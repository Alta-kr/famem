'use strict';
// Google 캘린더 동기화 코어 — src/core/gcal.js (GOOGLE §12.2 #1–14 · #19–35, IMPLEMENTATION_PLAN §3.9).
// 네트워크 없음. 시계는 고정(NOW = 2026-10-05 월 10:00). 되돌리기는 store 없이 "gcal 을 뺀 전체의 깊은 사본"을 되살려 흉내 낸다.
// #15–18(M.conflictsFor·M.calendarItems·recommend)은 model·recommend 테스트가 맡는다.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../src/core/dates');
const M = require('../src/core/model');
const G = require('../src/core/gcal');

const V4 = require('../src/core/model').SCHEMA_VERSION >= 4;                        // W1-model
const V4_SKIP = !V4 && 'W1-model 병합 전';

const NOW = new Date(2026, 9, 5, 10, 0);                 // 월요일
const CTX = { now: NOW, deviceId: 'dev-A', tz: 'Asia/Seoul', random: () => 0.5 };
const ctxAt = (date) => Object.assign({}, CTX, { now: date });
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).toISOString();     // 2026-10-d 현지 시각 → ISO
const plus = (ms) => new Date(NOW.getTime() + ms);
// UTC ISO → 같은 순간의 '+09:00' 표기 (Google 이 서울 캘린더에서 돌려주는 꼴)
const kst = (isoStr) => new Date(new Date(isoStr).getTime() + 9 * HOUR).toISOString().slice(0, 19) + '+09:00';

const PRIMARY = 'me@gmail.com';
const TEAM = 'team@group.calendar.google.com';
const DN = 'dncal@group.calendar.google.com';

function rawEv(id, start, end, extra) {
  return Object.assign({
    id, status: 'confirmed', etag: '"' + id + '-1"', updated: '2026-10-01T00:00:00.000Z', summary: '회의 ' + id,
    htmlLink: 'https://www.google.com/calendar/event?eid=' + id,
    start: { dateTime: start, timeZone: 'Asia/Seoul' }, end: { dateTime: end, timeZone: 'Asia/Seoul' }
  }, extra || {});
}

// primary(선택) + 팀(선택) 캘린더가 있는 상태
function stateWithCals() {
  const s = M.emptyState();
  G.ensure(s);
  G.mergeCalendarList(s, [
    { id: PRIMARY, summary: '내 캘린더', primary: true, backgroundColor: '#7986cb', accessRole: 'owner', timeZone: 'Asia/Seoul' },
    { id: TEAM, summary: '팀', backgroundColor: '#33b679', accessRole: 'reader', timeZone: 'Asia/Seoul' }
  ], CTX);
  G.setSelected(s, TEAM, true);
  return s;
}
let tok = 0;
function pull(s, calendarId, items, full, ctx = CTX) {
  const plan = G.planPull(s, calendarId, { ok: true, items, full, nextSyncToken: 'tok-' + (++tok), pages: 1, timeZone: 'Asia/Seoul' }, ctx);
  const r = G.applyPull(s, plan, ctx.now);
  return { plan, r };
}
const keysOf = (s, calendarId) => s.gcal.events.filter((e) => !calendarId || e.calendarId === calendarId).map((e) => e.eventId).sort();
const cal = (s, id) => s.gcal.calendars.find((c) => c.id === id);

// 내보내기 캘린더가 정해진 상태
function exportState() {
  const s = M.emptyState();
  G.ensure(s);
  s.gcal.exportCalendarId = DN;
  return s;
}
// 가짜 Google: 지금 보낼 op 를 모두 성공시킨다
function pushOk(s, ctx = CTX, etag = '"e1"') {
  const ops = G.dueOps(s, ctx, 25);
  const results = ops.map((op) => ({ opId: op.opId, ok: true, eventId: op.eventId, etag, updated: new Date(ctx.now).toISOString() }));
  const r = G.applyPushResults(s, ops, results, ctx);
  return { ops, r };
}
// Google 이 ‘Daynote’ 캘린더에서 돌려주는 모양 (설명 없음 — EVENT_FIELDS 에 없다, 시각은 +09:00)
function googleCopy(s, b, over) {
  const { body } = G.eventBody(s, b, CTX);
  const L = s.gcal.links[b.id];
  return Object.assign({
    id: L ? L.eventId : G.eventIdFor(b.id, 0), status: 'confirmed', etag: L ? L.etag : '"e1"', updated: NOW.toISOString(),
    summary: body.summary, location: body.location,
    start: { dateTime: kst(body.start.dateTime), timeZone: 'Asia/Seoul' }, end: { dateTime: kst(body.end.dateTime), timeZone: 'Asia/Seoul' },
    htmlLink: 'https://www.google.com/calendar/event?eid=x', extendedProperties: JSON.parse(JSON.stringify(body.extendedProperties))
  }, over || {});
}
function ownPull(s, items, full = false, ctx = CTX) {
  const plan = G.planOwnPull(s, { ok: true, items, full, nextSyncToken: 'own-' + (++tok), pages: 1, timeZone: 'Asia/Seoul' }, ctx);
  const r = G.applyOwnPull(s, plan, ctx);
  return { plan, r };
}
// 일정 블록 하나를 올리고 링크까지 맺은 상태
function linkedEvent(fields) {
  const s = exportState();
  const b = M.addBlock(s, Object.assign({ title: '치과', start: at(7, 10), end: at(7, 11) }, fields || {}));
  G.reconcile(s, CTX);
  pushOk(s);
  assert.ok(s.gcal.links[b.id], '링크가 맺어져야 한다');
  return { s, b };
}
// 되돌리기 흉내: gcal 을 뺀 전체의 깊은 사본을 찍고, 나중에 그것으로 되살린다 (gcal 은 지금 값 유지 — store.js KEEP_ON_UNDO)
function snapshotExceptGcal(s) {
  const copy = Object.assign({}, s);
  delete copy.gcal;
  return JSON.parse(JSON.stringify(copy));
}
function restoreExceptGcal(s, snap) {
  const gcal = s.gcal;
  Object.keys(s).forEach((k) => { delete s[k]; });
  Object.assign(s, JSON.parse(JSON.stringify(snap)), { gcal });
}
const clone = (x) => JSON.parse(JSON.stringify(x));

// ------------------------------------------------------------------ 모듈 계약
test('내보내는 이름이 계약(GOOGLE §8.1 + blockSyncState)과 같다', () => {
  const fns = ['emptyGcal', 'ensure', 'resetForAccount', 'mergeCalendarList', 'setSelected', 'disableExport',
    'windowFor', 'needsFullSync', 'pullRequest', 'eventKey', 'normalizeEvent', 'isBusy',
    'planPull', 'applyPull', 'applySeries', 'resetCalendar', 'prune',
    'eventIdFor', 'exportable', 'keepLinked', 'eventBody', 'remoteHash', 'reconcile', 'dueOps', 'applyPushResults', 'backoffMs',
    'planOwnPull', 'applyOwnPull', 'applyRemoteDeletes', 'summary', 'blockSyncState'];
  fns.forEach((f) => assert.equal(typeof G[f], 'function', f));
  assert.deepEqual(
    { WINDOW_PAST_DAYS: G.WINDOW_PAST_DAYS, WINDOW_FUTURE_DAYS: G.WINDOW_FUTURE_DAYS, RESYNC_DRIFT_DAYS: G.RESYNC_DRIFT_DAYS,
      FULL_SYNC_MAX_AGE_DAYS: G.FULL_SYNC_MAX_AGE_DAYS, EXPORT_PAST_HOURS: G.EXPORT_PAST_HOURS, LINK_KEEP_DAYS: G.LINK_KEEP_DAYS,
      MAX_ATTEMPTS: G.MAX_ATTEMPTS, MARKER: G.MARKER },
    { WINDOW_PAST_DAYS: 7, WINDOW_FUTURE_DAYS: 60, RESYNC_DRIFT_DAYS: 7, FULL_SYNC_MAX_AGE_DAYS: 7, EXPORT_PAST_HOURS: 24,
      LINK_KEEP_DAYS: 30, MAX_ATTEMPTS: 8, MARKER: 'daynote-export:v1' });
  assert.deepEqual(Object.keys(G).sort(), fns.concat(['WINDOW_PAST_DAYS', 'WINDOW_FUTURE_DAYS', 'RESYNC_DRIFT_DAYS', 'FULL_SYNC_MAX_AGE_DAYS',
    'EXPORT_PAST_HOURS', 'LINK_KEEP_DAYS', 'MAX_ATTEMPTS', 'MARKER']).sort());
});

test('G.emptyGcal() 은 M.emptyState().gcal 과 같다 (§2.1)', { skip: V4_SKIP }, () => {
  assert.deepEqual(G.emptyGcal(), M.emptyState().gcal);
  assert.notEqual(G.emptyGcal().settings, G.emptyGcal().settings);   // 매번 새 객체
});

test('ensure: 옛 상태(gcal 없음)에 조각을 만들고, 빠진 안쪽 값만 채우며 멱등이다', () => {
  const old = M.emptyState();
  delete old.gcal;
  const g = G.ensure(old);
  assert.equal(old.gcal, g);
  assert.deepEqual(g, G.emptyGcal());
  const s = { gcal: { accountId: 'a', settings: { exportWork: false }, events: null, links: [], calendars: [{ id: 'x' }] } };
  G.ensure(s);
  assert.deepEqual(s.gcal.settings, { exportWork: false, exportEnabled: true, exportTitles: true });
  assert.deepEqual(s.gcal.events, []);
  assert.deepEqual(s.gcal.links, {});
  assert.deepEqual(s.gcal.calendars, [{ id: 'x' }]);
  assert.equal(s.gcal.accountId, 'a');
  const before = clone(s.gcal);
  G.ensure(s);
  assert.deepEqual(s.gcal, before);
});

test('시계를 직접 읽지 않는다: now 없이 부르면 TypeError', () => {
  assert.throws(() => G.windowFor(), TypeError);
  assert.throws(() => G.reconcile(exportState(), { deviceId: 'x' }), TypeError);
  assert.throws(() => G.prune(exportState()), TypeError);
});

// ------------------------------------------------------------------ 정규화 (#1–5)
test('#1 normalizeEvent: +09:00 시각을 UTC 로 바꾸고 tz 를 보존한다', () => {
  const n = G.normalizeEvent({
    id: 'e1', status: 'confirmed', etag: '"1"', updated: '2026-10-01T00:00:00Z', summary: '팀 주간 회의', location: '3층 회의실',
    htmlLink: 'https://www.google.com/calendar/event?eid=e1',
    start: { dateTime: '2026-10-12T10:00:00+09:00', timeZone: 'Asia/Seoul' }, end: { dateTime: '2026-10-12T11:00:00+09:00', timeZone: 'Asia/Seoul' }
  }, { calendarId: PRIMARY, timeZone: 'Asia/Seoul' });
  assert.equal(n.start, '2026-10-12T01:00:00.000Z');
  assert.equal(n.end, '2026-10-12T02:00:00.000Z');
  assert.equal(n.tz, 'Asia/Seoul');
  assert.equal(n.key, 'g:' + PRIMARY + '|e1');
  assert.equal(n.key, G.eventKey(PRIMARY, 'e1'));
  assert.equal(n.calendarId, PRIMARY);
  assert.equal(n.title, '팀 주간 회의');
  assert.equal(n.location, '3층 회의실');
  assert.equal(n.updated, '2026-10-01T00:00:00.000Z');
  assert.equal(n.allDay, false);
  assert.equal(n.busy, true);
  assert.equal(n.status, 'confirmed');
  assert.equal(n.origin, 'google');
  assert.equal(n.daynoteId, null);
  assert.equal(n.recurringEventId, null);
  // 다른 시간대는 순간으로 저장하고 원래 시간대를 남긴다
  const ny = G.normalizeEvent(rawEv('ny', '2026-10-12T09:00:00-04:00', '2026-10-12T10:00:00-04:00',
    { start: { dateTime: '2026-10-12T09:00:00-04:00', timeZone: 'America/New_York' }, end: { dateTime: '2026-10-12T10:00:00-04:00' } }), { calendarId: PRIMARY, timeZone: 'Asia/Seoul' });
  assert.equal(ny.start, '2026-10-12T13:00:00.000Z');
  assert.equal(ny.tz, 'America/New_York');
  // 오프셋이 없는 비정상 값 + Asia/Seoul → +09:00
  const bare = G.normalizeEvent(rawEv('b', '2026-10-12T10:00:00', '2026-10-12T11:00:00'), { calendarId: PRIMARY });
  assert.equal(bare.start, '2026-10-12T01:00:00.000Z');
  // 제목 없음 · 300자에서 자름 · https 링크만
  const untitled = G.normalizeEvent(rawEv('u', at(6, 10), at(6, 11), { summary: '  ', htmlLink: 'javascript:alert(1)' }), { calendarId: PRIMARY });
  assert.equal(untitled.title, '(제목 없음)');
  assert.equal(untitled.htmlLink, null);
  assert.equal(G.normalizeEvent(rawEv('l', at(6, 10), at(6, 11), { summary: '가'.repeat(400) }), { calendarId: PRIMARY }).title.length, 300);
});

test('#2 종일 일정: startDate·endDate(배타), start 는 D.parseYmd(startDate) 의 ISO, 바쁨 아님', () => {
  const n = G.normalizeEvent({ id: 'a1', summary: '연차', start: { date: '2026-10-12' }, end: { date: '2026-10-14' } }, { calendarId: PRIMARY, timeZone: 'Asia/Seoul' });
  assert.equal(n.allDay, true);
  assert.equal(n.startDate, '2026-10-12');
  assert.equal(n.endDate, '2026-10-14');
  assert.equal(n.start, D.parseYmd('2026-10-12').toISOString());
  assert.equal(n.end, D.parseYmd('2026-10-14').toISOString());
  assert.equal(n.busy, false);
  assert.equal(G.isBusy(n), false);
  assert.equal(G.isBusy({ id: 'a1', start: { date: '2026-10-12' }, end: { date: '2026-10-13' } }), false);
});

test('#3 한가함(transparent)은 바쁨이 아니고, 거절·workingLocation·birthday 는 버린다(null)', () => {
  const ctx = { calendarId: PRIMARY };
  const free = G.normalizeEvent(rawEv('f', at(6, 10), at(6, 11), { transparency: 'transparent' }), ctx);
  assert.equal(free.busy, false);
  assert.equal(G.isBusy(rawEv('f', at(6, 10), at(6, 11), { transparency: 'transparent' })), false);
  assert.equal(G.normalizeEvent(rawEv('d', at(6, 10), at(6, 11), { attendees: [{ email: 'a@x', responseStatus: 'accepted' }, { self: true, responseStatus: 'declined' }] }), ctx), null);
  assert.equal(G.normalizeEvent(rawEv('w', at(6, 10), at(6, 11), { eventType: 'workingLocation' }), ctx), null);
  assert.equal(G.normalizeEvent(rawEv('b', at(6, 10), at(6, 11), { eventType: 'birthday' }), ctx), null);
  assert.equal(G.isBusy(rawEv('w', at(6, 10), at(6, 11), { eventType: 'workingLocation' })), false);
  assert.equal(G.isBusy(rawEv('ok', at(6, 10), at(6, 11), { eventType: 'focusTime' })), true);
  // 이미 저장된 것이 버리는 종류로 바뀌면 지운다
  const s = stateWithCals();
  pull(s, PRIMARY, [rawEv('d', at(6, 10), at(6, 11))], true);
  const { plan } = pull(s, PRIMARY, [rawEv('d', at(6, 10), at(6, 11), { attendees: [{ self: true, responseStatus: 'declined' }], updated: '2026-10-02T00:00:00Z' })], false);
  assert.deepEqual(plan.removeKeys, [G.eventKey(PRIMARY, 'd')]);
  assert.deepEqual(keysOf(s, PRIMARY), []);
});

test('#4 참석 미정·응답 전은 바쁨이고 투영에서 tentative:true', { skip: V4_SKIP }, () => {
  const s = stateWithCals();
  pull(s, PRIMARY, [
    rawEv('t1', at(6, 10), at(6, 11), { status: 'tentative' }),
    rawEv('t2', at(6, 12), at(6, 13), { attendees: [{ self: true, responseStatus: 'needsAction' }] }),
    rawEv('t3', at(6, 14), at(6, 15), { attendees: [{ self: true, responseStatus: 'accepted' }, { email: 'b@x', responseStatus: 'declined' }] })
  ], true);
  const byId = Object.fromEntries(s.gcal.events.map((e) => [e.eventId, e]));
  assert.equal(byId.t1.status, 'tentative');
  assert.equal(byId.t2.response, 'needsAction');
  assert.equal(byId.t3.response, 'accepted');
  const items = Object.fromEntries(M.externalItems(s).map((x) => [x.eventId, x]));
  assert.deepEqual([items.t1.busy, items.t1.tentative], [true, true]);
  assert.deepEqual([items.t2.busy, items.t2.tentative], [true, true]);
  assert.deepEqual([items.t3.busy, items.t3.tentative], [true, false]);
  assert.equal(items.t1.color, '#7986cb');
  assert.equal(items.t1.calendarName, '내 캘린더');
});

test('#5 id·status 만 있는 취소 항목은 묘비가 된다', () => {
  assert.deepEqual(G.normalizeEvent({ id: 'gone1', status: 'cancelled' }, { calendarId: PRIMARY }),
    { tombstone: true, calendarId: PRIMARY, eventId: 'gone1', recurringEventId: null });
  assert.deepEqual(G.normalizeEvent({ id: 's_1', status: 'cancelled', recurringEventId: 's' }, { calendarId: PRIMARY }),
    { tombstone: true, calendarId: PRIMARY, eventId: 's_1', recurringEventId: 's' });
  assert.equal(G.isBusy({ id: 'x', status: 'cancelled', start: { dateTime: at(6, 10) } }), false);
});

// ------------------------------------------------------------------ 시간 창·요청 (#6–7)
test('#6 pullRequest: 커서가 없으면 창(timeMin/timeMax), 있으면 syncToken 만 — orderBy 는 없다', () => {
  const w = G.windowFor(NOW);
  assert.equal(w.start, D.startOfDay(D.addDays(NOW, -7)).toISOString());
  assert.equal(w.end, D.startOfDay(D.addDays(NOW, 61)).toISOString());
  const first = G.pullRequest({ id: PRIMARY, syncToken: null }, NOW);
  assert.deepEqual(first, { calendarId: PRIMARY, timeMin: w.start, timeMax: w.end });
  const s = stateWithCals();
  pull(s, PRIMARY, [], true);
  const inc = G.pullRequest(cal(s, PRIMARY), NOW);
  assert.deepEqual(inc, { calendarId: PRIMARY, syncToken: cal(s, PRIMARY).syncToken });
  [first, inc].forEach((r) => assert.equal('orderBy' in r, false));
  assert.equal('timeMin' in inc, false);
});

test('#7 needsFullSync: 토큰 없음, 창이 7일 밀림, 전체 동기화 7일 지남', () => {
  const w = G.windowFor(NOW);
  assert.equal(G.needsFullSync({ id: 'c', syncToken: null }, NOW), true);
  // 창 밀림만 (전체 동기화는 최근)
  const drift = { id: 'c', syncToken: 't', windowStart: w.start, windowEnd: w.end, fullSyncAt: plus(6 * DAY).toISOString() };
  assert.equal(G.needsFullSync(drift, plus(6 * DAY)), false);
  assert.equal(G.needsFullSync(drift, plus(7 * DAY)), true);
  // 나이만 (창은 그때 기준으로 최신)
  const w7 = G.windowFor(plus(7 * DAY));
  const aged = { id: 'c', syncToken: 't', windowStart: w7.start, windowEnd: w7.end, fullSyncAt: NOW.toISOString() };
  assert.equal(G.needsFullSync(aged, plus(7 * DAY - MIN)), false);
  assert.equal(G.needsFullSync(aged, plus(7 * DAY)), true);
});

// ------------------------------------------------------------------ 가져오기 병합 (#8–14)
test('#8 전체 planPull: 응답에 없는 그 캘린더의 일정만 지우고 다른 캘린더는 그대로 둔다', () => {
  const s = stateWithCals();
  pull(s, PRIMARY, [rawEv('p1', at(6, 10), at(6, 11)), rawEv('p2', at(6, 12), at(6, 13))], true);
  pull(s, TEAM, [rawEv('t1', at(6, 10), at(6, 11))], true);
  const plan = G.planPull(s, PRIMARY, { ok: true, items: [rawEv('p1', at(6, 10), at(6, 11))], full: true, nextSyncToken: 'next' }, CTX);
  assert.equal(plan.full, true);
  assert.deepEqual(plan.removeKeys, [G.eventKey(PRIMARY, 'p2')]);
  assert.equal(plan.stats.removed, 1);
  assert.equal(plan.stats.seen, 1);
  assert.deepEqual(plan.cursor, { syncToken: 'next', windowStart: G.windowFor(NOW).start, windowEnd: G.windowFor(NOW).end, fullSyncAt: NOW.toISOString() });
  const r = G.applyPull(s, plan, NOW);
  assert.equal(r.changed, 1);
  assert.deepEqual(keysOf(s, PRIMARY), ['p1']);
  assert.deepEqual(keysOf(s, TEAM), ['t1']);
  assert.equal(cal(s, PRIMARY).syncToken, 'next');
  assert.equal(cal(s, PRIMARY).fullSyncAt, NOW.toISOString());
  assert.equal(cal(s, PRIMARY).lastSyncAt, NOW.toISOString());
});

test('#9 증분 upsert: 더 새로우면 바꾸고, 오래된 응답은 건너뛴다(skippedStale)', () => {
  const s = stateWithCals();
  pull(s, PRIMARY, [rawEv('p1', at(6, 10), at(6, 11), { summary: 'A', updated: '2026-10-02T00:00:00Z' })], true);
  const windowEnd = cal(s, PRIMARY).windowEnd;
  const newer = pull(s, PRIMARY, [rawEv('p1', at(6, 10), at(6, 11), { summary: 'B', updated: '2026-10-03T00:00:00Z' })], false, ctxAt(plus(HOUR)));
  assert.equal(newer.plan.full, false);
  assert.equal(newer.plan.upserts[0].title, 'B');
  assert.equal(newer.r.changed, 1);
  assert.equal(s.gcal.events[0].title, 'B');
  assert.equal(cal(s, PRIMARY).windowEnd, windowEnd);           // 증분은 창을 바꾸지 않는다
  assert.equal(cal(s, PRIMARY).syncToken, 'tok-' + tok);
  const stale = pull(s, PRIMARY, [rawEv('p1', at(6, 10), at(6, 11), { summary: 'C', updated: '2026-10-01T00:00:00Z' })], false);
  assert.equal(stale.plan.stats.skippedStale, 1);
  assert.deepEqual(stale.plan.upserts, []);
  assert.equal(stale.r.changed, 0);
  assert.equal(s.gcal.events[0].title, 'B');
  // 증분의 새 일정은 더한다
  const added = pull(s, PRIMARY, [rawEv('p9', at(8, 10), at(8, 11))], false);
  assert.equal(added.r.changed, 1);
  assert.deepEqual(keysOf(s, PRIMARY), ['p1', 'p9']);
});

test('#10 반복 인스턴스 묘비는 그 인스턴스만, 시리즈 id 묘비는 모든 인스턴스를 지운다', () => {
  const s = stateWithCals();
  pull(s, PRIMARY, [
    rawEv('s1_20261006', at(6, 9), at(6, 10), { recurringEventId: 's1' }),
    rawEv('s1_20261013', at(13, 9), at(13, 10), { recurringEventId: 's1' }),
    rawEv('s1_20261020', at(20, 9), at(20, 10), { recurringEventId: 's1' }),
    rawEv('x', at(6, 15), at(6, 16))
  ], true);
  const one = pull(s, PRIMARY, [{ id: 's1_20261006', status: 'cancelled', recurringEventId: 's1' }], false);
  assert.deepEqual(one.plan.removeKeys, [G.eventKey(PRIMARY, 's1_20261006')]);
  assert.deepEqual(one.plan.removeSeries, []);
  assert.deepEqual(keysOf(s, PRIMARY), ['s1_20261013', 's1_20261020', 'x']);
  const all = pull(s, PRIMARY, [{ id: 's1', status: 'cancelled' }], false);
  assert.deepEqual(all.plan.removeSeries, ['s1']);
  assert.equal(all.plan.stats.removed, 2);
  assert.equal(all.r.changed, 2);
  assert.deepEqual(keysOf(s, PRIMARY), ['x']);
});

test('#11 반복 인스턴스가 바뀌면 refetchSeries 에 들어가고 applySeries 가 창 안의 인스턴스를 통째로 바꾼다', () => {
  const s = stateWithCals();
  pull(s, PRIMARY, [
    rawEv('s2_a', at(6, 10), at(6, 11), { recurringEventId: 's2' }),
    rawEv('s2_b', at(13, 10), at(13, 11), { recurringEventId: 's2' }),
    rawEv('solo', at(7, 10), at(7, 11))
  ], true);
  const { plan } = pull(s, PRIMARY, [rawEv('s2_a', at(6, 11), at(6, 12), { recurringEventId: 's2', updated: '2026-10-04T00:00:00Z' })], false);
  assert.deepEqual(plan.refetchSeries, ['s2']);
  const r = G.applySeries(s, PRIMARY, 's2', [
    rawEv('s2_x', at(6, 11), at(6, 12), { recurringEventId: 's2' }),
    rawEv('s2_y', at(13, 11), at(13, 12)),                                            // recurringEventId 가 빠져도 시리즈로 묶는다
    rawEv('s2_far', new Date(2027, 2, 1, 11).toISOString(), new Date(2027, 2, 1, 12).toISOString(), { recurringEventId: 's2' })
  ], CTX);
  assert.ok(r.changed > 0);
  assert.deepEqual(keysOf(s, PRIMARY), ['s2_x', 's2_y', 'solo']);
  assert.ok(s.gcal.events.filter((e) => e.eventId !== 'solo').every((e) => e.recurringEventId === 's2'));
  // 같은 결과를 다시 넣으면 변화 없음
  assert.equal(G.applySeries(s, PRIMARY, 's2', [
    rawEv('s2_x', at(6, 11), at(6, 12), { recurringEventId: 's2' }), rawEv('s2_y', at(13, 11), at(13, 12), { recurringEventId: 's2' })
  ], CTX).changed, 0);
  // 전체 동기화에서는 시리즈를 다시 받지 않는다
  assert.deepEqual(pull(s, PRIMARY, [rawEv('s2_x', at(6, 11), at(6, 12), { recurringEventId: 's2' })], true).plan.refetchSeries, []);
});

test('#12 증분 결과 중 창 밖 항목은 넣지 않고, 같은 키가 있으면 지운다', () => {
  const s = stateWithCals();
  pull(s, PRIMARY, [rawEv('p1', at(6, 10), at(6, 11))], true);
  const far = new Date(2027, 0, 10, 10).toISOString(), farEnd = new Date(2027, 0, 10, 11).toISOString();
  const old = new Date(2026, 8, 1, 10).toISOString(), oldEnd = new Date(2026, 8, 1, 11).toISOString();
  const { plan, r } = pull(s, PRIMARY, [
    rawEv('p1', far, farEnd, { updated: '2026-10-03T00:00:00Z' }),
    rawEv('farnew', far, farEnd),
    rawEv('oldnew', old, oldEnd)
  ], false);
  assert.equal(plan.stats.outOfWindow, 3);
  assert.deepEqual(plan.upserts, []);
  assert.deepEqual(plan.removeKeys, [G.eventKey(PRIMARY, 'p1')]);
  assert.equal(r.changed, 1);
  assert.deepEqual(keysOf(s, PRIMARY), []);
});

test('#13 resetCalendar(410) 뒤에는 pullRequest 가 전체 동기화 요청을 만든다', () => {
  const s = stateWithCals();
  pull(s, PRIMARY, [rawEv('p1', at(6, 10), at(6, 11)), rawEv('p2', at(6, 12), at(6, 13))], true);
  pull(s, TEAM, [rawEv('t1', at(6, 10), at(6, 11))], true);
  assert.ok(G.pullRequest(cal(s, PRIMARY), NOW).syncToken);
  assert.deepEqual(G.resetCalendar(s, PRIMARY), { removed: 2 });
  assert.equal(cal(s, PRIMARY).syncToken, null);
  assert.equal(cal(s, PRIMARY).selected, true);
  assert.deepEqual(keysOf(s), ['t1']);
  const w = G.windowFor(NOW);
  assert.deepEqual(G.pullRequest(cal(s, PRIMARY), NOW), { calendarId: PRIMARY, timeMin: w.start, timeMax: w.end });
});

test('#14 prune: 창 시작보다 먼저 끝난 일정과 30일 지난 링크를 정리한다', () => {
  const s = stateWithCals();
  const ctx = { calendarId: PRIMARY };
  s.gcal.events.push(
    G.normalizeEvent(rawEv('old', new Date(2026, 8, 20, 10).toISOString(), new Date(2026, 8, 20, 11).toISOString()), ctx),
    G.normalizeEvent(rawEv('edge', new Date(2026, 8, 27, 23).toISOString(), new Date(2026, 8, 28, 1).toISOString()), ctx),
    G.normalizeEvent(rawEv('now', at(5, 9), at(5, 10)), ctx));
  s.gcal.links.b_old = { eventId: 'e_old', calendarId: DN, gen: 0, etag: '"1"', hash: 'x', end: plus(-31 * DAY).toISOString() };
  s.gcal.links.b_mid = { eventId: 'e_mid', calendarId: DN, gen: 0, etag: '"1"', hash: 'x', end: plus(-29 * DAY).toISOString() };
  assert.deepEqual(G.prune(s, NOW), { removed: 1, linksDropped: 1 });
  assert.deepEqual(keysOf(s), ['edge', 'now']);
  assert.deepEqual(Object.keys(s.gcal.links), ['b_mid']);
  assert.deepEqual(G.prune(s, NOW), { removed: 0, linksDropped: 0 });
});

test('applyPull: 그 사이 가져오기를 끈 캘린더의 계획은 반영하지 않는다', () => {
  const s = stateWithCals();
  const plan = G.planPull(s, TEAM, { ok: true, items: [rawEv('t1', at(6, 10), at(6, 11))], full: true, nextSyncToken: 'n' }, CTX);
  assert.deepEqual(G.setSelected(s, TEAM, false), { removed: 0 });
  assert.deepEqual(G.applyPull(s, plan, NOW), { changed: 0 });
  assert.deepEqual(keysOf(s, TEAM), []);
  assert.equal(cal(s, TEAM).syncToken, null);
  // 다시 켜면 커서 없이(전체 동기화) 시작하고, 끄면 그 캘린더 일정과 커서를 지운다
  G.setSelected(s, TEAM, true);
  assert.ok(G.pullRequest(cal(s, TEAM), NOW).timeMin);
  pull(s, TEAM, [rawEv('t1', at(6, 10), at(6, 11))], true);
  assert.deepEqual(keysOf(s, TEAM), ['t1']);
  assert.ok(G.pullRequest(cal(s, TEAM), NOW).syncToken);
  assert.deepEqual(G.setSelected(s, TEAM, false), { removed: 1 });
  assert.equal(cal(s, TEAM).syncToken, null);
  G.setSelected(s, TEAM, true);
  assert.ok(G.pullRequest(cal(s, TEAM), NOW).timeMin);
});

// ------------------------------------------------------------------ 내보내기 (#19–29)
test('#19 eventIdFor: base32hex 문자만, 길이 5~1024, 같은 입력이면 같고 gen 이 다르면 다르다', () => {
  const ids = [G.eventIdFor('blk_lx9a2b3c4', 0), G.eventIdFor('blk_lx9a2b3c4', 1), G.eventIdFor('blk_lx9a2b3c4', 2),
    G.eventIdFor('blk_lx9a2b3c4', 40), G.eventIdFor('블록_한글', 0), G.eventIdFor('blk_' + 'z'.repeat(500), 3)];
  ids.forEach((id) => {
    assert.match(id, /^[a-v0-9]+$/);
    assert.ok(id.length >= 5 && id.length <= 1024, id.length);
  });
  assert.equal(G.eventIdFor('blk_lx9a2b3c4', 0), G.eventIdFor('blk_lx9a2b3c4'));
  assert.equal(G.eventIdFor('blk_lx9a2b3c4', 1), G.eventIdFor('blk_lx9a2b3c4', 1));
  assert.equal(new Set(ids.slice(0, 4)).size, 4);
  assert.notEqual(G.eventIdFor('blk_a', 0), G.eventIdFor('blk_b', 0));
  assert.equal(G.eventIdFor('blk_lx9a2b3c4', 0), 'dn' + Buffer.from('blk_lx9a2b3c4', 'utf8').toString('hex'));
  assert.equal(G.eventIdFor('블록_한글', 0), 'dn' + Buffer.from('블록_한글', 'utf8').toString('hex'));
});

test('#20 exportable: 샘플·timeUncertain·삭제된 할 일의 작업·24시간 전에 끝난 블록은 빼고, exportWork:false 면 작업 블록을 뺀다', () => {
  const s = exportState();
  const t = M.addTask(s, { title: '견적서 작성' }, NOW);
  const gone = M.addTask(s, { title: '지운 할 일' }, NOW);
  const ev = M.addBlock(s, { title: '치과', start: at(6, 10), end: at(6, 11) });
  const work = M.addBlock(s, { taskId: t.id, start: at(6, 14), end: at(6, 15) });
  const sample = M.addBlock(s, { title: '샘플 회의', start: at(6, 9), end: at(6, 10), sample: true });
  const unsure = M.addBlock(s, { title: '시각 미정', start: at(6, 9), end: at(6, 10), timeUncertain: true });
  const old = M.addBlock(s, { title: '지난 일정', start: at(4, 8), end: at(4, 9) });          // 25시간 전에 끝남
  const recent = M.addBlock(s, { title: '어제 일정', start: at(4, 10), end: at(4, 11) });     // 23시간 전에 끝남
  const orphanWork = M.addBlock(s, { taskId: gone.id, start: at(6, 16), end: at(6, 17) });
  gone.deletedAt = NOW.toISOString();
  const ex = (b) => G.exportable(s, b, CTX);
  assert.deepEqual([ev, work, sample, unsure, old, recent, orphanWork].map(ex), [true, true, false, false, false, true, false]);
  assert.equal(G.keepLinked(s, old, CTX), true);                  // 시간 조건만 뺀다
  assert.equal(G.keepLinked(s, orphanWork, CTX), false);
  assert.equal(G.keepLinked(s, unsure, CTX), false);
  s.gcal.settings.exportWork = false;
  assert.equal(ex(work), false);
  assert.equal(G.keepLinked(s, work, CTX), false);
  assert.equal(ex(ev), true);
  s.gcal.settings.exportEnabled = false;
  assert.equal(ex(ev), false);
});

test('#21 eventBody: 본문 모양 · exportTitles:false 면 바쁨/집중 작업 · daynoteId 표식 · 밀리초만 다른 시각은 같은 해시', () => {
  const s = exportState();
  const t = M.addTask(s, { title: '견적서 작성' }, NOW);
  const ev = M.addBlock(s, { title: '치과', start: at(6, 10), end: at(6, 11), location: '강남역' });
  const work = M.addBlock(s, { taskId: t.id, title: '옛 제목', start: at(6, 14), end: at(6, 15) });
  const { body, hash } = G.eventBody(s, ev, CTX);
  assert.deepEqual(body, {
    summary: '치과', description: 'Daynote 일정', location: '강남역',
    start: { dateTime: new Date(at(6, 10)).toISOString().slice(0, 19) + 'Z', timeZone: 'Asia/Seoul' },
    end: { dateTime: new Date(at(6, 11)).toISOString().slice(0, 19) + 'Z', timeZone: 'Asia/Seoul' },
    transparency: 'opaque', reminders: { useDefault: false },
    extendedProperties: { private: { daynoteId: ev.id, daynoteKind: 'event', daynoteDevice: 'dev-A', daynoteV: '1' } }
  });
  assert.match(hash, /^[0-9a-f]{8}$/);
  const w = G.eventBody(s, work, CTX).body;
  assert.equal(w.summary, '견적서 작성');                       // 할 일의 지금 제목
  assert.equal(w.description, 'Daynote 작업 시간');
  assert.equal('location' in w, false);
  assert.equal(w.extendedProperties.private.daynoteKind, 'work');
  M.updateTask(s, t.id, { title: '견적서 보내기' }, NOW);
  assert.equal(G.eventBody(s, work, CTX).body.summary, '견적서 보내기');
  // 제목 숨기기
  s.gcal.settings.exportTitles = false;
  const hidden = G.eventBody(s, ev, CTX).body;
  assert.equal(hidden.summary, '바쁨');
  assert.equal('location' in hidden, false);
  assert.equal(G.eventBody(s, work, CTX).body.summary, '집중 작업');
  assert.notEqual(G.eventBody(s, ev, CTX).hash, hash);
  s.gcal.settings.exportTitles = true;
  // 밀리초만 다르면 같은 해시
  const ms1 = M.addBlock(s, { title: 'x', start: '2026-10-06T01:00:00.000Z', end: '2026-10-06T02:00:00.000Z' });
  const ms2 = M.addBlock(s, { title: 'x', start: '2026-10-06T01:00:00.400Z', end: '2026-10-06T02:00:00.999Z' });
  assert.equal(G.eventBody(s, ms1, CTX).hash, G.eventBody(s, ms2, CTX).hash);
  // 기기·시간대는 해시에 들어가지 않는다
  assert.equal(G.eventBody(s, ev, Object.assign({}, CTX, { deviceId: 'dev-B', tz: 'UTC' })).hash, hash);
});

test('#22 remoteHash(Google 원본) 은 eventBody(같은 블록).hash 와 같다 — +09:00 과 Z 표기 차이도 같게 본다', () => {
  const s = exportState();
  const t = M.addTask(s, { title: '견적서 작성' }, NOW);
  const ev = M.addBlock(s, { title: '치과', start: at(6, 10), end: at(6, 11), location: '강남역' });
  const work = M.addBlock(s, { taskId: t.id, start: at(6, 14), end: at(6, 15) });
  [ev, work].forEach((b) => {
    const { body, hash } = G.eventBody(s, b, CTX);
    const raw = googleCopy(s, b);
    assert.equal(raw.start.dateTime.endsWith('+09:00'), true);
    assert.equal(G.remoteHash(raw), hash);
    const z = googleCopy(s, b, { start: { dateTime: body.start.dateTime }, end: { dateTime: new Date(body.end.dateTime).toISOString() }, transparency: 'opaque' });
    assert.equal(G.remoteHash(z), hash);
    assert.notEqual(G.remoteHash(googleCopy(s, b, { summary: '다른 제목' })), hash);
  });
});

test('#23 reconcile: 새 블록 insert, 바뀐 블록 patch, 지운 블록 delete, 그대로이면 op 없음 — 두 번 불러도 같다', () => {
  const s = exportState();
  const t = M.addTask(s, { title: '견적서 작성' }, NOW);
  const ev = M.addBlock(s, { title: '치과', start: at(6, 10), end: at(6, 11) });
  const work = M.addBlock(s, { taskId: t.id, start: at(6, 14), end: at(6, 15) });
  const r1 = G.reconcile(s, CTX);
  assert.deepEqual(r1.inserts, [ev.id, work.id]);
  assert.deepEqual([r1.patches, r1.deletes, r1.unlinked], [[], [], []]);
  assert.deepEqual(s.gcal.outbox.map((e) => [e.id, e.op, e.calendarId, e.attempts, e.nextAt]),
    [['op:' + ev.id, 'insert', DN, 0, null], ['op:' + work.id, 'insert', DN, 0, null]]);
  const box = clone(s.gcal.outbox);
  const r2 = G.reconcile(s, CTX);
  assert.deepEqual(r2.inserts, r1.inserts);
  assert.equal(r2.changed, 0);
  assert.deepEqual(s.gcal.outbox, box);
  pushOk(s);
  assert.deepEqual(s.gcal.outbox, []);
  const quiet = G.reconcile(s, CTX);
  assert.deepEqual([quiet.inserts, quiet.patches, quiet.deletes], [[], [], []]);
  assert.deepEqual(s.gcal.outbox, []);
  M.updateBlock(s, ev.id, { title: '치과 예약' });
  M.deleteBlock(s, work.id);
  const r3 = G.reconcile(s, CTX);
  assert.deepEqual(r3.patches, [ev.id]);
  assert.deepEqual(r3.deletes, [work.id]);
  assert.deepEqual(s.gcal.outbox.map((e) => [e.op, e.eventId]),
    [['patch', s.gcal.links[ev.id].eventId], ['delete', s.gcal.links[work.id].eventId]]);
  const box3 = clone(s.gcal.outbox);
  G.reconcile(s, CTX);
  assert.deepEqual(s.gcal.outbox, box3);
  // 내보내기 캘린더가 아직 없으면 insert 를 만들지 않는다
  const s2 = exportState();
  s2.gcal.exportCalendarId = null;
  M.addBlock(s2, { title: 'x', start: at(6, 10), end: at(6, 11) });
  assert.deepEqual(G.reconcile(s2, CTX).inserts, []);
});

test('#24 합치기: insert 대기 중에 지우면 항목이 사라지고, patch 대기 중에 지우면 delete 로 바뀌며 nextAt 이 유지된다', () => {
  const s = exportState();
  const a = M.addBlock(s, { title: 'A', start: at(6, 10), end: at(6, 11) });
  G.reconcile(s, CTX);
  M.deleteBlock(s, a.id);
  G.reconcile(s, CTX);
  assert.deepEqual(s.gcal.outbox, []);

  const { s: s2, b } = linkedEvent();
  M.updateBlock(s2, b.id, { title: '치과 예약' });
  G.reconcile(s2, CTX);
  const entry = s2.gcal.outbox[0];
  assert.equal(entry.op, 'patch');
  entry.attempts = 2;
  entry.nextAt = plus(5 * MIN).toISOString();
  M.deleteBlock(s2, b.id);
  G.reconcile(s2, CTX);
  assert.equal(s2.gcal.outbox.length, 1);
  assert.equal(s2.gcal.outbox[0].op, 'delete');
  assert.equal(s2.gcal.outbox[0].nextAt, plus(5 * MIN).toISOString());
  assert.equal(s2.gcal.outbox[0].attempts, 0);
  assert.equal(s2.gcal.outbox[0].eventId, s2.gcal.links[b.id].eventId);
});

test('#25 되돌리기: 블록 추가 → insert 성공(링크) → 되돌리기로 블록이 사라지고 gcal 은 유지 → reconcile 이 delete 를 낸다', () => {
  const s = exportState();
  const snap = snapshotExceptGcal(s);                 // 라벨 있는 mutate 직전 스냅숏 (gcal 제외)
  const b = M.addBlock(s, { title: '치과', start: at(6, 10), end: at(6, 11) });
  G.reconcile(s, CTX);
  pushOk(s);
  const L = s.gcal.links[b.id];
  assert.ok(L);
  restoreExceptGcal(s, snap);
  assert.equal(s.blocks.length, 0);
  assert.equal(s.gcal.links[b.id], L);                // 링크는 남는다
  const r = G.reconcile(s, CTX);
  assert.deepEqual(r.deletes, [b.id]);
  const ops = G.dueOps(s, CTX);
  assert.deepEqual(ops.map((o) => [o.op, o.eventId, o.calendarId, o.body]), [['delete', L.eventId, DN, null]]);
  G.applyPushResults(s, ops, [{ opId: ops[0].opId, ok: true }], CTX);
  assert.deepEqual(s.gcal.links, {});
  assert.deepEqual(s.gcal.outbox, []);
});

test('#26 applyPushResults insert: 링크의 hash 는 보낸 본문의 해시 — 보낸 뒤 블록이 또 바뀌면 다음 reconcile 이 patch 를 낸다', () => {
  const s = exportState();
  const b = M.addBlock(s, { title: '치과', start: at(6, 10), end: at(6, 11) });
  G.reconcile(s, CTX);
  const ops = G.dueOps(s, CTX);
  assert.deepEqual(ops.map((o) => [o.opId, o.op, o.calendarId, o.eventId, o.daynoteId, o.gen]),
    [['op:' + b.id, 'insert', DN, G.eventIdFor(b.id, 0), b.id, 0]]);
  assert.deepEqual(ops[0].body, G.eventBody(s, b, CTX).body);
  M.updateBlock(s, b.id, { title: '치과 (보낸 뒤 바꿈)' });       // 보내는 사이에 바뀜
  const r = G.applyPushResults(s, ops, [{ opId: ops[0].opId, ok: true, eventId: ops[0].eventId, etag: '"e1"', updated: '2026-10-05T01:00:01.000Z' }], CTX);
  assert.deepEqual(r, { done: 1, failed: 0, backoffUntil: null, exportError: null });
  assert.deepEqual(s.gcal.links[b.id], {
    eventId: ops[0].eventId, calendarId: DN, gen: 0, etag: '"e1"', remoteUpdated: '2026-10-05T01:00:01.000Z',
    hash: ops[0].hash, end: b.end, pushedAt: NOW.toISOString()
  });
  assert.notEqual(s.gcal.links[b.id].hash, G.eventBody(s, b, CTX).hash);
  assert.deepEqual(s.gcal.outbox, []);
  assert.deepEqual(G.reconcile(s, CTX).patches, [b.id]);
  const patch = G.dueOps(s, CTX);
  assert.equal(patch[0].op, 'patch');
  assert.equal(patch[0].body.summary, '치과 (보낸 뒤 바꿈)');
  G.applyPushResults(s, patch, [{ opId: patch[0].opId, ok: true, eventId: patch[0].eventId, etag: '"e2"' }], CTX);
  assert.equal(s.gcal.links[b.id].etag, '"e2"');
  assert.equal(s.gcal.links[b.id].hash, G.eventBody(s, b, CTX).hash);
  assert.deepEqual(G.reconcile(s, CTX).patches, []);
});

test('#27 409 adopted 면 링크를 맺고, id_taken 이면 gens+1 이 되어 다음 dueOps 의 eventId 가 다르다', () => {
  const s = exportState();
  const a = M.addBlock(s, { title: 'A', start: at(6, 10), end: at(6, 11) });
  const b = M.addBlock(s, { title: 'B', start: at(6, 12), end: at(6, 13) });
  G.reconcile(s, CTX);
  const ops = G.dueOps(s, CTX);
  const r = G.applyPushResults(s, ops, [
    { opId: 'op:' + a.id, ok: true, eventId: G.eventIdFor(a.id, 0), etag: '"g1"', updated: NOW.toISOString(), adopted: true },
    { opId: 'op:' + b.id, ok: false, error: { type: 'id_taken', status: 409, retryable: false, message: '이미 쓴 id' } }
  ], CTX);
  assert.equal(r.done, 1);
  assert.equal(r.failed, 0);
  assert.equal(s.gcal.links[a.id].eventId, G.eventIdFor(a.id, 0));
  assert.equal(s.gcal.links[b.id], undefined);
  assert.equal(s.gcal.gens[b.id], 1);
  const entry = s.gcal.outbox.find((e) => e.id === 'op:' + b.id);
  assert.equal(entry.op, 'insert');
  assert.equal(entry.nextAt, NOW.toISOString());       // 바로 다시
  const again = G.dueOps(s, CTX);
  assert.equal(again.length, 1);
  assert.equal(again[0].gen, 1);
  assert.equal(again[0].eventId, G.eventIdFor(b.id, 1));
  assert.notEqual(again[0].eventId, ops.find((o) => o.daynoteId === b.id).eventId);
  G.applyPushResults(s, again, [{ opId: again[0].opId, ok: true, eventId: again[0].eventId, etag: '"g2"' }], CTX);
  assert.equal(s.gcal.links[b.id].gen, 1);
});

test('#28 patch 에 404/410 이면 링크를 지우고 gen+1 을 한 뒤 insert 한다', () => {
  ['gone', 'not_found'].forEach((type) => {
    const { s, b } = linkedEvent();
    M.updateBlock(s, b.id, { title: '치과 예약' });
    G.reconcile(s, CTX);
    const ops = G.dueOps(s, CTX);
    assert.equal(ops[0].op, 'patch');
    const r = G.applyPushResults(s, ops, [{ opId: ops[0].opId, ok: false, error: { type, status: 410, retryable: false } }], CTX);
    assert.equal(r.failed, 0);
    assert.equal(s.gcal.links[b.id], undefined);
    assert.equal(s.gcal.gens[b.id], 1);
    assert.deepEqual(s.gcal.outbox.map((e) => [e.op, e.attempts, e.lastError]), [['insert', 0, null]]);
    G.reconcile(s, CTX);
    const next = G.dueOps(s, CTX);
    assert.deepEqual(next.map((o) => [o.op, o.eventId, o.gen]), [['insert', G.eventIdFor(b.id, 1), 1]]);
  });
});

test('#29 rate_limit 은 backoffUntil · network 는 attempts·nextAt · backoffMs 지터와 30분 상한 · 8회가 넘어도 남는다', () => {
  // rate_limit
  const s = exportState();
  M.addBlock(s, { title: 'A', start: at(6, 10), end: at(6, 11) });
  M.addBlock(s, { title: 'B', start: at(6, 12), end: at(6, 13) });
  G.reconcile(s, CTX);
  let ops = G.dueOps(s, CTX);
  let r = G.applyPushResults(s, ops, [{ opId: ops[0].opId, ok: false, error: { type: 'rate_limit', status: 429, retryable: true, retryAfterMs: 120000 } }], CTX);
  assert.equal(r.backoffUntil, plus(120000).toISOString());
  assert.equal(s.gcal.backoffUntil, plus(120000).toISOString());
  assert.deepEqual(G.dueOps(s, CTX), []);
  assert.deepEqual(G.dueOps(s, ctxAt(plus(119000))), []);
  assert.equal(G.dueOps(s, ctxAt(plus(120000))).length, 2);
  assert.equal(s.gcal.outbox.every((e) => e.lastError === null), true);   // 항목 탓이 아니다
  // quota: retryAfterMs(1시간)
  r = G.applyPushResults(s, ops, { ok: false, error: { type: 'quota', retryAfterMs: HOUR } }, CTX);
  assert.equal(r.backoffUntil, plus(HOUR).toISOString());

  // network
  const n = exportState();
  M.addBlock(n, { title: 'A', start: at(6, 10), end: at(6, 11) });
  G.reconcile(n, CTX);
  ops = G.dueOps(n, CTX);
  r = G.applyPushResults(n, ops, [{ opId: ops[0].opId, ok: false, error: { type: 'network', retryable: true, message: 'fetch failed' } }], CTX);
  assert.equal(r.failed, 1);
  const e = n.gcal.outbox[0];
  assert.equal(e.attempts, 1);
  assert.equal(e.nextAt, plus(G.backoffMs(1, undefined, 0.5)).toISOString());
  assert.equal(e.nextAt, plus(11250).toISOString());
  assert.deepEqual(e.lastError, { type: 'network', message: 'fetch failed', at: NOW.toISOString() });
  assert.deepEqual(G.dueOps(n, CTX), []);
  assert.equal(G.dueOps(n, ctxAt(new Date(e.nextAt))).length, 1);
  // backoffMs: 지터 범위·상한·retryAfter
  for (let a = 1; a <= 14; a++) {
    const base = Math.min(15000 * 2 ** (a - 1), 30 * MIN);
    assert.equal(G.backoffMs(a, null, 0), base / 2);
    assert.equal(G.backoffMs(a, null, 1), base);
    const v = G.backoffMs(a, null, 0.37);
    assert.ok(v >= base / 2 && v <= base);
  }
  assert.equal(G.backoffMs(20, null, 1), 30 * MIN);
  assert.equal(G.backoffMs(3, 5000, 0.2), 5000);
  // 8회를 넘어도 버리지 않고 6시간 간격으로
  e.attempts = 8;
  ops = G.dueOps(n, ctxAt(plus(DAY)));
  G.applyPushResults(n, ops, [{ opId: ops[0].opId, ok: false, error: { type: 'server', status: 503, retryable: true } }], ctxAt(plus(DAY)));
  assert.equal(n.gcal.outbox.length, 1);
  assert.equal(e.attempts, 9);
  assert.equal(e.nextAt, plus(DAY + 6 * HOUR).toISOString());
  G.reconcile(n, ctxAt(plus(DAY)));
  assert.equal(n.gcal.outbox.length, 1);
  assert.equal(n.gcal.outbox[0].attempts, 9);
  // bad_request 는 하루 뒤에
  const bad = exportState();
  M.addBlock(bad, { title: 'A', start: at(6, 10), end: at(6, 11) });
  G.reconcile(bad, CTX);
  ops = G.dueOps(bad, CTX);
  G.applyPushResults(bad, ops, [{ opId: ops[0].opId, ok: false, error: { type: 'bad_request', status: 400, retryable: false } }], CTX);
  assert.equal(bad.gcal.outbox[0].nextAt, plus(DAY).toISOString());
  assert.equal(G.summary(bad, NOW).failed, 1);
});

test('‘Daynote’ 캘린더가 없어지면(calendar_missing) 올리기를 멈추고 한 항목씩만 시험한다 — 다시 만들면 새 캘린더로 옮긴다', () => {
  const { s, b } = linkedEvent();
  const c = M.addBlock(s, { title: 'C', start: at(8, 10), end: at(8, 11) });
  const d = M.addBlock(s, { title: 'D', start: at(8, 12), end: at(8, 13) });
  G.reconcile(s, CTX);
  let ops = G.dueOps(s, CTX);
  assert.equal(ops.length, 2);
  const r = G.applyPushResults(s, ops, [{ opId: ops[0].opId, ok: false, error: { type: 'calendar_missing', status: 404 } }], CTX);
  assert.equal(r.exportError, 'calendar_missing');
  assert.equal(G.summary(s, NOW).exportError, 'calendar_missing');
  assert.deepEqual(G.dueOps(s, ctxAt(plus(HOUR))).map((o) => o.opId), ['op:' + c.id]);   // 막힌 항목 하나만
  assert.deepEqual(G.dueOps(s, CTX), []);
  // 다시 만들기 → 새 id: 옛 링크는 풀고 새 캘린더로 올린다
  s.gcal.exportCalendarId = 'dncal2@group';
  const rr = G.reconcile(s, CTX);
  assert.deepEqual(rr.unlinked, [b.id]);
  assert.deepEqual(rr.inserts.sort(), [b.id, c.id, d.id].sort());
  assert.ok(s.gcal.outbox.every((e) => e.calendarId === 'dncal2@group' && e.lastError === null && e.attempts === 0));
  ops = G.dueOps(s, CTX);
  assert.equal(ops.length, 3);
  // 같은 캘린더에 하나라도 올라가면 막힘이 풀린다
  const s2 = exportState();
  const x = M.addBlock(s2, { title: 'X', start: at(8, 10), end: at(8, 11) });
  const y = M.addBlock(s2, { title: 'Y', start: at(8, 12), end: at(8, 13) });
  G.reconcile(s2, CTX);
  ops = G.dueOps(s2, CTX);
  G.applyPushResults(s2, ops, [{ opId: 'op:' + x.id, ok: false, error: { type: 'write_denied' } }, { opId: 'op:' + y.id, ok: false, error: { type: 'write_denied' } }], CTX);
  assert.equal(G.summary(s2, NOW).exportError, 'write_denied');
  ops = G.dueOps(s2, ctxAt(plus(HOUR)));
  assert.equal(ops.length, 1);
  G.applyPushResults(s2, ops, [{ opId: ops[0].opId, ok: true, eventId: ops[0].eventId, etag: '"1"' }], ctxAt(plus(HOUR)));
  assert.equal(G.summary(s2, NOW).exportError, null);
  assert.equal(G.dueOps(s2, ctxAt(plus(HOUR))).length, 1);
});

test('dueOps 는 상태를 바꾸지 않고 limit 만큼만 돌려준다', () => {
  const s = exportState();
  for (let i = 0; i < 5; i++) M.addBlock(s, { title: 'B' + i, start: at(6, 9 + i), end: at(6, 10 + i) });
  G.reconcile(s, CTX);
  const before = clone(s);
  assert.equal(G.dueOps(s, CTX, 3).length, 3);
  assert.equal(G.dueOps(s, CTX).length, 5);
  assert.deepEqual(s, before);
});

// ------------------------------------------------------------------ ‘Daynote’ 캘린더 되읽기 (#30–34)
test('#30-1 블록·링크·살아 있음 · local✗ remote✗ → 아무것도 안 한다', () => {
  const { s, b } = linkedEvent();
  const before = clone({ blocks: s.blocks, links: s.gcal.links, outbox: s.gcal.outbox });
  const { plan, r } = ownPull(s, [googleCopy(s, b)]);
  assert.equal(plan.stats.echo, 1);
  ['adoptLinks', 'remoteEdits', 'remoteDeletes', 'reinserts', 'orphans', 'mirrors', 'removeKeys', 'dropLinks'].forEach((k) => assert.deepEqual(plan[k], [], k));
  assert.equal(r.changed, 0);
  assert.deepEqual(clone({ blocks: s.blocks, links: s.gcal.links, outbox: s.gcal.outbox }), before);
});

test('#30-2 local✓ remote✗ → 되읽기는 그대로 두고 reconcile 이 patch 를 낸다', () => {
  const { s, b } = linkedEvent();
  const g0 = googleCopy(s, b);
  M.updateBlock(s, b.id, { title: '치과 예약' });
  const { plan } = ownPull(s, [g0]);
  assert.deepEqual([plan.remoteEdits, plan.remoteDeletes, plan.reinserts], [[], [], []]);
  assert.equal(b.title, '치과 예약');
  assert.deepEqual(G.reconcile(s, CTX).patches, [b.id]);
});

test('#30-3 local✗ remote✓ → Google 값(시작·끝·제목·장소)을 반영하고 L.hash = remoteHash, etag 갱신', () => {
  const { s, b } = linkedEvent();
  const g1 = googleCopy(s, b, { etag: '"e2"', updated: plus(MIN).toISOString(), summary: '치과(변경)', location: '강남',
    start: { dateTime: kst(at(7, 13)), timeZone: 'Asia/Seoul' }, end: { dateTime: kst(at(7, 14)), timeZone: 'Asia/Seoul' } });
  const { plan, r } = ownPull(s, [g1]);
  assert.deepEqual(plan.remoteEdits.map((x) => [x.blockId, x.patch]), [[b.id, { start: at(7, 13), end: at(7, 14), title: '치과(변경)', location: '강남' }]]);
  assert.equal(r.edited, 1);
  assert.ok(r.changed >= 1);
  assert.deepEqual([b.start, b.end, b.title, b.location], [at(7, 13), at(7, 14), '치과(변경)', '강남']);
  const L = s.gcal.links[b.id];
  assert.equal(L.etag, '"e2"');
  assert.equal(L.hash, G.remoteHash(g1));
  assert.equal(L.end, at(7, 14));
  assert.deepEqual(G.reconcile(s, CTX).patches, []);       // 모두 반영했으니 되돌려 보낼 것이 없다
  // exportTitles:false 면 시간만 반영하고, 다른 제목은 다음 reconcile 이 되돌린다
  const { s: s2, b: b2 } = linkedEvent();
  s2.gcal.settings.exportTitles = false;
  G.reconcile(s2, CTX); pushOk(s2, CTX, '"t1"');
  const g2 = googleCopy(s2, b2, { etag: '"t2"', summary: '누가 바꾼 제목', start: { dateTime: kst(at(7, 15)) }, end: { dateTime: kst(at(7, 16)) } });
  ownPull(s2, [g2]);
  assert.deepEqual([b2.start, b2.title], [at(7, 15), '치과']);
  assert.deepEqual(G.reconcile(s2, CTX).patches, [b2.id]);
});

test('#30-3b 작업 블록은 시작·끝만 반영하고, 제목이 다르면 다음 reconcile 이 patch 로 되돌린다', () => {
  const s = exportState();
  const t = M.addTask(s, { title: '견적서 작성' }, NOW);
  const w = M.addBlock(s, { taskId: t.id, start: at(7, 10), end: at(7, 11) });
  G.reconcile(s, CTX); pushOk(s);
  const g1 = googleCopy(s, w, { etag: '"e2"', summary: 'Google 에서 바꾼 제목', start: { dateTime: kst(at(7, 15)) }, end: { dateTime: kst(at(7, 17)) } });
  const { plan } = ownPull(s, [g1]);
  assert.deepEqual(plan.remoteEdits[0].patch, { start: at(7, 15), end: at(7, 17) });
  assert.deepEqual([w.start, w.end], [at(7, 15), at(7, 17)]);
  assert.equal(t.title, '견적서 작성');
  assert.deepEqual(G.reconcile(s, CTX).patches, [w.id]);
  assert.equal(G.dueOps(s, CTX)[0].body.summary, '견적서 작성');
});

test('#30-4 local✓ remote✓ → Daynote 가 이긴다 (Google 변경은 반영하지 않고 L.etag 도 그대로)', () => {
  const { s, b } = linkedEvent();
  const g1 = googleCopy(s, b, { etag: '"e2"', start: { dateTime: kst(at(7, 13)) }, end: { dateTime: kst(at(7, 14)) } });
  M.updateBlock(s, b.id, { title: '치과 예약' });
  const { plan, r } = ownPull(s, [g1]);
  assert.deepEqual(plan.remoteEdits, []);
  assert.equal(r.changed, 0);
  assert.equal(b.start, at(7, 10));
  assert.equal(s.gcal.links[b.id].etag, '"e1"');
  assert.deepEqual(G.reconcile(s, CTX).patches, [b.id]);
  assert.equal(G.dueOps(s, CTX)[0].body.start.dateTime, new Date(at(7, 10)).toISOString().slice(0, 19) + 'Z');
});

test('#30-5 Google 에서 취소됨 · local✗ → applyRemoteDeletes 가 블록을 지우고 링크 삭제·gens+1', () => {
  const { s, b } = linkedEvent();
  const L = s.gcal.links[b.id];
  const { plan, r } = ownPull(s, [{ id: L.eventId, status: 'cancelled' }]);
  assert.deepEqual(plan.remoteDeletes, [{ blockId: b.id }]);
  assert.equal(r.changed, 0);
  assert.ok(M.byId(s.blocks, b.id));                         // 지우는 일은 라벨 있는 mutate 에서 따로
  assert.deepEqual(G.applyRemoteDeletes(s, plan, CTX), { deleted: 1 });
  assert.equal(M.byId(s.blocks, b.id), null);
  assert.equal(s.gcal.links[b.id], undefined);
  assert.equal(s.gcal.gens[b.id], 1);
  assert.deepEqual(G.reconcile(s, CTX).deletes, []);
});

test('#30-6 Google 에서 취소됨 · local✓ → 링크 삭제·gens+1, 다음 reconcile 이 새 id 로 다시 insert (Daynote 가 이김)', () => {
  const { s, b } = linkedEvent();
  const L = s.gcal.links[b.id];
  M.updateBlock(s, b.id, { title: '치과 예약' });
  const { plan } = ownPull(s, [{ id: L.eventId, status: 'cancelled' }]);
  assert.deepEqual(plan.reinserts, [b.id]);
  assert.deepEqual(plan.remoteDeletes, []);
  assert.ok(M.byId(s.blocks, b.id));
  assert.equal(s.gcal.links[b.id], undefined);
  assert.equal(s.gcal.gens[b.id], 1);
  assert.deepEqual(G.reconcile(s, CTX).inserts, [b.id]);
  assert.equal(G.dueOps(s, CTX)[0].eventId, G.eventIdFor(b.id, 1));
});

test('#30-7 블록 있음·링크 없음·살아 있음 → 링크를 다시 맺는다 (L.hash = remoteHash)', () => {
  const { s, b } = linkedEvent();
  const raw = googleCopy(s, b);
  delete s.gcal.links[b.id];
  const { plan, r } = ownPull(s, [raw]);
  assert.deepEqual(plan.adoptLinks.map((a) => a.blockId), [b.id]);
  assert.equal(r.relinked, 1);
  const L = s.gcal.links[b.id];
  assert.equal(L.eventId, raw.id);
  assert.equal(L.calendarId, DN);
  assert.equal(L.hash, G.remoteHash(raw));
  assert.equal(L.etag, raw.etag);
  assert.equal(L.gen, 0);
  assert.deepEqual(G.reconcile(s, CTX), { inserts: [], patches: [], deletes: [], unlinked: [], changed: 0 });
});

test('#30-8 블록 없음·살아 있음(내 기기 표식) → 고아 delete(op:orphan:…) 를 넣는다', () => {
  const { s, b } = linkedEvent();
  const raw = googleCopy(s, b);
  M.deleteBlock(s, b.id);
  delete s.gcal.links[b.id];
  const { plan, r } = ownPull(s, [raw]);
  assert.deepEqual(plan.orphans, [{ eventId: raw.id }]);
  assert.equal(r.orphans, 1);
  assert.deepEqual(s.gcal.outbox.map((e) => [e.id, e.op, e.blockId, e.eventId, e.calendarId]), [['op:orphan:' + raw.id, 'delete', null, raw.id, DN]]);
  ownPull(s, [raw]);
  assert.equal(s.gcal.outbox.length, 1);                     // 두 번 넣지 않는다
  G.reconcile(s, CTX);
  assert.equal(s.gcal.outbox.length, 1);                     // reconcile 도 고아 delete 를 남긴다
  const ops = G.dueOps(s, CTX);
  assert.deepEqual(ops.map((o) => [o.op, o.eventId, o.daynoteId]), [['delete', raw.id, null]]);
  G.applyPushResults(s, ops, [{ opId: ops[0].opId, ok: false, error: { type: 'gone', status: 410 } }], CTX);
  assert.deepEqual(s.gcal.outbox, []);
  // 링크가 남아 있으면 고아로 넣지 않는다 — reconcile 의 delete 가 맡는다
  const { s: s2, b: b2 } = linkedEvent();
  const raw2 = googleCopy(s2, b2);
  M.deleteBlock(s2, b2.id);
  assert.deepEqual(ownPull(s2, [raw2]).plan.orphans, []);
  assert.deepEqual(G.reconcile(s2, CTX).deletes, [b2.id]);
});

test('#30-9 블록 없음·링크 있음·취소됨 → 링크만 정리한다', () => {
  const { s, b } = linkedEvent();
  const L = s.gcal.links[b.id];
  M.deleteBlock(s, b.id);
  const { plan } = ownPull(s, [{ id: L.eventId, status: 'cancelled' }]);
  assert.deepEqual(plan.dropLinks, [b.id]);
  assert.deepEqual([plan.remoteDeletes, plan.reinserts, plan.orphans], [[], [], []]);
  assert.deepEqual(s.gcal.links, {});
  assert.equal(s.gcal.gens[b.id], undefined);
  assert.deepEqual(G.reconcile(s, CTX).deletes, []);
});

test('#31 내가 쓴 것이 돌아오면(etag 같음) 변화가 없다 — 증분·전체 모두', () => {
  const { s, b } = linkedEvent();
  const raw = googleCopy(s, b);
  const keep = clone({ blocks: s.blocks, links: s.gcal.links, outbox: s.gcal.outbox, events: s.gcal.events, gens: s.gcal.gens });
  [false, true].forEach((full) => {
    const { plan, r } = ownPull(s, [raw], full);
    assert.equal(plan.stats.echo, 1);
    assert.deepEqual(r, { changed: 0, edited: 0, relinked: 0, orphans: 0, mirrored: 0 });
    assert.deepEqual(clone({ blocks: s.blocks, links: s.gcal.links, outbox: s.gcal.outbox, events: s.gcal.events, gens: s.gcal.gens }), keep);
  });
  const c = cal(s, DN);
  assert.equal(c.isExport, true);
  assert.equal(c.selected, false);
  assert.ok(c.syncToken);
});

test('#32 다른 기기 표식이 있는 항목은 events 에 origin:daynote_other, busy 로 거울이 생긴다', () => {
  const { s } = linkedEvent();
  const other = rawEv('dnother1', at(8, 10), at(8, 11), { summary: '다른 기기 일정',
    extendedProperties: { private: { daynoteId: 'blk_other', daynoteKind: 'event', daynoteDevice: 'dev-B', daynoteV: '1' } } });
  const direct = rawEv('direct1', at(8, 12), at(8, 13), { summary: 'Google 에서 이 캘린더에 직접 만든 일정' });
  const { plan, r } = ownPull(s, [other, direct]);
  assert.equal(plan.mirrors.length, 2);
  assert.equal(r.mirrored, 2);
  const ev = s.gcal.events.find((e) => e.eventId === 'dnother1');
  assert.deepEqual([ev.origin, ev.busy, ev.daynoteId, ev.calendarId, ev.key], ['daynote_other', true, 'blk_other', DN, G.eventKey(DN, 'dnother1')]);
  assert.equal(s.gcal.events.find((e) => e.eventId === 'direct1').origin, 'google');
  assert.equal(s.gcal.links.blk_other, undefined);
  if (V4) assert.equal(M.externalItems(s).find((x) => x.eventId === 'dnother1').origin, 'daynote_other');
  // 다른 기기가 지우면 거울도 사라진다 (증분 묘비 · 전체 동기화에서 빠짐)
  ownPull(s, [{ id: 'dnother1', status: 'cancelled' }]);
  assert.deepEqual(s.gcal.events.map((e) => e.eventId), ['direct1']);
  ownPull(s, [], true);
  assert.deepEqual(s.gcal.events, []);
});

test('#33 링크를 잃은 상태(백업 복원)에서는 daynoteId 로 링크를 다시 맺고, 내용이 다르면 patch 가 나간다', () => {
  const { s, b } = linkedEvent();
  const raw = googleCopy(s, b, { id: G.eventIdFor(b.id, 2) });            // 세대 2 로 올라가 있던 이벤트
  s.gcal.links = {};
  s.gcal.gens = {};
  M.updateBlock(s, b.id, { title: '치과 (복원 뒤 다른 제목)' });
  const { plan } = ownPull(s, [raw]);
  assert.equal(plan.adoptLinks.length, 1);
  assert.equal(s.gcal.links[b.id].eventId, raw.id);
  assert.equal(s.gcal.links[b.id].gen, 2);
  assert.equal(s.gcal.gens[b.id], 2);
  assert.deepEqual(G.reconcile(s, CTX).patches, [b.id]);
  const ops = G.dueOps(s, CTX);
  assert.deepEqual(ops.map((o) => [o.op, o.eventId, o.body.summary]), [['patch', raw.id, '치과 (복원 뒤 다른 제목)']]);
});

test('#34 지운 것 반영(applyRemoteDeletes) 뒤 되돌리면 블록이 돌아오고, reconcile 이 새 gen 으로 insert 한다', () => {
  const { s, b } = linkedEvent();
  const L = s.gcal.links[b.id];
  const plan = G.planOwnPull(s, { ok: true, items: [{ id: L.eventId, status: 'cancelled' }], full: false, nextSyncToken: 'n1' }, CTX);
  G.applyOwnPull(s, plan, CTX);
  const snap = snapshotExceptGcal(s);                        // S.mutate('Google에서 지운 일정 반영', …) 직전
  assert.deepEqual(G.applyRemoteDeletes(s, plan, CTX), { deleted: 1 });
  assert.equal(s.blocks.length, 0);
  restoreExceptGcal(s, snap);                                // 되돌리기 (gcal 은 유지)
  assert.ok(M.byId(s.blocks, b.id));
  assert.equal(s.gcal.links[b.id], undefined);
  assert.equal(s.gcal.gens[b.id], 1);
  assert.deepEqual(G.reconcile(s, CTX).inserts, [b.id]);
  const ops = G.dueOps(s, CTX);
  assert.deepEqual(ops.map((o) => [o.op, o.eventId, o.gen]), [['insert', G.eventIdFor(b.id, 1), 1]]);
  assert.notEqual(ops[0].eventId, L.eventId);
});

test('전체 되읽기에서 창 안의 링크된 이벤트가 안 보이면 링크를 풀고 새 세대로 다시 올린다 (데이터를 잃지 않는 쪽)', () => {
  const { s, b } = linkedEvent();
  const far = M.addBlock(s, { title: '먼 미래', start: new Date(2027, 1, 1, 10).toISOString(), end: new Date(2027, 1, 1, 11).toISOString() });
  G.reconcile(s, CTX); pushOk(s);
  assert.ok(s.gcal.links[far.id]);
  const { plan } = ownPull(s, [], true);                        // 410 뒤 전체 동기화: 아무것도 안 보임
  assert.deepEqual(plan.reinserts, [b.id]);                      // 창 밖(먼 미래)의 링크는 그대로 둔다
  assert.equal(s.gcal.links[b.id], undefined);
  assert.ok(s.gcal.links[far.id]);
  assert.equal(s.gcal.gens[b.id], 1);
  assert.deepEqual(G.reconcile(s, CTX).inserts, [b.id]);
});

test('applyOwnPull 은 그 사이 Daynote 에서 바뀐 블록에는 Google 편집을 반영하지 않는다', () => {
  const { s, b } = linkedEvent();
  const g1 = googleCopy(s, b, { etag: '"e2"', start: { dateTime: kst(at(7, 13)) }, end: { dateTime: kst(at(7, 14)) } });
  const plan = G.planOwnPull(s, { ok: true, items: [g1], full: false, nextSyncToken: 'n' }, CTX);
  assert.equal(plan.remoteEdits.length, 1);
  M.updateBlock(s, b.id, { title: '먼저 바꿈' });
  const r = G.applyOwnPull(s, plan, CTX);
  assert.equal(r.edited, 0);
  assert.equal(b.start, at(7, 10));
  assert.equal(s.gcal.links[b.id].etag, '"e1"');
  // 다른 내보내기 캘린더의 계획은 무시한다
  s.gcal.exportCalendarId = 'other-cal';
  assert.deepEqual(G.applyOwnPull(s, plan, CTX), { changed: 0, edited: 0, relinked: 0, orphans: 0, mirrored: 0 });
});

// ------------------------------------------------------------------ 계정·캘린더 목록 (#35)
test('#35 resetForAccount 는 조각을 비우고 settings 는 유지 · mergeCalendarList 는 처음엔 primary 만, 선택 보존, 사라진 캘린더 일정 삭제, isExport', () => {
  const s = stateWithCals();
  pull(s, PRIMARY, [rawEv('p1', at(6, 10), at(6, 11))], true);
  pull(s, TEAM, [rawEv('t1', at(6, 10), at(6, 11))], true);
  s.gcal.settings.exportWork = false;
  s.gcal.exportCalendarId = DN;
  s.gcal.links.x = { eventId: 'e', calendarId: DN };
  s.gcal.gens.x = 2;
  s.gcal.outbox.push({ id: 'op:x', op: 'delete' });
  s.gcal.backoffUntil = plus(HOUR).toISOString();
  s.gcal.accountId = 'acct-1';
  G.resetForAccount(s, 'acct-2');
  assert.deepEqual(s.gcal, Object.assign(G.emptyGcal(), { accountId: 'acct-2', settings: { exportEnabled: true, exportWork: false, exportTitles: true } }));

  // 처음: primary 만 고른다
  const first = G.mergeCalendarList(s, [
    { id: TEAM, summary: '팀', backgroundColor: '#33b679', accessRole: 'reader', timeZone: 'Asia/Seoul' },
    { id: PRIMARY, summary: '내 캘린더', primary: true, backgroundColor: '#7986cb', accessRole: 'owner', timeZone: 'Asia/Seoul' },
    { id: 'busy@x', summary: '바쁨만', accessRole: 'freeBusyReader', backgroundColor: 'url(javascript:1)' }
  ], CTX);
  assert.deepEqual(first, { added: 3, removed: 0 });
  assert.deepEqual(s.gcal.calendars.map((c) => [c.id, c.selected, c.isExport, c.primary]),
    [[PRIMARY, true, false, true], [TEAM, false, false, false], ['busy@x', false, false, false]]);
  assert.deepEqual(cal(s, PRIMARY), {
    id: PRIMARY, summary: '내 캘린더', primary: true, color: '#7986cb', accessRole: 'owner', timeZone: 'Asia/Seoul',
    selected: true, isExport: false, syncToken: null, windowStart: null, windowEnd: null, fullSyncAt: null, lastSyncAt: null, nextPullAt: null, error: null
  });
  assert.equal(cal(s, 'busy@x').color, null);                       // 색이 아닌 값은 버린다

  // 선택·커서 보존, ‘Daynote’ 캘린더 표시, 새 캘린더는 고르지 않음
  G.setSelected(s, TEAM, true);
  G.setSelected(s, PRIMARY, false);
  pull(s, TEAM, [rawEv('t1', at(6, 10), at(6, 11))], true);
  const teamToken = cal(s, TEAM).syncToken;
  s.gcal.exportCalendarId = DN;
  const second = G.mergeCalendarList(s, [
    { id: PRIMARY, summary: '내 캘린더', primary: true, accessRole: 'owner' },
    { id: TEAM, summary: '팀(이름 바뀜)', accessRole: 'reader' },
    { id: DN, summary: 'Daynote', accessRole: 'owner', description: 'Daynote가 만든 일정 [daynote-export:v1]' },
    { id: 'holiday@x', summary: '대한민국의 휴일', accessRole: 'reader' }
  ], CTX);
  assert.deepEqual(second, { added: 2, removed: 1 });
  assert.deepEqual(s.gcal.calendars.map((c) => [c.id, c.selected, c.isExport]),
    [[PRIMARY, false, false], [TEAM, true, false], [DN, false, true], ['holiday@x', false, false]]);
  assert.equal(cal(s, TEAM).summary, '팀(이름 바뀜)');
  assert.equal(cal(s, TEAM).syncToken, teamToken);
  assert.equal(G.setSelected(s, DN, true).removed, 0);
  assert.equal(cal(s, DN).selected, false);                        // ‘Daynote’ 는 가져오기 대상이 아니다

  // 목록에서 사라진 캘린더 → 그 일정도 지운다. 숨겨진 ‘Daynote’ 는 남긴다
  const third = G.mergeCalendarList(s, [{ id: PRIMARY, summary: '내 캘린더', primary: true, accessRole: 'owner' }], CTX);
  assert.deepEqual(third, { added: 0, removed: 2 });
  assert.deepEqual(s.gcal.calendars.map((c) => c.id), [PRIMARY, DN]);
  assert.deepEqual(keysOf(s), []);
  const sum = G.summary(s, NOW);
  assert.deepEqual([sum.calendars, sum.selected], [1, 0]);

  // exportCalendarId 가 아직 없으면 표식이 있는 내 캘린더를 ‘Daynote’ 로 본다
  const s2 = M.emptyState();
  G.mergeCalendarList(s2, [
    { id: PRIMARY, primary: true, accessRole: 'owner' },
    { id: DN, summary: 'Daynote', accessRole: 'owner', description: '[daynote-export:v1]' },
    { id: 'fake@x', summary: 'Daynote', accessRole: 'reader', description: '[daynote-export:v1]' }
  ], CTX);
  assert.deepEqual(s2.gcal.calendars.map((c) => [c.id, c.isExport]), [[PRIMARY, false], [DN, true], ['fake@x', false]]);
});

// ------------------------------------------------------------------ 올리기 끄기 · 표시
test('disableExport: removeFuture 면 앞으로의 링크를 delete(drain) 로 지우고, 아니면 링크만 모두 푼다', () => {
  const { s, b } = linkedEvent();
  const past = M.addBlock(s, { title: '어제', start: at(4, 12), end: at(4, 13) });   // 21시간 전에 끝남 → 올라감
  const pending = M.addBlock(s, { title: '아직 안 올림', start: at(9, 10), end: at(9, 11) });
  G.reconcile(s, CTX);
  const ops = G.dueOps(s, CTX).filter((o) => o.daynoteId === past.id);
  G.applyPushResults(s, ops, ops.map((o) => ({ opId: o.opId, ok: true, eventId: o.eventId, etag: '"p"' })), CTX);
  assert.ok(s.gcal.links[past.id]);
  assert.equal(s.gcal.outbox.length, 1);                                // pending 의 insert
  const r = G.disableExport(s, { removeFuture: true }, NOW);
  assert.deepEqual(r, { deletes: 1, unlinked: 1 });
  assert.equal(s.gcal.settings.exportEnabled, false);
  assert.deepEqual(s.gcal.outbox.map((e) => [e.id, e.op, e.drain, e.eventId]), [['op:' + b.id, 'delete', true, s.gcal.links[b.id].eventId]]);
  assert.equal(s.gcal.links[past.id], undefined);
  assert.equal(G.summary(s, NOW).draining, 1);
  // 꺼져 있어도 reconcile 은 아무것도 안 하고, dueOps 는 drain 항목을 보낸다
  assert.deepEqual(G.reconcile(s, CTX), { inserts: [], patches: [], deletes: [], unlinked: [], changed: 0 });
  const drain = G.dueOps(s, CTX);
  assert.deepEqual(drain.map((o) => o.op), ['delete']);
  G.applyPushResults(s, drain, [{ opId: drain[0].opId, ok: true }], CTX);
  assert.deepEqual([s.gcal.links, s.gcal.outbox], [{}, []]);
  assert.equal(G.blockSyncState(s, pending.id, CTX), null);
  // 그대로 두기
  const { s: s2 } = linkedEvent();
  M.addBlock(s2, { title: '대기', start: at(9, 10), end: at(9, 11) });
  G.reconcile(s2, CTX);
  assert.deepEqual(G.disableExport(s2, { removeFuture: false }, NOW), { deletes: 0, unlinked: 1 });
  assert.deepEqual([s2.gcal.links, s2.gcal.outbox], [{}, []]);
  assert.deepEqual(G.dueOps(s2, CTX), []);
  // 다시 켜면 처음부터 올린다
  s2.gcal.settings.exportEnabled = true;
  assert.equal(G.reconcile(s2, CTX).inserts.length, 2);
});

test('blockSyncState 표: null · uncertain · failed · pending · synced', () => {
  const { s, b } = linkedEvent();
  const t = M.addTask(s, { title: '견적서' }, NOW);
  const fresh = M.addBlock(s, { title: '새 일정', start: at(8, 10), end: at(8, 11) });
  const unsure = M.addBlock(s, { title: '시각 미정', start: at(8, 12), end: at(8, 13), timeUncertain: true });
  const sample = M.addBlock(s, { title: '샘플', start: at(8, 14), end: at(8, 15), sample: true });
  const old = M.addBlock(s, { title: '지난주', start: at(1, 10), end: at(1, 11) });
  const work = M.addBlock(s, { taskId: t.id, start: at(8, 16), end: at(8, 17) });
  const st = (id) => G.blockSyncState(s, id, CTX);
  const table = () => [st(b.id), st(fresh.id), st(unsure.id), st(sample.id), st(old.id), st(work.id), st('blk_none')];
  assert.deepEqual(table(), ['synced', 'pending', 'uncertain', null, null, 'pending', null]);
  G.reconcile(s, CTX);                                                 // fresh·work 가 outbox 로
  const ops = G.dueOps(s, CTX);
  G.applyPushResults(s, ops, ops.map((o) => (o.daynoteId === fresh.id
    ? { opId: o.opId, ok: false, error: { type: 'server', status: 500, retryable: true } }
    : { opId: o.opId, ok: true, eventId: o.eventId, etag: '"w"' })), CTX);
  assert.deepEqual(table(), ['synced', 'failed', 'uncertain', null, null, 'synced', null]);
  M.updateBlock(s, b.id, { title: '치과 예약' });
  G.reconcile(s, CTX);
  assert.equal(st(b.id), 'pending');                                   // patch 대기
  s.gcal.settings.exportEnabled = false;
  assert.deepEqual(table(), [null, null, null, null, null, null, null]);
});

test('summary: 가져온 일정·올릴 일정·실패·마지막 동기화', () => {
  const s = stateWithCals();
  s.gcal.exportCalendarId = DN;
  pull(s, PRIMARY, [rawEv('p1', at(6, 10), at(6, 11)), rawEv('p2', at(7, 10), at(7, 11))], true);
  pull(s, TEAM, [rawEv('t1', at(6, 10), at(6, 11))], true);
  M.addBlock(s, { title: 'A', start: at(6, 10), end: at(6, 11) });
  M.addBlock(s, { title: 'B', start: at(6, 12), end: at(6, 13) });
  G.reconcile(s, CTX);
  const ops = G.dueOps(s, CTX);
  G.applyPushResults(s, ops, [{ opId: ops[0].opId, ok: false, error: { type: 'bad_request', status: 400 } }], CTX);
  s.gcal.lastSyncAt = NOW.toISOString();
  assert.deepEqual(G.summary(s, NOW), {
    calendars: 2, selected: 2, events: 3, pending: 1, failed: 1,
    lastSyncAt: NOW.toISOString(), lastError: null, exportError: null, draining: 0
  });
  assert.deepEqual(G.summary(M.emptyState(), NOW), {
    calendars: 0, selected: 0, events: 0, pending: 0, failed: 0, lastSyncAt: null, lastError: null, exportError: null, draining: 0
  });
});
