'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const str = (v) => String(v == null ? '' : v).slice(0, 20000);
const s2k = (o, k) => (o && typeof o[k] === 'string' && o[k] ? o[k].slice(0, 2048) : undefined);

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
  // Google 캘린더 — 인자는 여기서 문자열로 강제 변환해 보낸다 (메인에서도 다시 확인)
  google: {
    status: () => ipcRenderer.invoke('google:status'),
    setClient: (input) => ipcRenderer.invoke('google:setClient', {
      clientId: str(input && input.clientId), clientSecret: str(input && input.clientSecret), text: str(input && input.text) }),
    clearClient: () => ipcRenderer.invoke('google:clearClient'),
    signIn: (opts) => ipcRenderer.invoke('google:signIn', { loginHint: opts && opts.loginHint ? String(opts.loginHint).slice(0, 320) : null }),
    cancelSignIn: () => ipcRenderer.invoke('google:cancelSignIn'),
    signOut: () => ipcRenderer.invoke('google:signOut'),
    onChanged: (fn) => { if (typeof fn === 'function') ipcRenderer.on('google:changed', (_e, st) => fn(st)); }
  },
  gcal: {
    calendars: () => ipcRenderer.invoke('gcal:calendars'),
    ensureExportCalendar: (o) => ipcRenderer.invoke('gcal:ensureExportCalendar', {
      tz: String((o && o.tz) || 'Asia/Seoul').slice(0, 64), preferId: o && o.preferId ? String(o.preferId).slice(0, 2048) : null }),
    list: (req) => ipcRenderer.invoke('gcal:list', {
      calendarId: s2k(req, 'calendarId'), syncToken: s2k(req, 'syncToken'), timeMin: s2k(req, 'timeMin'), timeMax: s2k(req, 'timeMax') }),
    instances: (req) => ipcRenderer.invoke('gcal:instances', {
      calendarId: s2k(req, 'calendarId'), eventId: s2k(req, 'eventId'), timeMin: s2k(req, 'timeMin'), timeMax: s2k(req, 'timeMax') }),
    push: (ops) => ipcRenderer.invoke('gcal:push', Array.isArray(ops) ? ops.slice(0, 50) : [])
  },
  onBeforeClose: (fn) => ipcRenderer.on('app:before-close', () => fn()),
  // 빠른 메모 창(Ctrl+Shift+Space)에서 보낸 글
  onQuickCapture: (fn) => ipcRenderer.on('quick:capture', (_e, text) => fn(String(text || ''))),
  ready: () => ipcRenderer.invoke('app:ready'),
  onFlush: (fn) => ipcRenderer.on('app:flush', () => fn()),
  setCloseToTray: (on) => ipcRenderer.invoke('app:setCloseToTray', !!on),
  flushed: () => ipcRenderer.invoke('app:flushed')
});
