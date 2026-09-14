const chatContainer = document.getElementById('chat-container');
let systemMessageRemoved = false;

const LOGOS = {
    twitch: `
        <svg class="platform-logo" style="color:#9147ff" viewBox="0 0 2400 2800" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true">
            <path d="M2200 1300l-400 400h-400l-350 350v-350H600V200h1600v1100zM500 0L0 500v1800h600v500l500-500h400l900-900V0H500zm1300 550h200v600h-200V550zm-550 0h200v600h-200V550z"/>
        </svg>
    `,
    youtube: `
        <svg class="platform-logo" style="color:#ff0000" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true">
            <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
        </svg>
    `
};

// Проверка preload
if (!window.chatAPI) {
    console.error('chatAPI не найден — preload не загрузился!');
} else {
    console.log('chatAPI OK');
}

// Кнопки окна
document.getElementById('btn-close')?.addEventListener('click', () => {
    window.chatAPI?.closeWindow();
});

document.getElementById('btn-min')?.addEventListener('click', () => {
    window.chatAPI?.minimizeWindow();
});

// Приём сообщений
window.chatAPI?.onMessage((data) => {
    if (!systemMessageRemoved) {
        const sysMsg = chatContainer.querySelector('.system-message');
        if (sysMsg) sysMsg.remove();
        systemMessageRemoved = true;
    }

    const messageEl = document.createElement('div');
    messageEl.className = 'message';

    const logoWrap = document.createElement('span');
    logoWrap.innerHTML = LOGOS[data.platform] || LOGOS.twitch;

    const usernameEl = document.createElement('span');
    usernameEl.className = 'username';
    usernameEl.style.color = data.color;
    usernameEl.textContent = data.username + ':';

    const textEl = document.createElement('span');
    textEl.className = 'text';

    if (Array.isArray(data.parts) && data.parts.length > 0) {
        for (const part of data.parts) {
            if (part.type === 'text') {
                textEl.appendChild(document.createTextNode(part.value));
            } else if (part.type === 'emoji' && part.url) {
                const img = document.createElement('img');
                img.src = part.url;
                img.alt = part.alt || '';
                img.className = 'yt-emoji';
                img.onerror = () => {
                    const fallback = document.createTextNode(part.alt || '');
                    img.replaceWith(fallback);
                };
                textEl.appendChild(img);
            }
        }
    } else {
        textEl.textContent = data.message || '';
    }

    messageEl.appendChild(logoWrap.firstElementChild);
    messageEl.appendChild(usernameEl);
    messageEl.appendChild(textEl);
    chatContainer.appendChild(messageEl);

    chatContainer.scrollTop = chatContainer.scrollHeight;

    const messages = chatContainer.querySelectorAll('.message');
    if (messages.length > 200) messages[0].remove();
});