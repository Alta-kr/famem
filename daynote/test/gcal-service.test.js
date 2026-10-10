'use strict';

// Google 캘린더 REST 실행기(services/gcal.js) — 가짜 auth {getAccessToken, exportCalendarId}, 가짜 fetch, sleep 기록
// (DAYNOTE_GOOGLE_DESIGN.md §12.4)

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../services/gcal');

const NOW = new Date(2026, 9, 5, 10, 0);
const BASE = 'https://www.googleapis.com/calendar/v3';
const EXPORT = 'dn0123456789@group.calendar.google.com';
const TIME_MIN = '2026-09-27T15:00:00.000Z';
const TIME_MAX = '2026-12-04T15:00:00.000Z';

// ---------------------------------------------------------------- 가짜 도구 (§12.1)
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(String(url));
    const req = { url: u, method: init.method || 'GET', headers: init.headers || {}, body: init.body == null ? null : String(init.body) };
    calls.push(req);
    const r = await handler(req, calls.length);          // { status, json?, headers? } 또는 throw new TypeError('fetch failed')
    const h = Object.fromEntries(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: (k) => h[k.toLowerCase()] ?? null },
      json: async () => r.json, text: async () => (r.json === undefined ? '' : JSON.stringify(r.json)) };
  };
  fn.calls = calls;
  return fn;
}
function fakeAuth({ exportId = EXPORT, fail = null } = {}) {
  let n = 0;
  const a = {
    calls: [], set: [], exportId,
    getAccessToken: async (o = {}) => {
      a.calls.push(o);
      if (fail) return { ok: false, error: fail };
      n++;
      return { ok: true, accessToken: 'ya29.tok' + n, expiresAt: NOW.getTime() + 3600e3 };
    },
    exportCalendarId: () => a.exportId,
    setExportCalendarId: (id) => { a.set.push(id); a.exportId = id; return { ok: true }; }
  };
  return a;
}
function setup(handler, o = {}) {
  const fetch = fakeFetch(handler);
  const slept = [];
  const auth = o.auth || fakeAuth();
  const svc = S.create(Object.assign({ auth, fetch, sleep: async (ms) => { slept.push(ms); }, random: () => 0, now: () => NOW.getTime() }, o.create || {}));
  return { svc, fetch, slept, auth };
}
const gErr = (code, reason, extra = {}) => ({ error: Object.assign({ code, message: 'x', errors: reason ? [{ domain: 'global', reason, message: 'x' }] : [] }, extra) });
const evPath = (cid) => '/calendar/v3/calendars/' + encodeURIComponent(cid) + '/events';
const body = (patch = {}) => Object.assign({
  summary: '견적서 작성', description: 'Daynote 작업 시간',
  start: { dateTime: '2026-10-05T01:00:00Z', timeZone: 'Asia/Seoul' },
  end: { dateTime: '2026-10-05T02:00:00Z', timeZone: 'Asia/Seoul' },
  transparency: 'opaque', reminders: { useDefault: false },
  extendedProperties: { private: { daynoteId: 'blk_1', daynoteKind: 'work', daynoteDevice: '0123456789abcdef', daynoteV: '1' } }
}, patch);
const insertOp = (patch = {}) => Object.assign({ opId: 'op:blk_1', op: 'insert', calendarId: EXPORT, eventId: 'dn626c6b5f31', daynoteId: 'blk_1', body: body(), hash: 'h1', gen: 0 }, patch);

// ---------------------------------------------------------------- §12.4
test('1. 전체 listEvents: singleEvents·maxResults=250·timeMin·timeMax·fields, orderBy 없음, 2페이지 이어 받기, 마지막 nextSyncToken', async () => {
  const t = setup((req) => (req.url.searchParams.get('pageToken') === 'p2'
    ? { status: 200, json: { items: [{ id: 'b' }], nextSyncToken: 'sync-1' } }
    : { status: 200, json: { items: [{ id: 'a' }], nextPageToken: 'p2', timeZone: 'Asia/Seoul' } }));
  const r = await t.svc.listEvents({ calendarId: 'me@gmail.com', timeMin: TIME_MIN, timeMax: TIME_MAX });
  assert.deepEqual(r, { ok: true, items: [{ id: 'a' }, { id: 'b' }], nextSyncToken: 'sync-1', full: true, pages: 2, timeZone: 'Asia/Seoul' });
  assert.equal(t.fetch.calls.length, 2);
  t.fetch.calls.forEach((c, i) => {
    assert.equal(c.method, 'GET');
    assert.equal(c.url.origin + c.url.pathname, 'https://www.googleapis.com' + evPath('me@gmail.com'));
    const q = c.url.searchParams;
    assert.equal(q.get('singleEvents'), 'true');
    assert.equal(q.get('maxResults'), '250');
    assert.equal(q.get('timeMin'), TIME_MIN);
    assert.equal(q.get('timeMax'), TIME_MAX);
    assert.equal(q.get('fields'), S.EVENT_FIELDS);
    assert.equal(q.has('orderBy'), false);
    assert.equal(q.has('syncToken'), false);
    assert.equal(q.get('pageToken'), i === 0 ? null : 'p2');
    assert.equal(c.headers.Authorization, 'Bearer ya29.tok' + (i + 1));
    assert.equal(c.headers.Accept, 'application/json');
    assert.equal(c.headers['Content-Type'], undefined);
  });
  assert.equal(S.EVENT_FIELDS, 'nextPageToken,nextSyncToken,timeZone,items(id,status,etag,updated,summary,location,htmlLink,eventType,'
    + 'transparency,start,end,recurringEventId,originalStartTime,attendees(self,responseStatus),extendedProperties/private)');
  assert.ok(!JSON.stringify(r).includes('ya29.'));
});

test('2. 증분 listEvents 는 syncToken 만 보내고 timeMin·timeMax 가 없다', async () => {
  const t = setup(() => ({ status: 200, json: { items: [{ id: 'x', status: 'cancelled' }], nextSyncToken: 'sync-2' } }));
  const r = await t.svc.listEvents({ calendarId: 'primary', syncToken: 'sync-1', timeMin: TIME_MIN, timeMax: TIME_MAX });
  assert.equal(r.ok, true);
  assert.equal(r.full, false);
  assert.equal(r.nextSyncToken, 'sync-2');
  assert.equal(r.pages, 1);
  const q = t.fetch.calls[0].url.searchParams;
  assert.equal(q.get('syncToken'), 'sync-1');
  assert.equal(q.has('timeMin'), false);
  assert.equal(q.has('timeMax'), false);
  assert.equal(q.has('orderBy'), false);
  assert.equal(q.get('singleEvents'), 'true');
  assert.equal(q.get('fields'), S.EVENT_FIELDS);
});

test('3. 410 이면 sync_token_gone (다시 시도 안 함), maxPages 를 넘으면 too_many_changes', async () => {
  const t = setup(() => ({ status: 410, json: gErr(410, 'fullSyncRequired') }));
  const r = await t.svc.listEvents({ calendarId: 'primary', syncToken: 'old' });
  assert.equal(r.ok, false);
  assert.equal(r.error.type, 'sync_token_gone');
  assert.equal(r.error.status, 410);
  assert.equal(t.fetch.calls.length, 1);
  let n = 0;
  const m = setup(() => ({ status: 200, json: { items: [{ id: 'e' + (++n) }], nextPageToken: 'p' + n } }), { create: { maxPages: 3 } });
  const r2 = await m.svc.listEvents({ calendarId: 'primary', syncToken: 's' });
  assert.equal(r2.ok, false);
  assert.equal(r2.error.type, 'too_many_changes');
  assert.equal(m.fetch.calls.length, 3);
});

test('4. 429 + Retry-After: 2 → sleep(2000) 뒤 성공, retries 를 넘으면 rate_limit 과 retryAfterMs', async () => {
  const t = setup((req, n) => (n === 1 ? { status: 429, headers: { 'Retry-After': '2' }, json: gErr(429, 'rateLimitExceeded') } : { status: 200, json: { items: [] } }));
  const r = await t.svc.listEvents({ calendarId: 'primary', timeMin: TIME_MIN, timeMax: TIME_MAX });
  assert.equal(r.ok, true);
  assert.deepEqual(t.slept, [2000]);
  assert.equal(t.fetch.calls.length, 2);

  const all = setup(() => ({ status: 429, headers: { 'Retry-After': '2' }, json: gErr(429, 'rateLimitExceeded') }));
  const r2 = await all.svc.listEvents({ calendarId: 'primary', syncToken: 's' });
  assert.equal(r2.ok, false);
  assert.equal(r2.error.type, 'rate_limit');
  assert.equal(r2.error.retryAfterMs, 2000);
  assert.equal(r2.error.retryable, true);
  assert.equal(all.fetch.calls.length, 4);                     // 처음 1번 + retries 3번
  assert.deepEqual(all.slept, [2000, 2000, 2000]);

  // Retry-After 가 없으면 1초·2초·4초 (+지터), 결과에는 그래도 retryAfterMs 가 있다
  const nh = setup(() => ({ status: 429, json: gErr(429, 'rateLimitExceeded') }));
  const r3 = await nh.svc.listCalendars();
  assert.equal(r3.error.type, 'rate_limit');
  assert.ok(r3.error.retryAfterMs > 0);
  assert.deepEqual(nh.slept, [1000, 2000, 4000]);
  const jit = setup(() => ({ status: 503, json: gErr(503, 'backendError') }), { create: { random: () => 0.999, retries: 1 } });
  assert.equal((await jit.svc.listCalendars()).error.type, 'server');
  assert.ok(jit.slept[0] > 1000 && jit.slept[0] <= 1500);

  // 너무 긴 Retry-After 는 서비스 안에서 기다리지 않고 엔진에 넘긴다
  const long = setup(() => ({ status: 429, headers: { 'Retry-After': '3600' } }));
  const r4 = await long.svc.listCalendars();
  assert.equal(r4.error.retryAfterMs, 3600000);
  assert.deepEqual(long.slept, []);
  assert.equal(long.fetch.calls.length, 1);
  // 5xx 는 다시 시도해서 성공
  const s5 = setup((req, n) => (n === 1 ? { status: 503 } : { status: 200, json: { items: [] } }));
  assert.equal((await s5.svc.listCalendars()).ok, true);
  assert.deepEqual(s5.slept, [1000]);
});

test('5. 403 userRateLimitExceeded 는 다시 시도, insufficientPermissions 는 needs_scope(1번), quotaExceeded 는 quota + 1시간', async () => {
  const rl = setup((req, n) => (n === 1 ? { status: 403, json: gErr(403, 'userRateLimitExceeded') } : { status: 200, json: { items: [{ id: 'c' }] } }));
  assert.equal((await rl.svc.listCalendars()).ok, true);
  assert.equal(rl.fetch.calls.length, 2);
  assert.deepEqual(rl.slept, [1000]);

  const ns = setup(() => ({ status: 403, json: gErr(403, 'insufficientPermissions') }));
  const r = await ns.svc.listEvents({ calendarId: 'primary', syncToken: 's' });
  assert.equal(r.error.type, 'needs_scope');
  assert.equal(r.error.retryable, false);
  assert.equal(ns.fetch.calls.length, 1);
  const ns2 = setup(() => ({ status: 403, json: { error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } } }));
  assert.equal((await ns2.svc.listCalendars()).error.type, 'needs_scope');

  const q = setup(() => ({ status: 403, json: gErr(403, 'quotaExceeded') }));
  const rq = await q.svc.listCalendars();
  assert.equal(rq.error.type, 'quota');
  assert.equal(rq.error.retryAfterMs, 3600000);
  assert.equal(q.fetch.calls.length, 1);
  assert.deepEqual(q.slept, []);
  const d = setup(() => ({ status: 403, json: gErr(403, 'dailyLimitExceeded') }));
  assert.equal((await d.svc.listCalendars()).error.type, 'quota');
});

test('6. 401 이면 forceRefresh 를 한 번 하고 성공, 연속 401 이면 auth', async () => {
  const t = setup((req, n) => (n === 1 ? { status: 401, json: gErr(401, 'authError') } : { status: 200, json: { items: [] } }));
  const r = await t.svc.listEvents({ calendarId: 'primary', syncToken: 's' });
  assert.equal(r.ok, true);
  assert.deepEqual(t.auth.calls, [{}, { forceRefresh: true }]);
  assert.equal(t.fetch.calls[1].headers.Authorization, 'Bearer ya29.tok2');

  const bad = setup(() => ({ status: 401, json: gErr(401, 'authError') }));
  const r2 = await bad.svc.listEvents({ calendarId: 'primary', syncToken: 's' });
  assert.equal(r2.error.type, 'auth');
  assert.equal(bad.fetch.calls.length, 2);
  assert.deepEqual(bad.auth.calls, [{}, { forceRefresh: true }]);

  // 토큰을 못 받으면 요청하지 않는다 (reauth·not_signed_in 은 그대로 전한다)
  const re = setup(() => ({ status: 200, json: {} }), { auth: fakeAuth({ fail: { type: 'reauth', message: '만료', retryable: false } }) });
  assert.equal((await re.svc.listCalendars()).error.type, 'reauth');
  assert.equal(re.fetch.calls.length, 0);
  const ni = setup(() => ({ status: 200, json: {} }), { auth: fakeAuth({ fail: { type: 'not_signed_in' } }) });
  assert.equal((await ni.svc.push([insertOp()])).results[0].error.type, 'not_signed_in');
  assert.equal(ni.fetch.calls.length, 0);
});

test('7. TypeError(fetch failed) 는 network(retryable, 다시 시도), AbortController 시간 제한은 timeout', async () => {
  const t = setup(() => { throw new TypeError('fetch failed'); });
  const r = await t.svc.listEvents({ calendarId: 'primary', syncToken: 's' });
  assert.equal(r.error.type, 'network');
  assert.equal(r.error.retryable, true);
  assert.equal(t.fetch.calls.length, 4);
  assert.deepEqual(t.slept, [1000, 2000, 4000]);
  const back = setup((req, n) => { if (n === 1) throw new TypeError('fetch failed'); return { status: 200, json: { items: [] } }; });
  assert.equal((await back.svc.listCalendars()).ok, true);

  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  });
  const svc = S.create({ auth: fakeAuth(), fetch: hang, sleep: async () => {}, requestTimeoutMs: 20 });
  const r2 = await svc.listEvents({ calendarId: 'primary', syncToken: 's' });
  assert.equal(r2.ok, false);
  assert.equal(r2.error.type, 'timeout');
  assert.equal(r2.error.retryable, true);
});

test('8. push insert: POST …/events?sendUpdates=none, 본문에 id, 모르는 키는 sanitizeBody 로 지워진다', async () => {
  const t = setup(() => ({ status: 200, json: { id: 'dn626c6b5f31', etag: '"e1"', updated: '2026-10-05T01:00:01.000Z', status: 'confirmed' } }));
  const op = insertOp({ body: body({ attendees: [{ email: 'boss@corp.com' }], colorId: '5', visibility: 'public', conferenceData: {},
    reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 1 }] },
    extendedProperties: { private: { daynoteId: 'blk_1', evil: 'x', daynoteKind: 'work' }, shared: { daynoteId: 'blk_1' } } }) });
  const r = await t.svc.push([op]);
  assert.deepEqual(r, { ok: true, results: [{ opId: 'op:blk_1', ok: true, eventId: 'dn626c6b5f31', etag: '"e1"', updated: '2026-10-05T01:00:01.000Z' }] });
  const c = t.fetch.calls[0];
  assert.equal(c.method, 'POST');
  assert.equal(c.url.origin + c.url.pathname, 'https://www.googleapis.com' + evPath(EXPORT));
  assert.equal(c.url.searchParams.get('sendUpdates'), 'none');
  assert.equal(c.headers['Content-Type'], 'application/json');
  const sent = JSON.parse(c.body);
  assert.deepEqual(sent, {
    id: 'dn626c6b5f31', summary: '견적서 작성', description: 'Daynote 작업 시간',
    start: { dateTime: '2026-10-05T01:00:00Z', timeZone: 'Asia/Seoul' }, end: { dateTime: '2026-10-05T02:00:00Z', timeZone: 'Asia/Seoul' },
    transparency: 'opaque', reminders: { useDefault: false },
    extendedProperties: { private: { daynoteId: 'blk_1', daynoteKind: 'work' } }
  });
});

test('sanitizeBody: 허용 키만, 형식이 틀리면 null', () => {
  assert.equal(S.sanitizeBody(null), null);
  assert.equal(S.sanitizeBody([]), null);
  assert.equal(S.sanitizeBody(body({ start: undefined })), null);
  assert.equal(S.sanitizeBody(body({ end: { dateTime: '내일 3시' } })), null);
  const b = S.sanitizeBody(body({ location: '본사 3층', transparency: 'busy', summary: 42,
    start: { dateTime: '2026-10-05T10:00:00+09:00', timeZone: 'Asia/Seoul; DROP' },
    extendedProperties: { private: { daynoteId: 'x'.repeat(1025), daynoteKind: 'event' } } }));
  assert.equal(b.location, '본사 3층');
  assert.equal('transparency' in b, false);
  assert.equal('summary' in b, false);
  assert.deepEqual(b.start, { dateTime: '2026-10-05T10:00:00+09:00' });
  assert.deepEqual(b.extendedProperties, { private: { daynoteKind: 'event' } });
  assert.equal('id' in S.sanitizeBody(Object.assign(body(), { id: 'evil' })), false);
});

test('9. push 409 → GET → 같은 daynoteId 의 살아 있는 일정이면 adopted, 취소된 일정이면 id_taken', async () => {
  const live = setup((req) => {
    if (req.method === 'POST') return { status: 409, json: gErr(409, 'duplicate') };
    if (req.method === 'GET') return { status: 200, json: { id: 'dn626c6b5f31', status: 'confirmed', etag: '"e0"', updated: '2026-10-05T00:00:00.000Z', extendedProperties: { private: { daynoteId: 'blk_1' } } } };
    return { status: 200, json: { id: 'dn626c6b5f31', etag: '"e2"', updated: '2026-10-05T01:00:02.000Z' } };      // PATCH: 지금 본문으로 맞춘다
  });
  const r = await live.svc.push([insertOp()]);
  assert.deepEqual(r.results[0], { opId: 'op:blk_1', ok: true, eventId: 'dn626c6b5f31', etag: '"e2"', updated: '2026-10-05T01:00:02.000Z', adopted: true });
  assert.deepEqual(live.fetch.calls.map((c) => c.method), ['POST', 'GET', 'PATCH']);
  assert.equal(live.fetch.calls[1].url.pathname, evPath(EXPORT) + '/dn626c6b5f31');
  assert.equal(live.fetch.calls[2].url.searchParams.get('sendUpdates'), 'none');
  assert.equal('id' in JSON.parse(live.fetch.calls[2].body), false);

  const cancelled = setup((req) => (req.method === 'POST' ? { status: 409, json: gErr(409, 'duplicate') }
    : { status: 200, json: { id: 'dn626c6b5f31', status: 'cancelled', extendedProperties: { private: { daynoteId: 'blk_1' } } } }));
  const r2 = await cancelled.svc.push([insertOp()]);
  assert.equal(r2.results[0].ok, false);
  assert.equal(r2.results[0].error.type, 'id_taken');
  assert.deepEqual(cancelled.fetch.calls.map((c) => c.method), ['POST', 'GET']);
  const gone = setup((req) => (req.method === 'POST' ? { status: 409 } : { status: 410, json: gErr(410, 'deleted') }));
  assert.equal((await gone.svc.push([insertOp()])).results[0].error.type, 'id_taken');
  const other = setup((req) => (req.method === 'POST' ? { status: 409 } : { status: 200, json: { id: 'dn626c6b5f31', status: 'confirmed', extendedProperties: { private: { daynoteId: 'blk_9' } } } }));
  assert.equal((await other.svc.push([insertOp()])).results[0].error.type, 'id_taken');
});

test('10. push delete 가 204·410·404 면 모두 ok:true, patch 가 404·410 이면 gone', async () => {
  for (const status of [204, 410, 404]) {
    const t = setup(() => ({ status }));
    const r = await t.svc.push([{ opId: 'op:blk_2', op: 'delete', calendarId: EXPORT, eventId: 'dn626c6b5f32', daynoteId: 'blk_2' }]);
    assert.equal(r.results[0].ok, true, String(status));
    assert.equal(r.results[0].eventId, 'dn626c6b5f32');
    assert.equal(t.fetch.calls[0].method, 'DELETE');
    assert.equal(t.fetch.calls[0].url.pathname, evPath(EXPORT) + '/dn626c6b5f32');
    assert.equal(t.fetch.calls[0].url.searchParams.get('sendUpdates'), 'none');
  }
  for (const status of [404, 410]) {
    const t = setup(() => ({ status, json: gErr(status, 'notFound') }));
    const r = await t.svc.push([{ opId: 'op:blk_3', op: 'patch', calendarId: EXPORT, eventId: 'dn626c6b5f33', daynoteId: 'blk_3', body: body(), hash: 'h' }]);
    assert.equal(r.results[0].ok, false);
    assert.equal(r.results[0].error.type, 'gone', String(status));
    assert.equal(t.fetch.calls[0].method, 'PATCH');
  }
  const ok = setup(() => ({ status: 200, json: { id: 'dn626c6b5f33', etag: '"p"', updated: '2026-10-05T01:00:00.000Z' } }));
  const r = await ok.svc.push([{ opId: 'op:blk_3', op: 'patch', calendarId: EXPORT, eventId: 'dn626c6b5f33', body: body() }]);
  assert.deepEqual(r.results[0], { opId: 'op:blk_3', ok: true, eventId: 'dn626c6b5f33', etag: '"p"', updated: '2026-10-05T01:00:00.000Z' });
  // insert 가 404 → ‘Daynote’ 캘린더가 없다
  const miss = setup(() => ({ status: 404, json: gErr(404, 'notFound') }));
  const m = await miss.svc.push([insertOp()]);
  assert.equal(m.results[0].error.type, 'calendar_missing');
  assert.equal(m.results[0].error.message, 'Google에서 ‘Daynote’ 캘린더를 찾을 수 없어요.');
});

test('11. 다른 calendarId 로 push 하면 요청 없이 write_denied (다음 op 는 그대로 보낸다)', async () => {
  const t = setup(() => ({ status: 200, json: { id: 'dn626c6b5f31', etag: '"e"' } }));
  const r = await t.svc.push([insertOp({ opId: 'op:x', calendarId: 'primary' }), insertOp({ opId: 'op:y', eventId: 'DN-BAD' }), insertOp()]);
  assert.equal(r.results[0].error.type, 'write_denied');
  assert.equal(r.results[1].error.type, 'bad_request');            // base32hex 가 아닌 id
  assert.equal(r.results[2].ok, true);
  assert.equal(t.fetch.calls.length, 1);
  assert.equal(t.fetch.calls[0].url.pathname, evPath(EXPORT));
  // 내보내기 캘린더가 아직 없으면 모두 거부
  const none = setup(() => ({ status: 200, json: {} }), { auth: fakeAuth({ exportId: null }) });
  assert.equal((await none.svc.push([insertOp()])).results[0].error.type, 'write_denied');
  assert.equal(none.fetch.calls.length, 0);
  // 고아 delete 는 Google 식 id 도 허용
  const orphan = setup(() => ({ status: 204 }));
  const o = await orphan.svc.push([{ opId: 'op:orphan:abc_20261012T010000Z', op: 'delete', calendarId: EXPORT, eventId: 'abc_20261012T010000Z' }]);
  assert.equal(o.results[0].ok, true);
  // 50개 넘게는 받지 않는다
  assert.equal((await t.svc.push(new Array(51).fill(0).map(() => insertOp()))).error.type, 'bad_request');
  assert.equal((await t.svc.push('x')).ok, false);
});

test('12. ensureExportCalendar: preferId 확인 → 표식 캘린더 다시 쓰기 → 없으면 POST /calendars, 그리고 setExportCalendarId', async () => {
  const listed = (items) => ({ status: 200, json: { items } });
  // (가) preferId 가 owner 로 있으면 그대로
  const a = setup((req) => (req.url.pathname === '/calendar/v3/users/me/calendarList/' + encodeURIComponent(EXPORT)
    ? { status: 200, json: { id: EXPORT, summary: 'Daynote', accessRole: 'owner', timeZone: 'Asia/Seoul' } } : { status: 500 }), { auth: fakeAuth({ exportId: null }) });
  const ra = await a.svc.ensureExportCalendar({ tz: 'Asia/Seoul', preferId: EXPORT });
  assert.deepEqual(ra, { ok: true, calendar: { id: EXPORT, summary: 'Daynote', timeZone: 'Asia/Seoul' }, created: false });
  assert.deepEqual(a.auth.set, [EXPORT]);
  assert.equal(a.fetch.calls.length, 1);

  // (나) preferId 가 없어졌으면 표식이 있는 owner 캘린더를 찾는다 (숨긴 캘린더 포함)
  const b = setup((req) => {
    if (req.url.pathname.startsWith('/calendar/v3/users/me/calendarList/')) return { status: 404, json: gErr(404, 'notFound') };
    if (req.url.pathname === '/calendar/v3/users/me/calendarList') {
      return listed([
        { id: 'me@gmail.com', summary: '나', accessRole: 'owner', primary: true },
        { id: 'shared@group.calendar.google.com', summary: 'Daynote', accessRole: 'reader', description: '[daynote-export:v1]' },
        { id: 'again@group.calendar.google.com', summary: 'Daynote', accessRole: 'owner', description: 'Daynote가 만든 일정과 작업 시간이에요. [daynote-export:v1]', timeZone: 'Asia/Seoul' }
      ]);
    }
    return { status: 500 };
  }, { auth: fakeAuth({ exportId: null }) });
  const rb = await b.svc.ensureExportCalendar({ tz: 'Asia/Seoul', preferId: 'old@group.calendar.google.com' });
  assert.deepEqual(rb, { ok: true, calendar: { id: 'again@group.calendar.google.com', summary: 'Daynote', timeZone: 'Asia/Seoul' }, created: false });
  assert.equal(b.fetch.calls[1].url.searchParams.get('showHidden'), 'true');
  assert.deepEqual(b.auth.set, ['again@group.calendar.google.com']);
  assert.ok(!b.fetch.calls.some((c) => c.method === 'POST'));

  // (다) 없으면 새로 만든다
  const c = setup((req) => {
    if (req.method === 'POST') return { status: 200, json: { id: 'new@group.calendar.google.com', summary: 'Daynote', timeZone: 'Asia/Seoul' } };
    return listed([{ id: 'me@gmail.com', accessRole: 'owner', primary: true }]);
  }, { auth: fakeAuth({ exportId: null }) });
  const rc = await c.svc.ensureExportCalendar({ tz: 'Asia/Seoul', preferId: null });
  assert.deepEqual(rc, { ok: true, calendar: { id: 'new@group.calendar.google.com', summary: 'Daynote', timeZone: 'Asia/Seoul' }, created: true });
  const post = c.fetch.calls.find((x) => x.method === 'POST');
  assert.equal(post.url.href, BASE + '/calendars');
  assert.deepEqual(JSON.parse(post.body), { summary: 'Daynote',
    description: 'Daynote가 만든 일정과 작업 시간이에요. 이 캘린더를 지우면 Daynote가 올린 일정도 함께 지워져요. [daynote-export:v1]', timeZone: 'Asia/Seoul' });
  assert.deepEqual(c.auth.set, ['new@group.calendar.google.com']);
  assert.equal(c.auth.exportCalendarId(), 'new@group.calendar.google.com');

  // 만들 권한이 없으면 오류를 그대로 돌려주고 기록하지 않는다
  const d = setup((req) => (req.method === 'POST' ? { status: 403, json: gErr(403, 'insufficientPermissions') } : listed([])), { auth: fakeAuth({ exportId: null }) });
  const rd = await d.svc.ensureExportCalendar({ tz: 'Asia/Seoul' });
  assert.equal(rd.ok, false);
  assert.equal(rd.error.type, 'needs_scope');
  assert.deepEqual(d.auth.set, []);
});

test('13. listCalendars 는 페이지를 이어 받고(minAccessRole=freeBusyReader), 캘린더 경로가 404 면 calendar_missing', async () => {
  const t = setup((req) => (req.url.searchParams.get('pageToken') === 'c2'
    ? { status: 200, json: { items: [{ id: 'b' }] } }
    : { status: 200, json: { items: [{ id: 'a' }], nextPageToken: 'c2' } }));
  const r = await t.svc.listCalendars();
  assert.deepEqual(r, { ok: true, items: [{ id: 'a' }, { id: 'b' }] });
  assert.equal(t.fetch.calls[0].url.origin + t.fetch.calls[0].url.pathname, BASE + '/users/me/calendarList');
  assert.equal(t.fetch.calls[0].url.searchParams.get('minAccessRole'), 'freeBusyReader');
  assert.equal(t.fetch.calls[1].url.searchParams.get('pageToken'), 'c2');

  const m = setup(() => ({ status: 404, json: gErr(404, 'notFound') }));
  const rm = await m.svc.listEvents({ calendarId: 'gone@group.calendar.google.com', timeMin: TIME_MIN, timeMax: TIME_MAX });
  assert.equal(rm.ok, false);
  assert.equal(rm.error.type, 'calendar_missing');
  assert.equal(m.fetch.calls.length, 1);
});

// ---------------------------------------------------------------- 그 밖의 계약
test('listInstances: …/events/{id}/instances?timeMin&timeMax&maxResults&fields, 시리즈가 없으면 빈 목록', async () => {
  const t = setup(() => ({ status: 200, json: { items: [{ id: 'ser_20261012T010000Z', recurringEventId: 'ser' }] } }));
  const r = await t.svc.listInstances({ calendarId: 'primary', eventId: 'ser', timeMin: TIME_MIN, timeMax: TIME_MAX });
  assert.deepEqual(r, { ok: true, items: [{ id: 'ser_20261012T010000Z', recurringEventId: 'ser' }] });
  const c = t.fetch.calls[0];
  assert.equal(c.url.pathname, evPath('primary') + '/ser/instances');
  assert.equal(c.url.searchParams.get('timeMin'), TIME_MIN);
  assert.equal(c.url.searchParams.get('timeMax'), TIME_MAX);
  assert.equal(c.url.searchParams.get('maxResults'), '250');
  assert.equal(c.url.searchParams.get('fields'), S.EVENT_FIELDS);
  const g = setup(() => ({ status: 410, json: gErr(410, 'deleted') }));
  assert.deepEqual(await g.svc.listInstances({ calendarId: 'primary', eventId: 'ser', timeMin: TIME_MIN, timeMax: TIME_MAX }), { ok: true, items: [], gone: true });
  assert.equal((await t.svc.listInstances({ calendarId: 'primary', eventId: '' })).error.type, 'bad_request');
});

test('push: 레이트 리밋·네트워크 오류가 나면 같은 회차의 나머지 op 는 보내지 않고 같은 오류로 돌려준다', async () => {
  const t = setup(() => ({ status: 429, headers: { 'Retry-After': '120' } }));
  const ops = [insertOp({ opId: 'op:a' }), insertOp({ opId: 'op:b', eventId: 'dn626c6b5f32' }), { opId: 'op:c', op: 'delete', calendarId: EXPORT, eventId: 'dn626c6b5f33' }];
  const r = await t.svc.push(ops);
  assert.equal(r.ok, true);
  assert.deepEqual(r.results.map((x) => [x.opId, x.ok, x.error.type, x.error.retryAfterMs]), [
    ['op:a', false, 'rate_limit', 120000], ['op:b', false, 'rate_limit', 120000], ['op:c', false, 'rate_limit', 120000]]);
  assert.equal(r.results[1].skipped, true);
  assert.equal(t.fetch.calls.length, 1);
  const net = setup(() => { throw new TypeError('fetch failed'); });
  const rn = await net.svc.push(ops);
  assert.deepEqual(rn.results.map((x) => x.error.type), ['network', 'network', 'network']);
  assert.equal(net.fetch.calls.length, 4);                       // 첫 op 만 (1 + 재시도 3)
  // op 하나만의 오류(bad_request·gone)는 다음 op 를 막지 않는다
  const per = setup((req, n) => (n === 1 ? { status: 400, json: gErr(400, 'invalid') } : { status: 200, json: { id: 'x' } }));
  const rp = await per.svc.push(ops.slice(0, 2));
  assert.deepEqual(rp.results.map((x) => x.ok), [false, true]);
  assert.equal(rp.results[0].error.type, 'bad_request');
  assert.equal(rp.results[0].error.message, '일정 1개는 Google이 받지 않았어요. 시간을 확인해 주세요.');
  assert.ok(!JSON.stringify([r, rn, rp]).includes('ya29.'));
});

// ---------------------------------------------------------------- 검증에서 더한 것
const abortError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });

test('본문 읽기가 멈춰도 20초 제한 안이다: 헤더 뒤에 본문이 안 오면 timeout (영원히 기다리지 않는다)', async () => {
  const stall = (url, init) => Promise.resolve({ ok: true, status: 200, headers: { get: () => null },
    json: () => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(abortError())); }) });
  const svc = S.create({ auth: fakeAuth(), fetch: stall, sleep: async () => {}, requestTimeoutMs: 20 });
  const r = await svc.listEvents({ calendarId: 'primary', syncToken: 's' });
  assert.equal(r.ok, false);
  assert.equal(r.error.type, 'timeout');
  // push 도 같은 규칙 (본문이 멈춘 PATCH 응답)
  const p = await svc.push([{ opId: 'op:blk_3', op: 'patch', calendarId: EXPORT, eventId: 'dn626c6b5f33', body: body() }]);
  assert.equal(p.results[0].error.type, 'timeout');
});

test('읽기(GET) 2xx 인데 본문이 JSON 객체가 아니면 server 오류로 다시 시도 — "일정 0개"로 받아 전체 동기화가 지우지 않게', async () => {
  // 첫 응답은 빈 본문, 다시 시도하면 정상
  const t = setup((req, n) => (n === 1 ? { status: 200 } : { status: 200, json: { items: [{ id: 'a' }], nextSyncToken: 's2' } }));
  const r = await t.svc.listEvents({ calendarId: 'primary', timeMin: TIME_MIN, timeMax: TIME_MAX });
  assert.equal(r.ok, true);
  assert.deepEqual(r.items, [{ id: 'a' }]);
  assert.equal(r.nextSyncToken, 's2');
  assert.deepEqual(t.slept, [1000]);
  // 계속 깨진 본문(JSON 파싱 실패)이면 실패로 돌려준다 — 빈 성공이 아니다
  const broken = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new SyntaxError('Unexpected token <'); } });
  const slept = [];
  const svc = S.create({ auth: fakeAuth(), fetch: broken, sleep: async (ms) => { slept.push(ms); }, random: () => 0 });
  const rb = await svc.listEvents({ calendarId: 'primary', timeMin: TIME_MIN, timeMax: TIME_MAX });
  assert.equal(rb.ok, false);
  assert.equal(rb.error.type, 'server');
  assert.equal(rb.error.reason, 'invalid_json');
  assert.equal(rb.error.retryable, true);
  assert.deepEqual(slept, [1000, 2000, 4000]);
  const arr = setup(() => ({ status: 200, json: [] }));
  assert.equal((await arr.svc.listCalendars()).error.type, 'server');
  // 쓰기는 본문이 비어도 성공 (DELETE 200 · PATCH 200 빈 본문)
  const del = setup(() => ({ status: 200 }));
  const rd = await del.svc.push([{ opId: 'op:blk_2', op: 'delete', calendarId: EXPORT, eventId: 'dn626c6b5f32' },
    { opId: 'op:blk_3', op: 'patch', calendarId: EXPORT, eventId: 'dn626c6b5f33', body: body() }]);
  assert.deepEqual(rd.results.map((x) => x.ok), [true, true]);
  assert.deepEqual(del.slept, []);
});

test('patch 는 장소가 없으면 location:"" 로 보내 Google 에 남은 예전 장소를 지운다 (insert 는 키 없음)', async () => {
  const t = setup(() => ({ status: 200, json: { id: 'dn626c6b5f33', etag: '"p"' } }));
  const patch = (b) => ({ opId: 'op:blk_3', op: 'patch', calendarId: EXPORT, eventId: 'dn626c6b5f33', body: b });
  await t.svc.push([patch(body({ summary: '바쁨', description: 'Daynote 일정' }))]);      // 제목 올리기를 끈 일정 블록
  assert.equal(JSON.parse(t.fetch.calls[0].body).location, '');
  assert.equal(JSON.parse(t.fetch.calls[0].body).summary, '바쁨');
  await t.svc.push([patch(body({ location: '본사 3층' }))]);
  assert.equal(JSON.parse(t.fetch.calls[1].body).location, '본사 3층');
  await t.svc.push([insertOp()]);
  assert.equal('location' in JSON.parse(t.fetch.calls[2].body), false);
  assert.equal('location' in S.sanitizeBody(body()), false);           // sanitizeBody 자체는 허용 키만 남긴다
});

test('POST /calendars 는 네트워크 오류·5xx 뒤에 다시 보내지 않는다 (‘Daynote’ 캘린더가 둘 생기지 않게), 429 는 다시 보낸다', async () => {
  const listed = { status: 200, json: { items: [{ id: 'me@gmail.com', accessRole: 'owner', primary: true }] } };
  const net = setup((req) => { if (req.method === 'POST') throw new TypeError('fetch failed'); return listed; }, { auth: fakeAuth({ exportId: null }) });
  const rn = await net.svc.ensureExportCalendar({ tz: 'Asia/Seoul' });
  assert.equal(rn.ok, false);
  assert.equal(rn.error.type, 'network');
  assert.equal(net.fetch.calls.filter((c) => c.method === 'POST').length, 1);
  assert.deepEqual(net.slept, []);
  assert.deepEqual(net.auth.set, []);
  const s5 = setup((req) => (req.method === 'POST' ? { status: 503, json: gErr(503, 'backendError') } : listed), { auth: fakeAuth({ exportId: null }) });
  assert.equal((await s5.svc.ensureExportCalendar({ tz: 'Asia/Seoul' })).error.type, 'server');
  assert.equal(s5.fetch.calls.filter((c) => c.method === 'POST').length, 1);
  let posts = 0;
  const rl = setup((req) => {
    if (req.method !== 'POST') return listed;
    posts++;
    return posts === 1 ? { status: 429, json: gErr(429, 'rateLimitExceeded') } : { status: 200, json: { id: 'new@group.calendar.google.com', summary: 'Daynote' } };
  }, { auth: fakeAuth({ exportId: null }) });
  const rr = await rl.svc.ensureExportCalendar({ tz: 'Asia/Seoul' });
  assert.equal(rr.ok, true);
  assert.equal(rr.created, true);
  assert.equal(posts, 2);
  // 일정 insert 는 id 를 정해 보내므로(409 → 확인) 네트워크 오류 뒤에도 다시 보낸다
  const ins = setup((req, n) => { if (n === 1) throw new TypeError('fetch failed'); return { status: 200, json: { id: 'dn626c6b5f31', etag: '"e"' } }; });
  assert.equal((await ins.svc.push([insertOp()])).results[0].ok, true);
  assert.equal(ins.fetch.calls.length, 2);
});

test('409 이어받기: GET 과 PATCH 사이에 지워졌으면 id_taken (gone 이면 코어가 캘린더 없음으로 읽는다), PATCH 도 장소를 비운다', async () => {
  const raced = setup((req) => {
    if (req.method === 'POST') return { status: 409, json: gErr(409, 'duplicate') };
    if (req.method === 'GET') return { status: 200, json: { id: 'dn626c6b5f31', status: 'confirmed', etag: '"e0"', extendedProperties: { private: { daynoteId: 'blk_1' } } } };
    return { status: 404, json: gErr(404, 'notFound') };
  });
  const r = await raced.svc.push([insertOp()]);
  assert.equal(r.results[0].ok, false);
  assert.equal(r.results[0].error.type, 'id_taken');
  assert.deepEqual(raced.fetch.calls.map((c) => c.method), ['POST', 'GET', 'PATCH']);
  assert.equal(JSON.parse(raced.fetch.calls[2].body).location, '');
  // 다른 오류(레이트 리밋)는 그대로 전해 다음 회차에 다시 한다
  const rl = setup((req) => {
    if (req.method === 'POST') return { status: 409 };
    if (req.method === 'GET') return { status: 200, json: { id: 'dn626c6b5f31', status: 'confirmed', extendedProperties: { private: { daynoteId: 'blk_1' } } } };
    return { status: 429, headers: { 'Retry-After': '120' } };
  });
  assert.equal((await rl.svc.push([insertOp()])).results[0].error.type, 'rate_limit');
});

test('classifyHttpError: 상태 코드·reason·context 별 분류', () => {
  const c = (status, reason, context, headers) => S.classifyHttpError({ status, body: reason ? gErr(status, reason) : null, headers, context });
  const types = [
    [c(400, 'invalid', 'insert'), 'bad_request'], [c(401, 'authError', 'list'), 'auth'],
    [c(403, 'forbidden', 'insert'), 'write_denied'], [c(403, 'forbidden', 'list'), 'forbidden'],
    [c(404, 'notFound', 'list'), 'calendar_missing'], [c(404, 'notFound', 'calendar'), 'calendar_missing'],
    [c(404, 'notFound', 'patch'), 'gone'], [c(404, 'notFound', 'delete'), 'not_found'],
    [c(409, 'duplicate', 'insert'), 'conflict'], [c(410, 'fullSyncRequired', 'list'), 'sync_token_gone'], [c(410, 'deleted', 'patch'), 'gone'],
    [c(429, null, 'list'), 'rate_limit'], [c(500, null, 'list'), 'server'], [c(503, null, 'insert'), 'server']
  ];
  types.forEach(([e, want]) => assert.equal(e.type, want, JSON.stringify(e)));
  const e = c(429, 'rateLimitExceeded', 'list', { get: (k) => (k === 'retry-after' ? '30' : null) });
  assert.deepEqual(Object.keys(e).sort(), ['message', 'reason', 'retryAfterMs', 'retryable', 'status', 'type']);
  assert.equal(e.retryAfterMs, 30000);
  assert.equal(e.reason, 'rateLimitExceeded');
  assert.equal(e.status, 429);
  assert.equal(e.message, 'Google이 잠시 요청을 막았어요. 1분 뒤 다시 할게요.');
  assert.equal(c(400, 'x', 'insert').retryable, false);
  assert.equal(c(500, null, 'list').retryable, true);
});
