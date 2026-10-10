'use strict';

// 캘린더 월간 격자 — 월요일 시작, 늘 6주(42칸). 끌기 도중 달을 넘겨도 칸 위치가 흔들리지 않게 6주로 고정한다.
// 칸에는 그날의 종일 일정·시각 있는 항목(그날 시작한 것만)·마감 수를 보인다. 폰에서는 숫자와 점만.
// 칸은 [data-drop=day] 놓기 대상이다(끌기는 calendar.js 가 DN.dragPlace 로 다룬다).
// 키보드: 칸 하나만 tabindex=0(roving). 화살표·Home/End·PageUp/PageDown·Enter·Esc.

(function () {
  var DN = window.Daynote;
  var M = DN.model, D = DN.dates, S = DN.store, ui = DN.ui, h = ui.h;
  var DESKTOP_LINES = 3, PHONE_DOTS = 3;
  var WEEK_HEAD = ['월', '화', '수', '목', '금', '토', '일'];

  function q(s) { return '‘' + s + '’'; }
  function SL() { return DN.slots || null; }

  function itemsOf(st, ymd) {
    var s = D.parseYmd(ymd), e = D.addDays(s, 1);
    var all = M.calendarItems(st, s.toISOString(), e.toISOString());
    var allDay = all.filter(function (x) { return x.allDay; });
    var timed = all.filter(function (x) { return !x.allDay && D.ymd(x.start) === ymd; }).sort(function (a, b) {
      var sa = new Date(a.start).getTime(), sb = new Date(b.start).getTime();
      if (sa !== sb) return sa - sb;
      var la = new Date(a.end).getTime() - sa, lb = new Date(b.end).getTime() - sb;
      if (la !== lb) return lb - la;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return allDay.concat(timed);
  }

  // ctx = { anchor, now, onOpenDay(ymd, opts), onDropTask(taskId, ymd, cellEl), picking, pickTitle,
  //         onCancelPick(), onPage(deltaMonths, focusYmd), focusYmd }
  function render(host, ctx) {
    var st = S.state;
    var now = ctx.now;
    var a = D.parseYmd(ctx.anchor);
    var month = a.getMonth(), year = a.getFullYear();
    var first = new Date(year, month, 1);
    var start = D.startOfWeek(first);
    var wh = SL() ? SL().normalizeWorkHours(st.prefs.workHours) : null;
    var todayKey = D.ymd(now);
    var picking = ctx.picking || null;
    var pickTitle = ctx.pickTitle || '';

    var dueByDay = {};
    M.liveTasks(st).forEach(function (t) {
      if (t.dueDate && t.status !== 'done') (dueByDay[t.dueDate] = dueByDay[t.dueDate] || []).push(t);
    });

    var grid = h('div.cm', { role: 'grid', 'aria-label': year + '년 ' + (month + 1) + '월', 'aria-readonly': 'true' });
    grid.appendChild(h('div.cm-weekdays', { role: 'row' }, WEEK_HEAD.map(function (w) { return h('div', { role: 'columnheader' }, w); })));
    var cells = {}, keys = [];

    function label(cell) {
      var key = cell.getAttribute('data-day');
      var d = D.parseYmd(key);
      var n = Number(cell.getAttribute('data-count') || 0), due = Number(cell.getAttribute('data-due') || 0);
      return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + D.WEEKDAYS[d.getDay()] + '요일, 일정 ' + n + '개, 마감 ' + due + '개' +
        (key === todayKey ? ', 오늘' : '') + (cell.classList.contains('is-off') ? ', 쉬는 날' : '') +
        (picking ? ', Enter로 ' + q(pickTitle) + ' 넣기' : '');
    }

    function itemButton(x, key) {
      var ext = M.isExternal(x);
      var t = x.taskId ? M.byId(st.tasks, x.taskId) : null;
      var title = ext ? x.title : t ? t.title : (x.title || '일정');
      var text = x.allDay ? title : D.hm(x.start) + ' ' + title;
      var cls = 'button.cm-item' + (x.allDay ? '.allday' : '') + (ext ? '.ext' : x.kind === 'work' ? '.work' : '.event') +
        (ext && x.tentative ? '.is-tentative' : '') + (t && t.status === 'done' ? '.is-done' : '');
      var b = h(cls, {
        type: 'button', tabindex: '-1', title: text,
        onclick: function (e) {
          e.stopPropagation();
          if (picking) { ctx.onDropTask(picking, key, cells[key]); return; }
          if (ext) { if (DN.views.calPlace) DN.views.calPlace._tl.extOpen(x, e.currentTarget); }
          else if (DN.views.schedule) DN.views.schedule.open({ blockId: x.id });
        }
      }, text);
      if (ext && x.color) b.style.setProperty('--gc', x.color);
      return b;
    }

    for (var w = 0; w < 6; w++) {
      var row = h('div.cm-week', { role: 'row' });
      for (var i = 0; i < 7; i++) {
        var d = D.addDays(start, w * 7 + i);
        var key = D.ymd(d);
        keys.push(key);
        var items = itemsOf(st, key);
        var due = dueByDay[key] || [];
        var off = wh ? !SL().isWorkingDay(d, wh) : (d.getDay() === 0 || d.getDay() === 6);
        var cell = h('div.cm-day' + (d.getMonth() !== month ? '.is-out' : '') + (key === todayKey ? '.is-today' : '') +
          (key < todayKey ? '.is-past' : '') + (off ? '.is-off' : '') + (picking ? '.is-picking' : ''), {
          role: 'gridcell', 'data-day': key, 'data-drop': 'day', tabindex: '-1',
          'data-count': String(items.length), 'data-due': String(due.length)
        });
        var lines = items.length > DESKTOP_LINES ? DESKTOP_LINES - 1 : items.length;
        cell.appendChild(h('div.cm-day-head',
          h('span.cm-num', String(d.getDate())),
          due.length ? h('span.cm-due', { title: '마감: ' + due.map(function (t) { return t.title; }).join(', ') }, '마감 ' + due.length) : null));
        cell.appendChild(h('div.cm-items',
          items.slice(0, lines).map(function (x) { return itemButton(x, key); }),
          items.length > lines ? h('button.cm-more.link-btn', { type: 'button', tabindex: '-1', onclick: (function (k) {
            return function (e) { e.stopPropagation(); if (picking) ctx.onDropTask(picking, k, cells[k]); else ctx.onOpenDay(k, { focus: true }); };
          })(key) }, '+' + (items.length - lines) + '개 더') : null));
        cell.appendChild(h('div.cm-dots', { 'aria-hidden': 'true' },
          items.slice(0, PHONE_DOTS).map(function (x) { return h('span.cm-dot.' + (M.isExternal(x) ? 'ext' : x.kind === 'work' ? 'work' : 'event')); }),
          due.length ? h('span.cm-dot.due') : null));
        cell.appendChild(h('div.cm-fit', { 'aria-hidden': 'true' }));
        cell.appendChild(h('div.cm-dwell', { 'aria-hidden': 'true' }));
        cell.setAttribute('aria-label', label(cell));
        cell.addEventListener('click', (function (k) {
          return function () {
            if (picking) ctx.onDropTask(picking, k, cells[k]);
            else ctx.onOpenDay(k, { focus: true });
          };
        })(key));
        cells[key] = cell;
        row.appendChild(cell);
      }
      grid.appendChild(row);
    }

    // roving tabindex
    var focusKey = ctx.focusYmd && cells[ctx.focusYmd] ? ctx.focusYmd
      : cells[todayKey] && D.parseYmd(todayKey).getMonth() === month ? todayKey : D.ymd(first);
    cells[focusKey].setAttribute('tabindex', '0');
    function setRoving(k) {
      Object.keys(cells).forEach(function (x) { cells[x].setAttribute('tabindex', x === k ? '0' : '-1'); });
      focusKey = k;
    }
    function focusDay(k) {
      if (!cells[k]) return false;
      setRoving(k);
      try { cells[k].focus(); } catch (e) { /* 없음 */ }
      return true;
    }
    function moveTo(target) {
      var k = D.ymd(target);
      if (cells[k]) { focusDay(k); return; }
      var tm = target.getFullYear() * 12 + target.getMonth(), cm = year * 12 + month;
      if (ctx.onPage) ctx.onPage(tm > cm ? 1 : -1, k);
    }
    grid.addEventListener('keydown', function (e) {
      var cell = e.target.closest ? e.target.closest('.cm-day') : null;
      if (!cell || e.target !== cell) return;
      var k = cell.getAttribute('data-day');
      var d0 = D.parseYmd(k);
      var wd = (d0.getDay() + 6) % 7;
      var handled = true;
      if (e.key === 'ArrowLeft') moveTo(D.addDays(d0, -1));
      else if (e.key === 'ArrowRight') moveTo(D.addDays(d0, 1));
      else if (e.key === 'ArrowUp') moveTo(D.addDays(d0, -7));
      else if (e.key === 'ArrowDown') moveTo(D.addDays(d0, 7));
      else if (e.key === 'Home') moveTo(D.addDays(d0, -wd));
      else if (e.key === 'End') moveTo(D.addDays(d0, 6 - wd));
      else if (e.key === 'PageUp' || e.key === 'PageDown') {
        var dm = e.key === 'PageUp' ? -1 : 1;
        var y = d0.getFullYear(), m = d0.getMonth() + dm;
        var last = new Date(y, m + 1, 0).getDate();
        var t = new Date(y, m, Math.min(d0.getDate(), last));
        if (ctx.onPage) ctx.onPage(dm, D.ymd(t));
      } else if (e.key === 'Enter' || e.key === ' ') {
        if (picking && e.shiftKey) ctx.onOpenDay(k, { focus: true, pick: true });
        else if (picking) ctx.onDropTask(picking, k, cell);
        else ctx.onOpenDay(k, { focus: true });
      } else if (e.key === 'Escape' && picking) {
        if (ctx.onCancelPick) ctx.onCancelPick();
      } else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    });
    grid.addEventListener('focusin', function (e) {
      var cell = e.target.closest ? e.target.closest('.cm-day') : null;
      if (cell && e.target === cell) setRoving(cell.getAttribute('data-day'));
    });

    host.appendChild(grid);

    function setPicking(taskId, title) {
      picking = taskId || null;
      if (title != null) pickTitle = title;
      Object.keys(cells).forEach(function (k) {
        cells[k].classList.toggle('is-picking', !!picking);
        cells[k].setAttribute('aria-label', label(cells[k]));
      });
    }
    function paintNow(n) {
      var tk = D.ymd(n);
      if (tk === todayKey) return;
      todayKey = tk;
      Object.keys(cells).forEach(function (k) {
        cells[k].classList.toggle('is-today', k === tk);
        cells[k].classList.toggle('is-past', k < tk);
        cells[k].setAttribute('aria-label', label(cells[k]));
      });
    }

    return {
      el: grid,
      destroy: function () { grid.remove(); },
      cellFor: function (ymd) { return cells[ymd] && cells[ymd].isConnected ? cells[ymd] : null; },
      focusDay: focusDay,
      setPicking: setPicking,
      paintNow: paintNow,
      focusedYmd: function () { return focusKey; }
    };
  }

  DN.views.calMonth = { render: render };
})();
