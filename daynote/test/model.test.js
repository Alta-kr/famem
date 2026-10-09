'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/core/model');

const NOW = new Date(2026, 9, 5, 10, 0);
const LATER = new Date(2026, 9, 6, 10, 0);
const at = (h, m) => new Date(2026, 9, 5, h, m || 0).toISOString();

test('completeTask → task_done 기록', () => {
  const s = M.emptyState();
  const t = M.addTask(s, { title: 'x' }, NOW);
  const res = M.completeTask(s, t.id, NOW);
  assert.equal(t.status, 'done');
  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].type, 'task_done');
  assert.equal(s.history[0].id, res.historyId);
  assert.equal(M.completeTask(s, t.id, NOW), null); // 두 번 완료 안 됨
});

test('reopenTask undoOf → 기록 삭제, 이전 상태 복원', () => {
  const s = M.emptyState();
  const t = M.addTask(s, { title: 'x', status: 'in_progress' }, NOW);
  const res = M.completeTask(s, t.id, NOW);
  M.reopenTask(s, t.id, NOW, { undoOf: res.historyId, prevStatus: res.prevStatus });
  assert.equal(s.history.length, 0);
  assert.equal(t.status, 'in_progress');
  assert.equal(t.completedAt, null);
});

test('일반 reopen → revokedAt + task_reopened', () => {
  const s = M.emptyState();
  const t = M.addTask(s, { title: 'x' }, NOW);
  M.completeTask(s, t.id, NOW);
  M.reopenTask(s, t.id, LATER);
  assert.equal(t.status, 'todo');
  assert.equal(s.history.length, 2);
  assert.equal(s.history[0].revokedAt, LATER.toISOString());
  assert.equal(s.history[1].type, 'task_reopened');
});

test('deleteTask → 미래 블록만 삭제', () => {
  const s = M.emptyState();
  const t = M.addTask(s, { title: 'x' }, NOW);
  const past = M.addBlock(s, { taskId: t.id, start: at(8), end: at(9) });
  M.addBlock(s, { taskId: t.id, start: at(14), end: at(15) });
  const ev = M.addBlock(s, { title: 'ev', start: at(16), end: at(17) });
  M.deleteTask(s, t.id, NOW);
  assert.ok(t.deletedAt);
  assert.equal(s.tasks.length, 1);
  assert.deepEqual(s.blocks.map((b) => b.id), [past.id, ev.id]);
});

test('deleteBlock 은 task 유지', () => {
  const s = M.emptyState();
  const t = M.addTask(s, { title: 'x' }, NOW);
  const b = M.addBlock(s, { taskId: t.id, start: at(14), end: at(15) });
  M.deleteBlock(s, b.id);
  assert.equal(s.blocks.length, 0);
  assert.equal(s.tasks.length, 1);
  assert.equal(t.deletedAt, null);
});

test('mergeSuggestions 중복 key 무시 (상태 무관)', () => {
  const s = M.emptyState();
  const c = { key: 'note1:보고서', title: '보고서', sourceType: 'note', sourceId: 'n1' };
  assert.equal(M.mergeSuggestions(s, [c, Object.assign({}, c)], NOW).length, 1);
  M.dismissSuggestion(s, s.suggestions[0].id, NOW);
  assert.equal(M.mergeSuggestions(s, [c], NOW).length, 0);
  assert.equal(s.suggestions.length, 1);
});

test('acceptSuggestion 두 번 → Task 1개, duplicate:true', () => {
  const s = M.emptyState();
  const [sug] = M.mergeSuggestions(s, [{ key: 'k', title: 't', sourceType: 'note', sourceId: 'n1' }], NOW);
  const a = M.acceptSuggestion(s, sug.id, {}, NOW);
  const b = M.acceptSuggestion(s, sug.id, {}, NOW);
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(b.task.id, a.task.id);
  assert.equal(s.tasks.length, 1);
  assert.equal(a.task.sources[0].suggestionId, sug.id);
});

test('resolveRef: 삭제된 원본은 missing:true', () => {
  const s = M.emptyState();
  const t = M.addTask(s, { title: 'x' }, NOW);
  const n = M.addNote(s, { body: '# 회의록\n내용' }, NOW);
  assert.equal(M.resolveRef(s, { kind: 'task', id: t.id }).missing, false);
  assert.equal(M.resolveRef(s, { kind: 'note', id: n.id }).label, '회의록');
  M.deleteTask(s, t.id, NOW);
  M.deleteNote(s, n.id, NOW);
  assert.equal(M.resolveRef(s, { kind: 'task', id: t.id }).missing, true);
  assert.equal(M.resolveRef(s, { kind: 'note', id: n.id }).missing, true);
  const gone = M.resolveRef(s, { kind: 'email', id: 'nope', label: '옛 제목' });
  assert.equal(gone.missing, true);
  assert.equal(gone.label, '옛 제목');
});
