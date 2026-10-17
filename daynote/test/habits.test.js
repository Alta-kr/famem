'use strict';

// 연구 기반 도움들 — 계획 오류 보정, 오래 집중, 하루 마무리, 밀린 일, 새 주 시작

const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/core/model');
const D = require('../src/core/dates');
const HB = require('../src/core/habits');

const NOW = new Date(2026, 9, 19, 15, 0);   // 월요일

function doneTask(st, est, workedMin) {
  const t = M.addTask(st, { title: 't' + st.tasks.length, estimateMinutes: est }, NOW);
  t.workedMs = workedMin * 60000;
  M.completeTask(st, t.id, NOW);
  return t;
}

test('계획 오류: 끝낸 일 3개부터 예상 대비 실제 비율(중앙값), 벗어날 때만 현실 시간', () => {
  const st = M.emptyState();
  const open = M.addTask(st, { title: '보고서', estimateMinutes: 40 }, NOW);
  doneTask(st, 30, 45);
  doneTask(st, 20, 30);
  assert.strictEqual(HB.estimateRatio(st), null);              // 아직 2개
  doneTask(st, 60, 90);
  assert.deepStrictEqual(HB.estimateRatio(st), { ratio: 1.5, n: 3 });
  assert.deepStrictEqual(HB.realistic(st, open), { minutes: 60, ratio: 1.5, n: 3 });
  // 거의 맞게 예상하면 알려 주지 않음
  const st2 = M.emptyState();
  const o2 = M.addTask(st2, { title: 'x', estimateMinutes: 30 }, NOW);
  doneTask(st2, 30, 31); doneTask(st2, 20, 21); doneTask(st2, 10, 10);
  assert.strictEqual(HB.realistic(st2, o2), null);
});

test('오래 집중: 50분 넘게 이어서 진행 중인 일', () => {
  const st = M.emptyState();
  const t = M.addTask(st, { title: '집중' }, NOW);
  M.startTask(st, t.id, new Date(NOW.getTime() - 30 * 60000));
  assert.strictEqual(HB.longFocus(st, NOW), null);
  assert.strictEqual(HB.longFocus(st, new Date(NOW.getTime() + 25 * 60000)).id, t.id);
  M.pauseTask(st, t.id, NOW);
  assert.strictEqual(HB.longFocus(st, new Date(NOW.getTime() + 60 * 60000)), null);
});

test('하루 마무리: 다음 시각 선택지 (오늘 오후/저녁 · 내일 오전·오후 · 이번 주 금요일)', () => {
  const am = HB.whenChoices(new Date(2026, 9, 19, 10, 0)).map((c) => c.label);
  assert.deepStrictEqual(am, ['오늘 오후', '내일 오전', '내일 오후', '이번 주 금요일']);
  const eve = HB.whenChoices(new Date(2026, 9, 19, 20, 0)).map((c) => c.label);
  assert.deepStrictEqual(eve, ['내일 오전', '내일 오후', '이번 주 금요일']);
  const fri = HB.whenChoices(new Date(2026, 9, 23, 16, 0));
  assert.strictEqual(fri[fri.length - 1].label, '다음 주 월요일');
  assert.strictEqual(D.ymd(fri[fri.length - 1].at), '2026-10-26');
  const st = M.emptyState();
  const a = M.addTask(st, { title: 'a' }, NOW); M.completeTask(st, a.id, NOW);
  const b = M.addTask(st, { title: 'b' }, NOW);
  const r = HB.dayClose(st, NOW, [b]);
  assert.deepStrictEqual([r.done.map((t) => t.title), r.left.map((t) => t.title)], [['a'], ['b']]);
});

test('밀린 일: 전부 내일로 (시각 유지), 끝낸 일은 그대로', () => {
  const st = M.emptyState();
  const a = M.addTask(st, { title: 'a', dueDate: '2026-10-15', dueTime: '18:00' }, NOW);
  const b = M.addTask(st, { title: 'b', dueDate: '2026-10-19', dueTime: '09:00' }, NOW);
  const c = M.addTask(st, { title: 'c', dueDate: '2026-10-25' }, NOW);
  assert.deepStrictEqual(HB.overdueTasks(st, NOW).map((t) => t.title), ['a', 'b']);
  HB.postponeOverdueToTomorrow(st, NOW);
  assert.deepStrictEqual([a.dueDate, a.dueTime, b.dueDate, c.dueDate], ['2026-10-20', '18:00', '2026-10-20', '2026-10-25']);
});

test('새 주 시작: 주마다 한 번, 꼭 끝낼 일은 3개까지', () => {
  const st = M.emptyState();
  const ts = ['a', 'b', 'c', 'd'].map((x) => M.addTask(st, { title: x }, NOW));
  assert.strictEqual(HB.shouldOfferWeekStart(st, NOW), true);
  assert.strictEqual(HB.setWeekGoals(st, ts.map((t) => t.id), NOW), 3);
  assert.deepStrictEqual(ts.map((t) => HB.isWeekGoal(t, NOW)), [true, true, true, false]);
  assert.strictEqual(HB.shouldOfferWeekStart(st, NOW), false);
  assert.strictEqual(HB.shouldOfferWeekStart(st, new Date(2026, 9, 26, 9, 0)), true);   // 다음 주
  assert.strictEqual(HB.isWeekGoal(ts[0], new Date(2026, 9, 26, 9, 0)), false);
});
