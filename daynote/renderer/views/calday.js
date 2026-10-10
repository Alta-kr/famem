'use strict';

// 하루 패널 — 월간 보기 위에 그날 시간표를 연다(데스크톱: 오른쪽 시트, 폰: 아래 시트).
// 끌던 할 일이 있으면 추천 시간대(DN.planner)를 순위와 함께 보이고, 허용 띠 밖은 옅은 빗금으로 보인다.
// 놓으면 그 시각(15분 단위)에 넣는다. 머무르기로 연 패널은 끌기가 취소되면 함께 닫힌다(calendar.js).
// 캘린더가 다시 그려져도(_mount) 열린 채 같은 날·같은 할 일로 다시 그린다.

(function () {
  var DN = window.Daynote;
  var M = DN.model, D = DN.dates, S = DN.store, ui = DN.ui, h = ui.h;
  var RANK = ['①', '②', '③', '④', '⑤'];

  var cur = null;        // { ymd, opts }
  var host = null;       // .cal-main
  var hooks = {};        // { taskIds(), armBlock(el, b), cellFor(ymd), onPlaced(taskId), onClose(reason, opts) }
  var sheet = null;
  var info = { allowed: null, magnets: [] };
  var lastScroll = null;
  var listening = false;

  function PL() { return DN.planner || null; }
  function SL() { return DN.slots || null; }
  function CP() { return DN.views.calPlace || null; }
  function now() { return DN.app.now(); }
  function q(s) { return '‘' + s + '’'; }
  function phone() { return !!(window.matchMedia && window.matchMedia('(max-width: 640px)').matches); }

  function liveTask(id) { var t = id ? M.byId(S.state.tasks, id) : null; return t && !t.deletedAt ? t : null; }

  function freeMinutes(ymd) {
    if (!SL()) return null;
    var day = D.parseYmd(ymd);
    var ws = D.parseYmd(ymd, SL().DAY_WINDOW.start), we = D.parseYmd(ymd, SL().DAY_WINDOW.end);
    var busy = SL().merge(SL().collectBusy(S.state, D.startOfDay(day), D.addDays(D.startOfDay(day), 1)));
    var used = 0;
    busy.forEach(function (b) {
      var s = Math.max(b.start, ws.getTime()), e = Math.min(b.end, we.getTime());
      if (e > s) used += e - s;
    });
    return Math.max(0, Math.round((we - ws - used) / 60000));
  }

  function headMeta(ymd) {
    var day = D.parseYmd(ymd);
    var free = freeMinutes(ymd);
    var freeTxt = free == null ? '' : ' · 빈 시간 ' + (free ? D.duration(free) : '없음');
    if (!SL()) return freeTxt.replace(/^ · /, '');
    var wh = SL().normalizeWorkHours(S.state.prefs.workHours);
    var win = SL().workWindow(day, wh);
    return (win ? '근무일 ' + D.hm(win.start) + '–' + D.hm(win.end) : '쉬는 날') + freeTxt;
  }

  // 지금 패널이 다루는 할 일 / 블록
  function subject() {
    if (!cur) return null;
    var o = cur.opts || {};
    if (o.blockId) {
      var b = M.byId(S.state.blocks, o.blockId);
      if (!b) return null;
      var bt = liveTask(b.taskId);
      return bt ? { task: bt, block: b, minutes: D.minutesBetween(b.start, b.end) } : null;
    }
    var t = liveTask(o.taskId);
    if (!t || t.status === 'done') return null;
    var m = CP() ? CP()._fmt.lengthFor(t) : t.estimateMinutes;
    return { task: t, block: null, minutes: m };
  }

  function suggestions(sub, ymd) {
    if (!sub || !PL()) return [];
    var o = { now: now(), workHours: S.state.prefs.workHours, limit: 3, minutes: sub.minutes != null ? sub.minutes : 30 };
    if (sub.block) o.ignoreBlockId = sub.block.id;
    return PL().suggestSlots(S.state, sub.task.id, ymd, o);
  }
  function allowedWindows(sub, ymd) {
    if (!sub || !PL()) return null;
    return PL().windowsFor(S.state, sub.task, ymd, { now: now(), workHours: S.state.prefs.workHours })
      .map(function (w) { return { start: new Date(w.start), end: new Date(w.end) }; });
  }

  function place(sub, start, anchor) {
    if (!CP()) return;
    var p = sub.block
      ? CP().dropAtTime(null, start, anchor, { blockId: sub.block.id })
      : CP().dropAtTime(sub.task.id, start, anchor, {});
    p.then(function (ok) { if (ok && hooks.onPlaced) hooks.onPlaced(sub.task.id); });
  }

  function build() {
    var ymd = cur.ymd, o = cur.opts || {};
    var TL = CP() && CP()._tl;
    var n = now();
    var day = D.parseYmd(ymd);
    var sub = subject();
    var list = suggestions(sub, ymd);
    info = { allowed: allowedWindows(sub, ymd), magnets: list.map(function (c, i) { return { start: c.start, rank: i + 1 }; }) };

    var title = (day.getMonth() + 1) + '월 ' + day.getDate() + '일 ' + D.WEEKDAYS[day.getDay()] + '요일';
    var h3 = h('h3', { tabindex: '-1' }, title);
    var autoBtn = h('button.btn.btn-sm', { type: 'button', onclick: function (e) {
      var ids = hooks.taskIds ? hooks.taskIds() : [];
      if (CP()) CP().arrange(ymd, e.currentTarget, ids);
    } }, '이 날 자동 배치');
    var head = h('div.cd-head',
      h('div.cd-head-text', h3, h('div.meta', headMeta(ymd))),
      PL() ? autoBtn : null,
      h('button.icon-btn', { type: 'button', 'aria-label': '닫기', title: '닫기 (Esc)', onclick: function () { close('button'); } }, ui.icon('x')));

    var taskBox = null;
    if (sub) {
      var verb = sub.block ? ' 옮기기' : ' 넣기';
      taskBox = h('div.cd-task',
        h('div.cd-task-title', q(sub.task.title) + verb + ' · ' + (sub.minutes != null ? D.duration(sub.minutes) : '소요 시간 미정 — 놓으면 물어봐요')),
        list.length
          ? h('ol.cd-sugg-list', { 'aria-label': '추천 시간' }, list.map(function (c, i) {
            return h('li', h('button.cd-sugg-btn', { type: 'button', title: c.reasons.join(' '), onclick: function (e) { place(sub, c.start, e.currentTarget); } },
              RANK[i] + ' ' + D.hm(c.start) + '–' + D.hm(c.end) + ' · ' + (c.reasons[0] || '')));
          }))
          : h('div.cd-sugg-none', h('span.meta', '이 날에는 알맞은 빈 시간이 없어요.'), ' ',
            h('button.link-btn', { type: 'button', onclick: function () {
              if (!DN.views.schedule) return;
              if (sub.block) DN.views.schedule.open({ blockId: sub.block.id });
              else DN.views.schedule.open({ taskId: sub.task.id, start: D.parseYmd(ymd, '09:00') });
            } }, '시간 직접 정하기…')));
    }

    // 종일
    var allDay = TL ? TL.allDayItems(ymd) : [];
    var allRow = allDay.length ? h('div.cd-allday', allDay.map(function (x) {
      var el = h('button.cal-allday-item', { type: 'button', onclick: function (e) { TL.extOpen(x, e.currentTarget); } }, x.title);
      TL.setGc(el, x.color);
      return el;
    })) : null;

    // 시간표
    var px = TL ? TL.minToPx : function (m) { return m / 60 * 48; };
    var total = px(24 * 60);
    var hours = h('div.cd-hours', { style: { height: total + 'px' } });
    for (var hr = 1; hr < 24; hr++) hours.appendChild(h('div.cal-hour-label', { style: { top: px(hr * 60) + 'px' } }, D.pad(hr) + ':00'));
    var col = h('div.cd-col.cal-col' + (ymd === D.ymd(n) ? '.is-today' : ''), { 'data-drop': 'slot', 'data-day': ymd, 'data-autoscroll': '', 'aria-label': title + ' 시간표' });
    for (var i = 0; i < 48; i++) col.appendChild(h('div.cal-slot' + (i % 2 === 0 ? '.hour' : ''), { style: { top: px(i * 30) + 'px', height: px(30) + 'px' } }));
    if (info.allowed) {
      var dayStart = D.parseYmd(ymd), cursor = dayStart;
      var dayEnd = D.addDays(dayStart, 1);
      info.allowed.concat([{ start: dayEnd, end: dayEnd }]).forEach(function (w) {
        if (w.start > cursor) {
          col.appendChild(h('div.cd-band.is-off', { 'aria-hidden': 'true', style: {
            top: px(D.minutesBetween(dayStart, cursor)) + 'px', height: px(D.minutesBetween(cursor, w.start)) + 'px' } }));
        }
        if (w.end > cursor) cursor = w.end;
      });
    }
    list.forEach(function (c, i) {
      col.appendChild(h('div.cd-sugg', { 'aria-hidden': 'true', title: c.reasons.join(' '), style: {
        top: px(c.start.getHours() * 60 + c.start.getMinutes()) + 'px', height: px(c.minutes) + 'px' } },
        h('span.cd-rank', String(i + 1)), h('span.cd-sugg-time', D.hm(c.start) + '–' + D.hm(c.end))));
    });
    if (TL) TL.paintItems(col, ymd, { extra: 'cd-block', armBlock: hooks.armBlock });
    if (ymd === D.ymd(n)) col.appendChild(h('div.cal-now', { 'aria-hidden': 'true', style: { top: px(n.getHours() * 60 + n.getMinutes()) + 'px' } }));
    col.addEventListener('click', function (e) {
      if (e.target !== col && !e.target.classList.contains('cal-slot') && !e.target.classList.contains('cd-band')) return;
      if (!TL) return;
      var start = TL.timeAt(col, ymd, e.clientY, 0);
      var s2 = subject();
      if (s2) place(s2, start, col);
      else if (DN.views.schedule) DN.views.schedule.open({ event: true, start: start });
    });
    var grid = h('div.cd-grid', hours, col);
    var body = h('div.cd-body', { 'data-autoscroll': '' }, grid);
    body.addEventListener('scroll', function () { lastScroll = { ymd: ymd, top: body.scrollTop }; });

    var el = h('aside.cd-sheet', { role: 'region', 'aria-label': title + ' 시간표', 'data-day': ymd },
      h('div.cd-grip', { 'aria-hidden': 'true' }), head, taskBox, allRow, body);
    return { el: el, h3: h3, body: body, first: list[0] || null };
  }

  function mountSheet(focus) {
    if (sheet) { sheet.remove(); sheet = null; }
    if (!cur) return;
    if (!host || !host.isConnected) host = document.querySelector('.cal-main');
    if (!host) return;
    var b = build();
    sheet = b.el;
    host.appendChild(sheet);
    host.classList.add('has-day');
    var TL = CP() && CP()._tl;
    var px = TL ? TL.minToPx : function (m) { return m / 60 * 48; };
    if (lastScroll && lastScroll.ymd === cur.ymd) b.body.scrollTop = lastScroll.top;
    else {
      var startMin = b.first ? Math.max(0, b.first.start.getHours() * 60 + b.first.start.getMinutes() - 60) : 7 * 60;
      b.body.scrollTop = px(startMin);
      lastScroll = { ymd: cur.ymd, top: b.body.scrollTop };
    }
    if (focus) setTimeout(function () { if (b.h3.isConnected) b.h3.focus(); }, 0);
    listen(true);
  }

  // 폰: 시트 밖을 누르면 닫는다 · 어디서나: Esc 로 닫는다
  function onDocDown(e) {
    if (!cur || !sheet || !phone()) return;
    if (DN.dragPlace && DN.dragPlace.active()) return;
    var t = e.target;
    if (sheet.contains(t) || (t.closest && t.closest('.menu, .toast-wrap, .overlay, .modal'))) return;
    close('cancel');
  }
  function onDocKey(e) {
    if (!cur || e.key !== 'Escape' || e.defaultPrevented) return;
    if (DN.dragPlace && DN.dragPlace.active()) return;
    if (document.querySelector('.overlay') || document.querySelector('body > .menu')) return;
    if (DN.app.current().view !== 'calendar') return;
    var mem = DN.views.calendar && DN.views.calendar._mem;
    if (mem && mem.picking) return;   // 고르기 모드의 Esc 는 calendar 가 먼저 받는다
    e.preventDefault();
    close('esc');
  }
  function listen(on) {
    if (on === listening) return;
    listening = on;
    var f = on ? 'addEventListener' : 'removeEventListener';
    document[f]('pointerdown', onDocDown, true);
    document[f]('keydown', onDocKey);
  }

  function open(ymd, opts) {
    opts = opts || {};
    if (cur && cur.ymd === ymd && opts.openedBy === 'dwell' && (cur.opts || {}).taskId === opts.taskId) return;
    var prev = cur;
    cur = { ymd: ymd, opts: opts };
    if (!prev || prev.ymd !== ymd) lastScroll = null;
    mountSheet(!!opts.focus);
  }

  function close(reason) {
    if (!cur) return;
    var was = cur;
    cur = null;
    if (sheet) { sheet.remove(); sheet = null; }
    if (host) host.classList.remove('has-day');
    listen(false);
    info = { allowed: null, magnets: [] };
    if (hooks.onClose) hooks.onClose(reason, was.opts || {});
    if ((reason === 'esc' || reason === 'button') && (was.opts || {}).focus && hooks.cellFor) {
      var c = hooks.cellFor(was.ymd);
      if (c) setTimeout(function () { try { c.focus(); } catch (e) { /* 없음 */ } }, 0);
    }
  }

  DN.views.calDay = {
    open: open,
    close: close,
    isOpen: function () { return !!cur; },
    ymd: function () { return cur ? cur.ymd : null; },
    opts: function () { return cur ? cur.opts : null; },
    repaint: function () { if (cur) mountSheet(false); },
    // calendar.js 가 다시 그릴 때마다 부른다
    _mount: function (el, hk) { host = el; hooks = hk || {}; if (cur) mountSheet(false); },
    _dragInfo: function () { return info; },
    sheet: function () { return sheet; }
  };
})();
