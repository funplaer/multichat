const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');

process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('UNHANDLED REJECTION:', err);
});


// ---------- YOUTUBE CHAT ----------
let LiveChat;

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


// ---------- КАРТЫ СМАЙЛИКОВ И БАДЖЕЙ ----------
let emoteMap = new Map();      // Twitch emoteId -> url
let badgeMap = new Map();      // Twitch "set:version" -> url
let sevenTVMap = new Map();  // 7TV "emoteName" -> url


// ---------- AUTH ----------
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

        // ---------- GLOBAL EMOTES ----------
        const globalEmotes = await apiClient.chat.getGlobalEmotes();

        for (const emote of globalEmotes) {
            emoteMap.set(
                emote.id,
                emote.getImageUrl(1.0)
            );
        }

        // ---------- CHANNEL EMOTES ----------
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

        // ---------- GLOBAL BADGES ----------
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

        // ---------- CHANNEL BADGES ----------
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

    // Zero-width определяется по visibility_simple, а не по flags
    const visibility = data.visibility_simple || emote.visibility_simple || [];
    const zeroWidth = visibility.includes('ZERO_WIDTH');

    if (zeroWidth) {
        console.log(`7TV ZERO-WIDTH: ${emote.name}`);
    }

    const url = `https://cdn.7tv.app/emote/${emote.id}/2x.webp`;

    sevenTVMap.set(emote.name, {
        url,
        width,
        height,
        aspectRatio,
        zeroWidth
    });
};

        // --- Глобальные смайлики 7TV ---
        const globalRes = await fetch('https://7tv.io/v3/emote-sets/global');
        if (globalRes.ok) {
            const globalData = await globalRes.json();
            for (const emote of globalData.emotes || []) {
                addEmote(emote);
            }
        }
        console.log(`7TV: глобальных смайликов — ${sevenTVMap.size}`);

        // --- Канальные смайлики 7TV ---
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


// ---------- ПОДСТАНОВКА 7TV СМАЙЛИКОВ В ТЕКСТ ----------
// Проходим по текстовым частям и заменяем слова, найденные в sevenTVMap
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
    // ЛОГ
    console.log(`7TV MATCH: ${token} | zeroWidth=${tv.zeroWidth}`);

    if (textBuffer) {
        result.push({ type: 'text', value: textBuffer });
        textBuffer = '';
    }

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

                    // 1) Собираем Twitch-части
                    const twitchParts = buildTwitchParts(event.messageParts);

                    // 2) Прогоняем через 7TV-фильтр
                    const parts = apply7TVEmotes(twitchParts);

                    // 3) Fallback: если parts пуст, но текст есть — отдаём текст
                    const finalParts = parts.length > 0
                        ? parts
                        : [{ type: 'text', value: messageText }];

                    // 4) Баджи
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


// ---------- YOUTUBE ----------
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
    mainWindow =
        new BrowserWindow({
            width: 400,
            height: 700,

            frame: false,
            transparent: true,
            resizable: true,
            alwaysOnTop: true,
            skipTaskbar: false,
            hasShadow: false,

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

    mainWindow.loadFile(
        'index.html'
    );

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
        createWindow();

        // Загружаем Twurple
        await loadTwurple();

        // Twitch
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
                await load7TVAssets();     // <-- 7TV
                await startTwitch();
            }

        } else {
            console.warn(
                'Twitch-чат отключён: Twurple не загрузился.'
            );
        }

        // YouTube
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
    'window-all-closed',
    () => {
        if (process.platform !== 'darwin') {
            app.quit();
        }
    }
);