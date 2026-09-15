const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { app, BrowserWindow, ipcMain } = require('electron');

process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT:', err);
});
process.on('unhandledRejection', (err) => {
    console.error('UNHANDLED REJECTION:', err);
});

let tmi, LiveChat;
try {
    tmi = require('tmi.js');
    console.log('tmi.js OK');
} catch (e) {
    console.error('tmi.js НЕ ЗАГРУЖЕН:', e.message);
}

try {
    ({ LiveChat } = require('youtube-chat-next'));
    console.log('youtube-chat-next OK');
} catch (e) {
    console.error('youtube-chat-next НЕ ЗАГРУЖЕН:', e.message);
}

const TWITCH_CHANNEL = process.env.TWITCH_CHANNEL || 'twitchdev';
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';
const YOUTUBE_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || '';

let mainWindow = null;

// ---------- КАРТЫ СМАЙЛИКОВ И БАДЖЕЙ ----------
// emoteMap:  "id" -> url  (например "25" -> "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0")
let emoteMap = new Map();
// badgeMap:  "set_id:version" -> url  (например "subscriber:12" -> "https://static-cdn.jtvnw.net/badges/v1/...")
let badgeMap = new Map();

// ---------- HELIX API: TOKEN ----------
async function getAppAccessToken() {
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: TWITCH_CLIENT_ID,
            client_secret: TWITCH_CLIENT_SECRET,
            grant_type: 'client_credentials'
        })
    });
    if (!res.ok) throw new Error(`Token error: ${res.status} ${await res.text()}`);
    const json = await res.json();
    return json.access_token;
}

// ---------- HELIX API: BROADCASTER ID ----------
async function getBroadcasterId(login, token) {
    const res = await fetch(`https://api.twitch.tv/helix/users?login=${login}`, {
        headers: {
            'Client-ID': TWITCH_CLIENT_ID,
            'Authorization': `Bearer ${token}`
        }
    });
    if (!res.ok) throw new Error(`Users error: ${res.status} ${await res.text()}`);
    const json = await res.json();
    return json.data[0]?.id;
}

// ---------- HELIX API: ЗАГРУЗКА СМАЙЛИКОВ И БАДЖЕЙ ----------
async function loadTwitchAssets() {
    if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
        console.warn('Twitch API: CLIENT_ID/SECRET не заданы — смайлики и баджи не загружены.');
        return;
    }

    try {
        const token = await getAppAccessToken();
        const broadcasterId = await getBroadcasterId(TWITCH_CHANNEL, token);

        if (!broadcasterId) {
            console.warn(`Twitch API: не найден broadcaster_id для канала ${TWITCH_CHANNEL}`);
            return;
        }

        // --- Глобальные смайлики ---
        const globalEmotesRes = await fetch('https://api.twitch.tv/helix/chat/emotes/global', {
            headers: {
                'Client-ID': TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${token}`
            }
        });
        const globalEmotes = await globalEmotesRes.json();

        // --- Смайлики канала ---
        const channelEmotesRes = await fetch(
            `https://api.twitch.tv/helix/chat/emotes?broadcaster_id=${broadcasterId}`,
            {
                headers: {
                    'Client-ID': TWITCH_CLIENT_ID,
                    'Authorization': `Bearer ${token}`
                }
            }
        );
        const channelEmotes = await channelEmotesRes.json();

        // Собираем карту смайликов
        const allEmotes = [...(globalEmotes.data || []), ...(channelEmotes.data || [])];
        for (const emote of allEmotes) {
            emoteMap.set(emote.id, emote.images?.url_1x || emote.images?.url_2x || '');
        }
        console.log(`Twitch API: загружено смайликов — ${emoteMap.size}`);

        // --- Глобальные баджи ---
        const globalBadgesRes = await fetch('https://api.twitch.tv/helix/chat/badges/global', {
            headers: {
                'Client-ID': TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${token}`
            }
        });
        const globalBadges = await globalBadgesRes.json();

        // --- Баджи канала ---
        const channelBadgesRes = await fetch(
            `https://api.twitch.tv/helix/chat/badges?broadcaster_id=${broadcasterId}`,
            {
                headers: {
                    'Client-ID': TWITCH_CLIENT_ID,
                    'Authorization': `Bearer ${token}`
                }
            }
        );
        const channelBadges = await channelBadgesRes.json();

        // Собираем карту баджей: set_id:version -> url
        const allBadges = [...(globalBadges.data || []), ...(channelBadges.data || [])];
        for (const set of allBadges) {
            for (const version of set.versions || []) {
                badgeMap.set(`${set.set_id}:${version.id}`, version.image_url_1x || '');
            }
        }
        console.log(`Twitch API: загружено баджей — ${badgeMap.size}`);

    } catch (e) {
        console.error('Twitch API: ошибка загрузки ассетов:', e.message || e);
    }
}

// ---------- СОЗДАНИЕ ОКНА ----------
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 400,
        height: 700,
        frame: false,
        transparent: true,
        resizable: true,
        alwaysOnTop: true,
        skipTaskbar: false,
        hasShadow: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile('index.html');

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// ---------- ПАРСИНГ СМАЙЛИКОВ ИЗ TAGS ----------
// tags.emotes = { "25": ["0-4", "6-9"], "1902": ["11-14"] }
function buildTwitchParts(message, tags) {
    const emotes = tags.emotes;
    if (!emotes || Object.keys(emotes).length === 0) {
        return [{ type: 'text', value: message }];
    }

    // Собираем плоский список: { start, end, id } и сортируем по start
    const ranges = [];
    for (const [id, positions] of Object.entries(emotes)) {
        for (const pos of positions) {
            const [start, end] = pos.split('-').map(Number);
            ranges.push({ start, end, id });
        }
    }
    ranges.sort((a, b) => a.start - b.start);

    const parts = [];
    let cursor = 0;

    for (const r of ranges) {
        if (r.start > cursor) {
            parts.push({ type: 'text', value: message.slice(cursor, r.start) });
        }
        const emoteText = message.slice(r.start, r.end + 1);
        const url = emoteMap.get(r.id);
        if (url) {
            parts.push({ type: 'emote', url, alt: emoteText });
        } else {
            parts.push({ type: 'text', value: emoteText });
        }
        cursor = r.end + 1;
    }

    if (cursor < message.length) {
        parts.push({ type: 'text', value: message.slice(cursor) });
    }

    return parts;
}

// ---------- ПАРСИНГ БАДЖЕЙ ИЗ TAGS ----------
// tags.badges = { moderator: "1", subscriber: "12" }
function buildTwitchBadges(tags) {
    const badges = tags.badges;
    if (!badges || Object.keys(badges).length === 0) return [];

    const result = [];
    for (const [setId, version] of Object.entries(badges)) {
        const url = badgeMap.get(`${setId}:${version}`);
        if (url) {
            result.push({ url, alt: `${setId}/${version}` });
        }
    }
    return result;
}

// ---------- TWITCH ----------
function startTwitch() {
    if (!tmi) {
        console.error('Twitch не запущен: модуль tmi.js не загружен.');
        return;
    }

    const twitchClient = new tmi.Client({
        options: { debug: false },
        connection: { reconnect: true, secure: true },
        channels: [TWITCH_CHANNEL]
    });

    twitchClient.on('connected', (addr, port) => {
        console.log(`Twitch подключён: ${addr}:${port}, канал: ${TWITCH_CHANNEL}`);
    });

    twitchClient.on('disconnected', (reason) => {
        console.warn('Twitch отключён:', reason);
    });

    twitchClient.on('message', (channel, tags, message, self) => {
        if (self || !mainWindow) return;

        const parts = buildTwitchParts(message, tags);
        const badges = buildTwitchBadges(tags);

        mainWindow.webContents.send('chat-message', {
            platform: 'twitch',
            username: tags['display-name'] || tags.username || 'unknown',
            parts,
            badges,
            color: tags.color || '#9147ff',
            timestamp: Date.now()
        });
    });

    twitchClient.connect().catch(err => {
        console.error('Ошибка подключения к Twitch:', err.message || err);
    });
}

// ---------- YOUTUBE ----------
function startYouTube() {
    if (!LiveChat) {
        console.error('YouTube не запущен: модуль youtube-chat-next не загружен.');
        return;
    }

    if (!YOUTUBE_CHANNEL_ID) {
        console.warn('YOUTUBE_CHANNEL_ID не задан — YouTube чат отключён.');
        return;
    }

    const youtubeChat = new LiveChat({ channelId: YOUTUBE_CHANNEL_ID });

    youtubeChat.on('start', (liveId) => {
        console.log(`YouTube чат подключён. Live ID: ${liveId}`);
    });

    youtubeChat.on('chat', (chat) => {
        if (!mainWindow) return;

        const parts = [];
        let plainText = '';

        for (const part of chat.message || []) {
            const hasText = part.text !== undefined && part.text !== null && String(part.text).length > 0;
            const hasUrl = !!part.url;

            if (hasText) {
                parts.push({ type: 'text', value: String(part.text) });
                plainText += String(part.text);
            } else if (hasUrl) {
                parts.push({
                    type: 'emoji',
                    url: part.url,
                    alt: part.alt || part.emojiText || ''
                });
                plainText += (part.emojiText || '');
            }
        }

        if (parts.length === 0) return;

        const nickColor = chat.isModerator ? '#1e90ff' : '#efeff1';

        mainWindow.webContents.send('chat-message', {
            platform: 'youtube',
            username: chat.author?.name || 'unknown',
            message: plainText.trim(),
            parts,
            color: nickColor,
            timestamp: Date.now()
        });
    });

    youtubeChat.on('error', (err) => {
        console.error('Ошибка YouTube чата:', err.message || err);
    });

    youtubeChat.on('end', (reason) => {
        console.log('YouTube чат завершён:', reason);
    });

    youtubeChat.start().then(ok => {
        if (!ok) console.warn('Не удалось запустить YouTube чат. Проверь channelId.');
    });
}

// ---------- IPC: кнопки окна ----------
ipcMain.on('window-close', () => {
    if (mainWindow) mainWindow.close();
});

ipcMain.on('window-minimize', () => {
    if (mainWindow) mainWindow.minimize();
});

// ---------- ЗАПУСК ----------
app.whenReady().then(async () => {
    // Сначала загружаем ассеты, потом создаём окно и запускаем чаты
    await loadTwitchAssets();

    createWindow();
    startTwitch();
    startYouTube();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});