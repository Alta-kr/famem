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

// ================================================================== 근무 시간 요일 · 상태 반향 (FEATURES §7.5)

const SAT = new Date(2026, 9, 10, 10, 0);
const satAt = (h, m) => new Date(2026, 9, 10, h, m || 0).toISOString();

test('토요일 10:00, 11:00 일정, 근무 시간 없음 → 근무 시간 밖(offHours), T 모름', () => {
  const s = setup();
  M.addBlock(s, { title: '브런치', start: satAt(11, 0), end: satAt(12, 0) });
  M.addTask(s, { title: '20분', estimateMinutes: 20 }, SAT);
  const r = R.recommend(s, { now: SAT });
  assert.equal(r.context.offHours, true);
  assert.equal(r.context.source, 'none');
  assert.equal(r.context.availableMinutes, null);
  assert.deepEqual(r.context.workHours, { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] });
});

test('workHours.days 에 토요일(6)이 있으면 같은 조건에서 캘린더 T 60분', () => {
  const s = setup();
  M.addBlock(s, { title: '브런치', start: satAt(11, 0), end: satAt(12, 0) });
  M.addTask(s, { title: '20분', estimateMinutes: 20 }, SAT);
  const r = R.recommend(s, { now: SAT, workHours: { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5, 6] } });
  assert.equal(r.context.offHours, false);
  assert.equal(r.context.source, 'calendar');
  assert.equal(r.context.availableMinutes, 60);
  assert.equal(r.context.until, 'next');
});

test('opts.status 는 context.status 로 그대로 돌아오고 결과 순서는 같다', () => {
  const s = setup();
  event(s, 10, 30, 11, 0);
  task(s, { title: 'a', estimateMinutes: 20 });
  task(s, { title: 'b', dueDate: '2026-10-05' });
  task(s, { title: 'c', priority: 'high' });
  const status = { id: 'meeting', label: '회의 중', busy: true, until: at(11, 0), guessed: false };
  const plain = R.recommend(s, { now: NOW });
  const r = R.recommend(s, { now: NOW, status });
  assert.equal(plain.context.status, null);
  assert.deepEqual(r.context.status, status);
  assert.deepEqual(ids(r.ranked), ids(plain.ranked));
  assert.equal(r.primary.taskId, plain.primary.taskId);
});

// ================================================================== Google 일정 (GOOGLE #17–18)

const V4 = M.SCHEMA_VERSION >= 4;                                                  // W1-model
function gev(id, s, e, extra) {
  return Object.assign({ key: 'g:cal1|' + id, calendarId: 'cal1', eventId: id, status: 'confirmed', title: id, location: '', htmlLink: '',
    allDay: false, start: s, end: e, startDate: null, endDate: null, busy: true, response: null, origin: 'google' }, extra || {});
}

test('GOOGLE 17. Google 회의 중이면 busyWith 가 그 회의, 다음 Google 회의까지 30분이면 T 30', { skip: !V4 && 'W1-model 병합 전' }, () => {
  const s = setup();
  s.gcal.events.push(gev('standup', at(9, 30), at(10, 15), { title: '스탠드업' }));
  task(s, { title: '20분', estimateMinutes: 20 });
  const cal = R.calendarContext(s, NOW);
  assert.equal(cal.busyWith.id, 'g:cal1|standup');
  let r = R.recommend(s, { now: NOW });
  assert.equal(r.context.busyWith.title, '스탠드업');
  assert.equal(r.context.source, 'none');

  const s2 = setup();
  s2.gcal.events.push(gev('weekly', at(10, 30), at(11, 30), { title: '주간 회의' }));
  task(s2, { title: '20분', estimateMinutes: 20 });
  r = R.recommend(s2, { now: NOW });
  assert.equal(r.context.source, 'calendar');
  assert.equal(r.context.until, 'next');
  assert.equal(r.context.availableMinutes, 30);
  assert.equal(r.context.next.title, '주간 회의');
  assert.match(r.primary.reasons[0], /다음 일정 ‘주간 회의’까지 30분/);
  // 오프셋 ISO 로 저장된 Google 일정도 같은 순간으로 읽는다
  const s3 = setup();
  const kst = (d) => { const k = new Date(d.getTime() + 9 * 3600000); return k.toISOString().slice(0, 19) + '+09:00'; };
  s3.gcal.events.push(gev('kst', kst(new Date(2026, 9, 5, 10, 45)), kst(new Date(2026, 9, 5, 11, 15))));
  assert.equal(R.recommend(s3, { now: NOW }).context.availableMinutes, 45);
});

test('GOOGLE 18. 종일 ‘연차’ 일정만 있으면 T 는 기존 규칙과 같다 (종일은 바쁨이 아님)', { skip: !V4 && 'W1-model 병합 전' }, () => {
  const make = (withAllDay) => {
    const s = setup();
    if (withAllDay) s.gcal.events.push(gev('vac', new Date(2026, 9, 5).toISOString(), new Date(2026, 9, 6).toISOString(),
      { title: '연차', allDay: true, busy: false, startDate: '2026-10-05', endDate: '2026-10-06' }));
    M.addTask(s, { id: 'task_x', title: '20분', estimateMinutes: 20, createdAt: at(8, 0) }, NOW);
    return s;
  };
  assert.deepEqual(R.recommend(make(true), { now: NOW }), R.recommend(make(false), { now: NOW }));
  assert.equal(R.recommend(make(true), { now: NOW }).context.source, 'none');
  assert.equal(R.calendarContext(make(true), NOW).busyWith, null);
  // 한가함(busy:false)으로 표시된 일정도 T 를 정하지 않는다
  const s = make(false);
  s.gcal.events.push(gev('free', at(10, 30), at(11, 0), { busy: false }));
  assert.equal(R.recommend(s, { now: NOW }).context.source, 'none');
});

// ================================================================== 현재 상태 statusView (STATUS §8, #116–#128)
// statusView 는 status.js 없이 손으로 만든 평범한 데이터다 (recommend 는 status 를 모른다).

function sv(fields) {
  return Object.assign({
    active: true, id: 'off', label: '퇴근 · 내 시간', category: 'life', guessed: false, since: at(9, 0),
    overlay: null, rec: 'normal', busy: false, nudges: true, remainMinutes: null, offHours: true, workWindow: null,
    levels: {}, hiddenIds: [], anchored: [], summary: { hidden: 0, byCtx: {}, parked: 0 }
  }, fields || {});
}
function lv(level, ctx, extra) {
  return Object.assign({ level, reason: 'policy', ctx: ctx || null, ctxSource: ctx ? 'rule' : null, ctxLabel: null, evidence: null, breakthrough: null, sentence: null }, extra || {});
}
const OLD = '2026-10-01T00:00:00.000Z';

test('116. statusView 가 없으면 결과가 상태 없는 결과와 deepEqual 이고 새 키가 없다 (I1)', () => {
  const s = setup();
  event(s, 10, 30, 11, 0);
  task(s, { title: '업무', estimateMinutes: 20, createdAt: OLD });
  task(s, { title: '긴 업무', estimateMinutes: 90, createdAt: OLD });
  task(s, { title: '대기', status: 'waiting', createdAt: OLD });
  const a = R.recommend(s, { now: NOW });
  const b = R.recommend(s, { now: NOW, statusView: null });
  assert.deepEqual(a, b);
  assert.deepEqual(Object.keys(a), ['evaluatedAt', 'context', 'primary', 'alternatives', 'ranked', 'tooLong', 'excluded', 'empty']);
  assert.deepEqual(Object.keys(a.excluded), ['done', 'waiting', 'blocked', 'snoozed']);
  assert.ok('status' in a.context);
  assert.equal(a.context.status, null);
  a.ranked.concat(a.tooLong).forEach((i) => {
    assert.ok(!('levelRank' in i) && !('level' in i) && !('ctx' in i));
  });
  assert.equal(a.primary.reasons.length, b.primary.reasons.length);
});

test('118. 명시 퇴근: 숨긴 업무는 ranked 에 없고 excluded.hidden·hiddenIds 가 맞으며 primary 는 집 일', () => {
  const s = setup();
  const w1 = task(s, { title: '견적서 보내기', createdAt: OLD });
  const w2 = task(s, { title: '회의록 정리', dueDate: '2026-10-04', createdAt: OLD });
  const home = task(s, { title: '빨래 돌리기', createdAt: OLD });
  const v = sv({ levels: { [w1.id]: lv('hide', 'work'), [w2.id]: lv('hide', 'work'), [home.id]: lv('up', 'home') } });
  const r = R.recommend(s, { now: NOW, statusView: v });
  assert.deepEqual(ids(r.ranked), [home.id]);
  assert.equal(r.excluded.hidden, 2);
  assert.deepEqual(r.hiddenIds.slice().sort(), [w1.id, w2.id].sort());
  assert.deepEqual(r.hiddenIds, s.tasks.filter((t) => t.id !== home.id).map((t) => t.id));   // 입력 순서
  assert.equal(r.primary.taskId, home.id);
  assert.equal(r.primary.level, 'up');
  assert.equal(r.primary.levelRank, 0);
  assert.equal(r.primary.ctx, 'home');
  assert.equal(r.context.offHours, true);
  assert.equal(r.context.source, 'none');
  // 수준을 모르는 할 일은 보통(1)
  const other = task(s, { title: '맥락 없음', createdAt: OLD });
  const r2 = R.recommend(s, { now: NOW, statusView: v });
  const item = r2.ranked.find((i) => i.taskId === other.id);
  assert.equal(item.level, 'normal');
  assert.equal(item.levelRank, 1);
  assert.equal(item.ctx, null);
});

test('119. levelRank 가 첫 정렬 키: 명시 업무에서 날짜 없는 업무가 기한 지난 ‘빨래’보다 먼저', () => {
  const s = setup();
  const laundry = task(s, { title: '빨래', dueDate: '2026-10-03', createdAt: OLD });
  const work = task(s, { title: '견적서', createdAt: OLD });
  const v = sv({ id: 'work', label: '업무 중', category: 'work', offHours: false, levels: { [laundry.id]: lv('down', 'home'), [work.id]: lv('up', 'work') } });
  assert.deepEqual(ids(R.recommend(s, { now: NOW }).ranked), [laundry.id, work.id]);
  const r = R.recommend(s, { now: NOW, statusView: v });
  assert.deepEqual(ids(r.ranked), [work.id, laundry.id]);
  assert.deepEqual(r.ranked.map((i) => i.levelRank), [0, 2]);
});

test('120. 모두 숨김 → empty all_hidden (판정 순서: no_tasks → time_short → all_hidden → all_excluded)', () => {
  const s = setup();
  const a = task(s, { title: '업무 1', createdAt: OLD });
  const b = task(s, { title: '업무 2', createdAt: OLD });
  task(s, { title: '대기', status: 'waiting', createdAt: OLD });
  const v = sv({ levels: { [a.id]: lv('hide', 'work'), [b.id]: lv('hide', 'work') } });
  const r = R.recommend(s, { now: NOW, statusView: v });
  assert.equal(r.empty, 'all_hidden');
  assert.equal(r.primary, null);
  assert.equal(r.excluded.hidden, 2);
  assert.equal(r.excluded.waiting, 1);
  // 숨기지 않은 할 일이 너무 길기만 하면 time_short 가 먼저
  const c = task(s, { title: '긴 일', estimateMinutes: 120, createdAt: OLD });
  assert.equal(R.recommend(s, { now: NOW, availableMinutes: 15, statusView: v }).empty, 'time_short');
  M.deleteTask(s, c.id, NOW);
  assert.equal(R.recommend(s, { now: NOW, statusView: v }).empty, 'all_hidden');
  // 숨긴 것이 없으면 all_excluded, 할 일이 아예 없으면 no_tasks
  const s2 = setup();
  task(s2, { title: '대기만', status: 'waiting', createdAt: OLD });
  assert.equal(R.recommend(s2, { now: NOW, statusView: sv() }).empty, 'all_excluded');
  assert.equal(R.recommend(setup(), { now: NOW, statusView: v }).empty, 'no_tasks');
  // 상태 없이 같은 데이터는 지금처럼 (숨기지 않는다)
  assert.equal(R.recommend(s, { now: NOW }).ranked.length, 2);
});

test('121. 휴식 덧씌움 12분 남음 → T 12, source status, until status_end, 30분 할 일은 too_long', () => {
  const s = setup();
  event(s, 10, 30, 11, 0);
  const short = task(s, { title: '메일 확인', estimateMinutes: 10, createdAt: OLD });
  const long = task(s, { title: '보고서 초안', estimateMinutes: 30, createdAt: OLD });
  const v = sv({ id: 'work', label: '업무 중', category: 'work', offHours: false, rec: 'short', remainMinutes: 12,
    overlay: { id: 'break', label: '휴식', until: at(10, 12), rec: 'short' }, workWindow: { start: at(9, 0), end: at(18, 0) } });
  const r = R.recommend(s, { now: NOW, statusView: v });
  assert.equal(r.context.availableMinutes, 12);
  assert.equal(r.context.source, 'status');
  assert.equal(r.context.until, 'status_end');
  assert.deepEqual(ids(r.tooLong), [long.id]);
  assert.equal(r.primary.taskId, short.id);
  assert.equal(r.primary.fit, 'fits');
  assert.equal(r.primary.reasons[0], '‘휴식’ 남은 시간(12분) 안에 끝나는 일을 골랐어요.');
  assert.equal(r.primary.reasons[1], '지금 쓸 수 있는 시간이 12분이고, 이 업무는 약 10분입니다.');
  // 사용자가 고른 시간이 늘 먼저
  const u = R.recommend(s, { now: NOW, availableMinutes: 60, statusView: v });
  assert.equal(u.context.source, 'user');
  assert.ok(!u.primary.reasons.some((x) => /남은 시간\(/.test(x)));
  // 덧씌움이 없으면 바탕 상태 이름을 쓴다
  const v2 = sv({ id: 'work', label: '업무 중', category: 'work', offHours: false, remainMinutes: 12 });
  assert.equal(R.recommend(s, { now: NOW, statusView: v2 }).primary.reasons[0], '‘업무 중’ 남은 시간(12분) 안에 끝나는 일을 골랐어요.');
});

test('122. 회의·수업·운전·운동·잘 시간(rec none) → primary 없음, empty quiet, ranked 는 계산된다', () => {
  const s = setup();
  const a = task(s, { title: '견적서', estimateMinutes: 20, createdAt: OLD });
  const b = task(s, { title: '보고서', estimateMinutes: 40, createdAt: OLD });
  ['meeting', 'class', 'driving', 'exercise', 'sleep'].forEach((id) => {
    const v = sv({ id, label: id, category: id === 'sleep' ? 'sleep' : 'work', rec: 'none', offHours: false,
      overlay: id === 'sleep' ? null : { id, label: id, until: at(11, 0), rec: 'none' } });
    const r = R.recommend(s, { now: NOW, statusView: v });
    assert.equal(r.empty, 'quiet', id);
    assert.equal(r.primary, null);
    assert.deepEqual(r.alternatives, []);
    assert.deepEqual(ids(r.ranked).sort(), [a.id, b.id].sort());
    assert.equal(r.context.source, 'none');
    assert.equal(r.context.availableMinutes, null);
    // 사용자가 시간을 골라도 쉰다 (ranked·tooLong 은 그 시간으로 계산)
    const u = R.recommend(s, { now: NOW, availableMinutes: 30, statusView: v });
    assert.equal(u.empty, 'quiet');
    assert.equal(u.primary, null);
    assert.equal(u.context.source, 'user');
    assert.deepEqual(ids(u.tooLong), [b.id]);
  });
});

test('123. 명시 업무 + 20:00 → offHours false, T 를 근무 끝으로 자르지 않음(다음 일정까지)', () => {
  const s = setup();
  const night = new Date(2026, 9, 5, 20, 0);
  M.addBlock(s, { title: '배포 점검', start: at(21, 0), end: at(22, 0) });
  M.addTask(s, { title: '야근 업무', estimateMinutes: 30, createdAt: OLD }, night);
  const v = sv({ id: 'work', label: '야근', category: 'work', offHours: false, workWindow: null });
  const r = R.recommend(s, { now: night, statusView: v });
  assert.equal(r.context.offHours, false);
  assert.equal(r.context.source, 'calendar');
  assert.equal(r.context.until, 'next');
  assert.equal(r.context.availableMinutes, 60);
  assert.equal(R.recommend(s, { now: night }).context.source, 'none');              // 상태가 없으면 근무 시간 밖
  // 시간표 안의 명시 업무는 sv.workWindow 끝(18:00)에서 자른다
  const s2 = setup();
  const five = new Date(2026, 9, 5, 17, 0);
  M.addBlock(s2, { title: '저녁 약속', start: at(19, 0), end: at(20, 0) });
  M.addTask(s2, { title: '업무', estimateMinutes: 30, createdAt: OLD }, five);
  const r2 = R.recommend(s2, { now: five, statusView: sv({ id: 'work', label: '업무 중', category: 'work', offHours: false, workWindow: { start: at(9, 0), end: at(18, 0) } }) });
  assert.equal(r2.context.availableMinutes, 60);
  assert.equal(r2.context.until, 'work_end');
});

test('124. 명시 퇴근 + 평일 10:00 → offHours true → source none, 사용자 T 가 있으면 사용자 T', () => {
  const s = setup();
  event(s, 10, 30, 11, 0);
  task(s, { title: '빨래', estimateMinutes: 20, createdAt: OLD });
  const v = sv({ offHours: true });
  const r = R.recommend(s, { now: NOW, statusView: v });
  assert.equal(r.context.offHours, true);
  assert.equal(r.context.source, 'none');
  assert.equal(r.context.availableMinutes, null);
  assert.equal(R.recommend(s, { now: NOW }).context.source, 'calendar');
  const u = R.recommend(s, { now: NOW, availableMinutes: 45, statusView: v });
  assert.equal(u.context.source, 'user');
  assert.equal(u.context.availableMinutes, 45);
  assert.equal(u.context.offHours, false);
});

test('125. 상태 이유는 최대 1개, 맨 앞: when·phone·돌파·up 문장(ST.view 가 만든 것)과 primary down 문장', () => {
  const s = setup();
  const t = (title, extra) => task(s, Object.assign({ title, createdAt: OLD, priority: 'high' }, extra || {}));
  const when = t('우유 사기');
  const phone = t('엄마한테 전화');
  const soon = t('견적서 회신', { dueDate: '2026-10-05', dueTime: '19:00' });
  const later = t('보고서', { dueDate: '2026-10-06', dueTime: '09:00' });
  const up = t('빨래');
  const plain = t('맥락 없음');
  const S = {
    when: '‘퇴근하고’ 하기로 한 일이에요.',
    phone: '이동 중에 폰으로 할 수 있는 일이에요.',
    soon: '‘업무’ 할 일이지만 19:00 마감이라 골랐어요.',
    later: '‘업무’ 할 일이지만 내일 09:00 마감이라 남겨 뒀어요.',
    up: '지금은 ‘퇴근 · 내 시간’이라 ‘집안일’ 일을 먼저 골랐어요.'
  };
  const v = sv({ levels: {
    [when.id]: lv('up', 'errand', { reason: 'when', sentence: S.when }),
    [phone.id]: lv('up', 'family', { reason: 'phone', sentence: S.phone }),
    [soon.id]: lv('normal', 'work', { reason: 'due_soon', breakthrough: { dueAt: at(19, 0), soon: true }, sentence: S.soon }),
    [later.id]: lv('down', 'work', { reason: 'due', breakthrough: { dueAt: new Date(2026, 9, 6, 9, 0).toISOString(), soon: false }, sentence: S.later }),
    [up.id]: lv('up', 'home', { sentence: S.up }),
    [plain.id]: lv('normal', null)
  } });
  const r = R.recommend(s, { now: NOW, statusView: v });
  const by = (task) => r.ranked.find((i) => i.taskId === task.id);
  const all = Object.values(S);
  const count = (item) => item.reasons.filter((x) => all.includes(x) || /상태라 뒤로 둔 일/.test(x)).length;
  assert.equal(by(when).reasons[0], S.when);
  assert.equal(by(phone).reasons[0], S.phone);
  assert.equal(by(soon).reasons[0], S.soon);
  assert.equal(by(later).reasons[0], S.later);
  assert.equal(by(up).reasons[0], S.up);
  r.ranked.forEach((i) => assert.ok(count(i) <= 1, i.taskId));
  assert.equal(count(by(plain)), 0);
  assert.equal(by(plain).reasons[0], '소요 시간 미정');
  // 원래 이유는 그 뒤에 그대로 (nextCard 는 앞 두 개만 보인다)
  assert.deepEqual(by(soon).reasons, [S.soon, '소요 시간 미정', '오늘 19:00 마감입니다.', '우선순위가 높음입니다.']);

  // primary 가 down 이고 문장이 없으면 ‘…’ 상태라 뒤로 둔 일 문장 하나
  const s2 = setup();
  const d = task(s2, { title: '견적서', createdAt: OLD });
  const vw = sv({ id: 'off', label: '퇴근 · 내 시간', levels: { [d.id]: lv('down', 'work') } });
  const r2 = R.recommend(s2, { now: NOW, statusView: vw });
  assert.equal(r2.primary.taskId, d.id);
  assert.equal(r2.primary.reasons[0], '‘퇴근 · 내 시간’ 상태라 뒤로 둔 일이지만 지금 할 수 있는 다른 일이 없어요.');
  assert.equal(r2.primary.reasons.filter((x) => /뒤로 둔 일/.test(x)).length, 1);
  // down 이지만 이미 문장(돌파)이 있으면 더하지 않는다
  const s3 = setup();
  const d3 = task(s3, { title: '보고서', createdAt: OLD });
  const r3 = R.recommend(s3, { now: NOW, statusView: sv({ levels: { [d3.id]: lv('down', 'work', { sentence: S.later }) } }) });
  assert.equal(r3.primary.reasons[0], S.later);
  assert.ok(!r3.primary.reasons.some((x) => /상태라 뒤로 둔 일/.test(x)));
  // 짐작 상태면 상태 문장 뒤에 ' (시간표 기준)'
  const r4 = R.recommend(s2, { now: NOW, statusView: sv({ guessed: true, label: '퇴근 후', levels: { [d.id]: lv('down', 'work') } }) });
  assert.equal(r4.primary.reasons[0], '‘퇴근 후’ 상태라 뒤로 둔 일이지만 지금 할 수 있는 다른 일이 없어요. (시간표 기준)');
  const r5 = R.recommend(s, { now: NOW, statusView: Object.assign({}, v, { guessed: true }) });
  assert.equal(r5.ranked.find((i) => i.taskId === when.id).reasons[0], S.when + ' (시간표 기준)');
  // 같은 입력을 두 번 불러도 문장이 쌓이지 않는다
  assert.equal(R.recommend(s, { now: NOW, statusView: v }).ranked.find((i) => i.taskId === when.id).reasons.filter((x) => x === S.when).length, 1);
});

test('126. tooLong 도 levelRank 를 먼저 본다', () => {
  const s = setup();
  const over = task(s, { title: '기한 지난 집안일', estimateMinutes: 90, dueDate: '2026-10-01', createdAt: OLD });
  const up = task(s, { title: '업무', estimateMinutes: 60, createdAt: OLD });
  const plainR = R.recommend(s, { now: NOW, availableMinutes: 15 });
  assert.deepEqual(ids(plainR.tooLong), [over.id, up.id]);
  const v = sv({ id: 'work', label: '업무 중', category: 'work', offHours: false, levels: { [over.id]: lv('down', 'home'), [up.id]: lv('up', 'work') } });
  const r = R.recommend(s, { now: NOW, availableMinutes: 15, statusView: v });
  assert.deepEqual(ids(r.tooLong), [up.id, over.id]);
  assert.equal(r.empty, 'time_short');
});

test('127. checkStartable 은 숨긴 할 일도 시작을 허락한다 (I5)', () => {
  const s = setup();
  const w = task(s, { title: '견적서', createdAt: OLD });
  const v = sv({ levels: { [w.id]: lv('hide', 'work') } });
  assert.deepEqual(R.recommend(s, { now: NOW, statusView: v }).hiddenIds, [w.id]);
  const c = R.checkStartable(s, w.id, NOW);
  assert.equal(c.ok, true);
  assert.equal(c.task.id, w.id);
});

test('128. context.status 는 sv 요약 { id, label, guessed, category, overlay } (opts.status 보다 먼저)', () => {
  const s = setup();
  task(s, { title: 'x', createdAt: OLD });
  const overlay = { id: 'meal', label: '점심', until: at(13, 0), rec: 'short' };
  const v = sv({ id: 'work', label: '업무 중', category: 'work', guessed: true, offHours: false, overlay, remainMinutes: 30 });
  const r = R.recommend(s, { now: NOW, statusView: v, status: { id: 'work', label: '다른 값', busy: false } });
  assert.deepEqual(r.context.status, { id: 'work', label: '업무 중', guessed: true, category: 'work', overlay });
  const r2 = R.recommend(s, { now: NOW, statusView: sv() });
  assert.deepEqual(r2.context.status, { id: 'off', label: '퇴근 · 내 시간', guessed: false, category: 'life', overlay: null });
  assert.deepEqual(Object.keys(r2).sort(), ['alternatives', 'context', 'empty', 'evaluatedAt', 'excluded', 'hiddenIds', 'primary', 'ranked', 'tooLong'].sort());
  assert.deepEqual(r2.hiddenIds, []);
  assert.equal(r2.excluded.hidden, 0);
});

// ================================================================== 검증에서 더한 경계 (statusView)

test('덧씌움 남은 시간이 0분이면 source status 로 고르지 않고 캘린더 규칙으로 간다', () => {
  const s = setup();
  event(s, 10, 30, 11, 0);
  const a = task(s, { title: '메일 확인', estimateMinutes: 10, createdAt: OLD });
  const v = sv({ id: 'work', label: '업무 중', category: 'work', offHours: false, rec: 'short', remainMinutes: 0,
    overlay: { id: 'break', label: '휴식', until: new Date(2026, 9, 5, 10, 0, 30).toISOString(), rec: 'short' } });
  const r = R.recommend(s, { now: NOW, statusView: v });
  assert.equal(r.context.source, 'calendar');
  assert.equal(r.context.availableMinutes, 30);
  assert.notEqual(r.empty, 'time_short');
  assert.equal(r.primary.taskId, a.id);
  assert.ok(!r.primary.reasons.some((x) => /남은 시간\(/.test(x)));
  // 숫자가 아닌 값도 무시한다
  assert.equal(R.recommend(s, { now: NOW, statusView: sv({ id: 'work', category: 'work', offHours: false, remainMinutes: '12' }) }).context.source, 'calendar');
});

test('남은 시간 문장: 짐작 상태면 (시간표 기준), 소요 시간 미정·너무 긴 일에는 붙이지 않는다', () => {
  const s = setup();
  const fit = task(s, { title: '메일 확인', estimateMinutes: 10, createdAt: OLD });
  const unknown = task(s, { title: '정리', createdAt: OLD });
  const long = task(s, { title: '보고서', estimateMinutes: 30, createdAt: OLD });
  const v = sv({ id: 'work', label: '업무 중', category: 'work', guessed: true, offHours: false, rec: 'short', remainMinutes: 12,
    overlay: { id: 'meal', label: '점심', until: at(10, 12), rec: 'short' } });
  const r = R.recommend(s, { now: NOW, statusView: v });
  const by = (t) => r.ranked.concat(r.tooLong).find((i) => i.taskId === t.id);
  assert.equal(by(fit).reasons[0], '‘점심’ 남은 시간(12분) 안에 끝나는 일을 골랐어요. (시간표 기준)');
  assert.equal(by(unknown).fit, 'unknown');
  assert.ok(!by(unknown).reasons.some((x) => /남은 시간\(/.test(x)));
  assert.equal(by(long).fit, 'too_long');
  assert.ok(!by(long).reasons.some((x) => /남은 시간\(/.test(x)));
  assert.deepEqual(ids(r.ranked), [fit.id, unknown.id]);
});

test('statusView 에 levels 가 없거나 모르는 수준이면 모두 보통(1)으로 보고 숨기지 않는다', () => {
  const s = setup();
  const a = task(s, { title: 'a', createdAt: OLD });
  const b = task(s, { title: 'b', createdAt: OLD });
  const v = sv({ levels: undefined });
  const r = R.recommend(s, { now: NOW, statusView: v });
  assert.deepEqual(r.ranked.map((i) => [i.level, i.levelRank]), [['normal', 1], ['normal', 1]]);
  assert.equal(r.excluded.hidden, 0);
  assert.deepEqual(r.hiddenIds, []);
  const r2 = R.recommend(s, { now: NOW, statusView: sv({ levels: { [a.id]: lv('extra'), [b.id]: lv('up') } }) });
  assert.deepEqual(ids(r2.ranked), [b.id, a.id]);
  assert.equal(r2.ranked[1].level, 'normal');
});

test('쉬는 상태(quiet)에서도 숨김은 그대로 빠지고, 할 일이 없어도 empty 는 quiet 이다', () => {
  const s = setup();
  const w = task(s, { title: '견적서', createdAt: OLD });
  const h = task(s, { title: '빨래', createdAt: OLD });
  const v = sv({ id: 'meeting', label: '회의 중', rec: 'none', offHours: false, levels: { [w.id]: lv('hide', 'work') } });
  const r = R.recommend(s, { now: NOW, statusView: v });
  assert.equal(r.empty, 'quiet');
  assert.deepEqual(ids(r.ranked), [h.id]);
  assert.deepEqual(r.hiddenIds, [w.id]);
  assert.equal(R.recommend(setup(), { now: NOW, statusView: v }).empty, 'quiet');
});

test('Google 일정이 자정을 넘겨도 다음 일정은 오늘 시작한 것만, 끝난 Google 일정은 무시한다', { skip: !V4 && 'W1-model 병합 전' }, () => {
  const s = setup();
  s.gcal.events.push(
    gev('past', at(8, 0), at(9, 0)),
    gev('late', new Date(2026, 9, 5, 23, 30).toISOString(), new Date(2026, 9, 6, 1, 0).toISOString())
  );
  task(s, { title: 'x', estimateMinutes: 10, createdAt: OLD });
  const cal = R.calendarContext(s, NOW);
  assert.equal(cal.current.length, 0);
  assert.equal(cal.next.id, 'g:cal1|late');
  // 근무 시간 안이면 근무 끝(18:00)에서 자른다
  const r = R.recommend(s, { now: NOW });
  assert.equal(r.context.until, 'work_end');
  assert.equal(r.context.availableMinutes, 480);
});
