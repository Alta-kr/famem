'use strict';

// Google 캘린더 REST v3 실행기 — 메인 프로세스에서만 쓴다. "인증된 HTTP 실행기" 역할만 한다.
// 병합·충돌 규칙과 상태 저장은 렌더러(renderer/gcalsync.js)와 순수 코어(src/core/gcal.js)가 맡는다.
//
// - fetch 는 주입받는다 (main: electron net.fetch — 시스템 프록시·OS 인증서 저장소를 따른다, 테스트: 가짜 fetch).
// - 페이지 넘기기, 401 한 번 갱신 뒤 재시도, 429·5xx·네트워크 오류 재시도(1초·2초·4초 + 지터, Retry-After 우선), 오류 분류.
// - 쓰기는 auth.exportCalendarId() (앱이 만든 ‘Daynote’ 캘린더) 한 곳에만 한다. 본문은 sanitizeBody 로 허용 키만 남긴다.
// - require('electron') 금지. 토큰은 응답·오류·로그 어디에도 싣지 않는다.
//
// 설계: DAYNOTE_GOOGLE_DESIGN.md §7.1, §7.3.3, §7.3.6, §7.5, §8.6

const { redact } = require('./google-auth');

const EVENT_FIELDS = 'nextPageToken,nextSyncToken,timeZone,items(id,status,etag,updated,summary,location,htmlLink,eventType,'
  + 'transparency,start,end,recurringEventId,originalStartTime,attendees(self,responseStatus),extendedProperties/private)';
const MARKER = '[daynote-export:v1]';
const EXPORT_CALENDAR = {
  summary: 'Daynote',
  description: 'Daynote가 만든 일정과 작업 시간이에요. 이 캘린더를 지우면 Daynote가 올린 일정도 함께 지워져요. ' + MARKER
};
const MAX_PUSH = 50;
const QUOTA_RETRY_MS = 60 * 60 * 1000;
const RATE_LIMIT_DEFAULT_MS = 60 * 1000;
const MAX_INLINE_WAIT_MS = 30 * 1000;        // 이보다 긴 Retry-After 는 서비스 안에서 기다리지 않고 엔진에 넘긴다
const EVENT_ID_RE = /^[a-v0-9]{5,1024}$/;    // base32hex — Daynote 가 정한 id (G.eventIdFor)
const ANY_EVENT_ID_RE = /^[A-Za-z0-9_\-]{1,1024}$/;

// ApiError.type → 화면 문구 (§부록 A)
const MESSAGES = {
  auth: 'Google 로그인을 확인하지 못했어요. 다시 연결해 주세요.',
  reauth: 'Google 로그인이 만료됐어요. 다시 연결해 주세요.',
  needs_scope: '캘린더 권한이 허용되지 않았어요. 다시 연결할 때 모든 항목에 체크해 주세요.',
  forbidden: '이 캘린더를 볼 권한이 없어요.',
  write_denied: '‘Daynote’ 캘린더에 쓸 권한이 없어요. 다시 연결해 주세요.',
  not_found: 'Google에서 일정을 찾을 수 없어요.',
  calendar_missing: 'Google에서 캘린더를 찾을 수 없어요.',
  gone: 'Google에서 지워진 일정이에요.',
  sync_token_gone: '동기화 기준이 만료돼 처음부터 다시 받아요.',
  too_many_changes: '바뀐 일정이 너무 많아 처음부터 다시 받아요.',
  rate_limit: 'Google이 잠시 요청을 막았어요. 잠시 뒤 다시 할게요.',
  quota: '오늘 쓸 수 있는 Google 요청량을 다 썼어요. 잠시 뒤 다시 할게요.',
  server: 'Google 서버 문제로 동기화하지 못했어요. 잠시 뒤 다시 할게요.',
  network: '인터넷에 연결되지 않아 동기화를 미뤘어요. 연결되면 다시 할게요.',
  timeout: '인터넷에 연결되지 않아 동기화를 미뤘어요. 연결되면 다시 할게요.',
  bad_request: '일정 1개는 Google이 받지 않았어요. 시간을 확인해 주세요.',
  conflict: '같은 id 의 일정이 이미 있어요.',
  id_taken: '지워진 일정 id 는 다시 쓸 수 없어요. 새 id 로 다시 올릴게요.',
  not_signed_in: 'Google 계정이 연결되어 있지 않아요.',
  unknown: '알 수 없는 오류로 동기화하지 못했어요.'
};
const RETRYABLE = new Set(['rate_limit', 'quota', 'server', 'network', 'timeout', 'id_taken', 'too_many_changes', 'sync_token_gone']);
const API_TYPES = new Set(Object.keys(MESSAGES));
// 이 오류가 나면 같은 회차의 나머지 op 도 같은 결과가 된다 → 요청하지 않고 같은 오류로 돌려준다
const STOP_TYPES = new Set(['rate_limit', 'quota', 'auth', 'reauth', 'not_signed_in', 'needs_scope', 'calendar_missing',
  'write_denied', 'network', 'timeout', 'server', 'unknown']);

function apiError(type, extra = {}) {
  const t = API_TYPES.has(type) ? type : 'unknown';
  const e = {
    type: t,
    status: extra.status != null ? extra.status : 0,
    reason: extra.reason || '',
    retryable: extra.retryable != null ? extra.retryable : RETRYABLE.has(t),
    retryAfterMs: extra.retryAfterMs != null ? extra.retryAfterMs : null,
    message: extra.message || MESSAGES[t]
  };
  if (t === 'rate_limit' && e.retryAfterMs != null) {
    e.message = 'Google이 잠시 요청을 막았어요. ' + Math.max(1, Math.ceil(e.retryAfterMs / 60000)) + '분 뒤 다시 할게요.';
  }
  return e;
}

// Retry-After: 초 또는 HTTP 날짜 → ms | null
function retryAfterOf(headers, nowMs) {
  const v = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const at = Date.parse(s);
  if (isNaN(at)) return null;
  return Math.max(0, at - (nowMs != null ? nowMs : Date.now()));
}

// Google 오류 본문에서 reason 들을 모은다: error.errors[].reason, error.details[].reason, error.status, (OAuth 식) error 문자열
function reasonsOf(body) {
  const out = [];
  const e = body && body.error;
  if (!e) return out;
  if (typeof e === 'string') { out.push(e); return out; }
  (Array.isArray(e.errors) ? e.errors : []).forEach((x) => { if (x && x.reason) out.push(String(x.reason)); });
  (Array.isArray(e.details) ? e.details : []).forEach((x) => { if (x && x.reason) out.push(String(x.reason)); });
  if (e.status) out.push(String(e.status));
  return out;
}

const WRITE_CONTEXTS = new Set(['insert', 'patch', 'delete', 'create']);

// HTTP 상태 + 본문 → ApiError
//   context: 'list'(일정 목록) | 'insert' | 'patch' | 'delete' | 'calendar'(캘린더 경로) | 'instances' | 'get' | 'create'
function classifyHttpError({ status, body, headers, context, now } = {}) {
  const reasons = reasonsOf(body);
  const has = (...names) => reasons.some((r) => names.includes(r));
  const reason = reasons[0] || '';
  const retryAfterMs = retryAfterOf(headers, now);
  const base = { status, reason };
  if (status === 400) return apiError('bad_request', base);
  if (status === 401) return apiError('auth', base);
  if (status === 403) {
    if (has('rateLimitExceeded', 'userRateLimitExceeded', 'RATE_LIMIT_EXCEEDED')) {
      return apiError('rate_limit', Object.assign({}, base, { retryAfterMs: retryAfterMs != null ? retryAfterMs : RATE_LIMIT_DEFAULT_MS }));
    }
    if (has('quotaExceeded', 'dailyLimitExceeded', 'RESOURCE_EXHAUSTED')) {
      return apiError('quota', Object.assign({}, base, { retryAfterMs: retryAfterMs != null ? retryAfterMs : QUOTA_RETRY_MS }));
    }
    if (has('insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'insufficientScopes')) return apiError('needs_scope', base);
    if (WRITE_CONTEXTS.has(context)) return apiError('write_denied', base);
    return apiError('forbidden', base);
  }
  if (status === 404) {
    if (context === 'list' || context === 'calendar' || context === 'insert' || context === 'create') return apiError('calendar_missing', base);
    if (context === 'patch') return apiError('gone', base);
    return apiError('not_found', base);
  }
  if (status === 409 || status === 412) return apiError('conflict', base);
  if (status === 410) {
    if (context === 'list') return apiError('sync_token_gone', base);
    return apiError('gone', base);
  }
  if (status === 429) {
    return apiError('rate_limit', Object.assign({}, base, { retryAfterMs: retryAfterMs != null ? retryAfterMs : RATE_LIMIT_DEFAULT_MS }));
  }
  if (status >= 500) return apiError('server', Object.assign({}, base, { retryAfterMs }));
  if (status >= 400) return apiError('bad_request', base);
  return apiError('unknown', base);
}

// 보낼 본문의 허용 키만 남긴다. 형식이 틀리면 null.
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const TZ_RE = /^[A-Za-z0-9_+\-\/]{1,64}$/;
const PRIVATE_KEY_RE = /^daynote[A-Za-z0-9_]{0,40}$/;
function sanitizeTime(t) {
  if (!t || typeof t !== 'object' || typeof t.dateTime !== 'string' || !DATE_TIME_RE.test(t.dateTime)) return null;
  const out = { dateTime: t.dateTime };
  if (typeof t.timeZone === 'string' && TZ_RE.test(t.timeZone)) out.timeZone = t.timeZone;
  return out;
}
function sanitizeBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const out = {};
  ['summary', 'description', 'location'].forEach((k) => {
    if (typeof body[k] === 'string') out[k] = body[k].slice(0, 8192);
  });
  const start = sanitizeTime(body.start);
  const end = sanitizeTime(body.end);
  if (!start || !end) return null;
  out.start = start;
  out.end = end;
  if (body.transparency === 'opaque' || body.transparency === 'transparent') out.transparency = body.transparency;
  if (body.reminders && typeof body.reminders === 'object' && typeof body.reminders.useDefault === 'boolean') {
    out.reminders = { useDefault: body.reminders.useDefault };
  }
  const priv = body.extendedProperties && body.extendedProperties.private;
  if (priv && typeof priv === 'object' && !Array.isArray(priv)) {
    const p = {};
    Object.keys(priv).forEach((k) => {
      const v = priv[k];
      if (PRIVATE_KEY_RE.test(k) && typeof v === 'string' && v.length <= 1024) p[k] = v;
    });
    if (Object.keys(p).length) out.extendedProperties = { private: p };
  }
  return out;
}

function create(opts = {}) {
  const {
    auth,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
    random = Math.random,
    base = 'https://www.googleapis.com/calendar/v3',
    pageSize = 250, maxPages = 40, retries = 3,
    requestTimeoutMs = 20000,
    log = () => {}
  } = opts;
  if (!auth || typeof auth.getAccessToken !== 'function') throw new Error('gcal.create: auth 가 필요해요.');
  const fetchFn = opts.fetch || ((u, init) => globalThis.fetch(u, init));
  const nowMs = () => (typeof now === 'function' ? now() : Date.now());
  const say = (msg) => { try { log(redact(msg)); } catch (e) {} };
  const enc = encodeURIComponent;
  const calPath = (cid) => base + '/calendars/' + enc(cid);
  const exportId = () => (typeof auth.exportCalendarId === 'function' ? auth.exportCalendarId() : null) || null;

  function url(p, query) {
    const q = new URLSearchParams();
    Object.keys(query || {}).forEach((k) => { const v = query[k]; if (v != null && v !== '') q.set(k, String(v)); });
    const s = q.toString();
    return s ? p + '?' + s : p;
  }
  const backoff = (attempt) => Math.round(1000 * Math.pow(2, attempt - 1) + random() * 500);

  // 요청 1건: 토큰 → fetch(20초 제한, 본문 읽기까지) → 401 이면 한 번 갱신 → 429·403 rate·5xx·네트워크면 최대 retries 번 다시
  //   POST /calendars(context 'create')는 멱등이 아니다 — 네트워크 오류·5xx 뒤에 다시 보내면 ‘Daynote’ 캘린더가 둘 생길 수 있어
  //   서비스 안에서는 다시 보내지 않는다 (다음 회차의 ensureExportCalendar 가 표식으로 먼저 찾는다). 429·rate 403 은 처리 전 거절이라 다시 보낸다.
  async function send(method, u, { body, context } = {}) {
    const unsafe = context === 'create';
    let attempt = 0;
    let forced = false;
    let force = false;
    for (;;) {
      const tk = await auth.getAccessToken(force ? { forceRefresh: true } : {});
      force = false;
      if (!tk || !tk.ok) {
        const t = tk && tk.error && tk.error.type;
        const type = t === 'reauth' || t === 'invalid_grant' ? 'reauth'
          : t === 'not_signed_in' ? 'not_signed_in'
            : t === 'network' ? 'network'
              : t === 'server' ? 'server' : 'auth';
        return { ok: false, error: apiError(type, { message: type === 'auth' && tk && tk.error && tk.error.message ? tk.error.message : undefined }) };
      }
      const headers = { Authorization: 'Bearer ' + tk.accessToken, Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ac ? setTimeout(() => ac.abort(), requestTimeoutMs) : null;
      let res;
      let json = null;
      let badJson = false;
      try {
        res = await fetchFn(u, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ac ? ac.signal : undefined });
        // 본문 읽기도 20초 제한 안에서 한다 (헤더만 오고 본문이 멈추면 영원히 기다리지 않게)
        if (res.status !== 204) {
          try { json = await res.json(); }
          catch (e) { if (ac && ac.signal.aborted) throw e; json = null; badJson = true; }
        }
      } catch (e) {
        if (timer) clearTimeout(timer);
        if (ac && ac.signal.aborted) {
          say('gcal ' + method + ' ' + context + ': timeout');
          return { ok: false, error: apiError('timeout') };
        }
        say('gcal ' + method + ' ' + context + ': network ' + ((e && e.message) || e));
        if (!unsafe && attempt < retries) { attempt++; await sleep(backoff(attempt)); continue; }
        return { ok: false, error: apiError('network') };
      }
      if (timer) clearTimeout(timer);
      let err;
      if (res.ok) {
        // 읽기(GET)는 JSON 객체가 와야 쓸 수 있다. 빈·깨진 본문을 "일정 0개"로 받으면 전체 동기화가 그 캘린더 일정을 모두 지운다.
        if (method !== 'GET' || (json && typeof json === 'object' && !Array.isArray(json))) return { ok: true, status: res.status, json };
        err = apiError('server', { status: res.status, reason: badJson ? 'invalid_json' : 'empty_body' });
      } else {
        if (res.status === 401 && !forced) { forced = true; force = true; continue; }
        err = classifyHttpError({ status: res.status, body: json, headers: res.headers, context, now: nowMs() });
      }
      say('gcal ' + method + ' ' + context + ': ' + res.status + ' ' + err.type + (err.reason ? ' ' + err.reason : ''));
      if ((err.type === 'rate_limit' || (err.type === 'server' && !unsafe)) && attempt < retries) {
        const hinted = retryAfterOf(res.headers, nowMs());
        if (hinted == null || hinted <= MAX_INLINE_WAIT_MS) {
          attempt++;
          await sleep(hinted != null ? hinted : backoff(attempt));
          continue;
        }
      }
      return { ok: false, error: err, status: res.status, json };
    }
  }

  // 페이지 이어 받기 — nextPageToken 이 없을 때까지. maxPages 를 넘으면 too_many_changes.
  async function pages(p, query, context, onPage) {
    let pageToken = null;
    let n = 0;
    for (;;) {
      if (n >= maxPages) return { ok: false, error: apiError('too_many_changes') };
      const r = await send('GET', url(p, Object.assign({}, query, { pageToken })), { context });
      if (!r.ok) return r;
      n++;
      const j = r.json || {};
      onPage(j, n);
      if (!j.nextPageToken) return { ok: true, pages: n, last: j };
      pageToken = j.nextPageToken;
    }
  }

  async function listCalendarEntries(extra) {
    const items = [];
    const r = await pages(base + '/users/me/calendarList', Object.assign({ minAccessRole: 'freeBusyReader', maxResults: pageSize }, extra), 'calendar',
      (j) => { (Array.isArray(j.items) ? j.items : []).forEach((x) => items.push(x)); });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, items };
  }

  function listCalendars() { return listCalendarEntries({}); }

  async function listEvents(req) {
    req = req && typeof req === 'object' ? req : {};
    const calendarId = typeof req.calendarId === 'string' ? req.calendarId : '';
    if (!calendarId) return { ok: false, error: apiError('bad_request') };
    const syncToken = typeof req.syncToken === 'string' && req.syncToken ? req.syncToken : null;
    const query = { singleEvents: 'true', maxResults: pageSize, fields: EVENT_FIELDS };
    if (syncToken) query.syncToken = syncToken;                     // 증분: timeMin·timeMax·orderBy 와 함께 쓸 수 없다
    else { query.timeMin = req.timeMin || null; query.timeMax = req.timeMax || null; }
    const items = [];
    let timeZone = null;
    const r = await pages(calPath(calendarId) + '/events', query, 'list', (j) => {
      if (timeZone == null && typeof j.timeZone === 'string') timeZone = j.timeZone;
      (Array.isArray(j.items) ? j.items : []).forEach((x) => items.push(x));
    });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, items, nextSyncToken: r.last.nextSyncToken || null, full: !syncToken, pages: r.pages, timeZone };
  }

  async function listInstances(req) {
    req = req && typeof req === 'object' ? req : {};
    const calendarId = typeof req.calendarId === 'string' ? req.calendarId : '';
    const eventId = typeof req.eventId === 'string' ? req.eventId : '';
    if (!calendarId || !ANY_EVENT_ID_RE.test(eventId)) return { ok: false, error: apiError('bad_request') };
    const items = [];
    const r = await pages(calPath(calendarId) + '/events/' + enc(eventId) + '/instances',
      { timeMin: req.timeMin || null, timeMax: req.timeMax || null, maxResults: pageSize, fields: EVENT_FIELDS }, 'instances',
      (j) => { (Array.isArray(j.items) ? j.items : []).forEach((x) => items.push(x)); });
    if (!r.ok) {
      // 시리즈가 이미 없으면 창 안의 인스턴스도 없다
      if (r.error && (r.error.type === 'not_found' || r.error.type === 'gone')) return { ok: true, items: [], gone: true };
      return { ok: false, error: r.error };
    }
    return { ok: true, items };
  }

  // ‘Daynote’ 캘린더 확보 (§7.3.6): preferId 확인 → 표식으로 다시 찾기 → 새로 만들기 → auth 에 기록
  async function ensureExportCalendar(req) {
    req = req && typeof req === 'object' ? req : {};
    const tz = typeof req.tz === 'string' && TZ_RE.test(req.tz) ? req.tz : 'Asia/Seoul';
    const preferId = typeof req.preferId === 'string' && req.preferId ? req.preferId : null;
    let found = null;
    let created = false;
    if (preferId) {
      const r = await send('GET', base + '/users/me/calendarList/' + enc(preferId), { context: 'calendar' });
      // 기본(primary) 캘린더는 내보내기 대상이 될 수 없다 — 쓰기 화이트리스트가 사용자 캘린더로 넓어지지 않게
      if (r.ok) { if (r.json && r.json.accessRole === 'owner' && !r.json.primary) found = r.json; }
      else if (r.error.type !== 'calendar_missing' && r.error.type !== 'not_found' && r.error.type !== 'forbidden') return { ok: false, error: r.error };
    }
    if (!found) {
      const l = await listCalendarEntries({ showHidden: 'true' });
      if (!l.ok) return { ok: false, error: l.error };
      found = l.items.find((c) => c && c.accessRole === 'owner' && !c.primary && typeof c.description === 'string' && c.description.indexOf(MARKER) >= 0) || null;
    }
    if (!found) {
      const r = await send('POST', base + '/calendars', { body: { summary: EXPORT_CALENDAR.summary, description: EXPORT_CALENDAR.description, timeZone: tz }, context: 'create' });
      if (!r.ok) return { ok: false, error: r.error };
      found = r.json || {};
      created = true;
    }
    if (!found.id) return { ok: false, error: apiError('unknown') };
    if (typeof auth.setExportCalendarId === 'function') auth.setExportCalendarId(found.id);
    return { ok: true, calendar: { id: found.id, summary: found.summaryOverride || found.summary || EXPORT_CALENDAR.summary, timeZone: found.timeZone || tz }, created };
  }

  // ---------------- 쓰기
  const okResult = (op, j, extra) => Object.assign({ opId: op.opId, ok: true, eventId: (j && j.id) || op.eventId, etag: (j && j.etag) || null, updated: (j && j.updated) || null }, extra || {});
  const errResult = (op, error) => ({ opId: op.opId, ok: false, error });

  async function pushOne(op) {
    if (!op || typeof op !== 'object') return errResult({ opId: null }, apiError('bad_request'));
    const cid = exportId();
    if (!cid || op.calendarId !== cid) return errResult(op, apiError('write_denied'));          // 쓰기 화이트리스트
    const orphan = typeof op.opId === 'string' && op.opId.indexOf('op:orphan:') === 0;
    const idOk = typeof op.eventId === 'string' && (orphan && op.op === 'delete' ? ANY_EVENT_ID_RE : EVENT_ID_RE).test(op.eventId);
    if (!idOk) return errResult(op, apiError('bad_request'));
    const evPath = calPath(cid) + '/events';
    const one = evPath + '/' + enc(op.eventId);
    const missing = (e) => (e.type === 'calendar_missing' ? apiError('calendar_missing', { status: e.status, reason: e.reason, message: 'Google에서 ‘Daynote’ 캘린더를 찾을 수 없어요.' }) : e);

    if (op.op === 'delete') {
      const r = await send('DELETE', url(one, { sendUpdates: 'none' }), { context: 'delete' });
      if (r.ok || r.status === 404 || r.status === 410) return okResult(op, null);           // 이미 없으면 성공
      return errResult(op, missing(r.error));
    }
    const body = sanitizeBody(op.body);
    if (!body) return errResult(op, apiError('bad_request'));
    // PATCH 는 보낸 필드만 바꾼다. 코어 본문은 장소가 없으면(제목 올리기 끔·장소 지움·작업 블록) location 키를 빼므로
    // 그대로 보내면 Google 에 예전 장소가 남는다 → 빈 문자열로 명시해 지운다. (remoteHash 는 '' 와 없음을 같게 본다)
    const patchBody = Object.assign({}, body);
    if (typeof patchBody.location !== 'string') patchBody.location = '';

    if (op.op === 'patch') {
      const r = await send('PATCH', url(one, { sendUpdates: 'none' }), { body: patchBody, context: 'patch' });
      if (r.ok) return okResult(op, r.json);
      return errResult(op, missing(r.error));
    }
    if (op.op === 'insert') {
      const r = await send('POST', url(evPath, { sendUpdates: 'none' }), { body: Object.assign({ id: op.eventId }, body), context: 'insert' });
      if (r.ok) return okResult(op, r.json);
      if (r.error.type !== 'conflict') return errResult(op, missing(r.error));
      // 409: 이 id 가 이미 있다 → 확인. 내가 올린 살아 있는 일정이면 이어받고(adopted), 지워진 id 면 id_taken
      const g = await send('GET', url(one, { fields: 'id,status,etag,updated,extendedProperties/private' }), { context: 'get' });
      if (!g.ok) {
        if (g.status === 404 || g.status === 410) return errResult(op, apiError('id_taken', { status: 409 }));
        return errResult(op, g.error);
      }
      const ev = g.json || {};
      const priv = (ev.extendedProperties && ev.extendedProperties.private) || {};
      if (ev.status === 'cancelled' || !op.daynoteId || priv.daynoteId !== op.daynoteId) return errResult(op, apiError('id_taken', { status: 409 }));
      // 응답을 못 받은 첫 insert 뒤에 블록이 또 바뀌었을 수 있다 → 지금 본문으로 맞춰 둔다 (링크 해시 = 보낸 본문)
      const p = await send('PATCH', url(one, { sendUpdates: 'none' }), { body: patchBody, context: 'patch' });
      if (p.ok) return okResult(op, p.json, { adopted: true });
      // GET 과 PATCH 사이에 지워졌다 → 그 id 는 다시 못 쓴다. (insert op 의 'gone' 은 코어가 캘린더 없음으로 읽으므로 id_taken 으로 바꾼다)
      if (p.error && (p.error.type === 'gone' || p.error.type === 'not_found')) return errResult(op, apiError('id_taken', { status: 409 }));
      return errResult(op, missing(p.error));
    }
    return errResult(op, apiError('bad_request'));
  }

  async function push(ops) {
    if (!Array.isArray(ops) || ops.length > MAX_PUSH) return { ok: false, error: apiError('bad_request') };
    const results = [];
    let stop = null;
    for (const op of ops) {
      if (stop) { results.push(Object.assign(errResult(op || { opId: null }, stop), { skipped: true })); continue; }
      let r;
      try { r = await pushOne(op); }
      catch (e) { say('gcal push: ' + ((e && e.message) || e)); r = errResult(op || { opId: null }, apiError('unknown')); }
      results.push(r);
      // 요청 없이 거른 op(화이트리스트·형식)는 그 op 만의 문제다 — status 0 인 write_denied 는 멈추지 않는다
      if (!r.ok && STOP_TYPES.has(r.error.type) && !(r.error.type === 'write_denied' && !r.error.status)) stop = r.error;
    }
    return { ok: true, results };
  }

  return { listCalendars, ensureExportCalendar, listEvents, listInstances, push };
}

module.exports = { create, classifyHttpError, sanitizeBody, EVENT_FIELDS };
