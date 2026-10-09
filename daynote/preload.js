'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 렌더러에는 저장·내보내기 같은 필요한 동작만 노출한다. 파일 시스템은 열어주지 않는다.
contextBridge.exposeInMainWorld('daynoteHost', {
  kind: 'electron',
  load: () => ipcRenderer.invoke('store:load'),
  save: (json) => ipcRenderer.invoke('store:save', json),
  dataPath: () => ipcRenderer.invoke('store:path'),
  revealData: () => ipcRenderer.invoke('store:reveal'),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  exportFile: (name, content) => ipcRenderer.invoke('file:export', name, content),
  ai: {
    status: () => ipcRenderer.invoke('ai:status'),
    organizeNote: (input) => ipcRenderer.invoke('ai:organizeNote', input),
    // 키는 보내기만 하고 돌려받지 않는다 (상태에는 끝 4자리만)
    setKey: (key) => ipcRenderer.invoke('ai:setKey', String(key || '')),
    clearKey: () => ipcRenderer.invoke('ai:clearKey'),
    check: () => ipcRenderer.invoke('ai:check')
  },
  onBeforeClose: (fn) => ipcRenderer.on('app:before-close', () => fn()),
  // 빠른 메모 창(Ctrl+Shift+Space)에서 보낸 글
  onQuickCapture: (fn) => ipcRenderer.on('quick:capture', (_e, text) => fn(String(text || ''))),
  ready: () => ipcRenderer.invoke('app:ready'),
  onFlush: (fn) => ipcRenderer.on('app:flush', () => fn()),
  setCloseToTray: (on) => ipcRenderer.invoke('app:setCloseToTray', !!on),
  flushed: () => ipcRenderer.invoke('app:flushed')
});
