require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const tmi = require('tmi.js');
const { LiveChat } = require('youtube-chat-next');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const TWITCH_CHANNEL = process.env.TWITCH_CHANNEL || 'twitchdev';
const YOUTUBE_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || '';

// ---------- TWITCH ----------
const twitchClient = new tmi.Client({
    options: { debug: false },
    connection: {
        reconnect: true,
        secure: true
    },
    channels: [TWITCH_CHANNEL]
});

twitchClient.on('connected', (addr, port) => {
    console.log(`Twitch подключён: ${addr}:${port}, канал: ${TWITCH_CHANNEL}`);
});

twitchClient.on('disconnected', (reason) => {
    console.warn('Twitch отключён:', reason);
});

twitchClient.on('message', (channel, tags, message, self) => {
    if (self) return;

    io.emit('chat-message', {
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

// ---------- YOUTUBE ----------
if (YOUTUBE_CHANNEL_ID) {
    const youtubeChat = new LiveChat({
        channelId: YOUTUBE_CHANNEL_ID
    });

    youtubeChat.on('start', (liveId) => {
        console.log(`YouTube чат подключён. Live ID: ${liveId}`);
    });

    youtubeChat.on('chat', (chat) => {
        // Склеиваем все части сообщения (текст + эмодзи) в одну строку
        const text = chat.message
            .map(part => (part.text ? part.text : part.alt || ''))
            .join('')
            .trim();

        if (!text) return;

        // Цвет ника: синий для модераторов, нейтральный для остальных
        const nickColor = chat.isModerator ? '#1e90ff' : '#efeff1';

        io.emit('chat-message', {
            platform: 'youtube',
            username: chat.author?.name || 'unknown',
            message: text,
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
} else {
    console.warn('YOUTUBE_CHANNEL_ID не задан — YouTube чат отключён.');
}

// ---------- SOCKET.IO ----------
io.on('connection', (socket) => {
    console.log('Клиент подключился:', socket.id);
    socket.emit('system-message', {
        text: `Twitch: ${TWITCH_CHANNEL} | YouTube: ${YOUTUBE_CHANNEL_ID || '—'}`
    });
});

// ---------- SERVER ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен: http://localhost:${PORT}`);
    console.log(`Twitch канал: ${TWITCH_CHANNEL}`);
    console.log(`YouTube канал: ${YOUTUBE_CHANNEL_ID || '—'}`);
});