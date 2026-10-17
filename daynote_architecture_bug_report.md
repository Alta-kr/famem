# Daynote 아키텍처 구조 점검 및 신규 버그 리포트

- **점검 일자**: 2026-10-17
- **대상 버전**: `daynote@0.1.0` (`SCHEMA_VERSION = 3`, `capture.v7`, 기존 단위 테스트 149/149 통과 본)
- **점검 범위**: 첨부 아키텍처 다이어그램 기준 전 계층 — 메인 프로세스(`main.js`, `services/ai.js`, `services/keystore.js`), IPC 브리지(`preload.js`, `quick-preload.js`), 렌더러 뷰(`renderer/views/*`), 흐름(`assistant.js`, `capture.js`, `palette.js`, `aiflow.js`), 공통(`app.js`, `ui.js`, `store.js`, `editor.js`, `rules.js`), 코어 규칙·AI 검증(`src/core/*`)

## 1. 아키텍처 구조 대조 및 점검 개요

첨부된 구조도의 두 축인 **메인 프로세스(Node)**와 **렌더러(화면)** 및 그 사이의 **IPC 경계**를 실제 코드베이스와 대조한 결과는 다음과 같습니다.

| 구조도 계층 | 구성 모듈 | 실제 코드 매핑 및 역할 | 구조 점검 결과 |
| :--- | :--- | :--- | :--- |
| **메인 프로세스** | `main.js` | 창·트레이·빠른 메모 창(`quickWindow`)·전역 단축키·원자적 파일 저장(`daynote-data.json` + `.bak`) | 정상 분리됨 |
| **메인 프로세스** | `services/ai.js` | Gemini(`3.5-flash-lite` / `3.8-flash` 2단 호출)·Claude 호출, 환경변수 키 격리(`captureEnvKeys`), 오류 키 가림(`redact`) | **폴백 조건 누락 발견 (`BUG-NEW-09`)** |
| **메인 프로세스** | `services/keystore.js` | `.env` 로드 및 Electron `safeStorage`(Windows DPAPI) 기반 API 키 암호화 보관 | 정상 분리됨 |
| **IPC 경계** | `preload.js` · `quick-preload.js` | `contextBridge`로 `window.daynoteHost` 및 `window.daynoteQuick` 최소 권한 노출 | 정상 분리됨 |
| **렌더러 · 뷰** | `renderer/views/*` | `today`, `chat`, `calendar`, `tasks`, `notes`, `archive`, `projects`, `weekly`, `inbox`, `detail`, `schedule`, `review`, `settings` | **뷰 상태·표시 버그 다수 발견 (`BUG-NEW-04`, `05`, `07`, `10`)** |
| **렌더러 · 흐름** | `assistant` · `capture` · `palette` · `aiflow` | 채팅 도우미·명령 실행, 빠른 입력 분류 파이프라인, `Ctrl+K` 명령 팔레트, 메모 AI 정리 흐름 | **명령 분류 시 원문 유실 및 시각 배치 버그 발견 (`BUG-NEW-01`, `07`)** |
| **렌더러 · 공통** | `app` · `ui` · `store` · `editor` · `rules` | 앱 셸·단축키, 공용 DOM/메뉴/칩, 상태 저장소(`mutate`/`undo`/`flush`), 마크다운 에디터 | **`store.flush` 비동기 경합 발견 (`BUG-NEW-09`)** |
| **렌더러 · 코어** | `src/core/*` (`ai/*` 포함) | UMD 모듈로 화면과 Node 테스트가 공유하는 순수 도메인 규칙 및 AI 응답 검증·초안 반영 | **검증 정규식·상태 변환·주간 요약 버그 발견 (`BUG-NEW-01`, `02`, `03`, `06`, `08`)** |

기존 `daynote_bug_report.md`의 1·2차 패치 항목(`BUG-01`~`BUG-07`)은 모두 코드에 반영되어 149개 단위 테스트를 통과하고 있으나, 전체 아키텍처의 데이터 흐름과 경계 조건을 전수 추적한 결과 **총 10건의 신규 버그(`BUG-NEW-01` ~ `BUG-NEW-10`)**를 확인했습니다.

## 2. 신규 발견 버그 요약표

| ID | 심각도 | 계층 / 영역 | 파일 및 위치 | 핵심 증상 요약 |
| :--- | :--- | :--- | :--- | :--- |
| **BUG-NEW-01** | 높음 | 코어 AI · 흐름 (`proposals`, `capture`, `app`) | `src/core/ai/proposals.js` (412, 425행), `renderer/capture.js` (94–96행), `renderer/app.js` (291–299행) | AI가 `entry_type: 'command'`로 분류했을 때 명령 검증(`resolve`)이 실패하거나 `Ctrl+N` 빠른 메모에서 입력하면 **명령도 실행되지 않고 원문 메모가 영구 삭제(유실)**됨 |
| **BUG-NEW-02** | 높음 | 코어 AI 검증 (`validate`) | `src/core/ai/validate.js` (327–337행), `src/core/ai/proposals.js` (451행) | 할 일 제목에 `'후'`·`'뒤'` 글자가 포함된 경우(예: 샘플 할 일 `"세미나 장소 후보 알아보기"`, `"오후 회의"`) `"두 시간 미뤄줘"` 같은 마감 연장이 `shiftMinutes` 정규식 오류로 무조건 실패함 |
| **BUG-NEW-03** | 높음 | 코어 AI 검증 (`validate`) | `src/core/ai/validate.js` (164–176행) | 일정 소요 시간 검증(`checkDuration`)에서 `12:00~12:30`을 **750분(12시간 30분)**으로 오산하고, `"오후 2시~오후 4시"`처럼 종료 시각 앞에 `오전/오후`가 붙은 범위를 인식하지 못함 |
| **BUG-NEW-04** | 중간 | 렌더러 뷰 · 공통 (`archive`, `ui`) | `renderer/views/archive.js` (11–12, 40–47, 66–75, 173–194행), `renderer/ui.js` (294–299행) | 보관함에서 완료 보고(`done`)·날짜 변경(`moved`) 항목의 종류 칩이 누락되고, 검색 결과에 **`"undefined: [할 일 제목]"`**이 노출되며, 할 일 필터 및 클릭 이동이 동작하지 않음 |
| **BUG-NEW-05** | 중간 | 렌더러 뷰 · 코어 모델 (`detail`, `model`, `sample`) | `renderer/views/detail.js` (37–44행), `src/core/model.js` (72–87, 185–193행), `renderer/sample.js` (66행) | 상세 패널에서 `'진행 중'` 할 일을 `'할 일'`/`'대기'`로 바꿀 때 작업 시계(`runningSince`)가 멈추지 않고, `'대기'` 상태에서 `'진행 중'` 전환이 거부되며, 샘플 `'진행 중'` 할 일의 작업 시간이 0분으로 고정됨 |
| **BUG-NEW-06** | 중간 | 코어 AI (`proposals`) | `src/core/ai/proposals.js` (626, 648–703, 782행) | 할 일 ↔ 일정 변환(`taskToBlock`/`blockToTask`) 시 누적 작업 시간(`workedMs`)·이어서 할 메모(`resumeNote`)·주간 목표(`weekGoal`)·샘플 표시(`sample`)가 유실되고, 다중 줄 카드에서 완료된 할 일이 일정으로 변환되어 삭제됨 |
| **BUG-NEW-07** | 중간 | 렌더러 뷰 · 흐름 (`chat`, `assistant`) | `renderer/views/chat.js` (429, 436, 443, 714–722행), `renderer/assistant.js` (287–296행) | 시간 정한 할 일(`do_at`)의 날짜 메뉴를 열면 항상 **`✓ 날짜 없음`**으로 잘못 체크되어 표시되고, `'오늘 저녁'` 선택 시 빈 시간이 다음 날 아침으로 밀려도 **`"오늘 저녁 08:00"`**로 잘못 안내됨 |
| **BUG-NEW-08** | 중간 | 코어 주간 정리 · 추천 (`weekly`, `projects`, `recommend`) | `src/core/weekly.js` (78행), `renderer/views/projects.js` (117, 125행), `src/core/recommend.js` (248–256행) | 주간 정리 보고서(`unfinished`)와 프로젝트 진행 현황에서 일시 정지(`paused`) 상태 할 일이 누락되며, 추천 지문(`signature`) 계산에 수동 정렬 순서(`sortOrder`)가 빠져 있음 |
| **BUG-NEW-09** | 중간 | 메인 AI · 렌더러 저장소 (`services/ai`, `store`, `quick`) | `services/ai.js` (198–224, 243–246행), `renderer/store.js` (92–112, 180–184행), `renderer/quick.js` (24–35행) | Gemini 1차 모델이 `incomplete`/`failed` 반환 시 2차 모델 폴백이 작동하지 않고, `store.flush()` 진행 중 창을 닫으면 저장 완료 전에 앱이 종료되며, 빠른 메모 창에서 Enter 연타 시 중복 전송됨 |
| **BUG-NEW-10** | 낮음 | 렌더러 뷰 · 코어 명령 (`notes`, `inbox`, `model`, `commands`) | `renderer/views/notes.js` (18–19행), `renderer/views/inbox.js` (86–91, 126행), `src/core/model.js` (487–507행), `src/core/ai/commands.js` (83–86, 117–122행) | 메모 화면 첫 진입 시 숨겨진 `task_source` 원문이 노출되고, 제안함에서 샘플 로드 시 목록이 갱신되지 않으며, 샘플 삭제 후 채팅에 고아 카드가 남고, 없는 할 일 세분화 요청 시 엉뚱한 할 일을 쪼개는 문제 |

## 3. 버그별 상세 분석 및 권장 수정 방안

### BUG-NEW-01. `entry_type: 'command'` 분류 시 명령 검증 실패 또는 `Ctrl+N` 빠른 메모 경로에서 원문 메모 영구 유실

- **위치**:
  - `daynote/src/core/ai/proposals.js` (`applyCapture` 412, 425행)
  - `daynote/renderer/capture.js` (`classify` 94–96행)
  - `daynote/renderer/app.js` (`saveQuick` 291–299행)
  - `daynote/renderer/views/chat.js` (`captureCard` 204행)
- **재현 시나리오**:
  1. **시나리오 A (명령 검증 탈락 시 증발)**: 사용자가 홈 채팅에 애매한 요청 문장을 입력했을 때 AI가 `entry_type: 'command'`를 반환했으나 `commands` 배열이 비어 있거나 `CMD.resolve()` 검증(인용구 불일치, 잘못된 `view` 이름 등)에서 걸러져 `cmds = []`가 됩니다. 이때 `applyCapture()`(425행)는 `note.deletedAt = iso(now)`로 메모를 삭제하고, `chat.js`(204행)는 `if (n.deletedAt && c.entryType === 'command') return null;`로 결과 카드를 숨기며, 실행할 `cmds`도 없어 아무 응답도 나오지 않은 채 **사용자 입력이 메모·보관함·채팅 결과에서 완전히 사라집니다.**
  2. **시나리오 B (`Ctrl+N` 빠른 메모 모달에서 입력 시 증발)**: `Ctrl+N` 빠른 메모 창(`app.js` `saveQuick()`)은 `assistant.send()`를 거치지 않고 `DN.capture.submit(text, projectId)`를 `onDone` 콜백 없이 호출합니다. 여기서 명령형 문장(예: `"오늘 할 일 보여줘"`, `"회의록 찾아줘"`)을 저장하면 채팅창에는 애초에 메시지가 올라가지 않고 `onDone`이 없어 명령도 실행되지 않는데, `applyCapture()`가 `note.deletedAt = iso(now)`를 설정해 **작성한 메모가 흔적도 없이 삭제됩니다.**
- **원인**:
  - `applyCapture()`가 `CMD.resolve()` 결과를 확인하지 않고 `out.entry_type === 'command'` 문자열만 보고 `note.deletedAt = iso(now)`를 수행합니다.
  - 또한 `capture.submit()`이 채팅 입력(`assistant.send`)에서 호출되었는지, 일반 빠른 메모(`app.saveQuick`)에서 호출되었는지 구분하지 않습니다.
- **권장 수정 코드 (`daynote/src/core/ai/proposals.js` 및 `daynote/renderer/capture.js`)**:

```javascript
// 1) src/core/ai/proposals.js — applyCapture 내부 (411~426행)
// args.commands 가 실제로 1개 이상 검증되었고 채팅에서 보낸 경우에만 command 로 삭제 처리
var validCmds = Array.isArray(args.commands) ? args.commands : [];
if (entryType === 'command') {
  entryType = created.length || reported ? 'mixed' : (validCmds.length ? 'command' : 'memo');
}
if (entryType === 'done' && !completed.length) entryType = updated.length ? 'update' : 'memo';
if (entryType === 'update' && !updated.length) entryType = completed.length ? 'done' : 'memo';
if (entryType === 'task' && !created.length) entryType = 'memo';

var keepLink = note.kindByUser ? note.kind === 'link' : out.note_kind === 'link';
var sourceOnly = entryType === 'task' || entryType === 'done' || entryType === 'update';
note.captureRole = sourceOnly && !skipped.length && !keepLink ? 'task_source' : 'memo';
if (!note.title && note.captureRole === 'memo' && out.note_title) note.title = String(out.note_title).trim().slice(0, 80);
if (!note.kindByUser) note.kind = NOTE_KIND[out.note_kind] ? out.note_kind : (note.kind || 'memo');
if (entryType === 'command') { note.captureRole = 'memo'; note.deletedAt = iso(now); }

// 2) renderer/capture.js — classify 내부 (90~97행)에서 resolve 를 먼저 계산해 applyCapture 에 전달
S.mutate('AI 분류', function (s) {
  var r = M.byId(s.aiRuns, run.id);
  Object.assign(r, { provider: res.provider || r.provider, model: res.model || r.model });
  P.finishRun(s, run.id, { status: 'succeeded', rawOutput: res.raw || JSON.stringify(res.output), usage: res.usage || null, dropped: v.dropped }, t);
  cmds = DN.aiCommands.resolve(s, sent, res.output.commands, focus);
  cap = P.applyCapture(s, { note: sent, run: r, validated: v, output: res.output, commands: cmds }, t);
}, { source: 'capture' });
```

### BUG-NEW-02. 할 일 제목에 ‘후’·‘뒤’가 포함된 경우(`"세미나 장소 후보 알아보기"` 등) 마감 연장(`shiftMinutes`) 실패

- **위치**: `daynote/src/core/ai/validate.js` (`shiftMinutes` 327–337행)
- **재현 시나리오**:
  1. 샘플 데이터에 기본 포함된 할 일 `"세미나 장소 후보 알아보기"`(또는 `"오후 회의 준비"`, `"점심 이후 집중 시간 확보"`, `"뒤풀이 장소 예약"`)가 있는 상태에서 `"세미나 장소 후보 알아보기 두 시간 미뤄줘"`를 입력합니다.
  2. `V.shiftMinutes("세미나 장소 후보 알아보기 두 시간 미뤄줘")`가 **`null`**을 반환하고, `V.verifyWhen()`도 상대 시각 기준어(`후/뒤`)가 없어 `null`을 반환합니다.
  3. 결과적으로 `changeDue()`가 `null`을 반환하여 할 일 마감이 전혀 변경되지 않습니다.
- **원인**:
  - 329행 `if (/(후|뒤|있다가|이따)\s*(로|에)?/.test(s.replace(/(미뤄|늦춰|연장|미루|늦추)[^\s]*/g, ''))) return null;`에서 `(로|에)?`가 선택적(`?`)이기 때문에, 문장 어디에든 `'후'`나 `'뒤'` 한 글자만 들어 있어도(`후보`, `오후`, `이후`, `뒤풀이` 등) `"~후로 미뤄줘"`(현재 시각 기준 상대 시각)로 오판해 `null`을 반환합니다.
- **권장 수정 코드 (`daynote/src/core/ai/validate.js` 327–337행)**:

```javascript
// 시간 표현 바로 뒤에 '후/뒤/있다가/이따'가 붙을 때만 상대 시각(relativeAt)으로 넘기고,
// 할 일 제목 속 '후보'·'오후'·'뒤풀이' 등에는 반응하지 않도록 수정
function shiftMinutes(text) {
  var s = String(text || '');
  if (/(\d+|한|두|세|네|다섯|여섯|반)\s*(?:시간(?:\s*반)?(?:\s*\d+\s*분)?|분)\s*(?:후|뒤|있다가|이따)/.test(s)) return null;
  var m = s.match(/(\d+|한|두|세|네|다섯|여섯|반)\s*시간\s*(반)?\s*(?:(\d+)\s*분)?\s*(?:더\s*|만\s*|정도\s*)?(?:미뤄|미루|늦춰|늦추|연장)/);
  if (m) {
    var h = m[1] === '반' ? 0.5 : (KNUM[m[1]] || +m[1]);
    return Math.round(h * 60) + (m[2] ? 30 : 0) + (m[3] ? +m[3] : 0);
  }
  m = s.match(/(\d+)\s*분\s*(?:더\s*|만\s*|정도\s*)?(?:미뤄|미루|늦춰|늦추|연장)/);
  return m ? +m[1] : null;
}
```

### BUG-NEW-03. `checkDuration()`에서 `12:00~12:30`을 750분으로 오산 및 종료 시각 앞 `오전/오후` 수식어 미인식

- **위치**: `daynote/src/core/ai/validate.js` (`checkDuration` 164–176행)
- **재현 시나리오**:
  1. `"월요일 12:00~12:30 점심 회의"`(또는 `"오후 12시~12시 반 회의"`)를 입력하고 AI가 `start.time = "12:00"`, `duration_minutes = 30`을 반환합니다.
  2. `checkDuration`이 메모 기준 소요 시간을 **750분(12시간 30분)**으로 계산하여 `{ status: 'confirm', message: '메모 기준 소요 시간과 AI 값이 다릅니다.', options: [{ label: '메모 기준', value: 750 }, { label: 'AI 제안', value: 30 }] }` 오류를 발생시킵니다.
  3. 또한 `"월요일 오후 2시~오후 4시 회의"`처럼 종료 시각 앞에도 `오후`가 적힌 문장은 정규식이 매칭되지 않아 `span = null`이 되고 `"메모에 소요 시간이 없습니다."` 확인 필요 상태로 빠집니다.
- **원인**:
  - 174행 `if (eh <= 12 && (sh >= 12 || (eh < 12 && eh < sh))) eh += 12;`에서 `eh === 12`일 때도 `sh >= 12`(`sh === 12`)이면 `eh += 12`가 실행되어 오후 12시(`12:30`)가 `24:30`으로 변합니다.
  - 167행 `range` 정규식이 `[~\-–]\s*` 뒤에 곧바로 `(\d{1,2})`만 기대하고 `(?:오전|오후|아침|저녁|밤)?`를 허용하지 않습니다.
- **권장 수정 코드 (`daynote/src/core/ai/validate.js` 164–176행)**:

```javascript
function checkDuration(ai, w, quote, startTime) {
  var src = [w.text || '', quote || ''].join(' ');
  var range = src.match(/(\d{1,2})\s*(?:시(?:\s*(\d{1,2})\s*분|\s*(반))?|:(\d{2}))?\s*[~\-–]\s*(?:(오전|오후|아침|저녁|밤)\s*)?(\d{1,2})\s*(?:시(?:\s*(\d{1,2})\s*분|\s*(반))?|:(\d{2}))/);
  var span = null;
  if (range && startTime) {
    var sh = +startTime.slice(0, 2), sm = +startTime.slice(3);
    var eMer = range[5], eh = +range[6];
    var em = range[7] != null ? +range[7] : range[8] ? 30 : range[9] != null ? +range[9] : 0;
    if (eMer === '오전' || eMer === '아침') { if (eh === 12) eh = 0; }
    else if (eMer === '오후' || eMer === '저녁' || eMer === '밤') { if (eh < 12) eh += 12; }
    else if (eh < 12 && (sh >= 12 || eh < sh)) eh += 12;
    if (eh * 60 + em > sh * 60 + sm) span = (eh * 60 + em) - (sh * 60 + sm);
  }
  // 이하 동일
```

### BUG-NEW-04. 보관함(`archive.js`)에서 완료 보고(`done`)·날짜 변경(`moved`) 항목의 칩 누락 및 검색 시 `"undefined: ..."` 노출

- **위치**:
  - `daynote/renderer/views/archive.js` (`ORDER` 12행, `matchesFilter` 40–47행, `open` 66–75행, `row` 173–194행)
  - `daynote/renderer/ui.js` (`KIND_LABEL` · `KIND_ICON` 294–299행)
- **재현 시나리오**:
  1. 작업 공간에 `"분기 보고서 작성"` 할 일을 올려 두고 `"이거 끝났어"` 또는 `"내일로 미뤄줘"`를 입력합니다.
  2. 보관함(`Alt+2`)으로 이동하면 해당 기록 행에 종류 칩이 아무것도 표시되지 않습니다.
  3. 보관함 검색창에 `"분기 보고서"`를 입력하면 원문(`"이거 끝났어"`)에는 해당 단어가 없고 연결된 할 일 제목에만 있으므로 `e.hits`가 렌더링되는데, 화면에 **`"undefined: 분기 보고서 작성"`**이라고 출력됩니다.
  4. 상단 `'할 일'` 종류 필터를 누르면 해당 기록이 목록에서 사라지며, 기록을 클릭해도 할 일 상세 패널이 아닌 빈 메모 편집기로 이동합니다.
- **원인**:
  - `P.captureItems()`는 완료 보고와 날짜 변경 항목의 `kind`를 각각 `'done'`, `'moved'`로 반환하지만, `ui.KIND_LABEL`(`task`, `event`, `memo`, `idea`, `link`)과 `archive.js`의 `ORDER`, `matchesFilter`, `open` 함수는 `'done'`과 `'moved'`를 처리하지 않습니다.
- **권장 수정 코드 (`daynote/renderer/ui.js` 및 `daynote/renderer/views/archive.js`)**:

```javascript
// 1) renderer/ui.js (294~296행) — 완료·날짜 변경 라벨과 아이콘 추가
var KIND_LABEL = { task: '할 일', event: '일정', memo: '메모', idea: '아이디어', link: '링크', done: '완료', moved: '날짜 변경' };
var KIND_ICON = { task: 'task', event: 'calendar', memo: 'note', idea: 'idea', link: 'link', done: 'check', moved: 'calendar' };

// 2) renderer/views/archive.js — ORDER, matchesFilter, open 보완
var ORDER = ['memo', 'idea', 'link', 'task', 'done', 'moved', 'event'];
// matchesFilter 내부 (41행):
if (f.kind !== 'all' && !e.items.some(function (it) {
  return it.kind === f.kind || (f.kind === 'task' && (it.kind === 'done' || it.kind === 'moved'));
})) return false;
// open(e) 내부 (71행):
if (made[0].kind === 'task' || made[0].kind === 'done' || made[0].kind === 'moved') { A.openTask(made[0].item.id); return; }
```

### BUG-NEW-05. 할 일 작업 시계(`runningSince`·`workedMs`) 상태 불일치 및 상세 패널(`detail.js`) 상태 드롭다운 오류

- **위치**:
  - `daynote/renderer/views/detail.js` (37–44행)
  - `daynote/src/core/model.js` (`normalizeTask` 72–87행, `updateTask` 185–193행)
  - `daynote/renderer/sample.js` (66행)
- **재현 시나리오**:
  1. 할 일을 시작(`status = 'in_progress'`, `runningSince` 기록됨)한 뒤 오른쪽 상세 패널(`detail.js`)을 열고 상태 드롭다운을 `'할 일'`(`todo`)이나 `'대기'`(`waiting`)로 변경합니다. `M.updateTask()`가 호출되면서 `status`만 바뀌고 `stopClock()`이 호출되지 않아 **`runningSince`가 지워지지 않으며, 멈춘 뒤에도 작업 시간(`workedMinutes`)이 계속 올라갑니다.**
  2. 반대로 상태가 `'대기'`(`waiting`)인 할 일의 상세 패널에서 상태 드롭다운을 `'진행 중'`으로 바꾸면, `A.startTask(taskId)` 내부의 `recommend.checkStartable()`이 `"시작하지 않았습니다: 대기 상태인 할 일입니다."` 오류 토스트를 띄우며 시작을 거부합니다. 이때 상세 패널이 다시 그려지지 않아 **드롭다운 선택값만 `'진행 중'`으로 바뀌고 실제 상태는 `'대기'`에 머무는 불일치**가 발생합니다(`'할 일'` 상태에서 `'일시 정지'`를 골랐을 때도 동일).
  3. 샘플 데이터의 유일한 진행 중 할 일인 `"세미나 발표 자료 목차 잡기"`(`sample.js` 66행)는 `status: 'in_progress', startedAt: iso(minsAgo(90))`로 생성되지만 `runningSince`가 없어, 90분 동안 진행 중임에도 작업 시간이 `0분`으로 나오고 50분 집중 휴식 알림(`habits.longFocus`)도 동작하지 않습니다.
- **권장 수정 코드 (`daynote/src/core/model.js` 및 `daynote/renderer/views/detail.js`)**:

```javascript
// 1) src/core/model.js — normalizeTask (84행 부근) 및 updateTask (185~193행)
// normalizeTask 반환 직전:
if (normed.status === 'in_progress' && !normed.runningSince) {
  normed.runningSince = normed.startedAt || normed.updatedAt || iso();
}

// updateTask 내부:
function updateTask(state, id, patch, now) {
  var t = byId(state.tasks, id);
  if (!t) return null;
  var p = Object.assign({}, patch);
  if ('status' in p && t.status === 'in_progress' && p.status !== 'in_progress') {
    stopClock(t, now);
  }
  if ('estimateMinutes' in p && !('estimateSource' in p)) p.estimateSource = p.estimateMinutes == null ? null : 'user';
  Object.assign(t, p, { updatedAt: iso(now) });
  return t;
}

// 2) renderer/views/detail.js — 상태 select 핸들러 (40~44행)
status.addEventListener('change', function () {
  if (status.value === 'in_progress') {
    if (t.status === 'waiting') save({ status: 'todo' }, null);
    A.startTask(taskId).then(function (ok) { if (!ok) renderAgain(); });
    return;
  }
  if (status.value === 'paused') {
    if (t.status === 'in_progress') A.pauseTask(taskId);
    else save({ status: 'paused', pausedAt: A.now().toISOString() }, '상태 변경');
    return;
  }
  if (status.value === 'todo' && (t.status === 'in_progress' || t.status === 'paused')) {
    A.returnToTodo(taskId);
    return;
  }
  save({ status: status.value }, '상태 변경');
});
```

### BUG-NEW-06. 할 일 ↔ 일정 변환 시 메타데이터(`workedMs`, `resumeNote`, `weekGoal`, `sample`) 유실 및 다중 줄 완료 항목 변환 오류

- **위치**: `daynote/src/core/ai/proposals.js` (`TASK_KEEP` 626행, `taskToBlock` 648–675행, `blockToTask` 677–703행, `captureSetItemKind` 782행)
- **재현 시나리오**:
  1. 25분 동안 작업 후 일시 정지해 `'이어서 할 첫 행동'`(`resumeNote`)과 `'이번 주 목표'`(`weekGoal`)를 적어 둔 할 일을 결과 카드에서 `'일정'`으로 바꿨다가 다시 `'할 일'`로 되돌립니다.
  2. `workedMs`(25분), `resumeNote`, `weekGoal`, `postponedCount`, `sample` 속성이 모두 사라집니다. 만약 진행 중(`in_progress`)인 상태에서 변환했다가 돌아오면 `status`만 `'in_progress'`이고 `runningSince`가 `undefined`인 깨진 상태가 됩니다.
  3. 또한 다중 줄 결과 카드(`captureItems.length > 1`)에서 이미 완료한 할 일 줄의 종류 칩을 눌러 `'일정'`으로 바꾸면, `captureSetKind`(742행)와 달리 완료 여부 검사가 없어 완료된 할 일이 삭제되고 주간 정리·프로젝트 히스토리에서 `'원본 삭제됨'`으로 표시됩니다.
- **권장 수정 코드 (`daynote/src/core/ai/proposals.js`)**:

```javascript
// 626행: 보존 필드 목록 확장
var TASK_KEEP = [
  'dueDate', 'dueTime', 'memo', 'priority', 'estimateMinutes', 'estimateSource',
  'steps', 'breakdown', 'blockedBy', 'waitingFor', 'snoozedUntil', 'proposalId',
  'sortOrder', 'elaboratedAt', 'workedMs', 'runningSince', 'pausedAt',
  'resumeNote', 'weekGoal', 'postponedCount', 'sample'
];

// 782행 (captureSetItemKind 내부): 완료된 할 일은 일정으로 바꾸지 않도록 보호
} else if (kind === 'event' && ref.kind === 'task') {
  if (cur.status !== 'done') swap(cur.id, { kind: 'block', id: taskToBlock(state, cur, now, 0).id });
}
```

### BUG-NEW-07. 시간 정한 할 일(`do_at`)의 날짜 메뉴 체크 오류 및 `whenChips` 날짜·시각 안내 불일치

- **위치**:
  - `daynote/renderer/views/chat.js` (`dateMenu` 429, 436행, `pickForm` 443행, `whenChips` 714–722행)
  - `daynote/renderer/assistant.js` (`planAt` 287–296행)
- **재현 시나리오**:
  1. `"30분 후 샤워하기"`를 입력해 할 일(`dueDate: null`)과 오늘 작업 시간(`work` 블록)이 생성된 상태에서 결과 카드의 날짜 칩(`오늘 15:30 · 30분`)을 클릭합니다.
  2. 메뉴가 열리면 오늘 날짜가 아니라 **`✓ 날짜 없음`에 체크 표시**가 되어 있고, `'내일'`로 옮긴 뒤 다시 메뉴를 열어도 여전히 `'날짜 없음'`에 체크되어 있습니다.
  3. 또한 마감 없는 할 일 아래에 뜨는 `'언제 할까요?'`(`whenChips`) 또는 하루 마무리 카드에서 `'오늘 저녁'`(19:00)을 눌렀을 때, 할 일 예상 시간이 90분 이상이거나 19:00~20:00에 이미 일정이 있으면 `findFreeSlot()`(`DAY_END = 20`)이 **내일 오전 08:00**를 반환합니다. 그러나 토스트와 카드 문구는 `c.label + ' ' + D.hm(at)`으로 조합되어 **`"오늘 저녁 08:00에 하기로 했어요."`**라는 모순된 안내를 출력합니다.
- **권장 수정 코드 (`daynote/renderer/views/chat.js`)**:

```javascript
// 1) dateMenu (429행) 및 pickForm (443행)에서 미래 work 블록 날짜 반영
var work = it.kind === 'task'
  ? M.blocksForTask(S.state, it.item.id).filter(function (b) { return b.kind === 'work' && new Date(b.end) > now; })[0]
  : null;
var curYmd = it.kind === 'task' ? (work ? D.ymd(work.start) : it.item.dueDate) : D.ymd(it.item.start);

// 2) whenChips (714~722행)에서 실제 배치된 날짜가 선택한 칩의 기준 날짜와 다르면 실제 날짜를 표시
function whenChips(taskId, onPicked, extra) {
  var now = DN.app.now();
  return h('div.when-chips', DN.habits.whenChoices(now).map(function (c) {
    return h('button.chip.chip-btn', { type: 'button', onclick: function () {
      var at = DN.assistant.planAt(taskId, c.at);
      if (at && onPicked) {
        var sameDay = D.ymd(at) === D.ymd(c.at);
        var prefix = sameDay ? c.label : dayLabel(D.ymd(at), now);
        onPicked(prefix + ' ' + D.hm(at));
      }
    } }, c.label);
  }).concat(extra || []));
}
```

### BUG-NEW-08. 주간 정리(`weekly.js`)·프로젝트(`projects.js`)의 일시 정지(`paused`) 할 일 누락 및 추천 `signature` 누락

- **위치**:
  - `daynote/src/core/weekly.js` (`summarize` 78행)
  - `daynote/renderer/views/projects.js` (`renderOverview` 117행, `renderTasks` 125행)
  - `daynote/src/core/recommend.js` (`signature` 248–256행)
- **원인**:
  1. `weekly.js` 78행 `return (t.dueDate && t.dueDate <= r.weekEnd) || t.status === 'in_progress' || t.status === 'waiting';`에서 `'paused'` 상태가 빠져 있어, 시작해서 작업 시간을 쌓다가 잠시 멈춰 둔(`paused`) 할 일이 주간업무보고의 `진행 중·남은 일`에서 누락됩니다(참고로 149행 보고서 포맷터는 `M.TASK_STATUS[t.status]`를 출력하도록 이미 준비되어 있으나 78행 필터에서 걸러짐).
  2. `recommend.signature()`(250–252행)는 추천 순위에 직접 영향을 주는 `t.sortOrder`와 단계별 `s.estimateMinutes`를 지문 문자열에 포함하지 않아, 홈에서 할 일 순서를 끌어 놓아 바꿔도 추천 지문이 변하지 않습니다.
- **권장 수정 코드 (`daynote/src/core/weekly.js` 및 `daynote/src/core/recommend.js`)**:

```javascript
// 1) src/core/weekly.js (78행)
return (t.dueDate && t.dueDate <= r.weekEnd) || t.status === 'in_progress' || t.status === 'paused' || t.status === 'waiting';

// 2) src/core/recommend.js — signature (250~253행)
state.tasks.forEach(function (t) {
  parts.push([t.id, t.status, t.priority, t.sortOrder, t.dueDate, t.dueTime, t.estimateMinutes, (t.blockedBy || []).join('+'),
    t.snoozedUntil, t.deletedAt, t.archivedAt, (t.steps || []).map(function (s) { return (s.done ? 1 : 0) + ':' + (s.estimateMinutes || ''); }).join(',')].join('|'));
});
```

### BUG-NEW-09. Gemini 2단 모델 폴백 누락, `store.flush()` 종료 경합 및 빠른 메모 중복 전송

- **위치**:
  - `daynote/services/ai.js` (`callGeminiTiered` 213–224행, `organize` 243–246행)
  - `daynote/renderer/store.js` (`flush` 92–112행, `beforeunload` 180–184행)
  - `daynote/renderer/quick.js` (`send` 24–35행)
- **원인**:
  1. `services/ai.js`: `callGemini()`는 `res.status !== 'completed'`(`incomplete`, `budget_exceeded`, `failed`)일 때 예외를 던지지 않고 `{ ok: false, error: { retryable: true } }`를 반환합니다. 그러나 `callGeminiTiered()`는 `catch (e)` 블록에서만 2차 모델(`order[1]`)로 넘어가므로, 1차 모델이 `incomplete`나 `failed` 상태를 반환하면 2차 모델 대체 호출이 전혀 작동하지 않습니다.
  2. `renderer/store.js`: `flush()`가 시작될 때 `dirty = false`를 먼저 설정하기 때문에, 디바운스 타이머에 의해 `host.save(json)`가 진행 중인 도중 사용자가 창을 닫으면 `onBeforeClose`가 호출한 두 번째 `flush()`가 `if (!dirty) return Promise.resolve(true);`로 즉시 끝나 버려, 파일 쓰기가 완료되기 전에 `host.flushed()`가 호출됩니다.
  3. `renderer/quick.js`: `send()` 실행 중 `sending` 잠금이 없어 Enter를 연타하면 동일 텍스트로 `Q.submit()`이 중복 호출됩니다.
- **권장 수정 코드 (`daynote/services/ai.js` 및 `daynote/renderer/store.js`)**:

```javascript
// 1) services/ai.js — callGeminiTiered (213~224행)
async function callGeminiTiered(input) {
  const order = input && input.purpose === 'capture' ? [MODELS.geminiFast, MODELS.gemini] : [MODELS.gemini, MODELS.geminiFast];
  let firstRes;
  try {
    firstRes = await callGemini(input, order[0]);
    if (firstRes.ok || !firstRes.error || !firstRes.error.retryable) return firstRes;
  } catch (e) {
    const c = classifyGemini(e);
    if (!c.retryable && e.status !== 404) throw Object.assign(e, { _classified: c });
    firstRes = { ok: false, error: c };
  }
  await new Promise((r) => setTimeout(r, retryDelayMs != null ? retryDelayMs : firstRes.error.type === 'rate_limit' ? 300 : 1200));
  try { return await callGemini(input, order[1]); }
  catch (e2) { throw Object.assign(e2, { _classified: classifyGemini(e2) }); }
}

// 2) renderer/store.js — in-flight 저장 Promise 직렬화
var savingPromise = null;
function flush() {
  clearTimeout(saveTimer);
  if (!dirty) return savingPromise || Promise.resolve(true);
  dirty = false;
  var json = JSON.stringify(state);
  setStatus({ phase: 'saving' });
  savingPromise = host.save(json).then(function (res) {
    savingPromise = null;
    if (res && res.ok) {
      try { localStorage.removeItem(EMERGENCY_KEY); } catch (e) {}
      if (dirty) { return flush(); }
      setStatus({ phase: 'saved', at: res.savedAt || new Date().toISOString(), error: null });
      return true;
    }
    throw new Error((res && res.error) || '알 수 없는 오류');
  }).catch(function (e) {
    savingPromise = null;
    dirty = true;
    try { localStorage.setItem(EMERGENCY_KEY, JSON.stringify(state)); } catch (_) {}
    setStatus({ phase: 'error', error: e.message });
    return false;
  });
  return savingPromise;
}
```

### BUG-NEW-10. 화면 초기 진입·샘플 데이터·명령 대상 해석의 경계 조건 버그 4건

- **위치 및 세부 내용**:
  1. **메모 화면(`renderer/views/notes.js` 18–19행)**: `mem.noteId`가 없을 때 `M.liveNotes(st)` 전체에서 첫 메모를 고르기 때문에, 가장 최근에 홈 채팅에서 입력한 글이 할 일 전용(`captureRole === 'task_source'`)이면 숨겨져야 할 원문이 49행(`n.id !== mem.noteId`) 예외를 타고 메모 목록과 편집기에 노출됩니다. 초기 선택 후보를 `notes.filter(function (n) { return n.captureRole !== 'task_source'; })`로 제한해야 합니다.
  2. **새 할 일 제안 화면(`renderer/views/inbox.js` 86–91, 126행)**: 빈 화면에서 `'샘플 데이터로 둘러보기'` 버튼을 누르면 `A().loadSample()`이 호출되어 화면이 다시 그려지지만, `A().current()` 참조가 그대로여서 `if (lastVisit !== visit)` 조건이 거짓이 되어 `rescan(true)`가 돌지 않습니다. 그 결과 샘플을 불러온 직후에도 `"검토할 제안이 없습니다"`가 그대로 표시됩니다. `loadSample()` 직후 `rescan(true)`를 호출하거나 `st.meta.sampleLoaded` 변화를 감지해야 합니다.
  3. **샘플 삭제 시 채팅 고아 카드(`src/core/model.js` `clearSample` 487–507행)**: 샘플 데이터를 지울 때 `state.chat`에 남아 있는 샘플 할 일·메모 참조 카드가 정리되지 않아 `"지워진 할 일이에요."`, `"밀린 일이 0개 있어요."` 같은 빈 카드가 홈 채팅에 남습니다.
  4. **특정 할 일 작게 나누기 명령(`src/core/ai/commands.js` 83–86, 117–122행)**: 사용자가 `"없는할일 작게 나눠줘"`처럼 대상을 명시했으나 매칭되는 할 일이 없을 때, `missing` 안내를 띄우지 않고 `taskId: null`을 반환해 `assistant.breakdown()`이 `pickTaskToBreak()`로 전혀 다른 할 일을 임의로 골라 세분화합니다. `m[1].trim()`이나 `c.target`이 명시된 경우에는 대상을 찾지 못했을 때 `missing`으로 안내해야 합니다.

## 4. 권장 회귀 테스트 추가 목록 (`test/`)

위 버그들을 수정한 뒤 `node --test` 스위트에 아래 회귀 테스트를 추가하면 재발을 방지할 수 있습니다.

1. **`BUG-NEW-01` 검증**: `entry_type: 'command'`이나 `commands` 배열의 인용구가 원문에 없어 `CMD.resolve()`가 `[]`를 반환할 때 `note.deletedAt`이 `null`로 유지되고 `note.captureRole === 'memo'`로 보존되는지 확인.
2. **`BUG-NEW-02` 검증**: 할 일 제목이 `"세미나 장소 후보 알아보기"` 또는 `"오후 발표 준비"`일 때 `V.shiftMinutes('세미나 장소 후보 알아보기 두 시간 미뤄줘') === 120`을 반환하는지 확인.
3. **`BUG-NEW-03` 검증**: `checkDuration`에서 `"월요일 12:00~12:30 점심 회의"`(`startTime = '12:00'`)가 `[30, 'ok']`를 반환하고, `"월요일 오후 2시~오후 4시 회의"`(`startTime = '14:00'`)가 `[120, 'ok']`를 반환하는지 확인.
4. **`BUG-NEW-05` & `06` 검증**:
   - `M.updateTask(st, id, { status: 'waiting' }, now)` 호출 시 진행 중이던 할 일의 `runningSince`가 `null`로 정리되고 `workedMs`가 누적되는지 확인.
   - `P.captureSetKind(st, noteId, 'event', now)` 후 다시 `'task'`로 되돌렸을 때 `workedMs`, `resumeNote`, `weekGoal`, `sample`이 보존되는지 확인.
   - `P.captureSetItemKind(st, noteId, { kind: 'task', id: doneTask.id }, 'event', now)` 호출 시 완료된 할 일이 삭제되지 않고 유지되는지 확인.
5. **`BUG-NEW-08` 검증**: 마감일 없는 할 일을 `startTask` 후 `pauseTask`로 일시 정지했을 때 `W.summarize(st, weekStart, now).unfinished`에 포함되는지 확인.
6. **`BUG-NEW-09` 검증**: `services/ai.js`에서 1차 모델(`gemini-3.5-flash-lite`)이 `{ status: 'incomplete' }`를 반환했을 때 2차 모델(`gemini-3.8-flash`)로 자동 폴백되어 성공 응답을 반환하는지 확인.

## 5. 수정 결과 (2026-10-17, Claude)

10건 모두 코드에서 원인을 확인했고 수정했습니다. 전체 테스트 **157/157** 통과(새 회귀 테스트 8건: `test/bugfix-arch.test.js` 7건, `test/capture-v3.test.js` 1건), `npm run smoke`(숨김 창) `rendered:true`, `consoleErrors:[]`.

| ID | 수정 내용 | 검증 |
| :--- | :--- | :--- |
| BUG-NEW-01 | `applyCapture`는 **검증된 명령이 있을 때만** 원문을 지움(없으면 `memo`로 보존). `capture.submit`에서 채팅으로 보낸 글에 `viaChat` 표시 → 채팅 글만 `resolve`·실행, `Ctrl+N` 메모 창은 항상 메모로 보존. 명령 실행을 `classify` 안으로 옮겨 '다시 시도'로 불려도 실행됨 | 테스트(명령 없음·Ctrl+N 경로·명령 있음 3가지), 브라우저에서 Ctrl+N 입력 보존 확인 |
| BUG-NEW-02 | `shiftMinutes`: 시간 표현 **바로 뒤**의 후·뒤만 "지금부터"로 판단 (권장안 그대로) | 테스트: '후보'·'오후'·'뒤풀이' 제목 + 실제 마감 18:00→20:00 |
| BUG-NEW-03 | `checkDuration`: 끝 시각 앞 오전·오후 인식, 표기 없는 12시는 정오 그대로 (권장안 + 오전 12시 처리) | 테스트: 12:00~12:30=30, 오후 2시~오후 4시=120, 오전 11시~오후 1시=120 |
| BUG-NEW-04 | `ui.KIND_LABEL/ICON`에 완료·날짜 변경 추가, 보관함 `ORDER`·할 일 필터·클릭 이동이 완료·날짜 변경을 할 일 기록으로 처리, 라벨 없을 때 대비 | 브라우저: "완료" 칩, 검색 "완료: 세미나 장소 후보 알아보기" (undefined 없음) |
| BUG-NEW-05 | `model.updateTask`가 상태 변경 시 시계를 맞춤(진행 중을 떠나면 멈춤·되면 시작), `normalizeTask`가 시계 없는 진행 중을 `startedAt`부터 셈(샘플·예전 데이터). 상세 패널: 대기→진행 중 허용, 시작 실패 시 드롭다운 되돌림, 할 일↔일시 정지 경로 정리 | 테스트 |
| BUG-NEW-06 | `TASK_KEEP`에 `workedMs`·`pausedAt`·`resumeNote`·`weekGoal`·`postponedCount`·`sample` 추가. 변환 전 진행 중이면 시계를 멈춰 시간을 쌓고, 되돌릴 때 진행 중이면 그때부터 다시 셈(권장안의 `runningSince` 그대로 보존 대신 — 일정이었던 동안을 작업 시간으로 세지 않게). 여러 줄 카드의 끝낸 할 일은 일정으로 바꾸지 않음 | 테스트 |
| BUG-NEW-07 | 날짜 메뉴·날짜 고르기 창이 시간 정한 할 일의 작업 시간 날짜를 현재 값으로 사용. "언제 할까요?"·하루 마무리는 다른 날로 밀리면 실제 날로 안내 | 브라우저: 메뉴 체크 "오늘", 저녁이 찬 날 → 다음 날 08:00 |
| BUG-NEW-08 | 주간 정리 남은 일·프로젝트 진행 중 집계/정렬에 일시 정지 포함, 추천 지문에 `sortOrder`·단계 시간 추가 | 테스트 |
| BUG-NEW-09 | Gemini 2단: 1차가 예외 없이 끝내지 못함(`incomplete`·`failed`)을 돌려줘도 2차로 대체(JSON 못 읽음은 기존처럼 같은 쪽에서 한 번 더 — 호출이 4번까지 늘지 않게). `store.flush`: 쓰는 중인 저장을 기다리고, 쓰는 동안 바뀌면 이어서 저장. 빠른 메모 창 Enter 연타 잠금 | 테스트(incomplete → 3.8 Flash), smoke |
| BUG-NEW-10 | 메모 화면 첫 선택에서 `task_source` 제외, 제안함 샘플 불러온 뒤 바로 다시 찾기, 샘플 삭제 시 채팅 고아 카드 정리, 이름을 말했는데 없는 할 일 "작게 나눠줘"는 되묻기(AI 명령도 동일). 짧은 제목("내 일")은 이름 전체로 먼저 찾음 | 테스트, 브라우저(제안함 카드 2개 표시) |
