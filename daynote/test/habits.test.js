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

test('오래 집중(안전망): 90분 넘게 이어서 진행 중인 일', () => {
  const st = M.emptyState();
  const t = M.addTask(st, { title: '집중' }, NOW);
  M.startTask(st, t.id, new Date(NOW.getTime() - 30 * 60000));
  assert.strictEqual(HB.longFocus(st, new Date(NOW.getTime() + 25 * 60000)), null);
  assert.strictEqual(HB.longFocus(st, new Date(NOW.getTime() + 65 * 60000)).id, t.id);
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

test('일한 흐름: 50분쯤 이어서 일한 뒤 일을 끝내면 쉬기 권하기, 30분 비면 새 흐름', () => {
  const at = (m) => new Date(NOW.getTime() + m * 60000);
  let run = null;
  run = HB.touchWork(run, at(0));
  run = HB.touchWork(run, at(25));
  assert.strictEqual(HB.workRunMinutes(run, at(40)), 40);
  assert.strictEqual(HB.restDue(run, at(40), null), false);
  run = HB.touchWork(run, at(50));
  assert.strictEqual(HB.restDue(run, at(52), null), true);
  assert.strictEqual(HB.restDue(run, at(52), at(40).toISOString()), false);   // 20분 안에 권했으면 다시 안 함
  assert.strictEqual(HB.restDue(run, at(52), at(30).toISOString()), true);
  // 30분 넘게 아무것도 안 했으면 쉬다 온 것 — 흐름을 새로
  assert.strictEqual(HB.workRunMinutes(run, at(85)), 0);
  run = HB.touchWork(run, at(85));
  assert.strictEqual(HB.workRunMinutes(run, at(90)), 5);
  // 날이 바뀌면 새로
  const late = HB.touchWork(HB.touchWork(null, new Date(2026, 9, 19, 23, 40)), new Date(2026, 9, 20, 0, 5));
  assert.strictEqual(HB.workRunMinutes(late, new Date(2026, 9, 20, 0, 10)), 5);
  assert.strictEqual(HB.REST_DEFAULT_MIN, 3);
});

test('하루 마무리: 오늘 하려던 일만 묻고, 앞날로 이미 정한 일은 빼기', () => {
  const st = M.emptyState();
  const today = D.ymd(NOW), tom = D.ymd(D.addDays(NOW, 1));
  const a = M.addTask(st, { title: '오늘 마감', dueDate: today }, NOW);
  const b = M.addTask(st, { title: '금요일에 하기', planDate: D.ymd(D.addDays(NOW, 3)) }, NOW);
  const c = M.addTask(st, { title: '다음 주 마감', dueDate: D.ymd(D.addDays(NOW, 7)) }, NOW);
  const d = M.addTask(st, { title: '날짜 없음' }, NOW);
  const e = M.addTask(st, { title: '할 날 오늘', planDate: today, dueDate: tom }, NOW);
  const r = HB.dayClose(st, NOW, [a, b, c, d, e]);
  assert.deepStrictEqual(r.left.map((t) => t.title), ['오늘 마감', '날짜 없음', '할 날 오늘']);
});
