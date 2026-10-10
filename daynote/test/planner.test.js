'use strict';

// 배치 알고리즘 (src/core/planner.js) — 띠·수준·바쁜 시간·점수·이유·실패·가까운 날·나누기·하루 자동 배치
// 고정 시계: 2026-10-05 월요일. 날짜는 모두 현지 시각으로 만든다 (TZ=UTC·Asia/Seoul 둘 다 통과).
// "활성" = presence.activatedAt 을 둔 상태(기본 프리셋 office).

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/core/model');
const D = require('../src/core/dates');
const SL = require('../src/core/slots');
const ST = require('../src/core/status');
const PL = require('../src/core/planner');

const L = (d, h, m) => new Date(2026, 9, d, h || 0, m || 0);                      // 10월 d일 h:m (현지)
const iso = (d, h, m) => L(d, h, m).toISOString();
const MON = L(5, 10, 0);
const WED = '2026-10-07';
const FRI = L(9, 18, 42);
const SAT = L(10, 1, 25);
const hm = (c) => D.hm(c.start);
const hmE = (c) => D.hm(c.end);

function fresh() { return M.emptyState(); }
function task(s, fields, now) { return M.addTask(s, fields, now || MON); }
function block(s, d, h1, m1, h2, m2, extra) {
  return M.addBlock(s, Object.assign({ title: '일정', start: iso(d, h1, m1), end: iso(d, h2, m2) }, extra || {}));
}
function activate(s) { ST.ensure(s); s.presence.activatedAt = MON.toISOString(); return s; }
function gev(id, s, e, extra) {
  return Object.assign({ key: 'g:cal1|' + id, calendarId: 'cal1', eventId: id, recurringEventId: null, etag: 'e', updated: s,
    status: 'confirmed', title: id, location: '', htmlLink: '', eventType: 'default', allDay: false,
    start: s, end: e, startDate: null, endDate: null, tz: null, busy: true, response: null, origin: 'google', daynoteId: null }, extra || {});
}
const HOME = '설거지하기';           // 집안일 맥락, 배치 힌트 없음
const NONE = '그거 하기';            // 맥락 없음, 힌트 없음
const WORK = '주간 보고서 작성';      // 업무 맥락

// ------------------------------------------------------------------ 기본·입력

test('1. 없는 할 일 → missing, 끝낸 할 일 → done, suggestSlots 는 둘 다 []', () => {
  const s = fresh();
  const t = task(s, { title: HOME, estimateMinutes: 30 });
  M.completeTask(s, t.id, MON);
  assert.equal(PL.placeOnDay(s, 'nope', WED, { now: MON }).reason, 'missing');
  assert.equal(PL.placeOnDay(s, 'nope', WED, { now: MON }).ok, false);
  assert.equal(PL.placeOnDay(s, 'nope', WED, { now: MON }).message, '할 일을 찾지 못했어요.');
  const r = PL.placeOnDay(s, t.id, WED, { now: MON });
  assert.equal(r.reason, 'done');
  assert.equal(r.message, '이미 끝낸 일이에요.');
  assert.deepEqual(PL.suggestSlots(s, 'nope', WED, { now: MON }), []);
  assert.deepEqual(PL.suggestSlots(s, t.id, WED, { now: MON }), []);
});

test('2. 소요 시간 없음 → no_estimate, opts.minutes 를 주면 ok', () => {
  const s = fresh();
  const t = task(s, { title: HOME });
  const r = PL.placeOnDay(s, t.id, WED, { now: MON });
  assert.equal(r.reason, 'no_estimate');
  assert.equal(r.message, '소요 시간을 먼저 정해 주세요.');
  const ok = PL.placeOnDay(s, t.id, WED, { now: MON, minutes: 30 });
  assert.equal(ok.ok, true);
  assert.equal(ok.candidate.minutes, 30);
});

test('3. 어제 → past, 오늘 → 가능', () => {
  const s = fresh();
  const t = task(s, { title: NONE, estimateMinutes: 30 });
  const r = PL.placeOnDay(s, t.id, '2026-10-04', { now: MON });
  assert.equal(r.reason, 'past');
  assert.equal(r.message, '지난 날짜에는 넣을 수 없어요.');
  assert.equal(PL.placeOnDay(s, t.id, '2026-10-05', { now: MON }).ok, true);
});

test('4. 오늘: 모든 후보가 15분 칸으로 올린 지금 이후 (10:07 → 첫 후보 ≥ 10:15)', () => {
  const s = fresh();
  const now = L(5, 10, 7);
  const t = task(s, { title: NONE, estimateMinutes: 30 }, now);
  const list = PL.suggestSlots(s, t.id, '2026-10-05', { now, limit: 100 });
  assert.ok(list.length > 0);
  const floor = SL.roundUp15(now).getTime();
  assert.equal(D.hm(new Date(floor)), '10:15');
  list.forEach((c) => assert.ok(c.start.getTime() >= floor, hm(c)));
});

test('5. 모든 후보: 15분 칸 시작, 길이 = minutes, startIso = start.toISOString()', () => {
  const s = fresh();
  const t = task(s, { title: NONE, estimateMinutes: 45 });
  block(s, 7, 10, 10, 11, 5);
  const list = PL.suggestSlots(s, t.id, WED, { now: MON, limit: 100 });
  assert.ok(list.length > 10);
  list.forEach((c) => {
    assert.ok([0, 15, 30, 45].includes(c.start.getMinutes()));
    assert.equal((c.end - c.start) / 60000, c.minutes);
    assert.equal(c.minutes, 45);
    assert.equal(c.startIso, c.start.toISOString());
    assert.equal(c.endIso, c.end.toISOString());
  });
});

test('6. block 모양이 정확하고 addBlock 뒤 conflictsFor 가 그 블록을 돌려준다', () => {
  const s = fresh();
  const t = task(s, { title: HOME, estimateMinutes: 30 });
  const r = PL.placeOnDay(s, t.id, WED, { now: MON });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.block).sort(), ['end', 'kind', 'start', 'taskId']);
  assert.deepEqual(r.block, { taskId: t.id, kind: 'work', start: r.candidate.startIso, end: r.candidate.endIso });
  const b = M.addBlock(s, r.block);
  const hits = M.conflictsFor(s, r.block.start, r.block.end);
  assert.deepEqual(hits.map((x) => x.id), [b.id]);
});

test('7. 순수성: placeOnDay·suggestSlots·arrangeDay·nearestDay 전후 상태가 같다', () => {
  const s = activate(fresh());
  const a = task(s, { title: HOME, estimateMinutes: 30, dueDate: '2026-10-08' });
  const b = task(s, { title: WORK, estimateMinutes: 90, priority: 'high' });
  task(s, { title: NONE });
  block(s, 7, 18, 30, 20, 0);
  s.gcal.events.push(gev('e1', iso(7, 9, 0), iso(7, 10, 0)));
  const before = JSON.stringify(s);
  PL.placeOnDay(s, a.id, WED, { now: MON });
  PL.placeOnDay(s, b.id, '2026-10-11', { now: MON });
  PL.suggestSlots(s, a.id, WED, { now: MON });
  PL.arrangeDay(s, s.tasks.map((t) => t.id), WED, { now: MON });
  PL.nearestDay(s, b.id, '2026-10-11', { now: MON });
  PL.splitPlan(s, a.id, WED, { now: MON });
  PL.windowsFor(s, a, WED, { now: MON });
  assert.equal(JSON.stringify(s), before);
});

test('8. 결정성: 같은 입력 두 번 같고, 블록 순서를 뒤집어도 같다', () => {
  const s = fresh();
  const t = task(s, { title: HOME, estimateMinutes: 30 });
  block(s, 7, 18, 30, 19, 0);
  block(s, 7, 20, 0, 21, 0);
  block(s, 7, 7, 0, 7, 30);
  const one = PL.suggestSlots(s, t.id, WED, { now: MON });
  const two = PL.suggestSlots(s, t.id, WED, { now: MON });
  assert.deepEqual(one, two);
  s.blocks.reverse();
  assert.deepEqual(PL.suggestSlots(s, t.id, WED, { now: MON }), one);
  assert.deepEqual(PL.placeOnDay(s, t.id, WED, { now: MON }), PL.placeOnDay(s, t.id, WED, { now: MON }));
});

// ------------------------------------------------------------------ 띠·고정 표(상태 꺼짐)

const bandRows = (bands) => bands.map((b) => [b.band, D.hm(b.start) + '–' + D.hm(b.end), b.statusId]);

test('9. dayBands(수): 출근 전·업무·점심·업무·퇴근 후·늦은 밤', () => {
  const bands = PL.dayBands(fresh(), WED, { now: MON });
  assert.deepEqual(bandRows(bands), [
    ['morning', '07:00–08:30', 'off'],
    ['work', '09:00–12:00', 'work'],
    ['lunch', '12:00–13:00', 'work'],
    ['work', '13:00–18:00', 'work'],
    ['evening', '18:30–22:30', 'off'],
    ['late', '22:30–23:00', 'off']
  ]);
  assert.deepEqual(bands.map((b) => b.label), ['출근 전', '업무 중', '점심시간', '업무 중', '퇴근 후', '늦은 밤']);
  bands.forEach((b) => assert.equal(D.ymd(b.start), WED));
});

test('10. dayBands(토): 쉬는 날 가장자리 07–09·21–23, 가운데 09–21, 상태 id day_off', () => {
  const bands = PL.dayBands(fresh(), '2026-10-10', { now: MON });
  assert.deepEqual(bandRows(bands), [
    ['dayoff_edge', '07:00–09:00', 'day_off'],
    ['dayoff', '09:00–21:00', 'day_off'],
    ['dayoff_edge', '21:00–23:00', 'day_off']
  ]);
  assert.deepEqual(bands.map((b) => b.label), ['쉬는 날', '쉬는 날', '쉬는 날']);
});

test('11. 맥락 없음 30분, 수 → 09:00 (보통 10 + 정렬 3; 18:30 도 13 이지만 이른 쪽)', () => {
  assert.equal(ST.ruleContext(NONE), null);
  const s = fresh();
  const t = task(s, { title: NONE, estimateMinutes: 30 });
  const list = PL.suggestSlots(s, t.id, WED, { now: MON, limit: 100 });
  assert.equal(hm(list[0]), '09:00');
  assert.equal(list[0].score, 13);
  assert.deepEqual(list[0].terms, { level: 10, fragAlign: 3 });
  const at1830 = list.find((c) => hm(c) === '18:30');
  assert.equal(at1830.score, 13);
  const at0700 = list.find((c) => hm(c) === '07:00');
  assert.equal(at0700.score, 7);
});

test('12. 업무 맥락, 수 → 근무 시간 안, 첫 이유 ‘근무 시간 안이에요.’', () => {
  const s = fresh();
  const t = task(s, { title: WORK, estimateMinutes: 60 });
  const r = PL.placeOnDay(s, t.id, WED, { now: MON });
  assert.equal(r.ok, true);
  assert.ok(r.candidate.start >= L(7, 9) && r.candidate.end <= L(7, 18));
  assert.equal(r.candidate.band, 'work');
  assert.equal(r.reasons[0], '근무 시간 안이에요.');
});

test('13. 업무 맥락, 일요일 → no_window + 가장 가까운 날 10/12 09:00', () => {
  const s = fresh();
  const t = task(s, { title: WORK, estimateMinutes: 60 });
  const r = PL.placeOnDay(s, t.id, '2026-10-11', { now: MON });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_window');
  assert.equal(r.message, '근무 시간에 할 일이라 쉬는 날에는 넣지 않았어요.');
  assert.equal(r.detail, null);
  assert.equal(r.alternatives.length, 1);
  assert.equal(r.alternatives[0].ymd, '2026-10-12');
  assert.equal(hm(r.alternatives[0].candidate), '09:00');
  assert.equal(r.split, null);
});

test('14. 집안일, 수 → 18:30 · good, 근무 띠 후보 없음', () => {
  const s = fresh();
  const t = task(s, { title: '빨래 돌리기', estimateMinutes: 30 });
  const list = PL.suggestSlots(s, t.id, WED, { now: MON, limit: 100 });
  assert.equal(hm(list[0]), '18:30');
  assert.equal(list[0].fit, 'good');
  assert.ok(list.every((c) => c.band !== 'work'));
});

test('15. 집안일, 토요일(now=토 01:25) → 09:00', () => {
  const s = fresh();
  const t = task(s, { title: HOME, estimateMinutes: 30 }, SAT);
  const r = PL.placeOnDay(s, t.id, '2026-10-10', { now: SAT });
  assert.equal(r.ok, true);
  assert.equal(hm(r.candidate), '09:00');
  assert.equal(r.candidate.band, 'dayoff');
});

test('16. 밖 볼일·개인·가족·공부 맥락 → 수요일 저녁 띠 (고정 표)', () => {
  const rows = [
    { title: '은행 가기', ctx: 'errand' },
    { title: '병원 예약', ctx: 'personal' },
    { title: '엄마 생신 선물 사기', ctx: 'family' },
    { title: '영어 단어 외우기', ctx: 'study' }
  ];
  rows.forEach((row) => {
    assert.equal(ST.ruleContext(row.title).ctx, row.ctx, row.title);
    const s = fresh();
    const t = task(s, { title: row.title, estimateMinutes: 30 });
    const list = PL.suggestSlots(s, t.id, WED, { now: MON, limit: 100 });
    assert.equal(list[0].band, 'evening', row.title);
    assert.equal(hm(list[0]), '18:30', row.title);
    assert.equal(list[0].fit, 'good', row.title);
    assert.ok(list.every((c) => c.band !== 'work'), row.title);
    const lv = {};
    PL.windowsFor(s, t, WED, { now: MON }).forEach((w) => w.parts.forEach((p) => { lv[p.band] = p.level; }));
    assert.deepEqual(lv, { morning: 'down', lunch: 'down', evening: 'up', late: 'normal' }, row.title);
  });
});

test('17. 근무 시간 10:00–19:00 → 집안일 19:30, 업무 10:00', () => {
  const s = fresh();
  s.prefs.workHours = { start: '10:00', end: '19:00', days: [1, 2, 3, 4, 5] };
  const h = task(s, { title: HOME, estimateMinutes: 30 });
  const w = task(s, { title: WORK, estimateMinutes: 60 });
  assert.equal(hm(PL.placeOnDay(s, h.id, WED, { now: MON }).candidate), '19:30');
  assert.equal(hm(PL.placeOnDay(s, w.id, WED, { now: MON }).candidate), '10:00');
});

test('18. 근무 요일에 토요일(6) → 토요일이 근무일 띠', () => {
  const s = fresh();
  s.prefs.workHours = { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5, 6] };
  const bands = PL.dayBands(s, '2026-10-10', { now: MON });
  assert.deepEqual(bands.map((b) => b.band), ['morning', 'work', 'lunch', 'work', 'evening', 'late']);
  const w = task(s, { title: WORK, estimateMinutes: 60 });
  assert.equal(hm(PL.placeOnDay(s, w.id, '2026-10-10', { now: MON }).candidate), '09:00');
});

test('19. 상태 꺼짐: 이유에 맥락 이름(‘집안일’)을 쓰지 않는다', () => {
  const s = fresh();
  const t = task(s, { title: HOME, estimateMinutes: 30 });
  const list = PL.suggestSlots(s, t.id, WED, { now: MON });
  assert.equal(list[0].reasons[0], '근무 시간 밖이라 개인 일 하기 좋은 시간이에요.');
  list.forEach((c) => c.reasons.forEach((x) => assert.ok(!x.includes('집안일'), x)));
});

test('20. noStatus: 맥락 null 처럼 모든 띠가 보통', () => {
  const s = activate(fresh());
  const t = task(s, { title: HOME, estimateMinutes: 30 });
  const mode = PL.taskMode(s, t, { now: MON, noStatus: true });
  assert.equal(mode.ctx, null);
  assert.equal(mode.statusActive, false);
  assert.equal(mode.profile, null);
  const parts = [];
  PL.windowsFor(s, t, WED, { now: MON, noStatus: true }).forEach((w) => w.parts.forEach((p) => parts.push(p)));
  assert.equal(parts.length, 6);
  assert.ok(parts.every((p) => p.level === 'normal'));
  assert.equal(hm(PL.suggestSlots(s, t.id, WED, { now: MON, noStatus: true })[0]), '09:00');
});

// ------------------------------------------------------------------ 바쁜 시간

test('21. 수 18:30–20:00 블록 → 집안일 30분은 20:00', () => {
  const s = fresh();
  const t = task(s, { title: HOME, estimateMinutes: 30 });
  block(s, 7, 18, 30, 20, 0);
  assert.equal(hm(PL.placeOnDay(s, t.id, WED, { now: MON }).candidate), '20:00');
});

test('22. Google 바쁨 일정 18:30–19:30 → 19:30; 종일·한가함 일정은 무시', () => {
  const s = fresh();
  const t = task(s, { title: HOME, estimateMinutes: 30 });
  s.gcal.events.push(gev('busy', iso(7, 18, 30), iso(7, 19, 30)));
  assert.equal(hm(PL.placeOnDay(s, t.id, WED, { now: MON }).candidate), '19:30');

  const s2 = fresh();
  const t2 = task(s2, { title: HOME, estimateMinutes: 30 });
  s2.gcal.events.push(gev('free', iso(7, 18, 30), iso(7, 19, 30), { busy: false }));
  s2.gcal.events.push(gev('allday', iso(7, 0, 0), iso(8, 0, 0), { allDay: true, startDate: WED, endDate: '2026-10-08' }));
  assert.equal(hm(PL.placeOnDay(s2, t2.id, WED, { now: MON }).candidate), '18:30');
});

test('23. opts.external 바쁨도 피한다', () => {
  const s = fresh();
  const t = task(s, { title: HOME, estimateMinutes: 30 });
  const external = [{ id: 'x1', start: iso(7, 18, 0), end: iso(7, 19, 15), title: '외부', source: 'google' }];
  assert.equal(hm(PL.placeOnDay(s, t.id, WED, { now: MON, external }).candidate), '19:15');
});

test('24. ignoreBlockId: 자기 블록(18:30–19:00)을 옮길 때 18:30 이 다시 후보', () => {
  const s = fresh();
  const t = task(s, { title: HOME, estimateMinutes: 30 });
  const b = M.addBlock(s, { taskId: t.id, kind: 'work', start: iso(7, 18, 30), end: iso(7, 19, 0) });
  assert.notEqual(hm(PL.suggestSlots(s, t.id, WED, { now: MON })[0]), '18:30');
  const list = PL.suggestSlots(s, t.id, WED, { now: MON, ignoreBlockId: b.id });
  assert.equal(hm(list[0]), '18:30');
});

test('25. 끝낸 할 일의 작업 블록도 바쁜 시간이다', () => {
  const s = fresh();
  const t = task(s, { title: HOME, estimateMinutes: 30 });
  const done = task(s, { title: '화분 물 주기', estimateMinutes: 30 });
  M.addBlock(s, { taskId: done.id, kind: 'work', start: iso(7, 18, 30), end: iso(7, 19, 0) });
  M.completeTask(s, done.id, MON);
  const list = PL.suggestSlots(s, t.id, WED, { now: MON, limit: 100 });
  assert.ok(list.every((c) => !(c.start < L(7, 19) && c.end > L(7, 18, 30))));
  assert.equal(hm(list[0]), '19:00');
});

test('26. 집안일이 갈 수 있는 띠가 모두 차면 no_slot + 이유 + 가까운 날(10/6, 이른 날 먼저)', () => {
  const s = fresh();
  const t = task(s, { title: HOME, estimateMinutes: 30 });
  block(s, 7, 7, 0, 8, 30);
  block(s, 7, 12, 0, 13, 0);          // 고정 표의 점심(내림)도 집안일이 갈 수 있는 띠다
  block(s, 7, 18, 30, 23, 0);
  const r = PL.placeOnDay(s, t.id, WED, { now: MON });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_slot');
  assert.equal(r.message, '10/7(수)에는 30분 빈 시간이 없어요.');
  assert.ok(r.detail.includes('퇴근 후(18:30–22:30)'), r.detail);
  assert.equal(r.detail, '퇴근 후(18:30–22:30)가 일정으로 차 있어요.');
  assert.equal(r.alternatives[0].ymd, '2026-10-06');
  assert.equal(hm(r.alternatives[0].candidate), '18:30');
});

test('27. 집안일 300분: 수요일은 too_long(가장 긴 창 270분), 토요일엔 들어간다', () => {
  const s = fresh();
  const t = task(s, { title: HOME, estimateMinutes: 300 });
  const r = PL.placeOnDay(s, t.id, WED, { now: MON });
  assert.equal(r.reason, 'too_long');
  assert.equal(r.message, '‘설거지하기’(5시간)은 이 날 넣을 수 있는 가장 긴 시간(4시간 30분)보다 길어요.');
  assert.ok(r.message.includes('4시간 30분'));
  const sat = PL.placeOnDay(s, t.id, '2026-10-10', { now: MON });
  assert.equal(sat.ok, true);
  assert.equal(sat.candidate.minutes, 300);
});

// ------------------------------------------------------------------ 상태 켜짐

test('28. 활성 + 집안일, 수 → 18:30, 이유 ‘퇴근 후’라 ‘집안일’…', () => {
  const s = activate(fresh());
  const t = task(s, { title: HOME, estimateMinutes: 30 });
  const r = PL.placeOnDay(s, t.id, WED, { now: MON });
  assert.equal(hm(r.candidate), '18:30');
  assert.equal(r.candidate.statusId, 'off');
  assert.equal(r.reasons[0], '‘퇴근 후’라 ‘집안일’ 하기 좋은 시간이에요.');
});

test('29. 활성 + 집안일, 저녁·늦은 밤·출근 전이 모두 차면 근무 띠 poor + 내림 이유', () => {
  const s = activate(fresh());
  const t = task(s, { title: HOME, estimateMinutes: 30 });
  block(s, 7, 7, 0, 8, 30);
  block(s, 7, 18, 30, 23, 0);
  const r = PL.placeOnDay(s, t.id, WED, { now: MON });
  assert.equal(r.ok, true);
  assert.equal(r.candidate.band, 'work');
  assert.equal(r.candidate.fit, 'poor');
  assert.equal(r.reasons[0], '‘업무 중’ 시간이라 알맞은 때는 아니지만 다른 빈 시간이 없어요.');
  // 내림 문장은 1순위에만
  r.alternatives.forEach((c) => assert.ok(!c.reasons.some((x) => x.includes('알맞은 때는 아니지만'))));
});

test('30. 활성 + 업무 할 일, 토요일 → no_window (쉬는 날의 업무 = 숨김)', () => {
  const s = activate(fresh());
  const t = task(s, { title: WORK, estimateMinutes: 60 });
  const r = PL.placeOnDay(s, t.id, '2026-10-10', { now: MON });
  assert.equal(r.reason, 'no_window');
  assert.equal(r.message, '‘업무’ 일은 ‘쉬는 날’에는 넣지 않아요.');
});

test('31. 활성 + afterWork down → 업무 할 일 토요일 가능, poor', () => {
  const s = activate(fresh());
  s.prefs.statusProfile = { afterWork: 'down' };
  const t = task(s, { title: WORK, estimateMinutes: 60 });
  const r = PL.placeOnDay(s, t.id, '2026-10-10', { now: MON });
  assert.equal(r.ok, true);
  assert.equal(r.candidate.fit, 'poor');
});

test('32. 활성 + policy {off:{home:hide}} → 집안일 저녁 불가, 근무 띠(down)로', () => {
  const s = activate(fresh());
  s.prefs.statusProfile = { policy: { off: { home: 'hide' } } };
  const t = task(s, { title: HOME, estimateMinutes: 30 });
  const list = PL.suggestSlots(s, t.id, WED, { now: MON, limit: 100 });
  assert.ok(list.length > 0);
  assert.ok(list.every((c) => c.band === 'work' || c.band === 'lunch'));
  assert.ok(list.every((c) => c.level === 'down' && c.fit === 'poor'));
  assert.equal(list[0].band, 'work');
});

test('33. presence.current 를 명시 off 로 둬도 미래 날짜 결과가 같다 (시간표만 본다)', () => {
  const s = activate(fresh());
  const t = task(s, { title: WORK, estimateMinutes: 60 });
  const h = task(s, { title: HOME, estimateMinutes: 30 });
  const before = [PL.suggestSlots(s, t.id, WED, { now: MON }), PL.suggestSlots(s, h.id, WED, { now: MON })];
  s.presence.current = { id: 'off', label: '퇴근 · 내 시간', role: null, since: MON.toISOString(), source: 'user', until: null, returnTo: null };
  assert.equal(ST.current(s, null, MON).id, 'off');
  assert.deepEqual([PL.suggestSlots(s, t.id, WED, { now: MON }), PL.suggestSlots(s, h.id, WED, { now: MON })], before);
  assert.equal(PL.suggestSlots(s, t.id, WED, { now: MON })[0].statusId, 'work');
});

// ------------------------------------------------------------------ 걸어 둔 상태

test('34. atMode off(맥락 없음), 수 → 18:30, 이유 ‘퇴근하고’ 하기로 한 일이에요.', () => {
  const s = fresh();
  const t = task(s, { title: NONE, estimateMinutes: 30, atMode: 'off', atModeSource: 'user' });
  const r = PL.placeOnDay(s, t.id, WED, { now: MON });
  assert.equal(hm(r.candidate), '18:30');
  assert.equal(r.candidate.level, 'up');
  assert.equal(r.reasons[0], '‘퇴근하고’ 하기로 한 일이에요.');
});

test('35. atMode work + 집안일(꺼짐) → 근무 띠 up (숨김을 이긴다) → 09:00', () => {
  const s = fresh();
  const t = task(s, { title: HOME, estimateMinutes: 30, atMode: 'work', atModeSource: 'user' });
  const r = PL.placeOnDay(s, t.id, WED, { now: MON });
  assert.equal(hm(r.candidate), '09:00');
  assert.equal(r.candidate.band, 'work');
  assert.equal(r.candidate.fit, 'good');
  assert.equal(r.reasons[0], '‘출근하면’ 하기로 한 일이에요.');
});

test('36. atMode pause, 수 → 12:00(점심, comfort 없음); 토 → 후보는 있고 poor', () => {
  const s = fresh();
  const t = task(s, { title: NONE, estimateMinutes: 30, atMode: 'pause', atModeSource: 'user' });
  const c = PL.suggestSlots(s, t.id, WED, { now: MON })[0];
  assert.equal(hm(c), '12:00');
  assert.equal(c.band, 'lunch');
  assert.equal(c.terms.comfort, undefined);
  const sat = PL.suggestSlots(s, t.id, '2026-10-10', { now: MON });
  assert.ok(sat.length > 0);
  assert.equal(sat[0].fit, 'poor');
});

test('37. atMode rest: 수 → poor, 토 → good', () => {
  const s = fresh();
  const t = task(s, { title: NONE, estimateMinutes: 30, atMode: 'rest', atModeSource: 'user' });
  assert.equal(PL.suggestSlots(s, t.id, WED, { now: MON })[0].fit, 'poor');
  assert.equal(PL.suggestSlots(s, t.id, '2026-10-10', { now: MON })[0].fit, 'good');
});

// ------------------------------------------------------------------ 힌트

test('38. ruleHints 데이터 표', () => {
  const N = { focus: null, energy: null, prefer: null, splittable: null };
  const rows = [
    ['분기 보고서 작성', { focus: 'deep' }],
    ['고객사에 메일 보내기', { focus: 'light' }],
    ['보고서 메일로 보내기', { focus: 'light' }],
    ['아침 운동', { energy: 'high', prefer: 'morning' }],
    ['틈틈이 영어 공부', { focus: 'deep', splittable: true }],
    ['한 번에 몰아서 정리', { focus: 'light', splittable: false }],
    ['한번에 정리', { focus: 'light', splittable: false }],
    ['정리본 작성 후 메일', { focus: 'light' }],
    ['코드리뷰하기', {}],
    ['퇴근 후 책 읽기', { energy: 'low', prefer: 'evening' }],
    ['퇴근후 장보기', { energy: 'high', prefer: 'evening' }],
    ['오후에 은행', { prefer: 'afternoon' }],
    ['', {}]
  ];
  rows.forEach(([title, want]) => assert.deepEqual(PL.ruleHints(title), Object.assign({}, N, want), JSON.stringify(title)));
  assert.deepEqual(PL.ruleHints(null), N);
});

test('39. hintsOf: user 의 null 은 그대로, ai 의 null 은 규칙 값, 없으면 규칙', () => {
  const s = fresh();
  const title = '틈틈이 영어 공부';                     // 규칙: deep · splittable true
  const u = task(s, { title, schedHints: { focus: null, energy: 'low', prefer: null, splittable: null, source: 'user', at: MON.toISOString() } });
  assert.deepEqual(PL.hintsOf(u), { focus: null, energy: 'low', prefer: null, splittable: null,
    src: { focus: 'user', energy: 'user', prefer: 'user', splittable: 'user' } });
  const a = task(s, { title, schedHints: { focus: 'light', energy: null, prefer: null, splittable: null, source: 'ai', at: MON.toISOString() } });
  assert.deepEqual(PL.hintsOf(a), { focus: 'light', energy: null, prefer: null, splittable: true,
    src: { focus: 'ai', energy: null, prefer: null, splittable: 'rule' } });
  const n = task(s, { title });
  assert.deepEqual(PL.hintsOf(n), { focus: 'deep', energy: null, prefer: null, splittable: true,
    src: { focus: 'rule', energy: null, prefer: null, splittable: 'rule' } });
});

test('40. prefer morning → 09:00(+15); prefer evening → 1순위 18:30 이후', () => {
  const s = fresh();
  const m = task(s, { title: NONE, estimateMinutes: 30, schedHints: { prefer: 'morning', source: 'user' } });
  const c = PL.suggestSlots(s, m.id, WED, { now: MON })[0];
  assert.equal(hm(c), '09:00');
  assert.equal(c.terms.prefer, 15);
  assert.ok(c.reasons.includes('오전에 하기 좋은 일이에요.'));
  const e = task(s, { title: NONE, estimateMinutes: 30, schedHints: { prefer: 'evening', source: 'user' } });
  const ce = PL.suggestSlots(s, e.id, WED, { now: MON })[0];
  assert.ok(ce.start >= L(7, 18, 30), hm(ce));
  assert.ok(ce.reasons.includes('저녁에 하기 좋은 일이에요.'));
});

test('41. 집중(deep) 60분, 10:00–11:00 블록 → 11:30 (앞뒤 15분 띄움)', () => {
  const s = fresh();
  const t = task(s, { title: NONE, estimateMinutes: 60, schedHints: { focus: 'deep', source: 'user' } });
  block(s, 7, 10, 0, 11, 0);
  const list = PL.suggestSlots(s, t.id, WED, { now: MON, limit: 100 });
  const c = list[0];
  assert.equal(hm(c), '11:30');
  assert.equal(c.score, 18);
  assert.equal(c.terms.deepBuffer, undefined);
  assert.ok(c.reasons.includes('집중이 필요한 일이라 이른 시간에 두었어요.'));
  const at = (h) => list.find((x) => hm(x) === h);
  assert.equal(at('11:45').score, 18);
  assert.equal(at('11:15').score, 14);
  assert.equal(at('11:00').score, 11);
  assert.equal(at('09:00').score, 17);
});

test('42. 가벼운 일(light) 30분, 10–11·11:30–12:30 블록 → 11:00 빈틈', () => {
  const s = fresh();
  const t = task(s, { title: NONE, estimateMinutes: 30, schedHints: { focus: 'light', source: 'user' } });
  block(s, 7, 10, 0, 11, 0);
  block(s, 7, 11, 30, 12, 30);
  const c = PL.suggestSlots(s, t.id, WED, { now: MON })[0];
  assert.equal(hm(c), '11:00');
  assert.ok(c.reasons.includes('빈 시간에 딱 맞아요.'));
  assert.equal(c.terms.lightGap, 4);
});

test('43. 기운(high)은 21:00 이후를 피하고, low 는 19:00 이후를 고른다', () => {
  const s = fresh();
  M.addBlock(s, { title: '회의', start: iso(7, 9, 0), end: iso(7, 18, 0) });
  const hi = task(s, { title: NONE, estimateMinutes: 30, schedHints: { energy: 'high', source: 'user' } });
  const lo = task(s, { title: NONE, estimateMinutes: 30, schedHints: { energy: 'low', source: 'user' } });
  const ch = PL.suggestSlots(s, hi.id, WED, { now: MON, limit: 100 });
  assert.ok(ch[0].start < L(7, 21), hm(ch[0]));
  ch.filter((c) => c.start >= L(7, 21)).forEach((c) => assert.equal(c.terms.energy, -8));
  const cl = PL.suggestSlots(s, lo.id, WED, { now: MON })[0];
  assert.ok(cl.start >= L(7, 19), hm(cl));
  assert.ok(cl.reasons.includes('가볍게 할 수 있는 저녁 시간이에요.'));
});

// ------------------------------------------------------------------ 마감·우선순위

test('44. 수 17:00, 마감 수 20:00 → 모든 후보가 20:00 전에 끝나고 1순위 18:30', () => {
  const now = L(7, 17, 0);
  const s = fresh();
  const t = task(s, { title: HOME, estimateMinutes: 30, dueDate: WED, dueTime: '20:00' }, now);
  const list = PL.suggestSlots(s, t.id, WED, { now, limit: 100 });
  assert.ok(list.length > 0);
  list.forEach((c) => assert.ok(c.end <= L(7, 20), hmE(c)));
  assert.equal(hm(list[0]), '18:30');
  assert.ok(list[0].reasons.length <= 3);
});

test('45. 마감(10/6) 뒤의 날 → after_due, 대안은 마감일부터 거꾸로; allowAfterDue 면 ok', () => {
  const s = fresh();
  const t = task(s, { title: HOME, estimateMinutes: 30, dueDate: '2026-10-06' });
  const r = PL.placeOnDay(s, t.id, WED, { now: MON });
  assert.equal(r.reason, 'after_due');
  assert.equal(r.message, '마감(10/6(화))보다 늦은 날이에요.');
  assert.equal(r.alternatives[0].ymd, '2026-10-06');
  assert.equal(hm(r.alternatives[0].candidate), '18:30');
  assert.equal(PL.placeOnDay(s, t.id, WED, { now: MON, allowAfterDue: true }).ok, true);
});

test('46. 마감 내일 → urgency 항과 이유, 30일 뒤 마감 → urgency 없음', () => {
  const s = fresh();
  const t = task(s, { title: HOME, estimateMinutes: 30, dueDate: '2026-10-08' });
  const c = PL.suggestSlots(s, t.id, WED, { now: MON })[0];
  assert.ok(c.terms.urgency > 0);
  assert.ok(c.reasons.some((x) => /^마감\(.+\)이 가까워 앞쪽 시간을 골랐어요\.$/.test(x)), c.reasons.join('|'));
  const far = task(s, { title: HOME, estimateMinutes: 30, dueDate: '2026-11-06' });
  PL.suggestSlots(s, far.id, WED, { now: MON, limit: 100 }).forEach((x) => assert.equal(x.terms.urgency, undefined));
});

test('47. dueTight: 끝이 마감 60분 전보다 늦은 후보는 −6', () => {
  const s = fresh();
  const t = task(s, { title: HOME, estimateMinutes: 30, dueDate: WED, dueTime: '20:00' });
  const list = PL.suggestSlots(s, t.id, WED, { now: MON, limit: 100 });
  list.forEach((c) => {
    if (c.end > L(7, 19)) assert.equal(c.terms.dueTight, -6, hm(c));
    else assert.equal(c.terms.dueTight, undefined, hm(c));
  });
  assert.ok(list.some((c) => c.terms.dueTight === -6));
});

test('48. 우선순위: high 는 앞쪽, low 는 늦을수록 점수가 크다', () => {
  const s = fresh();
  const hi = task(s, { title: NONE, estimateMinutes: 30, priority: 'high' });
  const no = task(s, { title: NONE, estimateMinutes: 30 });
  const lo = task(s, { title: NONE, estimateMinutes: 30, priority: 'low' });
  const ch = PL.suggestSlots(s, hi.id, WED, { now: MON })[0];
  const cn = PL.suggestSlots(s, no.id, WED, { now: MON })[0];
  assert.ok(ch.terms.priority > 0);
  assert.ok(ch.start <= cn.start);
  assert.ok(ch.reasons.includes('우선순위가 높아 앞쪽에 두었어요.'));
  const ll = PL.suggestSlots(s, lo.id, WED, { now: MON, limit: 100 }).slice().sort((a, b) => a.start - b.start);
  for (let i = 1; i < ll.length; i++) assert.ok((ll[i].terms.priority || 0) >= (ll[i - 1].terms.priority || 0));
  assert.ok(ll[ll.length - 1].terms.priority > (ll[0].terms.priority || 0));
});

// ------------------------------------------------------------------ 빈틈·인접·기록·다양성

test('49. 짧은 일(15분) + 30분 빈틈 → 그 빈틈 (shortSmall + fragTight)', () => {
  const s = fresh();
  const t = task(s, { title: NONE, estimateMinutes: 15 });
  block(s, 7, 9, 0, 10, 0);
  block(s, 7, 10, 30, 18, 0);
  const c = PL.suggestSlots(s, t.id, WED, { now: MON })[0];
  assert.equal(hm(c), '10:00');
  assert.equal(c.terms.shortSmall, 4);
  assert.equal(c.terms.fragTight, 6);
  assert.ok(c.reasons.includes('짧은 일이라 작은 빈틈에 넣었어요.'));
});

test('50. 같은 프로젝트 블록(19:00–20:00)과 이어지는 시간 → 이유', () => {
  const s = fresh();
  const p = M.addProject(s, { name: '온보딩 개선' }, MON);
  const other = task(s, { title: '화분 물 주기', estimateMinutes: 60, projectId: p.id });
  M.addBlock(s, { taskId: other.id, kind: 'work', start: iso(7, 19, 0), end: iso(7, 20, 0) });
  const t = task(s, { title: HOME, estimateMinutes: 30, projectId: p.id });
  const c = PL.suggestSlots(s, t.id, WED, { now: MON })[0];
  assert.equal(c.terms.project, 5);
  assert.ok(c.reasons.includes('같은 프로젝트 ‘온보딩 개선’ 일과 이어져요.'), c.reasons.join('|'));
  // 프로젝트가 없는 할 일은 그 항이 없다
  const solo = task(s, { title: HOME, estimateMinutes: 30 });
  PL.suggestSlots(s, solo.id, WED, { now: MON, limit: 100 }).forEach((x) => assert.equal(x.terms.project, undefined));
});

test('51. 기록: 지난 28일 20시대 집안일 블록 3개 → 20:00; 2개면 18:30; learning 끄면 18:30', () => {
  function build(n) {
    const s = fresh();
    for (let i = 0; i < n; i++) {
      const past = task(s, { title: '화분 물 주기', estimateMinutes: 30 });
      M.addBlock(s, { taskId: past.id, kind: 'work', start: iso(1 - i, 20, 0), end: iso(1 - i, 20, 30) });
    }
    return s;
  }
  const s3 = build(3);
  const t3 = task(s3, { title: HOME, estimateMinutes: 30 });
  const c3 = PL.suggestSlots(s3, t3.id, WED, { now: MON })[0];
  assert.equal(hm(c3), '20:00');
  assert.equal(c3.terms.history, 4);
  assert.ok(c3.reasons.includes('평소 이 시간대에 하던 일이에요.'));

  const s2 = build(2);
  const t2 = task(s2, { title: HOME, estimateMinutes: 30 });
  assert.equal(hm(PL.suggestSlots(s2, t2.id, WED, { now: MON })[0]), '18:30');

  const off = build(3);
  off.prefs.learning = false;
  const to = task(off, { title: HOME, estimateMinutes: 30 });
  const list = PL.suggestSlots(off, to.id, WED, { now: MON, limit: 100 });
  assert.equal(hm(list[0]), '18:30');
  list.forEach((c) => assert.equal(c.terms.history, undefined));
});

test('52. 다양성: limit 3 의 시작이 서로 60분 이상, 1순위는 그대로', () => {
  const s = fresh();
  const t = task(s, { title: NONE, estimateMinutes: 30 });
  const three = PL.suggestSlots(s, t.id, WED, { now: MON, limit: 3 });
  assert.equal(three.length, 3);
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
    assert.ok(Math.abs(three[i].start - three[j].start) >= 60 * 60000, hm(three[i]) + ' ' + hm(three[j]));
  }
  const all = PL.suggestSlots(s, t.id, WED, { now: MON, limit: 1000 });
  assert.deepEqual(three[0], all[0]);
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].score >= all[i].score);
});

test('53. 같은 점수면 이른 시작이 먼저', () => {
  const s = fresh();
  const t = task(s, { title: NONE, estimateMinutes: 30 });
  const list = PL.suggestSlots(s, t.id, WED, { now: MON, limit: 1000 });
  for (let i = 1; i < list.length; i++) {
    if (list[i - 1].score === list[i].score) assert.ok(list[i - 1].start < list[i].start);
  }
  assert.equal(list[0].score, list[1].score);
  assert.ok(list[0].start < list[1].start);
});

// ------------------------------------------------------------------ 나누기·가까운 날·하루 자동 배치

test('54. 나눌 수 있는 300분 집안일, 수 → too_long + 첫 조각 270분(18:30), 자동으로 넣지 않음', () => {
  const s = fresh();
  const t = task(s, { title: HOME, estimateMinutes: 300, schedHints: { splittable: true, source: 'user' } });
  const r = PL.placeOnDay(s, t.id, WED, { now: MON });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too_long');
  assert.ok(r.split);
  assert.equal(r.split.chunkMinutes, 270);
  assert.equal(r.split.restMinutes, 30);
  assert.equal(hm(r.split.first), '18:30');
  assert.equal(r.split.chunkMinutes % 15, 0);
  assert.ok(r.split.chunkMinutes >= 30 && r.split.chunkMinutes <= 270);
  assert.equal(r.split.first.minutes, 270);
});

test('55. splitPlan: deep 180분은 null, 힌트 없는 180분은 결과, splittable false 는 null', () => {
  const s = fresh();
  const deep = task(s, { title: NONE, estimateMinutes: 180, schedHints: { focus: 'deep', source: 'user' } });
  assert.equal(PL.splitPlan(s, deep.id, WED, { now: MON }), null);
  const plain = task(s, { title: NONE, estimateMinutes: 180 });
  const p = PL.splitPlan(s, plain.id, WED, { now: MON });
  assert.ok(p);
  assert.equal(p.chunkMinutes + p.restMinutes, 180);
  assert.equal(p.chunkMinutes, 150);
  const no = task(s, { title: NONE, estimateMinutes: 180, schedHints: { splittable: false, source: 'user' } });
  assert.equal(PL.splitPlan(s, no.id, WED, { now: MON }), null);
  const short = task(s, { title: NONE, estimateMinutes: 90 });
  assert.equal(PL.splitPlan(s, short.id, WED, { now: MON }), null);
});

test('56. nearestDay: 같은 거리면 이른 날, 마감 뒤·오늘 전은 건너뜀, 없으면 null', () => {
  const s = fresh();
  const w = task(s, { title: WORK, estimateMinutes: 60 });
  assert.equal(PL.nearestDay(s, w.id, '2026-10-11', { now: MON }).ymd, '2026-10-12');
  const h = task(s, { title: HOME, estimateMinutes: 30 });
  const n = PL.nearestDay(s, h.id, WED, { now: MON });
  assert.equal(n.ymd, '2026-10-06');
  assert.equal(hm(n.candidate), '18:30');
  const due = task(s, { title: HOME, estimateMinutes: 30, dueDate: '2026-10-06' });
  assert.equal(PL.nearestDay(s, due.id, '2026-10-08', { now: MON }).ymd, '2026-10-06');
  const thu = L(8, 10, 0);
  assert.equal(PL.nearestDay(s, h.id, '2026-10-08', { now: thu }).ymd, '2026-10-09');
  assert.equal(PL.nearestDay(s, h.id, WED, { now: MON, minutes: 1000 }), null);
  assert.equal(PL.nearestDay(s, 'nope', WED, { now: MON }), null);
});

test('57. remainingMinutes: 미래 블록·진행 중 블록을 빼고, estimate 없으면 null', () => {
  const s = fresh();
  const t = task(s, { title: HOME, estimateMinutes: 120 });
  M.addBlock(s, { taskId: t.id, kind: 'work', start: iso(7, 18, 30), end: iso(7, 19, 30) });
  M.addBlock(s, { taskId: t.id, kind: 'work', start: iso(2, 18, 30), end: iso(2, 19, 30) });   // 지난 블록은 빼지 않음
  assert.equal(PL.remainingMinutes(s, t, MON), 60);
  const r = task(s, { title: HOME, estimateMinutes: 120 });
  M.addBlock(s, { taskId: r.id, kind: 'work', start: iso(5, 9, 30), end: iso(5, 10, 30) });   // now 10:00 → 남은 30분
  assert.equal(PL.remainingMinutes(s, r, MON), 90);
  const big = task(s, { title: HOME, estimateMinutes: 30 });
  M.addBlock(s, { taskId: big.id, kind: 'work', start: iso(7, 9, 0), end: iso(7, 11, 0) });
  assert.equal(PL.remainingMinutes(s, big, MON), 0);
  assert.equal(PL.remainingMinutes(s, task(s, { title: HOME }), MON), null);
  // 남은 분이 있으면 그 길이로 찾는다
  assert.equal(PL.suggestSlots(s, t.id, WED, { now: MON })[0].minutes, 60);
});

test('58. arrangeDay: 순서·겹치지 않음·허용 창 안·건너뛰기 이유·maxTasks·순수·결정성', () => {
  const s = fresh();
  const lateTask = task(s, { title: NONE, estimateMinutes: 30, dueDate: '2026-10-02' });       // 마감 지남
  const high = task(s, { title: '이거 하기', estimateMinutes: 60, priority: 'high' });
  const plain = task(s, { title: HOME, estimateMinutes: 45 });
  const noEst = task(s, { title: HOME });
  const blocker = task(s, { title: '화분 물 주기' });
  const blocked = task(s, { title: HOME, estimateMinutes: 30, blockedBy: [blocker.id] });
  const snoozed = task(s, { title: HOME, estimateMinutes: 30, snoozedUntil: iso(9, 9, 0) });
  const huge = task(s, { title: HOME, estimateMinutes: 600 });
  const ids = [plain.id, huge.id, noEst.id, blocked.id, snoozed.id, high.id, lateTask.id];
  const before = JSON.stringify(s);
  const r = PL.arrangeDay(s, ids, WED, { now: MON });
  assert.equal(JSON.stringify(s), before);
  assert.deepEqual(r.placements.map((p) => p.taskId), [lateTask.id, high.id, plain.id]);
  assert.equal(r.minutes, 30 + 60 + 45);
  const reasons = {};
  r.skipped.forEach((x) => { reasons[x.taskId] = x.reason; });
  assert.deepEqual(reasons, { [noEst.id]: 'no_estimate', [blocked.id]: 'blocked', [snoozed.id]: 'snoozed', [huge.id]: 'no_slot' });
  // 서로 겹치지 않음 · 모두 허용 창 안
  const ps = r.placements;
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    assert.ok(!(ps[i].candidate.start < ps[j].candidate.end && ps[j].candidate.start < ps[i].candidate.end));
  }
  ps.forEach((p) => {
    const t = M.byId(s.tasks, p.taskId);
    const wins = PL.windowsFor(s, t, WED, { now: MON });
    assert.ok(wins.some((w) => w.start <= p.candidate.start && p.candidate.end <= w.end));
    assert.deepEqual(p.block, { taskId: p.taskId, kind: 'work', start: p.candidate.startIso, end: p.candidate.endIso });
  });
  // maxTasks
  const two = PL.arrangeDay(s, ids, WED, { now: MON, maxTasks: 2 });
  assert.equal(two.placements.length, 2);
  assert.ok(two.skipped.some((x) => x.taskId === plain.id && x.reason === 'limit'));
  // maxMinutes
  const cap = PL.arrangeDay(s, ids, WED, { now: MON, maxMinutes: 60 });
  assert.deepEqual(cap.placements.map((p) => p.taskId), [lateTask.id]);
  // 결정성
  assert.deepEqual(PL.arrangeDay(s, ids, WED, { now: MON }), r);
  assert.deepEqual(PL.arrangeDay(s, ids.slice().reverse(), WED, { now: MON }).placements, r.placements);
  // 지난 날 · 없는 할 일 · 끝낸 할 일
  const past = PL.arrangeDay(s, [plain.id], '2026-10-04', { now: MON });
  assert.deepEqual(past, { placements: [], skipped: [{ taskId: plain.id, reason: 'past' }], minutes: 0 });
  const gone = PL.arrangeDay(s, ['nope'], WED, { now: MON });
  assert.deepEqual(gone.skipped, [{ taskId: 'nope', reason: 'missing' }]);
});

test('58b. arrangeDay: 알맞지 않은(poor) 자리는 빼고, includePoor 면 넣는다', () => {
  const s = fresh();
  const t = task(s, { title: NONE, estimateMinutes: 30, atMode: 'rest', atModeSource: 'user' });
  const r = PL.arrangeDay(s, [t.id], WED, { now: MON });
  assert.deepEqual(r.skipped, [{ taskId: t.id, reason: 'poor_fit' }]);
  assert.equal(PL.arrangeDay(s, [t.id], WED, { now: MON, includePoor: true }).placements.length, 1);
  const w = task(s, { title: WORK, estimateMinutes: 60 });
  assert.deepEqual(PL.arrangeDay(s, [w.id], '2026-10-11', { now: MON }).skipped, [{ taskId: w.id, reason: 'no_window' }]);
});

test('59. arrangeDay: 두 번째 할 일은 첫 번째가 놓인 시간을 바쁨으로 본다', () => {
  const s = fresh();
  const a = task(s, { title: HOME, estimateMinutes: 30, priority: 'high' });
  const b = task(s, { title: '화분 물 주기', estimateMinutes: 30 });
  const r = PL.arrangeDay(s, [a.id, b.id], WED, { now: MON });
  assert.equal(r.placements.length, 2);
  assert.equal(hm(r.placements[0].candidate), '18:30');
  assert.ok(r.placements[1].candidate.start >= L(7, 19, 0), hm(r.placements[1].candidate));
});

test('60. 금 18:42, 업무 할 일 금요일 → 오늘은 이미 지남 + 10/12 09:00', () => {
  const s = fresh();
  const t = task(s, { title: WORK, estimateMinutes: 60 }, FRI);
  const r = PL.placeOnDay(s, t.id, '2026-10-09', { now: FRI });
  assert.equal(r.reason, 'no_window');
  assert.equal(r.message, '오늘은 이 일을 할 시간대가 이미 지났어요.');
  assert.equal(r.alternatives[0].ymd, '2026-10-12');
  assert.equal(hm(r.alternatives[0].candidate), '09:00');
});

test('61. 토 01:25, 집안일 토요일 → 09:00', () => {
  const s = fresh();
  const t = task(s, { title: HOME, estimateMinutes: 30 }, SAT);
  assert.equal(hm(PL.suggestSlots(s, t.id, '2026-10-10', { now: SAT })[0]), '09:00');
});

test('62. 점심: 업무 할 일, 09:00–12:00 바쁨 → 13:00 (12:00 아님)', () => {
  const s = fresh();
  const t = task(s, { title: WORK, estimateMinutes: 60 });
  block(s, 7, 9, 0, 12, 0);
  const c = PL.suggestSlots(s, t.id, WED, { now: MON })[0];
  assert.equal(hm(c), '13:00');
});

test('63. 늦은 밤: 집안일, 18:30–22:30 바쁨 → 22:30 · late', () => {
  const s = fresh();
  const t = task(s, { title: HOME, estimateMinutes: 30 });
  block(s, 7, 18, 30, 22, 30);
  const c = PL.suggestSlots(s, t.id, WED, { now: MON })[0];
  assert.equal(hm(c), '22:30');
  assert.equal(c.band, 'late');
});

test('64. fmtDay · fmtRange', () => {
  assert.equal(PL.fmtDay(L(5, 15), MON), '오늘');
  assert.equal(PL.fmtDay('2026-10-06', MON), '내일');
  assert.equal(PL.fmtDay(L(12), MON), '10/12(월)');
  assert.equal(PL.fmtDay('2026-10-12', MON), '10/12(월)');
  assert.equal(PL.fmtRange(L(7, 19, 30), L(7, 20, 0)), '19:30–20:00');
});

test('내보내기: 상수와 얼린 WEIGHTS', () => {
  assert.equal(PL.STEP_MIN, 15);
  assert.equal(PL.MIN_CHUNK, 30);
  assert.equal(PL.COMMUTE_MIN, 30);
  assert.equal(PL.EVENING_END, '22:30');
  assert.deepEqual(Array.from(PL.DAY_OFF_CORE), ['09:00', '21:00']);
  assert.ok(Object.isFrozen(PL.WEIGHTS));
  assert.deepEqual(Object.assign({}, PL.WEIGHTS.level), { up: 30, normal: 10, down: -20 });
});

// ------------------------------------------------------------------ 검증 추가분 (W1.5-planner 검증)

test('V1. no_slot 이유의 조사는 띠 라벨을 따른다 (업무 중(…)이 · 퇴근 후(…)가)', () => {
  const s = fresh();
  const t = task(s, { title: NONE, estimateMinutes: 30 });
  block(s, 7, 7, 0, 23, 0);
  const r = PL.placeOnDay(s, t.id, WED, { now: MON });
  assert.equal(r.reason, 'no_slot');
  // 맥락 없음 → 모든 띠가 보통, 가장 넓은 조각은 13:00–18:00 업무 띠
  assert.equal(r.detail, '업무 중(13:00–18:00)이 일정으로 차 있어요.');
});

test('V2. 마감 시각 때문에 자리가 없으면 detail 은 마감 문구', () => {
  const s = fresh();
  const t = task(s, { title: NONE, estimateMinutes: 30, dueDate: WED, dueTime: '10:00' });
  block(s, 7, 7, 0, 8, 30);
  block(s, 7, 9, 0, 10, 0);
  const r = PL.placeOnDay(s, t.id, WED, { now: MON });
  assert.equal(r.reason, 'no_slot');
  assert.equal(r.detail, '마감(10:00) 전에는 빈 시간이 없어요.');
  // 마감일 이후는 가까운 날에서도 빼므로 대안은 마감 전 날
  assert.equal(r.alternatives[0].ymd, '2026-10-06');
});

test('V3. 활성 + 메일에서 온 업무 짐작(hint) → 쉬는 날의 숨김이 내림으로 (poor)', () => {
  const s = activate(fresh());
  const t = task(s, { title: NONE, estimateMinutes: 60, sources: [{ type: 'email', excerpt: '' }] });
  const mode = PL.taskMode(s, t, { now: MON });
  assert.equal(mode.ctx, 'work');
  assert.equal(mode.ctxSource, 'hint');
  const r = PL.placeOnDay(s, t.id, '2026-10-10', { now: MON });
  assert.equal(r.ok, true);
  assert.equal(r.candidate.fit, 'poor');
  // 같은 맥락이라도 사용자가 정한 업무면 숨김 그대로
  const u = task(s, { title: NONE, estimateMinutes: 60, context: 'work', contextSource: 'user' });
  assert.equal(PL.placeOnDay(s, u.id, '2026-10-10', { now: MON }).reason, 'no_window');
});

test('V4. 띠 경계: 이른 출근(출근 전 띠 없음)·늦은 근무(퇴근 후 띠 없음)·점심 없음', () => {
  const s = fresh();
  const rowsFor = (wh, st) => bandRows(PL.dayBands(st || s, WED, { now: MON, workHours: wh }));
  assert.deepEqual(rowsFor({ start: '07:40', end: '16:00', days: [1, 2, 3, 4, 5] }).map((r) => r[0]),
    ['work', 'lunch', 'work', 'evening', 'late']);                          // 07:00–07:10 은 15분 미만
  assert.deepEqual(rowsFor({ start: '13:00', end: '22:00', days: [1, 2, 3, 4, 5] }), [
    ['morning', '07:00–12:30', 'off'],
    ['work', '13:00–22:00', 'work'],
    ['late', '22:30–23:00', 'off']
  ]);
  const noLunch = fresh();
  noLunch.prefs.statusProfile = { autoSchedule: { lunch: null } };
  assert.deepEqual(rowsFor(null, noLunch).map((r) => r[0]), ['morning', 'work', 'evening', 'late']);
  // 근무 시간을 opts 로만 줘도 상태 id 가 그 시간표를 따른다 (12:30 전 = 출근 전 → off)
  const on = activate(fresh());
  assert.deepEqual(rowsFor({ start: '13:00', end: '22:00', days: [1, 2, 3, 4, 5] }, on).map((r) => r[2]), ['off', 'work', 'off']);
});

test('V5. 오늘: 창은 15분 올린 지금에서 시작하고 조각도 잘린다, 지난 띠는 없다', () => {
  const s = fresh();
  const now = L(7, 12, 20);
  const t = task(s, { title: NONE, estimateMinutes: 30 }, now);
  const wins = PL.windowsFor(s, t, WED, { now });
  assert.equal(D.hm(wins[0].start), '12:30');
  assert.equal(wins[0].parts[0].band, 'lunch');
  assert.equal(D.hm(wins[0].parts[0].start), '12:30');
  assert.ok(wins.every((w) => w.parts.every((p) => p.start >= wins[0].start && p.start < p.end)));
  const list = PL.suggestSlots(s, t.id, WED, { now, limit: 100 });
  assert.ok(list.every((c) => c.start >= L(7, 12, 30)));
  // today 항 = 2 × earliness: 가장 이른 후보 2, 가장 늦은 후보 0(항 없음)
  const byStart = list.slice().sort((a, b) => a.start - b.start);
  assert.equal(byStart[0].terms.today, 2);
  assert.equal(byStart[byStart.length - 1].terms.today, undefined);
});

test('V6. 마감이 이미 지난 일은 막지 않고(after_due 없음) 앞쪽에 둔다', () => {
  const s = fresh();
  const t = task(s, { title: NONE, estimateMinutes: 30, dueDate: '2026-10-02', dueTime: '18:00' });
  const r = PL.placeOnDay(s, t.id, WED, { now: MON });
  assert.equal(r.ok, true);
  assert.equal(hm(r.candidate), '09:00');
  assert.ok(r.candidate.terms.urgency > 0);
  assert.equal(PL.nearestDay(s, t.id, WED, { now: MON }).ymd, '2026-10-06');
  // 오늘 마감인데 시각이 지났어도 같다
  const today = task(s, { title: NONE, estimateMinutes: 30, dueDate: '2026-10-05', dueTime: '09:00' });
  assert.equal(PL.placeOnDay(s, today.id, WED, { now: MON }).ok, true);
});

test('V7. 블록 옮기기(ignoreBlockId)는 그 블록의 길이를 지킨다 (opts.minutes 가 없을 때)', () => {
  const s = fresh();
  // 소요 시간 없이 넣은 블록 (팝오버에서 저장 끔)
  const a = task(s, { title: NONE });
  const ba = M.addBlock(s, { taskId: a.id, kind: 'work', start: iso(7, 18, 30), end: iso(7, 19, 15) });
  const la = PL.suggestSlots(s, a.id, WED, { now: MON, ignoreBlockId: ba.id });
  assert.ok(la.length > 0);
  la.forEach((c) => assert.equal(c.minutes, 45));
  // 나눠 넣은 첫 조각(90분 / 소요 120분)을 옮길 때도 90분
  const b = task(s, { title: NONE, estimateMinutes: 120 });
  const bb = M.addBlock(s, { taskId: b.id, kind: 'work', start: iso(8, 18, 30), end: iso(8, 20, 0) });
  assert.equal(PL.remainingMinutes(s, b, MON), 30);
  PL.suggestSlots(s, b.id, '2026-10-08', { now: MON, ignoreBlockId: bb.id }).forEach((c) => assert.equal(c.minutes, 90));
  assert.equal(PL.placeOnDay(s, b.id, '2026-10-08', { now: MON, ignoreBlockId: bb.id }).candidate.minutes, 90);
  // opts.minutes 가 이긴다 · 다른 할 일의 블록이면 평소 길이
  assert.equal(PL.suggestSlots(s, b.id, '2026-10-08', { now: MON, ignoreBlockId: bb.id, minutes: 60 })[0].minutes, 60);
  assert.equal(PL.suggestSlots(s, b.id, '2026-10-08', { now: MON, ignoreBlockId: ba.id })[0].minutes, 30);
});

test('V8. arrangeDay: 앞서 둔 블록으로 다시 매긴다 (같은 프로젝트 이어짐) · extraBusy 순서 무관', () => {
  const s = fresh();
  const p = M.addProject(s, { name: '이사 준비' }, MON);
  const a = task(s, { title: HOME, estimateMinutes: 60, priority: 'high', projectId: p.id });
  const b = task(s, { title: '화분 물 주기', estimateMinutes: 30, projectId: p.id });
  const r = PL.arrangeDay(s, [a.id, b.id], WED, { now: MON });
  assert.deepEqual(r.placements.map((x) => x.taskId), [a.id, b.id]);
  assert.equal(hm(r.placements[0].candidate), '18:30');
  assert.equal(hm(r.placements[1].candidate), '19:30');
  assert.equal(r.placements[1].candidate.terms.project, 5);
  assert.ok(r.placements[1].candidate.reasons.includes('같은 프로젝트 ‘이사 준비’ 일과 이어져요.'));
  const extra = [{ start: L(7, 18, 30).getTime(), end: L(7, 19, 0).getTime() }, { start: iso(7, 20, 0), end: iso(7, 21, 0) }];
  const one = PL.suggestSlots(s, b.id, WED, { now: MON, extraBusy: extra });
  assert.deepEqual(PL.suggestSlots(s, b.id, WED, { now: MON, extraBusy: extra.slice().reverse() }), one);
  one.forEach((c) => assert.ok(!(c.start < L(7, 19) && c.end > L(7, 18, 30)) && !(c.start < L(7, 21) && c.end > L(7, 20))));
});

test('V9. 활성 이유의 조사: ‘업무 중’이라 · ‘퇴근 후’라', () => {
  const s = activate(fresh());
  const w = task(s, { title: WORK, estimateMinutes: 60 });
  assert.equal(PL.placeOnDay(s, w.id, WED, { now: MON }).reasons[0], '‘업무 중’이라 ‘업무’ 하기 좋은 시간이에요.');
});

test('V10. 소스: ES5·벽시계 없음, 브라우저(window 만, status 없이)에서도 DN.planner', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'planner.js'), 'utf8');
  assert.ok(!/new Date\(\)|Date\.now/.test(src), '벽시계를 읽지 않는다');
  assert.ok(!/=>|\bconst\b|\blet\b|`|\bclass\b|\.\.\.|\?\.|\basync\b|\bawait\b/.test(src.replace(/\/\/.*$/gm, '')), 'ES5 문법');
  const vm = require('vm');
  const ctx = { window: {} };
  vm.createContext(ctx);
  ['dates.js', 'model.js', 'slots.js', 'planner.js'].forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'core', f), 'utf8'), ctx, { filename: f });
  });
  const P = ctx.window.Daynote.planner;
  assert.equal(typeof P.placeOnDay, 'function');
  const Mw = ctx.window.Daynote.model;
  const s = Mw.emptyState();
  const t = Mw.addTask(s, { title: HOME, estimateMinutes: 30 }, MON);
  // status 가 없으면 맥락 null → 모든 띠 보통 → 09:00
  const r = P.placeOnDay(s, t.id, WED, { now: MON });
  assert.equal(r.ok, true);
  assert.equal(r.candidate.startIso, L(7, 9, 0).toISOString());
  assert.equal(P.taskMode(s, t, { now: MON }).profile, null);
});
