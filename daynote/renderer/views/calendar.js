'use strict';

// 캘린더 — 왼쪽 미배치 할 일, 오른쪽 일간·주간 시간표.
// 작업 시간 블록은 할 일을 참조할 뿐 사본이 아니다. 블록을 지워도 할 일은 남는다.
// 마감일은 날짜 머리에 따로 보인다 (작업 시간과 섞지 않는다).
// 월간 보기는 넣지 않았다 — 이 앱의 캘린더 목적은 "언제 할지" 시간 배치이고, 월 단위로는 시간 블록이 보이지 않는다.

(function () {
  var DN = window.Daynote;
  var M = DN.model, D = DN.dates, S = DN.store, ui = DN.ui, h = ui.h;
  var H_START = 0, H_END = 24, HOUR_PX = 48, SNAP = 15;   // 하루 전체를 그리고, 처음엔 업무 시간 근처로 스크롤한다

  var mem = { mode: 'week', anchor: null, scrolled: false };
  var drag = null;   // { kind:'task'|'block', id, minutes, offsetMin }

  function minToPx(min) { return min / 60 * HOUR_PX; }

  function render(root) {
    var A = DN.app;
    var st = S.state;
    var now = A.now();
    if (!mem.anchor) mem.anchor = D.ymd(now);
    var anchor = D.parseYmd(mem.anchor);
    var days = mem.mode === 'week'
      ? [0, 1, 2, 3, 4, 5, 6].map(function (i) { return D.addDays(D.startOfWeek(anchor), i); })
      : [anchor];
    root.style.overflow = 'hidden';

    // ---------------------------------------------------------- 미배치
    var nowIso = now.toISOString();
    var unscheduled = M.liveTasks(st).filter(function (t) {
      return t.status !== 'done' && !st.blocks.some(function (b) { return b.taskId === t.id && b.end > nowIso; });
    }).sort(function (a, b) { return (a.dueDate || '9999') < (b.dueDate || '9999') ? -1 : (a.dueDate || '9999') > (b.dueDate || '9999') ? 1 : 0; });

    var side = h('section.cal-side', { 'aria-label': '미배치 할 일' },
      h('div.cal-side-head', h('h2', '미배치 할 일'), h('div.meta', '시간표로 끌어다 놓거나 ‘배치’를 누르세요. 마감일은 그대로 둡니다.')),
      h('div.cal-side-list', { 'data-keep-scroll': 'cal-side' },
        unscheduled.length ? unscheduled.map(function (t) {
          var card = h('div.unsched', { draggable: 'true', 'data-task-id': t.id },
            h('div.row', h('span.t', t.title),
              h('button.btn.btn-xs', { type: 'button', 'aria-label': '‘' + t.title + '’ 일정에 배치', onclick: function () { A.scheduleTask(t.id); } }, '배치')),
            h('div.task-chips', ui.dueChip(t, now), ui.estimateChip(t), ui.statusChips(st, t, now)));
          card.addEventListener('dragstart', function (e) {
            drag = { kind: 'task', id: t.id, minutes: t.estimateMinutes ? Math.min(t.estimateMinutes, 240) : 30, offsetMin: 0 };
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', t.title);
          });
          card.addEventListener('dragend', clearGhost);
          card.addEventListener('dblclick', function () { A.openTask(t.id); });
          return card;
        }) : h('div.empty', '모든 할 일이 배치되어 있습니다.')));

    // ---------------------------------------------------------- 머리
    var title = mem.mode === 'week'
      ? D.weekLabel(days[0])
      : D.longDay(anchor);
    function shift(n) { mem.anchor = D.ymd(D.addDays(anchor, n * (mem.mode === 'week' ? 7 : 1))); A.refresh(); }
    var head = h('div.cal-head',
      h('h2', title),
      h('button.icon-btn', { type: 'button', 'aria-label': mem.mode === 'week' ? '이전 주' : '이전 날', onclick: function () { shift(-1); } }, ui.icon('chevronLeft')),
      h('button.btn.btn-sm', { type: 'button', onclick: function () { mem.anchor = D.ymd(now); A.refresh(); } }, '오늘'),
      h('button.icon-btn', { type: 'button', 'aria-label': mem.mode === 'week' ? '다음 주' : '다음 날', onclick: function () { shift(1); } }, ui.icon('chevronRight')),
      h('div.grow'),
      h('div.seg', { role: 'group', 'aria-label': '보기' },
        h('button', { type: 'button', 'aria-pressed': String(mem.mode === 'day'), onclick: function () { mem.mode = 'day'; A.refresh(); } }, '일간'),
        h('button', { type: 'button', 'aria-pressed': String(mem.mode === 'week'), onclick: function () { mem.mode = 'week'; A.refresh(); } }, '주간')),
      h('button.btn.btn-sm', { type: 'button', onclick: function () { DN.views.schedule.open({ event: true, start: defaultStart() }); } }, ui.icon('plus'), '일정 추가'));

    function defaultStart() {
      var d = new Date(days[0]);
      if (days.some(function (x) { return D.ymd(x) === D.ymd(now); })) d = new Date(now);
      else d.setHours(9, 0, 0, 0);
      return DN.views.schedule.findFreeSlot(S.state, d, 60);
    }

    var cols = '56px repeat(' + days.length + ', minmax(0, 1fr))';
    var dueByDay = {};
    M.liveTasks(st).forEach(function (t) { if (t.dueDate && t.status !== 'done') (dueByDay[t.dueDate] = dueByDay[t.dueDate] || []).push(t); });
    var daysHead = h('div.cal-days-head', { style: { gridTemplateColumns: cols } }, h('div'),
      days.map(function (d) {
        var key = D.ymd(d);
        var due = dueByDay[key] || [];
        return h('div.cal-day-label' + (key === D.ymd(now) ? '.is-today' : ''),
          D.WEEKDAYS[d.getDay()], h('b', String(d.getDate())),
          due.length ? h('div.due', { title: due.map(function (t) { return t.title; }).join(', ') }, '마감 ' + due.length + ' · ' + due[0].title) : null);
      }));

    // ---------------------------------------------------------- 시간표
    var totalPx = minToPx((H_END - H_START) * 60);
    var hours = h('div.cal-hours', { style: { height: totalPx + 'px' } });
    for (var hr = H_START; hr < H_END; hr++) {
      hours.appendChild(h('div.cal-hour-label', { style: { top: minToPx((hr - H_START) * 60) + 'px' } }, hr === H_START ? '' : D.pad(hr) + ':00'));
    }
    var grid = h('div.cal-grid', { style: { gridTemplateColumns: cols, height: totalPx + 'px' } }, hours);
    var colEls = days.map(function (d) {
      var key = D.ymd(d);
      var col = h('div.cal-col' + (key === D.ymd(now) ? '.is-today' : ''), { 'data-day': key, 'aria-label': D.longDay(d) + ' 시간표' });
      for (var i = 0; i < (H_END - H_START) * 2; i++) col.appendChild(h('div.cal-slot' + (i % 2 === 0 ? '.hour' : ''), { style: { top: minToPx(i * 30) + 'px', height: minToPx(30) + 'px' } }));
      placeBlocks(col, d);
      if (key === D.ymd(now)) {
        var nm = (now.getHours() - H_START) * 60 + now.getMinutes();
        if (nm >= 0 && nm <= (H_END - H_START) * 60) col.appendChild(h('div.cal-now', { style: { top: minToPx(nm) + 'px' }, 'aria-hidden': 'true' }));
      }
      wireDrop(col, d);
      col.addEventListener('click', function (e) {
        if (e.target !== col && !e.target.classList.contains('cal-slot')) return;
        var start = timeAt(col, d, e.clientY, 0);
        DN.views.schedule.open({ event: true, start: start });
      });
      grid.appendChild(col);
      return col;
    });

    function placeBlocks(col, d) {
      var key = D.ymd(d);
      var list = S.state.blocks.filter(function (b) {
        if (D.ymd(b.start) !== key) return false;
        var t = b.taskId && M.byId(S.state.tasks, b.taskId);
        return !(t && t.deletedAt);
      }).sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : (a.end > b.end ? -1 : 1); });
      // 겹치는 블록은 나란히 놓는다
      var lanes = [];
      list.forEach(function (b) {
        var lane = 0;
        while (lanes[lane] && lanes[lane] > b.start) lane++;
        lanes[lane] = b.end;
        b.__lane = lane;
      });
      list.forEach(function (b) {
        var overl = list.filter(function (o) { return o !== b && o.start < b.end && o.end > b.start; });
        var n = Math.max(b.__lane, overl.reduce(function (m, o) { return Math.max(m, o.__lane); }, 0)) + 1;
        var s = new Date(b.start), e = new Date(b.end);
        var top = minToPx((s.getHours() - H_START) * 60 + s.getMinutes());
        var height = Math.max(minToPx(D.minutesBetween(s, e)), 22);
        var t = b.taskId && M.byId(S.state.tasks, b.taskId);
        var conflict = overl.length > 0;
        var label = t ? t.title : (b.title || '일정');
        var el = h('div.cal-block.' + (b.kind === 'work' ? 'work' : 'event') + (t && t.status === 'done' ? '.is-done' : '') + (conflict ? '.is-conflict' : ''), {
          role: 'button', tabindex: '0', draggable: 'true',
          'aria-label': (b.kind === 'work' ? '작업: ' : '일정: ') + label + ', ' + D.hm(s) + '부터 ' + D.hm(e) + '까지' + (conflict ? ', 다른 일정과 겹침' : ''),
          style: { top: top + 'px', height: height + 'px', left: 'calc(' + (b.__lane / n * 100) + '% + 3px)', width: 'calc(' + (100 / n) + '% - 6px)', right: 'auto' },
          onclick: function (ev) { ev.stopPropagation(); DN.views.schedule.open({ blockId: b.id }); },
          onkeydown: function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); DN.views.schedule.open({ blockId: b.id }); } }
        },
          h('div.bt', (b.kind === 'work' ? '' : '') + label),
          height > 30 ? h('div.bm', D.hm(s) + '–' + D.hm(e) + (b.kind === 'work' ? ' · 작업' : '')) : null,
          conflict ? h('div.conf', '⚠ 겹침') : null,
          b.sample ? null : null);
        el.addEventListener('dragstart', function (ev) {
          var r = el.getBoundingClientRect();
          var offsetMin = Math.round((ev.clientY - r.top) / HOUR_PX * 60 / SNAP) * SNAP;
          drag = { kind: 'block', id: b.id, minutes: D.minutesBetween(s, e), offsetMin: offsetMin };
          ev.dataTransfer.effectAllowed = 'move';
          ev.dataTransfer.setData('text/plain', label);
        });
        el.addEventListener('dragend', clearGhost);
        col.appendChild(el);
      });
    }

    function timeAt(col, d, clientY, offsetMin) {
      var r = col.getBoundingClientRect();
      var min = (clientY - r.top) / HOUR_PX * 60 - (offsetMin || 0);
      min = Math.round(min / SNAP) * SNAP;
      min = Math.max(0, Math.min((H_END - H_START) * 60 - SNAP, min));
      var s = new Date(d); s.setHours(H_START, 0, 0, 0);
      return D.addMinutes(s, min);
    }

    // 놓기 전에 결과를 보여준다 — 시간, 겹침 여부
    var ghost = null;
    function clearGhost() { if (ghost) { ghost.remove(); ghost = null; } }
    function wireDrop(col, d) {
      col.addEventListener('dragover', function (e) {
        if (!drag) return;
        e.preventDefault();
        var s = timeAt(col, d, e.clientY, drag.offsetMin);
        var en = D.addMinutes(s, drag.minutes);
        var c = M.conflictsFor(S.state, s.toISOString(), en.toISOString(), drag.kind === 'block' ? drag.id : null);
        if (!ghost) ghost = h('div.cal-ghost', { 'aria-hidden': 'true' });
        ghost.className = 'cal-ghost' + (c.length ? ' is-conflict' : '');
        ghost.style.top = minToPx((s.getHours() - H_START) * 60 + s.getMinutes()) + 'px';
        ghost.style.height = minToPx(drag.minutes) + 'px';
        ghost.textContent = D.hm(s) + '–' + D.hm(en) + (c.length ? ' · 겹침 ' + c.length + '건' : '');
        if (ghost.parentNode !== col) col.appendChild(ghost);
      });
      col.addEventListener('dragleave', function (e) { if (!col.contains(e.relatedTarget)) clearGhost(); });
      col.addEventListener('drop', function (e) {
        if (!drag) return;
        e.preventDefault();
        var info = drag; drag = null;
        clearGhost();
        var s = timeAt(col, d, e.clientY, info.offsetMin);
        var en = D.addMinutes(s, info.minutes);
        var c = M.conflictsFor(S.state, s.toISOString(), en.toISOString(), info.kind === 'block' ? info.id : null);
        var tail = c.length ? ' 다른 일정과 겹칩니다.' : '';
        if (info.kind === 'task') {
          var t = M.byId(S.state.tasks, info.id);
          S.mutate('일정에 배치', function (st2) { M.addBlock(st2, { taskId: info.id, kind: 'work', start: s.toISOString(), end: en.toISOString() }); });
          ui.undoToast('‘' + t.title + '’ 작업 시간을 ' + D.relDay(D.ymd(s), now) + ' ' + D.hm(s) + '에 배치했습니다.' + tail);
        } else {
          S.mutate('일정 변경', function (st2) { M.updateBlock(st2, info.id, { start: s.toISOString(), end: en.toISOString() }); });
          ui.undoToast(D.relDay(D.ymd(s), now) + ' ' + D.hm(s) + '로 옮겼습니다.' + tail);
        }
      });
    }

    var scroll = h('div.cal-scroll', { 'data-keep-scroll': 'cal' }, grid);
    var mainCol = h('section.cal-main', { 'aria-label': '시간표' }, head, daysHead, scroll);
    root.appendChild(h('div.cal-layout', side, mainCol));

    if (!mem.scrolled) {
      mem.scrolled = true;
      setTimeout(function () { scroll.scrollTop = minToPx((Math.min(Math.max(now.getHours() - 1, 7), 16) - H_START) * 60); }, 0);
    }

    return {
      destroy: function () { root.style.overflow = ''; clearGhost(); drag = null; },
      onTick: function () { A.refresh(); }
    };
  }

  DN.views.calendar = { title: '캘린더', render: render, _mem: mem };
})();
