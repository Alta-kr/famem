# Daynote 코드베이스 버그 리포트

- **점검 일자**: 2026-10-17
- **대상 버전**: `daynote@0.1.0` (`SCHEMA_VERSION = 3`)
- **점검 범위**: Electron 메인 프로세스(`main.js`, `preload.js`, `services/`), 코어 도메인(`src/core/`), 렌더러 UI(`renderer/`), 스크립트 및 패키지 설정(`package.json`)

## 1. 전체 버그 요약표

| ID | 심각도 | 영역 | 파일 및 위치 | 핵심 증상 요약 |
| :--- | :--- | :--- | :--- | :--- |
| **BUG-01** | 높음 | 홈 채팅 · 날짜 변경 | `daynote/renderer/views/chat.js` (330–338, 407–425행) | 시간 정한 할 일(`do_at`)의 날짜 칩을 바꿔도 `work` 블록은 그대로 남아 화면 표시와 오늘 일정이 갱신되지 않음 |
| **BUG-02** | 높음 | 빠른 입력 · 종류 변환 | `daynote/src/core/ai/proposals.js` (493–505, 639–645행) | 완료 보고(`done`)·날짜 변경(`update`) 입력을 메모류로 바꿀 때 기존 할 일의 완료·날짜 변경이 되돌려지지 않음 |
| **BUG-03** | 중간 | 데이터 모델 · 주간 정리 | `daynote/src/core/model.js` (438–452행), `daynote/src/core/weekly.js` (57–59행) | 샘플 데이터 삭제 시 사용자 항목의 `projectId`가 고아 참조로 남아 주간보고에 `### 프로젝트 없음` 섹션이 중복 생성됨 |
| **BUG-04** | 중간 | 렌더러 · 리스너/타이머 | `daynote/renderer/store.js` (141행), `daynote/renderer/views/notes.js` (331행), `daynote/renderer/views/chat.js` (104, 108행) | 메모 화면 진입 시 `statusListeners` 누적 누수 및 홈 화면 이탈 시 휴식 타이머 인터벌(`timerTick`) 미해제 |
| **BUG-05** | 중간 | AI 검증 · 소요 시간 계산 | `daynote/src/core/ai/validate.js` (164–180행) | `14:00~15:30` 또는 `2시~3시 반`처럼 종료 시각에 분이 포함된 범위 표현의 소요 시간 검증 누락 |
| **BUG-06** | 낮음 | AI 연결 확인 · 시간대 | `daynote/main.js` (106–107행) | 한국 시각 오전 0시~9시 사이 `ai:check` 실행 시 `today`가 UTC 날짜로 들어가 기준 시각과 하루 어긋남 |
| **BUG-07** | 낮음 | 테스트 스크립트 | `daynote/package.json` (10행) | `"node --test \"test/*.test.js\""`의 따옴표로 인해 셸 와일드카드 확장이 막혀 `npm test` 실행 실패 |

## 2. 버그별 상세 분석 및 수정 방안

### BUG-01. ‘시간 정한 할 일’(`do_at`)의 날짜 변경 시 작업 시간(`work` 블록) 미반영

- **위치**: `daynote/renderer/views/chat.js` (`dateInfo` 330–338행, `setDate` 407–425행)
- **재현 시나리오**:
  1. 홈 채팅 입력창에 `"30분 후 샤워하기"`를 입력해 할 일(`task`)과 오늘 작업 시간 블록(`work` 블록)이 함께 생성되게 합니다.
  2. 결과 카드의 날짜 칩(예: `오늘 13:50 · 30분`)을 눌러 `내일` 또는 `날짜 없음`을 선택합니다.
  3. `task.dueDate`만 바뀌고 `work` 블록은 그대로 남아, 날짜 칩 문구가 여전히 `오늘 13:50 · 30분 (마감 내일)`로 표시되고 오늘 일정에도 그대로 남습니다.
- **원인**:
  - `dateInfo()`(331행)는 미래의 `work` 블록이 존재하면 `task.dueDate`보다 `work` 블록의 시작 시각을 우선 표시합니다.
  - 반면 `setDate()`(409–413행)는 `it.kind === 'task'`일 때 `M.updateTask()`로 `dueDate`와 `dueTime`만 변경하고 연결된 `work` 블록은 수정하거나 삭제하지 않습니다.
- **권장 수정 코드 (`daynote/renderer/views/chat.js`)**:

```javascript
function setDate(it, ymd, time) {
  var now = DN.app.now();
  if (it.kind === 'task') {
    S.mutate(ymd ? '마감일 바꾸기' : '마감일 지우기', function (s) {
      var work = M.blocksForTask(s, it.item.id).filter(function (b) {
        return b.kind === 'work' && new Date(b.end) > now;
      })[0];
      if (work) {
        if (!ymd) {
          M.deleteBlock(s, work.id);
        } else {
          var ws = new Date(work.start), we = new Date(work.end);
          var len = Math.max(15, Math.round((we - ws) / 60000)) || 30;
          var ns = D.parseYmd(ymd, time || D.hm(ws));
          M.updateBlock(s, work.id, { start: ns.toISOString(), end: D.addMinutes(ns, len).toISOString() });
        }
      }
      M.updateTask(s, it.item.id, ymd ? { dueDate: ymd } : { dueDate: null, dueTime: null }, now);
    }, { source: 'capture' });
    return;
  }
  // 기존 일정(event) 블록 변경 로직 유지
}
```

### BUG-02. 완료 보고(`done`)·날짜 변경(`update`) 글을 메모로 바꿀 때 기존 할 일 상태 미복원

- **위치**: `daynote/src/core/ai/proposals.js` (`captureToMemo` 493–505행, `captureSetKind` 639–645행)
- **재현 시나리오**:
  1. 열린 할 일 `"샤워하기"`가 있는 상태에서 `"샤워 완료"` 또는 `"샤워는 내일 할게"`를 입력합니다.
  2. AI가 기존 할 일을 완료 처리(`note.capture.completed`)하거나 날짜를 변경(`note.capture.updated`)합니다.
  3. 이후 `captureToMemo(state, noteId, now)` 또는 `captureSetKind(state, noteId, 'memo', now)`가 호출되면 `created`만 지워지고 `completed`·`updated`는 복원되지 않은 채 남습니다.
  4. `captureItems()`(747–762행)는 `M.liveCompleted`와 `M.liveUpdated`를 계속 읽으므로, 메모로 바꿨음에도 완료/날짜 변경 줄이 사라지지 않고 기존 할 일도 원래 상태로 돌아가지 않습니다.
- **권장 수정 코드 (`daynote/src/core/ai/proposals.js`)**:

```javascript
function captureToMemo(state, noteId, now) {
  var note = M.byId(state.notes, noteId);
  if (!note || !note.capture) return null;
  (note.capture.created || []).forEach(function (c) {
    if (c.kind === 'task') M.deleteTask(state, c.id, now); else M.deleteBlock(state, c.id);
  });
  (note.capture.completed || []).forEach(function (d) {
    M.reopenTask(state, d.id, now, { undoOf: d.historyId, prevStatus: d.prevStatus });
  });
  (note.capture.updated || []).forEach(function (u) {
    var tk = M.byId(state.tasks, u.id);
    if (tk && u.prev) M.updateTask(state, tk.id, { dueDate: u.prev.dueDate, dueTime: u.prev.dueTime }, now);
    if (u.prevWork) M.updateBlock(state, u.prevWork.id, { start: u.prevWork.start, end: u.prevWork.end });
    if (u.newWorkId) M.deleteBlock(state, u.newWorkId);
  });
  state.proposals.forEach(function (p) {
    if (p.source && p.source.id === noteId && (p.status === 'accepted' || p.status === 'pending')) {
      p.status = 'dismissed';
      p.reviewedAt = iso(now);
    }
  });
  note.captureRole = 'memo';
  note.capture = Object.assign({}, note.capture, {
    entryType: 'memo', created: [], skipped: [], completed: [], updated: [], changedByUser: true
  });
  return note;
}
```

### BUG-03. 샘플 데이터 삭제 후 고아 `projectId`로 인한 주간보고 섹션 중복 및 항목 누락

- **위치**: `daynote/src/core/model.js` (`clearSample` 438–452행), `daynote/src/core/weekly.js` (`summarize` 57–59행)
- **재현 시나리오**:
  1. 샘플 데이터를 불러온 상태에서 샘플 프로젝트(예: `신규 온보딩 개편`)에 사용자 할 일을 추가하고 완료합니다.
  2. 상단 배너 또는 설정에서 `샘플 지우기`를 실행합니다.
  3. 샘플 프로젝트는 삭제되지만 사용자가 만든 할 일과 완료 히스토리의 `projectId`는 삭제된 샘플 프로젝트 ID를 그대로 유지합니다.
  4. `주간 정리` 화면에서 초안을 생성하면 삭제된 프로젝트 ID 그룹(`gk = 'proj_sample...'`)과 원래 프로젝트가 없는 그룹(`gk = ''`)이 모두 `projectName: '프로젝트 없음'`을 가져 `### 프로젝트 없음` 섹션이 두 번 출력됩니다. 또한 `프로젝트` 화면에서는 해당 할 일이 어느 프로젝트 목록에도 나타나지 않습니다.
- **권장 수정 코드 (`daynote/src/core/model.js` 및 `daynote/src/core/weekly.js`)**:

```javascript
// 1) src/core/model.js — clearSample 내부에 고아 projectId 정리 추가
var aliveProj = {};
state.projects.forEach(function (p) { if (!p.deletedAt) aliveProj[p.id] = true; });
['notes', 'tasks', 'blocks', 'history', 'suggestions'].forEach(function (k) {
  state[k].forEach(function (item) {
    if (item.projectId && !aliveProj[item.projectId]) item.projectId = null;
  });
});

// 2) src/core/weekly.js — summarize 내부에서 유효한 프로젝트인지 확인
var rawPid = (task && !task.deletedAt ? task.projectId : h.projectId) || null;
var projObj = rawPid ? M.byId(state.projects, rawPid) : null;
var pid = (projObj && !projObj.deletedAt) ? rawPid : null;
```

### BUG-04. 화면 전환 시 상태 리스너 누적 및 휴식 타이머 인터벌 미해제

- **위치**:
  - `daynote/renderer/store.js` (141행) 및 `daynote/renderer/views/notes.js` (331–334행)
  - `daynote/renderer/views/chat.js` (104, 108–118행)
- **원인**:
  1. `store.onStatus(fn)`는 `store.subscribe(fn)`와 달리 구독 해제 함수를 반환하지 않습니다. `notes.js`는 `unsubStatus` 플래그만 `true`로 바꾸지만 `statusListeners` 배열에서 함수 자체가 제거되지 않아 `notes` 화면을 열 때마다 배열 크기가 계속 증가합니다.
  2. `chat.js`는 휴식 카드 타이머가 작동 중일 때 1초 간격의 `timerTick` 인터벌을 실행하지만, `destroy()`에서 `clearInterval(timerTick)`을 호출하지 않습니다.
- **권장 수정 코드**:

```javascript
// 1) renderer/store.js (141행)
onStatus: function (fn) {
  statusListeners.push(fn);
  fn(saveStatus);
  return function () {
    statusListeners = statusListeners.filter(function (f) { return f !== fn; });
  };
},

// 2) renderer/views/notes.js (331–334행)
var offStatus = S.onStatus(function () { if (ed) setStatus(); });
return {
  destroy: function () { flushPending(); offStatus(); offAi(); root.style.overflow = ''; },
  // ...
};

// 3) renderer/views/chat.js (104행)
return {
  refresh: paintList,
  focus: function () { ta.focus(); },
  destroy: function () { clearInterval(timerTick); offAi(); }
};
```

### BUG-05. 분 단위가 포함된 시간 범위(`14:00~15:30`, `2시~3시 반`)의 소요 시간 검증 누락

- **위치**: `daynote/src/core/ai/validate.js` (`checkDuration` 164–180행)
- **원인**:
  - `var range = src.match(/(\d{1,2})\s*(?:시|:\d{2})?\s*[~\-–]\s*(\d{1,2})\s*시/);` 정규식이 종료 시각 뒤에 오는 `:30`, `30분`, `반`을 처리하지 못합니다.
  - 따라서 `"14:00~15:30 회의"`는 정규식 자체가 매칭되지 않고, `"2시~3시 반 회의"`는 종료 시각을 3시 정각으로 계산해 AI가 `90`분을 반환하면 불일치(`confirm`) 상태로 빠집니다.
- **권장 수정 코드 (`daynote/src/core/ai/validate.js`)**:

```javascript
var range = src.match(/(\d{1,2})\s*(?:시(?:\s*(\d{1,2})\s*분|\s*(반))?|:(\d{2}))?\s*[~\-–]\s*(\d{1,2})\s*(?:시(?:\s*(\d{1,2})\s*분|\s*(반))?|:(\d{2}))/);
var span = null;
if (range && startTime) {
  var sh = +startTime.slice(0, 2), sm = +startTime.slice(3);
  var eh = +range[5];
  var em = range[6] != null ? +range[6] : range[7] ? 30 : range[8] != null ? +range[8] : 0;
  if (eh <= 12 && sh >= 12) eh += 12;
  if (eh * 60 + em > sh * 60 + sm) span = (eh * 60 + em) - (sh * 60 + sm);
}
```

### BUG-06. `ai:check` 연결 확인 시 UTC 날짜 사용으로 인한 오전 시간대 날짜 불일치

- **위치**: `daynote/main.js` (103–111행)
- **원인**:
  - `today: now.toISOString().slice(0, 10)`은 UTC 기준 날짜를 반환하므로, 한국 표준시(`Asia/Seoul`, UTC+9) 기준 오전 00:00~08:59 사이에 연결 확인을 실행하면 `today`가 전날 날짜로 설정됩니다.
- **권장 수정 코드 (`daynote/main.js`)**:

```javascript
ipcMain.handle('ai:check', async () => {
  const capture = require('./src/core/ai/capture');
  const dates = require('./src/core/dates');
  const now = new Date();
  const input = capture.buildInput(
    { id: 'check-' + now.getTime(), title: '', body: '내일까지 견적서 보내기', updatedAt: now.toISOString() },
    { today: dates.ymd(now), timezone: 'Asia/Seoul', projects: [], openTasks: [] }
  );
  const t0 = Date.now();
  const r = await ai.organize(input);
  return r.ok ? { ok: true, ms: Date.now() - t0, model: r.model } : { ok: false, ms: Date.now() - t0, error: r.error };
});
```

### BUG-07. `package.json`의 `npm test` 스크립트 글로브 따옴표 오류

- **위치**: `daynote/package.json` (10행)
- **원인**:
  - `"test": "node --test \"test/*.test.js\""`에서 큰따옴표가 셸의 와일드카드(`*`) 확장을 막아 Node 실행 환경에 따라 `Could not find '.../test/*.test.js'` 오류로 종료됩니다.
- **권장 수정 코드 (`daynote/package.json`)**:

```json
"scripts": {
  "start": "electron .",
  "smoke": "electron . --profile=smoke --smoke",
  "test": "node --test",
  "serve": "node scripts/serve.js",
  "postinstall": "node scripts/fix-electron.js",
  "shots": "electron . --profile=shots --shots"
}
```

## 3. 수정 적용 체크리스트

- [x] `daynote/renderer/views/chat.js`: `setDate()`에서 할 일의 `work` 블록 날짜 동기화 및 삭제 처리
- [x] `daynote/src/core/ai/proposals.js`: `captureToMemo()`에서 `completed` 및 `updated` 항목 원상 복구 처리
- [x] `daynote/src/core/model.js` & `weekly.js`: `clearSample()` 실행 시 고아 `projectId` 정리 및 `summarize()` 프로젝트 유효성 검사
- [x] `daynote/renderer/store.js`, `notes.js`, `chat.js`: `onStatus` 구독 해제 함수 반환 및 `timerTick` 인터벌 해제
- [x] `daynote/src/core/ai/validate.js`: `checkDuration()`의 종료 시각 분 단위 파싱 보완
- [x] `daynote/main.js`: `ai:check` 핸들러에서 `dates.ymd(now)` 사용
- [x] `daynote/package.json`: `test` 스크립트 수정 후 `npm test` 통과 확인 (아래 4장의 BUG-07 참고 — 권장안과 다르게 고침)

## 4. 수정 결과 및 검토 의견 (2026-10-17, Claude)

### 4.1 확인 결과

7개 모두 실제 코드에서 재현 또는 원인을 확인했습니다. BUG-07은 환경에 따라 다릅니다. Node 21 이상은 따옴표로 감싼 글로브를 Node가 직접 풀어서 동작하고, 그보다 낮은 버전에서만 실패합니다.

| ID | 고친 내용 | 검증 |
| :--- | :--- | :--- |
| BUG-01 | 날짜 칩을 바꾸면 미래의 `work` 블록도 같은 날로 옮기고, "날짜 없음"이면 지운다 | 브라우저 미리보기: "30분 후 샤워하기" → 내일로 바꾸니 칩이 "내일(일) 14:15", 오늘 일정은 비어 있음 |
| BUG-02 | `captureToMemo()`에서 완료 보고를 취소하고(`undoOf`로 완료 기록 삭제), 날짜 변경도 원래 마감·작업 시간으로 되돌림. `completed`·`updated`도 비움 | `test/bugfix-1017.test.js` 2건 |
| BUG-03 | 리포트 권장안 두 가지(`clearSample` 고아 참조 정리, `summarize` 유효성 검사)를 모두 적용 | 테스트 1건. 예전 데이터처럼 고아 참조가 남아 있어도 "프로젝트 없음" 섹션은 하나만 생김 |
| BUG-04 | `onStatus`가 구독 해제 함수를 반환하고, `notes.js`의 `destroy`에서 호출함. `chat.js`의 `destroy`에서 `timerTick`을 해제함 | 코드 수정만 함 (자동 테스트 없음) |
| BUG-05 | 끝 시각의 `:mm`, `N분`, `반`까지 읽고 시작 시각의 분도 반영 | 테스트 1건: `14:00~15:30`, `2시~3시 반`, `2시~4시` |
| BUG-06 | `ai:check`에서 `dates.ymd(now)`로 현지 날짜를 사용 | 코드 수정만 함 |
| BUG-07 | `"test": "node --test"` (아래 4.2 참고) | `npm test` 127/127 통과 |

- 전체 테스트 127/127 통과. 새 회귀 테스트는 4건(`test/bugfix-1017.test.js`)입니다.
- `npm run smoke`(숨김 창): `rendered:true`, `consoleErrors:[]`

### 4.2 권장안과 다르게 고친 부분 — BUG-07

권장안(`node --test test/*.test.js`, 따옴표 제거)은 Windows에서 오히려 깨질 수 있습니다. npm은 Windows에서 스크립트를 `cmd.exe`로 실행하는데, `cmd.exe`는 `*`를 풀어 주지 않습니다. 그래서 이 방식은 셸이 글로브를 풀어 주는 macOS·Linux에서만 확실히 동작합니다.

대신 인자 없이 `node --test`를 쓰도록 바꿨습니다. Node의 기본 탐색 규칙이 `test/` 폴더의 파일과 `*.test.js`를 찾고 `node_modules`는 제외합니다. 이 방식은 셸 종류나 Node 버전(18 이상)과 상관없이 같은 결과를 냅니다.

### 4.3 남은 의견

- BUG-04는 화면 동작이라 자동 테스트가 없습니다. 메모 화면을 여러 번 오간 뒤 `statusListeners` 길이가 늘지 않는지 확인하는 브라우저 점검을 추가할 만합니다.
- BUG-06은 `main.js`에 있어 테스트에서 직접 부를 수 없습니다. 날짜 계산을 `src/core`의 함수로 빼면 테스트할 수 있습니다.
- 1차 수정은 커밋 `87a01a1`로 올렸습니다.

## 5. 1차 패치 코드 리뷰 및 2차 보완 지시서 (Claude 작업용)

1차 패치(`BUG-01` ~ `BUG-07`)와 `test/bugfix-1017.test.js`를 검증한 결과, 127개 단위 테스트가 모두 통과하며 특히 `BUG-07`을 `"test": "node --test"`로 수정해 Windows `cmd.exe` 호환성까지 확보한 점이 좋습니다.

다만 적용된 패치 코드를 상세 대조한 결과 **3가지 경계 조건(엣지 케이스)**과 **4.3장의 테스트 가능성 개선 항목**이 남아 있어, 아래 명세에 따라 2차 보완을 진행해 주세요.

### 5.1 BUG-01 보완: `do_at`(시간 정한 할 일) 날짜 변경 시 불필요한 `dueDate` 생성 방지

- **위치**: `daynote/renderer/views/chat.js` (`dateInfo` 330–338행, `setDate` 407–426행)
- **문제 원인**:
  - `"30분 후 샤워하기"`처럼 할 시각(`do_at`)만 있고 마감일(`dueDate`)은 `null`인 할 일에서 날짜 칩을 눌러 `내일`로 바꾸면, 412–421행에서 `work` 블록을 옮긴 뒤 **422행의 `M.updateTask(s, it.item.id, { dueDate: ymd })`까지 무조건 실행**됩니다.
  - 그 결과 원래 마감이 없던 `do_at` 할 일에 `dueDate`가 생겨버리고, `dateInfo()`(335행)는 `work` 블록과 `dueDate`가 둘 다 있으면 `(마감 ...)`을 덧붙이므로 칩 문구가 **`내일(일) 14:15 · 30분 (마감 내일(일))`로 중복 표시**됩니다.
- **수정 방안 (`daynote/renderer/views/chat.js`)**:
  - `work` 블록이 존재하는 할 일에서 날짜를 바꿀 때, 원래 `it.item.dueDate`가 없었던 경우(`!it.item.dueDate`)에는 `work` 블록만 이동(또는 `ymd === null`일 때 삭제)하고 `dueDate`는 새로 설정하지 않도록 분기합니다.

```javascript
function setDate(it, ymd, time) {
  var now = DN.app.now();
  if (it.kind === 'task') {
    S.mutate(ymd ? '날짜 바꾸기' : '날짜 지우기', function (s) {
      var work = M.blocksForTask(s, it.item.id).filter(function (b) { return b.kind === 'work' && new Date(b.end) > now; })[0];
      if (work) {
        if (!ymd) {
          M.deleteBlock(s, work.id);
          M.updateTask(s, it.item.id, { dueDate: null, dueTime: null }, now);
        } else {
          var ws = new Date(work.start);
          var wlen = Math.max(15, Math.round((new Date(work.end) - ws) / 60000)) || 30;
          var wn = D.parseYmd(ymd, time || D.hm(ws));
          M.updateBlock(s, work.id, { start: wn.toISOString(), end: D.addMinutes(wn, wlen).toISOString() });
          // 원래 마감일(dueDate)도 함께 있던 할 일만 마감일을 갱신하고, 순수 do_at 할 일은 dueDate: null 유지
          if (it.item.dueDate) M.updateTask(s, it.item.id, { dueDate: ymd }, now);
        }
        return;
      }
      M.updateTask(s, it.item.id, ymd ? { dueDate: ymd } : { dueDate: null, dueTime: null }, now);
    }, { source: 'capture' });
    return;
  }
  // 기존 일정(event) 블록 변경 로직 유지
}
```

### 5.2 BUG-02 보완: 완료 보고(`done`)·날짜 변경(`update`) 글을 `task` 또는 `event`로 바꿀 때 기존 할 일 복원 누락

- **위치**: `daynote/src/core/ai/proposals.js` (`captureToMemo` 493–515행, `captureSetKind` 634–682행, `captureSetItemKind` 687–716행)
- **문제 원인**:
  - `captureSetKind()`에서 `memo`·`idea`·`link`(`NOTE_KIND[kind]`)로 바꿀 때는 `captureToMemo()`가 호출되어 `completed`·`updated`가 원상 복구됩니다.
  - 그러나 사용자가 `"샤워 완료"` 또는 `"견적서는 내일 보낼게"` 카드에서 종류를 **`할 일(task)`이나 `일정(event)`으로 바로 바꾸면**, `captureToMemo()`를 거치지 않고 660행의 `if (!live.length) { var t0 = captureToTask(state, noteId, now); ... }`로 진입합니다.
  - 이 경우 새 할 일/일정이 만들어지면서도 기존 할 일의 완료(`completed`)나 날짜 변경(`updated`)이 취소되지 않고 그대로 남으며, 결과 카드에도 새 할 일 줄과 완료/날짜 변경 줄이 동시에 남습니다.
- **수정 방안 (`daynote/src/core/ai/proposals.js`)**:
  - `completed`·`updated` 복원 로직을 `revertReported(state, note, now)` 헬퍼로 분리해 `captureToMemo()`와 `captureSetKind()`(할 일/일정으로 바꿀 때) 양쪽에서 모두 호출합니다.

```javascript
function revertReported(state, note, now) {
  if (!note || !note.capture) return;
  (note.capture.completed || []).forEach(function (d) {
    M.reopenTask(state, d.id, now, { undoOf: d.historyId, prevStatus: d.prevStatus });
  });
  (note.capture.updated || []).forEach(function (u) {
    var tk = M.byId(state.tasks, u.id);
    if (tk && u.prev) M.updateTask(state, tk.id, { dueDate: u.prev.dueDate, dueTime: u.prev.dueTime }, now);
    if (u.prevWork) M.updateBlock(state, u.prevWork.id, { start: u.prevWork.start, end: u.prevWork.end });
    if (u.newWorkId) M.deleteBlock(state, u.newWorkId);
  });
  note.capture = Object.assign({}, note.capture, { completed: [], updated: [] });
}
```

- `captureSetKind()`에서는 `if (!live.length)` 분기 직전에 `revertReported(state, note, now);`를 호출하면 완료 보고·날짜 변경을 `task`나 `event`로 바꿀 때도 기존 할 일이 깨끗하게 복원됩니다.

### 5.3 BUG-05 보완: 오전에서 오후로 정오(12:00)를 넘기는 시간 범위(`11시~1시`) 검증 누락

- **위치**: `daynote/src/core/ai/validate.js` (`checkDuration` 164–176행)
- **문제 원인**:
  - 173행의 `if (eh <= 12 && sh >= 12) eh += 12;` 조건은 시작 시각이 오후(`sh >= 12`)일 때만 종료 시각(`eh`)에 12시간을 더합니다.
  - 따라서 `"11시~1시 점심 회의"` 또는 `"오전 10시~2시 워크숍"`처럼 시작은 오전(`sh = 10` 또는 `11`)이고 종료가 오후 12시 표기(`eh = 1` 또는 `2`)인 경우 `eh += 12`가 실행되지 않아 `eh * 60 + em > sh * 60 + sm` 조건이 거짓이 되고 소요 시간(`span`)이 `null`이 됩니다.
- **수정 방안 (`daynote/src/core/ai/validate.js` 173행)**:
  - 종료 시각(`eh`)이 1~11시이면서 시작 시각(`sh`)보다 작을 때도 오후로 해석하도록 조건을 보완합니다.

```javascript
if (eh <= 12 && (sh >= 12 || (eh < 12 && eh < sh))) eh += 12;
```

### 5.4 4.3장 남은 의견 보완: `BUG-04` 단위 테스트 가능 구조 및 회귀 테스트 추가

- **`store.test.js` 또는 `bugfix-1017.test.js`에서 `onStatus` 해제 검증**:
  - `renderer/store.js`의 `onStatus` 구독 해제는 브라우저 DOM 없이도 `store.test.js` 방식으로 즉시 단위 테스트가 가능합니다(구독 등록 후 반환된 `off()`를 호출하고 상태 변경 시 콜백이 더 이상 호출되지 않는지 확인).
- **`test/bugfix-1017.test.js`에 추가할 회귀 테스트 목록**:
  1. `BUG-02 보완`: 완료 보고(`"샤워 완료"`) 또는 날짜 변경(`"견적서는 내일 보낼게"`)을 `captureSetKind(st, note.id, 'task', NOW)`로 바꿨을 때 기존 할 일의 완료·날짜 변경이 원래대로 돌아오고 새 할 일 1개만 남는지 확인.
  2. `BUG-05 보완`: `dur('월요일 오전 11시~1시 회의', '월요일 오전 11시', '11:00', 120)`이 `[120, 'ok']`를 반환하는지 확인.

### 5.5 2차 보완 체크리스트

- [x] `daynote/renderer/views/chat.js`: `setDate()`에서 `work` 블록만 있던 할 일(`!it.item.dueDate`)의 날짜 변경 시 `dueDate`가 새로 생기지 않도록 수정
- [x] `daynote/src/core/ai/proposals.js`: `revertReported()` 분리 및 `captureSetKind()`에서 `task`/`event`로 변경할 때도 `completed`·`updated` 복원 적용
- [x] `daynote/src/core/ai/validate.js`: `checkDuration()`에서 정오를 넘기는 시간 범위(`11시~1시` 등) 계산 조건 보완
- [x] `daynote/test/bugfix-1017.test.js`: 위 2차 보완 항목(`BUG-02` 할 일/일정 변환 복원, `BUG-05` 정오 넘김 범위) 및 `onStatus` 구독 해제 회귀 테스트 추가
## 6. 2차 보완 결과 (2026-10-17, Claude)

| 항목 | 고친 내용 | 검증 |
| :--- | :--- | :--- |
| 5.1 | 작업 시간이 있는 할 일은 작업 시간만 옮기고, 마감은 원래 마감이 있던 경우에만 함께 옮김. "날짜 없음"이면 작업 시간과 마감을 지움. 판단은 렌더링 시점 스냅샷(`it.item`)이 아니라 변경 시점의 상태(`s.tasks`)로 함 | 브라우저 미리보기: "30분 후 샤워하기" → 내일: 칩 "내일(일) 14:50 · 30분", `dueDate` null 유지 / 날짜 없음: 작업 시간 삭제 |
| 5.2 | `revertReported()`로 분리해 `captureToMemo()`와 `captureSetKind()`(할 일·일정으로 바꿀 때) 양쪽에서 호출. `captureSetKind`에서는 원문 드러내기 보류(`__holdReveal`) 구간 안에서 호출해, 되돌리는 도중 원문이 메모로 잠깐 드러나는 일을 막음 | 테스트 2건: 완료 보고 → 할 일·일정, 날짜 바꾸기 → 할 일 |
| 5.3 | 권장 조건 `eh <= 12 && (sh >= 12 \|\| (eh < 12 && eh < sh))` 적용 | 테스트: `11시~1시`=120, `10시~2시`=240, `9시~11시`=120, `10시~12시`=120 |
| 5.4 | `store.test.js`와 같은 방식(vm으로 `store.js` 로드)으로 `onStatus` 해제 테스트 추가 | 해제한 리스너는 저장 상태가 바뀌어도 불리지 않음 |

- 전체 테스트 131/131 통과. `test/bugfix-1017.test.js`는 8건이 됐습니다.
- `npm run smoke`(숨김 창): `rendered:true`, `consoleErrors:[]`
- 이 2차 보완도 커밋해 올렸습니다.
