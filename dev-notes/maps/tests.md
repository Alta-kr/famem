# Daynote map — Tests, scripts, build, conventions

Repo `/home/user/famem`, app root `/home/user/famem/daynote` (all paths below are relative to the app root unless absolute).
Branch `web-mobile`. Last commit `d75f062` ("웹 데모 빌드와 폰 레이아웃 추가": added `scripts/build-web.js`, `DAYNOTE_WEB_DEMO` flag in `renderer/store.js`, ≤640px phone CSS).
Verified in this container on 2026-10-09 (UTC clock; the user's clock is Asia/Seoul).

---

## 0. Key facts

- `npm test` = `node --test "test/*.test.js"` → **123 tests in 12 files, all pass** (about 0.4 s). They need **no `node_modules`**: the `@anthropic-ai/sdk` and `@google/genai` SDKs are required lazily and stubbed out in the tests.
- The quoted glob needs **Node ≥ 21**. The container default is Node 22.22.0, where the run passes. Under `/opt/node20/bin/node` the run fails with `Could not find '.../test/*.test.js'`. On Node 20, use `node --test test/` instead.
- The tests are deterministic across time zones. They pass under UTC, Asia/Seoul, America/Los_Angeles and Pacific/Kiritimati, because every date is built with the local `new Date(y, m0, d, h, min)` constructor and passed in explicitly as `now`.
- `node_modules` is **absent**, so neither Electron nor the SDKs are installed. `npm run smoke` and `npm run shots` (both need Electron) **cannot run** right now.
- Headless check that works today: `node scripts/serve.js <port>` plus the global **Playwright 1.56.1** (`/opt/node-tools/node_modules/playwright`, browsers in `/opt/pw-browsers`, env `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`). Verified: every view renders with 0 console errors (§10).
- `src/core/**` is plain-ES5-syntax UMD. It registers itself as `window.Daynote.<name>` and also sets `module.exports`. `renderer/*.js` files are browser IIFEs. Two renderer files are reachable from Node:
  - `renderer/sample.js` is UMD, so tests can `require` it.
  - `renderer/store.js` is loaded with `vm` and a fake `window`/`localStorage`.
- `scripts/build-web.js` copies **all of** `renderer/` (except files whose path ends in `quick.html`/`quick.js`) and **all of** `src/` into `dist-web/`. It never copies `services/`, `main.js`, `preload*.js`, `assets/`, `scripts/` or `test/`. A new file is copied automatically, but it **only loads if `renderer/index.html` has a `<script>` tag for it**.

---

## 1. What runs where

| Layer | Files | Module style | Syntax | Tested in Node? |
|---|---|---|---|---|
| Business rules ("업무 규칙") | `src/core/{dates,model,recommend,suggest,weekly,split}.js` | UMD → `window.Daynote.X` + `module.exports` | ES5 (`var`, `function`), no DOM | **Yes**, fully |
| AI layer (pure) | `src/core/ai/{organizeNote,validate,proposals,capture,assist,fake}.js` | UMD → `window.Daynote.ai*` | ES5 | **Yes** |
| Main-process services | `services/ai.js`, `services/keystore.js` | CommonJS (`module.exports = {…}`) | ES2017+ (`const`, arrows, `async`) | **Yes** (fake clients, fake safeStorage) |
| Electron shell | `main.js`, `preload.js`, `quick-preload.js` | CommonJS, `require('electron')` | ES2017+ | **No** (only through `--smoke`) |
| Renderer | `renderer/*.js`, `renderer/views/*.js` | IIFE `(function () { … })();` using `window.Daynote` | ES5 | Only `store.js` (vm) and `sample.js` (UMD) |
| Vendored editor | `renderer/editor.js` (`window.createEditor`), `renderer/rules.js`, `renderer/vendor/codemirror.min.*` | globals | ES5 | No |
| Scripts | `scripts/*.js` | CommonJS | ES2017+ | No |

---

## 2. `package.json` (verbatim scripts)

```json
"main": "main.js",
"scripts": {
  "start": "electron .",
  "smoke": "electron . --profile=smoke --smoke",
  "test": "node --test \"test/*.test.js\"",
  "serve": "node scripts/serve.js",
  "build:web": "node scripts/build-web.js",
  "postinstall": "node scripts/fix-electron.js",
  "shots": "electron . --profile=shots --shots"
},
"devDependencies": { "electron": "32.3.3" },
"dependencies": { "@anthropic-ai/sdk": "^0.131.0", "@google/genai": "^2.27.0" }
```

Notes:
- There is no lint or format script and no eslint, prettier or editorconfig file in the repo.
- `scripts/fix-electron.js` mentions `npm run fix` in a comment, but no `fix` script exists.
- `scripts/make-icons.js` is not wired into npm scripts. Run it as `node scripts/make-icons.js`; it writes the `assets/icon-{16,32,256}.png` files.
- `.gitignore` contains `.env`, `node_modules/`, `screenshots*/` and `dist-web/`. So `dist-web/` is a local artifact. It currently exists, and its only differences from `renderer/` are the expected ones: `index.html` is rewritten and `web-demo.js` is added.
- The README (`README.md:6-15`) uses `npm.cmd` (Windows PowerShell). The project's primary target is **Windows**: DPAPI keystore, tray, `fix-electron.js` for win32 only.
- `.claude/launch.json` defines a preview config `daynote-web`: `node scripts/serve.js`, port `5178`.

---

## 3. UMD pattern in `src/core`

### 3.1 Template (copy exactly; this is `src/core/weekly.js:11-18` / `suggest.js:19-26`)

```js
'use strict';

// <한국어 설명: 무엇을 하는지, 상태를 바꾸는지/안 바꾸는지, 불변 규칙>

(function (factory) {
  var deps = (typeof module !== 'undefined' && module.exports)
    ? { dates: require('./dates'), model: require('./model') }
    : { dates: window.Daynote.dates, model: window.Daynote.model };
  var api = factory(deps.dates, deps.model);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.weekly = api; }
})(function (D, M) {
  var NO_PROJECT = '프로젝트 없음';
  // ...
  return { summarize: summarize, draftReport: draftReport, carryOver: carryOver, weekRange: weekRange };
});
```

Modules with no dependencies (`dates.js:6-10`, `model.js:18-22`, `split.js:8-12`, `ai/organizeNote.js:9-13`) use the short form:

```js
(function (factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.dates = api; }
})(function () { ... });
```

`ai/capture.js:12-17` takes a single dependency without a `deps` object: `var dep = (…module.exports) ? require('./organizeNote') : window.Daynote.aiOrganize;`.

### 3.2 Module → global name → dependencies (factory parameter letters)

| File | `window.Daynote.` | Node deps (`require`) | Factory params | Export object (line) |
|---|---|---|---|---|
| `src/core/dates.js` | `dates` | — | `()` | `DAY, WEEKDAYS, pad, ymd, parseYmd, startOfDay, endOfDay, addDays, addMinutes, startOfWeek, dayDiff, minutesBetween, hm, relDay, longDay, shortDay, duration, weekLabel` (`:87-91`) |
| `src/core/model.js` | `model` | — | `()` | `SCHEMA_VERSION(=3), TASK_STATUS, PRIORITY, HISTORY_TYPES, MANUAL_HISTORY_TYPES, uid, iso, emptyState, normalize, normalizeTask, byId, live*, …, clearSample` (`:454-470`) |
| `src/core/recommend.js` | `recommend` | `./dates`, `./model` | `(D, M)` | `recommend, checkStartable, signature, calendarContext, snoozeOptions, MAX_ALTERNATIVES` (`:270-273`) |
| `src/core/suggest.js` | `suggest` | `./dates`, `./model` | `(D, M)` | `parseDueHint, extractFromNote, extractFromEmail, scan, normalizeText, hash` (`:246-249`) |
| `src/core/weekly.js` | `weekly` | `./dates`, `./model` | `(D, M)` | `summarize, draftReport, carryOver, weekRange` (`:181`) |
| `src/core/split.js` | `split` | — | `()` | `DEFAULT, MIN_PX, KEY_STEP, normalize, minRatio, clampAll, moveEdge, round, isDefault` (`:80-83`) |
| `src/core/ai/organizeNote.js` | **`aiOrganize`** | — | `()` | `PROMPT_VERSION('organize-note.v2'), SYSTEM, SCHEMA, buildInput, userText` (`:108`) |
| `src/core/ai/validate.js` | `aiValidate` | `../dates`, `../model`, `../suggest` | `(D, M, SG)` | `verifyWhen, validateOrganizeNote, shapeErrors, timeCandidates, sanitizeSteps, noteLines, locate, DATE_RE, TIME_RE` (`:340-344`) |
| `src/core/ai/proposals.js` | `aiProposals` | `../dates`, `../model`, `../suggest`, `./validate` | `(D, M, SG, V)` | `noteHash, itemKey, startRun, finishRun, …, applyCapture, captureSetKind, captureSetItemKind, captureRemoveItem, captureItems` (`:772-780`) |
| `src/core/ai/capture.js` | `aiCapture` | `./organizeNote` | `(O)` | `PROMPT_VERSION('capture.v6'), ENTRY_TYPES, NOTE_KINDS, SYSTEM, SCHEMA, buildInput, userText` (`:83`) |
| `src/core/ai/assist.js` | `aiAssist` | `../dates`, `../model`, `./validate`, `../recommend` | `(D, M, V, R)` | `BREAKDOWN, ELABORATE, NUDGE_GAP_MIN, validateBreakdown, …, pickStretches` (`:274-280`) |
| `src/core/ai/fake.js` | `aiFake` | `../dates`, `../suggest`, `./validate` | `(D, SG, V)` | `organize` (`:192`) |
| `renderer/sample.js` (renderer, but UMD) | `sample` | `../src/core/dates`, `../src/core/model` | `(D, M)` | `build(state, now)` |

Naming rule: files under `src/core/ai/X.js` become `window.Daynote.aiX` in camelCase, **except** `organizeNote.js`, which becomes `aiOrganize`. Plain core files use their file name.

### 3.3 Browser load order (`renderer/index.html:16-56`)

Dependencies resolve **at script-execution time** from `window.Daynote.*`. A module therefore has to appear after all of its dependencies:

```
../src/core/dates.js, model.js, recommend.js, suggest.js, weekly.js, split.js
../src/core/ai/organizeNote.js, validate.js, proposals.js, capture.js, assist.js, fake.js
vendor/codemirror.min.js, rules.js, editor.js
sample.js, store.js, ui.js, app.js, aiflow.js, capture.js, assistant.js,
views/detail.js, schedule.js, chat.js, today.js, archive.js, review.js, notes.js, tasks.js,
calendar.js, projects.js, weekly.js, inbox.js, settings.js, palette.js
```

Two consequences:
- Renderer IIFEs grab `DN.model`, `DN.store` and similar **at load** (for example `renderer/views/tasks.js:10-11`).
- `DN.app` is referenced lazily (`var A = function () { return DN.app; };` in `views/weekly.js:13`, or `var A = DN.app` inside `render()`), because the views load after `app.js` but `app.js` boots on `DOMContentLoaded` (`app.js:345-346`).

### 3.4 UMD rules and gotchas

- The factory must not touch `window` or `document`; the only window access is the registration line. Core code is pure functions over a plain `state` object (`model.js:5`). The Node `require` path never defines `window`.
- In Node, both branches run when `window` is defined. That never happens under `node --test`, but the store vm test defines `window`. It does not load core modules through vm; it passes `{ Daynote: { model: M } }` directly.
- **Real-clock fallbacks.** Many functions take an optional trailing `now` and fall back to the wall clock when it is missing:
  - `model.iso(now)` (`model.js:39`) → `new Date(now || Date.now())`
  - `recommend(state, { now })` (`recommend.js:153`)
  - `suggest.parseDueHint(text, now)` (`suggest.js:103`)
  - `assist.nextNudge(state, { now })` (`assist.js:181`)
  - `proposals` `iso()` (`proposals.js:25`)
  - `dates.relDay(dateStr, now)` (`dates.js:58`)

  Forgetting to pass `now` gives silent wall-clock behaviour. Always pass `now`.
- **The AI date reference is `note.updatedAt`, not `ctx.now`**:
  - `organizeNote.buildInput` sets `referenceTime: note.updatedAt || new Date()` (`organizeNote.js:75`).
  - `validate.validateOrganizeNote` uses `ref: new Date(note.updatedAt || ctx.now || Date.now())` (`validate.js:239`).
  - `verifyWhen` does the same (`validate.js:326`).

  This is why tests do `note.updatedAt = NOW.toISOString()` after `M.addNote`.
- `model.uid(prefix)` = `prefix_ + Date.now() base36 + random + seq` (`model.js:34-37`). IDs are non-deterministic, so tests pass explicit `id: 't1'` when they need stable IDs.
- `model.emptyState().meta.createdAt` and `normalizeTask()` defaults for `createdAt`/`updatedAt` use the real clock (`model.js:41-56, 72-87`).
- Insertion order:
  - `addNote` and `addTask` **`unshift`**: the newest item is at `[0]` (`model.js:148, 181`).
  - `addProject`, `addBlock` and `mergeSuggestions` **`push`**.

  Tests rely on this: `st.tasks[0]` is the last task added.
- `conflictsFor` and the `weekly` filters compare **ISO strings lexicographically** (`model.js:332-339`, `weekly.js:74-83`). Always store `toISOString()` (Z) for `start`/`end`/`at`, and use `'YYYY-MM-DD'` for `dueDate`.
- Weeks start on Monday (`dates.startOfWeek`, `dates.js:39-43`).

---

## 4. Coding conventions (observed)

- Every JS file starts with `'use strict';`, then a blank line, then a **Korean** header comment. The header states responsibilities and invariants, for example "이 모듈은 상태를 바꾸지 않는다" or "본문은 데이터일 뿐이다".
- Comments are Korean, and so are all user-facing strings: toasts, errors and report text.
- Code identifiers are English camelCase.
- Section dividers:
  - Inside modules (`suggest.js:50`): `  // ------------------------------------------------------------------ 문자열 도우미`
  - In main, tests and scripts (`main.js:45`, `test/capture-v3.test.js:185`): `// ---------------------------------------------------------------- 저장소`
  - Header sub-sections use `// ── 감지 규칙 ──…`.
- **`src/core` and `renderer` use ES5 syntax only.** Measured counts:
  - 0 arrows, 0 `const`, 0 `let`, 0 template literals, 0 classes, 0 `async`, 0 `?.`/`??`, 0 spread.
  - ES2015+ *built-ins* are fine: `Object.assign` (56 uses), `String#endsWith` (`store.js:39`), regex lookbehind `(?<=…)` (`suggest.js:176`), `Math.imul`, `Set` in tests.
  - Use `var` and `function () {}`; iterate with `.forEach`/`.filter`/`.map`; `Array.prototype.slice.call(arguments)`.
- `services/`, `main.js`, `scripts/` and `test/` use modern Node syntax: `const`/`let`, arrows, `async`/`await`, destructuring, template literals (`shots.js`).
- Formatting: 2-space indent, single quotes, semicolons, long lines (150–200+ chars are common), several statements per line are common.
- Return shapes:
  - Result/IO style: `{ ok: true, … } | { ok: false, error: { type, message, retryable } }` (`services/ai.js`, `store.js` host).
  - Model mutators return the mutated or new object, or `null` when it is not found.
- Private or test-only hooks are prefixed with `_`:
  - `services/ai.js:253` `_setClients`
  - `views/calendar.js:223` `_mem`
  - `views/review.js:372` `_checked`, `_expanded`
- Window globals for test and debug use the `__daynote*` pattern (§7.2).
- Short module aliases used everywhere:
  - In core factories: `D`=dates, `M`=model, `SG`=suggest, `V`=validate, `R`=recommend, `O`=organizeNote.
  - In the renderer: `DN = window.Daynote`, `S = DN.store` (**`S` means store in the renderer but suggest in `suggest.test.js`**), `A = DN.app`, `ui`, `h = ui.h`, `W` = weekly, `P` = aiProposals.
  - In tests: `M, R, S(suggest), W, SP(split), V, P, O, C(capture), A(assist), D, fake`.

### 4.1 Renderer contracts (for testability context)

- View contract (`renderer/app.js:5-7`): `Daynote.views.<name> = { title, render(root, params) → { destroy?(), onChange?(info) → true to skip re-render, onTick?(now) } }`. Registered at `views/*.js` file ends, for example `DN.views.weekly = { title: '주간 정리', render: render };` (`views/weekly.js:332`).
- `DN.app` (`app.js:338-344`): `now, go, refresh, openTask, closeDetail, toggleDone, startTask, snoozeMenu, taskMenu, deleteTask, scheduleTask, openRef, applyPrefs, quickCapture, saveQuick, loadSample, clearSample, current, detailTaskId, nav`.
- **Renderer clock:** `app.js:28-29` `function now() { return window.__daynoteNow ? new Date(window.__daynoteNow) : new Date(); }`. All views should call `DN.app.now()` (or `A.now()`/`A().now()`), never `new Date()`.
  - Known exceptions that use `Date.now()` directly, so the clock is not frozen there: `assistant.js` idle and rest timers (`:19,167-218`), `chat.js:114` timer, `store.js:150` undo timestamp.
- Store API (`renderer/store.js:114-174`):
  - `state` (getter), `load()`, `whenReady(fn)`, `subscribe(fn)`, `onStatus(fn)`, `status()`
  - `mutate(label, fn, opts{silent, source})`: if `label` is non-null the call is undoable; it returns `fn`'s result.
  - `canUndo()`, `undo()`: restores the snapshot but **keeps current `prefs`**.
  - `flush()`, `retrySave()`, `replaceAll(next)`, `host`
- Host abstraction (`store.js:15-65`): `window.daynoteHost` (from `preload.js:6-29`) **or** a browser fallback backed by `localStorage` key `daynote:data`, with emergency copy `daynote:unsaved`.
  - The fallback host lacks `onQuickCapture`, `ready`, `onFlush` and `setCloseToTray`. Renderer code must guard them: `if (host.onFlush) …` (`store.js:179`), `assistant.js:214-216`, `views/settings.js:246`.

---

## 5. Tests

### 5.1 Runner and style

- Built-in `node:test` only. Every test is a top-level `test('한국어 설명', () => {…})`.
  - **No `describe`, `before`/`after`, mocks, `t.mock.timers`, `.skip` or `.only`** (grep-verified).
  - Async tests return a Promise (`async () => { await … }`).
- Assertions:
  - `require('node:assert')` with `strictEqual`/`deepStrictEqual`/`match`/`ok` in `suggest`, `weekly`, `store`, `split`, `ai`, `ai-provider`, `assist`, `capture`, `capture-v3`.
  - `require('node:assert/strict')` with `equal`/`deepEqual` (strict) in `model`, `recommend`, `sample`.
  - **Gotcha:** with plain `node:assert`, `assert.equal` is loose `==`. Use `strictEqual` there, or import `node:assert/strict`.
- File naming is `test/<module>.test.js`. Test names are Korean sentences describing the rule, sometimes numbered (`'1. 다음 일정까지 30분: …'` in `recommend.test.js`).
- `node --test` runs **each file in its own subprocess**. Module-level state (`model` `seq`, `services/ai` `inflight`, key variables) is isolated per file but shared between tests in the same file. `services/ai` is re-required with `freshAi()` to reset it.
- Run one file: `node --test test/weekly.test.js` (or just `node test/weekly.test.js`).
- Filter by name: `node --test --test-name-pattern="carryOver" test/weekly.test.js`.
- Reporters: `--test-reporter=dot` or `spec`. A non-TTY run defaults to TAP.

### 5.2 Inventory (123 tests)

| File | # | Modules under test | Fixed clock | Notable helpers / patterns |
|---|---|---|---|---|
| `test/model.test.js` | 8 | `model` | `NOW = new Date(2026, 9, 5, 10, 0)` (Mon), `LATER` = +1d, `at(h,m)` → ISO on 10-05 | complete/reopen history, soft delete, future-block deletion, suggestion merge/accept idempotency, `resolveRef` missing |
| `test/recommend.test.js` | 18 | `model`, `recommend` | `NOW` 2026-10-05 10:00, `at(h,m)` | `task(s, fields)`, `event(s, sh, sm, eh, em)`, `ids(list)`; tests for working hours (00:15 and 17:00) |
| `test/suggest.test.js` | 6 | `model`, `suggest` | `NOW = new Date(2026, 9, 6, 10, 0)` (**Tue**) | `parseDueHint` table, checkbox/request extraction, email quote/signature cut, `scan`, plus `mergeSuggestions` idempotency, "지시문은 문자열" (prompt-injection-as-data) |
| `test/weekly.test.js` | 5 | `model`, `weekly` | `WEEK = '2026-10-05'`, `NOW = new Date(2026, 9, 9, 17, 0)` (Fri), `at(d,h)` | `setup()` builds projects/tasks/history across the week; asserts report markdown headings and `'- 기록 없음'` ×5 |
| `test/split.test.js` | 12 | `split` | — | `near(a, b)` with 1e-9 tolerance, `sum(r)` |
| `test/sample.test.js` | 5 | `renderer/sample` (via `require('../renderer/sample')`), `model`, `recommend` | `NOW` 2026-10-05 10:00; also `new Date(2027, 2, 15, 9, 0)` | `built()`; checks every sample item has `sample:true`, that `sample.build` contains no hard-coded dates, `clearSample` |
| `test/store.test.js` | 1 | `renderer/store.js` via `vm` | — | `loadStore()` (below); undo keeps `prefs` |
| `test/ai.test.js` | 19 | `model`, `ai/validate`, `ai/proposals`, `ai/organizeNote`, `ai/fake` | `NOW` 2026-10-05 10:00 | `setup()` → `{ st, note }`, `goodOutput()` (canonical AI JSON), `when(text,date,time)`, `runOnce(st, note, out)`, recursive schema `walk` (`additionalProperties:false` and `required` == all keys) |
| `test/assist.test.js` | 9 | `ai/assist` (+ `validate`, `proposals`, `capture`, `fake`) | `NOW` 2026-10-05 10:00 | `capture(st, text)` runs the full fake pipeline; `A.pickStretches(3, 42)` seeded |
| `test/capture.test.js` | 8 | `ai/capture`, `proposals.applyCapture`, `captureToMemo/ToTask/SetProject` | `NOW` 2026-10-05 10:00 | `submit(st, text, output?)` |
| `test/capture-v3.test.js` | 29 | capture v3–v6 (kinds, set-kind round-trips, relative times, `do_at`, done/updated reports), `services/ai` model tiers, `services/keystore`, `.env`, key redaction | `NOW = new Date(2026, 9, 9, 10, 20)` (Fri) plus per-test `at` | `submit(st, text, patch)`, `submitWith(st, text, at)`, `live(list)`, async `withEnv`, `freshAi()`, `capInput(id)`, `fs.mkdtempSync(os.tmpdir())` |
| `test/ai-provider.test.js` | 3 | `services/ai` (provider choice, Gemini call shape, retry and error classes) | — | sync-or-async `withEnv(vars, fn)`, `freshAi()`, `ai._setClients({ gemini, retryDelayMs })` |

### 5.3 How tests fake time

There is no timer mocking. Everything is time-injected:

```js
const NOW = new Date(2026, 9, 5, 10, 0);          // month is 0-based: 9 = October → 2026-10-05 (월) 10:00 local
const at = (h, m) => new Date(2026, 9, 5, h, m || 0).toISOString();
M.addTask(s, { title: 'x' }, NOW);                 // trailing `now` on every mutator
R.recommend(s, { now: NOW, availableMinutes: 30 });
note.updatedAt = NOW.toISOString();                // anchor for AI relative dates (see §3.4)
```

- Conventional dates are the week of **2026-10-05 (Mon) – 10-11 (Sun)**. Mon 10:00 is the default; Tue 10-06 is used for suggest; Fri 10-09 for weekly and capture-v3.
- `shots.js` also uses `'2026-10-05T10:00:00'`.
- The user's "today" (2026-10-10, Sat) is not used anywhere; nothing depends on the wall clock.

### 5.4 State construction patterns

- Start from `M.emptyState()` and build through model mutators (`addProject/addTask/addNote/addBlock/addHistory/completeTask/...`), never by hand-written object literals. Exception: `st.emails.push({...})` in `suggest.test.js:62`, because there is no `addEmail`.
- Give fixed IDs when cross-references matter, for example `M.addProject(st, { id: 'p1', name: '…' }, NOW)`.
- Old data: `M.normalize({ version: 1, … })` upgrades to `SCHEMA_VERSION` (`ai.test.js:318-325`).

### 5.5 The AI pipeline as used in tests (no network)

The canonical order mirrors the renderer flow: **save note first → AI → validate → apply**.

```js
const note = M.addNote(st, { title: '', body: text, capture: { status: 'pending', at: NOW.toISOString() } }, NOW);
note.updatedAt = NOW.toISOString();
const input = C.buildInput(note, { today: '2026-10-05 (월)', projects: st.projects.map((p) => p.name), openTasks: [] });
const out = fake.organize(input).output;           // or a hand-written output object
const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, NOW);
const v = V.validateOrganizeNote(out, { note, state: st, now: NOW });
assert.ok(v.ok, v.errors.join());
const cap = P.applyCapture(st, { note, run, validated: v, output: out }, NOW);
```

This is `test/capture.test.js:23-33`. For the memo-organize flow, `runOnce` in `ai.test.js:160-166` uses `P.mergeOrganizeRun` followed by `P.finishRun(st, run.id, { status: 'succeeded', rawOutput }, NOW)`.

`fake.organize(input)` (`src/core/ai/fake.js:54-112`) is the deterministic AI oracle:
- It is rule-based on top of `suggest.extractFromNote` and `validate.timeCandidates`.
- Magic markers in the note body:
  - `'[가짜:지어내기]'` appends a fabricated task (quote not in the source), which `validate` must drop.
  - `'[가짜:실패]'` returns `{ ok:false, error:{ type:'server', retryable:true } }`.
- `input.purpose`:
  - `'capture'` adds `entry_type`, `note_kind`, `done_tasks`, `updated_tasks`, `do_at`, `size` and `breakdown` (`classifyCapture`, `:127-190`).
  - `'breakdown'`/`'elaborate'` returns `demoAssist` output.
- **Gotcha:** many capture-v3 assertions depend on fake's heuristics (`TASK_END_RE`, `LARGE_RE`, `DONE_RE`, `UPDATE_RE`, the `REL` relative-time regex). Changing `fake.js` or `suggest.js` patterns can break tests that look like they test `proposals`.

### 5.6 Testing `services/ai.js` (main process) without the SDKs

```js
const ENV = ['DAYNOTE_AI_FAKE', 'DAYNOTE_AI_PROVIDER', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY' /*, 'DAYNOTE_KEY_FROM_DOTENV' */];
function withEnv(vars, fn) { /* save+delete ENV keys, assign vars, run fn, restore (also after a Promise) */ }
function freshAi() { delete require.cache[require.resolve('../services/ai')]; return require('../services/ai'); }
ai._setClients({ retryDelayMs: 0, gemini: { interactions: { create: async (req) => ({ status: 'completed', output_text: JSON.stringify(OUT), usage: { total_input_tokens: 900, total_output_tokens: 120 } }) } } });
```

Sources: `test/ai-provider.test.js:9-25,55` and `capture-v3.test.js:186-198`.

- `services/ai.js` exports `{ status, organize, MODELS, setSavedKey, captureEnvKeys, redact, _setClients }` (`:255`).
- The SDKs are `require`d lazily inside `claude()` (`:116`), `classifyClaude()` (`:127`) and `gemini()` (`:166`). Injecting a client avoids loading them.
- **Gotcha:** the Claude path is untested, and `classifyClaude` throws `MODULE_NOT_FOUND` if the SDK is missing. Do not exercise the Claude error paths in tests without stubbing.
- `organize(input)` requires `input.noteId || input.requestId`. Concurrent calls with the same key return `{ error.type: 'busy' }` (`inflight` Set, `:42`, `:231-232`, `:248`). Use distinct IDs per call (`capInput('a')`, `capInput('b')`, …).
- Fake mode (`DAYNOTE_AI_FAKE=1`) sleeps **600 ms** before returning (`:235`).
- Key storage: `services/keystore.js` `create(userDataDir, safeStorage)` → `{ read, save, clear, hint }`. Tests inject a fake safeStorage `{ isEncryptionAvailable, encryptString, decryptString }` and an `fs.mkdtempSync(path.join(os.tmpdir(), 'dn-key-'))` dir (`capture-v3.test.js:258-275`). The temp dirs are **not cleaned up**.
- `loadDotEnv(dir)` fills `process.env` only for keys that are not already set, and sets `DAYNOTE_KEY_FROM_DOTENV=1`.

### 5.7 Testing a renderer IIFE (only `store.js` today)

`test/store.test.js:10-19`:

```js
function loadStore() {
  const mem = {};
  const localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
  const window = { Daynote: { model: M }, addEventListener() {} };
  const ctx = vm.createContext({ window, localStorage, setTimeout() { return 0; }, clearTimeout() {}, console, JSON, Promise, Date });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/store.js'), 'utf8'), ctx);
  return window.Daynote.store;
}
```

Gotchas for this approach:
- `setTimeout` is a no-op stub. Debounced saves and `whenReady` callbacks **never fire**, so call `S.flush()` explicitly.
- The context has **no `document`, `navigator`, `location`, `Blob` or `URL`**. Any new top-level (load-time) reference to those in `store.js` will crash this test with a `ReferenceError`. Today they are only referenced inside lazily called host functions.
- Only `window.Daynote.model` is provided. A new store dependency on another `DN.*` module must be added to the fake `window`.
- Other renderer files (`ui.js`, `app.js`, `views/*`, `aiflow.js`, `capture.js`, `assistant.js`, `palette.js`, `editor.js`) need a real DOM. `app.js` calls `document.addEventListener('DOMContentLoaded', start)` at load. **They have no unit tests.** The recommended route for renderer logic is to put it in `src/core` (pure, UMD) and test it there. That is the documented architecture: "업무 규칙 — 화면·Electron 을 모른다, Node 에서 그대로 테스트" (`README.md:36`, `index.html:15`).

---

## 6. What is NOT covered by `npm test`

- Everything in `renderer/` except `store.js` (one undo test) and `sample.js`.
- `main.js` (IPC handlers, window, tray, quick window, atomic save with `.bak`), `preload.js` and `quick-preload.js`.
- The Claude provider path, `services/ai.js` `callClaude`/`classifyClaude`.
- CSS and phone layout (`renderer/styles.css` media queries at `:1115-1137`, `:1323`, `:1336` (≤640px bottom tab bar)).
- Verification of these happens through `npm run smoke` (Electron, hidden window), `npm run shots` (Electron screenshots) and manual browser checks via `serve.js` (`DAYNOTE_UX_P1_REPORT.md:46-52`: "`npm test` 61/61 … Electron 스모크 테스트(숨긴 창) 통과 … 브라우저에서 … 확인").

### 6.1 IPC surface (main ↔ renderer), for anyone adding host features

- **`ipcMain.handle`** (`main.js`):
  - `store:load`, `store:save(json)`, `store:path`, `store:reveal`
  - `ai:status`, `ai:organizeNote(input)`, `ai:setKey(key)`, `ai:clearKey`, `ai:check`
  - `clipboard:write(text)`, `file:export(name, content)`
  - `app:flushed`, `app:setCloseToTray(on)`, `app:ready` → `{ quickKey }`
  - `quick:submit(text)`
- **`ipcMain.on`**: `quick:hide`, `quick:resize(h)`.
- **main → renderer `send`**: `app:flush`, `app:before-close`, `quick:capture(text)`, `quick:shown(status)`.
- **Preload exposure** (`preload.js:6-29`): `window.daynoteHost = { kind:'electron', load, save, dataPath, revealData, copyText, exportFile, ai:{ status, organizeNote, setKey, clearKey, check }, onBeforeClose, onQuickCapture, ready, onFlush, setCloseToTray, flushed }`.
- **Quick window** (`quick-preload.js`): `window.daynoteQuick = { submit, hide, resize, onShown }`.
- Every new host method also needs a **browser fallback in `renderer/store.js:15-65`**, or a guard at its call site. Otherwise serve.js and dist-web break.

---

## 7. Test and demo switches (env vars, argv, window globals, URL)

### 7.1 Main process (`main.js`)

| Switch | Where | Effect |
|---|---|---|
| `--profile=<name>` or `DAYNOTE_PROFILE` | `main.js:15-23` | `userData` → `"<userData> [<name>]"` (sanitized `[A-Za-z0-9_-]`, max 24 chars). Isolated data. |
| `--smoke` | `main.js:27-28,143,150,173-210` | hidden window, no background throttling, forces `DAYNOTE_AI_FAKE=1` unless `DAYNOTE_SMOKE_REAL=1` |
| `--shots` | `main.js:28,143,150,162-170` | hidden window, fake AI, runs `scripts/shots.js`, then `app.exit(0)` |
| `CHECK_RUN` (= smoke or shots) | `main.js:27,317,326-333` | skips the single-instance lock, saved key, tray and global shortcut |
| `DAYNOTE_AI_FAKE=1` | `services/ai.js:78` | fake provider (`status().provider === 'fake'`, model `'가짜 AI(테스트)'`) |
| `DAYNOTE_AI_PROVIDER=gemini\|claude`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `ANTHROPIC_API_KEY` | `services/ai.js:77-85` | provider choice. Keys are moved out of `process.env` by `captureEnvKeys()` at startup (`main.js:87`). |
| `.env` in the app dir | `services/keystore.js:11-27`, `main.js:31-32` | dev keys (not served: serve.js 403s dot-files) |

### 7.2 Renderer (browser or Electron)

| Switch | Where | Effect |
|---|---|---|
| `window.__daynoteNow = '2026-10-05T10:00:00'` | `renderer/app.js:28-29` | freezes `DN.app.now()`. **The string is parsed in the page's local TZ** (no `Z`). |
| `window.__daynoteFailSave = true` | `store.js:25` | browser host `save` fails, which exercises the error status and emergency copy |
| `window.__daynoteAiFail = true` | `store.js:54` | browser fake AI returns a retryable network error |
| `?fakeai` in the URL | `store.js:48,52,61` | browser host uses `Daynote.aiFake.organize` (500 ms delay) |
| `window.DAYNOTE_WEB_DEMO = true` | `store.js:48,52,61`; set by `dist-web/web-demo.js` | same as `?fakeai`, always on in the web demo. The UI shows the `'데모 모드'` chip when `provider === 'fake'` (`views/chat.js:122`). |

---

## 8. `npm run smoke` (in `main.js:172-210`, no separate script file)

- Runs `electron . --profile=smoke --smoke`. The window is created hidden (`show: false`).
- On `did-finish-load`, it waits 1500 ms and then calls `executeJavaScript` with an IIFE that:
  1. builds `out = { core: !!(D.model && D.recommend && D.suggest && D.weekly), editor: typeof window.createEditor === 'function', views: Object.keys(D.views).sort().join(','), title: document.title, rendered: !!document.querySelector('.sidebar') }`;
  2. calls `D.app.go(v)` for `['notes','tasks','calendar','projects','weekly','inbox','settings','today']`. It does **not** visit `archive`. Exceptions are appended to `out.fail`.
  3. records `out.notesAtStart`, then `D.app.saveQuick('smoke 확인 메모 ' + ISO)`. This **persists into the smoke profile**, so the count grows every run.
  4. calls `D.aiFlow.loadStatus()`. If configured (fake by default), it saves an AI memo and polls `note.capture.status` every 100 ms, up to 50 times, then fills `out.aiResult` and `out.aiCapture`.
  5. awaits `D.store.flush()` and sets `out.saved`.
- Output: one line, `SMOKE {json…, consoleErrors:[…]}`. Errors are collected from `console-message` with `level >= 3`.
- Exit code is `1` if there are console errors, `!rendered`, or `fail`; otherwise `0`.
- To extend: add new core globals to `out.core` and new views to the `go` list (`main.js:180-181`).

---

## 9. `npm run shots` (`scripts/shots.js`, invoked from `main.js:162-170`)

- Exports `module.exports = async function takeShots(win, outDir)` (`shots.js:138-164`). `main.js` calls it with `path.join(__dirname, 'screenshots')`, so the output goes to **`daynote/screenshots/<name>.png`** (gitignored `screenshots*/`; the P1 report also mentions `screenshots-before/`).
- It sets `process.env.DAYNOTE_AI_FAKE = '1'` (`:10`) and `NOW = '2026-10-05T10:00:00'` (Monday morning, `:12`). `MEMO` is a 6-line sample meeting note (`:14-21`).
- `STEPS` (`:24-131`) is an array of `[fileName, jsSource, size?]`. There are 24 steps, `01-첫실행-오늘` through `16-작은창-1280x800` (the last one has `{ width:1280, height:800 }`, and the resize persists).
  - The JS is a string with `${NOW}` interpolated. Its **last expression's value** is awaited if it is a Promise. Steps end with `null;` when nothing should be awaited.
- `PRELUDE` (`:134`) defines `window.clearToasts()` before every step.
- `SETTLE` (`:136`) finishes all `document.getAnimations()`. Hidden windows do not advance animations; without this, shots come out half-transparent.
- Loop per step:
  1. Optionally `setContentSize`.
  2. `executeJavaScript(PRELUDE + js, true)`. Errors are logged as `SHOT-ERROR <name> <msg>` and **the run continues**.
  3. Wait 700 ms, run SETTLE, `webContents.invalidate()`, wait 100 ms. Before the first shot it captures once and discards it (a stale frame), then runs `capturePage()` → `toPNG()`.
  4. Log `SHOT <file> WxH`.
- Step 01 waits for `Daynote.store.whenReady`, then `replaceAll(model.emptyState())`. The shots profile keeps data between runs, so this reset is needed. It also forces `prefs.theme = 'light'`.
- **Fragile coupling: these names are not checked anywhere else.** Renaming any of them silently degrades screenshots; you only get a `SHOT-ERROR` line.
  - APIs: `Daynote.store.{whenReady,replaceAll,mutate,state}`, `Daynote.model.{emptyState,addNote}`, `Daynote.app.{applyPrefs,go,loadSample,openTask,closeDetail,scheduleTask}`, `Daynote.assistant.{send,tryNudge,next,rest}`, `Daynote.ui.closeMenu`, `Daynote.palette.{open,close}`.
  - Selectors: `.chat-list`, `.cap-kind`, `.btn-ai`, `.review-foot button` (text `'확인할 항목'`, class `primary`), `.review-body`, `.ai-card`, `select[data-fk$=":durationMinutes"]`, `.cal-scroll`, `.overlay`, `#view button` (text `'초안 만들기'`), `.report-toolbar .seg button` (text `'편집'`), `.toast`.

---

## 10. Can smoke or shots run headless on Linux here?

- **Not as-is.**
  - `daynote/node_modules` and `/home/user/famem/node_modules` do not exist, so there is no Electron and no `npx electron` binary.
  - `npm install` would download Electron 32.3.3 (`postinstall` `fix-electron.js` is a no-op off win32, `:45`) plus the SDKs. Whether the proxy allows the GitHub download is untested.
  - If it were installed, the run needs a display and, as root, Chromium's sandbox disabled: `xvfb-run -a npx electron . --no-sandbox --profile=smoke --smoke`. `xvfb-run` and `Xvfb` exist at `/usr/bin`. **Unverified.**
  - Also note `webPreferences.sandbox: true` (`main.js:148`).
- **Verified alternative (no Electron):** run the renderer in headless Chromium through Playwright against `serve.js`, with `?fakeai` and `__daynoteNow`. Result:
  - `Daynote` keys were `aiAssist,aiCapture,aiFake,aiFlow,aiOrganize,aiProposals,aiValidate,app,assistant,capture,dates,model,palette,recommend,sample,split,store,suggest,ui,views,weekly`.
  - Views were `archive,calendar,chat,detail,inbox,notes,projects,review,schedule,settings,tasks,today,weekly`.
  - `go()` into all 9 navigable views raised no errors, there were 0 console errors, and `aiFlow.loadStatus().provider === 'fake'`.
  - `dist-web/index.html` at 390×844 had `DAYNOTE_WEB_DEMO === true` and `scrollWidth === 390` (no horizontal scroll).

```bash
cd /home/user/famem/daynote && node scripts/serve.js 5191 &   # any free port
NODE_PATH=/opt/node-tools/node_modules node -e '
const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: "Asia/Seoul" }); // match the user TZ
  const p = await ctx.newPage(); const errs = [];
  p.on("console", m => m.type() === "error" && errs.push(m.text())); p.on("pageerror", e => errs.push(e.message));
  await p.addInitScript(() => { window.__daynoteNow = "2026-10-05T10:00:00"; });   // set BEFORE app scripts run
  await p.goto("http://localhost:5191/renderer/index.html?fakeai");
  await p.waitForSelector(".sidebar");
  console.log(await p.evaluate(() => Object.keys(Daynote.views)), errs);
  await b.close();
})();'
```

  - Without `timezoneId`, the browser uses the container TZ (UTC), so local-time strings shift.
  - Each Playwright page starts with empty `localStorage`, giving a fresh first-run state. Use `Daynote.app.loadSample()` for data.
  - Do not use `dist-web` for CSP-sensitive checks, because its CSP meta is stripped (§12).
- The Playwright route covers the renderer and core only. `main.js`, IPC, preload, the tray and the quick window remain Electron-only. The browser host's AI is `aiFake` called directly; it does not go through `services/ai.js`.

---

## 11. `scripts/serve.js` — local static server (built-in modules only)

- Usage: `node scripts/serve.js [port]` or `npm run serve`. The port comes from `argv[2] || $PORT || 5178` (`:12`).
- **ROOT is the app dir** (`daynote/`), not `renderer/` (`:11`). `/` redirects 302 to `/renderer/index.html` (`:37-40`), so the `../src/` script paths resolve. `/dist-web/index.html` is also servable.
- Binds **`127.0.0.1` only** (`:69`) and rejects any `Host` header other than `localhost`, `127.0.0.1` or `[::1]` with 403 (DNS-rebinding guard, `:30-31`). **A phone on the LAN cannot reach it.** To test the phone layout on a real device, serve `dist-web/` with another server (global `serve@14`/`http-server@14` exist in `/opt/node-tools`), or use browser device emulation.
- Security filters:
  - GET/HEAD only (405 otherwise).
  - NUL → 400.
  - Any path segment starting with `.` → 403. This covers `.env`, `.git` and `.claude`.
  - A path that resolves outside ROOT → 403.
  - Any `node_modules` segment → 403.
  - **It does serve `main.js`, `services/*.js`, `test/` and so on** (verified `/services/ai.js` → 200). This is acceptable only because it is localhost-only.
- Responses carry `Cache-Control: no-store`. The MIME table is at `:14-20`; unknown types are sent as `application/octet-stream`. A directory URL without a trailing `/` gets a 301 to the slash form; a directory serves its `index.html`.
- Verified probes: `/` → 302; `/renderer/index.html` → 200; `/.env` → 403; `Host: evil.com` → 403.

---

## 12. `scripts/build-web.js` — web demo build (`npm run build:web`)

`scripts/build-web.js:14-28`, in order:
1. `fs.rmSync('dist-web', { recursive, force })`. This is a full wipe; never hand-edit `dist-web`.
2. `fs.cpSync('renderer', 'dist-web', { recursive, filter: (src) => !/quick(\.html|\.js)$/.test(src) })` copies **everything** in `renderer/` (views, vendor, fonts, CSS) except the quick window.
   - **Gotcha:** the regex is tested against the full absolute path and is not anchored to a basename. Any future file whose name *ends with* `quick.js` or `quick.html` (for example `views/quick.js` or `renderer/dayquick.js`) is silently dropped.
3. `fs.cpSync('src', 'dist-web/src', { recursive })` copies the whole `src/` tree.
4. Writes `dist-web/web-demo.js` = `window.DAYNOTE_WEB_DEMO = true;\n`.
5. Rewrites `dist-web/index.html`:
   - Removes the CSP `<meta http-equiv="Content-Security-Policy" …>`.
   - Replaces every `../src/` with `src/`.
   - Inserts `<script src="web-demo.js"></script>` **immediately before** `<script src="store.js"></script>`, keeping the indentation.
   - Throws `'store.js 스크립트 태그를 찾지 못했습니다'` if the `store.js` tag is not found.

What gets picked up automatically:
- A new `renderer/**` file (JS, CSS, assets) is **copied** automatically, but it only **loads** if `renderer/index.html` references it. There is no bundler and no manifest; `index.html` is the manifest.
- A new `src/**` file is copied automatically. Its `<script src="../src/…">` tag in `renderer/index.html` is rewritten automatically.
- `services/*`, `main.js`, `preload*.js`, `assets/` (icons), `scripts/` and `test/` are **never** in the web build. Anything the renderer gets from `window.daynoteHost` in Electron falls back to the `store.js` browser host there (localStorage persistence, `aiFake` AI, Blob download for export, `navigator.clipboard`). New main-process features need a browser fallback, or the web demo breaks.
- Nothing in the renderer references `../assets/` or other parent paths besides `../src/` (the only other hit is `renderer/sample.js:9`, a Node-only `require('../src/core/...')`). A new parent-path reference would break in `dist-web` because only `../src/` is rewritten.

Other notes:
- Paths in `dist-web` are relative, so it can be hosted under any sub-path. There is no minification, hashing or service worker.
- The web demo runs **without CSP**, while Electron and `serve.js` (`renderer/index.html:6`: `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:;`) enforce it. Code that works in `dist-web` can still fail in the app, for example inline `<script>`, `eval`/`new Function`, external fonts or images, or `fetch` (no `connect-src`). **Validate against `/renderer/index.html` via `serve.js`, not `dist-web`.**
- `dist-web` keeps the full data model and AI in the browser's `localStorage` (`daynote:data`). Data is per-browser and per-origin.

---

## 13. Other scripts

- `scripts/fix-electron.js` (postinstall): Windows-only repair. If `node_modules/electron/dist/electron.exe` is missing, it finds the cached `electron-v<ver>-win32-<arch>.zip` under `%LOCALAPPDATA%\electron\Cache`, expands it with PowerShell and writes `path.txt`. It returns immediately on non-win32 (`:45`) or when electron is not installed.
- `scripts/make-icons.js`: a pure-Node PNG writer (zlib + CRC). It draws a rounded accent square with three memo lines into `assets/icon-*.png`.

---

## 14. Checklists for new work

### 14.1 New pure rule module `src/core/foo.js` (or `src/core/ai/foo.js`)

1. Copy the UMD template (§3.1). Use ES5 syntax and Korean header comments.
   - Use `require('./dates')` from core, or `require('../dates')` / `require('./validate')` from `ai/`.
   - Browser globals are `window.Daynote.foo`, or `window.Daynote.aiFoo` under `ai/`.
2. Take `state` and `now` as explicit parameters and never read the clock implicitly. Return new data or mutate `state` in place; model mutators mutate and return the object.
3. Add `<script src="../src/core/foo.js"></script>` to `renderer/index.html` **after its dependencies and before any consumer** (§3.3).
4. Add `test/foo.test.js` (`node:test` + `node:assert/strict`, a fixed `NOW = new Date(2026, 9, 5, 10, 0)`, state from `M.emptyState()` plus mutators).
5. Optionally add it to the smoke `out.core` check (`main.js:180`).
6. `build-web` needs no change.

### 14.2 New renderer view or file

1. Write an IIFE: `'use strict'; (function () { var DN = window.Daynote; var M = DN.model, D = DN.dates, S = DN.store, ui = DN.ui, h = ui.h; … DN.views.foo = { title: '…', render: render }; })();`
2. Use `DN.app.now()` for time and `S.mutate(label|null, fn, { source, silent })` for every state change.
3. Add a `<script>` to `renderer/index.html`. Views load after `assistant.js` and before `palette.js`.
4. If it is navigable, update `NAV` in `app.js:14-21` (Alt+1–6 are used), and consider the smoke list (`main.js:181`) and a shots step.
5. Keep logic in `src/core` so that it can be tested. Otherwise the only check is the Playwright and serve route (§10).
6. Do not name it `*quick.js` (§12).

### 14.3 New main-process capability (IPC)

1. Put the logic in `services/foo.js` (CommonJS). Inject Electron objects so Node tests can fake them, as `keystore.create(dir, safeStorage)` does. Do not `require('electron')` in services.
2. Add `ipcMain.handle('foo:bar', …)` in `main.js`, expose it in `preload.js` under `daynoteHost`, and add a **browser fallback** in `renderer/store.js` host, or guard the call site with `if (host.x)`.
3. Test it with `withEnv` + `freshAi`-style re-require and `_set*` injection hooks.

### 14.4 New test file

- Use the name `test/<area>.test.js` so the glob picks it up. Write Korean test names that describe the rule. There are no shared helpers; each file defines its own `setup`/`submit`/`withEnv`. If something must persist across tests in the same file, keep the env/require-cache resets explicit.

---

## 15. Pitfalls (summary)

1. On Node < 21, `npm test`'s quoted glob fails (`Could not find …/test/*.test.js`). Use Node 22 (`/opt/node22`, the default) or `node --test test/`.
2. A missing `now` argument means wall-clock behaviour (`model.iso`, `recommend`, `suggest.parseDueHint`, `assist.nextNudge`, `relDay`). AI relative dates anchor on `note.updatedAt`.
3. Month is 0-based in `new Date(2026, 9, …)` (= October). The `__daynoteNow` and shots `NOW` strings have no `Z`, so they are interpreted in local TZ. The container is UTC while the user is Asia/Seoul.
4. `addTask`/`addNote` unshift (newest first), but `addBlock`/`addProject` push.
5. In the `node:assert` files, `assert.equal` is loose. Prefer `strictEqual`, or use `node:assert/strict`.
6. `fake.js` heuristics are a hidden dependency of capture tests and of the shots/demo output.
7. `services/ai` keeps module state (`inflight`, keys, client cache). Re-require it with `freshAi()` and use unique `noteId`s.
8. `store.test.js` vm context: no `document`, `location` or timers. Top-level DOM access in `store.js` breaks the test.
9. `build-web` quick filter regex, CSP stripped in `dist-web`, and `index.html` acts as the manifest (an unreferenced file is copied but never loads).
10. `serve.js` is localhost-only, so it cannot be reached from a phone. It serves the whole app dir except dot-files and `node_modules`.
11. smoke and shots require Electron (not installed). shots relies on many CSS selectors and `Daynote.*` APIs and fails soft (`SHOT-ERROR`). smoke writes a memo into the smoke profile on every run and skips the `archive` view.
12. Some docs are out of date:
    - `README.md:48` lists only 5 test files (there are now 12).
    - `DAYNOTE_UX_P1_REPORT.md:48` says 61 tests (there are now 123).
    - The `fix-electron.js` comment mentions a nonexistent `npm run fix`.
13. `capture-v3` tests leave `dn-key-*` and `dn-env-*` temp dirs in `os.tmpdir()`.
