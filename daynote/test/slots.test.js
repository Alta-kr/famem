'use strict';

// 빈 시간 찾기 (src/core/slots.js) — 근무 시간 · 바쁜 시간 · 빈 시간 · 지금 비어 있나
// 고정 시계: 2026-10-05 월요일. 날짜는 모두 현지 시각으로 만든다 (TZ=UTC·Asia/Seoul 둘 다 통과).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const M = require('../src/core/model');
const SL = require('../src/core/slots');

const V4 = M.SCHEMA_VERSION >= 4;                                                  // W1-model

const L = (d, h, m) => new Date(2026, 9, d, h, m || 0);                           // 10월 d일 h:m (현지)
const iso = (d, h, m) => L(d, h, m).toISOString();
const NOW = L(5, 10, 0);                                                           // 월 10:00
const ms = (d, h, m) => L(d, h, m).getTime();
const ids = (list) => list.map((b) => b.id);

function task(s, fields) { return M.addTask(s, fields, NOW); }
function block(s, fields) { return M.addBlock(s, fields); }
function ev(id, s, e, extra) { return Object.assign({ id, start: s, end: e, title: id, source: 'google' }, extra || {}); }
// state.gcal.events 에 넣는 GEvent (GOOGLE §6.3 모양, 손으로 만든다)
function gev(id, s, e, extra) {
  return Object.assign({ key: 'g:cal1|' + id, calendarId: 'cal1', eventId: id, recurringEventId: null, etag: 'e', updated: s,
    status: 'confirmed', title: id, location: '', htmlLink: '', eventType: 'default', allDay: false,
    start: s, end: e, startDate: null, endDate: null, tz: null, busy: true, response: null, origin: 'google', daynoteId: null }, extra || {});
}
// 같은 순간을 '+09:00' 표기로 쓴 ISO 문자열
function kstIso(date) {
  const k = new Date(date.getTime() + 9 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return k.getUTCFullYear() + '-' + p(k.getUTCMonth() + 1) + '-' + p(k.getUTCDate()) + 'T' + p(k.getUTCHours()) + ':' + p(k.getUTCMinutes()) + ':00+09:00';
}

// ------------------------------------------------------------------ 근무 시간

test('1. normalizeWorkHours(undefined) → 월–금 09:00–18:00', () => {
  assert.deepEqual(SL.normalizeWorkHours(undefined), { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] });
  assert.deepEqual(SL.normalizeWorkHours(null), { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] });
  // 돌려준 값은 사본 — 고쳐도 기본값이 바뀌지 않는다
  const a = SL.normalizeWorkHours();
  a.days.push(6);
  assert.deepEqual(SL.normalizeWorkHours().days, [1, 2, 3, 4, 5]);
  assert.deepEqual(SL.DEFAULT_WORK_HOURS, { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] });
});

test('2. 요일이 없는 옛 설정 {10:00–19:00} → 요일은 기본값으로 채움', () => {
  assert.deepEqual(SL.normalizeWorkHours({ start: '10:00', end: '19:00' }), { start: '10:00', end: '19:00', days: [1, 2, 3, 4, 5] });
  assert.deepEqual(SL.normalizeWorkHours({ start: '9:30', end: '17:00' }), { start: '09:30', end: '17:00', days: [1, 2, 3, 4, 5] });
});

test('3. 잘못된 시각·시작 ≥ 끝 → 시간 둘 다 기본값, 요일은 정수만·중복 없이·오름차순', () => {
  const def = { start: '09:00', end: '18:00' };
  [{ start: 'aa', end: '18:00' }, { start: '19:00', end: '10:00' }, { start: '10:00', end: '10:00' }, { start: '10:00', end: '24:00' }, { start: '9:5', end: '18:00' }]
    .forEach((wh) => {
      const n = SL.normalizeWorkHours(wh);
      assert.deepEqual({ start: n.start, end: n.end }, def, JSON.stringify(wh));
    });
  assert.deepEqual(SL.normalizeWorkHours({ days: [5, 1, 1, 9, 'x'] }).days, [1, 5]);
  assert.deepEqual(SL.normalizeWorkHours({ days: [] }).days, [1, 2, 3, 4, 5]);
  assert.deepEqual(SL.normalizeWorkHours({ days: 'mon' }).days, [1, 2, 3, 4, 5]);
  assert.deepEqual(SL.normalizeWorkHours({ days: [6, 0, 2.5] }).days, [0, 6]);
  assert.equal(SL.parseHm('24:00'), null);
  assert.equal(SL.parseHm('9:5'), null);
  assert.equal(SL.parseHm('aa'), null);
  assert.equal(SL.parseHm('9:05'), 545);
  assert.equal(SL.parseHm('23:59'), 1439);
  assert.equal(SL.parseHm(null), null);
});

test('4. validateWorkHours: 정상 / end_before_start / too_short / no_days / invalid_time (메시지 포함)', () => {
  const ok = SL.validateWorkHours({ start: '09:00', end: '18:00', days: [5, 1, 3] });
  assert.deepEqual(ok, { ok: true, value: { start: '09:00', end: '18:00', days: [1, 3, 5] } });
  const cases = [
    [{ start: '18:00', end: '09:00', days: [1] }, 'end_before_start', '끝 시각은 시작보다 늦어야 해요. 밤샘 근무는 아직 지원하지 않아요.'],
    [{ start: '09:00', end: '09:00', days: [1] }, 'end_before_start', null],
    [{ start: '09:00', end: '09:20', days: [1] }, 'too_short', '근무 시간은 30분 이상이어야 해요.'],
    [{ start: '09:00', end: '18:00', days: [] }, 'no_days', '근무 요일을 하루 이상 골라 주세요.'],
    [{ start: '09:00', end: '18:00', days: [7, 'x'] }, 'no_days', null],
    [{ start: 'aa', end: '18:00', days: [1] }, 'invalid_time', '시각을 ‘09:00’처럼 골라 주세요.'],
    [{ start: '09:00', days: [1] }, 'invalid_time', null],
    [null, 'invalid_time', null]
  ];
  cases.forEach(([input, error, message]) => {
    const r = SL.validateWorkHours(input);
    assert.equal(r.ok, false, JSON.stringify(input));
    assert.equal(r.error, error, JSON.stringify(input));
    assert.equal(typeof r.message, 'string');
    assert.ok(r.message.length > 0);
    if (message) assert.equal(r.message, message);
  });
  assert.equal(SL.validateWorkHours({ start: '09:00', end: '09:30', days: [1] }).ok, true);   // 정확히 30분은 된다
});

test('5. describeWorkHours: 월–금 · 매일 · 월·수·금 · 토·일 · 월–수', () => {
  assert.equal(SL.describeWorkHours({ start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] }), '월–금 09:00–18:00');
  assert.equal(SL.describeWorkHours(undefined), '월–금 09:00–18:00');
  assert.equal(SL.describeWorkHours({ start: '10:00', end: '16:00', days: [0, 1, 2, 3, 4, 5, 6] }), '매일 10:00–16:00');
  assert.equal(SL.describeWorkHours({ start: '09:00', end: '18:00', days: [1, 3, 5] }), '월·수·금 09:00–18:00');
  assert.equal(SL.describeWorkHours({ start: '09:00', end: '18:00', days: [6, 0] }), '토·일 09:00–18:00');
  assert.equal(SL.describeWorkHours({ start: '09:00', end: '18:00', days: [1, 2, 3] }), '월–수 09:00–18:00');
  assert.equal(SL.describeWorkHours({ start: '09:00', end: '18:00', days: [1, 2, 3, 5] }), '월–수·금 09:00–18:00');
  assert.equal(SL.describeWorkHours({ start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5, 6] }), '월–토 09:00–18:00');
});

test('6. isWorkingTime: 월 10:00 참 / 09:00 참 / 18:00 거짓(끝 제외) / 토 10:00 거짓 / 토 근무 요일이면 참', () => {
  assert.equal(SL.isWorkingTime(L(5, 10, 0)), true);
  assert.equal(SL.isWorkingTime(L(5, 9, 0)), true);
  assert.equal(SL.isWorkingTime(L(5, 8, 59)), false);
  assert.equal(SL.isWorkingTime(L(5, 18, 0)), false);
  assert.equal(SL.isWorkingTime(L(5, 17, 59)), true);
  assert.equal(SL.isWorkingTime(L(10, 10, 0)), false);
  assert.equal(SL.isWorkingTime(L(10, 10, 0), { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5, 6] }), true);
  assert.equal(SL.isWorkingDay(L(10, 10, 0)), false);
  assert.equal(SL.isWorkingDay(L(9, 23, 0)), true);
});

test('7. workWindow(토) → null, workWindow(월) → 현지 09:00–18:00', () => {
  assert.equal(SL.workWindow(L(10, 12, 0)), null);
  const w = SL.workWindow(L(5, 22, 30));
  assert.equal(w.start.getTime(), ms(5, 9, 0));
  assert.equal(w.end.getTime(), ms(5, 18, 0));
  const w2 = SL.workWindow(L(6, 1, 0), { start: '10:00', end: '16:30' });
  assert.equal(w2.start.getTime(), ms(6, 10, 0));
  assert.equal(w2.end.getTime(), ms(6, 16, 30));
});

// ------------------------------------------------------------------ 바쁜 시간

test('8. 블록: 작업·일정 모두, ignoreId 제외, 지운 할 일 제외, 끝낸 할 일은 기본 포함 / includeDoneWork:false 면 제외', () => {
  const s = M.emptyState();
  const live = task(s, { title: '보고서' });
  const done = task(s, { title: '끝낸 일' });
  const gone = task(s, { title: '지운 일' });
  const w = block(s, { taskId: live.id, title: '옛 제목', start: iso(5, 10, 0), end: iso(5, 11, 0) });
  const e = block(s, { title: '팀 회의', start: iso(5, 13, 0), end: iso(5, 14, 0) });
  const dw = block(s, { taskId: done.id, start: iso(5, 9, 0), end: iso(5, 9, 30) });
  const gw = block(s, { taskId: gone.id, start: iso(5, 8, 0), end: iso(5, 8, 30) });
  M.completeTask(s, done.id, NOW);
  M.deleteTask(s, gone.id, NOW);                       // 지난 블록은 남지만 바쁜 시간에서는 뺀다
  assert.ok(M.byId(s.blocks, gw.id));

  const all = SL.collectBusy(s, L(5, 0, 0), L(6, 0, 0));
  assert.deepEqual(ids(all), [dw.id, w.id, e.id]);    // 시작순
  const bw = all.find((b) => b.id === w.id);
  assert.deepEqual(bw, { id: w.id, start: ms(5, 10, 0), end: ms(5, 11, 0), title: '보고서', source: 'block', kind: 'work', taskId: live.id, done: false });
  const be = all.find((b) => b.id === e.id);
  assert.equal(be.kind, 'event');
  assert.equal(be.title, '팀 회의');
  assert.equal(be.taskId, null);
  assert.equal(all.find((b) => b.id === dw.id).done, true);

  assert.deepEqual(ids(SL.collectBusy(s, L(5, 0, 0), L(6, 0, 0), { ignoreId: w.id })), [dw.id, e.id]);
  assert.deepEqual(ids(SL.collectBusy(s, L(5, 0, 0), L(6, 0, 0), { includeDoneWork: false })), [w.id, e.id]);
  // 구간 [from, to) 와 겹치는 것만
  assert.deepEqual(ids(SL.collectBusy(s, L(5, 11, 0), L(5, 13, 0))), []);
  assert.deepEqual(ids(SL.collectBusy(s, L(5, 10, 59), L(5, 13, 1))), [w.id, e.id]);
});

test('9. 외부 일정(opts.external): 취소·한가함·busy:false 제외, 종일은 busy:true 일 때만', () => {
  const s = M.emptyState();
  const external = [
    ev('meet', iso(5, 10, 0), iso(5, 11, 0)),
    ev('cancel', iso(5, 11, 0), iso(5, 12, 0), { status: 'cancelled' }),
    ev('free', iso(5, 12, 0), iso(5, 13, 0), { transparency: 'transparent' }),
    ev('nb', iso(5, 13, 0), iso(5, 14, 0), { busy: false }),
    ev('allday', L(5, 0, 0).toISOString(), L(6, 0, 0).toISOString(), { allDay: true }),
    ev('allday-busy', L(5, 0, 0).toISOString(), L(6, 0, 0).toISOString(), { allDay: true, busy: true }),
    ev('tent', iso(5, 15, 0), iso(5, 16, 0), { status: 'tentative' })
  ];
  const before = JSON.stringify(external);
  const busy = SL.collectBusy(s, L(5, 0, 0), L(6, 0, 0), { external });
  assert.deepEqual(ids(busy), ['allday-busy', 'meet', 'tent']);
  const m = busy.find((b) => b.id === 'meet');
  assert.deepEqual(m, { id: 'meet', start: ms(5, 10, 0), end: ms(5, 11, 0), title: 'meet', source: 'external', kind: 'external', taskId: null, done: false, provider: 'google' });
  assert.equal(JSON.stringify(external), before);
  // ignoreId 는 외부 일정에도 적용된다
  assert.deepEqual(ids(SL.collectBusy(s, L(5, 0, 0), L(6, 0, 0), { external, ignoreId: 'meet' })), ['allday-busy', 'tent']);
});

test('10. 오프셋 ISO(+09:00) 외부 일정과 toISOString 블록이 같은 순간으로 겹침 판정된다', () => {
  const s = M.emptyState();
  const b = block(s, { title: '회의', start: iso(5, 10, 0), end: iso(5, 11, 0) });
  const off = ev('kst', kstIso(L(5, 10, 30)), kstIso(L(5, 11, 30)));
  assert.match(off.start, /\+09:00$/);
  const busy = SL.collectBusy(s, L(5, 0, 0), L(6, 0, 0), { external: [off] });
  const k = busy.find((x) => x.id === 'kst');
  assert.equal(k.start, ms(5, 10, 30));
  assert.equal(k.end, ms(5, 11, 30));
  assert.deepEqual(ids(SL.conflicts(busy, L(5, 10, 45), L(5, 10, 50))), [b.id, 'kst']);
  assert.deepEqual(ids(SL.conflicts(busy, L(5, 11, 0), L(5, 11, 15))), ['kst']);
  assert.deepEqual(SL.merge(busy), [{ start: ms(5, 10, 0), end: ms(5, 11, 30) }]);
});

test('11. NaN·end <= start 항목은 무시하고, 입력 배열·state 를 바꾸지 않는다', () => {
  const s = M.emptyState();
  block(s, { title: '깨짐', start: 'nope', end: iso(5, 11, 0) });
  block(s, { title: '거꾸로', start: iso(5, 12, 0), end: iso(5, 11, 0) });
  block(s, { title: '0분', start: iso(5, 12, 0), end: iso(5, 12, 0) });
  block(s, { title: '시각 없음', start: null, end: null });
  const ok = block(s, { title: '정상', start: iso(5, 14, 0), end: iso(5, 15, 0) });
  const external = [ev('bad', 'x', iso(5, 9, 0)), ev('rev', iso(5, 9, 0), iso(5, 8, 0))];
  const snapState = JSON.stringify(s), snapExt = JSON.stringify(external);
  const busy = SL.collectBusy(s, L(5, 0, 0), L(6, 0, 0), { external });
  assert.deepEqual(ids(busy), [ok.id]);
  assert.equal(JSON.stringify(s), snapState);
  assert.equal(JSON.stringify(external), snapExt);
  // merge·conflicts 도 입력을 바꾸지 않는다
  const copy = JSON.stringify(busy);
  SL.merge(busy); SL.conflicts(busy, L(5, 14, 0), L(5, 14, 30));
  assert.equal(JSON.stringify(busy), copy);
});

test('12. conflicts 는 반열린 구간: 10:00–10:30 과 10:30–11:00 은 안 겹치고, 10:15–10:45 는 겹친다', () => {
  const busy = [{ id: 'a', start: ms(5, 10, 0), end: ms(5, 10, 30) }];
  assert.deepEqual(SL.conflicts(busy, L(5, 10, 30), L(5, 11, 0)), []);
  assert.deepEqual(ids(SL.conflicts(busy, L(5, 10, 15), L(5, 10, 45))), ['a']);
  assert.deepEqual(ids(SL.conflicts(busy, iso(5, 9, 30), ms(5, 10, 1))), ['a']);   // Date·ISO·ms 모두 받는다
  assert.deepEqual(SL.conflicts(busy, L(5, 9, 30), L(5, 10, 0)), []);
});

// ------------------------------------------------------------------ 빈 시간 찾기

const busyOf = (pairs) => pairs.map(([a, b], i) => ({ id: 'b' + i, start: a.getTime(), end: b.getTime() }));

test('13. work: 월 10:00, 30분, 바쁨 10:00–11:00 → 11:00', () => {
  const r = SL.findSlot(busyOf([[L(5, 10, 0), L(5, 11, 0)]]), { from: NOW, now: NOW, minutes: 30 });
  assert.equal(r.found, true);
  assert.equal(r.mode, 'work');
  assert.equal(r.start.getTime(), ms(5, 11, 0));
  assert.equal(r.end.getTime(), ms(5, 11, 30));
  assert.equal(r.sameDay, true);
  assert.equal(r.dayOffset, 0);
});

test('14. 이어진 바쁨(10:00–10:30, 10:30–11:15)은 합쳐서 → 11:15', () => {
  const r = SL.findSlot(busyOf([[L(5, 10, 0), L(5, 10, 30)], [L(5, 10, 30), L(5, 11, 15)]]), { from: NOW, now: NOW, minutes: 30 });
  assert.equal(r.start.getTime(), ms(5, 11, 15));
});

test('15. 15분 칸: 바쁨 끝 10:40 → 10:45', () => {
  const r = SL.findSlot(busyOf([[L(5, 10, 0), L(5, 10, 40)]]), { from: NOW, now: NOW, minutes: 30 });
  assert.equal(r.start.getTime(), ms(5, 10, 45));
  assert.equal(SL.roundUp15(L(5, 10, 40)).getTime(), ms(5, 10, 45));
  assert.equal(SL.roundUp15(L(5, 10, 45)).getTime(), ms(5, 10, 45));
  assert.equal(SL.roundUp15(new Date(ms(5, 10, 45) + 1000)).getTime(), ms(5, 11, 0));
  assert.equal(SL.roundUp15(L(5, 23, 50)).getTime(), ms(6, 0, 0));
});

test('16. 90분: 60분 틈은 건너뛰고 다음 맞는 틈', () => {
  const r = SL.findSlot(busyOf([[L(5, 10, 0), L(5, 11, 0)], [L(5, 12, 0), L(5, 13, 0)]]), { from: NOW, now: NOW, minutes: 90 });
  assert.equal(r.start.getTime(), ms(5, 13, 0));
  assert.equal(r.end.getTime(), ms(5, 14, 30));
});

test('17. 근무 끝을 넘김: 월 17:30 60분 → 화 09:00, sameDay:false, dayOffset:1', () => {
  const from = L(5, 17, 30);
  const r = SL.findSlot([], { from, now: from, minutes: 60 });
  assert.equal(r.mode, 'work');
  assert.equal(r.start.getTime(), ms(6, 9, 0));
  assert.equal(r.sameDay, false);
  assert.equal(r.dayOffset, 1);
});

test('18. 금 17:30 60분 → 다음 월 09:00 (주말 건너뜀)', () => {
  const from = L(9, 17, 30);
  const r = SL.findSlot([], { from, now: from, minutes: 60, workHours: undefined });
  assert.equal(r.start.getTime(), ms(12, 9, 0));
  assert.equal(r.dayOffset, 3);
});

test('19. day: 토 10:00(근무일 아님) 바쁨 10:00–11:00 → 토 11:00. 22:45 에서 30분 → 다음 날 07:00', () => {
  const sat = L(10, 10, 0);
  const r = SL.findSlot(busyOf([[L(10, 10, 0), L(10, 11, 0)]]), { from: sat, now: sat, minutes: 30 });
  assert.equal(r.mode, 'day');
  assert.equal(r.start.getTime(), ms(10, 11, 0));
  const late = L(10, 22, 45);
  const r2 = SL.findSlot([], { from: late, now: late, minutes: 30 });
  assert.equal(r2.mode, 'day');
  assert.equal(r2.start.getTime(), ms(11, 7, 0));
  assert.equal(r2.dayOffset, 1);
  // 22:30 에서 30분은 그날 안(23:00 끝 포함)
  const r3 = SL.findSlot([], { from: L(10, 22, 30), now: L(10, 22, 30), minutes: 30 });
  assert.equal(r3.start.getTime(), ms(10, 22, 30));
});

test('20. pickMode·defaultMode', () => {
  assert.equal(SL.pickMode(L(5, 10, 0)), 'work');
  assert.equal(SL.pickMode(L(5, 20, 0)), 'day');
  assert.equal(SL.pickMode(L(5, 7, 30)), 'day');
  assert.equal(SL.pickMode(L(5, 18, 0)), 'day');
  assert.equal(SL.defaultMode(L(5, 7, 30)), 'work');      // 출근 전이면 근무 시작부터
  assert.equal(SL.defaultMode(L(5, 19, 0)), 'day');
  assert.equal(SL.defaultMode(L(10, 10, 0)), 'day');      // 토요일
  // 출근 전 07:30 에서 근무 모드로 찾으면 09:00
  const r = SL.findSlot([], { from: L(5, 7, 30), now: L(5, 7, 30), minutes: 30, mode: SL.defaultMode(L(5, 7, 30)) });
  assert.equal(r.start.getTime(), ms(5, 9, 0));
});

test('21. 지금 이전은 내지 않는다: from 어제, now 월 10:07 → 10:15 이후', () => {
  const now = L(5, 10, 7);
  const r = SL.findSlot([], { from: L(4, 10, 0), now, minutes: 30 });
  assert.equal(r.found, true);
  assert.ok(r.start.getTime() >= ms(5, 10, 15));
  assert.equal(r.start.getTime(), ms(5, 10, 15));
  assert.equal(r.sameDay, false);
});

test('22. too_long: work 600분, day 961분', () => {
  const a = SL.findSlot([], { from: NOW, now: NOW, minutes: 600, mode: 'work' });
  assert.deepEqual(a, { found: false, reason: 'too_long', mode: 'work' });
  const b = SL.findSlot([], { from: NOW, now: NOW, minutes: 961, mode: 'day' });
  assert.deepEqual(b, { found: false, reason: 'too_long', mode: 'day' });
  assert.equal(SL.findSlot([], { from: NOW, now: NOW, minutes: 540, mode: 'work' }).found, true);   // 9시간은 들어간다(다음 날 09:00)
  assert.equal(SL.findSlot([], { from: NOW, now: NOW, minutes: 960, mode: 'day' }).found, true);
});

test('23. no_slot: 14일 동안의 근무 창이 모두 바쁨', () => {
  const r = SL.findSlot(busyOf([[L(5, 0, 0), L(25, 0, 0)]]), { from: NOW, now: NOW, minutes: 30, mode: 'work' });
  assert.deepEqual(r, { found: false, reason: 'no_slot', mode: 'work' });
  // days 를 줄여도 같은 규칙
  const r2 = SL.findSlot(busyOf([[L(5, 0, 0), L(7, 0, 0)]]), { from: NOW, now: NOW, minutes: 30, mode: 'work', days: 2 });
  assert.equal(r2.reason, 'no_slot');
});

test('24. 외부(Google) 바쁨이 자리를 막는다', () => {
  const s = M.emptyState();
  const busy = SL.collectBusy(s, NOW, L(20, 0, 0), { external: [ev('g1', iso(5, 10, 0), iso(5, 11, 0)), ev('g2', iso(5, 11, 0), iso(5, 11, 30))] });
  const r = SL.findSlot(busy, { from: NOW, now: NOW, minutes: 30 });
  assert.equal(r.start.getTime(), ms(5, 11, 30));
});

test('25. ignoreId: 고치는 블록 자신은 자리를 막지 않는다', () => {
  const s = M.emptyState();
  const me = block(s, { title: '내 일정', start: iso(5, 10, 0), end: iso(5, 10, 30) });
  const other = block(s, { title: '다른 일정', start: iso(5, 10, 30), end: iso(5, 11, 0) });
  const r = SL.findSlot(SL.collectBusy(s, NOW, L(20, 0, 0), { ignoreId: me.id }), { from: NOW, now: NOW, minutes: 30 });
  assert.equal(r.start.getTime(), ms(5, 10, 0));
  const r2 = SL.findSlot(SL.collectBusy(s, NOW, L(20, 0, 0)), { from: NOW, now: NOW, minutes: 30 });
  assert.equal(r2.start.getTime(), ms(5, 11, 0));
  assert.ok(other);
});

test('26. 사용자 근무 시간(10:00–16:00, 월–토)을 따른다', () => {
  const wh = { start: '10:00', end: '16:00', days: [1, 2, 3, 4, 5, 6] };
  const fri = L(9, 15, 30);
  const r = SL.findSlot([], { from: fri, now: fri, minutes: 60, workHours: wh });
  assert.equal(r.mode, 'work');
  assert.equal(r.start.getTime(), ms(10, 10, 0));          // 토요일도 근무일
  assert.equal(SL.pickMode(L(5, 9, 30), wh), 'day');       // 10시 전은 근무 시간 밖
  const r2 = SL.findSlot([], { from: L(5, 9, 30), now: L(5, 9, 30), minutes: 30, workHours: wh, mode: 'work' });
  assert.equal(r2.start.getTime(), ms(5, 10, 0));
  assert.deepEqual(SL.findSlot([], { from: fri, now: fri, minutes: 361, workHours: wh, mode: 'work' }), { found: false, reason: 'too_long', mode: 'work' });
});

test('27. bad_input: minutes 0·소수·문자, from 무효', () => {
  assert.equal(SL.findSlot([], { from: NOW, now: NOW, minutes: 0 }).reason, 'bad_input');
  assert.equal(SL.findSlot([], { from: NOW, now: NOW, minutes: 1.5 }).reason, 'bad_input');
  assert.equal(SL.findSlot([], { from: NOW, now: NOW, minutes: '30' }).reason, 'bad_input');
  assert.equal(SL.findSlot([], { from: 'not a date', now: NOW, minutes: 30 }).reason, 'bad_input');
  assert.equal(SL.findSlot([], { from: NOW, now: NOW, minutes: 30 }).found, true);
});

// ------------------------------------------------------------------ 지금 비어 있나

test('28. 블록 없음 → free, next null, reason null', () => {
  const r = SL.freeNow(M.emptyState(), NOW, {});
  assert.deepEqual(r, { free: true, reason: null, current: null, next: null, freeMinutes: null, workTime: true });
});

test('29. 진행 중(start <= now < end) → in_progress, current 채움 (가장 먼저 끝나는 것)', () => {
  const s = M.emptyState();
  const long = block(s, { title: '긴 회의', start: iso(5, 9, 0), end: iso(5, 12, 0) });
  const short = block(s, { title: '짧은 회의', start: iso(5, 10, 0), end: iso(5, 10, 30) });
  const r = SL.freeNow(s, NOW, {});
  assert.equal(r.free, false);
  assert.equal(r.reason, 'in_progress');
  assert.equal(r.current.id, short.id);
  assert.ok(long);
});

test('30. 지금 막 끝난 블록 → free', () => {
  const s = M.emptyState();
  block(s, { title: '회의', start: iso(5, 9, 0), end: iso(5, 10, 0) });
  const r = SL.freeNow(s, NOW, {});
  assert.equal(r.free, true);
  assert.equal(r.current, null);
});

test('31. 정확히 15분 뒤 시작 → imminent / 16분 뒤 → free, freeMinutes 15(5분 단위 내림)', () => {
  const s = M.emptyState();
  const b = block(s, { title: '회의', start: iso(5, 10, 15), end: iso(5, 11, 0) });
  let r = SL.freeNow(s, NOW, {});
  assert.equal(r.free, false);
  assert.equal(r.reason, 'imminent');
  assert.equal(r.next.id, b.id);
  M.updateBlock(s, b.id, { start: iso(5, 10, 16) });
  r = SL.freeNow(s, NOW, {});
  assert.equal(r.free, true);
  assert.equal(r.reason, null);
  assert.equal(r.next.id, b.id);
  assert.equal(r.freeMinutes, 15);
  M.updateBlock(s, b.id, { start: iso(5, 11, 20), end: iso(5, 12, 0) });
  assert.equal(SL.freeNow(s, NOW, {}).freeMinutes, 80);
});

test('32. 끝낸 할 일의 작업 블록이 진행 중이어도 free', () => {
  const s = M.emptyState();
  const t = task(s, { title: '끝낸 일' });
  block(s, { taskId: t.id, start: iso(5, 9, 30), end: iso(5, 10, 30) });
  assert.equal(SL.freeNow(s, NOW, {}).reason, 'in_progress');
  M.completeTask(s, t.id, NOW);
  const r = SL.freeNow(s, NOW, {});
  assert.equal(r.free, true);
  assert.equal(r.current, null);
});

test('33. 외부 일정이 진행 중 → in_progress', () => {
  const r = SL.freeNow(M.emptyState(), NOW, { external: [ev('g', iso(5, 9, 45), iso(5, 10, 45))] });
  assert.equal(r.reason, 'in_progress');
  assert.equal(r.current.id, 'g');
  assert.equal(r.current.provider, 'google');
});

test('34. status:{busy:true} → status, {busy:false}·null → 영향 없음', () => {
  const s = M.emptyState();
  assert.equal(SL.freeNow(s, NOW, { status: { label: '회의 중', busy: true } }).reason, 'status');
  assert.equal(SL.freeNow(s, NOW, { status: { label: '회의 중', busy: true } }).free, false);
  assert.equal(SL.freeNow(s, NOW, { status: { label: '퇴근', busy: false } }).free, true);
  assert.equal(SL.freeNow(s, NOW, { status: null }).free, true);
  // 진행 중이 상태보다 먼저
  block(s, { title: '회의', start: iso(5, 9, 0), end: iso(5, 11, 0) });
  assert.equal(SL.freeNow(s, NOW, { status: { busy: true } }).reason, 'in_progress');
});

test('35. 23:55 에 다음 날 00:05 블록 → imminent (자정을 넘어도 본다)', () => {
  const s = M.emptyState();
  block(s, { title: '심야 배포', start: iso(6, 0, 5), end: iso(6, 1, 0) });
  const r = SL.freeNow(s, L(5, 23, 55), {});
  assert.equal(r.reason, 'imminent');
  assert.equal(r.next, null);                              // 오늘(자정 전) 시작하는 것이 아니다
  assert.equal(r.freeMinutes, null);
});

test('36. workTime 참/거짓, 지운 할 일의 블록은 무시', () => {
  const s = M.emptyState();
  const t = task(s, { title: '지울 일' });
  block(s, { taskId: t.id, start: iso(5, 9, 30), end: iso(5, 10, 30) });
  M.deleteTask(s, t.id, NOW);
  const r = SL.freeNow(s, NOW, {});
  assert.equal(r.free, true);
  assert.equal(r.workTime, true);
  assert.equal(SL.freeNow(s, L(5, 19, 0), {}).workTime, false);
  assert.equal(SL.freeNow(s, L(10, 10, 0), {}).workTime, false);
  assert.equal(SL.freeNow(s, L(10, 10, 0), { workHours: { start: '09:00', end: '18:00', days: [6] } }).workTime, true);
});

// ------------------------------------------------------------------ Google 일정(state.gcal.events) — W1-model 병합 뒤

test('state.gcal.events 의 바쁜 Google 일정을 읽는다 (종일·한가함 제외, provider google)', { skip: !V4 && 'W1-model 병합 전' }, () => {
  const s = M.emptyState();
  s.gcal.calendars.push({ id: 'cal1', summary: '내 캘린더', color: '#7986cb', selected: true });
  s.gcal.events.push(
    gev('meet', iso(5, 14, 0), iso(5, 15, 0)),
    gev('tent', iso(5, 16, 0), iso(5, 16, 30), { response: 'needsAction' }),
    gev('free', iso(5, 11, 0), iso(5, 12, 0), { busy: false }),
    gev('vac', L(5, 0, 0).toISOString(), L(6, 0, 0).toISOString(), { allDay: true, busy: false, startDate: '2026-10-05', endDate: '2026-10-06' }),
    gev('kst', kstIso(L(5, 17, 0)), kstIso(L(5, 17, 30)))
  );
  const busy = SL.collectBusy(s, L(5, 0, 0), L(6, 0, 0));
  assert.deepEqual(ids(busy), ['g:cal1|meet', 'g:cal1|tent', 'g:cal1|kst']);
  const m = busy[0];
  assert.deepEqual(m, { id: 'g:cal1|meet', start: ms(5, 14, 0), end: ms(5, 15, 0), title: 'meet', source: 'external', kind: 'external', taskId: null, done: false, provider: 'google' });
  assert.equal(busy[2].start, ms(5, 17, 0));
  // 빈 시간 찾기도 Google 회의를 피한다
  const r = SL.findSlot(busy, { from: L(5, 14, 0), now: L(5, 14, 0), minutes: 60 });
  assert.equal(r.start.getTime(), ms(5, 15, 0));
  // 지금 비어 있나: Google 회의 중이면 in_progress
  assert.equal(SL.freeNow(s, L(5, 14, 30), {}).reason, 'in_progress');
  assert.equal(SL.freeNow(s, L(5, 14, 30), {}).current.id, 'g:cal1|meet');
  // opts.external 과 같은 id 가 겹쳐 들어와도 한 번만
  assert.equal(SL.collectBusy(s, L(5, 0, 0), L(6, 0, 0), { external: [ev('g:cal1|meet', iso(5, 14, 0), iso(5, 15, 0))] }).length, 3);
  // ignoreId 로 Google 일정도 뺄 수 있다
  assert.deepEqual(ids(SL.collectBusy(s, L(5, 0, 0), L(6, 0, 0), { ignoreId: 'g:cal1|meet' })), ['g:cal1|tent', 'g:cal1|kst']);
});

test('SL.conflicts(collectBusy(…)) 와 M.conflictsFor 가 블록 + Google 바쁨에서 같은 결과를 낸다', { skip: !V4 && 'W1-model 병합 전' }, () => {
  const s = M.emptyState();
  const live = task(s, { title: '보고서' });
  const done = task(s, { title: '끝낸 일' });
  const gone = task(s, { title: '지운 일' });
  const blocks = [
    block(s, { taskId: live.id, start: iso(5, 9, 0), end: iso(5, 10, 0) }),
    block(s, { title: '팀 회의', start: iso(5, 10, 30), end: iso(5, 11, 30) }),
    block(s, { taskId: done.id, start: iso(5, 13, 0), end: iso(5, 13, 30) }),
    block(s, { taskId: gone.id, start: iso(5, 8, 0), end: iso(5, 8, 30) }),
    block(s, { title: '다음 날', start: iso(6, 9, 0), end: iso(6, 10, 0) })
  ];
  M.completeTask(s, done.id, NOW);
  M.deleteTask(s, gone.id, NOW);                       // 08:00 블록은 지난 것이라 남는다 — 그래도 둘 다 뺀다
  assert.ok(M.byId(s.blocks, blocks[3].id));
  s.gcal.events.push(
    gev('meet', iso(5, 11, 0), iso(5, 12, 0)),
    gev('tent', iso(5, 13, 15), iso(5, 14, 0), { status: 'tentative' }),
    gev('free', iso(5, 9, 30), iso(5, 10, 30), { busy: false }),
    gev('vac', L(5, 0, 0).toISOString(), L(6, 0, 0).toISOString(), { allDay: true, busy: false, startDate: '2026-10-05', endDate: '2026-10-06' }),
    gev('kst', kstIso(L(5, 15, 0)), kstIso(L(5, 16, 0)))
  );
  const windows = [[L(5, 0, 0), L(6, 0, 0)], [L(5, 8, 0), L(5, 8, 30)], [L(5, 9, 45), L(5, 11, 15)], [L(5, 11, 30), L(5, 13, 15)],
    [L(5, 13, 0), L(5, 13, 20)], [L(5, 15, 30), L(5, 15, 45)], [L(5, 16, 0), L(5, 17, 0)], [L(5, 23, 0), L(6, 9, 30)]];
  const sorted = (list) => list.map((x) => x.id).sort();
  windows.forEach(([a, b]) => {
    [null, blocks[1].id, 'g:cal1|meet'].forEach((ignoreId) => {
      const fromSlots = SL.conflicts(SL.collectBusy(s, a, b, { ignoreId }), a, b);
      const fromModel = M.conflictsFor(s, a.toISOString(), b.toISOString(), ignoreId);
      assert.deepEqual(sorted(fromSlots), sorted(fromModel), a.toISOString() + ' ' + b.toISOString() + ' ' + ignoreId);
    });
  });
  // 하루 전체에서는 지운 할 일의 블록·종일·한가함이 빠지고 나머지가 모두 나온다
  assert.deepEqual(sorted(SL.conflicts(SL.collectBusy(s, L(5, 0, 0), L(6, 0, 0)), L(5, 0, 0), L(6, 0, 0))),
    [blocks[0].id, blocks[1].id, blocks[2].id, 'g:cal1|kst', 'g:cal1|meet', 'g:cal1|tent'].sort());
});

test('slots 는 window 없이 require 만으로 동작하고 내보내기 이름이 계약과 같다', () => {
  ['DEFAULT_WORK_HOURS', 'DAY_WINDOW', 'STEP_MIN', 'SEARCH_DAYS', 'IMMINENT_MIN', 'parseHm', 'normalizeWorkHours', 'validateWorkHours',
    'describeWorkHours', 'isWorkingDay', 'workWindow', 'isWorkingTime', 'roundUp15', 'collectBusy', 'conflicts', 'merge',
    'findSlot', 'pickMode', 'defaultMode', 'freeNow'].forEach((k) => assert.ok(k in SL, k));
  assert.deepEqual(SL.DAY_WINDOW, { start: '07:00', end: '23:00' });
  assert.equal(SL.STEP_MIN, 15);
  assert.equal(SL.SEARCH_DAYS, 14);
  assert.equal(SL.IMMINENT_MIN, 15);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'slots.js'), 'utf8');
  assert.ok(!/new Date\(\)/.test(src), '벽시계를 읽지 않는다');
  assert.ok(!/=>|\bconst\b|\blet\b|`/.test(src.replace(/\/\/.*$/gm, '')), 'ES5 문법');
});
