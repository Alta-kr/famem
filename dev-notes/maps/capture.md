# Daynote subsystem map: Capture / chat pipeline (text you throw in → classified items)

Paths are relative to `/home/user/famem/daynote`. Line numbers are from branch `web-mobile` at commit `d75f062`.
Everything is plain browser JS. Each module is an IIFE that writes to `window.Daynote.*`. The `src/core/**` files use a UMD wrapper, so they can also be `require`d in Node tests.

---

## 0. File index (what each file really does)

| File | Global | Role in the pipeline |
|---|---|---|
| `renderer/views/chat.js` (539) | `DN.views.chat` | Home "적어 두기" panel: message list, onboarding examples, helper buttons, textarea (Enter to send), **result card with chips**, and the breakdown/next/elaborate/rest cards. |
| `renderer/assistant.js` (231) | `DN.assistant` | Chat controller: `send()` (posts the user bubble, then calls `DN.capture.submit`, then posts the capture card), the helper buttons (`next/breakdown/rest/elaborate`), auto nudges, quick-window wiring. Owns `state.chat`. |
| `renderer/capture.js` (134) | `DN.capture` | Capture orchestrator: **saves the raw note first**, calls AI over IPC, validates, then `P.applyCapture` under undo label `'AI 분류'`. Holds the chip-correction wrappers (`setKind/setItemKind/removeItem/setProject`). |
| `renderer/aiflow.js` (124) | `DN.aiFlow` | AI status cache (`status()`), `contextOpts(note)` (today/projects/openTasks sent to the AI). Also the separate "메모 정리" review flow (`organize`), which is **not** used by capture. |
| `src/core/ai/capture.js` (84) | `DN.aiCapture` | Capture prompt (`SYSTEM`), JSON `SCHEMA`, `PROMPT_VERSION='capture.v6'`, `buildInput()`. Extends `organizeNote.js`. |
| `src/core/ai/organizeNote.js` (109) | `DN.aiOrganize` | Base prompt/schema, `buildInput()`, `userText()` (the `<context>` and `<memo>` format). |
| `src/core/ai/validate.js` (345) | `DN.aiValidate` | `validateOrganizeNote()`: checks shape, checks each item's evidence quote against the text, recomputes dates/times, finds duplicates. `verifyWhen()` checks date changes. |
| `src/core/ai/proposals.js` (781) | `DN.aiProposals` | AI-result layer: `aiRuns`, `proposals`. **`applyCapture()`** creates the tasks/blocks and applies done/moved reports. All the correction logic lives here (`captureSetKind`, `captureSetItemKind`, `captureRemoveItem`, `captureSetProject`, `captureItems`). |
| `src/core/ai/fake.js` (193) | `DN.aiFake` | Rule-based demo AI. Used with `DAYNOTE_AI_FAKE=1`, in the browser with `?fakeai`, and in the web demo. |
| `src/core/ai/assist.js` (281) | `DN.aiAssist` | Helper features: breakdown and elaborate prompts and validators, nudge timing, stretches. |
| `services/ai.js` (255) | (main process) | Provider calls (Gemini tiered / Claude / fake), retries, error classification, key handling. |
| `src/core/split.js` (84) | `DN.split` | **Unrelated to capture.** It computes the height ratios of the three right-hand home panes. It does not split text. |
| `src/core/suggest.js` | `DN.suggest` | `parseDueHint`, `normalizeText`, `hash`, `extractFromNote`. Used by the validator and the fake AI. |
| `src/core/model.js` | `DN.model` | `addNote/addTask/addBlock/completeTask/reopenTask/deleteTask`, `liveCreated/liveCompleted/liveUpdated`, `revealSources`. |
| `renderer/store.js` | `DN.store` | `mutate(label, fn, opts)`, whole-state snapshot undo, debounced save, browser host fallback (with the fake AI). |

Script load order (`renderer/index.html:16-56`): dates, model, recommend, suggest, weekly, split, ai/organizeNote, ai/validate, ai/proposals, ai/capture, ai/assist, ai/fake … store, ui, app, aiflow, capture, assistant, views/… chat, today …. **A new `src/core` file needs its own `<script>` tag in this order.** The web build (`scripts/build-web.js`) copies `renderer/` and `src/` as they are, so the tag is the only extra step.

---

## 1. Entry points (three paths into capture)

```
A) Home textarea (chat.js)      Enter → sendNow() → DN.assistant.send(v, null) → DN.capture.submit(...)  [chat bubble + card]
B) Global quick window           quick.js send() → IPC 'quick:submit' (main.js:278) → webContents.send('quick:capture')
   (Ctrl+Shift+Space)            → preload onQuickCapture → assistant.watch() (assistant.js:214) → send(text)   [same as A]
C) Ctrl+N modal (app.js:265)     saveQuick() (app.js:286) → DN.capture.submit(text, projectId)   [NO chat bubble/card, toast only]
```
- Path C skips `DN.assistant.send`, so it never posts chat messages and never gets the large-task notice. Its result appears only in the today lists and the archive.
- Quick-window text is cut at 20000 characters (`quick-preload.js`). The home textarea has no limit.
- If a quick capture arrives before the renderer is ready, main queues it in `pendingQuick`. The queue is flushed when the renderer calls `host.ready()` (main.js:240-244), which happens inside `assistant.watch()` after `S.whenReady`.

---

## 2. Step-by-step: Enter in the home textarea → saved items → result card

1. **Keydown** `chat.js:84-87`: Enter without Shift, and not during IME composition (`!e.isComposing && e.keyCode !== 229`), calls `sendNow()`.
2. **`sendNow()`** `chat.js:74-82`:
   - empty after trim → return
   - `clearTimeout(t)` cancels the draft autosave
   - `S.mutate(null, s.quickDraft = {text:'', projectId:null}, {source:'today', silent:true})`
   - clears the textarea, then calls `AS.send(v, null)`, then re-focuses `.chat-input textarea` on the next tick.
3. **`DN.assistant.send(text, projectId)`** `assistant.js:52-66`:
   - `post({role:'user', kind:'text', text})`. This pushes onto `state.chat` (`post()` at `assistant.js:24-32`, `mutate(null…, {source:'chat'})`, capped at 200 by `MAX_MESSAGES`). **The raw text exists in `state.chat` first.**
   - `DN.capture.submit(text, projectId, onDone)`.
   - `post({kind:'capture', noteId: note.id})`. The card stores only `noteId` and always renders from live state.
   - `onDone(r)`: if `r.capture.largeTasks` is non-empty, it posts a text message ("‘X’는 꽤 큰 일 같아요 …").
4. **`DN.capture.submit(text, projectId, onDone)`** `renderer/capture.js:28-39`:
   ```js
   var note = S.mutate('입력 저장', function (s) {
     return M.addNote(s, { title: '', body: text, projectId: projectId || null,
       captureRole: 'memo', capture: { status: 'pending', at: now().toISOString(), entryType: null, created: [] } }, now());
   }, { source: 'capture' });
   classify(note.id).then(function (r) { if (onDone) onDone(r, note.id); });
   ```
   **This is where the raw text is saved as a note** (undoable label `'입력 저장'`). `M.addNote` (model.js:143) prepends it with `unshift`. The file is written by the debounced save (400 ms, `store.js:85-112`), through IPC `store:save` with an atomic write in main. In the browser it goes to `localStorage['daynote:data']`.
5. **`classify(noteId)`** `capture.js:41-95`:
   - Guard: the note is missing, or `inflight[noteId]` is set → resolve `null`.
   - `DN.aiFlow.status()`. If `!configured`, it calls `setCapture(noteId, {status:'no_ai', reason})` and resolves `{ok:false, reason:'not_configured'}` (lines 44-49).
   - `sent = deepClone(note)` and `input = C.buildInput(sent, DN.aiFlow.contextOpts(sent))` (lines 50-51).
   - Starts the run inside an unlabeled mutate: sets `n.capture.status='pending', error:null`, then `P.startRun(s, {kind:'capture', noteId, noteHash, promptVersion:'capture.v6', provider, model})` (lines 52-56). Sets `inflight[noteId]=true` and calls `notify()`.
   - **AI call**: `S.host.ai.organizeNote(input)` (line 60) → preload `ipcRenderer.invoke('ai:organizeNote', input)` (preload.js:16) → `main.js:94` → `services/ai.js organize(input)`.
   - Error from the IPC call → `{ok:false, error:{type:'ipc', …}}`.
   - `!res.ok` → `P.finishRun(status:'failed', error, rawOutput)` and `note.capture = {status:'failed', error}` (lines 65-73).
   - `V.validateOrganizeNote(res.output, {note: sent, state, now})` (line 74). If not ok → run status `'invalid'`, note `'failed'` with message `'AI 응답 형식이 맞지 않아 쓰지 않았어요.'` (lines 75-84).
   - Success (lines 85-93): **`S.mutate('AI 분류', …)`** (undoable):
     ```js
     Object.assign(r, { provider: res.provider || r.provider, model: res.model || r.model });
     P.finishRun(s, run.id, { status: 'succeeded', rawOutput: res.raw || JSON.stringify(res.output), usage, dropped: v.dropped }, t);
     cap = P.applyCapture(s, { note: sent, run: r, validated: v, output: res.output }, t);
     ```
     Resolves `{ok:true, capture: cap}`.
6. **`P.applyCapture`** (proposals.js:345-427, details in §6) creates the tasks/blocks, completes or moves existing tasks, and sets `note.captureRole`, `note.kind`, `note.title` and `note.capture`.
7. **Re-render**: every `S.mutate` that is not silent emits `{type:'change', label, source}`. `app.onStoreChange` → `today.onChange` (today.js:37-44) returns `true` for `source==='today'` (draft typing), so the textarea and IME state survive. Otherwise it calls `chat.refresh()` (= `paintList`, chat.js:24-40), which rebuilds the whole message list (last 60, `SHOW`), and repaints the right-hand lists.
8. **Card**: `message()` (chat.js:132-149) → `captureCard(m)` (157-189) → `DN.capture.items(n)` = `P.captureItems(state, note)` → `capRow()` for each row (232-317).

---

## 3. AI call contract

### 3.1 IPC
- Renderer `S.host.ai.organizeNote(input)` → channel **`'ai:organizeNote'`** → `ai.organize(input)`. The same channel serves every purpose. `requestDef(input)` (services/ai.js:30-36) routes on `input.purpose`: `'capture'` → `src/core/ai/capture`, `'breakdown'` → `assist.BREAKDOWN`, `'elaborate'` → `assist.ELABORATE`, anything else → `organizeNote`.
- Other channels: `'ai:status'` (status object: `{configured, provider:'fake'|'gemini'|'claude'|null, model, fastModel?, reason?, notice?, keySource?, savedKey}`), `'ai:setKey'`, `'ai:clearKey'`, `'ai:check'` (main.js:103-111 classifies "내일까지 견적서 보내기" through `capture.buildInput`).
- Browser fallback (`store.js:46-62`): when `window.DAYNOTE_WEB_DEMO` is set or the URL has `?fakeai`, it uses `window.Daynote.aiFake.organize(input)` after 500 ms. `window.__daynoteAiFail` simulates a network error. Otherwise it returns `not_configured`.
- Main-process guard: the `inflight` Set is keyed by `input.noteId || input.requestId`. A duplicate request returns `{ok:false, error:{type:'busy', retryable:false}}`. The renderer has its own `inflight{}` (capture.js:14).

### 3.2 Provider behavior (`services/ai.js`)
- `mode()` (77-85): `DAYNOTE_AI_FAKE=1` → fake (600 ms delay). Otherwise `DAYNOTE_AI_PROVIDER` or the available key decides: Gemini first, then Claude.
- Gemini `callGeminiTiered` (213-224): for capture it tries `gemini-3.5-flash-lite` (thinking `minimal`) first, then `gemini-3.8-flash` (`low`). On a retryable error or a 404 it switches to the other model. Requests use `response_format` with a JSON schema and `store:false`.
- Claude `callClaude` (138-160): `claude-opus-5-5`, `output_config.format` json_schema, effort low, system prompt cached, `fallbacks:'default'`.
- An `invalid_json` result is retried once (`attempts:2`).
- Result: `{ok:true, provider, model, output, raw, usage, attempts}` or `{ok:false, error:{type, message, retryable}, attempts}`. Error types: `auth|permission|rate_limit|bad_request|network|server|api|unknown|refusal|truncated|failed|invalid_json|not_configured|bad_input|busy`.

### 3.3 Input JSON for capture (`C.buildInput` = `O.buildInput` + 2 fields)
```json
{"promptVersion":"capture.v6","noteId":"note_…","noteHash":"<fnv8>","title":"",
 "lines":["<body split on \\n>"],"referenceTime":"<note.updatedAt ISO>","today":"2026-10-10 (토)",
 "timezone":"Asia/Seoul","projects":["<live project names ≤30>"],"openTasks":["<non-done live task titles ≤60>"],
 "purpose":"capture"}
```
- `contextOpts(note)` is at aiflow.js:24-33. `openTasks` keeps `state.tasks` order, and `addTask` uses `unshift`, so the newest tasks come first. Only the first 60 are sent (`MAX_OPEN_TASKS`, organizeNote.js:15). **Done and moved detection only works on titles in this list.**
- `userText(input)` (organizeNote.js:93-106) renders a `<context>` block (오늘, 시간대, 기준 시각 in local time, 프로젝트, 이미 있는 할 일 list) and a `<memo>` block with line numbers `0| <title>`, `1| <line1>`, …. Line 0 is the title, which is always empty for captures.

### 3.4 Output JSON schema (`C.SCHEMA`, capture.js:55-74; every property is required; `additionalProperties:false`)
```
summary: string
sections: [{heading, bullets:[{text, line:int|null}]}]
tasks:  [{title, evidence:{quote, line:int}, due:{text|null,date|null,time|null}, project_hint:str|null,
          basis:'explicit'|'inferred', size:'small'|'large', breakdown:[{title, minutes:int|null}],
          do_at:{text,date,time}}]            // do_at = the time to do it (creates a 30-min work block), due = the deadline
events: [{title, evidence, start:{text,date,time}, duration_minutes:int|null, location:str|null, basis}]
open_questions: [{text, line:int|null}]
entry_type: 'memo'|'task'|'mixed'|'done'|'update'
note_title: string                            // used only when the note stays a memo and has no title
note_project_hint: string|null
note_kind: 'memo'|'idea'|'link'
done_tasks:    [{title (verbatim from openTasks), evidence:{quote,line}}]
updated_tasks: [{title, evidence, due:{text,date,time}, do_at:{text,date,time}}]
```
- The prompt is `C.SYSTEM` = `O.SYSTEM` (base rules 1-13) + capture rules **A–I** (capture.js:22-52): A entry_type, B tasks/events, C project hint, D note_title, E size/breakdown, F note_kind, G task vs event vs timed task, H done reports, I date changes.
- Version history comment at capture.js:18: v2 large/breakdown · v3 note_kind · v4 do_at · v5 done_tasks · v6 updated_tasks. **When the prompt changes, bump `PROMPT_VERSION`.** `test/capture-v3.test.js:38` asserts `'capture.v6'`.
- `test/assist.test.js:109-121` walks every schema object and requires `additionalProperties:false` and `required == keys`. Nested objects must therefore be built the same way (`obj()` helper or an explicit `required`).

### 3.5 Kind vocabulary (there is no `todo` kind)
| Layer | Values |
|---|---|
| AI `entry_type` | `memo, task, mixed, done, update` |
| AI `note_kind` | `memo, idea, link` |
| Card row `it.kind` | `task, event, memo, idea, link` (chip-editable) + `done, moved` (report rows, only `×`) |
| Row `ref.kind` | `note` (the note itself), `task`, `block` (an event is stored as a block), `done`, `moved` |
| `note.capture.created[].kind` | `task` \| `block` |
| `block.kind` | `event` (standalone) \| `work` (time slot for a task, `taskId` set) |
| `note.captureRole` | `memo` (visible in memo lists) \| `task_source` (hidden source text) |

The kind lists are duplicated: `chat.js:154-155` (`KINDS`, `NOTE_KIND`), `renderer/capture.js:108` (`KIND_LABEL`), `ui.js:292-293` (`KIND_LABEL`, `KIND_ICON`), `proposals.js:337-338,544` (`ENTRY`, `NOTE_KIND`, `KINDS`), `capture.js:19-20` (enums), and CSS `.kind-*`. Adding a kind means updating all of them.

---

## 4. Validation (`V.validateOrganizeNote(out, {note, state, now})`, validate.js:231-320)
- `shapeErrors` (33-50) checks **only the base organize fields**: summary, sections, tasks, events, open_questions. The capture-only fields (`entry_type`, `note_kind`, `done_tasks`, `updated_tasks`, `size`, `breakdown`, `do_at`) are **not** shape-checked. `applyCapture` handles them defensively (whitelist lookups, `Array.isArray`).
- Reference time `ref = note.updatedAt` of the *sent* snapshot.
- Each item goes through `base()` (246-260). `locate(lines, quote, hintLine)` must find the quote in the text, otherwise the item is moved to `dropped` with `'근거 문장이 원문에 없습니다'`. An empty title is dropped. `ordinal` counts repeats of the same quote.
- Task fields (262-287): `{title, dueDate, dueTime, projectId, atDate?, atTime?}`. Event fields (289-302): `{title, date, time, durationMinutes, location, projectId}`. Every field has the shape `{value, status:'ok'|'confirm', message, options:[{label,value}]}`. When the app's recomputation disagrees with the AI, the result is `confirm` with `value:null`.
  - `checkDate` (118-143): a relative expression ("30분 후") is recomputed by the app and wins. Text missing from the source → confirm. App and AI disagree → confirm. A past date → confirm.
  - `checkTime` (145-161): "3시" without 오전/오후 gives two candidates (`03:00`, `15:00`), so the time is `confirm` unless the AI picked one of them. An event needs a time (`required`).
  - `checkProject` (182-189): fuzzy name match on `project_hint`, otherwise `note.projectId`. Events always use `note.projectId`.
  - `findDupTask` (192-199): same normalized title or same source excerpt among live tasks, **including done tasks**. `findDupEvent` (202-211): same day with a similar title.
  - `extra` = `{size:'large', breakdown: sanitizeSteps(...)}` when `size==='large'` and there are at least 2 valid steps.
- Return value: `{ok, errors, items:[{kind, quote, line, ordinal, basis, flags, title, fields, duplicateOf, extra, defaultChecked}], dropped, digest}`.
- `verifyWhen(w, quote, note, now)` (324-338) is used for `updated_tasks`. It returns `{date, time}` only when the date/time is verified, and returns null for past dates.

---

## 5. `applyCapture(state, {note, run, validated, output}, now)` (proposals.js:345-427)
1. `entryType = ENTRY[out.entry_type] ? out.entry_type : 'memo'`.
2. **User override guard** (351-354): if `note.capture.changedByUser`, it only sets `status:'done', error:null, runId, doneAt` and returns. A late or retried AI result never overwrites a user decision.
3. `mergeOrganizeRun(state, {note, run, validated})` (101-149) upserts `state.proposals` by key `kind:note:<noteId>:<hash(norm(quote))>:<ordinal>`, refreshes stale proposals, and replaces `noteDigests[noteId]`.
4. Project (359-361): `userProject = note.projectId` wins. Otherwise `matchProject(out.note_project_hint)`, which is then written to `note.projectId`.
5. For each pending proposal of this run (`mine`, 363-383):
   - `duplicateOf` → `skipped.push({id, reason:'duplicate'})`. **It is not created.** The proposal stays `pending`.
   - Sets `fields.projectId` to the chosen project (the user's project overrides the AI's per-task hint).
   - An event with date and time but no duration gets `edits.durationMinutes = 30` and is remembered in `guessedDur`.
   - An event that is still `blocked` (for example an ambiguous "3시", or no date) gets `edits.saveAs='task'`, so it is created as a task.
   - Still blocked → `skipped.push({id, reason:'blocked'})`.
6. `applySelections(state, ids, now)` (248-298) creates the items:
   - Tasks: `origin:'ai_accepted'`, `proposalId`, `sources:[{type:'note', refId, excerpt: quote, noteHash, proposalId}]`.
   - `atDate`+`atTime` → a 30-minute **work block** with `durationGuessed:true`.
   - Events: an `event` block via `eventRange`.
   - Sets `p.status='accepted'`, `p.resultRef`, and `p.acceptedValues` (the values actually applied).
7. Blocks with a guessed duration get `durationGuessed=true`. For large tasks (`extra.breakdown`): `task.breakdown = {status:'pending', steps, source:'capture', createdAt, shownAt:null}` is stored and **not applied**, and the task id is pushed to `largeTasks`.
8. `completeReported(state, note, out.done_tasks, created, now)` (473-490): the evidence quote must appear in the note text (space-insensitive). `findOpenTask` (432-440) matches an exact title or exactly one fuzzy containment match, and skips tasks just created. Then `M.completeTask` (which adds a history `task_done`) runs, and `{kind:'task', id, historyId, prevStatus}` is recorded.
9. `updateReported(...)` (442-471): same matching. `verifyWhen` runs on `due` and `do_at`. A `do_at` without a time becomes a due date. A `due` sets `dueDate/dueTime`. A `do_at` moves the existing future work block or creates one. The record is `{kind:'task', id, prev:{dueDate,dueTime}, prevWork, newWorkId, to:{dueDate,dueTime,at:'YYYY-MM-DD HH:MM'|null}}`.
10. entryType reconciliation (407-413). For example, a `'task'` with nothing created becomes `'memo'`, and a `'memo'` with reports becomes `'mixed'`.
11. `keepLink = note.kindByUser ? note.kind==='link' : out.note_kind==='link'`. Then:
    - `note.captureRole = (entryType in task|done|update) && !skipped.length && !keepLink ? 'task_source' : 'memo'`.
    - `note.title = out.note_title` (≤80 characters) if it is empty and the role is memo.
    - `note.kind = out.note_kind` unless `kindByUser`.
12. `note.capture = {…, status:'done', entryType, runId, doneAt, created:[{kind,id}], skipped, completed, updated, projectByAi, largeTasks}`, which is returned.

---

## 6. Data shapes

**Note after capture** (`state.notes[]`):
```js
{ id:'note_…', title:'', body:'<raw text, never modified>', projectId, createdAt, updatedAt, deletedAt:null, sample:false,
  captureRole:'memo'|'task_source', kind:'memo'|'idea'|'link', kindByUser?:true,
  capture:{ status:'pending'|'no_ai'|'failed'|'done', at:ISO, entryType, created:[{kind:'task'|'block',id}],
    reason?, error?:{type,message,retryable}, runId?, doneAt?, skipped?:[{id:<proposalId>,reason:'duplicate'|'blocked'}],
    completed?:[…], updated?:[…], projectByAi?:bool, largeTasks?:[taskId], changedByUser?:true } }
```
**aiRun** (`state.aiRuns[]`, proposals.js:42-57): `{id:'run_…', kind:'capture', noteId, noteHash, promptVersion, provider, model, status:'running'|'succeeded'|'failed'|'invalid', attempts, startedAt, finishedAt, error, usage, rawOutput(≤60000 chars), stats, dropped}`. **Only the 5 most recent runs per noteId are kept.**

**proposal** (`state.proposals[]`): `{id:'prop_…', key, kind:'task'|'event', origin:'ai', status:'pending'|'accepted'|'dismissed'|'stale', runId, promptVersion, source:{type:'note', id, quote, line, noteHash}, payload:{title, fields, flags, basis, duplicateOf, defaultChecked, extra}, edits, aiUpdate, resultRef:{kind:'task'|'block', id}, acceptedValues, createdAt, updatedAt, reviewedAt, sample}`.

**Chat messages** (`state.chat[]`, base `{id:'msg_…', at:ISO, role:'assistant'|'user'}`, assistant.js:24-32):
| kind | extra fields | renderer |
|---|---|---|
| user `text` | `text` | bubble |
| `text` | `text`, `actions?:['next'|'rest']` | chat.js:135-141 |
| `thinking` | `text` (spinner; later overwritten with `update()`) | 142 |
| `capture` | `noteId` | `captureCard` 157 |
| `breakdown` | `taskId, intro, reason, draft:[{title,minutes}], resolved?:'applied'|'later'|'never', resolvedCount` | 439 |
| `next` | `taskId, step:title|null, reasons, skip:[ids]` | 481 |
| `elaborate` | `intro, picks:[{taskId,why,question,hints}], done:{taskId:'saved'|'skipped'}` | 501 |
| `rest` | `stretches:[{title,how,seconds}], timerEnd:ISO|null, timerDone` | 523 |

Fields that conversions add to tasks/blocks: `convertedFrom` (saved original values), `timeUncertain`, `durationGuessed`, `breakdown`.

---

## 7. Result card (chat.js:157-317)
- **States** (157-186):
  - `n.deletedAt` → "이 글은 메모에서 지웠어요."
  - `CP.isRunning(id) || c.status==='pending'` → skeleton "정리하는 중…"
  - `'no_ai'` → "메모로 저장했어요 · AI를 연결하면…" + [설정 열기]. There is no retry button.
  - `'failed'` → "메모로 남겨 뒀어요 · {error.message}" + [다시 시도] → `CP.classify(n.id)`. Retry has no `onDone`, so no large-task notice.
  - otherwise the header is `summary(items, now)` + " · 비슷한 할 일이 이미 있어서 N개는 만들지 않았어요". **That count includes `blocked` skips too.**
  - Footer: `c.changedByUser ? '직접 고침' : 'AI가 정리함'` · "Ctrl+Z로 되돌리기".
  - Rows are rendered in every non-running state, including no_ai/failed (the note row), so the user can classify by hand without AI.
- `summary()` (198-230) builds Korean sentences: "할 일로 정리했어요", "메모와 할 일 2개로 나눴어요", "‘X’를 완료했어요", "‘X’ 마감을 내일(토)로 옮겼어요". It uses `ui.josa`.
- `captureItems(state, note)` (proposals.js:747-762) returns live created rows (`task`/`event`), then `done` rows, then `moved` rows. The note row `{kind: note.kind||'memo', ref:{kind:'note'}}` is prepended unless `captureRole==='task_source'` and other rows exist.
- **Row layout** (`capRow`, 232-317): `[kind chip] [title button] [date chip]? [시각 확인 필요]? [project chip] [×]?`
  - `moved` row (240-252): "날짜 변경" chip, the new date, and × (title '원래 날짜로 되돌리기').
  - `done` row (254-265): "완료" chip and × ('완료 취소').
  - The note row has no date chip and no ×. Its project chip shows `n.projectId`.
  - Date label `dateInfo` (327-348): a task with a future work block shows "오늘 21:35 · 30분 (마감 …)". Otherwise it shows the due date, with `chip-overdue`/`chip-today` classes. An event shows the day plus time (no time when `timeUncertain`), and the length when `durationGuessed`.
  - `data-focus-key="cap:<noteId>:<idx>:kind|date|time|proj"` lets `ui.menu` put focus back on the redrawn chip (ui.js:171-185).

---

## 8. Corrections through chips: call chains, effects, and what gets recorded

| UI action | chat.js | → DN.capture (renderer/capture.js) | undo label | core (proposals.js) | Flags it sets |
|---|---|---|---|---|---|
| Kind chip, single-row card | `kindMenu` 351 → `changeKind` 360-364 | `setKind(noteId, kind)` 109 | `'<할 일>(으)로 바꾸기'` | `captureSetKind` 624-672 | `capture.changedByUser=true`, status 'done', entryType recomputed. memo/idea/link: `kindByUser=true`; task/event: `kindByUser=false` |
| Kind chip, multi-row card | same | `setItemKind(noteId, ref, kind)` 112 | same | `captureSetItemKind` 677-706 | `changedByUser=true`; `kindByUser=true` if a note kind |
| × on task/event row | 308-314 + `undoToast` | `removeItem(noteId, ref)` 115 | `'정리 결과에서 빼기'` | `captureRemoveItem` 709-743 | deletes the item; accepted proposal → `dismissed`; `changedByUser=true` |
| × on done row | 254-265 | `removeItem` | same | 726-733: `M.reopenTask(undoOf: historyId)` erases the history entry | `changedByUser=true` |
| × on moved row | 240-252 | `removeItem` | same | 713-725: restores `prev` due date, `prevWork` block, deletes `newWorkId` | `changedByUser=true` |
| Project chip (whole note) | `projectMenu` 428-436 | `setProject(noteId, pid)` 103 | `'프로젝트 바꾸기'` | `captureSetProject` 528-538: note plus every `created` item; **not** completed/updated tasks | `capture.projectByAi=false` (**not** `changedByUser`) |
| Date chip | `dateMenu` 367-383 / `pickForm` 386-404 → `setDate` 407-425 | **bypasses DN.capture**: calls `S.mutate` directly | `'마감일 바꾸기'`/`'마감일 지우기'`/`'일정 옮기기'` | `M.updateTask(dueDate)` or `M.updateBlock(start/end, timeUncertain:false if time)` | **none** |
| 시각 확인 필요 chip | 290-295 → `pickForm` | as date chip | | | none |

Conversion rules in core:
- `captureSetKind` (whole note):
  - memo/idea/link → `captureToMemo`: deletes created items, dismisses proposals, role memo.
  - task/event: with no live items it first calls `captureToTask` (the first text line becomes the title). Then:
    - `task`: `blockToTask` for blocks.
    - `event`: `taskToBlock` for open tasks; done tasks stay tasks; undated items get a one-hour slot each.
  - Original values are kept in `convertedFrom` so a round trip loses nothing (`TASK_KEEP` at 545). `guessStart` gives "9:00 on the due date" or "next whole hour" with `timeUncertain:true`.
  - `relink` re-points `proposal.resultRef`.
  - `state.__holdReveal` stops `M.revealSources` from flipping `task_source` to `memo` partway through. It is always deleted in `finally`.
- `captureSetItemKind`:
  - note row → task/event: creates a task (and a block for event), and the role becomes `task_source`.
  - item row → memo/idea/link: removes that item; role memo; `note.kind` set to the chosen kind.
  - task ↔ event: swaps the item in `capture.created`.

### Are corrections recorded anywhere? (relevant to adaptive learning)
- **There is no corrections or feedback log.** UX v2 §3.5 (DAYNOTE_UX_V2.md:60) says "고친 결과는 다음 분류의 참고가 된다 — v2 이후" (i.e., planned, not implemented). A grep for learn/feedback/correction finds nothing.
- Traces that do exist and could reconstruct a correction:
  - `note.capture.changedByUser` and `note.kindByUser`. These are booleans only, with no before/after values or timestamp. `projectByAi:false` after a project change.
  - The original AI decision: `aiRuns[note.capture.runId].rawOutput` (raw JSON). Gone once more than 5 runs exist for the note.
  - `proposals[]` with `payload` (validated AI values), `acceptedValues` (applied values), `status` (`dismissed` after ×), and `resultRef` (re-pointed after conversion).
  - `task/block.convertedFrom` (values before a kind conversion). `task.origin` is `'ai_accepted'` for AI-made items and `'user'` for converted ones.
  - The undo stack keeps labels and snapshots in memory only (30 entries, not persisted).
- Date-chip edits leave **no** capture-level trace beyond `task.updatedAt`.

---

## 9. Undo semantics and how they interact with capture
- `S.mutate(label, fn)` with a label deep-clones the **whole state before** `fn` and pushes it onto `undoStack` (≤30). `S.undo()` swaps in the snapshot but keeps the current `prefs` (store.js:145-169). The snapshot **includes `state.chat`, `aiRuns`, `proposals`**, so undo also removes chat messages posted after it.
- Ctrl+Z (`app.js:309-314`) is ignored when focus is in an INPUT/TEXTAREA. **The chat textarea is auto-focused after every send** (chat.js:81, 98-103), so the card's "Ctrl+Z로 되돌리기" hint does nothing until focus moves away. `ui.undoToast` (ui.js:104-107, "되돌리기" button) appears only for the × actions, not for kind, project or date chips.
- `undoToast` calls `S.undo()`, which pops the **top** of the stack. If an `'AI 분류'` for another note lands in between, the button undoes that instead.
- Labeled steps in one capture: `'입력 저장'` (note added) and `'AI 분류'` (applyCapture). Starting the run and posting chat messages use unlabeled mutates.
- **Bug: undo of `'AI 분류'` leaves a permanent spinner.** The snapshot holds `note.capture.status='pending'` and the run `status:'running'`, but `inflight` is already cleared. The card shows "정리하는 중…" forever, with no retry button. `recoverInterrupted` (proposals.js:84-93, run at aiflow.js:121 on load) only flips **aiRuns** to failed, not `note.capture.status`.
- **Same symptom when the app quits mid-classification**: the note stays `'pending'` across restarts. Nothing re-classifies or fails pending notes on load (grep shows no handler).
- Undo of `'입력 저장'` while the AI call is in flight removes the note and the run. When the response arrives, the success path does `Object.assign(M.byId(s.aiRuns, run.id), …)` with `null`, which throws a TypeError inside the promise (unhandled). State is unchanged because the throw happens before any write, and the undo push happens after `fn`.

---

## 10. Fake AI: how it decides kinds (`src/core/ai/fake.js`)
`organize(input)` (54-112):
1. `purpose` breakdown or elaborate → `demoAssist` (39-52): generic 4-step plan; `is_large=false` if `remaining_minutes<=30`; elaborate picks the first task.
2. `'[가짜:실패]'` in the text → server error. `'[가짜:지어내기]'` → adds an invented task, which the validator drops (test hook).
3. `SG.extractFromNote` (suggest.js:216) finds candidates: unchecked `- [ ]` lines, or sentences matching `REQUEST_PATTERNS` (부탁드립니다/해 주세요/해야/필요/제출/회신/검토/요청/TODO …), with `parseDueHint` for dates.
   - A candidate whose quote matches `EVENT_RE = /(회의|미팅|면담|발표|리뷰|세미나|워크숍|약속|점심|저녁|통화|콜)/` **and** has a date becomes an event.
   - Otherwise it becomes a task (title through `actionTitle`, which strips request endings and leading dates).
4. Any line matching `EVENT_RE` that has both a date hint and a time becomes an event. The time is filled only if it is unambiguous; otherwise it is null, the validator marks it confirm, and `applyCapture` turns it into a task.
5. `classifyCapture` (127-190), only when `purpose==='capture'`:
   - `UPDATE_RE /(할게|할께|보낼게|낼게|하기로|미룸|미뤘|미루|미뤄|옮김|옮겼|연기|변경)/` + date hint + `matchOpen` (≥2-character word overlap with an open-task stem) → `updated_tasks` (due only).
   - No tasks or events, and a single body line → a task if it has a date hint or ends with `TASK_END_RE /(하기|보내기|정리|작성|확인|준비|연락|제출|예약|검토|회신|공유|등록|신청|구매|수정)$/`.
   - Project hint: the first project with a word of ≥2 characters (excluding 신규/개선/프로젝트) that appears in the text.
   - `REL /(\d+\s*분|(?:\d+|한|두|세)\s*시간(?:\s*반)?)\s*(?:후|뒤|있다가)/` → `do_at.text`. The time expression is stripped from the title and `due` is cleared.
   - `size='large'` if the title matches `LARGE_RE /(보고서|기획|발표|준비|자료|분석|문서|계획|제안서|정리해서|만들기|작성)/`; `breakdown=genericSteps`.
   - `DONE_RE /(완료|끝냈|끝났|끝남|다 했|다했|했음|마쳤|보냈음|보냈다|제출함)/` + `matchOpen` → `done_tasks`.
   - `entry_type` (184-185): only reports → done/update; no items → memo, or mixed if there are reports; items and `body.length <= items` → task; otherwise mixed.
   - `note_kind`: a URL → link; `/(어떨까|해 보면|하면 좋|아이디어)/` → idea; otherwise memo. `note_title` = first line, ≤20 characters.

Verified results (run against the core at NOW = 2026-10-10 01:25):
| Input | Result |
|---|---|
| `내일까지 견적서 보내기` | task "견적서 보내기" due tomorrow, role `task_source` |
| `다음 주 화요일 3시 치과` | **task** (not an event: 치과 is not in `EVENT_RE`). The onboarding example is misclassified in demo mode. |
| `내일 3시 팀 회의` | event proposal with ambiguous time → **saved as a task** "팀 회의" due tomorrow, no time |
| `내일 오후 3시 팀 회의` | event block 15:00, 30 min, `durationGuessed` |
| `온보딩에 퀴즈 넣으면 어떨까` | memo, `kind:'idea'` |
| `https://x.com 나중에 읽기` | memo, `kind:'link'` |
| `30분 후 샤워하기` | task "샤워하기" + work block now+30 min (rounded to 5 min) |
| `금요일까지 분기 보고서 작성` | task, `largeTasks=[id]`, `breakdown.status='pending'` |
| `샤워 완료` (open "샤워하기") | `done` row, entryType done, role `task_source` |
| `견적서는 내일 보낼게` (open "견적서 보내기") | `moved` row, due → tomorrow |
| `우유 사기` / `장보기` | memo (no task ending matched) |
| `/todo 우유 사기` | **task titled "/todo 우유 사기"** (the TODO request pattern matches; the slash prefix is left in the title) |

---

## 11. Helper buttons (chat.js:63-66 → `DN.assistant`)
- **다음 할 일** → `AS.next(skip)` (assistant.js:69-81). Rule-based, no AI: `R.recommend(state, {now, skipIds, workHours: prefs.workHours})`.
  - `primary` → posts a `next` card. The card offers 지금 시작 (`A.startTask`) or 이어하기, 다른 추천 (`AS.next(skip+id)`), and 작게 나누기 / 나눠 둔 단계 보기 when the task has no steps.
  - `empty`: `all_skipped` → text. `time_short` → text + `breakdown()`. `no_tasks` → text. `all_excluded` → text + `elaborate()`.
- **작게 나누기** → `AS.breakdown(taskId?, intro?)` (92-120).
  - Target selection, `pickTaskToBreak` (84-90): `AS.pendingBreakdowns` first; otherwise the open task with no steps and the largest `estimateMinutes`, ties broken by earliest due date.
  - A stored draft (`task.breakdown.status` pending/later with steps) is shown directly (`markShown`).
  - AI not ready → manual card with empty rows.
  - Otherwise: `pending['bd:'+id]` guard, a `thinking` message, then `call(AS.BREAKDOWN.buildInput(t, {today, projectName}))` over the same IPC with `purpose:'breakdown'`, `requestId:'bd:'+id`.
  - `validateBreakdown` → `storeBreakdown(…, 'button')` → the thinking message is updated into a `breakdown` card.
  - Card (chat.js:439-478): edits go to `m.draft` in the chat message, not to the task. 이렇게 나누기 → `AS.applyBreakdown` (label `'단계 나누기'`) appends `steps`, sets `estimateMinutes` (source `'ai'`) when all minutes are known, and sets `breakdown.status='accepted'`. 나중에 → `'later'` (remind after 2 h). 필요 없어요 → `'dismissed'`.
- **휴식** → `AS.rest()` (166-168) posts a `rest` card with `pickStretches(3, Date.now())`. "5분 타이머 시작" → `startTimer` (`timerEnd`) → `finishTimer` posts "휴식 끝!" with action `next` and shows a toast. The countdown ticks via `chat.js startTimers` (108-118, `[data-timer-end]`). Timers are rescheduled on launch (assistant.js:218). The timer uses `Date.now()`, not `DN.app.now()`.
- **Auto nudges** `tryNudge(reason)` (183-196):
  - Triggers: `'completed'` (store label `'완료'` → after 1.5 s; **AI done-reports run under `'AI 분류'`, so they do not trigger it**), `'idle'` (3 minutes without keydown/mousedown/wheel, checked every 30 s), `'open'` (8 s after start).
  - Skipped when not on the today view, while typing in the chat input, or during a calendar event.
  - `AS.nextNudge` (assist.js:179-192): at least 20 minutes between nudges, none within 10 minutes of a capture, pending breakdowns first, then elaborate.
  - `meta.lastNudgeAt` is persisted.

---

## 12. Hook points for new features

### 12.1 Slash-command prefix parser (`/할일 …`, `/일정 …`, `/메모`, `/다음`, `/휴식` …)
Nothing parses slash commands today. Note that the `data-slash` attribute on the textarea (chat.js:19) is the **'/' focus shortcut** in `app.js:304-308`. When focus is outside a field, that handler calls `preventDefault`, so a **'/' typed from outside never reaches the textarea**. A parser must allow for that, for example by inserting '/' when focusing, or by not swallowing the key for the chat textarea.

Candidate hooks, from UI to core:
1. `chat.js sendNow()` (74-82), before `AS.send(v, null)` at line 80. Covers only the home textarea. The best place for UI-only commands (`/다음` → `AS.next()`, `/휴식` → `AS.rest()`, `/나누기` → `AS.breakdown()`) that should not create a note. The quick window never reaches here.
2. **`DN.assistant.send(text, projectId)`** (assistant.js:52-66). Recommended for chat-visible commands: covers the home textarea **and** the quick window (`onQuickCapture` → `send`, line 214). The user bubble could show the raw text while the note body stores the stripped text.
3. **`DN.capture.submit(text, projectId, onDone)`** (renderer/capture.js:28-39). The common entry for all three paths, including Ctrl+N `saveQuick` (app.js:289). The place to strip a kind prefix and record a forced kind on the note (for example `capture:{…, forcedKind:'task'}`) before `M.addNote`.
4. Applying a forced kind:
   - (a) skip the AI and call `P.captureSetKind(s, noteId, kind, now)` in the same mutate, which sets `changedByUser` so a later AI result is ignored (proposals.js:351); or
   - (b) still call the AI (to get dates and projects), then honor the forced kind in `applyCapture` right after line 349 (`entryType` override) or after creation via `captureSetKind`; or
   - (c) pass it as a hint in `C.buildInput` (capture.js:76-81) plus a new SYSTEM rule and a `PROMPT_VERSION` bump.
5. Put the pure parser in `src/core` (for example a `parseCommand(text) → {cmd, kind, rest}` in `src/core/ai/capture.js` or a new `src/core/command.js` with a script tag in index.html) so `node --test` can cover it.
6. Strip the prefix before the title is built. Otherwise it leaks into task titles: `actionTitle` and `captureToTask` (proposals.js:511-512) only strip bullets and checkboxes.

### 12.2 Status-change detector ("시작했어", "기다리는 중", "취소", …)
The existing pattern to copy is done_tasks and updated_tasks:
- Prompt and schema: add a rule after `H`/`I` in `C.SYSTEM` (capture.js:45-51); add `SCHEMA.properties.status_tasks` next to lines 67-73 (fully required objects); bump `PROMPT_VERSION` (line 18) and the test assertion.
- Fake: add a regex block in `classifyCapture` like `DONE_RE` (fake.js:171-178), using `matchOpen` and the `used{}` map, and include it in `entry_type` (184-185) and the return object (181-189). Pass it through `organize()` output at line 108.
- Core apply: after `updateReported` at proposals.js:406, add `statusReported(state, note, out.status_tasks, created, exclude, now)`, using `findOpenTask` (432) and the quote check pattern (449-450). Store `prev` status for undo. Use `M.startTask` (in-progress) or `M.updateTask({status:'waiting', waitingFor})`.
  - Extend the entryType logic (407-413) and the `sourceOnly` role decision (417-418).
  - Add `M.liveX` to model.js (281-304) and include it in `captureHasResults` so `revealSources` keeps the hidden source text consistent.
  - Add the row to `captureItems` (747-762) and an × branch to `captureRemoveItem` (709-743).
- Renderer: add a row type in `capRow` (like `moved`/`done` at chat.js:240-265) and text in `summary()` (198-230).
- No-AI or local pre-detection: `classify()` returns early at renderer/capture.js:45-49 when not configured. A rules detector could run there, or in `submit` before `classify`, so it works offline.
- Note that rule H already says "하는 중" is **not** done. Keep the done, status and moved lists mutually exclusive (exclude maps at proposals.js:443-444, 474-475).

### 12.3 Adaptive learning (record corrections, then feed them back)
- Record at the funnel: `DN.capture.setKind/setItemKind/removeItem/setProject` (renderer/capture.js:103-117) and `chat.js setDate` (407-425, which currently bypasses `DN.capture`). Recording inside the core functions in proposals.js (624, 677, 709, 528) is better, because Node tests then cover it.
  - The AI's original decision is available from `note.capture.runId` → `aiRuns` `rawOutput`, from `proposals.payload`, and from `acceptedValues`.
- **New top-level state keys must be added to `M.emptyState()`** (model.js:41-55). `M.normalize` (58-70) copies only keys present in `emptyState`, so **unknown top-level keys are dropped on load**, even though a comment says otherwise.
  - Keep the log bounded (compare `chat` at 200 and `aiRuns` at 5 per note).
  - Remember that undo snapshots include it.
- Feed back through `DN.aiFlow.contextOpts` (aiflow.js:24-33) → `O.buildInput` (organizeNote.js:66-81, which copies only known fields) → `userText` (93-106, add a section such as "사용자 교정 예시"). Add a SYSTEM rule and bump `PROMPT_VERSION`. `fake.classifyCapture` can read the same input field to show the effect in demo mode.

---

## 13. Tests (Node built-in `node --test "test/*.test.js"`)
- `test/capture.test.js`: `submit(st, text, output?)` helper (lines 23-33) mirrors the renderer flow: addNote → buildInput → fake → startRun → validate → applyCapture. Covers task-only → `task_source`; mixed → memo plus task in project; duplicate skip; dropped invented items; toMemo/toTask/setProject; user project wins.
- `test/capture-v3.test.js`: note kinds; kind round trips task ↔ idea ↔ event (with `convertedFrom` preservation); done tasks not converted; source revealed after deletions; a late AI result does not overwrite user changes; single-line `setItemKind`; relative time; `do_at` work blocks; done reports and moved reports with × undo; provider tiering, key isolation and redaction (uses `_setClients` and `withEnv`).
- `test/assist.test.js`: large-task breakdown is stored, not applied; validators; nudge timing; apply/defer; elaborate candidates; stretches; the schema strictness walker.
- When adding schema fields, the strictness walker (assist.test.js:109-121) and `capture.test.js:35-40` must still pass.

---

## 14. Pitfalls and gotchas (consolidated)
1. `src/core/split.js` is the home pane-ratio math, not text splitting. `data-slash` is the '/' focus shortcut, not a command system.
2. The raw text is stored twice: in `state.chat` (user bubble, trimmed to 200 messages) and in `notes[].body`. The note is the durable copy. `body` is never rewritten by AI or conversions; only `title`, `kind`, `captureRole`, `projectId` and `capture` change.
3. Ctrl+N (`saveQuick`) captures produce **no chat card**. The only chat-visible paths go through `DN.assistant.send`.
4. **`'AI 분류'` undo, or a quit mid-call, leaves `capture.status='pending'` forever** (spinner, no retry). No recovery code exists for note status.
5. Ctrl+Z is ignored in text fields, and the chat textarea holds focus. Kind, project and date changes show no undo toast. `undoToast` pops whatever is on top of the stack.
6. `no_ai` captures are never re-classified when a key is added later, and the card has no retry button. `aiFlow.status()` starts as `{configured:false, reason:'확인 중…'}` until the `ai:status` IPC resolves, so a capture sent very early is marked `no_ai`.
7. Date chip on a task with a work block: `setDate` changes only `dueDate`. The work block (which the chip displays first) does not move. Choosing "날짜 없음" also clears `dueTime`. Date edits set no capture flags.
8. `captureSetProject` does not touch completed or moved tasks and does not set `changedByUser`. Project and date edits are therefore invisible to the `changedByUser` override (they are direct field edits anyway).
9. A single-row card uses `setKind` (the whole note, converting every created item). A multi-row card uses `setItemKind`. The row count includes the note row.
10. In `captureSetKind`, choosing task or event resets `kindByUser=false`. Choosing memo/idea/link deletes created tasks/blocks (soft delete; future work blocks removed).
11. The header's "skipped" count mixes `duplicate` and `blocked` but always says "비슷한 할 일이 이미 있어서". Skipped duplicates stay as `pending` proposals, visible in the notes review UI.
12. `findDupTask` counts **done** tasks as duplicates, so re-throwing a finished task's text creates nothing.
13. Capture-only output fields are not shape-validated. Unknown `entry_type`/`note_kind` fall back to memo. Done and moved reports require the evidence quote to appear in the text (space-insensitive) and an unambiguous open-task match.
14. Done and moved detection only sees the first 60 open task titles, newest first.
15. `state.__holdReveal` is a transient flag on the live state object. Always delete it in `finally`, or `revealSources` stops working and the flag gets persisted.
16. Duplicated kind tables (§3.5) must stay in sync. CSS classes `kind-<kind>` exist for the five kinds plus `kind-done` and `kind-moved`.
17. Two in-flight guards: renderer `inflight{}` and main `inflight` Set. A main `busy` error turns the card into `failed`.
18. `quickDraft` is shared between the home textarea (debounced 300 ms, `source:'today'`) and the Ctrl+N modal.
19. Dead or unused APIs: `DN.capture.onChange` (no subscribers), `DN.capture.today`, `DN.capture.toMemo`/`toTask` (no UI caller; the core functions are used internally), `DN.capture.KIND_LABEL`.
20. The fake AI is a demo, not a reference. "다음 주 화요일 3시 치과" becomes a task, and a bare "3시" makes an event fall back to a task. Real-AI behavior must be tested with mocked `output` objects (the `submit(st, text, patch)` helpers accept overrides).
21. The UX doc's date menu mentions "이번 주말", but the code offers 오늘 / 내일 / 이번 주 금요일 (if it has not passed) / 다음 주 월요일 / 날짜 고르기 / 날짜 없음. The doc's right-click menu on today-list items is not implemented; the result card is the only correction surface.
