'use strict';

// Daynote 메인 프로세스 — 창, 로컬 저장, 내보내기만 맡는다.
// 업무 규칙은 src/core 에, 화면은 renderer 에 있다.

const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, safeStorage, nativeTheme, Tray, Menu, globalShortcut, nativeImage, screen, net } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');

const DATA_FILE = () => path.join(app.getPath('userData'), 'daynote-data.json');
const BACKUP_FILE = () => DATA_FILE() + '.bak';

// `--profile=test` 로 켜면 다른 폴더에 저장한다 (검증용 격리 데이터).
(function applyProfile() {
  let name = process.env.DAYNOTE_PROFILE || '';
  for (const arg of process.argv) {
    const m = /^--profile=(.+)$/.exec(arg);
    if (m) name = m[1];
  }
  name = String(name).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  if (name) app.setPath('userData', app.getPath('userData') + ' [' + name + ']');
})();

// 스크린샷·smoke 검사는 실제 AI 를 부르지 않고 가짜 AI 를 쓴다 (화면에 '가짜 AI(테스트)' 로 표시됨)
// smoke 에서 실제 AI 까지 확인하려면 DAYNOTE_SMOKE_REAL=1
const CHECK_RUN = process.argv.includes('--shots') || process.argv.includes('--smoke');
if (process.argv.includes('--shots') || (process.argv.includes('--smoke') && process.env.DAYNOTE_SMOKE_REAL !== '1')) process.env.DAYNOTE_AI_FAKE = '1';

// 개발용 .env (GEMINI_API_KEY=...) — 환경변수가 이미 있으면 그대로 둔다
const keystoreMod = require('./services/keystore');
const dotenvKeys = [];
keystoreMod.loadDotEnv(__dirname, dotenvKeys);
const googleAuthMod = require('./services/google-auth');
const gcalMod = require('./services/gcal');
const envGoogleClient = googleAuthMod.captureEnvClient(process.env, dotenvKeys);   // ai.captureEnvKeys() 바로 옆
let googleAuth = null, gcalSvc = null;

let mainWindow = null;
let quickWindow = null;
let tray = null;
let isQuitting = false;
let closeToTray = true;          // 화면 설정에서 끌 수 있다 (app:setCloseToTray)
let rendererReady = false;
let quickRegistered = false;     // 다른 앱이 같은 단축키를 쓰고 있으면 등록에 실패한다
const pendingQuick = [];         // 메인 화면이 준비되기 전에 들어온 빠른 메모
const QUICK_KEY = 'CommandOrControl+Shift+Space';
const ICON = (size) => path.join(__dirname, 'assets', 'icon-' + size + '.png');

// ---------------------------------------------------------------- 저장소
// 전체 상태를 JSON 하나로 둔다. 임시 파일에 쓰고 이름을 바꿔 원자적으로 교체하고,
// 바로 전 정상 파일은 .bak 으로 남긴다 — 쓰다가 꺼져도 둘 중 하나는 온전하다.
async function loadData() {
  for (const file of [DATA_FILE(), BACKUP_FILE()]) {
    try {
      const text = await fs.readFile(file, 'utf8');
      return { ok: true, data: JSON.parse(text), recovered: file !== DATA_FILE(), path: DATA_FILE() };
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      // 깨진 파일은 지우지 않고 옆에 보관한 뒤 백업을 시도한다
      try { await fs.copyFile(file, file + '.broken-' + Date.now()); } catch (_) {}
    }
  }
  return { ok: true, data: null, path: DATA_FILE() };
}

let writing = Promise.resolve();
function saveData(json) {
  writing = writing.then(async () => {
    const target = DATA_FILE();
    const tmp = target + '.tmp';
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(tmp, json, 'utf8');
    if (fsSync.existsSync(target)) {
      try { await fs.copyFile(target, BACKUP_FILE()); } catch (_) {}
    }
    await fs.rename(tmp, target);
    return { ok: true, savedAt: new Date().toISOString() };
  }).catch((e) => ({ ok: false, error: e.message }));
  return writing;
}

ipcMain.handle('store:load', () => loadData());
ipcMain.handle('store:save', (_e, json) => saveData(json));
ipcMain.handle('store:path', () => DATA_FILE());
ipcMain.handle('store:reveal', () => { shell.showItemInFolder(DATA_FILE()); });

// AI — 키와 호출은 여기(메인)에만 있다. 화면은 결과만 받는다.
// 설정 화면에서 넣은 키는 DPAPI 로 암호화해 userData 에 둔다. 화면에는 끝 4자리만 알려 준다.
const ai = require('./services/ai');
// 환경변수·.env 의 키를 AI 모듈 안으로 옮기고 process.env 에서 지운다 — 창(렌더러) 프로세스가 물려받지 않게
ai.captureEnvKeys();
let keystore = null;
function aiStatus() {
  const k = keystore ? keystore.read() : '';
  return Object.assign(ai.status(), { savedKey: keystore ? keystore.hint(k) : null });
}
ipcMain.handle('ai:status', () => aiStatus());
ipcMain.handle('ai:organizeNote', (_e, input) => ai.organize(input));
ipcMain.handle('ai:setKey', (_e, key) => {
  const r = keystore.save(key);
  if (!r.ok) return Object.assign({ ok: false, error: r.error }, { status: aiStatus() });
  ai.setSavedKey(keystore.read());
  return { ok: true, status: aiStatus() };
});
ipcMain.handle('ai:clearKey', () => { keystore.clear(); ai.setSavedKey(''); return { ok: true, status: aiStatus() }; });
// 연결 확인 — 짧은 글 하나를 실제로 분류해 본다 (걸린 시간과 모델을 알려 줌)
ipcMain.handle('ai:check', async () => {
  const capture = require('./src/core/ai/capture');
  const now = new Date();
  const input = capture.buildInput({ id: 'check-' + now.getTime(), title: '', body: '내일까지 견적서 보내기', updatedAt: now.toISOString() },
    { today: now.toISOString().slice(0, 10), timezone: 'Asia/Seoul', projects: [], openTasks: [] });
  const t0 = Date.now();
  const r = await ai.organize(input);
  return r.ok ? { ok: true, ms: Date.now() - t0, model: r.model } : { ok: false, ms: Date.now() - t0, error: r.error };
});

// Google 캘린더 — 로그인·토큰은 services/google-auth, 일정 호출은 services/gcal. 화면에는 상태와 결과만 간다.
const G_UNAVAILABLE = () => ({ available: false, state: 'unavailable', signedIn: false, email: null, name: null, picture: null,
  reason: CHECK_RUN ? '검사 실행 중에는 Google 연결을 쓰지 않아요.' : '잠시 뒤 다시 시도해 주세요.' });
const fromMain = (e) => !!mainWindow && e.sender === mainWindow.webContents;
function gh(fn) {                       // 보낸 창 확인 + 미준비 + 예외 → 평범한 객체
  return async (e, arg) => {
    if (!fromMain(e)) return { ok: false, error: { type: 'forbidden', message: '허용되지 않은 요청이에요.', retryable: false } };
    if (!googleAuth) return { ok: false, error: { type: 'unavailable', message: G_UNAVAILABLE().reason, retryable: false }, status: G_UNAVAILABLE() };
    try { return await fn(arg || {}); }
    catch (err) { return { ok: false, error: { type: 'unknown', message: googleAuthMod.redact(String((err && err.message) || err)), retryable: false } }; }
  };
}
ipcMain.handle('google:status', (e) => {
  if (!fromMain(e) || !googleAuth) return G_UNAVAILABLE();
  try { return googleAuth.status(); } catch (_) { return G_UNAVAILABLE(); }
});
ipcMain.handle('google:setClient', gh((a) => googleAuth.setClient({ clientId: a.clientId, clientSecret: a.clientSecret, text: a.text })));
ipcMain.handle('google:clearClient', gh(() => { googleAuth.clearClient(); return { ok: true, status: googleAuth.status() }; }));
ipcMain.handle('google:signIn', gh((a) => googleAuth.signIn({ loginHint: a.loginHint || null })));
ipcMain.handle('google:cancelSignIn', gh(() => googleAuth.cancelSignIn()));
ipcMain.handle('google:signOut', gh(() => googleAuth.signOut()));
ipcMain.handle('gcal:calendars', gh(() => gcalSvc.listCalendars()));
ipcMain.handle('gcal:ensureExportCalendar', gh((a) => gcalSvc.ensureExportCalendar(a)));
ipcMain.handle('gcal:list', gh((a) => gcalSvc.listEvents(a)));
ipcMain.handle('gcal:instances', gh((a) => gcalSvc.listInstances(a)));
ipcMain.handle('gcal:push', gh((ops) => gcalSvc.push(ops)));

ipcMain.handle('clipboard:write', (_e, text) => { clipboard.writeText(String(text || '')); return true; });

// 보고서·백업 내보내기 — 사용자가 고른 위치에만 쓴다
ipcMain.handle('file:export', async (_e, suggestedName, content) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    defaultPath: suggestedName,
    filters: suggestedName.endsWith('.json')
      ? [{ name: 'JSON', extensions: ['json'] }]
      : [{ name: 'Markdown', extensions: ['md'] }, { name: '텍스트', extensions: ['txt'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try {
    await fs.writeFile(res.filePath, content, 'utf8');
    return { ok: true, path: res.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---------------------------------------------------------------- 창
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Daynote',
    icon: ICON(256),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111113' : '#F7F7F5',
    autoHideMenuBar: true,
    show: !process.argv.includes('--smoke') && !process.argv.includes('--shots'),   // smoke 검사는 창을 띄우지 않고 뒤에서만 돈다
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: !process.argv.includes('--smoke') && !process.argv.includes('--shots')   // 숨긴 창에서도 타이머가 제때 돌게
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Windows 로그오프·종료 — 트레이로 숨어 있어도 저장을 마무리하고 끈다
  mainWindow.on('session-end', () => { isQuitting = true; mainWindow.webContents.send('app:flush'); });
  mainWindow.on('query-session-end', () => { isQuitting = true; mainWindow.webContents.send('app:flush'); });
  // 메인 창이 정말 닫히면 (트레이로 숨기기가 꺼져 있을 때) 숨은 빠른 메모 창까지 함께 끈다
  mainWindow.on('closed', () => { mainWindow = null; isQuitting = true; app.quit(); });
  mainWindow.webContents.on('did-start-loading', () => { rendererReady = false; });

  // `npm run shots` — 화면별 스크린샷을 screenshots/ 에 저장하고 끈다 (창은 띄우지 않음)
  if (process.argv.includes('--shots')) {
    mainWindow.setContentSize(1440, 900);
    mainWindow.webContents.once('did-finish-load', async () => {
      try { await require('./scripts/shots')(mainWindow, path.join(__dirname, 'screenshots')); }
      catch (e) { console.log('SHOT-FAIL ' + e.message); }
      mainWindow.__flushed = true;
      app.exit(0);
    });
  }

  // `npm run smoke` —창을 띄워 화면이 실제로 그려지는지 확인하고 결과를 출력한 뒤 끈다
  if (process.argv.includes('--smoke')) {
    const errors = [];
    mainWindow.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
    mainWindow.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        const res = await mainWindow.webContents.executeJavaScript(`(function () {
          var D = window.Daynote || {};
          var out = { core: !!(D.model && D.recommend && D.suggest && D.weekly && D.slots && D.commands && D.adapt && D.statusCore && D.gcal && D.aiForced && D.planner), editor: typeof window.createEditor === 'function', views: Object.keys(D.views || {}).sort().join(','), title: document.title, rendered: !!document.querySelector('.sidebar') };
          ['notes', 'tasks', 'calendar', 'projects', 'weekly', 'inbox', 'settings', 'today'].forEach(function (v) { try { D.app.go(v); } catch (e) { out.fail = (out.fail || '') + v + ':' + e.message + ' '; } });
          // 다시 켰을 때 남아 있는지 보려고 메모를 하나 저장한다 (smoke 전용 프로필)
          out.notesAtStart = D.store.state.notes.length;
          D.app.saveQuick('smoke 확인 메모 ' + new Date().toISOString());
          // AI 정리 경로(화면 → IPC → services/ai)도 한 번 지나가 본다
          return D.aiFlow.loadStatus().then(function (s) {
            out.ai = s.provider || ('미연결: ' + s.reason);
            if (!s.configured) return null;
            var n = D.app.saveQuick('smoke AI 메모\\n- [ ] 금요일까지 보고서 검토 부탁드립니다\\n수요일 오후 2시 팀 회의');
            // 입력 저장과 함께 자동 분류가 돈다 — 끝날 때까지 기다렸다가 결과를 본다
            return new Promise(function (resolve) {
              var tries = 0;
              (function poll() {
                var note = D.model.byId(D.store.state.notes, n.id);
                if ((note.capture && note.capture.status !== 'pending') || tries++ > 50) return resolve(note);
                setTimeout(poll, 100);
              })();
            }).then(function (note) {
              var c = note.capture || {};
              out.aiResult = c.status + (c.error ? ' ' + JSON.stringify(c.error) : '');
              out.aiCapture = c.entryType + ' → ' + (c.created || []).map(function (x) { return x.kind; }).join(',');
            });
          }).then(function () { return D.store.flush(); }).then(function (ok) { out.saved = ok; return out; });
        })()`);
        console.log('SMOKE ' + JSON.stringify(Object.assign(res, { consoleErrors: errors })));
        mainWindow.__flushed = true;
        app.exit(errors.length || !res.core || !res.rendered || res.fail ? 1 : 0);
      }, 1500);
    });
  }

  // 메모 속 링크는 앱 안에서 열지 않고 기본 브라우저로 넘긴다
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  // 닫기 — 트레이가 있으면 숨기기만 한다 (빠른 메모 단축키가 계속 동작하도록)
  // 정말 끌 때는 화면에 남은 저장 대기분을 비우고 끈다
  mainWindow.on('close', (e) => {
    if (tray && closeToTray && !isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      mainWindow.webContents.send('app:flush');   // 숨기기 전에 저장 대기분을 바로 쓴다 (숨은 창은 타이머가 느려진다)
      trayHintOnce();
      return;
    }
    if (mainWindow.__flushed) return;
    e.preventDefault();
    mainWindow.webContents.send('app:before-close');
    setTimeout(() => { if (mainWindow) { mainWindow.__flushed = true; mainWindow.close(); } }, 1500);
  });
}

ipcMain.handle('app:flushed', () => {
  if (mainWindow) { mainWindow.__flushed = true; mainWindow.close(); }
});
ipcMain.handle('app:setCloseToTray', (_e, on) => { closeToTray = !!on; return closeToTray; });
ipcMain.handle('app:ready', () => {
  rendererReady = true;
  pendingQuick.splice(0).forEach((t) => mainWindow.webContents.send('quick:capture', t));
  return { quickKey: quickRegistered ? QUICK_KEY : null };
});

function showMain() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------- 빠른 메모 창
// 어디서든 Ctrl+Shift+Space → 화면 위쪽에 작은 입력창. 적고 Enter 면 메인 화면의 홈 입력과 똑같이 처리된다.
function createQuickWindow() {
  quickWindow = new BrowserWindow({
    width: 680, height: 140, show: false, frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
    backgroundColor: '#00000000', hasShadow: false, title: 'Daynote 빠른 메모',
    webPreferences: { preload: path.join(__dirname, 'quick-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
  });
  quickWindow.setAlwaysOnTop(true, 'pop-up-menu');
  quickWindow.loadFile(path.join(__dirname, 'renderer', 'quick.html'));
  quickWindow.on('blur', () => { if (quickWindow && quickWindow.isVisible()) quickWindow.hide(); });
  quickWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  quickWindow.on('closed', () => { quickWindow = null; });
}
function toggleQuick() {
  if (!quickWindow) createQuickWindow();
  if (quickWindow.isVisible()) { quickWindow.hide(); return; }
  // 마우스가 있는 모니터의 위쪽 1/5 지점, 가운데
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const [w] = quickWindow.getSize();
  quickWindow.setPosition(Math.round(d.x + (d.width - w) / 2), Math.round(d.y + d.height * 0.2));
  const show = () => { quickWindow.show(); quickWindow.focus(); quickWindow.webContents.send('quick:shown', ai.status()); };
  if (quickWindow.webContents.isLoading()) quickWindow.webContents.once('did-finish-load', show); else show();
}
ipcMain.handle('quick:submit', (_e, text) => {
  text = String(text || '').trim();
  if (!text) return { ok: false };
  if (!mainWindow) return { ok: false };
  if (rendererReady) mainWindow.webContents.send('quick:capture', text); else pendingQuick.push(text);
  return { ok: true };
});
ipcMain.on('quick:hide', () => { if (quickWindow) quickWindow.hide(); });
ipcMain.on('quick:resize', (_e, h) => {
  if (!quickWindow) return;
  const [w] = quickWindow.getSize();
  quickWindow.setSize(w, Math.max(80, Math.min(400, Math.round(h))));
});

// ---------------------------------------------------------------- 트레이
function trayHintOnce() {
  const flag = path.join(app.getPath('userData'), 'tray-hint-shown');
  if (fsSync.existsSync(flag) || !tray) return;
  try { fsSync.writeFileSync(flag, '1'); } catch (_) {}
  tray.displayBalloon({
    iconType: 'info', title: 'Daynote는 트레이에서 계속 실행돼요',
    content: 'Ctrl+Shift+Space로 어디서든 메모를 던질 수 있어요. 완전히 끄려면 트레이 아이콘 → 끝내기.'
  });
}
function createTray() {
  const img = nativeImage.createFromPath(ICON(16));
  img.addRepresentation({ scaleFactor: 2, buffer: fsSync.readFileSync(ICON(32)) });
  tray = new Tray(img);
  tray.setToolTip(quickRegistered ? 'Daynote — Ctrl+Shift+Space 빠른 메모' : 'Daynote');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Daynote 열기', click: showMain },
    quickRegistered ? { label: '빠른 메모', accelerator: QUICK_KEY, click: toggleQuick } : { label: '빠른 메모', click: toggleQuick },
    { type: 'separator' },
    { label: '끝내기', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('click', showMain);
}

// 두 번째로 실행하면 새로 띄우지 않고 이미 떠 있는 창을 보여 준다 (검사 실행은 제외)
const single = CHECK_RUN || app.requestSingleInstanceLock();
if (!single) app.quit();
else start();

function start() {
app.on('second-instance', showMain);
app.on('before-quit', () => { isQuitting = true; });
app.whenReady().then(() => {
  keystore = keystoreMod.create(app.getPath('userData'), safeStorage);
  if (!CHECK_RUN) ai.setSavedKey(keystore.read());
  if (!CHECK_RUN) {
    const fetchFn = (u, init) => net.fetch(u, init);
    googleAuth = googleAuthMod.create({ userDataDir: app.getPath('userData'), safeStorage, fetch: fetchFn,
      openExternal: (u) => shell.openExternal(u), env: envGoogleClient,
      onStatus: (st) => { if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('google:changed', st); },
      onFocusApp: showMain });
    gcalSvc = gcalMod.create({ auth: googleAuth, fetch: fetchFn });
  }
  createWindow();
  if (!CHECK_RUN) {
    try { createTray(); } catch (e) { console.log('tray failed: ' + e.message); tray = null; }
    try { quickRegistered = globalShortcut.register(QUICK_KEY, toggleQuick); } catch (e) { quickRegistered = false; }
    if (!quickRegistered) console.log('빠른 메모 단축키를 등록하지 못했습니다: ' + QUICK_KEY);
    if (tray) { tray.destroy(); createTray(); }   // 단축키 등록 결과에 맞춰 안내 다시
  }
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
}
