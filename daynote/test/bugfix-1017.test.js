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
