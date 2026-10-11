'use strict';
// 적응 2단계 — 검증에서 나온 문제 고침 (배치 기본 길이 보정 · 남은 몫 0 · 추천 이유 자리 · 표본 부풀림 · 되먹임 · seen · 문구)
// 시계는 고정: NOW = 2026-10-05 (월) 10:00. 날짜는 모두 현지 시각으로 만든다 (TZ=UTC·Asia/Seoul 둘 다 통과).
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/core/model');
const AD = require('../src/core/adapt');
const PL = require('../src/core/planner');
const R = require('../src/core/recommend');

const L = (d, h, m) => new Date(2026, 9, d, h || 0, m || 0);
const NOW = L(5, 10, 0);
const WED = '2026-10-07';
const plus = (date, min) => new Date(date.getTime() + min * 60000);

function fresh() { return M.emptyState(); }
function seed(s, n, ratio, opts) {
  opts = opts || {};
  const est = opts.est || 30;
  for (let i = 0; i < n; i++) {
    const done = opts.doneAt ? opts.doneAt(i) : plus(NOW, -1);
    const start = plus(done, -Math.round(est * ratio));
    const t = M.addTask(s, { title: 'x' + i, estimateMinutes: est, startedAt: start.toISOString() }, start);
    M.completeTask(s, t.id, done);
    AD.observeDone(s, t, done);
  }
}

test('1. planner: adaptMinutes — 화면이 계산한 기본 길이(calplace.lengthFor)도 보정한다. 직접 고른 길이는 그대로', () => {
  const s = fresh();
  seed(s, 20, 1.4);
  const t = M.addTask(s, { title: '그거 하기', estimateMinutes: 60 }, NOW);
  // calplace.dropOnDay 와 같은 길: lengthFor(t) = 남은 분 또는 예상 → minutes 로 넘긴다
  const raw = PL.remainingMinutes(s, t, NOW);
  const plain = PL.placeOnDay(s, t.id, WED, { now: NOW, minutes: raw });
  assert.equal(plain.candidate.minutes, 60);
  assert.equal(plain.adjusted, null);
  const r = PL.placeOnDay(s, t.id, WED, { now: NOW, minutes: raw, adaptMinutes: true });
  assert.equal(r.ok, true);
  assert.equal(r.candidate.minutes, 80);
  assert.deepEqual(r.adjusted, { base: 60, minutes: 80, factor: 1.3, n: 20 });
  assert.ok(r.reasons.includes('평소 예상보다 1.3배 걸려서 1시간 대신 1시간 20분으로 잡았어요.'), r.reasons.join(' / '));
  assert.equal(PL.lengthInfo(s, t, { now: NOW, minutes: raw, adaptMinutes: true }).minutes, 80);
  // noAdapt 가 이긴다 · 예상 없는 일은 보정하지 않는다
  assert.equal(PL.lengthInfo(s, t, { now: NOW, minutes: raw, adaptMinutes: true, noAdapt: true }).minutes, 60);
  const u = M.addTask(s, { title: '모르는 일' }, NOW);
  assert.deepEqual(PL.lengthInfo(s, u, { now: NOW, minutes: 30, adaptMinutes: true }), { minutes: 30, adjust: null });
});

test('2. planner: 예상 전부가 이미 잡혀 있으면(남은 몫 0) 예상 전체를 보정해서 넣는다 — "1시간 대신 20분" 이 나오지 않는다', () => {
  const s = fresh();
  seed(s, 20, 1.4);
  const t = M.addTask(s, { title: '그거 하기', estimateMinutes: 60 }, NOW);
  M.addBlock(s, { taskId: t.id, start: L(6, 9, 0).toISOString(), end: L(6, 10, 0).toISOString() });
  assert.equal(PL.remainingMinutes(s, t, NOW), 0);
  const info = PL.lengthInfo(s, t, { now: NOW });
  assert.equal(info.minutes, 80);
  assert.deepEqual(info.adjust, { base: 60, minutes: 80, factor: 1.3, n: 20 });
  // 보정이 없으면 예상 전체 (같은 대체 규칙)
  assert.deepEqual(PL.lengthInfo(s, t, { now: NOW, noAdapt: true }), { minutes: 60, adjust: null });
  const r = PL.placeOnDay(s, t.id, WED, { now: NOW });
  assert.ok(r.reasons.every((x) => !/대신 20분/.test(x)), r.reasons.join(' / '));
});

test('3. recommend: 쓸 시간이 없으면(open) 보정 이유를 넣지 않는다. 있으면 마감 이유 뒤에 둔다', () => {
  const s = fresh();
  seed(s, 20, 1.4);
  const t = M.addTask(s, { title: '그거 하기', estimateMinutes: 30, dueDate: '2026-10-05' }, NOW);
  // 근무 시간 밖(일요일 밤) — 쓸 시간 없음
  const off = R.recommend(s, { now: L(4, 22, 0) });
  const item = off.ranked.filter((i) => i.taskId === t.id)[0];
  assert.equal(item.fit, 'open');
  assert.equal(item.estimateAdjusted, undefined);
  assert.ok(item.reasons.every((x) => !/평소 예상보다/.test(x)), item.reasons.join(' / '));

  const r = R.recommend(s, { now: NOW, availableMinutes: 45 });
  assert.equal(r.primary.taskId, t.id);
  assert.equal(r.primary.estimateAdjusted, 40);
  const ri = r.primary.reasons.indexOf('평소 예상보다 1.3배 걸려서 약 40분으로 보고 골랐어요.');
  const di = r.primary.reasons.findIndex((x) => /마감/.test(x));
  assert.ok(di !== -1 && ri > di, r.primary.reasons.join(' / '));
});

test('4. actualMinutes: 시작 시각으로 잰 것은 max(예상×3, 120분) 안만, 비율은 3배까지. 진행 중이 아니던 일은 세지 않는다', () => {
  const s = fresh();
  // 9시에 시작했다가 다른 일로 바꾸고 15시에 끝냄 → 360분: 세지 않는다
  const t = M.addTask(s, { title: 'a', estimateMinutes: 30, startedAt: L(5, 9, 0).toISOString() }, NOW);
  assert.equal(AD.actualMinutes(s, t, L(5, 15, 0)), null);
  assert.deepEqual(AD.actualMinutes(s, t, L(5, 10, 30)), { minutes: 90, how: 'started' });
  // 긴 예상이면 예상×3 까지
  const u = M.addTask(s, { title: 'b', estimateMinutes: 60, startedAt: L(5, 9, 0).toISOString() }, NOW);
  assert.deepEqual(AD.actualMinutes(s, u, L(5, 11, 30)), { minutes: 150, how: 'started' });
  // 완료 직전 상태가 할 일(todo)이면 시작 시각은 옛 값 — 세지 않는다
  assert.equal(AD.actualMinutes(s, t, L(5, 9, 40), { prevStatus: 'todo' }), null);
  assert.deepEqual(AD.actualMinutes(s, t, L(5, 9, 40), { prevStatus: 'in_progress' }), { minutes: 40, how: 'started' });
  // observeDone 이 prevStatus 를 넘겨받는다 — 완료 시각은 세고 비율은 세지 않는다
  M.startTask(s, t.id, L(5, 9, 0));
  M.startTask(s, u.id, L(5, 9, 10));                                  // t 는 할 일로 돌아감
  const r = M.completeTask(s, t.id, L(5, 9, 40));
  assert.equal(r.prevStatus, 'todo');
  const o = AD.observeDone(s, r.task, L(5, 9, 40), { prevStatus: r.prevStatus });
  assert.equal(o.hours, true);
  assert.equal(o.ratio, null);
  // 시작으로 잰 표본은 3배까지만
  const v = M.addTask(s, { title: 'c', estimateMinutes: 10, startedAt: L(5, 9, 0).toISOString() }, NOW);
  M.completeTask(s, v.id, L(5, 10, 0));                               // 60분 / 10분 = 6 → 3
  assert.equal(AD.observeDone(s, v, L(5, 10, 0), { prevStatus: 'in_progress' }).ratio, 3);
});

test('5. actualMinutes: 보정·직접 늘린 블록 끝 무렵에 끝낸 것은 블록을 잰 것이라 세지 않는다 (되먹임 막기)', () => {
  const s = fresh();
  // 예상 60분인데 블록 80분 (보정으로 잡힘)
  const t = M.addTask(s, { title: 'a', estimateMinutes: 60 }, NOW);
  M.addBlock(s, { taskId: t.id, start: L(5, 9, 0).toISOString(), end: L(5, 10, 20).toISOString() });
  assert.equal(AD.actualMinutes(s, t, L(5, 10, 20)), null);           // 끝에 체크
  assert.equal(AD.actualMinutes(s, t, L(5, 10, 16)), null);           // 끝 5분 전 안
  assert.equal(AD.actualMinutes(s, t, L(5, 10, 40)), null);           // 끝 + 여유 안
  assert.deepEqual(AD.actualMinutes(s, t, L(5, 9, 50)), { minutes: 50, how: 'block' });   // 일찍 끝냄은 일을 잰 것
  // 예상만큼 잡힌 블록이면 끝에 체크해도(넘긴 것까지) 센다
  const u = M.addTask(s, { title: 'b', estimateMinutes: 60 }, NOW);
  M.addBlock(s, { taskId: u.id, start: L(5, 13, 0).toISOString(), end: L(5, 14, 0).toISOString() });
  assert.deepEqual(AD.actualMinutes(s, u, L(5, 14, 0)), { minutes: 60, how: 'block' });
  assert.deepEqual(AD.actualMinutes(s, u, L(5, 14, 15)), { minutes: 75, how: 'block' });
  // 블록 끝 무렵이라 못 잰 일은 비율 없이 시각만 센다
  M.completeTask(s, t.id, L(5, 10, 20));
  const o = AD.observeDone(s, t, L(5, 10, 20));
  assert.equal(o.hours, true);
  assert.equal(o.ratio, null);
});

test('6. observeDone: 못 잰 첫 완료가 나중에 잴 수 있는 완료를 막지 않는다. 시각은 한 번만 센다', () => {
  const s = fresh();
  const t = M.addTask(s, { title: 'a', estimateMinutes: 30 }, NOW);
  M.completeTask(s, t.id, L(5, 9, 0));
  const first = AD.observeDone(s, t, L(5, 9, 0));
  assert.equal(first.hours, true);
  assert.equal(first.ratio, null);
  M.reopenTask(s, t.id, L(5, 9, 1));
  M.startTask(s, t.id, L(5, 9, 5));
  M.completeTask(s, t.id, L(5, 9, 50));
  const again = AD.observeDone(s, t, L(5, 9, 50), { prevStatus: 'in_progress' });
  assert.equal(again.hours, false);
  assert.ok(Math.abs(again.ratio - 1.5) < 1e-9);
  assert.equal(s.learned.stats.hours.n, 1);
  assert.equal(s.learned.stats.est.ratios.length, 1);
  M.reopenTask(s, t.id, L(5, 9, 51));
  M.completeTask(s, t.id, L(5, 9, 55));
  const third = AD.observeDone(s, t, L(5, 9, 55), { prevStatus: 'in_progress' });
  assert.equal(third.ratio, null);                                     // 이미 잰 일은 또 세지 않는다
  assert.equal(s.learned.stats.est.ratios.length, 1);
});

test('7. unobserveDone: 완료 취소(toggleDone) 때 그 완료의 시각·비율을 뺀다. 다시 끝내면 새로 센다', () => {
  const s = fresh();
  const t = M.addTask(s, { title: 'a', estimateMinutes: 30, projectId: 'p1', context: 'work', startedAt: L(5, 9, 0).toISOString() }, NOW);
  M.completeTask(s, t.id, L(5, 9, 45));
  AD.observeDone(s, t, L(5, 9, 45));
  const S = s.learned.stats;
  assert.equal(S.est.ratios.length, 1);
  assert.equal(S.est.byProject.p1.length, 1);
  const u = AD.unobserveDone(s, t.id, L(5, 9, 46));
  assert.deepEqual(u, { hours: true, ratio: true });
  M.reopenTask(s, t.id, L(5, 9, 46));
  assert.equal(S.est.ratios.length, 0);
  assert.equal(S.est.byProject.p1, undefined);
  assert.equal(S.est.byContext.work, undefined);
  assert.equal(S.hours.n, 0);
  assert.ok(S.hours.done.reduce((a, b) => a + b, 0) < 1e-3);
  assert.equal(S.est.seen.length, 0);
  assert.equal(S.est.seenR.length, 0);
  // 다시 끝내면 새로 센다
  M.completeTask(s, t.id, L(5, 10, 0));
  const o = AD.observeDone(s, t, L(5, 10, 0));
  assert.equal(o.hours, true);
  assert.ok(Math.abs(o.ratio - 2) < 1e-9);
  // 통계가 없거나 센 적 없는 일이면 아무것도 하지 않는다
  assert.equal(AD.unobserveDone(fresh(), 'nope', NOW), null);
  const v = M.addTask(s, { title: 'b' }, NOW);
  assert.deepEqual(AD.unobserveDone(s, v.id, NOW), { hours: false, ratio: false });
  assert.equal(S.est.ratios.length, 1);
});

test('8. ensureStats · resetStats: seenR 를 고치고, 비율만 지우면 시각 seen 은 남는다', () => {
  const s = fresh();
  seed(s, 3, 1.2);
  const n = M.normalize(JSON.parse(JSON.stringify(s)));
  delete n.learned.stats.est.seenR;
  const S = AD.ensureStats(n);
  assert.deepEqual(S.est.seenR, []);
  assert.equal(s.learned.stats.est.seenR.length, 3);
  AD.resetStats(s, 'est');
  assert.equal(s.learned.stats.est.seen.length, 3);
  assert.equal(s.learned.stats.est.seenR.length, 0);
  AD.resetStats(s, 'hours');
  assert.equal(s.learned.stats.est.seen.length, 0);
});

test('9. statsSummary: 배우기를 끄면 캘린더에 반영하지 않는다고 말한다. 처음 안내는 무엇을 세는지 밝힌다', () => {
  const s = fresh();
  const first = AD.statsSummary(s, NOW).duration;
  assert.match(first, /작업 시간 안에서 끝내거나 ‘지금 시작’을 누르고 끝내면 세요/);
  seed(s, 20, 1.4);
  assert.match(AD.statsSummary(s, NOW).duration, /1\.3배 걸렸어요\. 캘린더에 넣을 때 그만큼 넉넉히 잡아요\.$/);
  s.prefs.learning = false;
  assert.equal(AD.statsSummary(s, NOW).duration, '최근 완료한 20개 기준으로 예상보다 1.3배 걸렸어요. 배우기를 꺼서 지금은 캘린더에 반영하지 않아요.');
});

test('10. statsSummary: 새벽 1–5시는 ‘새벽’ 으로 쓴다', () => {
  const s = fresh();
  seed(s, 20, 1, { doneAt: (i) => L(5 - (i % 3), i % 2 ? 1 : 0, 30) });   // 밤 12시 반 · 새벽 1시 반
  const sm = AD.statsSummary(s, NOW);
  assert.match(sm.hours, /^할 일은 주로 밤 12시–새벽 2시에 끝냈고/);
  const t = fresh();
  seed(t, 20, 1, { doneAt: () => L(5, 4, 30) });
  assert.match(AD.statsSummary(t, NOW).hours, /^할 일은 주로 새벽 4시–오전 6시에/);
});

test('8. unobserveDone: 같은 시각에 끝낸 두 일 중 취소한 일의 비율만 뺀다 (할 일 id 로 찾는다)', () => {
  const s = fresh();
  const done = plus(NOW, -1);
  const mk = (title, ratio) => {
    const t = M.addTask(s, { title, estimateMinutes: 30, startedAt: plus(done, -30 * ratio).toISOString() }, plus(done, -120));
    M.completeTask(s, t.id, done);
    AD.observeDone(s, t, done);
    return t;
  };
  const a = mk('a', 1);
  mk('b', 2);
  assert.equal(s.learned.stats.est.ratios.length, 2);
  AD.unobserveDone(s, a.id, NOW);
  const left = s.learned.stats.est.ratios;
  assert.equal(left.length, 1);
  assert.ok(Math.abs(left[0][0] - Math.log(2)) < 0.01, '남은 표본은 b(2배)');
});
