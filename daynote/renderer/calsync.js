'use strict';

// 회사 캘린더(ICS) 구독 — 설정에서 넣은 주소를 앱을 켤 때와 30분마다 가져와 '읽기 전용 일정' 으로 넣는다 (UX 점검 C-09)
//   회의가 Daynote 에 보여야 빈 시간 찾기·추천·2주 띠의 '바쁜 날'·하루 마감이 맞는다
//   시간이 있는 일정 → blocks (origin 'ics', calId) · 종일 일정 → meta.extDays [{ calId, date, title }]
//   되돌리기 대상이 아니다 (store 의 undo 가 지금 것을 유지한다). 주소에는 비공개 토큰이 있으니 화면·로그에 그대로 내지 않는다
(function () {
  var DN = window.Daynote, S = DN.store, M = DN.model, D = DN.dates;
  var PAST_DAYS = 7, AHEAD_DAYS = 60, EVERY = 30 * 60000, MAX_EVENTS = 2000;
  var running = {};

  function now() { return DN.app ? DN.app.now() : new Date(); }
  function list() { return (S.state.prefs.calendars || []).slice(); }
  // 다시 가져와도 같은 일정은 같은 id — 열어 둔 창·겹침 표시가 끊기지 않게
  function stableId(calId, uid) {
    var s = calId + '|' + uid, h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return 'ics_' + (h >>> 0).toString(36) + '_' + s.length.toString(36);
  }
  // 화면에 보일 주소 — 비공개 토큰은 감춘다
  function maskUrl(url) {
    var m = String(url || '').match(/^(?:https?|webcals?):\/\/([^/?#]+)/i);
    return m ? m[1] + '/…' : '';
  }

  // 가져온 ICS 글 → 그 캘린더의 일정을 통째로 갈아 끼운다. 반환: 넣은 일정 수
  function apply(calId, text) {
    var n = now();
    var from = D.addDays(D.startOfDay(n), -PAST_DAYS), to = D.addDays(D.startOfDay(n), AHEAD_DAYS);
    var ev = DN.ics.parse(text, { from: from, to: to });
    var timed = ev.filter(function (e) { return !e.allDay; }).slice(0, MAX_EVENTS);
    var allDay = ev.filter(function (e) { return e.allDay; });
    S.mutate(null, function (s) {
      s.blocks = s.blocks.filter(function (b) { return !(b.origin === 'ics' && b.calId === calId); });
      var seen = {};
      timed.forEach(function (e) {
        var id = stableId(calId, e.uid);
        if (seen[id]) return;
        seen[id] = true;
        M.addBlock(s, { id: id, kind: 'event', origin: 'ics', calId: calId, title: e.title, location: e.location, start: e.start, end: e.end });
      });
      var days = (s.meta.extDays || []).filter(function (x) { return x.calId !== calId; });
      allDay.forEach(function (e) {
        // 여러 날 종일 일정(휴가 등)은 하루씩 — 기간 안의 날만
        for (var d = D.startOfDay(new Date(e.start)), k = 0; d < new Date(e.end) && k < 62; d = D.addDays(d, 1), k++) {
          if (d >= from && d < to) days.push({ calId: calId, date: D.ymd(d), title: e.title });
        }
      });
      s.meta.extDays = days;
      var c = M.byId(s.prefs.calendars || [], calId);
      if (c) { c.lastSync = new Date().toISOString(); c.error = null; c.count = timed.length + allDay.length; }
    }, { source: 'calendar' });
    return timed.length + allDay.length;
  }

  function setError(calId, msg) {
    S.mutate(null, function (s) {
      var c = M.byId(s.prefs.calendars || [], calId);
      if (c) { c.error = msg; c.lastTry = new Date().toISOString(); }
    }, { source: 'calendar' });
  }

  // 주소로 가져오기 (파일로 넣은 캘린더는 다시 가져올 것이 없다)
  function sync(calId) {
    var c = M.byId(S.state.prefs.calendars || [], calId);
    if (!c || !c.url) return Promise.resolve({ ok: false, error: '주소가 없는 캘린더예요' });
    if (running[calId]) return running[calId];
    var host = S.host;
    if (!host.fetchCalendar) return Promise.resolve({ ok: false, error: '이 환경에서는 가져올 수 없어요' });
    var p = host.fetchCalendar(c.url).then(function (r) {
      if (!r || !r.ok) { setError(calId, (r && r.error) || '가져오지 못했어요'); return { ok: false, error: (r && r.error) || '가져오지 못했어요' }; }
      try { return { ok: true, count: apply(calId, r.text) }; }
      catch (e) { setError(calId, '캘린더 내용을 읽지 못했어요'); return { ok: false, error: '캘린더 내용을 읽지 못했어요' }; }
    }, function () {
      setError(calId, '가져오지 못했어요');
      return { ok: false, error: '가져오지 못했어요' };
    }).then(function (r) { delete running[calId]; return r; });
    running[calId] = p;
    return p;
  }
  function syncAll(force) {
    var t = Date.now();
    return Promise.all(list().filter(function (c) {
      if (!c.url) return false;
      var last = new Date(c.lastSync || c.lastTry || 0).getTime();
      return force || t - last >= EVERY - 60000;
    }).map(function (c) { return sync(c.id); }));
  }

  // 새 구독 — 이름·주소. 바로 한 번 가져온다
  function add(name, url) {
    var id = M.uid('cal');
    S.mutate(null, function (s) {
      s.prefs.calendars = (s.prefs.calendars || []).concat([{ id: id, name: String(name || '').trim() || '회사 캘린더', url: String(url || '').trim(), lastSync: null, error: null, count: 0 }]);
    }, { source: 'calendar' });
    return sync(id).then(function (r) { return Object.assign({ id: id }, r); });
  }
  // 파일로 한 번 가져오기 — 주소 없이, 같은 이름의 파일 캘린더는 갈아 끼운다
  function importFile(name, text) {
    if (!/BEGIN:VCALENDAR/i.test(String(text || ''))) return { ok: false, error: '캘린더(ICS) 파일이 아니에요' };
    var label = String(name || '').replace(/\.ics$/i, '') || 'ICS 파일';
    var ex = list().filter(function (c) { return !c.url && c.name === label; })[0];
    var id = ex ? ex.id : M.uid('cal');
    if (!ex) S.mutate(null, function (s) { s.prefs.calendars = (s.prefs.calendars || []).concat([{ id: id, name: label, url: null, lastSync: null, error: null, count: 0 }]); }, { source: 'calendar' });
    try { return { ok: true, id: id, count: apply(id, text) }; }
    catch (e) { setError(id, '캘린더 내용을 읽지 못했어요'); return { ok: false, error: '캘린더 내용을 읽지 못했어요' }; }
  }
  // 구독 빼기 — 가져온 일정도 함께 지운다
  function remove(calId) {
    S.mutate(null, function (s) {
      s.prefs.calendars = (s.prefs.calendars || []).filter(function (c) { return c.id !== calId; });
      s.blocks = s.blocks.filter(function (b) { return !(b.origin === 'ics' && b.calId === calId); });
      s.meta.extDays = (s.meta.extDays || []).filter(function (x) { return x.calId !== calId; });
    }, { source: 'calendar' });
  }

  // 그날의 종일 일정 제목들
  function allDayOn(state, ymd) {
    return ((state.meta && state.meta.extDays) || []).filter(function (x) { return x.date === ymd; });
  }
  function calName(state, calId) {
    var c = M.byId((state.prefs && state.prefs.calendars) || [], calId);
    return c ? c.name : '외부 캘린더';
  }
  function isExternal(b) { return !!(b && b.origin === 'ics'); }

  var timer = null;
  function start() {
    if (timer) return;
    syncAll(false);
    timer = setInterval(function () { syncAll(false); }, 5 * 60000);
    // 잠자기에서 깨어나거나 창으로 돌아왔을 때 오래됐으면 다시
    window.addEventListener('focus', function () { syncAll(false); });
  }

  DN.calsync = { start: start, sync: sync, syncAll: syncAll, add: add, importFile: importFile, remove: remove, apply: apply,
    allDayOn: allDayOn, calName: calName, isExternal: isExternal, maskUrl: maskUrl };
})();
