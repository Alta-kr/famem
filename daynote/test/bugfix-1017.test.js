'use strict';

// daynote_bug_report.md (2026-10-17) 회귀 테스트 — 코어에서 확인할 수 있는 것만 (BUG-02, 03, 05)

const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/core/model');
const V = require('../src/core/ai/validate');
const P = require('../src/core/ai/proposals');
const C = require('../src/core/ai/capture');
const W = require('../src/core/weekly');

const NOW = new Date(2026, 9, 9, 22, 0);
const NUL = { text: null, date: null, time: null };

function apply(st, body, patch) {
  const note = M.addNote(st, { title: '', body, capture: { status: 'pending', at: NOW.toISOString() } }, NOW);
  note.updatedAt = NOW.toISOString();
  const out = Object.assign({ summary: '', sections: [], tasks: [], events: [], open_questions: [], entry_type: 'memo',
    note_title: 't', note_project_hint: null, note_kind: 'memo', done_tasks: [], updated_tasks: [] }, patch);
  const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, NOW);
  P.applyCapture(st, { note, run, validated: V.validateOrganizeNote(out, { note, state: st, now: NOW }), output: out }, NOW);
  return note;
}

test('BUG-02: 완료 보고를 메모로 바꾸면 완료가 취소되고 완료 기록도 지워진다', () => {
  const st = M.emptyState();
  const t = M.addTask(st, { title: '샤워하기' }, NOW);
  const note = apply(st, '샤워 완료', { entry_type: 'done', done_tasks: [{ title: '샤워하기', evidence: { quote: '샤워 완료', line: 1 } }] });
  assert.strictEqual(t.status, 'done');
  P.captureSetKind(st, note.id, 'memo', NOW);
  assert.strictEqual(t.status, 'todo');
  assert.ok(!st.history.some((h) => h.type === 'task_done'));
  assert.deepStrictEqual(P.captureItems(st, note).map((i) => i.kind), ['memo']);
});

test('BUG-02: 날짜 바꾸기를 메모로 바꾸면 마감·작업 시간이 원래대로', () => {
  const st = M.emptyState();
  const t = M.addTask(st, { title: '견적서 보내기', dueDate: '2026-10-09' }, NOW);
  const note = apply(st, '견적서는 내일 보낼게', { entry_type: 'update',
    updated_tasks: [{ title: '견적서 보내기', evidence: { quote: '견적서는 내일 보낼게', line: 1 }, due: { text: '내일', date: '2026-10-10', time: null }, do_at: NUL }] });
  assert.strictEqual(t.dueDate, '2026-10-10');
  P.captureSetKind(st, note.id, 'idea', NOW);
  assert.strictEqual(t.dueDate, '2026-10-09');
  assert.deepStrictEqual(P.captureItems(st, note).map((i) => i.kind), ['idea']);
});

test('BUG-03: 샘플을 지우면 사용자 항목의 고아 projectId 를 비우고, 주간 정리에 "프로젝트 없음" 은 한 번만', () => {
  const st = M.emptyState();
  const sp = M.addProject(st, { name: '샘플 프로젝트', sample: true }, NOW);
  const mine = M.addTask(st, { title: '내 할 일', projectId: sp.id }, NOW);
  const loose = M.addTask(st, { title: '프로젝트 없는 일' }, NOW);
  M.completeTask(st, mine.id, NOW);
  M.completeTask(st, loose.id, NOW);
  M.clearSample(st);
  assert.strictEqual(mine.projectId, null);
  assert.ok(st.history.every((h) => !h.projectId));
  // 지운 프로젝트를 가리키는 기록이 남아 있어도(예전 데이터) 한 묶음으로
  st.history[0].projectId = 'proj_gone';
  const sum = W.summarize(st, '2026-10-05', NOW);
  const groups = sum.completed.filter((g) => !g.projectId);
  assert.strictEqual(groups.length, 1);
});

test('BUG-05: 끝 시각에 분이 있는 범위의 소요 시간을 검증한다', () => {
  function dur(body, text, time, ai) {
    const note = { id: 'n', title: '', body, updatedAt: NOW.toISOString() };
    const out = { summary: '', sections: [], tasks: [], open_questions: [],
      events: [{ title: '회의', evidence: { quote: body, line: 1 }, start: { text, date: '2026-10-12', time }, duration_minutes: ai, location: null, basis: 'explicit' }] };
    const f = V.validateOrganizeNote(out, { note, state: M.emptyState(), now: NOW }).items[0].fields.durationMinutes;
    return [f.value, f.status];
  }
  assert.deepStrictEqual(dur('월요일 14:00~15:30 회의', '월요일 14:00', '14:00', 90), [90, 'ok']);
  assert.deepStrictEqual(dur('월요일 오후 2시~3시 반 회의', '월요일 오후 2시', '14:00', 90), [90, 'ok']);
  assert.deepStrictEqual(dur('월요일 오후 2시~4시 회의', '월요일 오후 2시', '14:00', 120), [120, 'ok']);
});

// ---------------------------------------------------------------- 2차 보완 (리포트 5장)
test('5.2: 완료 보고를 할 일·일정으로 바꾸면 기존 할 일 완료가 취소되고 새 항목만 남는다', () => {
  for (const kind of ['task', 'event']) {
    const st = M.emptyState();
    const t = M.addTask(st, { title: '샤워하기' }, NOW);
    const note = apply(st, '샤워 완료', { entry_type: 'done', done_tasks: [{ title: '샤워하기', evidence: { quote: '샤워 완료', line: 1 } }] });
    assert.strictEqual(t.status, 'done');
    P.captureSetKind(st, note.id, kind, NOW);
    assert.strictEqual(t.status, 'todo', kind);
    assert.ok(!st.history.some((h) => h.type === 'task_done'), kind);
    const kinds = P.captureItems(st, note).map((i) => i.kind);
    assert.ok(!kinds.includes('done'), kind + ': ' + kinds);
    assert.strictEqual(kinds.filter((k) => k === kind).length, 1, kind + ': ' + kinds);
  }
});

test('5.2: 날짜 바꾸기를 할 일로 바꾸면 기존 할 일 마감이 원래대로', () => {
  const st = M.emptyState();
  const t = M.addTask(st, { title: '견적서 보내기', dueDate: '2026-10-09' }, NOW);
  const note = apply(st, '견적서는 내일 보낼게', { entry_type: 'update',
    updated_tasks: [{ title: '견적서 보내기', evidence: { quote: '견적서는 내일 보낼게', line: 1 }, due: { text: '내일', date: '2026-10-10', time: null }, do_at: NUL }] });
  assert.strictEqual(t.dueDate, '2026-10-10');
  P.captureSetKind(st, note.id, 'task', NOW);
  assert.strictEqual(t.dueDate, '2026-10-09');
  assert.ok(!P.captureItems(st, note).some((i) => i.kind === 'moved'));
});

test('5.3: 정오를 넘기는 범위("11시~1시")의 소요 시간', () => {
  function dur(body, text, time, ai) {
    const note = { id: 'n', title: '', body, updatedAt: NOW.toISOString() };
    const out = { summary: '', sections: [], tasks: [], open_questions: [],
      events: [{ title: '회의', evidence: { quote: body, line: 1 }, start: { text, date: '2026-10-12', time }, duration_minutes: ai, location: null, basis: 'explicit' }] };
    const f = V.validateOrganizeNote(out, { note, state: M.emptyState(), now: NOW }).items[0].fields.durationMinutes;
    return [f.value, f.status];
  }
  assert.deepStrictEqual(dur('월요일 오전 11시~1시 회의', '월요일 오전 11시', '11:00', 120), [120, 'ok']);
  assert.deepStrictEqual(dur('월요일 오전 10시~2시 워크숍', '월요일 오전 10시', '10:00', 240), [240, 'ok']);
  assert.deepStrictEqual(dur('월요일 오전 9시~11시 회의', '월요일 오전 9시', '09:00', 120), [120, 'ok']);
  assert.deepStrictEqual(dur('월요일 10시~12시 회의', '월요일 10시', '10:00', 120), [120, 'ok']);
});

test('BUG-04: onStatus 는 구독 해제 함수를 돌려주고, 해제 뒤에는 불리지 않는다', () => {
  const fs = require('fs'), path = require('path'), vm = require('vm');
  const mem = {};
  const localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
  const timers = [];
  const window = { Daynote: { model: M }, addEventListener() {} };
  const ctx = vm.createContext({ window, localStorage, setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {}, console, JSON, Promise, Date });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/store.js'), 'utf8'), ctx);
  const S = window.Daynote.store;
  let a = 0, b = 0;
  const offA = S.onStatus(() => { a++; });
  S.onStatus(() => { b++; });
  assert.strictEqual(typeof offA, 'function');
  offA();
  const a0 = a, b0 = b;
  S.mutate('메모', (s) => { M.addNote(s, { title: 'x' }); });   // 저장 상태가 바뀐다 (저장 대기)
  timers.splice(0).forEach((fn) => fn());
  assert.strictEqual(a, a0);
  assert.ok(b > b0);
});
