const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chatAPI', {
    onMessage: (callback) => {
        ipcRenderer.on('chat-message', (event, data) => callback(data));
    },
    closeWindow: () => ipcRenderer.send('window-close'),
    minimizeWindow: () => ipcRenderer.send('window-minimize')
});