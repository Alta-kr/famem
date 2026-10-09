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
  var dep = (typeof module !== 'undefined' && module.exports) ? require('./organizeNote') : window.Daynote.aiOrganize;
  var api = factory(dep);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.aiCapture = api; }
})(function (O) {
  var PROMPT_VERSION = 'capture.v6';   // v2: 큰 할 일 감지 + 단계 초안(보관만) · v3: 메모 종류(메모/아이디어/링크) · v4: 시간 정한 할 일(do_at) · v5: 완료 보고(done_tasks) · v6: 날짜 바꾸기(updated_tasks)
  var ENTRY_TYPES = ['memo', 'task', 'mixed', 'done', 'update'];
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
    '   날짜 바꾸기만 있는 글이면 entry_type "update", 다른 기록·할 일이 섞이면 "mixed". 없으면 updated_tasks 는 빈 배열입니다.'
  ].join('\n');

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  var SCHEMA = clone(O.SCHEMA);
  var stepSchema = { type: 'object', additionalProperties: false, required: ['title', 'minutes'],
    properties: { title: { type: 'string' }, minutes: { anyOf: [{ type: 'integer' }, { type: 'null' }] } } };
  SCHEMA.properties.tasks.items.properties.size = { type: 'string', enum: ['small', 'large'] };
  SCHEMA.properties.tasks.items.properties.breakdown = { type: 'array', items: stepSchema };
  // 할 시각 (마감 due 와 다름) — 없으면 text·date·time 모두 null
  SCHEMA.properties.tasks.items.properties.do_at = clone(SCHEMA.properties.tasks.items.properties.due);
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
  SCHEMA.required = Object.keys(SCHEMA.properties);

  function buildInput(note, opts) {
    var input = O.buildInput(note, opts);
    input.promptVersion = PROMPT_VERSION;
    input.purpose = 'capture';
    return input;
  }

  return { PROMPT_VERSION: PROMPT_VERSION, ENTRY_TYPES: ENTRY_TYPES, NOTE_KINDS: NOTE_KINDS, SYSTEM: SYSTEM, SCHEMA: SCHEMA, buildInput: buildInput, userText: O.userText };
});
