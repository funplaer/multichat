const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chatAPI', {
    onMessage: (callback) => {
        ipcRenderer.on('chat-message', (event, data) => callback(data));
    },
    onViewersUpdate: (callback) => {
        ipcRenderer.on('viewers-update', (event, data) => callback(data));
    },
    getVersion: () => ipcRenderer.invoke('get-version'),
    closeWindow: () => ipcRenderer.send('window-close'),
    minimizeWindow: () => ipcRenderer.send('window-minimize')
});