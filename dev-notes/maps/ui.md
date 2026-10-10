# Map: UI kit, app shell, styles, palette, conventions (Daynote renderer)

Paths are relative to `/home/user/famem/daynote/`. Line numbers are from branch `web-mobile` @ d75f062.
Files covered: `renderer/ui.js` (457 lines), `renderer/app.js` (347), `renderer/palette.js` (243), `renderer/styles.css` (1367),
`renderer/index.html` (58), `renderer/views/archive.js`, `renderer/views/tasks.js`. Also cross-read: `store.js`, `views/chat.js`,
`views/today.js`, `views/detail.js`, `views/schedule.js`, `views/settings.js`, `assistant.js`, `capture.js`, `scripts/build-web.js`.

---------------------------------------------------------------------------------------------------------------------------------
## 0. TL;DR for implementers

- All DOM is built with `ui.h('tag.cls#id', attrs?, ...children)` (ui.js:10). No framework, no bundler, ES5 style (`var`, `function`, no arrows/template literals).
- Every module is an IIFE that reads `window.Daynote` (`DN`) and attaches itself: `DN.ui`, `DN.app`, `DN.views.<id>`, `DN.palette`, ...
- A view = `DN.views.<id> = { title, render(root, params) -> handle }`; the handle may have `destroy()`, `onChange(info) -> true to skip re-render`, `onTick(now)`.
- State changes only via `DN.store.mutate(label|null, fn, {silent, source})` (store.js:145). Any non-silent mutate re-renders the current view unless its `onChange` returns `true`.
- Floating things: one at a time, via `ui.popover`/`ui.menu` (ui.js:182/242). Modals via `ui.modal` (ui.js:110). Toasts via `ui.toast`/`ui.undoToast` (ui.js:86/104).
- Colors only via CSS tokens (styles.css:14-273). Kind colors through local vars `--kind/--kind-soft/--kind-ink` set by `.kind-<k>` or `[data-kind=<k>]`.
- Phone layout = `@media (max-width: 640px)` at styles.css:1336-1367 (sidebar becomes a bottom tab bar).
- Korean copy: short polite `-어요` 체, suggest rather than command, titles in ‘ ’ quotes, particles via `ui.josa`.
- For a slash-command autocomplete: copy the palette's combobox mechanics (palette.js:113-229) and the `.menu`/`.pal-opt` look; do NOT naively use `ui.menu` (steals focus) and be careful with `ui.popover` (closes + preventDefaults on anchor mousedown).
- For status chips: reuse `.chip` + `chip-*` variants for display, `button.pill[aria-pressed]` (archive kind filter) or `.seg` for filters, and the cap-row "chip → ui.menu with checked items" pattern for editing.

---------------------------------------------------------------------------------------------------------------------------------
## 1. Load order, globals, CSP (renderer/index.html)

```
index.html:6   CSP: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:
index.html:8-10  vendor/codemirror.min.css, styles.css, editor.css
index.html:16-28 ../src/core/{dates,model,recommend,suggest,weekly,split}.js, ../src/core/ai/{organizeNote,validate,proposals,capture,assist,fake}.js
index.html:31-33 vendor/codemirror.min.js, rules.js, editor.js
index.html:36-56 sample.js, store.js, ui.js, app.js, aiflow.js, capture.js, assistant.js,
                 views/detail.js, schedule.js, chat.js, today.js, archive.js, review.js, notes.js, tasks.js,
                 calendar.js, projects.js, weekly.js, inbox.js, settings.js, palette.js
```
- `window.Daynote` namespaces: `dates, model, recommend, suggest, weekly, split, aiOrganize, aiValidate, aiProposals, aiCapture, aiAssist, aiFake, sample, store, ui, app, aiFlow, capture, assistant, views.*, palette`.
- ui.js needs `DN.dates`, `DN.model` at load (ui.js:6-7); it reaches `DN.app` / `DN.store` lazily inside functions (app.js loads after ui.js).
- app.js starts on `DOMContentLoaded` (app.js:346); views attach later in the same tick, so views must also reference `DN.app` lazily (they do: `var A = DN.app` inside `render`).
- **New renderer file ⇒ add a `<script>` tag** in index.html (order matters: after ui.js/app.js, before palette.js if palette uses it). No inline `<script>`, no inline `on*=` HTML attributes (CSP). Inline `style=` attributes are fine (`'unsafe-inline'` for styles).
- Web demo build `scripts/build-web.js`: copies `renderer/` → `dist-web/` (excludes quick.html/quick.js), copies `src/` to `dist-web/src`, strips the CSP meta, rewrites `../src/` → `src/`, injects `<script src="web-demo.js">` (sets `window.DAYNOTE_WEB_DEMO = true` → fake AI) right before `store.js`. `dist-web/` is gitignored; rerun `npm run build:web` after changes. `scripts/serve.js` serves repo root on 127.0.0.1:5178 (`/` → `/renderer/index.html`, `?fakeai` enables fake AI).
- Store host in browser = localStorage key `daynote:data` (store.js:11); emergency copy `daynote:unsaved`.
- `quick.html` (global quick-capture window) has its OWN inline tokens/styles (not styles.css) — changes to tokens don't propagate there.
- Smoke test list of views lives in main.js:181 (`['notes','tasks','calendar','projects','weekly','inbox','settings','today']` — archive is missing); screenshot script scripts/shots.js.

---------------------------------------------------------------------------------------------------------------------------------
## 2. `ui.h` — hyperscript (ui.js:10-37)

```js
function h(sel, attrs /*, ...kids */)
// sel: /^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i   e.g. 'div', 'button.btn.btn-primary', 'h2#agenda-title', '.foo' (tag defaults to div)
```
- 2nd arg is treated as a child (not attrs) if it is a non-object, a `Node`, or an `Array` (ui.js:15). Plain object ⇒ attrs. `null` ⇒ no attrs.
- Children: nested arrays are flattened; `null`/`false` skipped; non-Nodes become text nodes (`String(c)`) — safe against HTML injection.
- Attr handling (ui.js:16-27):
  | key | effect |
  |---|---|
  | value `null`/`undefined`/`false` | **skipped entirely** |
  | `class` | appended to classes from selector |
  | `text` | `textContent` |
  | `html` | `innerHTML` — only for fixed strings (icons). Never user text. |
  | `style` (object) | `Object.assign(el.style, v)` |
  | `on<event>` (function) | `addEventListener(event.toLowerCase())` e.g. `onclick`, `onkeydown`, `onmousedown`, `onsubmit` |
  | `value` | `el.value = v` |
  | `checked` / `disabled` / `selected` | boolean property `el[k] = !!v` |
  | anything else | `setAttribute(k, v === true ? '' : v)` |
- Examples:
  ```js
  h('button.btn.btn-sm', { type: 'button', onclick: fn }, ui.icon('plus'), '추가')
  h('div.seg', { role: 'group', 'aria-label': '보기' }, MODES.map(function (m) { return h('button', {...}, m.label); }))
  h('input.input', { type: 'search', placeholder: '… ( / )', 'aria-label': '…', value: q, 'data-slash': '' })
  h('span.chip.chip-project', { style: { '--pc': p.color } }, p.name)   // see gotcha G1
  ```
- **Gotchas**
  - G1: `style: { '--pc': color }` goes through `Object.assign(el.style, …)`. Assigning a custom property as a JS property on `CSSStyleDeclaration` does not set it in browsers (needs `el.style.setProperty('--pc', color)`). Used at ui.js:315 (projectChip), chat.js:303, today.js:266/312. Result is likely that `.chip-project::before` always falls back to `var(--primary)` (styles.css:447). Verify in a browser before relying on `--pc`/`--kind` via `style:`; prefer `el.style.setProperty(...)` or a class.
  - G2: boolean `false` is dropped, so ARIA states must be strings: `'aria-pressed': on ? 'true' : 'false'` (or `String(bool)`), never `false`.
  - G3: an invalid selector (spaces, `[attr]`, `:` etc., or a trailing `.`) makes the regex fail ⇒ you silently get a bare `<div>`. Build conditional classes like `'li.task-row' + (done ? '.is-done' : '')`.
  - G4: `autofocus: true` ⇒ `autofocus=""` (picked up by `ui.modal` focus logic).

---------------------------------------------------------------------------------------------------------------------------------
## 3. Icons — `ui.icon(name, cls?)` (ui.js:40-82)

- Returns an `<svg class="ico [cls]" viewBox="0 0 24 24" aria-hidden="true">` built via innerHTML from fixed path table `P`. Unknown name ⇒ empty SVG (no error).
- Names (36): `today note task calendar project weekly inbox settings mail plus x search play clock snooze refresh trash link flag star alert edit chevronLeft chevronRight sidebar copy download spark check more undo idea archive chevronDown command theme`.
- Styling: `svg.ico` 16px, `stroke: currentColor`, width 1.5, round caps, `fill: none` (styles.css:424). Context sizes: `.btn svg` 16, `.btn-xs svg` 14, `.icon-btn svg` 18, `.chip svg` 12 (stroke 1.8), nav 18 (phone 20), `.menu button svg` 16, `.pal-ico svg` 16.
- To add an icon: add a 24×24 stroke path string to `P`. For a filled part use inline `fill="currentColor" stroke="none"` (see `theme`).
- Always pair icon-only buttons with `aria-label` (+ `title` for tooltip), e.g. `h('button.icon-btn', { type:'button', 'aria-label':'닫기', title:'닫기 (Esc)', onclick }, ui.icon('x'))`.

---------------------------------------------------------------------------------------------------------------------------------
## 4. Toasts (ui.js:84-107; CSS styles.css:854-864)

```js
ui.toast(msg, opts?) -> close()      // opts: { error?: bool, action?: { label, fn }, duration?: ms }
ui.undoToast(msg)    -> close()      // = toast(msg, { action: { label: '되돌리기', fn: () => DN.store.undo() } })
```
- Lazily creates `div.toast-wrap[role=status][aria-live=polite]` on body (fixed, bottom 20px, centered, z-index 100).
- Toast = `div.toast(.is-error)` > `span(msg)` + optional action button + `닫기` button (`aria-label="알림 닫기"`).
- At most 2 visible: before appending, removes oldest while `children.length >= 2` (ui.js:97).
- Default duration 3500 ms, 7000 ms if `action` given.
- `msg` may be a string or Node.
- Gotchas:
  - `undoToast`'s action calls the **global last** undo (`S.undo()` pops the top of the stack, store.js:159), not "the action this toast describes". If another labelled mutate happened in between, it undoes that one.
  - Toasts are not cleared on navigation (P1 report lists "토스트 수명과 화면 이동 시 정리" as remaining work).
  - Phone: `.toast-wrap` sits at `bottom: 20px`, overlapping the bottom tab bar; nothing in the 640px block moves it. Also `.toast-wrap` is `left: 50%` + `translateX(-50%)` with auto width, so its shrink-to-fit width is capped at ~50vw — toasts get narrow on phones (likely; verify).
  - Inverse surface colors: `--inverse-bg/--inverse-text/--inverse-hover/--inverse-active`; error uses `--toast-error-bg/--toast-error-text`.

---------------------------------------------------------------------------------------------------------------------------------
## 5. Modals / dialogs (ui.js:109-167; CSS styles.css:866-879)

```js
ui.modal({
  title: string,               // h2 in .modal-head + aria-label
  body: Node | Node[] ,        // appended into div.modal-body (flex column, gap 12)
  actions?: [{ label, primary?, danger?, disabled?, onClick?() -> false keeps it open }],
  footLeft?: Node,             // goes into .modal-foot > .left (e.g. a danger delete button)
  wide?: bool,                 // .modal-wide (860px) instead of 520px
  onClose?: fn
}) -> { close, box, body, foot }

ui.confirm(title, message, okLabel = '확인') -> Promise<boolean>   // actions: '취소' / okLabel(primary). Closing any other way resolves false.
```
- DOM: `div.overlay` (fixed, z 80, `--overlay` backdrop) > `div.modal[role=dialog][aria-modal=true]` > `.modal-head` (h2 + `.icon-btn` x) + `.modal-body` + `.modal-foot` (only if actions).
- Focus: on open, focuses `[autofocus]` → first input/textarea/select in body → primary button (setTimeout 0). On close, restores previous `document.activeElement`.
- Keys: document-level **capture** keydown listener: `Escape` closes (stopPropagation); `Tab` is trapped inside (`button, input, select, textarea, [tabindex]:not([tabindex="-1"])` — note `a[href]` not included).
- Backdrop mousedown on the overlay itself closes.
- Footer buttons are `button.btn(.btn-primary)(.btn-danger)`; returning `false` from `onClick` keeps the modal open (used for validation, e.g. schedule.js:91-99, projects.js:68).
- Inserting extra footer buttons after creation: `m.foot.insertBefore(h('button.btn', …), m.foot.children[1])` (schedule.js:140).
- Enter-to-submit is manual: `input.addEventListener('keydown', e => { if (e.key==='Enter' && !e.isComposing) { if (save() !== false) m.close(); } })` (projects.js:78).
- Helper boxes for modal bodies: `.conflict-box` (warning), `.ok-box` (success), `.field`, `.field-row` (2-col grid), `.help`.
- Gotchas:
  - While any `.overlay` exists, app shortcuts are off (app.js:298) and Ctrl+K does nothing (palette.js:236).
  - Because the modal's Esc listener is on `document` in capture phase, Esc inside a `ui.menu` opened from within a modal closes the **modal** (the menu's own Esc handler never sees it); the menu (appended to body) stays until an outside mousedown.
  - z-order: overlay 80 < `.menu` 90 < toast 100, so popovers from inside modals render above the modal.
  - Phone: `.modal, .dialog { max-width: calc(100vw - 24px) }` (styles.css:1366; `.dialog` is unused).

---------------------------------------------------------------------------------------------------------------------------------
## 6. Popover & menu (ui.js:169-289; CSS styles.css:881-888, 1154-1165)

### 6.1 `ui.popover(anchor, content, opts?)` (ui.js:182-235)
```js
// opts: { role = 'dialog', label?, className?, onClose? }
var pop = ui.popover(anchorEl, contentNode, { label: '날짜와 시각 정하기' });
// pop = { el, close(restoreFocus), setContent(node, role?), place(), anchor, key }
```
- Single global `openPop`; opening a new one calls `closeMenu(false)` first. `ui.closeMenu(restore?)` closes whatever is open (palette calls it before opening, palette.js:238).
- Element: `div.menu(.<className>)[role][aria-label]`, appended to `document.body`, `position: fixed`, z 90, `--surface-raised`, `--shadow-float`, radius 12, padding 4, `popIn` animation.
- `place()`: top = anchor.bottom + 4, left = anchor.left; flips **above** the anchor if it would overflow the bottom (`r.top - height - 4`), clamps right edge to 8px margin. Computed once on open and on `setContent` — not on scroll.
- Closes on: mousedown outside (capture, attached after a 0ms timeout), mousedown **on the anchor** (toggle: `preventDefault()` + close), window `resize`, `Escape` inside the popover (restores focus), `Tab` only when role=menu.
- Sets `aria-expanded="true"` on the anchor while open; removes it on close.
- Focus restore: to the anchor if still connected, else to `document.querySelector('[data-focus-key="<anchor's key>"]')` — the reason re-rendered rows give their chips `data-focus-key` (chat.js:237, `'cap:' + noteId + ':' + idx + ':kind'`).
- `setContent(node, role)`: replaces content, re-places, and **focuses the first input/select/textarea/button** in it (used to turn a menu into a small form: chat.js:386-404 `pickForm` → `pop.setContent(form, 'dialog')`).
- The initial `popover()` call does not move focus (only `menu()` and `setContent` do).

### 6.2 `ui.menu(anchor, items, opts?)` (ui.js:237-289) — returns the **element**, not the handle
```js
// item kinds:
{ label: '언제 다시 볼까요?' }                         // heading (label without onClick) → div.menu-label
{ sep: true }                                          // div.menu-sep
{ label, onClick(pop), sub?, icon?: name|Node, kind?: 'task'|'event'|..., checked?: bool, disabled?, keepOpen? }
// opts: { label?, className? }   (chat.js uses className: 'cap-menu' → min-width 220)
```
- Items are `button[role=menuitem|menuitemradio][tabindex=-1]`; `checked !== undefined` ⇒ radio with `aria-checked` and a right-side check icon (`span.menu-check`); `checked:true` adds `.is-checked` and receives initial focus (else first enabled button).
- `kind` adds class `kind-<k>` (icon colored by `--kind`, styles.css:1158) and, when no icon, a `span.kind-dot`.
- Click: unless `keepOpen`, closes with focus restore, then calls `onClick(pop)`, then (0ms later) if focus fell to `body` re-focuses the anchor/data-focus-key element.
- Keys: ArrowUp/Down wrap, Home/End; Enter/Space = native button click; Esc closes; Tab closes. No type-ahead.
- Canonical uses: `app.taskMenu` (app.js:215), `app.snoozeMenu` (app.js:201, `sub` = date), chat kind/date/project menus (chat.js:351-436).

### 6.3 CSS gotcha inside popovers
`.menu button { display:flex; width:100%; text-align:left; border:0; background:none; padding:7px 10px; … color: var(--text-primary) }` has specificity (0,1,1) and beats single-class `.btn`, `.btn-primary`, `.btn-xs` (0,1,0). Any `<button>` placed in a popover (e.g. the `.cap-pick-foot` 적용/취소 buttons, chat.js:400-402) gets menu-row styling (full width, no fill). Scope overrides like `.menu .btn-primary { … }` if you need real buttons inside a popover. Conversely, list rows get the menu look for free if they are `<button>`s.
Highlight is `:hover, :focus` only (styles.css:886) — there is no `.is-active` style for `.menu button`, so a focus-less (aria-activedescendant) list must add its own active class (palette uses `.pal-opt.is-active { background: var(--primary-soft) }`).

---------------------------------------------------------------------------------------------------------------------------------
## 7. Chips (ui.js:291-365; CSS styles.css:439-473, 1179-1201, 1329-1332)

### 7.1 Kind maps
```js
ui.KIND_LABEL = { task: '할 일', event: '일정', memo: '메모', idea: '아이디어', link: '링크' }   // ui.js:292
ui.KIND_ICON  = { task: 'task', event: 'calendar', memo: 'note', idea: 'idea', link: 'link' } // ui.js:293
ui.kindChip(kind, extra?) -> span.chip.chip-kind.kind-<k>  (icon + label + extra; unknown kind → memo)
```
`DN.capture.KIND_LABEL` duplicates the label map (capture.js:108).

### 7.2 Task chips (all return `null` when not applicable; `now` defaults to `DN.app.now()`)
| fn (ui.js line) | output |
|---|---|
| `projectChip(state, projectId)` (312) | `span.chip.chip-project` w/ `--pc` dot; null if missing/deleted |
| `dueChip(task, now)` (318) | `chip-overdue` '기한 지남 · 오늘 18:00' / `chip-today` '마감 오늘' / `chip-due` '마감 10월 9일 (금)' (flag icon) |
| `scheduleChip(state, task, now)` (330) | done→null; next block → `chip-sched` '작업 오늘 14:00' (clock); else `chip-unsched` '일정 미배치' |
| `estimateChip(task)` (337) | done→null; null → plain '소요 시간 미정'; `estimateSource:'ai'` → `chip-guess` '약 30분 (추정)'; else clock + duration |
| `statusChips(state, task, now)` (344) → **array** | `chip-progress` '진행 중'; `chip-waiting` '대기 · <waitingFor>'; `chip-waiting` '선행: <title> 외 N'; `chip-waiting` (snooze icon) '내일 09:00까지 미룸'; `chip-high` '우선순위 높음'; plain '우선순위 낮음' |
| `sourceChip(state, task)` (359) | '메일'/'메모'/'출처' (+ ' (삭제됨)' with `chip-missing`) |

### 7.3 Chip CSS variants (styles.css:440-464)
Base `.chip`: inline-flex, h 22, padding 0 8, radius pill, 12px/500, bg `--surface-subtle`, color `--text-secondary`, 1px transparent border.
Variants: `chip-project` (outline + `::before` dot `var(--pc, var(--primary))`), `chip-due` (primary text), `chip-overdue` (error-soft/error), `chip-today` (warning-soft/warning-ink), `chip-sched` (primary-soft/primary-ink), `chip-unsched` (dashed border), `chip-high` (warning), `chip-progress` (secondary-soft/secondary), `chip-waiting` (subtle + border), `chip-guess` (dashed warning — "AI 추정/확인 필요"), `chip-sample` (warning), `chip-auto`, `chip-manual` (secondary), `chip-missing` (error), `chip-overlap` (warning). Interactive: `button.chip` (hover border-strong), `.chip-btn` (cursor pointer).
Kind chips: `.chip-kind` uses `--kind-soft` bg / `--kind-ink` text / weight 600 (styles.css:472); icon colored `var(--kind)` (1179). Pseudo-kinds `kind-done` (success tokens) and `kind-moved` (event tokens) exist only in CSS (1329-1332).
Chip containers: `.task-chips` (flex-wrap gap 4, hidden when `:empty`), `.home-meta`, `.arc-meta`, `.wk-meta`, `.ai-card-meta`, `.cap-row`.
Related pills/badges: `.pill` (h 28, outline; `[aria-pressed=true]` = primary fill), `.ai-badge`, `.state-pill.is-ready/.is-note/.is-blocked`, `.confirm-badge(.is-required)`, `.status-dot(.ok/.err/.busy)`.

### 7.4 `.kind-*` variable mechanism (styles.css:466-473)
```css
.kind-task, [data-kind="task"] { --kind: var(--kind-task); --kind-soft: var(--kind-task-soft); --kind-ink: var(--kind-task-ink); }
/* same for event, memo, idea, link; plus .kind-done (success) and .kind-moved (event) at 1329-1332 */
.kind-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--kind, var(--text-tertiary)); }
```
Anything inside an element carrying `.kind-x` / `data-kind="x"` can use `var(--kind)`, `var(--kind-soft)`, `var(--kind-ink)` (e.g. `.arc-kind[aria-pressed=true]`, `.pal-opt[class*="kind-"] .pal-ico`, `.menu button[class*="kind-"] svg`, `.cap-kind:hover`). A new semantic family (e.g. task statuses) can follow the same recipe with new classes mapping to existing tokens — no new colors needed.

---------------------------------------------------------------------------------------------------------------------------------
## 8. Task row and other helpers (ui.js:367-449)

```js
ui.taskRow(state, task, opts?) -> li.task-row   // opts: { selected, compact, hideProject }  (comment mentions onOpen — unused)
ui.projectOptions(state, selectedId, emptyLabel = '프로젝트 없음') -> <option>[]   // first option value ''
ui.highlight(text, q) -> (string|<mark>)[]   // case-insensitive substring marks; feed as children
ui.josa(word, pair) -> word + particle       // pair: '와/과' '를/을' '는/은' '가/이' '로/으로'
```
- taskRow markup: `li.task-row(.is-done)(.is-selected)[tabindex=0][data-task-id]` > `input.check` (round checkbox) + `div.task-main` (`div.task-title`, `div.task-chips`) + `div.task-actions` (icon buttons, visible on hover/focus/selected). Must live in `ul.task-list`.
  - click → `A.openTask(id)`; Enter open; Space toggle done; F2 or title dblclick → inline rename (`store.mutate('제목 변경', …)`); ArrowUp/Down moves focus across **all** `.task-row` in the document.
  - Chips order: statusChips, dueChip, (scheduleChip, estimateChip unless compact), projectChip (unless hideProject), sourceChip (unless compact), '샘플'.
- `josa` returns the word **plus** the particle; to get just the particle: `ui.josa(q, '와/과').slice(q.length)` (palette.js:165, archive.js:211). Non-Hangul last char → first form; for '로/으로', ㄹ final also takes '로'.
- `highlight` uses `q.length` on the original text — fine for Korean/ASCII. `mark` styling exists only under `.arc mark, .pal mark` (styles.css:1289) and `.note-item mark` — add your container if you use it elsewhere.

`window.Daynote.ui` export list (ui.js:451-456): `h, icon, toast, undoToast, modal, confirm, menu, closeMenu, popover, kindChip, KIND_LABEL, KIND_ICON, josa, projectChip, dueChip, scheduleChip, estimateChip, statusChips, sourceChip, taskRow, projectOptions, highlight`.
**There is no segmented-control or tabs helper** — `.seg` is built inline (see §12.3).

---------------------------------------------------------------------------------------------------------------------------------
## 9. App shell (renderer/app.js)

### 9.1 DOM built by `buildShell()` (app.js:32-52)
```
#app
 └ div.app(.sidebar-collapsed)
    ├ aside.sidebar
    │  ├ div.brand > div.brand-mark 'D' + div.brand-name 'Daynote' + button.icon-btn.brand-collapse (Ctrl+\)
    │  ├ nav.nav[aria-label=주 메뉴]            ← els.nav (NAV buttons)
    │  └ div.sidebar-foot > div.nav (els.navSub: button.nav-sub '설정') + div.save-indicator[role=status]
    ├ main.main > div (els.banner: sample banner) + div.view#view[tabindex=-1]   ← views render here
    └ div (els.detail: detail panel host → aside.detail)
```
### 9.2 Sidebar nav (app.js:14-21, 54-80)
```js
var NAV = [
  { id: 'today',    label: '오늘',     icon: 'today',    key: '1' },
  { id: 'archive',  label: '보관함',   icon: 'archive',  key: '2' },
  { id: 'tasks',    label: '할 일',    icon: 'task',     key: '3' },
  { id: 'calendar', label: '캘린더',   icon: 'calendar', key: '4' },
  { id: 'projects', label: '프로젝트', icon: 'project',  key: '5' },
  { id: 'weekly',   label: '주간 정리', icon: 'weekly',  key: '6' }
];
```
- Rendered as `button.nav-item[aria-current=page?][title='<label> (Alt+N)']` > icon + `span.nav-label` + optional `span.nav-count` (today: open tasks due ≤ today; tasks: all open). Settings is `button.nav-sub` in the footer. `notes` and `inbox` views are reachable only via `go()`/palette.
- `renderNav()` rebuilds the whole nav (and sample banner) on every store change and every minute.
- Adding a NAV item: also update the Alt shortcut regex `/^[1-6]$/` (app.js:300), the settings shortcut table (settings.js:252 'Alt + 1~6'), and check the phone tab bar width (each item ≥44px; bar has `overflow-x: auto`). Palette "이동" commands are derived from `A.nav()` automatically.
- Save indicator: `renderSave(status)` (app.js:82-95), status from `S.onStatus`: `phase: saved|pending|saving|error`, `at`, `error`. Error shows '저장 실패 · 내용은 보존 중 ' + `link-btn` '다시 시도' (`S.retrySave()`).
- Sample banner: `div.sample-banner[role=note]` when `state.meta.sampleLoaded` with '샘플 지우기'.

### 9.3 View contract and navigation (app.js:5-7, 113-145)
```js
DN.views.<id> = { title: '보관함', render: function (root, params) { …; return handle; } };
// handle (all optional): {
//   destroy(),                         // called before re-render and before leaving
//   onChange(info) -> boolean,          // true = "I handled it, don't re-render me"
//   onTick(now)                         // every 60s (app.js:332-335)
// }
DN.app.go(viewId, params?)   // unknown id → 'today'; destroys old handle; scrollTop=0; renderView(); renderNav(); document.title = title + ' · Daynote'
DN.app.refresh()             // renderView() + renderNav() keeping scroll
DN.app.current()             // the live { view, params, handle } object (identity changes on every go())
```
- `renderView()` (app.js:125-133) keeps `#view.scrollTop` and every `[data-keep-scroll="<key>"]` element's scrollTop across re-renders — give inner scrollers a stable `data-keep-scroll` key.
- `onStoreChange(info)` (app.js:135-145): renderNav → applyPrefs → detail panel (close if task gone; else its own onChange or re-render) → `cur.handle.onChange(info)`; if not `true`, full `renderView()` (root cleared; all inputs recreated ⇒ focus/IME lost).
- `info` shapes (store.js): `{ type: 'change', label, source }` (mutate), `{ type: 'undo', label }`, `{ type: 'load' }`.
- Patterns to keep inputs alive:
  - archive.js:224-232 — `onChange` repaints only lists and returns `true` (except `type==='load'`).
  - today.js:37-44 — ignores `source === 'today'` changes (draft autosave), else repaints sub-parts, returns `true`.
  - tasks.js:205-211 — lets it re-render but saves the search caret first and restores focus/selection on next render (tasks.js:190-194).
  - detail.js:185-188 — skip re-render for own `source:'detail'` edits unless the label matches `/상태|단계|선행|미루기|소요 시간 확인|마감일/` (labels are load-bearing!).
- Per-visit state: module-level objects survive across renders (`mem` in archive.js:16, `filter`/`sticky` in tasks.js:29-35). Detect a fresh visit by identity: `if (stickyOwner !== A.current()) {…}` (tasks.js:89). Consume incoming params once and clear them (archive.js:80-83) so re-renders use on-screen state.
- `params` used today: `notes {noteId}`, `projects {projectId}`, `archive {kind, projectId, query}`, `tasks {projectId, filter: 'open'|'done'|'all'}`.
- Non-navigable "views"/components: `detail.render(root, taskId)`, `schedule.open(opts)` (modal), `chat.render(root)` (embedded in today), `review.render(root, noteId, ctx)`, `inbox.openEmail(id)`.

### 9.4 Shared actions on `DN.app` (app.js:338-344)
`now, go, refresh, openTask(id, {keepFocus}), closeDetail, toggleDone(id), startTask(id) → Promise<bool>, snoozeMenu(id, anchor, after?), taskMenu(id, anchor), deleteTask(id), scheduleTask(id, opts) (→ DN.views.schedule.open), openRef(ref), applyPrefs, quickCapture, saveQuick(text, projectId, {silent}), loadSample, clearSample, current(), detailTaskId(), nav()`.
- `now()` honors `window.__daynoteNow` (fixed clock for screenshots/tests). Always use `DN.app.now()`; `D.relDay(x)` without `now` uses the real clock.
- `applyPrefs()`: `.sidebar-collapsed` if `prefs.sidebarCollapsed || innerWidth < 1000`; `html.reduce-motion` if `prefs.reduceMotion`; theme via `data-theme` attribute on `<html>` ('light'|'dark'; absent = system).
- `quickCapture()` (Ctrl+N) modal shares `state.quickDraft {text, projectId}` with the home chat textarea draft.

### 9.5 Keyboard shortcuts
| Key | Where | Behavior |
|---|---|---|
| Alt+1…6 | app.js:300 | `go(NAV[n-1].id)` — works even inside inputs |
| Ctrl/Cmd+N | app.js:301 | quick memo modal (even inside inputs) |
| Ctrl/Cmd+\ | app.js:302 | toggle sidebar (prefs, silent) |
| `/` | app.js:304-308 | outside fields: focus `#view [data-slash]` (chat textarea on home, search on archive); `preventDefault` ⇒ the '/' is **not typed** |
| `/` | tasks.js:196-203 | tasks view has its own document listener focusing its search (its input has no `data-slash`) |
| Ctrl/Cmd+Z | app.js:309-314 | outside fields: `S.undo()` + toast '‘<label>’을(를) 되돌렸습니다.' |
| Esc | app.js:315 | outside fields: close detail panel (detail panel itself also handles Esc, detail.js:180) |
| Ctrl/Cmd+K | palette.js:232-240 | document **capture** listener; ignored inside `.CodeMirror` (editor uses it for links); toggles palette; no-op if a `.overlay` exists |
| Ctrl+Shift+T | notes.js:179 | CodeMirror keymap: selection → task |
| Alt+↑/↓ | today.js:355-365 | reorder today lists |
| Enter / Shift+Enter | chat.js:84-87 | send / newline (IME-guarded) |
| Ctrl+Shift+Space | main process | global quick-capture window |
- app `onKey` returns immediately if any `.overlay` is in the DOM (app.js:298). `inField` = INPUT/TEXTAREA/SELECT/contentEditable/inside `.CodeMirror` (app.js:299).
- The settings view shows a hard-coded table of these (settings.js:249-261) — update it when adding shortcuts. Note DAYNOTE_UX_V2.md §8 says "Ctrl+1~6" but code uses Alt+1~6.

---------------------------------------------------------------------------------------------------------------------------------
## 10. Command palette — Ctrl+K (renderer/palette.js)

- API: `DN.palette = { open(initialText?), close(), isOpen() }` (palette.js:242). `results`/`commands` are private — extend by editing palette.js.
- Option object shape:
  ```js
  { group: '명령'|'이동'|'최근'|'할 일'|'메모'|'일정'|'프로젝트', icon?: iconName, kind?: 'task'|'event'|'memo'|'idea'|'link',
    color?: '#hex' (shows a dot instead of icon), label, sub?, snippet?, keys?: 'Alt+1', checked?: bool,
    words?: 'search synonyms (ko + en)', at?: ISO (recency for ranking), run: function () {} }
  ```
- `commands()` (palette.js:29-45): '새로 적기' (go today + focus `.chat-input textarea`); one '이동' item per `A.nav()` entry (with `keys: 'Alt+N'`); '메모 목록' (notes); '새 할 일 제안' (inbox); three '테마: …' items (`checked` = current); '설정 열기'.
- `results(query)` (86-110): empty query ⇒ only `group === '명령'` commands + 5 most recent tasks/notes regrouped as '최근'. Otherwise substring match (lowercased) over: commands (`label + words`), tasks (`title + memo`), notes (`title + body`, excluding `captureRole === 'task_source'`), standalone events (`blocks` without `taskId`), projects. Each group ranked by `rank()` (prefix match < contains < none, then `at` desc) and capped at `PER_GROUP = 6`.
- DOM (113-147): `div.overlay.pal-overlay` > `div.modal.pal[role=dialog]` > `div.pal-head` (search icon, `input.pal-input[role=combobox][aria-controls=pal-list][aria-autocomplete=list]`, `kbd` Esc) + `div.pal-list#pal-list[role=listbox]` + `div.pal-foot` (key hints).
- Rows (paint, 157-194): `div.pal-group[role=group]` > `div.pal-group-title` + `div.pal-opt(.kind-k)#pal-opt-<i>[role=option][aria-selected]` > `span.pal-ico` (icon or `span.pal-dot` colored) + `span.pal-main` (`span.pal-label` highlighted, `span.pal-snippet`) + `span.pal-check` + `span.pal-sub` + `kbd.pal-keys`.
- Combobox mechanics (reusable for any autocomplete):
  - Focus never leaves the input; active option via `.is-active` + `aria-selected="true"` + input `aria-activedescendant` (setActive, 196-207), `scrollIntoView({block:'nearest'})` for keyboard moves.
  - Option `onmousedown: e.preventDefault()` keeps input focus; `onmousemove` sets active; `onclick` runs.
  - keydown (130-140): **`if (e.isComposing || e.keyCode === 229) return;`** (Korean IME guard) then ArrowUp/Down (wrap), PageUp/Down (±5), Enter run, Escape close (stopPropagation), Tab swallowed.
- Empty result: '‘q’와/과 맞는 것이 없어요.' + 'Enter를 누르면 이 글을 오늘 화면 입력창에 옮겨 둘게요.'; Enter then goes to today and fills `.chat-input textarea` (dispatches `input` event, does not send) (209-229).
- CSS: styles.css:1292-1321 (`.pal-opt.is-active { background: var(--primary-soft) }`, label color `--primary-ink`, icon colored by `--kind` for kind rows).

---------------------------------------------------------------------------------------------------------------------------------
## 11. CSS: tokens and conventions (renderer/styles.css)

### 11.1 Theming structure
- Light tokens on `:root` (14-121); dark on `:root[data-theme="dark"]` (124-196); **duplicated** for system dark under `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }` (199-273). Any new token must be added in all three places.
- Rule from header comment: "색은 모두 아래 토큰으로만 쓴다" — no raw hex in components. (Existing violation: notes.js:194 inline `#C9CDC6`.) Project colors are data (`model.js:166 PROJECT_COLORS`).
### 11.2 Token list (light values)
| group | tokens |
|---|---|
| surfaces | `--bg-app #F7F7F5`, `--surface #FFF`, `--surface-subtle #F1F1EF` (chips/hover), `--surface-hover #EDEDEA` (selected/pressed), `--surface-raised` (menus/modals), `--surface-active` (seg selected) |
| borders | `--border-deco #E6E6E3` (1px dividers), `--border-strong #D6D6D2` (hover), `--border-input`, `--border-control #8C8C8C` (checkbox ring ≥3:1) |
| text | `--text-primary #1A1A1A`, `--text-secondary #6B6B6B`, `--text-tertiary #8C8C8C` (hints only, not body) |
| accent | `--primary #5B5BD6`, `--primary-hover`, `--primary-ink` (text on soft), `--primary-soft #EEEEFB`, `--primary-line` (35% alpha), `--primary-fill`, `--primary-fill-hover`, `--on-primary`, `--focus`, `--focus-ring` |
| status | `--success/-soft/-ink/-line`, `--warning/-soft/-ink/-line`, `--on-warning`, `--error/-soft`, `--secondary #0B6E65` (in progress / now) `/-soft`, `--accent-warm(-soft)` = warning |
| kinds | `--kind-{task,event,memo,idea,link}` + `-soft` + `-ink` (task #2F6FEB blue, event #D9730D orange, memo gray, idea #9A6B00, link #0F8A7E) |
| floating | `--shadow-float`, `--overlay`, `--inverse-bg/-text/-hover/-active`, `--toast-error-bg/-text`, `--ai-checked-bg`, `--scrollbar(-hover)` |
| calendar | `--grid-line`, `--grid-line-strong`, `--today-col`, `--cal-{blue,green,orange,red,gray}(-bg)` |
| shape/motion | `--font` (Pretendard Variable…), `--mono`, `--r-control 8px`, `--r-panel 12px`, `--r-pill 999px`, `--ease cubic-bezier(.2,.7,.3,1)`, `--t-fast 160ms`, `--t-mid 200ms`, `--sidebar-w 224px`, `--detail-w 340px` |
| editor aliases | `--bg, --bg-alt, --text, --text-muted, --text-faint, --border, --accent, --on-accent, --accent-soft, --selection, --code-*, --codeblock-bg, --highlight-bg/-text, --quote-bar, --editor-font` (for editor.css) |
### 11.3 Typography & shape rules (UX_V2 §6)
Sizes 12/13/14(body)/16/20/26(page title); weights 400/500/600/700; headings letter-spacing -0.02em, body -0.005em; line-height 1.5 body / 1.3 headings; `font-variant-numeric: tabular-nums` globally. Radii 8 controls / 12 cards / 999 chips (6px for small inner buttons). Shadows only on floating things. 1.5px stroke icons at 16/18px.
### 11.4 Motion rule
Surfaces animate **position only** (no opacity) so a frozen frame is never faded (P1 report §1): `slideIn` (detail), `modalIn`, `popIn` (menus/toasts/sel-pop), `backdropIn` (overlay background only), plus `spin`, `capSlide`. Transitions use `var(--t-fast) ease-out`. Reduced motion: `@media (prefers-reduced-motion)` and `html.reduce-motion` kill all animation/transition (1146-1149).
### 11.5 Naming conventions
- Component prefixes: `task-`, `home-`, `cap-` (capture card), `chat-`/`msg-`, `arc-` (archive), `pal-` (palette), `cal-`, `proj-`, `tl-` (timeline), `wk-` (weekly), `sug-` (inbox), `review-`/`ai-`, `note-`, `detail-`, `modal-`, `menu-`, `nav-`, `page-`, `panel-`, `settings-`.
- Variants: `btn-*`, `chip-*`, `kind-*`. States: `is-*` (`is-active, is-selected, is-done, is-checked, is-open, is-error, is-saving, is-pending, is-empty, is-stale, is-now, is-past, is-work, is-today, is-none, is-conflict, is-dragging, is-missing, is-warn, is-info, is-required, is-confirm, is-off, is-auto, is-revoked`).
- ARIA-driven styling: `[aria-pressed="true"]` (`.seg button`, `.pill`, `.arc-kind`), `[aria-current="page"]` (nav), `[aria-current="true"]` (`.note-item`, `.proj-item`), `[aria-expanded="true"]` (popover anchor, e.g. `.cap-proj.is-empty`).
- Data hooks: `data-slash` (target of `/`), `data-keep-scroll`, `data-focus-key`, `data-task-id`, `data-note-id`, `data-id`, `data-kind`, `data-timer-end`, `data-split-edge`.
### 11.6 Generic component classes (quick reference)
- Layout: `.view-pad` (padding 32/40, max-width 1080, centered), `.page-head` > `div(h1.page-title + div.page-sub)` + `.page-actions`; `.toolbar` (flex-wrap gap 8); `.section-title`, `.panel-title`; `.card(.card-pad)`, `.panel > .panel-head/.panel-body`; `.empty` (+ `h3`, `.btn`); `.muted`, `.meta` (12px secondary), `.help` (13px secondary), `.sr-only`.
- Buttons: `.btn` (32px) `.btn-primary` `.btn-ghost` `.btn-danger` `.btn-sm` (28) `.btn-xs` (24) `.icon-btn` (30, transparent) `.link-btn` (underlined primary) `.btn-ai` (primary-colored icon).
- Inputs: `.input/.select/.textarea` (32px, focus ring `0 0 0 3px var(--focus-ring)`), `.field` (> label 12px), `.field-row` (2 cols), `.add-row` (dashed → solid on focus-within), `.search` (icon-prefixed input wrapper), `.check` (round checkbox), `.check-row`.
- Feedback: `.conflict-box`, `.ok-box`, `.review-flag(.is-error/.is-info)`, `.spinner`, `kbd`.
- Floating z-index ladder: in-view 1-6 · `.sel-pop` 30 · review drawer 35 · detail drawer 40 · `.overlay` 80 · `.menu` 90 · `.toast-wrap` 100.
### 11.7 Responsive breakpoints
1280 (view-pad 28; notes list hidden with review) · 1250 (home grid) · 1180 (`.detail` becomes absolute right drawer w/ shadow; side lists narrower) · 1000 (weekly/proj/sug single column; review-col drawer; JS auto-collapses sidebar) · 900 (proj columns) · 860 (home stacks vertically, split bars hidden; archive filters left-aligned; capture card full width) · **640 phone**.

### 11.8 Phone layout — `@media (max-width: 640px)` (styles.css:1334-1367)
```css
.app { flex-direction: column-reverse; height: 100dvh; }               /* sidebar ends up at the bottom */
.app .sidebar, .app.sidebar-collapsed .sidebar { flex: 0 0 auto; width: 100%; flex-direction: row; align-items: center;
  padding: 4px 6px calc(4px + env(safe-area-inset-bottom)); border-right: 0; border-top: 1px solid var(--border-deco);
  overflow-x: auto; overflow-y: hidden; }                              /* bottom tab bar */
.sidebar .brand, .nav-sep, .nav-section-title, .nav-sub, .save-indicator, .nav-label, .nav-count { display: none; }
.sidebar-foot .nav-sub { display: flex; height: 44px; min-width: 44px; … }  /* settings stays as a tab (later rule wins) */
.sidebar .nav { flex-direction: row; flex: 1; justify-content: space-around; }
.app .nav-item { height: 44px; min-width: 44px; padding: 0 10px; justify-content: center; }  /* 44px touch targets, 20px icons */
.view-pad { padding: 16px 16px 40px; }
.home { padding: 12px 12px 16px; gap: 12px; grid-template-rows: auto auto; }  .home-chat .chat { min-height: 62dvh; }
.home-today { flex: none; overflow: visible; }  .home-sec* { flex: none !important; height: auto !important; }  .home-scroll { overflow: visible; }
.chat-input-foot { flex-wrap: wrap; }  .chat-input-hint { display: none; }  .chat-input-foot .btn-primary { margin-left: auto !important; }
.cap-row { flex-wrap: wrap; }  .cap-title { flex: 1 1 auto; white-space: normal; }
.detail { width: 100% !important; max-width: 100%; }                  /* full-screen drawer (absolute from the 1180 rule) */
.notes-list, .cal-side, .proj-list { flex-basis: auto; width: 100%; }  .notes-layout, .cal-layout, .proj-layout { flex-direction: column; }
.modal, .dialog { max-width: calc(100vw - 24px); }
```
Phone gotchas: no hover ⇒ hover-revealed controls (`.task-actions`, `.cap-x`, `.cap-proj.is-empty`, `.tl-actions`, `.drag-handle` all `opacity: 0` until hover/focus-within) are only reachable after tapping/focusing the row; toasts overlap the tab bar (§4); `.menu` popovers are `position: fixed` and fine, but `place()` doesn't follow scroll; keyboard shortcuts (Ctrl+K etc.) have no touch equivalent. The `.sidebar-collapsed` class is still applied (width < 1000) — phone rules explicitly override it.

---------------------------------------------------------------------------------------------------------------------------------
## 12. Example views — idioms to copy

### 12.1 archive.js (filters + list, keeps inputs alive)
- Module state `mem = { kind:'all', projectId:'', query:'', limit:150 }` (archive.js:16); params consumed then cleared (80-83).
- Header: `div.view-pad.arc` > `.page-head` with `h1.page-title '보관함'`, `.page-sub` (-어요 copy), `.page-actions` count `span.meta`.
- **Kind filter chip row** (95-105): `div.arc-kinds[role=group][aria-label=종류]` of `button.pill.arc-kind(.kind-<k>)[aria-pressed]` with leading `span.kind-dot`; clicking repaints only kinds + list. CSS: `.arc-kind[aria-pressed="true"] { background: var(--kind-soft, var(--primary-fill)); border-color: var(--kind, …); color: var(--kind-ink, var(--on-primary)); font-weight: 600 }` (styles.css:1264) — '전체' (no kind class) falls back to primary fill.
- Project `select.select.arc-proj` with sentinel `'__none'` = "프로젝트 없음"; search `input.input[type=search][data-slash]` inside `div.search.arc-search` (icon-prefixed). Esc clears search (stopPropagation), ArrowDown jumps into the list.
- List: `section.arc-day` > `h2.arc-day-head` + `ul.arc-list` > `li` > `button.arc-row[data-note-id]` (ArrowUp/Down between rows, Up from first → search). Pagination "더 보기 (N개 남음)" `btn-sm`.
- Empty states (203-220) built with `ui.josa` and a '필터 지우기' reset button.
- `onChange` returns `true` after repainting (226-231) so the search input never loses focus/IME state.
### 12.2 tasks.js (grouped list + toolbar)
- GROUPS (13-25) ordered sections with `section.task-group[aria-label] > div.task-group-head(span label + span.count) + ul.task-list(ui.taskRow…)`.
- Toolbar (110-118): project `select` (`ui.projectOptions`), `div.seg` of MODES `[{open:'남은 일'},{done:'완료'},{all:'전체'}]`, search input (no `data-slash`; own '/' handler 196-203, removed in `destroy`).
- `.add-row` input: Enter adds task; trailing `!` ⇒ priority high; IME guarded with `e.isComposing`.
- "Sticky" completed rows: `sticky[taskId] = group` keeps a just-completed task in place until the filter changes or the view is re-entered (30-35, 72-80, 160).
- Re-render strategy: `redraw = A.refresh` (full re-render) + caret restore (`searchCaret`).
- Copy here is older `-습니다/-입니다` style ('확정된 할 일을 마감과 상태별로 봅니다.', '아직 할 일이 없습니다') — not the v2 tone.
### 12.3 Segmented control recipe (no helper; used in tasks.js:112, settings.js:224, calendar.js:64, inbox.js:106, weekly.js:284, projects.js:234)
```js
var seg = h('div.seg', { role: 'group', 'aria-label': '보기' }, MODES.map(function (m) {
  return h('button', { type: 'button', 'aria-pressed': cur === m.id ? 'true' : 'false',
    onclick: function () { cur = m.id; A.refresh(); /* or flip aria-pressed in place like settings.js:230 */ } }, m.label);
}));
```
CSS styles.css:495-505 (selected = `--surface-active` + 1px ring, 600 weight).

---------------------------------------------------------------------------------------------------------------------------------
## 13. Store contract (as used by UI) — renderer/store.js

```js
S.state                                   // single object (getter)
S.mutate(label|null, fn(state) -> result, { silent?, source? }) -> result
//  label  ⇒ JSON-clones the WHOLE state before fn (undo snapshot, stack max 30). Use null for high-frequency/cosmetic writes.
//  silent ⇒ no emit (no re-render). Used for prefs, drafts, nudge timestamps.
//  source ⇒ passed to listeners: 'today' (home draft), 'capture', 'chat', 'detail', 'notes'
S.undo() -> label|null                    // restores snapshot but keeps current prefs; emits {type:'undo', label}
S.subscribe(fn) -> unsubscribe;  S.onStatus(fn);  S.whenReady(fn);  S.flush();  S.retrySave();  S.host (IPC or browser shim)
```
- Undo labels are user-visible Korean noun phrases ('할 일 추가', '완료', '제목 변경', '마감일 바꾸기', '할 일(으)로 바꾸기' …) shown in the Ctrl+Z toast. They are also matched by code: `assistant.js:205` (`info.label === '완료'` triggers a nudge), `detail.js:187` (regex). Reuse existing wording when the semantics match.

---------------------------------------------------------------------------------------------------------------------------------
## 14. Korean copy / tone rules

Source: DAYNOTE_UX_V2.md §7 + observed v2 code (chat.js, archive.js, palette.js).
- Short polite **'-어요' 체**: '저장했어요', '맞는 글이 없어요', '정리하는 중…'. Older views (tasks, app.js toasts, schedule, settings mail card, notes, detail) still use '-습니다' — don't copy those for new UI; new strings should be -어요.
- **Suggest, don't command**: '나눠 볼까요?' (O) / '나누세요' (X). Menu headings are questions: '언제 다시 볼까요?', '무엇으로 둘까요?', '언제까지 할까요?', '언제로 옮길까요?'.
- AI results: '~로 정리했어요', '메모와 할 일 2개로 나눴어요', '아이디어로 남겼어요'. Mark AI output ('AI가 정리함', `chip-guess` '(추정)', '확인 필요').
- Failures don't blame and give the next action: '메모로 남겨 뒀어요 · 다시 시도', '저장 실패 · 내용은 보존 중 다시 시도'.
- Dates in human words: '오늘', '내일(토)', '10월 9일 (금)', '다음 주 화 15:00' (`D.relDay`, `D.shortDay` '10/9 (금)', `D.longDay`, `D.hm`, `D.duration` '1시간 30분').
- Quote dynamic titles with typographic single quotes: `'‘' + title + '’'`. Attach particles with `ui.josa` (e.g. `ui.josa(title, '를/을')`), or the `(으)로`/`을(를)` fallback in fixed strings.
- Separators: ' · ' (middle dot). Ellipsis: '…' (U+2026) for in-progress and "opens more" menu items ('일정에 배치…', '날짜 고르기…').
- Keyboard hints in placeholders/titles: '검색  ( / )', '사이드바 접기/펴기 (Ctrl+\\)', `h('kbd', 'Ctrl+Z')`.
- Undo toasts state what happened and reassure: '‘X’를 뺐어요. 원문은 그대로 있어요.' + 되돌리기.
- All aria-labels/titles in Korean; icon buttons name their target: `'‘' + title + '’ 메뉴'`.

---------------------------------------------------------------------------------------------------------------------------------
## 15. Blueprint: slash-command autocomplete in the home chat input

Where: `views/chat.js` `render()` — `ta` = `h('textarea', {rows:1, placeholder, 'aria-label', 'data-slash': ''})` (chat.js:19); input wrapper `div.chat-input` > `ta` + `div.chat-input-foot` (chat.js:91-93); Enter→`sendNow()` listener at chat.js:84-87; doer actions `DN.assistant.next()/breakdown()/rest()` (assistant.js:225-230), `DN.capture`, `DN.app.go`, `DN.palette.open()`.
Facts that constrain the design:
1. The textarea survives store changes (today.js:37-44 skips `source:'today'`; other changes only call `chat.refresh()` = message list repaint). It is recreated only on full re-render (`type:'load'`, navigation). Its `destroy` (chat.js:104) must also tear down the popup.
2. Listener order: listeners on the same element fire in registration order. Register the slash keydown handler **before** chat.js:84's Enter handler (or merge into it) and call `e.preventDefault(); e.stopImmediatePropagation()` for ArrowUp/Down/Enter/Tab/Escape while the popup is open — otherwise Enter sends the message.
3. IME: bail out on `e.isComposing || e.keyCode === 229` (palette.js:131, chat.js:86). Detect the trigger on `input` events (value/caret), not keydown, so Korean composition works.
4. The global '/' shortcut (app.js:304) only fires outside fields and `preventDefault`s, so pressing '/' on the page just focuses the textarea without typing '/'; the popup should open on a typed '/' at line start (or value start).
5. `.chat` has `overflow: hidden` (styles.css:995) and `.chat-input` is at the bottom of the panel ⇒ render the popup in `document.body` with `position: fixed` (like `.menu`) and place it **above** the textarea (`top = rect.top - height - 4`; reuse the flip logic of `place()` ui.js:188-195). Re-place on `input` (textarea grows up to 160px) and close on window `resize`.
6. Focus must stay in the textarea ⇒ do not use `ui.menu` (moves focus to the first item) or `pop.setContent` (focuses first button). Use the palette combobox pattern (§10): `aria-autocomplete="list"`, `aria-controls`, `aria-expanded`, `aria-activedescendant` on the textarea; options with `role=option`, `id`, `aria-selected`, `onmousedown: preventDefault`, `onmousemove` → setActive, `onclick` → run.
7. If you do use `ui.popover(ta, list, {role:'listbox', className:'slash-pop'})` to inherit "single floating thing" + outside-click + resize handling + `ui.closeMenu()` from Ctrl+K: (a) a mousedown on the anchor (the textarea) is `preventDefault`ed and closes the popup (caret click is swallowed once) — pass a different anchor or accept; (b) its Esc handler is on the popup element and never sees keys typed in the textarea — handle Esc yourself; (c) it sets `aria-expanded` on the anchor; (d) after replacing children manually call `pop.place()`; (e) buttons inside inherit `.menu button` styles (§6.3) and highlight only on `:focus` — add an `.is-active` rule.
8. Blur: close on `blur` with a short delay (notes.js:199 uses `setTimeout(hidePop, 150)`) so option clicks land; with `onmousedown: preventDefault` on options blur won't fire anyway.
9. Styling to reuse: container = `.menu` look (`--surface-raised`, `--shadow-float`, `--r-panel`, `popIn`); rows = `.pal-opt` + `.pal-ico` + `.pal-main/.pal-label/.pal-sub` + `kbd.pal-keys` + `.is-active` (styles.css:1300-1318; not scoped to `.pal`, except `mark` highlighting which is `.pal mark` — add your container to that rule or use `.pal` as an extra class). Group headings = `.pal-group-title`; empty = `.pal-empty`. Optional kind coloring via `.kind-<k>` on the row.
10. Copy: command labels as Korean verbs/nouns used by the tool buttons ('다음 할 일', '작게 나누기', '휴식' — chat.js:64-66) and palette ('새로 적기', '설정 열기'); sub-text in -어요 ('다음에 할 일을 추천해요'); hint line like the palette foot (`kbd ↑ ↓ 고르기 · Enter 실행 · Esc 닫기`). Update settings.js KEYS table and the placeholder/hint (`.chat-input-hint` is hidden on phone).
11. Phone: no physical arrows on touch — rows must be tappable (≥36px, `.pal-opt` min-height 38) and the popup must fit `100vw - 24px`.
12. Command registry: if commands should be shared with Ctrl+K, note palette's `commands()` is private; either export it (`DN.palette.commands`) or create a shared list module loaded before both chat.js and palette.js (index.html order: chat.js is loaded before palette.js).

---------------------------------------------------------------------------------------------------------------------------------
## 16. Blueprint: status chip row (task statuses)

- Status enum and labels: `DN.model.TASK_STATUS = { todo: '할 일', in_progress: '진행 중', waiting: '대기', done: '완료' }`, `DN.model.PRIORITY = { high: '높음', normal: '보통', low: '낮음' }` (model.js:25-26).
- Existing color semantics to keep consistent: in_progress → `--secondary` (`.chip-progress`); waiting/blocked/snoozed → neutral bordered (`.chip-waiting`); done → success (`.kind-done` tokens, `.ok-box`, `--success`); overdue → error (`.chip-overdue`); due today/high priority → warning (`.chip-today`, `.chip-high`); AI-uncertain → dashed warning (`.chip-guess`); scheduled → primary-soft (`.chip-sched`).
- Display-only chips on rows: return arrays of `h('span.chip.chip-…', …)` and drop them into `.task-chips`/`.home-meta`/`.arc-meta` (flex-wrap gap 4). Extend `ui.statusChips` (ui.js:344) rather than adding a parallel helper if it is for task rows (`taskRow` already calls it).
- Filter chip row (single select): copy archive's kind row — `div[role=group][aria-label]` of `button.pill[aria-pressed='true'|'false']` with `span.kind-dot` and a `--kind/--kind-soft/--kind-ink` mapping class. Recipe for new mapping classes (all tokens exist in both themes):
  ```css
  .st-todo        { --kind: var(--text-tertiary); --kind-soft: var(--surface-subtle); --kind-ink: var(--text-secondary); }
  .st-in_progress { --kind: var(--secondary);     --kind-soft: var(--secondary-soft); --kind-ink: var(--secondary); }
  .st-waiting     { --kind: var(--border-strong); --kind-soft: var(--surface-subtle); --kind-ink: var(--text-secondary); }
  .st-done        { --kind: var(--success);       --kind-soft: var(--success-soft);   --kind-ink: var(--success-ink); }
  ```
  (class names are a suggestion; existing families are `.kind-*` and `[data-kind]`). Toggle with a module-level filter object and repaint only the list (archive pattern) to avoid recreating the row.
- Multi-select filters: `aria-pressed` per pill is still correct; mutually exclusive 2-4 modes: `.seg`.
- Editable status chip on a row: `button.chip.<variant>` with `'aria-haspopup': 'menu'`, `'data-focus-key': <stable key>`, `aria-label: '상태: 진행 중 — 바꾸기'`, trailing `ui.icon('chevronDown', 'cap-caret')`, onclick → `ui.menu(e.currentTarget, [{ label: '상태를 무엇으로 둘까요?' }].concat(keys.map(k => ({ label: M.TASK_STATUS[k], checked: t.status === k, onClick: … }))), { label: '상태 바꾸기', className: 'cap-menu' })` — same as `kindMenu` (chat.js:351-355). Inside clickable rows remember `e.stopPropagation()` (row onclick opens the task). Use `A.startTask(id)` for → in_progress (it confirms switching other in-progress tasks, app.js:183-199) and `A.toggleDone(id)` for done/undone, so history/undo toasts stay consistent; other changes via `S.mutate('상태 변경', s => M.updateTask(s, id, { status }, A.now()))` (detail.js:42 uses the label '상태 변경').
- Phone: chip rows already wrap; keep chips ≤22px tall but make the clickable ones `button.chip` (hover border) — touch targets are small; consider `.btn-xs`-like padding on ≤640px.

---------------------------------------------------------------------------------------------------------------------------------
## 17. Pitfalls checklist (collected)

1. `h()` drops `false`/`null` attrs → ARIA booleans must be strings (§2 G2).
2. `style: {'--var': x}` via h() likely does nothing (§2 G1) — use `el.style.setProperty`.
3. Invalid `h()` selector silently yields a plain `<div>` (§2 G3).
4. Any non-`true` `onChange` return ⇒ full view re-render ⇒ inputs recreated (focus, caret, IME composition lost).
5. Labelled `mutate` clones the entire state — avoid for per-keystroke writes (use `null` label, maybe `silent`).
6. `undoToast`'s button undoes the latest labelled mutation, whatever it is.
7. `ui.menu` returns the element; `ui.popover` returns the handle `{el, close, setContent, place, …}`.
8. Popovers aren't closed on `go()` navigation or on scroll; only outside mousedown/resize/Esc/anchor click/another popover/Ctrl+K.
9. `.menu button` overrides `.btn*` styles inside popovers (§6.3).
10. Esc inside a popover opened from a modal closes the modal (capture listener) (§5).
11. App shortcuts are disabled while any `.overlay` is present (modal or palette).
12. Alt+1..6 is hard-wired to 6 NAV items (regex + settings table).
13. Keyboard handlers in text inputs must guard Korean IME (`e.isComposing || e.keyCode === 229`).
14. Use `DN.app.now()` not `new Date()` (fixed-clock screenshots/tests via `window.__daynoteNow`).
15. New tokens must be added three times (light, `[data-theme=dark]`, system-dark media block); `quick.html` has its own separate tokens.
16. New script files must be added to `index.html`; CSP forbids inline scripts; rebuild `dist-web` for the web demo.
17. `.task-row` ArrowUp/Down navigation queries all `.task-row` in the document — two lists on one screen are traversed as one.
18. `D.relDay(date)` without `now` uses the real clock.
19. Hover-only affordances are invisible on phones until the row gets focus.
20. Toasts on phone: overlap the bottom tab bar and are width-capped by `left:50%` positioning.
21. Existing copy mixes '-습니다' and '-어요'; v2 rule is '-어요'.
22. Smoke check view list (main.js:181) doesn't include new views automatically (archive is already missing).
