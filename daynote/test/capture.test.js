'use strict';

// 빠른 입력 자동 분류 — 입력 → AI 판단 → 검증 → 바로 반영, 그리고 사용자가 바꾸기

const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/core/model');
const V = require('../src/core/ai/validate');
const P = require('../src/core/ai/proposals');
const C = require('../src/core/ai/capture');
const fake = require('../src/core/ai/fake');

const NOW = new Date(2026, 9, 5, 10, 0);

function setup() {
  const st = M.emptyState();
  M.addProject(st, { id: 'p1', name: '신규 온보딩 개선' }, NOW);
  M.addProject(st, { id: 'p2', name: '3분기 리포트' }, NOW);
  return st;
}

// 화면 쪽 흐름과 같은 순서: 메모로 먼저 저장 → AI → 검증 → 반영
function submit(st, text, output) {
  const note = M.addNote(st, { title: '', body: text, capture: { status: 'pending', at: NOW.toISOString() } }, NOW);
  note.updatedAt = NOW.toISOString();
  const input = C.buildInput(note, { today: '2026-10-05 (월)', projects: st.projects.map((p) => p.name), openTasks: [] });
  const out = output || fake.organize(input).output;
  const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, NOW);
  const v = V.validateOrganizeNote(out, { note, state: st, now: NOW });
  assert.ok(v.ok, v.errors.join());
  const cap = P.applyCapture(st, { note, run, validated: v, output: out }, NOW);
  return { note, cap };
}

test('스키마: capture 스키마는 메모 정리 스키마 + 분류 항목이며 구조화 출력 조건을 지킨다', () => {
  assert.deepStrictEqual(C.SCHEMA.properties.entry_type.enum, ['memo', 'task', 'mixed', 'done', 'update']);
  assert.deepStrictEqual(C.SCHEMA.required.slice().sort(), Object.keys(C.SCHEMA.properties).sort());
  assert.strictEqual(C.SCHEMA.additionalProperties, false);
  assert.match(C.SYSTEM, /entry_type/);
});

test('할 일만 적으면 할 일이 바로 생기고, 원문은 출처로만 남아 메모 목록에서 숨는다', () => {
  const st = setup();
  const { note, cap } = submit(st, '내일까지 견적서 보내기');
  assert.strictEqual(cap.entryType, 'task');
  assert.strictEqual(note.captureRole, 'task_source');
  assert.strictEqual(st.tasks.length, 1);
  const t = st.tasks[0];
  assert.strictEqual(t.title, '견적서 보내기');
  assert.strictEqual(t.dueDate, '2026-10-06');
  assert.strictEqual(t.origin, 'ai_accepted');
  assert.strictEqual(t.sources[0].refId, note.id);           // 원문 연결
  assert.strictEqual(note.body, '내일까지 견적서 보내기');      // 원문 보존
});

test('기록 + 할 일(혼합)은 메모로 남고, 할 일은 따로 생기며 관련 프로젝트에 자동으로 들어간다', () => {
  const st = setup();
  const { note, cap } = submit(st, '오늘 회의 분위기 좋았음\n온보딩 설문은 금요일까지 정리해서 공유 부탁드립니다');
  assert.strictEqual(cap.entryType, 'mixed');
  assert.strictEqual(note.captureRole, 'memo');
  assert.strictEqual(note.projectId, 'p1');
  assert.ok(cap.projectByAi);
  assert.strictEqual(st.tasks.length, 1);
  assert.strictEqual(st.tasks[0].projectId, 'p1');
  assert.strictEqual(st.tasks[0].dueDate, '2026-10-09');
});

test('그냥 메모는 메모로만 남는다 (할 일을 만들어내지 않음)', () => {
  const st = setup();
  const { note, cap } = submit(st, '점심 때 들은 아이디어: 퀴즈 형식 교육 자료');
  assert.strictEqual(cap.entryType, 'memo');
  assert.strictEqual(note.captureRole, 'memo');
  assert.strictEqual(st.tasks.length, 0);
});

test('시각은 있지만 소요 시간이 없는 일정은 30분으로 캘린더에 넣고, 길이는 짐작이라고 표시한다', () => {
  const st = setup();
  submit(st, '수요일 오후 3시 디자인 리뷰 회의');
  assert.strictEqual(st.tasks.length, 0);
  assert.strictEqual(st.blocks.length, 1);
  const b = st.blocks[0];
  const s = new Date(b.start);
  assert.deepStrictEqual([s.getDate(), s.getHours()], [7, 15]);
  assert.strictEqual(new Date(b.end) - s, 30 * 60000);
  assert.strictEqual(b.durationGuessed, true);
});

test('이미 있는 할 일과 같은 건 만들지 않고 초안으로 남긴다. 원문에 없는 항목은 버린다', () => {
  const st = setup();
  M.addTask(st, { title: '견적서 보내기' }, NOW);
  const { cap } = submit(st, '내일까지 견적서 보내기');
  assert.strictEqual(st.tasks.length, 1);
  assert.strictEqual(cap.skipped[0].reason, 'duplicate');
  assert.strictEqual(cap.entryType, 'memo');                  // 아무것도 못 만들었으니 메모로 남김

  const st2 = setup();
  const made = { summary: '', sections: [], events: [], open_questions: [], entry_type: 'task', note_title: 'x', note_project_hint: null,
    tasks: [{ title: '보고서 제출', evidence: { quote: '보고서를 금요일까지 제출', line: 1 }, due: { text: null, date: null, time: null }, project_hint: null, basis: 'explicit' }] };
  const r = submit(st2, '오늘은 조용한 하루', made);
  assert.strictEqual(st2.tasks.length, 0);
  assert.strictEqual(r.cap.entryType, 'memo');
});

test('바꾸기: 메모로 바꾸면 만든 할 일이 지워지고, 할 일로 바꾸면 원문 연결된 할 일이 생기고, 프로젝트는 함께 바뀐다', () => {
  const st = setup();
  const { note } = submit(st, '오늘 회의 분위기 좋았음\n온보딩 설문은 금요일까지 정리해서 공유 부탁드립니다');
  const taskId = note.capture.created[0].id;
  P.captureSetProject(st, note.id, 'p2');
  assert.strictEqual(M.byId(st.tasks, taskId).projectId, 'p2');
  assert.strictEqual(note.projectId, 'p2');
  P.captureToMemo(st, note.id, NOW);
  assert.ok(M.byId(st.tasks, taskId).deletedAt);
  assert.strictEqual(note.captureRole, 'memo');
  assert.deepStrictEqual(note.capture.created, []);

  const st2 = setup();
  const r = submit(st2, '점심 때 들은 아이디어: 퀴즈 형식 교육 자료');
  const t = P.captureToTask(st2, r.note.id, NOW);
  assert.strictEqual(t.sources[0].refId, r.note.id);
  assert.strictEqual(r.note.captureRole, 'task_source');
  assert.strictEqual(M.liveTasks(st2).length, 1);
});

test('사용자가 고른 프로젝트는 AI 판단보다 우선한다', () => {
  const st = setup();
  const note = M.addNote(st, { title: '', body: '온보딩 설문 금요일까지 정리 부탁드립니다', projectId: 'p2', capture: { status: 'pending' } }, NOW);
  note.updatedAt = NOW.toISOString();
  const input = C.buildInput(note, { today: 'x', projects: st.projects.map((p) => p.name), openTasks: [] });
  const out = fake.organize(input).output;
  const run = P.startRun(st, { noteId: note.id }, NOW);
  const v = V.validateOrganizeNote(out, { note, state: st, now: NOW });
  P.applyCapture(st, { note, run, validated: v, output: out }, NOW);
  assert.strictEqual(note.projectId, 'p2');
  assert.strictEqual(st.tasks[0].projectId, 'p2');
});
