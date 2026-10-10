# Map: Recommendation · Today view · Schedule/Calendar · Blocks · Conflicts

Repo `/home/user/famem`, app `/home/user/famem/daynote` (branch `web-mobile`, HEAD `d75f062`).
All paths below are relative to `daynote/` unless noted. Line numbers are from HEAD as read on 2026-10-10.
Plain ES5-ish JS, no bundler. Core modules use a UMD wrapper (Node `require` + `window.Daynote.*`).
Renderer modules are IIFEs that hang APIs off `window.Daynote` (`DN`).

Tests: `npm test` = `node --test "test/*.test.js"`. `test/recommend.test.js` + `test/sample.test.js` pass (23/23).

---

## 0. TL;DR facts

1. `recommend(state, opts)` (`src/core/recommend.js:151`) is pure and has no side effects. `opts = { now, availableMinutes, skipIds, workHours }`.
   T comes from: the user value (`availableMinutes > 0`) first. Otherwise, inside work hours and not in a current `kind:'event'` block, it is the minutes to the next block today, capped at the end of work hours. Otherwise T is unknown (`source:'none'`).
2. Fit values are `open` (T unknown), `fits`, `step_fits`, `unknown` (estimate null) and `too_long` (split out into `tooLong[]`).
   Sort keys, in order: `fitGroup, urgency, cont, manual, prio, dueKey, slack, createdAt, taskId`.
3. The UI has **no time selection**: there are no 15/30/60/custom chips anywhere. The only recommend UI is the chat tool button **"다음 할 일"** (`renderer/views/chat.js:64`). It calls `DN.assistant.next(skip)` (`renderer/assistant.js:69`), which never passes `availableMinutes`. The result renders as a chat message card `kind:'next'` (`chat.js:481 nextCard`).
   README (`README.md:64-68`) and the header comment of `recommend.js:12` still describe chips and a "정보가 바뀌었습니다" signature banner. That UI was removed in v2, and `R.signature()` has no UI caller.
4. `workHours` is `S.state.prefs.workHours`. It is never set: there is no settings UI and `emptyState().prefs` has no key for it. So the default `{start:'09:00', end:'18:00'}` always applies. `assist.looksIdle` calls `recommend` **without** `workHours`.
5. Blocks (`state.blocks[]`) are a flat array with no normalization. Shape: `{id:'blk_…', kind:'work'|'event', taskId|null, title, start:ISO-UTC, end:ISO-UTC, origin, proposalId, sources[], sample, …optional}`. `kind` defaults to `'work'` iff `taskId` is set (`model.js:313`).
6. Conflicts come from a single function, `M.conflictsFor(state, startIso, endIso, ignoreId)` (`src/core/model.js:332`). It does lexical ISO string interval overlap over **all** blocks (work + event, past, done-task blocks), skipping blocks of deleted tasks.
7. Schedule dialog (`renderer/views/schedule.js:43 open`):
   - **Estimate null:** it already defaults to 30 min and shows the help line "소요 시간이 정해지지 않아 30분으로 잡았습니다. 길이를 바꿔 주세요."
   - **Conflict:** it shows a `.conflict-box` text, and the primary "배치" needs a **second click** (toast). There are no inline "다른 시간 찾기 / 겹쳐 배치" buttons.
   - **"다음 빈 시간 찾기"** always searches from dialog-open `now` with fixed 08–20 hours. It does not use the selected date/time and not workHours.
8. Calendar drag/drop (`renderer/views/calendar.js:188`) commits overlaps **without confirmation** (toast suffix only), and estimate-null tasks drop as 30 min silently.
9. There are no external/busy calendars. Settings shows "앱 안 캘린더만 사용 중" (`settings.js:190-193`). Any external busy source must be routed through `conflictsFor`, `calendarContext`, `findFreeSlot`, the calendar `placeBlocks` and the today `agenda`.
   `M.normalize` **drops unknown top-level state keys**, so a new collection must be added to `emptyState()`.

---

## 1. Files and roles

| File | Lines | Role |
|---|---|---|
| `src/core/recommend.js` | 274 | `recommend`, `calendarContext`, `checkStartable`, `signature`, `snoozeOptions` |
| `src/core/dates.js` | 93 | local-time date helpers (`D`) |
| `src/core/model.js` | 471 | state shape, `addBlock/updateBlock/deleteBlock/conflictsFor`, task ops (`M`) |
| `renderer/views/today.js` | 398 | Home: chat (left) + today lists (tasks/memos/agenda) with splitters |
| `renderer/views/chat.js` | 539 | chat stream; tool buttons; `nextCard` = recommend UI |
| `renderer/assistant.js` | 231 | `DN.assistant.next()` calls recommend; nudges use `calendarContext` |
| `renderer/views/schedule.js` | 147 | "일정에 배치/일정 추가/일정 수정" modal; `findFreeSlot` |
| `renderer/views/calendar.js` | 224 | day/week grid, unscheduled list, drag-drop, lanes |
| `renderer/views/detail.js` | 194 | task detail panel: estimate input, steps, work blocks list |
| `renderer/app.js` | 347 | `A.now()`, `startTask`, `snoozeMenu`, `scheduleTask`, 60 s tick |
| `renderer/ui.js` | 457 | `h`, `modal`, `menu`, `popover`, `toast`, `undoToast`, chips |
| `renderer/store.js` | 183 | `S.state`, `S.mutate(label, fn, {source, silent})`, undo, save |
| `src/core/ai/proposals.js` | 781 | creates blocks from AI (events, `durationGuessed`, `timeUncertain`, task↔event) |
| `src/core/ai/assist.js` | 281 | `looksIdle` → `R.recommend`; `elaborateCandidates` checks work blocks |
| `renderer/sample.js` | 133 | sample blocks incl. an intentional overlap pair |
| `test/recommend.test.js` | 253 | recommend spec tests |

Script load order (`renderer/index.html:16-56`): `dates → model → recommend → suggest → weekly → split → ai/* → … → store → ui → app → aiflow → capture → assistant → views/detail → views/schedule → views/chat → views/today → … → views/calendar → … → settings → palette`.
A new core module must be added both here and as a `require` in its tests. `scripts/build-web.js` copies `renderer/` and `src/` wholesale, so new files are picked up automatically, but script tags must exist in `index.html`.

---

## 2. `src/core/dates.js` (`DN.dates`, `D`)

All functions use **local time**. `dueDate` is `'YYYY-MM-DD'`, and block times are ISO strings.

```
D.ymd(d) -> 'YYYY-MM-DD' (local)                      :19
D.parseYmd(s, hm?) -> local Date at s + 'HH:MM' (or 00:00); null if !s   :25
D.startOfDay(d) / D.endOfDay(d) (23:59:59.999)        :33-34
D.addDays(d,n) / D.addMinutes(d,n)                    :35-36
D.startOfWeek(d) -> Monday 00:00                      :39
D.dayDiff(a,b) -> round((startOfDay(b)-startOfDay(a))/DAY)  (b - a)   :46
D.minutesBetween(a,b) -> Math.round((b-a)/60000)      :50
D.hm(d) -> 'HH:MM'                                    :52
D.relDay(ymd, now) -> '오늘'|'내일'|'어제'|'10월 6일 (월)'  :55
D.longDay / D.shortDay / D.weekLabel                  :65-85
D.duration(min) -> '' (null) | '45분' | '1시간' | '1시간 30분'   :75
D.WEEKDAYS = ['일','월',…,'토'], D.DAY, D.pad
```

Gotcha: `minutesBetween` rounds, so a gap under 30 s rounds to `0` (a calendar T of 0 is possible, see §3.3).

---

## 3. `src/core/recommend.js` (`DN.recommend`, `R`)

Exports (`:270`): `recommend, checkStartable, signature, calendarContext, snoozeOptions, MAX_ALTERNATIVES (=2)`.
Deps: `D` (dates), `M` (model: `byId`, `unmetBlockers`).

### 3.1 `calendarContext(state, now)` (`:65-84`)

```js
live = state.blocks.filter(b => (no taskId || task exists && !task.deletedAt) && b.end > nowIso && b.start < eodIso)
         .sort(by start)
current  = live.filter(b.start <= nowIso)
upcoming = live.filter(b.start >  nowIso)
return {
  current,                                   // blocks in progress now (any kind)
  busyWith: first current with kind==='event' || null,   // work blocks do NOT make you busy
  next: upcoming[0] || null,                 // next block today, ANY kind (incl. own work blocks)
  minutesToNext: next ? D.minutesBetween(now, next.start) : null,
  workingNow: current.filter(kind==='work' && taskId).map(taskId)
}
```

- `eod = D.endOfDay(now)`, so it covers **today only**. With no further block today, `minutesToNext = null`.
- Comparisons are **lexical ISO strings**. They are only correct if every block uses `Date#toISOString()` (UTC `Z`, fixed width). Imported external events must be normalized to this format.
- It does **not** skip blocks of done tasks or archived tasks, only deleted ones. A finished task's later work block still counts as `next`.

### 3.2 `recommend(state, opts)` (`:151-231`)

Input: `opts = { now?: Date|string (default new Date()), availableMinutes?: number|null, skipIds?: [taskId], workHours?: {start:'HH:MM', end:'HH:MM'} }`. The comment at `:150` omits `workHours`.

**Available time T and context** (`:154-176`):

```js
var wh = opts.workHours || { start: '09:00', end: '18:00' };
var whStart = D.parseYmd(D.ymd(now), wh.start), whEnd = D.parseYmd(D.ymd(now), wh.end);
var offHours = now < whStart || now >= whEnd;
if (userT != null && userT > 0)                         ctx = { availableMinutes: userT, source: 'user' };
else if (!cal.busyWith && !offHours && cal.minutesToNext != null) {
  var toEnd = D.minutesBetween(now, whEnd);
  ctx = cal.minutesToNext > toEnd ? { availableMinutes: toEnd, source:'calendar', until:'work_end' }
                                  : { availableMinutes: cal.minutesToNext, source:'calendar', until:'next' };
} else                                                  ctx = { availableMinutes: null, source: 'none' };
ctx.offHours = offHours && ctx.source !== 'user';
ctx.workHours = wh;
ctx.busyWith = cal.busyWith ? { id, title: blockTitle(...), end } : null;
ctx.next     = cal.next ? { id, title, start } : null;
ctx.minutesToNext = cal.minutesToNext;
```

Policy notes:
- The user value always wins. `0`, negative or `null` falls through to the calendar.
- Inside work hours but with **no next block today**, T is unknown. It is **not** "until work end". This follows the module comment ("오늘 남은 일정이 없으면 T 를 모른다"). A P2 decision could change it.
- During a current `event` block, T is unknown. A current `work` block does not block T.
- Night shifts (`end < start`) are unsupported: everything counts as `offHours`.
- `ctx` shape: `{ availableMinutes, source:'user'|'calendar'|'none', until?:'next'|'work_end', offHours, workHours, busyWith, next, minutesToNext }`.

**Exclusion** (`exclusionOf :92`), checked in order:
- `deletedAt || archivedAt` gives `'removed'` (not counted).
- `status==='done'` gives `'done'`.
- `'waiting'`.
- `M.unmetBlockers(state,t).length` gives `'blocked'`. Deleted blockers don't block.
- `snoozedUntil > now` gives `'snoozed'`.

**Fit** (`fitOf :101`):

```js
if (T == null)  return { fit: 'open', used: est };
if (est == null) return { fit: 'unknown', used: null };      // NOT treated as 0
if (est <= T)   return { fit: 'fits', used: est };
steps = t.steps.filter(!done && estimateMinutes != null && estimateMinutes <= T);
if (steps.length) return { fit: 'step_fits', used: steps[0].estimateMinutes, step: steps[0] };  // FIRST in array order, not best fit
return { fit: 'too_long', used: est };
```

If `est == null`, the result is `unknown` even when steps have estimates.

**Item shape** (`:189-204`), pushed to `ranked` or `tooLong`:

```js
{ taskId, fit, step: {id,title,done,estimateMinutes}|null,
  fitGroup: fit==='unknown' ? 1 : 0,           // 'open'/'fits'/'step_fits' = 0
  urgency: dueInfo.bucket,                     // 0 overdue, 1 today, 2 tomorrow, 3 ≤7d, 4 later/none
  cont: (status==='in_progress' || workingNow has id) ? 0 : 1,
  manual: typeof sortOrder==='number' ? sortOrder : Number.MAX_SAFE_INTEGER,
  prio: {high:0, normal:1, low:2}[priority] ?? 1,
  dueKey: dueDate + 'T' + (dueTime||'23:59')  | '9999-99-99T99:99',
  slack: T!=null ? (used!=null ? T-used : Infinity) : (used!=null ? used : Infinity),
  createdAt, estimateUnknown: est==null, estimateIsGuess: estimateSource==='ai',
  reasons: [string] }
```

**dueInfo** (`:48`): `bucket 0` if `dayDiff<0` **or** the due datetime (`dueTime||'23:59'`) is earlier than now. Text examples: `'마감이 2일 지났습니다.'`, `'오늘 14:00 마감입니다.'`, `'내일 마감입니다.'`, `'10월 9일 (금) 마감입니다.'`. Bucket 4 has empty text.

**Sort** `compare` (`:140`). Each key applies only when all earlier keys tie:

```js
['fitGroup','urgency','cont','manual','prio'] numeric asc → dueKey (string asc) → slack asc → createdAt asc → taskId asc
```

- `manual` (home drag order, `sortOrder`) comes **before** `prio`. The README order (`README.md:66`) is outdated.
- The `Infinity` slack values are guarded by `!==`, so no NaN.
- `tooLong.sort` uses `urgency, prio, slack` (`:209`). Gotcha: `too_long` slack is negative (`T-est`), so ascending order puts the **longest** task first.

**Reasons** (`reasonsFor :112`) are Korean sentences built only from real inputs (no scores). The lead depends on `source`:
- user: `'지금 쓸 수 있는 시간이 30분이고, 이 업무는 약 20분(추정)입니다.'`
- calendar/work_end: `'근무 종료(18:00)까지 1시간이 있고, …'`
- calendar/next: `'다음 일정 ‘팀 회의’까지 30분이 있고, …'`
- step_fits: `'전체는 약 2시간이라 …, ‘초안’ 단계(약 25분)는 30분 안에 할 수 있습니다.'`
- unknown: `'소요 시간이 정해지지 않아 30분 안에 끝날지 알 수 없습니다. 확인해 주세요.'`
- open: `'이 업무는 약 X입니다.'` or `'소요 시간 미정'`

It then appends due text, `'이미 진행 중인 업무라 …'` or `'지금 이 업무의 작업 시간이 잡혀 있습니다.'`, and `'우선순위가 높음입니다.'`. `estLabel` adds `(추정)` for AI estimates, but not on the step label.

**Output** (`:221`):

```js
{ evaluatedAt: ISO, context: ctx,
  primary: visible[0]||null, alternatives: visible.slice(1, 3),
  ranked,            // ALL non-too_long candidates (skipIds NOT removed)
  tooLong,
  excluded: { done, waiting, blocked, snoozed },   // 'removed' not counted
  empty: null | 'no_tasks' | 'time_short' | 'all_excluded' | 'all_skipped' }
```

`empty` logic:
- `ranked` empty and `openCount===0` gives `no_tasks`. `openCount` counts excluded non-done tasks too.
- `ranked` empty and `tooLong` non-empty gives `time_short`.
- Otherwise with `ranked` empty, `all_excluded`.
- `ranked` non-empty but all skipped gives `all_skipped`.

### 3.3 Edge cases and gotchas
- A calendar-derived T can be `0`: a next block within 30 s, or 17:59:40 with the work-end cap. Then everything with an estimate becomes too_long.
- `recommend` considers **all** live tasks, not only the "today" list.
- Results are not stored; the module comment at `:6` says "같은 입력 → 같은 결과".
- `checkStartable(state, taskId, now)` (`:234`) returns `{ok:true, task}` or `{ok:false, reason:'…'}` and reuses `exclusionOf`. It is used by `A.startTask` (`app.js:184`).
- `signature(state)` (`:247`) fingerprints the task fields and blocks `id|start|end|taskId`. It is only used in tests now.
- `snoozeOptions(now)` (`:258`) returns `[{label, at:Date}]`: 1시간 뒤, 오늘 오후 3시 (if more than 1 h away), 내일 오전 9시, 다음 주 월요일. It is used by `A.snoozeMenu` (`app.js:201`).

### 3.4 Tests (`test/recommend.test.js`)

Conventions:
- `NOW = new Date(2026, 9, 5, 10, 0)` (local Monday 10:00), `at(h,m)` gives an ISO string for that day.
- `task(s, fields)` is `M.addTask(s, fields, NOW)`. `event(s, sh,sm,eh,em)` is `M.addBlock(s,{title:'회의', start, end})`, which defaults to kind event.
- `ids(list)` maps to `taskId`.

Covered:
- Calendar T=30 → fits/too_long (`:16`).
- User T beats the calendar (`:30`).
- waiting/blocked exclusion (`:41`).
- done/deleted/snooze (`:59`).
- Unknown sorts after fits (`:74`).
- `(추정)` (`:86`).
- empty values (`:95`).
- `startTask` (`:114`).
- source none / fit open (`:127`).
- Moving a block changes T and the signature (`:137`).
- skip/all_skipped (`:148`).
- urgency order (`:163`).
- continuation (`:174`).
- priority (`:189`).
- deterministic ties (`:200`).
- step_fits (`:212`).
- offHours 00:15 (`:226`).
- work_end cap 17:00 → 60 (`:242`).

`test/sample.test.js:64-77` also asserts that sample data yields `source:'calendar', availableMinutes:30, fit:'fits'`.

---

## 4. Where "지금 할 일 추천" lives today (v2)

### 4.1 Entry points
- Chat tool row (`renderer/views/chat.js:63-66`): `h('button.chat-tool', {onclick: () => AS.next()}, icon('spark'), '다음 할 일')`, plus '작게 나누기' and '휴식'.
- Text-message action `'next'` (`chat.js:138`, button '다음 할 일 추천받기'). It is posted after the rest timer ends (`assistant.js:178`).
- **There is no recommend card on the today panel.** The P1 report (`DAYNOTE_UX_P1_REPORT.md` §4) describes one, with a context line, "추천 근거", "다른 후보 2개 보기" and "쓸 수 있는 시간을 골라 주세요". It no longer exists in the code (git history has only 2 commits, so the old code isn't recoverable).

### 4.2 `DN.assistant.next(skip)` (`renderer/assistant.js:69-81`)

```js
var r = R.recommend(S.state, { now: now(), skipIds: skip || [], workHours: S.state.prefs.workHours });
if (r.primary) post({ kind:'next', taskId: r.primary.taskId, step: r.primary.step ? r.primary.step.title : null,
                      reasons: r.primary.reasons, skip: skip || [] });
else if (r.empty==='all_skipped') post(text '추천할 후보를 모두 보여 드렸어요…')
else if (r.empty==='time_short')  { post(text '남은 시간 안에 끝낼 수 있는 할 일이 없어요…'); breakdown(); }  // breakdown() w/o taskId → pickTaskToBreak, NOT r.tooLong[0]
else post(no_tasks ? '아직 할 일이 없어요…' : '지금 바로 시작할 할 일이 없어 보여요.'), and elaborate() unless no_tasks
```

- `availableMinutes` is never passed, and `context` (source, offHours, busyWith, next) is never shown.
- Chat messages persist in `state.chat` (max 200) through `post()`, which is `S.mutate(null, …, {source:'chat'})` and so is not undoable.
- `now()` is `DN.app.now()`. It honours `window.__daynoteNow` for pinning the clock (`app.js:29`).

### 4.3 `nextCard(m, st, now)` (`chat.js:481-498`)
- Message shape: `{id, at, role:'assistant', kind:'next', taskId, step:string|null, reasons:[string], skip:[taskId]}`.
- It renders:
  - `'지금 하기 좋은 일'`
  - the live task title (strikethrough if done)
  - `'먼저 이 단계부터: ' + step`
  - **`reasons.slice(0,2)`**. These are frozen strings from post time and can go stale.
- Buttons:
  - in_progress → '이어하기' (`A.openTask`), otherwise '지금 시작' (`A.startTask`)
  - '다른 추천' → `AS.next(m.skip.concat(t.id))`
  - '작게 나누기' or '나눠 둔 단계 보기' when there are no steps
- To add time chips (15/30/60/직접), the natural places are:
  - (a) next to the '다음 할 일' tool button, or a popover from it
  - (b) on `nextCard`, as a "시간 바꾸기" row
- Extend `AS.next(skip, minutes)` and store `minutes` in the message so '다른 추천' preserves it.
- Show `r.context` (offHours, "쓸 수 있는 시간을 골라 주세요", "다음 일정까지 N분 · title HH:MM") in the card.

### 4.4 Nudges using calendar context
- `tryNudge(reason)` (`assistant.js:183`) returns early if `R.calendarContext(S.state, now()).busyWith`, meaning "don't interrupt during an event". It is gated by `AS.nextNudge` (20-min gap, `NUDGE_GAP_MIN`).
- `AS.looksIdle(state, now)` (`src/core/ai/assist.js:170`) calls `R.recommend(state,{now})` **without workHours**.

---

## 5. Today view (`renderer/views/today.js`, `DN.views.today`)

Layout: `div.home` > `div.home-chat` (`DN.views.chat.render`) + `div.home-lists` > `section.home-today`. The latter has three `div.home-sec` with draggable splitters: tasks / memos / agenda. Splitter ratios live in `prefs.homeSplit` (`src/core/split.js`).

Handle:
- `onChange(info)`: skip when `info.source==='today'`, defer during splitter drag, else `chat.refresh(); paint()`.
- `onTick`: repaint lists every 60 s (`app.js:332`).

Exports: `{ title:'오늘', render, todayTaskList, todayMemoList }`.

### 5.1 `todayTaskList(st, now)` (`:53-77`)
- `open` includes live non-done tasks where `in_progress || has a block whose local start day is today || dueDate <= today || created today`.
- `done` includes tasks completed today.
- Sort: tasks with numeric `sortOrder` first (ascending), then `rank` (in_progress 0, overdue 1, due today 2, else 3), then `dueDate`, then `createdAt`.
- Drag reorder (`sortable`, `:316`; keyboard Alt+↑/↓) writes `sortOrder = (i+1)*10` for the **visible open ids only**, under label '할 일 순서 바꾸기'. Tasks not on today's list keep stale `sortOrder`, which recommend's `manual` key also uses.

### 5.2 `agenda(st, now)`: '오늘 일정' (`:369-395`)

```js
list = st.blocks.filter(D.ymd(b.start) === today && !(task && task.deletedAt)).sort(by start)
```

- Multi-day or overnight blocks show only on the start day.
- Header buttons:
  - '일정 추가' → `DN.views.schedule.open({ event: true, start: DN.views.schedule.findFreeSlot(S.state, A.now(), 60) })`
  - '캘린더' → `A.go('calendar')`
- Rows: `div.agenda-item[.is-work][.is-now][.is-past]` containing `span.time 'HH:MM–HH:MM'` and a title button (task → `A.openTask`, event → `schedule.open({blockId})`). `'· 겹침'` (warning colour) shows if `M.conflictsFor(st, b.start, b.end, b.id).length > 0`, which is O(n²).
- CSS: `styles.css:585-593`. `.is-work .t::before { content:'작업 · ' }`, and the event bar is `--kind-event`.

---

## 6. Block model (`src/core/model.js`)

The header comment (`:11`) reads `ScheduledBlock → Task 참조(kind:'work') 또는 독립 일정(kind:'event')`. The due date (`dueDate/dueTime`) is separate from work time (blocks).

```js
function addBlock(state, fields) {                                          // :313
  var b = Object.assign({ id: uid('blk'), kind: fields.taskId ? 'work' : 'event', taskId: null, title: '',
                          start: null, end: null, origin: 'user', proposalId: null, sources: [], sample: false }, fields);
  state.blocks.push(b); return b;
}
function updateBlock(state, id, patch) { Object.assign(byId(state.blocks,id), patch) }   // :318
function deleteBlock(state, id) { filter out; revealSources(state); return b }           // :324 (task untouched)
function conflictsFor(state, startIso, endIso, ignoreId) {                               // :332
  return state.blocks.filter(b => b.id !== ignoreId
    && !(b.taskId && task && task.deletedAt)
    && b.start < endIso && b.end > startIso);             // half-open overlap, lexical ISO compare
}
blocksForTask(state, taskId) -> sorted by start                                         // :99
nextBlockForTask(state, taskId, now) -> first with end > now                             // :105
```

Block fields seen in code:

| field | values / meaning | set by |
|---|---|---|
| `id` | `'blk_…'` | addBlock |
| `kind` | `'work'` (task time) or `'event'` (standalone) | addBlock default; schedule.js:105; proposals |
| `taskId` | task id or null | |
| `title` | event title; for work blocks it is often a copy of the task title, but the UI shows the **live task title** | |
| `start`,`end` | ISO UTC strings (`toISOString()`) | |
| `origin` | `'user'` or `'ai_accepted'` | proposals.js:280,288 |
| `proposalId` | AI proposal link | |
| `sources` | `[{type:'note', refId, excerpt, noteHash?, proposalId?}]` | proposals |
| `sample` | bool (clearSample) | sample.js |
| `location`, `projectId` | events from AI | proposals.js:287 |
| `timeUncertain` | AI could not fix the time; chip '시각 확인 필요' | proposals.js:588, chat.js:290 |
| `durationGuessed` | length guessed (30 min / 60 min); chat chip shows length | proposals.js:280,389,464 |
| `convertedFrom` | task↔event round-trip snapshot | proposals.js:583-601 |
| `__lane` | **accidentally persisted**: calendar `placeBlocks` writes `b.__lane` onto the live state objects (calendar.js:127), which are then saved by JSON | calendar.js |

Lifecycle rules:
- `M.deleteTask` (`:268`) soft-deletes the task and **hard-deletes future blocks** of it (`b.start > now`). Past blocks stay. Every consumer must filter blocks whose task has `deletedAt`, and every one listed here does.
- Blocks are never normalized on load (`normalize :58` only normalizes tasks).
- **`normalize` iterates only the `emptyState()` keys** (`:61`). An unknown top-level key (for example a future `externalEvents`) is **dropped on load**, despite the comment. Nested `prefs` merges with `Object.assign`, so `prefs.workHours` survives.
- `clearSample` (`:438`) filters `sample:true` in the listed collections, so a new collection must be added there.
- Undo (`store.js:159`) restores a full snapshot except `prefs`. Every labelled `S.mutate(label, fn)` is undoable.

Task fields relevant here (`normalizeTask :72`):
- `estimateMinutes` (null = 미정, never 0; the UI enforces ≥1)
- `estimateSource` (`'user'|'ai'|null`). `updateTask` auto-sets it to `'user'` when `estimateMinutes` is patched without a source (`:190`).
- `steps[{id,title,done,estimateMinutes}]`
- `status` (`todo|in_progress|waiting|done`), `priority` (`high|normal|low|null`)
- `dueDate`, `dueTime`, `blockedBy[]`, `snoozedUntil`, `sortOrder`, `startedAt`, `completedAt`, `deletedAt`, `archivedAt`
- `breakdown{status,steps}`

`M.startTask` (`:242`) sets in_progress, switches other in-progress tasks to todo and clears snooze. It never touches blocks.

---

## 7. Schedule dialog (`renderer/views/schedule.js`, `DN.views.schedule = { open, findFreeSlot }`)

Constant: `DAY_START = 8, DAY_END = 20` (`:9`), the free-slot search window. It is **not** `prefs.workHours`.

### 7.1 `findFreeSlot(state, from, minutes, ignoreId)` (`:20-33`)

```js
t = roundUp15(from)
for day 0..13: s = (day0 ? max(t, base 08:00) : base 08:00); end = base 20:00
  while s+minutes <= end: if (!M.conflictsFor(state, s, s+minutes, ignoreId).length) return s; s += 15min
return roundUp15(from)          // fallback = conflicting slot, no signal to caller
```

- It includes weekends and doesn't respect workHours.
- Any block counts as busy, including **past or done work blocks** and other tasks' planned work.
- The fallback is indistinguishable from success.

Callers:
- `open()` default start
- `nextFree()`
- today '일정 추가' (60 min)
- calendar header '일정 추가' via `defaultStart()` (`calendar.js:69`, 60 min from today/now or the first visible day at 09:00)

### 7.2 `open(opts)` (`:43-144`)

`opts: { taskId?, blockId?, start?: Date, minutes?, event?: true }`. **`event` is ignored**: `isEvent = !task`. **No caller passes `minutes`.**

```js
block = byId(blocks, opts.blockId); task = byId(tasks, opts.taskId || block.taskId); isEvent = !task; now = A.now();
minutes = block ? minutesBetween(block.start, block.end)
        : opts.minutes || (task && task.estimateMinutes ? Math.min(task.estimateMinutes, 240) : isEvent ? 60 : 30);   // :51
unknownEst = task && task.estimateMinutes == null && !block && !opts.minutes;                                        // :53
start = block ? block.start : opts.start ? opts.start : findFreeSlot(st, now, minutes);                               // :54
```

Controls:
- `titleIn` (events only; task blocks can't be renamed)
- `dateIn[type=date]`, `timeIn[type=time step=900]`
- `durIn` select with `[15,30,45,60,90,120,180,240] ∪ {minutes}`, sorted

`update()` (`:69`) runs on every change/input:
- It **resets `allowConflict=false`**.
- It computes `c = M.conflictsFor(S.state, r.s, r.e, block && block.id)` and renders either `div.conflict-box` (`icon('alert') + '<relDay> HH:MM–HH:MM · 겹치는 일정: ‘title’ HH:MM–HH:MM, …'`) or `div.ok-box ('… · 겹치는 일정 없음')`.
- It adds `dueWarn` (a second conflict-box, `'마감(…)보다 늦은 시간입니다.'`) when the task due is before the start.
- It adds the help `'지난 시간입니다…'` when the start is before now on a new block.

`nextFree()` (`:84`) is `findFreeSlot(S.state, now, Number(durIn.value), block && block.id)`. It starts from **dialog-open `now`**, not from the chosen date/time.

`commit()` (`:89`), on the primary button:
1. Validate the date. Events need a title.
2. Recheck conflicts against **current** state.
3. If there is a conflict and `!allowConflict`: `update(); allowConflict = true; toast('겹치는 일정이 있습니다. 그래도 배치하려면 한 번 더 눌러 주세요.'); return false` (keeps the modal open).
4. Otherwise `S.mutate(block ? '일정 변경' : '일정에 배치', s => block ? M.updateBlock(s, block.id, {start,end[,title]}) : M.addBlock(s, {taskId, kind: task?'work':'event', start, end[, title]}))`.
5. `undoToast('‘title’ 작업 시간을 오늘 14:00에 배치했습니다. 마감일은 바뀌지 않습니다.')`.

Body order (`:111-124`):
1. Task header (title, due '— 작업 시간과 별개입니다') or the title field.
2. Date/start row.
3. Length plus a '다음 빈 시간 찾기' button.
4. Block source line (`ai_accepted`).
5. **`unknownEst` help: `'소요 시간이 정해지지 않아 30분으로 잡았습니다. 길이를 바꿔 주세요.'`** (`:121`).
6. `preview` (aria-live).
7. Footer help `'빈 시간은 앱 캘린더 기준의 후보입니다. 실제로 여유가 있는지는 직접 확인해 주세요.'`.

Modal (`ui.modal`):
- Title: '작업 시간 변경' | '일정 수정' | '일정에 배치' | '일정 추가'.
- Actions: '취소' plus primary '변경 저장'|'배치' (`onClick: commit`; returning `false` keeps it open).
- `footLeft`: a delete button ('이 작업 시간 삭제' / '일정 삭제').
- For task+block, a '할 일 열기' button is inserted in the footer (`:139`).

### 7.3 Gap vs P2 ("P2 일정 충돌", `DAYNOTE_UX_P1_REPORT.md` 남은 작업)

| P2 item | Current state | Missing |
|---|---|---|
| 소요 시간 미정 → 30분 제안값 표시 | Defaults to 30 min. Plain `div.help` line (`:121`). | Visual "제안" marker on the length (e.g. `chip-guess` "제안 30분"). Option to save the chosen length back to `task.estimateMinutes` (no write today). An AI-estimate `(추정)` label when `estimateSource==='ai'`. A notice when the estimate is clamped (>240). The same silent 30 in calendar drag (`calendar.js:44`). |
| 충돌 시 "다른 시간 찾기 / 겹쳐 배치" | Conflict text plus a separate, always-visible '다음 빈 시간 찾기' (from `now`). Two-click primary with toast. | Inline buttons inside `.conflict-box`: **다른 시간 찾기** (search from the selected start or same day first, pass `ignoreId`, report "no slot") and **겹쳐 배치** (commit with `allowConflict=true`). The primary label could switch. Calendar drop needs the same choice; it currently commits silently. |
| 좁은 블록 정보 축약 | `.bm` time line only if `height > 30` (`calendar.js:146`); lane width ignored | compact rendering for narrow lanes |
| 날짜 헤더 마감 펼치기 | `div.due` `'마감 N · first title'` + `title` tooltip (`calendar.js:85`) | expandable list |
| 미배치 목록 접기 | `section.cal-side` always shown (260px; stacked on phone) | collapse toggle (could live in `mem`) |
| 근무 시간 설정 UI (P2 설정) | none | settings card writing `prefs.workHours` (silent mutate like theme, `settings.js:228`); `findFreeSlot` should probably use it too |

Pitfalls when implementing:
- `update()` resets `allowConflict` on any input, so an explicit "겹쳐 배치" button should call commit with a force flag rather than rely on the variable.
- `commit` re-reads `S.state`, which is the right pattern. Keep the recheck at save time.
- The return value of `findFreeSlot` does not say whether a slot was found. Add a variant that returns `null` or `{start, found}` so "다른 시간 찾기" can say "14일 안에 빈 시간이 없어요".
- `allowConflict` is per dialog instance, and `S.mutate` labels drive undo text.

---

## 8. Calendar view (`renderer/views/calendar.js`, `DN.views.calendar = { title:'캘린더', render, _mem }`)

Constants (`:11`): `H_START=0, H_END=24, HOUR_PX=48, SNAP=15`.

Module state:
- `mem = { mode:'week'|'day', anchor:'YYYY-MM-DD'|null, scrolled:false }`
- `drag = null | { kind:'task'|'block', id, minutes, offsetMin }`

There is no month view, by design (`:6`).

Unscheduled (`:31-51`):
- Live, not done, and **no block of any kind with `taskId===t.id && end > now`**. Sorted by `dueDate`.
- Card `div.unsched[draggable][data-task-id]`: title, '배치' button (`A.scheduleTask`), chips `dueChip, estimateChip, statusChips`.
- dragstart: `drag = {kind:'task', id, minutes: est ? min(est,240) : 30, offsetMin:0}`.
- dblclick opens the task.

Header (`:54-74`): prev/next (±7 or ±1 days), '오늘', the 일간/주간 segment, '일정 추가'. Days header: `cal-day-label` with `div.due` from `dueByDay` (live non-done tasks by `dueDate`).

Grid (`:89-112`):
- Hour labels; per-day `div.cal-col[data-day]` with 48 half-hour `div.cal-slot` elements.
- `placeBlocks(col, d)`, plus a now line `div.cal-now`.
- `wireDrop`.
- Click on an empty slot → `schedule.open({event:true, start: timeAt(...)})`.

`placeBlocks(col, d)` (`:114-159`):

```js
list = S.state.blocks.filter(D.ymd(b.start)===key && !(task && task.deletedAt))
       .sort(start asc, then longer first)
lanes: greedy — lane = first lane whose last end <= b.start; b.__lane = lane      // mutates state objects!
n = max(b.__lane, max lane among overlapping) + 1                                 // overlap via ISO string compare
el = div.cal-block.(work|event)[.is-done][.is-conflict]  role=button tabindex=0 draggable
     top = minutes-from-midnight px; height = max(duration px, 22); left/width by lane/n
     children: div.bt label, div.bm 'HH:MM–HH:MM[ · 작업]' if height>30, div.conf '⚠ 겹침' if conflict
     click/Enter/Space → schedule.open({blockId})
     dragstart → drag = {kind:'block', id, minutes: duration, offsetMin: snapped grab offset}
```

- Conflict here means "overlaps another block **starting the same day**". Cross-midnight blocks are drawn only on the start day and can overflow the column.
- The work-block label is the live task title. CSS is at `styles.css:686-704`: `.cal-block.work` uses `--kind-task`, `.event` uses `--kind-event`, and `.is-conflict` has a warning ring.

Drag/drop (`:173-206`):
- `dragover` shows `div.cal-ghost[.is-conflict]` with `'HH:MM–HH:MM · 겹침 N건'`.
- `drop` **commits immediately**:
  - task: `S.mutate('일정에 배치', addBlock({taskId, kind:'work', start, end}))`
  - block: `S.mutate('일정 변경', updateBlock(...))`
  - Followed by `undoToast(... + (conflict ? ' 다른 일정과 겹칩니다.' : ''))`.
- `timeAt(col, d, clientY, offsetMin)` snaps to 15 and clamps to `[0, 24h-15]`.

Handle: `onTick` triggers `A.refresh()` (full re-render every 60 s, which also clears a ghost mid-drag). `destroy` clears the ghost/drag. The initial scroll goes to `clamp(now.h-1, 7, 16)`.

Phone (`styles.css:1336+`): `.cal-layout` stacks into a column and `.cal-side` goes full width. There is no touch DnD; HTML5 drag does nothing on mobile, so the dialog is the only path there.

---

## 9. Task detail panel (`renderer/views/detail.js`, `DN.views.detail.render(root, taskId)`)

Relevant parts:
- **Estimate input** `:59-68`: `input[type=number min=1 step=5 placeholder='미정']`. On change: `'' → null`, else `max(1, round)`, saved as `{estimateMinutes}` (the source becomes 'user' automatically).
  - Help text when null: `'비워 두면 ‘소요 시간 미정’입니다. 추천에서 0분으로 보지 않습니다.'`
  - AI estimate: `chip-guess 'AI 추정값'` plus '이 값으로 확정' (saves `estimateSource:'user'`).
- **Steps** `:87-106`: checkbox, title, estimate ('미정'), delete, and an add row (title + minutes). The comment says steps enable `step_fits`.
- **Work blocks** `:122-131`:
  - `M.blocksForTask` rows `'오늘 14:00–15:00 (지남)'`.
  - '변경' → `A.scheduleTask(taskId, {blockId})`.
  - '삭제' → `M.deleteBlock` under label '작업 시간 삭제'.
  - Section `'작업 시간'` with '작업 시간 추가' → `A.scheduleTask(taskId)` (`:160`).
- Actions `:135-143`: '지금 시작', '완료', '일정에 배치' (`A.scheduleTask`), '나중에' (`A.snoozeMenu`).
- Blocker help `:165`: `'선행 업무가 끝나기 전에는 ‘지금 할 일 추천’에 나오지 않습니다.'`
- `save(patch,label)` is `S.mutate(label, M.updateTask(...), {source:'detail'})`. `onChange` skips the re-render for its own edits unless the label matches `/상태|단계|선행|미루기|소요 시간 확인|마감일/`.

---

## 10. Shared app and UI helpers used here

- `A = DN.app` (`app.js:338`) provides:
  - `now()`, `go(view, params)`, `refresh()`
  - `openTask(id, {keepFocus})`, `closeDetail()`, `toggleDone(id)`
  - `startTask(id)`: checkStartable, confirm switch, mutate '지금 시작'
  - `snoozeMenu(id, anchor, after)`, `taskMenu`, `deleteTask`
  - **`scheduleTask(id, opts)` = `DN.views.schedule.open({taskId:id, ...opts})`** (`:235`)
  - `current()`, `detailTaskId()`
- `S = DN.store`:
  - `S.state` (getter)
  - **`S.mutate(label|null, fn, {source?, silent?})`**: a label makes the change undoable, `silent` suppresses the change emit, and `source` is passed to view `onChange(info)`
  - `S.subscribe(fn)` receives `{type:'change'|'undo'|'load', label, source}`
  - `S.undo()`, `S.host` (Electron IPC or browser localStorage shim)
- `ui = DN.ui`:
  - `h('tag.cls#id', attrs, ...children)`
  - `modal({title, body, actions:[{label, primary, danger, disabled, onClick → false keeps open}], footLeft, wide, onClose}) → {close, box, body, foot}`
  - `confirm(title, msg, okLabel) → Promise<bool>`
  - `menu(anchor, items, opts)`, `popover(anchor, node, opts) → {close, setContent, place}`
  - `toast(msg, {action, error, duration})`, `undoToast(msg)`
  - `icon(name)`
  - Chips: `dueChip(t, now)`, `scheduleChip(st,t,now)` ('작업 오늘 14:00' / '일정 미배치'), **`estimateChip(t)`** ('소요 시간 미정' / '약 30분 (추정)' as `chip-guess` / '30분'), `statusChips(st,t,now)`
- CSS tokens: `.conflict-box` (warning-soft), `.ok-box` (success-soft) (`styles.css:878-879`). `.chip-guess` is dashed warning (`:456`), `.chip-overlap` (`:461`). Use the existing `.seg` button group for time chips (calendar mode toggle and settings theme use it). `.chat-tool` is at `:1021`.
- There is no IPC for calendars. The IPC list in `main.js:78-286` covers only store/ai/clipboard/file/app/quick. The renderer works the same with the browser shim (`store.js:15`); `scripts/serve.js` and `build-web.js` need nothing extra.

---

## 11. Other block producers and consumers (grep map)

Producers (`M.addBlock`):
- `schedule.js:105` (dialog)
- `calendar.js:199` (drop)
- `proposals.js:278` (AI task with time → 30-min work block, `durationGuessed`)
- `proposals.js:285` (AI event)
- `proposals.js:464` (date-change report → new 30-min work block)
- `proposals.js:585` (task→event)
- `proposals.js:617` (event→task keeps a work block)
- `sample.js:88-97`

Updaters:
- `schedule.js:104`, `calendar.js:202`
- `chat.js:415-424` (`setDate` for event rows: keeps the length, ≥15 min, defaults 60)
- `proposals.js:463,718`

Deleters:
- `schedule.js:130`, `detail.js:128`
- `proposals.js:497,574,620,719,734`
- `M.deleteTask` (future blocks)

`conflictsFor` callers:
- `schedule.js:28,72,94` (`findFreeSlot`, preview, commit)
- `calendar.js:179,195` (ghost, drop)
- `today.js:387` (agenda '· 겹침')
- `review.js:179,250` (created link '겹침 N', draft event conflict '— 겹쳐도 저장할 수 있어요.')
- `notes.js:249` (linked events)
- `proposals.js:291` (`created[].conflicts` count)
- `test/sample.test.js:48`

Other block readers:
- `R.calendarContext`/`recommend`/`signature`
- `today.todayTaskList` (block today → on today list), `today.agenda`
- `calendar.unscheduled`/`placeBlocks`
- `ui.scheduleChip` via `M.nextBlockForTask`
- `chat.dateInfo` (`:331`, work-block time on capture rows)
- `assist.elaborateCandidates` (`:150`, skips tasks with future work blocks)
- `validate.findDupEvent` (`:202`, same-day similar title = duplicate; time-only overlap = conflict, not dup)
- `palette.js:105` (event search `!b.taskId`), `notes.js:241`

---

## 12. Where external/busy events would plug in

There is no external-calendar code now. `README.md:98` lists "외부 캘린더 동기화" as unimplemented; `settings.js:190-193` has the static card "앱 안 캘린더만 사용 중".

Touch points that must learn about external busy time:
1. **`M.conflictsFor`** (`model.js:332`). Every conflict UI and `findFreeSlot` flows through it. Either add external busy items to its scan (best: one place), or add `M.busyIntervals(state, from, to)` and use it in both.
2. **`R.calendarContext`** (`recommend.js:65`) feeds `busyWith` (only `kind==='event'` counts as busy), `next` and `minutesToNext`, which give T. External events should count as `event`. Decide whether to skip own **work** blocks for `next`: today they shorten T.
3. **`schedule.findFreeSlot`** (`schedule.js:20`). It inherits from `conflictsFor`; also align its hours with `prefs.workHours`.
4. **Rendering**: `calendar.placeBlocks` (`calendar.js:114`), `today.agenda` (`today.js:369`). External items need a distinct class (read-only, no drag, click opens info rather than `schedule.open`).
5. **Edit guards**: `schedule.open({blockId})` assumes the block is editable/deletable. The calendar block drag (`dragstart`) and the delete in the dialog must be disabled for read-only external items.
6. **`R.signature`** (if revived) and **`assist.tryNudge`** busy suppression come through `calendarContext`.
7. **Storage**:
   - A separate top-level array must be added to `M.emptyState()` (`model.js:41`), or `normalize` drops it.
   - It should probably be excluded from undo snapshots (like `prefs`) if synced.
   - It must be added to `clearSample` if samples include it.
   - Alternative: store as `blocks` with `kind:'event', origin:'external', readOnly:true, externalId, calendarId`. This gets conflicts and rendering for free but needs edit guards, and `deleteTask`/`palette`/`findDupEvent` will see them.
8. **Times**: keep `start`/`end` as `toISOString()` UTC strings. All overlap logic is lexical string comparison. All-day events need an explicit representation; there is none now.
9. **IPC**: a sync would live in the main process (a new `ipcMain.handle('calendar:…')` in `main.js` + `preload.js` + a `store.js` browser shim stub), following the `ai:*` pattern.

---

## 13. Pitfalls checklist

- Time chips are documented (README, recommend.js header) but **not implemented**. Don't assume an existing UI.
- `prefs.workHours` has no writer, and `looksIdle` ignores it. `findFreeSlot` uses its own 08–20. There are three different notions of "working day".
- `availableMinutes` must be `> 0` to count. Pass a number of minutes, not a string, because `est <= T` and `T - used` would misbehave.
- `step_fits` picks the first fitting undone step in array order. Steps without estimates are ignored. A task with a null estimate never reaches step logic.
- `ranked` still contains skipped ids. Only `primary/alternatives` honour `skipIds`.
- `tooLong` is sorted longest-first within the same urgency/prio (negative slack).
- Chat `next` messages freeze `reasons`, so re-renders show stale reasons.
- `time_short` handling calls `breakdown()` without the too-long task id.
- `calendarContext` counts done tasks' work blocks and any work block as `next`. Only `event` blocks make you "busy".
- `conflictsFor` treats past and done blocks as conflicts too, which matters for `findFreeSlot` when it searches from now. Blocks of archived tasks also still count.
- In the schedule dialog, `opts.event` is unused. `nextFree` searches from open-time `now`. `allowConflict` resets on any edit. The `findFreeSlot` fallback silently returns a conflicting slot. The chosen length is never written back to the task estimate.
- Calendar drop never asks about conflicts. Estimate-null and >240 are silently 30/240. The 60 s `onTick` re-renders mid-interaction.
- `placeBlocks` writes `__lane` onto persisted block objects.
- `M.normalize` drops unknown top-level keys, and blocks are not normalized (no defaults for older data).
- All date logic is local time. Tests use `new Date(2026, 9, 5, 10, 0)` (local). Container TZ is likely UTC, but ISO strings make overlap TZ-agnostic.
- `A.now()` respects `window.__daynoteNow` for screenshots and manual checks. Use `A.now()`, never `new Date()`, in views.
- Mutations: give undoable user actions a Korean label (`'일정에 배치'`, `'일정 변경'`, …). Use `S.mutate(null, …, {silent:true})` for prefs (see the theme in `settings.js:228`). `prefs` is excluded from undo.
