# Daynote 기능 명세 — P2 잔여(일정·설정) · 할 일 추천 버튼 · 슬래시 명령어

- 작성: 2026-10-10 (토) · 기준: 브랜치 `web-mobile`, 커밋 `d75f062`
- 근거 문서: `DAYNOTE_UX_V2.md`, `DAYNOTE_UX_P1_REPORT.md` (남은 작업 P2), `DAYNOTE_UX_REVIEW_CLAUDE.md` §10·11·15, `daynote/README.md`
- 이 문서는 **구현 지시서**다. 파일 경로는 `daynote/` 기준. 줄 번호는 위 커밋 기준이다.
- 다른 팀이 설계하는 것: **현재 상태(status) 기능**, **Google 캘린더 연결**. 이 문서는 두 기능과 만나는 **연결 지점(hook)** 만 정한다 (§1.5, §2.3, §5.6, §6.9).

---

## 0. 요약과 결정 기록

| # | 주제 | 결정 | 이유 |
|---|---|---|---|
| D1 | 빈 시간 찾기 | 순수 모듈 `src/core/slots.js` 하나에 근무 시간 · 바쁜 시간 모으기 · 빈 시간 찾기 · "지금 비어 있나" 를 둔다. 시각 비교는 **밀리초 숫자**로 한다 | 대화상자·추천·오늘 화면이 같은 규칙을 쓰고 Node 에서 시험한다. 외부(Google) 일정은 `+09:00` 같은 오프셋 ISO 일 수 있어 문자열 비교를 쓰면 틀린다 |
| D2 | 바쁜 시간의 범위 | 블록 전부(작업·일정, 지난 것·끝낸 할 일의 것 포함, 지운 할 일의 블록은 제외) + 외부 일정(취소·종일·‘한가함’ 제외) | 지금 `M.conflictsFor` 와 같은 기준이어야 "겹침" 표시와 "다른 시간 찾기" 결과가 어긋나지 않는다 |
| D3 | 찾는 범위 | 기준 시각이 근무 시간 안이면 **근무 시간(근무 요일) 안**, 밖이면 **하루 07:00–23:00 안**. 기준 시각부터 앞으로, 15분 칸, 최대 14일 | "근무 시간 / 하루" 둘 다 필요하다. 퇴근 뒤·주말에 잡는 개인 일정을 월요일 9시로 미는 건 이상하다 |
| D4 | 충돌 시 선택 | 겹침 상자 안에 **[다른 시간 찾기] [겹쳐 배치]** 두 버튼. 겹치는 동안 아래쪽 주 버튼(배치/변경 저장)은 **비활성**. "두 번 누르면 저장" 토스트 흐름은 없앤다 | 숨은 두 번 클릭 대신 명시적 선택. 리뷰 §10·11 |
| D5 | 상시 "다음 빈 시간 찾기" 버튼 | **없앤다.** 같은 동작은 겹칠 때 상자 안의 [다른 시간 찾기] 로만 | 처음 여는 시각이 이미 빈 시간이고, 같은 버튼 두 개는 정보 우선순위 원칙(리뷰 §4)에 어긋난다 |
| D6 | 소요 시간 미정 | 30분을 **제안값**으로 표시(점선 칩 `제안값`, 옵션 "30분 (제안)"). 길이를 바꾸면 "소요 시간으로도 저장" 체크가 켜진다. 손대지 않고 배치하면 블록에 `durationGuessed:true` | 30분을 사실처럼 확정하지 않는다(리뷰 §10·11, README 규칙 "미정은 null") |
| D7 | 근무 시간 형태 | `prefs.workHours = { start:'HH:MM', end:'HH:MM', days:[0..6] }` (`days` 는 `Date#getDay()` 값). 없으면 **월–금 09:00–18:00** | 요일별 근무일이 필요하다. 지금은 `days` 가 없어 주말도 근무일로 계산되는데, 기본값을 월–금으로 바꾼다(§3.3에 영향 정리) |
| D8 | 설정 AI 구역 | 위: 쉬운 상태 한 줄 + 키 붙여 넣기 + 전송 범위 안내. 아래 `<details>` **고급**: 키 출처·모델 id·환경변수·원문 사유. 구현되지 않은 "로컬만/자동/API" 선택지는 **보이지 않는다** | 리뷰 §15 "실제 구현되지 않은 옵션은 활성화하지 않는다". 비활성 라디오 세 개는 잡음이다 |
| D9 | "할 일 추천" 버튼 위치 | 홈 채팅 열 안, 도우미 버튼 줄 **바로 위** 한 줄(`.rec-cta`). 보일 때는 도우미 줄의 "다음 할 일" 을 숨긴다 | 폰에서도 첫 화면(입력창 위)에 보인다. 같은 일을 하는 버튼이 동시에 두 개 보이지 않게 한다 |
| D10 | 사용 가능 시간 입력 파싱 | `src/core/dates.js` 에 `parseDuration(text)` 추가 | `dates.duration(min)`(분 → "1시간 30분") 의 역함수라 같은 곳이 맞다 |
| D11 | 명령어 파서 | `src/core/commands.js` — **의존성 없음**(빠른 메모 창도 그대로 불러 쓴다) | 홈 입력창·빠른 메모 창·Ctrl+N 이 같은 규칙을 쓴다 |
| D12 | 명령어 짧은 형태 | **넣는다**: `/t /e /m /i /l /s /h /?`. 영어 별칭 `task`(=todo), `note`(=memo) | 명령 토큰 뒤에 공백·`:`·끝이 와야만 인정하므로 일반 글과 부딪히지 않는다. 한글 입력 상태에서는 한글 별칭(`/할일` …)을 쓴다 |
| D13 | 명령어의 의미 | 명령어는 **종류를 정한다**. 원문은 명령어를 뗀 본문으로 저장하고 **그 종류의 항목 딱 하나**를 **바로**(규칙으로) 만든다. AI 는 뒤에서 **다듬기만** 한다(제목·날짜·시각·프로젝트·길이·장소). AI 의 종류 판단, 여러 항목 나누기, 완료 보고·날짜 바꾸기 보고, 중복 건너뛰기는 **모두 쓰지 않는다** | 사용자가 정한 것은 AI 가 덮지 않는다(원칙 6). AI 없이도 즉시 맞게 동작한다(원칙 2). 프롬프트를 바꾸지 않아 `capture.v6` 그대로 |
| D14 | AI 제목 다듬기 조건 | AI 가 할 일+일정을 **정확히 하나** 돌려줬을 때만 그 항목의 제목·날짜를 쓴다. 0개거나 2개 이상이면 프로젝트만 쓴다 | "견적서 보내고 세금계산서 발행" 을 AI 가 둘로 나누면 첫 제목만 쓰는 순간 내용이 사라진다 |
| D15 | 사용자 손댐 보호 | 규칙으로 만든 값을 `capture.command.base` 에 적어 두고, AI 다듬기는 **지금 값이 base 와 같은 칸만** 바꾼다 | 날짜 칩 수정은 `changedByUser` 를 세우지 않는다(capture 지도 §14-8). 칸별 비교가 가장 단순하고 확실하다 |
| D16 | 모르는 명령어 | 일반 글로 그대로 저장 + 부드러운 안내 한 줄. `//` 로 시작하면 `/` 하나를 떼고 일반 글(이스케이프) | 적는 순간 막지 않는다(원칙 1) |
| D17 | `/상태` | 상태 기능의 `DN.status.setFromCommand(text)` 를 부른다. 없으면 "준비 중" 안내. 메모는 만들지 않는다 | 상태 설계는 다른 팀 몫 |
| D18 | `/도움말` | 흐름에 **도움말 카드**(채팅 메시지 `kind:'help'`)를 올린다. 빠른 메모 창에서는 창 안에 목록을 펼친다 | 빠른 창은 보내면 숨으므로 흐름 카드를 볼 수 없다 |

새로 생기는 것 한눈에:

```
src/core/slots.js            DN.slots      근무 시간 · 바쁜 시간 · 빈 시간 찾기 · 지금 비어 있나        (deps: dates, model)
src/core/commands.js         DN.commands   슬래시 명령어 표 · parse · 자동완성 match                  (deps: 없음)
src/core/ai/forced.js        DN.aiForced   명령어로 정한 종류의 항목 만들기(규칙) · AI 다듬기          (deps: dates, model, suggest, ai/validate, ai/proposals)
src/core/dates.js            + parseDuration
renderer/slash.js            DN.slash      자동완성 팝업 (DOM 만, ui.js 안 씀 — 빠른 메모 창도 사용)
renderer/views/recpanel.js   DN.views.recPanel  "할 일 추천" 줄 + 시간 고르기·결과 패널
test/slots.test.js · test/commands.test.js · test/dates.test.js · test/forced.test.js (+ recommend/assist 추가)
```

---

## 1. 공통

### 1.1 스크립트 순서 (`renderer/index.html:16-56`)

```
../src/core/dates.js, model.js, slots.js, recommend.js, suggest.js, weekly.js, split.js, commands.js
../src/core/ai/organizeNote.js, validate.js, proposals.js, capture.js, forced.js, assist.js, fake.js
… sample.js, store.js, ui.js, app.js, aiflow.js, capture.js, assistant.js, slash.js,
views/detail.js, schedule.js, recpanel.js, chat.js, today.js, …
```

- `recommend.js` 가 `slots` 를 쓰므로 `slots.js` 는 `recommend.js` 앞. UMD deps 에 `slots: require('./slots')` 추가.
- `renderer/quick.html` 은 `quick.js` 앞에 `<script src="../src/core/commands.js"></script>` 와 `<script src="slash.js"></script>` 를 넣는다. 두 파일 모두 `window.Daynote` 외 다른 전역을 쓰지 않는다. CSP(`script-src 'self'`)는 메인 창과 같은 방식으로 통과한다.
- `scripts/build-web.js` 는 바꿀 것이 없다(파일 이름이 `quick.js` 로 끝나지 않게 주의).
- 스모크(`main.js:180`) `out.core` 에 `D.slots && D.commands` 를 더한다.

### 1.2 데이터 변경 (새 최상위 키 없음 → `SCHEMA_VERSION` 그대로 3)

| 위치 | 추가 | 기본값·읽는 법 |
|---|---|---|
| `prefs.workHours.days` | `[0..6]` 정렬·중복 없음 | 없거나 비면 `[1,2,3,4,5]` (`SL.normalizeWorkHours`) |
| `note.capture.command` | `{ name, kind, token, raw, base, refined }` | 명령어로 적은 글만. §6.5 |
| 블록 `durationGuessed` | 이미 있는 필드 재사용 | 대화상자에서 제안값 그대로 배치하면 `true` |
| 채팅 메시지 `kind:'help'` | `{ kind:'help' }` | §6.11 |

외부 일정은 이 문서에서 저장하지 않는다. `slots.collectBusy` 가 `state.externalEvents`(있으면)와 `opts.external` 을 읽기만 한다(§2.3).

### 1.3 되돌리기 라벨

| 동작 | 라벨 | 비고 |
|---|---|---|
| 명령어로 적기(원문 + 항목 생성) | `'입력 저장'` | 기존 라벨. 원문과 항목이 **한 번에** 되돌아간다 |
| AI 다듬기 | `'AI 다듬기'` | 새 라벨 |
| 대화상자 배치/변경(겹쳐 배치 포함) | `'일정에 배치'` / `'일정 변경'` | 기존 라벨 |
| 근무 시간 저장 | 없음(`S.mutate(null, …, {silent:true})`) | prefs 는 undo 대상이 아니다 |

### 1.4 말투

새 문구는 모두 `-어요` 체(UX_V2 §7). 대화상자에서 이번에 손대는 문구(겹침·빈 시간·토스트)도 `-어요` 로 바꾼다. 동적 제목은 `‘ ’` 로 감싸고 조사는 `ui.josa`.

### 1.5 다른 팀 기능과의 연결 지점(계약)

| 연결 지점 | 이 문서가 기대하는 모양 | 없을 때 |
|---|---|---|
| `DN.status.current(now)` | `→ { label:string, busy?:boolean, until?:ISO } \| null` | `null` 로 본다 |
| `DN.status.setFromCommand(text, { now, source:'command' })` | `→ { ok:boolean, label?:string, message?:string }`. 되돌리기 라벨이 있는 `S.mutate` 를 스스로 한다 | `/상태` 는 "준비 중" 안내 |
| 외부 바쁜 일정 | `state.externalEvents: [{ id, start, end, title, allDay?, busy?, transparency?, status?, source:'google' }]` (Google 팀이 `M.emptyState()` 에 추가) 또는 `externalId` 를 가진 `state.blocks` 항목 | 블록만 본다 |
| 연결 목록 상태 | 설정의 `PROVIDERS` 표에서 `status:'ready'` 로 바꾸면 "준비 중" 에서 빠진다 | "준비 중" 에 남는다 |

---

## 2. A-1 빈 시간 찾기 — `src/core/slots.js`

머리 주석(한국어): "근무 시간·바쁜 시간·빈 시간. 상태를 바꾸지 않는다. 시각은 밀리초로 비교한다. now 를 꼭 넘긴다."

### 2.1 상수

```js
DEFAULT_WORK_HOURS = { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] }
DAY_WINDOW         = { start: '07:00', end: '23:00' }   // 근무 시간 밖에서 찾을 때의 하루
STEP_MIN = 15; SEARCH_DAYS = 14; IMMINENT_MIN = 15
```

### 2.2 근무 시간

```js
parseHm(s) → 분(0..1439) | null            // 'H:MM'·'HH:MM' 만. '24:00'·'9:5'·'aa' → null
normalizeWorkHours(wh) → { start, end, days }
  // 관대한 정리(읽을 때): start/end 중 하나라도 null 이거나 start >= end 이면 시간 둘 다 기본값.
  // days: 배열이 아니거나 0..6 정수가 하나도 없으면 기본값. 정수만 남기고 중복 제거·오름차순.
validateWorkHours(input) → { ok:true, value } | { ok:false, error, message }   // 엄격(설정 화면 저장 전)
  // error: 'invalid_time' | 'end_before_start' | 'too_short'(30분 미만) | 'no_days'
describeWorkHours(wh) → '월–금 09:00–18:00'
  // 요일은 월요일부터 본다(월화수목금토일). 7개면 '매일'. 연속 3개 이상은 '월–수', 아니면 '·' 로 잇는다 ('월·수·금', '토·일').
isWorkingDay(date, wh) → bool
workWindow(date, wh) → { start: Date, end: Date } | null   // 그날이 근무일이 아니면 null. 현지 시각.
isWorkingTime(now, wh) → bool                                 // start <= now < end (끝은 포함하지 않음)
```

메시지(`validateWorkHours`):

| error | message |
|---|---|
| invalid_time | 시각을 ‘09:00’처럼 골라 주세요. |
| end_before_start | 끝 시각은 시작보다 늦어야 해요. 밤샘 근무는 아직 지원하지 않아요. |
| too_short | 근무 시간은 30분 이상이어야 해요. |
| no_days | 근무 요일을 하루 이상 골라 주세요. |

### 2.3 바쁜 시간 모으기

```js
collectBusy(state, from, to, opts) → Busy[]
  // from, to: Date | ISO | ms. [from, to) 와 겹치는 것만.
  // opts: { ignoreId?, external?: ExternalEvent[], includeDoneWork?: true }
Busy = { id, start: ms, end: ms, title, source: 'block'|'external', kind: 'work'|'event'|'external', taskId: id|null, done: bool, provider?: 'google' }

conflicts(busy, start, end) → Busy[]      // 반열린 구간 [start, end) 겹침: b.start < end && b.end > start
merge(busy) → [{ start, end }]             // 시작순 정렬 후 겹치거나 맞닿은 구간 합치기
```

규칙(순서대로):
1. `state.blocks`: `id === ignoreId` 제외. `taskId` 의 할 일이 없거나 `deletedAt` 이면 제외(지금 `conflictsFor` 와 같음). `Date.parse` 결과가 NaN 이거나 `end <= start` 이면 제외. `includeDoneWork === false` 이면 **완료된 할 일의 작업 블록**도 제외(§5.1 에서만 씀). 제목은 작업 블록이면 살아 있는 할 일 제목.
2. 외부 일정: `state.externalEvents`(배열일 때만) + `opts.external`. 제외: `status === 'cancelled'`, `busy === false`, `transparency === 'transparent'`, `allDay && busy !== true`(Google 종일 일정은 기본이 ‘한가함’). `state.blocks` 중 `externalId === ev.id` 인 블록이 있으면 중복이므로 외부 쪽을 뺀다.
3. 결과는 시작순 정렬. 입력(state·배열)을 바꾸지 않는다.

### 2.4 빈 시간 찾기

```js
findSlot(busy, opts) → { found:true,  start: Date, end: Date, mode, sameDay: bool, dayOffset: int }
                     | { found:false, reason: 'too_long'|'no_slot'|'bad_input', mode }
  opts: { from: Date, now: Date, minutes: int, workHours, mode: 'auto'|'work'|'day' = 'auto', days = 14 }
pickMode(from, wh) → 'work' | 'day'      // from 이 그날 근무 창 안(start <= from < end)이면 'work', 아니면 'day'
defaultMode(now, wh) → 'work' | 'day'    // 근무일이고 now < 그날 근무 끝이면 'work' (출근 전이면 근무 시작부터), 아니면 'day'
```

알고리즘:
1. `minutes` 가 1 미만·정수 아님·`from` 무효 → `bad_input`.
2. `mode==='auto'` → `pickMode(from)`.
3. 하루 창의 길이(work: `end-start`, day: 16시간)가 `minutes` 보다 짧으면 → `too_long` (근무일이 하나도 없을 때도 work 모드는 `no_slot`).
4. `t0 = roundUp15(max(from, now))`. 기준일은 **`t0` 의 날짜부터** `d = 0 .. days-1`:
   - 창: work 모드는 `workWindow(day)`(근무일 아니면 건너뜀), day 모드는 그날 `07:00–23:00`.
   - `s = max(창 시작, t0)` 를 15분 칸으로 올림. `s + minutes <= 창 끝` 인 동안: `merge(busy)` 중 `[s, s+len)` 과 겹치는 첫 구간이 없으면 **찾음**. 있으면 `s = roundUp15(그 구간 끝)` 으로 건너뛴다.
5. 못 찾으면 `no_slot`. `sameDay` 는 `D.ymd(start) === D.ymd(from)`, `dayOffset` 은 `D.dayDiff(from, start)`.

`renderer/views/schedule.js` 의 `findFreeSlot(state, from, minutes, ignoreId) → Date` 는 **이름과 반환형을 지키는 감싸개**로 바꾼다:

```js
function findFreeSlot(state, from, minutes, ignoreId) {
  var wh = SL.normalizeWorkHours(state.prefs.workHours), now = DN.app.now();
  var busy = SL.collectBusy(state, from, D.addDays(from, SL.SEARCH_DAYS + 1), { ignoreId: ignoreId });
  var r = SL.findSlot(busy, { from: from, now: now, minutes: minutes, workHours: wh, mode: SL.defaultMode(from, wh) });
  return r.found ? r.start : roundUp15(from);   // 못 찾으면 예전처럼 from (미리보기가 겹침을 보여 준다)
}
```

호출하는 곳(`today.js:381`, `calendar.js:73`, `schedule.js` 기본 시작 시각)은 그대로 둔다. 기존 상수 `DAY_START=8, DAY_END=20` 은 지운다.

### 2.5 지금 비어 있나 (§5 에서 사용)

```js
freeNow(state, now, opts) → {
  free: bool,
  reason: null | 'in_progress' | 'imminent' | 'status',
  current: Busy | null,       // 지금 진행 중인 것(가장 먼저 끝나는 것)
  next: Busy | null,          // 오늘(자정 전) 시작하는 다음 것
  freeMinutes: int | null,    // next 까지 남은 분을 5분 단위로 내림. next 없으면 null
  workTime: bool              // isWorkingTime(now, workHours)
}
opts: { workHours, external, status, imminentMinutes = 15 }
```

- 바쁜 시간: `collectBusy(state, now - 1일, endOfDay(now) + 15분, { includeDoneWork:false, external })`.
- `in_progress`: `start <= now < end` 인 것이 있다(끝나는 순간은 진행 중이 아니다).
- `imminent`: `now < start` 이고 `start - now <= 15분` 인 것이 있다(정확히 15분 뒤 → 바쁨, 16분 뒤 → 빔). 자정을 넘어도 본다.
- `status`: `opts.status && opts.status.busy === true`.
- 우선순위: in_progress → imminent → status. 하나라도 걸리면 `free:false`.

---

## 3. A-2 일정 배치 대화상자 — `renderer/views/schedule.js`

### 3.1 길이 — 제안값 표시

`open()` 의 `minutes`·`unknownEst` 계산(51-53줄)은 유지하고 표시만 바꾼다.

| 경우 | 길이 select 옵션 글자 | 길이 라벨 옆 | 도움말 | 저장 체크 |
|---|---|---|---|---|
| 할 일, `estimateMinutes == null`, 블록 없음 | `30분 (제안)` | `span.chip.chip-guess` **제안값** | 소요 시간이 정해지지 않아 30분을 제안했어요. 맞는 길이를 골라 주세요. | `label.check-row` **이 길이를 ‘소요 시간’으로도 저장** (처음엔 꺼짐) |
| 할 일, `estimateSource === 'ai'` | `45분 (AI 추정)` | `chip-guess` **AI 추정** | — | 없음 |
| 할 일, 추정이 240분 초과 | `4시간` | — | 소요 시간(5시간)이 길어 4시간만 잡았어요. 나눠서 여러 번 배치해도 좋아요. | 없음 |
| 그 밖 | 그대로 | — | — | 없음 |

- 사용자가 길이를 처음 바꾸면(`lenTouched = true`): 제안값 칩과 "(제안)" 꼬리를 지우고, 저장 체크를 **켠다**(사용자가 다시 끌 수 있다).
- `commit` 에서: `unknownEst && !lenTouched` 이면 새 블록에 `durationGuessed: true`. 저장 체크가 켜져 있으면 **같은 mutate 안에서** `M.updateTask(s, task.id, { estimateMinutes: minutes }, now)` (출처는 자동으로 `'user'`).
- 토스트: 제안값 그대로 → "‘X’ 작업 시간을 오늘 14:00에 30분(제안값)으로 배치했어요. 길이는 캘린더에서 바꿀 수 있어요." / 소요 시간 저장 → "… 배치했어요. 소요 시간도 45분으로 저장했어요." / 그 밖 → "… 배치했어요. 마감일은 그대로예요."

### 3.2 충돌 — 상태와 화면

겹침 계산은 미리보기와 저장 모두 `SL.conflicts(SL.collectBusy(S.state, s, e, { ignoreId: block && block.id }), s, e)` 로 한다(외부 일정 포함). `M.conflictsFor` 는 다른 화면용으로 그대로 둔다.

상태(대화상자 지역 변수): `idle | conflict | searching | found | not_found`. `update()` 는 입력이 바뀔 때마다 `idle/conflict` 로 다시 계산하고, 직전 검색 결과(`found`/`not_found`) 표시를 지운다. 단, "다른 시간 찾기" 가 입력을 바꿔 생긴 `update()` 는 `found` 를 유지한다(플래그 `fromSearch`).

| 상태 | 미리보기(`aria-live=polite`) | 상자 안 버튼 | 주 버튼 |
|---|---|---|---|
| 겹침 없음 | `div.ok-box` "오늘 14:00–14:30 · 겹치는 일정 없음" | — | 활성 |
| 겹침 | `div.conflict-box` 아이콘 + "오늘 14:00–14:30 · 겹치는 일정: ‘팀 회의’ 14:00–15:00, ‘주간 회의’ 14:15–14:45 (Google)" | `div.conflict-actions`: **[다른 시간 찾기]**(`btn-sm.btn-primary`) **[겹쳐 배치]**(`btn-sm`) | **비활성**, `title`="겹치는 일정이 있어요. 위에서 골라 주세요." |
| 찾음(같은 날) | `ok-box` "빈 시간으로 옮겼어요 · 오늘 15:30–16:00 · 근무 시간(월–금 09:00–18:00) 안에서 찾았어요" + `link-btn` **원래 시간으로** | — | 활성, 포커스 이동 |
| 찾음(다른 날) | `ok-box` "오늘은 빈 시간이 없어 내일(일) 10:00–10:30으로 옮겼어요 · 07:00–23:00 사이에서 찾았어요" + **원래 시간으로** | — | 활성, 포커스 이동 |
| 못 찾음 | 겹침 상자 + 한 줄 "근무 시간(월–금 09:00–18:00) 안에서 14일 동안 30분 빈 시간을 찾지 못했어요. 길이를 줄이거나 겹쳐 배치할 수 있어요." (`too_long` 이면 "30분은 근무 시간보다 길어요.") | [다른 시간 찾기] **비활성**(입력이 바뀌면 다시 활성), [겹쳐 배치] | 비활성 |

- 외부 일정은 이름 뒤에 ` (Google)` 를 붙인다(`provider==='google'`). 제목이 없으면 ‘일정’.
- 찾은 범위 문구는 모드로 정한다: work → "근무 시간(`describeWorkHours(wh)`) 안에서 찾았어요", day → "07:00–23:00 사이에서 찾았어요". 못 찾음 문구도 같은 범위 표현을 쓴다.
- 주 버튼이 비활성일 때도 키보드 사용자를 위해 겹침 상자의 첫 버튼에 `autofocus` 를 주지 않는다(입력 중 포커스를 뺏지 않음). 대신 주 버튼에 `aria-describedby` 로 겹침 상자를 가리킨다.

**[다른 시간 찾기]**:
```js
var from = r.s < now ? now : r.s;                         // 지난 시각이면 지금부터
var busy = SL.collectBusy(S.state, from, D.addDays(from, 15), { ignoreId: block && block.id });
var res = SL.findSlot(busy, { from: from, now: now, minutes: Number(durIn.value), workHours: wh, mode: SL.pickMode(r.s, wh) });
```
찾으면 `prev = {date, time}` 를 기억하고 `dateIn/timeIn` 을 바꾼 뒤 `update({fromSearch:true})`. **원래 시간으로** 는 `prev` 를 되돌린다.

**[겹쳐 배치]**: `commit({ force: true })` — 겹침 재확인을 건너뛰고 저장한 뒤 닫는다. 토스트 끝에 " 다른 일정과 겹쳐요." 를 붙인다.

`commit({force})` 규칙: 저장 직전 최신 상태로 겹침을 다시 계산한다(지금처럼). 겹침이 있고 `!force` 이면 저장하지 않고 `update()` 해서 상자를 보여 준다(토스트 없음). 기존 `allowConflict` 변수는 지운다.

- 상시 버튼 "다음 빈 시간 찾기"(117줄)는 지운다(D5).
- 바닥 안내(123줄)는 "빈 시간은 Daynote 캘린더 기준이에요. 실제 여유는 직접 확인해 주세요." 로, 외부 일정이 하나라도 읽혔으면 "Daynote 캘린더와 Google 캘린더 기준이에요. …" 로.
- 지난 시각 안내(80줄): "지난 시간이에요. 이미 한 일을 기록하는 거라면 그대로 저장하세요."

### 3.3 근무 시간을 읽는 곳 정리 (D7 영향)

| 곳 | 바꿀 것 |
|---|---|
| `recommend.js:158-160` | `var wh = SL.normalizeWorkHours(opts.workHours); var win = SL.workWindow(now, wh); var offHours = !SL.isWorkingTime(now, wh);` `toEnd` 는 `win.end` 기준. `ctx.workHours = wh` |
| `assist.js:173` `looksIdle` | `R.recommend(state, { now, workHours: state.prefs && state.prefs.workHours })` (버그 수정) |
| `assistant.js:70` | 그대로(`prefs.workHours` 를 넘김) |
| `schedule.js` | §2.4 감싸개 + §3.2 |

동작 변화: 근무 시간을 정하지 않은 사용자도 **주말에는 근무 시간 밖**이 된다. "다음 할 일" 은 주말에 캘린더로 T 를 짐작하지 않고 "쓸 수 있는 시간" 을 묻는 쪽으로 간다(§5 패널이 이 질문을 대신한다). 기존 테스트(월요일 기준)는 그대로 통과해야 한다.

---

## 4. A-3 설정 — `renderer/views/settings.js`

### 4.1 페이지 구조

`page-sub`: "AI·근무 시간·연결·데이터·화면을 정해요."

순서: **AI 처리 → 근무 시간 → 연결(이메일·캘린더) → 데이터 → 화면**.

`render` 가 돌려주는 핸들에 `onChange(info)` 를 둔다: `info.source` 가 `'capture'|'chat'|'today'` 이면 `true`(다시 그리지 않음). 빠른 메모 창에서 글이 들어와도 키 입력칸·시각 입력의 포커스가 사라지지 않게 한다.

### 4.2 AI 처리 카드 (`#set-ai`, 제목 "AI 처리")

위쪽(늘 보임):

| 상태 판정(위에서부터) | 점 | 굵은 글 | 보조 글 |
|---|---|---|---|
| `!configured && reason === '확인 중…'` | busy | 확인 중… | — |
| `S.host.kind === 'browser' && provider !== 'fake'` | — | 브라우저 미리보기 | AI는 데스크톱 앱에서 연결할 수 있어요. |
| `provider === 'fake'` | busy | 데모 모드 · 실제 AI가 아니에요 | 규칙으로 나눠요. 인터넷으로 보내는 것은 없어요. |
| `!configured && savedKey` | err | 저장한 키를 쓸 수 없어요 | 키(••••abcd)를 다시 붙여 넣어 주세요. |
| `!configured` | — | AI 꺼짐 | 적은 글은 메모로만 저장돼요. 키를 넣으면 할 일·일정으로 나눠 드려요. |
| `provider === 'gemini'` | ok | 켜짐 · Google Gemini | 처리 위치: Google 서버 (인터넷 필요) |
| `provider === 'claude'` | ok | 켜짐 · Anthropic Claude | 처리 위치: Anthropic 서버 (인터넷 필요) |

- 키 줄(데모·브라우저에서는 숨김): `label` **AI 키** · `input#set-ai-key[type=password]` 자리표시 "Google AI Studio 키를 붙여 넣으세요" · [키 저장]/[키 바꾸기] · [연결 확인](켜짐일 때만) · 결과 `span.help[role=status]`.
  - 연결 확인 결과(위쪽): "잘 연결됐어요 · 1.2초" / "연결하지 못했어요. 키를 확인해 주세요." 모델 id·원문 오류는 **고급**에만.
- 저장한 키 줄(`savedKey` 있을 때): "저장한 키 ••••abcd · 이 컴퓨터의 보안 저장소에 암호화해 뒀어요" + `btn-ghost` [지우기] (확인 대화상자 문구는 지금 그대로).
- 키 만들기: `a.link-btn[href="https://aistudio.google.com/apikey"][target=_blank][rel=noopener]` **키 만들기** + "Google AI Studio에서 무료로 만들 수 있어요." (Electron 은 `setWindowOpenHandler` 가 외부 브라우저로 연다)
- `aiSt.notice`(무료 등급 안내) `conflict-box` — 유지.
- 전송 범위 문단(134-136줄) — **그대로 유지**(리뷰 §15).

아래쪽 `details.settings-adv` > `summary` **고급** (처음엔 접힘. 열림 여부는 모듈 변수 `advOpen` 으로 다시 그려도 유지):
- 키 출처: `KEY_SOURCE[aiSt.keySource]` (이 앱에 저장한 키 / 환경변수 / 앱 폴더의 .env 파일)
- 모델: Gemini — 나누기 `aiSt.fastModel`(thinking minimal), 작게 나누기·메모 정리 `aiSt.model`(low), 한쪽이 실패하면 서로 대신 / Claude — `aiSt.model`
- 마지막 연결 확인: `1.23초 · gemini-3.5-flash-lite` 또는 원문 오류 메시지
- 상태 원문 사유: `aiSt.reason` (환경변수 이름이 들어 있을 수 있으므로 여기만)
- 개발용 설정: "환경변수 GEMINI_API_KEY(또는 GOOGLE_API_KEY), ANTHROPIC_API_KEY, DAYNOTE_AI_PROVIDER=gemini|claude, DAYNOTE_AI_FAKE=1 을 읽어요. 우선순위: 이 앱에 저장한 키 > 환경변수 > 앱 폴더의 .env"
- 저장 방식: "Windows는 DPAPI, macOS는 키체인으로 암호화해요."

함께 고칠 문구: `store.js:49` 브라우저 사유 → "브라우저 미리보기에서는 AI를 연결할 수 없어요. 데스크톱 앱에서 키를 넣어 주세요." (`services/ai.js` 의 사유 문자열은 `ai-provider.test.js:46` 이 검사하므로 **바꾸지 않는다** — 화면 위쪽에 원문 사유를 보이지 않는 것으로 해결)

CSS: `.settings-adv{margin-top:12px;border-top:1px solid var(--border-deco);padding-top:8px}` `.settings-adv>summary{cursor:pointer;font-weight:600;font-size:13px;color:var(--text-secondary);list-style:none;display:flex;gap:6px;align-items:center}` + `chevronDown` 아이콘 회전(`[open]`), `summary:focus-visible` 에 `--focus-ring`.

### 4.3 근무 시간 카드 (`#set-work`)

```
h3 근무 시간
p.help  할 일 추천과 ‘다른 시간 찾기’가 이 시간을 기준으로 해요. 근무 시간 밖에는 남은 시간을 짐작하지 않고 물어봐요.
div.settings-row  [lbl 시간]  input#set-work-start[type=time step=900] ~ input#set-work-end[type=time step=900]
div.settings-row  [lbl 요일]  div.work-days[role=group aria-label=근무 요일]  button.pill[aria-pressed] × 7 (월 화 수 목 금 토 일)
div.help#set-work-sum[aria-live=polite]   월–금 09:00–18:00 · 하루 9시간
div.field-error[role=alert][hidden]        (검증 메시지)
button.link-btn  기본값으로 (월–금 09:00–18:00)      ← prefs.workHours 가 있을 때만
```

동작:
- 처음 값: `SL.normalizeWorkHours(prefs.workHours)`.
- 시각은 `change` 에서만(입력 중 `input` 은 무시), 요일은 클릭에서 후보를 만들어 `SL.validateWorkHours` 로 검사.
  - 통과 → `S.mutate(null, s => { 기본값과 같으면 delete s.prefs.workHours; 아니면 s.prefs.workHours = value }, { silent: true })`, 요약 글 갱신, 오류 숨김, 기본값 링크 표시 여부 갱신.
  - 실패 → 저장하지 않고 오류 표시. 입력은 사용자가 친 그대로 둔다.
- 요일 버튼: `aria-pressed` 를 그 자리에서 바꾼다(다시 그리지 않음). 마지막 하나를 끄려 하면 저장하지 않고 `no_days` 메시지.
- 하루 길이 표시: `D.duration(end-start)` → "하루 9시간".
- 폰: `.settings-row` 가 줄바꿈되고 요일 pill 은 `min-width:40px; height:36px`.

### 4.4 연결 카드 (`#set-conn`, 제목 "연결") — 사용 중 · 체험 · 준비 중

1. **사용 중**
   - 메일: 지금의 메일 카드 내용(상태 줄, 마지막 동기화, 오류, 읽기 범위 문단, 상태별 버튼, **"새 할 일 제안 보기" 링크와 제안 수** — 받은편지함으로 가는 유일한 길이므로 반드시 남긴다). 끊긴 상태의 굵은 글은 "연결된 메일 없음".
   - 캘린더: `status-line` "캘린더 · Daynote 안 캘린더만 사용 중" (Google 팀이 이 줄을 연결 카드로 바꾼다).
2. **체험** (`h4`, 메일이 끊겼을 때만): `div.provider` [inbox 아이콘] **샘플 메일함** `span.chip.chip-sample` 체험 / "실제 계정에 접속하지 않고 샘플 메일 4통으로 흐름을 보여 줘요." / 버튼: 샘플이 있으면 [연결], 없으면 [샘플 불러오기].
3. **준비 중** (`h4`): `div.provider-list.is-soon` — 버튼 없이 이름 + `span.chip` **준비 중**. 아래 한 줄 "다음 버전에서 연결할 수 있게 준비하고 있어요."

```js
var PROVIDERS = [
  { id: 'gmail',        name: 'Gmail',          icon: 'mail',     status: 'soon' },
  { id: 'outlook-mail', name: 'Outlook 메일',    icon: 'mail',     status: 'soon' },
  { id: 'gcal',         name: 'Google 캘린더',   icon: 'calendar', status: 'soon' },   // Google 팀이 'ready' 로
  { id: 'outlook-cal',  name: 'Outlook 캘린더',  icon: 'calendar', status: 'soon' }
];
```

비활성 [연결] 버튼(177-180줄)은 없앤다.

### 4.5 화면 카드

단축키 표(249-261줄)에 한 줄 추가: `['/ (입력창 맨 앞)', '명령어 — /할일 · /일정 · /메모 · /도움말 …']`. 기존 `'/'` 줄 설명은 "입력창·검색 칸으로 (홈에서 입력창이 비어 있으면 ‘/’ 를 넣고 명령어 목록을 열어요)".

---

## 5. B "할 일 추천" 버튼

### 5.1 언제 보이나

`.rec-cta` 는 다음이 모두 참일 때만 보인다:
1. 오늘 화면(홈)이 열려 있다.
2. `SL.freeNow(state, now, { workHours, external, status: DN.status && DN.status.current ? DN.status.current(now) : null }).free === true`
   - 진행 중인 블록이 없다(작업·일정·외부 모두. 단 **완료한 할 일의 작업 블록**과 지운 할 일의 블록은 빼고 본다)
   - 다음 블록이 15분보다 뒤에 있거나 없다
   - 상태가 `busy:true` 가 아니다
3. 패널이 닫혀 있다(열리면 패널이 그 자리를 차지한다).
4. 숨김 기한 전이 아니다: `mem.dismissedUntil` 이 있으면 `now < dismissedUntil` 동안 숨긴다.

근무 시간과 무관하다(사용자 정의). 근무 시간 밖에는 문구만 바뀐다.

다시 계산하는 때: 저장소 변경(`chat.refresh`), 60초 틱(`today.onTick` → `chat.tick()`), 패널 동작 직후.

### 5.2 화면 배치

`renderer/views/chat.js` 의 `render` 안, `list` 와 `tools` 사이에 `recHost` 를 둔다:

```
section.chat
  div.chat-head
  div.chat-list
  div.rec-host            ← DN.views.recPanel.mount(recHost, { onCtaVisible: fn })
     ├ div.rec-cta        (보일 때)
     └ section.rec-panel  (열렸을 때)
  div.chat-tools          ("다음 할 일" 은 rec-cta 가 보이거나 패널이 열려 있으면 hidden)
  div.chat-input
```

`chat.render` 는 `{ refresh, focus, destroy, tick }` 을 돌려주고 `refresh`·`tick` 에서 `rec.paint()` 를 부른다. `today.js` 의 `onTick` 에 `if (chat.tick) chat.tick();` 추가.

모듈 기억(`recpanel.js` 안, 다시 그려도 유지):
```js
var mem = { open: false, minutes: null, choice: null /* '15'|'30'|'60'|'120'|'cal'|'custom' */,
            customText: '', error: null, skip: [], dismissedUntil: null };
```

### 5.3 CTA 줄 `.rec-cta`

```
div.rec-cta[role=region][aria-label=지금 할 일 추천]
  span.rec-cta-text   (아래 표)
  button.btn.btn-primary.rec-cta-btn[aria-expanded=false][aria-controls=rec-panel]  [spark] 할 일 추천
  button.icon-btn[aria-label=지금은 괜찮아요][title=지금은 괜찮아요]  [x]
```

| 경우 | `rec-cta-text` |
|---|---|
| 근무 시간 안, 오늘 다음 일정 있음 | 지금 비어 있어요 · ‘팀 회의’까지 1시간 20분 |
| 근무 시간 안, 오늘 남은 일정 없음 | 지금 비어 있어요 · 오늘 남은 일정이 없어요 |
| 근무 시간 밖 | 근무 시간이 아니에요 · 할 일을 골라 볼까요? |

- × 또는 "지금 시작" 성공 → `mem.dismissedUntil = next ? next.start : now + 60분`. (다음 빈 구간에서 다시 보인다)
- 폰(≤640px): 글이 한 줄로 안 들어가면 버튼이 아래 줄로 내려가고 너비 100%, 높이 44px.

### 5.4 패널 `section.rec-panel#rec-panel` — 상태와 문구

구조(늘 같은 DOM. 저장소가 바뀌면 `.rec-results` 만 다시 그린다 — 입력칸 포커스·한글 조합 유지):

```
section.rec-panel#rec-panel[aria-labelledby=rec-title]
  div.rec-head   h3#rec-title 얼마나 시간이 있어요?   button.icon-btn[aria-label=추천 닫기] [x]
  div.rec-chips[role=group][aria-label=쓸 수 있는 시간]
     button.pill[aria-pressed] 15분 · 30분 · 1시간 · 2시간  (+ 있으면) 다음 일정까지 1시간 20분
  form.rec-custom
     input.input#rec-custom-in[type=text][autocomplete=off][placeholder=직접 (예: 45, 1시간 30분, 1:30)][aria-describedby=rec-custom-msg]
     button.btn.btn-sm[type=submit] 추천 받기
  div.help#rec-custom-msg   (오류 시 role=alert)
  div.rec-results[aria-live=polite]
```

- "다음 일정까지" 칩: `freeNow.freeMinutes` 가 15 이상 720 이하일 때만. 값 = `freeMinutes`.
- 칩을 누르면 바로 결과(확인 단계 없음). 누른 칩만 `aria-pressed=true`.
- 직접 입력: Enter 또는 [추천 받기] → `D.parseDuration(text)`. 실패면 메시지를 `#rec-custom-msg` 에 보이고 `aria-invalid=true`. 성공하면 같은 값의 칩이 있으면 그 칩을 눌린 상태로, 없으면 칩은 모두 해제.
- 열 때: 첫 칩에 포커스. Esc(패널 안 포커스) 또는 × → 닫고 CTA 버튼으로 포커스. 닫으면 `minutes/choice/skip/error` 를 비운다.

추천 계산(그릴 때마다, 저장하지 않음):
```js
R.recommend(S.state, { now: A.now(), availableMinutes: mem.minutes, skipIds: mem.skip,
                       workHours: S.state.prefs.workHours, status: statusNow() })
```
`recommend.js` 는 `opts.status` 를 받아 `ctx.status = opts.status || null` 로 돌려주기만 한다(지금은 순서에 영향 없음 — 상태 팀이 정책을 더할 자리). 머리 주석의 opts 설명에 `workHours, status` 를 적는다.

결과 상태:

| 상태 | 화면 |
|---|---|
| 고르기 전 | 결과 칸 비움 |
| `primary` 있음 | 요약 `div.rec-sum` "30분 안에 할 만한 일" + (`tooLong.length` 이면) " · 더 긴 일 2개는 뺐어요". 주 후보 `div.rec-item.is-primary`: 제목(`button.link-btn` → `A.openTask`), 단계 있으면 "먼저 이 단계부터: ‘초안’", 이유 `reasons.slice(0,2)`, 칩 `ui.estimateChip(t)`·`ui.dueChip(t, now)`, 버튼 [지금 시작](진행 중이면 [이어하기]) · [다른 후보] · (단계 없으면) [작게 나누기]/[나눠 둔 단계 보기]. 다른 후보 `div.rec-alts` 제목 "다른 후보" 아래 최대 2줄: 제목 링크 + 추정 시간 meta + [시작](`btn-xs`) |
| `empty:'no_tasks'` | 아직 할 일이 없어요. 생각나는 걸 적어 주세요. [적으러 가기] → 패널 닫고 입력창 포커스 |
| `empty:'time_short'` | 30분 안에 끝낼 수 있는 할 일이 없어요. + [1시간으로 보기](다음 큰 칩이 있으면) + [큰 일 나눠 보기] → `AS.breakdown(r.tooLong[0].taskId)` |
| `empty:'all_excluded'` | 지금 바로 시작할 할 일이 없어요 · 대기 1 · 선행 업무 1 · 미룸 2 (0인 항목은 뺌) |
| `empty:'all_skipped'` | 후보를 모두 봤어요. [처음부터 다시] → `mem.skip = []` |

동작:
- [지금 시작] → `A.startTask(id)` (Promise). `true` 면 패널 닫고 `dismissedUntil` 설정. `false` 면 그대로.
- [다른 후보] → `mem.skip.push(primary.taskId)` 후 결과만 다시 그림.
- [작게 나누기] → `AS.breakdown(t.id)` (흐름에 카드가 뜬다. 패널은 열린 채).
- 문구 "30분" 은 `D.duration(mem.minutes)`.

CSS 이름: `.rec-host .rec-cta .rec-cta-text .rec-cta-btn .rec-panel .rec-head .rec-chips .rec-custom .rec-results .rec-sum .rec-item .rec-alts`. 칩은 기존 `.pill[aria-pressed]`. 패널 `max-height: 50%` 넘으면 안쪽 스크롤(`data-keep-scroll="rec"`). 폰에서 `.rec-custom` 은 입력 100% + 버튼 아래 줄.

### 5.5 직접 입력 파싱 — `dates.parseDuration(text)`

```js
parseDuration(text) → { ok: true, minutes: int } | { ok: false, error: 'empty'|'invalid'|'too_short'|'too_long', message }
DURATION_MIN = 5; DURATION_MAX = 720
```

정리: `String(text).normalize('NFKC')`(전각 숫자 → 반각) → 앞뒤 공백 제거 → 소문자 → 연속 공백 하나로 → 앞의 `약 |대략 ` 제거 → 끝의 `정도|쯤|가량|내외` 제거.

받는 형태(전체가 맞아야 함):

| 형태 | 예 | 값 |
|---|---|---|
| 숫자만(분) | `45`, `120` | 45, 120 |
| 분 | `45분`, `45 분`, `45m`, `45min`, `45 mins`, `45minutes` | 45 |
| 시간 | `1시간`, `1 시간`, `1h`, `1hr`, `2 hours`, `한 시간`, `두시간` | 60, 120 |
| 시간 + 분 | `1시간 30분`, `1시간30분`, `1시간 30`, `1h30m`, `1h 30m`, `1h30` | 90 |
| 시간 + 반 | `1시간 반`, `한 시간 반`, `반 시간` | 90, 90, 30 |
| 소수 시간 | `1.5시간`, `1.5h`, `0.5시간` | 90, 30 (반올림) |
| 시:분 | `1:30`, `0:45`, `2:00`, `01:05` | 90, 45, 120, 65 |

- 한글 수: 한 1 · 두 2 · 세 3 · 네 4 · 다섯 5 · 여섯 6 · 일곱 7 · 여덟 8 · 아홉 9 · 열 10 (시간에만). 한자어 수(삼십분)는 받지 않는다.
- 시간과 함께 쓴 분은 0–59. `1:5`, `1:75`, `1시간 70분`, `1.5시간 10분`, `30.5분`, `-30`, `30분 후`(상대 시각) → `invalid`.
- 범위: 5분 미만 → `too_short`, 720분 초과 → `too_long`.

| error | message |
|---|---|
| empty | 시간을 적어 주세요. |
| invalid | ‘45’, ‘1시간 30분’, ‘1:30’처럼 적어 주세요. |
| too_short | 5분 이상으로 적어 주세요. |
| too_long | 12시간 이하로 적어 주세요. |

### 5.6 상태와의 연결

- CTA: `DN.status.current(now).busy === true` 면 숨김(§2.5 `status`).
- 추천: `status` 를 `recommend` 에 넘기고 `context.status` 로 돌려받는다. 상태 팀이 "회의 중에는 추천하지 않음", "집중 중에는 진행 중 일만" 같은 정책을 `recommend` 의 `exclusionOf` 다음 단계에 넣는다. 이 문서는 그 정책을 정하지 않는다.

---

## 6. C 슬래시 명령어

### 6.1 명령어 표 (`src/core/commands.js` 의 `COMMANDS`, 이 순서 = 목록 순서)

| name | kind | 한글 | 영어 별칭 | 짧은 형태 | 아이콘 | 설명 | 예 |
|---|---|---|---|---|---|---|---|
| todo | task | `할일`, `할 일` | `todo`, `task` | `t` | task | 할 일로 적어요 | /할일 내일까지 견적서 보내기 |
| event | event | `일정` | `event` | `e` | calendar | 일정으로 적어요 | /일정 금요일 오후 3시 치과 |
| memo | memo | `메모` | `memo`, `note` | `m` | note | 메모로만 남겨요 (할 일을 만들지 않아요) | /메모 회의 분위기 좋았음 |
| idea | idea | `아이디어` | `idea` | `i` | idea | 아이디어로 남겨요 | /아이디어 온보딩에 퀴즈 넣기 |
| link | link | `링크` | `link` | `l` | link | 링크로 남겨요 | /링크 https://… 나중에 읽기 |
| status | — | `상태` | `status` | `s` | clock | 지금 상태를 바꿔요 | /상태 회의 중 |
| help | — | `도움말` | `help` | `h`, `?` | command | 명령어 목록을 보여 줘요 | /도움말 |

`needsArgs`: todo·event·memo·idea·link = true, status·help = false. `noArgs`(Enter 로 바로 실행): help 만.

### 6.2 `parse(text)`

```js
parse(text) → {
  command: 'todo'|'event'|'memo'|'idea'|'link'|'status'|'help'|null,
  kind:    'task'|'event'|'memo'|'idea'|'link'|null,
  args:    string,        // 명령 뒤 본문. 명령이 없으면 원문(앞뒤 공백 제거). 이스케이프면 '/' 하나 뗀 원문
  raw:     string,        // 받은 그대로
  token:   string|null,   // 사용자가 친 그대로의 명령 토큰 ('/TODO', '/할일')
  unknown: string|null,   // 명령처럼 보이지만 없는 토큰 ('todos') — 일반 글로 처리
  escaped: boolean
}
```

규칙:
1. `s = String(text ?? '').normalize('NFC')`, 앞 공백(줄바꿈 포함) 제거.
2. 첫 글자가 `/` 또는 `／`(U+FF0F)가 아니면 명령 아님. `args = s.trim()`.
3. 둘째 글자도 슬래시면 **이스케이프**: `escaped:true`, `args = s.slice(1).trim()`.
4. `head = s.slice(1)`. 모든 이름(한글·영어·짧은 형태)을 **긴 것부터** 대 본다. 라틴 글자는 대소문자 무시. 이름 뒤 글자가 공백·`:`·`：`·끝일 때만 맞음 (`/todox` ✗, `/todo:` ✓, `/할 일이` ✗).
5. 맞으면 나머지에서 맨 앞 `:`/`：` 하나와 앞 공백(줄바꿈 포함)을 떼고 끝 공백을 지운 것이 `args`. 줄바꿈은 안쪽에서는 그대로 둔다.
6. 안 맞으면 `head` 가 `^[A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ?]{1,15}(?=[\s:：]|$)` 이면 `unknown` = 그 토큰, 아니면 명령 아님(`/usr/bin`, `/10 회의` 는 일반 글, 안내 없음).
7. 명령은 **글 맨 앞**에서만 본다(`우유 /todo` 는 일반 글).

그 밖의 내보내기:
```js
COMMANDS, get(name)
match(query) → [{ name, kind, token, alt: ['/todo','/t'], desc, example, icon, noArgs, exact }]
suggestFor(token) → 'todo' | null     // 없는 명령에 '혹시 …' 안내용
_jamo(s)                              // 시험용
```

`match(query)` (자동완성):
- `query` = `/` 뒤 글자(공백 없는). NFC + 라틴 소문자.
- 비교는 **자모 분해 앞부분 일치**: 한글 음절을 초·중·종성 호환 자모로 풀고 겹받침(ㄳ ㄵ ㄶ ㄺ ㄻ ㄼ ㄽ ㄾ ㄿ ㅀ ㅄ)도 둘로 푼다. 그래서 조합 중인 `/ㅎ`, `/하`, `/할`, `/할ㅇ`, `/멤`(→메모) 이 모두 맞는다.
- 명령마다 후보 순서 [한글들, 영어 이름, 영어 별칭, 짧은 형태] 중 처음 맞는 것으로 판정하고, 명령 하나는 한 번만.
- 정렬: 후보 전체와 정확히 같은 것(`exact`) 먼저, 나머지는 표 순서.
- 보여 줄 `token`: 빈 질의 → 한글(`/할일`). 맞은 후보가 한 글자 짧은 형태면 영어 이름(`/todo`), 아니면 맞은 후보 그대로. `alt` 는 나머지 대표 형태(한글/영어/짧은 형태, `할 일` 은 빼고).
- 맞는 게 없으면 `[]`.

`suggestFor(token)`: 모든 이름 중 편집 거리 1 이하이거나 한쪽이 다른 쪽의 앞부분인 것이 **정확히 하나**면 그 `name`, 아니면 `null`.

### 6.3 어디서 걸리나 (파이프라인 훅)

```
A) 홈 입력창  chat.js sendNow() ── 빈 본문 검사(§6.4) ──> AS.send(raw)
B) 빠른 메모 창 quick.js send() ── /도움말·빈 본문은 창 안에서 처리(§6.10) ──> IPC quick:submit(raw)
                                   ──> main ──> assistant.watch onQuickCapture ──> AS.send(raw)
C) Ctrl+N     app.saveQuick(text, projectId) ── 자체 분기(§6.4) ──> DN.capture.submit(args, projectId, null, {command})

AS.send(text, projectId)   ← 명령 판단은 여기서 한 번 (A·B 공통)
   p = CMD.parse(text)
   help    → post 사용자 말풍선(raw) → post {kind:'help'}                     → return null
   status  → post 말풍선 → statusCommand(p.args)                              → return null
   kind    → (args 비면 안내 text 만 post, return null)
             post 말풍선(raw) → note = DN.capture.submit(p.args, projectId, onDone, { command: p }) → post {kind:'capture', noteId}
   unknown → 일반 글과 똑같이 submit(raw) → capture 카드 다음에 안내 text post (§6.12)
   escaped → 일반 글처럼 submit(p.args)
   그 밖   → 지금 그대로
```

`DN.capture.submit(text, projectId, onDone, opts)` — 네 번째 인자 추가. `opts.command` 가 없으면 **지금과 완전히 같다**. 있으면 §6.5. `submit` 자체는 명령어를 해석하지 않는다(받은 본문을 그대로 저장한다는 계약 유지).

### 6.4 빈 본문과 Ctrl+N

- 홈 입력창: `sendNow()` 에서 `p.kind && !p.args` 이면 보내지 않고, 글을 지우지 않으며, 입력창 아래 `div.chat-input-note[role=status]` 에 "‘/할일’ 뒤에 적을 내용을 써 주세요." (다음 입력에서 사라짐).
- `AS.send` 로 빈 본문이 들어오면(빠른 창 우회 등): 말풍선 없이 `post({kind:'text', text:'‘/할일’ 뒤에 적을 내용이 없어서 아무것도 만들지 않았어요.'})`.
- Ctrl+N `saveQuick(text, projectId, opts)`:
  - kind + 본문 → `DN.capture.submit(p.args, projectId, null, { command: p })`, 토스트 "할 일로 저장했어요." (종류 라벨) + [오늘에서 보기]
  - kind + 빈 본문 → 토스트 "‘/할일’ 뒤에 내용을 적어 주세요." `return false`(창 유지)
  - help → 창을 닫고 `go('today')` 후 `AS.post({kind:'help'})`
  - status → `statusCommand(p.args, { surface:'toast' })` (결과를 토스트로)
  - unknown/일반 → 지금처럼 `submit(text)` (unknown 이면 토스트 끝에 " · ‘/todos’는 없는 명령어라 그대로 저장했어요")

### 6.5 명령어로 정한 종류 — 저장과 즉시 생성 (`renderer/capture.js` + `src/core/ai/forced.js`)

`submit` 의 command 분기:

```js
var cmd = opts.command;                                 // parse 결과
var id = M.uid('note');
var aiOn = DN.aiFlow.status().configured;
if (aiOn) inflight[id] = true;                          // 첫 그림부터 '다듬는 중' 이 되게 (아래 classify 변경과 짝)
var note = S.mutate('입력 저장', function (s) {
  var n = M.addNote(s, { id: id, title: '', body: text, projectId: projectId || null,
    capture: { status: 'pending', at: now().toISOString(), entryType: null, created: [],
               command: { name: cmd.command, kind: cmd.kind, token: cmd.token, raw: cmd.raw } } }, now());
  F.createForced(s, n, now());                          // 같은 되돌리기 단계 안에서 항목을 바로 만든다
  return n;
}, { source: 'capture' });
classify(note.id, { starting: true }).then(…onDone…);
```

`classify` 변경:
- `inflight[noteId] = true` 를 run 시작 mutate(52줄) **앞으로** 옮긴다(같은 작업 안의 마지막 그림이 '실행 중' 이 되게). `{starting:true}` 이면 처음 가드(`inflight[noteId]` 이면 그만)를 건너뛴다.
- 성공 후 `if (sent.capture && sent.capture.command)` → `S.mutate('AI 다듬기', s => { finishRun(…); cap = F.refineForced(s, { note: sent, run: r, validated: v, output: res.output }, t); })`. 아니면 지금처럼 `'AI 분류'` + `applyCapture`.
- AI 미설정·실패·형식 오류 분기는 그대로(`status` 만 `no_ai`/`failed`). 항목은 이미 있으므로 잃는 것이 없다.

`F.createForced(state, note, now)` (순수, state 를 바꿈):

| kind | 만드는 것 | note |
|---|---|---|
| task | `M.addTask({ title, memo, dueDate, dueTime, projectId: note.projectId, sources:[{type:'note', refId, excerpt: body 앞 300자}], origin:'user' })`. 할 시각(`at`)이 있으면 30분 작업 블록 `{ taskId, start, end, sources, origin:'user', durationGuessed:true }` | `captureRole:'task_source'`, `capture.entryType:'task'`, `created:[{kind:'task', id}]` |
| event | `M.addBlock({ kind:'event', title, start, end, projectId, sources, origin:'user', timeUncertain, durationGuessed })` | `captureRole:'task_source'`, `entryType:'task'`, `created:[{kind:'block', id}]` |
| memo/idea/link | 만들지 않음 | `captureRole:'memo'`, `kind`, `kindByUser:true`, `entryType:'memo'`, `created:[]` |

그리고 `capture.command.base` = 만든 값의 사본, `capture.command.refined = []`.
- task: `{ title, memo, dueDate, dueTime, projectId, workId, workStart, workEnd }`
- event: `{ title, start, end, projectId, timeUncertain, location: null }`
- memo류: `{ title: '', projectId }`

**중복 검사는 하지 않는다**(사용자가 명시적으로 새로 만들라고 했다). 만든 항목은 `origin:'user'` 이고 proposals 를 만들지 않는다.

### 6.6 규칙 추출 — `F.rulesItem(text, kind, now)` (AI 없이도 날짜를 찾는다)

```js
rulesItem(text, 'task', now)  → { kind:'task', title, memo, dueDate|null, dueTime|null, at: {date, time}|null }
rulesItem(text, 'event', now) → { kind:'event', title, date, time, timeUncertain, durationMinutes, durationGuessed }
```

1. 첫 줄(빈 줄 제외) = 제목 재료, 나머지 줄 = `memo`(할 일만, 앞뒤 공백 정리, 2000자까지). 첫 줄 앞의 `- `, `* `, `1. `, `[ ]` 는 뗀다(`suggest.cleanTitle` 과 같은 규칙).
2. 날짜: `SG.parseDueHint(첫 줄, now)` → `{dueDate, phrase}`.
3. 상대 시각: `V.relativeAt(첫 줄, now)` → `{date, time}` (`validate.js` 에서 `relativeAt`, `relativeMinutes` 를 **내보내기**에 추가).
4. 시각: `V.timeCandidates(첫 줄)` 와 그 표현(정규식으로 위치를 함께 얻는 `timeMatch` 를 `validate.js` 에 추가해 내보낸다: `→ { text, index, candidates } | null`).
5. 길이(일정): `V.durationSpan(text, startTime)` — `checkDuration` 안의 "2시~4시", "1시간", "30분간" 계산을 함수로 빼서 내보낸다(`checkDuration` 은 그 함수를 쓴다).

| kind | 시각 표현 | 결과 |
|---|---|---|
| task | 상대 시각("30분 후") | `at` = 상대 시각. 날짜는 쓰지 않는다 |
| task | 후보 1개("오후 3시", "15:00") + 뒤에 "까지" | `dueDate` = 날짜 표현 또는 오늘, `dueTime` = 시각 |
| task | 후보 1개, "까지" 없음 | `at` = (날짜 표현 또는 오늘, 시각). 오늘인데 이미 지났으면 `at` 없이 `dueDate`=오늘만 |
| task | 후보 2개("3시") | 시각을 **쓰지 않는다**. 날짜 표현이 있으면 `dueDate` |
| task | 없음 | 날짜 표현이 있으면 `dueDate` |
| event | 상대 시각 | 그 날짜·시각, `timeUncertain:false` |
| event | 후보 1개 | (날짜 표현 또는 오늘/지났으면 내일, 시각), `timeUncertain:false` |
| event | 후보 2개 | 1–6시는 오후, 7–11시는 오전으로 고르고 `timeUncertain:true`. 날짜는 위와 같음 |
| event | 시각 없음, 날짜 있음 | 그날 09:00, `timeUncertain:true` |
| event | 둘 다 없음 | `P.guessStart(null, null, now)`(다음 정시), `timeUncertain:true` |

- `proposals.js` 의 내부 함수 `guessStart`, `matchProject` 를 **내보내기**에 더해 `forced.js` 가 재사용한다(로드 순서상 proposals 가 앞).

- 일정 길이: `durationSpan` 이 있으면 그 값(`durationGuessed:false`), 없으면 **30분**(`durationGuessed:true`) — 명령어 없이 적은 일정(AI 경로, `applyCapture`)과 같게.
- 제목: 첫 줄에서 **실제로 칸에 쓴 표현만** 뺀다(쓴 날짜 표현, 쓴 시각 표현과 바로 뒤 `에|부터|까지`, 쓴 상대 시각과 뒤 `에`, 쓴 길이 표현 "2시~4시"). 쓰지 않은 "3시" 는 제목에 남긴다. 그다음 앞뒤의 `,`·`.`·공백과 앞에 홀로 남은 조사(`에 `, `까지 `)를 지우고 공백을 하나로. 비면 첫 줄 원문. 120자 넘으면 117자 + `…`.

### 6.7 AI 다듬기 — `F.refineForced(state, { note, run, validated, output }, now)`

1. `note = M.byId(state.notes, args.note.id)`. 없거나 `capture.command` 가 없으면 `null`.
2. `capture.changedByUser` 이면(종류 칩 등으로 사용자가 바꿈) → `status:'done', error:null, runId, doneAt` 만 적고 끝.
3. **쓰지 않는 것**: `output.entry_type`, `note_kind`, `done_tasks`, `updated_tasks`, 그리고 `mergeOrganizeRun`(초안 저장) — 명령어 글은 검토할 초안을 남기지 않는다. `validated.items[].duplicateOf` 도 무시한다.
4. 프로젝트 후보 `proj`: 사용자가 처음 고른 `note.projectId`(Ctrl+N 선택) > AI 항목의 `fields.projectId`(아래 5의 항목이 있고 `status:'ok'`) > `matchProject(output.note_project_hint)`.
5. AI 항목 `ai = F.pickAiItem(validated)`: `validated.items` 중 `kind` 가 task/event 인 것이 **정확히 하나**면 그것, 아니면 `null` (D14).
6. 칸별 적용 — **지금 값 === base 값**일 때만 바꾸고, 바꾼 칸 이름을 `refined` 에 넣는다. `status:'ok'` 인 칸만 쓴다(`confirm` 은 쓰지 않음).

| 강제 종류 | AI 항목 | 쓰는 것 |
|---|---|---|
| task | task | `title`, `dueDate`, `dueTime`, (`atDate`+`atTime` 둘 다 ok) → 작업 블록: base 의 작업 블록이 그대로면 옮기고, 없고 지금 작업 블록도 없으면 30분 블록 새로(`durationGuessed:true`) |
| task | event | `title`, (`date`+`time` ok) → 작업 블록(위와 같은 규칙) |
| event | event | `title`, (`date`+`time` ok) → 시작 옮김·`timeUncertain:false`, `durationMinutes` ok → 끝 다시 계산·`durationGuessed:false`, `location` |
| event | task | `title`, `dueDate` ok → 날짜만 바꾸고 시각 유지, (`atDate`+`atTime` ok) → 시작 옮김·`timeUncertain:false` |
| memo/idea/link | — | `note.title` 이 비어 있으면 `output.note_title`(80자까지). `note.kind`·`kindByUser` 는 그대로 |
| 모두 | — | `proj` 가 있으면 항목 `projectId`(base 와 같을 때)와 `note.projectId`(비어 있을 때) |

7. 큰 일: 강제 종류가 task 이고 `ai` 가 있고 `ai.extra.breakdown` 이 있고 할 일에 단계가 없으면 `task.breakdown = { status:'pending', steps, source:'capture', createdAt, shownAt:null }`, `largeTasks:[taskId]` (기존 `onDone` 안내가 그대로 동작).
8. 만든 항목이 그사이 지워졌으면(×) 그 항목은 건드리지 않고 다시 만들지도 않는다.
9. `note.capture = { …, status:'done', error:null, runId, doneAt, largeTasks, command: { …, refined } }`. 반환 `note.capture`.

필드 이름(`refined`)과 카드 문구: `title` 제목 · `dueDate`/`date` 날짜 · `dueTime`/`time`/`at` 시각 · `durationMinutes` 길이 · `location` 장소 · `projectId` 프로젝트.

### 6.8 결과 카드 (`renderer/views/chat.js` `captureCard`/`capRow`)

명령어 글(`c.command` 있음)은 따로 그린다. 항목이 처음부터 있으므로 **스켈레톤을 쓰지 않는다**.

| 상황 | 머리 | 줄 | 바닥 |
|---|---|---|---|
| AI 다듬는 중 (`CP.isRunning(id)`) | `summary(items)` + 보조 " · 명령어로 지정" | 항목 줄 | `span.spinner` + "AI가 제목·날짜를 다듬는 중…" |
| 멈춤 (`status==='pending' && !isRunning`) — 'AI 다듬기' 되돌리기·앱 종료 뒤 | 같음 | 같음 | "다듬기가 멈췄어요" + [다시 다듬기] → `CP.classify(n.id)` |
| AI 없음 (`no_ai`) | 같음 | 같음 | task/event: "명령어로 지정 · AI 없이 날짜만 찾았어요" / 메모류: "명령어로 지정" (설정 열기 버튼 없음) |
| 실패 (`failed`) | 같음 | 같음 | "명령어로 지정 · AI로 다듬지 못했어요" + [다시 다듬기] |
| 끝 (`done`), `refined` 있음 | 같음 | 같음 | "명령어로 지정 · AI가 제목·날짜를 다듬음 · `Ctrl+Z`로 되돌리기" (`refined` 를 표의 한국어로, 최대 3개 `·` 로) |
| 끝, `refined` 없음 | 같음 | 같음 | "명령어로 지정 · `Ctrl+Z`로 되돌리기" |
| `changedByUser` | 기존 요약 | 기존 | 기존 "직접 고침" |

**종류 칩 잠금 표시**: `c.command && !c.changedByUser` 이고 그 줄이 명령어로 만든 항목(메모류면 메모 줄)일 때:
```
button.chip.chip-kind.cap-kind.kind-task.is-forced
  [task 아이콘] 할 일 [lock 아이콘 .cap-lock] [chevronDown .cap-caret]
  aria-label="종류: 할 일, 명령어로 지정 — 바꾸기"
  title="‘/할일’ 명령어로 정한 종류예요. 눌러서 바꿀 수 있어요."
```
- 누르면 지금과 같은 종류 메뉴(`kindMenu`). 메뉴 머리말만 "명령어로 정한 종류예요. 무엇으로 바꿀까요?". 바꾸면 기존 `setKind/setItemKind` → `changedByUser:true` → 잠금이 사라지고 바닥은 "직접 고침". 이후 늦게 도착한 AI 결과는 §6.7-2 로 아무것도 바꾸지 않는다.
- `ui.icon` 에 `lock` 추가: `'<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'`. CSS `.cap-lock{width:11px;height:11px;opacity:.75}`.

**사용자 말풍선**: `m.text` 를 `CMD.parse` 해서 명령이면 `span.chip.msg-cmd`(토큰 그대로, 예 `/할일`) + 공백 + 본문으로 그린다(그릴 때만 해석, 저장은 원문).

### 6.9 `/상태`

`assistant.js` 에 `statusCommand(args, opts)`:
```js
var ST = DN.status;
if (!ST || typeof ST.setFromCommand !== 'function') → '상태 기능은 아직 준비 중이에요. 적은 내용은 저장하지 않았어요.'
else if (!args) { var cur = ST.current ? ST.current(now()) : null;
  → cur ? '지금 상태는 ‘' + cur.label + '’예요. 바꾸려면 ‘/상태 회의 중’처럼 적어 주세요.'
        : '‘/상태 회의 중’처럼 적으면 지금 상태를 바꿔요.' }
else { var r = ST.setFromCommand(args, { now: now(), source: 'command' });
  → r && r.ok ? (r.message || '상태를 ‘' + (r.label || args) + '’' + 로/으로 + ' 바꿨어요.') : ((r && r.message) || '상태를 바꾸지 못했어요.') }
```
흐름에서는 `post({kind:'text', text})`, Ctrl+N 에서는 토스트. 메모는 만들지 않는다.

### 6.10 자동완성 팝업 — `renderer/slash.js` (`DN.slash`)

`ui.js` 를 쓰지 않는 순수 DOM 컴포넌트(빠른 메모 창에서도 쓰기 위해). 의존: `window.Daynote.commands` 만.

```js
DN.slash.attach(textarea, {
  mount: Element,                 // 목록을 넣을 곳 (홈: .chat-input, 빠른 창: #panel)
  placement: 'above' | 'below',   // 홈: above(입력창 위), 빠른 창: below(제자리, 창 높이를 늘림)
  idPrefix: 'slash',
  iconFor: function (iconName) → Node | null,   // 홈은 ui.icon, 빠른 창은 null
  onExecute: function (text) {},  // noArgs 명령을 Enter·탭으로 고르면 바로 보낼 글 ('/도움말')
  onResize: function () {}        // 빠른 창의 fit()
}) → { isOpen(), close(), refresh(), destroy() }
```

열림 조건(`input` 이벤트마다 검사 — 한글 조합 중에도 값이 들어오므로 `keydown` 이 아니라 `input` 으로 본다):
- 값 전체가 `^[/／][^\s/／]*$` (명령 토큰만, 공백·줄바꿈 없음), 커서가 끝, `value !== dismissedValue`.
- 질의 = 슬래시 뒤 글자 → `CMD.match(query)`.

DOM:
```
div.slash-pop#slash-list[role=listbox][aria-label=명령어]
  div.slash-opt#slash-opt-0[role=option][aria-selected=true].is-active
     span.slash-ico (아이콘)  span.slash-main ( b.slash-token /할일  span.slash-desc 할 일로 적어요 )  span.slash-alt /todo · /t
  …
  div.slash-empty   맞는 명령어가 없어요 · 그대로 보내면 글로 적어요      (결과가 [] 일 때, 고를 수 없음)
  div.slash-foot    ↑↓ 고르기 · Enter·Tab 넣기 · Esc 닫기                (폰에서 숨김)
```
- 홈: `.chat-input { position: relative }`, 팝업 `position:absolute; left:12px; right:12px; bottom:calc(100% + 4px); max-height:280px; overflow:auto` — `body` 에 띄우지 않으므로 스크롤·크기 변경·화면 키보드에서 따로 위치를 맞출 필요가 없다(`.chat` 의 `overflow:hidden` 안에서도 위쪽은 채팅 목록 영역이라 잘리지 않는다).
- 모양: `--surface-raised`, `--shadow-float`, `--r-panel`, 줄 높이 38px(폰 44px), 활성 줄 `--primary-soft`. 종류 명령 줄은 `.kind-<k>` 로 아이콘 색.
- 입력창 속성: `aria-autocomplete="list"`, `aria-controls="slash-list"`, `aria-expanded="true|false"`, 활성 줄이 있으면 `aria-activedescendant`.

키(팝업이 열려 있고 고를 줄이 있을 때만, `e.isComposing || e.keyCode === 229` 이면 아무것도 안 함):

| 키 | 동작 |
|---|---|
| ↓ / ↑ | 활성 줄 이동(끝에서 처음으로 돈다) |
| Tab | 활성 명령으로 **완성**: 값 = `token + ' '`, 커서 끝, 팝업 닫힘 |
| Enter | `noArgs`(도움말)면 `onExecute(token)` 로 바로 보냄. 아니면 Tab 과 같이 완성(보내지 않음) |
| Esc | 팝업만 닫고 `dismissedValue = value` (글은 그대로). 앱의 Esc(상세 패널 닫기)로 번지지 않게 `stopPropagation` |
| Shift+Enter | 막지 않음(줄바꿈 → 조건이 깨져 닫힌다) |

위 키를 처리하면 `preventDefault()` + `stopImmediatePropagation()`. **`attach` 를 chat.js 의 Enter 리스너(84줄)·quick.js 의 keydown 보다 먼저 등록**한다(같은 요소의 리스너는 등록 순서대로 불린다).

마우스·터치: 줄에 `pointerdown → preventDefault()`(포커스·화면 키보드 유지), `pointermove → 활성`, `click → Enter 와 같은 동작`. `blur` 150ms 뒤 닫힘. 줄이 없는 상태(`slash-empty`)에서 Enter 는 막지 않는다(보내기 → 모르는 명령 처리).

전역 `/` 단축키(`app.js:304-308`): 대상이 홈 입력창(`TEXTAREA`)이고 값이 비어 있으면 포커스 뒤 `value='/'` 로 두고 `input` 이벤트를 보내 팝업을 연다. 값이 있으면 지금처럼 포커스만.

입력창 안내: `.chat-input-hint` "Enter 보내기 · Shift+Enter 줄바꿈 · / 명령어". 자리표시는 그대로.

### 6.11 `/도움말` 카드 (채팅 `kind:'help'`)

```
div.help-card
  div.help-card-title  명령어
  ul
    li  button.help-cmd(chip) /할일   span.meta /todo · /t   div 할 일로 적어요   div.meta 예) /할일 내일까지 견적서 보내기
    … (표 6.1 순서, 7줄)
  div.meta  명령어 없이 적으면 Daynote가 알아서 나눠요 · 명령어로 정한 종류도 결과 카드에서 바꿀 수 있어요 · ‘/’를 글자로 쓰려면 //로 시작하세요
```
`help-cmd` 를 누르면 입력창에 `'/할일 '` 를 채우고 포커스(`.chat-input textarea` 에 값 + `input` 이벤트). 카드는 `state.chat` 에 남는다(최대 200).

### 6.12 모르는 명령어

- 저장: 원문 그대로(명령 아님). AI 도 원문 그대로 받는다.
- 안내(capture 카드 다음 `post({kind:'text'})`):
  - `suggestFor` 결과 있음: "‘/todos’는 없는 명령어라 그냥 적은 글로 정리했어요. ‘/todo’를 쓰려던 거라면 다음엔 그렇게 적어 주세요."
  - 없음: "‘/abc’는 없는 명령어라 그냥 적은 글로 정리했어요. /도움말로 명령어를 볼 수 있어요."

### 6.13 빠른 메모 창 (`renderer/quick.html`, `renderer/quick.js`)

- 스크립트: `commands.js`, `slash.js` 를 `quick.js` 앞에. `DN.slash.attach(ta, { mount: panel, placement: 'below', onResize: fit, onExecute: showHelp })`. 인라인 CSS 에 `.slash-pop`(제자리 블록, 테두리 위쪽 1px), `.slash-opt`, `.is-active`, `.qhelp` 추가(색은 창의 기존 변수 `--surface --border --text --text-2 --primary --primary-soft`).
- 창 높이: 7줄 × 36px + 패널 ≈ 380px, `quick:resize` 의 상한(400) 안.
- `send()` 분기(`p = DN.commands.parse(text)`):

| 경우 | 동작 | 창 문구(`#sent-text` 또는 안내 줄) |
|---|---|---|
| help | 보내지 않고 `div.qhelp` 에 명령어 목록 펼침(Esc 로 접힘, 다시 Esc 면 창 숨김) | — |
| kind + 빈 본문 | 보내지 않음, 창 유지 | ‘/할일’ 뒤에 적을 내용을 써 주세요. |
| kind | `Q.submit(text)` | 할 일로 보냈어요. Daynote 오늘 화면에서 볼 수 있어요. (종류 라벨) |
| status | `Q.submit(text)` | 상태 바꾸기를 보냈어요. |
| unknown | `Q.submit(text)` | 보냈어요 · ‘/todos’는 없는 명령어라 글로 적었어요. |
| 그 밖 | 지금 그대로 | 지금 그대로 |

- 바닥 안내에 `<span><kbd>/</kbd> 명령어</span>` 추가.

---

## 7. 테스트 목록 (`node --test`, 고정 시계 `new Date(2026, 9, 5, 10, 0)` 월요일, 필요 시 10-10 토요일)

### 7.1 `test/slots.test.js`

근무 시간
1. `normalizeWorkHours(undefined)` → `{09:00, 18:00, [1,2,3,4,5]}`
2. `{start:'10:00', end:'19:00'}` → days 기본값으로 채움
3. 잘못된 시각(`'aa'`, start ≥ end) → 시간 둘 다 기본값. days `[5,1,1,9,'x']` → `[1,5]`, `[]` → 기본값
4. `validateWorkHours`: 정상 / `end_before_start` / `too_short`(09:00–09:20) / `no_days` / `invalid_time` — 각 메시지 문자열 존재
5. `describeWorkHours`: 월–금 → `'월–금 09:00–18:00'`, 7일 → `'매일 …'`, `[1,3,5]` → `'월·수·금 …'`, `[6,0]` → `'토·일 …'`, `[1,2,3]` → `'월–수 …'`
6. `isWorkingTime`: 월 10:00 참 / 월 09:00 참 / 월 18:00 거짓(끝 제외) / 토 10:00 거짓 / days 에 6 넣으면 토 10:00 참
7. `workWindow(토)` → null, `workWindow(월)` → 현지 09:00–18:00

바쁜 시간
8. 작업·일정 블록 모두 포함, `ignoreId` 제외, 지운 할 일의 블록 제외, 끝낸 할 일의 블록은 기본 포함 / `includeDoneWork:false` 면 제외
9. 외부: `opts.external` 과 `state.externalEvents` 둘 다 읽음. `cancelled`·`transparent`·`busy:false` 제외, 종일은 `busy:true` 일 때만, `externalId` 가 같은 블록이 있으면 외부 쪽 제외
10. 오프셋 ISO(같은 순간을 `+09:00` 표기로 만든 문자열)와 `toISOString()` 블록이 같은 순간으로 겹침 판정됨(시간대와 무관하게 통과)
11. NaN·`end <= start` 항목 무시. 입력 배열·state 를 바꾸지 않음
12. `conflicts` 반열린: 10:00–10:30 vs 10:30–11:00 없음, 10:15–10:45 하나

빈 시간 찾기
13. work: 월 10:00, 30분, 바쁨 10:00–11:00 → 11:00
14. 이어진 바쁨(10:00–10:30, 10:30–11:15) 합쳐서 → 11:15
15. 15분 칸: 바쁨 끝 10:40 → 10:45
16. 같은 길이 90분: 60분 틈은 건너뛰고 다음 맞는 틈
17. 근무 끝 넘김: 월 17:30 60분 → 화 09:00, `sameDay:false`, `dayOffset:1`
18. 금 17:30 60분 → 다음 월 09:00(주말 건너뜀)
19. day: 토 10:00(근무일 아님) 바쁨 10:00–11:00 → 토 11:00. 22:45 에서 30분 → 다음 날 07:00
20. `pickMode`: 근무 창 안 → work, 20:00 → day, 출근 전 07:30 → day. `defaultMode`: 월 07:30 → work, 월 19:00 → day, 토 → day
21. now 이전은 내지 않음: from 어제, now 월 10:07 → 10:15 이후
22. `too_long`: work 600분, day 961분
23. `no_slot`: 14일 근무 창이 모두 바쁨
24. 외부(Google) 바쁨이 자리를 막음
25. `ignoreId` 로 고치는 블록 자신은 막지 않음
26. 사용자 근무 시간(10:00–16:00, 월–토) 따름
27. `bad_input`: minutes 0, from 무효

지금 비어 있나
28. 블록 없음 → free, next null, reason null
29. 진행 중(`start <= now < end`) → `in_progress`, current 채움
30. 지금 막 끝난 블록 → free
31. 정확히 15분 뒤 시작 → `imminent` / 16분 뒤 → free, `freeMinutes` 15(5분 내림)
32. 끝낸 할 일의 작업 블록이 진행 중 → free
33. 외부 일정 진행 중 → `in_progress`
34. `status:{busy:true}` → `status`, `{busy:false}`·null → 영향 없음
35. 23:55 에 다음 날 00:05 블록 → `imminent`
36. `workTime` 참/거짓, 지운 할 일의 블록 무시

### 7.2 `test/commands.test.js`

1. 일반 글 → `command:null, unknown:null, escaped:false, args` = 앞뒤 공백 뗀 원문
2. `'/todo 우유 사기'` → todo/task, args `'우유 사기'`, token `'/todo'`
3. 한글 `'/할일 내일까지 견적서'`, 띄어 쓴 `'/할 일 견적서'` → todo
4. `'/할 일이 많다'` → command null, unknown `'할'`
5. 대소문자 `'/TODO x'` → todo, token `'/TODO'`
6. 짧은 형태 `/t /e /m /i /l /s` + 본문, `/h`, `/?` → 각 명령
7. 영어 별칭 `'/task x'` → todo, `'/note x'` → memo
8. 경계: `'/todox 우유'` → unknown `'todox'`; `'/todo:우유'`, `'/todo: 우유'`, `'/todo：우유'` → args `'우유'`
9. 전각 슬래시 `'／할일 우유'` → todo
10. 앞 공백 `'  /memo 회의'` → memo
11. 명령만 `'/memo'`, `'/메모   '` → args `''`
12. 여러 줄: `'/todo\n우유 사기\n계란'` → args `'우유 사기\n계란'`; `'/todo 우유\n계란'` → `'우유\n계란'`
13. 중간의 명령 `'우유 /todo'` → 일반 글
14. 이스케이프 `'//todo 글자'` → command null, escaped true, args `'/todo 글자'`
15. `'/usr/bin 정리'`, `'/10 회의'`, `'/'` → 일반 글, unknown null
16. NFD 로 분해된 `'할일'` 도 todo
17. `'/도움말 할일'` → help, args `'할일'`; `'/상태 회의 중'` → status, kind null, args `'회의 중'`
18. `match('')` → 7개 표 순서, 첫 token `'/할일'`
19. `match('ㅎ')`, `match('하')`, `match('할')`, `match('할ㅇ')` → [todo]; `match('멤')` → [memo]; `match('ㄷ')`/`match('도')` → [help]; `match('ㅅ')` → [status]
20. `match('t')` → 첫째 todo, token `'/todo'`; `match('m')` → 첫째 memo(`exact`); `match('?')` → help; `match('x')` → `[]`
21. `alt` 에 `'할 일'` 이 없고 대표 형태만
22. `suggestFor('todos')` → `'todo'`, `suggestFor('할릴')` → `'todo'`, `suggestFor('xyz')` → null
23. 표 무결성: 모든 이름(한글·영어·짧은 형태)이 명령 사이에 중복 없음, kind 는 다섯 종류 또는 null
24. `require` 만으로 동작(`window` 없음), 입력을 바꾸지 않음

### 7.3 `test/dates.test.js` (`parseDuration`)

1. 숫자만: `'45'`→45, `'120'`→120
2. 분: `'45분' '45 분' '45m' '45min' '45 mins'` → 45
3. 시간: `'1시간' '1 시간' '1h' '1hr' '2 hours' '한 시간' '두시간'` → 60/120
4. 시간+분: `'1시간 30분' '1시간30분' '1시간 30' '1h30m' '1h 30m' '1h30'` → 90
5. 반: `'1시간 반' '한 시간 반'` → 90, `'반 시간'` → 30
6. 소수: `'1.5시간' '1.5h'` → 90, `'0.5시간'` → 30
7. 시:분: `'1:30'`→90, `'0:45'`→45, `'2:00'`→120, `'01:05'`→65
8. 꾸밈말: `'약 30분' '30분 정도' '30분쯤' '  30 분  '` → 30, 전각 `'３０분'` → 30
9. 오류 invalid: `'abc' '1:5' '1:75' '1시간 70분' '1.5시간 10분' '30.5분' '-30' '30분 후'`
10. 오류 empty: `'' '   ' null`
11. 범위: `'0' '3'` → too_short, `'13시간' '721'` → too_long, `'5'` → 5, `'12시간'` → 720
12. 결과는 정수, 오류마다 `message` 문자열
13. `duration(parseDuration('1시간 30분').minutes) === '1시간 30분'` (왕복)

### 7.4 `test/forced.test.js` (`src/core/ai/forced.js`, + `validate` 새 내보내기)

규칙 추출(`rulesItem`, NOW 월 10:00)
1. task `'내일까지 견적서 보내기'` → 제목 `'견적서 보내기'`, dueDate 10-06, at null
2. task `'30분 후 샤워하기'` → `'샤워하기'`, at 오늘 10:30, dueDate null
3. task `'오후 3시에 보고서 쓰기'` → at 오늘 15:00, `'보고서 쓰기'`
4. task `'오후 3시까지 보고서'` → dueDate 오늘, dueTime 15:00, at null
5. task `'3시 보고서'` → 시각 안 씀, 제목 `'3시 보고서'` 그대로
6. task `'오전 9시에 운동'` (이미 지남) → at null, dueDate 오늘
7. event `'다음 주 화요일 3시 치과'` → 10-13 15:00, timeUncertain true, `'치과'`, 30분, durationGuessed true
8. event `'내일 오전 10시 팀 회의'` → 10-06 10:00, timeUncertain false, `'팀 회의'`
9. event `'금요일 2시~4시 워크숍'` → 10-09 14:00(오전/오후 없음 → 오후, timeUncertain true), 120분, durationGuessed false, `'워크숍'`
10. event `'팀 회식'` → 오늘 11:00, timeUncertain true
11. event `'9시 스탠드업'` → 내일 09:00(오늘은 지남), timeUncertain true
12. event `'30분 후 통화'` → 오늘 10:30, timeUncertain false
13. event `'내일 3시'` → 제목 비면 원문 첫 줄 `'내일 3시'`
14. 여러 줄 task → 첫 줄 제목, 나머지 memo / `'- [ ] 우유 사기'` → `'우유 사기'` / 121자 제목 → 117자 + `…`

만들기(`createForced`)
15. todo: 할 일 하나, `origin:'user'`, 출처 연결, note `task_source`, `created` 하나, `command.base` 채움, proposals 변화 없음
16. 할 시각 있는 todo: 30분 작업 블록(`durationGuessed`), `created` 는 할 일만, `base.workId`
17. event: 일정 블록 하나(`kind:'event'`), note `task_source`
18. memo/idea/link: 할 일·블록 없음, `note.kind`, `kindByUser:true`, role memo
19. 사용자 프로젝트(`note.projectId`)가 항목에 들어감
20. 이미 같은 제목 할 일이 있어도 새로 만든다(중복 건너뛰기 없음)

AI 다듬기(`refineForced`, 손으로 만든 `output` + 실제 `validateOrganizeNote`)
21. AI 할 일 하나(제목·마감 ok) → 제목·마감 바뀜, `refined` 에 `title`·`dueDate`, status done
22. AI 가 events·done_tasks·updated_tasks 까지 줘도 다른 항목을 만들지 않고 열린 할 일을 완료·변경하지 않음, proposals 그대로
23. AI 할 일 둘 → 항목 그대로, `note_project_hint` 로 프로젝트만
24. AI 0개 → 항목 그대로
25. 사용자가 제목을 고친 뒤(≠ base) → 제목은 그대로, 마감은 다듬어짐
26. `changedByUser` → 아무것도 안 바뀜, status done
27. todo + AI 일정(date·time ok) → 작업 블록이 그 시각에 생김, 제목 반영
28. event + AI 일정(time ok, duration ok, location) → 시작·끝·장소, timeUncertain false
29. event + AI 할 일(due ok) → 날짜만 바뀌고 시각 유지
30. `confirm` 칸(예: 오전/오후 모름)은 쓰지 않음
31. memo류: 빈 제목에 `note_title`, `note_kind` 가 달라도 `note.kind` 유지, 할 일 안 만듦
32. 사용자 프로젝트가 AI 프로젝트보다 우선
33. 큰 일(`size:'large'`, 단계 2개 이상, 항목 하나) → `breakdown.status:'pending'`, `largeTasks`
34. 만든 할 일을 × 로 지운 뒤 AI 도착 → 다시 만들지 않음
35. 실패 뒤 다시 다듬기(status failed → refine) 정상
36. 가짜 AI 통합: `'금요일까지 분기 보고서 작성'` 을 task 로 강제 → `fake.organize` → 제목 `'분기 보고서 작성'`, 마감 금요일, `largeTasks` 1개
37. `validate` 내보내기: `relativeAt`, `relativeMinutes`, `timeMatch`, `durationSpan` 이 있고, 기존 `checkDuration` 결과가 바뀌지 않음(기존 `ai.test.js` 통과)

### 7.5 기존 파일에 더할 것

- `test/recommend.test.js`
  - 토요일 10:00, 11:00 일정, workHours 없음 → `offHours:true`, `source:'none'`
  - `workHours.days` 에 6 → 같은 조건에서 `source:'calendar'`, T 60
  - `opts.status` 가 `context.status` 로 그대로, 결과 순서 동일
  - 기존 00:15·17:00 테스트 그대로 통과
- `test/assist.test.js`: `looksIdle` 이 `state.prefs.workHours` 를 넘긴다 — 근무 시간을 지금이 밖이 되게 두면 캘린더 T 를 쓰지 않는 결과(`recommend` 를 같은 옵션으로 부른 것과 같음)
- `test/sample.test.js`: 샘플(월요일 기준) 결과 그대로
- `test/capture-v3.test.js:38` 의 `'capture.v6'` 그대로(프롬프트 안 바뀜)

---

## 8. 화면 확인 (Playwright + `scripts/serve.js`, `?fakeai`, `__daynoteNow`, `timezoneId:'Asia/Seoul'`)

자동 시험이 닿지 않는 렌더러 부분. 1440×900 과 390×844(폰) 두 크기, 밝게·어둡게.

A. 대화상자
- [ ] 소요 시간 미정 할 일 → "30분 (제안)" + 제안값 칩. 길이 바꾸면 칩 사라지고 저장 체크 켜짐. 저장 후 할 일 상세의 소요 시간 반영
- [ ] 겹침 → 주 버튼 비활성 + 상자 안 두 버튼. [다른 시간 찾기] → 빈 시간·문구·[원래 시간으로]. [겹쳐 배치] → 저장, 토스트 "다른 일정과 겹쳐요"
- [ ] 금요일 17:30 60분 → 다음 월요일 09:00 문구 "오늘은 빈 시간이 없어 …"
- [ ] 키보드만으로 끝까지(Tab, Space), Esc 닫기, 포커스 복귀

B. 설정
- [ ] AI: 데모/꺼짐/브라우저 문구, 고급 접힘·펼침이 다시 그려도 유지, 위쪽에 환경변수 이름이 없음
- [ ] 근무 시간: 끝 < 시작 오류, 요일 마지막 하나 끄기 막힘, 저장 후 오늘 화면 추천 문구 변화, 기본값 링크
- [ ] 연결: 사용 중·체험·준비 중 구분, 비활성 버튼 없음, "새 할 일 제안 보기" 남아 있음

C. 할 일 추천
- [ ] 일정 없음 → CTA 보임, "다음 할 일" 도구 숨김. 일정 10분 뒤 → CTA 없음. 시계를 진행(60초 틱)해 바뀜 확인
- [ ] 칩 30분 → 결과, [다른 후보], [지금 시작] → 패널 닫힘·CTA 숨김. 직접 `1:30`, `abc`(오류 문구)
- [ ] 패널이 열린 채 빠른 메모로 글이 들어와도 입력칸 포커스·조합 유지
- [ ] 폰: CTA·칩·입력이 줄바꿈, 가로 스크롤 없음(`scrollWidth === 390`)

D. 명령어
- [ ] `/` 로 팝업, `/ㅎ`(한글 조합 중) → 할일, ↑↓·Tab·Enter·Esc, Enter 가 보내기로 새지 않음, 바깥에서 `/` 키 → 입력창에 `/` + 팝업
- [ ] `/할일 내일까지 견적서 보내기` → 카드가 스켈레톤 없이 즉시, 잠금 칩, 1초 뒤(가짜 AI) "AI가 … 다듬음"
- [ ] AI 없음(`?fakeai` 없이) → 같은 할 일이 날짜와 함께 생김, 바닥 "AI 없이 날짜만 찾았어요"
- [ ] 잠금 칩으로 일정으로 바꿈 → 잠금 사라짐, "직접 고침"
- [ ] `/도움말` 카드, 줄 누르면 입력창 채움 / `/todos 우유` 안내 / `//todo` 글자 그대로 / `/할일` 만 → 보내지 않고 안내
- [ ] 폰에서 팝업 줄 탭으로 완성, 화면 키보드가 내려가지 않음
- [ ] 콘솔 오류 0

---

## 9. 구현 순서와 파일별 변경

1. **slots + 근무 시간** (A-1, A-3 근무 시간): `src/core/slots.js` · `recommend.js`(deps·workHours) · `ai/assist.js`(looksIdle) · `views/schedule.js`(감싸개) · `index.html` · 테스트 7.1, 7.5
2. **대화상자** (A-2): `views/schedule.js`(제안값·충돌 상태·버튼 정리·문구) · `styles.css`(`.conflict-actions`, 제안값 칩 자리)
3. **설정** (A-3): `views/settings.js`(카드 재배치·AI 처리·고급·근무 시간·연결 3구역·onChange) · `store.js:49` 문구 · `styles.css`(`.settings-adv .work-days .field-error .provider-list.is-soon`)
4. **할 일 추천** (B): `dates.js`(parseDuration) · `views/recpanel.js` · `views/chat.js`(recHost, 도구 숨김, tick) · `views/today.js`(onTick) · `recommend.js`(status 반향) · `styles.css`(`.rec-*`) · 테스트 7.3
5. **명령어** (C): `src/core/commands.js` · `ai/validate.js`(내보내기 4개) · `ai/forced.js` · `renderer/capture.js`(submit 4번째 인자, classify 분기·inflight 순서) · `assistant.js`(send 분기, statusCommand, help post) · `app.js`(saveQuick 분기, `/` 단축키) · `slash.js` · `views/chat.js`(sendNow 빈 본문, 카드 분기, 잠금 칩, 말풍선 칩, help 카드) · `ui.js`(lock 아이콘) · `quick.html`/`quick.js` · `settings.js`(단축키 표) · `styles.css`(`.slash-* .msg-cmd .help-card .cap-lock .chat-input-note`) · 테스트 7.2, 7.4
6. 문서: `README.md`(추천 패널·명령어·근무 시간·테스트 목록), `DAYNOTE_UX_V2.md` §8 키 표에 `/` 명령어, 스모크 `out.core`

각 단계 끝에 `npm test` 전부 통과 + §8 해당 항목 확인.

---

## 10. 범위 밖 (후속)

- 캘린더 끌어 놓기의 충돌 선택과 소요 시간 미정 표시(`calendar.js:44,188`) — 지금처럼 저장 + 토스트. 후속으로 토스트에 [다른 시간 찾기] 를 붙일 수 있다(같은 `SL.findSlot`).
- 좁은 블록 정보 축약, 날짜 헤더 마감 펼치기, 미배치 목록 접기(P2 일정의 나머지).
- 밤샘 근무(끝 < 시작), 요일별로 다른 근무 시간.
- 한글 자판으로 친 영어 명령(`/ㅅㅐㅇㅐ` → todo) 보정.
- 명령어로 만든 항목의 "비슷한 할 일이 이미 있어요" 안내.
- 'AI 분류' 되돌리기·앱 종료 뒤 일반 카드가 계속 "정리하는 중…" 인 기존 버그(capture 지도 §9) — 명령어 카드는 §6.8 "멈춤" 상태로 따로 처리하지만, 일반 카드는 이 문서에서 고치지 않는다.
- 상태 정책(어떤 상태에서 무엇을 추천할지)과 Google 캘린더 동기화 자체.
