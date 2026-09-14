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
const YOUTUBE_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || '';

let mainWindow = null;

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

    // Отладка рендерера (раскомментируй при необходимости):
    mainWindow.webContents.openDevTools({ mode: 'detach' }); /////////////////////////////////////////////

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

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

        console.log(`TWITCH MESSAGE: ${tags['display-name']}: ${message}`);

        mainWindow.webContents.send('chat-message', {
            platform: 'twitch',
            username: tags['display-name'] || tags.username || 'unknown',
            message,
            color: tags.color || '#9147ff',
            timestamp: Date.now()
        });
    });

    twitchClient.connect().catch(err => {
        console.error('Ошибка подключения к Twitch:', err.message || err);
    });
}

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

        console.log(`YOUTUBE MESSAGE: ${chat.author?.name}: ${plainText}`);

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

app.whenReady().then(() => {
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