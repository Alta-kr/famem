'use strict';
// v1.1 고침 — 추천 최대 분 문구 · 배치 기본 길이 보정(calplace·calday) · 귀가 말 라벨
// 날짜는 모두 현지 시각으로 만든다 (TZ=UTC·Asia/Seoul 둘 다 통과).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../src/core/model');
const ST = require('../src/core/status');
const R = require('../src/core/recommend');
const AD = require('../src/core/adapt');
const PL = require('../src/core/planner');

const at = (d, h, m) => new Date(2026, 9, d, h, m || 0);   // 2026-10-d (5 = 월, 10 = 토)
const MON = (h, m) => at(5, h, m);
const plus = (date, min) => new Date(date.getTime() + min * 60000);

function mk(preset, cur, now) {
  const s = M.emptyState();
  s.prefs.statusProfile = { preset };
  const pf = ST.profile(s.prefs);
  const list = [].concat(cur);
  list.forEach((id, i) => ST.setStatus(s, { id }, { source: 'chip' }, pf, plus(now, -(list.length - i))));
  return { s, pf, ctx: { profile: pf, eff: ST.effective(s, pf, now), current: s.presence.current, now } };
}

// ------------------------------------------------------------------ 1. 추천 최대 분 (remainCapped)
test('추천: 상태의 추천 최대 분이 정한 시간은 ‘남은 시간’이라 하지 않는다', () => {
  const now = MON(10);
  const { s, pf } = mk('home', 'kids', now);
  const t = M.addTask(s, { title: '물 주기', estimateMinutes: 5 }, plus(now, -10));
  const sv = ST.view(s, pf, now);
  assert.deepEqual([sv.remainMinutes, sv.remainCapped], [10, true]);
  const r = R.recommend(s, { now, statusView: sv });
  assert.equal(r.primary.taskId, t.id);
  assert.equal(r.context.source, 'status');
  assert.equal(r.context.capped, true);
  assert.equal(r.primary.reasons[0], '‘아이와 함께’일 때는 10분 안에 끝나는 일만 골랐어요.');
  assert.equal(r.primary.reasons[1], '‘아이와 함께’일 때는 10분까지만 보고, 이 업무는 약 5분입니다.');
  r.primary.reasons.forEach((x) => {
    assert.ok(!/남은 시간/.test(x), x);
    assert.ok(!/지금 쓸 수 있는 시간이/.test(x), x);
  });
});

test('추천: 낮잠 덧씌움 — 최대 분이 정하면 최대 분 문구, 남은 시간이 더 짧으면 남은 시간 문구', () => {
  const start = MON(10);
  const { s, pf } = mk('home', ['kids', 'nap'], start);
  M.addTask(s, { title: 'abc 확인', estimateMinutes: 5 }, plus(start, -10));
  const n1 = plus(start, 10);
  const v1 = ST.view(s, pf, n1);
  assert.equal(v1.remainCapped, true);
  const r1 = R.recommend(s, { now: n1, statusView: v1 });
  assert.equal(r1.primary.reasons[0], '‘아기 낮잠’일 때는 40분 안에 끝나는 일만 골랐어요.');
  const n2 = plus(start, 50);
  const v2 = ST.view(s, pf, n2);
  assert.equal(v2.remainCapped, false);
  const r2 = R.recommend(s, { now: n2, statusView: v2 });
  assert.equal(r2.context.capped, undefined);
  assert.equal(r2.primary.reasons[0], '‘아기 낮잠’ 남은 시간(9분) 안에 끝나는 일을 골랐어요.');
  assert.match(r2.primary.reasons[1], /^지금 쓸 수 있는 시간이 9분이고/);
});

test('추천: 사용자가 고른 시간이 있으면 최대 분 문구를 쓰지 않는다', () => {
  const now = MON(14);
  const { s, pf } = mk('shop', 'shop_open', now);
  M.addTask(s, { title: '영수증 정리', estimateMinutes: 5 }, plus(now, -10));
  const r = R.recommend(s, { now, statusView: ST.view(s, pf, now), availableMinutes: 30 });
  assert.equal(r.context.source, 'user');
  assert.ok(r.primary.reasons.every((x) => !/일 때는/.test(x)), r.primary.reasons.join(' / '));
});

// ------------------------------------------------------------------ 2. 배치 기본 길이 보정
function seed(s, n, ratio, now) {
  for (let i = 0; i < n; i++) {
    const done = plus(now, -1);
    const st = plus(done, -Math.round(30 * ratio));
    const t = M.addTask(s, { title: 'x' + i, estimateMinutes: 30, startedAt: st.toISOString() }, st);
    M.completeTask(s, t.id, done);
    AD.observeDone(s, t, done);
  }
}

test('planner.splitPlan: adaptMinutes 는 전체 길이만 보정하고 첫 조각 길이는 다시 보정하지 않는다', () => {
  const now = MON(10);
  const s = M.emptyState();
  seed(s, 20, 1.4, now);
  const t = M.addTask(s, { title: '긴 일', estimateMinutes: 600, hints: { splittable: true } }, now);
  const sp = PL.splitPlan(s, t.id, '2026-10-07', { now, minutes: 600, adaptMinutes: true });
  assert.ok(sp, 'split');
  assert.equal(sp.chunkMinutes + sp.restMinutes, PL.lengthInfo(s, t, { now, minutes: 600, adaptMinutes: true }).minutes);
  assert.equal(Math.round((new Date(sp.first.endIso) - new Date(sp.first.startIso)) / 60000), sp.chunkMinutes);
});

test('calplace.dropOnDay · calday.suggestions: lengthFor 로 잡은 길이에만 adaptMinutes 를 넘긴다', () => {
  const cp = fs.readFileSync(path.join(__dirname, '../renderer/views/calplace.js'), 'utf8');
  // 사용자가 넘긴 길이(opts.minutes)·askDuration 결과에는 adapt 가 없다
  assert.match(cp, /var fromLength = opts\.minutes == null;/);
  assert.match(cp, /Promise\.resolve\(\{ minutes: minutes, save: !!opts\.save, adapt: fromLength \|\| undefined \}\)/);
  assert.equal((cp.match(/adaptMinutes: d\.adapt/g) || []).length, 4, 'placeOnDay · placeAlt · splitPlan · 그래도 이 날에');
  const cd = fs.readFileSync(path.join(__dirname, '../renderer/views/calday.js'), 'utf8');
  assert.match(cd, /else if \(sub\.minutes != null\) o\.adaptMinutes = true;/);
});

// ------------------------------------------------------------------ 3. 귀가 말 라벨
test('귀가 말: 프리셋이 다른 상태로 보내면 그 상태 이름, 기본 도착 상태면 ‘집’', () => {
  const rows = [
    ['home', 'kids', '집 도착', MON(11), 'me', '혼자 시간'],
    ['home', 'kids', '귀가', MON(11), 'me', '혼자 시간'],
    ['home', 'out', '집 왔어', MON(11), 'me', '혼자 시간'],
    ['office', 'work', '집 도착', MON(20), 'off', '집'],
    ['shift', 'work', '집 도착', MON(9), 'off', '집'],
    ['home', 'kids', '육퇴', MON(21), 'off', '내 시간']
  ];
  rows.forEach(([preset, cur, text, now, id, label]) => {
    const { ctx } = mk(preset, cur, now);
    const d = ST.detect(text, ctx);
    const tag = preset + ' ' + text;
    assert.ok(d, tag);
    assert.deepEqual([d.id, d.label], [id, label], tag);
  });
});
