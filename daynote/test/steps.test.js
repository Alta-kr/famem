'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/core/model');
const ST = require('../src/core/steps');

const OUTLINE = '인공조류 보드 디버깅\n 1. 전원 디버깅\n 2. 클럭 확인\n 3. 인터페이스 확인';

test('목록 읽기: 들여쓰기·번호 아래 항목은 위 항목의 아래로', () => {
  const r = ST.parseOutline(OUTLINE);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].text, '인공조류 보드 디버깅');
  assert.deepStrictEqual(r[0].children.map((c) => c.text), ['전원 디버깅', '클럭 확인', '인터페이스 확인']);
  // 들여쓰기 없이 번호만 · 더 깊은 하위
  const r2 = ST.parseOutline('보고서 쓰기\n1. 자료 모으기\n   - 매출표\n   - 고객 설문\n2. 초안');
  assert.deepStrictEqual(r2[0].children.map((c) => c.text), ['자료 모으기', '초안']);
  assert.deepStrictEqual(r2[0].children[0].children.map((c) => c.text), ['매출표', '고객 설문']);
  // 목록 표시 없는 두 줄은 형제
  assert.strictEqual(ST.parseOutline('장보기\n세탁하기').length, 2);
  // "네. 알겠어요" 같은 문장은 목록 표시로 보지 않는다
  assert.strictEqual(ST.parseOutline('네. 알겠어요')[0].text, '네. 알겠어요');
});

test('세부 할 일 나무: 체크하면 아래도 같이, 아래를 다 끝내면 위도 끝', () => {
  const t = ST.taskFromText('보고서 쓰기\n1. 자료 모으기\n   - 매출표\n   - 고객 설문\n2. 초안');
  assert.strictEqual(t.title, '보고서 쓰기');
  let s = t.steps;
  assert.deepStrictEqual(ST.count(s), { done: 0, total: 4 });
  const [collect, draft] = s;
  const [sales, survey] = collect.steps;
  s = ST.toggle(s, sales.id);
  assert.strictEqual(ST.find(s, collect.id).done, false);
  s = ST.toggle(s, survey.id);
  assert.strictEqual(ST.find(s, collect.id).done, true);            // 아래를 다 끝내면 위도 끝
  s = ST.toggle(s, collect.id);
  assert.strictEqual(ST.find(s, sales.id).done, false);              // 위를 풀면 아래도 풀림
  s = ST.toggle(s, collect.id);
  assert.deepStrictEqual(ST.count(s), { done: 3, total: 4 });
  // 아래에 새 단계를 더하면 위 단계는 아직 안 끝난 것
  s = ST.add(s, collect.id, '경쟁사 자료');
  assert.strictEqual(ST.find(s, collect.id).done, false);
  assert.strictEqual(ST.find(s, collect.id).steps.length, 3);
  s = ST.remove(s, ST.find(s, collect.id).steps[2].id);
  assert.strictEqual(ST.find(s, collect.id).done, true);
  assert.deepStrictEqual(ST.leaves(s).map((x) => x.title), ['매출표', '고객 설문', '초안']);
  assert.strictEqual(draft.title, '초안');
});

test('정리: 목록으로 적은 글은 할 일 하나 + 세부 할 일 (데모 AI · 아래 항목을 따로 만든 AI 결과 모두)', () => {
  const V = require('../src/core/ai/validate');
  const P = require('../src/core/ai/proposals');
  const C = require('../src/core/ai/capture');
  const fake = require('../src/core/ai/fake');
  const at = new Date(2026, 9, 18, 10, 0);
  function send(st, body, out) {
    const note = M.addNote(st, { title: '', body, capture: { status: 'pending', at: at.toISOString() } }, at);
    note.updatedAt = at.toISOString();
    const input = C.buildInput(note, { today: '2026-10-18 (일)', projects: [], openTasks: [] });
    out = out || fake.organize(input).output;
    const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, at);
    P.applyCapture(st, { note, run, validated: V.validateOrganizeNote(out, { note, state: st, now: at }), output: out }, at);
    return note;
  }
  let st = M.emptyState();
  send(st, OUTLINE);
  let live = M.liveTasks(st);
  assert.strictEqual(live.length, 1);
  assert.strictEqual(live[0].title, '인공조류 보드 디버깅');
  assert.deepStrictEqual(live[0].steps.map((x) => x.title), ['전원 디버깅', '클럭 확인', '인터페이스 확인']);
  // AI 가 아래 항목만 할 일로 만든 경우
  st = M.emptyState();
  const nul = { text: null, date: null, time: null };
  const task = (title, quote, line) => ({ title, evidence: { quote, line }, due: nul, do_at: nul, project_hint: null, basis: 'explicit', size: 'small', breakdown: [] });
  const out = { summary: '', sections: [], events: [], open_questions: [], entry_type: 'task', note_title: 'x', note_project_hint: null, note_kind: 'memo', done_tasks: [], updated_tasks: [], bulk_updates: [], commands: [],
    tasks: [task('전원 디버깅', '1. 전원 디버깅', 2), task('클럭 확인', '2. 클럭 확인', 3), task('인터페이스 확인', '3. 인터페이스 확인', 4)] };
  send(st, OUTLINE, out);
  live = M.liveTasks(st);
  assert.strictEqual(live.length, 1);
  assert.strictEqual(live[0].title, '인공조류 보드 디버깅');
  assert.strictEqual(live[0].steps.length, 3);
});

test('메모를 할 일로: 첫 줄이 제목, 아래 목록은 세부 할 일', () => {
  const P = require('../src/core/ai/proposals');
  const at = new Date(2026, 9, 18, 10, 0);
  const st = M.emptyState();
  const n = M.addNote(st, { title: '', body: OUTLINE + '\n   - 3.3V 레일\n   - 5V 레일', capture: { status: 'done', entryType: 'memo', created: [] } }, at);
  const t = P.captureToTask(st, n.id, at);
  assert.strictEqual(t.title, '인공조류 보드 디버깅');
  assert.deepStrictEqual(t.steps.map((x) => x.title), ['전원 디버깅', '클럭 확인', '인터페이스 확인']);
  assert.deepStrictEqual(t.steps[2].steps.map((x) => x.title), ['3.3V 레일', '5V 레일']);
});

test('정리: 회의록처럼 맨 위 줄이 제목이면 아래 체크 항목 할 일을 제목으로 바꾸지 않는다', () => {
  const V = require('../src/core/ai/validate');
  const P = require('../src/core/ai/proposals');
  const C = require('../src/core/ai/capture');
  const at = new Date(2026, 9, 18, 10, 0);
  const st = M.emptyState();
  const body = '온보딩 주간 회의\n- [ ] 설문 문항 정리해서 금요일까지 공유\n수요일 오후 3시 디자인 리뷰 회의\n예산 논의는 다음에 해야 함';
  const note = M.addNote(st, { title: '', body, capture: { status: 'pending', at: at.toISOString() } }, at);
  note.updatedAt = at.toISOString();
  const nul = { text: null, date: null, time: null };
  const out = { summary: '', sections: [], events: [], open_questions: [], entry_type: 'task', note_title: 'x', note_project_hint: null, note_kind: 'memo', done_tasks: [], updated_tasks: [], bulk_updates: [], commands: [],
    tasks: [{ title: '설문 문항 정리해서 공유', evidence: { quote: '- [ ] 설문 문항 정리해서 금요일까지 공유', line: 2 }, due: nul, do_at: nul, project_hint: null, basis: 'explicit', size: 'small', breakdown: [] }] };
  const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, at);
  P.applyCapture(st, { note, run, validated: V.validateOrganizeNote(out, { note, state: st, now: at }), output: out }, at);
  assert.deepStrictEqual(M.liveTasks(st).map((t) => t.title), ['설문 문항 정리해서 공유']);
});
