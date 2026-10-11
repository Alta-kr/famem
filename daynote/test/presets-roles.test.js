'use strict';
// 현재 상태 — 프리셋별 역할 풀이 (복귀·도착·깸), 덧씌움 추천 최대 분, 걸어 둔 때 — STATUS §4.4 · §12
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/core/model');
const ST = require('../src/core/status');

const at = (d, h, m) => new Date(2026, 9, d, h, m || 0);   // 2026-10-d (5 = 월, 10 = 토)
const MON = (h, m) => at(5, h, m);
const SAT = (h, m) => at(10, h, m);

function prefsFor(preset, extra) {
  return { statusProfile: Object.assign({ preset }, extra || {}) };
}
function mk(preset, cur, now, extra) {
  const s = M.emptyState();
  Object.assign(s.prefs, prefsFor(preset, extra));
  const pf = ST.profile(s.prefs);
  if (cur === 'guess') ST.toGuess(s, new Date(now.getTime() - 60000), pf);
  else if (cur) {
    const list = [].concat(cur);
    list.forEach((id, i) => ST.setStatus(s, { id }, { source: 'chip' }, pf, new Date(now.getTime() - (list.length - i) * 60000)));
  }
  return { s, pf, ctx: { profile: pf, eff: ST.effective(s, pf, now), current: s.presence.current, now } };
}
const GUESS_ON = { autoSchedule: { mode: 'guess' } };

// [프리셋, 지금 상태, 말, 시각, 추가 설정, 기대 { id, label } | null]
const ROWS = [
  // 직장인·프리랜서: 지금처럼 근무 시간이면 업무로, 밖이면 퇴근, 주말이면 쉬는 날
  ['office', 'out', '다녀왔어', MON(11), null, { id: 'work', label: '업무 중' }],
  ['office', 'out', '다녀왔어', MON(20), null, { id: 'off' }],
  ['office', 'out', '다녀왔어', SAT(11), null, { id: 'day_off' }],
  ['freelance', 'out', '다녀왔어', MON(11), null, { id: 'wfh', label: '작업 중' }],
  ['freelance', 'out', '다녀왔어', MON(21), null, { id: 'off', label: '일 끝' }],
  // 육아·살림: 짐작이 꺼져 있으면(기본) 혼자 시간으로, 켜면 등원–하원 시간표대로
  ['home', 'out', '다녀왔어', MON(11), null, { id: 'me', label: '혼자 시간' }],
  ['home', 'out', '다녀왔어', MON(11), GUESS_ON, { id: 'me', label: '혼자 시간' }],
  ['home', 'out', '다녀왔어', MON(20), GUESS_ON, { id: 'kids', label: '아이와 함께' }],
  ['home', 'out', '집 도착', MON(11), null, { id: 'me' }],
  ['home', 'to_home', '도착', MON(11), null, { id: 'me', label: '혼자 시간' }],
  ['home', 'kids', '귀가', MON(11), null, { id: 'me' }],
  ['home', 'kids', '육퇴', MON(21), null, { id: 'off', label: '내 시간' }],
  ['home', 'kids', '애들 재웠어', MON(21), null, { id: 'off', label: '내 시간' }],
  // 학생: 수업 시간 안에 돌아오면 공부 중 (알바 중이 아니다)
  ['student', 'out', '복귀', MON(11), null, { id: 'study', label: '공부 중' }],
  ['student', 'out', '복귀', MON(20), null, { id: 'off', label: '집·자유' }],
  ['student', 'out', '복귀', SAT(11), null, { id: 'day_off' }],
  // 자영업: 영업 시간 안이면 영업 중
  ['shop', 'out', '다녀왔어', MON(13), null, { id: 'shop_open', label: '영업 중' }],
  ['shop', 'out', '다녀왔어', MON(21), null, { id: 'off', label: '영업 끝' }],
  // 교대 근무: 시간표로 짐작하지 않는다 — 요일·시각과 상관없이 같다
  ['shift', 'out', '다녀왔어', MON(13), null, { id: 'off', label: '퇴근' }],
  ['shift', 'out', '다녀왔어', SAT(13), null, { id: 'off', label: '퇴근' }],
  ['shift', 'out', '집 도착', SAT(13), null, { id: 'off' }],
  ['shift', 'work', '집 도착', SAT(9), null, { id: 'off' }],
  ['office', 'out', '집 도착', SAT(13), null, { id: 'day_off' }]
];
test('복귀·도착: 프리셋의 시간표 짐작 상태로 돌아간다 (교대 근무는 시간으로 짐작하지 않음)', () => {
  ROWS.forEach(([preset, cur, text, now, extra, want]) => {
    const { ctx } = mk(preset, cur, now, extra);
    const d = ST.detect(text, ctx);
    const tag = [preset, cur, text, now.toString().slice(0, 21), extra ? 'guess' : ''].join(' ');
    if (want === null) { assert.equal(d, null, tag); return; }
    assert.ok(d, tag + ' detected');
    assert.equal(d.id, want.id, tag + ' id');
    if (want.label) assert.equal(d.label, want.label, tag + ' label');
  });
});

test('일어났어: 교대 근무·짐작 꺼짐이면 시간표 이름을 쓰지 않는다', () => {
  const sh = mk('shift', 'sleep', MON(15));
  const d = ST.detect('일어났어', sh.ctx);
  assert.ok(d && d.id == null);
  assert.equal(d.label, sh.pf.statuses.none.label);
  const of = mk('office', 'sleep', MON(15));
  assert.equal(ST.detect('일어났어', of.ctx).label, '업무 중');
});

test('추천 최대 분: 덧씌움은 제 것만 — 영업 중 위 브레이크·점심은 10분에 묶이지 않는다', () => {
  const now = MON(14);
  ['break', 'meal'].forEach((ov) => {
    const { s, pf } = mk('shop', ['shop_open', ov], now);
    const eff = ST.effective(s, pf, now);
    assert.equal(eff.recMax, null, ov);
    const v = ST.view(s, pf, now);
    assert.ok(v.remainMinutes == null || v.remainMinutes > 10, ov + ' remain ' + v.remainMinutes);
    assert.equal(v.remainCapped, false, ov);
  });
  // 바탕만 있으면 그대로 10분, 남은 시간이 아니라 최대 분이라는 표시
  const so = mk('shop', 'shop_open', now);
  const v = ST.view(so.s, so.pf, now);
  assert.deepEqual([v.remainMinutes, v.remainCapped], [10, true]);
  // 낮잠: 50분 남으면 40분(최대 분), 9분 남으면 9분(남은 시간)
  const n = mk('home', ['kids', 'nap'], MON(10));
  const v1 = ST.view(n.s, n.pf, new Date(MON(10).getTime() + 10 * 60000));
  assert.deepEqual([v1.remainMinutes, v1.remainCapped], [40, true]);
  const v2 = ST.view(n.s, n.pf, new Date(MON(10).getTime() + 50 * 60000));
  assert.deepEqual([v2.remainMinutes, v2.remainCapped], [9, false]);
  // 덧씌움 없는 보통 상태
  const o = mk('office', 'work', now);
  assert.equal(ST.view(o.s, o.pf, now).remainCapped, false);
});

test('학생 시간표 짐작은 공부 시간이라 부른다 (수업 중은 추천·알림 없음과 섞이지 않게)', () => {
  const { s, pf } = mk('student', 'guess', MON(10));
  const eff = ST.effective(s, pf, MON(10));
  assert.deepEqual([eff.id, eff.label, eff.guessed], ['study', '공부 시간', true]);
  assert.equal(pf.schedule.label, '수업 시간', '설정 카드 이름은 그대로');
});

test('걸어 둔 때: 프리셋 전용 상태는 정한 때만 맞는다', () => {
  const T = [
    ['home', 'kids', 'off', false],
    ['home', 'kids', 'work', false],
    ['home', 'kids', 'rest', false],
    ['home', 'me', 'off', true],
    ['student', 'study', 'work', false],
    ['student', 'part_time', 'work', true],
    ['shop', 'shop_prep', 'work', true],
    ['shop', 'shop_open', 'work', true],
    ['shop', 'shop_close', 'work', true],
    ['shop', 'shop_open', 'off', false]
  ];
  T.forEach(([preset, sid, mode, want]) => {
    assert.equal(ST.atModeMatches(mode, sid, ST.profile(prefsFor(preset))), want, preset + ' ' + sid + ' ' + mode);
  });
  // 사용자 상태는 여전히 범주로
  const pf = ST.profile({ statusProfile: { preset: 'office', statuses: [{ id: 'u_gym', custom: true, label: '헬스장', category: 'life', place: 'out' }] } });
  assert.equal(ST.atModeMatches('out', 'u_gym', pf), true);
  // 아이와 함께일 때 '퇴근하고' 걸어 둔 일은 띄우지 않는다
  const { s, pf: hp } = mk('home', 'kids', MON(10));
  const t = M.addTask(s, { title: '택배 반품' }, MON(9));
  M.updateTask(s, t.id, { atMode: 'off', atModeSource: 'user' }, MON(9));
  const lv = ST.view(s, hp, MON(10)).levels[t.id];
  assert.ok(!lv || lv.reason !== 'when', '아이와 함께는 퇴근하고가 아니다');
});
