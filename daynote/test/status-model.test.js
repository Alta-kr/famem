'use strict';
// 현재 상태 — 유효 상태·시간표 짐작·상태 기계·기록 (STATUS §20.2 #39–62. #63–66 은 model/store 테스트가 맡는다 — #65 는 여기서도 ST 로 한 번 더)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('../src/core/model');
const ST = require('../src/core/status');

// 다른 wave-1 패키지가 아직 합쳐지지 않았으면 그 테스트만 건너뛴다 (IMPLEMENTATION_PLAN §0.9)
const V4 = require('../src/core/model').SCHEMA_VERSION >= 4;                        // W1-model

const at = (d, h, m) => new Date(2026, 9, d, h, m || 0);   // 10월 d일 — 5 월 · 9 금 · 10 토 · 12 월
const NOW = at(5, 10);
const P0 = ST.profile({});

function fresh(prefs) {
  const s = M.emptyState();
  Object.assign(s.prefs, prefs || {});
  return { s, pf: ST.profile(s.prefs) };
}
function set(s, pf, id, when, extra, opts) { return ST.setStatus(s, Object.assign({ id }, extra || {}), opts || { source: 'chip' }, pf, when); }
function activate(s, pf, when) { ST.toGuess(s, when, pf); }

test('#39 activatedAt 이 없으면 effective·view 가 null (근무 시간이 있어도)', () => {
  const { s, pf } = fresh({ workHours: { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] } });
  M.addTask(s, { title: '보고서 쓰기' }, NOW);
  assert.equal(ST.effective(s, pf, NOW), null);
  assert.equal(ST.view(s, pf, NOW), null);
  assert.equal(ST.current(s, pf, NOW), null);
  assert.equal(ST.isActive(s, pf), false);
});

test('#40 enabled:false 면 activatedAt 이 있어도 view null', () => {
  const { s } = fresh({ statusProfile: { enabled: false } });
  const pf = ST.profile(s.prefs);
  set(s, P0, 'off', NOW);
  assert.ok(s.presence.activatedAt);
  assert.equal(ST.view(s, pf, NOW), null);
  assert.equal(ST.isActive(s, pf), false);
  assert.equal(ST.isActive(s, P0), true);
});

test('#41 짐작: 월 10:00 업무 · 20:00 퇴근 후 · 07:00 출근 전 · 12:30 업무(점심은 짐작하지 않음)', () => {
  const { s, pf } = fresh();
  activate(s, pf, at(5, 6));
  const e = (d) => ST.effective(s, pf, d);
  assert.deepEqual([e(at(5, 10)).id, e(at(5, 10)).guessed, e(at(5, 10)).label], ['work', true, '업무 중']);
  assert.deepEqual([e(at(5, 20)).id, e(at(5, 20)).label], ['off', '퇴근 후']);
  assert.deepEqual([e(at(5, 7)).id, e(at(5, 7)).label], ['off', '출근 전']);
  assert.equal(e(at(5, 12, 30)).id, 'work');
  assert.equal(e(at(5, 12, 30)).overlay, null);
});

test('#42 짐작: 토 01:25 = 금요일 밤 퇴근 후 · 토 10:00 쉬는 날 · 월 02:00 쉬는 날(일요일 밤)', () => {
  const g = ST.guess(P0, at(10, 1, 25));
  assert.equal(g.id, 'off');
  assert.equal(g.label, '퇴근 후');
  assert.equal(g.segment.start, at(9, 18).toISOString());
  assert.equal(g.segment.end, at(10, 4).toISOString());
  assert.equal(ST.guess(P0, at(10, 10)).id, 'day_off');
  assert.equal(ST.guess(P0, at(12, 2)).id, 'day_off');
  assert.equal(ST.guess(P0, at(12, 4)).id, 'off');
  // timeline 은 구간을 이어 붙인다
  const tl = ST.timeline(P0, at(9, 19), 1);
  assert.deepEqual(tl.map((x) => x.id), ['off', 'day_off']);
});

test('#43 근무 시간 {10:00–19:00, 월–목} → 금 11:00 쉬는 날, 목 18:30 업무. 시작 ≥ 끝이면 기본값', () => {
  const pf = ST.profile({ workHours: { start: '10:00', end: '19:00', days: [1, 2, 3, 4] } });
  assert.equal(ST.guess(pf, at(9, 11)).id, 'day_off');
  assert.equal(ST.guess(pf, at(8, 18, 30)).id, 'work');
  assert.equal(ST.guess(pf, at(8, 9, 30)).id, 'off');
  const bad = ST.profile({ workHours: { start: '18:00', end: '09:00', days: [1, 2, 3, 4, 5] } });
  assert.deepEqual(bad.schedule.workHours, { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] });
  assert.equal(ST.guess(bad, at(5, 10)).id, 'work');
});

test('#44 명시한 업무는 시계가 바꾸지 않는다: 월 09:00 출근 → 21:00 에도 업무 중', () => {
  const { s, pf } = fresh();
  set(s, pf, 'work', at(5, 9));
  const e = ST.effective(s, pf, at(5, 21));
  assert.equal(e.id, 'work');
  assert.equal(e.guessed, false);
});

test('#45 업무 낡음 16시간: 월 22:00 출근 → 화 06:00 업무, 화 14:01 짐작', () => {
  const { s, pf } = fresh();
  set(s, pf, 'work', at(5, 22));
  assert.equal(ST.effective(s, pf, at(6, 6)).guessed, false);
  assert.equal(ST.effective(s, pf, at(6, 13, 59)).guessed, false);
  const e = ST.effective(s, pf, at(6, 14, 1));
  assert.equal(e.guessed, true);
  assert.equal(e.id, 'work');
});

test('#46 생활 낡음: 금 18:40 퇴근 → 토 03:59 퇴근, 토 04:00 짐작 쉬는 날', () => {
  const { s, pf } = fresh();
  set(s, pf, 'off', at(9, 18, 40));
  const a = ST.effective(s, pf, at(10, 3, 59));
  assert.deepEqual([a.id, a.guessed], ['off', false]);
  assert.equal(a.expiresAt, at(10, 4).toISOString());
  const b = ST.effective(s, pf, at(10, 4));
  assert.deepEqual([b.id, b.guessed], ['day_off', true]);
});

test('#47 이동 2시간 · 외출 4시간 · 잠 10시간이면 낡는다', () => {
  [['to_home', 2], ['out', 4], ['sleep', 10]].forEach(([id, h]) => {
    const { s, pf } = fresh();
    const t0 = at(5, 13);
    set(s, pf, id, t0);
    assert.equal(ST.effective(s, pf, new Date(t0.getTime() + h * 3600000 - 60000)).id, id, id);
    assert.equal(ST.effective(s, pf, new Date(t0.getTime() + h * 3600000)).guessed, true, id);
  });
});

test('#48 덧씌움: until 이 지나면 저장값 그대로여도 returnTo 로. 덧씌움 위 덧씌움은 원래 바탕으로. 바탕 없는 덧씌움은 짐작으로', () => {
  const { s, pf } = fresh();
  set(s, pf, 'work', at(5, 9));
  set(s, pf, 'break', at(5, 10));              // 15분
  const e1 = ST.effective(s, pf, at(5, 10, 5));
  assert.equal(e1.id, 'work');
  assert.equal(e1.overlay.id, 'break');
  assert.equal(e1.rec, 'short');
  const e2 = ST.effective(s, pf, at(5, 10, 16));
  assert.equal(s.presence.current.id, 'break');  // 저장값은 아직 그대로
  assert.deepEqual([e2.id, e2.guessed, e2.overlay], ['work', false, null]);
  // 덧씌움 위 덧씌움 → 교체, returnTo 는 원래 바탕
  set(s, pf, 'meal', at(5, 10, 5));
  assert.equal(s.presence.current.id, 'meal');
  assert.equal(s.presence.current.returnTo.id, 'work');
  assert.equal(ST.effective(s, pf, at(5, 11, 10)).id, 'work');
  // 바탕 없는 덧씌움
  const f = fresh();
  activate(f.s, f.pf, at(5, 9));
  set(f.s, f.pf, 'meeting', at(5, 10));
  assert.equal(f.s.presence.current.returnTo, null);
  const g = ST.effective(f.s, f.pf, at(5, 11, 1));
  assert.deepEqual([g.id, g.guessed], ['work', true]);
});

test('#49 시간표 짐작 끔(mode off) + 명시 없음 → none(모두 보기) → 모든 할 일 보통', () => {
  const { s } = fresh({ statusProfile: { autoSchedule: { mode: 'off' } } });
  const pf = ST.profile(s.prefs);
  M.addTask(s, { title: '보고서 쓰기' }, NOW);
  M.addTask(s, { title: '빨래 돌리기' }, NOW);
  activate(s, pf, NOW);
  const e = ST.effective(s, pf, at(5, 20));
  assert.deepEqual([e.id, e.guessed], ['none', true]);
  const v = ST.view(s, pf, at(5, 20));
  Object.keys(v.levels).forEach((id) => assert.equal(v.levels[id].level, 'normal'));
});

test('#50 setStatus: activatedAt 이 생기고 기록을 남긴다. 짐작에서 바꾸면 from null', () => {
  const { s, pf } = fresh();
  const tr = ST.setStatus(s, { id: 'off' }, { source: 'text', text: '퇴근!' }, pf, at(5, 18, 42));
  assert.equal(s.presence.activatedAt, at(5, 18, 42).toISOString());
  assert.equal(tr.noop, false);
  assert.equal(tr.from, null);
  assert.deepEqual(tr.to, { id: 'off', label: '퇴근 · 내 시간' });
  assert.deepEqual(s.presence.log[0], { at: at(5, 18, 42).toISOString(), id: 'off', label: '퇴근 · 내 시간', from: null, fromLabel: null, source: 'text', text: '퇴근!' });
  const tr2 = ST.setStatus(s, { id: 'sleep' }, { source: 'menu' }, pf, at(5, 23));
  assert.deepEqual(tr2.from, { id: 'off', label: '퇴근 · 내 시간', guessed: false });
  const last = s.presence.log[s.presence.log.length - 1];
  assert.equal(last.from, 'off');
  assert.equal(last.fromLabel, '퇴근 · 내 시간');
  assert.equal('text' in last, false);
  // 짐작에서 명시로
  const f = fresh();
  activate(f.s, f.pf, at(5, 9));
  const tr3 = ST.setStatus(f.s, { id: 'off' }, { source: 'chip' }, f.pf, at(5, 10));
  assert.deepEqual(tr3.from, { id: 'work', label: '업무 중', guessed: true });
  assert.equal(f.s.presence.log[f.s.presence.log.length - 1].from, null);
});

test('#51 같은 명시 상태 → noop, 기록이 늘지 않는다. 짐작과 같은 id 를 명시하는 것은 noop 이 아니다', () => {
  const { s, pf } = fresh();
  set(s, pf, 'work', at(5, 9));
  const n = s.presence.log.length;
  const tr = set(s, pf, 'work', at(5, 9, 30));
  assert.equal(tr.noop, true);
  assert.equal(tr.since, at(5, 9).toISOString());
  assert.equal(s.presence.log.length, n);
  const f = fresh();
  activate(f.s, f.pf, at(5, 9));
  const tr2 = set(f.s, f.pf, 'work', at(5, 10));
  assert.equal(tr2.noop, false);
  assert.equal(f.s.presence.current.id, 'work');
});

test('#52 덧씌움에 같은 id + minutes → 연장(until 만), 기록 없음', () => {
  const { s, pf } = fresh();
  set(s, pf, 'work', at(5, 9));
  set(s, pf, 'break', at(5, 10));
  const n = s.presence.log.length;
  const since = s.presence.current.since;
  const tr = set(s, pf, 'break', at(5, 10, 5), { minutes: 10 });
  assert.equal(tr.extended, true);
  assert.equal(s.presence.current.until, at(5, 10, 15).toISOString());
  assert.equal(s.presence.current.since, since);
  assert.equal(s.presence.log.length, n);
});

test('#53 업무 → 퇴근: 그 전부터 진행 중인 업무는 parked (task.status 그대로). 퇴근 → 업무: resume 으로 돌려주고 비운다', () => {
  const { s, pf } = fresh();
  const t = M.addTask(s, { title: '분기 보고서 작성', status: 'in_progress', startedAt: at(5, 9, 30).toISOString() }, at(5, 9));
  const home = M.addTask(s, { title: '빨래 돌리기', status: 'in_progress', startedAt: at(5, 9, 30).toISOString() }, at(5, 9));
  set(s, pf, 'work', at(5, 9));
  const tr = set(s, pf, 'off', at(5, 18, 40));
  assert.deepEqual(tr.parked, [t.id]);
  assert.deepEqual(s.presence.parked, [t.id]);
  assert.equal(M.byId(s.tasks, t.id).status, 'in_progress');
  assert.equal(M.byId(s.tasks, home.id).status, 'in_progress');
  const tr2 = set(s, pf, 'work', at(6, 9));
  assert.deepEqual(tr2.resume, [t.id]);
  assert.deepEqual(s.presence.parked, []);
});

test('#54 바탕이 바뀌면 shown 을 비운다. 덧씌움으로 바뀔 때는 유지한다', () => {
  const { s, pf } = fresh();
  set(s, pf, 'work', at(5, 9));
  ST.markShown(s, 't1');
  set(s, pf, 'break', at(5, 10));
  assert.deepEqual(s.presence.shown, ['t1']);
  set(s, pf, 'off', at(5, 10, 5));
  assert.deepEqual(s.presence.shown, []);
});

test('#55 revert: 마지막 기록의 from 으로(source revert). from 이 null 이면 짐작으로', () => {
  const { s, pf } = fresh();
  set(s, pf, 'work', at(5, 9));
  set(s, pf, 'off', at(5, 18));
  const tr = ST.revert(s, pf, at(5, 18, 1));
  assert.equal(s.presence.current.id, 'work');
  assert.equal(s.presence.current.source, 'revert');
  assert.equal(tr.to.id, 'work');
  const f = fresh();
  activate(f.s, f.pf, at(5, 9));
  set(f.s, f.pf, 'off', at(5, 10));
  ST.revert(f.s, f.pf, at(5, 10, 1));
  assert.equal(f.s.presence.current, null);
  assert.equal(ST.effective(f.s, f.pf, at(5, 10, 1)).guessed, true);
  assert.equal(ST.revert(fresh().s, P0, NOW), null);
});

test('#56 기록은 60개, text 는 40자로 자른다', () => {
  const { s, pf } = fresh();
  const long = '가'.repeat(50);
  for (let i = 0; i < 70; i++) ST.setStatus(s, { id: i % 2 ? 'off' : 'work' }, { source: 'text', text: long }, pf, new Date(NOW.getTime() + i * 60000));
  assert.equal(s.presence.log.length, 60);
  assert.equal(s.presence.log[59].text.length, 40);
});

test('#57 반차 until 이 지나면 짐작으로', () => {
  const { s, pf } = fresh();
  const d = ST.detect('반차', { profile: pf, eff: null, current: null, now: at(5, 8, 30) });
  ST.setStatus(s, d, { source: 'text' }, pf, at(5, 8, 30));
  const a = ST.effective(s, pf, at(5, 12));
  assert.deepEqual([a.id, a.label, a.guessed], ['off', '반차', false]);
  const b = ST.effective(s, pf, at(5, 13));
  assert.deepEqual([b.id, b.guessed], ['work', true]);
});

test('#58 settle: 지난 덧씌움·낡은 상태를 저장하고 until/expire 기록을 남긴다. 바뀐 게 없으면 false', () => {
  const { s, pf } = fresh();
  set(s, pf, 'work', at(5, 9));
  set(s, pf, 'break', at(5, 10));
  assert.equal(ST.settle(s, pf, at(5, 10, 5)), false);
  assert.equal(ST.settle(s, pf, at(5, 10, 20)), true);
  assert.equal(s.presence.current.id, 'work');
  const l1 = s.presence.log[s.presence.log.length - 1];
  assert.deepEqual([l1.source, l1.id, l1.from, l1.at], ['until', 'work', 'break', at(5, 10, 15).toISOString()]);
  assert.equal(ST.settle(s, pf, at(6, 1, 1)), true);   // 09:00 + 16h
  assert.equal(s.presence.current, null);
  assert.equal(s.presence.log[s.presence.log.length - 1].source, 'expire');
  assert.equal(ST.settle(s, pf, at(6, 2)), false);
});

test('#59 confirmGuess: 짐작 퇴근 후 → 명시(source confirm)', () => {
  const { s, pf } = fresh();
  activate(s, pf, at(5, 9));
  const tr = ST.confirmGuess(s, pf, at(5, 20));
  assert.equal(tr.noop, false);
  assert.equal(s.presence.current.id, 'off');
  assert.equal(s.presence.current.source, 'confirm');
  assert.equal(ST.effective(s, pf, at(5, 20)).guessed, false);
  assert.equal(ST.confirmGuess(s, pf, at(5, 20, 1)), null);   // 이미 명시
});

test('#60 ST.current: 회의 → busy·until, 퇴근 → busy false, 꺼짐 → null', () => {
  const { s, pf } = fresh();
  set(s, pf, 'work', at(5, 9));
  set(s, pf, 'meeting', at(5, 10));
  assert.deepEqual(ST.current(s, pf, at(5, 10, 10)), { id: 'meeting', label: '회의 중', busy: true, until: at(5, 11).toISOString(), guessed: false });
  set(s, pf, 'off', at(5, 18));
  assert.deepEqual(ST.current(s, pf, at(5, 18, 10)), { id: 'off', label: '퇴근 · 내 시간', busy: false, until: null, guessed: false });
  assert.equal(ST.current(s, ST.profile({ statusProfile: { enabled: false } }), at(5, 18, 10)), null);
  const f = fresh();
  activate(f.s, f.pf, at(5, 9));
  assert.deepEqual(ST.current(f.s, f.pf, at(5, 10)), { id: 'work', label: '업무 중', busy: false, until: null, guessed: true });
});

test('#61 ST.profile({}) → 직장인, 빈칸 없는 정책표, 메뉴 7개. 모르는 id·잘못된 수준·중복 단어는 버린다', () => {
  const pf = ST.profile({});
  assert.equal(pf.preset, 'office');
  assert.equal(pf.enabled, true);
  assert.deepEqual(pf.menu, ['work', 'meal', 'break', 'to_home', 'off', 'out', 'day_off']);
  assert.deepEqual(pf.contextIds, ['work', 'home', 'errand', 'personal', 'family', 'study']);
  pf.statusIds.forEach((id) => {
    if (pf.statuses[id].overlay) { assert.equal(pf.matrix[id], undefined, id); return; }
    pf.contextIds.concat(['_none']).forEach((c) => assert.ok(['up', 'normal', 'down', 'hide'].includes(pf.matrix[id][c]), id + '×' + c));
  });
  assert.equal(pf.matrix.off.work, 'hide');
  assert.equal(pf.matrix.work.work, 'up');
  assert.equal(pf.matrix.sleep._none, 'hide');
  assert.equal(pf.schedule.dayStart, '04:00');
  assert.deepEqual(pf.schedule.lunch, ['12:00', '13:00']);
  assert.equal(ST.profile({}), pf, '메모: 같은 설정이면 같은 객체');
  const messy = ST.profile({ statusProfile: {
    preset: 'nope',
    statuses: [{ id: 'nope', label: 'x' }, { id: 'off', label: '칼퇴', words: ['집 감', '집감', 'x', '가'.repeat(21)] }],
    policy: { off: { work: 'sideways', home: 'down' }, nope: { work: 'up' }, break: { work: 'up' } }
  } });
  assert.equal(messy.preset, 'office');
  assert.equal(messy.statuses.nope, undefined);
  assert.equal(messy.statuses.off.label, '칼퇴');
  assert.deepEqual(messy.statuses.off.words, ['집 감']);
  assert.equal(messy.matrix.off.work, 'hide');
  assert.equal(messy.matrix.off.home, 'down');
  assert.equal(messy.matrix.break, undefined);
  assert.notEqual(messy.hash, pf.hash);
});

test('#62 사용자 상태(life·home) → 공식 행. policy 칸이 프리셋을 이긴다. afterWork down → 퇴근×업무 = 내림', () => {
  const pf = ST.profile({ statusProfile: {
    statuses: [{ id: 'u_rest', custom: true, label: '집에서 쉼', category: 'life', place: 'home', words: ['소파'] }],
    policy: { to_home: { errand: 'normal' } }
  } });
  assert.equal(pf.statuses.u_rest.custom, true);
  assert.equal(pf.matrix.u_rest.work, 'hide');
  assert.equal(pf.matrix.u_rest.home, 'up');
  assert.equal(pf.matrix.u_rest.errand, 'normal');
  assert.equal(pf.rawMatrix.to_home.errand, 'up');
  assert.equal(pf.matrix.to_home.errand, 'normal');
  const down = ST.profile({ statusProfile: { afterWork: 'down' } });
  assert.equal(down.matrix.off.work, 'down');
  assert.equal(down.matrix.to_home.work, 'down');
  assert.equal(down.matrix.day_off.work, 'down');
  // 사용자 맥락 열: 업무 범주 행은 내림, 그 밖은 보통
  const cx = ST.profile({ statusProfile: { contexts: [{ id: 'u_church', custom: true, label: '교회', words: ['예배'] }] } });
  assert.equal(cx.matrix.work.u_church, 'down');
  assert.equal(cx.matrix.off.u_church, 'normal');
});

test('toGuess·wake: 시간표대로 두기와 잠에서 깨기는 presence 만 바꾼다', () => {
  const { s, pf } = fresh();
  const t = M.addTask(s, { title: '보고서 쓰기' }, NOW);
  const before = JSON.stringify([s.tasks, s.blocks, s.notes]);
  set(s, pf, 'sleep', at(5, 23));
  assert.equal(ST.wake(s, at(6, 7)), true);
  assert.equal(s.presence.current, null);
  assert.equal(s.presence.log[s.presence.log.length - 1].source, 'wake');
  assert.equal(ST.wake(s, at(6, 7, 1)), false);
  set(s, pf, 'work', at(6, 9));
  ST.toGuess(s, at(6, 10), pf);
  assert.equal(s.presence.current, null);
  assert.equal(JSON.stringify([s.tasks, s.blocks, s.notes]), before, 'I2: 할 일·블록·메모는 그대로');
  assert.equal(M.byId(s.tasks, t.id).updatedAt, t.updatedAt);
});

test('#53·#54 바탕이 바뀔 때 옛 상태에서 펼쳐 본(shown) 할 일도 parked 로 센다 (shown 을 먼저 비운다)', () => {
  const { s, pf } = fresh();
  const t = M.addTask(s, { title: '분기 보고서 작성', status: 'in_progress', startedAt: at(5, 9, 30).toISOString() }, at(5, 9));
  set(s, pf, 'work', at(5, 9));
  ST.markShown(s, t.id);
  const tr = set(s, pf, 'off', at(5, 18, 40));
  assert.deepEqual(tr.parked, [t.id]);
  assert.deepEqual(s.presence.shown, []);
});

test('깨진 저장값: since·until 이 없거나 읽을 수 없고 log 에 null 이 있어도 던지지 않는다 (낡은 것으로 본다)', () => {
  const { s, pf } = fresh();
  s.presence.activatedAt = at(5, 9).toISOString();
  s.presence.current = { id: 'off', label: '퇴근' };                       // since 없음
  assert.equal(ST.effective(s, pf, at(5, 10)).guessed, true);
  assert.ok(ST.view(s, pf, at(5, 10)));
  s.presence.current = { id: 'meal', label: '점심', since: at(5, 12).toISOString(), until: at(5, 13).toISOString(),
    returnTo: { id: 'work', label: '업무 중' } };                            // returnTo.since 없음
  const e = ST.effective(s, pf, at(5, 12, 30));
  assert.deepEqual([e.overlay.id, e.guessed], ['meal', true]);
  s.presence.current = { id: 'break', label: '휴식', since: at(5, 15).toISOString(), until: 'garbage', returnTo: null };
  const v = ST.view(s, pf, at(5, 15, 5));
  assert.deepEqual([v.overlay.id, v.overlay.until, v.remainMinutes], ['break', null, null]);
  assert.equal(ST.current(s, pf, at(5, 15, 5)).until, null);
  assert.equal(ST.settle(s, pf, at(5, 15, 20)), true, '기본 15분이 지나면 끝난다');
  assert.equal(s.presence.current, null);
  s.presence.log.push(null);
  set(s, pf, 'work', at(5, 16));
  s.presence.log.push(null);
  assert.doesNotThrow(() => ST.revert(s, pf, at(5, 16, 1)));
});

test('#65 (store vm) 메모 저장 → 라벨 없는 ST.setStatus(퇴근) → undo: 메모는 되돌아가고 presence 는 그대로', { skip: !V4 && 'W1-model 병합 전' }, () => {
  const mem = {};
  const localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
  const window = { Daynote: { model: M }, addEventListener() {} };
  const ctx = vm.createContext({ window, localStorage, setTimeout() { return 0; }, clearTimeout() {}, console, JSON, Promise, Date });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/store.js'), 'utf8'), ctx);
  const S = window.Daynote.store;
  const now = at(9, 18, 42);
  S.mutate('메모 저장', (s) => { M.addNote(s, { title: '퇴근 전 메모' }, now); });
  S.mutate(null, (s) => ST.setStatus(s, { id: 'off' }, { source: 'text', text: '퇴근!' }, ST.profile(s.prefs), now), { source: 'status' });
  const presence = S.state.presence;
  assert.equal(S.undo(), '메모 저장');
  assert.equal(S.state.notes.length, 0);
  assert.equal(S.state.presence, presence);
  assert.equal(S.state.presence.current.id, 'off');
  assert.equal(ST.effective(S.state, ST.profile(S.state.prefs), now).id, 'off');
});

test('I4 코어는 벽시계를 읽지 않는다: 상태 바꾸기·보기·나누기·예산을 Date.now·인자 없는 new Date 없이 돌린다', () => {
  const { s, pf } = fresh();
  const now = at(9, 18, 42);
  const tasks = ['견적서 보내기', '빨래 돌리기', '우유 사기', '엄마 생신 선물 주문'].map((title, i) =>
    M.addTask(s, { title, dueDate: i === 0 ? '2026-10-09' : null, dueTime: i === 0 ? '18:00' : null, atMode: i === 2 ? 'out' : null }, at(8, 9)));
  M.addBlock(s, { taskId: tasks[1].id, title: tasks[1].title, start: at(9, 19).toISOString(), end: at(9, 20).toISOString() });
  const Orig = Date;
  function Guard(...a) {
    if (!new.target) throw new Error('Date() — 벽시계를 읽었다');
    if (a.length === 0) throw new Error('new Date() — 벽시계를 읽었다');
    return new Orig(...a);
  }
  Guard.prototype = Orig.prototype;
  Guard.now = () => { throw new Error('Date.now — 벽시계를 읽었다'); };
  Guard.UTC = Orig.UTC;
  Guard.parse = Orig.parse;
  global.Date = Guard;
  try {
    const pf2 = ST.profile({ workHours: { start: '10:00', end: '19:00', days: [1, 2, 3, 4] }, statusProfile: { afterWork: 'down' } });
    ST.setStatus(s, { id: 'work' }, { source: 'text' }, pf, at(9, 9));
    ST.setStatus(s, { id: 'break', minutes: 10 }, { source: 'text' }, pf, at(9, 15));
    ST.settle(s, pf, at(9, 16));
    ST.overtimeDue(s, pf, at(9, 19, 30));
    ST.setStatus(s, { id: 'off' }, { source: 'text', text: '퇴근!' }, pf, now);
    const sv = ST.view(s, pf, now);
    ST.view(s, pf2, now);
    ST.partitionToday(s, tasks, sv, { rankedIds: tasks.map((t) => t.id) });
    ST.applyStatusPolicy(s, tasks, ST.effective(s, pf, now), pf, now);
    ST.current(s, pf, now);
    ST.hiddenSummaryText(sv.summary, pf);
    ST.nextActiveStart(pf, 'work', ST.effective(s, pf, now), now);
    ST.timeline(pf, now, 3);
    ST.revert(s, pf, at(9, 18, 43));
    ST.toGuess(s, at(9, 18, 44), pf);
    ST.confirmGuess(s, pf, at(9, 20));
    ST.budgetOk(s, pf, now); ST.useBudget(s, pf, now);
    ST.notePresetSignal(s, 'freelance', now); ST.presetOfferDue(s, pf, now); ST.guessPreset(s);
    ST.markShown(s, tasks[0].id); ST.wake(s, now);
    ST.contextOf(s, tasks[3], pf, now); ST.ruleContext('빨래 돌리기', pf); ST.contextHintsForAi(pf);
  } finally { global.Date = Orig; }
  assert.equal(s.presence.current.source, 'confirm');
});

test('ensure: 옛 상태(presence 없음·모양이 틀림)도 채운다. 읽기 함수는 state 를 바꾸지 않는다', () => {
  const s = M.emptyState();
  delete s.presence;
  assert.equal(ST.effective(s, P0, NOW), null);
  assert.equal(ST.view(s, P0, NOW), null);
  assert.equal('presence' in s, false);
  s.presence = { activatedAt: null, shown: 'x', hints: null };
  const p = ST.ensure(s);
  assert.deepEqual(p.shown, []);
  assert.deepEqual(p.parked, []);
  assert.deepEqual(p.log, []);
  assert.deepEqual(p.hints, { day: null, used: 0, overtimeDismiss: 0, presetSeen: {}, presetOffered: {} });
  assert.equal(p.current, null);
  assert.equal(ST.ensure(s), p);
});
