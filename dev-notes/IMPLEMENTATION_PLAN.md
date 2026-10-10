# Daynote v4 — Integration & Implementation Plan (two waves, disjoint file ownership)

- Base: `/home/user/famem`, branch `web-mobile`, commit `d75f062`. App root `daynote/` (all paths below are relative to `daynote/` unless they start with `/` or `DAYNOTE_`).
- Inputs (read the relevant ones fully before coding): `DAYNOTE_STATUS_DESIGN.md` (= **STATUS**), `DAYNOTE_GOOGLE_DESIGN.md` (= **GOOGLE**), `DAYNOTE_FEATURES_SPEC.md` (= **FEATURES**), `DAYNOTE_ADAPTIVE_PLAN.md` (= **ADAPT**), and the maps in `/tmp/claude-0/-home-user-famem/d3fdabf7-4009-5137-898c-558d19de7de2/scratchpad/maps/*.md`.
- This plan **overrides** the four design docs wherever they disagree (§1). Where this plan says "implement X §n", implement that section literally, plus the overrides written here.
- Nothing has been implemented yet (`git status` shows only the four docs as untracked). Current suite: `npm test` = 123 tests / 12 files, all green.

---

## 0. Ground rules for every engineer

1. **Edit only the files your package OWNS** (§4, §7). If you believe a file you do not own needs a change, do not touch it: write a `REQUEST:` line in your final report (file, function, exact change). Cross-package calls go through the contracts in §5 and must be **guarded** (`if (DN.status && DN.status.view) …`) so any partial merge still runs without exceptions.
2. Syntax: `src/core/**` and `renderer/**` are **ES5** (`var`, `function`, no arrows/const/let/template literals/classes/async/`?.`/spread). `services/**`, `main.js`, `preload.js`, `scripts/**`, `test/**` use modern Node. Every file starts with `'use strict';` + a Korean header comment. Core modules use the UMD template of tests map §3.1.
3. Core functions take `now` explicitly and never read the wall clock (no `new Date()` defaults in new code paths). Renderer code uses `DN.app.now()`.
4. Renderer code references other renderer modules **lazily** (inside functions), never at script-load time; new renderer files are loaded via tags the orchestrator pre-adds (§4.2) and may initially be placeholders.
5. State writes only through `S.mutate(label|null, fn, {source, silent})`. Labels are user-visible Korean and are load-bearing (see §2.13). Prefs and `presence` writes are always `null`-labeled.
6. No new color tokens; no edits to `renderer/styles.css`. Each wave-2 package puts **all** of its CSS in its own `renderer/css/<pkg>.css` (already linked by the orchestrator). Respect ui-map gotchas: ARIA booleans as strings; custom properties via `el.style.setProperty` or classes, never `style:{'--x':…}`; `.menu button` overrides `.btn` inside popovers.
7. User-facing copy is `-어요` style; dynamic titles in `‘ ’`; particles via `ui.josa`.
8. Tests: `node:test` + `node:assert/strict`, Korean test names, fixed clocks (`new Date(2026, 9, 5, 10, 0)` Mon; `new Date(2026, 9, 9, 18, 42)` Fri; `new Date(2026, 9, 10, 1, 25)` Sat), states built from `M.emptyState()` + mutators. Tests must pass under `TZ=UTC` and `TZ=Asia/Seoul`.
9. **Cross-package test guard (wave 1 only).** A wave-1 test that needs a module or behaviour delivered by *another* wave-1 package must skip itself until that package is merged, using exactly these probes:
   ```js
   const fs = require('fs'), path = require('path');
   const has = (rel) => fs.existsSync(path.join(__dirname, '..', rel));
   const AD = has('src/core/adapt.js') ? require('../src/core/adapt') : null;          // W1-adapt
   const SL = has('src/core/slots.js') ? require('../src/core/slots') : null;          // W1-slots-recommend
   const ST = has('src/core/status.js') ? require('../src/core/status') : null;        // W1-status
   const G  = has('src/core/gcal.js') ? require('../src/core/gcal') : null;            // W1-gcal-core
   const V4 = require('../src/core/model').SCHEMA_VERSION >= 4;                        // W1-model
   const R_SV = (() => { const R = require('../src/core/recommend'), M = require('../src/core/model');   // W1-slots-recommend (statusView)
     const r = R.recommend(M.emptyState(), { now: new Date(2026, 9, 5, 10, 0), statusView: { active: true, levels: {}, rec: 'normal', offHours: false, workWindow: null, remainMinutes: null, label: 'x', id: 'work', category: 'work', guessed: false, overlay: null } });
     return !!(r.excluded && 'hidden' in r.excluded); })();
   test('…', { skip: !AD && 'W1-adapt 병합 전' }, () => { … });
   ```
   After the wave-1 merge the orchestrator requires **0 failures and 0 skipped**.
10. Final report of every package: files changed, tests added (names), test result (`npm test` summary), `REQUEST:` lines, deviations from this plan (should be none).

---

## 1. Contradictions between the docs and the decisions

| # | Topic | Conflict | Decision (binding) |
|---|---|---|---|
| C1 | `SCHEMA_VERSION` | FEATURES §1.2 "stays 3"; GOOGLE §6.1 "4 for gcal"; ADAPT A16 "4 for learned, share"; STATUS §3.6 "share one number" | **One bump 3 → 4** for gcal + learned + presence + task context fields. Comment at model.js:23 becomes `… · 4: Google 캘린더(gcal, 되돌리기 제외) · 적응(learned) · 현재 상태(presence, 되돌리기 제외) · 할 일 맥락(context·atMode)`. |
| C2 | External busy events storage | FEATURES §1.5/§2.3 reads `state.externalEvents` (or blocks with `externalId`); GOOGLE D6 stores `state.gcal.events` + projections | **No `state.externalEvents`, no `externalId` on blocks.** Single source = `state.gcal.events`, read only through `M.externalItems()` / `M.calendarItems()`. `slots.collectBusy` reads `M.externalItems(state, from, to)` (busy && !allDay) plus `opts.external` (test hook, FEATURES ExternalEvent shape with its exclusion rules). The FEATURES "externalId duplicate" rule is dropped. |
| C3 | Conflict detection | FEATURES: dialog uses `slots`, `M.conflictsFor` unchanged; GOOGLE: `M.conflictsFor` gains Google items | Both. `M.conflictsFor` adds busy, non-all-day ExtItems (opt-out `opts.blocksOnly`). `slots.collectBusy` applies the identical rule. A test asserts they agree (W1-slots-recommend). |
| C4 | Work hours | Only FEATURES defines `prefs.workHours = {start,end,days}`; STATUS reads it | `prefs.workHours` per FEATURES D7 (default **Mon–Fri 09:00–18:00**, absent = default). All readers normalize through `SL.normalizeWorkHours` (status.js has an identical internal fallback because it must not hard-depend on slots). |
| C5 | Capture prompt version | FEATURES D13 "stay capture.v6"; ADAPT "v7 rule J"; STATUS "v7/v8 rules K·L·M" | **One `capture.v7`** containing rules J (ADAPT §7.6.1) + K, L, M (STATUS §14) and the STATUS schema additions. `test/capture-v3.test.js:38` asserts `'capture.v7'`. FEATURES' statement is superseded. |
| C6 | `DN.status.setFromCommand` | FEATURES §1.5: "labeled mutate", returns `{ok,label,message}`; STATUS §5.10: unlabeled, returns `{ok,label,message,posted}`, picker when no args | **STATUS wins.** Status changes are never undoable (`presence` is kept on undo). `statusCommand` (assistant.js) shows nothing when `r.posted`; with empty args on the chat surface it calls `DN.status.postPicker()`. |
| C7 | `DN.status.current(now)` shape | FEATURES `{label,busy?,until?}`; STATUS `{id,label,busy,until,guessed}` | STATUS superset. |
| C8 | Recommend `opts.status` vs `opts.statusView` | FEATURES: `ctx.status = opts.status||null`; STATUS: statusView injection, "no new keys" (I1) | Both options accepted. `context.status` key is **always present**: `sv ? {id,label,guessed,category,overlay} : (opts.status || null)`. All other statusView-only keys (`levelRank`, `level`, `ctx` on items, `excluded.hidden`, `hiddenIds`) appear **only** when `statusView` is non-null. I1 holds because `recommend(s,{now})` deep-equals `recommend(s,{now,statusView:null})`. |
| C9 | Adaptive type `context` | ADAPT §7.8: `to` = status label (≤40), `strongNPart:3`, group "상태(맥락)"; STATUS §6.6: task context id or `'none'`, `strongNPart:2`, group "할 일 맥락" | **STATUS wins** for all three. `AD` does not validate context `to` values (caller passes `allowed`). `AD.says('context', to)` returns `to`; the settings learn card renders labels with `DN.statusCore.contextLabel(profile, to)`. ADAPT test 25 is rewritten with `to:'work'` and 2 corrections ⇒ strong. |
| C10 | Settings card order | FEATURES: AI→근무→연결→데이터→화면; ADAPT inserts 배운 것 after AI; STATUS inserts 현재 상태 after 근무; GOOGLE replaces the static 캘린더 card | **AI 처리 (`#set-ai`) → Daynote가 배운 것 (`#set-learn`) → 근무 시간 (`#set-work`) → 현재 상태 (`#set-status`) → 연결 (`#set-conn`: 메일 사용 중 / 체험 / 준비 중) → 캘린더 (`#set-gcal`, Google card) → 데이터 (`#set-data`) → 화면 (`#set-view`)**. In `PROVIDERS` the `gcal` entry is `status:'ready'` (so it is not listed under 준비 중). |
| C11 | Settings re-render policy | FEATURES: skip for capture/chat/today; STATUS adds status; GOOGLE: gcal/gcal-settings repaint only the card | §5.9 card registry + one `onChange` rule (skip list `capture chat today status ai gcal gcal-settings`; cards get first chance). |
| C12 | Undo exclusions | GOOGLE D11 keeps `gcal`; STATUS keeps `presence`; ADAPT keeps `learned` **undoable** | `KEEP_ON_UNDO = ['prefs','presence','gcal']`; these three are also nulled out of the snapshot clone. `learned` stays in snapshots (undo reverts learning together with the correction). |
| C13 | Date chip path | chat.js writes directly (today); ADAPT routes through `P.captureSetDate` | ADAPT wins: chat → `DN.capture.setDate(noteId, ref, ymd, time)` → `P.captureSetDate`. |
| C14 | Footer of the capture card | FEATURES command footers; ADAPT learned/taught footers; STATUS hint chip | Precedence in §4.3 W2-capture (command card ⇒ FEATURES table; else learned/taught rules; hint line always appended under rows). |
| C15 | Who learns from commands | ADAPT §7.5.6 optional | **On**: `F.createForced` calls `AD.learn({type:'kind', text: note.body, to: cmd.kind, ref: note.id, source:'command'})` when `AD.enabled`. |
| C16 | AI context on forced items | not covered by FEATURES | `F.refineForced` may set `task.context`/`contextSource:'ai'` from the single AI item only when `task.contextSource !== 'user'` and `task.context == null`; sets `atMode`/`'ai'` only when `task.atMode == null`. |
| C17 | `#태그` in commands | STATUS §6.5 (capture only) | Also applied by `F.rulesItem` for `/할일` text (`ST.extractContextTag`), giving `context`, `contextSource:'user'`. |
| C18 | Schedule dialog footer copy | GOOGLE §9.3 vs FEATURES §3.2 | FEATURES wording: `빈 시간은 Daynote 캘린더 기준이에요. 실제 여유는 직접 확인해 주세요.`; when `M.externalItems(S.state).length > 0`: `빈 시간은 Daynote 캘린더와 Google 캘린더 기준이에요. 실제 여유는 직접 확인해 주세요.` |
| C19 | `findFreeSlot` | GOOGLE "inherits conflictsFor"; FEATURES slots wrapper | FEATURES wrapper (slots-based, includes Google busy via C2). Constants `DAY_START/DAY_END` removed. |
| C20 | `nextCard` status line text | STATUS "퇴근 · 내 시간 기준" with label already containing "· 시간표 기준" | Stored `m.statusLabel = sv.label + (sv.guessed ? ' · 시간표 기준' : '')`; rendered as `div.meta.next-status` with text `'지금: ' + m.statusLabel`. |
| C21 | Status reason sentences in recommend | STATUS §8.2 examples (some need labels recommend does not know) | §3.7: sentences for when/phone/breakthrough/up are **pre-built by `ST.view`** (`levels[id].sentence`); recommend builds only the overlay-remaining and primary-down sentences; at most one status sentence, unshifted to position 0. |
| C22 | Context sent to AI before activation | STATUS silent | `input.contexts` is **always** sent (labels+hints only); `input.presenceNow` only when status is active; `presence.log` never. |
| C23 | Context UI before activation | STATUS hides card chips before activation, silent elsewhere | Every context/atMode UI (capture-card chip, today chips, detail rows, project select) renders **only when `DN.status.isActive()`** (P-1). |
| C24 | Learn-card rerender | ADAPT: × uses a labeled mutate so settings re-renders | `DN.capture.forgetRule` uses `{source:'learn'}`; `'learn'` is **not** in the settings skip list ⇒ full re-render. |
| C25 | FEATURES "status 팀이 정책을 넣는 자리" (exclusion step) | STATUS uses `levelRank` + `hide` exclusion | STATUS mechanism is the policy. |
| C26 | Rec panel empty states | FEATURES lacks `quiet`/`all_hidden` | Add: quiet → `‘{label}’ 중이라 추천은 쉬어요. 끝나면 다시 골라 드릴게요.`; all_hidden → `지금(‘{label}’)은 할 만한 일이 없어요. 쉬어도 돼요.` + `[접어 둔 일 보기]` → `DN.views.today.showHidden()`. |
| C27 | Calendar per-day blocks | GOOGLE `calendarItems` uses overlap semantics; calendar draws on start day only | `placeBlocks` uses `M.calendarItems(S.state, dayStartIso, dayEndIso, {includeAllDay:false}).filter(x => D.ymd(x.start) === key)`. Lane numbers go in a local map (no `b.__lane` writes). |
| C28 | Status-change cards from chip/menu when home not visible | STATUS §10.2 | `DN.status.set` posts a card only when `DN.app.current().view === 'today'`; otherwise only a toast. |
| C29 | Who edits `renderer/index.html` | GOOGLE §13 track D, FEATURES §1.1, STATUS §21, ADAPT §7.7.3 each add tags | **Only the orchestrator**, once, at the gate (§4.2), with the merged order. |
| C30 | Start-up hooks | STATUS §15 puts `settle` in `app.js whenReady`; ADAPT §7.7.3 puts `bootstrap/compact` in `app.js`/`assistant.js` | `settle` runs from `statusui.js`'s own `S.whenReady` (and `DN.status.tick` from the app's 60 s tick); `bootstrap/compact` run from `renderer/capture.js`'s own `S.whenReady`; Google sync start from `gcalsync.js`'s own `S.whenReady`. `app.js` only calls `DN.status.tick`. |
| C31 | `looksIdle` workHours bug | fixed in FEATURES §3.3, GOOGLE §8.3, STATUS §8.4 | Fixed once by W1-slots-recommend (§3.8). |
| C32 | FEATURES `/상태` "준비 중" fallback, `statusCommand` text messages | STATUS ships in the same release | Keep the guard (partial merges), but the real path is `DN.status.setFromCommand` (C6). |

---

## 2. Unified state schema v4 (owner of `model.js`/`store.js`: **W1-model**)

### 2.1 `emptyState()` — new top-level keys (exact literals)
```js
presence: { v: 1, activatedAt: null, current: null, shown: [], parked: [], log: [],
            hints: { day: null, used: 0, overtimeDismiss: 0, presetSeen: {}, presetOffered: {} } },
learned:  { v: 1, rules: [], metrics: { learned: 0, applied: 0, reverted: 0, hinted: 0 }, bootstrappedAt: null, compactedAt: null },
gcal:     { v: 1, accountId: null, settings: { exportEnabled: true, exportWork: true, exportTitles: true },
            calendars: [], exportCalendarId: null, events: [], links: {}, gens: {}, outbox: [],
            backoffUntil: null, lastSyncAt: null, lastError: null }
```
No other new top-level keys (in particular **no** `externalEvents`, `statusHistory`, `contextLearn`).

### 2.2 `normalize(raw)` — migration rules (after the existing generic loop and before `tasks.map(normalizeTask)`)
```js
var E = emptyState();
// presence
if (!s.presence || typeof s.presence !== 'object') s.presence = E.presence;
['shown', 'parked', 'log'].forEach(function (k) { if (!Array.isArray(s.presence[k])) s.presence[k] = []; });
s.presence.hints = Object.assign({}, E.presence.hints, (s.presence.hints && typeof s.presence.hints === 'object') ? s.presence.hints : {});
// learned
if (!Array.isArray(s.learned.rules)) s.learned.rules = [];
s.learned.metrics = Object.assign({}, E.learned.metrics, (s.learned.metrics && typeof s.learned.metrics === 'object') ? s.learned.metrics : {});
// gcal
s.gcal.settings = Object.assign({}, E.gcal.settings, (s.gcal.settings && typeof s.gcal.settings === 'object') ? s.gcal.settings : {});
['calendars', 'events', 'outbox'].forEach(function (k) { if (!Array.isArray(s.gcal[k])) s.gcal[k] = []; });
['links', 'gens'].forEach(function (k) { if (!s.gcal[k] || typeof s.gcal[k] !== 'object' || Array.isArray(s.gcal[k])) s.gcal[k] = {}; });
s.version = SCHEMA_VERSION;   // 4
```
`ST.ensure`, `AD.ensure`, `G.ensure` remain idempotent defensive helpers (they must work on a state produced by an *old* `emptyState()` too).

### 2.3 Task fields (`normalizeTask` defaults)
| field | default | values | writer |
|---|---|---|---|
| `context` | `null` | `null` \| `'work'\|'home'\|'errand'\|'personal'\|'family'\|'study'\|'u_xxxxxx'` | user (`ST.setTaskContext`), AI (`applySelections`, `refineForced`) |
| `contextSource` | `null` | `null \| 'user' \| 'ai'` (`'user'`+`null` = pinned "정하지 않음") | same |
| `atMode` | `null` | `null \| 'work'\|'off'\|'out'\|'pause'\|'rest'` | user, AI, rule |
| `atModeSource` | `null` | `null \| 'user' \| 'ai' \| 'rule'` | same |

`M.updateTask(state, id, patch, now)` new rule (before applying the patch): if `'title' in patch` and `patch.title !== t.title` and `t.contextSource === 'ai'` and `!('contextSource' in patch)` ⇒ `patch.context = null; patch.contextSource = null`.

`proposals.js` `TASK_KEEP` += `context, contextSource, atMode, atModeSource` (W2-ai).

### 2.4 Project field
`project.context: null | ctxId` (user only). `M.addProject` copies `fields.context || null` into the new project (default `null`). Readers use `p.context || null`.

### 2.5 Note fields (no normalizer; read defensively)
| field | shape | set by |
|---|---|---|
| `note.capture.command` | `{ name, kind, token, raw, base, refined: [] }` | `renderer/capture.js` + `F.createForced` / `F.refineForced` (FEATURES §6.5–6.7) |
| `note.capture.statusLine` | `null \| string (≤80)` | `DN.capture.submit(…, {statusLine})` (STATUS §3.4) |
| `note.capture.statusHint` | `null \| { from:'rule'\|'ai', role, id, label, quote, at, resolved?: 'applied'\|'dismissed' }` | `DN.capture.submit(…, {statusHint})`, `P.applyCapture` (AI) ; resolved by `DN.status.hintChip` |
| `note.capture.learned` | `[{ type, to, from, ruleIds:[], phrase, refId?, at }]` | `P.applyLearned` |
| `note.capture.taught` | `true` | `learnFrom` in proposals |

### 2.6 Other entities
- aiRun: `hints: [ruleId]` (passed to `P.startRun`, stored by its `Object.assign`).
- Blocks: **no new fields**. `durationGuessed` reused by the schedule dialog. `__lane` must no longer be written (W2-schedule).
- Chat messages (new kinds): `{kind:'help'}`; `{kind:'status', to:{id,label}, from:{id,label,guessed}|null, source, at, text?, pure, noteId?, parked:[], resume:[]}`; `{kind:'status-pick'}`; `{kind:'status-offer', preset}`; `next` messages gain `statusLabel: string|null`; `text` messages may carry `actions: ['showHidden']`.

### 2.7 Prefs keys (no schema bump needed; always `S.mutate(null, fn, {silent:true})`)
| key | shape | default (absent) | writer |
|---|---|---|---|
| `workHours` | `{ start:'HH:MM', end:'HH:MM', days:[0..6] }` | Mon–Fri 09:00–18:00 (`SL.DEFAULT_WORK_HOURS`); deleted when equal to default | W2-settings |
| `statusProfile` | STATUS §3.2 object | office preset | W2-status (settings-status.js) |
| `learning` | `false` or absent (= on) | on | W2-settings (settings-learn.js) |

### 2.8 Undo (`renderer/store.js`)
```js
var KEEP_ON_UNDO = ['prefs', 'presence', 'gcal'];
// mutate(): when label is truthy, take the snapshot WITHOUT these keys:
var before = null;
if (label) { var keep = {}; KEEP_ON_UNDO.forEach(function (k) { keep[k] = state[k]; state[k] = null; });
             try { before = clone(state); } finally { KEEP_ON_UNDO.forEach(function (k) { state[k] = keep[k]; }); } }
// undo(): restore snapshot, then put back the CURRENT values of KEEP_ON_UNDO keys (if defined)
```

### 2.9 `clearSample`
Adds `state.learned.rules = state.learned.rules.filter(r => !r.sample)` (guard missing `learned`). Does **not** touch `presence` or `gcal`.

### 2.10 Secrets
Tokens, client secrets, auth codes never enter `state`, chat, logs or IPC results. Backup export (`JSON.stringify(S.state)`) contains gcal event titles/times only.

### 2.11 Load order (final `renderer/index.html` core block — see §4.2)
`dates, model, slots, adapt, statusWords, status, recommend, suggest, weekly, split, gcal, commands, ai/organizeNote, ai/validate, ai/proposals, ai/capture, ai/forced, ai/assist, ai/fake`.

### 2.12 Global names
`DN.slots`, `DN.adapt`, `DN.statusWords`, `DN.statusCore` (core `status.js`; the one exception to file-name = global-name), `DN.gcal`, `DN.commands`, `DN.aiForced`; renderer: `DN.status` (statusui.js), `DN.slash`, `DN.gcalSync`, `DN.views.recPanel`, `DN.views.extEvent`, `DN.settingsCards`.

### 2.13 `S.mutate` sources and labels (registry)
- New sources: `'status'` (presence changes, status cards), `'gcal'` (sync engine), `'gcal-settings'` (Google card prefs-like writes), `'learn'` (rule deletion), `'settings'` (generic settings writes). Existing: `today chat capture detail notes ai review weekly projects`.
- New undo labels (exact): `'맥락 바꾸기'`, `'언제 할지 바꾸기'`, `'프로젝트 맥락 바꾸기'`, `'AI 다듬기'`, `'배운 대로 정리'`, `'배운 것 지우기'`, `'배운 것 모두 지우기'`, `'Google에서 지운 일정 반영'`. Reused: `'입력 저장'`, `'AI 분류'`, `'상태 변경'` ([멈춰 두기]), `'일정에 배치'`, `'일정 변경'`, `'마감일 바꾸기'`, `'마감일 지우기'`, `'일정 옮기기'`, `'할 일 순서 바꾸기'`.
- `detail.js` onChange regex becomes `/상태|단계|선행|미루기|소요 시간 확인|마감일|맥락|언제 할지/`.

---

## 3. Module APIs (exports are binding; internals follow the cited design sections)

### 3.1 `src/core/slots.js` — `DN.slots` (`SL`), deps `dates`, `model` (W1-slots-recommend)
Implements FEATURES §2 with C2.
```js
DEFAULT_WORK_HOURS = { start:'09:00', end:'18:00', days:[1,2,3,4,5] }; DAY_WINDOW = { start:'07:00', end:'23:00' };
STEP_MIN = 15; SEARCH_DAYS = 14; IMMINENT_MIN = 15;
parseHm(s) → int(0..1439) | null
normalizeWorkHours(wh) → { start, end, days }
validateWorkHours(input) → { ok:true, value } | { ok:false, error:'invalid_time'|'end_before_start'|'too_short'|'no_days', message }
describeWorkHours(wh) → '월–금 09:00–18:00'
isWorkingDay(date, wh) → bool;  workWindow(date, wh) → { start:Date, end:Date } | null;  isWorkingTime(now, wh) → bool
roundUp15(date) → Date
collectBusy(state, from, to, opts) → Busy[]      // opts { ignoreId?, external?: ExternalEvent[], includeDoneWork?: bool(default true) }
//   Busy = { id, start:ms, end:ms, title, source:'block'|'external', kind:'work'|'event'|'external', taskId, done, provider?:'google' }
//   external part = M.externalItems(state, from, to) filtered busy && !allDay (provider 'google')  +  opts.external with FEATURES §2.3 rule 2 exclusions
conflicts(busy, start, end) → Busy[];  merge(busy) → [{start,end}]
findSlot(busy, opts) → { found:true, start:Date, end:Date, mode, sameDay, dayOffset } | { found:false, reason:'too_long'|'no_slot'|'bad_input', mode }
pickMode(from, wh) → 'work'|'day';  defaultMode(now, wh) → 'work'|'day'
freeNow(state, now, opts) → { free, reason:null|'in_progress'|'imminent'|'status', current, next, freeMinutes, workTime }   // opts { workHours, external, status, imminentMinutes=15 }
```
If `M.externalItems` is missing (pre-merge), external part = `[]`.

### 3.2 `src/core/commands.js` — `DN.commands` (`CMD`), no deps (W1-commands)
FEATURES §6.1–6.2: `COMMANDS, get(name), parse(text) → {command, kind, args, raw, token, unknown, escaped}, match(query) → [{name, kind, token, alt, desc, example, icon, noArgs, exact}], suggestFor(token) → name|null, _jamo(s)`.

### 3.3 `src/core/dates.js` additions (W1-commands)
`parseDuration(text) → {ok:true, minutes} | {ok:false, error:'empty'|'invalid'|'too_short'|'too_long', message}`, `DURATION_MIN = 5`, `DURATION_MAX = 720` (FEATURES §5.5). Existing exports unchanged.

### 3.4 `src/core/adapt.js` — `DN.adapt` (`AD`), deps `dates`, `model` (W1-adapt)
ADAPT §7.4 exactly (exports listed in §7.4.5: `TYPES, LIMITS, DATE_WORDS, MONTH_WORDS, ensure, enabled, normKey, tokens, phrases, learn, suggest, hints, penalize, weaken, get, forget, forgetRef, reset, compact, list, count, encodeDate, resolveDate, says, bootstrap`), with C9: `TYPES.context = { halfLife: 60, roles: ['exact','part'], strongN: 2, strongNPart: 2, toAi: false }`.

### 3.5 `src/core/statusWords.js` — `DN.statusWords` (`SW`), no deps (W1-status)
Pure data used only by `status.js` and tests: `PHRASES` (STATUS §5.6 incl. tiers/gates/labels), `PRESET_WORDS` (§12.3), `FILLERS`, `TAILS`, `DURATION_RE` sources, `BLOCK_ANYWHERE`, `BLOCK_AFTER`, `BLOCK_BEFORE_OTHERS` (§5.4), `STATUSES` (§2.2 table), `CONTEXTS` (§2.3), `CONTEXT_WORDS`, `CONTEXT_EXCLUDE`, `ERRAND_ENDINGS` (§6.2–6.3), `ATMODE_PHRASES` (§2.4), `PHONE_WORDS` (§2.5), `PRESETS` (§12.1–12.2; office & freelance `stage:'v1'`, others `stage:'v1.1'`, creator `'v2'`), `PRESET_SIGNALS` (§12.4). Renderer code never reads `SW` directly (use `ST.*`).

### 3.6 `src/core/status.js` — `DN.statusCore` (`ST`), deps `dates`, `model`, `statusWords`; optional `slots`, `adapt` (W1-status)
Optional deps: Node `try { require('./slots') } catch (e) { null }`, browser `window.Daynote.slots || null` (same for adapt). Without slots use an internal `normalizeWorkHours` with FEATURES §2.2 rules. Without adapt (or `prefs.learning===false`) skip learned steps.

Implements STATUS §2–§7, §9.1, §12, §13 (pure parts). **Exports (binding):**
```js
ensure(state) → state.presence
isActive(state, profile) → bool                          // profile.enabled && !!presence.activatedAt
profile(prefs) → Profile                                 // memoized; STATUS §3.5 (+ contextIds, menu, matrix, rawMatrix, schedule, hash)
presetList() → [{ id, label, desc, stage }]
effective(state, profile, now) → Eff | null
guess(profile, now) → { id, label, segment:{ start:ISO, end:ISO } }
timeline(profile, from, days) → [{ id, start:ISO, end:ISO }]
view(state, profile, now) → StatusView | null           // pure; see shape below
current(state, profile, now) → null | { id, label, busy, until, guessed }
detect(text, ctx) → Detection | null                     // ctx { profile, eff, current, now }
parseStatusArgs(args, profile, eff, now) → { cmd:'picker'|'set'|'guess'|'revert'|'unknown', id?, label?, until?, minutes? }
resolveRole(role, info, ctx) → null | { id, label, until?, minutes? }   // info { matched?, words? }, ctx as detect
extractAtMode(title) → null | { mode, phrase, title };  findAtMode(text) → mode|null;  atModePhrase(mode) → '퇴근하고'|'출근하면'|'나가는 김에'|'쉬는 시간에'|'쉬는 날에'
extractContextTag(text, profile) → null | { ctx, tag, text }        // '#집안일 빨래' → { ctx:'home', tag:'#집안일', text:'빨래' }; '# 회의록' is not a tag
presetSignal(text, profile) → presetId|null;  guessPreset(state) → presetId|null
onPhone(task) → bool
ruleContext(text, profile) → null | { ctx, score, margin, evidence, scores }
contextOf(state, task, profile, now) → { value, source, evidence, ruleIds? }
contextLabel(profile, ctxId) → string                   // null|'none' → '정하지 않음'
contextHintsForAi(profile) → [{ id, label, hint }]      // hint = 6 representative words joined by '·'
setTaskContext(state, taskId, ctxId, profile, now) → { task, learned:'none'|'hint'|'strong' }   // STATUS §6.5 (AD.learn/penalize/count inside)
setTaskAtMode(state, taskId, mode, now) → task           // atModeSource 'user'; mode null = 상관없음
levelOf(state, task, ctxR, eff, profile, now) → { level, reason, breakthrough }
nextActiveStart(profile, ctxId, eff, now) → Date
applyStatusPolicy(state, tasks, eff, profile, now) → { visible, demoted, hidden, levels, reasons }
partitionToday(state, open, view, opts) → Partition      // opts { rankedIds }
joinOrder(groups, key, newIds) → [taskId]                // STATUS §9.3 "끌기 저장"; groups = { when, upNormal, down } arrays of ids, key ∈ 'when'|'upNormal'|'down'
hiddenSummaryText(summary, profile, opts) → string       // '업무 할 일 5개 숨김' / '업무 할 일 4개 · 공부 1개 숨김' / '… (하던 일 1)'; opts.short → '업무 5 숨김'
isHidden(view, taskId) → bool
setStatus(state, target, opts, profile, now) → Transition;  revert(state, profile, now) → Transition|null
toGuess(state, now);  wake(state, now) → bool;  settle(state, profile, now) → bool;  markShown(state, taskId);  confirmGuess(state, profile, now) → Transition
budgetOk(state, profile, now) → bool;  useBudget(state, profile, now)
overtimeDue(state, profile, now) → bool;  dismissOvertime(state, profile, now)
notePresetSignal(state, presetId, now);  presetOfferDue(state, profile, now) → presetId|null;  markPresetOffered(state, presetId, now)
```
Shapes (STATUS §3.5 with additions in **bold**):
- `Detection = { tier:'sure'|'maybe', role, id, label, until, minutes, pure, statusLine, rest, matched, same }`. Special words (`idle`, `reset`, `wake`) return `tier:'sure', pure:true`.
- `Transition = { noop, extended?, from:{id,label,guessed}|null, to:{id,label}, parked:[], resume:[], at }`.
- `StatusView = { active:true, id, label, category, guessed, since, overlay:{id,label,until,rec}|null, rec:'normal'|'short'|'none', busy, nudges, remainMinutes, offHours, workWindow:{start,end}|null, levels:{ [taskId]: { level, reason, ctx, ctxSource, **ctxLabel**, evidence, breakthrough:{dueAt,soon}|null, **sentence**: string|null } }, hiddenIds, anchored, summary:{ hidden, byCtx, parked } }`.
- `levels[id].sentence` (built by `view`, C21): reason `when` → `‘{atModePhrase}’ 하기로 한 일이에요.`; `phone` → `이동 중에 폰으로 할 수 있는 일이에요.`; breakthrough soon → `‘{ctxLabel}’ 할 일이지만 {HH:MM} 마감이라 골랐어요.`; breakthrough (down) → `‘{ctxLabel}’ 할 일이지만 {relDay HH:MM} 마감이라 남겨 뒀어요.`; level `up` by policy on explicit status → `지금은 ‘{view.label}’이라 ‘{ctxLabel}’ 일을 먼저 골랐어요.`; otherwise `null`.
- `Partition = { when, up, normal, extra, down, hidden, summary:{hidden, byCtx, parked, guessedDown}|null }`; view null ⇒ `{ when:[], up:[], normal: open ids, extra:[], down:[], hidden:[], summary:null }`.

### 3.7 `src/core/recommend.js` extension (W1-slots-recommend)
Deps become `dates, model, slots`. `opts = { now, availableMinutes, skipIds, workHours, status?, statusView? }`.
1. `var wh = SL.normalizeWorkHours(opts.workHours); var win = SL.workWindow(now, wh);` offHours = `sv ? sv.offHours : !SL.isWorkingTime(now, wh)`; cap end = `sv ? (sv.workWindow ? new Date(sv.workWindow.end) : null) : (win ? win.end : null)`. `ctx.workHours = wh`.
2. T: user (>0) → else `sv && sv.rec === 'none'` → `{availableMinutes:null, source:'none'}` + quiet → else `sv && sv.remainMinutes != null` → `{availableMinutes: sv.remainMinutes, source:'status', until:'status_end'}` → else calendar rule (not busy, not offHours, next block today; cap by end when non-null) → else none.
3. `calendarContext(state, now)`: `live` also includes `M.externalItems(state, nowIso, eodIso)` with `busy && !allDay` (guard `M.externalItems`). `blockTitle` uses `b.title` for items without taskId.
4. `ctx.status` per C8.
5. With `sv` only: exclusion `sv.levels[id].level === 'hide'` ⇒ `excluded.hidden++`, `hiddenIds.push(id)`, counts in `openCount`; items gain `levelRank` (`up:0, normal:1, down:2`, missing level ⇒ 1), `level`, `ctx`; compare keys `['levelRank','fitGroup','urgency','cont','manual','prio']` then the existing tail; `tooLong` sorted by `levelRank` first; result gains `hiddenIds`; `empty` order `quiet → no_tasks → time_short → all_hidden → all_excluded → all_skipped`; `quiet` applies whenever `sv.rec === 'none'` (even with a user T) and keeps `ranked`/`tooLong` computed, with `primary:null`, `alternatives:[]`.
6. Status reason (max one, unshifted to index 0 of `reasons`): `lv.sentence` if non-null; else if `ctx.source === 'status'` ⇒ `‘{sv.overlay ? sv.overlay.label : sv.label}’ 남은 시간({remainMinutes}분) 안에 끝나는 일을 골랐어요.`; after sorting, if `primary.level === 'down'` and primary has no status sentence ⇒ `‘{sv.label}’ 상태라 뒤로 둔 일이지만 지금 할 수 있는 다른 일이 없어요.`. If `sv.guessed` and a status sentence was added, append ` (시간표 기준)`.
7. Without `sv` the output keys are exactly today's keys plus `context.status`.

### 3.8 `src/core/ai/assist.js` extension (W1-slots-recommend)
`looksIdle(state, now, sv)` → `R.recommend(state, { now, workHours: state.prefs && state.prefs.workHours, statusView: sv || null })`; `elaborateCandidates(state, now, sv)` and `pendingBreakdowns(state, now, sv)` drop tasks whose `sv.levels[id].level` is `'hide'` or `'down'`; `nextNudge(state, ctx)` passes `ctx.statusView` to all three. Signatures stay backward compatible.

### 3.9 `src/core/gcal.js` — `DN.gcal` (`G`), deps `dates`, `model` (W1-gcal-core)
GOOGLE §8.1 exports exactly, plus:
```js
blockSyncState(state, blockId, ctx) → null | 'synced' | 'pending' | 'failed' | 'uncertain'
//  block missing or !exportEnabled → null; block.timeUncertain → 'uncertain'; outbox entry 'op:'+blockId with lastError → 'failed';
//  outbox entry → 'pending'; links[blockId] → 'synced'; exportable(block) → 'pending'; else null
```
`emptyGcal()` must deep-equal `M.emptyState().gcal` (§2.1).

### 3.10 `src/core/model.js` additions (W1-model)
```js
externalItems(state, fromIso?, toIso?) → ExtItem[]      // GOOGLE §6.5 shape; overlap (end > from && start < to); sorted by start, id
//  ExtItem.tentative = ev.status === 'tentative' || ev.response === 'tentative' || ev.response === 'needsAction'
//  color/calendarName from state.gcal.calendars by calendarId (null/'' if missing)
calendarItems(state, fromIso, toIso, opts?) → (Block|ExtItem)[]   // opts { busyOnly?, includeAllDay?=true }; blocks exclude deleted-task blocks
conflictsFor(state, startIso, endIso, ignoreId, opts?) → (Block|ExtItem)[]   // + busy && !allDay ExtItems (id !== ignoreId); opts.blocksOnly → old behaviour
isExternal(item) → bool
```

### 3.11 W2-ai core changes
- **`validate.js`** new exports: `relativeAt(text, now) → {date, time, text, index}|null`, `relativeMinutes(text) → {minutes, text, index}|null`, `timeMatch(text) → {text, index, candidates}|null`, `durationSpan(text, startTime) → {minutes, text, index}|null` (`checkDuration` uses `.minutes`; results unchanged). `validateOrganizeNote` additionally: per task item `item.context` (null unless id ∈ `ST.profile(state.prefs).contextIds`), `item.atMode = {mode, phrase}|null` (accepted only when `ST.findAtMode(quote) === do_in`), and top-level `presence: {role, quote, line}|null` (dropped if role ∉ enum, `role==='none'`, quote not `locate`d, or `note.capture.statusLine` set). Deps add `../status`.
- **`capture.js`**: `PROMPT_VERSION = 'capture.v7'`; SYSTEM += J (ADAPT §7.6.1) then K, L, M (STATUS §14); SCHEMA: `tasks[].context: string|null`, `tasks[].do_in: enum`, top-level `presence: {role: enum, quote: string|null}` (all required, `additionalProperties:false`); `buildInput(note, opts)` adds `learned`, `contexts`, `presenceNow`, `statusLine`; `userText(input)` appends inside `<context>` (before `</context>`, in this order): `맥락 목록: id=라벨(hint), …` (if contexts), `지금 상태: …` (if presenceNow), `상태 보고 줄(앱이 이미 처리함 — 할 일로 만들지 말 것): ‘…’` (if statusLine), then the ADAPT learned block.
- **`proposals.js`**: deps `(D, M, SG, V, AD, ST)`. ADAPT §7.5 entirely (`learnFrom`, hooks, `captureSetDate`, `planLearned`, `applyLearned`, `captureSetProject(state, noteId, projectId, now, opts)`); STATUS §3.3 `TASK_KEEP`; STATUS §14 `applySelections` (`#tag` → user context and strip tag; else `payload.context` → `'ai'`; `payload.atMode` → `'ai'`; leftover leading phrase → `ST.extractAtMode` → `'rule'`), `mergeOrganizeRun` copies `item.context`/`item.atMode` into `payload`, `applyCapture` statusHint from validated `presence` (only if no statusLine/statusHint, `ST.isActive`, `ST.budgetOk`; then `ST.useBudget`; never changes presence). New exports: `captureSetDate, planLearned, applyLearned, guessStart, matchProject`.
- **`fake.js`**: ADAPT §7.6.3 and STATUS §14 fake rules; emits `tasks[].context:null`, `tasks[].do_in`, `presence:{role:'none',quote:null}` only for `purpose==='capture'`.
- **`forced.js`** (new) — `DN.aiForced` (`F`), deps `dates, model, suggest, ai/validate, ai/proposals, status, adapt`:
  ```js
  rulesItem(text, kind, now, opts) → task: { kind:'task', title, memo, dueDate, dueTime, at:{date,time}|null, atMode:{mode,phrase}|null, context:{ctx,tag}|null }
                                   | event: { kind:'event', title, date, time, timeUncertain, durationMinutes, durationGuessed }
                                   // opts { profile } (for #tag); FEATURES §6.6 rules
  createForced(state, note, now) → { created:[{kind,id}] }     // FEATURES §6.5 table + base; atMode 'rule', #tag 'user'; AD.learn command label (C15)
  pickAiItem(validated) → item | null                           // FEATURES D14
  refineForced(state, { note, run, validated, output }, now) → note.capture | null   // FEATURES §6.7 + C16
  REFINED_LABEL = { title:'제목', dueDate:'날짜', date:'날짜', dueTime:'시각', time:'시각', at:'시각', durationMinutes:'길이', location:'장소', projectId:'프로젝트' }
  ```

### 3.12 Services (W1-google-services; main-process CommonJS, no `require('electron')`)
- `services/keystore.js`: GOOGLE §8.4 (`loadDotEnv(dir, out?)`, `createSecretStore(userDataDir, safeStorage, fileName) → {read, write, clear, exists}`); `create` unchanged.
- `services/google-auth.js`: GOOGLE §8.5 (`create, SCOPES, ENDPOINTS, makePkce, buildAuthUrl, parseIdToken, parseClientInput, captureEnvClient, redact`; `GoogleStatus` shape).
- `services/gcal.js`: GOOGLE §8.6 (`create, classifyHttpError, sanitizeBody, EVENT_FIELDS`).

### 3.13 How renderer code calls core (summary)
| Renderer caller | Core calls |
|---|---|
| `renderer/capture.js` | `F.createForced`, `F.refineForced`, `P.applyCapture`, `P.applyLearned`, `P.planLearned`, `P.captureSetDate`, `P.captureSetProject(…, now())`, `AD.hints/count/forget/bootstrap/compact`, `C.buildInput` |
| `renderer/assistant.js`, `app.js` | `CMD.parse`, `R.recommend(…, {statusView})`, `AS.pendingBreakdowns/elaborateCandidates/nextNudge(…, sv)` |
| `renderer/statusui.js` | all `ST.*` mutators inside `S.mutate(null, …, {source:'status'})`; `ST.setTaskContext`/`setTaskAtMode` inside labeled mutates |
| `views/today.js` | `ST.partitionToday`, `ST.joinOrder`, `ST.hiddenSummaryText`, `R.recommend`, `M.calendarItems` |
| `views/recpanel.js` | `SL.freeNow`, `SL.normalizeWorkHours/isWorkingTime`, `R.recommend`, `D.parseDuration` |
| `views/schedule.js` | `SL.collectBusy/conflicts/findSlot/pickMode/defaultMode/normalizeWorkHours/describeWorkHours`, `G.blockSyncState`, `M.externalItems` |
| `views/calendar.js` | `M.calendarItems`, `M.conflictsFor` |
| `renderer/gcalsync.js` | all `G.*` planners/mutators inside `S.mutate(null, …, {source:'gcal', silent: changed===0})`; `G.applyRemoteDeletes` in labeled mutate |
| `views/settings*.js` | `SL.validateWorkHours/describeWorkHours`, `AD.list/reset/enabled`, `ST.profile/presetList/contextLabel` |

---

## 4. Work packages

### 4.1 WAVE 1 — core (7 packages, fully parallel, Node tests only)

---
#### W1-model
**Owns:** `src/core/model.js`, `renderer/store.js`, `renderer/sample.js`, `test/model.test.js`, `test/store.test.js`, `test/sample.test.js`.
**Do:**
1. §2.1–§2.4, §2.9, §3.10 in `model.js` (SCHEMA 4 + comment, emptyState, normalize rules, normalizeTask fields, `updateTask` AI-context rule, `addProject` context default, `clearSample`, `externalItems`, `calendarItems`, `conflictsFor(…, opts)`, `isExternal`; export the four new functions).
2. `store.js`: §2.8 (KEEP_ON_UNDO + snapshot exclusion); browser host stubs `google`/`gcal` exactly as GOOGLE §8.9 (reason `'Google 캘린더 연결은 데스크톱 앱에서만 쓸 수 있어요.'`); browser `ai.status()` not-configured reason → `'브라우저 미리보기에서는 AI를 연결할 수 없어요. 데스크톱 앱에서 키를 넣어 주세요.'` (FEATURES §4.2). No top-level DOM access (store vm test).
3. `sample.js`: STATUS §17 (3 projects `context:'work'`; tasks `빨래 돌리기` no date, `estimateMinutes:15`, created now−1 day; `분리수거` due today; `엄마 생신 선물 주문` due tomorrow; `우유 사기` `atMode:'out'`, `atModeSource:'rule'`, created today; all `sample:true`, all dates relative to `now`). Do not set `presence`.
**Tests:**
- `model.test.js` (+): normalize v3 file → v4 defaults for presence/learned/gcal incl. nested (`gcal.settings` merge keeps stored `exportWork:false`), `SCHEMA_VERSION===4`, `presence` survives normalize round-trip (STATUS #63); normalizeTask adds 4 null fields; `updateTask` clears AI context on title change, keeps user context (STATUS #66); `clearSample` keeps presence & gcal, removes `sample` rules (STATUS #64, ADAPT adapt-capture #18 part); `externalItems` projection fields + tentative + color; `calendarItems` merges & sorts, drops deleted-task blocks, `includeAllDay:false`, `busyOnly`; `conflictsFor` includes busy Google, excludes all-day/transparent(busy:false), `blocksOnly` = old (GOOGLE #15–16); `addProject` default `context:null`.
- `store.test.js` (+): labeled mutate (e.g. `'메모 저장'` adding a note) → then unlabeled changes to `gcal.links` and `presence.current` (plain assignment, no ST) → `undo()` → the note is gone, while `S.state.gcal` and `S.state.presence` are the **same objects** (identity) as just before `undo()` (STATUS #65, GOOGLE §12.5); a labeled mutate followed by `undo()` still keeps `prefs` (existing test); browser `host.google.status()` resolves `available:false`; `host.gcal.list()` resolves `{ok:false, error:{type:'unavailable'}}`; browser `host.ai.status()` reason contains no `GEMINI_API_KEY`.
- `sample.test.js`: update counts for the 4 new tasks; new items carry `sample:true`; projects have `context:'work'`; existing recommend expectation (line ~64) still passes (verify after merge with W1-slots-recommend; if the primary changes, keep the assertion on `source/availableMinutes/fit` only).

---
#### W1-status
**Owns:** `src/core/statusWords.js`, `src/core/status.js`, `test/status-detect.test.js`, `test/status-model.test.js`, `test/status-context.test.js`, `test/status-policy.test.js`, `test/status-presets.test.js`, `test/status-integration.test.js`.
**Do:** §3.5, §3.6 (STATUS §2–§7, §9.1, §12, §13). `view()` builds `ctxLabel` and `sentence` (§3.6). `setStatus` never touches tasks/blocks/notes (I2). All functions take `now`.
**Tests:** STATUS §20.1 (#1–38) → `status-detect`; §20.2 #39–62 → `status-model` (#63–66 belong to W1-model); §20.3 #67–87 → `status-context` (#75 learned steps, #82–87 skip-guard on `AD` and `V4`; #87 uses the store vm harness from `test/store.test.js` copied locally); §20.4 #88–114 → `status-policy`; §20.8 #145–149 → `status-presets`; `status-integration`: #117, #143, #144 (+ #109 with real recommend ordering) skip-guarded on `R_SV` and `V4`. Detection tests are one data table (STATUS §20 rule).

---
#### W1-commands
**Owns:** `src/core/commands.js`, `src/core/dates.js`, `test/commands.test.js`, `test/dates.test.js`.
**Do:** §3.2, §3.3 (FEATURES §6.1–6.2, §5.5). `commands.js` must run with `require` only (no window) and in the quick window (no other globals).
**Tests:** FEATURES §7.2 (#1–24), §7.3 (#1–13).

---
#### W1-adapt
**Owns:** `src/core/adapt.js`, `test/adapt.test.js`.
**Do:** §3.4 (ADAPT §7.4 + C9). `learn` with `ev.source==='manual'` works even when disabled; `suggest` returns null when disabled.
**Tests:** ADAPT §7.10 `adapt.test.js` #1–31, with #25 rewritten per C9 (two different texts '고객사 미팅 준비'/'고객사 견적 회신' → `to:'work'` → `suggest('context','고객사 방문 일정')` strong; `to:'work'` accepted although not a kind target).

---
#### W1-slots-recommend
**Owns:** `src/core/slots.js`, `src/core/recommend.js`, `src/core/ai/assist.js`, `test/slots.test.js`, `test/recommend.test.js`, `test/assist.test.js`.
**Do:** §3.1, §3.7, §3.8. Keep `R.signature`, `checkStartable` (I5), `snoozeOptions` unchanged. Update the header comment of `recommend.js` opts (`workHours, status, statusView`).
**Tests:**
- `slots.test.js`: FEATURES §7.1 #1–36 (external cases use `opts.external`; one extra test with a hand-built `state.gcal.events` item skip-guarded on `V4`), plus "**`SL.conflicts(collectBusy(…))` and `M.conflictsFor` agree** on blocks + Google busy" (skip `V4`).
- `recommend.test.js` (append; existing 18 unchanged): FEATURES §7.5 (Saturday offHours, `days` incl. 6, `opts.status` echo); GOOGLE #17–18 (skip `V4`); STATUS #116, #118–#128 using **hand-built `statusView` objects** (no ST): hide exclusion & `hiddenIds`, `levelRank` first, `all_hidden`, overlay `remainMinutes` → `source:'status'`, `quiet` keeps ranked, explicit work at 20:00 not capped, explicit off offHours, reasons order (sentence first, max one), `tooLong` by levelRank, `context.status` summary.
- `assist.test.js` (append): FEATURES looksIdle passes workHours; STATUS #129–131 with hand-built sv.

---
#### W1-gcal-core
**Owns:** `src/core/gcal.js`, `test/gcal-core.test.js`.
**Do:** §3.9 (GOOGLE §6–§7, §8.1). No network, no clock reads, own `fnv1a`.
**Tests:** GOOGLE §12.2 #1–14, #19–35 (#15–18 moved to W1-model / W1-slots-recommend); #25 & #34 simulate undo by restoring a deep clone of everything except `gcal` (no store dependency); `blockSyncState` table test; `G.emptyGcal()` deep-equals `M.emptyState().gcal` (skip `V4`).

---
#### W1-google-services
**Owns:** `services/keystore.js`, `services/google-auth.js`, `services/gcal.js`, `test/google-auth.test.js`, `test/gcal-service.test.js`.
**Do:** §3.12 (GOOGLE §4, §5, §7.3.6, §7.5, §8.4–§8.6). Existing keystore behaviour and its tests in `test/capture-v3.test.js` stay green (do not edit that file).
**Tests:** GOOGLE §12.3 #1–21, §12.4 #1–13, plus `createSecretStore` (encrypted bytes contain no plaintext, `exists`, `clear`, `write` refuses when encryption unavailable) and `loadDotEnv(dir, out)` fills `out`.

### 4.2 Orchestrator gate between waves (nobody else edits these)
1. Merge all W1 packages; run `npm test` under `TZ=UTC` and `TZ=Asia/Seoul`: **0 fail, 0 skipped**.
2. Rewrite `renderer/index.html` script/link blocks to exactly:
```html
  <link rel="stylesheet" href="vendor/codemirror.min.css">
  <link rel="stylesheet" href="styles.css">
  <link rel="stylesheet" href="editor.css">
  <link rel="stylesheet" href="css/capture.css">
  <link rel="stylesheet" href="css/slash.css">
  <link rel="stylesheet" href="css/today.css">
  <link rel="stylesheet" href="css/status.css">
  <link rel="stylesheet" href="css/settings.css">
  <link rel="stylesheet" href="css/gcal.css">
  <link rel="stylesheet" href="css/schedule.css">
…
  <!-- 업무 규칙 (화면과 분리 — Node 에서 그대로 테스트한다) -->
  <script src="../src/core/dates.js"></script>
  <script src="../src/core/model.js"></script>
  <script src="../src/core/slots.js"></script>
  <script src="../src/core/adapt.js"></script>
  <script src="../src/core/statusWords.js"></script>
  <script src="../src/core/status.js"></script>
  <script src="../src/core/recommend.js"></script>
  <script src="../src/core/suggest.js"></script>
  <script src="../src/core/weekly.js"></script>
  <script src="../src/core/split.js"></script>
  <script src="../src/core/gcal.js"></script>
  <script src="../src/core/commands.js"></script>
  <!-- AI 층 -->
  <script src="../src/core/ai/organizeNote.js"></script>
  <script src="../src/core/ai/validate.js"></script>
  <script src="../src/core/ai/proposals.js"></script>
  <script src="../src/core/ai/capture.js"></script>
  <script src="../src/core/ai/forced.js"></script>
  <script src="../src/core/ai/assist.js"></script>
  <script src="../src/core/ai/fake.js"></script>
  <!-- 마크다운 편집기 (unchanged 3 tags) -->
  <!-- 화면 -->
  <script src="sample.js"></script>
  <script src="store.js"></script>
  <script src="ui.js"></script>
  <script src="app.js"></script>
  <script src="aiflow.js"></script>
  <script src="gcalsync.js"></script>
  <script src="capture.js"></script>
  <script src="assistant.js"></script>
  <script src="slash.js"></script>
  <script src="statusui.js"></script>
  <script src="views/detail.js"></script>
  <script src="views/schedule.js"></script>
  <script src="views/extevent.js"></script>
  <script src="views/recpanel.js"></script>
  <script src="views/chat.js"></script>
  <script src="views/today.js"></script>
  <script src="views/archive.js"></script>
  <script src="views/review.js"></script>
  <script src="views/notes.js"></script>
  <script src="views/tasks.js"></script>
  <script src="views/calendar.js"></script>
  <script src="views/projects.js"></script>
  <script src="views/weekly.js"></script>
  <script src="views/inbox.js"></script>
  <script src="views/settings-learn.js"></script>
  <script src="views/settings-status.js"></script>
  <script src="views/settings-google.js"></script>
  <script src="views/settings.js"></script>
  <script src="palette.js"></script>
```
3. Create placeholders (owner overwrites): JS files `src/core/ai/forced.js`, `renderer/gcalsync.js`, `renderer/slash.js`, `renderer/statusui.js`, `renderer/views/extevent.js`, `renderer/views/recpanel.js`, `renderer/views/settings-learn.js`, `renderer/views/settings-status.js`, `renderer/views/settings-google.js` with content `'use strict';\n// placeholder — owned by <PKG>\n`; CSS files `renderer/css/{capture,slash,today,status,settings,gcal,schedule}.css` with `/* placeholder — owned by <PKG> */`.
4. Sanity: `node scripts/serve.js 5191` + Playwright (`?fakeai`, `timezoneId:'Asia/Seoul'`) loads `/renderer/index.html`, `go()` into every view, **0 console errors**.

### 4.3 WAVE 2 — integration (9 packages, parallel; recommended merge order W2-ai → W2-main → W2-status → others)

---
#### W2-ai
**Owns:** `src/core/ai/validate.js`, `src/core/ai/proposals.js`, `src/core/ai/capture.js`, `src/core/ai/fake.js`, `src/core/ai/forced.js`, `test/forced.test.js`, `test/adapt-capture.test.js`, `test/status-capture.test.js`, and edits (only where required) `test/capture-v3.test.js`, `test/capture.test.js`, `test/ai.test.js`.
**Do:** §3.11. Keep `applyCapture`'s early return for `changedByUser`; `learnFrom` outside the `__holdReveal` try/finally; `applyLearned` never calls `AD.learn`; `captureSetProject` without `now` does not learn (A17).
**Tests:** FEATURES §7.4 #1–37 → `forced.test.js` (+ `#tag` and atMode-prefix cases for `rulesItem`, + command-label learning); ADAPT §7.10 adapt-capture #1–19; STATUS §20.7 #132–141 → `status-capture.test.js`; `capture-v3.test.js:38` → `'capture.v7'`; schema strictness walker (assist.test.js) must pass unchanged.

---
#### W2-capture
**Owns:** `renderer/capture.js`, `renderer/assistant.js`, `renderer/app.js`, `renderer/views/chat.js`, `renderer/views/notes.js`, `renderer/css/capture.css`.

**`renderer/capture.js`**
1. `submit(text, projectId, onDone, opts)`: `opts = opts || {}`. If `opts.command` → FEATURES §6.5 code verbatim (pre-generated id, `inflight[id]=true` when AI configured, `'입력 저장'` mutate with `M.addNote` + `DN.aiForced.createForced(s, n, now())`, then `classify(id, {starting:true})`). Else today's flow with `capture: { status:'pending', at, entryType:null, created:[], statusLine: opts.statusLine || null, statusHint: opts.statusHint || null }`.
2. `classify(noteId, opts)`: guard `inflight[noteId] && !(opts && opts.starting)`. Not configured → `setCapture(no_ai)` then, if `!cmd`, `pl = P.planLearned(S.state, noteId, now(), {hinted:[]})`; if `pl.kind || pl.project || pl.dates.length` → `S.mutate('배운 대로 정리', s => P.applyLearned(s, noteId, now(), {hinted:[]}), {source:'capture'})`. Configured → build input exactly:
   ```js
   var AD = DN.adapt, SU = DN.status, isCmd = !!(sent.capture && sent.capture.command);
   var hints = (!isCmd && AD && AD.enabled(S.state)) ? AD.hints(S.state, sent.body, now(), { projects: M.liveProjects(S.state) }) : [];
   var copts = DN.aiFlow.contextOpts(sent);
   copts.learned = hints;
   copts.contexts = SU && SU.contextsForAi ? SU.contextsForAi() : [];
   copts.presenceNow = SU && SU.presenceForAi ? SU.presenceForAi() : null;
   copts.statusLine = (sent.capture && sent.capture.statusLine) || null;
   var input = C.buildInput(sent, copts);
   var hintIds = [].concat.apply([], hints.map(function (h) { return h.ruleIds || []; }));
   ```
   Set `inflight[noteId] = true` **before** the run-start mutate; run-start passes `hints: hintIds` to `P.startRun` and `if (hints.length) AD.count(s, 'hinted')`. Success: `isCmd` ⇒ `S.mutate('AI 다듬기', …finishRun…; cap = F.refineForced(s, {note: sent, run: r, validated: v, output: res.output}, t))`; else `S.mutate('AI 분류', …finishRun…; cap = P.applyCapture(…); P.applyLearned(s, sent.id, t, {hinted: hintIds}))`. Failure/invalid branches unchanged.
3. `setProject` → `P.captureSetProject(s, noteId, projectId, now())`.
4. New `setDate(noteId, ref, ymd, time)`: label `ref.kind==='task' ? (ymd ? '마감일 바꾸기' : '마감일 지우기') : '일정 옮기기'`, `P.captureSetDate(s, noteId, ref, ymd, time, now())`, source `'capture'`.
5. New `forgetRule(ruleId, label)`: `S.mutate('배운 것 지우기', s => DN.adapt.forget(s, ruleId), {source:'learn'})` then `ui.undoToast('‘' + label + '’ 규칙을 지웠어요.')`.
6. On `DOMContentLoaded` → `S.whenReady`: `S.mutate(null, s => { AD.bootstrap(s, now()); if (!s.learned.compactedAt || now() - new Date(s.learned.compactedAt) > D.DAY) AD.compact(s, now()); }, {silent:true})` (guard `DN.adapt`).
7. Export `setDate`, `forgetRule` on `DN.capture`.

**`renderer/assistant.js`**
1. `send(text, projectId)` (merged FEATURES §6.3 + STATUS §5.1):
   ```
   raw = String(text||''); if (!raw.trim()) return null
   p = DN.commands ? DN.commands.parse(raw) : { command:null, kind:null, args: raw.trim(), raw, token:null, unknown:null, escaped:false }
   help   → post user bubble(raw); postHelp(); return null
   status → post user bubble(raw); statusCommand(p.args, { surface:'chat' }); return null
   kind   → if (!p.args) { post({kind:'text', text:'‘' + p.token + '’ 뒤에 적을 내용이 없어서 아무것도 만들지 않았어요.'}); return null }
            post bubble(raw); note = DN.capture.submit(p.args, projectId, onDone, { command: p }); post capture card; return note
   escaped→ post bubble(raw); note = submit(p.args, projectId, onDone); post capture card; return note     // no status detection
   else (plain or unknown):
            d = (!p.unknown && DN.status && DN.status.detect) ? DN.status.detect(raw) : null
            post bubble(raw)
            if (d && d.tier==='sure' && d.pure) { DN.status.apply(d, {source:'text', surface:'chat', text: raw}); return null }
            if (d && d.tier==='sure') DN.status.apply(d, {source:'text', surface:'chat', text: raw}); else if (DN.status && DN.status.touch) DN.status.touch()
            note = submit(raw, projectId, onDone, { statusLine: d && d.tier==='sure' ? d.statusLine : null,
                                                    statusHint: d && d.tier==='maybe' && DN.status.hintFor ? DN.status.hintFor(d) : null })
            post capture card; if (p.unknown) post unknown-command text (FEATURES §6.12, uses CMD.suggestFor); return note
   ```
   `onDone` = today's large-task notice.
2. `statusCommand(args, opts)` per C6 (FEATURES §6.9 text, STATUS amendments): chat surface → `post({kind:'text', text})`; toast surface → `ui.toast(text, r && r.ok && !r.noop ? {action:{label:'이전 상태로', fn: function(){ DN.status.revert(); }}} : undefined)`; nothing when `r.posted`; empty args + chat + `DN.status.postPicker` → `postPicker()`.
3. `postHelp()` → `post({kind:'help'})`.
4. `next(skip)`: `sv = DN.status && DN.status.view ? DN.status.view(now()) : null`; `R.recommend(S.state, {now, skipIds, workHours: S.state.prefs.workHours, status: DN.status && DN.status.current ? DN.status.current(now()) : null, statusView: sv})`; primary → `post({kind:'next', …, statusLabel: sv ? sv.label + (sv.guessed ? ' · 시간표 기준' : '') : null})`; `quiet` → `post({kind:'text', text:'‘' + sv.label + '’ 중이라 추천은 쉬어요. 끝나면 다시 골라 드릴게요.'})`; `all_hidden` → `post({kind:'text', text:'지금(‘' + sv.label + '’)은 할 만한 일이 없어요. 쉬어도 돼요.', actions:['showHidden']})`; other branches unchanged (`time_short` calls `breakdown(r.tooLong[0] && r.tooLong[0].taskId)`).
5. `pickTaskToBreak()`: `AS.pendingBreakdowns(S.state, now(), sv)` and drop tasks whose sv level is hide/down; `elaborate()` uses `AS.elaborateCandidates(S.state, now(), sv)`.
6. `tryNudge`: after the calendar busy check: `var sv = …view(now()); if (sv && !sv.nudges) return;` and pass `statusView: sv` to `AS.nextNudge`.
7. `startTimer` → after `update`, `DN.status && DN.status.onRestTimer && DN.status.onRestTimer(msgId, end)`; `finishTimer` → before posting "휴식 끝!", `DN.status && DN.status.onRestDone && DN.status.onRestDone(msgId)`.
8. Export `statusCommand`, `postHelp` on `DN.assistant`.

**`renderer/app.js`**
1. `saveQuick(text, projectId, opts)` (FEATURES §6.4 + STATUS §5.1 C; `silent` suppresses toasts):
   ```
   if (!text.trim()) toast('내용을 입력해 주세요.'), return false
   p = DN.commands ? DN.commands.parse(text) : plain
   if (p.kind && !p.args) { toast('‘' + p.token + '’ 뒤에 내용을 적어 주세요.'); return false }
   clear quickDraft (existing silent mutate)
   help   → go('today'); DN.assistant.postHelp(); return true
   status → DN.assistant.statusCommand(p.args, {surface:'toast'}); return true
   kind   → note = DN.capture.submit(p.args, projectId, null, {command:p}); toast(ui.josa(KIND_LABEL[p.kind], '로/으로') + ' 저장했어요.', {action:{label:'오늘에서 보기', fn: go('today')}}); return note
   escaped→ note = submit(p.args, projectId); existing toast; return note
   d = (!p.unknown && DN.status && DN.status.detect) ? DN.status.detect(text) : null
   sure&pure → DN.status.apply(d, {source:'text', surface:'toast', text}); return true          // apply shows '‘퇴근’으로 바꿨어요 · 메모는 만들지 않았어요' + [이전 상태로]
   sure      → DN.status.apply(d, {source:'text', surface:'toast', text, quiet:true}); note = submit(text, projectId, null, {statusLine: d.statusLine});
               toast('‘' + d.label + '’' + josa(로/으로) + ' 바꾸고, 적은 글은 저장했어요.', [오늘에서 보기]); return note
   else      → DN.status && DN.status.touch && DN.status.touch(); note = submit(text, projectId, null, {statusHint: maybe ? hintFor(d) : null});
               existing toast + (p.unknown ? ' · ‘/' + p.unknown + '’는 없는 명령어라 그대로 저장했어요' : ''); return note
   ```
2. `/` shortcut: if `slash` element is a `TEXTAREA` with empty value → focus, `value = '/'`, caret at end, `dispatchEvent(new Event('input', {bubbles:true}))`; else today's behaviour.
3. `renderNav`: today count excludes `DN.statusCore.isHidden(sv, t.id)` where `sv = DN.status && DN.status.view ? DN.status.view(n) : null`.
4. 60 s tick: call `DN.status && DN.status.tick && DN.status.tick(now())` **before** `cur.handle.onTick`.

**`renderer/views/chat.js`**
1. `render()`: build the `div.chat-input` container **before** registering listeners; `var slash = DN.slash && DN.slash.attach ? DN.slash.attach(ta, { mount: inputBox, placement:'above', idPrefix:'slash', iconFor: function (n) { return ui.icon(n); }, onExecute: function (t) { ta.value = ''; grow(); AS.send(t, null); } }) : null;` registered **before** the existing Enter keydown listener. Hint text `'Enter 보내기 · Shift+Enter 줄바꿈 · / 명령어'`.
2. `sendNow()`: `p = DN.commands ? DN.commands.parse(v) : null; if (p && p.kind && !p.args) { show 'div.chat-input-note[role=status]' text '‘' + p.token + '’ 뒤에 적을 내용을 써 주세요.'; return; }` (do not clear the textarea; the note is removed on next `input`).
3. Rec host: `var recHost = h('div.rec-host')` placed between `list` and `tools`; `var nextTool = <the 다음 할 일 button>`; `var rec = DN.views.recPanel && DN.views.recPanel.mount ? DN.views.recPanel.mount(recHost, { onCtaVisible: function (v) { nextTool.hidden = !!v; } }) : null;`. Return `{ refresh: function () { paintList(); if (rec) rec.paint(); }, focus, destroy: function () { offAi(); if (slash) slash.destroy(); if (rec) rec.destroy(); }, tick: function () { if (rec) rec.paint(); } }`.
4. `message()`: user bubble → if `CMD.parse(m.text).command` show `span.chip.msg-cmd` (token) + space + args (FEATURES §6.8); `kind:'help'` → help card (FEATURES §6.11; `help-cmd` fills textarea `'/할일 '` + input event + focus); `if (/^status/.test(m.kind)) return DN.status && DN.status.card ? DN.status.card(m, st, now) : null;`; text actions: add `'showHidden'` → `button.btn.btn-xs '접어 둔 일 보기'` → `DN.views.today && DN.views.today.showHidden && DN.views.today.showHidden()`.
5. `captureCard()` precedence: (a) `c.command` → FEATURES §6.8 states table (no skeleton; running/stopped/no_ai/failed/done/refined/changedByUser); (b) else running → skeleton (unchanged); (c) `no_ai`: if `c.learned && c.learned.length` → head `summary(items)` + `' · AI 없이 배운 대로'`, foot `[설정 열기]` + `link-btn '왜?'`, else unchanged; (d) `failed` unchanged; (e) done: if `c.learned.length && !c.changedByUser` → foot `AI가 정리함 · 배운 대로 N곳 고침 · [왜?] · Ctrl+Z로 되돌리기`; else if `c.changedByUser && c.taught && DN.adapt && DN.adapt.enabled(S.state)` → `직접 고침 · 다음 정리에 참고해요 · [배운 것 보기]` (→ `A.go('settings', {section:'learn'})`); else unchanged. After the rows always append `DN.status && DN.status.hintChip ? DN.status.hintChip(n) : null`. [왜?] popover per ADAPT §7.7.1 (`ui.popover(anchor, node, {label:'배운 대로 고친 까닭', className:'learn-why'})`, rule rows via `AD.get`, `[이 규칙 지우기]` → `DN.capture.forgetRule`).
6. `capRow()`: kind chip gets `.is-forced` + lock icon + FEATURES aria/title when `c.command && !c.changedByUser` and the row is not a done/moved report; title `'배운 대로 정한 종류예요. 눌러서 바꿀 수 있어요.'` when `(c.learned||[]).some(x=>x.type==='kind')`; kind menu heading `'명령어로 정한 종류예요. 무엇으로 바꿀까요?'` for forced rows; for `it.kind==='task'` append `DN.status && DN.status.contextChip ? DN.status.contextChip(item, { focusKey: fk + ':ctx', where:'cap' }) : null` after the project chip; `dateMenu(anchor, n, it, now)`, `pickForm(pop, n, it, now)`, `setDate(n, it, ymd, time)` → `DN.capture.setDate(n.id, it.ref, ymd, time)` (delete the direct `S.mutate` code).
7. `nextCard()`: if `m.statusLabel` render `h('div.meta.next-status', '지금: ' + m.statusLabel)` above the title.
**`renderer/views/notes.js`:** inside the note-delete mutate (≈line 230) add `if (DN.adapt) DN.adapt.forgetRef(s, n.id);`.
**`renderer/css/capture.css`:** `.msg-cmd`, `.help-card`, `.help-card-title`, `.help-cmd`, `.cap-kind.is-forced`, `.cap-lock{width:11px;height:11px;opacity:.75}`, `.chat-input-note`, `.next-status`, `.learn-why{max-width:360px;padding:8px 10px}`, `.learn-why .btn{width:auto;display:inline-flex}`, `.cap-hint` wrapper spacing, phone rules.

---
#### W2-slash
**Owns:** `renderer/slash.js`, `renderer/quick.html`, `renderer/quick.js`, `renderer/css/slash.css`.
**Do:** FEATURES §6.10 (`DN.slash.attach` — pure DOM, depends only on `window.Daynote.commands`; uses `input` events; IME guard; `pointerdown` preventDefault; blur close 150 ms; `stopImmediatePropagation` for handled keys), §6.13 (quick window: script tags `../src/core/commands.js` then `slash.js` before `quick.js`; inline CSS `.slash-pop .slash-opt .is-active .qhelp` using the window's own variables; `send()` branches; foot hint `<span><kbd>/</kbd> 명령어</span>`; window height ≤ 400). `css/slash.css` (home): `.chat-input{position:relative}`, `.slash-pop{position:absolute;left:12px;right:12px;bottom:calc(100% + 4px);max-height:280px;overflow:auto}` + tokens (`--surface-raised`, `--shadow-float`, `--r-panel`), rows 38 px (44 px ≤640), `.slash-opt.is-active{background:var(--primary-soft)}`, `.slash-foot` hidden ≤640, kind icon colours via `.kind-<k>`.
**Note:** `build-web.js` excludes files ending in `quick.js`/`quick.html` — `slash.js` is fine.

---
#### W2-today
**Owns:** `renderer/views/today.js`, `renderer/views/recpanel.js`, `renderer/css/today.css`.
**`today.js`:**
1. `render`: `var statusBar = h('div.home-status')` as first child of `div.home`; `paintStatusBar()` (called from `paint()`) fills it with `DN.status.chip('bar')` + `span.meta` `ST.hiddenSummaryText(sv.summary, profile, {short:true})` when `sv && sv.summary.hidden`. Expose module-level `repaintToday` = `function(){ chat.refresh(); paint(); }` while mounted (cleared in `destroy`).
2. `todayLists`: head = `h1 '오늘'`, date, `DN.status && DN.status.chip ? DN.status.chip('head') : null`; under head `DN.status && DN.status.nudgeLine ? DN.status.nudgeLine(now) : null`.
3. Tasks section: `sv = DN.status && DN.status.view ? DN.status.view(now) : null`. **`sv === null` ⇒ exactly today's markup.** Else: `ranked = R.recommend(st, {now, workHours: st.prefs.workHours, statusView: sv}).ranked.map(x => x.taskId)`; `part = DN.statusCore.partitionToday(st, tl.open, sv, {rankedIds: ranked})`; render STATUS §9.3 groups (when / up+normal / extra / down / hidden line / done), §9.4 hidden line (`div.hidden-line[role=group]` + `button.link-btn '보기'` with `aria-expanded` and aria-label), §9.5 empty & sleep states, §9.6 count (`when+up+normal+down`). Rows in when/extra/down/expanded-hidden get `DN.status.contextChip(t, {focusKey:'today-ctx:' + t.id, where:'today'})`; down/hidden rows have class `.is-dim`; clicking an expanded hidden row → `DN.status.markShown(t.id)` then `A.openTask(t.id)`. Drag: one `sortable` per group; commit = `ST.joinOrder({when, upNormal, down}, key, newIds)` → `S.mutate('할 일 순서 바꾸기', set (i+1)*10)`. Module `mem = { downOpen: true, showHidden: false, baseId: null }`; reset `showHidden` when `sv.id` (base) changes. Guess-mode down header: `시간표로 보면 지금은 ‘{label}’이라 뒤로 미룬 일 N개 · [‘{label}’로 정하기]` → `DN.status.confirmGuess()`.
4. `onTick`: `if (chat.tick) chat.tick(); paint();`.
5. Export `showHidden()`: `mem.showHidden = true; if (repaintToday) repaintToday(); else DN.app.go('today');`.
6. Agenda (GOOGLE §9.3): list = `M.calendarItems(st, sod, eod)`; all-day items first (`'종일 · ' + title`), timed items whose `D.ymd(start)===today`; ext items `div.agenda-item.is-ext` (`.is-tentative` if tentative), click → `DN.views.extEvent && DN.views.extEvent.open ? DN.views.extEvent.open(item, ev.currentTarget) : A.go('calendar', {anchor: today})`; conflict marker via `M.conflictsFor(st, x.start, x.end, x.id)` for timed items.
**`recpanel.js`:** FEATURES §5.1–§5.4 (CTA, panel, chips, custom input with `D.parseDuration`, results, `mem`), recommend opts add `status: DN.status.current(now)` and `statusView: DN.status.view(now)` (guarded), `SL.freeNow(…, {workHours, status: DN.status.current(now)})`, C26 states. `DN.views.recPanel = { mount(host, opts) → { paint(), destroy(), ctaVisible(), isOpen() } }`; `opts.onCtaVisible(bool)` called whenever CTA-or-panel visibility changes (true when CTA visible **or** panel open).
**`css/today.css`:** `.rec-*` (FEATURES §5.4 names), `.home-status` (STATUS §10.8 incl. ≤860 sticky rules and `.home-today-head .status-chip{display:none}` ≤860), `.today-group-head`, `.home-row.is-dim .home-row-title`, `.hidden-line`, `.status-nudge`, `.agenda-item.is-ext`, `.agenda-item.is-tentative`, `.agenda-allday`.

---
#### W2-status
**Owns:** `renderer/statusui.js`, `renderer/views/settings-status.js`, `renderer/palette.js`, `renderer/views/detail.js`, `renderer/views/projects.js`, `renderer/ui.js`, `renderer/css/status.css`.
**`statusui.js` → `DN.status`** (STATUS §10, §15; all presence writes `S.mutate(null, fn, {source:'status'})`, non-silent unless stated):
```js
isActive() → bool
profile() → Profile                       // ST.profile(S.state.prefs), cached by JSON of [prefs.workHours, prefs.statusProfile]
view(now?) → StatusView|null              // cache key: minute + local rev (bumped on every S.subscribe event and own writes) + prefs JSON
current(now?) → null|{id,label,busy,until,guessed}
detect(text) → Detection|null             // ST.detect with { profile, eff, current, now }
apply(d, opts) → Transition|null          // opts { source, surface:'chat'|'toast', text, quiet? }; idle → DN.assistant.next(); same → toast '이미 ‘X’이에요'
                                          // chat surface: post/merge (2-min rule) status card; toast surface (unless quiet): STATUS §10.4 toast + [이전 상태로]
hintFor(d) → statusHint|null              // isActive && budgetOk → useBudget (silent mutate) → { from:'rule', role, id, label, quote, at }
touch()                                   // if sleeping → ST.wake (silent)
set(target, opts) → Transition            // opts { source:'menu'|'chip'|'palette'|'hint'|'rest', quiet? }; card only when today view is current (C28)
revert(), toGuess(), extend(minutes), back(), confirmGuess()
setFromCommand(args, { now, source:'command', surface }) → { ok, label?, message?, posted?, noop? }
postPicker()                              // post {kind:'status-pick'}
tick(now) → bool                          // ST.settle in silent mutate; if changed bump rev; also overtime/preset bookkeeping
chip(where:'head'|'bar') → Element        // STATUS §10.1; data-focus-key 'presence-chip' (head) / 'presence-chip-bar'
openMenu(anchor)                          // STATUS §10.2 (ui.menu className 'cap-menu'); '현재 상태 설정…' → A.go('settings', {section:'status'})
card(m, st, now) → Element|null           // kinds 'status' (STATUS §10.3), 'status-pick', 'status-offer' (§12.4)
nudgeLine(now) → Element|null             // overtime line (STATUS §13); [닫기] → ST.dismissOvertime
contextChip(task, { focusKey, where }) → Element|null   // null unless isActive(); dashed '(추정)' unless source user/project
contextMenu(anchor, taskId, opts)         // '어느 쪽 일인가요?' + contexts + '정하지 않음'
setTaskContext(taskId, ctxId, opts)       // S.mutate('맥락 바꾸기', ST.setTaskContext, {source: opts.source||'today'}); toasts per §10.4 (undoToast)
setTaskAtMode(taskId, mode, opts)         // S.mutate('언제 할지 바꾸기', ST.setTaskAtMode, {source: opts.source||'detail'})
markShown(taskId)                         // silent
hintChip(note) → Element|null             // capture card suggestion line; [바꾸기] → set({id,label},{source:'hint'}) + resolved 'applied'; [아니요] → 'dismissed'
contextsForAi() → [{id,label,hint}]       // ST.contextHintsForAi(profile())
presenceForAi() → string|null             // active ? view label : null
onRestTimer(msgId, timerEndIso), onRestDone(msgId)       // STATUS §8.4
```
On `DOMContentLoaded` → `S.whenReady`: one `tick(A.now())`. Status cards use `DN.assistant.post/update` (lazy).
**`settings-status.js` → `DN.settingsCards.status = { render(ctx) → section#set-status, onChange(info) → bool, destroy() }`** — STATUS §11 entirely (silent prefs writes, DOM updated in place; returns `true` from `onChange` for `source:'status'`). Read work hours with `SL.describeWorkHours(SL.normalizeWorkHours(prefs.workHours))`.
**`palette.js`:** STATUS §10.2 '상태' group (menu statuses, `상태: 시간표대로`, `상태: 이전 상태로`, `현재 상태 설정 열기`; current status shown checked on empty query after '명령'); GOOGLE §9.3 '일정' group merges `M.externalItems(S.state)` (sub `'Google · ' + calendarName`, run → `A.go('calendar', {anchor: D.ymd(start)})`).
**`detail.js`:** when `DN.status.isActive()`: '맥락' row (select + reason line + current-effect line) and '언제 할까요' select (STATUS §10.6) using `DN.status.setTaskContext/setTaskAtMode` with `source:'detail'`; onChange regex per §2.13.
**`projects.js`:** when active: head select '기본 맥락' → `S.mutate('프로젝트 맥락 바꾸기', s => { M.byId(s.projects, id).context = v || null; }, {source:'projects'})`.
**`ui.js`:** add icons to `P`: `lock` (FEATURES §6.8 path), `briefcase home bag user heart book coffee moon walk train leaf` (24×24, 1.5 stroke, no fills except via inline `fill`).
**`css/status.css`:** STATUS §10.8 (`.status-chip`, `.st-*`, `.ctx-*`, `.ctx-chip`, `.ctx-chip.is-guess`), status card / status-pick / status-offer styles, settings-status card (matrix grid, phone `.seg` rows), detail context rows, `@media (max-width:640px){ .toast-wrap{ bottom: calc(64px + env(safe-area-inset-bottom)); } .ctx-chip{min-height:32px} }`, menu items ≥44 px on phone.

---
#### W2-settings
**Owns:** `renderer/views/settings.js`, `renderer/views/settings-learn.js`, `renderer/css/settings.css`.
**`settings.js`:** FEATURES §4 (AI 처리 card `#set-ai` with `details.settings-adv` 고급 and module `advOpen`; 근무 시간 card `#set-work`; 연결 card `#set-conn` with 사용 중/체험/준비 중 and `PROVIDERS` where `gcal` is `'ready'`; 화면 card `#set-view` with the `/` shortcut rows); page-sub `'AI·근무 시간·연결·데이터·화면을 정해요.'`; C10 order with registry cards:
```js
function card(name, fallback) { var c = DN.settingsCards && DN.settingsCards[name]; if (!c || !c.render) return fallback ? fallback() : null;
  try { return c.render(ctx); } catch (e) { console.error(e); return fallback ? fallback() : null; } }
// ctx = { params, rerender: function () { root.textContent = ''; render(root, {}); } }
// google fallback = static '캘린더' card: 'Daynote 안 캘린더만 사용 중'
```
`render(root, params)` returns `{ onChange, destroy }`: `onChange(info)`: `type !== 'change'` → `false`; ask `DN.settingsCards.{status,google,learn}.onChange(info)` — any `true` → return `true`; source ∈ `capture chat today status ai gcal gcal-settings` → `true`; else `false`. `destroy` calls each card's `destroy`. `params.section` (once): scroll `#set-<section>` into view and focus its `h3`. Transmission paragraph (AI card) appends: `함께 보내는 것: 할 일 맥락 이름 목록, 지금 상태 이름(현재 상태를 쓸 때), 이 글에 나온 표현을 전에 어떻게 고쳤는지(배우기를 켰을 때).` Data card help adds: `백업 파일에는 가져온 Google 일정의 제목·시간이 들어가요. 로그인 정보는 들어가지 않아요.`
**`settings-learn.js` → `DN.settingsCards.learn`**: ADAPT §7.7.2 with C9 (context group title `할 일 맥락`, chips `DN.statusCore.contextLabel(DN.status ? DN.status.profile() : ST.profile(prefs), to)`), × via `DN.capture.forgetRule`, 모두 지우기 via `S.mutate('배운 것 모두 지우기', s => AD.reset(s), {source:'learn'})` + undoToast, toggle silent prefs write + in-place DOM.
**`css/settings.css`:** `.settings-adv` (FEATURES §4.2 CSS), `.work-days`, `.field-error`, `.provider-list.is-soon`, `.learn-group`, `.learn-list`, `.learn-row`, `.learn-key`, `.learn-arrow`, `.learn-row .meta`, phone rules.

---
#### W2-gcal
**Owns:** `renderer/gcalsync.js`, `renderer/views/settings-google.js`, `renderer/views/extevent.js`, `renderer/css/gcal.css`.
**`gcalsync.js` → `DN.gcalSync`** = GOOGLE §8.10 API + §7.6 engine (single-flight `syncNow`, start 3 s after `whenReady`, 10-min interval, `online`/`visibilitychange`, `host.google.onChanged`, 4-s debounced push on `S.subscribe` changes with `source !== 'gcal'` or `type:'undo'`; all sync mutates `S.mutate(null, fn, {source:'gcal', silent: changed === 0})`; remote deletes via `S.mutate('Google에서 지운 일정 반영', …)` + `ui.undoToast`; toasts §9.4). Does nothing when `!available()` (browser/smoke). `ctx()` = `{ now: A.now(), deviceId: status.deviceId, tz: Intl…||'Asia/Seoul' }`.
**`settings-google.js` → `DN.settingsCards.google = { render(ctx) → section#set-gcal, onChange(info), destroy() }`**: GOOGLE §9.1 (all states, 3 groups, 고급, setup modal; `onChange` repaints only the card for `source 'gcal'|'gcal-settings'` and returns `true`; never repaint while an input of the card has focus or non-empty value in `needs_setup`); subscribes to `DN.gcalSync.onChange` in render and unsubscribes in `destroy`.
**`extevent.js` → `DN.views.extEvent = { open(item, anchorEl) }`**: GOOGLE §9.2 popover (`ui.popover`, label `'Google 일정'`), `[Google 캘린더에서 열기]` → `window.open(item.htmlLink)`; other-device text.
**`css/gcal.css`:** `.gcal-*` (account, avatar, cal-list, dot via `--gc` set with `setProperty`), `.ext-pop`.

---
#### W2-schedule
**Owns:** `renderer/views/schedule.js`, `renderer/views/calendar.js`, `renderer/css/schedule.css`.
**`schedule.js`:** FEATURES §2.4 wrapper `findFreeSlot` (same name/return), §3.1 suggested length (+ `durationGuessed`, save-estimate checkbox in the same mutate), §3.2 conflict state machine (`SL.conflicts(SL.collectBusy(…))`, `div.conflict-actions` with [다른 시간 찾기]/[겹쳐 배치], disabled primary, `commit({force})`, remove "다음 빈 시간 찾기"), copy (C18, `-어요`); GOOGLE §9.3: `' (Google)'` suffix for `provider==='google'`, sync line under block edit when `DN.gcalSync && DN.gcalSync.status().signedIn && S.state.gcal.settings.exportEnabled` using `G.blockSyncState(S.state, block.id, DN.gcalSync.ctx())` → texts `Google 캘린더 ‘Daynote’에 반영됨` / `Google에 올리는 중이에요` / `Google에 올리지 못했어요 · 설정에서 확인` / `시각을 확인하면 Google에 올라가요`.
**`calendar.js`:** C27 `placeBlocks` (lanes in a local `Map`/object keyed by id, no `__lane` on state objects); ext items `div.cal-block.ext(.is-tentative)` `draggable='false'`, aria-label per GOOGLE §9.2, click/Enter → `DN.views.extEvent.open(item, el)`; all-day row `div.cal-allday` with `span.cal-allday-item` (hidden when empty); `render(root, params)` reads `params.anchor` once (archive pattern) to set `mem.anchor`; drag & block click paths ignore ext items.
**`css/schedule.css`:** `.conflict-actions`, length suggestion chip slot, `.cal-block.ext`, `.cal-block.ext.is-tentative`, `.cal-allday`, `.cal-allday-item` (GOOGLE §9.2 CSS), `.sched-sync` line.

---
#### W2-main
**Owns:** `main.js`, `preload.js`, `scripts/shots.js`, `README.md` (daynote/), `/home/user/famem/DAYNOTE_UX_V2.md`.
**`main.js`:** GOOGLE §8.7 exactly (dotenv `out`, `captureEnvClient`, lazy create in `whenReady` when `!CHECK_RUN`, `net` import, `fromMain` sender check, `gh` wrapper, the 11 handlers + `google:changed` send, redaction); smoke `out.core` becomes `!!(D.model && D.recommend && D.suggest && D.weekly && D.slots && D.commands && D.adapt && D.statusCore && D.gcal && D.aiForced)`. No other behaviour changes.
**`preload.js`:** GOOGLE §8.8 `google`/`gcal` surfaces (argument coercion as written).
**`scripts/shots.js`:** add step `17-퇴근후-홈` after existing steps: load sample, `Daynote.assistant.send('퇴근')`, wait, screenshot (STATUS #160). Keep all existing steps/selectors working (update selectors only if a W2 package renamed one — none planned).
**Docs:** README (features: slash commands, 할 일 추천 패널, 근무 시간, 현재 상태, Daynote가 배운 것, Google 캘린더 setup text GOOGLE §14 verbatim, "실제 동작/미구현" table per GOOGLE §14 last paragraph, test file list); `DAYNOTE_UX_V2.md` §8 key table gains `/ (입력창 맨 앞) — 명령어`.

---

## 5. Integration contract (cross-package surface; all calls guarded)

### 5.1 `DN.capture` (W2-capture)
`submit(text, projectId, onDone, opts{command?, statusLine?, statusHint?}) → note|null` · `classify(noteId, opts{starting?}) → Promise` · `setKind(noteId, kind)` · `setItemKind(noteId, ref, kind)` · `removeItem(noteId, ref)` · `setProject(noteId, projectId)` · **`setDate(noteId, ref, ymd|null, time|null)`** · **`forgetRule(ruleId, label)`** · `items(note)` · `isRunning(id)` · `toMemo`, `toTask`, `today`, `KIND_LABEL`, `onChange`.

### 5.2 `DN.assistant` (W2-capture)
`send(text, projectId)` · `next(skip)` · **`statusCommand(args, {surface:'chat'|'toast'})`** · **`postHelp()`** · `post(msg) → msg` · `update(id, patch)` · `breakdown`, `rest`, `startTimer`, `tryNudge`, `quickKey`, …

### 5.3 `DN.status` (W2-status) — §4.3 W2-status list. Consumers: chat.js (`card`, `hintChip`, `contextChip`), assistant.js (`detect`, `apply`, `hintFor`, `touch`, `view`, `current`, `setFromCommand`, `postPicker`, `revert`, `onRestTimer`, `onRestDone`), capture.js (`contextsForAi`, `presenceForAi`), app.js (`detect`, `apply`, `touch`, `hintFor`, `view`, `tick`), today.js (`chip`, `nudgeLine`, `view`, `profile`, `contextChip`, `markShown`, `confirmGuess`), recpanel.js (`view`, `current`), settings-learn.js (`profile`).

### 5.4 Views
- `DN.views.chat.render(root) → { refresh(), focus(), destroy(), tick() }` (W2-capture); today.js calls `chat.tick()` on its tick.
- `DN.views.today = { title, render, todayTaskList, todayMemoList, showHidden() }` (W2-today).
- `DN.views.recPanel.mount(host, { onCtaVisible(bool) }) → { paint(), destroy(), ctaVisible(), isOpen() }` (W2-today).
- `DN.views.extEvent.open(item, anchorEl)` (W2-gcal).
- `DN.views.calendar.render(root, params)` honours `params.anchor: 'YYYY-MM-DD'` once (W2-schedule).
- `DN.views.settings.render(root, params)` honours `params.section ∈ ai|learn|work|status|conn|gcal|data|view` once (W2-settings).
- `DN.views.schedule = { open, findFreeSlot }` (names unchanged).

### 5.5 `DN.slash` (W2-slash)
`attach(textarea, { mount, placement:'above'|'below', idPrefix, iconFor(name)→Node|null, onExecute(text), onResize() }) → { isOpen(), close(), refresh(), destroy() }`. Must be attached before any Enter keydown listener on the same textarea.

### 5.6 `DN.gcalSync` (W2-gcal) — GOOGLE §8.10 (`available, status, loadStatus, onChange, phase, syncNow, schedulePush, signIn, cancelSignIn, signOut, setClient, clearClient, setSelected, setExport, refreshCalendars, ensureExportCalendar, ctx`).

### 5.7 `DN.settingsCards` (registry; created by whichever file loads first: `window.Daynote.settingsCards = window.Daynote.settingsCards || {}`)
`Card = { render(ctx{params, rerender}) → HTMLElement (section.card.settings-card#set-<name>), onChange?(info) → bool, destroy?() }`; names: `learn` (W2-settings), `status` (W2-status), `google` (W2-gcal).

### 5.8 Host surface / IPC (W2-main + W1-model stubs)
| channel | args | returns |
|---|---|---|
| `google:status` | – | `GoogleStatus` |
| `google:setClient` | `{clientId, clientSecret, text}` | `{ok, error?, status}` |
| `google:clearClient` | – | `{ok, status}` |
| `google:signIn` | `{loginHint}` | `{ok, status}` \| `{ok:false, error, status}` |
| `google:cancelSignIn` | – | `{ok:true}` |
| `google:signOut` | – | `{ok, revoked, status}` |
| `google:changed` (main→renderer send) | `GoogleStatus` | – |
| `gcal:calendars` | – | `{ok, items, error?}` |
| `gcal:ensureExportCalendar` | `{tz, preferId}` | `{ok, calendar, created, error?}` |
| `gcal:list` | `{calendarId, syncToken?, timeMin?, timeMax?}` | `{ok, items, nextSyncToken, full, pages, timeZone}` \| `{ok:false, error}` |
| `gcal:instances` | `{calendarId, eventId, timeMin, timeMax}` | `{ok, items}` \| `{ok:false, error}` |
| `gcal:push` | `DispatchOp[]` (≤50) | `{ok, results}` \| `{ok:false, error}` |
`window.daynoteHost.google = {status, setClient, clearClient, signIn, cancelSignIn, signOut, onChanged}`, `.gcal = {calendars, ensureExportCalendar, list, instances, push}`; browser host stubs (W1-model) return `available:false`/`unavailable`. Existing `ai:*`, `store:*`, `app:*`, `quick:*` unchanged.

### 5.9 Store events & re-render rules
- `today.onChange`: unchanged rule (skip only `source:'today'`; everything else → `chat.refresh(); paint()`), so `'status'`, `'gcal'`, `'learn'` repaint home.
- Settings: §4.3 W2-settings rule. Detail: regex §2.13.
- Status writes are non-silent (`source:'status'`) except `markShown`, `touch`, `tick/settle`, budget bookkeeping (silent).
- Sync writes `source:'gcal'`, silent when nothing changed.

### 5.10 DOM hooks
- Ids: `#set-ai #set-learn #set-work #set-status #set-conn #set-gcal #set-data #set-view`, `#rec-panel`, `#rec-title`, `#rec-custom-in`, `#slash-list`, `#slash-opt-<i>`.
- `data-focus-key`: `cap:<noteId>:<idx>:kind|date|time|proj|ctx`, `presence-chip`, `presence-chip-bar`, `today-ctx:<taskId>`.
- Classes others rely on: `.chat-input textarea` (focus target; palette, help card, recpanel), `[data-slash]` stays on the chat textarea, `.home-today-head` (chip host), `.home-status`, `.rec-host`, `.cap-row`, `.agenda-item.is-ext`, `.cal-block.ext`.

### 5.11 Labels/sources/message kinds — §2.6, §2.13.

---

## 6. Verification

### 6.1 Per package
| Package | Automated | Manual / Playwright (serve.js, `?fakeai`, `timezoneId:'Asia/Seoul'`, `__daynoteNow`) |
|---|---|---|
| W1-model | `npm test` green; new model/store/sample tests | – |
| W1-status | 6 status test files green (skips only for not-yet-merged deps) | – |
| W1-commands | commands/dates tests | – |
| W1-adapt | adapt tests | – |
| W1-slots-recommend | slots + appended recommend/assist tests; the 18 original recommend tests untouched | – |
| W1-gcal-core | gcal-core tests | – |
| W1-google-services | google-auth (real 127.0.0.1 loopback) + gcal-service tests; capture-v3 keystore tests unchanged | – |
| W2-ai | forced, adapt-capture, status-capture; full suite green; schema walker | – |
| W2-capture | full suite green | FEATURES §8 D (command card instant + lock + refine; `/할일` alone blocked; `//todo`; unknown `/todos` hint; help card); STATUS #151–153 ('퇴근' no memo + card + chip; mixed text keeps original body; Ctrl+Z keeps status); ADAPT §7.11 #1–2, #6; Ctrl+N with `/할일 …` and `퇴근` (toast + [이전 상태로]); 0 console errors |
| W2-slash | – | `/` popup, `/ㅎ` while composing → 할일, ↑↓/Tab/Enter/Esc, Enter never sends while popup open, outside `/` key inserts `/`; phone tap rows ≥44 px; quick window (Electron only) |
| W2-today | – | FEATURES §8 C (CTA visibility, chips, custom `1:30`/`abc`, start closes panel, typing kept while capture arrives); STATUS #150, #155–157 (I1 screen identical before activation except faint chip; 390×844 no horizontal scroll; guess-mode down group + [퇴근으로 정하기]); hidden line expand/collapse; drag across groups keeps unique `sortOrder` |
| W2-status | – | STATUS #154 (chip menu keyboard & focus return), #158 (settings card keeps focus while a quick capture arrives; matrix cell click without re-render), #159 (Ctrl+K '퇴근'); detail context/atMode rows; project default context; context chip menu + undo toast |
| W2-settings | – | FEATURES §8 B (AI states, 고급 persists across re-render, no env var names in the top area; work hours validation, last-day guard, default link; 사용 중/체험/준비 중 and "새 할 일 제안 보기" kept); ADAPT §7.11 #3–5 |
| W2-gcal | – | GOOGLE §12.6: browser host shows '데스크톱 앱에서만'; fake `window.daynoteHost` via `addInitScript` → signed_in card, calendar list, sync → `.cal-block.ext`, `.cal-allday-item`, today `.is-ext`, Google-meeting reason text in '다음 할 일'; 390 px no horizontal scroll |
| W2-schedule | – | FEATURES §8 A (suggested length chip, conflict box buttons, [원래 시간으로], Fri 17:30 60 min → next Mon 09:00 copy, keyboard-only); Google suffix; sync line states; calendar ext block not draggable, click opens popover; `__lane` absent from saved JSON |
| W2-main | `npm test` unaffected | `node -e "require('./preload.js')"` not possible (electron) → code review; if Electron installable: `xvfb-run -a npx electron . --no-sandbox --profile=smoke --smoke` prints `core:true`, exit 0 |

### 6.2 Global acceptance criteria (after wave 2 merge)
1. `npm test` green under `TZ=UTC` and `TZ=Asia/Seoul`; **0 skipped**; all 123 pre-existing tests pass (only intended edits: `capture-v3` version line, `sample` counts).
2. Playwright on `/renderer/index.html` (CSP on) at 1440×900 and 390×844, light and dark: `go()` into `today archive tasks calendar projects weekly inbox notes settings` → **0 console errors / pageerrors**; `document.documentElement.scrollWidth === 390` on phone for today, settings, calendar.
3. **I1 regression:** fresh state + sample at `__daynoteNow='2026-10-10T01:25:00'`, status never activated → `DN.status.view()` is `null`, today task list markup equals pre-change markup apart from the faint `상태 정하기` chip, `R.recommend(state,{now})` deep-equals `R.recommend(state,{now, statusView:null})`.
4. `npm run build:web` succeeds; `dist-web/index.html` served statically loads with 0 console errors; settings Google card shows `Google 캘린더 연결은 데스크톱 앱에서만 쓸 수 있어요.`; fake AI demo works for `/할일 내일까지 견적서 보내기`, `퇴근`, `장보기` correction learning.
5. Undo semantics: after any labeled change, `S.undo()` never reverts `prefs`, `presence`, `gcal`; it does revert `learned` together with the correction.
6. Security: `JSON.stringify(S.state)` and all IPC results contain none of `ya29.`, `1//`, `GOCSPX-`, `refresh_token`, `client_secret`; Google handlers reject non-main-window senders; renderer CSP unchanged.
7. Prompt: capture input text sent to providers contains no `proj_`/`lr_` ids and no `presence.log` text (W2-ai test #19 of adapt-capture + STATUS #133).
8. Smoke (if Electron available) exits 0 with the extended `out.core`.

---

## 7. Ownership summary (every changed/created file has exactly one owner per wave)

| Wave | Package | Owned files |
|---|---|---|
| 1 | **W1-model** | `src/core/model.js`, `renderer/store.js`, `renderer/sample.js`, `test/model.test.js`, `test/store.test.js`, `test/sample.test.js` |
| 1 | **W1-status** | `src/core/statusWords.js`*, `src/core/status.js`*, `test/status-detect.test.js`*, `test/status-model.test.js`*, `test/status-context.test.js`*, `test/status-policy.test.js`*, `test/status-presets.test.js`*, `test/status-integration.test.js`* |
| 1 | **W1-commands** | `src/core/commands.js`*, `src/core/dates.js`, `test/commands.test.js`*, `test/dates.test.js`* |
| 1 | **W1-adapt** | `src/core/adapt.js`*, `test/adapt.test.js`* |
| 1 | **W1-slots-recommend** | `src/core/slots.js`*, `src/core/recommend.js`, `src/core/ai/assist.js`, `test/slots.test.js`*, `test/recommend.test.js`, `test/assist.test.js` |
| 1 | **W1-gcal-core** | `src/core/gcal.js`*, `test/gcal-core.test.js`* |
| 1 | **W1-google-services** | `services/keystore.js`, `services/google-auth.js`*, `services/gcal.js`*, `test/google-auth.test.js`*, `test/gcal-service.test.js`* |
| gate | **orchestrator** | `renderer/index.html`; placeholder creation (§4.2) |
| 2 | **W2-ai** | `src/core/ai/validate.js`, `src/core/ai/proposals.js`, `src/core/ai/capture.js`, `src/core/ai/fake.js`, `src/core/ai/forced.js`*, `test/forced.test.js`*, `test/adapt-capture.test.js`*, `test/status-capture.test.js`*, `test/capture-v3.test.js`, `test/capture.test.js`, `test/ai.test.js` |
| 2 | **W2-capture** | `renderer/capture.js`, `renderer/assistant.js`, `renderer/app.js`, `renderer/views/chat.js`, `renderer/views/notes.js`, `renderer/css/capture.css`* |
| 2 | **W2-slash** | `renderer/slash.js`*, `renderer/quick.html`, `renderer/quick.js`, `renderer/css/slash.css`* |
| 2 | **W2-today** | `renderer/views/today.js`, `renderer/views/recpanel.js`*, `renderer/css/today.css`* |
| 2 | **W2-status** | `renderer/statusui.js`*, `renderer/views/settings-status.js`*, `renderer/palette.js`, `renderer/views/detail.js`, `renderer/views/projects.js`, `renderer/ui.js`, `renderer/css/status.css`* |
| 2 | **W2-settings** | `renderer/views/settings.js`, `renderer/views/settings-learn.js`*, `renderer/css/settings.css`* |
| 2 | **W2-gcal** | `renderer/gcalsync.js`*, `renderer/views/settings-google.js`*, `renderer/views/extevent.js`*, `renderer/css/gcal.css`* |
| 2 | **W2-schedule** | `renderer/views/schedule.js`, `renderer/views/calendar.js`, `renderer/css/schedule.css`* |
| 2 | **W2-main** | `main.js`, `preload.js`, `scripts/shots.js`, `README.md`, `/home/user/famem/DAYNOTE_UX_V2.md` |

`*` = new file (wave-2 `*` files exist as orchestrator placeholders and are overwritten by their owner).
Not touched by anyone: `renderer/styles.css`, `renderer/aiflow.js`, `renderer/editor.*`, `renderer/rules.js`, `renderer/views/{archive,review,inbox,weekly,tasks}.js`, `quick-preload.js`, `services/ai.js`, `scripts/{build-web,serve,fix-electron,make-icons}.js`, `src/core/{suggest,weekly,split}.js`, `src/core/ai/organizeNote.js`, `test/{ai-provider,suggest,weekly,split}.test.js`.
