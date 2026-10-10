# Map: Settings view, main process, secrets, AI provider

Scope: `daynote/renderer/views/settings.js`, `main.js`, `preload.js`, `quick-preload.js`, `services/ai.js`, `services/keystore.js`, `renderer/quick.{js,html}`, `renderer/store.js` (host shim), `renderer/aiflow.js` (status cache), tests `test/ai-provider.test.js`, `test/capture-v3.test.js` (keystore and key-isolation tests live **here**, not in ai-provider), `test/ai.test.js`, `package.json`.
All paths below are relative to `/home/user/famem/daynote` unless noted. Line numbers are from commit `d75f062` (branch `web-mobile`).

---

## 0. TL;DR facts

- The **main process owns secrets and network calls**. The renderer never sees the key. It gets a status object plus a `••••abcd` hint. The renderer CSP is `default-src 'none'` with no `connect-src` (`renderer/index.html:6`), so **the renderer cannot fetch any external URL**. Google API calls must therefore run in main.
- **The renderer owns all app data**. Main only writes the JSON string the renderer sends through `store:save` (`main.js:63-79`). **Main must never write `daynote-data.json` on its own.** The renderer would overwrite it on its next debounced save. To get main-side data (for example gcal events) into the app, send it to the renderer, which merges it with `S.mutate`.
- The settings view is `DN.views.settings = { title: '연결과 설정', render }` (`settings.js:278-279`). It is a single `render(root)` that builds 5 cards in order: **이메일 연결 → 캘린더 → AI 연결 → 데이터 → 화면(+단축키)** (`settings.js:272-274`). It returns `{}`, so it fully re-renders on every non-silent store change.
- Keys are encrypted with Electron `safeStorage` (DPAPI on Windows) into `<userData>/ai-key.bin` by `services/keystore.js`. The factory takes `safeStorage` as an injected argument, which is why it can be tested with a fake.
- `services/ai.js` is a **module-singleton with hidden state** (savedKey, envKeys, clients, retryDelayMs, inflight). Tests reset it with `delete require.cache[...]` (`freshAi()`), change `process.env` (`withEnv`), and inject fake SDK clients with `_setClients({ gemini, claude, retryDelayMs })`. The SDKs are `require`d lazily. **node_modules is not installed in this checkout**, yet `npm test` passes (123/123) because no test reaches a real SDK require.
- IPC naming convention is `namespace:verb`: `store:*`, `ai:*`, `app:*`, `quick:*`, `clipboard:write`, `file:export`. All renderer→main calls use `ipcMain.handle` and `ipcRenderer.invoke`, except `quick:hide` and `quick:resize`, which use `on`/`send`.
- P2 wants these settings changes: restructure the AI section into "AI 처리"; move technical text (env vars, model ids, .env) into an "고급" (advanced) area; split unsupported connections (Gmail/Outlook/외부 캘린더) into a "준비 중" (coming soon) group with the sample mailbox in a separate 체험 (try-it) area; add a work-hours UI for `prefs.workHours` (`DAYNOTE_UX_P1_REPORT.md:59`, details in `DAYNOTE_UX_REVIEW_CLAUDE.md:171-185`).

---

## 1. Process / file topology

```
main.js  (Electron main, CommonJS, Node 20 in Electron 32.3.3)
 ├─ require('./services/keystore')  → loadDotEnv(__dirname) at load time (main.js:31-32)
 ├─ require('./services/ai')        → ai.captureEnvKeys() at load time (main.js:85-87)
 ├─ ipcMain.handle(...) registered at MODULE TOP LEVEL (before app ready)
 ├─ start() → app.whenReady(): keystore = keystoreMod.create(userData, safeStorage); ai.setSavedKey(...)
 ├─ BrowserWindow main   → preload.js        → window.daynoteHost   → renderer/index.html
 └─ BrowserWindow quick  → quick-preload.js  → window.daynoteQuick  → renderer/quick.html
renderer/store.js: `var host = window.daynoteHost || { kind:'browser', ...localStorage shim... }` (store.js:15-65)
                   exposed as Daynote.store.host  (→ `S.host` everywhere)
```

- `src/core/**` files are UMD: they register on `window.Daynote.*` and also `module.exports`. The renderer loads them with `<script>`, and Node tests load them directly. `services/**` files are main-only CommonJS and **must not `require('electron')`**, because tests run in plain Node (`node --test "test/*.test.js"`, `package.json:10`). Only `main.js`, `preload.js`, and `quick-preload.js` require electron.
- Web builds: `scripts/serve.js` serves the repo statically (it blocks dotfiles, `node_modules`, and non-localhost Host headers; `serve.js:29-48`). `scripts/build-web.js` copies `renderer/` and `src/` into `dist-web/`, strips the CSP meta, rewrites `../src/` to `src/`, and injects `web-demo.js` (`window.DAYNOTE_WEB_DEMO = true`) before `store.js`. **`services/` is never shipped to the web.** Every new `daynoteHost` API therefore needs a browser stub in `store.js`.

### userData files (`app.getPath('userData')`; with `--profile=X` or `DAYNOTE_PROFILE=X` it becomes `userData + ' [X]'`, main.js:15-23)
| file | writer | notes |
|---|---|---|
| `daynote-data.json` | `saveData` main.js:63-76 | Written atomically: write `.tmp`, copy the old file to `.bak`, then rename. Writes are serialized on the `writing` promise chain. |
| `daynote-data.json.bak` | same | Fallback read in `loadData` (main.js:48-60). |
| `*.broken-<ts>` | loadData | A corrupt file is copied aside, never deleted. |
| `ai-key.bin` | keystore.save | `safeStorage.encryptString(key)` written as raw bytes. Not atomic, no file mode set. |
| `tray-hint-shown` | trayHintOnce main.js:293-301 | One-time balloon flag. |

---

## 2. main.js in detail

### 2.1 Electron APIs imported (main.js:6)
`app, BrowserWindow, ipcMain, dialog, clipboard, shell, safeStorage, nativeTheme, Tray, Menu, globalShortcut, nativeImage, screen`

| API | where | use |
|---|---|---|
| `shell.openExternal(url)` | main.js:213-216 | **Only** in `setWindowOpenHandler`, for `/^https?:\/\//` links. All window opens are denied. |
| `shell.showItemInFolder` | main.js:81 | `store:reveal` |
| `dialog.showSaveDialog` | main.js:117 | `file:export` (filters: JSON when the name ends in `.json`, otherwise md/txt) |
| `clipboard.writeText` | main.js:113 | |
| `safeStorage` | main.js:325 | Injected into `keystoreMod.create(userData, safeStorage)` |
| `Tray`, `Menu`, `nativeImage` | main.js:302-314 | Tray menu: Daynote 열기 / 빠른 메모 (accelerator only if registered) / 끝내기. `tray.displayBalloon` is Windows-only. |
| `globalShortcut.register('CommandOrControl+Shift+Space', toggleQuick)` | main.js:330 | `quickRegistered` is false if another app already holds the shortcut. `unregisterAll` runs on `will-quit` (335). |
| `screen` | main.js:272 | Places the quick window at the top 1/5 of the display under the cursor. |
| `nativeTheme.shouldUseDarkColors` | main.js:141 | Only sets the initial `backgroundColor`. The app theme pref is **not** pushed to `nativeTheme.themeSource`. |
| `app.requestSingleInstanceLock` | main.js:317 | `second-instance` calls `showMain` and **ignores argv** (relevant if you ever use a custom-protocol OAuth redirect). |

Not used anywhere: `protocol`, `net`, `session`, `Notification`, `powerMonitor`, `autoUpdater`, `app.setLoginItemSettings`, `app.setAsDefaultProtocolClient`.

### 2.2 Window security
Main window (main.js:133-153): `contextIsolation:true, nodeIntegration:false, sandbox:true, spellcheck:false`. `will-navigate` is prevented (217). The sandboxed preload can only use `contextBridge` and `ipcRenderer`, with no Node modules. The quick window (255-267) uses the same flags and is frameless, transparent, alwaysOnTop `'pop-up-menu'`, skipTaskbar, and hides on blur.

### 2.3 Modes and flags
- `CHECK_RUN = argv has --shots || --smoke` (main.js:27). `--shots`, or `--smoke` without `DAYNOTE_SMOKE_REAL=1`, sets `process.env.DAYNOTE_AI_FAKE='1'` (28). In CHECK_RUN: **the saved key is not loaded** (326), there is no tray or global shortcut (328-333), and there is no single-instance lock (317).
- The smoke script (main.js:173-210) visits `['notes','tasks','calendar','projects','weekly','inbox','settings','today']` via `D.app.go(v)`, so **settings render must not throw in Electron**. It exits with code 1 on any console error of level ≥3.
- Shots: `scripts/shots.js` step `15-연결과설정` (shots.js:118-121) calls `Daynote.app.go('settings')`.

### 2.4 IPC handler table (renderer → main)
| channel | line | args | returns |
|---|---|---|---|
| `store:load` | 78 | – | `{ok:true, data:Object\|null, recovered?:bool, path}` |
| `store:save` | 79 | `json:string` | `{ok:true, savedAt:ISO}` \| `{ok:false, error}` |
| `store:path` | 80 | – | string (data file path) |
| `store:reveal` | 81 | – | undefined |
| `ai:status` | 93 | – | `aiStatus()`, i.e. `ai.status()` plus `savedKey: '••••abcd'\|null` |
| `ai:organizeNote` | 94 | `input` (built by src/core/ai/*) | `ai.organize(input)` result (§4.6) |
| `ai:setKey` | 95-100 | `key:string` | `{ok:true, status}` \| `{ok:false, error:string, status}` |
| `ai:clearKey` | 101 | – | `{ok:true, status}` |
| `ai:check` | 103-111 | – | `{ok:true, ms, model}` \| `{ok:false, ms, error:{type,message,retryable}}` |
| `clipboard:write` | 113 | `text` | `true` |
| `file:export` | 116-130 | `suggestedName, content` | `{ok:true,path}` \| `{ok:false,canceled:true}` \| `{ok:false,error}` |
| `app:flushed` | 236 | – | Marks `__flushed` and closes the main window |
| `app:setCloseToTray` | 239 | `on:bool` | bool |
| `app:ready` | 240-244 | – | `{quickKey: 'CommandOrControl+Shift+Space'\|null}`. Also drains `pendingQuick`. |
| `quick:submit` | 278-284 | `text` | `{ok:bool}`. Forwards `quick:capture` to main, or queues it if the renderer isn't ready. |
| `quick:hide` (on) | 285 | – | – |
| `quick:resize` (on) | 286-290 | `h:number` | – (clamped 80..400) |

Main → renderer events (`webContents.send`): `app:flush` (155, 156, 225: session end or hide-to-tray), `app:before-close` (231), `quick:capture` (242, 282), `quick:shown` (275, payload `ai.status()` without savedKey).

`ai:check` (103-111) builds a real capture input (`capture.buildInput({id:'check-'+ts, body:'내일까지 견적서 보내기', ...}, {today, timezone:'Asia/Seoul', projects:[], openTasks:[]})`) and runs the **full** `ai.organize` path. In fake mode this takes about 600 ms.

```js
// main.js:89-92 — the status the renderer sees
function aiStatus() {
  const k = keystore ? keystore.read() : '';          // decrypts on every call
  return Object.assign(ai.status(), { savedKey: keystore ? keystore.hint(k) : null });
}
```

**Gotchas (main):**
- Handlers are registered before `whenReady`, but `keystore` is only created inside `whenReady` (325). `ai:setKey` and `ai:clearKey` would throw on `null` if called earlier. The renderer can't load that early, but a new handler that needs `safeStorage` or `app.getPath` must use the same lazy-init pattern. `safeStorage.isEncryptionAvailable()` is only valid after `ready`.
- No handler validates `event.sender` or `senderFrame`. Both windows are local, but a sensitive handler (OAuth connect/disconnect) could check `_e.sender === mainWindow.webContents`.
- Return values go through structured clone. Return plain objects, never `Error` instances. Follow the `{ok, error:{type,message,retryable}}` shape.
- `closeToTray` defaults to `true` in main (38). The renderer syncs `prefs.closeToTray` once at startup (`assistant.js:215`) and again on the settings checkbox (`settings.js:246`).
- On close: if the tray is active, the window hides and sends `app:flush`. Otherwise it sends `app:before-close`, and the renderer calls `flush()` then `host.flushed()` (`store.js:177`). There is a 1.5 s safety timeout (232).

---

## 3. preload bridges

### 3.1 `preload.js` → `window.daynoteHost` (preload.js:6-29)
```js
{ kind:'electron',
  load, save(json), dataPath, revealData, copyText(text), exportFile(name, content),
  ai: { status, organizeNote(input), setKey(key) /* String() coerced */, clearKey, check },
  onBeforeClose(fn), onQuickCapture(fn(text)), ready(), onFlush(fn), setCloseToTray(on), flushed() }
```

### 3.2 Browser fallback (`renderer/store.js:15-65`), used when there is no `daynoteHost`
- `kind:'browser'`. `load`/`save` use localStorage key `daynote:data`, with an emergency copy in `daynote:unsaved`. `dataPath` returns `'브라우저 localStorage'`. `revealData` is a no-op. `exportFile` uses a Blob download.
- `ai.status()`: if `window.DAYNOTE_WEB_DEMO` is set or the URL contains `?fakeai`, it returns `{configured:true, provider:'fake', model:'가짜 AI(테스트)'}`. Otherwise it returns `{configured:false, reason:'…GEMINI_API_KEY 또는 ANTHROPIC_API_KEY 를 설정해 주세요.'}`. That reason string **contains env var names**, which P2 wants removed from user-facing text.
- `ai.setKey` returns `{ok:false, error:'브라우저 미리보기에서는 키를 저장할 수 없습니다.'}`. `clearKey` returns `{ok:true}`. `check` returns fake success or an error.
- **No** `onQuickCapture`, `ready`, `onFlush`, or `setCloseToTray`. Callers guard with `if (host.x)` (`assistant.js:214-216`, `settings.js:246`). **Any new host API (`google`, `gcal`, work-hours sync, …) must either get a stub here or be feature-checked at every call site.** Otherwise the web demo, `serve.js`, and the settings page will throw.
- Test hooks: `window.__daynoteFailSave`, `window.__daynoteAiFail`, `window.__daynoteNow` (`app.js:29`).

### 3.3 `quick-preload.js` → `window.daynoteQuick`
`submit(text)` (sliced to 20000 chars) → `invoke('quick:submit')`. `hide()` → `send('quick:hide')`. `resize(h)` → `send('quick:resize')`. `onShown(fn(status))` → `on('quick:shown')`.

### 3.4 Quick window (`renderer/quick.html`, `renderer/quick.js`)
- Its own inline CSS. The theme follows **only** `prefers-color-scheme` (quick.html:14-16), never `prefs.theme`. It has its own CSP. The `@font-face` path is relative to `renderer/`.
- In `quick.js`: Enter sends, unless IME composition is in progress (`e.isComposing || keyCode===229`, line 39). Shift+Enter inserts a newline. Esc hides. `onShown` resets the sent state, shows the AI dot (`status.configured`), and focuses and selects the textarea. After a send it auto-hides after 700 ms on success or 2000 ms on failure.
- `build-web.js` excludes `quick.html` and `quick.js` from `dist-web`.

---

## 4. services/ai.js (255 lines)

### 4.1 Exports (ai.js:255)
`{ status, organize, MODELS, setSavedKey, captureEnvKeys, redact, _setClients }`

### 4.2 Provider selection: `mode()` (ai.js:77-85)
```
DAYNOTE_AI_FAKE==='1'                     → 'fake'
DAYNOTE_AI_PROVIDER==='gemini'|'claude'   → that provider if its key is present and not badKey, else null
geminiKey() ok                            → 'gemini'   (default)
anthropicKey() ok                         → 'claude'
else null
```
- `geminiKey() = savedKey || envGemini()`. `envGemini()` re-reads `process.env.GEMINI_API_KEY || GOOGLE_API_KEY` live, then falls back to the captured `envKeys.gemini`. Priority is **saved > env > .env**. The `.env` loader never overrides a real env var.
- `anthropicKey()` comes from env only. **The saved key is always treated as a Gemini key.** `keystore.save`'s regex `^[A-Za-z0-9_\-]{20,200}$` accepts `sk-ant-…`, but the key would then be sent to Gemini and fail with an auth error.
- **`GOOGLE_API_KEY` is treated as a Gemini key.** Never reuse that env name for Calendar or OAuth configuration.
- `badKey(k)` rejects keys containing whitespace or control characters (68), so a pasted key with a newline can't leak into SDK header errors.

### 4.3 `status()` shape (ai.js:87-103)
```js
fake:   { configured:true, provider:'fake', model:'가짜 AI(테스트)' }
gemini: { configured:true, provider:'gemini', model:'gemini-3.8-flash', fastModel:'gemini-3.5-flash-lite',
          vendor:'Google', keySource:'saved'|'env'|'dotenv'|null, notice:'Gemini API 무료 등급에서는 …' }
claude: { configured:true, provider:'claude', model:'claude-opus-5-5', vendor:'Anthropic' }   // no keySource
none:   { configured:false, provider:null, model:null, reason: <Korean string> }
```
`reason` texts: badKey → "AI 키에 공백이나 줄바꿈이…". Forced gemini → **"GEMINI_API_KEY 환경변수가 설정되어 있지 않습니다."** Forced claude → **"ANTHROPIC_API_KEY 환경변수…"**. Default → "AI 키가 없습니다. 설정에서 Google AI Studio 키를 넣어 주세요." `test/ai-provider.test.js:46` asserts `/GEMINI_API_KEY/` on the forced-gemini reason, so changing that text breaks the test.
Main adds `savedKey` (§2.4). Consumers of this status: `settings.js` aiCard, `chat.js:121-123` (chip), `review.js:68-78`, `capture.js:44-46` (copies `reason` into `note.capture.reason`), `aiflow.js:77`, and the quick window.

### 4.4 Key isolation
- `captureEnvKeys()` (ai.js:51-58) copies `GEMINI_API_KEY`/`GOOGLE_API_KEY`/`ANTHROPIC_API_KEY` into the module-private `envKeys`. It records `source = DAYNOTE_KEY_FROM_DOTENV==='1' ? 'dotenv' : 'env'`, then **deletes those keys and `DAYNOTE_KEY_FROM_DOTENV` from `process.env`** so child processes don't inherit them. It also resets both clients.
- `setSavedKey(k)` (50) trims, stores, and sets `geminiClient = null`. **This also discards any client injected with `_setClients`.**
- `redact(msg)` (70-75) replaces every known key with `[키 가림]`, plus the regexes `AIza[0-9A-Za-z_-]{10,}` and `sk-ant-[0-9A-Za-z_-]{10,}`. If you add OAuth tokens, extend this list or write an equivalent (`ya29\.` access tokens, `1//` refresh tokens).

### 4.5 Calls
- `requestDef(input)` (30-36) picks the request definition by `input.purpose`: `'capture'` → `src/core/ai/capture`, `'breakdown'` → `assist.BREAKDOWN`, `'elaborate'` → `assist.ELABORATE`, anything else → `organizeNote`. Each definition provides `{SYSTEM, SCHEMA, userText(input)}`.
- `MODELS = { claude:'claude-opus-5-5', gemini:'gemini-3.8-flash', geminiFast:'gemini-3.5-flash-lite' }`. `THINKING = { 'gemini-3.8-flash':'low', 'gemini-3.5-flash-lite':'minimal' }` (39-40).
- Gemini (`@google/genai`, lazy `require` in `gemini()` 164-170, `new GoogleGenAI({apiKey, httpOptions:{timeout:120000}})`):
```js
gemini().interactions.create({ model, system_instruction: def.SYSTEM, input: def.userText(input),
  generation_config:{ thinking_level }, response_format:{ type:'text', mime_type:'application/json', schema: def.SCHEMA },
  store:false })   // → { status:'completed'|'incomplete'|'budget_exceeded'|…, output_text, usage:{total_input_tokens,total_output_tokens,total_thought_tokens} }
```
- `callGeminiTiered` (213-224): `capture` tries `[fast, full]`; other purposes try `[full, fast]`. On a retryable error, or a 404 (model missing), it sleeps (`retryDelayMs ?? (rate_limit ? 300 : 1200)`) and tries the other model once. A non-retryable error is rethrown with `e._classified`.
- Claude (`@anthropic-ai/sdk`, lazy require, `maxRetries:2`, timeout 120 s): `claude().beta.messages.create({model, max_tokens:16000, betas:['server-side-fallback-2026-07-01'], fallbacks:'default', output_config:{effort:'low', format:{type:'json_schema', schema}}, system:[{type:'text', text, cache_control:{type:'ephemeral'}}], messages:[{role:'user', content}]})`. It handles `stop_reason` values `refusal` and `max_tokens`.
- `classifyGemini(e)` (172-182) classifies by `e.status`: 401/403 → auth (message mentions **GEMINI_API_KEY**), 429 → rate_limit, 400 with an /API key/ message → auth, other 400 → bad_request, ≥500 → server, other numeric status → api, no status → network (retryable).
- `classifyClaude(e)` (126-136) uses `instanceof Anthropic.*Error`, so it **needs the real SDK installed**. Without node_modules, the Claude error path throws MODULE_NOT_FOUND inside `organize`'s catch, and the promise rejects. No test covers the Claude path.

### 4.6 `organize(input)` contract (ai.js:226-250)
- Precondition errors: not configured → `{ok:false, error:{type:'not_configured', message: status().reason}}`. The dedupe key is `input.noteId || input.requestId`; a missing key gives `bad_input`, and a duplicate in flight gives `busy`.
- Fake: waits 600 ms, then calls `fake.organize(input)` (`src/core/ai/fake.js`).
- On `invalid_json` it re-calls once (`attempts:2`).
- Success: `{ ok:true, provider, model, output, raw, usage, attempts }`. Failure: `{ ok:false, error:{type,message,retryable}, raw?, attempts }`.
- Error `type` values: `auth, permission, rate_limit, bad_request, network, server, api, unknown, invalid_json, refusal, truncated, failed, not_configured, bad_input, busy`. The renderer adds `ipc` and `invalid_output`.

---

## 5. services/keystore.js (52 lines)

```js
loadDotEnv(dir) → bool          // reads <dir>/.env; for each KEY=VALUE line (KEY ~ [A-Z0-9_]+, quotes stripped, '#' lines skipped)
                                // sets process.env[KEY] only if unset and VALUE is non-empty. Returns true if GEMINI_/GOOGLE_API_KEY
                                // came from it, and in that case also sets process.env.DAYNOTE_KEY_FROM_DOTENV='1'.
create(userDataDir, safeStorage) → { read, save, clear, hint }
  read()      → string  // '' when missing, encryption unavailable, or decrypt fails (all errors swallowed)
  save(key)   → {ok:true} | {ok:false, error}  // trims; empty → '키가 비어 있어요.'; regex ^[A-Za-z0-9_\-]{20,200}$ ;
                                               // !isEncryptionAvailable → '이 컴퓨터에서는 키를 안전하게 저장할 수 없어요.'
                                               // mkdir -p, writeFileSync(file, safeStorage.encryptString(key))
  clear()     → {ok:true}  // unlink, errors ignored
  hint(key)   → '••••' + last4 | null
```
- `safeStorage` uses DPAPI (user-scoped) on Windows, Keychain on macOS, and libsecret/kwallet on Linux. On Linux it can fall back to the weak `basic_text` backend, so `isEncryptionAvailable()` may still be true. The app targets Windows (per the UX doc), but keep this in mind for anything new.
- The file name `ai-key.bin` and the Gemini-shaped regex are **hard-coded**, so the keystore is not a general secret store. `save()` would reject an OAuth token JSON (dots, slashes, braces). For Google tokens, add a sibling factory such as `createSecretFile(userDataDir, safeStorage, 'google-token.bin')` that stores `encryptString(JSON.stringify({...}))`. Alternatively, generalize `create(dir, safeStorage, {file, validate})` and keep the current defaults so the existing tests keep passing.
- `.env` is read from `__dirname` (the app folder). In a packaged app that folder is inside the asar, so `.env` support is effectively dev-only. The `.gitignore` lists `.env`, `node_modules/`, `screenshots*/`, and `dist-web/`.
- `scripts/fix-electron.js` comments mention `npm run fix`, but **no such script exists** in package.json.

---

## 6. Renderer-side AI status cache (`renderer/aiflow.js`)
- `DN.aiFlow.status()` returns the last fetched status object. Its initial value is `{configured:false, reason:'확인 중…'}` (12).
- `DN.aiFlow.loadStatus()` calls `host.ai.status()`, caches the result, notifies listeners, and resolves with the status. It runs on DOMContentLoaded (122). Settings calls it again after save or clear (`settings.js:76`). Nothing polls, so if the key changes elsewhere, the status stays stale until the next load.
- `DN.aiFlow.onChange(fn)` notifies on status loads and run start/finish.

---

## 7. renderer/views/settings.js (280 lines) structure

Module locals: `DN, M=model, D=dates, S=store, ui, h=ui.h, A=()=>DN.app`. `connectTimer` (13) is module-level.

| lines | piece | notes |
|---|---|---|
| 15-21 | `STATUS` map | `disconnected/connecting/connected/error/reauth` → `{text, dot:''\|'busy'\|'ok'\|'err'}`. Reuse it for a Google Calendar connection card. |
| 23 | `sampleMails()` | `S.state.emails.filter(e => e.sample)` |
| 25-32 | `scanAfterSync()` | `DN.suggest.scan(state, now)` then `M.mergeSuggestions` inside `S.mutate(null, …)`. Returns the number added. |
| 34-47 | `connectSample()` | Sets `emailConnection` to connecting, then to connected after a 700 ms timeout, then scans and toasts with a "제안 보기" action that calls `go('inbox')`. |
| 49-58 | `syncNow()` | |
| 60-67 | `disconnect()` | `ui.confirm(...)`, then the labeled mutate `'메일 연결 해제'`, then `ui.undoToast`. |
| 72 | `KEY_SOURCE` | `{env:'환경변수', dotenv:'앱 폴더의 .env 파일', saved:'이 앱에 저장한 키'}`. **Technical text; candidate for 고급.** |
| 74-137 | `aiCard(root)` | See §7.1 |
| 139-276 | `render(root)` | Builds the cards. See §7.2 |
| 278-279 | registration | `DN.views.settings = { title:'연결과 설정', render }` |

### 7.1 `aiCard(root)` (74-137)
- `aiSt = DN.aiFlow.status()`. `rerender = () => loadStatus().then(() => { root.textContent=''; render(root); })` re-renders the **whole settings view**. This bypasses `app.renderView`, which is harmless because the view returns `{}`.
- Label (77-80): `'연결 안 됨'` | `'데모 모드 — 실제 AI가 아니에요'` (fake) | `'연결됨 · Google Gemini'` | `'연결됨 · Anthropic Claude (' + model + ')'`. **The Claude label shows the model id.**
- Elements:
  - `input#set-ai-key` (password, placeholder `AIza로 시작하는 키를 붙여 넣으세요`, `aria-describedby=set-ai-key-help`).
  - Buttons: save (`'키 저장'`, or `'키 바꾸기'` when `savedKey` is set) → `S.host.ai.setKey(k)`, then clear the input, toast, and rerender. `'연결 확인'` (only when configured) → `S.host.ai.check()`, which writes `'잘 연결됐어요 · 1.2초 · <model>'` into the `span.help[role=status]`. `'저장한 키 지우기'` (only when `savedKey` is set) → `ui.confirm`, then `S.host.ai.clearKey()`, then rerender.
  - In fake mode the whole input row is hidden (124).
- `models` list (112-117), Gemini only: shows **model ids** `gemini-3.5-flash-lite` and `gemini-3.8-flash` with their roles. **Technical; candidate for 고급.**
- Help text (130-131): "Google AI Studio(aistudio.google.com)에서 무료로 만들 수 있어요. 키는 … Windows 보안 저장소로 암호화…".
- `aiSt.notice` (133): free-tier data-use warning in a `div.conflict-box`. **Keep**, since it describes data transmission.
- Transmission paragraph (134-136): what is sent (text, project names, open task titles) to `aiSt.vendor + ' API'`. **Keep**; the review explicitly asks to retain the data-scope explanation.
- `aiSt.reason` is **not shown** in settings. An unconfigured state only shows "연결 안 됨".

### 7.2 `render(root)` cards (in order)
1. **이메일 연결** `section.card.settings-card[aria-labelledby=set-mail]` (145-187): status line with dot and text, a `chip-sample` badge, last sync time, `c.error` in `div.conflict-box[role=alert]`, and a read-only privacy paragraph. **It also contains the "새 할 일 제안 보기" link with a pending count (154-160). This is the only UI entry to the inbox view besides Ctrl+K, because it was removed from the sidebar (app.js:13). Keep it reachable when you restructure.** Action buttons depend on status (162-172). When disconnected, `div.provider-list` (176-186) mixes **Gmail (disabled, "이 버전에서는 아직 지원하지 않습니다.")**, **Outlook (disabled)**, and **샘플 메일함으로 체험** (connect or load sample). P2 wants these split into "준비 중" and "체험".
2. **캘린더** (190-193): a static green dot with "앱 안 캘린더만 사용 중" and the note "외부 캘린더(Google·Outlook) 동기화는 … 아직 지원하지 않습니다." **Google Calendar connect UI goes here.**
3. **AI 연결**: `aiCard(root)`.
4. **데이터** (198-218): path from `S.host.dataPath()`, fetched asynchronously on every render. Buttons: 폴더 열기 → `S.host.revealData()`; 전체 백업 내보내기 → `S.flush()`, then `S.host.exportFile('daynote-백업-YYYY-MM-DD.json', JSON.stringify(S.state, null, 2))`; 샘플 지우기/불러오기 → `A().clearSample()` / `A().loadSample()`. **The backup exports the entire `S.state`. Never put tokens or secrets in state.**
5. **화면** (222-270):
   - Theme `div.seg[role=group]` with `button[data-theme-opt][aria-pressed]` for system/light/dark. It runs `S.mutate(null, fn, {silent:true})`, then `A().applyPrefs()`, then updates `aria-pressed` manually. `'system'` deletes `prefs.theme`.
   - `#set-motion` checkbox → `prefs.reduceMotion` (non-silent mutate, which re-renders).
   - `#set-tray` checkbox → `prefs.closeToTray` (silent), then `S.host.setCloseToTray(v)` if present.
   - `h3 '단축키'` with a hard-coded `KEYS` table (249-261). It shows `Ctrl + Shift + Space` even if registration failed; the real value is `DN.assistant.quickKey()`. It also shows `Alt + 1~6`, while UX_V2 §8 says `Ctrl+1~6`; the code (app.js:300) uses **Alt**.
   - Desktop-only rows (tray, global shortcut) still appear in the browser and web demo. Hide them with `S.host.kind !== 'electron'` if needed.
6. Page wrapper (272-274): `div.view-pad > div.page-head(page-title '연결과 설정', page-sub '외부 연결 상태와 데이터, 화면 설정을 관리합니다.')`, then the cards in the order above.

### 7.3 UI building blocks available
- `ui.h(sel, attrs?, ...kids)` (`ui.js:10-30`). `sel` is `'tag.cls#id'`. Attribute handling:
  - `on*` functions become event listeners. `style` objects are assigned.
  - `checked`, `disabled`, and `selected` are set as properties. `value` is set as a property.
  - `text` sets textContent. `html` sets innerHTML (fixed strings only).
  - `null` and `false` attributes or children are skipped. Arrays are flattened.
- `ui.icon(name)`: names include `settings, mail, inbox, calendar, refresh, download, link, alert, check, clock, theme, x, …` (ui.js:40-77). There is no `google` or `lock` icon.
- `ui.toast(msg, {error, action:{label,fn}, duration})`, `ui.undoToast(msg)`, `ui.confirm(title, message, okLabel) → Promise<bool>`, `ui.modal({title, body, actions, footLeft, wide, onClose})` (export map at ui.js:451-452).
- CSS (styles.css:837-851, 495-505, 878):
  - Card and row layout: `.settings-card`, `.settings-row` (`.grow .lbl .help`), `.check-row`.
  - Connection status: `.status-line`, `.status-dot(.ok|.err|.busy)`, `.provider-list`, `.provider`.
  - Controls and boxes: `.seg button[aria-pressed]`, `.conflict-box`.
  - Chips: `.chip-sample`, `.chip-sched`, `.chip-guess`.
  - Buttons: `.btn .btn-sm .btn-xs .btn-primary .btn-danger .btn-ghost .link-btn`.
- There is **no `<details>`/disclosure pattern** in the codebase yet. A "고급" section needs a new pattern, either native `<details><summary>` (needs new CSS) or a button with `aria-expanded`.
- Time input precedent: `.cap-pick-row .input[type="time"] { width:110px }` (styles.css:1224).
- Phone layout (≤640px, styles.css:1336+) sets `.view-pad { padding:16px 16px 40px }`. The `KEYS` table uses `white-space:nowrap` on its `kbd` cells and may overflow on narrow screens.

### 7.4 View lifecycle gotchas
- The view contract (app.js:5-6) is `render(root, params) → { destroy?, onChange?(info) → true to skip re-render, onTick? }`. Settings ignores `params`. **Deep-linking such as `go('settings', {section:'ai'})` is not supported.** Callers that open settings (`chat.js:177` "설정 열기" on a no_ai card, `palette.js:43`) just call `go('settings')`.
- Because `render` returns `{}`, **every non-silent `S.mutate` anywhere re-renders settings**: a capture arriving from the quick window, a background AI result, or toggling `reduceMotion`. A typed but unsaved key in `#set-ai-key`, the "연결 확인" result text, and the focus of any new `<input type=time>` are all lost. When you add editable fields, either mutate prefs with `{silent:true}` and update the DOM yourself (as the theme control does), or return `{ onChange: info => /* true when irrelevant */ }`.
- `store.undo()` restores the whole pre-mutation snapshot **except `prefs`** (store.js:159-169). Prefs changes therefore should not get an undo label. Use `S.mutate(null, …)`. It also means **any state merged after a labeled user action (for example a gcal sync) is rolled back by Ctrl+Z.** Make sync idempotent and re-runnable.

---

## 8. Data model touchpoints for settings (`src/core/model.js`)
- `emptyState()` (41-55) includes `emailConnection: {status:'disconnected', provider:null, lastSyncAt:null, error:null}`, `prefs: {sidebarCollapsed:false, reduceMotion:false}`, and `meta: {createdAt, sampleLoaded:false}`.
- **`normalize(raw)` (58-70) iterates only the keys of `emptyState()`**, so unknown top-level keys are **dropped** on load. I verified this: `normalize({foo:1}).foo` is undefined. The comment "모르는 필드는 버리지 않는다" is only true for nested object fields, which are shallow-merged with `Object.assign({}, default, raw)`. Consequences:
  - A new top-level slice (`calendarConnection`, `externalEvents`, `google`, …) **must be added to `emptyState()`**.
  - New `prefs.*` keys (`workHours`, `theme`, `closeToTray`) survive without changes, but nested defaults are not deep-merged. `prefs.workHours` is either the raw object or absent.
- Prefs currently in use: `sidebarCollapsed`, `reduceMotion`, `theme` ('light'|'dark'|absent=system), `closeToTray` (absent=true), `workHours` (absent=default), plus home split ratios (see the comment in store.js:162).
- `clearSample` (438-452) resets `emailConnection` when `provider==='sample'`.
- `SCHEMA_VERSION = 3` (23). It is bumped only for structural layers. Adding a defaulted top-level key does not strictly require a bump, but document it in the version comment if you do bump.

---

## 9. Work hours (P2 UI to build)
- Data: `S.state.prefs.workHours = { start:'HH:MM', end:'HH:MM' }`. It is **absent by default**. The default `{start:'09:00', end:'18:00'}` lives in `recommend.js:158` (`var wh = opts.workHours || {...}`).
- How it's evaluated: `D.parseYmd(D.ymd(now), wh.start)` (dates.js:25-31). It is lenient: a bad string becomes `Number(x)||0`, i.e. 00:00. `offHours = now < start || now >= end`. **If start ≥ end, every time is off-hours.** Overnight shifts, weekdays, and weekends are not modeled. The UI must validate that start < end.
- Consumers:
  - `assistant.js:70`: `R.recommend(S.state, { now, skipIds, workHours: S.state.prefs.workHours })`.
  - **Bug/gap:** `src/core/ai/assist.js:173` (`looksIdle`) calls `R.recommend(state, { now })` **without `workHours`**, so it always uses 09-18. Pass `state.prefs.workHours` when you add the UI.
  - The reason text in `recommend.js:119` shows `'근무 종료(' + ctx.workHours.end + ')까지'`.
  - Tests: `test/recommend.test.js:225-253` (default policy only).
- P1 report line 43: "근무 시간 값은 `prefs.workHours`로 바꿀 수 있지만, 아직 설정 화면 UI는 없다."
- Suggested UI: a row in the 화면 card, or a new "하루 리듬/근무 시간" card, with two `input.input[type=time]` fields. Save with `S.mutate(null, s => { s.prefs.workHours = {start, end}; }, {silent:true})`. Provide a "기본값(09:00–18:00)으로" reset that deletes the key.

---

## 10. P2 settings restructure: what exists vs. what's wanted

Requirement sources: `DAYNOTE_UX_P1_REPORT.md:59` and `DAYNOTE_UX_REVIEW_CLAUDE.md:171-185`.
- Group the sections as **AI 처리 / 이메일·캘린더 / 데이터·화면**.
- AI 처리: "로컬만 / 자동 선택 / API 사용". **Options that aren't implemented must not be enabled.** No local engine exists today; the only modes are fake, gemini, claude, and none. Show the engine, connection state, and processing location in plain language (e.g. "데모 모드 · 실제 AI 미연결"). Never fall back to the external API if local processing fails.
- Move technical items (env var names, providers, .env, model ids) to **고급**. Keep the transmission-scope explanation.
- Unsupported providers should read **"준비 중"**. The sample mailbox goes in a separate **체험** area.
- Show running, cancel, and failed states for AI work.

Technical strings to relocate or soften:
| text | where |
|---|---|
| `KEY_SOURCE` env/.env labels | settings.js:72, 122 |
| Gemini model ids list | settings.js:112-117 |
| Claude label with model id | settings.js:80 |
| "Google AI Studio(aistudio.google.com)…" | settings.js:131 (arguably user-facing: they need to get a key) |
| status reason "GEMINI_API_KEY 환경변수…" / "ANTHROPIC_API_KEY 환경변수…" | ai.js:99-100 (test asserts /GEMINI_API_KEY/ at ai-provider.test.js:46) |
| auth errors "GEMINI_API_KEY 를 확인해 주세요" / "ANTHROPIC_API_KEY 를 확인해 주세요" | ai.js:174, 128. These reach users via the check result (settings.js:103) and the capture failure card (chat.js:179). |
| browser reason "…GEMINI_API_KEY 또는 ANTHROPIC_API_KEY…" | store.js:49 |
| "가짜 AI(테스트)" model name | ai.js:89, store.js:48. Shown in check results and review chips. The review says "가짜 AI" wording doesn't fit the product. |

Unsupported or "준비 중" items today: Gmail and Outlook (settings.js:177-180) and external calendar (settings.js:193). README:98 lists them as 미구현 (not implemented).

---

## 11. Testing conventions (how to make a new service testable)

- Runner: `node --test "test/*.test.js"` (Node 22 here; glob support in `--test` needs Node ≥21). Uses `node:test` and `node:assert` with `strictEqual`/`deepStrictEqual`/`match`. Test names are Korean sentences. No mocking library is used.
- **Env isolation helper** (copy it; it's duplicated per file):
```js
const ENV = ['DAYNOTE_AI_FAKE','DAYNOTE_AI_PROVIDER','GEMINI_API_KEY','GOOGLE_API_KEY','ANTHROPIC_API_KEY','DAYNOTE_KEY_FROM_DOTENV'];
async function withEnv(vars, fn) { const saved = {}; ENV.forEach(k => { saved[k] = process.env[k]; delete process.env[k]; });
  Object.assign(process.env, vars); try { return await fn(); } finally { ENV.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); } }
function freshAi() { delete require.cache[require.resolve('../services/ai')]; return require('../services/ai'); }
```
  (capture-v3.test.js:186-194. ai-provider.test.js:9-25 has a sync/async-tolerant variant.)
- **Fake SDK client injection** (ai-provider.test.js:55, 74, 79, 85, 91; capture-v3.test.js:204-236):
```js
ai._setClients({ retryDelayMs: 0, gemini: { interactions: { create: async (req) => {
  sent = req;                                                     // assert on request shape
  if (fail) throw Object.assign(new Error('quota'), { status: 429 });   // errors carry numeric .status
  return { status: 'completed', output_text: JSON.stringify(OUT), usage: { total_input_tokens: 900 } };
} } } });
```
  Call `_setClients` **after** `setSavedKey`/`captureEnvKeys`, because both null the clients.
- **Fake safeStorage + tmp dir** (capture-v3.test.js:258-275):
```js
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-key-'));
const fakeSafe = { isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('enc:' + Buffer.from(s).toString('base64')),
  decryptString: (b) => Buffer.from(String(b).slice(4), 'base64').toString() };
const ks = K.create(dir, fakeSafe);
```
- `.env` test (277-290) writes a `.env` into a tmp dir and calls `K.loadDotEnv(dir)`.
- Key-leak tests (307-320) check that `redact` works and that `JSON.stringify(result)` contains no key fragment.
- Existing tests cover none of: main.js IPC, the settings view (no DOM tests at all), the Claude call path, or `ai:check`. UI is only exercised by `npm run smoke` and `npm run shots` (Electron, hidden window) and by manual browser runs (`npm run serve`, `?fakeai`).

---

## 12. Plugging in `services/google-auth.js` + `services/gcal.js`

### 12.1 Constraints from the existing architecture
1. **Main-only network and secrets.** The renderer CSP blocks `connect-src`, and the design rule is that the renderer never sees credentials (ai.js header, keystore header).
2. **No `require('electron')` inside services**, or Node tests break. Inject `safeStorage`, `shell.openExternal`, and `app.getPath('userData')` from main.js, the same way `keystoreMod.create(app.getPath('userData'), safeStorage)` does (main.js:325). Lazily `require` any npm dependency. Prefer no new deps: Electron 32's Node 20 has global `fetch`. Electron's `net.fetch` honors the system proxy but needs injecting.
3. **Factory with DI** (keystore style) is preferred over ai.js's module singleton with `_setClients`. Suggested signature:
```js
// services/google-auth.js
create({ userDataDir, safeStorage, fetch = globalThis.fetch, openExternal, clientId, clientSecret /* desktop clients: not truly secret */,
         now = () => Date.now(), listen /* injectable loopback server for tests */ })
  → { status() /* {status:'disconnected'|'connecting'|'connected'|'error'|'reauth', email?, error?} */,
      connect() /* Promise<{ok, status}|{ok:false, error:{type,message,retryable}}> */, cancel(), disconnect(),
      getAccessToken() /* refresh when expired; invalid_grant → status 'reauth' */ }
// services/gcal.js
create({ auth /* google-auth instance */, fetch }) → { listEvents({ timeMin, timeMax, calendarId='primary' }) → {ok, events:[...]} | {ok:false, error} }
```
4. **OAuth redirect**: use the loopback flow, `http://127.0.0.1:<ephemeral>/` with PKCE (S256) and a `state` check, opened via the injected `shell.openExternal(authUrl)`. A custom protocol would need `app.setAsDefaultProtocolClient` plus argv parsing in `second-instance` (main.js:322, which currently only calls `showMain`). Bind to `127.0.0.1` only, as `serve.js:69` does. Add a timeout and a cancel path that maps to the `connecting → 취소` button pattern (settings.js:166-167). Request `access_type=offline` and `prompt=consent` to get a refresh token. Scopes: `https://www.googleapis.com/auth/calendar.readonly` (or `calendar.events.readonly`), plus `openid email` to display the account.
   - Gotcha: refresh tokens for OAuth apps in Google "Testing" publishing status **expire after 7 days**. Map `invalid_grant` to `reauth` (STATUS map, settings.js:20).
5. **Secret storage**: write a separate encrypted file such as `<userData>/google-token.bin` containing the refresh token, scope, and email. Keep the access token in memory only. **Do not reuse `keystore.save`**: its regex is Gemini-shaped and its file name is fixed (§5). Disconnect should delete the file and best-effort revoke via `https://oauth2.googleapis.com/revoke`.
6. **Client ID config**: read a dedicated env var (e.g. `DAYNOTE_GOOGLE_CLIENT_ID` / `DAYNOTE_GOOGLE_CLIENT_SECRET`). `loadDotEnv` already loads any `[A-Z0-9_]+` key from `.env`. Capture it and delete it from `process.env` the way `captureEnvKeys` does. **Do not use `GOOGLE_API_KEY`**: ai.js treats it as a Gemini key and deletes it at startup.
7. **Redaction**: add token patterns to error messages, following `ai.redact` (ai.js:70-75). Never return tokens over IPC. Status should carry only `email` and state.
8. **CHECK_RUN**: in smoke and shots runs, don't touch Google. Either skip auth init or report `disconnected`, mirroring `if (!CHECK_RUN) ai.setSavedKey(...)` (main.js:326).

### 12.2 Wiring checklist
- **main.js**
  - Require the services at the top and lazily create the instances in `whenReady`, where `safeStorage` is available.
  - Register `ipcMain.handle('google:status' | 'google:connect' | 'google:cancel' | 'google:disconnect')` and `ipcMain.handle('gcal:list', (_e, {timeMin, timeMax}) => …)`. Follow the existing `namespace:verb` style.
  - Optionally push `mainWindow.webContents.send('gcal:changed', …)` or a status event, and focus the main window after the browser redirect (`showMain()`).
- **preload.js**: add `google: { status, connect, cancel, disconnect }` and `gcal: { list }` (plus `onGoogleStatus(fn)` if you push) under `daynoteHost`. Coerce arguments the way `setKey` does with `String(...)`.
- **store.js browser shim**: add stubs, e.g. `google.status → {status:'disconnected', available:false, reason:'데스크톱 앱에서만 연결할 수 있어요.'}`. Otherwise the web demo and smoke-in-browser break.
- **model.js**: add the new top-level slice to `emptyState()` so `normalize` keeps it, e.g. `calendarConnection:{status:'disconnected', provider:null, account:null, lastSyncAt:null, error:null}`, mirroring `emailConnection`. Decide whether `clearSample` should touch it.
- **Event storage choice**:
  - Option (a): store events as `blocks` with `kind:'event', origin:'gcal', externalId, calendarId, readOnly:true`. `addBlock` keeps extra fields, so they automatically appear in `calendar.js:116` (`placeBlocks`), `today.js:372` (agenda), `palette.js:105` (search), and `recommend.js:65-80` (`calendarContext`: `kind:'event'` counts as busy), and in conflicts via `M.conflictsFor`. However, `views/schedule.js` (`open({blockId})`), drag-move in the calendar, and `deleteBlock` must refuse to edit read-only blocks, and the AI duplicate/conflict checks in `validate.js` will see them.
  - Option (b): store them in a separate `externalEvents` array and teach each consumer about it.
  - Either way, the **renderer** merges them with `S.mutate(null, fn, {source:'gcal'})` (unlabeled, so the sync isn't an undo step). Main returns the data and never writes the data file.
- **Settings UI**: replace the static 캘린더 card (settings.js:190-193) with a connection card that reuses `STATUS` and the `actions` pattern from the email card (162-172): 연결 / 연결 중… 취소 / 지금 동기화 / 연결 해제 / 다시 연결 (reauth). Show the account email and last sync time, plus a short data-scope line ("일정 제목·시간만 읽기, 바꾸지 않음"), matching the mail card's privacy paragraph (151-153). The Outlook calendar stays under "준비 중".
- **Tests**: `test/google-auth.test.js` with fake `fetch` (record URL and body, return `{ ok, status, json: async () => … }`), a fake safeStorage from capture-v3, a tmp `userDataDir`, and an `openExternal` that captures the auth URL and then simulates the redirect (with an injected `listen`, or a real `http.get` to the loopback port). Assert PKCE and state presence, token-file encryption (no plaintext on disk), `invalid_grant → reauth`, and redaction. In `test/gcal.test.js`, map Google `events.list` items to the block shape: all-day events have `start.date` rather than `start.dateTime`; check `status:'cancelled'`, recurring `singleEvents=true`, and pagination via `nextPageToken`.

---

## 13. Misc gotchas and inconsistencies
- README:80 says "키는 환경변수로만 읽고 앱에 저장하지 않는다". That is stale: keys are now saved via keystore (README:18 and §5).
- The settings help text says "Windows 보안 저장소" unconditionally (settings.js:131), but `safeStorage` differs per OS.
- `ai.status()` is called on every `quick:shown` (main.js:275). `aiStatus()` decrypts the key file on every `ai:status` call. Both are cheap but synchronous.
- The quick window ignores `prefs.theme`. If a theme setting should cover it, send the theme to main and set `nativeTheme.themeSource` or post it to the quick window.
- `assistant.js:216` only reads `ready()` → `quickKey` once. The settings shortcut table doesn't use it.
- Saving a key while the provider is Claude (Anthropic env key only) switches the provider to Gemini, unless `DAYNOTE_AI_PROVIDER=claude`, which is never captured or deleted from env.
- `connectTimer` is module-level, so leaving the settings view doesn't cancel a pending sample connect. The timer callback re-checks status, so it's harmless.
- `ui.toast` keeps at most 2 toasts (ui.js:97).
- `D.app.go(view)` falls back to `'today'` for unknown view names (app.js:115).
