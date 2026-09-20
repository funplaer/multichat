const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { app, BrowserWindow, ipcMain, globalShortcut } = require('electron');
const fs = require('fs');
const { google } = require('googleapis');

process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('UNHANDLED REJECTION:', err);
});


// ---------- YOUTUBE CHAT ----------
let LiveChat;


// ---------- VERSION ----------
ipcMain.handle('get-version', () => {
    return app.getVersion();
});
try {
    ({ LiveChat } = require('youtube-chat-next'));
    console.log('youtube-chat-next OK');
} catch (e) {
    console.error('youtube-chat-next НЕ ЗАГРУЖЕН:', e.message);
}


// ---------- TWITCH / TWURPLE ----------
let RefreshingAuthProvider;
let ApiClient;
let EventSubWsListener;

async function loadTwurple() {
    console.log('Загрузка Twurple...');

    try {
        const authMod = await import('@twurple/auth');
        RefreshingAuthProvider = authMod.RefreshingAuthProvider;

        const apiMod = await import('@twurple/api');
        ApiClient = apiMod.ApiClient;

        const wsMod = await import('@twurple/eventsub-ws');
        EventSubWsListener = wsMod.EventSubWsListener;

        console.log('Twurple загружен');
    } catch (e) {
        console.error('Не удалось загрузить Twurple:', e.message);
        console.error('Twitch-чат будет отключён.');
    }
}


// ---------- CONFIG ----------
const TWITCH_CHANNEL = process.env.TWITCH_CHANNEL || 'twitchdev';
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';

const YOUTUBE_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || '';

const TOKEN_PATH = path.join(__dirname, 'tokens.json');

let mainWindow = null;


// ---------- YOUTUBE VIEWERS STATE ----------
let youtubeOAuth2Client = null;
let youtubeViewersInterval = null;
let currentYouTubeLiveId = null;
let youtubeViewersFailCount = 0;


// ---------- WINDOW STATE ----------
let WINDOW_STATE_PATH = null;

function loadWindowState() {
    try {
        if (WINDOW_STATE_PATH && fs.existsSync(WINDOW_STATE_PATH)) {
            const raw = fs.readFileSync(WINDOW_STATE_PATH, 'utf-8');
            const state = JSON.parse(raw);

            if (
                Number.isFinite(state.width) &&
                Number.isFinite(state.height) &&
                (state.x === undefined || Number.isFinite(state.x)) &&
                (state.y === undefined || Number.isFinite(state.y))
            ) {
                return state;
            }
        }
    } catch (e) {
        console.warn('Не удалось прочитать window-state.json:', e.message);
    }

    return { width: 400, height: 700, x: undefined, y: undefined, isMaximized: false };
}

let saveTimeout = null;

function saveWindowState() {
    if (!mainWindow) return;

    try {
        const isMaximized = mainWindow.isMaximized();

        const bounds = isMaximized
            ? mainWindow.getNormalBounds()
            : mainWindow.getBounds();

        const state = {
            width: bounds.width,
            height: bounds.height,
            x: bounds.x,
            y: bounds.y,
            isMaximized
        };

        if (WINDOW_STATE_PATH) {
            fs.writeFileSync(
                WINDOW_STATE_PATH,
                JSON.stringify(state, null, 4),
                'utf-8'
            );
        }
    } catch (e) {
        console.warn('Не удалось сохранить window-state.json:', e.message);
    }
}

function saveWindowStateDebounced() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveWindowState, 300);
}


// ---------- КАРТЫ СМАЙЛИКОВ И БАДЖЕЙ ----------
let emoteMap = new Map();
let badgeMap = new Map();
let sevenTVMap = new Map();


// ---------- YOUTUBE OAUTH ----------
function setupYouTubeOAuth() {
    const clientId = process.env.YOUTUBE_CLIENT_ID;
    const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
    const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
        console.warn('YouTube API: YOUTUBE_CLIENT_ID/SECRET/REFRESH_TOKEN не заданы. Счётчик зрителей YouTube отключён.');
        return null;
    }

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);

    oauth2Client.setCredentials({
        refresh_token: refreshToken
    });

    oauth2Client.on('tokens', (tokens) => {
        if (tokens.refresh_token) {
            console.log('YouTube: получен новый refresh_token');
        }
    });

    console.log('YouTube OAuth: клиент создан');
    return oauth2Client;
}


// ---------- AUTH (TWITCH) ----------
let authProvider = null;
let apiClient = null;
let authenticatedUserId = null;

async function setupAuth() {
    if (!RefreshingAuthProvider || !ApiClient) {
        return null;
    }

    if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
        console.warn('Twitch API: CLIENT_ID/SECRET не заданы.');
        return null;
    }

    if (!fs.existsSync(TOKEN_PATH)) {
        console.error('Нет tokens.json — Twitch-чат отключён.');
        return null;
    }

    let tokenData;

    try {
        tokenData = JSON.parse(
            fs.readFileSync(TOKEN_PATH, 'utf-8')
        );
    } catch (e) {
        console.error('Ошибка чтения tokens.json:', e.message);
        return null;
    }

    if (!tokenData.userId) {
        console.error('В tokens.json нет "userId". Twitch-чат отключён.');
        return null;
    }

    authenticatedUserId = String(tokenData.userId);

    authProvider = new RefreshingAuthProvider({
        clientId: TWITCH_CLIENT_ID,
        clientSecret: TWITCH_CLIENT_SECRET
    });

    authProvider.onRefresh(async (userId, newTokenData) => {
        const toSave = {
            ...newTokenData,
            userId: tokenData.userId
        };

        fs.writeFileSync(
            TOKEN_PATH,
            JSON.stringify(toSave, null, 4),
            'utf-8'
        );

        console.log('Токены обновлены');
    });

    try {
        await authProvider.addUser(
            authenticatedUserId,
            tokenData,
            ['chat']
        );
    } catch (e) {
        console.error('addUser ошибка:', e.message);
        return null;
    }

    apiClient = new ApiClient({
        authProvider
    });

    console.log('ApiClient создан');

    return apiClient;
}


// ---------- ЗАГРУЗКА TWITCH АССЕТОВ ----------
async function loadTwitchAssets() {
    if (!apiClient) return;

    try {
        const user = await apiClient.users.getUserByName(
            TWITCH_CHANNEL
        );

        if (!user) {
            console.warn(`Канал ${TWITCH_CHANNEL} не найден`);
            return;
        }

        const broadcasterId = user.id;

        // GLOBAL EMOTES
        const globalEmotes = await apiClient.chat.getGlobalEmotes();

        for (const emote of globalEmotes) {
            emoteMap.set(
                emote.id,
                emote.getImageUrl(1.0)
            );
        }

        // CHANNEL EMOTES
        const channelEmotes =
            await apiClient.chat.getChannelEmotes(broadcasterId);

        for (const emote of channelEmotes) {
            emoteMap.set(
                emote.id,
                emote.getImageUrl(1.0)
            );
        }

        console.log(
            `Загружено смайликов Twitch: ${emoteMap.size}`
        );

        // GLOBAL BADGES
        const globalBadges =
            await apiClient.chat.getGlobalBadges();

        for (const set of globalBadges) {
            for (const version of set.versions) {
                badgeMap.set(
                    `${set.id}:${version.id}`,
                    version.getImageUrl(1.0)
                );
            }
        }

        // CHANNEL BADGES
        const channelBadges =
            await apiClient.chat.getChannelBadges(
                broadcasterId
            );

        for (const set of channelBadges) {
            for (const version of set.versions) {
                badgeMap.set(
                    `${set.id}:${version.id}`,
                    version.getImageUrl(1.0)
                );
            }
        }

        console.log(
            `Загружено баджей: ${badgeMap.size}`
        );

    } catch (e) {
        console.error(
            'loadTwitchAssets ошибка:',
            e.message
        );
    }
}


// ---------- ЗАГРУЗКА 7TV СМАЙЛИКОВ ----------
async function load7TVAssets() {
    try {
        const addEmote = (emote) => {
            const data = emote.data || {};
            const width = data.width || 32;
            const height = data.height || 32;
            const aspectRatio = data.aspect_ratio || (width / height) || 1;

            const zeroWidth = (data.flags & 256) === 256;

            const url = `https://cdn.7tv.app/emote/${emote.id}/2x.webp`;

            sevenTVMap.set(emote.name, {
                url,
                width,
                height,
                aspectRatio,
                zeroWidth
            });
        };

        // Глобальные смайлики 7TV
        const globalRes = await fetch('https://7tv.io/v3/emote-sets/global');
        if (globalRes.ok) {
            const globalData = await globalRes.json();
            for (const emote of globalData.emotes || []) {
                addEmote(emote);
            }
        }
        console.log(`7TV: глобальных смайликов — ${sevenTVMap.size}`);

        // Канальные смайлики 7TV
        if (apiClient) {
            const user = await apiClient.users.getUserByName(TWITCH_CHANNEL);
            if (user) {
                const channelRes = await fetch(
                    `https://7tv.io/v3/users/twitch/${user.id}`
                );
                if (channelRes.ok) {
                    const channelData = await channelRes.json();
                    const emotes = channelData.emote_set?.emotes || [];
                    for (const emote of emotes) {
                        addEmote(emote);
                    }
                }
            }
        }
        console.log(`7TV: всего смайликов — ${sevenTVMap.size}`);
    } catch (e) {
        console.warn('7TV: ошибка загрузки смайликов —', e.message);
    }
}


// ---------- ПАРСИНГ TWITCH MESSAGE PARTS ----------
function buildTwitchParts(parts) {
    if (!Array.isArray(parts) || parts.length === 0) {
        return [];
    }

    const result = [];

    for (const part of parts) {
        if (!part) continue;

        if (part.type === 'text' || part.type === 'mention') {
            result.push({
                type: 'text',
                value: part.text || ''
            });
            continue;
        }

        if (part.type === 'emote' && part.emote) {
            const emoteId = part.emote.id;

            if (!emoteId) {
                result.push({
                    type: 'text',
                    value: part.text || ''
                });
                continue;
            }

            const url =
                emoteMap.get(emoteId) ||
                `https://static-cdn.jtvnw.net/emoticons/v2/${emoteId}/default/dark/2.0`;

            result.push({
                type: 'emote',
                url,
                alt: part.text || ''
            });
            continue;
        }

        if (part.type === 'cheermote') {
            result.push({
                type: 'text',
                value: part.text || ''
            });
            continue;
        }

        if (part.type === 'gif') {
            if (part.gif?.url) {
                result.push({
                    type: 'emote',
                    url: part.gif.url,
                    alt: part.text || ''
                });
            }
            continue;
        }

        if (part.text) {
            result.push({
                type: 'text',
                value: part.text
            });
        }
    }

    return result;
}


// ---------- ПОДСТАНОВКА 7TV СМАЙЛИКОВ ----------
function apply7TVEmotes(parts) {
    if (!Array.isArray(parts) || parts.length === 0) {
        return parts;
    }

    const result = [];

    for (const part of parts) {
        if (part.type !== 'text' || !part.value) {
            result.push(part);
            continue;
        }

        const tokens = part.value.split(/(\s+)/);
        let textBuffer = '';

        for (const token of tokens) {
            if (/^\s+$/.test(token) || token === '') {
                textBuffer += token;
                continue;
            }

            const tv = sevenTVMap.get(token);

            if (tv) {
                if (textBuffer && !/^\s+$/.test(textBuffer)) {
                    result.push({ type: 'text', value: textBuffer });
                }
                textBuffer = '';

                result.push({
                    type: 'emote',
                    url: tv.url,
                    alt: token,
                    aspectRatio: tv.aspectRatio,
                    naturalWidth: tv.width,
                    naturalHeight: tv.height,
                    zeroWidth: tv.zeroWidth
                });
            } else {
                textBuffer += token;
            }
        }

        if (textBuffer) {
            result.push({ type: 'text', value: textBuffer });
        }
    }

    return result;
}


// ---------- ПАРСИНГ TWITCH BADGES ----------
function buildTwitchBadges(badges) {
    if (!badges) {
        return [];
    }

    const result = [];

    for (const [setId, version] of Object.entries(badges)) {
        const url = badgeMap.get(
            `${setId}:${version}`
        );

        if (url) {
            result.push({
                url,
                alt: `${setId}/${version}`
            });
        }
    }

    return result;
}


// ---------- TWITCH EVENTSUB ----------
let eventSubListener = null;

async function startTwitch() {
    if (
        !apiClient ||
        !authProvider ||
        !authenticatedUserId ||
        !EventSubWsListener
    ) {
        console.warn(
            'Twitch EventSub не запущен: отсутствуют зависимости.'
        );
        return;
    }

    try {
        const broadcaster =
            await apiClient.users.getUserByName(
                TWITCH_CHANNEL
            );

        if (!broadcaster) {
            console.error(
                `Канал ${TWITCH_CHANNEL} не найден`
            );
            return;
        }

        eventSubListener =
            new EventSubWsListener({
                apiClient
            });

        eventSubListener.onChannelChatMessage(
            broadcaster.id,
            authenticatedUserId,

            (event) => {
                if (!mainWindow) {
                    return;
                }

                try {
                    const messageText = event.messageText || '';

                    const twitchParts = buildTwitchParts(event.messageParts);
                    const parts = apply7TVEmotes(twitchParts);

                    const finalParts = parts.length > 0
                        ? parts
                        : [{ type: 'text', value: messageText }];

                    const badges = buildTwitchBadges(event.badges);

                    mainWindow.webContents.send(
                        'chat-message',
                        {
                            platform: 'twitch',

                            username:
                                event.chatterDisplayName ||
                                event.chatterName ||
                                'unknown',

                            message: messageText,

                            parts: finalParts,

                            badges,

                            color:
                                event.color ||
                                '#9147ff',

                            timestamp: Date.now()
                        }
                    );

                } catch (e) {
                    console.error(
                        'Ошибка обработки Twitch-сообщения:',
                        e.message || e
                    );
                }
            }
        );

        await eventSubListener.start();

        console.log(
            `Twitch EventSub подключён: ${TWITCH_CHANNEL}`
        );

    } catch (e) {
        console.error(
            'EventSub ошибка:',
            e.message || e
        );
    }
}


// ---------- СЧЁТЧИК ЗРИТЕЛЕЙ TWITCH ----------
let twitchViewersInterval = null;

async function updateTwitchViewers() {
    if (!apiClient || !mainWindow) return;

    try {
        const stream = await apiClient.streams.getStreamByUserName(TWITCH_CHANNEL);
        const viewers = stream ? stream.viewers : null;

        if (!mainWindow) return;

        mainWindow.webContents.send('viewers-update', {
            platform: 'twitch',
            viewers
        });

        if (viewers !== null) {
           // console.log(`Twitch viewers: ${viewers}`);
        }
    } catch (e) {
        console.warn('Ошибка получения зрителей Twitch:', e.message);
    }
}

function startTwitchViewersCounter() {
    updateTwitchViewers();
    twitchViewersInterval = setInterval(updateTwitchViewers, 60 * 1000);
}


// ---------- СЧЁТЧИК ЗРИТЕЛЕЙ YOUTUBE ----------
async function updateYouTubeViewers() {
    if (!youtubeOAuth2Client || !currentYouTubeLiveId || !mainWindow) return;

    try {
        const youtube = google.youtube({
            version: 'v3',
            auth: youtubeOAuth2Client
        });

        const response = await youtube.videos.list({
            part: 'liveStreamingDetails',
            id: currentYouTubeLiveId
        });

        const items = response.data.items || [];
        if (items.length === 0) {
            console.log('YouTube viewers: видео не найдено');
            return;
        }

        const liveDetails = items[0].liveStreamingDetails;
        if (!liveDetails) {
            console.log('YouTube viewers: нет данных liveStreamingDetails');
            return;
        }

        const viewers = liveDetails.concurrentViewers !== undefined
            ? parseInt(liveDetails.concurrentViewers, 10)
            : null;

        if (viewers !== null && !isNaN(viewers)) {
            //console.log(`YouTube viewers: ${viewers}`);
            youtubeViewersFailCount = 0;

            mainWindow.webContents.send('viewers-update', {
                platform: 'youtube',
                viewers
            });
        } else {
            mainWindow.webContents.send('viewers-update', {
                platform: 'youtube',
                viewers: null
            });
        }
    } catch (e) {
        youtubeViewersFailCount++;

        if (youtubeViewersFailCount <= 3 || youtubeViewersFailCount % 10 === 0) {
            console.warn('YouTube viewers error:', e.message || e);
        }
    }
}

function startYouTubeViewersCounter(liveId) {
    if (youtubeViewersInterval) {
        clearInterval(youtubeViewersInterval);
        youtubeViewersInterval = null;
    }

    currentYouTubeLiveId = liveId;
    youtubeViewersFailCount = 0;

    updateYouTubeViewers();

    youtubeViewersInterval = setInterval(updateYouTubeViewers, 60 * 1000);

    console.log(`YouTube viewers counter started for liveId: ${liveId}`);
}

function stopYouTubeViewersCounter() {
    if (youtubeViewersInterval) {
        clearInterval(youtubeViewersInterval);
        youtubeViewersInterval = null;
    }

    currentYouTubeLiveId = null;

    if (mainWindow) {
        mainWindow.webContents.send('viewers-update', {
            platform: 'youtube',
            viewers: null
        });
    }

    console.log('YouTube viewers counter stopped');
}


// ---------- YOUTUBE CHAT ----------
function startYouTube() {
    if (!LiveChat || !YOUTUBE_CHANNEL_ID) {
        console.warn(
            'YouTube чат отключён.'
        );
        return;
    }

    const youtubeChat =
        new LiveChat({
            channelId: YOUTUBE_CHANNEL_ID
        });

    youtubeChat.on(
        'start',
        (liveId) => {
            console.log(
                `YouTube подключён. Live ID: ${liveId}`
            );

            if (youtubeOAuth2Client) {
                startYouTubeViewersCounter(liveId);
            } else {
                console.warn('YouTube viewers: OAuth-клиент не настроен');
            }
        }
    );

    youtubeChat.on(
        'chat',
        (chat) => {
            if (!mainWindow) {
                return;
            }

            const parts = [];
            let plainText = '';

            for (const part of chat.message || []) {
                const hasText =
                    part.text !== undefined &&
                    part.text !== null &&
                    String(part.text).length > 0;

                const hasUrl =
                    !!part.url;

                if (hasText) {
                    parts.push({
                        type: 'text',
                        value: String(part.text)
                    });

                    plainText +=
                        String(part.text);

                } else if (hasUrl) {
                    parts.push({
                        type: 'emoji',
                        url: part.url,
                        alt:
                            part.alt ||
                            part.emojiText ||
                            ''
                    });

                    plainText +=
                        part.emojiText || '';
                }
            }

            if (parts.length === 0) {
                return;
            }

            const nickColor =
                chat.isModerator
                    ? '#1e90ff'
                    : '#efeff1';

            mainWindow.webContents.send(
                'chat-message',
                {
                    platform: 'youtube',

                    username:
                        chat.author?.name ||
                        'unknown',

                    message:
                        plainText.trim(),

                    parts,

                    color: nickColor,

                    timestamp: Date.now()
                }
            );
        }
    );

    youtubeChat.on(
        'error',
        (err) => {
            console.warn(
                'YouTube ошибка:',
                err.message || err
            );
        }
    );

    youtubeChat.on(
        'end',
        (reason) => {
            console.log('YouTube чат завершён:', reason);
            stopYouTubeViewersCounter();
        }
    );

    youtubeChat
        .start()
        .then(
            (ok) => {
                if (!ok) {
                    console.warn(
                        'YouTube: стрим не запущен.'
                    );
                }
            }
        )
        .catch(
            (err) => {
                console.warn(
                    'YouTube: не подключиться —',
                    err.message || err
                );
            }
        );
}


// ---------- ОКНО ----------
function createWindow() {
    const state = loadWindowState();

    mainWindow =
        new BrowserWindow({
            width: state.width,
            height: state.height,
            x: state.x,
            y: state.y,

            frame: false,
            transparent: true,
            resizable: true,
            alwaysOnTop: true,
            skipTaskbar: false,
            hasShadow: false,
            icon: path.join(__dirname, 'build', 'icon.ico'),
            webPreferences: {
                preload:
                    path.join(
                        __dirname,
                        'preload.js'
                    ),

                contextIsolation: true,
                nodeIntegration: false
            }
        });

    if (state.isMaximized) {
        mainWindow.maximize();
    }

    mainWindow.loadFile(
        'index.html'
    );

    mainWindow.on('resize', saveWindowStateDebounced);
    mainWindow.on('move', saveWindowStateDebounced);
    mainWindow.on('maximize', saveWindowState);
    mainWindow.on('unmaximize', saveWindowState);
    mainWindow.on('close', saveWindowState);

    mainWindow.on(
        'closed',
        () => {
            mainWindow = null;
        }
    );
}


// ---------- IPC ----------
ipcMain.on(
    'window-close',
    () => {
        if (mainWindow) {
            mainWindow.close();
        }
    }
);

ipcMain.on(
    'window-minimize',
    () => {
        if (mainWindow) {
            mainWindow.minimize();
        }
    }
);


// ---------- ЗАПУСК ----------
app.whenReady().then(
    async () => {
        WINDOW_STATE_PATH = path.join(
            app.getPath('userData'),
            'window-state.json'
        );

        createWindow();

        globalShortcut.register('F12', () => {
            if (mainWindow) {
                mainWindow.webContents.toggleDevTools();
            }
        });

        // YouTube OAuth
        youtubeOAuth2Client = setupYouTubeOAuth();

        await loadTwurple();

        if (
            RefreshingAuthProvider &&
            ApiClient
        ) {
            try {
                await setupAuth();
            } catch (e) {
                console.error(
                    'Auth ошибка:',
                    e.message || e
                );
            }

            if (apiClient) {
                await loadTwitchAssets();
                await load7TVAssets();
                await startTwitch();

                startTwitchViewersCounter();
            }

        } else {
            console.warn(
                'Twitch-чат отключён: Twurple не загрузился.'
            );
        }

        startYouTube();

        app.on(
            'activate',
            () => {
                if (
                    BrowserWindow.getAllWindows()
                        .length === 0
                ) {
                    createWindow();
                }
            }
        );
    }
);

app.on(
    'will-quit',
    () => {
        globalShortcut.unregisterAll();

        if (twitchViewersInterval) {
            clearInterval(twitchViewersInterval);
        }

        if (youtubeViewersInterval) {
            clearInterval(youtubeViewersInterval);
        }
    }
);

app.on(
    'window-all-closed',
    () => {
        if (process.platform !== 'darwin') {
            app.quit();
        }
    }
);