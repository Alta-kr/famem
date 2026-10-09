'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/core/model');
const W = require('../src/core/weekly');

const WEEK = '2026-10-05';                  // 월
const NOW = new Date(2026, 9, 9, 17, 0);    // 금
const at = (d, h) => new Date(2026, 9, d, h || 10, 0);

function setup() {
  const st = M.emptyState();
  M.addProject(st, { id: 'p1', name: '홈페이지 개편' }, at(1));
  M.addTask(st, { id: 't1', title: '시안 검토', projectId: 'p1' }, at(1));
  M.addTask(st, { id: 't2', title: '견적 정리' }, at(1));
  M.addTask(st, { id: 't3', title: '지운 업무', projectId: 'p1' }, at(1));
  M.addTask(st, { id: 't4', title: '이번 주 마감', dueDate: '2026-10-08' }, at(1));
  M.addTask(st, { id: 't5', title: '다음 주 마감', dueDate: '2026-10-14', projectId: 'p1' }, at(1));
  M.addTask(st, { id: 't6', title: '마감 없는 할 일' }, at(1));
  M.completeTask(st, 't1', at(6));
  M.completeTask(st, 't2', at(7));
  M.completeTask(st, 't3', at(7));
  M.deleteTask(st, 't3', at(8));
  M.completeTask(st, 't6', at(2));           // 지난 주 완료 → 제외
  M.reopenTask(st, 't6', at(8));
  M.addHistory(st, { type: 'decision', title: 'B안으로 결정', projectId: 'p1' }, at(7));
  M.addHistory(st, { type: 'blocker', title: 'API 키 대기' }, at(8));
  return st;
}

test('summarize: 완료 그룹·missing·미완료·다음 주', () => {
  const st = setup();
  const s = W.summarize(st, WEEK, NOW);
  assert.strictEqual(s.weekStart, '2026-10-05');
  assert.strictEqual(s.weekEnd, '2026-10-11');
  assert.strictEqual(s.completed.length, 2);
  const g1 = s.completed[0];
  assert.strictEqual(g1.projectName, '홈페이지 개편');
  assert.deepStrictEqual(g1.items.map((i) => [i.title, i.missing]), [['시안 검토', false], ['지운 업무', true]]);
  assert.strictEqual(s.completed[1].projectName, '프로젝트 없음');
  assert.deepStrictEqual(s.unfinished.map((t) => t.taskId), ['t4']);
  assert.deepStrictEqual(s.nextWeek.map((t) => t.taskId), ['t5']);
  assert.strictEqual(s.decisions.length, 1);
  assert.strictEqual(s.blockers.length, 1);
});

test('summarize: 이름이 바뀌면 현재 이름', () => {
  const st = setup();
  M.updateTask(st, 't1', { title: '시안 최종 검토' }, at(9));
  const s = W.summarize(st, WEEK, NOW);
  assert.strictEqual(s.completed[0].items[0].title, '시안 최종 검토');
});

test('draftReport: 섹션·원본 삭제 표시', () => {
  const st = setup();
  const r = W.draftReport(W.summarize(st, WEEK, NOW), st);
  assert.ok(r.startsWith('# 주간업무보고 (10월 5일 – 10월 11일)'));
  ['## 이번 주 한 일', '### 홈페이지 개편', '## 진행 중·남은 일', '## 결정 사항', '## 이슈·장애물', '## 다음 주 계획'].forEach((h) => assert.ok(r.includes(h), h));
  assert.ok(r.includes('- 지운 업무 (원본 삭제됨)'));
  assert.ok(r.includes('- [홈페이지 개편] B안으로 결정'));
  assert.ok(r.includes('- 이번 주 마감 (마감 10/8)'));
});

test('draftReport: 기록 없으면 모든 섹션 기록 없음', () => {
  const st = M.emptyState();
  const s = W.summarize(st, WEEK, NOW);
  assert.strictEqual(s.recordCount, 0);
  const r = W.draftReport(s, st);
  assert.strictEqual((r.match(/- 기록 없음/g) || []).length, 5);
});

test('carryOver: +7일 / 없으면 다음 주 월요일, 완료는 그대로', () => {
  const st = setup();
  const changed = W.carryOver(st, ['t4', 't6', 't1'], WEEK, NOW);
  assert.deepStrictEqual(changed.map((t) => [t.id, t.dueDate]), [['t4', '2026-10-15'], ['t6', '2026-10-12']]);
  assert.strictEqual(M.byId(st.tasks, 't4').updatedAt, NOW.toISOString());
});
