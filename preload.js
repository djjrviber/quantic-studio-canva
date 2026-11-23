'use strict';
// Ponte mínima e explícita entre a página e o processo principal.
// A página nunca recebe acesso a Node, ao disco ou à rede diretamente.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qscDesktop', {
  version: ipcRenderer.sendSync('app:versionSync'),
  getKey: provider => ipcRenderer.sendSync('keys:getSync', String(provider)),
  setKey: (provider, value) => ipcRenderer.invoke('keys:set', String(provider), String(value || '')),
  http: req => ipcRenderer.invoke('http', req),
  getFolder: () => ipcRenderer.invoke('fs:getFolder'),
  pickFolder: () => ipcRenderer.invoke('fs:pickFolder'),
  openFolder: () => ipcRenderer.invoke('fs:openFolder'),
  writeFile: (name, bytes) => ipcRenderer.invoke('fs:write', String(name), bytes),
  downloadTo: (url, name) => ipcRenderer.invoke('fs:download', String(url), String(name)),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: cb => {
    const h = (_e, m) => { try { cb(m); } catch (e) {} };
    ipcRenderer.on('update', h);
    return () => ipcRenderer.removeListener('update', h);
  }
});
