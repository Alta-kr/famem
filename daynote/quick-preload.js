'use strict';

// 빠른 메모 창 전용 — 보내기·숨기기·높이 맞추기만 연다.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('daynoteQuick', {
  submit: (text) => ipcRenderer.invoke('quick:submit', String(text || '').slice(0, 20000)),
  hide: () => ipcRenderer.send('quick:hide'),
  resize: (h) => ipcRenderer.send('quick:resize', Number(h) || 0),
  onShown: (fn) => ipcRenderer.on('quick:shown', (_e, status) => fn(status))
});
