'use strict';

// 캘린더 — 왼쪽 미배치 할 일, 오른쪽 월간(기본) · 주간 · 일간.
// 월간: 일요일부터 시작하는 한 달 달력. 칸마다 일정·작업 시간·마감이 보이고, 날짜를 누르면 그날 일간 시간표.
// 작업 시간 블록은 할 일을 참조할 뿐 사본이 아니다. 블록을 지워도 할 일은 남는다.
// 마감일은 작업 시간과 섞지 않고 따로 표시한다.

(function () {
  var DN = window.Daynote;
  var M = DN.model, D = DN.dates, S = DN.store, ui = DN.ui, h = ui.h;
  var H_START = 0, H_END = 24, HOUR_PX = 48, SNAP = 15;   // 하루 전체를 그리고, 처음엔 업무 시간 근처로 스크롤한다

  var mem = { mode: 'month', anchor: null, scrolled: false };
  var drag = null;   // { kind:'task'|'block', id, minutes, offsetMin }

  function minToPx(min) { return min / 60 * HOUR_PX; }

  // 끄는 동안 커서 옆에 보이는 그림 — 카드 전체 대신 "제목 · 30분" 작은 알약 (아래 시간표를 가리지 않게)
  function setDragPill(e, title, minutes) {
    try {
      var pill = h('div.drag-pill', h('span.drag-pill-t', title), minutes ? h('span.drag-pill-m', minutes + '분') : null);
      document.body.appendChild(pill);
      e.dataTransfer.setDragImage(pill, -14, -10);   // 커서 오른쪽 아래로 비켜서
      setTimeout(function () { pill.remove(); }, 0);
    } catch (x) {}
  }

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
            setDragPill(e, t.title, drag.minutes);
          });
          card.addEventListener('dragend', clearGhost);
          card.addEventListener('dblclick', function () { A.openTask(t.id); });
          return card;
        }) : h('div.empty', '모든 할 일이 배치되어 있습니다.')));

    // ---------------------------------------------------------- 머리
    var month = mem.mode === 'month';
    var title = month ? anchor.getFullYear() + '년 ' + (anchor.getMonth() + 1) + '월'
      : mem.mode === 'week' ? D.weekLabel(days[0])
      : D.longDay(anchor);
    function shift(n) {
      if (month) mem.anchor = D.ymd(new Date(anchor.getFullYear(), anchor.getMonth() + n, 1));
      else mem.anchor = D.ymd(D.addDays(anchor, n * (mem.mode === 'week' ? 7 : 1)));
      A.refresh();
    }
    var unit = month ? '달' : mem.mode === 'week' ? '주' : '날';
    var head = h('div.cal-head',
      h('h2', title),
      h('button.icon-btn', { type: 'button', 'aria-label': '이전 ' + unit, onclick: function () { shift(-1); } }, ui.icon('chevronLeft')),
      h('button.btn.btn-sm', { type: 'button', onclick: function () { mem.anchor = D.ymd(now); A.refresh(); } }, '오늘'),
      h('button.icon-btn', { type: 'button', 'aria-label': '다음 ' + unit, onclick: function () { shift(1); } }, ui.icon('chevronRight')),
      h('div.grow'),
      h('div.seg', { role: 'group', 'aria-label': '보기' },
        h('button', { type: 'button', 'aria-pressed': String(mem.mode === 'month'), onclick: function () { mem.mode = 'month'; A.refresh(); } }, '월간'),
        h('button', { type: 'button', 'aria-pressed': String(mem.mode === 'week'), onclick: function () { mem.mode = 'week'; A.refresh(); } }, '주간'),
        h('button', { type: 'button', 'aria-pressed': String(mem.mode === 'day'), onclick: function () { mem.mode = 'day'; A.refresh(); } }, '일간')),
      h('button.btn.btn-sm', { type: 'button', onclick: function () { DN.views.schedule.open({ event: true, start: defaultStart() }); } }, ui.icon('plus'), '일정 추가'));

    function defaultStart() {
      var d = new Date(days[0]);
      if (days.some(function (x) { return D.ymd(x) === D.ymd(now); })) d = new Date(now);
      else d.setHours(9, 0, 0, 0);
      return DN.views.schedule.findFreeSlot(S.state, d, 60);
    }

    if (month) {
      var monthMain = h('section.cal-main.cal-month-main', { 'aria-label': '월간 달력' }, head, monthView(st, now, anchor));
      root.appendChild(h('div.cal-layout', side, monthMain));
      return { destroy: function () { root.style.overflow = ''; drag = null; if (openPicker) openPicker.close(); }, onTick: function () { if (!drag) A.refresh(); } };
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

  // ------------------------------------------------------------------ 월간 달력 (일요일 시작)
  var WEEK_HEAD = ['일', '월', '화', '수', '목', '금', '토'];
  var MAX_ITEMS = 3;   // 칸마다 이만큼 보이고 나머지는 "+N개 더"
  function monthView(st, now, anchor) {
    var A = DN.app;
    var today = D.ymd(now);
    var dayPicker = makeDayPicker(now);
    var weeks = D.monthGrid(anchor.getFullYear(), anchor.getMonth());
    var from = weeks[0][0].ymd, to = weeks[weeks.length - 1][6].ymd;
    // 날짜별: 일정·작업 시간(시각순), 마감(끝나지 않은 할 일)
    var byDay = {};
    function bucket(k) { return byDay[k] || (byDay[k] = { blocks: [], due: [] }); }
    st.blocks.forEach(function (b) {
      var k = D.ymd(b.start);
      if (k < from || k > to) return;
      var t = b.taskId && M.byId(st.tasks, b.taskId);
      if (t && t.deletedAt) return;
      bucket(k).blocks.push(b);
    });
    M.liveTasks(st).forEach(function (t) {
      if (t.dueDate && t.status !== 'done' && t.dueDate >= from && t.dueDate <= to) bucket(t.dueDate).due.push(t);
    });

    function item(cls, text, title, onClick, dragInfo) {
      var el = h('button.cal-m-item.' + cls, { type: 'button', title: title, onclick: function (e) { e.stopPropagation(); onClick(); } }, text);
      if (dragInfo) {
        el.setAttribute('draggable', 'true');
        el.addEventListener('dragstart', function (e) { drag = dragInfo; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', title); setDragPill(e, title, dragInfo.minutes); });
        el.addEventListener('dragend', function () { drag = null; });
      }
      return el;
    }
    function goDay(k) { mem.anchor = k; mem.mode = 'day'; mem.scrolled = false; A.refresh(); }

    var grid = h('div.cal-month', { style: { gridTemplateRows: 'auto repeat(' + weeks.length + ', minmax(0, 1fr))' } },
      WEEK_HEAD.map(function (w, i) { return h('div.cal-m-head' + (i === 0 ? '.is-sun' : i === 6 ? '.is-sat' : ''), w); }));
    weeks.forEach(function (week) {
      week.forEach(function (c) {
        var b = byDay[c.ymd] || { blocks: [], due: [] };
        var blocks = b.blocks.slice().sort(function (x, y) { return x.start < y.start ? -1 : 1; });
        var items = [];
        blocks.forEach(function (bl) {
          var t = bl.taskId && M.byId(st.tasks, bl.taskId);
          var label = t ? t.title : (bl.title || '일정');
          var s = new Date(bl.start);
          items.push(item(bl.kind === 'work' ? 'work' + (t && t.status === 'done' ? '.is-done' : '') : 'event',
            [h('span.cal-m-time', D.hm(s)), ' ', label], (bl.kind === 'work' ? '작업 · ' : '') + label + ' ' + D.hm(s) + '–' + D.hm(bl.end),
            function () { DN.views.schedule.open({ blockId: bl.id }); },
            { kind: 'block', id: bl.id, minutes: D.minutesBetween(s, new Date(bl.end)), keepTime: true }));
        });
        b.due.forEach(function (t) {
          var over = D.dueAt(t.dueDate, t.dueTime) < now;
          items.push(item('due' + (over ? '.is-over' : ''), [ui.icon('flag'), ' ', t.title], '마감 · ' + t.title + (t.dueTime ? ' ' + t.dueTime : ''),
            function () { A.scheduleTask(t.id); }, { kind: 'task', id: t.id, minutes: t.estimateMinutes ? Math.min(t.estimateMinutes, 240) : 30 }));
        });
        var more = items.length - MAX_ITEMS;
        var cls = '.cal-m-cell' + (c.inMonth ? '' : '.is-out') + (c.ymd === today ? '.is-today' : '') + (c.weekday === 0 ? '.is-sun' : c.weekday === 6 ? '.is-sat' : '');
        var cell = h('div' + cls, {
          'data-day': c.ymd, 'aria-label': D.longDay(D.parseYmd(c.ymd)) + (items.length ? ', ' + items.length + '개' : ''),
          onclick: function (e) {
            if (e.target.closest('.cal-m-item, .cal-m-date, .cal-m-more')) return;
            var d = D.parseYmd(c.ymd, '09:00');
            if (c.ymd === today) { d = new Date(now); d.setMinutes(Math.ceil(d.getMinutes() / 30) * 30, 0, 0); }
            DN.views.schedule.open({ event: true, start: DN.views.schedule.findFreeSlot(S.state, d, 60) });
          }
        },
          h('button.cal-m-date', { type: 'button', title: '이날 시간표 보기', onclick: function () { goDay(c.ymd); } }, String(c.day)),
          h('div.cal-m-items', items.slice(0, more > 0 ? MAX_ITEMS - 1 : MAX_ITEMS)),
          more > 0 ? h('button.cal-m-more', { type: 'button', onclick: function () { goDay(c.ymd); } }, '+' + (more + 1) + '개 더') : null);
        // 끌어 놓기: 할 일 → 그날 빈 시간에 작업 배치 / 일정·작업 → 같은 시각 그날로
        cell.addEventListener('dragover', function (e) {
          if (!drag) return;
          e.preventDefault();
          cell.classList.add('is-drop');
          Array.prototype.forEach.call(document.querySelectorAll('.cal-m-cell.is-drop'), function (x) { if (x !== cell) x.classList.remove('is-drop'); });
          dayPicker.hover(c.ymd, cell);   // 잠깐 머물면 그날 24시간 시간표가 뜬다 → 거기에 놓으면 그 시각
        });
        cell.addEventListener('dragleave', function (e) { if (!cell.contains(e.relatedTarget)) { cell.classList.remove('is-drop'); dayPicker.leaveCell(c.ymd); } });
        cell.addEventListener('drop', function (e) {
          if (!drag) return;
          e.preventDefault();
          cell.classList.remove('is-drop');
          dayPicker.close();
          var info = drag; drag = null;
          var dayLabel = D.relDay(c.ymd, now);
          if (info.kind === 'task') {
            var t = M.byId(S.state.tasks, info.id);
            var base = c.ymd === today ? new Date(now) : D.parseYmd(c.ymd, '09:00');
            var st0 = DN.views.schedule.findFreeSlot(S.state, base, info.minutes);
            var en0 = D.addMinutes(st0, info.minutes);
            S.mutate('일정에 배치', function (s2) { M.addBlock(s2, { taskId: info.id, kind: 'work', start: st0.toISOString(), end: en0.toISOString() }); });
            ui.undoToast('‘' + t.title + '’ 작업 시간을 ' + D.relDay(D.ymd(st0), now) + ' ' + D.hm(st0) + '에 배치했어요.');
          } else {
            var bl = M.byId(S.state.blocks, info.id);
            if (!bl) return;
            var os = new Date(bl.start);
            var ns = D.parseYmd(c.ymd, D.hm(os));
            var ne = D.addMinutes(ns, info.minutes);
            S.mutate('일정 옮기기', function (s2) { M.updateBlock(s2, info.id, { start: ns.toISOString(), end: ne.toISOString() }); });
            ui.undoToast(dayLabel + ' ' + D.hm(ns) + '로 옮겼어요.');
          }
        });
        grid.appendChild(cell);
      });
    });
    return grid;
  }

  // ------------------------------------------------------------------ 월간에서 끌어 놓을 때 뜨는 그날 24시간 시간표
  // 할 일(또는 일정)을 날짜 칸 위에 잠깐(DWELL) 올려 두면 그날 0~24시 시간표가 뜬다.
  // 시간표는 왼쪽 '미배치 할 일' 자리에 고정해서 뜬다 — 날짜 칸을 하나도 가리지 않는다.
  // 끄는 동안 계속 열려 있고, 다른 날짜 칸에 SWITCH 만큼 머물러야 그날로 바뀐다
  // (시간표 쪽으로 손을 옮기다 다른 칸을 잠깐 지나가도 바뀌지 않게).
  // 시간표 위에서는 놓을 자리를 미리 보여 주고(시각·길이·겹침), 놓으면 그 시각에 배치한다.
  // 칸에 바로 놓으면 예전처럼 그날 빈 시간에 넣는다.
  var DWELL = 300, SWITCH = 450, PICK_SNAP = 15;
  var openPicker = null;
  function makeDayPicker(now) {
    var A = DN.app;
    var state = { ymd: null, cell: null, timer: null, closeTimer: null, el: null, hourPx: 22 };
    function close() {
      clearTimeout(state.timer); clearTimeout(state.closeTimer);
      if (state.el) state.el.remove();
      if (state.cell) state.cell.classList.remove('is-picking');
      state.el = null; state.ymd = null; state.cell = null; state.pending = null;
      if (openPicker === api) openPicker = null;
    }
    function hover(ymd, cell) {
      clearTimeout(state.closeTimer);
      if (state.ymd === ymd && state.el) return;
      if (state.pending === ymd) return;
      clearTimeout(state.timer);
      state.pending = ymd;
      state.timer = setTimeout(function () { state.pending = null; open(ymd, cell); }, state.el ? SWITCH : DWELL);
    }
    // 칸을 떠나도 시간표는 그대로 (끝날 때까지). 머물기 예약만 취소
    function leaveCell(ymd) {
      if (state.pending === ymd) { clearTimeout(state.timer); state.pending = null; }
    }
    function minutesAt(area, clientY, offsetMin) {
      var r = area.getBoundingClientRect();
      var m = (clientY - r.top) / state.hourPx * 60 - (offsetMin || 0);
      m = Math.round(m / PICK_SNAP) * PICK_SNAP;
      return Math.max(0, Math.min(24 * 60 - PICK_SNAP, m));
    }
    function open(ymd, cell) {
      if (state.el) state.el.remove();
      if (state.cell) state.cell.classList.remove('is-picking');
      if (openPicker && openPicker !== api) openPicker.close();
      openPicker = api;
      state.ymd = ymd; state.cell = cell;
      Array.prototype.forEach.call(document.querySelectorAll('.cal-m-cell.is-drop, .cal-m-cell.is-picking'), function (x) { x.classList.remove('is-drop', 'is-picking'); });
      cell.classList.add('is-picking');   // 지금 고르는 날짜 칸 표시 (하나만)
      var vh = window.innerHeight;
      var day = D.parseYmd(ymd);
      var ghost = h('div.dp-ghost', { style: { display: 'none' } });
      var target = h('div.dp-target', '시간표 위에서 놓을 시각을 고르세요');
      var head = h('div.dp-head', h('b.dp-date', D.longDay(day)), target, h('span.meta', '다른 날짜는 그 칸에 잠깐 머물면 바뀌어요'));
      var area = h('div.dp-area');
      var el = h('div.day-picker.is-docked', { role: 'dialog', 'aria-label': D.longDay(day) + ' 시간 고르기' }, head, area);
      // 위치: 왼쪽 '미배치 할 일' 자리를 위아래 꽉 채운다 (날짜 칸을 가리지 않는다). 그 자리가 없으면 화면 왼쪽
      document.body.appendChild(el);
      var dock = document.querySelector('.cal-side');
      var r = dock ? dock.getBoundingClientRect() : { left: 8, top: 8, width: 260, height: vh - 16 };
      el.style.left = r.left + 'px';
      el.style.top = r.top + 'px';
      el.style.width = Math.max(240, r.width) + 'px';
      el.style.height = Math.max(300, Math.min(vh - r.top, r.height)) + 'px';
      state.el = el;
      // 남은 높이를 24시간에 고르게 나눈다 — 칸이 클수록 끌어서 고르기 쉽다 (너무 좁으면 14px 로 두고 스크롤)
      var areaH = el.clientHeight - head.offsetHeight - 22;   // 위 여백 8 + 아래 여백 8 + 여유
      state.hourPx = Math.max(14, areaH / 24);
      area.style.height = state.hourPx * 24 + 'px';
      for (var hr = 0; hr < 24; hr++) {
        area.appendChild(h('div.dp-hour' + (hr >= 9 && hr < 18 ? '.is-work' : ''), { style: { top: hr * state.hourPx + 'px', height: state.hourPx + 'px' } },
          h('span.dp-hlabel', D.pad(hr) + ':00')));
      }
      // 그날 이미 있는 일정·작업 시간 (겹침을 보며 고르게)
      S.state.blocks.filter(function (b) { return D.ymd(b.start) === ymd && !(drag && drag.kind === 'block' && drag.id === b.id); }).forEach(function (b) {
        var bs = new Date(b.start), be = new Date(b.end);
        var t = b.taskId && M.byId(S.state.tasks, b.taskId);
        if (t && t.deletedAt) return;
        var top = (bs.getHours() * 60 + bs.getMinutes()) / 60 * state.hourPx;
        var hgt = Math.max(D.minutesBetween(bs, be) / 60 * state.hourPx, 12);
        area.appendChild(h('div.dp-block.' + (b.kind === 'work' ? 'work' : 'event'), { style: { top: top + 'px', height: hgt + 'px' } },
          D.hm(bs) + ' ' + (t ? t.title : (b.title || '일정'))));
      });
      if (ymd === D.ymd(now)) {
        area.appendChild(h('div.dp-now', { style: { top: (now.getHours() * 60 + now.getMinutes()) / 60 * state.hourPx + 'px' } }));
      }
      area.appendChild(ghost);

      // 시간표 안으로 들어오면 닫기·다른 날 열기 예약을 모두 취소 (지나온 칸이 시간표를 바꾸지 않게)
      function hold() { clearTimeout(state.closeTimer); clearTimeout(state.timer); state.pending = null; }
      el.addEventListener('dragenter', hold);
      el.addEventListener('dragover', function (e) {
        if (!drag) return;
        e.preventDefault();
        hold();
        var m = minutesAt(area, e.clientY, 0);
        var st0 = D.addMinutes(day, m), en0 = D.addMinutes(st0, drag.minutes);
        var c = M.conflictsFor(S.state, st0.toISOString(), en0.toISOString(), drag.kind === 'block' ? drag.id : null);
        ghost.style.display = '';
        ghost.style.top = m / 60 * state.hourPx + 'px';
        ghost.style.height = Math.max(drag.minutes / 60 * state.hourPx, 14) + 'px';
        ghost.className = 'dp-ghost' + (c.length ? ' is-conflict' : '');
        ghost.textContent = D.hm(st0) + '–' + D.hm(en0);
        target.className = 'dp-target is-set' + (c.length ? ' is-conflict' : '');
        target.textContent = '놓으면 → ' + D.hm(st0) + '–' + D.hm(en0) + (c.length ? ' · 겹침 ' + c.length + '건' : '');
      });
      el.addEventListener('dragleave', function (e) { if (!el.contains(e.relatedTarget)) { ghost.style.display = 'none'; target.className = 'dp-target'; target.textContent = '시간표 위에서 놓을 시각을 고르세요'; } });
      el.addEventListener('drop', function (e) {
        if (!drag) return;
        e.preventDefault();
        var info = drag; drag = null;
        var m = minutesAt(area, e.clientY, 0);
        var st0 = D.addMinutes(day, m), en0 = D.addMinutes(st0, info.minutes);
        var c = M.conflictsFor(S.state, st0.toISOString(), en0.toISOString(), info.kind === 'block' ? info.id : null);
        var tail = c.length ? ' 다른 일정과 겹쳐요.' : '';
        close();
        if (info.kind === 'task') {
          var t = M.byId(S.state.tasks, info.id);
          S.mutate('일정에 배치', function (s2) { M.addBlock(s2, { taskId: info.id, kind: 'work', start: st0.toISOString(), end: en0.toISOString() }); });
          ui.undoToast('‘' + t.title + '’ 작업 시간을 ' + D.relDay(ymd, now) + ' ' + D.hm(st0) + '에 배치했어요.' + tail);
        } else {
          S.mutate('일정 옮기기', function (s2) { M.updateBlock(s2, info.id, { start: st0.toISOString(), end: en0.toISOString() }); });
          ui.undoToast(D.relDay(ymd, now) + ' ' + D.hm(st0) + '로 옮겼어요.' + tail);
        }
      });
      // 창이 아주 작아 스크롤이 생기면 일하는 시간대(8시)부터 보이게
      if (el.scrollHeight > el.clientHeight) el.scrollTop = Math.max(0, 8 * state.hourPx - 20);
    }
    var api = { hover: hover, leaveCell: leaveCell, close: close };
    return api;
  }
  // 끌기가 끝나면(어디에 놓든, 취소하든) 시간표를 닫는다
  document.addEventListener('dragend', function () { if (openPicker) openPicker.close(); }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && openPicker) openPicker.close(); });

  DN.views.calendar = { title: '캘린더', render: render, _mem: mem };
})();
