'use strict';

// 마감 남은 시간 표시와 마감 지난 할 일 미루기 (지금 + 24시간)

const test = require('node:test');
const assert = require('node:assert');
const D = require('../src/core/dates');
const M = require('../src/core/model');

const NOW = new Date(2026, 9, 17, 14, 30);

test('남은 시간: 분·시간·1일 N시간·N일, 지난 시간', () => {
  const at = (h, m) => new Date(NOW.getTime() + (h * 60 + (m || 0)) * 60000);
  assert.strictEqual(D.remainText(at(0, 45), NOW), '45분 남음');
  assert.strictEqual(D.remainText(at(5, 10), NOW), '5시간 남음');
  assert.strictEqual(D.remainText(at(27), NOW), '1일 3시간 남음');
  assert.strictEqual(D.remainText(at(24), NOW), '1일 남음');
  assert.strictEqual(D.remainText(at(24 * 4 + 5), NOW), '4일 남음');
  assert.strictEqual(D.remainText(at(-2), NOW), '2시간 지남');
  assert.strictEqual(D.remainText(at(-24 * 3), NOW), '3일 지남');
  assert.strictEqual(D.remainText(NOW, NOW), '1분 남음');
  // 시각 없는 마감은 그날 23:59 까지
  assert.strictEqual(D.remainText(D.dueAt('2026-10-17', null), NOW), '9시간 남음');
});

test('미루기: 마감 지난 할 일은 지금 + 24시간으로, 지나지 않은·끝낸 일은 그대로', () => {
  const st = M.emptyState();
  const late = M.addTask(st, { title: '보고서', dueDate: '2026-10-15', dueTime: '18:00' }, NOW);
  const lateDay = M.addTask(st, { title: '견적서', dueDate: '2026-10-16' }, NOW);
  const ok = M.addTask(st, { title: '회의록', dueDate: '2026-10-18' }, NOW);
  const done = M.addTask(st, { title: '끝난 일', dueDate: '2026-10-10' }, NOW);
  M.completeTask(st, done.id, NOW);

  assert.ok(M.postponeTask(st, late.id, NOW));
  assert.strictEqual(late.dueDate, '2026-10-18');
  assert.strictEqual(late.dueTime, '14:30');
  assert.strictEqual(late.postponedCount, 1);
  assert.ok(M.postponeTask(st, lateDay.id, NOW));
  assert.deepStrictEqual([lateDay.dueDate, lateDay.dueTime], ['2026-10-18', '14:30']);

  assert.strictEqual(M.postponeTask(st, ok.id, NOW), null);
  assert.strictEqual(ok.dueDate, '2026-10-18');
  assert.strictEqual(M.postponeTask(st, done.id, NOW), null);
  assert.strictEqual(done.dueDate, '2026-10-10');
  // 미룬 뒤에는 더 이상 지난 게 아니라 다시 눌러도 그대로
  assert.strictEqual(M.postponeTask(st, late.id, NOW), null);
});

// ---------------------------------------------------------------- 할 일 작업 공간: 시작·일시 정지·완료, 여러 일 동시 진행
test('작업 공간: 여러 일을 함께 진행하고, 일시 정지·할 일로 돌려보내기·완료에서 한 시간을 쌓는다', () => {
  const st = M.emptyState();
  const a = M.addTask(st, { title: 'A' }, NOW);
  const b = M.addTask(st, { title: 'B' }, NOW);
  const at = (m) => new Date(NOW.getTime() + m * 60000);
  M.startTask(st, a.id, at(0));
  M.startTask(st, b.id, at(5));
  assert.strictEqual(a.status, 'in_progress');
  assert.strictEqual(b.status, 'in_progress');
  assert.strictEqual(M.workedMinutes(a, at(20)), 20);
  M.pauseTask(st, a.id, at(20));
  assert.strictEqual(a.status, 'paused');
  assert.strictEqual(M.workedMinutes(a, at(60)), 20);          // 멈춘 동안은 안 쌓임
  assert.strictEqual(M.pauseTask(st, a.id, at(61)), null);     // 이미 멈춤
  M.startTask(st, a.id, at(60));                               // 이어서 하기
  M.completeTask(st, a.id, at(70));
  assert.strictEqual(M.workedMinutes(a, at(200)), 30);
  M.returnToTodo(st, b.id, at(35));
  assert.strictEqual(b.status, 'todo');
  assert.strictEqual(M.workedMinutes(b, at(100)), 30);
  assert.strictEqual(M.TASK_STATUS.paused, '일시 정지');
});

// ---------------------------------------------------------------- 작업 공간에서 "마감 두 시간 후로 미뤄줘"
test('작업 공간 할 일: 대상 없이 "마감 두시간 후로 미뤄줘" → 지금부터 2시간, "두 시간 미뤄줘" → 지금 마감부터 2시간', () => {
  const V = require('../src/core/ai/validate');
  const P = require('../src/core/ai/proposals');
  const C = require('../src/core/ai/capture');
  const fake = require('../src/core/ai/fake');
  function send(st, body, focus, at) {
    const note = M.addNote(st, { title: '', body, capture: { status: 'pending', at: at.toISOString() } }, at);
    note.updatedAt = at.toISOString();
    const open = M.liveTasks(st).filter((t) => t.status !== 'done').map((t) => t.title);
    const input = C.buildInput(note, { today: '2026-10-17 (토)', projects: [], openTasks: open, focusTask: focus });
    assert.match(C.userText(input), /작업 공간에 올려 둔 할 일: /);
    const out = fake.organize(input).output;
    const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, at);
    P.applyCapture(st, { note, run, validated: V.validateOrganizeNote(out, { note, state: st, now: at }), output: out }, at);
    return note;
  }
  const at = new Date(2026, 9, 17, 15, 0);
  const st = M.emptyState();
  const t = M.addTask(st, { title: '세미나 장소 후보 알아보기', dueDate: '2026-10-17', dueTime: '18:00' }, at);
  M.addTask(st, { title: '견적서 보내기', dueDate: '2026-10-20' }, at);
  const n1 = send(st, '마감 두시간 후로 미뤄줘', t.title, at);
  assert.deepStrictEqual([t.dueDate, t.dueTime], ['2026-10-17', '17:00']);
  assert.strictEqual(n1.capture.entryType, 'update');
  assert.strictEqual(M.liveTasks(st).length, 2);                      // 새 할 일을 만들지 않음
  send(st, '두 시간 더 미뤄줘', t.title, at);
  assert.deepStrictEqual([t.dueDate, t.dueTime], ['2026-10-17', '19:00']);
  // 다른 할 일이 이름으로 적혀 있으면 그쪽
  const other = M.liveTasks(st).find((x) => x.title === '견적서 보내기');
  send(st, '견적서는 내일로 미뤄줘', t.title, at);
  assert.strictEqual(other.dueDate, '2026-10-18');
  assert.deepStrictEqual([t.dueDate, t.dueTime], ['2026-10-17', '19:00']);
});

// ---------------------------------------------------------------- 묶음: "마감 지난 것 전부 두시간 후로 미뤄줘"
test('묶음 날짜 바꾸기: 마감 지난 할 일만 전부, 끝낸 일·지나지 않은 일은 그대로, 줄마다 되돌리기', () => {
  const V = require('../src/core/ai/validate');
  const P = require('../src/core/ai/proposals');
  const C = require('../src/core/ai/capture');
  const fake = require('../src/core/ai/fake');
  const at = new Date(2026, 9, 17, 15, 0);
  const st = M.emptyState();
  const p = M.addProject(st, { name: '사내 세미나' }, at);
  const a = M.addTask(st, { title: '보고서', dueDate: '2026-10-15', dueTime: '18:00' }, at);
  const b = M.addTask(st, { title: '견적서', dueDate: '2026-10-16', projectId: p.id }, at);
  const c = M.addTask(st, { title: '회의록', dueDate: '2026-10-18' }, at);
  const d = M.addTask(st, { title: '끝난 일', dueDate: '2026-10-10' }, at);
  M.completeTask(st, d.id, at);
  function send(body, out) {
    const note = M.addNote(st, { title: '', body, capture: { status: 'pending', at: at.toISOString() } }, at);
    note.updatedAt = at.toISOString();
    const input = C.buildInput(note, { today: '2026-10-17 (토)', projects: ['사내 세미나'], openTasks: M.liveTasks(st).filter((t) => t.status !== 'done').map((t) => t.title) });
    out = out || fake.organize(input).output;
    const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, at);
    P.applyCapture(st, { note, run, validated: V.validateOrganizeNote(out, { note, state: st, now: at }), output: out }, at);
    return note;
  }
  const note = send('마감 지난 것 전부 두시간 후로 미뤄줘');
  assert.deepStrictEqual([a.dueDate, a.dueTime], ['2026-10-17', '17:00']);
  assert.deepStrictEqual([b.dueDate, b.dueTime], ['2026-10-17', '17:00']);
  assert.strictEqual(c.dueDate, '2026-10-18');
  assert.strictEqual(d.dueDate, '2026-10-10');
  assert.strictEqual(note.capture.entryType, 'update');
  assert.deepStrictEqual(P.captureItems(st, note).map((i) => i.kind), ['moved', 'moved']);
  P.captureRemoveItem(st, note.id, { kind: 'moved', id: b.id }, at);
  assert.strictEqual(b.dueDate, '2026-10-16');
  assert.deepStrictEqual([a.dueDate, a.dueTime], ['2026-10-17', '17:00']);
  // 프로젝트로 좁히기 (AI 출력 직접)
  const nul = { text: null, date: null, time: null };
  const base = { summary: '', sections: [], tasks: [], events: [], open_questions: [], entry_type: 'update', note_title: 'x', note_project_hint: null, note_kind: 'memo', done_tasks: [], updated_tasks: [] };
  send('사내 세미나 할 일 전부 내일로 미뤄줘', Object.assign({}, base, { bulk_updates: [{ filter: 'all_open', project_hint: '사내 세미나', evidence: { quote: '사내 세미나 할 일 전부 내일로 미뤄줘', line: 1 }, due: { text: '내일', date: '2026-10-18', time: null }, do_at: nul }] }));
  assert.strictEqual(b.dueDate, '2026-10-18');
  assert.deepStrictEqual([a.dueDate, a.dueTime], ['2026-10-17', '17:00']);
  // 없는 프로젝트·이상한 filter 는 아무것도 바꾸지 않음
  send('없는 프로젝트 전부 내일로', Object.assign({}, base, { bulk_updates: [{ filter: 'all_open', project_hint: '없는 프로젝트', evidence: { quote: '없는 프로젝트 전부 내일로', line: 1 }, due: { text: '내일', date: '2026-10-18', time: null }, do_at: nul }] }));
  send('전부 내일로', Object.assign({}, base, { bulk_updates: [{ filter: 'weird', project_hint: null, evidence: { quote: '전부 내일로', line: 1 }, due: { text: '내일', date: '2026-10-18', time: null }, do_at: nul }] }));
  assert.strictEqual(c.dueDate, '2026-10-18');
  assert.deepStrictEqual([a.dueDate, a.dueTime], ['2026-10-17', '17:00']);
});

test('마감 바꾸기: AI 가 마감 말을 할 시각(do_at) 칸에 넣어도 마감으로, 날만 바꾸면 원래 시각 유지', () => {
  const V = require('../src/core/ai/validate');
  const P = require('../src/core/ai/proposals');
  const C = require('../src/core/ai/capture');
  const at = new Date(2026, 9, 17, 15, 0);
  const st = M.emptyState();
  const a = M.addTask(st, { title: '보고서', dueDate: '2026-10-15' }, at);
  const b = M.addTask(st, { title: '견적서', dueDate: '2026-10-17', dueTime: '17:00' }, at);
  const nul = { text: null, date: null, time: null };
  const base = { summary: '', sections: [], tasks: [], events: [], open_questions: [], entry_type: 'update', note_title: 'x', note_project_hint: null, note_kind: 'memo', done_tasks: [], updated_tasks: [] };
  function send(body, bulk) {
    const note = M.addNote(st, { title: '', body, capture: { status: 'pending', at: at.toISOString() } }, at);
    note.updatedAt = at.toISOString();
    const out = Object.assign({}, base, { bulk_updates: [Object.assign({ project_hint: null, evidence: { quote: body, line: 1 } }, bulk)] });
    const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, at);
    P.applyCapture(st, { note, run, validated: V.validateOrganizeNote(out, { note, state: st, now: at }), output: out }, at);
  }
  send('마감 지난 것 전부 두시간 후로 미뤄줘', { filter: 'overdue', due: nul, do_at: { text: '두시간 후', date: '2026-10-17', time: '17:00' } });
  assert.deepStrictEqual([a.dueDate, a.dueTime], ['2026-10-17', '17:00']);
  assert.strictEqual(st.blocks.length, 0);                              // 작업 시간을 만들지 않음
  send('오늘 마감인 거 다 내일로 미뤄줘', { filter: 'due_today', due: { text: '내일', date: '2026-10-18', time: null }, do_at: nul });
  assert.deepStrictEqual([b.dueDate, b.dueTime], ['2026-10-18', '17:00']);
});

test('한 달 달력: 일요일 시작, 요일이 맞고, 앞뒤 달 날짜로 주를 채운다', () => {
  // 2026년 10월 1일은 목요일
  const g = D.monthGrid(2026, 9);
  assert.strictEqual(g.length, 5);
  g.forEach((w) => { assert.strictEqual(w.length, 7); w.forEach((c, i) => assert.strictEqual(c.weekday, i)); });
  assert.deepStrictEqual(g[0].slice(0, 5).map((c) => c.ymd), ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']);
  assert.strictEqual(g[0][4].inMonth, true);
  assert.strictEqual(g[0][0].inMonth, false);
  assert.strictEqual(g[4][6].ymd, '2026-10-31');                     // 10월 31일은 토요일 → 마지막 칸
  assert.strictEqual(new Date(2026, 9, 17).getDay(), 6);
  assert.ok(g.some((w) => w[6].ymd === '2026-10-17'));               // 17일(토)은 토요일 열
  // 6주가 필요한 달: 2026년 8월 (1일 토요일, 31일 월요일)
  assert.strictEqual(D.monthGrid(2026, 7).length, 6);
  // 4주로 딱 맞는 달: 2026년 2월 (1일 일요일, 28일 토요일)
  assert.strictEqual(D.monthGrid(2026, 1).length, 4);
});

test('묶음 말: "마감 지난 것들은 2시간 뒤로" 는 작업 공간에 할 일이 있어도 마감 지난 것 전부를 미룬다', () => {
  const V = require('../src/core/ai/validate');
  const P = require('../src/core/ai/proposals');
  const C = require('../src/core/ai/capture');
  const fake = require('../src/core/ai/fake');
  // 묶음 말 판별
  assert.strictEqual(V.groupFilter('마감 지난 것들은 마감을 2시간 뒤로 미뤄줘.'), 'overdue');
  assert.strictEqual(V.groupFilter('마감 지난 거 내일로'), 'overdue');
  assert.strictEqual(V.groupFilter('오늘 마감인 거 다 내일로'), 'due_today');
  assert.strictEqual(V.groupFilter('마감 지난 견적서 내일로'), null);
  assert.strictEqual(V.groupFilter('마감 두 시간 후로 미뤄줘'), null);
  const at = new Date(2026, 9, 18, 0, 40);
  const nul = { text: null, date: null, time: null };
  function setup() {
    const st = M.emptyState();
    const focus = M.addTask(st, { title: '멘토 배정 기준 초안 작성', dueDate: '2026-10-17', dueTime: '18:00' }, at);
    const old = M.addTask(st, { title: '분기 지표 대시보드 캡처 정리', dueDate: '2026-10-15' }, at);
    const later = M.addTask(st, { title: '세미나 발표 자료 목차 잡기', dueDate: '2026-10-19' }, at);
    return { st, focus, old, later };
  }
  function send(st, body, out) {
    const note = M.addNote(st, { title: '', body, capture: { status: 'pending', at: at.toISOString() } }, at);
    note.updatedAt = at.toISOString();
    const input = C.buildInput(note, { today: '2026-10-18 (일)', projects: [], openTasks: M.liveTasks(st).filter((t) => t.status !== 'done').map((t) => t.title), focusTask: '멘토 배정 기준 초안 작성' });
    out = out || fake.organize(input).output;
    const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, at);
    P.applyCapture(st, { note, run, validated: V.validateOrganizeNote(out, { note, state: st, now: at }), output: out }, at);
  }
  const body = '마감 지난 것들은 마감을 2시간 뒤로 미뤄줘.';
  // 데모 AI
  let s = setup();
  send(s.st, body);
  assert.deepStrictEqual([s.focus.dueDate, s.focus.dueTime], ['2026-10-18', '02:40']);
  assert.deepStrictEqual([s.old.dueDate, s.old.dueTime], ['2026-10-18', '02:40']);
  assert.strictEqual(s.later.dueDate, '2026-10-19');
  // AI 가 작업 공간의 할 일 하나로만 받아도 묶음으로
  s = setup();
  const base = { summary: '', sections: [], tasks: [], events: [], open_questions: [], entry_type: 'update', note_title: 'x', note_project_hint: null, note_kind: 'memo', done_tasks: [], bulk_updates: [] };
  send(s.st, body, Object.assign({}, base, { updated_tasks: [{ title: '멘토 배정 기준 초안 작성', evidence: { quote: body, line: 1 }, due: { text: '2시간 뒤', date: null, time: null }, do_at: nul }] }));
  assert.deepStrictEqual([s.old.dueDate, s.old.dueTime], ['2026-10-18', '02:40']);
  assert.deepStrictEqual([s.focus.dueDate, s.focus.dueTime], ['2026-10-18', '02:40']);
  assert.strictEqual(s.later.dueDate, '2026-10-19');
  // 할 일 이름을 말한 한 건은 그대로 한 건
  s = setup();
  const one = '분기 지표 마감 지난 거 2시간 뒤로 미뤄줘';
  send(s.st, one, Object.assign({}, base, { updated_tasks: [{ title: '분기 지표 대시보드 캡처 정리', evidence: { quote: one, line: 1 }, due: { text: '2시간 뒤', date: null, time: null }, do_at: nul }] }));
  assert.deepStrictEqual([s.old.dueDate, s.old.dueTime], ['2026-10-18', '02:40']);
  assert.deepStrictEqual([s.focus.dueDate, s.focus.dueTime], ['2026-10-17', '18:00']);
});
