'use strict';

// "빠른 입력 자동 분류" 요청 정의 — 오늘 화면 입력창 하나로 받은 글을 AI 가 나눈다.
//
//   entry_type 'memo'  : 기록·생각·회의 내용 → 메모로 남긴다 (안에 할 일이 있으면 그 할 일도 따로 만든다)
//   entry_type 'task'  : 적은 것 자체가 할 일 → 할 일만 만든다 (원문은 출처로만 보관, 메모 목록엔 안 보임)
//   entry_type 'mixed' : 메모이면서 할 일도 담김 → 메모 + 할 일
//
// 할 일·일정 추출 규칙과 스키마는 organizeNote(메모 정리)와 같다. 그래서 같은 검증기를 거친다.
// 여기에 "이 입력은 무엇인가" 와 "어느 프로젝트 이야기인가" 만 더한다.

(function (factory) {
  var node = typeof module !== 'undefined' && module.exports;
  var api = factory(node ? require('./organizeNote') : window.Daynote.aiOrganize, node ? require('./commands') : window.Daynote.aiCommands);
  if (node) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.aiCapture = api; }
})(function (O, CMD) {
  var PROMPT_VERSION = 'capture.v12';   // v2: 큰 할 일 감지 + 단계 초안(보관만) · v3: 메모 종류(메모/아이디어/링크) · v4: 시간 정한 할 일(do_at) · v5: 완료 보고(done_tasks) · v6: 날짜 바꾸기(updated_tasks) · v7: 채팅 명령(commands) · v8: 작업 공간 할 일이 있어도 묶음 말은 묶음으로 · v9: 프로젝트 묶음 · 날 단위로 미루기 · v10: 목록은 할 일 하나 + 세부 할 일 · v11: 걸리는 시간 짐작(typical_minutes) · v12: 준비할 일(prep_steps)
  var ENTRY_TYPES = ['memo', 'task', 'mixed', 'done', 'update', 'command'];
  var NOTE_KINDS = ['memo', 'idea', 'link'];

  var SYSTEM = O.SYSTEM + '\n\n' + [
    '이번 입력은 사용자가 오늘 화면의 입력창 하나에 빠르게 적은 글입니다. 메모 정리 규칙에 더해 아래를 판단합니다.',
    'A. entry_type: 적은 글 전체가 해야 할 일 하나(또는 몇 개)뿐이면 "task", 기록·생각·회의 내용이면 "memo", 기록이면서 해야 할 일도 담겨 있으면 "mixed".',
    '   예) "내일까지 견적서 보내기" → task / "오늘 회의 분위기 좋았음. 디자인은 다음 주에 다시 보기로" → mixed / "점심 때 들은 아이디어: 온보딩에 퀴즈 넣기" → memo',
    'B. entry_type 이 task 나 mixed 이면 해야 할 일을 빠짐없이 tasks(또는 시각이 정해진 회의·약속은 events)에 넣습니다. memo 이면 tasks·events 는 비워도 됩니다.',
    'C. note_project_hint: 글 전체가 <context> 의 프로젝트 중 하나에 관한 것이 분명하면 그 이름을 그대로, 아니면 null. 할 일마다 project_hint 도 같은 기준으로 씁니다.',
    'D. note_title: 메모로 남길 때 쓸 짧은 제목(20자 안팎). 적은 글 첫 줄을 그대로 쓰지 말고 내용을 대표하는 말로.',
    'E. 할 일마다 size 를 정합니다. 한 번에 끝내기 어려운 큰 일(대략 1시간이 넘거나 여러 단계를 거쳐야 하는 일, 예: "분기 보고서 작성", "발표 준비")이면 "large", 아니면 "small".',
    '   large 이면 breakdown 에 그 일을 3~6개의 작은 단계로 나눈 초안을 넣습니다. 첫 단계는 15분 안에 시작할 수 있을 만큼 작게. 각 단계의 minutes 는 대략적인 추정(모르면 null).',
    '   단계는 메모에 없는 구체적 사실(사람·날짜·수치)을 지어내지 말고, 그 일을 하는 일반적인 순서로만 씁니다. small 이면 breakdown 은 빈 배열입니다.',
    '   이 단계는 바로 적용되지 않고, 사용자가 여유 있을 때 제안됩니다.',
    'F. note_kind: 메모로 남는 부분이 어떤 글인지 고릅니다.',
    '   "link" = URL·기사·영상·책처럼 나중에 볼 자료가 중심인 글 / "idea" = 해 볼 만한 생각·제안·가설(아직 할 일로 정하지 않음, "~하면 어떨까", "~해 보면 좋겠다") / "memo" = 그 밖의 기록·사실·회의 내용·감상.',
    '   예) "https://… 나중에 읽기" → entry_type memo, note_kind link. "나중에 읽기·보기" 는 할 일로 만들지 않습니다(마감이 적혀 있을 때만 할 일도 함께) /"온보딩에 퀴즈 넣으면 어떨까" → memo, idea / "점심 김밥 맛있었다" → memo, memo',
    '   entry_type 이 task 여도 note_kind 는 채웁니다(보통 "memo").',
    'G. 할 일 / 일정 / 시간 정한 할 일 — 기준은 "그 시각이 지나도 여전히 해야 하나?" 입니다.',
    '   - 일정(events): 정해진 시각에 일어나는 약속·회의·진료·수업·모임. 그 시각이 지나면 끝납니다. 예) "3시 치과", "내일 저녁 7시 친구랑 저녁", "4시 팀 회의".',
    '   - 시간 정한 할 일(tasks + do_at): 내가 해야 하는 행동인데 할 시각을 정해 둔 것. 그 시각을 놓쳐도 여전히 해야 합니다. 예) "30분 후 샤워하기", "3시에 보고서 쓰기", "점심 먹고 1시에 메일 정리".',
    '     do_at 에 시각 표현을 글자 그대로(text) 넣고 date·time 을 계산합니다. 앱이 이 할 일을 그 시각의 작업 시간으로 오늘 일정에 함께 보여 줍니다.',
    '   - 할 일(tasks): 시각 없이 해야 하는 것, 또는 "~까지" 처럼 마감만 있는 것. 마감은 due 이고 do_at 이 아닙니다(do_at 은 text·date·time 모두 null).',
    '   - 애매하면 시간 정한 할 일로 둡니다 (놓쳐도 사라지지 않게). 사용자가 "일정에" 라고 적었어도 내가 하는 행동이면 시간 정한 할 일입니다.',
    '   예) "오늘 일정에 30분 후 샤워하기" → tasks: 샤워하기, do_at.text "30분 후" / "금요일까지 보고서" → tasks: due "금요일까지" / "다음 주 화요일 3시 치과" → events.',
    '   일정이나 할 일이 있으면 entry_type 은 "task" (기록이 섞이면 "mixed").',
    'H. 완료 보고: 글이 <context> 의 "이미 있는 할 일" 중 어떤 일을 끝냈다고 말하면(예: "샤워 완료", "견적서 보냈음", "보고서 다 씀", "회의 끝났다") done_tasks 에 그 할 일 제목을 목록에 적힌 글자 그대로 넣고, evidence 에 근거 문장을 복사합니다.',
    '   목록에 없는 일, 끝냈는지 분명하지 않은 일("하는 중", "거의 다 함")은 넣지 않습니다. 끝낸 일을 새 할 일(tasks)로 만들지 마세요.',
    '   완료 보고만 있는 글이면 entry_type "done", 다른 기록·할 일이 섞이면 "mixed". 완료 보고가 없으면 done_tasks 는 빈 배열입니다.',
    'I. 날짜 바꾸기: 글이 "이미 있는 할 일" 의 날짜·시각을 바꾸겠다고 말하면(예: "견적서는 내일 보낼게", "보고서 다음 주 월요일로 미룸", "운동은 저녁 7시에 할게") updated_tasks 에 그 할 일 제목(목록 글자 그대로)과 근거 문장, 새 날짜·시각을 넣습니다.',
    '   날짜만 정하면 due 에(마감을 그날로), 할 시각을 정하면 do_at 에 넣고 다른 쪽은 text·date·time 모두 null 입니다. 표현은 text 에 글자 그대로, date·time 은 기준 시각으로 계산합니다.',
    '   목록에 없는 일, 바꿀 날짜가 분명하지 않은 말("나중에 할게", "좀 미뤄야겠다")은 넣지 않습니다. 같은 일을 새 할 일(tasks)로 또 만들지 마세요.',
    '   날짜 바꾸기만 있는 글이면 entry_type "update", 다른 기록·할 일이 섞이면 "mixed". 없으면 updated_tasks 는 빈 배열입니다.',
    '   "~후로·~뒤로 미뤄" 는 기준 시각부터, "두 시간 미뤄줘"·"30분 더 늦춰" 처럼 후·뒤가 없으면 지금 마감에서 미루는 것입니다. 표현은 due.text 에 글자 그대로 넣습니다(앱이 다시 계산합니다).',
    '   "마감 하루 미뤄줘"·"이틀 연장"·"일주일 늦춰" 처럼 날 단위로 미루면 각 할 일의 지금 마감에서 그만큼입니다 — due.text 에 "하루 미뤄" 처럼 글자 그대로, date·time 은 null 로 두면 앱이 계산합니다.',
    'K. 묶음으로 바꾸기: "마감 지난 것 전부 두 시간 후로 미뤄줘", "오늘 마감인 거 다 내일로", "온보딩 프로젝트 할 일 전부 다음 주 월요일로", "사내 세미나 관련 할 일은 마감 하루 미뤄줘" 처럼 여러 할 일을 묶어서 말하면 bulk_updates 에 넣습니다.',
    '   filter: overdue(마감 지난 것) · due_today(오늘 마감) · no_due(마감 없는 것) · in_progress(진행 중) · paused(일시 정지) · all_open(남은 할 일 전부). project_hint: 특정 프로젝트로 좁히면 그 이름, 아니면 null.',
    '   due·do_at 은 I 와 같은 규칙입니다. 어떤 할 일이 그 묶음인지는 앱이 고르니 updated_tasks 에 하나씩 나열하지 마세요. 묶음 지시가 없으면 빈 배열입니다.',
    'M. 걸리는 시간 짐작: 일정(events)이나 할 일(tasks)의 길이·끝 시각이 글에 없으면 duration_minutes 는 null 그대로 두고, typical_minutes 에 그런 일이 보통 걸리는 시간(분, 5~480)을 추정합니다.',
    '   예) 치과 60 · 병원 진료 60 · 점심 약속 60 · 회의 60 · 1:1 30 · 통화 15 · 샤워 20 · 운동 60 · 영화 130 · 견적서 보내기 20 · 보고서 작성 120. 길이가 글에 있으면 typical_minutes 는 null 입니다.',
    'L. 목록으로 적은 할 일: 한 줄 아래에 들여쓰기나 번호·기호(1. 2. / - / •)로 적은 항목들은 위 줄의 세부 할 일입니다.',
    '   예) "인공조류 보드 디버깅\n 1. 전원 디버깅\n 2. 클럭 확인" → tasks 에는 "인공조류 보드 디버깅" 하나만 넣습니다. 아래 항목을 따로 tasks 로 만들지 마세요 (앱이 세부 할 일로 넣습니다).',
    'N. 준비할 일: 할 일과 함께 "그 전에", "미리", "준비로", "준비할 것" 처럼 그 일을 하기 전에 틈틈이 해 둘 일을 적으면, 그 일들은 따로 tasks 로 만들지 말고 그 할 일의 prep_steps 에 짧은 제목으로 넣습니다.',
    '   글에 적힌 것만 넣고 지어내지 마세요. 없으면 빈 배열입니다 (breakdown 과 다름 — 사용자가 직접 말한 준비라 바로 세부 할 일로 들어갑니다).',
    '   예) "다음 주 금요일 워크숍 발표. 그 전에 자료 조사랑 슬라이드 템플릿 받아 두기" → tasks: "워크숍 발표"(due 다음 주 금요일), prep_steps ["자료 조사", "슬라이드 템플릿 받기"]',
    'J. 작업 공간의 할 일: <context> 에 "작업 공간에 올려 둔 할 일" 이 있으면, 사용자가 대상을 말하지 않고 "마감 두 시간 후로 미뤄줘", "이거 끝났어", "이거 내일로" 처럼 쓴 글은 그 할 일 이야기입니다.',
    '   이때 done_tasks·updated_tasks 의 title 은 그 할 일 제목을 그대로 씁니다. 다른 할 일 이름이 분명히 적혀 있으면 그쪽입니다. 이런 지시를 새 할 일로 만들지 마세요.',
    '   단, "마감 지난 것들은 2시간 뒤로", "밀린 거 내일로" 처럼 묶음을 말하면 작업 공간의 할 일이 아니라 K(bulk_updates) 입니다 (전부·모두 가 없어도).',
    CMD.PROMPT
  ].join('\n');

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  var SCHEMA = clone(O.SCHEMA);
  var stepSchema = { type: 'object', additionalProperties: false, required: ['title', 'minutes'],
    properties: { title: { type: 'string' }, minutes: { anyOf: [{ type: 'integer' }, { type: 'null' }] } } };
  SCHEMA.properties.tasks.items.properties.size = { type: 'string', enum: ['small', 'large'] };
  SCHEMA.properties.tasks.items.properties.breakdown = { type: 'array', items: stepSchema };
  // 할 시각 (마감 due 와 다름) — 없으면 text·date·time 모두 null
  SCHEMA.properties.tasks.items.properties.do_at = clone(SCHEMA.properties.tasks.items.properties.due);
  // 길이를 말하지 않았을 때 그런 일이 보통 걸리는 시간 (AI 추정, 분) — 앱은 '추정' 으로 표시한다
  SCHEMA.properties.tasks.items.properties.typical_minutes = { anyOf: [{ type: 'integer' }, { type: 'null' }] };
  // 그 일을 하기 전에 미리 해 둘 일 (사용자가 적은 것만) — 바로 '준비' 세부 할 일로 들어간다
  SCHEMA.properties.tasks.items.properties.prep_steps = { type: 'array', items: { type: 'string' } };
  SCHEMA.properties.events.items.properties.typical_minutes = { anyOf: [{ type: 'integer' }, { type: 'null' }] };
  SCHEMA.properties.events.items.required = Object.keys(SCHEMA.properties.events.items.properties);
  SCHEMA.properties.tasks.items.required = Object.keys(SCHEMA.properties.tasks.items.properties);
  SCHEMA.properties.entry_type = { type: 'string', enum: ENTRY_TYPES };
  SCHEMA.properties.note_title = { type: 'string' };
  SCHEMA.properties.note_project_hint = { anyOf: [{ type: 'string' }, { type: 'null' }] };
  SCHEMA.properties.note_kind = { type: 'string', enum: NOTE_KINDS };
  // 끝냈다고 말한 기존 할 일 (제목은 <context> 목록의 글자 그대로)
  SCHEMA.properties.done_tasks = { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'evidence'],
    properties: { title: { type: 'string' }, evidence: clone(SCHEMA.properties.tasks.items.properties.evidence) } } };
  // 날짜·시각을 바꾸겠다고 한 기존 할 일 (due: 마감, do_at: 할 시각 — 안 바꾸는 쪽은 모두 null)
  SCHEMA.properties.updated_tasks = { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'evidence', 'due', 'do_at'],
    properties: { title: { type: 'string' }, evidence: clone(SCHEMA.properties.tasks.items.properties.evidence),
      due: clone(SCHEMA.properties.tasks.items.properties.due), do_at: clone(SCHEMA.properties.tasks.items.properties.due) } } };
  // 묶음 날짜 바꾸기 — 어떤 묶음인지만 (대상 할 일은 앱이 고른다)
  SCHEMA.properties.bulk_updates = { type: 'array', items: { type: 'object', additionalProperties: false, required: ['filter', 'project_hint', 'evidence', 'due', 'do_at'],
    properties: { filter: { type: 'string', enum: ['overdue', 'due_today', 'no_due', 'in_progress', 'paused', 'all_open'] },
      project_hint: { anyOf: [{ type: 'string' }, { type: 'null' }] }, evidence: clone(SCHEMA.properties.tasks.items.properties.evidence),
      due: clone(SCHEMA.properties.tasks.items.properties.due), do_at: clone(SCHEMA.properties.tasks.items.properties.due) } } };
  // 채팅 명령 (추천·작게 나누기·시작·휴식·화면 열기·찾기 …) — 검증·실행은 commands.js · assistant.js
  SCHEMA.properties.commands = JSON.parse(JSON.stringify(CMD.SCHEMA_PART));
  SCHEMA.required = Object.keys(SCHEMA.properties);

  function buildInput(note, opts) {
    var input = O.buildInput(note, opts);
    input.promptVersion = PROMPT_VERSION;
    input.purpose = 'capture';
    // 지금 작업 공간(채팅)에 올려 둔 할 일 — "이거 미뤄줘" 의 대상
    input.focusTask = opts && opts.focusTask ? String(opts.focusTask).slice(0, 200) : null;
    if (input.focusTask && input.openTasks.indexOf(input.focusTask) === -1) input.openTasks = [input.focusTask].concat(input.openTasks);
    // 메모를 할 일 목록으로 끌어 놓았다 — 이 글은 할 일이다 (마감·프로젝트를 함께 알아낸다)
    input.moveToTask = !!(opts && opts.moveToTask);
    return input;
  }
  function userText(input) {
    var t = O.userText(input);
    var extra = '';
    if (input.focusTask) extra += '작업 공간에 올려 둔 할 일: ' + input.focusTask + '\n';
    if (input.moveToTask) extra += '사용자가 이 글을 할 일 목록으로 끌어 놓았습니다 — 할 일(tasks)로 정리하세요 (entry_type "task"). 마감·할 시각·프로젝트가 글에 있으면 함께 넣고, 목록이면 맨 위 줄이 할 일이고 아래 항목은 세부 할 일입니다.\n';
    return extra ? t.replace('</context>', extra + '</context>') : t;
  }

  return { PROMPT_VERSION: PROMPT_VERSION, ENTRY_TYPES: ENTRY_TYPES, NOTE_KINDS: NOTE_KINDS, SYSTEM: SYSTEM, SCHEMA: SCHEMA, buildInput: buildInput, userText: userText };
});
