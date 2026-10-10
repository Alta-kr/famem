'use strict';

// Google 캘린더 동기화 엔진 (DN.gcalSync) — GOOGLE §7.6 · §8.10.
//
//  - 규칙은 모두 순수 코어(DN.gcal = G)에 있다. 이 파일은 "언제 무엇을 부를지"와 host(메인 프로세스) 호출만 맡는다.
//  - 동기화가 만든 변경은 모두 S.mutate(null, fn, {source:'gcal', silent: changed === 0}) 다 — 되돌리기에 쌓이지 않고,
//    바뀐 것이 없으면 다시 그리지 않는다. 단 Google 에서 지운 일정의 반영만은 라벨 있는 mutate('Google에서 지운 일정 반영')라
//    되돌릴 수 있다.
//  - 한 번에 하나만 돈다(syncNow 는 실행 중이면 다시 돌 표시만 하고 같은 Promise 를 돌려준다).
//  - 시작 3초 뒤, 10분마다, 온라인이 됐을 때, 창이 다시 보이고 2분 넘게 지났을 때, 로그인했을 때 돈다.
//    Daynote 에서 블록을 바꾸면(gcal 이 아닌 변경·되돌리기) 4초 뒤 올리기만 한다.
//  - 브라우저 미리보기·검사 실행(host.google 없음 또는 available:false)에서는 아무것도 하지 않는다.
//  - 토큰·비밀값은 이 파일을 지나가지 않는다 — host 가 주는 GoogleStatus 에는 애초에 없다.

(function () {
  var DN = window.Daynote;

  var START_DELAY = 3000;
  var INTERVAL = 10 * 60000;
  var PUSH_DELAY = 4000;
  var FOCUS_GAP = 2 * 60000;
  var CAL_LIST_MAX_AGE = 24 * 3600000;
  var PUSH_ROUNDS = 4;
  var PUSH_BATCH = 25;
  var AUTH_TYPES = { auth: true, reauth: true, not_signed_in: true, needs_scope: true, unavailable: true };
  var RESET_TYPES = { sync_token_gone: true, too_many_changes: true };
  var OFFLINE_TYPES = { network: true, timeout: true };
  var ERROR_TEXT = {
    network: '인터넷에 연결되지 않아 동기화를 미뤘어요. 연결되면 다시 할게요.',
    timeout: '인터넷에 연결되지 않아 동기화를 미뤘어요. 연결되면 다시 할게요.',
    rate_limit: 'Google이 잠시 요청을 막았어요. 잠시 뒤 다시 할게요.',
    quota: '오늘 쓸 수 있는 Google 요청량을 다 썼어요. 잠시 뒤 다시 할게요.'
  };

  var status = { available: false, state: 'loading', signedIn: false };
  var phase = 'idle';
  var listeners = [];
  var running = null;          // 지금 도는 Promise
  var rerun = false;           // 도는 중에 다시 돌려 달라는 요청이 왔다
  var pushAfter = false;       // 도는 중에 올리기 요청이 왔다
  var timer = null, pushTimer = null;
  var started = false;
  var lastRunAt = 0;           // 실제 시계(ms) — 경과 시간 재기용(포커스 2분 규칙)
  var calListAt = 0;           // 캘린더 목록을 마지막으로 받은 때(실제 시계)

  // ------------------------------------------------------------------ 도우미
  function S() { return DN.store; }
  function G() { return DN.gcal; }
  function ui() { return DN.ui; }
  function host() { var s = S(); return s && s.host ? s.host : null; }
  function hasHost() { var hs = host(); return !!(hs && hs.google && hs.gcal && G()); }
  function now() { return DN.app && DN.app.now ? DN.app.now() : new Date(); }
  function tz() {
    try { return (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'Asia/Seoul'; } catch (e) { return 'Asia/Seoul'; }
  }
  function ms(x) { var t = x instanceof Date ? x.getTime() : new Date(x).getTime(); return t; }
  function toast(msg, opts) { if (ui() && ui().toast) ui().toast(msg, opts); }

  function errOf(res, fallbackType) {
    var e = res && res.error;
    if (e && typeof e === 'object') return { type: String(e.type || fallbackType || 'unknown'), message: String(e.message || ''), retryAfterMs: e.retryAfterMs || null };
    return { type: fallbackType || 'unknown', message: '', retryAfterMs: null };
  }
  function wrap(p) {
    return Promise.resolve(p).then(function (r) { return r || { ok: false, error: { type: 'unknown', message: '' } }; },
      function (e) { return { ok: false, error: { type: 'unknown', message: String((e && e.message) || e || '') } }; });
  }

  // 동기화용 mutate — 바뀐 수를 fn 안에서 세고, 그 결과로 silent 를 정한다.
  // store.mutate 는 fn 을 부른 뒤에 opts.silent 를 읽으므로 같은 opts 객체를 고쳐서 넘긴다.
  function gm(fn) {
    var opts = { source: 'gcal', silent: true };
    return S().mutate(null, function (s) {
      G().ensure(s);
      var before = JSON.stringify(s.gcal);
      var r = fn(s) || {};
      var n = typeof r.changed === 'number' ? r.changed : 0;
      if (!n && JSON.stringify(s.gcal) !== before) n = 1;
      opts.silent = n === 0;
      return r;
    }, opts);
  }

  function notify() {
    var info = { status: status, phase: phase };
    listeners.slice().forEach(function (fn) { try { fn(info); } catch (e) { console.error(e); } });
  }
  function setPhase(p) { if (phase !== p) { phase = p; notify(); } }

  function ctx() {
    var c = { now: now(), deviceId: status.deviceId || null, tz: tz() };
    if (status.email) c.selfEmail = status.email;
    return c;
  }

  // ------------------------------------------------------------------ 상태
  function cleanStatus(st) {
    if (!st || typeof st !== 'object') return { available: false, state: 'unavailable', signedIn: false, reason: null };
    var out = Object.assign({}, st);
    out.available = st.available !== false && st.state !== 'unavailable';
    out.signedIn = !!st.signedIn && out.available;
    if (!out.state) out.state = out.signedIn ? 'signed_in' : 'signed_out';
    return out;
  }

  function setStatus(st) {
    var prev = status;
    status = cleanStatus(st);
    if (status.signedIn) ensureTimer(); else stopTimer();
    notify();
    // 로그인이 막 끝났으면 바로 가져온다 (같은 회차가 돌고 있으면 그 Promise 가 맡는다)
    if (started && status.signedIn && !prev.signedIn) syncNow({ reason: 'signin' });
    return status;
  }

  function loadStatus() {
    if (!hasHost()) {
      return Promise.resolve(setStatus({ available: false, state: 'unavailable', signedIn: false,
        reason: 'Google 캘린더 연결은 데스크톱 앱에서만 쓸 수 있어요.' }));
    }
    return wrap(host().google.status()).then(function (st) {
      if (st && st.ok === false && st.status) st = st.status;
      if (!st || st.ok === false) st = { available: false, state: 'unavailable', signedIn: false, reason: (st && st.error && st.error.message) || null };
      return setStatus(st);
    });
  }

  function available() { return hasHost() && !!status.available; }

  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
  }

  // ------------------------------------------------------------------ 타이머
  function ensureTimer() {
    if (!started || timer) return;
    timer = setInterval(function () { if (status.signedIn) syncNow({ reason: 'timer' }); }, INTERVAL);
  }
  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

  // ------------------------------------------------------------------ 한 회차
  function emptyReport() {
    return { ok: true, pulled: {}, pushed: { done: 0, failed: 0 }, edited: 0, remoteDeleted: 0, inserted: 0 };
  }

  function syncNow(opts) {
    var reason = (opts && opts.reason) || 'manual';
    if (running) { rerun = true; return running; }
    running = runSync(reason).catch(function (e) {
      console.error(e);
      return { ok: false, pulled: {}, pushed: { done: 0, failed: 0 }, edited: 0, remoteDeleted: 0, error: { type: 'unknown', message: String(e && e.message || e) } };
    }).then(function (report) {
      running = null;
      finishRun();
      return report;
    });
    return running;
  }

  function finishRun() {
    if (rerun) { rerun = false; pushAfter = false; setTimeout(function () { syncNow({ reason: 'rerun' }); }, 0); }
    else if (pushAfter) { pushAfter = false; setTimeout(pushOnly, 0); }
  }

  // 오류를 캘린더 줄에 적는다 (레이트 리밋이면 모든 호출을 멈출 시각도)
  function recordCalError(calendarId, err) {
    gm(function (s) {
      var g = s.gcal, t = now();
      var c = null;
      g.calendars.forEach(function (x) { if (x && x.id === calendarId) c = x; });
      if (c) c.error = { type: err.type, message: err.message, at: t.toISOString() };
      if (err.type === 'rate_limit' || err.type === 'quota') {
        var wait = Math.max(Number(err.retryAfterMs) || 0, err.type === 'quota' ? 3600000 : 60000);
        var until = t.getTime() + wait;
        if (!(ms(g.backoffUntil) >= until)) g.backoffUntil = new Date(until).toISOString();
      }
      return { changed: 1 };
    });
  }

  function exportCal(g) {
    if (!g.exportCalendarId) return null;
    for (var i = 0; i < g.calendars.length; i++) if (g.calendars[i] && g.calendars[i].id === g.exportCalendarId) return g.calendars[i];
    return { id: g.exportCalendarId, isExport: true, selected: false, syncToken: null };
  }
  function findCal(id) {
    var cs = (S().state.gcal && S().state.gcal.calendars) || [];
    for (var i = 0; i < cs.length; i++) if (cs[i] && cs[i].id === id) return cs[i];
    return null;
  }

  // 지금 ‘Daynote’ 캘린더 id 를 정하고, 그 캘린더가 가져오기 목록에 남아 있으면 되읽기 전용으로 돌린다
  function setExportCalendar(s, id) {
    var g = s.gcal, changed = 0;
    if (!id) return { changed: 0 };
    if (g.exportCalendarId !== id) { g.exportCalendarId = id; changed++; }
    g.calendars.forEach(function (c) {
      if (c && c.id === id && !c.isExport) {
        G().resetCalendar(s, id);
        c.isExport = true; c.selected = false; changed++;
      }
    });
    return { changed: changed };
  }

  function runSync(reason) {
    var report = emptyReport();
    var errors = [];
    var manual = reason === 'manual';
    if (!hasHost()) return Promise.resolve({ ok: false, pulled: {}, pushed: { done: 0, failed: 0 }, edited: 0, remoteDeleted: 0, error: { type: 'unavailable' } });
    lastRunAt = Date.now();

    return loadStatus().then(function (st) {
      if (!st.available || !st.signedIn) { setPhase('idle'); report.ok = false; report.error = { type: st.available ? 'not_signed_in' : 'unavailable' }; return report; }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setPhase('offline');
        if (manual) toast(ERROR_TEXT.network);
        report.ok = false; report.error = { type: 'network' };
        return report;
      }
      setPhase('syncing');

      // 계정 확인 · ‘Daynote’ 캘린더 id 사본
      gm(function (s) {
        var changed = 0;
        if (s.gcal.accountId !== (st.accountId || null)) { G().resetForAccount(s, st.accountId || null); changed++; calListAt = 0; }
        if (st.exportCalendarId) changed += setExportCalendar(s, st.exportCalendarId).changed;
        return { changed: changed };
      });

      var step = Promise.resolve();
      // 캘린더 목록 (없거나 하루 지났으면)
      step = step.then(function () {
        var g = S().state.gcal;
        var imports = g.calendars.filter(function (c) { return c && !c.isExport; });
        if (imports.length && calListAt && Date.now() - calListAt < CAL_LIST_MAX_AGE) return null;
        return wrap(host().gcal.calendars()).then(function (r) {
          if (!r.ok) { errors.push(errOf(r)); return; }
          calListAt = Date.now();
          var c = ctx();
          gm(function (s) { return G().mergeCalendarList(s, r.items || [], c); });
        });
      });
      // ‘Daynote’ 캘린더 확보
      step = step.then(function () {
        var g = S().state.gcal;
        if (!g.settings.exportEnabled || g.exportCalendarId || !(st.scopes && st.scopes.appCalendar)) return null;
        return wrap(host().gcal.ensureExportCalendar({ tz: tz(), preferId: null })).then(function (r) {
          if (!r.ok || !r.calendar || !r.calendar.id) { errors.push(errOf(r)); return; }
          gm(function (s) { return setExportCalendar(s, r.calendar.id); });
        });
      });
      // 가져오기 · 되읽기
      step = step.then(function () {
        var g = S().state.gcal;
        if (ms(g.backoffUntil) > now().getTime()) { report.backoff = true; return null; }
        var list = g.calendars.filter(function (c) { return c && !c.isExport && c.selected && c.accessRole !== 'freeBusyReader'; })
          .map(function (c) { return c.id; });
        var ex = g.settings.exportEnabled ? exportCal(g) : null;
        var all = list.map(function (id) { return { id: id, own: false }; });
        if (ex) all.push({ id: ex.id, own: true });
        var chain = Promise.resolve();
        var stop = false;
        all.forEach(function (item) {
          chain = chain.then(function () { if (!stop) return pullOne(item, report, errors).then(function (halt) { if (halt) stop = true; }); });
        });
        return chain;
      });
      // 올리기
      step = step.then(function () {
        var g = S().state.gcal;
        var sum = G().summary(S().state, now());
        if (!g.settings.exportEnabled && !sum.draining) return null;
        setPhase('pushing');
        return pushRounds(report, errors);
      });
      return step.then(function () { return finish(report, errors, manual); });
    });
  }

  // 캘린더 하나 받기 → true 면 이번 회차의 남은 캘린더를 건너뛴다 (로그인 문제·레이트 리밋)
  function pullOne(item, report, errors) {
    var cal = item.own ? exportCal(S().state.gcal) : findCal(item.id);
    if (!cal) return Promise.resolve(false);
    var list = function (c) { return wrap(host().gcal.list(G().pullRequest(c, now()))); };
    return list(cal).then(function (res) {
      if (!res.ok && RESET_TYPES[errOf(res).type]) {
        gm(function (s) { return { changed: G().resetCalendar(s, item.id).removed }; });
        var fresh = item.own ? exportCal(S().state.gcal) : findCal(item.id);
        if (!fresh) return res;
        return list(fresh);
      }
      return res;
    }).then(function (res) {
      if (!res.ok) {
        var err = errOf(res);
        errors.push(err);
        recordCalError(item.id, err);
        return !!(AUTH_TYPES[err.type] || err.type === 'rate_limit' || err.type === 'quota');
      }
      var c = ctx();
      if (item.own) {
        var full = Object.assign({}, res, { calendarId: item.id });
        var plan = G().planOwnPull(S().state, full, c);
        var r = gm(function (s) { return G().applyOwnPull(s, plan, c); });
        report.edited += (r && r.edited) || 0;
        if (plan.remoteDeletes && plan.remoteDeletes.length) applyRemoteDeletes(plan, c, report);
        report.pulled[item.id] = { full: !!plan.full, upserted: (r && r.mirrored) || 0, removed: 0 };
        return false;
      }
      var p = G().planPull(S().state, item.id, res, c);
      gm(function (s) { return G().applyPull(s, p, c.now); });
      report.pulled[item.id] = { full: !!p.full, upserted: p.stats ? p.stats.upserted : 0, removed: p.stats ? p.stats.removed : 0 };
      var w = G().windowFor(c.now);
      var chain = Promise.resolve();
      (p.refetchSeries || []).forEach(function (sid) {
        chain = chain.then(function () {
          return wrap(host().gcal.instances({ calendarId: item.id, eventId: sid, timeMin: w.start, timeMax: w.end })).then(function (ri) {
            if (!ri.ok) { errors.push(errOf(ri)); return; }
            gm(function (s) { return G().applySeries(s, item.id, sid, ri.items || [], ctx()); });
          });
        });
      });
      return chain.then(function () { return false; });
    });
  }

  // Google 에서 지운 내 일정 → Daynote 블록 지우기 (되돌릴 수 있게 라벨 있는 mutate)
  function applyRemoteDeletes(plan, c, report) {
    var probe = 0;
    try { probe = G().applyRemoteDeletes(JSON.parse(JSON.stringify(S().state)), plan, c).deleted; } catch (e) { probe = 0; }
    if (!probe) {                      // 지울 블록이 없다 — 링크 정리만 (되돌리기에 빈 항목을 만들지 않는다)
      gm(function (s) { G().applyRemoteDeletes(s, plan, c); return { changed: 1 }; });
      return;
    }
    var out = S().mutate('Google에서 지운 일정 반영', function (s) { return G().applyRemoteDeletes(s, plan, c); }, { source: 'gcal' });
    var n = (out && out.deleted) || 0;
    report.remoteDeleted += n;
    if (n && ui() && ui().undoToast) ui().undoToast('Google 캘린더에서 지운 일정 ' + n + '개를 Daynote에서도 지웠어요.');
  }

  // reconcile + 최대 4번 보내기
  function pushRounds(report, errors) {
    var hadLinks = Object.keys(S().state.gcal.links || {}).length > 0;
    gm(function (s) { return G().reconcile(s, ctx()); });
    var round = 0, firstTime = 0;
    function next() {
      if (round >= PUSH_ROUNDS) return Promise.resolve();
      var c = ctx();
      var ops = G().dueOps(S().state, c, PUSH_BATCH);
      if (!ops.length) return Promise.resolve();
      round++;
      return wrap(host().gcal.push(ops)).then(function (r) {
        var res = gm(function (s) {
          var o = G().applyPushResults(s, ops, r, ctx());
          o.changed = (o.done || 0) + (o.failed || 0);
          return o;
        }) || {};
        report.pushed.done += res.done || 0;
        report.pushed.failed += res.failed || 0;
        var results = r && Array.isArray(r.results) ? r.results : [];
        ops.forEach(function (op) {
          if (op.op !== 'insert') return;
          var pr = results.filter(function (x) { return x && x.opId === op.opId; })[0];
          if (pr && pr.ok) { report.inserted++; if (!op.gen) firstTime++; }
        });
        if (res.exportError) report.exportError = res.exportError;
        if (!r.ok) { errors.push(errOf(r)); return; }
        if (ms(S().state.gcal.backoffUntil) > now().getTime()) return;
        return next();
      });
    }
    return next().then(function () {
      // 첫 업로드 알림 — 올린 적 없는(세대 0) 일정을 처음 올렸을 때만
      if (!hadLinks && firstTime > 0) {
        toast('Daynote 일정 ' + firstTime + '개를 Google 캘린더 ‘Daynote’에 올렸어요.');
      }
    });
  }

  function finish(report, errors, manual) {
    var main = errors.filter(function (e) { return e && e.type !== 'canceled'; })[0] || null;
    var t = now();
    gm(function (s) {
      var p = G().prune(s, t);
      s.gcal.lastSyncAt = t.toISOString();
      var before = JSON.stringify(s.gcal.lastError);
      s.gcal.lastError = main ? { type: main.type, message: main.message || '', at: t.toISOString() } : null;
      return { changed: (p.removed || 0) + (p.linksDropped || 0) + (JSON.stringify(s.gcal.lastError) !== before ? 1 : 0) };
    });
    if (report.edited > 0) toast('Google 캘린더에서 바꾼 일정 ' + report.edited + '개를 반영했어요.');
    if (main) {
      report.ok = false;
      report.error = main;
      if (AUTH_TYPES[main.type]) loadStatus();
      if (manual && ERROR_TEXT[main.type]) toast(ERROR_TEXT[main.type]);
    } else if (report.backoff && manual) {
      toast(ERROR_TEXT.rate_limit);
    }
    var g = S().state.gcal;
    if (main && OFFLINE_TYPES[main.type]) setPhase('offline');
    else if (ms(g.backoffUntil) > t.getTime()) setPhase('backoff');
    else if (main) setPhase('error');
    else setPhase('idle');
    notify();
    return report;
  }

  // ------------------------------------------------------------------ 올리기만
  function pushOnly() {
    if (!available() || !status.signedIn) return Promise.resolve(null);
    if (running) { pushAfter = true; return running; }
    var report = emptyReport(), errors = [];
    running = Promise.resolve().then(function () {
      var g = S().state.gcal;
      if (!g) return report;
      var sum = G().summary(S().state, now());
      if (!g.settings.exportEnabled && !sum.draining) return report;
      setPhase('pushing');
      return pushRounds(report, errors).then(function () {
        var main = errors[0] || null;
        if (main) gm(function (s) { s.gcal.lastError = { type: main.type, message: main.message || '', at: now().toISOString() }; return { changed: 1 }; });
        var bo = ms(S().state.gcal.backoffUntil) > now().getTime();
        setPhase(main && OFFLINE_TYPES[main.type] ? 'offline' : bo ? 'backoff' : main ? 'error' : 'idle');
        return report;
      });
    }).catch(function (e) { console.error(e); return report; }).then(function (r) { running = null; finishRun(); return r; });
    return running;
  }

  function schedulePush() {
    if (!available() || !status.signedIn) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushOnly, PUSH_DELAY);
  }

  // ------------------------------------------------------------------ 계정·설정 (host 감싸기)
  function signIn() {
    if (!hasHost()) return Promise.resolve({ ok: false, error: { type: 'unavailable', message: '' } });
    status = Object.assign({}, status, { state: 'connecting', error: null });
    notify();
    return wrap(host().google.signIn({ loginHint: status.email || null })).then(function (res) {
      if (res.status) setStatus(res.status); else loadStatus();
      if (res.ok && status.signedIn) {
        toast('Google 계정(' + (status.email || '') + ')을 연결했어요. 일정을 가져오는 중이에요.');
        syncNow({ reason: 'signin' });
      }
      return res;
    });
  }

  function cancelSignIn() {
    if (!hasHost()) return Promise.resolve({ ok: true });
    return wrap(host().google.cancelSignIn()).then(function (res) { return loadStatus().then(function () { return res; }); });
  }

  function signOut() {
    if (!hasHost()) return Promise.resolve({ ok: false, error: { type: 'unavailable', message: '' } });
    return wrap(host().google.signOut()).then(function (res) {
      if (!res.ok) { if (res.status) setStatus(res.status); return res; }
      S().mutate(null, function (s) { G().resetForAccount(s, null); }, { source: 'gcal' });
      calListAt = 0;
      if (res.status) setStatus(res.status); else loadStatus();
      if (res.revoked === false) {
        toast('이 컴퓨터에서는 해제했어요. Google 쪽 권한은 Google 계정 설정에서 지울 수 있어요.',
          { action: { label: '열기', fn: function () { window.open('https://myaccount.google.com/connections'); } } });
      } else {
        toast('Google 연결을 해제했어요.');
      }
      setPhase('idle');
      return res;
    });
  }

  function setClient(input) {
    if (!hasHost()) return Promise.resolve({ ok: false, error: { type: 'unavailable', message: '' } });
    return wrap(host().google.setClient(input || {})).then(function (res) {
      if (res.status) setStatus(res.status); else loadStatus();
      return res;
    });
  }

  function clearClient() {
    if (!hasHost()) return Promise.resolve({ ok: false, error: { type: 'unavailable', message: '' } });
    return wrap(host().google.clearClient()).then(function (res) {
      if (res.status) setStatus(res.status); else loadStatus();
      return res;
    });
  }

  function setSelected(calendarId, on) {
    if (!G()) return Promise.resolve(null);
    S().mutate(null, function (s) { return G().setSelected(s, calendarId, !!on); }, { source: 'gcal-settings' });
    return syncNow({ reason: 'select' });
  }

  // patch ⊂ { exportEnabled, exportWork, exportTitles }. 끌 때는 opts.removeFuture (화면이 물어본 답)
  function setExport(patch, opts) {
    if (!G()) return Promise.resolve(null);
    patch = patch || {};
    S().mutate(null, function (s) {
      var g = G().ensure(s);
      if (patch.exportEnabled === false && g.settings.exportEnabled) G().disableExport(s, { removeFuture: !!(opts && opts.removeFuture) }, now());
      else if (patch.exportEnabled === true) g.settings.exportEnabled = true;
      if (typeof patch.exportWork === 'boolean') g.settings.exportWork = patch.exportWork;
      if (typeof patch.exportTitles === 'boolean') g.settings.exportTitles = patch.exportTitles;
    }, { source: 'gcal-settings' });
    if (!available() || !status.signedIn) return Promise.resolve(null);
    return syncNow({ reason: 'select' });
  }

  function refreshCalendars() {
    if (!available()) return Promise.resolve({ ok: false, error: { type: 'unavailable' } });
    return wrap(host().gcal.calendars()).then(function (r) {
      if (r.ok) {
        calListAt = Date.now();
        var c = ctx();
        gm(function (s) { return G().mergeCalendarList(s, r.items || [], c); });
      }
      return r;
    });
  }

  // ‘다시 만들기’ — Daynote 캘린더를 다시 찾거나 만든다
  function ensureExportCalendar() {
    if (!available()) return Promise.resolve({ ok: false, error: { type: 'unavailable' } });
    var prefer = (S().state.gcal && S().state.gcal.exportCalendarId) || null;
    return wrap(host().gcal.ensureExportCalendar({ tz: tz(), preferId: prefer })).then(function (r) {
      if (r.ok && r.calendar && r.calendar.id) {
        gm(function (s) {
          var out = setExportCalendar(s, r.calendar.id);
          // ‘쓸 수 없음’으로 멈춘 항목을 다시 보낼 수 있게
          s.gcal.outbox.forEach(function (e) {
            if (e && e.lastError && (e.lastError.type === 'calendar_missing' || e.lastError.type === 'write_denied')) {
              e.lastError = null; e.nextAt = null; e.attempts = 0; out.changed++;
            }
          });
          return out;
        });
        loadStatus().then(function () { syncNow({ reason: 'manual' }); });
      }
      return r;
    });
  }

  // ------------------------------------------------------------------ 시작
  function start() {
    if (started || !hasHost()) return;
    loadStatus().then(function (st) {
      if (!st.available) return;          // 브라우저 미리보기·검사 실행 — 타이머를 켜지 않는다
      started = true;
      if (st.signedIn) ensureTimer();
      try {
        if (host().google.onChanged) host().google.onChanged(function (next) { setStatus(next); });
      } catch (e) { console.error(e); }
      setTimeout(function () { syncNow({ reason: 'start' }); }, START_DELAY);
      window.addEventListener('online', function () { if (status.signedIn) syncNow({ reason: 'online' }); });
      window.addEventListener('offline', function () { if (status.signedIn) setPhase('offline'); });
      document.addEventListener('visibilitychange', function () {
        if (document.hidden || !status.signedIn) return;
        if (Date.now() - lastRunAt > FOCUS_GAP) syncNow({ reason: 'focus' });
      });
      S().subscribe(function (info) {
        if (!info) return;
        if ((info.type === 'change' && info.source !== 'gcal' && info.source !== 'gcal-settings') || info.type === 'undo') schedulePush();
      });
    });
  }

  if (DN.store && DN.store.whenReady) DN.store.whenReady(start);

  DN.gcalSync = {
    available: available,
    status: function () { return status; },
    loadStatus: loadStatus,
    onChange: onChange,
    phase: function () { return phase; },
    syncNow: syncNow,
    schedulePush: schedulePush,
    signIn: signIn, cancelSignIn: cancelSignIn, signOut: signOut,
    setClient: setClient, clearClient: clearClient,
    setSelected: setSelected, setExport: setExport,
    refreshCalendars: refreshCalendars, ensureExportCalendar: ensureExportCalendar,
    ctx: ctx
  };
})();
