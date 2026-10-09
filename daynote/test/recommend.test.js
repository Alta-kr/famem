'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/core/model');
const R = require('../src/core/recommend');

const NOW = new Date(2026, 9, 5, 10, 0);
const at = (h, m) => new Date(2026, 9, 5, h, m || 0).toISOString();
const ids = (list) => list.map((i) => i.taskId);

function setup() { return M.emptyState(); }
function task(s, fields) { return M.addTask(s, fields, NOW); }
function event(s, sh, sm, eh, em) { return M.addBlock(s, { title: '회의', start: at(sh, sm), end: at(eh, em) }); }

test('1. 다음 일정까지 30분: 20분은 fits/primary, 60분은 tooLong', () => {
  const s = setup();
  event(s, 10, 30, 11, 0);
  const a = task(s, { title: '20분', estimateMinutes: 20 });
  const b = task(s, { title: '60분', estimateMinutes: 60 });
  const r = R.recommend(s, { now: NOW });
  assert.equal(r.context.source, 'calendar');
  assert.equal(r.context.availableMinutes, 30);
  assert.equal(r.primary.taskId, a.id);
  assert.equal(r.primary.fit, 'fits');
  assert.deepEqual(ids(r.tooLong), [b.id]);
  assert.ok(!ids(r.ranked).includes(b.id));
});

test('1. 사용자 availableMinutes 가 캘린더보다 우선', () => {
  const s = setup();
  event(s, 10, 30, 11, 0);
  const b = task(s, { title: '60분', estimateMinutes: 60 });
  const r = R.recommend(s, { now: NOW, availableMinutes: 90 });
  assert.equal(r.context.source, 'user');
  assert.equal(r.context.availableMinutes, 90);
  assert.equal(r.primary.taskId, b.id);
  assert.equal(r.tooLong.length, 0);
});

test('2. waiting / 선행 미완료는 마감이 급해도 제외, 선행 완료 후엔 후보', () => {
  const s = setup();
  const pre = task(s, { title: '선행', status: 'waiting' });
  const w = task(s, { title: '대기', status: 'waiting', dueDate: '2026-10-04' });
  const blocked = task(s, { title: '막힘', dueDate: '2026-10-04', blockedBy: [pre.id] });
  let r = R.recommend(s, { now: NOW });
  assert.ok(!ids(r.ranked).includes(w.id));
  assert.ok(!ids(r.ranked).includes(blocked.id));
  assert.equal(r.primary, null);
  assert.equal(r.excluded.waiting, 2);
  assert.equal(r.excluded.blocked, 1);

  M.completeTask(s, pre.id, NOW);
  r = R.recommend(s, { now: NOW });
  assert.equal(r.primary.taskId, blocked.id);
  assert.ok(!ids(r.ranked).includes(w.id));
});

test('3. done / deletedAt / 미래 snoozedUntil 제외, 미루기 지나면 복귀', () => {
  const s = setup();
  const d = task(s, { title: 'done' }); M.completeTask(s, d.id, NOW);
  const del = task(s, { title: 'del' }); M.deleteTask(s, del.id, NOW);
  const sn = task(s, { title: 'snooze' });
  M.snoozeTask(s, sn.id, at(11, 0), NOW);
  let r = R.recommend(s, { now: NOW });
  assert.deepEqual(r.ranked, []);
  assert.equal(r.excluded.snoozed, 1);
  assert.equal(r.excluded.done, 1);

  r = R.recommend(s, { now: new Date(2026, 9, 5, 11, 1) });
  assert.deepEqual(ids(r.ranked), [sn.id]);
});

test('4. estimate null → unknown, 0분 취급 안 함, fits 뒤', () => {
  const s = setup();
  const u = task(s, { title: '미정', dueDate: '2026-10-05' });
  const f = task(s, { title: '10분', estimateMinutes: 10 });
  const r = R.recommend(s, { now: NOW, availableMinutes: 30 });
  const ui = r.ranked.find((i) => i.taskId === u.id);
  assert.equal(ui.fit, 'unknown');
  assert.equal(ui.estimateUnknown, true);
  assert.notEqual(ui.slack, 30); // 0분 취급이면 slack 30
  assert.deepEqual(ids(r.ranked), [f.id, u.id]); // 마감이 급해도 fits 그룹이 먼저
});

test('4. AI 추정 이유 문구에 (추정)', () => {
  const s = setup();
  const t = task(s, { title: 'ai', estimateMinutes: 20, estimateSource: 'ai' });
  const r = R.recommend(s, { now: NOW, availableMinutes: 30 });
  assert.equal(r.primary.taskId, t.id);
  assert.equal(r.primary.estimateIsGuess, true);
  assert.ok(r.primary.reasons.some((x) => x.includes('(추정)')));
});

test('5. empty 값과 tasks 불변', () => {
  let s = setup();
  let r = R.recommend(s, { now: NOW });
  assert.equal(r.empty, 'no_tasks');
  assert.equal(s.tasks.length, 0);

  s = setup();
  task(s, { title: 'w', status: 'waiting' });
  r = R.recommend(s, { now: NOW });
  assert.equal(r.empty, 'all_excluded');
  assert.equal(s.tasks.length, 1);

  s = setup();
  task(s, { title: 'long', estimateMinutes: 120 });
  r = R.recommend(s, { now: NOW, availableMinutes: 15 });
  assert.equal(r.empty, 'time_short');
  assert.equal(s.tasks.length, 1);
});

test('6. startTask 반복 호출해도 tasks 길이 불변, 다른 진행 중 업무는 todo', () => {
  const s = setup();
  const a = task(s, { title: 'a', status: 'in_progress' });
  const b = task(s, { title: 'b' });
  const r1 = M.startTask(s, b.id, NOW);
  M.startTask(s, b.id, NOW);
  M.startTask(s, b.id, NOW);
  assert.equal(s.tasks.length, 2);
  assert.deepEqual(r1.switchedFrom, [a.id]);
  assert.equal(a.status, 'todo');
  assert.equal(b.status, 'in_progress');
});

test('7. 이메일/AI 없이 동작', () => {
  const s = setup();
  assert.equal(s.emails.length, 0);
  const t = task(s, { title: 'x', estimateMinutes: 10 });
  const r = R.recommend(s, { now: NOW });
  assert.equal(r.primary.taskId, t.id);
  assert.equal(r.context.source, 'none');
  assert.equal(r.primary.fit, 'open');
});

test('8. 블록 이동 → availableMinutes, signature 변경', () => {
  const s = setup();
  const e = event(s, 10, 30, 11, 0);
  task(s, { title: 'x', estimateMinutes: 10 });
  const sig1 = R.signature(s);
  assert.equal(R.recommend(s, { now: NOW }).context.availableMinutes, 30);
  M.updateBlock(s, e.id, { start: at(11, 0), end: at(12, 0) });
  assert.equal(R.recommend(s, { now: NOW }).context.availableMinutes, 60);
  assert.notEqual(R.signature(s), sig1);
});

test('9. skipIds / snoozeTask 후에도 task 유지', () => {
  const s = setup();
  const a = task(s, { title: 'a', estimateMinutes: 10 });
  const b = task(s, { title: 'b', estimateMinutes: 10 });
  const first = R.recommend(s, { now: NOW }).primary.taskId;
  const r = R.recommend(s, { now: NOW, skipIds: [first] });
  assert.notEqual(r.primary.taskId, first);
  M.snoozeTask(s, a.id, at(12, 0), NOW);
  assert.equal(s.tasks.length, 2);
  assert.equal(M.byId(s.tasks, a.id).deletedAt, null);
  assert.equal(M.byId(s.tasks, b.id).deletedAt, null);
  const all = R.recommend(s, { now: NOW, skipIds: [b.id] });
  assert.equal(all.empty, 'all_skipped');
});

test('정렬: 긴급도 (초과 → 오늘 → 내일 → 7일 → 없음)', () => {
  const s = setup();
  const none = task(s, { title: 'none' });
  const week = task(s, { title: 'week', dueDate: '2026-10-09' });
  const tmr = task(s, { title: 'tmr', dueDate: '2026-10-06' });
  const today = task(s, { title: 'today', dueDate: '2026-10-05' });
  const over = task(s, { title: 'over', dueDate: '2026-10-03' });
  const r = R.recommend(s, { now: NOW });
  assert.deepEqual(ids(r.ranked), [over.id, today.id, tmr.id, week.id, none.id]);
});

test('정렬: 이어하기 (진행 중, 지금 작업 블록) 먼저', () => {
  const s = setup();
  const plain = task(s, { title: 'plain' });
  const prog = task(s, { title: 'prog', status: 'in_progress' });
  const r = R.recommend(s, { now: NOW });
  assert.deepEqual(ids(r.ranked), [prog.id, plain.id]);

  const s2 = setup();
  const p2 = task(s2, { title: 'plain' });
  const w2 = task(s2, { title: 'blocked-time' });
  M.addBlock(s2, { taskId: w2.id, start: at(9, 30), end: at(11, 0) });
  const r2 = R.recommend(s2, { now: NOW });
  assert.deepEqual(ids(r2.ranked), [w2.id, p2.id]);
});

test('정렬: 우선순위 높음 → 보통/미지정 → 낮음', () => {
  const s = setup();
  const low = task(s, { title: 'low', priority: 'low' });
  const nul = task(s, { title: 'null' });
  const high = task(s, { title: 'high', priority: 'high' });
  const r = R.recommend(s, { now: NOW });
  assert.equal(r.ranked[0].taskId, high.id);
  assert.equal(r.ranked[2].taskId, low.id);
  assert.equal(r.ranked[1].taskId, nul.id);
});

test('정렬: 동률은 createdAt → id 순으로 결정적', () => {
  const s = setup();
  M.addTask(s, { id: 'task_b', title: 'b' }, NOW);
  M.addTask(s, { id: 'task_a', title: 'a' }, NOW);
  M.addTask(s, { id: 'task_0', title: 'old', createdAt: new Date(2026, 9, 1).toISOString() }, NOW);
  const r1 = ids(R.recommend(s, { now: NOW }).ranked);
  s.tasks.reverse();
  const r2 = ids(R.recommend(s, { now: NOW }).ranked);
  assert.deepEqual(r1, ['task_0', 'task_a', 'task_b']);
  assert.deepEqual(r2, r1);
});

test('step_fits: 전체는 길지만 들어가는 단계를 제안', () => {
  const s = setup();
  const t = task(s, {
    title: 'big', estimateMinutes: 120,
    steps: [{ title: '끝난 단계', done: true, estimateMinutes: 10 }, { title: '초안', done: false, estimateMinutes: 25 }]
  });
  const r = R.recommend(s, { now: NOW, availableMinutes: 30 });
  assert.equal(r.primary.taskId, t.id);
  assert.equal(r.primary.fit, 'step_fits');
  assert.equal(r.primary.step.title, '초안');
  assert.equal(r.tooLong.length, 0);
});

// 근무 시간 정책 (UX 검토 반영): 근무 시간 밖에는 캘린더 빈 시간을 가용 시간으로 정하지 않는다
test('근무 시간 밖(00:15)에는 다음 일정까지 비어 있어도 가용 시간을 정하지 않고 사용자 입력을 기다린다', () => {
  const M = require('../src/core/model');
  const R = require('../src/core/recommend');
  const st = M.emptyState();
  const night = new Date(2026, 9, 5, 0, 15);
  M.addBlock(st, { title: '팀 회의', start: new Date(2026, 9, 5, 10, 30).toISOString(), end: new Date(2026, 9, 5, 11, 30).toISOString() });
  M.addTask(st, { title: '20분 업무', estimateMinutes: 20 }, night);
  const r = R.recommend(st, { now: night });
  assert.strictEqual(r.context.source, 'none');
  assert.strictEqual(r.context.offHours, true);
  assert.strictEqual(r.context.availableMinutes, null);
  const r2 = R.recommend(st, { now: night, availableMinutes: 30 });
  assert.strictEqual(r2.context.source, 'user');
  assert.strictEqual(r2.context.offHours, false);
});

test('다음 일정이 근무 종료 뒤면 가용 시간은 근무 종료까지로 자른다', () => {
  const M = require('../src/core/model');
  const R = require('../src/core/recommend');
  const st = M.emptyState();
  const now = new Date(2026, 9, 5, 17, 0);
  M.addBlock(st, { title: '저녁 약속', start: new Date(2026, 9, 5, 19, 0).toISOString(), end: new Date(2026, 9, 5, 20, 0).toISOString() });
  M.addTask(st, { title: '업무', estimateMinutes: 30 }, now);
  const r = R.recommend(st, { now });
  assert.strictEqual(r.context.availableMinutes, 60);
  assert.strictEqual(r.context.until, 'work_end');
  assert.match(r.primary.reasons[0], /근무 종료\(18:00\)까지 1시간/);
});
