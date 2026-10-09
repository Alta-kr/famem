# Daynote "현재 상태" 최종 설계 — 구현 지시서

- 작성: 2026-10-10 (토) · 기준: 브랜치 `web-mobile`, 커밋 `d75f062`. 경로는 `daynote/` 기준이고, 줄 번호는 위 커밋 기준이다.
- 바탕: 세 기획안(P1 사람 중심 · P2 규칙 엔진 · P3 직업 프리셋)과 판정. **P1을 뼈대로** 삼고 P2의 불변식·단어 점수·막기 규칙·표 기반 테스트, P3의 `statusView` 주입·`nextActiveStart` 돌파·`extra`(지금 하기 좋은 일)·약한 힌트를 붙였다.
- 함께 맞출 문서와 계약:
  - `DAYNOTE_FEATURES_SPEC.md` §1.5(`DN.status.current` / `setFromCommand`), §2.2(`slots` 근무 시간), §4.1(설정 순서), §5.6(추천과 상태), §6.3·§6.9(`/상태`)
  - `DAYNOTE_ADAPTIVE_PLAN.md` §7.4·§7.8(`DN.adapt.learn/suggest`, type `context`)
  - `DAYNOTE_GOOGLE_DESIGN.md` D11(`gcal`도 undo에서 뺌), `SCHEMA_VERSION` 조율
- 이 단계에서는 소스를 바꾸지 않았다. 이 문서만 새로 썼다.

---

## 0. 결정 요약

1. **상태(presence)** 는 "지금 어떤 시간인가"(업무 중·퇴근·쉬는 날…), **맥락(context)** 은 "이 할 일은 어느 쪽 일인가"(업무·집안일·밖 볼일·개인·가족·공부)다. 둘이 만나는 **정책표**가 할 일마다 **띄움 / 보통 / 내림 / 숨김** 중 하나를 정한다. 상태는 할 일 데이터(마감·우선순위·순서·진행 상태)를 바꾸지 않는다.
2. **처음 쓰기 전에는 아무것도 바뀌지 않는다.** `presence.activatedAt`이 비어 있으면 추천과 오늘 목록이 지금 코드와 바이트 단위로 같다. 오늘 머리줄에 흐린 `[상태 정하기 ▾]` 알약 하나만 생긴다.
3. **시계는 숨기지 않는다.** 처음 쓴 뒤부터 근무 시간으로 상태를 짐작하지만, 짐작한 상태는 **내리기만** 한다. 숨김은 내림이 되고, 띄움은 보통이 된다. 숨기는 것은 사용자가 직접 말하거나 고른 상태뿐이다. 짐작으로도 숨기려면 설정에서 따로 켠다(`hideOnGuess`).
4. **짧은 상태는 목록을 흔들지 않는다.** 휴식·식사·회의·집중·수업·운전·운동은 원래 상태 위에 잠깐 얹히는 덧씌움이다. 바뀌는 것은 추천과 알림뿐이다.
5. **말로 바꾼다.** 글 전체나 첫 문장이 상태 보고이면("퇴근!", "점심", "10분만 쉴게") 그 자리에서 바뀐다. 오프라인에서도 규칙으로 바로 동작한다.
   - **상태만 적은 글은 메모를 만들지 않는다.** 흐름에 내 말풍선과 상태 카드가 남고, 카드의 [메모로 남기기]로 메모를 만들 수 있다.
   - **상태와 내용이 섞인 글은 원문 전체를 메모로 저장한다.** AI에는 상태 문장(`statusLine`)을 따로 알려 할 일로 만들지 않게 한다.
   - 애매한 글은 평소처럼 저장하고, 결과 카드에 "상태를 ‘휴식’으로 바꿀까요?" 제안 칩만 붙인다.
6. **숨긴 것은 수로 늘 보인다**: `업무 할 일 5개 숨김 · 보기`. **모르면 숨기지 않는다**: 맥락이 없거나, 단어 점수가 동점이거나, 약한 힌트뿐인 할 일은 숨지 않는다.
7. **약속은 상태보다 강하다.**
   - 일정 블록은 어떤 상태에서도 숨기지 않는다.
   - 숨긴 할 일이라도 기한이 지났거나, 다음에 그 맥락을 볼 시각(`nextActiveStart`) 전에 마감이면 **내림**까지 올라온다.
   - 마감이 3시간 안이면 **보통**까지 올라온다.
   - 작업 시간이 지금 잡혀 있거나 30분 안에 시작하는 할 일은 보통이다.
8. **걸어 둔 할 일**("퇴근하고 우유 사기")은 그 상태가 되면 띄움이다. 다른 상태에서는 정책대로 두고, 그 때문에 숨기지는 않는다.
9. **퇴근하면 오늘 목록 밖의 일도 끌어온다.** 날짜 없는 "빨래 돌리기"처럼 오늘 목록 조건에 들지 않는 띄움 할 일을 "지금 하기 좋은 일"로 최대 5개 보여 준다(`extra`).
10. **상태는 Ctrl+Z 대상이 아니다.** `store.undo()`가 `prefs`처럼 `presence`도 보존한다. 잘못 바꾼 상태는 카드·메뉴·토스트의 **[이전 상태로]**(기록 기반)로 되돌린다.
11. **추천은 `statusView`라는 평범한 데이터만 받는다.** `recommend.js`는 상태 모듈을 `require`하지 않는다. `statusView`가 없으면 출력이 지금과 같다. 정렬 첫 키는 `levelRank`다.
12. **맥락 우선순위**: 사용자 > 프로젝트 > 배운 제목 > AI > 배운 낱말 > 단어 규칙(사용자 단어 포함) > 약한 힌트 > 없음.
    - 저장하는 것은 사용자와 AI 값뿐이고, 나머지는 읽을 때 계산한다.
    - 배우기는 `DN.adapt`(type `context`)로 하며, 교정과 **같은 라벨 mutate** 안에서 한다. 그래서 Ctrl+Z가 교정과 배운 것을 함께 되돌린다.
13. **제안은 상태 관련을 모두 합쳐 하루 1번까지다.** 팝업도, "아직 업무 중이세요?" 같은 질문도 없다.
14. **v1에서 상태를 보고 바꾸는 곳**: 오늘 머리줄의 칩, 폰·좁은 창(≤860px)의 상단 고정 줄, Ctrl+K, `/상태`, 휴식 타이머 연결. 프리셋은 v1에 직장인(기본)·프리랜서와 사용자가 만든 상태를 넣는다. 나머지 프리셋(학생·교대 근무·자영업·육아)은 데이터로 정의만 해 두고 v1.1에 켠다.

### 0.1 이름 정리 (요청서 이름 → 최종 이름)

| 요청서 | 최종 | 이유 |
|---|---|---|
| `state.status` | **`state.presence`** | `task.status`(할 일/진행 중/대기/완료)와 헷갈리지 않게 한다. 화면 문구는 "상태" |
| `state.statusHistory` | `state.presence.log` (최근 60개) | 한 조각에 모아 undo 보존을 키 하나로 처리한다 |
| `prefs.statusProfile` | 그대로 | 설정이라 undo 대상이 아니다 |
| `task.context {value, source}` | 저장: `task.context`, `task.contextSource ('user'\|'ai')`<br>읽기: `ST.contextOf()` → `{ value, source:'user'\|'project'\|'learned'\|'ai'\|'rule'\|'hint'\|null, … }` | 규칙·학습·프로젝트 값은 계산한다(사전이 좋아지면 옛 할 일에도 바로 반영). 저장 모양은 `estimateMinutes/estimateSource`처럼 납작하게 둔다 |
| `src/core/status.js` | 그대로. 전역 이름은 **`DN.statusCore`**(줄여 `ST`). 사전·프리셋 데이터는 `src/core/statusWords.js`(`DN.statusWords`, 줄여 `SW`) | `DN.status`는 FEATURES_SPEC §1.5가 정한 화면 쪽 계약(`current`, `setFromCommand` — 스스로 mutate함)이다. 그래서 렌더러 모듈 `renderer/statusui.js`가 `DN.status`를 맡는다. 코어 이름 규칙(파일 이름 = 전역 이름)의 유일한 예외다 |
| `applyStatusPolicy(tasks, status, profile, now)` | `ST.applyStatusPolicy(state, tasks, eff, profile, now)` → `{ visible, demoted, hidden, levels, reasons }` | 프로젝트 맥락·작업 블록·배운 것·`shown`을 보려면 `state`가 필요하다 |

---

## 1. 왜 만드나 (짧게)

- 지금 '오늘'과 '다음 할 일'은 지금이 업무 시간인지 퇴근 뒤인지 모른다(`workHours` 09–18 하나뿐이고 설정 화면도 없다). 그래서 퇴근한 저녁에도 보고서가 맨 위에 있고, 회사에서 "빨래 돌리기"를 추천한다.
- 사람은 이미 상태를 한마디로 말한다("퇴근!", "점심", "ㅊㄱ"). Daynote는 그 한마디를 받아 목록과 추천을 그 시간에 맞게 정리한다. 상태를 고르는 화면은 만들지 않는다.
- 직업마다 하루가 다르다. 상태 이름·시간표·정책표는 데이터(프리셋)로 두고 엔진은 하나로 쓴다.

**원칙** (UX v2 §2의 6원칙 뒤에 붙인다)

| # | 원칙 | 지키는 장치 |
|---|---|---|
| P-1 | 쓰기 전엔 그대로 | `activatedAt` 없으면 `view = null` → 모든 출력이 지금과 동일 (불변식 I1) |
| P-2 | 말하면 바뀌고, 안 말하면 짐작만 한다 | 짐작은 점선 칩, 내리기만. 명시한 상태는 시계가 바꾸지 않는다 |
| P-3 | 숨기되 지우지 않는다 | 숨긴 수를 늘 보인다. 숨긴 일도 검색·할 일 화면·캘린더에는 그대로 있다 |
| P-4 | 모르면 숨기지 않는다 | 맥락 없음·동점·약한 힌트 → 숨김 금지 |
| P-5 | 짧은 상태는 목록을 흔들지 않는다 | 덧씌움은 추천·알림만 바꾼다 |
| P-6 | 약속은 상태보다 강하다 | 일정 블록 불변, 마감 돌파, 잡아 둔 작업 시간 |
| P-7 | 사용자가 정한 것은 AI·시계가 덮지 않는다 | `contextSource:'user'`, 명시 상태 우선, AI 상태는 제안만 |
| P-8 | 알려 주고 끝낸다 | 상태 관련 제안 하루 1번, 두 번 거절하면 다시 안 함 |

**불변식** (구현·리뷰 체크리스트)

- **I1.** `ST.view(...)`가 `null`이면 `recommend()` 출력과 오늘 목록 마크업이 지금 코드와 같다. 새 키도 넣지 않는다.
- **I2.** 상태 바꾸기(`ST.setStatus` 등)는 `state.presence`만 바꾼다. `tasks`·`blocks`·`notes`는 건드리지 않는다. 할 일 데이터는 카드의 버튼(라벨 있는 mutate)으로만 바뀐다.
- **I3.** 숨김은 오늘 목록·추천·자동 제안에만 적용한다. 할 일 화면·캘린더·검색(Ctrl+K)·주간 정리는 거르지 않는다.
- **I4.** 모든 코어 함수는 `now`를 받고 벽시계를 읽지 않는다.
- **I5.** 상태는 사용자의 행동을 막지 않는다. 숨긴 할 일도 열고, 시작하고, 완료할 수 있다(`checkStartable` 불변).

---

## 2. 개념

### 2.1 용어

| 용어 | 뜻 | 코드 |
|---|---|---|
| 상태 | 지금 어떤 시간인지. 한 번에 하나 | `state.presence.current` |
| 범주(category) | 상태의 성격: `work` 업무 · `life` 생활 · `rest` 쉬는 날 · `moving` 이동 · `sleep` 잠 · `none` 모두 보기 · `overlay` 덧씌움 | `StatusDef.category` |
| 장소(place) | `office` · `home` · `out` · `moving` · `null`. 사용자 상태의 정책 행을 계산할 때 쓴다 | `StatusDef.place` |
| 덧씌움 | 끝나는 시각이 있고, 끝나면 아래 상태로 돌아가는 상태. 목록은 아래 상태 기준 | `current.until`, `current.returnTo` |
| 짐작 상태 | 명시한 상태가 없거나 낡았을 때 근무 시간으로 계산한 상태. 저장하지 않는다 | `eff.guessed === true` |
| 역할(role) | 감지한 말의 뜻(`work_end` 등). 프리셋이 역할을 상태로 바꾼다 | `Detection.role` |
| 맥락 | 할 일이 어느 쪽 일인지 | `task.context` + 계산 |
| 보임 수준 | `up` 띄움 · `normal` 보통 · `down` 내림 · `hide` 숨김 | `levels[taskId].level` |
| 걸어 둔 상태 | "퇴근하고", "출근하면", "나가는 김에", "점심 때", "쉬는 날에" | `task.atMode` |
| 폰으로 할 일 | 전화·연락·이체·예약처럼 이동 중에도 할 수 있는 일. 저장하지 않는 계산 태그 | `ST.onPhone(task)` |
| 돌파 | 숨김이어도 마감이 가까우면 보이게 하는 규칙 | `levels[id].breakthrough` |
| 지금 하기 좋은 일 | 오늘 목록 조건 밖이지만 지금 띄움인 할 일(최대 5) | `partition.extra` |

### 2.2 기본 상태 (v1, 모든 프리셋 공통 사전)

| id | 기본 라벨 | 범주 | 장소 | 덧씌움 기본 분 | 추천(rec) | 자동 제안 | busy¹ | 낡는 때(명시한 경우) |
|---|---|---|---|---|---|---|---|---|
| `work` | 업무 중 | work | office | – | normal | 켬 | – | since + 16시간 (자정·하루 시작으로 끊지 않음) |
| `wfh` | 재택 근무 | work | home | – | normal | 켬 | – | since + 16시간 |
| `field` | 외근 중 | work | out | – | normal (폰 우선) | 켬 | – | since + 16시간 |
| `to_work` | 출근길 | moving | moving | – | normal (폰 우선) | 켬 | – | since + 2시간 |
| `to_home` | 퇴근길 | moving | moving | – | normal (폰 우선) | 켬 | – | since + 2시간 |
| `out` | 외출 중 | life | out | – | normal | 켬 | – | since + 4시간 |
| `off` | 퇴근 · 내 시간 | life | home | – | normal | 켬 | – | since 뒤 첫 하루 시작(기본 04:00) |
| `day_off` | 쉬는 날 | rest | home | – | normal | 켬 | – | since 뒤 첫 하루 시작 |
| `sleep` | 잘 시간 | sleep | home | – | none | 끔 | 예 | since + 10시간, 또는 상태 아닌 글을 적으면 |
| `none` | 모두 보기 | none | – | – | normal | 켬 | – | since 뒤 첫 하루 시작 |
| `break` | 휴식 | overlay | – | 15 | short (남은 시간 안) | 끔 | – | until |
| `meal` | 점심 / 식사 | overlay | – | 점심 시간 안이면 그 끝까지, 아니면 '점심' 60 · 그 밖 40 | short | 끔 | – | until |
| `meeting` | 회의 중 | overlay | – | 60 | none | 끔 | 예 | until |
| `focus` | 집중 | overlay | – | 50 | normal (부르면 추천) | 끔 | – | until |
| `class` | 수업 중 | overlay | – | 50 | none | 끔 | 예 | until |
| `drive` | 운전 중 | overlay | – | 60 | none (안전) | 끔 | 예 | until |
| `exercise` | 운동 | overlay | – | 60 | none | 끔 | 예 | until |

¹ `busy`는 FEATURES_SPEC의 `DN.status.current(now).busy`로 나간다. "할 일 추천" 줄(CTA)을 숨기고, `slots.freeNow`가 `reason:'status'`로 본다.

- 덧씌움 위에 덧씌움을 하면 교체한다. `returnTo`는 원래 바탕을 유지한다(깊이 1).
- 명시한 바탕 없이 덧씌움만 하면 `returnTo = null`이고, 끝나면 시간표 짐작으로 돌아간다.
- 프리셋 전용 상태(v1.1, §12): `kids` 아이와 함께, `me` 혼자 시간, `nap` 아기 낮잠(덧씌움), `shop_prep` 오픈 준비, `shop_open` 영업 중, `shop_close` 마감 정리, `busy` 바빠(덧씌움), `study` 공부 중, `part_time` 알바 중, `free_period` 공강(덧씌움).

### 2.3 기본 맥락 (6개 + 사용자 맥락)

| id | 라벨 | 설명 | 색(기존 토큰만) | 아이콘(새) | `#태그` 별칭 |
|---|---|---|---|---|---|
| `work` | 업무 | 회사·거래처·가게·알바 일 | `--kind-task` | `briefcase` | 업무, 일, 회사 |
| `home` | 집안일 | 집에서만 할 수 있는 일 | `--success` | `home` | 집안일, 집, 살림 |
| `errand` | 밖 볼일 | 나가야 할 수 있는 일(장보기·은행·택배) | `--kind-event` | `bag` | 볼일, 밖, 장보기 |
| `personal` | 개인 | 건강·운동·취미·돈 관리·약속 (**건강은 여기에 포함**) | `--kind-idea` | `user` | 개인, 나, 건강, 운동 |
| `family` | 가족 | 아이·부모님·배우자 | `--secondary` | `heart` | 가족, 육아 |
| `study` | 공부 | 과제·시험·자격증 | `--kind-link` | `book` | 공부, 과제 |
| (null) | 정하지 않음 | 모든 상태에서 보통 | `--text-tertiary` | – | – |

사용자 맥락(예: 부업, 교회, 반려동물)은 id가 `u_` + 6자 base36이고 중립색 점을 쓴다. 최대 6개(맥락 전체 12개)다.

### 2.4 걸어 둔 상태(`atMode`)와 맞는 상태

| atMode | 할 일 제목 **맨 앞**의 말 (떼어 내고 제목을 다듬는다) | 맞는 상태(유효 상태의 바탕 id) | 맞으면 |
|---|---|---|---|
| `work` | 출근하면, 출근해서, 출근하자마자, 회사 가서, 회사에서, 사무실에서 | `work`, `wfh`, `field` | 목록 '하기로 한 일' 묶음 + 카드 |
| `off` | 퇴근하고, 퇴근하면, 퇴근 후(에), 퇴근하고 나서, 일 끝나고, 집에 가서, 집 가서, 집에서 | `off`, `to_home`, `day_off` | 같음 |
| `out` | 나가는 김에, 밖에 나가면, 외출하면, 가는 길에, 오는 길에, 퇴근길에, 출근길에 | `out`, `to_work`, `to_home`, `field` | 같음 |
| `pause` | 점심 때, 점심에, 점심시간에, 쉬는 시간에, 쉴 때 | 덧씌움 `break`, `meal` | **카드와 추천만**(덧씌움은 목록을 흔들지 않는다) |
| `rest` | 쉬는 날에, 쉬는 날 | `day_off` | 목록 묶음 + 카드 |

- "주말에"는 날짜 표현이므로 걸어 둔 상태가 아니다. 마감 해석(`SG.parseDueHint`)에 맡긴다.
- 짐작 상태에서는 걸어 둔 할 일을 띄우지 않는다(짐작은 내리기만 한다).
- 맞지 않는 상태에서는 정책대로 둔다. 걸어 둔 상태 때문에 숨기는 일은 없다(P2안의 "다른 상태에서 숨김"은 버렸다).

### 2.5 폰으로 할 일 (`ST.onPhone`, 저장하지 않음)

제목 낱말이 다음으로 시작하면 참이다: 전화, 통화, 연락, 문자, 카톡, 메시지, 답장, 예약, 주문, 결제, 송금, 이체, 신청, 조회, 알아보기. 이동 상태(`moving` 범주)에서 숨김이 아닌 한 **띄움**이 된다.

---

## 3. 데이터 모델

### 3.1 `state.presence` — 새 최상위 키 (`M.emptyState()`에 반드시 추가)

```js
presence: {
  v: 1,
  activatedAt: null,            // 처음 직접 상태를 정한 시각(칩·말·명령·팔레트 어느 길이든). null 이면 기능이 없는 것처럼 동작(I1)
  current: null | {
    id: 'off',                  // 상태 id (기본 · 프리셋 · 사용자 'u_…')
    label: '퇴근',               // 칩에 보일 말. 사용자가 쓴 단어(야근·점심·반차·재택)를 살린다. ≤ 20자
    role: 'work_end' | null,    // 감지한 역할. 칩·메뉴로 고르면 null
    since: ISO,
    source: 'text' | 'command' | 'chip' | 'menu' | 'palette' | 'hint' | 'confirm' | 'rest' | 'revert',
    until: null | ISO,          // 덧씌움 끝 · 반차 끝. 지나면 returnTo, 없으면 시간표 짐작
    returnTo: null | { id, label, since, source }   // 덧씌움 아래의 명시 상태. 깊이 1
  },
  shown:  [],                   // [taskId] 이 상태에서 사용자가 펼쳐 열어 본 숨김 할 일. 바탕 상태가 바뀌면 비운다
  parked: [],                   // [taskId] 업무 → 업무 아님으로 바뀌며 숨겨진 '진행 중' 할 일. 다음 업무 상태에서 이어하기 후보
  log: [],                      // [{ at, id, label, from: id|null, fromLabel: string|null, source, text?: '퇴근!'(≤40) }] 최근 60개
  hints: {                      // 잔소리 예산과 한 번만 하는 안내
    day: null,                  // 'YYYY-MM-DD' (하루 시작 기준 날짜)
    used: 0,                    // 그날 쓴 상태 관련 제안 수 (상한 1)
    overtimeDismiss: 0,         // '근무 시간이 지났어요' 닫은 횟수. 2면 다시 띄우지 않음
    presetSeen: {},             // { student: [ISO, …] } 다른 프리셋 전용 말을 들은 시각(14일 창)
    presetOffered: {}           // { student: ISO } 프리셋마다 평생 1번
  }
}
```

- `normalize`는 객체를 얕게 병합하므로 키를 넣는 것만으로 보존된다. 안쪽 배열·객체는 `ST.ensure(state)`가 방어적으로 채운다.
- 같은 기기 안에서만 산다. 기기 사이 동기화는 하지 않는다(localStorage·`daynote-data.json`).
- 백업 내보내기에 그대로 들어간다. 비밀 정보는 없다.

### 3.2 `prefs.statusProfile` — 설정 (undo 대상 아님, `S.mutate(null, …, {silent:true})`)

근무 시간 자체는 새로 저장하지 않는다. FEATURES_SPEC D7의 `prefs.workHours = { start, end, days }`(없으면 월–금 09:00–18:00)를 그대로 읽는다.

```js
prefs.statusProfile = {               // 없으면 직장인 프리셋 기본값
  v: 1,
  enabled: true,                      // false 면 기능 전체 끔: view null, 칩 숨김 (activatedAt 은 남김)
  preset: 'office',                   // 'office'|'freelance'|'student'|'shift'|'shop'|'home'|'creator' (§12)
  statuses: [                         // 기본 상태 고침 + 새 상태. id 로 프리셋 정의 위에 합친다
    { id: 'off', label: '칼퇴', words: ['집 감'], wordsOff: [], menu: true, minutes: null },
    { id: 'u_gym', custom: true, label: '운동 중', category: 'overlay', place: null, minutes: 60,
      rec: 'none', words: ['헬스장 도착'], menu: true }
  ],
  contexts: [                         // 기본 맥락 고침 + 새 맥락
    { id: 'home', label: '집안일', words: ['식물 물주기'], wordsOff: ['정리'] },
    { id: 'u_church', custom: true, label: '교회', words: ['예배', '성경공부'] }
  ],
  policy: {                           // 정책표 칸 덮어쓰기: { statusId: { ctxId|'_none': 'up'|'normal'|'down'|'hide' } }
    off: { study: 'hide' }
  },
  afterWork: 'hide',                  // 'hide'|'down' — off·to_home·day_off 행의 주 맥락(가장 자주 바꾸는 손잡이)
  urgentHours: 3,                     // 0 이면 '마감 N시간 안이면 보통' 규칙 끔
  autoSchedule: {
    mode: 'guess',                    // 'guess'(기본, 내리기만) | 'off'
    hideOnGuess: false,               // true 면 짐작 상태로도 숨김 (opt-in)
    lunch: ['12:00', '13:00'],        // null 가능. 점심 덧씌움의 기본 끝 시각에만 쓴다(점심을 짐작하지는 않음)
    dayStart: '04:00',                // 생활 상태가 끝나고 '하루'가 바뀌는 시각
    overtimeLine: true                // '근무 시간이 지났어요' 한 줄 (하루 1번)
  }
}
```

- 덮어쓰기 모델이다. 프리셋 기본값이 나중에 좋아지면 사용자가 손대지 않은 칸은 저절로 따라간다.
- 검증(`ST.profile`이 읽을 때 관대하게 정리): 모르는 id, 잘못된 수준, 2자 미만이나 20자 초과 단어, 중복 단어는 버린다. 사용자 상태는 최대 10개, 사용자 맥락은 최대 6개, 항목마다 단어 30개까지다.
- `prefs.workHours`는 `DN.slots.normalizeWorkHours`가 있으면 그것으로, 없으면 같은 규칙의 내부 함수로 정리한다(시작 ≥ 끝이면 기본값). 밤샘 근무(끝 < 시작)는 FEATURES_SPEC처럼 v1에서 지원하지 않는다. 교대 근무 프리셋은 시간표 짐작을 끈다.

### 3.3 할 일·프로젝트 필드

```js
// normalizeTask 기본값 추가
task.context:      null | 'work'|'home'|'errand'|'personal'|'family'|'study'|'u_…'
task.contextSource: null | 'user' | 'ai'        // 'user' + context:null = 사용자가 '정하지 않음'으로 고정
task.atMode:       null | 'work'|'off'|'out'|'pause'|'rest'
task.atModeSource: null | 'user' | 'ai' | 'rule' // 'rule' = 만들 때 앱이 제목 맨 앞의 말을 떼며 정함

// 프로젝트 (normalize 되지 않으므로 읽을 때 p.context || null)
project.context:   null | ctxId                 // 사용자만 정한다. 소속 할 일의 기본 맥락
```

- **규칙·학습·프로젝트·힌트로 정한 맥락은 저장하지 않는다.** 사전이 좋아지거나 사용자가 가르치면 옛 할 일에도 바로 반영되고, 같은 입력이면 같은 결과가 나온다.
- `M.updateTask`: 패치에 `title`이 있고 값이 바뀌었으며 `t.contextSource === 'ai'`이고 패치가 `contextSource`를 정하지 않았으면 `context = null`, `contextSource = null`로 둔다. 제목이 바뀌면 AI 판단의 근거가 사라지기 때문이다. 사용자 값은 그대로다.
- `proposals.js:545` `TASK_KEEP`에 `context`, `contextSource`, `atMode`, `atModeSource`를 더한다(할 일↔일정 왕복 보존).

### 3.4 메모·채팅 필드

```js
note.capture.statusLine: null | '퇴근!'   // 섞인 글의 상태 문장(≤80). AI·가짜 AI가 할 일로 만들지 않게. 다시 시도해도 남는다
note.capture.statusHint: null | {         // 제안 칩 하나
  from: 'rule' | 'ai', role, id, label, quote, at, resolved?: 'applied' | 'dismissed' }

// 채팅 메시지
{ kind: 'status', to: { id, label }, from: { id, label, guessed } | null, source, at,
  text?: '퇴근!',          // 상태만 적은 글이면 원문(메모로 남기기용)
  pure: true|false, noteId?: 'note_…' /* 메모로 남긴 뒤 */, parked: [taskId], resume: [taskId] }
{ kind: 'status-pick' }   // '/상태' 만 보냈을 때 고르기 카드
// next 카드에 statusLabel: '퇴근 · 내 시간' | '업무 중 · 시간표 기준' (보낼 때 값)
```

숫자(숨긴 수, 이어하기 제목, 추천 할 일)는 카드를 그릴 때마다 지금 상태에서 다시 계산한다. 카드에 사본을 두지 않는 기존 원칙을 따른다.

### 3.5 계산값 (저장하지 않음)

```js
Profile = {                                  // ST.profile(prefs)
  preset, enabled, statuses: { id: StatusDef }, menu: [id], contexts: { id: ContextDef }, contextIds: [id],
  matrix: { statusId: { ctxId: level, _none: level } },   // 빈칸 없음
  primary: ['work'], afterWork, urgentHours,
  schedule: { mode, hideOnGuess, workHours: { start, end, days }, lunch, dayStart, overtimeLine },
  roleMap: { role: statusId }, words: <감지 색인>, ctxWords: <맥락 색인>, hash: 'p:…'   // 메모 키
}
StatusDef  = { id, label, category, place, overlay: bool, minutes, rec, nudges, busy, words, menu, custom }
ContextDef = { id, label, words: [{ w, weight }], custom }

Eff = {                                      // ST.effective(state, profile, now) — null 이면 기능 없음
  id, label, category, place, guessed: bool, source, since: ISO|null,
  expiresAt: ISO|null,                       // 명시 상태가 끝나는(낡는) 시각. 짐작이면 그 시간표 구간 끝
  overlay: null | { id, label, until, rec },
  rec: 'normal'|'short'|'none', busy: bool, nudges: bool
}

StatusView = {                               // ST.view(state, profile, now) — recommend·오늘·assist 에 넘기는 평범한 데이터
  active: true, id, label, category, guessed, since, overlay, rec, busy, nudges,
  remainMinutes: null | int,                 // 덧씌움 남은 분 (break·meal)
  offHours: bool,                            // 명시 업무 → false, 명시 그 밖 → true, 짐작 → 근무 시간 밖인지
  workWindow: null | { start: ISO, end: ISO },  // 명시 업무인데 시간표 밖(야근)이면 null → T 를 자르지 않음
  levels: { taskId: { level, reason, ctx, ctxSource, breakthrough: null | { dueAt, soon } } },
  hiddenIds: [taskId], anchored: [taskId],   // anchored = 걸어 둔 상태가 맞는 할 일
  summary: { hidden: 5, byCtx: { work: 5 }, parked: 1 }
}
ContextResult = { value: ctxId|null, source: 'user'|'project'|'learned'|'ai'|'rule'|'hint'|null,
                  evidence: '빨래'|'‘온보딩 개선’'|null, ruleIds?: [] }
```

### 3.6 모델·저장소 변경 체크리스트

| 곳 | 바꿀 것 |
|---|---|
| `model.js:41` `emptyState()` | `presence: { v:1, activatedAt:null, current:null, shown:[], parked:[], log:[], hints:{} }` |
| `model.js:72` `normalizeTask` | `context:null, contextSource:null, atMode:null, atModeSource:null` |
| `model.js:23` `SCHEMA_VERSION` | 다음 번호로 올린다. Google(`gcal`)·적응(`learned`)과 같은 릴리스면 **번호 하나를 함께 쓰고** 주석을 합친다: `· N: 현재 상태(presence), 할 일 맥락(context·atMode)`. 따로 들어가면 나중 쪽이 +1 |
| `model.js:185` `updateTask` | 제목이 바뀌면 AI 맥락 지우기(§3.3) |
| `model.js:438` `clearSample` | `presence`를 건드리지 않는다(바꿀 것 없음. 테스트로 고정) |
| `store.js:159` `undo` | `KEEP_ON_UNDO = ['prefs', 'presence']` (+ GOOGLE_DESIGN D11의 `'gcal'`). 아래 코드 |
| `proposals.js:545` | `TASK_KEEP` += `context, contextSource, atMode, atModeSource` |

```js
// renderer/store.js — undo 는 이 키들의 '지금 값' 을 유지한다
var KEEP_ON_UNDO = ['prefs', 'presence', 'gcal'];   // gcal 은 Google 설계 D11 (없으면 건너뜀)
undo: function () {
  var last = undoStack.pop();
  if (!last) return null;
  var keep = {};
  KEEP_ON_UNDO.forEach(function (k) { if (state[k] !== undefined) keep[k] = state[k]; });
  state = last.snapshot;
  Object.keys(keep).forEach(function (k) { state[k] = keep[k]; });
  scheduleSave();
  emit({ type: 'undo', label: last.label });
  return last.label;
}
```

알려진 동작: undo는 `chat`을 되돌리므로, 앞선 라벨 작업을 되돌리면 그 뒤에 올린 상태 카드가 흐름에서 사라질 수 있다. 상태는 그대로이고 카드만 없어진다. 칩이 늘 지금 상태를 보여 주므로 문제로 보지 않는다.

---

## 4. 상태 기계

### 4.1 유효 상태 `ST.effective(state, profile, now) → Eff | null` (순수, 기록하지 않음)

```
p = ST.ensure(state).presence
if (!profile.enabled || !p.activatedAt) return null                          // I1
cur = p.current
1) cur && cur.until && cur.until <= now  → cur = cur.returnTo ? { ...cur.returnTo, source:'return' } : null
2) cur && isStale(cur, now)              → cur = null
3) overlay = cur && def(cur.id).overlay ? cur : null
   base    = overlay ? (overlay.returnTo && !isStale(overlay.returnTo, now) ? overlay.returnTo : null) : cur
4) b = base ? explicitEff(base)                       // guessed:false, expiresAt = staleAt(base)
          : profile.schedule.mode === 'guess' ? guessEff(profile, now)   // guessed:true
          : { id:'none', label:'모두 보기', category:'none', guessed:true }
5) rec/busy/nudges = overlay ? def(overlay).… : def(b).…
   return { ...b, overlay: overlay && { id, label, until, rec }, rec, busy, nudges }
```

`settle`(§4.6)이 1)·2)의 결과를 나중에 저장한다. 앱이 꺼져 있던 동안 덧씌움이 끝났어도 켤 때 계산으로 바로 맞다.

### 4.2 낡음 규칙 `isStale(cur, now)` / `staleAt(cur)`

| 범주 | 낡는 때 | 이유 |
|---|---|---|
| work (`work`·`wfh`·`field`) | `since + 16h` | 자정·하루 시작으로 끊지 않는다. 야근·야간 근무가 유지된다 |
| life `off`, rest `day_off`, `none` | since 뒤 **첫 하루 시작**(기본 04:00) | 하루가 바뀌면 시간표로 돌아간다 |
| life `out` | `since + 4h` | 오래 밖에 있는 일은 드물다 |
| moving (`to_work`·`to_home`) | `since + 2h` | 출퇴근은 짧다 |
| sleep | `since + 10h`, 또는 상태 아닌 글을 적을 때(`ST.wake`) | 깨어 있다는 증거 |
| overlay | `until` | 기본 분 또는 말한 시간 |
| 반차(`off` + until) | `until` | §4.4 |

### 4.3 시간표 짐작 `ST.guess(profile, now)`

```
wh = profile.schedule.workHours                    // { start, end, days } (FEATURES_SPEC D7, 기본 월–금 09:00–18:00)
d  = now < 오늘 dayStart ? 어제 : 오늘               // '논리적 날짜' — 토 01:25 는 금요일 밤
if (!wh.days.includes(d.getDay()))  → { id:'day_off', label:'쉬는 날',  segment:[d 의 dayStart, 다음 dayStart) }
win = workWindow(d, wh)
now < win.start                     → { id:'off',     label:'출근 전',  segment:[d 의 dayStart, win.start) }
now < win.end                       → { id:'work',    label:'업무 중',  segment:[win.start, win.end) }
else                                → { id:'off',     label:'퇴근 후',  segment:[win.end, 다음 dayStart) }
```

- 점심과 잠은 짐작하지 않는다. 점심 시간에도 짐작은 '업무 중'이다.
- `mode:'off'`면 짐작하지 않는다. 그러면 명시 상태가 낡았을 때 `none`(모두 보통)이 된다.
- 예: 토 01:25 → 금요일 밤 '퇴근 후'(짐작). 토 10:00 → '쉬는 날'(짐작). 월 07:00 → '출근 전'. 월 10:00 → '업무 중'.
- `ST.timeline(profile, from, days)`는 위 구간을 이어 붙여 `[{ id, start, end }]`로 돌려준다(§7.5 `nextActiveStart`에서 쓴다).

### 4.4 역할 → 상태 `ST.resolveRole(role, words, ctx)` (직장인 프리셋 기준; 프리셋마다 `roleMap`으로 바뀐다)

| 역할 | 결과 | 조건·덧붙임 |
|---|---|---|
| `work_start` | `work` (재택 계열 단어면 `wfh`) | 라벨은 사용자의 말(야근·알바·재택) |
| `work_end` | `off` | 귀가 계열(집 도착·집 왔어·집이야·귀가)은 그날 짐작이 '쉬는 날'이면 `day_off` |
| `half_day` 반차 | `off` + `until` | "오전 반차" 또는 12:00 전에 "반차" → `until` = 오늘 13:00. "오후 반차" 또는 12:00 이후 → `until` = 오늘 근무 끝. 라벨 '반차'. 끝나면 짐작으로 돌아간다 |
| `commute_in` / `commute_out` | `to_work` / `to_home` | |
| `break` `meal` `meeting` `focus` `class` `drive` `exercise` | 같은 이름의 덧씌움 | 시간 표현이 있으면 `until`. `returnTo` = 지금 명시 바탕 |
| `back` 복귀 | 덧씌움이면 `returnTo`(없으면 짐작으로) · `out`/`field`면 짐작이 업무 시간이면 `work`, 아니면 `off` · 이미 업무 범주면 `same` | 그 밖이면 상태 아님(`null`) |
| `arrive` 도착 | `to_work` → `work`, `to_home` → `off`, `out` → `back`과 같음 | 그 밖이면 상태 아님 |
| `out` / `field` / `day_off` | 같은 이름 | |
| `sleep` | `sleep`. "낮잠 …"은 `until` +60분, `returnTo` = 지금 바탕 | |
| `wake` | `current = null`(짐작으로) | 지금 `sleep`일 때만 |
| `idle` | 상태 그대로, 바로 '다음 할 일'(`AS.next()`) | 메모를 만들지 않는다 |
| `reset` | `none` | |

### 4.5 상태 바꾸기 `ST.setStatus(state, target, opts, profile, now) → Transition` (상태 변경 함수)

`target = { id, label?, role?, until?, minutes? }`, `opts = { source, text? }`. 호출은 늘 `S.mutate(null, fn, { source:'status' })` 안에서 한다(라벨 없음 = undo 대상 아님).

```
1. ST.ensure(state); ST.settle(state, profile, now); eff0 = effective(state, profile, now)
2. 같은 상태: p.current 가 있고 같은 id 이고 until·minutes 를 주지 않았으면 → return { noop:true, eff:eff0 }
   - 덧씌움에 minutes 를 주면 연장: until 만 바꾸고 log 없음 → return { extended:true }
   - 짐작 상태와 같은 id 를 명시하는 것은 같은 상태가 아니다(짐작 → 명시 = 진짜 변화)
3. def = profile.statuses[id]; overlay = def.overlay
4. until = target.until || (minutes ? now+minutes : overlay ? now + defaultMinutes(def, profile, now) : null)
5. returnTo = overlay ? (p.current && 덧씌움이면 p.current.returnTo : p.current && { id, label, since, source }) : null
6. 업무 범주 → 업무 아님(덧씌움 제외): parked = 진행 중이면서 새 상태에서 levelOf 가 'hide' 인 할 일 id
   업무 아님 → 업무 범주: resume = p.parked; p.parked = []
7. 바탕이 바뀌면 p.shown = [] (덧씌움으로 바뀔 때는 목록이 그대로이므로 유지)
8. p.current = { id, label: target.label || def.label, role, since: now, source, until, returnTo }
9. p.activatedAt = p.activatedAt || now
10. log.push({ at, id, label, from: eff0 && !eff0.guessed ? eff0.id : null, fromLabel, source, text: opts.text ? opts.text.slice(0,40) : undefined }); 60개로 자름
11. return { noop:false, from: eff0 && { id, label, guessed }, to: { id, label }, parked, resume, at: now }
```

`task.status`는 건드리지 않는다(I2). 카드의 [멈춰 두기]만 할 일 데이터를 바꾼다(라벨 '상태 변경').

**함께 쓰는 변경 함수** (모두 `presence`만 바꾼다)

| 함수 | 하는 일 |
|---|---|
| `ST.revert(state, profile, now)` | 마지막 log의 `from`으로 `setStatus`(source `'revert'`). `from`이 `null`(짐작이었음)이면 `current = null`. 카드를 만들지 않는다 |
| `ST.toGuess(state, now)` | `current = null`(시간표대로). log `{ id:null, source:'menu' }` |
| `ST.wake(state, now)` | 지금 `sleep`이면 `current = null`. 카드 없음 |
| `ST.settle(state, profile, now) → bool` | `until`이 지난 덧씌움·반차를 `returnTo`/`null`로, 낡은 상태를 `null`로 **저장**. log에 `source:'until'\|'expire'`. 앱 60초 tick과 `setStatus` 앞에서 부른다 |
| `ST.markShown(state, taskId)` | `shown`에 넣는다(최대 50) |
| `ST.confirmGuess(state, profile, now)` | 지금 짐작 상태를 명시로 정한다(source `'confirm'`). '뒤로 미룬 일' 묶음 머리의 [퇴근으로 정하기] 등 |

### 4.6 덧씌움이 끝날 때

- 저절로 끝나면 카드를 만들지 않는다. 칩만 조용히 바뀐다(`settle`).
- 휴식 타이머로 시작한 휴식(`source:'rest'`)은 기존 "휴식 끝! 다시 시작해 볼까요?" 메시지 하나만 낸다(§8.4).
- 연달아 바꾸기: 흐름의 마지막 메시지가 2분 안에 올린 상태 카드이면 새 카드를 올리지 않고 그 카드를 새 상태로 고친다(`AS.update`).

### 4.7 흐름 (자주 오가는 길만. 명시하면 어느 상태로든 바로 간다)

```
              ┌──── 출근길 ───(도착)───┐
 출근 전(짐작) ─┤                       ▼
              └───── 출근 ─────▶ 업무 중 ◀──── 복귀 ────┐
                                 │  │ └─ 외근 ─▶ 외근 중 ┘
     ┌── 점심·휴식·회의·집중 ─────┘  │      (덧씌움: until 이 지나면 returnTo 로)
     ▼  (목록 그대로)                │
  [덧씌움]                          ├── 퇴근 ─────────▶ 퇴근·내 시간 ── 잘게 ──▶ 잘 시간
                                    └── 퇴근길 ─(도착)─▶       ▲              │
                                                     외출 ─(복귀)┘   (10시간 또는 글을 적으면)
                                                                             ▼
                  하루 시작(04:00) 이 지나면 생활 상태는 끝 ───────────▶ 시간표 짐작(점선, 내리기만)
```

### 4.8 대표 하루 (직장인, 평일, 처음 쓴 뒤)

| 시각 | 던진 말 / 일 | Daynote |
|---|---|---|
| 07:40 | 앱 열기 | 칩 `출근 전 · 시간표 기준`(점선). 업무는 내림, 나머지는 보통(짐작은 띄우지 않음) |
| 08:20 | `출근길` | `출근길`. 폰으로 할 일(치과 예약 전화·카드값 이체)이 띄움 |
| 08:55 | `출근` | `업무 중`. 카드: "어제 하던 ‘분기 보고서’부터 이어서 할까요? [이어하기]" · "출근하면 하기로 한 일: 메일 확인" · "지금 하기 좋은 일: ‘…’ [지금 시작]" |
| 12:02 | `점심` | `점심 · 13:00까지`. 목록 그대로, 알림 멈춤. 카드: "점심 때 하기로 한 일: 은행 들르기" |
| 13:00 | (자동) | 칩만 `업무 중`으로 |
| 15:30 | `10분만 쉴게` | `휴식 · 15:40까지`. '다음 할 일'은 10분 안에 끝나는 일 |
| 18:40 | `퇴근! 가는 길에 우유 사기` | `퇴근 · 내 시간`. 원문 전체가 메모가 되고 할 일 '우유 사기'(밖 볼일, 걸어 둔 상태 `out`)가 생긴다. 업무 5개 숨김 |
| 21:00 | `빨래 다 했어` | 기존 완료 감지가 '빨래 돌리기'를 완료 |
| 23:30 | `잘게` | `잘 시간`. 목록 자리에 "내일 첫 일정 10:00 팀 회의 · 내일 마감 1개". 알림 없음 |
| 다음 날 07:10 | 아무 글이나 | 깨어 있다고 보고 짐작으로(`ST.wake`) |

---

## 5. 말로 바꾸기 — 감지기 (`src/core/status.js`, 순수 함수)

### 5.1 어디서 걸리나

```
A) 홈 입력창  chat.js sendNow() ─▶ AS.send(text)
B) 빠른 메모 창 quick.js ─▶ IPC quick:submit ─▶ assistant.watch onQuickCapture ─▶ AS.send(text)     (A 와 같음)
C) Ctrl+N     app.saveQuick(text, projectId)   ─▶ 자체 분기 (토스트로 알림)

AS.send(text, projectId)                         ← 감지는 여기서 한 번 (A·B 공통)
   1. (FEATURES_SPEC §6.3) p = DN.commands.parse(text)
        status  → statusCommand(p.args)          → DN.status.setFromCommand (§5.10)
        kind(/할일·/메모 …)·escaped(//…) → 상태 감지를 건너뛴다 (사용자가 종류를 정했거나 글로 남기겠다고 함)
   2. d = DN.status.detect(text)                 → ST.detect(text, { profile, eff, current, now })
   3. post 사용자 말풍선
   4. d 가 sure·pure  → DN.status.apply(d, { source:'text', surface:'chat', text }) → 상태 카드. 메모 없음. return null
   5. d 가 sure·섞임  → DN.status.apply(d, …) (상태 카드 먼저) → DN.capture.submit(원문 전체, projectId, onDone, { statusLine: d.statusLine })
   6. d 가 maybe      → DN.capture.submit(text, …, { statusHint: DN.status.hintFor(d) })   (예산이 남았을 때만 hint)
   7. 그 밖           → 지금 그대로. 단 지금 '잘 시간'이면 DN.status.touch() → ST.wake
```

```js
// renderer/assistant.js send() — 명령어 분기(FEATURES_SPEC) 뒤, 일반 글에만
var SU = DN.status, d = SU ? SU.detect(text) : null;
post({ role: 'user', kind: 'text', text: text });
if (d && d.tier === 'sure' && d.pure) { SU.apply(d, { source: 'text', surface: 'chat', text: text }); return null; }
if (d && d.tier === 'sure') SU.apply(d, { source: 'text', surface: 'chat', text: text });
else if (SU) SU.touch();
var note = DN.capture.submit(text, projectId, onDone, {
  statusLine: d && d.tier === 'sure' ? d.statusLine : null,
  statusHint: d && d.tier === 'maybe' ? SU.hintFor(d) : null });
```

- `DN.capture.submit`의 4번째 인자 `opts`(FEATURES_SPEC가 `command`로 만든다)에 `statusLine`, `statusHint`를 더하고, `addNote`의 `capture` 객체에 그대로 적는다. `classify`는 `sent.capture.statusLine`을 AI 입력으로 넘긴다(§14).
- 빠른 메모 창은 바꾸지 않는다. 창에 코어를 불러 미리 판정하지 않는다(P1안의 미리보기는 버림). 결과는 메인 창의 흐름에 남는다.
- Ctrl+N(`saveQuick`)도 같은 `detect`/`apply`를 쓰되, 결과는 토스트로 알린다(§10.4).

### 5.2 정규화와 첫 문장

```
norm(s): NFC → 앞뒤 공백 제거 → 라틴 소문자 → 이모지 제거 → 끝의 [.!~…ㅋㅎㅠㅜ^;]+ 제거 → '용$'→'요' → 공백 하나로
head:    첫 줄에서 첫 문장 경계까지 (경계: [.!?~…]+ (뒤 공백 없어도), ',', ' · ', 줄바꿈). 경계 문자는 head 에 남긴다('?' 검사용)
rest:    head 뒤의 나머지 원문 (trim). 비면 pure
```

- 상태는 **글 전체가 상태이거나 첫 문장이 상태일 때만** 인정한다. 긴 메모 중간의 "퇴근길에 본 노을"은 상태가 아니다.
- `norm(head)`가 30자를 넘으면 상태가 아니다(sure도 maybe도 아님).
- **오타는 고치지 않는다.** 오탐이 미탐보다 훨씬 비싸다. 느슨한 맞춤은 `/상태` 명령에서만 한다(§5.10).

### 5.3 문법 (sure 판정)

```
SURE   := FILLER* DUR? CORE TAIL? DUR?          (h 전체와 일치, 덩어리 사이 공백은 있어도 없어도 됨)
FILLER := 이제 | 지금 | 드디어 | 방금 | 막 | 그럼 | 자 | 일단 | 오늘은 | 오늘 | 나 | 저 | 나도 | 저도
CORE   := 사전(§5.6)의 핵심어 — 긴 것부터 시도하고, SURE 전체가 맞는 첫 핵심어가 이긴다 ('출근 중' 이 '출근'+'중' 보다 먼저)
TAIL   := 함 | 했어 | 했어요 | 했음 | 했다 | 했습니다 | 합니다 | 해요 | 할게 | 할게요 | 할께 | 완료 | 중 | 중이야 | 중이에요 | 중임
        | 하는 중 | 감 | 가요 | 갑니다 | 간다 | 왔어 | 왔어요 | 왔음 | 옴 | 도착 | 도착했어 | 들어감 | 들어가요 | 나감 | 나가요
        | 이다 | 이야 | 야 | 이에요 | 예요 | 입니다 | 임 | ㄱ | ㄱㄱ
DUR    := (\d+)\s*분(만|정도|동안)? | (\d+|한|두|세)\s*시간(\s*반)?(만|정도|동안)? | 반\s*시간
        | (오전|오후)?\s*(\d{1,2})시(\s*(\d{1,2})분|\s*반)?\s*(까지|에 복귀|복귀)
```

- **'고'는 꼬리가 아니다.** "퇴근하고"는 늘 막는다(P1안의 꼬리 '고'와 막기 '하고'의 충돌을 없앴다).
- **'시작'·'끝'도 꼬리가 아니다.** 뜻이 핵심어마다 달라서("점심 끝" = 복귀, "운동 끝" = 복귀, "일 끝" = 퇴근) 사전에 핵심어로 따로 둔다.
- **"할게"는 '지금'으로 본다.** "퇴근할게"는 지금 나간다는 뜻이다.
- 시간 해석
  - "N분", "N시간" → `until = now + N`.
  - "H시까지": 오전/오후가 없으면 H:00과 (H+12):00 중 지금 뒤의 가장 이른 것. **8시간보다 멀면 `until` 없음.** 예: 14:00에 "6시까지 외출" → 18:00. 19:00에 → `until` 없음(다음 날 06:00은 11시간 뒤).
  - 시간 표현은 덧씌움·외출·반차에만 쓴다. 다른 상태에서는 무시한다.

### 5.4 막기 규칙 (하나라도 걸리면 상태 아님 = `null`)

| 자리 | 말 |
|---|---|
| head 어디든 | `?`·`？`, 언제, 몇 시, 아직, 내일, 모레, 이따, 나중에, 다음 주, 어제, 했었, 싶(다·어), 예정, 퇴사, 해야 |
| 핵심어 바로 뒤 (꼬리 대신) | 하고, 하면, 하면서, 하자마자, 한 다음, 하고 나서, 후, 전, 시간(핵심어가 '…시간'이 아닐 때), 길에(핵심어가 '…길'이 아닐 때), 하러, 하기, 가기, 보기, 하자, 했나, 하나, 하냐, 하니, 하지, 할까, 못, 늦 |
| 핵심어 바로 앞 | `안 `, `못 `, **다른 사람**: (님\|씨\|남편\|아내\|와이프\|엄마\|아빠\|친구\|동생\|형\|누나\|언니\|오빠\|팀장\|부장\|과장\|대리\|사장\|선배\|후배\|아이\|애\|아들\|딸)(은\|는\|이\|가\|도\|께서)? |
| 할 일 꼴 | 핵심어 뒤가 `기`·`하기`·`가기`·`보기`로 끝남 ("운동 가기", "장보기", "퇴근 시간 바꾸기") |

**예외(막기보다 먼저 본다)**
- `idle`·`reset`·`wake` 특수어가 앞말만 붙어 **정확히 일치**하면 막기를 보지 않는다("뭐 할까"는 '할까'로 막히지 않음).
- "퇴근 못 함", "퇴근 못해", "퇴근 못 할 듯" → **maybe** `work_start`(라벨 '야근'). 상태를 바꾸지는 않는다.

### 5.5 판정 순서 `ST.detect(text, ctx) → Detection | null`

```
ctx = { profile, eff: Eff|null, current: presence.current|null, now }
1. raw 가 비었거나 '/'·'／' 로 시작 → null (명령은 commands 가 처리)
2. head, rest 나누기 (§5.2). h = norm(head). h 가 비었거나 30자 초과 → null
3. 특수어 정확 일치 (idle·reset·wake) → 결과. wake 는 current.id === 'sleep' 일 때만, 아니면 null
4. '퇴근 못 함' 계열 → maybe(work_start, '야근')
5. 막기 규칙 → null
6. hits = 사전 핵심어 중 h 에 든 것 (긴 것부터). 이 프리셋에서 쓰지 않는 프리셋 전용 말은 빼고 ST.presetSignal 로만 센다(§12.3). 없으면 null
7. 다른 사람·할 일 꼴 → null
8. tier:
   SURE 문법이 맞고, 핵심어가 '애매만'이 아니고, ('꼬리 있어야 확실' 이면 TAIL 이 있음) → 'sure'
   아니면 남는 글자(h 에서 핵심어·앞말·꼬리·DUR·공백을 뺀 것) ≤ 6자 → 'maybe'
   아니면 → null
9. 문(gate) 검사 (§5.6 '문' 열) → 못 지나면 null
10. resolveRole → 상태 (§4.4). null 이면 null (예: 이동 중이 아닌데 '도착')
11. until/minutes 계산 (§5.3, 점심 기본은 autoSchedule.lunch)
12. return { tier, role, id, label, until, minutes, pure: tier==='sure' && !rest, statusLine: head.trim().slice(0,80),
             rest, matched: 핵심어, same: (id === 지금 명시 상태 id) }
```

- maybe는 상태를 바꾸지 않는다. 결과 카드의 제안 칩으로만 쓴다(§5.8).
- 기능을 켜기 전(`eff === null`)에도 sure 감지는 돈다. 사용자가 상태를 직접 말한 것이므로 그것으로 기능이 켜진다(P-1의 "첫 사용"). maybe·AI 제안은 켜기 전에는 보이지 않는다.

### 5.6 문구 사전 (`statusWords.js` `PHRASES`, 모든 프리셋 공통)

'확실' = 꼬리가 있어도 없어도 sure. '꼬리 필요' = 꼬리가 있으면 sure, 없으면 maybe. '애매만' = 늘 maybe.

| 역할 | 확실 | 꼬리 필요 | 애매만 | 문(gate) | 칩 라벨 |
|---|---|---|---|---|---|
| `work_start` | 출근, ㅊㄱ, 출근 완료, 회사 도착, 회사 왔어, 사무실 도착, 자리 도착, 업무 시작, 일 시작, 근무 시작, 작업 시작, 업무 중, 근무 중, 일하는 중, 작업 중, 야근, 야근 시작, 알바 출근 | – | (퇴근 못 함 — §5.4) | – | 업무 중 · 야근 · 알바 |
| `work_start`→`wfh` | 재택, 재택 시작, 재택근무, 재택 중 | – | – | – | 재택 |
| `work_end` | 퇴근, ㅌㄱ, 칼퇴, 칼퇴근, 정시퇴근, 정시 퇴근, 바로 퇴근, 일 끝, 업무 끝, 오늘 일 끝, 근무 끝, 작업 끝, 오늘 끝, 하교, 알바 끝 | – | – | – | 퇴근 · 내 시간 (하교·알바 끝은 그 말) |
| `work_end`(귀가) | 집 도착, 집 왔어, 집이야, 귀가 | – | – | 짐작이 쉬는 날이면 `day_off` | 집 |
| `half_day` | 반차, 오전 반차, 오후 반차 | – | – | – | 반차 |
| `commute_in` | 출근 중, 출근하는 중, 출근길, 회사 가는 중, 등교 중, 등굣길 | – | 지하철 탐, 버스 탐¹ | – | 출근길 |
| `commute_out` | 퇴근 중, 퇴근하는 중, 퇴근길, 집 가는 중, 집에 가는 중, 귀가 중 | – | (지하철 탐, 버스 탐)¹ | – | 퇴근길 |
| `break` | 휴식, 휴식 중, 휴식 시작, 쉬는 중, 쉴게, 잠깐 쉼, 잠깐 쉴게, 쉬는 시간, 휴게, 휴게 시간, 브레이크 | – | 커피, 커피 한잔, 커피 타임, 티타임, 바람 쐬러, 담배, 흡연, 머리 식히기 | 애매만 단어는 업무 범주(짐작 포함)일 때만 | 휴식 · 커피 |
| `meal` | 점심, 점심시간, 점심 시간, 점심 먹으러, 점심 먹는 중, 밥 먹으러, 밥 먹는 중, 식사, 식사 중, 저녁 먹으러, 저녁 먹는 중 | – | – | **업무 범주(짐작 포함) 또는 `focus` 덧씌움일 때만** | 점심 · 식사 · 저녁 |
| `back` | 복귀, 자리 복귀, 업무 복귀, 다시 일, 돌아왔어, 다녀왔어, 다시 시작, 점심 끝, 휴식 끝, 회의 끝, 미팅 끝, 운동 끝, 수업 끝, 점심 먹었어 | – | – | '점심 먹었어'·'점심 끝'은 `meal` 덧씌움일 때만, '회의 끝'은 `meeting`일 때만. 그 밖은 §4.4 | – |
| `arrive` | 도착, 도착했어, 다 왔어 | – | – | 이동·외출 중일 때만 | – |
| `out` | 외출, 외출 중, 잠깐 나갔다 올게, 나갔다 올게, 장 보러 감, 장 보는 중, 마트 가는 중, 마트 왔어, 은행 가는 중, 병원 가는 중, 볼일 보러 감 | – | 나왔어, 밖이야 | – | 외출 중 · 장보기 · 은행 · 병원 |
| `field` | 외근, 외근 중, 외근 나감, 거래처 가는 중, 거래처 방문 중, 현장 나감, 출장, 출장 중, 미팅 가는 중 | – | – | – | 외근 · 출장 |
| `meeting` | 회의 들어감, 회의 중, 회의 시작, 미팅 들어감, 미팅 중, 미팅 시작, 상담 중, 면담 중 | – | 회의, 미팅 | – | 회의 · 미팅 |
| `focus` | 집중 모드, 집중 시작, 몰입 모드, 방해 금지 | 집중 | – | – | 집중 |
| `class` | 수업 중, 수업 들어감, 수업 시작, 강의 중, 강의 들어감, 강의 시작 | – | 학원 | – | 수업 · 강의 |
| `drive` | 운전 중, 운전 시작 | 운전 | – | – | 운전 중 |
| `exercise` | 운동 중, 운동 시작, 운동 가는 중, 헬스장 도착, 헬스 중, 러닝 중, 요가 중, 수영 중 | 운동, 헬스, 러닝, 요가, 필라테스, 수영, 산책 | – | – | 그 말 |
| `day_off` | 쉬는 날, 오늘 쉼, 오늘 쉬어, 휴무, 휴무일, 연차, 월차, 휴가, 휴일, 주말 모드 | – | – | – | 연차 · 휴가 · 쉬는 날 |
| `sleep` | 잘게, 자러 감, 잔다, 자야지, 취침, 굿나잇, 굿밤 | 낮잠(+60분) | – | – | 잘 시간 · 낮잠 |
| `wake` | 기상, 일어났어, 일어남, 굿모닝 | – | – | `sleep`일 때만 | – |
| `idle` | 한가해, 한가함, 심심해, 뭐 하지, 뭐 할까, 할 거 없나 | – | – | 정확 일치 | 상태 그대로 + 다음 할 일 |
| `reset` | 상태 해제, 상태 없음, 모두 보기, 다 보여 줘 | – | – | 정확 일치 | 모두 보기 |

¹ "지하철 탐"·"버스 탐"은 방향을 짐작한다. 지금 업무 범주면 `commute_out`, 아니면 `commute_in`.

**공통 사전에 넣지 않는 말**(프리셋 전용, §12.3): 오프, 비번, 데이, 이브닝, 나이트, 오픈, 문 열었어, 마감했어, 문 닫았어, 영업 끝, 등원, 하원, 육퇴, 공강, 도서관 도착. 공통 사전에는 뜻이 하나인 말만 둔다.
"마감했어"는 직장인 프리셋에서 상태가 아니라 기존 완료 감지(`DONE_RE`)로 간다.

### 5.7 사용자 말

- 상태 설정의 `words`가 사전의 '확실' 칸에 더해지고, `wordsOff`는 뺀다.
- 사용자 상태의 라벨도 핵심어가 된다(예: '운동 중' 상태 → "운동 중"이라고 쓰면 그 상태).
- 사용자 말이 기본 말과 겹치면 사용자 말이 이긴다. 같은 말을 두 사용자 상태에 넣으려 하면 설정 화면에서 그 자리에서 막는다.

### 5.8 글 종류별 처리

| 입력 | 감지 | 결과 |
|---|---|---|
| `퇴근` | sure, pure | 상태만 바꾼다. 메모 없음. 흐름: 내 말풍선 + 상태 카드(+[메모로 남기기]) |
| `퇴근! 가는 길에 우유 사기` | sure, 섞임 | 상태를 바꾸고, **원문 전체**를 메모 본문으로 저장한다. `statusLine:'퇴근!'` → AI·가짜 AI가 '퇴근'을 할 일로 만들지 않는다. 할 일 '우유 사기'(atMode `out`) |
| `출근함\n9시 회의 자료 출력` | sure, 섞임 | 같음 |
| `퇴근하고 우유 사기` | null ('하고') | 그냥 정리. 할 일 '우유 사기', atMode `off` (§5.9) |
| `출근하면 메일 확인` | null | 할 일 '메일 확인', atMode `work`, 맥락 업무 |
| `오늘 퇴근길에 본 노을 예뻤다` | null (남는 글자 > 6) | 메모 |
| `퇴근 언제 하냐 ㅠ` / `팀장님 퇴근하심` / `운동 가기` | null | 메모 / 메모 / 할 일 |
| `커피 한잔` (업무 중) | maybe | 평소처럼 정리 + 결과 카드에 "상태를 ‘커피’로 바꿀까요? [바꾸기] [아니요]"(예산이 남았을 때) |
| `퇴근 못 함` | maybe | 정리 + "상태를 ‘야근’으로 바꿀까요?"(지금 명시 업무가 아닐 때만) |
| `한가해` | idle | 메모 없음. 상태 그대로 '다음 할 일' 카드 |
| `//퇴근` · `/메모 퇴근` | (감지 안 함) | 메모 (사용자가 글로 남기겠다고 함) |

**상태만 적은 글을 메모로 남기지 않는 이유**: "퇴근" 메모 수백 개는 보관함을 더럽힌다. 원문은 흐름(`state.chat`)의 말풍선과 `presence.log.text`에 남으므로 "적은 건 사라지지 않는다"는 약속은 지켜진다. 원하면 카드의 [메모로 남기기] 한 번이면 된다. 이 예외는 **글 전체가 상태 보고일 때만** 적용한다.

### 5.9 걸어 둔 상태 추출 `ST.extractAtMode(title) → null | { mode, phrase, title }`

- 제목 **맨 앞**의 §2.4 표현을 떼고, 남은 앞쪽 조사·쉼표(`에`, `엔`, `,`)와 공백을 다듬는다.
  - 예: "퇴근하고 우유 사기" → `{ mode:'off', phrase:'퇴근하고', title:'우유 사기' }`
  - 예: "나가는 김에 우체국 들르기" → `{ mode:'out', … title:'우체국 들르기' }`
- 다듬은 제목이 2자 미만이면 `null`이다(떼지 않는다).
- `ST.findAtMode(text) → mode|null`은 글 어디든 같은 표현이 있는지 본다. AI의 `do_in`을 검증할 때 쓴다(§14).
- 쓰는 곳: `applySelections`(AI가 제목에 남겼으면 한 번 더 떼기), 가짜 AI, FEATURES_SPEC의 `F.rulesItem`(명령어로 만든 할 일 → `atModeSource:'rule'`).

### 5.10 `/상태` 명령 — `DN.status.setFromCommand(args, { now, source:'command', surface })`

FEATURES_SPEC §6.9의 `statusCommand`가 부른다. 인자 해석은 `ST.parseStatusArgs(args, profile, eff, now)`가 한다.

| args | 결과 | 돌려주는 message |
|---|---|---|
| (없음) | FEATURES_SPEC은 지금 상태를 글로 알린다. **고침**: `DN.status.postPicker`가 있으면 `kind:'status-pick'` 카드(메뉴 상태 칩 줄)를 올린다 | – |
| `퇴근`, `퇴근 · 내 시간`, `off`, 사전의 모든 말(이 프리셋 전용 말 포함) | 그 상태 | `상태를 ‘퇴근 · 내 시간’으로 바꿨어요. 업무 할 일 5개는 접어 뒀어요.` |
| `휴식 10분`, `외출 6시까지` | 덧씌움·외출 + until | `10분 쉬어요 · 15:40에 ‘업무 중’으로 돌아갈게요.` |
| `자동`, `시간표`, `시간표대로` | `ST.toGuess` | `시간표대로 둘게요. 지금은 ‘업무 중’(시간표 기준)이에요.` |
| `이전`, `되돌리기`, `이전 상태` | `ST.revert` | `‘업무 중’으로 되돌렸어요.` |
| 오타 `퇴큰` | **명령에서만** 편집 거리 1 이하로 맞는 말이 하나뿐이면 그것 | 위와 같음 |
| 지금과 같은 상태 | noop | `이미 ‘업무 중’이에요 (09:02부터).` |
| 모르는 이름 `가게 오픈 준비` | `{ ok:false }` | `‘가게 오픈 준비’라는 상태가 없어요. 설정 › 현재 상태에서 만들 수 있어요.` |

- 감지 규칙의 막기(§5.4)는 쓰지 않는다. 명령은 명시적이다.
- 흐름(`surface:'chat'`)에서는 `setFromCommand`가 상태 카드를 직접 올리고 `{ ok:true, label, posted:true }`를 돌려준다. **FEATURES_SPEC 고침**: `statusCommand`는 `r.posted`이면 글 메시지를 따로 올리지 않는다.
- Ctrl+N(`surface:'toast'`)은 message를 토스트로 보인다.
- 상태 변경은 라벨 없는 mutate다. FEATURES_SPEC §1.5는 "되돌리기 라벨이 있는 mutate"라고 적었지만, 이 설계의 결정 10이 그것을 대신한다. '스스로 mutate한다'는 계약은 그대로 지킨다.
- `/퇴근` 같은 상태별 단축 명령은 두지 않는다. 명령 이름 공간을 깨끗하게 두고, 그냥 "퇴근"이라고 적으면 되기 때문이다.

### 5.11 감지 API 요약

```js
ST.detect(text, { profile, eff, current, now }) → null | Detection
  // Detection = { tier:'sure'|'maybe', role, id, label, until, minutes, pure, statusLine, rest, matched, same }
ST.parseStatusArgs(args, profile, eff, now) → { cmd:'picker'|'set'|'guess'|'revert'|'unknown', id?, label?, until?, minutes? }
ST.extractAtMode(title) → null | { mode, phrase, title }
ST.findAtMode(text) → mode | null
ST.presetSignal(text, profile) → presetId | null      // 지금 프리셋이 아닌 프리셋의 전용 말이면 그 프리셋
ST.onPhone(task) → bool
```

---

## 6. 맥락

### 6.1 우선순위 `ST.contextOf(state, task, profile, now) → ContextResult` (읽을 때 계산)

| 순위 | source | 조건 | 비고 |
|---|---|---|---|
| 1 | `user` | `task.contextSource === 'user'` | 값이 `null`이면 '정하지 않음'으로 고정. 절대 덮지 않는다 |
| 2 | `project` | 할 일의 프로젝트에 `context`가 있음 | 사용자가 프로젝트에 정한 값 |
| 3 | `learned` (제목) | `DN.adapt.suggest(state,'context',title,now,{allowed})` 결과의 `role === 'exact'`이고 수준이 hint 이상 | 같은 제목을 한 번 고친 것도 쓴다 |
| 4 | `ai` | `task.contextSource === 'ai'`이고 지금 있는 맥락 id | |
| 5 | `learned` (낱말) | 같은 `suggest` 결과가 `strong`(2번 이상 · 확신도 ≥ 0.66, 대략 3분의 2) | 한 번의 실수가 비슷한 할 일 전체로 번지지 않게 |
| 6 | `rule` | 단어 점수(§6.2, 사용자 단어 포함) | 점수 ≥ 2, 2등과 차이 ≥ 1 |
| 7 | `hint` | 메일에서 온 할 일(`sources[].type==='email'`) → `work` | **내릴 수는 있어도 숨기지는 못한다**(§7.4) |
| 8 | `null` | – | 모든 상태에서 보통 |

- 배운 결과가 `'none'`이면 `{ value:null, source:'learned' }`이다. 사용자가 '정하지 않음'으로 고친 것을 배운 것이고, 규칙보다 앞선다.
- 지워진 사용자 맥락 id가 저장돼 있으면 그 단계를 건너뛴다.
- 제목이 비면 `sources[0].excerpt`로 3·5·6단계를 한 번 더 본다.
- 메모 키: `task.id | task.updatedAt | task.title | task.projectId | profile.hash | learnedStamp`. `learnedStamp`은 `learned.metrics.learned + ':' + learned.rules.length`다. 할 일 1000개 × 규칙 300개에서도 한 번 계산하면 된다.
- `DN.adapt`가 아직 없거나 `prefs.learning === false`이면 3·5단계를 건너뛴다.

### 6.2 단어 규칙 `ST.ruleContext(text, profile) → null | { ctx, score, margin, evidence, scores }`

```
t     = NFC · 라틴 소문자 · '#맥락' 태그 뗌
toks  = t 를 /[\s,./·()\[\]!?~:;'"“”‘’]+/ 로 자른 낱말들
tight = t 에서 공백을 뺀 것
1) 띄어 쓴 키워드('코드 리뷰', '장 보기', '빨래 개기', '물 주기', '택배 보내기'):
   tight 가 공백 뺀 키워드를 포함하면 점수를 더하고, 그 키워드를 이루는 낱말은 2)에서 세지 않는다
2) 낱말 키워드: 낱말마다 그 낱말로 '시작하는' 키워드 중 **가장 긴 하나만** 센다 ('빨래를' → 빨래, '빨래방' → 빨래방, '세탁소' → 세탁소)
   - 라틴 키워드(PR·PPT·KPI·OKR·QA)는 낱말 전체가 같을 때만
   - 제외어(EXCLUDE: 청소년, 은행나무)로 시작하는 낱말은 건너뛴다
3) 끝말: 제목이 (사기|사 오기|사오기|사러 가기|들르기|맡기기|찾아오기|반납하기)$ 로 끝나면 errand +2
4) 가중치: 강 3 · 중 2 · 약 1. 사용자 단어는 3
5) best ≥ 2 이고 best − second ≥ 1 → ctx. 아니면(동점 포함) null — 맥락 없음 = 숨지 않음
```

동점이면 맥락을 정하지 않는다. 개인 일을 업무로 잘못 정하면 퇴근 뒤에 **숨어서** 놓치고, 업무를 개인 일로 잘못 정하면 업무 중에 **내려갈** 뿐이다. 이 비대칭 때문에 애매하면 정하지 않는 쪽을 택한다.

### 6.3 단어 사전 (`statusWords.js` `CONTEXT_WORDS`, P1 목록을 정리하고 P2 가중치를 붙임)

| 맥락 | 강(3) | 중(2) | 약(1) |
|---|---|---|---|
| work | 보고서, 회의록, 기획안, 기획서, 제안서, 견적서, 견적, 발주, 결재, 품의, 거래처, 클라이언트, 고객사, 계약서, 세금계산서, 인보이스, 출장, 배포, 코드 리뷰, 스프린트, 인수인계, 업무, 납품, 협력사, 회사, 사무실 | 회의, 미팅, 발표, 슬라이드, 엑셀, 회신, 정산, 실적, 매출, 단가, 팀장, 부장, 과장, 대표님, 온보딩, 야근, 손님, 매장, 재고, 리뷰 답글, PR, PPT, KPI, OKR, QA | 이슈, 버그, 자료, 메일 |
| home | 빨래, 빨래 개기, 세탁기, 건조기, 설거지, 청소, 청소기, 분리수거, 다림질, 밥하기 | 쓰레기, 음식물, 재활용, 정리정돈, 옷장, 이불, 침구, 화장실, 욕실, 냉장고, 요리, 반찬, 화분, 전구, 보일러, 고양이 모래 | 필터, 커튼, 수리 |
| errand | 장보기, 장 보기, 마트, 우체국, 택배 보내기, 세탁소, 빨래방, 주민센터, 동사무소, 은행, 다이소, 철물점, 미용실, 세차, 주유 | 반품, 구청, 약국, 편의점, 수선, 픽업, 찾아오기, 들르기 | (끝말 +2) |
| personal | 운동, 헬스, 러닝, 달리기, 요가, 필라테스, 수영, 치과, 진료, 검진, 건강검진, 관리비, 공과금, 카드값, 여권, 항공권 | 병원, 산책, 스트레칭, 영양제, 약 먹기, 예약, 송금, 이체, 보험, 해지, 연말정산, 친구, 여행, 숙소, 티켓, 취미, 독서, 책 읽기, 영화, 일기 | 생일, 선물, 주문 |
| family | 어린이집, 유치원, 등원, 하원, 준비물, 알림장, 학부모, 예방접종, 이유식, 기저귀, 운동회 | 아이, 애들, 아기, 엄마, 아빠, 부모님, 어머니, 아버지, 시댁, 처가, 남편, 아내, 와이프, 가족, 생신 | – |
| study | 공부, 인강, 복습, 예습, 자격증, 토익, 오픽, 숙제, 과제, 레포트 | 강의, 시험, 단어, 수업, 논문, 중간고사, 기말고사, 모의고사, 문제집 | – |

P1안 목록에서 일부러 뺀 말과 그 이유:
- 책 → '책임'에 걸린다. '책 읽기'·'독서'로 대신한다.
- 보고 → '보고 싶다'에 걸린다. '보고서'로 대신한다.
- 리포트 → '3분기 리포트'(업무)와 과제가 겹친다. 학생 표기 '레포트'만 둔다.
- 정리 → 어디에나 나온다.
- 사기(동사) → 끝말 규칙으로 대신한다.

**계산 예**

| 제목 | 점수 | 결과 |
|---|---|---|
| 빨래 돌리기 | home 3 | home |
| 회의록 정리 | work 3 (가장 긴 '회의록') | work |
| 청소년 지원사업 보고서 | '청소년' 제외 · work 3 | work |
| 우유 사기 | errand 2 (끝말) | errand |
| 엄마 생신 선물 주문 | family 4 · personal 2 | family |
| 엄마 선물 사기 | family 2 · errand 2 · personal 1 → 동점 | **null (숨지 않음)** |
| 정리하기 | – | null |
| 빨래방 가기 | errand 3 ('빨래'가 아니라 더 긴 '빨래방') | errand |

### 6.4 사용자 단어와 맥락

- 맥락 설정의 `words`는 그 맥락에 3점으로 더해지고, `wordsOff`는 기본 사전에서 뺀다.
- 사용자 맥락은 그 단어로만 잡힌다. 기본 정책 칸은 업무 범주 행에서 내림, 그 밖 행에서 보통이다(§7.3).
- 맥락을 지우면 "이 맥락의 할 일 N개를 [정하지 않음 ▾]로 옮길까요?"를 묻는다(`ui.confirm` + 선택). 남은 저장값은 모르는 id로 보고 무시한다.

### 6.5 직접 정하기

| 어디서 | 모양 | 동작 |
|---|---|---|
| 오늘 목록 — 내림 묶음·펼친 숨김 묶음의 행 | `button.chip.ctx-chip.ctx-<id>` (규칙·AI·학습·힌트면 점선 `is-guess`) | `ui.menu` "어느 쪽 일인가요?" → 맥락 6개 + 사용자 맥락 + 정하지 않음 |
| 결과 카드의 할 일 행 (기능을 켠 뒤에만) | `[집안일 (추정) ▾]` 칩, `data-focus-key="cap:<noteId>:<i>:ctx"` | 같음 |
| 상세 패널 | '맥락' 줄: 선택 + 이유 한 줄 + '언제 할까요' + 지금 효과 한 줄 (§10.6) | 같음 |
| 던질 때 `#태그` | `#집안일 빨래 돌리기`, `빨래 #집` — 맥락 라벨이나 별칭(§2.3)과 맞으면 사용자 맥락. 태그는 제목에서 뗀다 | `#` 바로 뒤가 공백인 마크다운 제목(`# 회의록`)은 태그가 아니다 |
| 프로젝트 화면 | 머리의 '기본 맥락' 선택 | `project.context`. 라벨 `'프로젝트 맥락 바꾸기'` |

```js
// 맥락 바꾸기 — 라벨 있는 mutate. 교정과 배우기가 함께 되돌아간다
S.mutate('맥락 바꾸기', function (s) { ST.setTaskContext(s, taskId, ctxId /* null = 정하지 않음 */, profile, now); }, { source: 'today' });
```

`ST.setTaskContext(state, taskId, ctxId, profile, now)`:
1. `prev = contextOf(...)`(바꾸기 전 계산값).
2. `task.context = ctxId`, `contextSource = 'user'`.
3. `DN.adapt`가 있고 켜져 있으면:
   - `prev.source === 'learned'`였고 값이 다르면 `AD.penalize(state, prev.ruleIds, now, 1)`, `AD.count(state, 'reverted')`.
   - `AD.learn(state, { type:'context', text: task.title, from: prev.value || null, to: ctxId || 'none', ref: (출처 메모 id || null), sample: !!task.sample, source:'correction' }, now)`.
4. 반환 `{ task, learned: 'none'|'hint'|'strong' }`. 같은 제목 정확 일치는 hint, 낱말이 strong이 되면 strong. 화면은 strong이 처음 되었을 때만 토스트 "앞으로 ‘견적서’가 들어간 할 일은 업무로 볼게요"를 띄운다.

### 6.6 적응형 학습과의 계약 (ADAPTIVE_PLAN §7.8 고침)

| 항목 | 이 설계의 약속 |
|---|---|
| 유형 | `context`를 **할 일 맥락**으로 쓴다. `to`는 맥락 id(`work`… `u_…`) 또는 `'none'` |
| `TYPES.context` | `{ halfLife: 60, roles: ['exact','part'], strongN: 2, strongNPart: **2**, toAi: false }` — `strongNPart`를 3에서 2로 고친다(판정: "낱말 학습은 교정 2번 이상 · 3분의 2 이상") |
| `allowed` | 지금 있는 맥락 id + `'none'` |
| 배우는 때 | `'맥락 바꾸기'` mutate 안. 다른 곳(AI 결과, 규칙, 학습 결과를 그대로 둔 것)은 증거가 아니다 |
| 벌점 | 학습으로 정해진 맥락을 사용자가 다른 값으로 고치면 `penalize` + `count('reverted')` |
| 화면 | 설정 "Daynote가 배운 것"의 묶음 이름은 **"할 일 맥락"**. 칩 라벨은 `DN.statusCore.contextLabel(profile, to)`로 그린다(`'none'` → "정하지 않음") |
| 개인정보 | `toAi:false`이므로 AI 힌트(`AD.hints`)에 나오지 않는다 |
| 끄기 | 같은 `prefs.learning`을 따른다 |
| 상태(말) 학습 | v1에서는 하지 않는다. 상태 감지는 규칙 사전과 사용자 말(§5.7)로만 한다 |

---

## 7. 정책

### 7.1 네 단계

| 수준 | 오늘 목록 | 추천 `levelRank` | 자동 제안(작게 나누기·구체화) | 사이드바 '오늘' 숫자 |
|---|---|---|---|---|
| `up` 띄움 | 맨 위(걸어 둔 일은 별도 머리) | 0 | 대상 | 셈 |
| `normal` 보통 | 가운데(지금 순서 그대로) | 1 | 대상 | 셈 |
| `down` 내림 | 아래 묶음 "지금은 뒤로 미룬 일 N개". 제목은 `--text-secondary`, 맥락 칩(투명도는 쓰지 않음) | 2 | 제외 | 셈 |
| `hide` 숨김 | 접은 한 줄 "업무 할 일 5개 숨김 · 보기" | 후보에서 뺌(`excluded.hidden`) | 제외 | 빼고 셈 |

`task.priority`와 `sortOrder`는 절대 바꾸지 않는다. "내려간다"는 보여 주는 순서의 이야기다.

### 7.2 직장인 기본 정책표 (`PRESETS.office.matrix`)

| 상태 ↓ / 맥락 → | 업무 | 집안일 | 밖 볼일 | 개인 | 가족 | 공부 | 정하지 않음 |
|---|---|---|---|---|---|---|---|
| 업무 중 `work` | **띄움** | 내림 | 내림 | 내림 | 내림 | 내림 | 보통 |
| 재택 근무 `wfh` | **띄움** | 내림 | 내림 | 내림 | 내림 | 내림 | 보통 |
| 외근 중 `field` | **띄움** | 내림 | 보통 | 내림 | 내림 | 내림 | 보통 |
| 출근길 `to_work` | 보통 | 내림 | 내림 | 보통 | 보통 | 보통 | 보통 |
| 퇴근길 `to_home` | **숨김**¹ | 내림 | **띄움** | 보통 | 보통 | 보통 | 보통 |
| 외출 중 `out` | 내림² | 내림 | **띄움** | 보통 | 보통 | 보통 | 보통 |
| 퇴근 · 내 시간 `off` | **숨김**¹ | **띄움** | 보통 | **띄움** | **띄움** | 보통 | 보통 |
| 쉬는 날 `day_off` | **숨김**¹ | **띄움** | **띄움** | **띄움** | **띄움** | 보통 | 보통 |
| 잘 시간 `sleep` | 모두 숨김. 목록 자리에 "내일 미리보기"(§9.5) ||||||
| 모두 보기 `none` | 모두 보통 ||||||
| 덧씌움(휴식·식사·회의·집중·수업·운전·운동) | **목록은 바탕 상태 그대로.** 추천만 바뀜(§8) ||||||

- ¹ `afterWork`(기본 '숨김', 바꾸면 '내림')가 정한다.
- ² 외출은 업무 시간 중의 잠깐 외출일 수 있으므로 업무를 숨기지 않는다.
- 이동 중(`moving` 범주)에는 폰으로 할 일이 숨김이 아닌 한 띄움이다.

### 7.3 행 계산 공식 (사용자 상태와, 프리셋이 정하지 않은 행)

`ST.profile`이 범주와 장소로 기본 행을 만들고, 그 위에 프리셋 행, 사용자 칸 덮어쓰기(`statusProfile.policy`), `afterWork` 순으로 덮는다.

| 범주 | 주 맥락(`primary`) | 그 밖 | 장소 조정 |
|---|---|---|---|
| work | 띄움 | 내림 | `out` → 밖 볼일 보통 |
| moving | 보통 | 집안일·밖 볼일 내림, 나머지 보통 | 폰으로 할 일 띄움 |
| life | `afterWork` (`place:'out'`이면 내림) | 보통 | `home` → 집안일·개인·가족 띄움 / `out` → 밖 볼일 띄움, 집안일 내림 |
| rest | `afterWork` | 보통 | `home`처럼 + 밖 볼일 띄움 |
| sleep | 숨김 | 숨김 | – |
| none | 보통 | 보통 | – |
| overlay | (행 없음) | | |

정하지 않음(`_none`) 열은 sleep을 빼면 늘 보통이다. 사용자 맥락 열은 work 범주 행에서 내림, 그 밖 행에서 보통이다.

### 7.4 수준 정하기 `ST.levelOf(state, task, ctxR, eff, profile, now) → { level, reason, breakthrough }`

```
0. eff 없음 → { level:'normal' }                                         // I1
1. 바탕이 sleep → 'hide' (reason 'sleep'). shown 만 예외
2. lvl = ctxR.value ? matrix[eff.id][ctxR.value] : matrix[eff.id]._none ; reason = 'policy'
3. 짐작이면 내리기만:  lvl==='up' → 'normal' ;  lvl==='hide' && !hideOnGuess → 'down'
4. 약한 힌트:          ctxR.source==='hint' && lvl==='hide' → 'down'
5. 걸어 둔 상태:       !eff.guessed && atModeMatches(task.atMode, eff.id) && task.atMode!=='pause' → 'up' (reason 'when')
6. 이동 중 폰:         eff.category==='moving' && ST.onPhone(task) && lvl!=='hide' → 'up' (reason 'phone')
7. 올림 — lvl 이 'hide' 또는 'down' 일 때만, 가장 높은 것을 쓴다
   a) presence.shown 에 있음                              → 'normal' ('shown')
   b) status==='in_progress' && startedAt ≥ eff.since     → 'normal' ('started')   // 이 상태에서 시작한 일
   c) 작업 블록이 지금 진행 중이거나 30분 안 시작          → 'normal' ('block')     // 사용자가 잡은 시간
   d) 마감: m = dueAt − now (분, dueTime 없으면 23:59)
      - lvl==='hide' && (m < 0 || dueAt < nextActiveStart(ctx)) → 'down' ('due')   // 한 단계만
      - 0 ≤ m ≤ urgentHours·60                                   → 'normal' ('due_soon')
8. return { level: lvl, reason, breakthrough: d 가 적용됐으면 { dueAt, soon: reason==='due_soon' } : null }
```

- 그 전부터 진행 중이었고 숨김이 된 할 일은 숨긴 채 `parked`로 둔다(카드가 알리고, 다음 업무 상태에서 이어하기).
- 기한이 사흘 지난 업무는 퇴근 뒤 '내림'까지만 올라온다. 보통으로 섞이지 않는다.
- 일정 블록(`kind:'event'`)은 할 일이 아니므로 정책 대상이 아니다. 오늘 일정 칸은 늘 그대로다.

### 7.5 돌파 기준 시각 `ST.nextActiveStart(profile, ctxId, eff, now) → Date`

"평소 리듬대로라면 이 맥락을 다음에 언제 보게 되나"를 계산한다.

```
if (schedule.mode === 'off' || 근무 요일 없음) return now + 12시간
t0 = eff.guessed ? now : (eff.expiresAt || now)        // 명시 상태는 그 상태가 끝나는 때부터 본다
segs = ST.timeline(profile, t0, 8일)                   // §4.3 구간: 하루 시작 · 근무 시작 · 근무 끝 경계
return 첫 seg 중 rawMatrix[seg.id][ctxId] !== 'hide' 인 것의 max(seg.start, t0)   // 짐작 완화 전 원래 표로 판단
       (없으면 t0 + 8일)
```

| 예 (직장인, 근무 월–금 09–18) | 계산 | 결과 |
|---|---|---|
| 금 19:00 명시 `off` (끝: 토 04:00) | 토 04:00–월 04:00 쉬는 날(업무 숨김) → 월 04:00–09:00 출근 전(숨김) → 월 09:00 업무 중(띄움) | **월 09:00** |
| 그때 업무 할 일 마감 토 23:59 | 토 23:59 < 월 09:00 | 보인다(내림) |
| 그때 업무 할 일 마감 월 10:00 | 월 10:00 > 월 09:00 | 숨김 |
| 그때 기한 3일 지난 업무 | m < 0 | 내림 |
| 그때 오늘 21:00 마감 업무 (2시간 뒤) | 0 ≤ m ≤ 180 | 보통 |
| 수 15:00 명시 `off`(일찍 퇴근, 끝: 목 04:00) | 목 04:00–09:00 숨김 → 목 09:00 | 목 09:00. 오늘 17:00 마감 업무는 2시간 뒤라 보통 |
| 시간표 짐작 끔 | now + 12h | 11시간 뒤 마감 → 내림 · 13시간 뒤 → 숨김 |

토요일 04:00부터는 명시 '퇴근'이 끝나고 짐작('쉬는 날')이 되므로 업무 할 일은 숨김이 아니라 내림으로 보인다(시계는 숨기지 않는다). 주말에도 업무를 접고 싶으면 "쉬는 날"이라고 말하거나 묶음 머리의 [쉬는 날로 정하기]를 누른다.

### 7.6 정책 적용 API

```js
ST.applyStatusPolicy(state, tasks, eff, profile, now) → {
  visible: [taskId],      // up 다음 normal (같은 수준 안에서는 입력 순서)
  demoted: [taskId],      // down (입력 순서)
  hidden:  [taskId],      // hide (입력 순서)
  levels:  { taskId: { level, reason, ctx, ctxSource, evidence, breakthrough } },
  reasons: { taskId: '퇴근 상태라 집에서 할 일을 먼저 골랐어요.' }   // 화면용 한 줄 (§8.3 문장)
}
// eff 가 null 이면 { visible: 입력 순서 그대로, demoted:[], hidden:[], levels:{}, reasons:{} }  (I1)

ST.view(state, profile, now) → StatusView | null      // 살아 있는 미완료 할 일 전부에 levelOf 를 계산한다
ST.partitionToday(state, open, view, opts) → Partition // §9.1
ST.current(state, profile, now) → null | { id, label, busy, until, guessed }   // FEATURES_SPEC DN.status.current 의 본체
```

---

## 8. 추천과 자동 제안 통합

### 8.1 `src/core/recommend.js` — `opts.statusView` 주입

`recommend.js`는 상태 모듈을 `require`하지 않는다. 의존성은 그대로 `dates`, `model`이다. 부르는 쪽이 `statusView`(평범한 데이터)를 넘긴다.

```js
// opts: { now, availableMinutes, skipIds, workHours, status?, statusView? }
var sv = opts.statusView || null;          // null 이면 아래 '바뀌는 것' 이 하나도 적용되지 않는다 (I1)
```

| 단계 | sv 없음 | sv 있음 |
|---|---|---|
| 근무 시간 밖 `offHours` | 지금 식(또는 FEATURES_SPEC §3.3의 `SL.isWorkingTime`) | `sv.offHours` (명시 업무 → false, 명시 그 밖 → true, 짐작 → 근무 시간 밖인지) |
| T의 상한 | `whEnd` | `sv.workWindow ? new Date(sv.workWindow.end) : null` — 명시 업무인데 시간표 밖(야근)이면 자르지 않는다 |
| 쓸 수 있는 시간 T | 사용자 > 캘린더 > 모름 | 1) 사용자 값이 늘 먼저<br>2) `sv.rec==='none'` → 모름 + 아래 'quiet'<br>3) `sv.remainMinutes` → `{ availableMinutes: remain, source:'status', until:'status_end' }`<br>4) 그 밖은 캘린더 규칙(위 `offHours`·상한 적용) |
| 제외 | 완료·대기·선행·미루기 | + `sv.levels[id].level === 'hide'` → `excluded.hidden++`, `hiddenIds.push(id)`, `openCount++` |
| 항목 | 지금 모양 | + `levelRank: { up:0, normal:1, down:2 }[level]`, `level`, `ctx` |
| 정렬 키 | `fitGroup, urgency, cont, manual, prio` → dueKey → slack → createdAt → id | **`levelRank`**, fitGroup, urgency, cont, manual, prio → 나머지 같음. `tooLong`도 `levelRank` 먼저 |
| `excluded` | `{ done, waiting, blocked, snoozed }` | + `hidden` |
| 결과 | 지금 모양 | + `hiddenIds` |
| `empty` | no_tasks · time_short · all_excluded · all_skipped | `sv.rec==='none'` → primary·alternatives 없이 **`'quiet'`**(ranked는 계산한다 — 오늘 화면 `extra` 순서에 쓴다) · ranked가 비고 hidden > 0 → **`'all_hidden'`** (판정 순서: quiet → no_tasks → time_short → all_hidden → all_excluded → all_skipped) |
| `context.status` | FEATURES_SPEC §5.4가 넣는 `opts.status || null` | `{ id, label, guessed, category, overlay }` |

**sv가 없으면 항목·결과·`excluded`에 새 키를 하나도 넣지 않는다.** 회귀 테스트는 `deepEqual(recommend(s,{now}), recommend(s,{now, statusView:null}))`로 확인한다.

### 8.2 이유 문장 (상태 이유는 최대 1개, **맨 앞**에 둔다 — `nextCard`가 `reasons.slice(0,2)`만 보이므로)

| 조건 | 문장 |
|---|---|
| `reason==='when'` | ‘퇴근하고’ 하기로 한 일이에요. |
| `reason==='phone'` | 이동 중에 폰으로 할 수 있는 일이에요. |
| `breakthrough.soon` | ‘업무’ 할 일이지만 19:00 마감이라 골랐어요. |
| `breakthrough` (내림) | ‘업무’ 할 일이지만 내일 09:00 마감이라 남겨 뒀어요. |
| `level==='up'`, 명시 | 지금은 ‘퇴근 · 내 시간’이라 집에서 할 일을 먼저 골랐어요. |
| primary가 `down` | ‘업무 중’이라 뒤로 둔 일이지만 지금 할 수 있는 다른 일이 없어요. |
| 덧씌움 남은 시간 | 휴식이 12분 남아서 그 안에 끝나는 일을 골랐어요. |
| 짐작 | (앞 문장 뒤에) 시간표로 보면 지금은 근무 시간이에요. |

새 문장은 v2 말투(-어요)다. 기존 문장(-습니다)의 말투 통일은 테스트 문자열이 바뀌므로 이 작업에서 하지 않는다.

### 8.3 부르는 곳 (`renderer/assistant.js`, FEATURES_SPEC `recpanel.js`)

```js
function next(skip) {
  var sv = DN.status ? DN.status.view(now()) : null;
  var r = R.recommend(S.state, { now: now(), skipIds: skip || [], workHours: S.state.prefs.workHours, statusView: sv });
  if (r.primary) { post({ kind: 'next', …, statusLabel: sv ? sv.label + (sv.guessed ? ' · 시간표 기준' : '') : null }); return r; }
  if (r.empty === 'quiet')      { post({ kind: 'text', text: sv.label + '이라 추천은 쉬어요. 끝나면 다시 골라 드릴게요.' }); return r; }
  if (r.empty === 'all_hidden') { post({ kind: 'text', text: '지금(' + sv.label + ')은 할 만한 일이 없어요. 쉬어도 돼요.', actions: ['showHidden'] }); return r; }
  … 기존 분기 그대로
}
```

- `nextCard` 머리에 `m.statusLabel`이 있으면 한 줄로 보인다: `퇴근 · 내 시간 기준`.
- 액션 `'showHidden'`은 [접어 둔 일 보기] 버튼이다. 오늘 화면의 숨긴 줄을 펼친다(`DN.views.today.showHidden()`).
- FEATURES_SPEC의 추천 패널(`recpanel.js`)도 같은 `statusView`를 넘긴다. CTA는 `DN.status.current(now).busy`이면 숨긴다(§5.6 그대로).

### 8.4 자동 제안·휴식 타이머

| 곳 | 바꿀 것 |
|---|---|
| `assistant.js:183` `tryNudge` | `sv && !sv.nudges`이면 돌아간다(덧씌움 전부·잘 시간). `AS.nextNudge(state, { …, statusView: sv })` |
| `assist.js:179` `nextNudge` | `ctx.statusView`를 `looksIdle`·`pendingBreakdowns`·`elaborateCandidates`에 넘긴다 |
| `assist.js:170` `looksIdle(state, now, sv)` | `R.recommend(state, { now, workHours: state.prefs && state.prefs.workHours, statusView: sv })` — `workHours` 빠진 버그도 함께 고친다 |
| `assist.js:142` `elaborateCandidates(state, now, sv)`, `:157` `pendingBreakdowns(state, now, sv)` | `sv.levels[id].level`이 `hide`·`down`인 할 일을 뺀다. 퇴근 뒤에 "보고서를 작게 나눠 볼까요?"가 나오지 않게 한다 |
| `assistant.js:84` `pickTaskToBreak` | 같은 필터 |
| `assistant.js:169` `startTimer` | 기능이 켜져 있고 바탕이 업무 범주이며 지금 덧씌움이 아니면 `DN.status.set({ id:'break', until: end }, { source:'rest', quiet:true })`(카드 없음). 이미 `break`면 `until`만 `end`로 바꾼다 |
| `assistant.js:174` `finishTimer` | 지금 `break`이고 `source==='rest'`이면 `settle`로 바탕에 돌아간다. 메시지는 기존 "휴식 끝!" 하나만 |

타이머는 `Date.now()`를 쓰고 상태는 `DN.app.now()`를 쓴다. 휴식의 `until`은 `timerEnd` 값을 그대로 쓴다(고정 시계 스크린샷에서 어긋나지 않게).

### 8.5 그 밖

- `checkStartable`은 바꾸지 않는다. 숨긴 할 일도 시작할 수 있다(I5). 시작하면 `startedAt ≥ since`가 되어 보통으로 올라온다.
- `slots.freeNow(…, { status: DN.status.current(now) })`는 `busy`만 본다(FEATURES_SPEC §2.5 그대로).

---

## 9. 오늘 화면 (`renderer/views/today.js`)

### 9.1 나누기 `ST.partitionToday(state, open, view, opts) → Partition`

```js
// open: todayTaskList(st, now).open (지금 정렬 그대로), opts.rankedIds: recommend(…statusView).ranked 의 taskId 순서
{ when:   [taskId],   // 걸어 둔 상태가 맞는 할 일 (오늘 목록 안 + 밖, 추천 순, 최대 5)  — 명시 상태일 때만
  up:     [taskId],   // open 중 띄움
  normal: [taskId],   // open 중 보통
  extra:  [taskId],   // 오늘 목록 밖의 띄움 할 일 (when 제외, 제외 사유 없는 것, 추천 순, 최대 5) — 명시 상태일 때만
  down:   [taskId],   // open 중 내림
  hidden: [taskId],   // open 중 숨김
  summary: { hidden: 5, byCtx: { work: 4, study: 1 }, parked: 1, guessedDown: bool } }

// view 가 null 이면 { when:[], up:[], normal: open, extra:[], down:[], hidden:[], summary:null }  → 지금 화면과 같은 마크업 (I1)
```

- 각 묶음 안의 순서는 입력(`open`, 지금 정렬: `sortOrder` → 진행 중 → 기한 지남 → 오늘 마감 → …)을 그대로 따른다.
- `extra`는 판정의 "필수 이식"이다. 날짜 없이 어제 만든 "빨래 돌리기"는 `todayTaskList` 조건에 들지 않아 지금은 오늘 목록에 아예 없다. 퇴근 뒤에는 이 묶음으로 올라온다.
- 짐작 상태에서는 `when`·`extra`가 늘 비어 있다(짐작은 띄우지 않는다).
- 덧씌움 중에는 바탕 상태로 나눈다(목록이 흔들리지 않는다).

### 9.2 퇴근 직후 화면 (데스크톱, 금 18:42, 샘플 + 직접 만든 할 일)

```
┌ 적어 두기 ───────────────────────────┐┌ 오늘  10월 9일 (금)                  [● 퇴근 · 내 시간 ▾] ┐
│                         ┌─────────┐  ││ 할 일                                           남은 6개 │
│                         │ 퇴근!    │  ││ ★ 퇴근하고 하기로 한 일                                   │
│                         └─────────┘  ││   ○ 우유 사기                                  밖 볼일 │
│ ┌ 퇴근 · 내 시간으로 바꿨어요 · 18:42 ┐ ││ ○ 분리수거                                    마감 오늘 │
│ │ 수고했어요. 업무 할 일 5개는 출근하면 │ ││ ○ 엄마 생신 선물 주문                    마감 10월 10일 (토) │
│ │ 다시 보여 드릴게요.                  │ ││ ── 지금 하기 좋은 일 ────────────────────────────────── │
│ │ 하던 ‘세미나 발표 자료 목차 잡기’는   │ ││ ○ 빨래 돌리기                                   약 15분 │
│ │ 출근하면 맨 위에 둘게요. [멈춰 두기]   │ ││ ○ 헬스 등록 알아보기                                     │
│ │ 지금 하기 좋은 일: ‘빨래 돌리기’ · 15분│ ││ ▾ 지금은 뒤로 미룬 일 1개                                │
│ │ [지금 시작]          [이전 상태로]    │ ││   ○ 멘토 배정 기준 초안 작성  [업무 ▾]  기한 지남 · 18:00 │
│ └──────────────────────────────────┘ ││ 업무 할 일 5개 숨김 (하던 일 1) · 보기                    │
│ [다음 할 일] [작게 나누기] [휴식]       ││ ✓ 리포트 목차 확정 (완료)                                │
│ ┌──────────────────────────────────┐ │├ 메모 … (그대로) ──────────────────────────────────────┤
│ │ 생각나는 걸 그냥 적어 보세요…         │ │├ 오늘 일정 (그대로) ────────────────────────────────────┤
└──────────────────────────────────────┘└──────────────────────────────────────────────────────┘
```

### 9.3 묶음과 행

| 묶음 | 머리 | 행 | 끌기 |
|---|---|---|---|
| when | `★ 퇴근하고 하기로 한 일` (work: 출근하면 하기로 한 일 · out: 나간 김에 할 일 · rest: 쉬는 날 하기로 한 일) | 기존 `taskRow` + 맥락 칩 | 묶음 안에서만 |
| up + normal | 없음(지금 목록 자리) | 기존 `taskRow`. 맥락 칩 없음(이미 맞는 맥락이라 소음) | 묶음 안에서만(up·normal은 한 묶음) |
| extra | `지금 하기 좋은 일` (`title`: "오늘 목록에는 없지만 지금 상태에 맞는 일이에요") | 기존 행 + 소요 시간 칩 | 없음 |
| down | `▾ 지금은 뒤로 미룬 일 N개` (펼침·접힘은 모듈 메모리 `mem.downOpen`, 기본 펼침)<br>짐작 때: `시간표로 보면 지금은 ‘퇴근 후’라 뒤로 미룬 일 N개 · [퇴근으로 정하기]`(→ `ST.confirmGuess`) | 제목 `--text-secondary` + 맥락 칩 + 돌파 칩(`기한 지남`·`마감 19:00`) | 묶음 안에서만 |
| hidden | 접은 한 줄(§9.4) | [보기]로 펼치면 내림과 같은 모양 | 없음 |
| done | (지금처럼 맨 아래) | 그대로 | 없음 |

**끌기 저장**: 묶음마다 `ul`과 `sortable`을 따로 둔다. 놓을 때 `[when, up+normal, down]`을 이은 **전체 순서**에서 끈 묶음만 새 순서로 바꾸고, 전체를 `(i+1)*10`으로 다시 매긴다(`ST.joinOrder(groups, key, newIds)`). 묶음 사이에 같은 `sortOrder` 값이 생기지 않는다. 라벨은 지금과 같은 '할 일 순서 바꾸기'다. 다른 묶음의 일을 앞으로 당기고 싶으면 [지금 시작]이나 맥락 칩을 쓴다.

### 9.4 숨긴 줄 (정확한 문구)

```
업무 할 일 5개 숨김 · 보기                           (맥락 하나)
업무 할 일 4개 · 공부 1개 숨김 · 보기                 (맥락 여럿 — 많은 순)
업무 할 일 5개 숨김 (하던 일 1) · 보기                 (parked 가 있을 때)
```

- `div.hidden-line[role=group]` > 글 + `button.link-btn '보기'`(`aria-expanded`, `aria-label="업무 할 일 5개 보기 (지금은 숨김)"`).
- 펼친 상태는 모듈 메모리(`mem.showHidden`)에만 두고 저장하지 않는다. 바탕 상태가 바뀌면 다시 접는다.
- 펼친 행을 누르면 `A.openTask(id)`와 함께 `ST.markShown`을 한다(라벨 없는 silent mutate). 그 할 일은 이 상태 동안 보통으로 보인다.
- 폰 상단 줄의 짧은 글: `업무 5 숨김`.

### 9.5 빈 상태와 잘 시간

| 경우 | 할 일 칸 |
|---|---|
| 모두 숨김 | `퇴근 시간이에요. 지금 할 일은 없어요 — 푹 쉬어요.` + 숨긴 줄 |
| 잘 시간 | `내일 첫 일정 10:00 ‘팀 회의’ · 내일 마감 ‘견적서 보내기’ 외 1개` + `button.link-btn '그래도 보기'`(펼치면 내림 모양으로 전부) |
| 기능 켜기 전 | 지금 문구 그대로 |

### 9.6 숫자

- 오늘 칸 머리의 "남은 N개" = when + up + normal + down(`extra`·숨김은 빼고 센다).
- 사이드바 '오늘' 숫자(`app.js:57`)는 지금 식(마감 ≤ 오늘)에서 `view.levels[id].level === 'hide'`인 할 일을 뺀다. 집에서 업무 숫자가 신경 쓰이지 않게 한다.
- 할 일 화면(`tasks.js`)·캘린더·검색은 거르지 않는다(I3).

---

## 10. UI

### 10.1 상태 칩

| 폭 | 위치 | 이유 |
|---|---|---|
| > 860px | 오늘 머리줄 오른쪽: `.home-today-head` 안, 날짜 뒤(`margin-left:auto`) | 바꾸면 바로 아래 목록이 바뀐다. 원인과 결과가 한자리에 있다 |
| ≤ 860px (홈이 세로로 쌓임, 폰 포함) | 홈 맨 위의 얇은 고정 줄 `div.home-status`(sticky): `[● 퇴근 · 내 시간 ▾]  업무 5 숨김` | 좁은 화면에서는 오늘 목록이 첫 화면 아래에 있다. 상태와 숨긴 수를 맨 위에서 보여 준다 |
| 그 밖의 화면·빠른 메모 창 | 없음 | v1 범위(결정 14). 바꾸기는 Ctrl+K·`/상태`·말로 |

두 자리를 같은 함수 `DN.status.chip()`이 그리고, 미디어 쿼리로 한쪽만 보인다.

**모양** (`button.status-chip.st-<범주>`, 높이 28 · 좁은 화면 36)

| 경우 | 보이는 것 |
|---|---|
| 기능 켜기 전 | `button.status-chip.is-unset` 흐린 점선 `상태 정하기 ▾` |
| 명시 | 실선, 점 색 = 범주. `퇴근 · 내 시간` (사용자 말: `야근`, `재택`, `반차`) |
| 짐작 | 점선(`is-guess`, `chip-guess`와 같은 선) + ` · 시간표 기준` |
| 덧씌움 | `점심 · 13:00까지` (바탕은 `title`: "끝나면 ‘업무 중’으로 돌아가요"). 남은 시간을 매초 그리지 않는다. 60초 tick이면 충분하다 |

- 점 색: work `--primary`, life `--secondary`, rest `--success`, moving `--kind-event`, overlay `--warning`, sleep·none `--text-tertiary`.
- 속성: `aria-haspopup="menu"`, `aria-label="지금 상태: 퇴근 · 내 시간 — 바꾸기"`, `data-focus-key="presence-chip"`.

### 10.2 빠르게 바꾸기 (칩 → `ui.menu`, `className:'cap-menu'`)

```
지금 어떤 시간인가요?                      ← 머리 (label 만)
● 업무 중                             ✓     ← 메뉴 상태 (프리셋 menu, ≤ 7)
○ 점심                              60분
○ 휴식                              15분
○ 퇴근길
○ 퇴근 · 내 시간
○ 외출 중
○ 쉬는 날
───────────────
시간표대로 (자동)        지금은 ‘업무 중’     ← ST.toGuess
모두 보기 (상태 없이)                        ← none
이전 상태로 (‘업무 중’)                       ← log 가 있을 때만, ST.revert
───────────────
현재 상태 설정…                              ← A.go('settings') 후 #set-status 로 스크롤
```

- 덧씌움은 기본 분으로 바로 적용한다. 덧씌움 중에 칩 메뉴를 열면 맨 위에 `5분 더` · `15분 더` · `지금 복귀`가 먼저 나온다.
- 고르면 `DN.status.set({ id }, { source:'menu' })` → 토스트(§10.4). 홈이 보이는 중이면 흐름에 상태 카드도 붙인다.
- Ctrl+K(`palette.js:29` `commands()`)에 '상태' 그룹을 둔다.
  - 메뉴 상태마다 `{ group:'상태', icon, label:'상태: 퇴근 · 내 시간', checked: 지금, words: 라벨 + 사전 말(퇴근 칼퇴 ㅌㄱ off …), run }`.
  - `상태: 시간표대로`, `상태: 이전 상태로`, `현재 상태 설정 열기`도 넣는다.
  - 빈 질의에서도 '명령' 그룹 바로 뒤에 지금 상태 하나가 `checked`로 보인다.
- `/상태` → §5.10. 말로 → §5.

### 10.3 상태 카드 (흐름 `kind:'status'` — `chat.js` `message()`에 `if (m.kind === 'status') return DN.status.card(m, st, now)`)

해당될 때만 줄을 더한다. 숫자와 제목은 그릴 때 계산한다.

| 바뀜 | 카드 문구 | 버튼 |
|---|---|---|
| → 업무 범주 | `‘업무 중’으로 바꿨어요.` · (resume) `어제 하던 ‘분기 보고서’부터 이어서 할까요?` · (걸어 둔 일) `출근하면 하기로 한 일: 메일 확인` · (추천) `지금 하기 좋은 일: ‘견적서 보내기’ · 약 20분` | [이어하기] [지금 시작] [이전 상태로] |
| → 퇴근 | `퇴근 · 내 시간으로 바꿨어요. 수고했어요.` · (숨김>0) `업무 할 일 5개는 출근하면 다시 보여 드릴게요.` · (돌파) `‘견적서 보내기’는 내일 09:00 마감이라 남겨 뒀어요.` · (parked) `하던 ‘분기 보고서’는 출근하면 맨 위에 둘게요.` · (걸어 둔 일) `퇴근하고 하기로 한 일: 우유 사기 · 빨래 돌리기` · (추천) `지금 하기 좋은 일: ‘빨래 돌리기’ · 15분` | [지금 시작] [멈춰 두기]¹ [이전 상태로] |
| → 퇴근길·출근길 | `퇴근길이에요. 전화·이체처럼 폰으로 할 수 있는 일을 위로 올렸어요.` + 폰 할 일 3개 | [이전 상태로] |
| → 외출 | `밖에 있는 김에: 우유 사기 · 우체국 들르기` | [이전 상태로] |
| → 쉬는 날 | `오늘은 쉬는 날로 둘게요. 업무 할 일 N개는 접어 뒀어요.` + 추천 1개 | [지금 시작] [이전 상태로] |
| → 휴식 | `15분 쉬어요 · 15:45에 ‘업무 중’으로 돌아갈게요.` · (pause 걸어 둔 일) `쉬는 시간에 하기로 한 일: …` | [스트레칭 보기]² [5분 더] [지금 복귀] |
| → 식사 | `점심 맛있게 드세요 · 13:00에 돌아갈게요.` · `점심 때 하기로 한 일: 은행 들르기` | [지금 복귀] |
| → 회의·수업·운동 | `회의 중엔 추천과 알림을 쉬어요 · 11:00에 돌아갈게요.` | [30분 더] [지금 복귀] |
| → 운전 | `운전 중엔 아무것도 띄우지 않아요. 안전 운전하세요.` | [지금 복귀] |
| → 집중 | `50분 집중해요 · 알림을 멈췄어요.` | [지금 복귀] |
| → 잘 시간 | `푹 자요. 내일 첫 일정은 10:00 ‘팀 회의’예요.` | – |
| → 모두 보기 | `상태 없이 모두 보여 드릴게요.` | [시간표대로] |
| 상태만 적은 글(pure) | 위 문구에 더해 | + [메모로 남기기]³ |

¹ [멈춰 두기]: parked 할 일을 `S.mutate('상태 변경', s => M.updateTask(s, id, { status:'todo' }, now))`로 바꾼다. 이것만 할 일 데이터를 바꾸고, Ctrl+Z가 된다.
² [스트레칭 보기]: `AS.rest()`. 그 카드의 타이머를 시작하면 휴식 `until`이 타이머 끝으로 바뀐다(§8.4).
³ [메모로 남기기]: `DN.capture.submit(m.text, null, null, { statusLine: m.text })` → 카드에 `noteId`를 적는다. 버튼은 "메모로 남겼어요"(링크)로 바뀐다.

- 카드 머리에는 시각을 붙인다: `퇴근 · 내 시간으로 바꿨어요 · 18:42`.
- 카드의 상태가 더 이상 지금이 아니면 한 줄 기록으로 접힌다: `18:42–21:10 · 퇴근 · 내 시간` (log로 계산).
- 같은 상태를 다시 말하면 카드를 만들지 않는다(§10.4 토스트).
- 2분 안에 연달아 바꾸면 마지막 카드를 고친다(§4.6).
- `/상태`만 보냈을 때 올리는 `kind:'status-pick'` 카드는 `지금 어떤 시간인가요?` + 메뉴 상태 `button.pill[aria-pressed]` 줄 + [시간표대로]다.

### 10.4 토스트 문구

| 언제 | 문구 | 동작 버튼 |
|---|---|---|
| 칩·메뉴·팔레트로 바꿈 | `‘퇴근 · 내 시간’으로 바꿨어요 · 업무 할 일 5개 숨김` | [이전 상태로] → `DN.status.revert()` (**`S.undo` 아님**) |
| 같은 상태 | `이미 ‘업무 중’이에요` | – |
| 이전 상태로 | `‘업무 중’으로 되돌렸어요` | – |
| Ctrl+N 상태만 | `‘퇴근’으로 바꿨어요 · 메모는 만들지 않았어요` | [이전 상태로] |
| Ctrl+N 섞인 글 | `‘퇴근’으로 바꾸고, 적은 글은 저장했어요` | [오늘에서 보기] |
| 맥락 바꾸기 | `‘견적서 보내기’를 업무로 뒀어요` | [되돌리기] (`ui.undoToast` — 라벨 있는 데이터 변경이라 Ctrl+Z 대상) |
| 낱말을 처음 확실히 배움 | `앞으로 ‘견적서’가 들어간 할 일은 업무로 볼게요` | [되돌리기] |
| 휴식 타이머 끝 | 기존 `5분 휴식이 끝났어요.` | – |

폰(≤640px)에서는 토스트가 아래 탭 막대를 가리는 기존 문제를 함께 고친다(§10.8 CSS).

### 10.5 퇴근하면 눈에 보이게 바뀌는 것 (확인 목록)

1. 칩: `업무 중`(파란 점) → `퇴근 · 내 시간`(초록빛 `--secondary` 점). 좁은 화면에서는 상단 줄 `업무 5 숨김`.
2. 흐름: 내 말풍선 "퇴근!" + 상태 카드(§10.3). 메모 수는 그대로다(상태만 적은 글).
3. 오늘 할 일: 업무가 숨은 줄로 접힌다. 집안일·개인·가족이 위로 오고, 걸어 둔 일(★)과 "지금 하기 좋은 일"이 생긴다. 마감이 가까운 업무는 '뒤로 미룬 일'에 남는다.
4. 사이드바 '오늘' 숫자에서 숨긴 업무가 빠진다.
5. '다음 할 일'이 집 일을 고르고 이유 첫 줄이 상태를 말한다. 머리줄에 `퇴근 · 내 시간 기준`.
6. 자동 제안(작게 나누기·구체화)이 업무 할 일을 고르지 않는다.
7. 메모·오늘 일정 칸, 할 일 화면, 캘린더, 검색은 그대로다.

### 10.6 맥락 칩과 상세 패널

- 결과 카드 할 일 행: `[할 일] 빨래 돌리기 [오늘] [집안일 (추정) ▾] [×]`.
  - 규칙·AI·학습·힌트로 정한 값은 점선 + `(추정)`이다. 사용자·프로젝트가 정한 값은 실선이다.
  - 기능을 켜기 전에는 칩을 보이지 않는다(P-1).
- 메뉴(`ui.menu`): 머리 `어느 쪽 일인가요?` → 맥락 6개(`kind` 대신 `ctx-<id>` 클래스 점) + 사용자 맥락 + `정하지 않음`(checked = 지금 값).
- 상세 패널(`detail.js`)에 두 줄을 더한다.
  - **맥락**: `select` + 이유 한 줄 + 지금 효과 한 줄.
    - 이유: `‘빨래’라는 말로 집안일로 봤어요 · 직접 바꾸면 그대로 둬요` / `AI가 정했어요` / `프로젝트 ‘온보딩 개선’을 따라 업무` / `전에 고친 대로 업무` / `직접 정함`.
    - 지금 효과: `지금(퇴근)은 숨김 · 내일 09:00 마감이라 뒤로 보여요` / `지금(업무 중)은 맨 위`.
  - **언제 할까요**: `상관없음 / 출근하면 / 퇴근하고 / 나가는 김에 / 쉬는 시간에 / 쉬는 날에` (`task.atMode`, `atModeSource:'user'`).
  - 라벨은 `'맥락 바꾸기'`, `'언제 할지 바꾸기'`다. `detail.js:187` `onChange` 정규식에 `맥락|언제 할지`를 더한다(라벨이 동작을 정한다).

### 10.7 폰과 좁은 화면

- `div.home-status`: sticky top, 최소 높이 44px, 배경 `--bg-app`. 칩 높이 36px. 글은 `업무 5 숨김`.
- 칩 메뉴의 항목은 최소 높이 44px이다. 메뉴 폭은 `calc(100vw - 24px)` 이하(기존 `.menu` 규칙)다.
- 맥락 칩(터치 대상)은 ≤640px에서 높이 32px이다.
- 상태 카드 버튼은 한 줄에 다 들어가지 않으면 줄바꿈한다(`flex-wrap`).
- 가로 스크롤 없음(390px에서 `scrollWidth === 390`)을 수용 기준으로 둔다.

### 10.8 접근성·CSS (기존 토큰만, 새 색 없음)

- 상태가 바뀌면 `.toast-wrap`(aria-live=polite)이나 카드로 알린다. 숨긴 줄 버튼은 "업무 할 일 5개 보기 (지금은 숨김)"으로 읽힌다.
- ARIA 불린은 문자열로 준다(`'aria-pressed': on ? 'true' : 'false'`, ui 지도 G2).
- `--kind`·`--st` 같은 지역 변수는 `style:{}`로 넘기면 적용되지 않는다(ui 지도 G1). **반드시 클래스로** 준다.
- 아이콘(`ui.js` `P`에 1.5px 선 아이콘 추가): `briefcase home bag user heart book coffee moon walk train leaf`.

```css
.status-chip { display:inline-flex; align-items:center; gap:6px; height:28px; padding:0 10px; margin-left:auto;
  border:1px solid var(--border-deco); border-radius:var(--r-pill); background:var(--surface); color:var(--text-primary);
  font-size:13px; font-weight:500; cursor:pointer; }
.status-chip:hover { border-color:var(--border-strong); }
.status-chip .st-dot { width:8px; height:8px; border-radius:50%; background:var(--st, var(--text-tertiary)); }
.status-chip.is-guess, .status-chip.is-unset { border-style:dashed; color:var(--text-secondary); }
.status-chip.is-unset { color:var(--text-tertiary); }
.st-work{--st:var(--primary)} .st-life{--st:var(--secondary)} .st-rest{--st:var(--success)}
.st-moving{--st:var(--kind-event)} .st-overlay{--st:var(--warning)} .st-sleep,.st-none{--st:var(--text-tertiary)}
.ctx-work     { --kind:var(--kind-task);  --kind-soft:var(--kind-task-soft);  --kind-ink:var(--kind-task-ink); }
.ctx-home     { --kind:var(--success);    --kind-soft:var(--success-soft);    --kind-ink:var(--success-ink); }
.ctx-errand   { --kind:var(--kind-event); --kind-soft:var(--kind-event-soft); --kind-ink:var(--kind-event-ink); }
.ctx-personal { --kind:var(--kind-idea);  --kind-soft:var(--kind-idea-soft);  --kind-ink:var(--kind-idea-ink); }
.ctx-family   { --kind:var(--secondary);  --kind-soft:var(--secondary-soft);  --kind-ink:var(--secondary); }
.ctx-study    { --kind:var(--kind-link);  --kind-soft:var(--kind-link-soft);  --kind-ink:var(--kind-link-ink); }
.ctx-custom   { --kind:var(--text-tertiary); --kind-soft:var(--surface-subtle); --kind-ink:var(--text-secondary); }
.ctx-chip { background:var(--kind-soft); color:var(--kind-ink); }
.ctx-chip.is-guess { background:transparent; border:1px dashed var(--kind); }
.today-group-head { display:flex; align-items:center; gap:6px; margin:10px 0 4px; font-size:12px; font-weight:600; color:var(--text-secondary); }
.home-row.is-dim .home-row-title { color:var(--text-secondary); }
.hidden-line { display:flex; gap:6px; align-items:center; padding:6px 0; font-size:13px; color:var(--text-secondary); border-top:1px solid var(--border-deco); }
.status-nudge { display:flex; gap:8px; align-items:center; font-size:13px; color:var(--text-secondary); padding:4px 0; }
.home-status { display:none; }
@media (max-width: 860px) {
  .home-status { display:flex; align-items:center; gap:8px; position:sticky; top:0; z-index:5; min-height:44px;
                 background:var(--bg-app); grid-column:1 / -1; }
  .home-status .status-chip { height:36px; margin-left:0; }
  .home-today-head .status-chip { display:none; }
}
@media (max-width: 640px) {
  .toast-wrap { bottom: calc(64px + env(safe-area-inset-bottom)); }
  .ctx-chip { min-height:32px; }
}
```

---

## 11. 설정 — "현재 상태" 카드 (`renderer/views/settings.js`)

**위치**: FEATURES_SPEC §4.1 순서에서 **근무 시간 카드 바로 다음**이다(AI 처리 → Daynote가 배운 것 → 근무 시간 → **현재 상태** → 연결 → 데이터 → 화면). FEATURES_SPEC가 아직 없으면 AI 카드 다음에 두고, 근무 시간은 읽기 전용 한 줄("근무 시간: 월–금 09:00–18:00 · 기본값")로 보인다.

```
section.card.settings-card#set-status [aria-labelledby=set-status-h]
  h3#set-status-h  현재 상태
  p.help  ‘퇴근’, ‘점심’처럼 적거나 오늘 화면의 칩을 누르면, 할 일을 그 시간에 맞게 보여 줘요. 숨긴 할 일은 지우지 않아요.
  label.check-row  [✓] 현재 상태 쓰기                                    ← enabled
  div.settings-row [lbl 어떤 하루를 보내세요?]  select  직장인 ▾  (프리랜서·재택 / 학생 / 교대 근무 / 자영업 / 육아·살림 — v1.1 은 '준비 중' 표시)
                   p.help  프리셋 한 줄 설명 ("평일 근무 시간 동안 업무를 위로, 퇴근하면 업무 할 일은 접고 집안일·개인 일을 먼저 보여 줘요.")
  label.check-row  [✓] 근무 시간으로 상태 짐작하기 (내리기만 해요)           ← autoSchedule.mode
       p.help  근무 시간은 위 ‘근무 시간’ 카드를 따라요. 짐작한 상태는 칩에 점선으로 보이고, 할 일을 숨기지는 않아요.
  div.settings-row [lbl 퇴근하면 업무 할 일은]  div.seg  (숨기기 | 아래로 내리기)   ← afterWork
  label.check-row  [✓] 마감이 3시간 안이면 숨기지 않고 보여 주기               ← urgentHours 3 / 0
  label.check-row  [✓] 근무 시간이 한참 지나도 ‘업무 중’이면 한 번 알려 주기     ← overtimeLine
  details.settings-adv > summary  더 고치기
     ▸ 점심 시간 [12:00]–[13:00] (비우면 없음) · 하루가 바뀌는 시각 [04:00]
     ▸ [ ] 시간표 짐작으로도 숨기기                                          ← hideOnGuess
     ▸ 상태 (메뉴에 보일 것, 이름, 알아들을 말, 기본 시간) + [새 상태]
     ▸ 맥락 (이름, 단어 더하기·빼기) + [새 맥락]
     ▸ 상태 × 맥락 표
     ▸ 배운 맥락 보기 → ‘Daynote가 배운 것’ 카드의 ‘할 일 맥락’ 묶음으로 스크롤
```

**저장 규칙**
- 모든 값은 `S.mutate(null, s => { … s.prefs.statusProfile … }, { silent:true })`로 저장하고 DOM은 그 자리에서 고친다(테마 컨트롤 방식). 입력 중인 시각 값과 포커스가 다시 그리기로 날아가지 않게 한다.
- FEATURES_SPEC §4.1의 `onChange` 핸들(`'capture'|'chat'|'today'`면 다시 그리지 않음)에 `'status'`도 더한다.
- 프리셋 바꾸기는 묻지 않고 바로 적용한다. 바뀌는 점 3줄 이하를 카드 안에 보이고 [이전 프리셋으로] 링크를 둔다. 할 일 맥락과 배운 것은 그대로다. 지금 상태 id가 새 프리셋에 없으면 `current = null`(짐작)로 둔다.
- 사용자가 바꾼 칸·말은 프리셋을 바꿔도 남는다(id가 같으면 적용, 없으면 보관). 같은 id를 쓰는 프리셋으로 돌아오면 다시 살아난다.

**상태 편집** (줄마다)
- 아이콘 점, 이름 `input`(≤20자), 알아들을 말(쉼표 입력 → 칩), 덧씌움이면 기본 분 `select`(5·10·15·30·45·60·90), '메뉴에 보이기' 체크.
- 같은 말이 다른 상태에 이미 있으면 저장하지 않고 그 자리에 "‘집 감’은 이미 ‘퇴근’에서 쓰고 있어요"를 보인다.
- [새 상태]가 묻는 것은 네 가지뿐이다.
  - 이름.
  - 성격: 업무 시간 / 내 시간 / 잠깐 쉬기 / 쉬는 날 → category `work / life / overlay / rest`.
  - 장소: 직장 / 집 / 밖 / 이동 중.
  - 알아들을 말.
- 정책 행은 §7.3 공식으로 자동이다. 최대 10개.

**맥락 편집**: 이름, 단어 더하기(3점), 기본 단어 끄기("기본 단어 보기" 펼침), [새 맥락](이름 + 단어, 최대 6). 지우기는 §6.4.

**상태 × 맥락 표**
- 데스크톱: 격자. 행은 덧씌움이 아닌 메뉴 상태(≤8), 열은 맥락(≤12). 칸은 `button`이고 누를 때마다 ▲ 띄움 → ● 보통 → ▼ 내림 → ✕ 숨김 → ▲ 순서로 바뀐다.
  - 스크린리더: "퇴근 · 업무: 숨김. 눌러서 바꾸기".
  - 사용자가 바꾼 칸에는 작은 점과 `title` "직접 바꿈"이 붙는다. 행 끝에 [기본값으로], 표 아래에 [모두 기본값으로]가 있다.
- 폰(≤640px): 위에 상태 `.seg`(가로 스크롤), 아래에 맥락 행마다 4칸 `.seg`(띄움·보통·내림·숨김).
- `afterWork` 칸(퇴근·퇴근길·쉬는 날 × 주 맥락)은 위의 '퇴근하면 업무 할 일은' 선택과 같은 값을 보인다. 표에서 바꾸면 `policy` 덮어쓰기가 이긴다.

---

## 12. 직업 프리셋

### 12.1 데이터 모양 (`statusWords.js` `PRESETS`)

```js
PRESETS.office = {
  label: '직장인', stage: 'v1', primary: ['work'],
  desc: '평일 근무 시간 동안 업무를 위로, 퇴근하면 업무 할 일은 접고 집안일·개인 일을 먼저 보여 줘요.',
  menu: ['work', 'meal', 'break', 'to_home', 'off', 'out', 'day_off'],
  roleMap: {},                                  // 기본 역할 → 상태 (§4.4) 를 고치는 것만
  statuses: {},                                 // 이 프리셋 전용 상태 정의
  matrix: {},                                   // §7.2 표 (공식 결과와 다른 칸만)
  schedule: { mode: 'guess' }, afterWork: 'hide',
  contextLabels: {},                            // 맥락 라벨 바꾸기 (예: student 의 work → '알바')
  words: {},                                    // 이 프리셋에서만 알아듣는 말 (§12.3)
  signals: ['회의', '보고서', '결재', '팀장']     // guessPreset 단어
};
```

### 12.2 프리셋 표

| 프리셋 | 단계 | 주 맥락 | 칩 메뉴 | 시간표 짐작 | 퇴근 후 주 맥락 | 다른 점 |
|---|---|---|---|---|---|---|
| **직장인** `office` (기본) | v1 | 업무 | 업무 중 · 점심 · 휴식 · 퇴근길 · 퇴근 · 외출 · 쉬는 날 | 켬 (근무 시간 카드) | 숨김 | §7.2 표 그대로 |
| **프리랜서·재택** `freelance` | v1 | 업무 | 작업 중(`wfh`, 라벨 '작업 중') · 휴식 · 점심 · 회의·미팅 · 외출 · 일 끝(`off`, 라벨 '일 끝') · 쉬는 날 | **끔**(시간이 들쭉날쭉) | **내림**(마감 중심) | `work_start` → `wfh`. 작업 중에도 집안일은 내림까지만. **휴식 덧씌움 중 '다음 할 일'은 10분 이하 집안일을 먼저**("빨래 돌리기 같은 짧은 집안일은 쉬는 틈에 골라 드려요") |
| **학생** `student` | v1.1 | 공부 (+`work` 라벨 '알바') | 수업 중 · 공부 중(`study`) · 쉬는 시간 · 이동 중 · 알바 중(`part_time`) · 집·자유(`off`) · 잘 시간 | 켬 (근무 시간 카드를 '수업 시간'으로 부름) | 공부 **보통**, 알바 숨김 | 수업 중 추천·알림 없음. 공강(덧씌움 60분)은 공부를 띄움. 공부 중: 공부 띄움, 알바 숨김, 그 밖 내림. 알바 중: 알바 띄움, 그 밖 내림 |
| **교대 근무** `shift` (간호·생산·보안) | v1.1 | 업무 (라벨 '근무') | 근무 중 · 휴게 · 퇴근 · 오프·비번(`day_off`) · 잘 시간 | **끔** (근무표는 v2) | 숨김 | 데이·이브닝·나이트를 라벨로 살린다. 업무 상태는 16시간 낡음 규칙만 써서 자정을 넘는다. 낮에 자는 동안 알림 없음. 평일 오프면 밖 볼일 띄움("은행·관공서 가기 좋은 날") |
| **자영업** `shop` (식당·카페·매장) | v1.1 | 업무 (라벨 '가게 일') | 오픈 준비 · 영업 중 · 브레이크 · 마감 정리 · 영업 끝 · 휴무 | 켬 (근무 시간 카드를 '영업 시간'으로 부름) | 숨김 (휴무에는 **내림** — 쉬는 날에도 가게 일은 본다) | 영업 중: 추천은 10분 이하, 자동 제안 끔. "한가해/손님 없음" → 바로 추천. "바빠" → 30분 조용히(덧씌움 `busy`). 오픈 준비: 밖 볼일 띄움(재료 장보기). 사전에 발주·재고·도매·리뷰 답글·배달앱을 업무 강(3)으로 더함 |
| **육아·살림** `home` | v1.1 | 집안일 + 가족 (`work`는 부업, 기본 보통) | 아이와 함께(`kids`) · 혼자 시간(`me`) · 아기 낮잠(`nap` 덧씌움 60) · 장보기·외출 · 쉬는 중 · 잘 시간 | 선택 (근무 시간 카드를 '등원–하원'으로 부름 → 그 사이 '혼자 시간' 짐작) | (업무 = 부업, 보통) | 아이와 함께: 추천 10분 이하, 알림 끔, 가족 띄움. 혼자 시간: 집안일·밖 볼일 띄움. 낮잠: 40분 이하 집안일·개인 추천. 육퇴(`me`, 라벨 '내 시간'): 집안일 **내림**, 개인 띄움, 말투 "내일 해도 괜찮아요" |
| 크리에이터 `creator` (선택) | v2 | 업무 (라벨 '제작') | 작업 중 · 집중(90분) · 회의·소통 · 휴식 · 작업 끝 · 쉬는 날 | 끔 | 숨김 | 집중: 업무만 띄움, 나머지 숨김, 기한 지난 것만 돌파 |

- **프리셋을 묻지 않는다.** 처음에는 직장인으로 시작한다. 말 사전이 공통이라, 학생이 "수업 들어감"이라고 하면 직장인 프리셋에서도 수업 덧씌움으로 알아듣는다.
- **같은 말, 다른 뜻**은 프리셋 전용 말로만 처리한다(§12.3). 공통 사전에는 뜻이 하나인 말만 둔다.

### 12.3 프리셋 전용 말 (그 프리셋일 때만 상태. 다른 프리셋에서는 `ST.presetSignal`로만 센다)

| 프리셋 | 말 → 역할·상태 |
|---|---|
| shift | 데이·이브닝·이브·나이트 (+출근) → `work_start`(라벨 그 말) · 인계 끝, 나이트 끝, 데이 끝 → `work_end` · 오프, 비번 → `day_off` |
| shop | 오픈, 가게 오픈, 문 열었어, 영업 시작, 장사 시작 → 영업 중 · 오픈 준비 → 오픈 준비 · 브레이크, 브레이크 타임 → `break` · 마감 시작, 마감 정리 → 마감 정리 · 마감했어, 문 닫았어, 영업 끝, 장사 끝, 가게 마감 → 영업 끝 · 정기휴무, 오늘 휴무 → `day_off` · 손님 없음 → `idle` · 바빠, 손님 많아, 정신없어 → `busy` 30분 |
| student | 공강 → 공강 덧씌움 · 도서관 도착, 독서실 왔어, 스터디카페 도착, 공부 시작 → 공부 중 · 알바 출근 → 알바 중 |
| home | 등원 완료, 등원시켰어, 어린이집 보냄 → 혼자 시간 · 하원, 하원 완료, 애들 왔어 → 아이와 함께 · 아기 낮잠, 낮잠 재웠어 → 낮잠 · 애들 재웠어, 재웠다, 육퇴 → 내 시간 |
| creator | 스탠드업, 라이브 시작 → `meeting` · 딥워크 → `focus` · 촬영 나감 → `out` |

### 12.4 프리셋 제안 (P1 "3번 들으면 한 번" + P3 `guessPreset`로 씨앗)

- `ST.presetSignal(text, profile)`가 다른 프리셋의 전용 말을 찾으면 `hints.presetSeen[preset]`에 시각을 넣는다(14일보다 오래된 것은 버린다).
- **씨앗**: 처음 켤 때(`activatedAt`이 생기는 순간) `g = ST.guessPreset(state)`를 계산한다. `g`가 있고 지금 프리셋과 다르면 `presetSeen[g] = [now]`로 한 번 센 것으로 친다.
  - `ST.guessPreset(state) → presetId|null`: 살아 있는 할 일·메모 제목에서 프리셋 `signals`를 센다. 가장 많은 프리셋이 3번 이상이고 2등보다 2 이상 많을 때만 돌려준다. 자동 적용은 절대 하지 않는다.
- 14일 안에 3번이 되고, 그 프리셋을 제안한 적이 없고, 오늘 예산이 남았으면 흐름에 한 줄을 올린다. 프리셋마다 평생 1번이다.
  - 예: `가게를 운영하시나 봐요. ‘자영업’ 리듬으로 맞추면 영업 중엔 짧은 일만 골라 드려요. [맞추기] [괜찮아요]`
- v1.1 전에는 제안할 프리셋이 직장인·프리랜서뿐이다. 나머지 신호는 세어 두기만 한다(켜지면 바로 쓸 수 있게).

| 신호 단어 (`signals`) | 추천 프리셋 |
|---|---|
| 과제, 시험, 강의, 레포트, 중간고사 | student |
| 등원, 하원, 어린이집, 이유식, 기저귀 | home |
| 발주, 매장, 손님, 영업, 재고 | shop |
| 데이, 나이트, 오프, 인계, 근무표 | shift |
| 클라이언트, 견적, 인보이스 (회사·팀장 단어 없음) | freelance |
| 회의, 보고서, 결재, 팀장 | office |

---

## 13. 자동 제안 — 잔소리 예산

| 무엇 | 언제 | 어디에 | 빈도 |
|---|---|---|---|
| 시간표 짐작 | 명시 상태가 없거나 낡았을 때 | 칩이 점선이 됨. 문장 없음 | 항상 (질문이 아님, 예산 안 씀) |
| 근무 시간이 지났어요 | 명시 업무 범주 + 짐작은 업무가 아님 + 근무 끝 + 90분 지남 + 홈이 보임 + 타이핑 중 아님 | 오늘 머리줄 아래 한 줄 `div.status-nudge`: `근무 시간이 지났어요 · [퇴근으로 바꾸기] · [닫기]` | 하루 1번. 2번 닫으면 다시 안 띄움(`overtimeDismiss`). `overtimeLine:false`면 없음 |
| 애매한 말 제안 칩 | 감지가 maybe | 결과 카드 아래: `상태를 ‘커피’로 바꿀까요? [바꾸기] [아니요]` | 예산 안에서 |
| AI가 찾은 상태 제안 | 규칙이 놓친 상태 보고(§14) | 같음, `AI가 ‘퇴근’으로 봤어요 · [바꾸기]` | 예산 안에서 |
| 프리셋 맞추기 | §12.4 | 흐름 한 줄 | 프리셋마다 평생 1번 + 예산 |

- 상태 관련 제안은 모두 합쳐 **하루 1번까지**다(`hints.day`/`used`, 하루 시작 기준). `ST.budgetOk(state, now)`, `ST.useBudget(state, now)`.
- 타이핑 중, 일정(event) 중, 덧씌움 중, 잘 시간에는 먼저 띄우지 않는다. 결과 카드 제안 칩은 사용자가 방금 적은 글에 붙는 것이라 예외다(예산은 쓴다).
- **상태를 안 바꿨다고 묻는 일은 절대 없다**("아직 업무 중이세요?"). 경계마다 묻는 일(P2안의 suggest 모드)과 시계로 숨기기(P3안의 자동 30분 유예)도 없다.
- [바꾸기] → `DN.status.set({ id, label }, { source:'hint' })`. `statusHint.resolved = 'applied'`. [아니요] → `'dismissed'`. 둘 다 라벨 없는 mutate다.
- (선택, v1.1) 처음 알게 하는 한 줄: 평일 18시 이후, 오늘 목록에 업무와 집안일·개인이 섞여 있고, 기능을 한 번도 쓰지 않았다면 평생 1번 `‘퇴근’이라고 적으면 업무 할 일은 접고 집안일을 먼저 보여 드려요. [퇴근으로 바꾸기] [괜찮아요]`.

---

## 14. AI 캡처 통합 (`capture.v7`)

**버전**: ADAPTIVE_PLAN이 같은 릴리스에 `capture.v7`(규칙 J)을 쓰면 **하나의 v7로 합친다**. 먼저 들어가는 쪽이 v7, 나중 쪽이 v8이다. 이 설계의 규칙 글자는 J와 겹치지 않게 **K·L·M**을 쓴다. `test/capture-v3.test.js:38`의 버전 assert도 함께 고친다.

**입력** (`C.buildInput(note, opts)` 뒤에 더한다 — `O.buildInput`은 아는 필드만 옮기므로)

```js
input.contexts    = (opts.contexts || []).map(c => ({ id: c.id, label: c.label, hint: c.hint }));  // hint: 대표 단어 6개 '빨래·설거지·분리수거…'
input.presenceNow = opts.presenceNow || null;   // 지금 상태 라벨 하나만 ('퇴근 · 내 시간'). 기능을 켜기 전이면 null. **기록(log)은 절대 보내지 않는다**
input.statusLine  = opts.statusLine || null;    // 섞인 글의 상태 문장
```

`userText`는 `<context>` 끝에 다음을 더한다.
- `맥락 목록: work=업무(회의·보고서·견적…), home=집안일(빨래·설거지…), …`
- `지금 상태: 퇴근 · 내 시간`
- `상태 보고 줄(앱이 이미 처리함 — 할 일로 만들지 말 것): ‘퇴근!’`

설정 AI 카드의 '전송 범위' 문단에 "맥락 이름 목록과 지금 상태 이름"을 더한다.

**출력 스키마** (모든 속성 required, `additionalProperties:false`, 엄격성 walker 통과)

```
tasks[].context: string | null                                        // 맥락 id 만. 모르면 null
tasks[].do_in:   'work' | 'off' | 'out' | 'pause' | 'rest' | 'none'    // 걸어 둔 상태
presence: { role: 'work_start'|'work_end'|'commute_in'|'commute_out'|'break'|'meal'|'out'|'field'|'meeting'
                  |'focus'|'class'|'drive'|'exercise'|'day_off'|'sleep'|'none',
            quote: string | null }
```

**SYSTEM 규칙**
```
K. 상태 보고: "퇴근", "점심 먹으러 감", "출근했어"처럼 사용자가 지금 자기 상태(출근·퇴근·휴식·외출·잠)를 알리는 말은 할 일·일정·완료 보고가 아닙니다.
   <context> 의 "상태 보고 줄" 은 앱이 이미 처리했으니 그 줄로 tasks·events·done_tasks·updated_tasks 를 만들지 마세요.
   presence: 상태 보고 줄이 없는데 글에 사용자 본인의 '지금' 상태 변화가 분명하면 role 과 근거 quote(원문 그대로)를, 아니면 role "none", quote null.
   다른 사람의 상태, 미래·바람·질문("퇴근하고 싶다", "언제 퇴근하지")은 none 입니다.
L. 맥락: tasks 마다 context 를 <context> 의 맥락 id 중 하나로 고릅니다. 분명하지 않으면 null. 업무로 단정하지 마세요.
M. 걸어 둔 상태(do_in): "퇴근하고·퇴근 후·집에 가서" → off, "출근하면·회사 가서" → work, "나가는 김에·가는 길에" → out,
   "점심 때·쉬는 시간에" → pause, "쉬는 날에" → rest. 그 표현은 제목에서 뺍니다. "주말에" 는 날짜이므로 due 로 다룹니다. 없으면 "none".
```

**검증** (`validate.js`)
- `context`가 목록에 없는 id면 `null`이다.
- `do_in`은 근거 `quote`에 `ST.findAtMode(quote) === do_in`일 때만 인정하고, 아니면 `none`이다(지어내지 않음, UX 원칙 4).
- `presence`: `role`이 enum에 없거나, `quote`가 원문에서 `locate`되지 않거나, `input.statusLine`이 있으면 버린다.
- 검증된 값은 할 일 항목에 `item.context`, `item.atMode = { mode, phrase }`로 싣는다. `mergeOrganizeRun`이 `payload.context`, `payload.atMode`로 옮긴다.

**적용**
- `applySelections`(`proposals.js:248`): 할 일을 만든 뒤 다음을 한다.
  - 근거 문장에 `#태그`(§6.5)가 있으면 `context`·`contextSource:'user'`로 두고 제목에서 태그를 뗀다. 사용자 태그가 AI를 이긴다.
  - 아니면 `payload.context`가 있을 때 `context`·`contextSource:'ai'`로 둔다.
  - `payload.atMode`가 있으면 `atMode`·`atModeSource:'ai'`로 둔다. 제목 맨 앞에 표현이 남아 있으면 `ST.extractAtMode`로 한 번 더 뗀다(그때 AI 값이 없으면 `atModeSource:'rule'`).
- 늦게 온 결과: `applyCapture`는 `changedByUser`이면 이미 돌아간다. FEATURES_SPEC의 `refineForced`(명령어 글 AI 다듬기)는 `contextSource === 'user'`인 할 일의 맥락을 바꾸지 않는다.
- `applyCapture`: 검증된 `presence`가 있고, `capture.statusLine`·`capture.statusHint`가 없고, `ST.isActive(state)`이고, `ST.budgetOk`이면 `capture.statusHint = { from:'ai', role, id: resolveRole(...), label, quote, at }`로 두고 `useBudget`한다. **AI는 상태를 바꾸지 않는다. 제안만 한다.**

**가짜 AI** (`fake.js` `classifyCapture`) — 웹 데모에서도 같은 동작을 보이게 한다.
- `input.statusLine`이 있으면 줄마다 그 문장을 빼고 판단한다. 그래서 '퇴근'이 할 일이 되지 않는다. 근거 quote는 남은 부분이고 원문 줄 안에 있으므로 `locate`된다.
- 한 줄 분기(`fake.js:143`): 맨 앞에 걸어 둔 상태 표현이 있으면 `TASK_END_RE`가 아니어도 할 일로 만든다(제목 = 뗀 나머지, `do_in` = 그 모드). 지금은 "우유 사기"가 할 일이 되지 않기 때문이다.
- `context`는 `null`로 둔다. 읽을 때 규칙(§6.2)이 같은 결과를 내므로 데모에서 차이가 없다. 'AI 값'이 학습·규칙을 가리지 않게 한다.
- `presence`는 늘 `{ role:'none', quote:null }`이다.

---

## 15. 렌더러 모듈 `renderer/statusui.js` (`DN.status`) — FEATURES_SPEC §1.5 계약 포함

`assistant.js`(와 FEATURES_SPEC `slash.js`) 뒤, `views/*` 앞에 둔다. 모든 변경은 `S.mutate(null, fn, { source:'status' })`다(맥락 바꾸기만 라벨 있음).

```js
DN.status = {
  // ── FEATURES_SPEC §1.5 계약
  current(now?)                      → null | { id, label, busy, until, guessed }
  setFromCommand(args, { now, source:'command', surface:'chat'|'toast' }) → { ok, label?, message?, posted? }
  // ── 읽기 (rev = 저장소 변경 횟수, 분 단위로 캐시)
  profile(), view(now?)              → StatusView | null
  // ── 말
  detect(text)                       → Detection | null       (ST.detect + 지금 profile·eff)
  apply(d, { source, surface, text }) → Transition             (상태 바꾸기 + 카드/토스트, idle 이면 AS.next())
  hintFor(d)                         → statusHint | null       (예산이 없으면 null, 있으면 쓰고 돌려줌)
  touch()                            → 잘 시간이면 ST.wake
  // ── 바꾸기
  set(target, { source, quiet? }), revert(), toGuess(), extend(minutes), back(), confirmGuess()
  postPicker()                       → 'status-pick' 카드
  // ── 그리기
  chip(where:'head'|'bar'), openMenu(anchor), card(m, st, now), nudgeLine(now)
  contextChip(task, opts), contextMenu(anchor, taskId), setTaskContext(taskId, ctxId)
  hintChip(note)                     → 결과 카드 제안 줄
  // ── 휴식 타이머
  onRestTimer(timerEnd), onRestDone()
};
```

**다른 렌더러 파일에서 바꿀 곳**

| 파일 | 바꿀 것 |
|---|---|
| `assistant.js` | `send()` 감지(§5.1), `next()`의 `statusView`·`quiet`·`all_hidden`(§8.3), `tryNudge`, 휴식 타이머(§8.4), `pickTaskToBreak` 필터 |
| `app.js` | `saveQuick` 감지(§5.1 C, 토스트), `renderNav` 숫자(§9.6), 60초 tick에서 `S.mutate(null, s => ST.settle(…), { silent:true, source:'status' })` 후 바뀌었으면 칩·목록 다시 그리기, `whenReady`에서 `settle` 한 번 |
| `views/today.js` | 머리줄 칩·상단 줄·근무 시간 줄, `partitionToday` 묶음(§9), 숨긴 줄, 끌기 저장, `onChange`가 `source:'status'`에서도 `chat.refresh(); paint()`(입력창은 그대로), `showHidden()` 내보내기 |
| `views/chat.js` | `message()`에 `status`·`status-pick` 분기, `captureCard`에 `hintChip`, 할 일 행 맥락 칩(기능을 켠 뒤), `nextCard` 상태 줄, 액션 `showHidden` |
| `views/detail.js` | 맥락·언제 할까요 줄, `onChange` 정규식 |
| `views/projects.js` | 머리의 '기본 맥락' 선택 |
| `views/settings.js` | §11 카드, `onChange`에 `'status'` |
| `palette.js` | '상태' 그룹 |
| `capture.js` (renderer) | `submit` opts의 `statusLine`·`statusHint` 저장, `classify`의 `contexts`·`presenceNow`·`statusLine` 입력 |
| `ui.js` | 아이콘 11개 |
| `styles.css` | §10.8 |
| `sample.js` | §17 |
| `index.html` | `../src/core/statusWords.js`, `../src/core/status.js`(`model.js`·`slots.js`·`adapt.js` 뒤, `recommend.js`·`ai/*` 앞), `statusui.js`(assistant 뒤) |
| `main.js:180` 스모크 | `out.core`에 `&& D.statusCore` |

---

## 16. 다른 문서와의 계약 정리

| 상대 | 이 설계가 쓰는 것 | 이 설계가 고쳐 달라는 것 |
|---|---|---|
| FEATURES_SPEC | `prefs.workHours {start,end,days}`, `DN.slots.normalizeWorkHours / workWindow / isWorkingTime`(없으면 같은 규칙의 내부 대체), `commands.parse`의 `status` 분기, `DN.capture.submit`의 4번째 인자, 설정 카드 순서·`details.settings-adv`, recpanel의 `status` 반향 | ① `statusCommand`: args 없으면 `DN.status.postPicker`가 있을 때 그것을 부른다. `r.posted`이면 글 메시지를 올리지 않는다<br>② `setFromCommand`의 mutate는 라벨 없음(결정 10)<br>③ `F.rulesItem`이 `ST.extractAtMode`로 제목 맨 앞의 걸어 둔 상태를 뗀다<br>④ `refineForced`는 사용자 맥락을 덮지 않는다<br>⑤ 설정 `onChange`에 `'status'` |
| ADAPTIVE_PLAN | `AD.learn`, `AD.suggest`, `AD.penalize`, `AD.count`, `prefs.learning` | ① type `context` = 할 일 맥락, `to` = 맥락 id 또는 `'none'`<br>② `strongNPart` 3 → 2<br>③ 설정 묶음 이름 "할 일 맥락", 칩 라벨 `DN.statusCore.contextLabel`<br>④ 프롬프트 버전 하나로 합치기(J는 적응, K·L·M은 상태) |
| GOOGLE_DESIGN | – | `KEEP_ON_UNDO`를 한 목록으로: `['prefs', 'presence', 'gcal']`. `SCHEMA_VERSION`은 같은 릴리스면 번호 하나 |
| `adapt.js`가 아직 없으면 | 학습 단계(§6.1의 3·5) 건너뜀, 사용자 맥락 저장은 그대로 | adapt 1단계 코어(§7.4: `ensure/normKey/tokens/phrases/learn/suggest/penalize/count`)를 이 기능과 함께 넣어도 된다. 순수 모듈이고 자체 테스트가 있다 |

---

## 17. 샘플 데이터 (`renderer/sample.js`)

샘플 할 일은 거의 모두 업무 말(보고·회의·리포트·발표)이다. 기능을 켜면 업무만 접히고 아무것도 올라오지 않는다. 그래서 다음을 더한다. 모든 날짜는 `now` 기준이고 `sample:true`다.

| 더할 것 | 값 | 보여 주는 것 |
|---|---|---|
| 프로젝트 3개 `context` | `'work'` | 프로젝트 → 맥락 |
| '빨래 돌리기' | 날짜 없음, `estimateMinutes:15`, 만든 때 하루 전 | 오늘 목록 밖 → 퇴근하면 `extra` |
| '분리수거' | 마감 오늘 | 퇴근하면 띄움 |
| '엄마 생신 선물 주문' | 마감 내일 | 가족 띄움 |
| '우유 사기' | `atMode:'out'`, `atModeSource:'rule'`, 만든 때 오늘 | 퇴근길·외출에서 ★ 묶음 |

- `test/sample.test.js`의 개수 기대값을 갱신한다(완료 3·대기 1·선행 1 같은 기존 조건은 그대로).
- `sample.test.js:64`의 `recommend` 기대값(`source:'calendar'`, 30분, `fits`)은 상태가 없으므로 바뀌지 않는다.
- `clearSample`은 `presence`를 건드리지 않는다.
- **샘플을 불러도 기능은 켜지지 않는다**(`activatedAt` 그대로). 토 01:25에 샘플을 불러도 화면은 지금과 같다.

---

## 18. 엣지 케이스

| 상황 | 동작 |
|---|---|
| 기능을 한 번도 안 씀 + 할 일 제목에 '업무'·'회의'·'빨래' | `view = null` → 추천·오늘 목록이 지금과 같다(I1). 흐린 [상태 정하기] 알약만 |
| "퇴근하고 싶다", "퇴근 언제", "아직 퇴근 전", "퇴사", "퇴근 시간 바꾸기" | 상태 아님. 그냥 정리 |
| "퇴근 못 함" | maybe: "상태를 ‘야근’으로 바꿀까요?"(명시 업무가 아닐 때만, 예산 안) |
| "출근 중" | 출근길(이동). 업무 중이 아님 |
| "도착"만 (이동 중 아님) | 상태 아님 → 메모 |
| "점심 먹었어" | 식사 중이면 복귀. 업무 중이면 상태 아님(기록 메모) |
| "밥 먹는 중" (퇴근 뒤) | 문(gate)에 걸려 상태 아님 → 메모 |
| 휴식이 앱이 꺼진 동안 끝남 | 켤 때 `effective`가 계산으로 바탕을 쓴다. `settle`이 저장한다. 카드 없음 |
| 야근: 09:00 출근, 21:00에도 업무 중 | 시계가 바꾸지 않는다. `offHours=false`, T를 근무 끝으로 자르지 않는다. 19:30에 "근무 시간이 지났어요" 한 줄(하루 1번) |
| 퇴근을 말하지 않고 집에 감 | 업무 상태는 16시간 규칙으로만 낡는다. 저녁에는 업무가 계속 보인다(숨기지 않는 쪽으로 실패). 근무 끝 줄이 한 번 알린다 |
| 야간 근무 22:00 "출근" | 다음 날 04:00을 넘어도 업무 중. 다음 날 14:00에 낡는다 |
| 주말에 "출근" | 명시 업무가 짐작(쉬는 날)을 이긴다 |
| 평일 연차인데 09:00에 앱 열기 | 짐작은 업무 중(점선, 숨기지 않음). "오늘 연차" 한마디로 쉬는 날 |
| 금 18:40 "퇴근" → 토 10:00 | 명시 퇴근은 토 04:00에 끝난다. 짐작 '쉬는 날'이라 업무는 숨김이 아닌 **내림**. 묶음 머리 [쉬는 날로 정하기]로 접을 수 있다 |
| 진행 중 업무가 퇴근으로 숨겨짐 | `parked`. 카드가 알리고 [멈춰 두기]를 준다. 출근 카드에서 [이어하기]. `task.status`는 상태가 바꾸지 않는다 |
| 숨긴 할 일을 검색·할 일 화면에서 열어 시작 | 막지 않는다. `startedAt ≥ since`라 보통으로 올라온다 |
| 오늘 일정(약속)이 퇴근 뒤에 있음 | 일정 칸은 그대로. 일정 블록은 정책 대상이 아니다 |
| 퇴근 상태인데 20:00에 업무 작업 블록 | 19:30부터 보통(`reason:'block'`). 사용자가 잡은 시간이 이긴다 |
| 맥락 없는 옛 할 일 | 규칙·학습으로 계산. 그래도 없으면 보통 |
| 동점("엄마 선물 사기") | 맥락 없음 → 어디서나 보통. 사용자가 고치면 배운다 |
| 할 일이 모두 숨김 | 빈 화면 문구와 숨긴 줄. 추천은 `all_hidden` |
| 같은 상태를 연달아 던짐 | 아무것도 바꾸지 않고 log도 남기지 않는다. 토스트 "이미 ‘업무 중’이에요". 상태만 적은 글이면 말풍선은 남는다 |
| 상태를 바꾼 뒤 Ctrl+Z | 데이터만 되돌리고 상태는 유지(`KEEP_ON_UNDO`). 상태는 [이전 상태로]로 되돌린다 |
| 맥락을 바꾼 뒤 Ctrl+Z | 맥락과 배운 규칙이 함께 되돌아간다(같은 라벨 mutate) |
| Ctrl+N 모달로 "퇴근" | 감지 적용. 흐름이 없으므로 토스트 + [이전 상태로] |
| 빠른 메모 창으로 "잘게" | 메인 흐름에 상태 카드. 창은 지금처럼 "보냈어요" 뒤 숨는다. 메인 창은 앞으로 나오지 않는다 |
| 잘 시간에 아무 글이나 | `ST.wake` → 짐작으로. 따로 묻지 않는다 |
| "퇴근! 내일 견적서 보내기" | 퇴근 + 할 일 '견적서 보내기'(업무, 내일). 지금 퇴근이라 바로 숨는다. 내일 마감이 월 09:00(다음 업무 시작) 전이면 내림으로 보인다 |
| "#집안일 빨래" | 사용자 맥락 home, 제목 '빨래' |
| 다른 화면(캘린더·할 일)에 있을 때 상태가 바뀜 | 그 화면들은 거르지 않으므로 영향 없음. 홈으로 오면 반영 |
| `/상태 퇴큰` | 명령에서만 편집 거리 1로 '퇴근' |
| AI 없음·오프라인·웹 데모 | 감지·맥락·정책·추천 모두 규칙으로 동작. AI 상태 제안만 없다 |
| 프리셋을 바꿨는데 지금 상태 id가 새 프리셋에 없음 | `current = null`(짐작) |
| 사용자 맥락을 지움 | 옮길 맥락을 묻는다. 남은 값은 무시하고 다음 단계로 계산 |
| 사용자 상태의 정책을 비워 둠 | 공식 행(§7.3). 사용자가 모든 칸을 보통으로 두면 아무것도 숨기지 않는다 |
| 여러 기기 | 상태는 기기마다 따로다. 동기화하지 않는다 |
| 기능 끄기(`enabled:false`) | `view = null`. 지금과 같아진다. `presence`는 남는다(다시 켜면 이어서) |
| `__daynoteNow` 고정 시계 | 모든 계산이 `A.now()`. 휴식 타이머만 `Date.now()`라서 `until`에 `timerEnd`를 그대로 쓴다 |

---

## 19. 결정한 쟁점 (판정의 "남은 모순"과 세 안의 과한 부분)

| 쟁점 | 결정 |
|---|---|
| **반차** | 퇴근(`off`) + `until`. 오전 반차(또는 12:00 전에 "반차") → 13:00까지, 오후 반차(또는 12:00 이후) → 오늘 근무 끝까지. 끝나면 시간표 짐작으로 |
| **퇴근 못 함** | 상태 아님. maybe 제안 '야근'까지만 |
| **오프·데이·나이트·마감했어** | 그 프리셋에서만 상태다. 공통 사전에는 뜻이 하나인 말만 둔다. 다른 프리셋에서는 프리셋 제안 신호로만 센다 |
| **같은 상태를 다시 보냄** | 아무것도 하지 않는다. log도 남기지 않는다. 짧은 토스트만 |
| **규칙 기반 'maybe' 제안** | 둔다. 결과 카드 제안 칩만 쓰고, 하루 1번 예산 안에서 |
| **맥락 집합** | 기본 6개(업무·집안일·밖 볼일·개인·가족·공부). 건강은 개인에 넣는다. 사용자 맥락은 최대 6개 |
| **숨긴 할 일 보이기** | 지금 상태 동안 유지되는 `presence.shown`(P1). "오늘은 보이기"(`showOn`)는 v2 |
| **짐작 상태가 띄우기도 하나** | 아니다. 짐작은 내리기만 한다(띄움 → 보통, 숨김 → 내림, `extra`·★ 없음). "시계는 내리기만"을 가장 단순하게 지킨다 |
| **상태 이름 키** | `state.presence`. 코어 파일은 `status.js`(`DN.statusCore`), 화면 계약은 `DN.status` |
| **학습 저장소** | 별도 `contextLearn`을 두지 않고 `state.learned`(adapt)를 쓴다. 되돌리기·백업·설정 화면을 한 곳에서 다룬다 |
| **외출 × 업무** | 숨김이 아니라 내림(업무 시간 중 잠깐 외출일 수 있음) |
| P1의 첫 실행 동작 변경 | 버림. `activatedAt` 전에는 그대로 |
| P1의 "첫 단어가 이긴다" 매칭 · 한 번 고치면 낱말 학습 · `prefs`에 학습 | 버림. 점수·문턱·차이 매칭, 2번 이상 학습, `state.learned` |
| P1의 빠른 메모 창 미리 판정 | 버림 |
| P2의 경계마다 묻기(suggest 모드) | 버림. 근무 끝 한 줄(하루 1번)만 |
| P2의 섞인 글에서 나머지만 저장 | 버림. 원문 전체 저장 + `statusLine` |
| P2의 `whenStatus` 다른 상태에서 숨김 · `capturedStatus` 힌트 | 버림 |
| P2의 표면 과다(사이드바 미니·Alt+S·타임라인·근무 시간 통계) | v1에서 뺌. 근무 시간 통계는 하지 않는다(스스로 말한 상태라 부정확) |
| P2의 퇴근 카드 "다음 업무 시작으로 미루기" | 버림. 이미 숨긴 일을 미루면 두 번 숨는다 |
| P3의 자동 리듬 30분 유예 뒤 숨김 | 버림(시계는 숨기지 않는다). `hideOnGuess` opt-in만 |
| P3의 라벨 있는 상태 mutate | 버림. 상태는 undo 밖 |
| P3의 프리셋별 맥락 해석 표 · 시험 기간 · 9개 맥락 · 돌파 모드 4개 | v2. 돌파는 한 규칙(§7.4 d)과 `urgentHours` 하나 |

---

## 20. 테스트 목록

- 규칙: `node:test`, `node:assert/strict`, 한국어 테스트 이름.
- 상태는 `M.emptyState()`와 mutator로 만든다.
- 고정 시계: `NOW = new Date(2026, 9, 5, 10, 0)`(월). 필요하면 금 `new Date(2026, 9, 9, 18, 42)`, 토 `new Date(2026, 9, 10, 1, 25)`.
- 근무 시간은 기본(월–금 09:00–18:00)이다.
- 감지 테스트는 **표 하나를 데이터로** 두고 돌린다(§5.8 표 포함).

### 20.1 `test/status-detect.test.js` — 감지 (`ST.detect`, `parseStatusArgs`, `extractAtMode`)

1. '출근', '출근했어', '출근 완료!', 'ㅊㄱ', '회사 도착', '이제 출근함ㅋㅋ' → `work_start`→`work`, sure, pure.
2. '퇴근', '퇴근했어요~', '칼퇴 ㅎㅎ', 'ㅌㄱ', '드디어 퇴근ㅠㅠ', '오늘 일 끝!', '퇴근 🎉', '퇴근!!!' → `off`, sure.
3. '퇴근할게' → `off`('할게'는 지금).
4. '출근 중', '출근길' → `to_work`. '퇴근길', '집 가는 중' → `to_home`. ('출근 중'이 '출근'+'중'보다 먼저)
5. 막기: '퇴근하고 싶다', '퇴근 언제 하지', '아직 퇴근 전', '퇴근 시간 바꾸기', '퇴사', '퇴근했나?', '내일 퇴근하고 장보기', '퇴근 15분 전', '퇴근하고' → `null`.
6. '퇴근 못 함', '퇴근 못해' → maybe, label '야근'.
7. 다른 사람: '팀장님 퇴근하심', '남편 퇴근 7시', '엄마 퇴근했대' → `null`.
8. 할 일 꼴: '운동 가기', '장보기' → `null`.
9. '퇴근! 가는 길에 우유 사기' → sure `off`, `pure:false`, `statusLine:'퇴근!'`, `rest:'가는 길에 우유 사기'`.
10. '출근함\n9시 회의 자료 출력' → sure `work`, `pure:false`.
11. '퇴근하고 우유 사기' → `null`. `extractAtMode` → `{ mode:'off', phrase:'퇴근하고', title:'우유 사기' }`.
12. 시간: '10분만 쉴게' → `break`, `until` +10분. '15분 쉼' → +15. '휴식' → +15(기본). '30분 휴식' → +30.
13. 12:20에 '1시까지 점심'(업무 짐작) → `meal`, `until` 13:00. 12:05에 '점심' → `until` = 점심 끝 13:00. 15:00에 '저녁 먹으러'(업무 중) → +40.
14. 14:00에 '6시까지 외출' → `until` 18:00. 19:00에 → `until` 없음(8시간 넘음).
15. 문: '밥 먹는 중'(명시 `off`) → `null`. '점심'(기능 켜기 전, `eff=null`) → `null`.
16. '커피 한잔'(업무 중) → maybe `break` 라벨 '커피'. '커피 한잔'(퇴근) → `null`.
17. '점심 먹었어': `meal` 중 → `back`. `work` 중 → `null`.
18. '도착': `to_home` 뒤 → `off`. `to_work` 뒤 → `work`. 이동·외출 아님 → `null`.
19. '복귀': `break` 덧씌움 → `returnTo`(업무 중). `out` + 10:00 → `work`. `out` + 20:00 → `off`. 이미 `work` → `same:true`.
20. '오늘 연차', '휴가', '쉬는 날' → `day_off`. '오프'(직장인) → `null`, `presetSignal` → `'shift'`.
21. '반차': 08:30 → `off`, `until` 13:00, 라벨 '반차'. 14:00 → `until` 18:00. '오후 반차'를 10:00에 → `until` 18:00.
22. '잘게', '굿나잇', '이제 자야지' → `sleep`. '낮잠' → maybe. '낮잠 잘게' → `sleep`, `until` +60, `returnTo` = 지금 바탕.
23. '일어났어': `sleep` 중 → `wake`. `sleep` 아님 → `null`.
24. '한가해', '뭐 하지', '뭐 할까'('할까' 막기보다 먼저) → `idle`.
25. '모두 보기', '상태 해제' → `reset`(`none`).
26. 긴 메모: '오늘 퇴근길에 본 노을 정말 예뻤다' → `null`. 첫 줄 40자 메모 가운데의 '퇴근' → `null`.
27. maybe: '운동'(꼬리 없음) → maybe `exercise`. '운동 중' → sure. '지하철 탐' → maybe, 업무 중이면 `to_home`, 아니면 `to_work`. 남는 글자 7자 이상이면 `null`.
28. '야근' → `work` 라벨 '야근'. '오늘 야근이라 퇴근 늦음' → `null`.
29. '재택 시작' → `wfh` 라벨 '재택'.
30. 프리셋 전용: '마감했어'(직장인) → `null`. '나이트 출근'(직장인) → `null`, `presetSignal` → `'shift'`. (v1.1 데이터로) `shop` 프리셋에서 '마감했어' → `work_end`, `shift`에서 '나이트 출근' → `work` 라벨 '나이트'.
31. 사용자 말: 상태 `off`에 words '집 감' → '집 감' sure `off`. `wordsOff`로 뺀 '칼퇴' → `null`. 사용자 상태 '운동 중'(words '헬스장 도착') → 그 상태.
32. `/`로 시작하는 글 → `null`(명령은 commands가 처리).
33. `parseStatusArgs`: '' → picker. '퇴근' → set `off`. '퇴큰' → set `off`(편집 거리 1). '휴식 10분' → set `break` +10. '자동' → guess. '이전' → revert. '가게 오픈 준비' → unknown.
34. `detect('퇴큰')` → `null`(일반 글에서는 오타를 고치지 않음).
35. 같은 입력·같은 `now` → 같은 결과. `detect`는 벽시계를 읽지 않는다(`Date.now`를 막아도 통과).
36. `extractAtMode` 표: '퇴근 후에 X'·'집에 가서 X' → off / '출근하면 X'·'회사 가서 X' → work / '점심 때 X'·'쉬는 시간에 X' → pause / '나가는 김에 X'·'가는 길에 X' → out / '쉬는 날에 X' → rest / '주말에 X' → `null` / '퇴근하고 A'의 A가 1자 → `null`.
37. `findAtMode('오늘 퇴근하고 빨래 돌리기')` → `'off'`(글 가운데도 찾음).
38. `onPhone`: '엄마한테 전화', '카드값 이체', '치과 예약' → true. '빨래 돌리기' → false.

### 20.2 `test/status-model.test.js` — 유효 상태·상태 기계·저장

39. `activatedAt` 없음 → `effective` null, `view` null(근무 시간이 있어도).
40. `enabled:false` → `view` null(`activatedAt`이 있어도).
41. 짐작: 월 10:00 `work`(guessed), 월 20:00 `off` '퇴근 후', 월 07:00 `off` '출근 전', 월 12:30 `work`(점심을 짐작하지 않음).
42. 짐작: 토 01:25 → 금요일 밤 `off` '퇴근 후'. 토 10:00 → `day_off`. 월 02:00 → `day_off`(일요일 밤).
43. `prefs.workHours {start:'10:00', end:'19:00', days:[1,2,3,4]}` → 금 11:00 `day_off`, 목 18:30 `work`. 시작 ≥ 끝이면 기본값.
44. 명시 업무는 시계로 바뀌지 않는다: 월 09:00 '출근' → 월 21:00에도 `work`, `guessed:false`.
45. 업무 낡음 16h: 22:00 '출근' → 다음 날 06:00 `work`, 14:01 → 짐작.
46. 생활 낡음: 금 18:40 `off` → 토 03:59 `off`, 토 04:00 → 짐작 `day_off`.
47. 이동 2h·외출 4h·잠 10h 낡음.
48. 덧씌움: `until`이 지나면 저장값이 그대로여도 `returnTo`로 계산된다. 덧씌움 위 덧씌움은 원래 바탕으로 돌아간다. 바탕 없는 덧씌움 → 끝나면 짐작.
49. `mode:'off'` + 명시 없음 → `{ id:'none', guessed:true }` → 모든 할 일 보통.
50. `setStatus`: `activatedAt`이 생긴다. log `{ at, id, label, from, fromLabel, source, text(≤40) }`. 짐작에서 바꾸면 `from:null`.
51. 같은 명시 상태 → `{ noop:true }`, log가 늘지 않는다. 짐작과 같은 id를 명시하면 noop이 아니다.
52. 덧씌움 같은 id + minutes → `{ extended:true }`, `until`만 바뀐다.
53. `work` → `off`: 그 전부터 진행 중인 업무 할 일 → `parked`, `task.status`는 그대로. `off` → `work`: `resume`으로 돌려주고 `parked`를 비운다.
54. 바탕이 바뀌면 `shown`을 비운다. 덧씌움으로 바뀔 때는 유지한다.
55. `revert`: 마지막 log의 `from`으로 간다(source `'revert'`). `from:null`이면 짐작으로.
56. log는 60개, `text`는 40자로 자른다.
57. 반차 `until`이 지나면 짐작으로.
58. `settle`: 지난 덧씌움과 낡은 상태를 저장하고 log에 `until`/`expire`를 남긴다. 바뀐 것이 없으면 false.
59. `confirmGuess`: 짐작 `off`를 명시 `off`(source `'confirm'`)로 바꾼다.
60. `ST.current`: 명시 `meeting` → `busy:true`, `until`. `off` → `busy:false`. 꺼짐 → null.
61. `ST.profile({})` → 직장인, 빈칸 없는 정책표, 메뉴 7개. 모르는 상태 id·잘못된 수준·중복 단어는 버린다.
62. `profile`: 사용자 상태(`category:'life', place:'home'`) → 공식 행(업무 숨김, 집안일 띄움). `policy` 칸 덮어쓰기가 프리셋을 이긴다. `afterWork:'down'`이면 `off`×업무 = 내림.
63. `normalize`(옛 v3 데이터) → `presence` 기본값, 할 일 `context/contextSource/atMode/atModeSource = null`, 버전이 올라간다. `presence`가 다시 불러와도 남는다(모르는 최상위 키가 버려지는 문제가 아님을 확인).
64. `clearSample`은 `presence`를 건드리지 않는다.
65. **(store vm 테스트)** `S.mutate('메모 저장', …)` → `S.mutate(null, s => ST.setStatus(s, {id:'off'}, …))` → `S.undo()` → 메모는 되돌아가고 `presence.current.id === 'off'`가 남는다(판정 필수).
66. `M.updateTask` 제목 변경: `contextSource:'ai'`이면 맥락을 지운다. `'user'`이면 그대로 둔다.

### 20.3 `test/status-context.test.js` — 맥락

67. 단어 규칙: '빨래 돌리기'·'설거지'·'분리수거' → home. '견적서 보내기'·'회의록 정리' → work. '우체국 택배 보내기'·'장보기'·'우유 사기' → errand. '헬스 등록 알아보기'·'카드값 이체' → personal. '어린이집 준비물'·'엄마 생신 선물 주문' → family. '과제 제출'·'인강 듣기' → study.
68. 조사가 붙어도 잡는다: '빨래를 개기' → home.
69. 낱말마다 가장 긴 키워드: '빨래방 가기' → errand, '세탁소 맡기기' → errand.
70. 제외어: '청소년 지원사업 보고서' → work.
71. 문턱: '정리하기' → null.
72. **동점 → null**: '엄마 선물 사기'(family 2 · errand 2) → null. 그래서 명시 `off`에서 숨지 않는다(판정 필수).
73. 라틴은 낱말 전체: 'PR 리뷰' → work. 'PRINT 수리'는 work가 아님.
74. 사용자 단어: home에 '식물 물주기' → home. `wordsOff`로 뺀 기본 단어는 세지 않는다. 사용자 맥락 '교회'(words '예배') → `u_church`.
75. 우선순위: user > project > learned(제목) > ai > learned(낱말) > rule > hint. 단계마다 한 할 일로 확인한다.
76. 사용자 '정하지 않음'(context null, source user) → 규칙이 덮지 않는다.
77. 배운 `'none'` → `{ value:null, source:'learned' }`. 규칙보다 앞선다.
78. 메일 출처 + 키워드 없음 → `{ value:'work', source:'hint' }`.
79. 지운 사용자 맥락 id가 저장돼 있으면 건너뛰고 규칙으로 계산한다.
80. 제목이 비면 `sources[0].excerpt`로 계산한다.
81. 메모: 같은 할 일을 두 번 부르면 같은 객체. 제목·`updatedAt`·profile·학습이 바뀌면 다시 계산한다.
82. `setTaskContext`: `contextSource:'user'`로 저장한다. `AD.learn`을 `{ type:'context', text:제목, from:이전 계산값, to }`로 부른다(adapt 대역으로 호출 기록 확인).
83. 학습 문턱(실제 adapt): '견적서 보내기'를 work로 1번 고침 → 같은 제목은 learned. '견적서 회신'은 아직 아님. '견적서 수정'도 고치면(2번) '견적서 회신' → learned(strong, `strongNPart:2`).
84. 학습으로 정해진 맥락을 다른 값으로 고치면 `AD.penalize` + `count('reverted')`.
85. `prefs.learning === false` → 학습 단계 없음, 사용자 값은 저장한다.
86. `DN.adapt`가 없어도 `setTaskContext`·`contextOf`가 던지지 않는다.
87. (store vm) '맥락 바꾸기' 뒤 `S.undo()` → 맥락과 `state.learned`가 함께 되돌아간다.

### 20.4 `test/status-policy.test.js` — 정책·돌파·나누기

88. `eff` null → `applyStatusPolicy`가 입력 순서 그대로 `visible`, 나머지는 빈 배열.
89. 명시 `work`: 업무 up, '빨래' down, 맥락 없음 normal.
90. 명시 `off`: 업무 hide, 집안일·개인·가족 up, 밖 볼일·공부 normal.
91. **짐작** `off`: 업무 down(숨김 아님), 집안일 normal(띄움 아님). `hideOnGuess:true`면 업무 hide.
92. `afterWork:'down'` → 명시 `off`에서 업무 down.
93. 덧씌움 `meal`(바탕 `work`) → `work`와 같은 수준.
94. `out` 명시: 업무 down, 밖 볼일 up.
95. 걸어 둔 상태: atMode `off`인 업무 할 일 → 명시 `off`에서 up. **`day_off`에서도 up이고 어떤 경우에도 숨지 않음**(판정 필수). `work`에서는 정책대로(up). 짐작 `off`에서는 up이 아님.
96. atMode `pause` → `meal` 덧씌움에서 목록 수준은 바탕 그대로. `view.anchored`에 들어간다.
97. `shown`에 든 숨김 할 일 → normal. 바탕이 바뀌면 다시 숨김.
98. 진행 중: `startedAt ≥ since` → normal. 그 전부터면 hide.
99. 작업 블록이 지금 또는 30분 안 → normal(reason 'block'). 31분 뒤면 그대로.
100. **돌파 경계**(금 19:00 명시 `off`): 업무 마감 토 23:59 → down. 월 10:00 → hide. 3일 지남 → down(보통이 아님). 오늘 21:00 → normal. 22:30(3.5시간) → down(`nextActiveStart` 전이라).
101. `nextActiveStart`: 금 19:00 명시 `off` → 월 09:00. 수 15:00 명시 `off` → 목 09:00. `mode:'off'` → now + 12h(11시간 뒤 마감 down, 13시간 뒤 hide).
102. `urgentHours:0` → 3시간 안 마감도 normal로 올리지 않는다(hide → 다음 활동 전이면 down까지만).
103. 약한 힌트(메일) 업무 + 명시 `off` → down.
104. 이동 중 + 폰 할 일(맥락 personal) → up. `to_home` + 폰 할 일(맥락 work, 숨김) → hide 그대로.
105. `sleep` → 모두 hide, `shown`만 예외.
106. 명시 `none` → 모두 normal.
107. 프리랜서 프리셋: 명시 `off`(일 끝)에서 업무 down.
108. `partitionToday`: when/up/normal/extra/down/hidden으로 나누고, 묶음 안 순서는 입력 순서다. done은 들어가지 않는다. `summary = { hidden, byCtx, parked }`.
109. **extra**: 날짜 없이 어제 만든 '빨래 돌리기' → 명시 `off`에서 `extra`에 든다(판정 필수). 짐작 `off`에서는 `extra`가 빈다. 대기·선행·미루기 할 일은 빠진다. 5개 상한, `rankedIds` 순서.
110. `when`: 오늘 목록 밖의 '우유 사기'(atMode out)가 `to_home`에서 when에 든다. 5개 상한.
111. `view` null → `{ normal: open, 나머지 빈 배열, summary: null }`.
112. `joinOrder`: 묶음 하나를 끌어도 이은 전체 순서가 `(i+1)*10`으로 겹치지 않게 매겨진다.
113. 숨긴 줄 문구: '업무 할 일 5개 숨김 · 보기' / '업무 할 일 4개 · 공부 1개 숨김 · 보기' / '(하던 일 1)'.
114. 사이드바 숫자 도우미: 숨김을 뺀다.

### 20.5 `test/recommend.test.js` 추가 (기존 18개는 고치지 않는다)

115. 기존 18개가 그대로 통과한다.
116. `recommend(s,{now})`와 `recommend(s,{now, statusView:null})`이 `deepEqual`이다.
117. **기능을 안 씀 + 제목 '업무', '20분 업무', 일정 '회의'** → `ST.view`가 null이고 결과가 상태 없는 결과와 `deepEqual`이다(판정 필수).
118. 명시 `off`: 업무 할 일은 ranked에 없다. `excluded.hidden`·`hiddenIds`가 맞다. primary는 집 일이다.
119. `levelRank`가 첫 키: 명시 `work`에서 날짜 없는 업무가 기한 지난 '빨래'보다 먼저다.
120. 모두 숨김 → `empty:'all_hidden'`.
121. 휴식 덧씌움 12분 남음 → `availableMinutes:12`, `source:'status'`, `until:'status_end'`. 30분 할 일은 `too_long`.
122. 회의·수업·운전·운동·잘 시간 → primary 없음, `empty:'quiet'`, ranked는 있다.
123. 명시 `work` + 20:00 → `offHours:false`, T를 근무 끝으로 자르지 않는다(다음 일정까지).
124. 명시 `off` + 평일 10:00 → `offHours:true` → `source:'none'`. 사용자 T가 있으면 사용자 T.
125. 이유: 상태 이유는 최대 1개이고 맨 앞이다. 'when'·'phone'·돌파·up 문장이 §8.2와 같다.
126. `tooLong`도 `levelRank`를 먼저 본다.
127. `checkStartable`은 숨긴 할 일도 시작을 허락한다.
128. `context.status`가 sv 요약 `{ id, label, guessed, category, overlay }`이다.

### 20.6 `test/assist.test.js` 추가

129. `looksIdle(state, now, sv)`가 `workHours`를 넘긴다(근무 시간을 10–19로 두면 18:30이 근무 시간으로 계산됨).
130. `elaborateCandidates`·`pendingBreakdowns`: sv의 hide·down 할 일을 뺀다. sv가 없으면 지금과 같다.
131. `nextNudge`가 `ctx.statusView`를 아래로 넘긴다.

### 20.7 `test/status-capture.test.js` — 캡처·AI

132. 버전이 v7(또는 합쳐진 번호)이다. 스키마 엄격성 walker 통과: `tasks[].context`, `tasks[].do_in`, `presence{role,quote}`가 required.
133. `buildInput`: `contexts`, `presenceNow`(라벨 하나), `statusLine`이 있다. `userText`에 '상태 보고 줄'이 있고 `presence.log`의 어떤 글도 없다.
134. 검증: 모르는 context id → null. `do_in`은 quote에 트리거가 없으면 'none'. `presence.quote`가 원문에 없거나 `statusLine`이 있으면 버린다. role이 enum 밖이면 버린다.
135. `applySelections`: AI context → `contextSource:'ai'`. `#집안일` 태그가 있으면 user가 이기고 제목에서 태그를 뗀다. '# 회의록' 마크다운 제목은 태그가 아니다.
136. `applySelections`: AI가 제목에 '퇴근하고'를 남겨도 떼고 `atMode:'off'`.
137. 가짜 AI: '퇴근하고 우유 사기' → 할 일 '우유 사기', `do_in:'off'`(지금 `TASK_END_RE`로는 할 일이 안 되는 글).
138. **섞인 글**(가짜 AI 전체 경로): '퇴근! 가는 길에 우유 사기'를 `statusLine:'퇴근!'`으로 저장 → 메모 본문 === 원문 그대로, '퇴근' 할 일 없음, '우유 사기'(atMode out) 있음(판정 필수).
139. 다시 시도해도 `capture.statusLine`이 남아 같은 결과다.
140. AI `presence`(직접 만든 출력) + 기능 켜짐 + 예산 있음 → `capture.statusHint` 저장, `presence.current`는 그대로(제안만). 예산이 없거나 기능을 켜기 전이면 저장하지 않는다.
141. 할 일 → 일정 → 할 일 왕복 뒤에도 `context·contextSource·atMode·atModeSource`가 남는다(`TASK_KEEP`).

### 20.8 `test/sample.test.js` 추가 · `test/status-presets.test.js`

142. 샘플: 프로젝트 3개의 context가 work다. 집안일·가족 할 일과 atMode 할 일이 있다. 새 할 일도 `sample:true`다.
143. **토 01:25에 샘플을 불러도(기능을 안 씀) `ST.view`가 null이고 `partitionToday`가 그대로이며 recommend가 상태 없는 결과와 같다**(판정 필수).
144. 샘플 + 명시 `off`(금 18:42): '빨래 돌리기'가 extra, 업무가 숨긴 줄, 오늘 18:00 마감 기한 지난 업무가 down.
145. `PRESETS` 무결성: 메뉴 id가 모두 정의돼 있다. 정책표가 모든 맥락을 덮는다. `roleMap`의 역할이 유효하다. 프리셋 전용 말이 공통 사전과 겹치지 않는다.
146. `guessPreset`: 과제·시험·강의 위주 → student. 등원·하원 → home. 신호가 부족하면 null.
147. 프리셋 제안 카운터: 14일 안 3번이면 제안 가능. 프리셋마다 평생 1번. 켤 때 `guessPreset`이 1번으로 씨앗을 뿌린다. 15일 전 신호는 버린다.
148. 잔소리 예산: 하루 1번. 하루 시작(04:00)이 지나면 다시 1번. 근무 끝 줄을 2번 닫으면 다시 띄우지 않는다.
149. 근무 끝 줄 조건: 명시 업무 + 근무 끝 + 90분 → 참. 89분 → 거짓. 짐작 업무 → 거짓. `overtimeLine:false` → 거짓.

### 20.9 화면 확인 (Playwright + `scripts/serve.js`, `timezoneId:'Asia/Seoul'`, `__daynoteNow`, `?fakeai`)

150. 1440×900, 새 데이터: 오늘 머리줄에 흐린 [상태 정하기]가 있고 나머지 화면은 지금과 같다. 콘솔 오류 0.
151. 입력창에 '퇴근' → 메모 수가 그대로다. 흐름에 말풍선과 상태 카드, 칩 `퇴근 · 내 시간`, 숨긴 줄이 생긴다. [이전 상태로] → 원래대로.
152. '퇴근! 가는 길에 우유 사기' → 상태 카드 + 결과 카드. 메모 본문이 원문이고 할 일은 '우유 사기' 하나다.
153. 데이터 편집(완료) → 퇴근 → Ctrl+Z → 완료가 되돌아가고 칩은 '퇴근'이다.
154. 칩 메뉴: 항목, 덧씌움 기본 분, '시간표대로', 키보드(↑↓, Enter, Esc)로 고르기, 포커스 복귀.
155. 390×844: 상단 고정 줄이 보이고 가로 스크롤이 없다(`scrollWidth === 390`). 메뉴 항목 ≥ 44px. 토스트가 탭 막대 위에 있다.
156. `__daynoteNow='2026-10-10T01:25:00'` + 샘플 + 기능 안 씀 → 지금과 같은 화면(스크린샷 비교).
157. 같은 시각 + 기능 켬(짐작 '퇴근 후') → 칩 점선 `퇴근 후 · 시간표 기준`. 업무가 '뒤로 미룬 일'에 있고 숨지 않는다. [퇴근으로 정하기] → 숨긴 줄로 바뀐다.
158. 설정 카드: 시각 입력 중에 다른 저장(빠른 메모)이 들어와도 포커스가 유지된다. 정책표 칸을 눌러도 다시 그리지 않는다.
159. Ctrl+K '퇴근' → '상태: 퇴근 · 내 시간' → Enter → 바뀜.
160. 스모크: `main.js:180` `out.core`에 `D.statusCore`. shots에 '퇴근 후 홈' 장면을 더한다.

---

## 21. 구현 순서와 파일

| 단계 | 내용 | 파일 | 테스트 |
|---|---|---|---|
| **A. 코어** (화면 없이 `node --test`로 끝남) | 사전·프리셋 데이터, 감지, 유효 상태, 짐작, 정책, 맥락, 돌파, 나누기, 상태 변경 함수, 모델 필드, undo 보존, 추천 주입, assist 필터 | `src/core/statusWords.js`(새, `DN.statusWords`, 의존성 없음) · `src/core/status.js`(새, `DN.statusCore`, deps `dates`·`model`·`statusWords`, 선택 `slots`·`adapt`) · `model.js` · `renderer/store.js` · `recommend.js` · `ai/assist.js` · `ai/proposals.js`(`TASK_KEEP`) | 20.1–20.6, 20.8 일부 |
| **B. 홈** | 칩·상단 줄·메뉴, 상태 카드, 말 감지 연결(`AS.send`·`saveQuick`), 오늘 묶음·숨긴 줄·extra·끌기, 추천 연결, 자동 제안 끄기, 휴식 타이머, 팔레트, 사이드바 숫자, 근무 끝 줄, 샘플 | `renderer/statusui.js`(새, `DN.status`) · `assistant.js` · `app.js` · `views/today.js` · `views/chat.js` · `palette.js` · `ui.js`(아이콘) · `styles.css` · `sample.js` · `index.html` · `main.js`(스모크) | 20.8 샘플, 20.9 |
| **C. 캡처·AI** | `statusLine`·`statusHint` 저장, capture v7(K·L·M), 검증, `applySelections` 맥락·걸어 둔 상태·`#태그`, 가짜 AI, 결과 카드 맥락 칩·제안 줄, 상세 패널 두 줄 | `renderer/capture.js` · `ai/capture.js` · `ai/validate.js` · `ai/proposals.js` · `ai/fake.js` · `views/chat.js` · `views/detail.js` | 20.7 |
| **D. 설정·학습·제안** | "현재 상태" 카드(프리셋·짐작·afterWork·표·상태/맥락 편집), adapt 연결과 계약 고침, 프로젝트 기본 맥락, 프리셋 제안, 맥락 학습 토스트 | `views/settings.js` · `views/projects.js` · `src/core/adapt.js`(ADAPTIVE_PLAN, `strongNPart`) | 20.3의 83–87, 20.8의 147–149 |
| **E. v1.1** | 학생·교대 근무·자영업·육아 프리셋 켜기, 프리셋 전용 상태, 처음 알게 하는 한 줄 | `statusWords.js` `PRESETS` · `status.js` | 20.1의 30, 20.8의 145 |

`renderer/index.html` 순서:
```
../src/core/dates.js, model.js, slots.js(FEATURES_SPEC), adapt.js(ADAPTIVE_PLAN), statusWords.js, status.js, recommend.js, suggest.js, weekly.js, split.js, commands.js …
../src/core/ai/organizeNote.js, validate.js, proposals.js, capture.js, (forced.js), assist.js, fake.js
… store.js, ui.js, app.js, aiflow.js, capture.js, assistant.js, (slash.js), statusui.js, views/…, palette.js
```
- `status.js`는 `validate.js`·`proposals.js`·`fake.js`보다 앞에 둔다(`extractAtMode`·`findAtMode`를 쓴다).
- `recommend.js`는 `status.js`에 의존하지 않는다.
- 선택 의존성은 Node에서 `try { require('./slots') } catch (e) { null }`로, 브라우저에서 `window.Daynote.slots || null`로 읽는다.
- `scripts/build-web.js`는 바꿀 것이 없다(파일 이름이 `quick.js`로 끝나지 않음).

**공수**(1인 기준, 대략): A 3–4일 · B 3–4일 · C 2일 · D 2–3일 · E 2일.

---

## 22. 일부러 하지 않는 것

- **위치(GPS)·와이파이·캘린더 일정으로 상태를 자동 판정하기.** 사생활 비용이 크다. 일정 중 알림 끄기는 이미 `calendarContext.busyWith`가 한다.
- **시계로 숨기기**(기본값으로), 경계마다 묻기, "아직 업무 중이세요?", 근무 시간 통계, 연속 기록 같은 게임 요소.
- **AI가 상태를 바꾸기.** AI는 제안만 한다.
- **할 일 하나에 맥락 여러 개.** 애매하면 정하지 않음이고, 그러면 숨지 않는다.
- **상태별 순서를 따로 저장하기.** 묶음 구조 덕분에 필요 없다.
- **상태 기록을 AI에 보내기**, 기기 사이 동기화.
- **v2로 미룸**:
  - 교대 근무표(로테이션)와 밤샘 근무 시간, 자영업 영업시간·육아 등하원 입력기
  - 시험 기간, 프리셋별 맥락 해석 표
  - "오늘은 보이기"(`showOn`)
  - 사이드바 미니 칩·Alt+S·트레이 메뉴·상태 타임라인
  - 할 일 화면 맥락 필터
  - `/상태`로 모르는 상태를 그 자리에서 만들기
  - 출퇴근 시각을 배워 근무 시간을 제안하기
  - 상태 말 학습(적응형 type 확장)
