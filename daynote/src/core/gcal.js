'use strict';

// Google 캘린더 동기화 규칙 (순수 모듈). 네트워크·시계·DOM 을 모른다 — 지금 시각은 항상 인자(now · ctx.now)로 받는다.
//
// 상태는 state.gcal 한 조각에만 둔다 (되돌리기 대상이 아니다 — store.js KEEP_ON_UNDO).
//   { v, accountId, settings:{exportEnabled, exportWork, exportTitles}, calendars:[CalendarEntry], exportCalendarId,
//     events:[GEvent], links:{ [blockId]: Link }, gens:{ [blockId]: n }, outbox:[OutboxEntry], backoffUntil, lastSyncAt, lastError }
//   토큰·비밀값·인가 코드는 절대 이 조각에 넣지 않는다. 일정 설명(description)과 참석자 목록도 저장하지 않는다.
//
// ── 가져오기 (Daynote 캘린더가 아닌 캘린더) ─────────────────────────────
//   창은 로컬 자정(now−7일) ~ 로컬 자정(now+61일). 첫 동기화는 전체, 그 뒤는 syncToken 증분.
//   planPull(계획, 상태를 바꾸지 않음) → applyPull(반영, mutator). 바쁨 규칙: 종일·한가함(transparent)은 바쁨이 아니고,
//   workingLocation·birthday·내가 거절한 일정은 아예 저장하지 않는다. 참석 미정·응답 전은 바쁨이다.
//
// ── 내보내기 (Daynote 블록 → 전용 ‘Daynote’ 캘린더) ─────────────────────
//   reconcile 이 "지금 블록"과 "링크(마지막으로 올린 것)"를 비교해 insert·patch·delete 를 outbox 에 맞춰 둔다 (멱등).
//   dueOps 는 지금 보낼 항목의 본문을 그때그때 계산한다 (outbox 에 본문을 저장하지 않는다 — 대기 중에 바뀐 최신 값이 올라간다).
//   이벤트 id 는 블록 id 에서 결정적으로 만든다(eventIdFor) — 응답을 못 받고 다시 보내도 일정이 두 개 생기지 않는다.
//   export 를 끈 뒤에도 disableExport({removeFuture:true}) 가 넣은 delete(drain:true)는 계속 보낸다.
//   reconcile·dueOps 는 꺼진 상태에서 불러도 안전하다 (reconcile 은 아무것도 안 하고, dueOps 는 drain 항목만 돌려준다).
//   ‘Daynote’ 캘린더가 없어지거나 쓸 수 없으면(calendar_missing·write_denied) 한 번에 한 항목만 시험 삼아 보낸다.
//
// ── 되읽기 (‘Daynote’ 캘린더 → Daynote, 양방향) ─────────────────────────
//   planOwnPull → applyOwnPull(조용히) + applyRemoteDeletes(라벨 있는 mutate 안에서 — 되돌릴 수 있다).
//   충돌은 링크에 저장한 기준값(본문 해시·etag)과 비교하는 3방향 규칙: 양쪽 다 바뀌면 Daynote 가 이긴다.
//   Google 의 취소가 Daynote 가 보낸 delete 의 메아리일 수 있으면(올릴 대상이 아닌 블록 · delete 대기 중) 블록은 절대 지우지 않는다.
//   409 adopted 로 맺은 링크는 Google 내용을 모르므로 해시를 비워 두어 다음 reconcile 이 한 번 patch 로 맞춘다.
//
// ctx = { now: Date|ISO, deviceId: string, tz: string, selfEmail?: string, random?: () => number }
// OutboxEntry = { id:'op:'+blockId | 'op:orphan:'+eventId, op, blockId, eventId, calendarId, attempts, nextAt, lastError, createdAt, drain? }

(function (factory) {
  var deps = (typeof module !== 'undefined' && module.exports)
    ? { dates: require('./dates'), model: require('./model') }
    : { dates: window.Daynote.dates, model: window.Daynote.model };
  var api = factory(deps.dates, deps.model);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.gcal = api; }
})(function (D, M) {
  var WINDOW_PAST_DAYS = 7;
  var WINDOW_FUTURE_DAYS = 60;
  var RESYNC_DRIFT_DAYS = 7;
  var FULL_SYNC_MAX_AGE_DAYS = 7;
  var EXPORT_PAST_HOURS = 24;
  var LINK_KEEP_DAYS = 30;
  var MAX_ATTEMPTS = 8;
  var MARKER = 'daynote-export:v1';

  var MINUTE = 60000;
  var HOUR = 60 * MINUTE;
  var DAY_MS = 24 * HOUR;
  var BACKOFF_BASE_MS = 15000;
  var BACKOFF_MAX_MS = 30 * MINUTE;
  var AFTER_MAX_MS = 6 * HOUR;          // MAX_ATTEMPTS 를 넘긴 뒤에도 버리지 않고 이 간격으로 계속 시도한다
  var HOLD_MS = 24 * HOUR;              // 다시 보내도 안 되는 오류(bad_request 등)는 하루 뒤에
  var DUE_LIMIT = 25;
  var TEXT_MAX = 300;
  var DESC_WORK = 'Daynote 작업 시간';
  var DESC_EVENT = 'Daynote 일정';
  var ORPHAN = 'op:orphan:';

  // 오류 type 묶음 (services/gcal.js 의 ApiError.type)
  var RATE = { rate_limit: true, quota: true };
  var STOP_OF = { calendar_missing: 'calendar_missing', write_denied: 'write_denied', forbidden: 'write_denied', needs_scope: 'write_denied' };
  var STOP_TYPES = { calendar_missing: true, write_denied: true };
  var GONE = { gone: true, not_found: true };
  var AUTH = { auth: true, reauth: true, not_signed_in: true, unavailable: true };
  var RETRY = { network: true, server: true, timeout: true, conflict: true, unknown: true };

  // ------------------------------------------------------------------ 작은 도우미
  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  function arr(x) { return Array.isArray(x) ? x : []; }
  function ms(x) {
    if (x == null || x === '') return NaN;
    return (x instanceof Date ? x : new Date(x)).getTime();
  }
  function iso(t) { return new Date(t).toISOString(); }
  function isoOrNull(x) { var t = ms(x); return isNaN(t) ? null : iso(t); }
  function needNow(v) {
    var t = ms(v);
    if (isNaN(t)) throw new TypeError('gcal: 지금 시각(now)을 넘겨야 해요.');
    return t;
  }
  function nowOf(ctx) { return needNow(ctx && ctx.now); }
  // 초 단위로 자른 UTC 'YYYY-MM-DDTHH:MM:SSZ'
  function sec(x) {
    var t = ms(x);
    if (isNaN(t)) return null;
    return iso(Math.floor(t / 1000) * 1000).slice(0, 19) + 'Z';
  }
  function isYmd(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function cut(s) { s = String(s == null ? '' : s); return s.length > TEXT_MAX ? s.slice(0, TEXT_MAX) : s; }
  function isNewer(a, b) { var x = ms(a), y = ms(b); return !isNaN(x) && !isNaN(y) && x > y; }
  function index(list) {
    var map = {};
    arr(list).forEach(function (x) { if (x && x.id) map[x.id] = x; });
    return map;
  }
  function kindOf(b) { return b.kind || (b.taskId ? 'work' : 'event'); }
  function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  // UTF-8 바이트 (eventIdFor·fnv1a 가 같은 바이트를 본다)
  function utf8(s) {
    var out = [];
    s = String(s);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }
  function hex2(b) { return (b < 16 ? '0' : '') + b.toString(16); }
  function utf8Hex(s) { return utf8(s).map(hex2).join(''); }

  // FNV-1a 32비트 → 8자리 16진수 (suggest 에 의존하지 않으려고 따로 둔다). 곱셈은 자리 이동으로 정확하게 한다.
  function fnv1a(s) {
    var h = 0x811c9dc5;
    var bytes = utf8(s);
    for (var i = 0; i < bytes.length; i++) {
      h = (h ^ bytes[i]) >>> 0;
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    var out = h.toString(16);
    while (out.length < 8) out = '0' + out;
    return out;
  }

  function randOf(ctx) {
    if (ctx && typeof ctx.random === 'function') return ctx.random();
    if (ctx && typeof ctx.rand === 'number') return ctx.rand;
    return Math.random();
  }

  // ------------------------------------------------------------------ 상태 조각
  function emptyGcal() {
    return {
      v: 1, accountId: null, settings: { exportEnabled: true, exportWork: true, exportTitles: true },
      calendars: [], exportCalendarId: null, events: [], links: {}, gens: {}, outbox: [],
      backoffUntil: null, lastSyncAt: null, lastError: null
    };
  }

  // 빠진 키를 채운다 (멱등). 옛 emptyState() 로 만든 상태(gcal 없음)에서도 동작한다. → state.gcal
  function ensure(state) {
    var E = emptyGcal();
    if (!isObj(state.gcal)) { state.gcal = E; return E; }
    var g = state.gcal;
    Object.keys(E).forEach(function (k) {
      if (k === 'settings') {
        if (!isObj(g.settings)) { g.settings = E.settings; return; }
        Object.keys(E.settings).forEach(function (sk) {
          if (typeof g.settings[sk] !== 'boolean') g.settings[sk] = E.settings[sk];
        });
      } else if (Array.isArray(E[k])) {
        if (!Array.isArray(g[k])) g[k] = [];
      } else if (isObj(E[k])) {
        if (!isObj(g[k])) g[k] = {};
      } else if (g[k] === undefined) {
        g[k] = E[k];
      }
    });
    return g;
  }

  // 읽기 전용 보기 — 계획(plan*)·dueOps·summary 처럼 상태를 바꾸면 안 되는 곳에서 쓴다
  function view(state) {
    var g = state && isObj(state.gcal) ? state.gcal : {};
    var s = isObj(g.settings) ? g.settings : {};
    return {
      settings: {
        exportEnabled: typeof s.exportEnabled === 'boolean' ? s.exportEnabled : true,
        exportWork: typeof s.exportWork === 'boolean' ? s.exportWork : true,
        exportTitles: typeof s.exportTitles === 'boolean' ? s.exportTitles : true
      },
      calendars: arr(g.calendars), events: arr(g.events), outbox: arr(g.outbox),
      links: isObj(g.links) ? g.links : {}, gens: isObj(g.gens) ? g.gens : {},
      exportCalendarId: g.exportCalendarId || null, accountId: g.accountId || null,
      backoffUntil: g.backoffUntil || null, lastSyncAt: g.lastSyncAt || null, lastError: g.lastError || null
    };
  }

  function findCal(g, id) {
    for (var i = 0; i < g.calendars.length; i++) if (g.calendars[i] && g.calendars[i].id === id) return g.calendars[i];
    return null;
  }
  function findEntry(g, id) {
    for (var i = 0; i < g.outbox.length; i++) if (g.outbox[i] && g.outbox[i].id === id) return g.outbox[i];
    return null;
  }
  function removeEntry(g, id) { g.outbox = g.outbox.filter(function (e) { return !(e && e.id === id); }); }
  // Daynote 가 이 블록의 Google 일정을 지우려고 보낼 delete 가 남아 있나
  function pendingDelete(g, blockId) {
    var e = findEntry(g, 'op:' + blockId);
    return !!(e && e.op === 'delete');
  }
  function newEntry(id, op, blockId, eventId, calendarId, nowIso) {
    return { id: id, op: op, blockId: blockId || null, eventId: eventId || null, calendarId: calendarId || null,
             attempts: 0, nextAt: null, lastError: null, createdAt: nowIso };
  }
  function resetCursor(c) {
    c.syncToken = null; c.windowStart = null; c.windowEnd = null; c.fullSyncAt = null; c.nextPullAt = null;
  }
  function removeEventsOf(g, calendarId) {
    var before = g.events.length;
    g.events = g.events.filter(function (ev) { return !(ev && ev.calendarId === calendarId); });
    return before - g.events.length;
  }
  function nextGen(g, blockId, linkGen) {
    return Math.max(Number(g.gens[blockId]) || 0, Number(linkGen) || 0) + 1;
  }

  // 계정이 바뀌면(또는 로그아웃) 가져온 것·링크·보낼 목록을 모두 비운다. 올리기 설정은 그대로 둔다.
  function resetForAccount(state, accountId) {
    var g = ensure(state);
    g.calendars = []; g.events = []; g.links = {}; g.gens = {}; g.outbox = [];
    g.exportCalendarId = null; g.backoffUntil = null; g.lastSyncAt = null; g.lastError = null;
    g.accountId = accountId == null ? null : accountId;
    return g;
  }

  // ‘Daynote’ 캘린더인가: 지금 쓰는 내보내기 캘린더이거나, 아직 정해지지 않았을 때 표식이 있는 내 캘린더
  function isExportRaw(g, raw) {
    if (g.exportCalendarId) return raw.id === g.exportCalendarId;
    return raw.accessRole === 'owner' && typeof raw.description === 'string' && raw.description.indexOf(MARKER) >= 0;
  }
  function safeColor(c) { return typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : null; }

  // calendarList 원본을 합친다 → { added, removed }
  //   처음 보는 캘린더는 primary 만 고른다. 고른 것·커서는 보존한다. 목록에서 사라진 캘린더는 그 일정과 함께 지운다
  //   (단 지금 쓰는 ‘Daynote’ 캘린더는 숨겨져 목록에 없더라도 남긴다). ‘Daynote’ 캘린더는 isExport 이고 가져오기 대상이 아니다.
  function mergeCalendarList(state, items, ctx) {
    void ctx;
    var g = ensure(state);
    var old = index(g.calendars);
    var seen = {}, next = [], added = 0, removed = 0;
    arr(items).forEach(function (raw) {
      if (!raw || typeof raw.id !== 'string' || !raw.id || raw.deleted || seen[raw.id]) return;
      seen[raw.id] = true;
      var prev = old[raw.id] || null;
      var isExport = isExportRaw(g, raw);
      var c = {
        id: raw.id, summary: cut(raw.summaryOverride || raw.summary || raw.id), primary: !!raw.primary,
        color: safeColor(raw.backgroundColor), accessRole: raw.accessRole || 'reader', timeZone: raw.timeZone || null,
        selected: prev ? !!prev.selected : !!raw.primary,
        isExport: isExport,
        syncToken: null, windowStart: null, windowEnd: null, fullSyncAt: null, lastSyncAt: null, nextPullAt: null, error: null
      };
      if (prev) {
        ['syncToken', 'windowStart', 'windowEnd', 'fullSyncAt', 'lastSyncAt', 'nextPullAt', 'error'].forEach(function (k) {
          if (prev[k] !== undefined) c[k] = prev[k];
        });
        if (!!prev.isExport !== isExport) {            // 가져오기 ↔ ‘Daynote’ 가 바뀌면 처음부터 다시 받는다
          resetCursor(c); c.lastSyncAt = null; c.error = null;
          removeEventsOf(g, c.id);
        }
      } else {
        added++;
      }
      if (isExport) c.selected = false;
      next.push(c);
    });
    Object.keys(old).forEach(function (id) {
      if (seen[id]) return;
      if (g.exportCalendarId && id === g.exportCalendarId) {
        var keep = old[id];
        keep.isExport = true; keep.selected = false;
        next.push(keep);
        return;
      }
      removed++;
      removeEventsOf(g, id);
    });
    // 기본 캘린더를 맨 앞에 (나머지는 Google 목록 순서)
    g.calendars = next.filter(function (c) { return c.primary; }).concat(next.filter(function (c) { return !c.primary; }));
    return { added: added, removed: removed };
  }

  // 가져오기 대상 켜기·끄기. 끄면 그 캘린더 일정과 커서를 지운다 → { removed }
  function setSelected(state, calendarId, on) {
    var g = ensure(state);
    var c = findCal(g, calendarId);
    if (!c || c.isExport) return { removed: 0 };
    if (on) {
      if (!c.selected) { c.selected = true; resetCursor(c); c.error = null; }
      return { removed: 0 };
    }
    c.selected = false;
    resetCursor(c);
    c.error = null;
    return { removed: removeEventsOf(g, calendarId) };
  }

  // 올리기 끄기. opts.removeFuture: true → 앞으로의 링크는 delete(drain) 로 Google 에서도 지우고 지난 것은 링크만 푼다,
  //                                false → 링크를 모두 풀고 보낼 목록을 비운다 (Google 일정은 그대로 남는다). → { deletes, unlinked }
  //   끄면 엔진이 ‘Daynote’ 캘린더를 더는 되읽지 않으므로 그 캘린더의 거울(다른 기기 일정 등)을 지우고 커서를 비운다.
  //   다시 켜면 전체 되읽기부터 하므로 남아 있던 내 일정은 remoteHash 로 링크를 다시 맺는다(409 adopt 보다 정확).
  function disableExport(state, opts, now) {
    var g = ensure(state);
    var t = needNow(now), nowIso = iso(t);
    g.settings.exportEnabled = false;
    g.calendars.forEach(function (c) {
      if (c && (c.isExport || (g.exportCalendarId && c.id === g.exportCalendarId))) { resetCursor(c); removeEventsOf(g, c.id); }
    });
    if (g.exportCalendarId) removeEventsOf(g, g.exportCalendarId);
    var deletes = 0, unlinked = 0;
    if (opts && opts.removeFuture) {
      var keep = [], kept = {};
      g.outbox.forEach(function (e) {
        if (e && e.op === 'delete') { e.drain = true; keep.push(e); kept[e.id] = true; }
      });
      Object.keys(g.links).forEach(function (blockId) {
        var L = g.links[blockId];
        var end = ms(L && L.end);
        if (L && L.eventId && (isNaN(end) || end > t)) {
          var id = 'op:' + blockId;
          if (!kept[id]) {
            var e = newEntry(id, 'delete', blockId, L.eventId, L.calendarId, nowIso);
            e.drain = true;
            keep.push(e); kept[id] = true;
          }
          deletes++;
        } else {
          delete g.links[blockId];
          unlinked++;
        }
      });
      g.outbox = keep;
    } else {
      unlinked = Object.keys(g.links).length;
      g.links = {};
      g.outbox = [];
    }
    return { deletes: deletes, unlinked: unlinked };
  }

  // ------------------------------------------------------------------ 시간 창
  function windowFor(now) {
    var t = needNow(now);
    return {
      start: D.startOfDay(D.addDays(new Date(t), -WINDOW_PAST_DAYS)).toISOString(),
      end: D.startOfDay(D.addDays(new Date(t), WINDOW_FUTURE_DAYS + 1)).toISOString()
    };
  }

  function needsFullSync(cal, now) {
    var t = needNow(now);
    if (!cal || !cal.syncToken) return true;
    if (isNaN(ms(cal.windowEnd)) || isNaN(ms(cal.fullSyncAt))) return true;
    if (D.dayDiff(new Date(cal.windowEnd), new Date(windowFor(t).end)) >= RESYNC_DRIFT_DAYS) return true;   // 창이 7일 이상 밀림
    if (t - ms(cal.fullSyncAt) >= FULL_SYNC_MAX_AGE_DAYS * DAY_MS) return true;
    return false;
  }

  // 증분이면 syncToken 만, 전체면 창만 보낸다 (orderBy 는 어느 쪽에도 쓰지 않는다)
  function pullRequest(cal, now) {
    if (needsFullSync(cal, now)) {
      var w = windowFor(now);
      return { calendarId: cal.id, timeMin: w.start, timeMax: w.end };
    }
    return { calendarId: cal.id, syncToken: cal.syncToken };
  }

  // ------------------------------------------------------------------ 정규화
  function eventKey(calendarId, eventId) { return 'g:' + calendarId + '|' + eventId; }

  function privateProps(raw) {
    var ep = raw && raw.extendedProperties;
    return ep && isObj(ep.private) ? ep.private : null;
  }
  function daynoteIdOf(raw) {
    var p = privateProps(raw);
    return p && typeof p.daynoteId === 'string' && p.daynoteId ? p.daynoteId : null;
  }
  function selfAttendee(raw, selfEmail) {
    var list = arr(raw && raw.attendees);
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (a && (a.self === true || (selfEmail && a.email === selfEmail))) return a;
    }
    return null;
  }
  // https 링크만 둔다 (팝오버의 [Google 캘린더에서 열기] → openExternal)
  function safeLink(u) { return typeof u === 'string' && /^https:\/\//.test(u) ? u : null; }

  // Google 의 start/end 한쪽 → UTC ISO | null. 오프셋 없는 비정상 값은 Asia/Seoul 이면 +09:00, 그 밖은 로컬 시간으로 읽는다.
  function timeOf(p, calTz) {
    if (!p || typeof p !== 'object') return null;
    if (p.dateTime) {
      var v = String(p.dateTime);
      if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(v) && (p.timeZone || calTz) === 'Asia/Seoul') v += '+09:00';
      return isoOrNull(v);
    }
    if (isYmd(p.date)) return D.parseYmd(p.date).toISOString();
    return null;
  }

  // 바쁜 일정인가 (§6.3). Google 원본과 정규화한 GEvent 를 모두 받는다.
  function isBusy(ev) {
    if (!ev || typeof ev !== 'object' || ev.tombstone || ev.status === 'cancelled') return false;
    if (typeof ev.start === 'string') return !!ev.busy && !ev.allDay;          // GEvent
    if (!ev.start || !ev.start.dateTime) return false;                          // 종일
    if (ev.transparency === 'transparent') return false;
    if (ev.eventType === 'workingLocation' || ev.eventType === 'birthday') return false;
    var self = selfAttendee(ev);
    return !(self && self.responseStatus === 'declined');
  }

  // 원본 → GEvent | 묘비 { tombstone, calendarId, eventId, recurringEventId } | null(버림)
  //   ctx = { calendarId, timeZone?(캘린더 시간대), selfEmail? }
  function normalizeEvent(raw, ctx) {
    if (!raw || typeof raw !== 'object' || raw.id == null || raw.id === '') return null;
    ctx = ctx || {};
    var calendarId = ctx.calendarId || null;
    var eventId = String(raw.id);
    var series = raw.recurringEventId ? String(raw.recurringEventId) : null;
    if (raw.status === 'cancelled') return { tombstone: true, calendarId: calendarId, eventId: eventId, recurringEventId: series };
    var type = raw.eventType || 'default';
    if (type === 'workingLocation' || type === 'birthday') return null;
    var self = selfAttendee(raw, ctx.selfEmail);
    var response = self && self.responseStatus ? self.responseStatus : null;
    if (response === 'declined') return null;
    var s = raw.start || {}, e = raw.end || {};
    var allDay = !s.dateTime && isYmd(s.date);
    var start, end, startDate = null, endDate = null;
    if (allDay) {
      startDate = s.date;
      endDate = isYmd(e.date) && e.date > s.date ? e.date : D.ymd(D.addDays(D.parseYmd(s.date), 1));   // 배타적 끝
      start = D.parseYmd(startDate).toISOString();
      end = D.parseYmd(endDate).toISOString();
    } else {
      start = timeOf(s, ctx.timeZone || null);
      end = timeOf(e, ctx.timeZone || null);
      if (!start) return null;
      if (!end || ms(end) < ms(start)) end = start;
    }
    var daynoteId = daynoteIdOf(raw);
    var title = typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary : '(제목 없음)';
    return {
      key: eventKey(calendarId, eventId), calendarId: calendarId, eventId: eventId, recurringEventId: series,
      etag: raw.etag || null, updated: isoOrNull(raw.updated),
      status: raw.status === 'tentative' ? 'tentative' : 'confirmed',
      title: cut(title), location: cut(raw.location || ''), htmlLink: safeLink(raw.htmlLink), eventType: type,
      allDay: allDay, start: start, end: end, startDate: startDate, endDate: endDate,
      tz: s.timeZone || ctx.timeZone || null,
      busy: isBusy(raw),
      response: response === 'accepted' || response === 'tentative' || response === 'needsAction' ? response : null,
      origin: daynoteId ? 'daynote_other' : 'google',
      daynoteId: daynoteId
    };
  }

  function inWindow(ev, ws, we) { return ms(ev.end) > ws && ms(ev.start) < we; }

  // events 에 넣거나 바꾼다 (오래된 값이 새 값을 덮지 않게). → 바뀐 개수
  function upsertEvents(g, list) {
    var pos = {};
    g.events.forEach(function (ev, i) { if (ev && ev.key) pos[ev.key] = i; });
    var changed = 0;
    arr(list).forEach(function (ev) {
      if (!ev || !ev.key) return;
      var i = pos[ev.key];
      if (i === undefined) { pos[ev.key] = g.events.length; g.events.push(ev); changed++; return; }
      var prev = g.events[i];
      if (isNewer(prev.updated, ev.updated) || sameJson(prev, ev)) return;
      g.events[i] = ev;
      changed++;
    });
    return changed;
  }

  function removeKeysFrom(g, calendarId, keys, series) {
    var rk = {}, rs = {};
    arr(keys).forEach(function (k) { rk[k] = true; });
    arr(series).forEach(function (s) { rs[s] = true; });
    var before = g.events.length;
    g.events = g.events.filter(function (ev) {
      if (!ev || ev.calendarId !== calendarId) return true;
      if (rk[ev.key]) return false;
      if ((ev.recurringEventId && rs[ev.recurringEventId]) || rs[ev.eventId]) return false;
      return true;
    });
    return before - g.events.length;
  }

  function cursorFor(cal, res, full, t) {
    if (full) {
      var w = windowFor(t);
      return { syncToken: (res && res.nextSyncToken) || null, windowStart: w.start, windowEnd: w.end, fullSyncAt: iso(t) };
    }
    return {
      syncToken: (res && res.nextSyncToken) || (cal && cal.syncToken) || null,
      windowStart: cal ? cal.windowStart || null : null, windowEnd: cal ? cal.windowEnd || null : null
    };
  }
  function applyCursor(cal, cursor, t) {
    if (!cal || !cursor) return;
    cal.syncToken = cursor.syncToken || null;
    if (cursor.windowStart !== undefined) cal.windowStart = cursor.windowStart;
    if (cursor.windowEnd !== undefined) cal.windowEnd = cursor.windowEnd;
    if (cursor.fullSyncAt) cal.fullSyncAt = cursor.fullSyncAt;
    cal.lastSyncAt = iso(t);
    cal.nextPullAt = null;
    cal.error = null;
  }
  function isFull(res, cal) {
    if (res && typeof res.full === 'boolean') return res.full;
    return !(cal && cal.syncToken);
  }

  // ------------------------------------------------------------------ 가져오기
  // res = gcal:list 성공 응답 { items, nextSyncToken, full, timeZone }. 상태를 바꾸지 않는다. → PullPlan (§7.2)
  function planPull(state, calendarId, res, ctx) {
    var g = view(state);
    var t = nowOf(ctx);
    var cal = findCal(g, calendarId);
    var full = isFull(res, cal);
    var win = windowFor(t), ws = ms(win.start), we = ms(win.end);
    var nctx = { calendarId: calendarId, timeZone: (res && res.timeZone) || (cal && cal.timeZone) || null, selfEmail: ctx && ctx.selfEmail };
    var existing = {};
    g.events.forEach(function (ev) { if (ev && ev.calendarId === calendarId) existing[ev.key] = ev; });
    var act = {}, order = [], seenKey = {}, series = {}, refetch = {};
    var stats = { seen: 0, upserted: 0, removed: 0, skippedStale: 0, outOfWindow: 0 };
    function set(key, ev) { if (!(key in act)) order.push(key); act[key] = ev; }

    arr(res && res.items).forEach(function (raw) {
      if (!raw || raw.id == null || raw.id === '') return;
      stats.seen++;
      var key = eventKey(calendarId, String(raw.id));
      seenKey[key] = true;
      var n = normalizeEvent(raw, nctx);
      if (!n) { set(key, null); return; }                                  // 버리는 종류 — 있으면 지운다
      if (n.tombstone) {
        set(key, null);
        Object.keys(existing).forEach(function (k) {                      // 시리즈 id 의 묘비 → 인스턴스 전부
          if (existing[k].recurringEventId === n.eventId) series[n.eventId] = true;
        });
        return;
      }
      if (!inWindow(n, ws, we)) { stats.outOfWindow++; set(key, null); return; }
      var prev = existing[key];
      if (prev && isNewer(prev.updated, n.updated)) { stats.skippedStale++; return; }
      if (!full && n.recurringEventId) refetch[n.recurringEventId] = true;
      set(key, n);
    });
    if (full) Object.keys(existing).forEach(function (k) { if (!seenKey[k]) set(k, null); });

    var upserts = [], removeKeys = [], gone = {};
    order.forEach(function (k) {
      if (act[k]) upserts.push(act[k]);
      else if (existing[k]) { removeKeys.push(k); gone[k] = true; }
    });
    var removeSeries = Object.keys(series);
    var upKeys = {};
    upserts.forEach(function (ev) { upKeys[ev.key] = true; });
    Object.keys(existing).forEach(function (k) {
      var ev = existing[k];
      if (!gone[k] && !upKeys[k] && ev.recurringEventId && series[ev.recurringEventId]) gone[k] = true;
    });
    stats.upserted = upserts.length;
    stats.removed = Object.keys(gone).length;
    return {
      calendarId: calendarId, full: full,
      upserts: upserts, removeKeys: removeKeys, removeSeries: removeSeries, refetchSeries: Object.keys(refetch),
      cursor: cursorFor(cal, res, full, t), stats: stats
    };
  }

  // 계획을 반영한다 (mutator). 그 사이 가져오기를 끈 캘린더면 아무것도 하지 않는다. → { changed } (일정 변화 수)
  function applyPull(state, plan, now) {
    var g = ensure(state);
    var t = needNow(now);
    var cal = plan ? findCal(g, plan.calendarId) : null;
    if (!cal || !cal.selected || cal.isExport) return { changed: 0 };
    var changed = removeKeysFrom(g, plan.calendarId, plan.removeKeys, plan.removeSeries);
    changed += upsertEvents(g, plan.upserts);
    applyCursor(cal, plan.cursor, t);
    return { changed: changed };
  }

  // 반복 시리즈를 events.instances 결과로 통째로 바꾼다 (창 안의 것만). → { changed }
  function applySeries(state, calendarId, seriesId, items, ctx) {
    var g = ensure(state);
    var t = nowOf(ctx);
    var cal = findCal(g, calendarId);
    if (!cal || !cal.selected || cal.isExport || !seriesId) return { changed: 0 };
    var win = windowFor(t), ws = ms(win.start), we = ms(win.end);
    var nctx = { calendarId: calendarId, timeZone: cal.timeZone || null, selfEmail: ctx && ctx.selfEmail };
    var fresh = {}, order = [];
    arr(items).forEach(function (raw) {
      var n = normalizeEvent(raw, nctx);
      if (!n || n.tombstone || !inWindow(n, ws, we)) return;
      if (!n.recurringEventId) n.recurringEventId = seriesId;
      if (!(n.key in fresh)) order.push(n.key);
      fresh[n.key] = n;
    });
    var old = {}, changed = 0;
    g.events.forEach(function (ev) {
      if (ev && ev.calendarId === calendarId && ev.recurringEventId === seriesId) old[ev.key] = ev;
    });
    Object.keys(old).forEach(function (k) { if (!fresh[k] || !sameJson(old[k], fresh[k])) changed++; });
    order.forEach(function (k) { if (!old[k]) changed++; });
    g.events = g.events.filter(function (ev) { return !(ev && ev.calendarId === calendarId && ev.recurringEventId === seriesId); })
      .concat(order.map(function (k) { return fresh[k]; }));
    return { changed: changed };
  }

  // 410(syncToken 만료) 등 — 커서와 그 캘린더 일정을 지워 다음 요청이 전체 동기화가 되게 한다. → { removed }
  function resetCalendar(state, calendarId) {
    var g = ensure(state);
    var c = findCal(g, calendarId);
    if (c) { resetCursor(c); c.error = null; }
    return { removed: removeEventsOf(g, calendarId) };
  }

  // 창 시작보다 먼저 끝난 일정과 30일 넘게 지난 링크를 정리한다 (Google 일정은 남겨 둔다). → { removed, linksDropped }
  function prune(state, now) {
    var g = ensure(state);
    var t = needNow(now), ws = ms(windowFor(t).start), limit = t - LINK_KEEP_DAYS * DAY_MS;
    var before = g.events.length;
    g.events = g.events.filter(function (ev) { var e = ms(ev && ev.end); return !isNaN(e) && e >= ws; });
    var linksDropped = 0;
    Object.keys(g.links).forEach(function (id) {
      var e = ms(g.links[id] && g.links[id].end);
      if (!isNaN(e) && e < limit) { delete g.links[id]; linksDropped++; }
    });
    return { removed: before - g.events.length, linksDropped: linksDropped };
  }

  // ------------------------------------------------------------------ 내보내기
  // 'dn' + hex(utf8(blockId)) + ('g' + 세대(32진)) — base32hex(a-v, 0-9)만 쓰고 결정적이다
  function eventIdFor(blockId, gen) {
    var n = Math.max(0, Math.floor(Number(gen) || 0));
    return 'dn' + utf8Hex(blockId) + (n ? 'g' + n.toString(32) : '');
  }
  function genOf(eventId, blockId) {
    var base = eventIdFor(blockId, 0);
    if (typeof eventId !== 'string' || eventId.indexOf(base + 'g') !== 0) return 0;
    var n = parseInt(eventId.slice(base.length + 1), 32);
    return isNaN(n) ? 0 : n;
  }

  // 시간 조건을 뺀 공통 조건 (keepLinked 와 같다)
  function linkable(state, g, b) {
    if (!b || !g.settings.exportEnabled) return false;
    var s = ms(b.start), e = ms(b.end);
    if (isNaN(s) || isNaN(e) || e < s) return false;
    if (b.sample || b.timeUncertain) return false;
    var kind = kindOf(b);
    if (kind === 'event') return true;
    if (kind !== 'work' || !g.settings.exportWork) return false;
    var task = b.taskId ? M.byId(arr(state.tasks), b.taskId) : null;
    return !!task && !task.deletedAt;
  }
  function exportableIn(state, g, b, t) {
    return linkable(state, g, b) && ms(b.end) >= t - EXPORT_PAST_HOURS * HOUR;
  }
  // 새로 올릴까
  function exportable(state, block, ctx) { return exportableIn(state, view(state), block, nowOf(ctx)); }
  // 이미 올린 것을 계속 맞출까 (시간 조건 없음)
  function keepLinked(state, block, ctx) { void ctx; return linkable(state, view(state), block); }

  function hashOf(summary, description, location, start, end, transparency) {
    return fnv1a(JSON.stringify([summary, description, location || '', start, end, transparency]));
  }

  function bodyIn(state, g, b, ctx) {
    var kind = kindOf(b), titles = g.settings.exportTitles;
    var summary;
    if (titles) {
      if (kind === 'work') {
        var task = b.taskId ? M.byId(arr(state.tasks), b.taskId) : null;
        summary = (task && task.title) || b.title || '작업';
      } else {
        summary = b.title || '일정';
      }
    } else {
      summary = kind === 'work' ? '집중 작업' : '바쁨';
    }
    var description = kind === 'work' ? DESC_WORK : DESC_EVENT;
    var location = kind === 'event' && titles && b.location ? String(b.location) : undefined;
    var tz = (ctx && ctx.tz) || 'Asia/Seoul';
    var start = sec(b.start), end = sec(b.end);
    var body = { summary: summary, description: description };
    if (location) body.location = location;
    body.start = { dateTime: start, timeZone: tz };
    body.end = { dateTime: end, timeZone: tz };
    body.transparency = 'opaque';
    body.reminders = { useDefault: false };                 // Daynote 일정으로 알림이 두 번 오지 않게
    body.extendedProperties = { private: {
      daynoteId: b.id, daynoteKind: kind, daynoteDevice: String((ctx && ctx.deviceId) || ''), daynoteV: '1'
    } };
    return { body: body, hash: hashOf(summary, description, location, start, end, 'opaque') };
  }
  function eventBody(state, block, ctx) { return bodyIn(state, view(state), block, ctx); }

  // Google 에서 받은 이벤트로 eventBody 와 같은 규칙의 해시를 만든다. 목록 응답에는 설명이 없으므로 종류 표식으로 채운다.
  function remoteHash(raw) {
    raw = raw || {};
    var p = privateProps(raw) || {};
    var description = typeof raw.description === 'string' ? raw.description : (p.daynoteKind === 'work' ? DESC_WORK : DESC_EVENT);
    var s = timeOf(raw.start, null), e = timeOf(raw.end, null);
    return hashOf(typeof raw.summary === 'string' ? raw.summary : '', description, raw.location || '',
      s ? sec(s) : null, e ? sec(e) : null, raw.transparency || 'opaque');
  }

  // 지금 블록과 링크를 비교해 outbox 를 맞춘다 (멱등). → { inserts, patches, deletes, unlinked, changed }  (앞의 넷은 blockId 목록)
  function reconcile(state, ctx) {
    var g = ensure(state);
    var t = nowOf(ctx), nowIso = iso(t);
    var out = { inserts: [], patches: [], deletes: [], unlinked: [], changed: 0 };
    if (!g.settings.exportEnabled) return out;
    var exportCal = g.exportCalendarId || null;
    var blocks = index(state.blocks);
    var wants = {}, wantOrder = [];
    function want(blockId, op, eventId, calendarId) {
      var id = 'op:' + blockId;
      if (!wants[id]) wantOrder.push(id);
      wants[id] = { op: op, blockId: blockId, eventId: eventId || null, calendarId: calendarId || null };
      (op === 'insert' ? out.inserts : op === 'patch' ? out.patches : out.deletes).push(blockId);
    }
    function unlink(blockId) { delete g.links[blockId]; out.unlinked.push(blockId); out.changed++; }

    // 내보내기 캘린더가 바뀌었으면(다시 만들기) 옛 캘린더를 가리키는 링크로는 고칠 수 없다 — 링크만 풀고 새로 올린다
    if (exportCal) {
      Object.keys(g.links).forEach(function (id) {
        var L = g.links[id];
        if (L && L.calendarId && L.calendarId !== exportCal) unlink(id);
      });
    }
    arr(state.blocks).forEach(function (b) {
      if (!b || !b.id) return;
      var L = g.links[b.id];
      if (!L) {
        if (exportCal && exportableIn(state, g, b, t)) want(b.id, 'insert', null, exportCal);
        return;
      }
      if (!linkable(state, g, b)) {
        if (ms(L.end) > t) want(b.id, 'delete', L.eventId, L.calendarId);
        else unlink(b.id);
        return;
      }
      if (bodyIn(state, g, b, ctx).hash !== L.hash) want(b.id, 'patch', L.eventId, L.calendarId);
    });
    Object.keys(g.links).forEach(function (id) {                 // 지운 블록 · 되돌리기로 사라진 블록
      if (!blocks[id]) want(id, 'delete', g.links[id].eventId, g.links[id].calendarId);
    });

    var next = [], had = {};
    g.outbox.forEach(function (e) {
      if (!e || !e.id) { out.changed++; return; }
      var w = wants[e.id];
      if (!w) {
        // 고아 delete 는 성공·포기 전까지 남긴다 (지금 내보내기 캘린더의 것만)
        if (e.id.indexOf(ORPHAN) === 0 && (!exportCal || e.calendarId === exportCal)) next.push(e);
        else out.changed++;
        return;
      }
      had[e.id] = true;
      if (e.op !== w.op) {
        e.op = w.op; e.attempts = 0; e.lastError = null;                 // nextAt 은 유지
        delete e.drain;
        out.changed++;
      }
      if (e.calendarId !== w.calendarId) {                             // 다른 캘린더로 — 처음부터 다시
        e.calendarId = w.calendarId; e.attempts = 0; e.nextAt = null; e.lastError = null;
        out.changed++;
      }
      if (e.eventId !== w.eventId) { e.eventId = w.eventId; out.changed++; }
      if (e.blockId !== w.blockId) e.blockId = w.blockId;
      next.push(e);
    });
    wantOrder.forEach(function (id) {
      if (had[id]) return;
      var w = wants[id];
      next.push(newEntry(id, w.op, w.blockId, w.eventId, w.calendarId, nowIso));
      out.changed++;
    });
    g.outbox = next;
    return out;
  }

  function isDue(e, t) { var n = ms(e.nextAt); return isNaN(n) || n <= t; }

  // 지금 보낼 항목 → DispatchOp[] (상태를 바꾸지 않는다). 본문은 지금 상태로 계산한다.
  //   DispatchOp = { opId, op, calendarId, eventId, daynoteId, body, hash, gen }
  function dueOps(state, ctx, limit) {
    var g = view(state);
    var t = nowOf(ctx);
    var max = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : DUE_LIMIT;
    if (ms(g.backoffUntil) > t) return [];
    var enabled = g.settings.exportEnabled;
    var list = g.outbox.filter(function (e) { return e && e.id && (enabled || e.drain); });
    // ‘Daynote’ 캘린더를 쓸 수 없는 동안에는 한 항목만 시험 삼아 보낸다
    var stopped = list.filter(function (e) {
      return e.lastError && STOP_TYPES[e.lastError.type] && (!g.exportCalendarId || e.calendarId === g.exportCalendarId);
    });
    if (stopped.length) { list = stopped; max = 1; }
    var blocks = index(state.blocks);
    var ops = [];
    for (var i = 0; i < list.length && ops.length < max; i++) {
      var e = list[i];
      if (!isDue(e, t)) continue;
      var L = e.blockId ? g.links[e.blockId] : null;
      var b = e.blockId ? blocks[e.blockId] : null;
      var built;
      if (e.op === 'insert') {
        var cid = e.calendarId || g.exportCalendarId;
        if (!b || L || !cid || !exportableIn(state, g, b, t)) continue;
        var gen = Math.max(0, Number(g.gens[b.id]) || 0);
        built = bodyIn(state, g, b, ctx);
        ops.push({ opId: e.id, op: 'insert', calendarId: cid, eventId: eventIdFor(b.id, gen), daynoteId: b.id,
                   body: built.body, hash: built.hash, gen: gen });
      } else if (e.op === 'patch') {
        if (!b || !L || !L.eventId) continue;
        built = bodyIn(state, g, b, ctx);
        ops.push({ opId: e.id, op: 'patch', calendarId: L.calendarId || e.calendarId, eventId: L.eventId, daynoteId: b.id,
                   body: built.body, hash: built.hash, gen: Number(L.gen) || 0 });
      } else if (e.op === 'delete') {
        var eventId = e.eventId || (L && L.eventId) || null;
        var calendarId = e.calendarId || (L && L.calendarId) || null;
        if (!eventId || !calendarId) continue;
        ops.push({ opId: e.id, op: 'delete', calendarId: calendarId, eventId: eventId, daynoteId: e.blockId || null,
                   body: null, hash: null, gen: L ? Number(L.gen) || 0 : null });
      }
    }
    return ops;
  }

  // 재시도 간격: retryAfterMs 가 있으면 그 값, 없으면 min(15초 × 2^(n−1), 30분) × (0.5 + rand/2)
  function backoffMs(attempts, retryAfterMs, rand) {
    if (typeof retryAfterMs === 'number' && retryAfterMs > 0) return retryAfterMs;
    var n = Math.max(1, Math.floor(Number(attempts) || 1));
    var base = Math.min(BACKOFF_BASE_MS * Math.pow(2, n - 1), BACKOFF_MAX_MS);
    var r = typeof rand === 'number' && rand >= 0 && rand <= 1 ? rand : 1;
    return Math.round(base * (0.5 + r / 2));
  }

  // 보낸 결과를 반영한다 (mutator). results 는 PushResult[] 또는 gcal:push 응답 전체({ok, results}|{ok:false, error}).
  //   → { done, failed, backoffUntil, exportError: null|'calendar_missing'|'write_denied' }
  function applyPushResults(state, ops, results, ctx) {
    var g = ensure(state);
    var t = nowOf(ctx), nowIso = iso(t);
    var out = { done: 0, failed: 0, backoffUntil: null, exportError: null };
    var whole = null, byOp = {};
    if (results && !Array.isArray(results)) {
      if (Array.isArray(results.results)) results = results.results;
      else { whole = (results && results.error) || { type: 'unknown', message: '' }; results = []; }
    }
    arr(results).forEach(function (r) { if (r && r.opId) byOp[r.opId] = r; });
    var blocks = index(state.blocks);
    var okCals = {};

    function retryAt(e, err) {
      var wait = e.attempts > MAX_ATTEMPTS ? AFTER_MAX_MS : backoffMs(e.attempts, err && err.retryAfterMs, randOf(ctx));
      return iso(t + wait);
    }
    function record(e, type, err, nextAtIso) {
      e.attempts = (Number(e.attempts) || 0) + 1;
      e.lastError = { type: type, message: cut((err && err.message) || ''), at: nowIso };
      e.nextAt = nextAtIso === undefined ? retryAt(e, err) : nextAtIso;
      out.failed++;
    }
    function linkDone(op, blockId) {
      var L = blockId ? g.links[blockId] : null;
      if (L && L.eventId === op.eventId) delete g.links[blockId];
    }

    arr(ops).forEach(function (op) {
      if (!op || !op.opId) return;
      var r = whole ? { opId: op.opId, ok: false, error: whole } : byOp[op.opId];
      if (!r) return;                                           // 보내지 못한 op — 다음 회차에
      var e = findEntry(g, op.opId);
      var blockId = op.daynoteId || (e && e.blockId) || null;
      var b = blockId ? blocks[blockId] : null;
      var err = r.ok ? null : (r.error || { type: 'unknown' });
      var type = err ? String(err.type || 'unknown') : null;

      if (r.ok || (op.op === 'delete' && (GONE[type] || type === 'calendar_missing'))) {
        if (op.op === 'insert' && blockId) {
          // 보낸 본문의 해시. 단 409 adopted 는 Google 에 이미 있던 일정을 그대로 받은 것이라(응답을 못 받은 뒤 블록이 또 바뀌었을 수 있다)
          // 내용이 같다고 확신할 수 없다 — 해시를 비워 다음 reconcile 이 한 번 patch 해서 맞추게 한다.
          g.links[blockId] = {
            eventId: r.eventId || op.eventId, calendarId: op.calendarId, gen: Number(op.gen) || 0,
            etag: r.etag || null, remoteUpdated: r.updated || null, hash: r.adopted ? null : op.hash,
            end: b ? b.end : null, pushedAt: nowIso
          };
          if ((Number(g.gens[blockId]) || 0) < (Number(op.gen) || 0)) g.gens[blockId] = Number(op.gen);
        } else if (op.op === 'patch' && blockId) {
          var L = g.links[blockId];
          if (L && L.eventId === op.eventId) {
            if (r.etag) L.etag = r.etag;
            if (r.updated) L.remoteUpdated = r.updated;
            L.hash = op.hash;
            if (b) L.end = b.end;
            L.pushedAt = nowIso;
          }
        } else if (op.op === 'delete') {
          linkDone(op, blockId);
        }
        if (e && e.op === op.op) removeEntry(g, e.id);
        if (op.calendarId) okCals[op.calendarId] = true;
        out.done++;
        return;
      }

      if (op.op === 'patch' && GONE[type]) {                    // Google 에서 지워짐 — Daynote 가 이긴다: 새 id 로 다시 올린다
        linkDone(op, blockId);
        if (blockId) g.gens[blockId] = nextGen(g, blockId, op.gen);
        if (e) {
          if (b && g.exportCalendarId && exportableIn(state, g, b, t)) {
            e.op = 'insert'; e.eventId = null; e.calendarId = g.exportCalendarId;
            e.attempts = 0; e.nextAt = null; e.lastError = null; delete e.drain;
          } else {
            removeEntry(g, e.id);
          }
        }
        return;
      }
      if (op.op === 'insert' && type === 'id_taken') {         // 지워진 id 는 다시 못 쓴다 — 세대를 올려 바로 다시
        if (blockId) g.gens[blockId] = nextGen(g, blockId, op.gen);
        if (e) { e.nextAt = nowIso; e.lastError = null; }
        return;
      }
      if (RATE[type]) {
        var wait = Math.max(Number(err.retryAfterMs) || 0, backoffMs((e ? Number(e.attempts) || 0 : 0) + 1, null, randOf(ctx)));
        var until = t + wait;
        if (!(ms(g.backoffUntil) >= until)) g.backoffUntil = iso(until);
        return;
      }
      if (AUTH[type]) return;                                   // 로그인 문제 — 상태 표시가 맡는다. 항목은 그대로
      var stop = STOP_OF[type] || (op.op === 'insert' && GONE[type] ? 'calendar_missing' : null);
      if (stop) {
        if (e) record(e, stop, err);
        else out.failed++;
        out.exportError = out.exportError || stop;
        return;
      }
      if (!e) { out.failed++; return; }
      if (RETRY[type] || err.retryable === true) record(e, type, err);
      else record(e, type, err, iso(t + HOLD_MS));             // bad_request 등 — 하루 뒤에 다시
    });

    // 그 캘린더에 하나라도 올라갔으면 ‘쓸 수 없음’ 표시를 거둔다
    Object.keys(okCals).forEach(function (cid) {
      g.outbox.forEach(function (e) {
        if (e && e.calendarId === cid && e.lastError && STOP_TYPES[e.lastError.type]) {
          e.lastError = null; e.nextAt = null; e.attempts = 0;
        }
      });
    });
    out.backoffUntil = g.backoffUntil || null;
    return out;
  }

  // ------------------------------------------------------------------ ‘Daynote’ 캘린더 되읽기
  // 일정 블록은 시작·끝·제목·장소(제목·장소는 exportTitles 일 때만), 작업 블록은 시작·끝만 반영한다
  function remotePatch(state, g, b, raw, ctx) {
    var patch = {};
    if (raw.start && raw.start.dateTime && raw.end && raw.end.dateTime) {
      var s = timeOf(raw.start, null), e = timeOf(raw.end, null);
      if (s && e && ms(e) >= ms(s)) {
        if (ms(s) !== ms(b.start)) patch.start = s;
        if (ms(e) !== ms(b.end)) patch.end = e;
      }
    }
    if (kindOf(b) === 'event' && g.settings.exportTitles) {
      var sent = bodyIn(state, g, b, ctx).body;
      var title = typeof raw.summary === 'string' ? raw.summary : '';
      if (title !== sent.summary) patch.title = title;
      var loc = raw.location || '';
      if (loc !== (sent.location || '')) patch.location = loc || null;
    }
    return patch;
  }

  // res = ‘Daynote’ 캘린더의 gcal:list 성공 응답. 상태를 바꾸지 않는다. → OwnPlan
  //   OwnPlan = { calendarId, full, cursor, adoptLinks:[{blockId, link}], remoteEdits:[{blockId, patch, link}], remoteDeletes:[{blockId}],
  //               reinserts:[blockId], orphans:[{eventId}], mirrors:[GEvent], removeKeys:[key], dropLinks:[blockId], stats }
  function planOwnPull(state, res, ctx) {
    var g = view(state);
    var t = nowOf(ctx);
    var deviceId = (ctx && ctx.deviceId) || null;
    var calendarId = (res && res.calendarId) || (ctx && ctx.calendarId) || g.exportCalendarId;
    var cal = findCal(g, calendarId);
    var full = isFull(res, cal);
    var win = windowFor(t), ws = ms(win.start), we = ms(win.end);
    var blocks = index(state.blocks), links = g.links;
    var nctx = { calendarId: calendarId, timeZone: (res && res.timeZone) || (cal && cal.timeZone) || null, selfEmail: ctx && ctx.selfEmail };
    var linkByEvent = {};
    Object.keys(links).forEach(function (id) {
      var L = links[id];
      if (L && L.eventId && (!L.calendarId || L.calendarId === calendarId)) linkByEvent[L.eventId] = id;
    });
    var existing = {};
    g.events.forEach(function (ev) { if (ev && ev.calendarId === calendarId) existing[ev.key] = ev; });
    var plan = {
      calendarId: calendarId, full: full, cursor: cursorFor(cal, res, full, t),
      adoptLinks: [], remoteEdits: [], remoteDeletes: [], reinserts: [], orphans: [], mirrors: [], removeKeys: [], dropLinks: [],
      stats: { seen: 0, echo: 0, edited: 0, adopted: 0, remoteDeleted: 0, reinserted: 0, orphans: 0, mirrored: 0, removed: 0, skippedStale: 0, outOfWindow: 0 }
    };
    var seenEvent = {}, seenKey = {}, mirrorMap = {}, mirrorOrder = [], drop = {}, handled = {}, orphaned = {};
    function dropKey(key) { if (existing[key]) drop[key] = true; }
    function orphan(eventId) { if (!orphaned[eventId]) { orphaned[eventId] = true; plan.orphans.push({ eventId: eventId }); } }

    arr(res && res.items).forEach(function (raw) {
      if (!raw || raw.id == null || raw.id === '') return;
      plan.stats.seen++;
      var eventId = String(raw.id);
      var key = eventKey(calendarId, eventId);
      seenEvent[eventId] = true;
      seenKey[key] = true;
      var p = privateProps(raw) || {};
      var daynoteId = daynoteIdOf(raw);

      if (raw.status === 'cancelled') {
        dropKey(key);
        var linked = linkByEvent[eventId];
        if (!linked || handled[linked]) return;
        handled[linked] = true;
        var lb = blocks[linked];
        if (!lb) plan.dropLinks.push(linked);                                   // 블록도 없음 — 링크만 정리
        // Daynote 도 Google 에서 빼려던 블록(시각 미정·작업 올리기 끔·올리기 끔) — 내가 보낸 delete 의 메아리일 수 있다. 블록은 두고 링크만 정리
        else if (!linkable(state, g, lb)) plan.dropLinks.push(linked);
        // 내가 보낸 delete 의 메아리(그 뒤 다시 올릴 블록이 됨) · Daynote 에서 바뀜 — Daynote 가 이긴다: 새 세대로 다시 올린다
        else if (pendingDelete(g, linked) || bodyIn(state, g, lb, ctx).hash !== links[linked].hash) plan.reinserts.push(linked);
        else plan.remoteDeletes.push({ blockId: linked });                     // Google 에서 지움 → Daynote 도 지운다
        return;
      }

      var mine = !!daynoteId && ((deviceId && p.daynoteDevice === deviceId) || !!links[daynoteId] || !!blocks[daynoteId]);
      if (!mine) {                                                              // Google 원본 · 다른 기기의 Daynote
        var n = normalizeEvent(raw, nctx);
        if (!n || n.tombstone) { dropKey(key); return; }
        if (!inWindow(n, ws, we)) { plan.stats.outOfWindow++; dropKey(key); return; }
        if (existing[key] && isNewer(existing[key].updated, n.updated)) { plan.stats.skippedStale++; return; }
        if (!(key in mirrorMap)) mirrorOrder.push(key);
        mirrorMap[key] = n;
        return;
      }

      dropKey(key);                                                             // 내 항목은 거울로 두지 않는다
      var b = blocks[daynoteId], L = links[daynoteId];
      if (L && L.eventId !== eventId) {                                         // 같은 블록의 옛 세대 이벤트
        if (deviceId && p.daynoteDevice === deviceId) orphan(eventId);
        return;
      }
      if (!b) {                                                                 // 블록이 없다 — 링크가 있으면 reconcile 이 지운다
        if (!L) orphan(eventId);
        return;
      }
      if (handled[daynoteId]) return;
      handled[daynoteId] = true;
      if (!L) {                                                                 // 링크를 잃음(백업 복원·재설치) — 다시 맺는다
        plan.adoptLinks.push({ blockId: daynoteId, link: {
          eventId: eventId, calendarId: calendarId, gen: genOf(eventId, daynoteId), etag: raw.etag || null,
          remoteUpdated: isoOrNull(raw.updated), hash: remoteHash(raw), end: b.end, pushedAt: iso(t)
        } });
        return;
      }
      var local = bodyIn(state, g, b, ctx).hash !== L.hash;
      var remote = (raw.etag || null) !== (L.etag || null);
      if (!remote) { plan.stats.echo++; return; }                               // 그대로 · 내가 쓴 것이 돌아옴 · local 만 바뀜(reconcile)
      if (local) return;                                                        // 양쪽 다 바뀜 — Daynote 가 이긴다 (etag 도 그대로)
      var patch = remotePatch(state, g, b, raw, ctx);
      plan.remoteEdits.push({ blockId: daynoteId, patch: patch, link: {
        eventId: eventId, etag: raw.etag || null, remoteUpdated: isoOrNull(raw.updated), hash: remoteHash(raw), end: patch.end || b.end
      } });
    });

    if (full) {
      // 창 안에 있어야 할 링크된 이벤트가 안 보이면 지워졌는지 확신할 수 없다 — 잃지 않는 쪽: 링크를 풀고 새 세대로 다시 올린다
      Object.keys(links).forEach(function (blockId) {
        var L = links[blockId];
        if (!L || !L.eventId || handled[blockId] || seenEvent[L.eventId]) return;
        if (L.calendarId && L.calendarId !== calendarId) return;
        if (!blocks[blockId]) return;                                           // 지운 블록은 reconcile 의 delete 가 맡는다
        var end = ms(L.end);
        if (!isNaN(end) && end > ws && end <= we) { handled[blockId] = true; plan.reinserts.push(blockId); }
      });
      Object.keys(existing).forEach(function (k) { if (!seenKey[k]) drop[k] = true; });
    }

    mirrorOrder.forEach(function (k) { plan.mirrors.push(mirrorMap[k]); });
    Object.keys(drop).forEach(function (k) { if (!mirrorMap[k]) plan.removeKeys.push(k); });
    plan.stats.edited = plan.remoteEdits.length;
    plan.stats.adopted = plan.adoptLinks.length;
    plan.stats.remoteDeleted = plan.remoteDeletes.length;
    plan.stats.reinserted = plan.reinserts.length;
    plan.stats.orphans = plan.orphans.length;
    plan.stats.mirrored = plan.mirrors.length;
    plan.stats.removed = plan.removeKeys.length;
    return plan;
  }

  // ‘Daynote’ 캘린더 항목이 calendars 에 아직 없으면(목록을 받기 전) 커서를 둘 자리를 만든다
  function exportCalEntry(g, id) {
    var c = findCal(g, id);
    if (c) { c.isExport = true; c.selected = false; return c; }
    c = { id: id, summary: 'Daynote', primary: false, color: null, accessRole: 'owner', timeZone: null, selected: false, isExport: true,
          syncToken: null, windowStart: null, windowEnd: null, fullSyncAt: null, lastSyncAt: null, nextPullAt: null, error: null };
    g.calendars.push(c);
    return c;
  }

  // 되읽기 반영 (조용한 mutate). 지운 것 반영은 applyRemoteDeletes 가 따로 한다. → { changed, edited, relinked, orphans, mirrored }
  //   changed 는 블록·일정·링크·보낼 목록의 변화 수다 (엔진이 silent 를 정할 때 — 동기화 한 줄·설정 카드도 다시 그려야 한다)
  function applyOwnPull(state, plan, ctx) {
    var g = ensure(state);
    var t = nowOf(ctx), nowIso = iso(t);
    var out = { changed: 0, edited: 0, relinked: 0, orphans: 0, mirrored: 0 };
    if (!plan || !plan.calendarId || (g.exportCalendarId && plan.calendarId !== g.exportCalendarId)) return out;
    var cal = exportCalEntry(g, plan.calendarId);
    var blocks = index(state.blocks);

    arr(plan.adoptLinks).forEach(function (a) {
      if (!a || !blocks[a.blockId] || g.links[a.blockId]) return;
      g.links[a.blockId] = Object.assign({}, a.link);
      g.gens[a.blockId] = Math.max(Number(g.gens[a.blockId]) || 0, Number(a.link.gen) || 0);
      out.relinked++;
      out.changed++;
    });
    arr(plan.remoteEdits).forEach(function (x) {
      var b = x && blocks[x.blockId], L = x && g.links[x.blockId];
      if (!b || !L || (x.link.eventId && L.eventId !== x.link.eventId)) return;
      if (bodyIn(state, g, b, ctx).hash !== L.hash) return;                     // 그 사이 Daynote 에서 바뀜 — Daynote 가 이긴다
      var keys = Object.keys(x.patch || {});
      keys.forEach(function (k) { b[k] = x.patch[k]; });
      L.etag = x.link.etag; L.remoteUpdated = x.link.remoteUpdated; L.hash = x.link.hash; L.end = b.end;
      if (keys.length) { out.edited++; out.changed++; }
    });
    arr(plan.reinserts).forEach(function (id) {
      var L = g.links[id];
      if (!L) return;                                                           // 이미 정리됨 — 세대를 또 올리지 않는다
      g.gens[id] = nextGen(g, id, L.gen);
      delete g.links[id];
      out.changed++;
    });
    arr(plan.dropLinks).forEach(function (id) {
      var L = g.links[id];
      if (!L) return;
      if (blocks[id]) g.gens[id] = nextGen(g, id, L.gen);                       // 블록이 남아 있으면 지워진 id 는 다시 못 쓴다
      delete g.links[id];
      out.changed++;
    });
    arr(plan.orphans).forEach(function (o) {
      var id = ORPHAN + o.eventId;
      if (findEntry(g, id)) return;
      g.outbox.push(newEntry(id, 'delete', null, o.eventId, plan.calendarId, nowIso));
      out.orphans++;
      out.changed++;
    });
    out.changed += removeKeysFrom(g, plan.calendarId, plan.removeKeys, []);
    out.mirrored = upsertEvents(g, plan.mirrors);
    out.changed += out.mirrored;
    applyCursor(cal, plan.cursor, t);
    return out;
  }

  // Google 에서 지운 일정을 Daynote 에서도 지운다 — 라벨 있는 mutate('Google에서 지운 일정 반영') 안에서 부른다.
  // 되돌리면 블록이 돌아오고 링크는 없고 세대가 올라가 있으므로 다음 reconcile 이 새 id 로 다시 올린다. → { deleted }
  function applyRemoteDeletes(state, plan, ctx) {
    var g = ensure(state);
    var out = { deleted: 0 };
    arr(plan && plan.remoteDeletes).forEach(function (x) {
      var id = x && x.blockId;
      var L = id ? g.links[id] : null;
      if (!L) return;
      var b = M.byId(arr(state.blocks), id);
      g.gens[id] = nextGen(g, id, L.gen);
      delete g.links[id];
      if (!b) return;
      // 그 사이 Daynote 가 Google 에서 빼려던 블록이 됨(내가 보낸 delete 의 메아리일 수 있다) — 블록은 지우지 않는다
      if (!linkable(state, g, b) || pendingDelete(g, id)) return;
      if (bodyIn(state, g, b, ctx).hash !== L.hash) return;                     // 그 사이 Daynote 에서 바뀜 — 다시 올린다
      M.deleteBlock(state, id);
      out.deleted++;
    });
    return out;
  }

  // ------------------------------------------------------------------ 표시
  //   → { calendars, selected, events, pending, failed, lastSyncAt, lastError, exportError, draining }
  //   calendars·selected 는 가져오기 캘린더 수(‘Daynote’ 제외), failed 는 오류가 남은 항목, draining 은 끈 뒤 남은 delete 수
  function summary(state, now) {
    var g = view(state);
    var imports = g.calendars.filter(function (c) { return c && !c.isExport; });
    var ws = isNaN(ms(now)) ? NaN : ms(windowFor(now).start);      // now 가 없으면 모두 센다
    var events = g.events.filter(function (ev) { return ev && (isNaN(ws) || ms(ev.end) >= ws); }).length;
    var pending = 0, failed = 0, draining = 0, exportError = null;
    g.outbox.forEach(function (e) {
      if (!e) return;
      if (e.drain) draining++;
      if (e.lastError) {
        failed++;
        if (STOP_TYPES[e.lastError.type] && !exportError) exportError = e.lastError.type;
      } else {
        pending++;
      }
    });
    return {
      calendars: imports.length, selected: imports.filter(function (c) { return c.selected; }).length,
      events: events, pending: pending, failed: failed,
      lastSyncAt: g.lastSyncAt, lastError: g.lastError, exportError: exportError, draining: draining
    };
  }

  // 일정 대화상자의 동기화 한 줄 → null | 'synced' | 'pending' | 'failed' | 'uncertain'
  function blockSyncState(state, blockId, ctx) {
    var g = view(state);
    var b = M.byId(arr(state && state.blocks), blockId);
    if (!b || !g.settings.exportEnabled) return null;
    if (b.timeUncertain) return 'uncertain';
    var e = findEntry(g, 'op:' + blockId);
    if (e && e.lastError) return 'failed';
    if (e) return 'pending';
    if (g.links[blockId]) return 'synced';
    if (exportable(state, b, ctx)) return 'pending';
    return null;
  }

  return {
    WINDOW_PAST_DAYS: WINDOW_PAST_DAYS, WINDOW_FUTURE_DAYS: WINDOW_FUTURE_DAYS, RESYNC_DRIFT_DAYS: RESYNC_DRIFT_DAYS,
    FULL_SYNC_MAX_AGE_DAYS: FULL_SYNC_MAX_AGE_DAYS, EXPORT_PAST_HOURS: EXPORT_PAST_HOURS, LINK_KEEP_DAYS: LINK_KEEP_DAYS,
    MAX_ATTEMPTS: MAX_ATTEMPTS, MARKER: MARKER,
    emptyGcal: emptyGcal, ensure: ensure, resetForAccount: resetForAccount, mergeCalendarList: mergeCalendarList,
    setSelected: setSelected, disableExport: disableExport,
    windowFor: windowFor, needsFullSync: needsFullSync, pullRequest: pullRequest,
    eventKey: eventKey, normalizeEvent: normalizeEvent, isBusy: isBusy,
    planPull: planPull, applyPull: applyPull, applySeries: applySeries, resetCalendar: resetCalendar, prune: prune,
    eventIdFor: eventIdFor, exportable: exportable, keepLinked: keepLinked, eventBody: eventBody, remoteHash: remoteHash,
    reconcile: reconcile, dueOps: dueOps, applyPushResults: applyPushResults, backoffMs: backoffMs,
    planOwnPull: planOwnPull, applyOwnPull: applyOwnPull, applyRemoteDeletes: applyRemoteDeletes,
    summary: summary, blockSyncState: blockSyncState
  };
});
