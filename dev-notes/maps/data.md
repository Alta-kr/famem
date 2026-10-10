# Daynote: data model, store, persistence and IPC map

Scope: `daynote/src/core/model.js`, `daynote/renderer/store.js`, `daynote/renderer/sample.js`, `daynote/main.js`, `daynote/preload.js`, `daynote/quick-preload.js`, `daynote/test/model.test.js`, `daynote/test/store.test.js`. Where an entity's real shape is set somewhere else, this map follows it there (`src/core/ai/proposals.js`, `src/core/ai/assist.js`, `src/core/ai/validate.js`, `src/core/suggest.js`, `renderer/capture.js`, `renderer/assistant.js`, `renderer/aiflow.js`, `renderer/app.js`, the views).
All paths below are relative to `/home/user/famem/daynote`. Line numbers come from the `web-mobile` branch at commit d75f062.

---

## 0. Ten-second summary

- The whole app state is **one plain JSON object**. In Electron it is saved to `userData/daynote-data.json`; in a plain browser it is saved to `localStorage['daynote:data']`.
- `src/core/model.js` is a UMD module of **pure mutators** that take `(state, ...args, now)`. They know nothing about the DOM, storage or Electron. It exports `window.Daynote.model` and `module.exports`.
- `renderer/store.js` (`window.Daynote.store`) owns the live state. **Every write goes through `store.mutate(label, fn, opts)`.** A non-null `label` adds an undo snapshot (a deep JSON clone, at most 30). Saving is debounced by 400 ms. When a save fails, the state is copied to `localStorage['daynote:unsaved']` as an emergency copy.
- `SCHEMA_VERSION = 3`. `normalize(raw)` is the only "migration". It fills missing defaults for known top-level keys, shallow-merges object keys, and runs `normalizeTask` on every task. There are **no per-version migration steps**, and **unknown top-level keys are dropped on load**.
- `prefs` is not covered by undo: `store.undo()` keeps the current `state.prefs`. Code writes prefs with `S.mutate(null, fn, {silent:true})`.
- Renderer and main talk only through `window.daynoteHost` (from `preload.js`, built with contextIsolation and a sandbox). In a browser without Electron, `store.js` builds a fallback `host` with the same surface (localStorage, Blob download, fake AI behind `DAYNOTE_WEB_DEMO` or `?fakeai`).
- Main saves atomically: it writes `*.tmp`, copies the old file to `.bak`, then renames `tmp` over the target. Writes are serialized on a promise chain. On load it tries the main file, then `.bak`, and keeps a corrupt file aside as `.broken-<ts>`.

---

## 1. Module wiring and load order

`renderer/index.html` loads plain `<script>` tags in this order. There is no bundler and no modules.

```
../src/core/dates.js, model.js, recommend.js, suggest.js, weekly.js, split.js
../src/core/ai/organizeNote.js, validate.js, proposals.js, capture.js, assist.js, fake.js
vendor/codemirror.min.js, rules.js, editor.js
sample.js, store.js, ui.js, app.js, aiflow.js, capture.js, assistant.js, views/*.js, palette.js
```

- Core modules use a UMD factory: `(function(factory){ var api=factory(); module.exports=api; window.Daynote.<name>=api; })`. Each one registers on `window.Daynote`:
  - `model` (model.js:18-22)
  - `dates`
  - `aiProposals`
  - `aiAssist`
  - `aiValidate`
  - `aiFake`
  - `suggest`
  - `recommend`
  - `weekly`
  - `split`
  - `sample` (sample.js:7-14, which `require`s `../src/core/dates` and `../src/core/model` under Node)
- `store.js` is a **browser-only IIFE**. It needs `window.Daynote.model` to exist already and has no `module.exports`. `test/store.test.js` loads it with `vm.runInContext` and fakes `window`, `localStorage` and `setTimeout`.
- `app.js` starts the app on `DOMContentLoaded`: `buildShell()`, then `S.load()`, then `S.subscribe(onStoreChange)`, `applyPrefs()` and `go('today')` (app.js:319-336).
- The web demo build (`scripts/build-web.js`) copies `renderer/` to `dist-web/` (without `quick.html` and `quick.js`) and copies `src/` to `dist-web/src/`. It removes the CSP meta tag, rewrites `../src/` to `src/`, and inserts `<script src="web-demo.js">` (`window.DAYNOTE_WEB_DEMO = true;`) **just before `store.js`**, so the browser host turns on the fake AI.
- `scripts/serve.js` is a static server bound to 127.0.0.1:5178. It redirects `/` to `/renderer/index.html` and refuses dotfiles and `node_modules`. There is no `daynoteHost`, so the localStorage fallback is used.

---

## 2. Full state shape (`emptyState()`, model.js:41-55)

```js
{
  version: 3,                       // SCHEMA_VERSION, always overwritten by normalize()
  projects: [], notes: [], tasks: [], blocks: [], history: [],
  suggestions: [], emails: [], reports: [],
  aiRuns: [], proposals: [], noteDigests: [],          // v2 AI layer
  chat: [],                                            // v3 home chat log (capped at 200 by assistant.js)
  emailConnection: { status: 'disconnected', provider: null, lastSyncAt: null, error: null },
  quickDraft: { text: '', projectId: null },
  prefs: { sidebarCollapsed: false, reduceMotion: false },   // more optional keys, see section 5
  meta: { createdAt: iso(), sampleLoaded: false }            // + meta.lastNudgeAt (assistant.js)
}
```

The schema history is recorded in the comment at model.js:23: `2: AI 층(aiRuns·proposals·noteDigests) · 3: 홈 채팅(chat), 수동 순서(sortOrder), 단계 초안(breakdown)`.

### Conventions used by every entity
- **IDs** come from `M.uid(prefix)` in the form `prefix_<base36 ms><5 random chars><seq>` (model.js:33-37). The prefixes in use are:
  - `task`
  - `note`
  - `proj`
  - `blk`
  - `hist`
  - `sug`
  - `rep`
  - `run` (proposals.js)
  - `prop` (proposals.js)
  - `msg` (assistant.js)
  - `step` (detail.js and assist.js)

  Sample emails use fixed ids `mail_sample_N`, and sample steps use `step_s1..3`.
- **Timestamps** are ISO UTC strings from `M.iso(now)` (model.js:39). `now` may be a Date, a number or undefined (undefined means the current time). In the renderer, always pass `DN.app.now()`, which honours `window.__daynoteNow` and is used for test and screenshot clocks.
- **Day-level dates** (`dueDate`, `weekStart`, suggestion `dueDate`) are `'YYYY-MM-DD'` strings in **local** time. Use `D.ymd` and `D.parseYmd(ymd, 'HH:MM')` from dates.js. Times are `'HH:MM'` strings. Block `start` and `end` are ISO strings and are compared as strings (`b.start < endIso`).
- **Soft delete**: tasks, notes and projects get `deletedAt` (ISO). Tasks also have `archivedAt`, which is **read in several places but never set by any code**. Blocks are **hard-deleted** (removed from the array). Manual history entries are hard-deleted.
- **`sample: true`** marks seed data. `clearSample` removes it.
- Insertion order: `addNote` and `addTask` **`unshift`** (newest first). `addProject`, `addBlock`, `addHistory`, `mergeSuggestions` and `startRun` **`push`**.

### 2.1 Task (`normalizeTask`, model.js:72-87; this is the only per-item normalizer)
```js
{
  id: 'task_…', title: '', memo: '',
  projectId: null,
  status: 'todo' | 'in_progress' | 'waiting' | 'done',     // labels: M.TASK_STATUS
  priority: null | 'high' | 'normal' | 'low',              // labels: M.PRIORITY
  dueDate: null | 'YYYY-MM-DD', dueTime: null | 'HH:MM',   // deadline, separate from work blocks
  estimateMinutes: null | int,       // REMAINING minutes; null = unknown (not 0)
  estimateSource: null | 'user' | 'ai',
  blockedBy: [taskId], waitingFor: '', snoozedUntil: null | ISO,
  steps: [{ id:'step_…', title, done: bool, estimateMinutes: null|int }],
  sources: [{ type:'note'|'email', refId, excerpt, suggestionId?, noteHash?, proposalId? }],
  origin: 'user' | 'ai_accepted', proposalId: null,
  sortOrder: null | number,          // v3; home drag order, (i+1)*10, smaller = higher (today.js:102)
  breakdown: null | {                // v3; AI step draft stored on the task, NOT applied
    status: 'pending'|'later'|'accepted'|'dismissed',
    steps: [{ title, minutes: null|int }],   // validate.sanitizeSteps shape (minutes, not estimateMinutes!)
    reason?, source: 'capture'|'button', createdAt, shownAt, remindAfter?, decidedAt?
  },
  elaboratedAt: null | ISO,          // "자세히 적기" answered or skipped; no more asking
  createdAt, updatedAt, startedAt: null, completedAt: null, deletedAt: null, archivedAt: null,
  sample: false
  // not defaulted, may exist: convertedFrom: { kind:'block', start, end, location, timeUncertain }  (proposals.blockToTask)
}
```
- `addTask(state, fields, now)` (model.js:178-183) builds `normalizeTask({id, createdAt, updatedAt, ...fields})`. If `estimateMinutes != null` and no `estimateSource` is given, it sets `estimateSource='user'`, then `unshift`s.
- `updateTask(state, id, patch, now)` (model.js:185-193) works on a copy of the patch. If `estimateMinutes` is in the patch and `estimateSource` is not, it sets `estimateSource = (v==null ? null : 'user')`. It always bumps `updatedAt` and returns the task, or null.
- **Two different step shapes**: `task.steps[]` items use `estimateMinutes`, but `task.breakdown.steps[]` and the chat `draft[]` items use `minutes`. `assist.applyBreakdown` converts between them (assist.js:205).

### 2.2 Note (`addNote`, model.js:143-150; no normalizer)
```js
{
  id: 'note_…', title: '', body: '' /* markdown */, projectId: null,
  createdAt, updatedAt, deletedAt: null, sample: false,
  // capture-only fields (set by renderer/capture.js and proposals.applyCapture):
  captureRole?: 'memo' | 'task_source',   // task_source = hidden from note lists, shown only as a source
  kind?: 'memo' | 'idea' | 'link', kindByUser?: bool,
  sortOrder?: number,                     // home memo drag order (today.js:107)
  capture?: {
    status: 'pending' | 'no_ai' | 'failed' | 'done', at: ISO, doneAt?, runId?,
    entryType: null | 'memo' | 'task' | 'mixed' | 'done' | 'update',
    created:   [{ kind:'task'|'block', id }],
    skipped:   [{ id /*proposalId*/, reason:'duplicate'|'blocked' }],
    completed: [{ kind:'task', id, historyId, prevStatus }],
    updated:   [{ kind:'task', id, prev:{dueDate,dueTime}, prevWork:{id,start,end}|null, newWorkId, to:{dueDate,dueTime,at} }],
    error?: {type,message,retryable}|null, reason?: string /*no_ai*/,
    projectByAi?: bool, largeTasks?: [taskId], changedByUser?: bool
  }
}
```
- `updateNote(state, id, patch, now)` merges the patch and sets `updatedAt`. `deleteNote(state, id, now)` sets `deletedAt` only. It does **not** mark proposals stale; the caller must also call `DN.aiProposals.staleForDeletedNote(s, id)` (notes.js:230).
- `noteTitle(note)` returns the trimmed title, or else the first non-empty body line with `#` stripped, cut to 60 characters, or else `'제목 없는 메모'`.

### 2.3 Project (`addProject`, model.js:166-175)
```js
{ id:'proj_…', name:'새 프로젝트', description:'', color: PROJECT_COLORS[projects.length % 6],
  createdAt, deletedAt:null, sample:false }
```
`PROJECT_COLORS = ['#4F46E5','#0F766E','#B45309','#9D174D','#1D4ED8','#4D7C0F']`. The model has **no `updateProject` or `deleteProject`**. projects.js:95-98 writes `name` and `description` directly inside `mutate`.

### 2.4 ScheduledBlock (`addBlock`, model.js:313-317)
```js
{ id:'blk_…', kind: fields.taskId ? 'work' : 'event', taskId:null, title:'', start: ISO, end: ISO,
  origin:'user'|'ai_accepted', proposalId:null, sources:[], sample:false,
  // optional: location, projectId (events), durationGuessed: bool, timeUncertain: bool,
  //           convertedFrom: { kind:'task', blockStart, hadWork, status, completedAt, startedAt, origin, createdAt, ...TASK_KEEP }
}
```
- `updateBlock(state, id, patch)` uses a plain `Object.assign` and does **not** touch any timestamp. `deleteBlock(state, id)` removes the block from the array and then runs `revealSources`.
- `conflictsFor(state, startIso, endIso, ignoreId)` returns the blocks that overlap the range. It skips work blocks whose task is deleted.
- `blocksForTask(state, taskId)` returns the task's blocks sorted by start. `nextBlockForTask(state, taskId, now)` returns the first such block with `end > now`.

### 2.5 HistoryEntry (`historyFor` model.js:195-201 and `addHistory` model.js:341-348)
```js
{ id:'hist_…', projectId, at: ISO, type, origin:'auto'|'manual', title, body:'',
  refs:[{ kind:'task'|'note'|'email'|'project', id, label }], revokedAt:null, editedAt:null, sample }
```
- `type` is one of the keys of `HISTORY_TYPES`: `task_done`, `task_reopened`, `decision`, `update`, `achievement`, `blocker`. The values the user can enter by hand are `MANUAL_HISTORY_TYPES = ['decision','update','achievement','blocker']`.
- `historyFor` (auto entries) does **not** set `sample`. sample.js:85 sets `h.sample = true` on the entries afterwards.
- `updateHistory` and `deleteHistory` return null unless `origin === 'manual'`.

### 2.6 Suggestion (`mergeSuggestions` model.js:366-380, with candidates from `suggest.build` suggest.js:188-212)
```js
{ id:'sug_…', key:'note|email:<noteId|messageId>:<fnv1a(normalized sentence)>',
  status:'pending'|'accepted'|'dismissed', taskId:null, createdAt, reviewedAt:null,
  sourceType:'note'|'email', sourceId, excerpt, title, reason,
  dueDate, dueEstimated, dueHint, projectId, sample,
  taskDeleted?: true }            // set by deleteTask
```
- A key that is already present is never merged again, **whatever its status**.
- `acceptSuggestion(state, id, fields, now)` returns `{task, duplicate}` and is idempotent once accepted. `dismissSuggestion` only acts on `pending`. `restoreSuggestion` turns `dismissed` back into `pending`.

### 2.7 Email (only sample data exists; sample.js:115-118)
`{ id, messageId, from, subject, receivedAt, body, sample }`. `suggest.scan` also tolerates optional `deletedAt` and `projectId`. Mail is scanned only while `emailConnection.status === 'connected'`.

### 2.8 WeeklyReport (`reportFor` and `saveReport`, model.js:420-434)
`{ id:'rep_…', weekStart:'YYYY-MM-DD'(Monday), draft:'', body:'', generatedAt:null, editedAt:null, refs:[historyId] }`. `saveReport` creates the report if missing and assigns the patch. It sets `editedAt` only when `body` is in the patch and `generatedAt` is not.

### 2.9 AI layer (v2) — defined in `src/core/ai/proposals.js`
- **aiRun** (`startRun`, proposals.js:42-57):
  ```js
  { id:'run_…', kind:'organize_note'|'capture', noteId, noteHash, promptVersion,
    provider, model, status:'running'|'succeeded'|'failed'|'invalid', attempts,
    startedAt, finishedAt, error, usage, rawOutput /* ≤60000 chars */, stats, dropped:[] }
  ```
  Only the **last 5 runs per note** are kept. `recoverInterrupted` (run on `whenReady` from aiflow.js:121) changes `running` to `failed` with error type `interrupted`.
- **proposal** (`mergeOrganizeRun`, proposals.js:133-139):
  ```js
  { id:'prop_…', key:'<kind>:note:<noteId>:<hash(norm(quote))>:<ordinal>', kind:'task'|'event', origin:'ai',
    status:'pending'|'stale'|'accepted'|'dismissed', runId, promptVersion,
    source:{ type:'note', id, quote, line, noteHash },
    payload:{ title, fields:{ <name>:{ value, status:'ok'|'confirm', message, options:[{label,value}] } },
              flags, basis:'explicit'|'inferred', duplicateOf, defaultChecked, extra:null|{size:'large', breakdown:[{title,minutes}]} },
    edits:null|{ field:value, saveAs?:'task' }, aiUpdate:null|{payload, runId, at},
    resultRef:null|{ kind:'task'|'block', id }, acceptedValues?, createdAt, updatedAt, reviewedAt, sample }
  ```
  Task fields are `title, dueDate, dueTime, projectId, atDate?, atTime?`. Event fields are `title, date, time, durationMinutes, location, projectId`.
- **noteDigest** holds one entry per note: `{ noteId, noteHash, runId, createdAt, summary, sections:[{heading, bullets:[{text,line}]}], openQuestions:[{text,line}] }`.

### 2.10 Chat message (v3) — defined in `renderer/assistant.js:24-39`
```js
{ id:'msg_…', at: ISO, role:'user'|'assistant',
  kind:'text'|'capture'|'thinking'|'breakdown'|'next'|'elaborate'|'rest',
  text?, actions?:['rest'|'next'], noteId? /*capture*/, taskId?, step?, reasons?, skip?,
  intro?, reason?, draft?:[{title,minutes}], resolved?:'applied'|'later'|'never', resolvedCount?,
  picks?:[{taskId, why, question, hints}], done?:{ [taskId]:'saved'|'skipped' },
  stretches?, timerEnd?, timerDone? }
```
`post()` caps `s.chat` at `MAX_MESSAGES = 200` by splicing from the front. Chat cards always read the **live** task or note by id; they never store copies.

### 2.11 Small singletons
- `emailConnection`: `{status:'disconnected'|'connecting'|'connected'|'error'|'reauth', provider:null|'sample', lastSyncAt, error}` (settings.js:15-21).
- `quickDraft`: `{text, projectId}`. It is written with a 250–300 ms debounce by the Ctrl+N modal (app.js:273) and the chat input (chat.js:72).
- `meta`: `{createdAt, sampleLoaded, lastNudgeAt?}`.

---

## 3. `SCHEMA_VERSION` and `normalize()` — the migration pattern (model.js:23, 57-70)

```js
function normalize(raw) {
  var s = emptyState();
  if (!raw || typeof raw !== 'object') return s;
  Object.keys(s).forEach(function (k) {          // ONLY keys known to emptyState()
    if (raw[k] === undefined) return;
    if (Array.isArray(s[k])) s[k] = Array.isArray(raw[k]) ? raw[k] : [];
    else if (s[k] && typeof s[k] === 'object') s[k] = Object.assign({}, s[k], raw[k]);   // shallow merge
    else s[k] = raw[k];
  });
  s.version = SCHEMA_VERSION;
  s.tasks = s.tasks.map(normalizeTask);
  return s;
}
```

Facts and gotchas:
- **There is no versioned migration code.** Nothing branches on `raw.version`. Loading an old file only fills defaults. A file written by a *newer* build is accepted silently and its version is overwritten.
- **Unknown top-level keys are dropped on load**, even though the comment says "모르는 필드는 버리지 않는다". The comment is true only for nested object keys (`prefs.theme`, `meta.lastNudgeAt`) and for per-item fields. A new top-level collection that is not added to `emptyState()` survives the save made during the same session, because the save is `JSON.stringify(state)`, but it disappears on the next launch.
- Array keys are **not** item-normalized, except `tasks`. Code that reads notes, blocks, projects, history, proposals, chat and similar entities must tolerate missing fields; for example, `n.capture` or `n.kind` may be undefined (treat it as `'memo'`), and old blocks may lack `sources`. `proposals.ensure(state)` defensively creates `aiRuns`, `proposals` and `noteDigests`. `assistant.post` defensively creates `chat`.
- `normalizeTask` defaults `id: uid('task')` and `createdAt: iso()`. A stored task with no id would get a **different random id on every load**. That never happens in practice, but do not rely on the defaults for identity fields.
- Object-valued defaults in `normalizeTask` (`blockedBy: []`, `steps: []` and others) are fresh literals on each call, so tasks never share them.
- **The recipe for adding a field:**
  1. A new top-level key goes into `emptyState()`, which makes normalize pick it up.
  2. A new task field gets a default in `normalizeTask`.
  3. A new field on another entity goes into its `addX` defaults **and** must be read defensively, or you add a `normalizeX` mapped inside `normalize()` the way tasks are.
  4. Bump `SCHEMA_VERSION` and extend the comment at model.js:23.
  5. If the field is an id reference, update `clearSample` (model.js:438-452) when it should be cascaded, and update `TASK_KEEP` in proposals.js:545 when the task field must survive a task↔event conversion.
- `normalize` is called in three places: `store.load()` (store.js:127), `store.replaceAll()` (store.js:173) and nowhere else. **The model functions assume an already-normalized state.**

---

## 4. Store API — `window.Daynote.store` (renderer/store.js)

Module-private state (store.js:67-75): `state`, `listeners[]`, `undoStack[]`, `saveTimer`, `saveStatus {phase, at, error}`, `statusListeners[]`, `dirty`, `loaded`, `readyQueue[]`. Constants: `LS_KEY='daynote:data'`, `EMERGENCY_KEY='daynote:unsaved'`, `SAVE_DELAY=400`.

| Member | Signature | Behavior |
|---|---|---|
| `host` | object | `window.daynoteHost` or the browser fallback (section 7) |
| `state` | getter | Returns the **current** object. Its identity changes on `load`, `undo` and `replaceAll`, so never cache it across async gaps. |
| `load()` | `→ Promise<{recovered, fresh}>` | Calls `host.load()`. If `localStorage['daynote:unsaved']` exists, that copy **wins** (`recovered=true`, `dirty=true`). Then `state = M.normalize(data)`, and it saves again if dirty. It sets `loaded`, emits `{type:'load'}` and drains `readyQueue`. `fresh` is `!data` and is not used by app.js; the app does not auto-load sample data. |
| `whenReady(fn)` | | Runs `fn` once after the first load, or on the next tick if already loaded |
| `subscribe(fn)` | `→ unsubscribe()` | `fn(info)`; listener exceptions are caught and logged |
| `onStatus(fn)` | | Calls `fn(saveStatus)` immediately and on every phase change. It has **no unsubscribe**. |
| `status()` | `→ {phase:'saved'|'pending'|'saving'|'error', at, error}` | |
| `mutate(label, fn, opts)` | `→ fn(state)` return value | See below |
| `canUndo()` | `→ bool` | |
| `undo()` | `→ label | null` | Pops a snapshot and **keeps the current `prefs`**, then schedules a save and emits `{type:'undo', label}` |
| `flush()` | `→ Promise<bool>` | Saves now if dirty |
| `retrySave()` | `→ Promise<bool>` | Sets `dirty=true` and calls `flush()`. The "다시 시도" buttons call it. |
| `replaceAll(next)` | | `normalize(next)`, clears undo, saves and emits `{type:'load'}`. **Nothing calls it** (there is no import UI). |

### 4.1 `mutate` (store.js:145-156) — the only sanctioned write path
```js
mutate: function (label, fn, opts) {
  opts = opts || {};
  var before = label ? clone(state) : null;           // JSON deep clone of the WHOLE state
  var result = fn(state);
  if (label) { undoStack.push({ label, snapshot: before, at: Date.now() }); if (undoStack.length > 30) undoStack.shift(); }
  scheduleSave();
  if (!opts.silent) emit({ type: 'change', label: label, source: opts.source });
  return result;
}
```
- `label` is a Korean user-facing string such as `'완료'`, `'삭제'` or `'할 일 수정'`. A **truthy label makes the change undoable** and is what the undo toast shows (`ui.undoToast` calls `S.undo()`, ui.js:104-107). `null` means the change is not undoable but is still saved.
- `opts.silent: true` saves without emitting, so no view re-renders. It is used for prefs, `quickDraft` while typing, `meta.lastNudgeAt`, `markShown`, `recoverInterrupted` and the raw-output write of an AI run.
- `opts.source` is passed through to listeners. The values in use are `'detail'`, `'notes'`, `'capture'`, `'chat'`, `'today'`, `'ai'`, `'review'`, `'weekly'` and `'projects'`. A view's `onChange(info)` can return `true` to skip its own re-render; for example, detail.js:185-188 skips re-rendering for its own `source:'detail'` edits unless the label matches `/상태|단계|선행|미루기|소요 시간 확인|마감일/`, and weekly.js skips `source:'weekly'`.
- Event shape: `{ type: 'load'|'change'|'undo', label?, source? }`. `assistant.js:204-206` listens for `info.label === '완료'` to trigger a nudge, so **labels are semantic in a few places**.
- `emit` is **synchronous**: `app.onStoreChange` re-renders the nav and the current view inside the `mutate` call. Do not call `mutate` during a render.
- Inside `fn`, use the `s` argument. It is the same object as `S.state`.
- If `fn` throws, nothing is saved or pushed onto the undo stack, but any partial in-place changes stay in memory.

### 4.2 Undo semantics and gotchas
- A snapshot is the state **before** a labeled mutation. `undo()` restores the entire object, so it also reverts **every unlabeled mutation made after that point**, including chat messages, `aiRuns`, `quickDraft`, `emailConnection` and `meta.lastNudgeAt`. Only `prefs` is preserved (store.js:162-165; test/store.test.js:21-30).
- `ui.undoToast(msg)` always undoes **the top of the stack**, not necessarily the action that showed the toast. If another labeled mutation happens before the user clicks, the click undoes that newer one.
- A labeled `mutate` costs a full `JSON.parse(JSON.stringify(state))`, and up to 30 snapshots stay in memory. aiRuns `rawOutput` can be up to 60 KB × 5 per note. Avoid labeled mutations in hot loops such as drag-move. Today's drag commits once on drop.
- Objects you held before `undo()` or `load()` are detached copies afterwards. Re-fetch them with `M.byId(S.state.tasks, id)`.

### 4.3 Debounced save and status machine (store.js:85-112)
```
mutate → scheduleSave(): dirty=true, phase='pending', (re)arm 400ms timer → flush()
flush(): if !dirty → resolve(true); dirty=false; json=JSON.stringify(state); phase='saving';
         host.save(json).then(ok → remove EMERGENCY_KEY; phase = dirty ? 'pending' : 'saved', at=savedAt)
                     .catch → dirty=true; localStorage[EMERGENCY_KEY]=json; phase='error', error=msg; resolve(false)
```
- A failed save has **no automatic retry timer**. It retries on the next `mutate` or when `retrySave()` is called from the indicators in app.js:89 and notes.js:112.
- The emergency copy is written with `localStorage.setItem` even in Electron. In browser mode, if the primary `setItem` fails because of quota, the emergency write usually fails as well.
- Status consumers: the sidebar indicator `app.renderSave` (app.js:82-95) and the editor status in notes.js:103-118.

### 4.4 Lifecycle hooks registered at module end (store.js:176-180)
```js
host.onBeforeClose(function () { flush().then(function () { host.flushed(); }); });
if (host.onFlush) host.onFlush(function () { flush(); });               // tray-hide / Windows session end
window.addEventListener('beforeunload', function () { if (dirty) localStorage.setItem(EMERGENCY_KEY, JSON.stringify(state)); });
```

---

## 5. Prefs — how to read and write them

There is no prefs API. Read `S.state.prefs.X` directly and write with a **silent, unlabeled** mutate:
```js
S.mutate(null, function (s) { s.prefs.sidebarCollapsed = !s.prefs.sidebarCollapsed; }, { silent: true });   // app.js:98
DN.app.applyPrefs();   // re-apply classes yourself, because a silent mutate does not re-render
```

| Key | Default (`emptyState`) | Values and semantics | Writers | Readers |
|---|---|---|---|---|
| `sidebarCollapsed` | `false` | bool | app.js:98 (toggle, Ctrl+\\) | app.js:102 (also forced when `innerWidth < 1000`) |
| `reduceMotion` | `false` | bool. Sets the `html.reduce-motion` class. | settings.js:238 (**not silent**, so it re-renders) | app.js:103 |
| `theme` | *absent* | `'light'`, `'dark'` or absent (absent means `'system'`). The key is **deleted** to reset it. Sets `html[data-theme]`. | settings.js:228, palette.js:24 | app.js:104-111, settings.js:223, palette.js:31 |
| `homeSplit` | *absent* | `[r0,r1,r2]`, three ratios summing to 1. **Deleted** when it equals `split.DEFAULT=[0.45,0.33,0.22]`. | today.js:166-172 (silent, on drop) | today.js:126, 161 |
| `closeToTray` | *absent* (= true) | `false` turns it off. Mirrored to main with `host.setCloseToTray(v)`. | settings.js:245 | assistant.js:215 (pushed to main on `whenReady`), settings.js:242 |
| `workHours` | *absent* | `{start:'HH:MM', end:'HH:MM'}`. recommend.js:158 falls back to 09:00–18:00. **There is no UI.** | — | assistant.js:70 → `R.recommend` |

Gotchas:
- Prefs survive `undo()` because store.js reattaches the current `prefs` object. Prefs written with a *labeled* mutate would still create an undo entry, but the undo would not revert them. Keep prefs writes `null`-labeled.
- Main's `closeToTray` flag (main.js:38) is **not persisted in main**. It defaults to `true` and is synced from the renderer only after `whenReady`, so for the first moments after launch it is always `true`.
- normalize shallow-merges `prefs`, so any new pref key persists without schema work. **A new pref key needs no `SCHEMA_VERSION` bump**, but add a sensible default either in `emptyState().prefs` or at the read site.

---

## 6. Model API reference (`window.Daynote.model` / `require('../src/core/model')`)

Constants:
- `SCHEMA_VERSION`
- `TASK_STATUS {todo:'할 일', in_progress:'진행 중', waiting:'대기', done:'완료'}`
- `PRIORITY {high:'높음', normal:'보통', low:'낮음'}`
- `HISTORY_TYPES`
- `MANUAL_HISTORY_TYPES`

Utilities and queries:
- `uid(prefix)`, `iso(now)`, `emptyState()`, `normalize(raw)`, `normalizeTask(t)`
- `byId(list, id)` — linear scan; returns null when `id` is falsy
- `liveTasks(state)` — excludes `deletedAt` and `archivedAt`
- `liveNotes(state)` and `liveProjects(state)` — exclude `deletedAt`
- `blocksForTask(state, taskId)`, `nextBlockForTask(state, taskId, now)`
- `tasksForNote(state, noteId)` — live tasks with a `sources[]` entry where `type==='note' && refId===noteId`
- `unmetBlockers(state, task)` — blockers that exist, are not deleted and are not done
- `noteTitle(note)`
- `resolveRef(state, ref)` → `{kind, id, label, missing, item}`. It accepts both `{kind,id}` (history refs) and `{type,refId}` (task sources). It sets `missing:true` when the item is gone or deleted and keeps the stored `ref.label` as a fallback.

Mutators (all take `state` first, mutate it in place, and return the touched entity or a result object):

| Function | Returns | Side effects |
|---|---|---|
| `addNote(s, fields, now)` | note | `unshift` |
| `updateNote(s, id, patch, now)` | note or null | `updatedAt` |
| `deleteNote(s, id, now)` | note | `deletedAt` only |
| `addProject(s, fields, now)` | project | `push`, color by count |
| `addTask(s, fields, now)` | task | normalizeTask, estimateSource rule, `unshift` |
| `updateTask(s, id, patch, now)` | task or null | estimateSource rule, `updatedAt` |
| `completeTask(s, id, now)` | `{task, historyId, prevStatus}` or null if done or missing | `status='done'`, `completedAt`, clears `snoozedUntil`, pushes a `task_done` history entry |
| `reopenTask(s, id, now, {undoOf?, prevStatus?})` | task or null | Restores `prevStatus` (or `'todo'`). **`undoOf`**: removes that history entry and nothing else. Otherwise it sets `revokedAt` on the earlier `task_done` entries for this task and pushes `task_reopened`. |
| `startTask(s, id, now)` | `{task, switchedFrom:[ids]}` or null | Every other `in_progress` task becomes `todo`. Sets `startedAt` once and clears the snooze. The UI must confirm the switch first (app.js:183-199). |
| `snoozeTask(s, id, untilIso, now)` | task | `updateTask({snoozedUntil})` |
| `deleteTask(s, id, now)` | task | Soft delete. **Removes only future blocks** (`start > now`), flags suggestions `taskDeleted`, then `revealSources`. |
| `addBlock(s, fields)` / `updateBlock(s, id, patch)` / `deleteBlock(s, id)` | block | Takes no `now`. Delete runs `revealSources`, and **does not affect the task**. |
| `conflictsFor(s, startIso, endIso, ignoreId)` | blocks[] | |
| `liveCreated` / `liveCompleted` / `liveUpdated(s, note)` | refs still alive | From `note.capture.created`, `.completed` and `.updated` |
| `captureHasResults(s, note)` | bool | |
| `revealSources(s)` | — | Notes with `captureRole==='task_source'` that have no remaining results revert to `'memo'`. This is a no-op while the transient `s.__holdReveal` is set (proposals.js:648, 684). |
| `addHistory(s, fields, now)` / `updateHistory(s, id, patch, now)` / `deleteHistory(s, id)` | entry or null | Edit and delete only work on `origin==='manual'` entries |
| `mergeSuggestions(s, candidates, now)` | added[] | Dedupe by `key` across all statuses |
| `acceptSuggestion(s, id, fields, now)` | `{task, duplicate}` or null | The created task gets `sources:[{type:sourceType, refId:sourceId, excerpt, suggestionId}]` |
| `dismissSuggestion(s, id, now)` / `restoreSuggestion(s, id)` | suggestion | |
| `reportFor(s, weekStart)` / `saveReport(s, weekStart, patch, now)` | report | |
| `clearSample(s)` | state | Filters `sample` out of projects, notes, tasks, blocks, history, suggestions, emails and proposals. Drops aiRuns and noteDigests whose note is gone. Resets a sample `emailConnection` and sets `meta.sampleLoaded=false`. It does **not** touch `chat` (stale `capture` cards can point at removed notes) or `reports`. |

Higher-level mutators live outside model.js but follow the same `(state, …, now)` pattern:
- `DN.aiProposals`:
  - `startRun`, `finishRun`, `mergeOrganizeRun`, `refreshStale`, `staleForDeletedNote`
  - `setEdit`, `takeAiUpdate`, `dismiss`, `restore`
  - `applySelections` (all or nothing)
  - `applyCapture`, `captureToMemo`, `captureToTask`, `captureSetProject`, `captureSetKind`, `captureSetItemKind`, `captureRemoveItem`
  - `recoverInterrupted`
- `DN.aiAssist`: `applyBreakdown`, `deferBreakdown`, `storeBreakdown`, `markShown`, `saveElaboration`, `skipElaboration`.
- `DN.weekly.carryOver(state, taskIds, weekStart, now)`.

Each of these should be called **inside** `S.mutate`.

---

## 7. Renderer ↔ main: `window.daynoteHost`

### 7.1 Electron preload (preload.js:6-29) — `contextBridge.exposeInMainWorld('daynoteHost', …)`
| Member | IPC | Direction | Main handler → return |
|---|---|---|---|
| `kind` | — | — | `'electron'` |
| `load()` | `store:load` | invoke | main.js:78 `loadData()` → `{ok:true, data:object\|null, recovered?:bool, path}` |
| `save(json)` | `store:save` | invoke | main.js:79 `saveData(json)` → `{ok:true, savedAt}` or `{ok:false, error:string}` |
| `dataPath()` | `store:path` | invoke | main.js:80 → absolute path string |
| `revealData()` | `store:reveal` | invoke | main.js:81 `shell.showItemInFolder` → undefined |
| `copyText(text)` | `clipboard:write` | invoke | main.js:113 → `true` |
| `exportFile(name, content)` | `file:export` | invoke | main.js:116-130 shows a save dialog filtered to JSON when `name` ends in `.json`, otherwise md/txt → `{ok:true,path}`, `{ok:false,canceled:true}` or `{ok:false,error}` |
| `ai.status()` | `ai:status` | invoke | main.js:89-93 → `{configured, provider:'fake'\|'gemini'\|'claude'\|null, model, fastModel?, vendor?, keySource?:'env'\|'dotenv'\|'saved', notice?, reason?, savedKey:'••••abcd'\|null}` |
| `ai.organizeNote(input)` | `ai:organizeNote` | invoke | main.js:94 → `services/ai.organize(input)`, which returns `{ok:true, provider, model, output, raw, usage, attempts}` or `{ok:false, error:{type,message,retryable}, raw?, attempts}`. `input.purpose` is one of `'capture'`, `'breakdown'`, `'elaborate'` or the default (organize note). The dedupe key is `input.noteId || input.requestId`, and a duplicate request gets `busy`. |
| `ai.setKey(key)` | `ai:setKey` | invoke | Encrypts the key with DPAPI into `userData/ai-key.bin` (services/keystore.js) → `{ok, error?, status}`. **The key is never returned.** |
| `ai.clearKey()` | `ai:clearKey` | invoke | → `{ok:true, status}` |
| `ai.check()` | `ai:check` | invoke | Sends a real capture of `'내일까지 견적서 보내기'` → `{ok, ms, model?, error?}` |
| `onBeforeClose(fn)` | `app:before-close` | main→renderer | Window close when the window is not hidden to the tray |
| `onQuickCapture(fn)` | `quick:capture` | main→renderer | `fn(String(text))` |
| `ready()` | `app:ready` | invoke | Sets `rendererReady` and flushes `pendingQuick` → `{quickKey:'CommandOrControl+Shift+Space'\|null}` |
| `onFlush(fn)` | `app:flush` | main→renderer | Hide-to-tray, `session-end` and `query-session-end` |
| `setCloseToTray(on)` | `app:setCloseToTray` | invoke | → bool |
| `flushed()` | `app:flushed` | invoke | Marks `__flushed` and closes the window |

### 7.2 Quick-capture window preload (quick-preload.js) — `window.daynoteQuick`
- `submit(text)` invokes `quick:submit` with the text **cut to 20000 characters**. It returns `{ok}`. Main forwards the text as `quick:capture` to the main window, or queues it in `pendingQuick` until `app:ready`.
- `hide()` uses `ipcRenderer.send('quick:hide')`.
- `resize(h)` uses `send('quick:resize', Number(h)||0)`. Main clamps the height to 80–400.
- `onShown(fn)` listens for `quick:shown` with the `ai.status()` payload.

The full flow is: global shortcut `CommandOrControl+Shift+Space` → `toggleQuick()` → user hits Enter → `quick:submit` → `quick:capture` → `assistant.watch` calls `host.onQuickCapture(text => send(text))` (assistant.js:214) → `DN.capture.submit`.

### 7.3 Browser fallback (store.js:15-65), used when `window.daynoteHost` is undefined
| Member | Browser behavior |
|---|---|
| `kind` | `'browser'` |
| `load()` | `JSON.parse(localStorage['daynote:data'])` → `{ok:true, data, path:'localStorage'}`. A parse error gives `data:null`, with **no corrupt-file preservation**. |
| `save(json)` | `localStorage.setItem` → `{ok:true, savedAt}` or `{ok:false, error}`. The test hook `window.__daynoteFailSave` forces a failure. |
| `dataPath()` | `'브라우저 localStorage'` |
| `revealData()` | no-op |
| `copyText(text)` | `navigator.clipboard.writeText`, or a textarea with `execCommand('copy')` |
| `exportFile(name, content)` | Blob download with `<a download>` → `{ok:true, path:name}`. It never reports `canceled`. |
| `ai.status()` | If `window.DAYNOTE_WEB_DEMO` or `?fakeai` → `{configured:true, provider:'fake', model:'가짜 AI(테스트)'}`. Otherwise `configured:false` with a `reason`. |
| `ai.organizeNote(input)` | With the fake AI on: after 500 ms returns `window.Daynote.aiFake.organize(input)` plus `{raw, attempts:1}`. The test hook `window.__daynoteAiFail` forces a network error. With it off: `{ok:false, error:{type:'not_configured'}}`. |
| `ai.setKey()` | Always `{ok:false, error}`. `clearKey()` returns `{ok:true}`. `check()` succeeds only with the fake AI. |
| `onBeforeClose`, `flushed` | no-ops |
| **missing** | `onQuickCapture`, `ready`, `onFlush`, `setCloseToTray`. Callers guard with `if (host.X)` (store.js:179, assistant.js:214-216, settings.js:246). **Any new host method must be optional or added to both hosts.** |

Renderer consumers of `S.host`:
- `settings.js` (dataPath, revealData, exportFile backup as `JSON.stringify(S.state,null,2)`, ai.*)
- `weekly.js` (copyText, exportFile `.md`)
- `review.js` (copyText)
- `capture.js`, `aiflow.js` and `assistant.js` (`ai.organizeNote`, always followed by `.catch → {ok:false, error:{type:'ipc'}}`)

### 7.4 Security posture
- The main and quick windows use `contextIsolation:true`, `nodeIntegration:false` and `sandbox:true`. `will-navigate` is prevented. `setWindowOpenHandler` sends `http(s)` links to `shell.openExternal` and denies everything else.
- The CSP in index.html is `default-src 'none'; script-src 'self'; …`. It forbids inline scripts and CDNs, so all code must be local files. The web build strips this CSP.
- API keys never reach the renderer: `ai.captureEnvKeys()` moves the env keys into the module and deletes them from `process.env` (main.js:87).

---

## 8. Persistence on the main side (main.js:45-81)

```js
const DATA_FILE = () => path.join(app.getPath('userData'), 'daynote-data.json');
const BACKUP_FILE = () => DATA_FILE() + '.bak';

async function loadData() {                       // main.js:48-60
  for (const file of [DATA_FILE(), BACKUP_FILE()]) {
    try { return { ok:true, data: JSON.parse(await fs.readFile(file,'utf8')), recovered: file !== DATA_FILE(), path: DATA_FILE() }; }
    catch (e) { if (e.code === 'ENOENT') continue; try { await fs.copyFile(file, file + '.broken-' + Date.now()); } catch (_) {} }
  }
  return { ok:true, data:null, path: DATA_FILE() };
}

let writing = Promise.resolve();
function saveData(json) {                         // main.js:62-76 — serialized queue
  writing = writing.then(async () => {
    const target = DATA_FILE(), tmp = target + '.tmp';
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(tmp, json, 'utf8');
    if (fsSync.existsSync(target)) { try { await fs.copyFile(target, BACKUP_FILE()); } catch (_) {} }
    await fs.rename(tmp, target);
    return { ok:true, savedAt: new Date().toISOString() };
  }).catch((e) => ({ ok:false, error: e.message }));
  return writing;
}
```

- The file format is compact `JSON.stringify(state)` (the whole state, every time). Pretty-printed JSON appears only in the user backup export.
- `.bak` is the **previous** successful file, rotated on every save. A missing main file with an existing `.bak` loads from `.bak` with `recovered:true`, and app.js:325 shows the toast "지난번에 저장되지 않은 내용을 복구했습니다." The emergency localStorage copy produces the same toast.
- There is no `fsync`, so atomicity relies on rename. `.catch` turns errors into `{ok:false}`, which keeps the queue alive.
- A corrupt file produces a `.broken-<ms>` copy and is **not deleted**, so `.broken-*` files can accumulate.
- Profiles: `--profile=<name>` or `DAYNOTE_PROFILE` sets userData to `<userData> [<name>]` (main.js:15-23). This is used by `npm run smoke` (`--profile=smoke`) and `npm run shots` (`--profile=shots`).
- Other files in userData:
  - `ai-key.bin` (safeStorage/DPAPI)
  - `tray-hint-shown`
  - `daynote-data.json.tmp`
  - `daynote-data.json.bak`

### 8.1 Close and flush sequence
```
user closes window
 ├─ tray && closeToTray && !isQuitting → preventDefault, hide, send 'app:flush' (renderer flush(), no ack), trayHintOnce()
 └─ else if !__flushed → preventDefault, send 'app:before-close'
        renderer: flush().then(host.flushed) → 'app:flushed' → main sets __flushed, close()
        safety timer: 1500 ms → __flushed = true, close()        (main.js:221-233)
Windows session-end / query-session-end → isQuitting = true, send 'app:flush' (main.js:155-156)
'closed' → app.quit() (also closes the hidden quick window)
renderer reload → 'did-start-loading' resets rendererReady (quick captures queue again)
```
Single instance: `app.requestSingleInstanceLock()` is skipped for `--smoke` and `--shots`, and `second-instance` calls `showMain`.

---

## 9. Sample data (renderer/sample.js)

`Daynote.sample.build(state, now)` mutates and returns `state`. Every item carries `sample:true` (the `x()` helper). The build adds:
- 3 projects
- 4 notes
- 16 tasks:
  - 13 open, including one overdue, two due today, one waiting, one with a `blockedBy`, one snoozed, one `in_progress`, one with three steps and `estimateMinutes:120`, and one with `estimateSource:'ai'`
  - 3 completed through `M.completeTask`, which creates auto history
- 7 blocks, including a deliberately overlapping pair on day+3 at 10:00/10:30
- 5 manual history entries
- 4 emails, with ids `mail_sample_1..4` and messageIds `<sample-N@sample.daynote>`

It sets `meta.sampleLoaded = true`. All dates are computed relative to `now`, so the data always looks current.

It is invoked as `S.mutate('샘플 불러오기', s => DN.sample.build(s, now()))` (app.js:259-262) and removed with `M.clearSample(s)` inside `S.mutate('샘플 지우기', …)` (app.js:247-257). app.js also re-filters `suggestions`, which is redundant. test/sample.test.js checks the `sample` flags, the required task mix, that each source excerpt is a substring of its note body, the overlap, and that `clearSample` keeps user items.

---

## 10. Tests

- `npm test` runs `node --test "test/*.test.js"`. The model, store and sample tests pass (14/14 at this commit).
- `test/model.test.js` covers:
  - complete → `task_done`, and completing twice returns null
  - reopen with `undoOf` deletes the history entry and restores `prevStatus`
  - a plain reopen sets `revokedAt` and adds `task_reopened`
  - `deleteTask` removes only future blocks
  - `deleteBlock` keeps the task
  - `mergeSuggestions` dedupes by key regardless of status
  - `acceptSuggestion` is idempotent
  - `resolveRef` reports `missing` and the fallback label
- `test/store.test.js` has a single test: undo reverts data but keeps `prefs.homeSplit`, `sidebarCollapsed` and `reduceMotion`. Its harness pattern (useful for new store tests):
  ```js
  const window = { Daynote: { model: M }, addEventListener() {} };
  const ctx = vm.createContext({ window, localStorage /*Map-backed*/, setTimeout() { return 0; }, clearTimeout() {}, console, JSON, Promise, Date });
  vm.runInContext(fs.readFileSync('renderer/store.js','utf8'), ctx);  // → window.Daynote.store
  ```
  `setTimeout` is a stub, so debounced saves never fire. Call `S.flush()` explicitly to test saving. There is no `daynoteHost` in this harness, so the **browser fallback host** is used and its `localStorage` is the fake.
- There are no tests for main.js persistence (`loadData`/`saveData`) or for `normalize()` itself.

---

## 11. Pitfalls and gotchas (checklist)

1. **Never write `S.state` outside `S.mutate`.** One exception exists (aiflow.js:96-97 `Object.assign(runNow, …)`), and it happens to be saved by the silent mutate that follows. Do not copy that pattern.
2. **New top-level keys must be added to `emptyState()`**, or `normalize()` drops them on the next launch.
3. Only tasks are normalized per item. Read other entities defensively (`(n.capture && n.capture.created) || []`, `b.sources || []`, `note.kind || 'memo'`).
4. `undo()` restores a whole snapshot, so later unlabeled changes are lost too, except prefs. Labels drive the undo toast text and, in one place (`'완료'`), behavior.
5. `ui.undoToast` undoes the most recent labeled action, which may not be the one the toast describes.
6. Use the silent, null-label convention for prefs and transient UI state (`quickDraft`, `homeSplit`, `lastNudgeAt`). A silent mutate does not re-render, so apply DOM effects yourself (`DN.app.applyPrefs()`).
7. Day dates are local `'YYYY-MM-DD'` strings, while block and timestamp values are ISO UTC. Do not mix them up. `dueDate` is the deadline; work time is a `kind:'work'` block, and the two are separate by design.
8. `estimateMinutes: null` means *unknown*, not 0. `updateTask` changes `estimateSource` automatically when `estimateMinutes` is patched, so pass `estimateSource` explicitly when you want `'ai'`.
9. Deleting a task removes only **future** work blocks. Deleting a note does **not** stale its proposals; call `staleForDeletedNote` as well. Blocks are hard-deleted and have no `deletedAt`.
10. `archivedAt` exists in the schema and is honoured by readers (`liveTasks`, recommend, weekly, assist), but nothing sets it.
11. The browser host lacks `onQuickCapture`, `ready`, `onFlush` and `setCloseToTray`. Guard new host calls. Browser `exportFile` never reports `canceled`.
12. Main's `closeToTray` is in-memory and defaults to `true`. It is synced from `prefs.closeToTray` only after load (assistant.js:215).
13. The emergency copy in `localStorage['daynote:unsaved']` **overrides** the file on the next load, even in Electron. A stale emergency key would silently win over a newer file. It is cleared only by a successful save.
14. `state.__holdReveal` is a transient flag on the state object. It is always deleted in `finally`, so it is never persisted, but it must not leak if new code reuses the pattern.
15. Model mutators insert in different orders: notes and tasks are `unshift`ed (newest first), everything else is `push`ed. List views sort explicitly. Do not rely on array order across entity types.
16. `clearSample` does not clean `chat` or `reports`. Chat `capture` cards may reference removed notes, so renderers must handle missing ids.
17. Each labeled mutate deep-clones the whole state. aiRuns `rawOutput` (≤60 KB × 5 per note) makes this heavy. Use `null` labels for high-frequency writes and commit drags once.
18. `normalize` does not check the version, so a newer file opened by an older build loses its unknown top-level keys on the next save. There is no downgrade guard.
19. The model has no project update or delete functions. Project edits are direct field writes inside `mutate`.
20. `replaceAll` exists but is unused. There is no restore-from-backup UI, even though a backup export exists.
