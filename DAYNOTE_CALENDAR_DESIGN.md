# Daynote 캘린더 개편 — 월간 기본 보기 · 끌어서 자동 배치 · 머무르면 열리는 하루 · 배치 알고리즘(`planner.js`) — 구현 지시서

- 대상: `/home/user/famem/daynote` (브랜치 `web-mobile`). 경로는 `daynote/` 기준.
- 이 문서(= **CAL**)는 `dev-notes/IMPLEMENTATION_PLAN.md`(= **PLAN**) §8 "Calendar addendum"과 함께 읽는다. 둘이 다르면 PLAN §8이 이긴다. 다른 설계 문서(STATUS·FEATURES·GOOGLE·ADAPT)와 다르면 이 문서가 이긴다(캘린더·배치에 한해서).
- 말투: 화면 문구는 `-어요`. 동적 제목은 `‘ ’`. 조사는 `ui.josa`.
- 문법: `src/core/**`, `renderer/**`는 ES5(UMD 코어 템플릿). 코어는 `now`를 인자로만 받는다.

---

## 0. 사용자 요청과 결정 요약

요청(원문 요약): ① 캘린더 기본 화면을 한 달 달력으로. ② 왼쪽 할 일을 끌어 날짜 위에 놓으면, 빈 시간과 그 일을 하는 상태(업무 중·퇴근 후 등)에 맞춰 자동으로 시간표에 넣기. ③ 날짜 위에 올린 채 1초 기다리면 "띵" 하는 작은 진동 애니메이션과 함께 그날이 열리고, 직접 시간을 골라 넣기. ④ 소요 시간이 없으면 놓자마자 소요 시간 입력 팝업. ⑤ 직접 넣을 때도 우선순위·현재 상태 등을 보고 어디에 둘지 알려 주는 알고리즘. ⑥ 알고리즘에 필요한 값은 AI에 할 일을 맡길 때(캡처) 같이 받아 온다. 사용자에게 묻지 않고 모두 정한다.

| # | 결정 | 이유 |
|---|---|---|
| D1 | 캘린더 기본 보기 = **월간**. `월간 · 주간 · 일간` 세그먼트로 바꾼다. 마지막 보기는 `prefs.calendarMode`(`'month'\|'week'\|'day'`, 없으면 `'month'`)에 저장(조용한 prefs 쓰기). | 요청 ①. 기존 주·일 보기는 정확한 시간 배치용으로 남긴다. |
| D2 | 끌기는 **포인터 이벤트 기반 자체 엔진** `renderer/dragplace.js`(`DN.dragPlace`). HTML5 DnD(`draggable`)는 캘린더 전부에서 걷어낸다(주·일 보기 포함). | 터치에서 HTML5 DnD가 동작하지 않는다(recommend map §8). 마우스·터치·펜을 한 코드로. |
| D3 | 날짜 칸에 놓기 = **자동 배치**. 소요 시간이 없으면 먼저 소요 시간 팝오버. 배치 결과는 바로 저장하고(되돌리기 가능) 토스트로 알린다: [다른 시간] [되돌리기]. | 요청 ②④. "확인 후 저장"보다 빠르고, 되돌리기로 안전하다. |
| D4 | 같은 날짜 칸 위에 **1000 ms 머무르면** 칸이 300 ms "띵" 흔들림(+가능하면 `navigator.vibrate(20)`) 뒤 **그날 시간표(하루 패널)** 가 월간 보기 위에 열리고, 끌기는 계속된다. 패널에 놓으면 그 시각(15분 단위)에 넣는다. 추천 시간대가 순위 배지와 함께 보인다. | 요청 ③. |
| D5 | **소리는 넣지 않는다**(설정도 만들지 않음). 진동은 터치 끌기일 때만. 동작 줄이기 설정이면 흔들림 대신 색 강조. | 보수적으로. 업무 중 소리는 방해가 된다. 나중에 넣는다면 `prefs.calendarSound`(기본 끔) 이름을 예약만 해 둔다. |
| D6 | 배치 알고리즘은 새 순수 모듈 **`src/core/planner.js`**(`DN.planner`, `PL`). 의존: `dates`, `model`, `slots` 필수, `status` 선택. `adapt`는 v1에서 쓰지 않는다(학습 대신 "지난 블록 기록" 친화도 항을 코어 안에서 계산). | 테스트 가능한 코어. 다른 모듈을 고치지 않는다. |
| D7 | 시간대 판단은 **하루를 띠(band)로 나눈다**: 출근 전 · 업무 · 점심 · 퇴근 후 · 늦은 밤 / 쉬는 날. 띠마다 상태 id를 붙이고(STATUS `ST.timeline`과 같은 구간), 할 일 맥락과 정책표로 띄움/보통/내림/숨김을 정한다. 현재 상태 기능이 꺼져 있으면 고정 표(§5.4)를 쓴다. | 요청 ②의 "업무중, 퇴근 이후 등". 미래 날짜는 "지금 상태"가 아니라 **시간표**로 판단해야 한다. |
| D8 | AI 캡처 출력에 할 일마다 **`sched`** 를 더한다: `{ focus:'deep'\|'light'\|null, energy:'high'\|'low'\|null, prefer:'morning'\|'afternoon'\|'evening'\|null, splittable:boolean\|null, minutes:int\|null }`. 저장은 `task.schedHints = { focus, energy, prefer, splittable, source:'ai'\|'user', at }`(사용자 값이 이긴다). `minutes`는 글에 걸리는 시간이 **명시**됐을 때만 `estimateMinutes`(출처 `'ai'`)로 들어간다. **규칙으로 짐작한 힌트는 저장하지 않고 읽을 때 계산**한다(`PL.hintsOf`) — 맥락(STATUS §3.3)과 같은 원칙. | 요청 ⑥. 지어내지 않기, 사용자 우선. |
| D9 | 긴 일 나누기: v1은 **제안만** 하고 버튼을 눌렀을 때 **첫 조각만** 넣는다. 남은 시간은 왼쪽 목록에 "남은 N" 칩으로 계속 보인다. | 여러 블록 자동 생성은 되돌리기·충돌 설명이 복잡하다. |
| D10 | "이 날 자동 배치"(`PL.arrangeDay`)는 미리보기 팝오버에서 확인한 뒤 한 번의 `S.mutate('자동 배치', …)`로 넣는다. | 여러 개를 한꺼번에 넣으므로 확인을 둔다. |
| D11 | 일정 대화상자(`schedule.js`)에 **추천 시간 칩 3개**를 둔다(같은 알고리즘). | 요청 ⑤ — 수동 배치에도 알고리즘. |
| D12 | 스키마 번호는 4 그대로. `normalizeTask`에 `schedHints:null`만 더한다. `prefs.calendarMode`는 prefs 키. | PLAN C1. |

---

## 1. 월간 보기 (기본)

### 1.1 머리와 보기 전환 (`renderer/views/calendar.js`)
```
div.cal-head
  h2 '2026년 10월'                       // 월간. 주간: D.weekLabel, 일간: D.longDay (지금과 같음)
  button.icon-btn [이전 달]  button.btn.btn-sm '오늘'  button.icon-btn [다음 달]   // aria-label '이전 달'/'다음 달' (주간·일간은 기존 문구)
  div.grow
  div.seg[role=group][aria-label=보기]  button '월간' · '주간' · '일간'   (aria-pressed 문자열)
  button.btn.btn-sm '+ 일정 추가'
```
- `mem = { mode, anchor, scrolled, sideOpen, ctxFilter, picking, day, dirty }`. `mode`는 처음 렌더 때 `S.state.prefs.calendarMode`에서 읽는다(값이 `month|week|day`가 아니면 `'month'`).
- 보기 바꾸기: `mem.mode = m; S.mutate(null, function (s) { s.prefs.calendarMode = m; }, { silent: true }); A.refresh();`
- 이전/다음: 월간은 `anchor`의 달 ±1(앵커는 그 달 1일로 맞춘다), 주간 ±7일, 일간 ±1일. '오늘'은 `anchor = D.ymd(now)`.
- `render(root, params)`: `params.anchor`를 한 번 읽고 지운다(PLAN §5.4). `params.mode`도 같은 방식으로 한 번 읽는다(예: 팔레트에서 주간으로). 앵커가 주어지면 월간은 그 달을 보여 준다.

### 1.2 격자 (`renderer/views/calmonth.js` → `DN.views.calMonth`)
```js
DN.views.calMonth = {
  render(host, ctx) → { el, destroy(), cellFor(ymd) → Element|null, focusDay(ymd), setPicking(taskId|null), paintNow() }
  // ctx = { anchor:'YYYY-MM-DD', now, onOpenDay(ymd, opts), onDropTask(taskId, ymd, cellEl), picking: taskId|null }
}
```
- **월요일 시작, 항상 6주(42칸)**: 첫 칸 = `D.startOfWeek(그 달 1일)`. 6주 고정은 끌기 도중 달을 넘겨도 칸 위치가 흔들리지 않게 하려는 것이다.
- 마크업(ARIA grid):
```
div.cm[role=grid][aria-label='2026년 10월'][aria-readonly=true]
  div.cm-weekdays[role=row]  div[role=columnheader] 월 화 수 목 금 토 일
  div.cm-week[role=row] × 6
    div.cm-day[role=gridcell][data-day=YYYY-MM-DD][data-drop=day][tabindex=-1|0][aria-selected?]
              (.is-out 다른 달) (.is-today) (.is-past) (.is-off 근무일 아님) (.is-picking)
      div.cm-day-head
        span.cm-num '12'                               // 오늘이면 원형 강조(--primary 배경, --on-primary 글자)
        span.cm-due[title='마감: 보고서, 견적서'] '마감 2'   // 그날 마감인 미완료 할 일 수. 없으면 없음
      div.cm-items
        button.cm-item.allday.ext[tabindex=-1] '연차'             // 종일 Google 일정(여러 날이면 걸친 날마다)
        button.cm-item.work(.is-done)[tabindex=-1] '19:30 빨래 돌리기'
        button.cm-item.event[tabindex=-1] '14:00 팀 회의'
        button.cm-item.ext(.is-tentative)[tabindex=-1] '10:00 주간 회의'
        button.cm-more.link-btn[tabindex=-1] '+2개 더'
      div.cm-fit[aria-hidden=true]                      // 끌기 중 그 칸 위에 있을 때만: '19:30 추천' · '빈 시간 없음' · '업무는 근무일에만'
      div.cm-dwell[aria-hidden=true]                    // 머무르기 진행 막대 (§4)
```
- 항목: `M.calendarItems(st, 그날 0시 ISO, 다음날 0시 ISO)`. 종일 항목(`allDay`)은 겹침 기준으로 걸친 모든 날에 맨 위. 시각 있는 항목은 **그날 시작한 것만**(PLAN C27 필터 `D.ymd(x.start) === key`), 시작순 → 긴 것 먼저 → id. 지운 할 일의 블록은 `calendarItems`가 이미 뺀다.
- 글자: `HH:MM 제목`(일 블록은 할 일 제목, 일정은 `b.title||'일정'`, Google은 `title`). 끝낸 할 일의 블록은 `.is-done`(취소선).
- 넘침: 데스크톱은 칸당 **3줄**(종일 포함). 넘치면 마지막 줄 대신 `+N개 더`. 누르면 하루 패널을 연다.
- 항목 클릭: 일·일정 → `DN.views.schedule.open({ blockId })`, Google → `DN.views.extEvent.open(item, el)`(가드). 클릭은 칸의 "하루 열기"로 번지지 않게 `stopPropagation`.
- 빈 곳 클릭/탭 → `ctx.onOpenDay(ymd, { focus: true })`.
- `.is-past`(오늘 이전): 글자색만 `--text-secondary`. 놓기 대상이지만 놓으면 거절(§3.6).
- `.is-off`: `SL.isWorkingDay(day, wh)`가 거짓인 날. 배경 `--surface-subtle`. (주말 강조 대신 근무 시간 설정을 따른다.)
- 오늘이 아닌 달의 칸(`.is-out`)도 놓기·열기가 된다. 날짜 숫자만 `--text-tertiary`.

### 1.3 키보드
- 격자 안 포커스는 roving tabindex 하나(처음엔 오늘, 오늘이 이 달이 아니면 1일).
- ←/→ 하루, ↑/↓ 한 주, Home/End 그 주 월/일, PageUp/PageDown 이전/다음 달(같은 날짜, 없으면 말일), Enter/Space → 하루 패널 열기(포커스는 패널 제목으로), Esc → (고르기 모드면) 고르기 취소.
- 칸 `aria-label`: `'10월 12일 일요일, 일정 2개, 마감 1개'` (+ `', 오늘'`, `', 쉬는 날'`). 고르기 모드일 때 끝에 `', Enter로 ‘빨래 돌리기’ 넣기'`.
- 달이 바뀌면 같은 위치로 포커스를 옮긴다(`focusDay`).

### 1.4 폰 (≤ 640px, 390px 기준)
- `.cal-layout`은 세로. 왼쪽 패널은 접힌 띠(§2.4).
- 격자: `grid-template-columns: repeat(7, minmax(0, 1fr))`, 칸 높이 52px, 숫자 + **점 최대 3개**(`span.cm-dot.work|event|ext`, 색: `--kind-task`, `--kind-event`, `--text-tertiary`) + 마감 점(`--warning`). 글자 항목·`+N`은 숨긴다.
- 칸을 탭하면 하루 패널이 **아래 시트**(높이 `75dvh`)로 열린다.
- 가로 스크롤 없음(`document.documentElement.scrollWidth === 390`). 칸 터치 영역은 51×52px 이상.

---

## 2. 왼쪽 패널 "배치할 일"

### 2.1 목록
- 제목 `h2 '배치할 일'`, 설명 `div.meta '날짜에 끌어다 놓으면 알맞은 시간에 넣어요. 날짜 위에서 잠깐 기다리면 그날이 열려요.'`
- 대상(`unscheduledTasks(st, now)` — calendar.js 지역 함수): 살아 있고(`M.liveTasks`) 끝나지 않은 할 일 중
  - 끝이 지금 이후인 작업 블록이 하나도 없는 것, **또는**
  - `estimateMinutes`가 있고 `PL.remainingMinutes(st, task, now) ≥ 30`인 것(일부만 넣은 일 — 칩 `남은 1시간 30분`).
- 묶음(이 순서, 빈 묶음은 숨김): `기한 지남`(dueDate < 오늘) · `오늘·내일 마감` · `이번 주 마감`(7일 안) · `나중 마감` · `마감 없음`.
- 묶음 안 정렬: 우선순위(high → normal/null → low) → 마감 날짜·시각 → `createdAt` → id.
- 맥락 거르기: `DN.status && DN.status.isActive()`일 때만 머리 아래 `div.cal-ctx[role=group][aria-label=맥락]`에 `button.pill[aria-pressed]` — `전체` + 목록에 실제로 있는 맥락들(`ST.contextOf(...).value`, `정하지 않음` 포함). `mem.ctxFilter`(저장 안 함).

### 2.2 카드
```
div.unsched[data-task-id][tabindex=0][role=button][aria-roledescription='끌 수 있는 할 일']
     [aria-label='빨래 돌리기, 30분, 마감 없음. 끌어서 날짜에 놓거나 Enter로 넣을 날짜를 골라요']
  span.unsched-grip[aria-hidden=true]            // 터치에서 바로 끌 수 있는 손잡이 (touch-action:none)
  div.row  span.t '빨래 돌리기'   button.btn.btn-xs '넣기'
  div.task-chips  dueChip · estimateChip(없으면 '소요 시간 미정' — 놓을 때 물어본다) · 남은 시간 칩 · 맥락 칩(활성일 때) · 힌트 칩(집중/가벼움, 있을 때만)
```
- `넣기` 버튼과 Enter/Space → 작은 메뉴(`ui.menu`): `날짜 골라서 넣기`(고르기 모드, §2.3) · `시간 직접 정하기…`(`A.scheduleTask(id)`, 대화상자에 추천 칩) · `할 일 열기`.
- 두 번 클릭 → `A.openTask(id)`(지금과 같음).
- 끌기 시작(§2.4): 마우스 왼쪽 버튼을 누르고 4px 움직이면. 터치는 손잡이에서 바로, 카드 몸통에서는 **350 ms 길게 누르기**(그 사이 8px 넘게 움직이면 스크롤로 보고 취소). 버튼·칩 위에서 시작한 포인터는 끌기를 시작하지 않는다.

### 2.3 키보드 대체: 고르기 모드
- `날짜 골라서 넣기` → `mem.picking = taskId`, 월간 보기로 바꾸고(보기 기억은 바꾸지 않음) 격자에 `.is-picking`, 포커스를 그 할 일의 마감일 칸(이 달이면) 또는 오늘 칸으로.
- 머리 위에 `div.cal-pick[role=status]`: `‘빨래 돌리기’를 넣을 날짜를 골라요. 화살표로 옮기고 Enter로 넣어요 · Shift+Enter 그날 열기 · Esc 취소` + `button.link-btn '취소'`.
- Enter = 그 칸에 놓기와 같다(§3, 팝오버 기준 요소는 그 칸). Shift+Enter = 하루 패널을 "이 할 일 넣기" 상태로 열기(§4.4). 폰에서는 고르기 모드에서 칸을 **탭**하면 놓기와 같다(끌기 없이 넣는 기본 길).
- 놓기가 끝나거나 Esc·취소 → 고르기 모드 해제, 포커스를 카드로(다시 그려졌으면 `data-focus-key='unsched:<id>'`로 찾기).

### 2.4 폰의 왼쪽 패널
- 접힌 띠 `button.cal-side-toggle[aria-expanded]` `배치할 일 5개` (폰 기본 접힘, 데스크톱은 늘 펼침). 펼치면 카드가 가로로 흐르는 `div.cal-side-list`(`overflow-x:auto`, 카드 너비 220px, `scroll-snap`). 페이지 가로 스크롤은 생기지 않는다.
- 폰에서 끌기는 손잡이 또는 길게 누르기. 대신 `넣기` → 고르기 모드 → 날짜 탭이 주된 길이다.

---

## 3. 날짜 칸에 놓기 = 자동 배치

### 3.1 흐름 (`renderer/views/calplace.js` → `DN.views.calPlace.dropOnDay(taskId, ymd, anchorEl, opts)`)
```
t = 할 일; 없거나 끝났으면 토스트 '이미 끝낸 일이에요.' 끝
ymd < 오늘          → 토스트 '지난 날짜에는 넣을 수 없어요.' (바꾸는 것 없음)
minutes = PL.remainingMinutes(st, t, now) ?? t.estimateMinutes
minutes == null     → askDuration(anchorEl, t) → (취소면 끝) → minutes, saveEstimate
r = PL.placeOnDay(st, t.id, ymd, { now, minutes, workHours: prefs.workHours })
r.ok                → commit(r) (§3.3)
r.reason==='after_due' → afterDuePopover (§3.5)
그 밖               → failPopover(r) (§3.4)
```

### 3.2 소요 시간 팝오버 `askDuration(anchorEl, task) → Promise<{minutes, save}|null>`
`ui.popover(anchorEl, node, { label: '소요 시간', className: 'dur-pop' })`
```
div.dur-pop-title  '‘빨래 돌리기’ 얼마나 걸릴까요?'
div.dur-chips[role=group][aria-label='소요 시간']
  button.pill '15분' · '30분' · '1시간' · '1시간 30분' · '2시간'      // 누르면 바로 확정
div.field
  input.input#dur-custom[placeholder='직접: 45분, 1:30'][inputmode=text][aria-describedby=dur-err]
  div#dur-err.field-error[role=alert]                               // D.parseDuration 의 message
label.check-row  input[type=checkbox][checked]  '할 일에 소요 시간으로 저장'
div.dur-foot  button.btn.btn-sm '취소'  button.btn.btn-sm.btn-primary '넣기'
```
- 처음 포커스: `30분` 칩. 힌트가 `focus:'deep'`이면 `1시간` 칩에 `.is-suggested`(점선 테두리)와 포커스.
- 직접 입력: Enter 또는 [넣기] → `D.parseDuration(v)`; 실패면 `#dur-err`에 `message`, 팝오버 유지. IME 가드(`e.isComposing || e.keyCode === 229`).
- Esc·바깥 클릭·[취소] → `null`(아무것도 바꾸지 않음).
- 확정 결과는 §3.3 커밋의 **같은 mutate** 안에서 저장한다(체크가 켜져 있으면 `M.updateTask(s, id, { estimateMinutes: minutes }, now)` → 출처 `'user'`). 체크가 꺼져 있으면 블록만 그 길이로 만든다.
- 팝오버는 끌기가 끝난 뒤(포인터를 놓은 뒤) 연다. 기준 칸이 다시 그려져 사라지면 `calMonth.cellFor(ymd)`로 다시 찾는다.

### 3.3 커밋과 토스트
```js
S.mutate('일정에 배치', function (s) {
  if (save) M.updateTask(s, t.id, { estimateMinutes: minutes }, now);
  M.addBlock(s, r.block);                       // { taskId, kind:'work', start, end } — 새 필드 없음
}, { source: 'calendar' });
```
- 토스트(여러 버튼 — §7.4 `ui.toast` 확장):
  `‘빨래 돌리기’를 10/12(일) 19:30–20:00에 넣었어요.` (오늘·내일이면 `오늘 19:30–20:00`) + (소요 시간을 저장했으면 ` 소요 시간도 30분으로 저장했어요.`)
  버튼: **[다른 시간]** **[되돌리기]**. 지속 9초.
- [다른 시간] → `alternativesPopover(blockId, ymd)`: 기준은 `calMonth.cellFor(ymd)`(없으면 일정 대화상자 `schedule.open({blockId})`로 대신).
```
div.pl-why-title '이 시간에 넣은 까닭'
ul.pl-why  li × 1–3   (r.candidate.reasons)
div.pl-alt-title '다른 후보'
button.pl-alt × ≤3   '20:30–21:00 · 남은 빈 시간을 한 덩어리로 남겨요'   // PL.suggestSlots(…, {ignoreBlockId: blockId}) 에서 지금 시간을 뺀 상위 3
button.link-btn '그날 열어서 직접 고르기'   → 하루 패널(§4.4, 이 블록을 옮기는 상태)
```
  후보를 누르면 `S.mutate('일정 변경', updateBlock(start,end), {source:'calendar'})` + undoToast `10/12(일) 20:30–21:00으로 옮겼어요.`
- "왜 이 시간?"은 이 팝오버의 첫 부분이다. 하루 패널의 블록 툴팁(`title`)에는 붙이지 않는다(이유는 저장하지 않으므로 넣은 직후에만 보인다).

### 3.4 넣을 자리가 없을 때 `failPopover(r)` (기준: 그 칸)
```
div.pl-fail-title  r.message                    // 예: '10/12(일)에는 30분 빈 시간이 없어요.'
div.meta           r.detail                     // 예: '퇴근 후(18:30–22:30)가 일정으로 차 있어요.'
(r.split) div.meta  '나눠서 하면 들어가요: 첫 1시간 30분을 넣고 나머지 1시간은 나중에.'
div.pl-fail-actions
  (r.alternatives[0]) button.btn.btn-sm.btn-primary '가장 가까운 날로 · 10/13(월) 19:30'
  (r.split)           button.btn.btn-sm '첫 1시간 30분만 넣기'
  button.btn.btn-sm '그날 열어서 직접'
```
- `가장 가까운 날로` → `PL.placeOnDay(st, id, alt.ymd, …)` 결과로 §3.3 커밋.
- `첫 … 만 넣기` → `r.split.first`로 커밋(토스트 끝에 ` 나머지 1시간은 왼쪽 목록에 남아 있어요.`).
- `그날 열어서 직접` → 하루 패널 "이 할 일 넣기"(§4.4).
- 이유별 `message`·`detail`은 코어가 만든다(§5.9).

### 3.5 마감보다 늦은 날 `afterDuePopover`
`마감(10/11(일))보다 늦은 날이에요.` + [마감 전 가장 가까운 날로 · 10/10(토) 09:00] [그래도 이 날에 넣기](`allowAfterDue:true`로 다시 `placeOnDay`) [그날 열어서 직접].

### 3.6 거절과 경계
- 지난 날짜: 위 토스트. 오늘인데 남은 띠가 없으면 코어가 `no_window`와 `오늘은 이 일을 할 시간대가 이미 지났어요.`를 준다.
- 끝낸 할 일·지운 할 일: 토스트, 바꾸는 것 없음.
- Google 일정을 끌 수는 없다(월간 항목은 끌기 대상이 아니다).
- 놓은 결과가 겹칠 수 없다(코어가 바쁜 시간을 피한다). 저장 직전에 최신 상태로 `placeOnDay`를 다시 부르므로 팝오버가 떠 있던 사이 바뀐 일정에도 맞다.

---

## 4. 머무르기(1초) → 띵 → 하루 패널에서 직접 넣기

### 4.1 타이머
- 끌기 중 포인터 아래의 `[data-drop=day]` 칸이 바뀌면 `dwell = { ymd, t0 }`로 새로 시작. 같은 칸 안에서 움직이는 것은 재시작하지 않는다. 칸을 벗어나면 취소.
- 상수: `DWELL_MS = 1000`, `DING_MS = 300`. 진행 표시: 칸 아래 `div.cm-dwell`이 `transform: scaleX(0→1)`로 1000 ms 동안 차오른다(동작 줄이기면 표시 없음).
- 1000 ms가 되면:
  1. 칸에 `.is-ding`(300 ms). 포인터 종류가 `touch`|`pen`이고 `navigator.vibrate`가 있으면 `try { navigator.vibrate(20) } catch (e) {}`.
  2. 300 ms 뒤 `calDay.open(ymd, { dragging: true, openedBy: 'dwell', taskId })`. 끌기는 그대로 이어진다(유령도 그대로).
- 이미 패널이 같은 날로 열려 있으면 아무것도 하지 않는다. 다른 날 칸에서 다시 1초 머무르면 패널이 그날로 바뀐다.
- 끌기 중 `이전 달`/`다음 달` 버튼 위에 **700 ms** 머무르면 달을 넘긴다(칸 위치는 6주 고정이라 그대로).

### 4.2 "띵" 애니메이션 (위치·크기만 움직인다 — UX 규칙)
```css
@keyframes cm-ding {
  0%   { transform: scale(1)    rotate(0); }
  20%  { transform: scale(1.03) rotate(-1.2deg); }
  45%  { transform: scale(1.03) rotate(1.2deg); }
  70%  { transform: scale(1.02) rotate(-0.6deg); }
  100% { transform: scale(1)    rotate(0); }
}
.cm-day.is-ding { animation: cm-ding 300ms var(--ease); box-shadow: inset 0 0 0 2px var(--primary); position: relative; z-index: 2; }
@media (prefers-reduced-motion: reduce) { .cm-day.is-ding { background: var(--primary-soft); } }
.reduce-motion .cm-day.is-ding { background: var(--primary-soft); }
```
`styles.css`의 전역 규칙이 동작 줄이기에서 `animation`을 끄므로, 그때는 테두리 + 배경 강조만 남는다(움직임 없음). 시간(300 ms 뒤 열기)은 같다.

### 4.3 하루 패널 (`renderer/views/calday.js` → `DN.views.calDay`)
```js
DN.views.calDay = {
  open(ymd, opts) → void      // opts { dragging?, openedBy:'dwell'|'click'|'pick'|'alt'|'fail', taskId?, blockId?, focus? }
  close(reason) → void        // reason 'esc'|'button'|'cancel'|'drop-outside'|'nav'
  isOpen() → bool,  ymd() → string|null,  repaint() → void
}
```
- 데스크톱: `.cal-main` 안 오른쪽 시트 `aside.cd-sheet[role=region][aria-label='10월 12일 일요일 시간표']`, 너비 `min(400px, 45%)`, 위아래 꽉, `--shadow-float`, `--surface-raised`. 들어올 때 `slideIn`(위치만).
- 폰: 아래 시트 `75dvh`, 위 모서리 둥글게, 손잡이 막대. 시트 밖(월간 격자 위쪽)은 그대로 보이고 탭하면 닫힌다.
- 머리:
```
div.cd-head
  h3[tabindex=-1] '10월 12일 일요일'
  div.meta '쉬는 날 · 빈 시간 9시간 30분'           // 띠 이름은 PL.dayBands 의 label, 빈 시간 = 허용 띠 안 빈 분 합(모든 맥락 기준 07:00–23:00)
  button.btn.btn-sm '이 날 자동 배치'               // §6
  button.icon-btn[aria-label=닫기]
(taskId 가 있을 때) div.cd-task
  div '‘빨래 돌리기’ 넣기 · 30분'                  // 소요 시간이 없으면 '소요 시간 미정 — 놓으면 물어봐요'
  ol.cd-sugg-list  li > button.cd-sugg-btn × ≤3   '① 19:30–20:00 · ‘퇴근 후’라 ‘집안일’ 하기 좋은 시간이에요'
```
- 몸통: 하루 시간표(지금 주·일 보기와 같은 `HOUR_PX=48`, 0–24시, 15분 칸). `div.cd-col[data-drop=slot][data-day=ymd][data-autoscroll]` 안에 블록·Google 항목(`M.calendarItems`, 차선 계산은 지역 객체), 종일 줄, 지금 선(오늘이면). 처음 스크롤: 추천 1순위 시작 −1시간, 없으면 07:00.
- **추천 띠**: `taskId`가 있으면 `PL.suggestSlots(st, taskId, ymd, { now, minutes, limit: 3 })`를 `div.cd-sugg[style top/height]` + `span.cd-rank '1'`로 그린다(`title`= 이유 이어 붙임). 허용 띠 밖은 `div.cd-band.is-off`(옅은 빗금, `--surface-hover` 반복 그라디언트)로 보인다.
- **유령 블록**(끌기 중 패널 위): `div.cd-ghost` 15분 스냅, 높이 = minutes(없으면 30분 + `소요 시간 미정` 꼬리), 글자 `19:30–20:00`. `SL.conflicts(SL.collectBusy(…))`가 있으면 `.is-conflict` + `· 겹침 N건`. 허용 띠 밖이면 `.is-offband` + `· 추천 시간대 밖`. **자석**: 유령 시작이 추천 시작과 10px 이내면 그 시작으로 붙고 `· 추천 1`.
- 놓기(패널): 소요 시간이 없으면 §3.2 팝오버(기준: 유령 요소, 팝오버가 닫힐 때까지 유령을 남긴다) → 그 시작 시각으로 `S.mutate('일정에 배치', …)`. 겹치면 그래도 넣고 토스트 끝에 ` 다른 일정과 겹쳐요.`(직접 고른 시간은 사용자의 뜻). 토스트: `‘빨래 돌리기’를 10/12(일) 19:30–20:00에 넣었어요.` + [되돌리기].
- 패널 안 블록도 끌어서 옮길 수 있다(`kind:'block'`, 잡은 위치 오프셋 유지) → `'일정 변경'`. Google 항목은 끌 수 없다.
- 놓은 뒤 패널은 열린 채 새 블록을 잠깐 강조(`.is-new`, 1.2 s 배경)한다.
- 닫기: Esc(끌기 중이면 끌기 취소가 먼저 — §4.5), 닫기 버튼, 다른 화면으로 이동, 폰에서 시트 밖 탭. `openedBy:'dwell'`로 열린 패널은 **끌기가 취소되거나 대상 밖에 놓이면 함께 닫힌다**. 닫으면 포커스를 그 칸으로 돌려준다(키보드로 열었을 때).

### 4.4 끌기 없이 직접 넣기 (키보드·폰)
- `calDay.open(ymd, { taskId, openedBy:'pick' })`이면 머리의 추천 버튼(① ② ③)이 놓기와 같다: 누르면 그 시간으로 커밋(소요 시간 없으면 먼저 §3.2).
- 추천이 없으면 `이 날에는 알맞은 빈 시간이 없어요.` + [시간 직접 정하기…] → `schedule.open({ taskId, start: 그날 09:00 })`.
- `blockId`로 열면(§3.3 "그날 열어서 직접") 같은 목록이 "이 블록 옮기기"가 되고 커밋 라벨은 `'일정 변경'`.

### 4.5 취소 규칙
- Esc(끌기 중) → 끌기 취소, 유령 제거, 머무르기 타이머 취소, dwell로 연 패널 닫기. 바꾸는 것 없음.
- 놓을 대상(`[data-drop]`) 밖에 놓기 → 취소와 같다.
- `pointercancel`(터치 스크롤 전환 등) → 취소와 같다.
- 끌기 중 다른 창으로 포커스가 나가면(`blur`) 취소.

---

## 5. 배치 알고리즘 — `src/core/planner.js` (`DN.planner`, `PL`)

### 5.1 모듈 머리
```js
'use strict';
// 할 일을 어느 날 어느 시간에 둘지 고른다. 상태를 바꾸지 않는다. now 를 꼭 넘긴다.
// 하루를 띠(출근 전·업무·점심·퇴근 후·늦은 밤 / 쉬는 날)로 나누고, 할 일의 맥락·걸어 둔 상태·배치 힌트로
// 띠마다 띄움/보통/내림/숨김을 정한 뒤, 15분 칸 후보를 바쁜 시간(Daynote 블록 + Google)을 피해 만들고 점수를 매긴다.
(function (factory) {
  var node = typeof module !== 'undefined' && module.exports;
  var opt = function (name) { try { return require('./' + name); } catch (e) { return null; } };
  var deps = node
    ? { dates: require('./dates'), model: require('./model'), slots: require('./slots'), status: opt('status') }
    : { dates: window.Daynote.dates, model: window.Daynote.model, slots: window.Daynote.slots, status: window.Daynote.statusCore || null };
  var api = factory(deps.dates, deps.model, deps.slots, deps.status);
  if (node) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.planner = api; }
})(function (D, M, SL, ST) { … });
```

### 5.2 내보내기 (binding)
```js
STEP_MIN = 15; MIN_CHUNK = 30; COMMUTE_MIN = 30; EVENING_END = '22:30'; DAY_OFF_CORE = ['09:00','21:00'];
WEIGHTS                                            // §5.7 표 (얼린 객체)
ruleHints(title) → { focus, energy, prefer, splittable }                      // §5.3 (모두 null 가능)
hintsOf(task) → { focus, energy, prefer, splittable, src: { focus:'user'|'ai'|'rule'|null, … } }
remainingMinutes(state, task, now) → int|null      // estimate − (끝이 now 이후인 이 할 일 작업 블록 분 합, 진행 중은 남은 분만). estimate 없으면 null. 0 미만은 0
taskMode(state, task, opts) → { ctx: ctxId|null, ctxSource, atMode, statusActive: bool, profile: Profile|null }
dayBands(state, ymd, opts) → Band[]                // §5.4 (할 일과 무관한 띠 모양 + 상태 id + 라벨)
windowsFor(state, task, ymd, opts) → Window[]      // §5.5 (수준이 붙은 허용 창, 'hide' 제외, 이어진 창은 합침)
suggestSlots(state, taskId, ymd, opts) → Candidate[]          // 점수 내림차순, 다양성 적용, 길이 ≤ opts.limit(기본 5)
placeOnDay(state, taskId, ymd, opts) → PlaceOk | PlaceFail
nearestDay(state, taskId, fromYmd, opts) → { ymd, candidate } | null
arrangeDay(state, taskIds, ymd, opts) → { placements: [{ taskId, candidate, block }], skipped: [{ taskId, reason }], minutes }
splitPlan(state, taskId, ymd, opts) → null | { first: Candidate, chunkMinutes, restMinutes }
fmtDay(date, now) → '오늘' | '내일' | '10/12(일)';  fmtRange(start, end) → '19:30–20:00'
```
공통 `opts`:
```js
{ now: Date (필수),
  minutes?: int,              // 없으면 remainingMinutes ?? task.estimateMinutes
  workHours?,                 // 없으면 state.prefs.workHours (SL.normalizeWorkHours 를 거친다)
  profile?,                   // 없으면 ST ? ST.profile(state.prefs) : null
  statusActive?: bool,        // 없으면 ST ? ST.isActive(state, profile) : false
  noStatus?: true,            // 시험용: ST 가 없는 것처럼
  external?: ExternalEvent[], // SL.collectBusy 로 넘김 (시험용)
  ignoreBlockId?,             // 옮기는 블록은 바쁜 시간에서 뺀다
  extraBusy?: [{ start: ms, end: ms, taskId? }],   // arrangeDay 가 앞서 둔 것
  allowAfterDue?: bool,
  limit?: int,                // suggestSlots 개수 (기본 5)
  historyDays?: int }         // 기록 친화도 창 (기본 28)
```
Shapes:
```js
Band      = { band: 'morning'|'work'|'lunch'|'evening'|'late'|'dayoff_edge'|'dayoff', start: Date, end: Date, statusId, label }
Window    = { start: Date, end: Date, parts: [{ band, start, end, level, statusId, label }] }   // level ∈ up|normal|down
Candidate = { start: Date, end: Date, startIso, endIso, minutes, score, fit: 'good'|'ok'|'poor',
              level, band, statusId, label, reasons: [string 1..3], terms: { key: number } }
PlaceOk   = { ok: true, candidate, block: { taskId, kind: 'work', start: ISO, end: ISO }, reasons, alternatives: Candidate[] (≤2) }
PlaceFail = { ok: false, reason: 'missing'|'done'|'no_estimate'|'past'|'after_due'|'no_window'|'too_long'|'no_slot',
              message, detail: string|null, alternatives: [{ ymd, candidate }] (≤1), split: splitPlan|null }
```

### 5.3 배치 힌트 — 규칙 짐작 `ruleHints(title)`과 합치기 `hintsOf(task)`
- 낱말: 제목을 소문자·NFC로, `[\s,./·()\[\]!?~:;'"“”‘’]+`로 자른 토큰. 키워드는 **토큰 머리에서 시작**할 때만 맞는다. 띄어 쓴 키워드(예: `한 번에`)는 공백을 뺀 글에서 토큰 머리 위치에 있을 때 맞는다(STATUS §6.2 `spacedAt`과 같은 방식). '가장 뒤'는 맞은 위치(공백 뺀 글 기준 시작 인덱스)로 비교한다.
- `focus`: 아래 두 목록 중 **제목에서 가장 뒤에 나온** 키워드의 쪽(우리말은 끝의 동작이 일의 성격을 정한다: "보고서 메일로 보내기" → 메일 → light).
  - deep: `보고서 기획 설계 공부 발표 제안서 논문 과제 분석 작성 개발 코딩 리뷰 검토 계획 기획서 시험 문서 연구 집필 번역 정리본`
  - light: `전화 통화 메일 문자 카톡 연락 답장 주문 예약 결제 송금 이체 신청 확인 출력 제출 버리기 분리수거 사기 구매 반납 등록 정리`
- `energy`: high — `운동 헬스 러닝 달리기 조깅 청소 대청소 이사 장보기 등산 수영 산책 빨래`; low — `읽기 독서 듣기 시청 보기`. 둘 다 있으면 뒤에 나온 쪽.
- `prefer`: 토큰 `아침 오전 출근전` → morning, `오후 점심후` → afternoon, `저녁 밤 퇴근후 자기전` → evening(가장 뒤).
- `splittable`: `조금씩 틈틈이 나눠서 나눠 매일` → true, `한번에 몰아서`·`한 번에` → false(뒤에 나온 쪽). 없으면 null.
- 맞는 것이 없으면 그 필드는 null.
- `hintsOf(task)`:
  - `task.schedHints && task.schedHints.source === 'user'` → 저장값 그대로(사용자의 null = "상관없음"으로 고정, 규칙으로 채우지 않는다). `src`는 값마다 `'user'`.
  - `source === 'ai'` → 필드마다 AI 값이 null이 아니면 AI, 아니면 규칙 값(`src:'rule'`).
  - 없음 → 규칙 값.

### 5.4 하루의 띠 `dayBands(state, ymd, opts)`
`wh = SL.normalizeWorkHours(opts.workHours || state.prefs.workHours)`, `lunch = profile ? profile.schedule.lunch : ['12:00','13:00']`(null이면 점심 띠 없음).

근무일(`SL.isWorkingDay`):
| band | 구간 | 상태 id | 라벨 |
|---|---|---|---|
| `morning` | 07:00 → wh.start − 30분 (길이 < 15분이면 없음) | `off` | 출근 전 |
| `work` | wh.start → wh.end (점심 구간을 뺀 나머지 조각들) | `work` | ‘업무 중’ (= `profile.statuses.work.label`, 없으면 '업무 중') |
| `lunch` | lunch[0] → lunch[1] (근무 창 안에 있을 때만, 잘라서) | `work` | 점심시간 |
| `evening` | wh.end + 30분 → 22:30 (wh.end + 30 ≥ 22:30 이면 없음) | `off` | 퇴근 후 |
| `late` | max(22:30, wh.end + 30분) → 23:00 | `off` | 늦은 밤 |

근무일 아님:
| band | 구간 | 상태 id | 라벨 |
|---|---|---|---|
| `dayoff_edge` | 07:00 → 09:00, 21:00 → 23:00 | `day_off` | 쉬는 날 |
| `dayoff` | 09:00 → 21:00 | `day_off` | ‘쉬는 날’ (`profile.statuses.day_off.label`) |

- 상태 id는 `ST`가 있고 `!opts.noStatus`이면 `ST.timeline(profile, 그날 00:00, 2)`에서 **띠 가운데 시각을 품는 구간의 id**로 다시 정한다(사용자 프리셋에 맞추기 위해). 표의 값은 기본 프리셋에서 그 결과와 같고, `ST`가 없을 때의 값이다.
- 모든 띠는 07:00–23:00(`SL.DAY_WINDOW`) 안이다. 밤샘 근무는 지원하지 않는다(PLAN C4).

### 5.5 띠의 수준 `windowsFor(state, task, ymd, opts)`
1. `mode = taskMode(...)`: `ctx = ST && !noStatus ? ST.contextOf(state, task, profile, now).value : null` (현재 상태가 꺼져 있어도 규칙 맥락은 계산한다 — 화면에는 이름을 보이지 않는다, §5.8), `atMode = task.atMode`.
2. 띠마다 기본 수준:
   - **현재 상태 기능이 켜져 있음**(`statusActive`): `level = profile.matrix[statusId][ctx || '_none']` (행이 없으면 `'normal'`). 사용자 칸(`policy`)과 `afterWork`가 반영된 실제 표를 쓴다.
   - **꺼져 있음 또는 ST 없음** — 고정 표:

| 맥락 \ 띠 | morning | work | lunch | evening | late | dayoff_edge | dayoff |
|---|---|---|---|---|---|---|---|
| `work` | hide | **up** | down | hide | hide | hide | hide |
| `home` `errand` `personal` `family` `study` `u_…` | down | hide | down | **up** | normal | normal | **up** |
| null (모름) | normal | normal | normal | normal | normal | normal | normal |

3. 걸어 둔 상태(`atMode`)가 있으면: 맞는 띠는 **`up`**(숨김이어도 — 사용자가 말한 때가 정책을 이긴다, STATUS §7.4 5단계와 같은 뜻), 맞지 않는 띠는 `hide`는 그대로, 나머지는 `down`.

| atMode | 맞는 띠 |
|---|---|
| `work` | work, lunch |
| `off` | evening, late, dayoff, dayoff_edge |
| `out` | morning, lunch, evening, dayoff |
| `pause` | lunch |
| `rest` | dayoff, dayoff_edge |

4. `hide`인 띠를 버리고, 끝과 시작이 맞닿은 띠는 하나의 창으로 합친다(창 안에 `parts` 유지). 오늘이면 창 시작을 `max(창 시작, SL.roundUp15(now))`로 자르고 빈 창은 버린다.

### 5.6 후보 만들기 (`suggestSlots` 안)
```
task 없음/지움 → []   (placeOnDay 는 'missing')
len = opts.minutes ?? (remainingMinutes > 0 ? remainingMinutes : estimate) ; 없으면 []
busy = SL.collectBusy(state, 그날 00:00 − 1h, 다음날 00:00 + 1h, { ignoreId: opts.ignoreBlockId, external: opts.external })
       + opts.extraBusy           → merged = SL.merge(busy)
dueAt = task.dueDate ? D.parseYmd(dueDate, dueTime || '23:59') : null
for each window W:
  for s = W.start (15분 칸으로 올림); s + len ≤ W.end; s += 15분:
     e = s + len
     merged 와 [s,e) 가 겹치면 건너뜀 (겹친 구간 끝으로 건너뛰어도 된다 — 결과는 같아야 한다)
     dueAt && !allowAfterDue && e > dueAt → 건너뜀
     후보 추가: level = W.parts 중 [s,e) 와 겹치는 것의 **가장 낮은** 수준(up>normal>down), band/statusId/label = s 를 품는 part
점수(§5.7) → 정렬(score 내림, 같으면 start 오름) → 다양성 → limit
```
- **다양성**: 결과를 고를 때 이미 고른 후보와 시작이 60분 안이면 건너뛴다. limit을 못 채우면 건너뛴 것을 점수 순으로 다시 채운다. (칩·추천 띠가 15분 차이 후보로 채워지지 않게.) 1순위는 늘 최고 점수다.
- 같은 입력이면 같은 출력(블록 배열 순서와 무관 — `collectBusy`가 정렬한다).

### 5.7 점수 (가중치는 `WEIGHTS`로 내보내 시험에서 쓴다)
`earliness(s)` = `1 − (s − firstStart) / (lastStart − firstStart)` — 그날 모든 후보 시작 중 최소/최대 기준(같으면 1). `G` = 후보를 품는 빈 구간(창 경계와 바쁜 시간 사이), `a = s − G.start`, `b = G.end − e`.

| key | 조건 | 점수 | 이유 문장(양수일 때 후보 이유) |
|---|---|---|---|
| `level` | up / normal / down | +30 / +10 / −20 | §5.8 수준 문장 |
| `atMode` | 걸어 둔 상태가 맞는 띠 | +0 (수준이 이미 up) | `‘퇴근하고’ 하기로 한 일이에요.` (`ST.atModePhrase`, 없으면 표: 출근하면·퇴근하고·나가는 김에·쉬는 시간에·쉬는 날에) |
| `comfort` | band morning −6 · late −4 · dayoff_edge −4 · lunch(atMode≠pause) −6 | 음수 | – |
| `prefer` | 힌트 prefer와 시작 시각대가 맞음(오전 <12:00, 오후 12–17, 저녁 ≥17) / 다름 | +15 / −5 | `오전에 하기 좋은 일이에요.` · `오후에…` · `저녁에…` |
| `deepEarly` | focus deep, 시작 < 12:00, band ≠ morning | +8 | `집중이 필요한 일이라 이른 시간에 두었어요.` |
| `deepBuffer` | focus deep, 앞쪽 바쁨의 끝 > s − 15분 이면 −10, 뒤쪽 바쁨의 시작 < e + 15분 이면 −10 | 0/−10/−20 | (양수 아님) — 둘 다 0이고 앞뒤 3시간 안에 바쁜 일이 있으면 이유 `앞뒤 일정과 15분 이상 떨어져 있어요.` (점수 +0, 이유만) |
| `lightGap` | focus light, `G ≤ len + 30` | +4 | `짧은 빈틈을 채워요.` |
| `energy` | high: 시작 ∈ [09:00,12:00)∪[15:00,19:00) +6, 시작 ≥ 21:00 −8 · low: 시작 ≥ 19:00 +4 | | high: `기운이 필요한 일이라 낮 시간에 두었어요.` · low: `가볍게 할 수 있는 저녁 시간이에요.` |
| `urgency` | 마감 있음: u = (dueAt ≤ 그날 끝+24h ? 1 : ≤ 3일 ? 0.6 : ≤ 7일 ? 0.3 : 0); 지난 마감 u=1 → `12 × u × earliness` | 0–12 | `마감(10/13(화) 18:00)이 가까워 앞쪽 시간을 골랐어요.` |
| `dueOk` | 마감 있고 e ≤ dueAt | 0 (이유만, 그날이 마감일이거나 u ≥ 0.6일 때) | `마감 전에 끝나요.` |
| `dueTight` | e > dueAt − 60분 | −6 | – |
| `priority` | high: `8 × earliness` · low: `3 × (1 − earliness)` | | high: `우선순위가 높아 앞쪽에 두었어요.` |
| `fragTight` | `G − len ≤ 15` | +6 | `빈 시간에 딱 맞아요.` |
| `fragAlign` | a = 0 → +3, 아니고 b = 0 → +2 | | `남은 빈 시간을 한 덩어리로 남겨요.` |
| `fragCrumb` | 0 < a < 30 → −4, 0 < b < 30 → −4 | | – |
| `shortSmall` | len ≤ 30 이고 G ≤ 60 | +4 | `짧은 일이라 작은 빈틈에 넣었어요.` |
| `project` | 할 일에 projectId가 있고, s에 끝나거나 e에 시작하는(±15분) 작업 블록의 할 일이 같은 프로젝트 | +5 | `같은 프로젝트 ‘온보딩 개선’ 일과 이어져요.` |
| `history` | 최근 `historyDays`(28)일, now 이전에 끝난 작업 블록 중 할 일 맥락(`ST.contextOf().value`, 없으면 null끼리)이 같은 것: 2시간 단위 시작 구간별로 세어, 후보 시작 구간의 수 ≥ 3 이고 전체의 ≥ 40% | +4 | `평소 이 시간대에 하던 일이에요.` |
| `today` | ymd가 오늘 | `2 × earliness` | – |

- `score` = 합(소수 그대로; 비교는 `1e-9` 허용, 같으면 시작이 이른 쪽). 보이는 값은 소수 첫째 자리 반올림.
- `fit` = level `up` → `'good'`, `normal` → `'ok'`, `down` → `'poor'`.
- `terms`에는 0이 아닌 항만 넣는다(시험·디버그용).

### 5.8 이유 문장 (후보마다 1–3개)
1. 첫 문장(있으면):
   - 걸어 둔 상태가 맞음 → `‘퇴근하고’ 하기로 한 일이에요.`
   - 아니고 level `up`:
     - 현재 상태 켜짐 + ctx 있음 → `‘퇴근 후’라 ‘집안일’ 하기 좋은 시간이에요.` (띠 라벨, `ST.contextLabel(profile, ctx)`)
     - 꺼짐: ctx `work` → `근무 시간 안이에요.` / 그 밖 → `근무 시간 밖이라 개인 일 하기 좋은 시간이에요.` (꺼져 있으면 맥락 이름을 쓰지 않는다 — PLAN C23)
   - level `down`이고 이것이 1순위 → `‘업무 중’ 시간이라 알맞은 때는 아니지만 다른 빈 시간이 없어요.` (띠 라벨)
2. 나머지: 양수 항의 이유를 점수 큰 순(같으면 표 순서)으로, 첫 문장과 합쳐 3개까지. 같은 문장은 한 번만.
3. 아무것도 없으면 `비어 있는 시간이에요.`

### 5.9 `placeOnDay` — 실패 이유와 문구
순서대로 판정한다.
| reason | 조건 | message | detail |
|---|---|---|---|
| `missing` | 할 일 없음·지움 | `할 일을 찾지 못했어요.` | null |
| `done` | `status==='done'` | `이미 끝낸 일이에요.` | null |
| `no_estimate` | 길이 없음 | `소요 시간을 먼저 정해 주세요.` | null |
| `past` | ymd < 오늘(now) | `지난 날짜에는 넣을 수 없어요.` | null |
| `after_due` | dueDate < ymd && !allowAfterDue | `마감(10/11(일))보다 늦은 날이에요.` | null |
| `no_window` | 허용 창이 없음 | 오늘이고 띠가 모두 지났으면 `오늘은 이 일을 할 시간대가 이미 지났어요.` / ctx work & 근무일 아님: 상태 켜짐 `‘업무’ 일은 ‘쉬는 날’에는 넣지 않아요.` · 꺼짐 `근무 시간에 할 일이라 쉬는 날에는 넣지 않았어요.` / 그 밖 `이 날에는 이 일을 할 시간대가 없어요.` | null |
| `too_long` | len > 가장 긴 허용 창 길이 | `‘보고서 작성’(5시간)은 이 날 넣을 수 있는 가장 긴 시간(4시간 30분)보다 길어요.` | null |
| `no_slot` | 후보 없음 | `10/12(일)에는 30분 빈 시간이 없어요.` | 가장 넓은(up 우선) 창: `퇴근 후(18:30–22:30)가 일정으로 차 있어요.` (마감 때문이면 `마감(18:00) 전에는 빈 시간이 없어요.`) |

- 실패에는 `alternatives = [nearestDay(…)]`(찾으면 1개), `split = (too_long||no_slot) ? splitPlan(…) : null`.
- 성공: 1순위 후보로 `block = { taskId, kind:'work', start: startIso, end: endIso }`, `alternatives` = 다양성 적용 2·3순위.
- `durationGuessed`는 넣지 않는다(사용자가 길이를 정했거나 할 일의 값이다).

### 5.10 `nearestDay(state, taskId, fromYmd, opts)`
- 거리 1, 2, … `opts.days`(기본 14)까지, 같은 거리면 **이른 날 먼저**(fromYmd−k, fromYmd+k). 오늘 이전은 건너뛴다. 마감이 있고 `!allowAfterDue`이면 마감일 이후는 건너뛴다. fromYmd 자신은 보지 않는다.
- 각 날 `suggestSlots(…, {limit:1})`의 1순위가 있으면 `{ ymd, candidate }`. 없으면 null.
- `after_due`의 대안은 fromYmd가 아니라 **마감일부터 거꾸로**(마감일, 마감일−1, …, 오늘) 찾는다.

### 5.11 `splitPlan(state, taskId, ymd, opts)`
- 나눌 수 있음: `hintsOf(task).splittable === true`, 또는 `splittable == null && len ≥ 120 && focus !== 'deep'`. 아니면 null.
- `L`을 `min(len − 30, 가장 긴 허용 창)`에서 30까지 15분씩 줄이며 `suggestSlots(…, {minutes:L, limit:1})`가 처음 결과를 내는 L. 없으면 null.
- `{ first: 그 후보, chunkMinutes: L, restMinutes: len − L }`. **v1은 첫 조각만 넣는다**(D9). 자동으로 여러 날에 나누지 않는다.

### 5.12 `arrangeDay(state, taskIds, ymd, opts)` — "이 날 자동 배치"
1. 건너뛰기: 없음·끝남(`missing`/`done`), 길이 없음(`no_estimate`), 열린 선행 업무(`blockedBy`에 끝나지 않은 할 일 → `blocked`), `snoozedUntil` > 그날 끝(`snoozed`), ymd < 오늘(`past` — 전부).
2. 순서 키(오름차순): 마감 등급(dueDate ≤ ymd: 0, ≤ ymd+2: 1, ≤ ymd+7: 2, 그 밖 마감: 3, 없음: 4) → 우선순위(high 0, normal/null 1, low 2) → 그날 가장 좋은 띠 수준(up 0, normal 1, down 2, 창 없음 3) → 길이 큰 것 먼저 → createdAt → id.
3. 탐욕: 순서대로 `suggestSlots(state, id, ymd, {…opts, extraBusy: 지금까지 둔 것, limit: 1})`. 후보가 있고 `fit !== 'poor'`(또는 `opts.includePoor`)이면 둔다. 없으면 `skipped`(`no_slot`/`no_window`/`poor_fit`).
4. 멈춤: `opts.maxTasks`(기본 6), 둔 분 합이 `opts.maxMinutes`(기본 480)를 넘게 되는 할 일은 `skipped:'limit'`.
5. 반환은 상태를 바꾸지 않는다. `minutes` = 둔 분 합.

### 5.13 순수성·시간대
- 상태를 바꾸지 않는다(시험: 전후 `JSON.stringify` 같음). 시계를 읽지 않는다. 모든 띠 경계는 현지 시각(`D.startOfDay` + 분), 비교는 밀리초.
- `TZ=UTC`, `TZ=Asia/Seoul` 둘 다 같은 기대값(현지 기준으로 쓴 시험).

---

## 6. "이 날 자동 배치" (하루 패널 머리 버튼)
- 대상 = 왼쪽 목록의 할 일(맥락 거르기가 있으면 그 결과) 중 `PL.remainingMinutes`/`estimateMinutes`가 있는 것.
- `r = PL.arrangeDay(st, ids, ymd, { now, workHours })` → 미리보기 팝오버(기준: 버튼, `className:'pl-arrange'`):
```
div.pl-arr-title '10/12(일)에 4개를 이렇게 넣을까요?'
ul  li > label.check-row  input[type=checkbox][checked]  '09:00–10:30 분기 보고서 초안' + div.meta(이유 첫 문장)
div.meta '소요 시간이 없어 뺀 일 2개 · 빈 시간이 없어 뺀 일 1개'      // skipped 요약 (있을 때만)
button.btn.btn-sm '취소'  button.btn.btn-sm.btn-primary '넣기 (4개)'
```
- 체크를 끄면 그 항목만 뺀다(다른 항목의 시간은 다시 계산하지 않는다 — 이미 겹치지 않으므로).
- [넣기] → 저장 직전에 같은 입력으로 `arrangeDay`를 다시 불러 결과가 같으면 그대로, 다르면 새 결과로 미리보기를 다시 그린다(그 사이 바뀐 일정에 넣지 않게). 같으면 `S.mutate('자동 배치', 고른 블록 모두 addBlock, { source: 'calendar' })` + undoToast `10/12(일)에 4개를 넣었어요.`
- 아무것도 둘 수 없으면 버튼 대신 `넣을 수 있는 일이 없어요.` + skipped 요약.

---

## 7. 다른 화면과의 연결

### 7.1 일정 대화상자 추천 칩 (`renderer/views/schedule.js`, W2-schedule)
- 할 일 배치(`task && !block`)와 작업 블록 변경(`task && block`)일 때만. 날짜 입력 위, 길이 행 아래에:
```
div.field
  label '추천 시간'
  div.sched-sugg[role=group][aria-label='추천 시간']
    button.pill.sched-sugg-chip × ≤3  '19:30 · 퇴근 후'      // title = 이유 이어 붙임
  div.help (첫 칩의 첫 이유)                                   // aria-live 아님
```
- 계산: `PL.suggestSlots(S.state, task.id, dateIn.value, { now, minutes: Number(durIn.value), ignoreBlockId: block && block.id, limit: 3 })`. 날짜·길이가 바뀔 때마다 다시(시각 입력이 바뀔 때는 다시 하지 않는다).
- 칩 라벨: `HH:MM · {띠 라벨}`(오늘이 아니어도 날짜는 입력란에 있으므로 시각만). 누르면 `timeIn.value` 설정 + `update()` + 그 칩 `aria-pressed='true'`.
- 결과가 없으면 `이 날에는 추천할 시간이 없어요.` + `button.link-btn '가까운 날 보기'` → `PL.nearestDay` 결과로 `dateIn`·`timeIn` 설정.
- 처음 열 때 시작 시각: `opts.start`가 없고 할 일이면 **오늘(또는 마감일이 오늘보다 앞이면 오늘)의 1순위**, 없으면 `nearestDay(오늘)`, 그것도 없으면 지금의 `findFreeSlot`. FEATURES §3.2 충돌 상태 기계는 그대로.
- `DN.planner`가 없으면(부분 병합) 칩 줄을 그리지 않는다.

### 7.2 상세 패널 "배치 힌트" (`renderer/views/detail.js`, W2-status)
- 소요 시간 행 아래, 현재 상태 활성 여부와 무관하게 항상:
```
div.detail-row  label '배치 힌트'
  div.seg[role=group][aria-label='일의 성격']  '상관없음' · '집중 필요' · '가벼운 일'   (focus null/deep/light)
  select.select[aria-label='하기 좋은 때']  상관없음 / 아침·오전 / 오후 / 저녁                  (prefer)
  label.check-row  input[type=checkbox]  '나눠서 해도 돼요'                                (splittable true / false)
  div.meta  'AI가 짐작했어요' | '제목으로 짐작했어요' | (사용자 값이면 없음)
```
- 현재 값은 `PL.hintsOf(task)`(가드: 없으면 행을 그리지 않음). 체크박스: `splittable === true`면 체크.
- 바꾸면: `save({ schedHints: { focus, energy, prefer, splittable, source: 'user', at: now ISO } }, '배치 힌트 바꾸기')` — 지금 보이는 유효값 전체를 사용자 값으로 고정한다(`energy`는 UI가 없으므로 유효값을 그대로 담는다). 화면은 그 자리에서 바뀌므로 detail onChange 정규식에 넣지 않는다.

### 7.3 오늘·추천 화면
- 바꾸지 않는다. (추천은 "지금 무엇을", 플래너는 "언제"를 정한다.)

### 7.4 `ui.toast` 여러 버튼 (W2-status, `renderer/ui.js`)
- `toast(msg, { actions: [{ label, fn }], duration })` 지원 추가. `action`(하나)도 그대로. 버튼 순서 = 배열 순서, 그 뒤 '닫기'. 버튼을 누르면 닫고 `fn()`.
- 기능 표시: `DN.ui.TOAST_ACTIONS = true`. calendar 쪽은 `ui.TOAST_ACTIONS ? toast(msg, {actions:[…], duration:9000}) : undoToast(msg)`.

---

## 8. AI가 함께 주는 값 (`sched`) — W2-ai

### 8.1 스키마 (`src/core/ai/capture.js`, `capture.v7` — PLAN C5의 v7에 규칙 N으로 더한다)
```js
var sched = obj({
  focus:      { anyOf: [{ type: 'string', enum: ['deep', 'light'] }, { type: 'null' }] },
  energy:     { anyOf: [{ type: 'string', enum: ['high', 'low'] }, { type: 'null' }] },
  prefer:     { anyOf: [{ type: 'string', enum: ['morning', 'afternoon', 'evening'] }, { type: 'null' }] },
  splittable: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
  minutes:    { anyOf: [{ type: 'integer' }, { type: 'null' }] }
});
SCHEMA.properties.tasks.items.properties.sched = sched;   // required 재계산은 기존 줄(Object.keys)이 한다
```
(엄격성 walker: 모든 객체 `additionalProperties:false`, 모든 속성 required — `obj()`가 만족한다.)

### 8.2 프롬프트 규칙 N (SYSTEM 끝, M 다음)
```
N. 배치 힌트: tasks 마다 sched 를 채웁니다. 글이나 할 일의 성격으로 분명할 때만 값을 넣고, 아니면 null 입니다. 지어내지 마세요.
   focus: 오래 생각하거나 글을 써야 하는 일(보고서·기획·설계·공부·발표 자료 등) "deep", 짧게 끝나는 연락·주문·정리 "light".
   energy: 몸을 쓰는 일(운동·청소·장보기 등)이나 '기운 있을 때'라고 하면 "high", '피곤해도·가볍게'라고 하면 "low".
   prefer: '아침에·오전에' morning, '오후에' afternoon, '저녁에·밤에' evening 처럼 하고 싶은 때가 글에 나올 때만. 시각이 정해진 일(do_at)은 null.
   splittable: '조금씩·틈틈이·나눠서' true, '한 번에·몰아서' false, 말이 없으면 null.
   minutes: '30분·1시간 반 걸려'처럼 걸리는 시간이 글에 직접 나올 때만 그 분(정수). 마감·시작 시각과 헷갈리지 마세요. 짐작하지 마세요.
```

### 8.3 검증 (`src/core/ai/validate.js`)
- 할 일 항목마다 `item.sched` = `{ focus, energy, prefer, splittable, minutes }`:
  - enum 밖·형식 오류는 그 필드만 null.
  - `prefer`는 그 할 일에 `do_at`(시각 정한 할 일)이 있으면 null.
  - `minutes`는 5–720 정수이고, 근거 `quote`에 `relativeMinutes`/`D.parseDuration`로 읽히는 길이 표현이 있고 그 값과 같을 때만(예: `quote`의 `1시간 반` → 90). 아니면 null.
  - 다섯 값이 모두 null이면 `item.sched = null`.

### 8.4 적용 (`src/core/ai/proposals.js`)
- `mergeOrganizeRun`: `payload.sched = item.sched || null`.
- `applySelections`(할 일 만들 때) / 늦게 온 AI 결과:
```
if (p.sched && !(t.schedHints && t.schedHints.source === 'user')) {
  var h = { focus: p.sched.focus, energy: p.sched.energy, prefer: p.sched.prefer, splittable: p.sched.splittable };
  if (h.focus != null || h.energy != null || h.prefer != null || h.splittable != null) t.schedHints = Object.assign(h, { source: 'ai', at: iso(now) });
}
if (p.sched && p.sched.minutes != null && t.estimateMinutes == null) { t.estimateMinutes = p.sched.minutes; t.estimateSource = 'ai'; }
```
- `TASK_KEEP` += `'schedHints'`(할 일↔일정 왕복 보존).
- 사용자가 상세에서 고친 값(`source:'user'`)은 AI·다듬기가 절대 바꾸지 않는다. 제목이 바뀌면 AI 힌트는 지운다(§9 model 규칙).

### 8.5 가짜 AI·명령어
- `fake.js`: 할 일마다 `sched: { focus:null, energy:null, prefer:null, splittable:null, minutes: <원문 줄에 길이 표현이 있으면 그 분, 아니면 null> }` (`purpose==='capture'`일 때만). 규칙 짐작은 읽을 때 `PL.hintsOf`가 하므로 가짜 AI가 'ai' 출처로 흉내 내지 않는다.
- `forced.js`: `refineForced`가 AI 항목의 `sched`를 위 §8.4와 같은 규칙으로(`schedHints == null`일 때만, `estimateMinutes == null`일 때만) 옮긴다. `rulesItem`은 바꾸지 않는다(규칙 힌트는 저장하지 않으므로).

---

## 9. 상태 변경 정리

| 곳 | 변경 | 담당 |
|---|---|---|
| `model.js` `normalizeTask` | `schedHints: null` 기본값, `TASK_NULLABLE`에 `'schedHints'` | W1.5-planner |
| `model.js` `updateTask` | 제목이 바뀌고 `t.schedHints && t.schedHints.source === 'ai'`이고 패치에 `schedHints`가 없으면 `p.schedHints = null` | W1.5-planner |
| `prefs.calendarMode` | `'month'\|'week'\|'day'`, 없으면 month. `S.mutate(null, …, {silent:true})` | W2-schedule |
| `SCHEMA_VERSION` | 4 그대로 | – |
| 블록 | 새 필드 없음. `origin:'user'` | – |
| 되돌리기 라벨 | `'일정에 배치'`(놓기·하루 패널 놓기·추천 버튼·가까운 날·첫 조각), `'일정 변경'`(다른 시간·블록 옮기기), **`'자동 배치'`**(arrangeDay), **`'배치 힌트 바꾸기'`**(상세) | – |
| mutate source | 새 `'calendar'` (캘린더·하루 패널·팝오버 쓰기). 설정 화면 건너뛰기 목록에는 넣지 않는다(설정은 그때 열려 있지 않다) | – |

`task.schedHints` 모양: `null | { focus: 'deep'|'light'|null, energy: 'high'|'low'|null, prefer: 'morning'|'afternoon'|'evening'|null, splittable: true|false|null, source: 'ai'|'user', at: ISO }`.

---

## 10. 끌기 엔진 `renderer/dragplace.js` (`DN.dragPlace`)
```js
DN.dragPlace = {
  arm(el, opts) → { destroy() }          // el 에서 시작하는 끌기를 준비 (pointerdown 등록)
  active() → bool,  cancel(),  session() → Session|null
}
opts = {
  payload: function () → { kind:'task'|'block', id, minutes|null, title, offsetMin? },   // 시작할 때 부름
  label: function (payload) → '빨래 돌리기 · 30분',
  grip: '.unsched-grip' | null,          // 터치에서 즉시 시작하는 손잡이
  longPressMs: 350, threshold: 4, touchSlop: 8,
  ignore: 'button, a, input, select, textarea, .chip',     // 여기서 시작한 포인터는 무시
  onStart(s), onOver(target|null, s), onMove(s), onDrop(target|null, s), onCancel(s), onEnd(s)
}
Session = { payload, pointerType, x, y, target /* closest('[data-drop]') */, startedAt }
```
- 시작: 마우스·펜(버튼 0) → `threshold` 이상 움직이면. 터치 → `grip`이면 즉시, 아니면 `longPressMs` 동안 `touchSlop` 안에 머무르면(그 사이 `pointercancel`이나 큰 움직임이면 포기 — 브라우저 스크롤에 양보).
- 시작하면: `el.setPointerCapture(pointerId)`, `document.documentElement.classList.add('dp-dragging')`(`user-select:none; cursor:grabbing`), 유령 `div.dp-ghost`(body 끝, `position:fixed; pointer-events:none; z-index:95`, `transform: translate3d(x+12px, y+12px, 0)`), 원본 `.is-dragging`(점선 테두리 + `--surface-hover` 배경 — 투명도는 쓰지 않는다).
- 터치 스크롤 막기: `arm`이 원본에 **non-passive** `touchmove` 리스너를 달아 `if (active) e.preventDefault()`. 손잡이는 CSS `touch-action:none`, 카드는 `touch-action: pan-x pan-y`.
- 대상 찾기: 매 `pointermove`(rAF로 묶음)에서 `document.elementFromPoint(x, y)`의 `closest('[data-drop]')`. 바뀌면 `onOver`.
- 자동 스크롤: 대상의 `closest('[data-autoscroll]')`(또는 `.cal-scroll`, `.cd-body`) 가장자리 40px 안이면 rAF마다 12px.
- 끝: `pointerup` → `onDrop(target)`; `pointercancel`·Esc(capture keydown, `stopPropagation`)·`window blur` → `onCancel`. 둘 다 끝에 `onEnd`, 유령 제거, 클래스 제거. 놓은 뒤 400 ms 안의 `click`은 한 번 삼킨다(놓기가 칸 클릭 = 하루 열기로 번지지 않게).
- 스크린리더: `div.sr-only#dp-live[aria-live=assertive]`에 `‘빨래 돌리기’ 옮기는 중이에요.` → 대상 바뀔 때 `10월 12일 일요일 위` / `19:30 위` → `넣었어요.` / `취소했어요.`
- 한 번에 하나만. `active()` 동안 다른 `arm`의 pointerdown은 무시한다.

### 10.1 캘린더 다시 그리기 규칙 (끌기·팝오버 보호)
- `calendar.js` 핸들:
  - `onChange(info)`: `DN.dragPlace.active()`이거나 캘린더 팝오버가 열려 있으면(`mem.popOpen`) `mem.dirty = true; return true;`. 아니면 `false`(지금처럼 다시 그림). 하루 패널은 `mem.day`로 다시 그려도 열린 채 복원된다.
  - `onTick()`: 전체 `A.refresh()` 대신 지금 선과 월간 오늘 표시만 고친다(`paintNow`). 날짜가 바뀌었을 때만(`D.ymd(now)` 변화) 그리고 끌기·팝오버가 없을 때 `A.refresh()`.
  - 끌기가 끝나고(`onEnd`) 팝오버도 없으면 `if (mem.dirty) { mem.dirty = false; A.refresh(); }`.
- 주간·일간 보기의 끌기도 이 엔진으로 바꾼다(`div.cal-col[data-drop=slot][data-day]`). 결과·문구는 지금과 같되 `-어요`로: `‘X’ 작업 시간을 오늘 14:00에 넣었어요.` / `오늘 14:00로 옮겼어요.` (+ ` 다른 일정과 겹쳐요.`). 소요 시간 없는 할 일을 놓으면 §3.2 팝오버를 먼저 띄운다(30분 기본값으로 몰래 넣지 않는다).

---

## 11. CSS (`renderer/css/schedule.css`에 모두 — 새 토큰 없음)
클래스 목록(이름 고정): `.cm`, `.cm-weekdays`, `.cm-week`, `.cm-day`(`.is-out .is-today .is-past .is-off .is-over .is-ding .is-picking`), `.cm-day-head`, `.cm-num`, `.cm-due`, `.cm-items`, `.cm-item`(`.work .event .ext .allday .is-done .is-tentative`), `.cm-more`, `.cm-dot`, `.cm-fit`, `.cm-dwell`, `.cal-pick`, `.cal-ctx`, `.cal-side-toggle`, `.unsched`(`.is-dragging`), `.unsched-grip`, `.dp-ghost`, `html.dp-dragging`, `.cd-sheet`, `.cd-head`, `.cd-task`, `.cd-sugg-list`, `.cd-sugg-btn`, `.cd-body`, `.cd-col`, `.cd-sugg`, `.cd-rank`, `.cd-band.is-off`, `.cd-ghost`(`.is-conflict .is-offband`), `.cd-block.is-new`, `.dur-pop`, `.dur-chips`, `.is-suggested`, `.pl-why`, `.pl-alt`, `.pl-fail-actions`, `.pl-arrange`, `.sched-sugg`, `.sched-sugg-chip`.
- 색: 일 블록 `--kind-task(-soft/-ink)`, 일정 `--kind-event`, Google `--surface-subtle` + `--text-secondary`(GOOGLE §9.2), 마감 `--warning-soft/-ink`, 오늘 `--primary`/`--on-primary`, 놓기 위 `.is-over` `box-shadow: inset 0 0 0 2px var(--primary-line)`, 추천 띠 `--success-soft` + 테두리 `--success-line`, 순위 배지 `--success`/`--surface`.
- `.dp-ghost`: `--inverse-bg`/`--inverse-text`, `--r-control`, `--shadow-float`, 최대 너비 240px, 말줄임.
- `.cm-dwell`: 칸 아래 2px, `background: var(--primary)`, `transform-origin: left`, `transform: scaleX(0)`; `.is-dwelling .cm-dwell { transform: scaleX(1); transition: transform 1000ms linear; }` (동작 줄이기에서 전역 규칙이 transition을 끈다 → 막대는 바로 차지 않고 보이지 않게 `display:none`도 같은 미디어/`.reduce-motion`에서 준다).
- 폰(≤640): §1.4, §2.4, `.cd-sheet { position: fixed; left:0; right:0; bottom: calc(56px + env(safe-area-inset-bottom)); height: 75dvh; border-radius: var(--r-panel) var(--r-panel) 0 0; }`, 팝오버 버튼 ≥44px.
- 다크 모드는 토큰이 처리한다(직접 색 금지).

---

## 12. 테스트

### 12.1 `test/planner.test.js` (W1.5-planner) — `node:test`, 고정 시계, 상태는 `M.emptyState()` + `M.addTask/addBlock/addProject`, `TZ=UTC`·`TZ=Asia/Seoul` 모두 통과
고정 시계: `MON = new Date(2026, 9, 5, 10, 0)`(월), `WED = '2026-10-07'`, `FRI = new Date(2026, 9, 9, 18, 42)`, `SAT = new Date(2026, 9, 10, 1, 25)`. 기본 근무 시간(월–금 09–18). "활성" = `state.presence.activatedAt = MON.toISOString()`(필요하면 `ST.ensure` 먼저), 기본 프리셋(office).

**기본·입력**
1. 없는 id → `placeOnDay` `{ok:false, reason:'missing'}`; 끝낸 할 일 → `'done'`; `suggestSlots` 둘 다 `[]`.
2. 소요 시간 없음 + `opts.minutes` 없음 → `'no_estimate'`; `opts.minutes:30` 주면 `ok:true`.
3. 어제(10/4) → `'past'`; 오늘(10/5) → 가능.
4. 오늘: 모든 후보 `start ≥ SL.roundUp15(now)` (now 10:07 → 첫 후보 ≥ 10:15).
5. 모든 후보: 시작 분이 0/15/30/45, `end − start = minutes`, `startIso === start.toISOString()`.
6. `block` 모양이 정확히 `{taskId, kind:'work', start, end}`이고 `M.addBlock(state, r.block)` 뒤 `M.conflictsFor`가 그 시간에 그 블록을 돌려준다.
7. 순수성: `placeOnDay`·`suggestSlots`·`arrangeDay`·`nearestDay` 전후 `JSON.stringify(state)` 같음.
8. 결정성: 같은 입력 두 번 deep-equal; `state.blocks` 순서를 뒤집어도 같음.

**띠·고정 표(상태 꺼짐)**
9. `dayBands(WED)`: morning 07:00–08:30, work 09:00–12:00·13:00–18:00, lunch 12:00–13:00, evening 18:30–22:30, late 22:30–23:00, 상태 id off/work/work/off/off.
10. `dayBands(SAT 10/10)`: dayoff_edge 07–09·21–23, dayoff 09–21, id `day_off`.
11. 맥락 없음(제목 ‘그거 하기’ — 시험 안에서 먼저 `ST.ruleContext(title)`이 null임을 단언), 30분, 수 → 09:00 (work normal +10, align +3 = 13; 18:30도 13 → 이른 쪽. 07:00은 10−6+3 = 7).
12. 업무 맥락('주간 보고서 작성'), 수 → 09:00–18:00 안; 이유 첫 문장 `근무 시간 안이에요.`
13. 업무 맥락, 일 10/11, now=MON → `'no_window'`, message `근무 시간에 할 일이라 쉬는 날에는 넣지 않았어요.`, alternatives[0].ymd = `'2026-10-12'`, 시작 09:00.
14. 집안일('빨래 돌리기'), 수 → 18:30 시작, `fit:'good'`, 근무 띠 후보 없음.
15. 집안일, 토 10/10(now=SAT) → 09:00.
16. 밖 볼일·개인·가족·공부 맥락 표본 각각 수요일 → 저녁 띠(표 일치) — 표 기반 시험(데이터 테이블).
17. `prefs.workHours = {start:'10:00', end:'19:00', days:[1..5]}` → 집안일 수 → 19:30; 업무 → 10:00.
18. `workHours.days`에 6 포함 → 토요일이 근무일 띠.
19. 꺼진 상태 이유에 맥락 이름(‘집안일’)이 없다.
20. `opts.noStatus:true` → 맥락 null처럼(모든 띠 normal).

**바쁜 시간**
21. 수 18:30–20:00 블록 → 집안일 30분 → 20:00.
22. Google 바쁨(`state.gcal.events` 손으로 만든 항목, `busy:true`, 수 18:30–19:30) → 19:30; 종일·`busy:false`는 무시.
23. `opts.external`(시험 훅) 바쁨도 피한다.
24. `ignoreBlockId`: 18:30–19:00 자기 블록을 옮길 때 18:30이 다시 후보.
25. 끝낸 할 일의 작업 블록도 바쁨이다.
26. 수 07:00–08:30·18:30–23:00 블록(집안일이 갈 수 있는 띠 전부) → `'no_slot'`, message `10/7(수)에는 30분 빈 시간이 없어요.`, detail에 `퇴근 후(18:30–22:30)`; alternatives[0] = 10/6 18:30 (거리 1은 10/6·10/8 — 이른 날 먼저).
27. 집안일 300분 수요일 → `'too_long'`(가장 긴 창 270분), message에 `4시간 30분`; 토요일엔 들어감(07–23 합친 창).

**상태 켜짐**
28. 활성 + 집안일 수 → 18:30, 이유 첫 문장 `‘퇴근 후’라 ‘집안일’ 하기 좋은 시간이에요.`
29. 활성 + 집안일 + 저녁·늦은 밤·출근 전 모두 바쁨 → 근무 띠 후보, `fit:'poor'`, 이유 `‘업무 중’ 시간이라 알맞은 때는 아니지만 다른 빈 시간이 없어요.`
30. 활성 + 업무 할 일 토요일 → `'no_window'`(off/day_off 행의 업무 = 숨김), message `‘업무’ 일은 ‘쉬는 날’에는 넣지 않아요.`
31. 활성 + `statusProfile.afterWork='down'` → 업무 할 일 토요일 가능, `fit:'poor'`.
32. 활성 + `statusProfile.policy = { off: { home: 'hide' } }` → 집안일 수: 저녁 불가, 근무 띠(down)로.
33. `presence.current`를 명시 `off`로 둬도(지금 상태) 미래 날짜 결과가 같다(플래너는 시간표만 본다).

**걸어 둔 상태**
34. `atMode:'off'`(맥락 없음) 수 → 18:30, 이유 첫 문장 `‘퇴근하고’ 하기로 한 일이에요.`
35. `atMode:'work'` + 집안일 맥락(꺼짐) → 근무 띠 up(숨김을 이긴다) → 09:00.
36. `atMode:'pause'` 수 → 12:00(점심), comfort 없음; 토요일 → 후보 있음, `fit:'poor'`.
37. `atMode:'rest'` 수 → `fit:'poor'`; 토 → `'good'`.

**힌트**
38. `ruleHints` 데이터 표: '분기 보고서 작성'→deep · '고객사에 메일 보내기'→light · '보고서 메일로 보내기'→light · '아침 운동'→energy high + prefer morning · '틈틈이 영어 공부'→deep + splittable true · '한 번에 몰아서 정리'→splittable false + light · '정리본 작성 후 메일'→light(뒤에 나온 쪽) · '코드리뷰하기'→focus null(토큰이 '리뷰'로 시작하지 않음) · ''→모두 null.
39. `hintsOf`: user 출처의 null은 규칙으로 채우지 않음; ai 출처의 null 필드는 규칙 값(`src:'rule'`); 없음 → 규칙.
40. prefer morning, 맥락 없음, 수 → 09:00(+15); prefer evening → 18:30 이후 1순위.
41. deep 60분, 맥락 없음, 수 10:00–11:00 블록 → 1순위 11:30 (10+8 = 18; 11:15는 앞 빈틈 15분 → crumb −4 = 14; 09:00·11:00은 맞닿아 −10 → 11), 앞뒤 15분 안에 바쁨 없음, 이유에 `집중이 필요한 일이라 이른 시간에 두었어요.`
42. light 30분, 수 10:00–11:00 · 11:30–12:30 블록 → 11:00(빈틈 채움), 이유에 `빈 시간에 딱 맞아요.`
43. energy high, 맥락 없음, 저녁만 비어 있음(09–18 바쁨) → 21:00 이후 후보가 1순위가 아님; energy low → 19:00 이후 선호.

**마감·우선순위**
44. 수 now=WED 17:00 시계(`new Date(2026,9,7,17,0)`), 집안일 due 수 20:00 → 모든 후보 end ≤ 20:00; 1순위 18:30.
45. dueDate 10/6에 ymd 10/7 → `'after_due'`, message `마감(10/6(화))보다 늦은 날이에요.`, alternatives 마감일부터 거꾸로(10/6 저녁); `allowAfterDue:true` → ok.
46. due 내일 → `terms.urgency > 0`, 이유에 `마감(…)이 가까워 앞쪽 시간을 골랐어요.`; due 30일 뒤 → urgency 없음.
47. `dueTight`: e > due − 60분 후보는 `terms.dueTight === -6`.
48. priority high → `terms.priority > 0`, 1순위 시작 ≤ 같은 제목·우선순위 없음의 1순위 시작; low → `terms.priority`가 늦은 후보일수록 큼.

**빈틈·인접·기록·다양성**
49. 짧은 일(15분) + 30분 빈틈 → 그 빈틈(shortSmall + fragTight).
50. 같은 프로젝트 블록이 19:00–20:00 → 그 프로젝트 집안일 1순위 이유에 `같은 프로젝트 ‘…’ 일과 이어져요.`
51. 기록: 지난 28일 안 20:00대 집안일 블록 3개(now 이전) → 집안일 1순위 20:00, 이유 `평소 이 시간대에 하던 일이에요.`; 2개면 18:30.
52. 다양성: 빈 하루에서 `limit:3`의 시작이 서로 60분 이상 떨어짐; 1순위 = 다양성 없이 정렬한 1순위.
53. 같은 점수 → 이른 시작.

**나누기·가까운 날·하루 자동 배치**
54. `splittable:true`(사용자), 집안일 300분, 수 → `too_long` + `split = { chunkMinutes: 270, restMinutes: 30, first.start = 18:30 }`(15의 배수·≥30·≤ len−30); `placeOnDay`는 `ok:false` 그대로(자동으로 넣지 않음).
55. `splitPlan` 직접 호출: splittable null + 180분 + focus deep → null; 같은 조건 focus null → 결과 있음; splittable false → null.
56. `nearestDay`: now=MON, from 10/11(일), 업무 → 10/12 (거리 1의 10/10 토는 업무 불가); 집안일 from 10/7 → 10/6(거리 같으면 이른 날); 마감 이후 날은 건너뜀; 오늘 이전 건너뜀; 14일 안에 없으면 null.
57. `remainingMinutes`: estimate 120, 미래 작업 블록 60분 → 60; 진행 중 블록(now가 중간) → 남은 분만 뺌; estimate null → null.
58. `arrangeDay`: 마감 지남·높은 우선순위가 먼저 놓임; 결과 블록끼리 겹치지 않음; 모두 허용 창 안; `no_estimate`·`blocked`·`snoozed`·`no_slot` 건너뛰기 이유; `maxTasks:2` 지킴; 상태 불변; 결정성.
59. `arrangeDay` 다시 매김: 두 번째 할 일이 첫 번째 놓인 시간을 바쁨으로 본다(첫 번째가 18:30이면 두 번째는 19:00 이후).
60. now=FRI 18:42, 업무 할 일 금요일 → `'no_window'` message `오늘은 이 일을 할 시간대가 이미 지났어요.`, alternatives[0] 10/12 09:00.
61. now=SAT 01:25, 집안일 토요일 → 09:00.
62. 점심: 업무 할 일, 수 09:00–12:00 바쁨 → 13:00(12:00 아님).
63. 늦은 밤: 집안일, 수 18:30–22:30 바쁨 → 22:30, `band:'late'`.
64. `fmtDay`: 오늘/내일/`10/12(일)`; `fmtRange` `19:30–20:00`.

### 12.2 model (W1.5-planner, `test/model.test.js` 추가)
65. `normalizeTask({})`에 `schedHints === null`; `{schedHints: undefined}`도 null.
66. `updateTask` 제목 변경 → AI 힌트 지움, 사용자 힌트 유지, 패치에 `schedHints`가 있으면 그 값.

### 12.3 W2-ai 시험 (`test/status-capture.test.js` 옆 새 파일 `test/sched-capture.test.js`)
67. 스키마 엄격성 walker 통과(`assist.test.js` 그대로), `sched` 다섯 속성 required.
68. validate: enum 밖 값 → null; `prefer` + `do_at` → null; 다섯 다 null → `item.sched === null`.
69. validate `minutes`: quote '보고서 1시간 반 걸릴 듯' + minutes 90 → 90; quote에 길이 없음 → null; 700000 → null.
70. proposals: 새 할 일에 `schedHints.source === 'ai'`; 사용자 힌트가 있는 할 일은 그대로; `minutes`는 estimate가 null일 때만(`estimateSource:'ai'`).
71. TASK_KEEP 왕복(할 일→일정→할 일)에 `schedHints` 보존.
72. fake: `purpose:'capture'` 출력에 `sched`, '30분 걸리는 빨래 개기' → minutes 30, 그 밖 null.
73. `refineForced`: `schedHints == null`일 때만 옮김.
74. 프롬프트 SYSTEM에 규칙 'N. 배치 힌트' 포함, 버전 `capture.v7`.

### 12.4 화면 확인 (Playwright + `scripts/serve.js 5191`, `?fakeai`, `timezoneId:'Asia/Seoul'`, `__daynoteNow='2026-10-10T10:00:00'`, 샘플 데이터)
1. 캘린더 첫 진입이 **월간**(`.cm[role=grid]`), 6주 42칸, 10/10에 `.is-today`. 주간으로 바꾸고 다른 화면 갔다 오면 주간(prefs 기억). 새로 고침 뒤에도 주간.
2. 마우스 끌기: '빨래 돌리기'(15분) 카드를 `page.mouse.down/move(단계 10)/up`으로 10/12 칸에 놓기 → 블록 생김, 토스트 `‘빨래 돌리기’를 10/12(일) 09:00–09:15에 넣었어요.` + [다른 시간][되돌리기]; [되돌리기] → 블록 없음.
3. 소요 시간 없는 할 일 놓기 → `.dur-pop` 바로 뜸, `1시간` 칩 → 블록 60분, 할 일 estimate 60(`'user'`). 직접 입력 `abc` → 오류 문구, `1:30` → 90. Esc → 아무것도 안 바뀜.
4. 머무르기: 끌어서 10/13 칸 위에 1.1초 → `.is-ding` 붙음(동작 줄이기 끔) → `.cd-sheet` 열림, 추천 띠 `.cd-sugg` 1–3개 + `.cd-rank`; 패널 20:00 위치에 놓기 → 20:00 블록. 0.8초만 머무르고 떠나면 안 열림.
5. 머무르기로 연 뒤 Esc → 패널 닫힘, 바뀐 것 없음. 대상 밖(왼쪽 패널)에 놓기 → 닫힘, 바뀐 것 없음.
6. `prefers-reduced-motion: reduce` 에뮬레이션 → `.is-ding`의 계산된 `animation-name`이 `none`, 배경이 `--primary-soft` 값.
7. 터치 에뮬레이션(`hasTouch`, 390×844): 손잡이에서 `touchscreen` 끌기(CDP `Input.dispatchTouchEvent`) → 놓기 성공; 카드 몸통 짧은 스와이프는 목록 스크롤이고 끌기 아님; 길게 누르기(400 ms) 후 이동 → 끌기.
8. 390px: 캘린더 월간·하루 시트 열린 상태 모두 `scrollWidth === 390`; 칸에 점만, 탭하면 아래 시트.
9. 키보드만: 카드 Tab → Enter → '날짜 골라서 넣기' → 화살표 → Enter → (소요 시간 팝오버) → 넣음, 포커스 카드로 복귀. Shift+Enter → 하루 패널 추천 ①에 포커스 가능.
10. 일정 대화상자: 상세 '일정에 배치' → `.sched-sugg-chip` 3개 이하, 누르면 시작 시각 바뀜, 날짜 바꾸면 칩 다시 계산.
11. '이 날 자동 배치' → 미리보기 → 넣기 → 블록 여러 개, 되돌리기 한 번에 모두 사라짐(라벨 '자동 배치').
12. 상세 '배치 힌트' 바꾸기 → `schedHints.source==='user'`; 그 뒤 AI 다듬기가 와도 유지.
13. 끌기 도중 Google 동기화 같은 저장(`S.mutate(null, …, {source:'gcal'})`)이 일어나도 유령·대상이 사라지지 않고, 끝난 뒤 다시 그려짐.
14. 1440×900·390×844, 라이트·다크: 콘솔 오류 0.

---

## 13. 범위 밖 (후속)
- 여러 조각 자동 분할 배치, 반복 일정, 월간 칸 항목 끌기, 이동 시간 계산, 소리, 다른 기기와의 동시 끌기, 학습(`adapt`)에 "배치 시간" 유형 추가(지금은 지난 블록 기록 친화도로 대신).
