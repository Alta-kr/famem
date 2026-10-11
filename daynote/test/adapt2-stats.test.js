'use strict';
// 적응 2단계 첫 조각 — 소요 시간 비율 · 완료 시각 분포 (DAYNOTE_ADAPTIVE_PLAN §6.1)
// 시계는 고정: NOW = 2026-10-05 (월) 10:00. 날짜는 모두 현지 시각으로 만든다 (TZ=UTC·Asia/Seoul 둘 다 통과).
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../src/core/dates');
const M = require('../src/core/model');
const AD = require('../src/core/adapt');
const PL = require('../src/core/planner');
const R = require('../src/core/recommend');

const L = (d, h, m) => new Date(2026, 9, d, h || 0, m || 0);     // 10월 d일 h:m (현지)
const NOW = L(5, 10, 0);
const WED = '2026-10-07';
const plus = (date, min) => new Date(date.getTime() + min * 60000);

function fresh() { return M.emptyState(); }

// 같은 날 시작 → 완료로 n 개를 끝낸다. 비율 ratio, 예상 est 분. 완료 시각 doneAt(기본 NOW 바로 전)
function seed(s, n, ratio, opts) {
  opts = opts || {};
  const est = opts.est || 30;
  const out = [];
  for (let i = 0; i < n; i++) {
    const done = opts.doneAt || plus(NOW, -1);
    const start = plus(done, -Math.round(est * ratio));
    const t = M.addTask(s, { title: '비밀 제목 ' + i, estimateMinutes: est, projectId: opts.projectId || null,
      context: opts.context || null, startedAt: start.toISOString() }, start);
    M.completeTask(s, t.id, done);
    out.push(AD.observeDone(s, t, done));
  }
  return out;
}
const expectFactor = (n, ratio) => Math.min(2.5, Math.max(0.5, Math.exp(n * Math.log(ratio) / (n + AD.STATS.SHRINK_K))));

// ------------------------------------------------------------------ 실제 소요 시간

test('1. actualMinutes: 작업 블록 안에서 완료 → 완료 시각까지의 블록 길이 합', () => {
  const s = fresh();
  const t = M.addTask(s, { title: 'a', estimateMinutes: 90 }, NOW);   // 블록 합(90분)이 예상과 같다
  M.addBlock(s, { taskId: t.id, start: L(5, 9, 0).toISOString(), end: L(5, 9, 30).toISOString() });
  M.addBlock(s, { taskId: t.id, start: L(5, 14, 0).toISOString(), end: L(5, 15, 0).toISOString() });
  M.addBlock(s, { taskId: t.id, start: L(6, 9, 0).toISOString(), end: L(6, 10, 0).toISOString() });   // 완료 뒤 블록은 세지 않는다
  assert.deepEqual(AD.actualMinutes(s, t, L(5, 14, 40)), { minutes: 70, how: 'block' });
  // 블록이 끝나고 20분 뒤(여유 30분 안) → 더 한 20분까지 센다
  assert.deepEqual(AD.actualMinutes(s, t, L(5, 15, 20)), { minutes: 110, how: 'block' });
  // 블록 밖(여유 넘음)이고 startedAt 도 없으면 모른다
  assert.equal(AD.actualMinutes(s, t, L(5, 17, 0)), null);
  // 일정(event) 블록은 작업 블록이 아니다
  const u = M.addTask(s, { title: 'b', estimateMinutes: 30 }, NOW);
  M.addBlock(s, { taskId: u.id, kind: 'event', start: L(5, 9, 0).toISOString(), end: L(5, 10, 0).toISOString() });
  assert.equal(AD.actualMinutes(s, u, L(5, 9, 30)), null);
});

test('2. actualMinutes: 같은 날 8시간 안에 시작 → 완료. 다른 날·8시간 넘음은 모른다', () => {
  const s = fresh();
  const t = M.addTask(s, { title: 'a', estimateMinutes: 30, startedAt: L(5, 9, 0).toISOString() }, NOW);
  assert.deepEqual(AD.actualMinutes(s, t, L(5, 9, 45)), { minutes: 45, how: 'started' });
  assert.equal(AD.actualMinutes(s, t, L(5, 17, 30)), null);         // 8시간 30분
  assert.equal(AD.actualMinutes(s, t, L(6, 9, 30)), null);          // 다음 날
  assert.equal(AD.actualMinutes(s, t, L(5, 8, 0)), null);           // 시작 전
  assert.equal(AD.actualMinutes(s, null, NOW), null);
});

// ------------------------------------------------------------------ 기록

test('3. observeDone: 비율·완료 시각을 숫자로만 남긴다. 제목은 저장하지 않는다', () => {
  const s = fresh();
  const [r] = seed(s, 1, 1.5, { projectId: 'proj_x', context: 'work' });
  assert.equal(r.hours, true);
  assert.equal(r.how, 'started');
  assert.equal(r.estimate, 30);
  assert.equal(r.actual, 45);
  assert.ok(Math.abs(r.ratio - 1.5) < 1e-9);
  const S = s.learned.stats;
  assert.equal(S.est.ratios.length, 1);
  assert.ok(Math.abs(S.est.ratios[0][0] - Math.log(1.5)) < 1e-3);
  assert.equal(S.est.byProject.proj_x.length, 1);
  assert.equal(S.est.byContext.work.length, 1);
  assert.equal(S.hours.n, 1);
  assert.equal(S.hours.done.reduce((a, b) => a + b, 0), 1);
  assert.ok(!JSON.stringify(S).includes('비밀'));
  // 규칙·지표는 건드리지 않는다
  assert.deepEqual(s.learned.rules, []);
  assert.equal(s.learned.metrics.learned, 0);
});

test('4. observeDone: 다시 연 뒤 또 끝내도 한 번만 센다. 예상 없으면 시각만. 배우기 끔·예제·미완료는 세지 않는다', () => {
  const s = fresh();
  const t = M.addTask(s, { title: 'a', estimateMinutes: 30, startedAt: L(5, 9, 0).toISOString() }, NOW);
  M.completeTask(s, t.id, L(5, 9, 40));
  AD.observeDone(s, t, L(5, 9, 40));
  M.reopenTask(s, t.id, L(5, 9, 41));
  M.completeTask(s, t.id, L(5, 9, 50));
  const again = AD.observeDone(s, t.id, L(5, 9, 50));               // id 로도 부를 수 있다
  assert.equal(again.hours, false);
  assert.equal(s.learned.stats.est.ratios.length, 1);
  assert.equal(s.learned.stats.hours.n, 1);

  const u = M.addTask(s, { title: 'b' }, NOW);
  M.completeTask(s, u.id, NOW);
  const ru = AD.observeDone(s, u, NOW);
  assert.equal(ru.hours, true);
  assert.equal(ru.ratio, null);
  assert.equal(s.learned.stats.est.ratios.length, 1);
  assert.equal(s.learned.stats.hours.n, 2);

  const v = M.addTask(s, { title: 'c', estimateMinutes: 10 }, NOW);
  assert.equal(AD.observeDone(s, v, NOW), null);                   // 아직 안 끝남

  const off = fresh();
  off.prefs.learning = false;
  const w = M.addTask(off, { title: 'd', estimateMinutes: 10 }, NOW);
  M.completeTask(off, w.id, NOW);
  assert.equal(AD.observeDone(off, w, NOW), null);
  assert.equal(off.learned.stats, undefined);

  const smp = fresh();
  const x = M.addTask(smp, { title: 'e', estimateMinutes: 10, sample: true }, NOW);
  M.completeTask(smp, x.id, NOW);
  assert.equal(AD.observeDone(smp, x, NOW), null);
});

test('5. observeDone: 최근 40개(칸마다 20개)만 남기고 비율은 [0.2, 5] 로 자른다', () => {
  const s = fresh();
  seed(s, 45, 1.2, { projectId: 'proj_x' });
  assert.equal(s.learned.stats.est.ratios.length, AD.STATS.EST_MAX);
  assert.equal(s.learned.stats.est.byProject.proj_x.length, AD.STATS.EST_KEY_MAX);
  assert.equal(s.learned.stats.est.seen.length, AD.STATS.SEEN_MAX > 45 ? 45 : AD.STATS.SEEN_MAX);
  const t = fresh();
  const [r] = seed(t, 1, 3.9);   // 시작 시각으로 잰 것: 30분 예상 → 117분 (120분 안) → 3 까지만
  assert.equal(r.ratio, AD.STATS.STARTED_CLAMP);
  const b = fresh();
  const u = M.addTask(b, { title: 'b', estimateMinutes: 10 }, NOW);
  M.addBlock(b, { taskId: u.id, start: L(5, 9, 0).toISOString(), end: L(5, 10, 0).toISOString() });
  M.completeTask(b, u.id, L(5, 9, 50));                                // 블록 안 50분 → 5배
  assert.equal(AD.observeDone(b, u, L(5, 9, 50)).ratio, 5);
});

// ------------------------------------------------------------------ 비율

test('6. durationStats: 8개 미만은 확실하지 않다. 표본이 많을수록 1.0 에서 멀어진다(축소)', () => {
  const s = fresh();
  assert.deepEqual(AD.durationStats(s, NOW), { n: 0, factor: 1, raw: 1, confident: false, scope: 'all' });
  seed(s, 7, 1.4);
  let d = AD.durationStats(s, NOW);
  assert.equal(d.n, 7);
  assert.equal(d.confident, false);
  seed(s, 13, 1.4);
  d = AD.durationStats(s, NOW);
  assert.equal(d.n, 20);
  assert.equal(d.confident, true);
  assert.ok(Math.abs(d.factor - expectFactor(20, 1.4)) < 1e-3, d.factor);
  assert.ok(Math.abs(d.raw - 1.4) < 1e-3);
  assert.ok(d.factor < 1.4 && d.factor > 1.25);
});

test('7. durationStats: 결과는 [0.5, 2.5] 로 자르고, 오래된 기록은 약해진다', () => {
  const s = fresh();
  seed(s, 40, 4);
  assert.equal(AD.durationStats(s, NOW).factor, 2.5);
  const q = fresh();
  seed(q, 40, 0.25);
  assert.equal(AD.durationStats(q, NOW).factor, 0.5);
  // 같은 기록이라도 반감기(90일) 뒤에는 1.0 쪽으로 더 당겨진다
  const s2 = fresh();
  seed(s2, 10, 1.5);
  const f0 = AD.durationStats(s2, NOW).factor;
  const f1 = AD.durationStats(s2, new Date(NOW.getTime() + 90 * D.DAY)).factor;
  assert.ok(f1 < f0 && f1 > 1, f0 + ' ' + f1);
});

test('8. durationStats: 프로젝트 칸이 8개 이상이면 그 칸을 전체 쪽으로 당겨 쓴다', () => {
  const s = fresh();
  seed(s, 10, 1.0);
  seed(s, 10, 2.0, { projectId: 'proj_slow' });
  const all = AD.durationStats(s, NOW);
  const pj = AD.durationStats(s, NOW, { projectId: 'proj_slow' });
  const other = AD.durationStats(s, NOW, { projectId: 'proj_none' });
  assert.equal(pj.scope, 'project');
  assert.equal(pj.n, 10);
  assert.equal(other.scope, 'all');
  assert.ok(pj.factor > all.factor);
  assert.ok(pj.factor < 2);
});

test('9. adjustMinutes: 확실할 때만 5분 단위로 보정. 차이가 작거나 배우기를 끄면 그대로', () => {
  const s = fresh();
  const t = M.addTask(s, { title: 'x', estimateMinutes: 60 }, NOW);
  assert.deepEqual(AD.adjustMinutes(s, t, 60, NOW), { minutes: 60, base: 60, factor: 1, n: 0, adjusted: false });
  seed(s, 20, 1.4);
  const a = AD.adjustMinutes(s, t, 60, NOW);
  assert.equal(a.adjusted, true);
  assert.equal(a.minutes, Math.round(60 * expectFactor(20, 1.4) / 5) * 5);
  assert.equal(a.factor, 1.3);
  assert.equal(t.estimateMinutes, 60);                               // 예상은 바꾸지 않는다
  s.prefs.learning = false;
  assert.equal(AD.adjustMinutes(s, t, 60, NOW).adjusted, false);
  const e = fresh();
  seed(e, 20, 1.05);
  assert.equal(AD.adjustMinutes(e, t, 60, NOW).adjusted, false);     // 0.1 배 안쪽 차이
});

// ------------------------------------------------------------------ 시각 분포 · 문장 · 지우기

test('10. hourStats: 7×24 감쇠 카운트, 가장 많이 끝낸 2시간과 요일', () => {
  const s = fresh();
  for (let i = 0; i < 10; i++) seed(s, 1, 1, { doneAt: L(6, 14, 30) });   // 화 14:30
  for (let i = 0; i < 5; i++) seed(s, 1, 1, { doneAt: L(5, 9, 10) });     // 월 09:10
  const h = AD.hourStats(s, NOW);
  assert.equal(h.n, 15);
  assert.equal(h.enough, true);
  assert.equal(h.grid.length, 168);
  assert.equal(h.peakDay, 1);
  assert.ok(h.peakHours[0] <= 14 && h.peakHours[1] > 14, String(h.peakHours));
  const later = AD.hourStats(s, new Date(NOW.getTime() + 60 * D.DAY));
  assert.ok(Math.abs(later.total - h.total / 2) < 0.01 * h.total);    // 60일 반감기
  const sm = AD.statsSummary(s, NOW);
  assert.match(sm.hours, /화요일에 가장 많이 끝냈어요\.$/);
  assert.match(sm.hours, /^할 일은 주로 (오후|낮)/);
});

test('11. statsSummary: "최근 완료한 20개 기준으로 예상보다 1.3배 걸렸어요"', () => {
  const s = fresh();
  assert.match(AD.statsSummary(s, NOW).duration, /‘지금 시작’을 누르고 끝내면 세요\. 8개가 쌓이면/);
  seed(s, 3, 1.4);
  assert.match(AD.statsSummary(s, NOW).duration, /\(지금 3개\)\.$/);
  seed(s, 17, 1.4);
  const sm = AD.statsSummary(s, NOW);
  assert.ok(sm.duration.startsWith('최근 완료한 20개 기준으로 예상보다 1.3배 걸렸어요.'), sm.duration);
  assert.equal(sm.confident, true);
  assert.equal(sm.hours, '할 일은 주로 오전 9시–11시에 끝냈고, 요일로는 월요일에 가장 많이 끝냈어요.');   // 20개 ≥ 14
  const few = fresh();
  seed(few, 13, 1.4);
  assert.equal(AD.statsSummary(few, NOW).hours, null);                // 14개 미만이면 시각 문장은 없다
});

test('12. statsSummary: 빨리 끝낸 사람 · 예상대로인 사람', () => {
  const fast = fresh();
  seed(fast, 20, 0.6);
  assert.match(AD.statsSummary(fast, NOW).duration, /예상의 0\.7배 만에 끝냈어요/);
  const same = fresh();
  seed(same, 20, 1.02);
  assert.match(AD.statsSummary(same, NOW).duration, /대체로 예상한 만큼 걸렸어요/);
});

test('13. resetStats · ensureStats · model.normalize 가 망가진 stats 를 고친다', () => {
  const s = fresh();
  assert.equal(AD.resetStats(s), false);
  seed(s, 10, 1.5);
  assert.equal(AD.resetStats(s, 'hours'), true);
  assert.equal(s.learned.stats.hours.n, 0);
  assert.equal(s.learned.stats.est.ratios.length, 10);
  AD.resetStats(s);
  assert.equal(s.learned.stats.est.ratios.length, 0);
  assert.equal(AD.durationStats(s, NOW).n, 0);

  const n1 = M.normalize({ learned: { rules: [], stats: 'oops' } });
  assert.equal(n1.learned.stats, undefined);
  const n2 = M.normalize({ learned: { rules: [], stats: { est: { ratios: [[0.1, 5], 'x', [NaN, 1]], byProject: { p: 'x', q: [[0, 1]] } }, hours: { done: [1, 2] } } } });
  const S = AD.ensureStats(n2);
  assert.deepEqual(S.est.ratios, [[0.1, 5]]);
  assert.deepEqual(Object.keys(S.est.byProject), ['q']);
  assert.equal(S.hours.done.length, 168);
  assert.equal(AD.durationStats(n2, NOW).n, 1);
  // 저장했다 다시 읽어도 같다
  seed(s, 9, 1.5);
  const back = M.normalize(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(AD.durationStats(back, NOW), AD.durationStats(s, NOW));
});

test('14. 개인정보: 통계는 AI 힌트에 나오지 않는다', () => {
  const s = fresh();
  const before = AD.hints(s, '비밀 제목 장보기', NOW);
  seed(s, 20, 1.5);
  assert.deepEqual(AD.hints(s, '비밀 제목 장보기', NOW), before);
  assert.ok(!JSON.stringify(s.learned.stats).includes('비밀'));
});

// ------------------------------------------------------------------ 배치 · 추천

test('15. planner: 확실하면 보정한 길이로 넣고 이유에 밝힌다. noAdapt 면 예상 그대로', () => {
  const s = fresh();
  const t = M.addTask(s, { title: '그거 하기', estimateMinutes: 60 }, NOW);
  const plain = PL.placeOnDay(s, t.id, WED, { now: NOW });
  assert.equal(plain.ok, true);
  assert.equal(plain.candidate.minutes, 60);
  assert.equal(plain.adjusted, null);

  seed(s, 20, 1.4);
  const snap = JSON.stringify(s);
  const r = PL.placeOnDay(s, t.id, WED, { now: NOW });
  assert.equal(JSON.stringify(s), snap);                             // 순수
  assert.equal(r.ok, true);
  assert.equal(r.candidate.minutes, 80);
  assert.deepEqual(r.adjusted, { base: 60, minutes: 80, factor: 1.3, n: 20 });
  assert.ok(r.reasons.includes('평소 예상보다 1.3배 걸려서 1시간 대신 1시간 20분으로 잡았어요.'), r.reasons.join(' / '));
  assert.ok(r.reasons.length <= 3);
  assert.equal(r.block.end, plus(new Date(r.block.start), 80).toISOString());
  assert.deepEqual(PL.lengthInfo(s, t, { now: NOW }).adjust, { base: 60, minutes: 80, factor: 1.3, n: 20 });

  const off = PL.placeOnDay(s, t.id, WED, { now: NOW, noAdapt: true });
  assert.equal(off.candidate.minutes, 60);
  const fixed = PL.suggestSlots(s, t.id, WED, { now: NOW, minutes: 45 });   // 직접 정한 길이는 보정하지 않는다
  assert.ok(fixed.every((c) => c.minutes === 45 && !c.adjusted));
  const arr = PL.arrangeDay(s, [t.id], WED, { now: NOW });
  assert.equal(arr.placements[0].candidate.minutes, 80);
});

test('16. planner: 앞으로 잡힌 작업 블록 몫은 빼고 남은 몫만 보정한다', () => {
  const s = fresh();
  seed(s, 20, 1.4);
  const t = M.addTask(s, { title: '그거 하기', estimateMinutes: 90 }, NOW);
  M.addBlock(s, { taskId: t.id, start: L(6, 9, 0).toISOString(), end: L(6, 9, 30).toISOString() });   // 30분 잡혀 있음
  const info = PL.lengthInfo(s, t, { now: NOW });
  const adj = AD.adjustMinutes(s, t, 90, NOW).minutes;                 // 90 → 120
  assert.equal(info.minutes, adj - 30);
  assert.equal(info.adjust.base, 60);
});

test('17. recommend: 보정 추정으로 적합도를 정하고 이유에 밝힌다', () => {
  const s = fresh();
  const t = M.addTask(s, { title: '그거 하기', estimateMinutes: 30 }, NOW);
  let r = R.recommend(s, { now: NOW, availableMinutes: 35 });
  assert.equal(r.primary.taskId, t.id);
  assert.equal(r.primary.fit, 'fits');
  assert.equal(r.primary.estimateAdjusted, undefined);

  seed(s, 20, 1.4);
  r = R.recommend(s, { now: NOW, availableMinutes: 35 });
  assert.equal(r.primary, null);
  assert.equal(r.tooLong[0].taskId, t.id);
  assert.equal(r.tooLong[0].estimateAdjusted, 40);
  assert.ok(r.tooLong[0].reasons.some((x) => x === '평소 예상보다 1.3배 걸려서 약 40분으로 보고 골랐어요.'), r.tooLong[0].reasons.join(' / '));

  r = R.recommend(s, { now: NOW, availableMinutes: 45 });
  assert.equal(r.primary.taskId, t.id);
  assert.equal(r.primary.reasons[1], '평소 예상보다 1.3배 걸려서 약 40분으로 보고 골랐어요.');
  assert.equal(R.recommend(s, { now: NOW, availableMinutes: 35, noAdapt: true }).primary.taskId, t.id);
});
