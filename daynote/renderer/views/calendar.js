'use strict';

// 캘린더 — 왼쪽 "배치할 일", 오른쪽 월간(기본)·주간·일간 보기.
// 할 일을 날짜 칸에 끌어다 놓으면 알맞은 시간에 자동으로 넣고(calplace.js), 칸 위에서 1초 기다리면 그날 시간표가 열린다(calday.js).
// 끌기는 포인터 이벤트 엔진(dragplace.js) 하나로 마우스·터치·펜을 다룬다 — HTML5 draggable 은 쓰지 않는다.
// 작업 시간 블록은 할 일을 참조할 뿐 사본이 아니다. 블록을 지워도 할 일은 남는다. 마감일은 따로 보인다.
// 끌기 중이거나 캘린더 팝오버가 열려 있으면 다시 그리지 않고(mem.dirty) 끝난 뒤에 그린다.

(function () {
  var DN = window.Daynote;
  var M = DN.model, D = DN.dates, S = DN.store, ui = DN.ui, h = ui.h;
  var HOUR_PX = 48, SNAP = 15;
  var DWELL_MS = 1000, DING_MS = 300, NAV_DWELL_MS = 700;
  var MODES = ['month', 'week', 'day'];
  var MODE_LABEL = { month: '월간', week: '주간', day: '일간' };
  var GROUPS = [
    { id: 'overdue', label: '기한 지남' }, { id: 'soon', label: '오늘·내일 마감' }, { id: 'week', label: '이번 주 마감' },
    { id: 'later', label: '나중 마감' }, { id: 'none', label: '마감 없음' }
  ];
  var PRIO = { high: 0, normal: 1, low: 2 };

  var mem = { mode: null, anchor: null, scrolled: false, sideOpen: false, ctxFilter: null, picking: null, day: null, dirty: false, popOpen: false,
    lastYmd: null, focusYmd: null, focusAfter: null };

  var live = null;    // 지금 그려진 화면의 도구들 (render 마다 새로)

  function PL() { return DN.planner || null; }
  function SL() { return DN.slots || null; }
  function CP() { return DN.views.calPlace || null; }
  function CD() { return DN.views.calDay || null; }
  function DP() { return DN.dragPlace || null; }
  function TL() { return CP() ? CP()._tl : null; }
  function q(s) { return '‘' + s + '’'; }
  // 조사는 따옴표 안 낱말에 맞춘다: ‘엄마 생신 선물 주문’을
  function qj(s, pair) { var w = ui.josa(s, pair); return q(s) + w.slice(String(s).length); }
  function statusOn() { return !!(DN.status && DN.status.isActive && DN.status.isActive()); }
  function minToPx(min) { return min / 60 * HOUR_PX; }

  function lengthFor(st, t, now) {
    var r = PL() ? PL().remainingMinutes(st, t, now) : null;
    if (r != null && r > 0) return r;
    return t.estimateMinutes != null ? t.estimateMinutes : null;
  }

  // ------------------------------------------------------------------ 배치할 일 (CAL §2.1)
  function unscheduledTasks(st, now) {
    var nowIso = now.toISOString();
    var out = [];
    M.liveTasks(st).forEach(function (t) {
      if (t.status === 'done') return;
      var future = st.blocks.some(function (b) { return b.taskId === t.id && b.kind === 'work' && b.end > nowIso; });
      var rem = PL() && t.estimateMinutes != null ? PL().remainingMinutes(st, t, now) : null;
      if (!future) out.push({ t: t, rem: null });
      else if (t.estimateMinutes != null && rem != null && rem >= 30) out.push({ t: t, rem: rem });
    });
    return out;
  }
  function groupOf(t, today) {
    if (!t.dueDate) return 'none';
    if (t.dueDate < today) return 'overdue';
    var d = D.dayDiff(D.parseYmd(today), D.parseYmd(t.dueDate));
    if (d <= 1) return 'soon';
    if (d <= 7) return 'week';
    return 'later';
  }
  function cmpTask(a, b) {
    var pa = PRIO[a.priority] != null ? PRIO[a.priority] : 1, pb = PRIO[b.priority] != null ? PRIO[b.priority] : 1;
    if (pa !== pb) return pa - pb;
    var da = (a.dueDate || '9999-99-99') + ' ' + (a.dueTime || '99:99'), db = (b.dueDate || '9999-99-99') + ' ' + (b.dueTime || '99:99');
    if (da !== db) return da < db ? -1 : 1;
    var ca = a.createdAt || '', cb = b.createdAt || '';
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }
  function ctxOf(st, t, now) {
    var ST = DN.statusCore;
    if (!ST || !DN.status || !DN.status.profile) return 'none';
    var r = ST.contextOf(st, t, DN.status.profile(), now);
    return (r && r.value) || 'none';
  }
  function ctxLabel(v) {
    var ST = DN.statusCore;
    if (!ST || !DN.status || !DN.status.profile) return v;
    return ST.contextLabel(DN.status.profile(), v === 'none' ? null : v);
  }

  // ------------------------------------------------------------------ 화면
  function render(root, params) {
    var A = DN.app;
    var st = S.state;
    var now = A.now();
    var today = D.ymd(now);
    params = params || {};
    if (params.anchor) { mem.anchor = params.anchor; mem.focusYmd = params.anchor; }
    if (params.mode && MODES.indexOf(params.mode) !== -1) mem.mode = params.mode;
    params.anchor = undefined; params.mode = undefined;   // 한 번만 읽는다 — 다시 그릴 때는 화면에서 고친 값을 쓴다
    if (!mem.mode) mem.mode = MODES.indexOf(st.prefs.calendarMode) !== -1 ? st.prefs.calendarMode : 'month';
    if (!mem.anchor) mem.anchor = today;
    mem.lastYmd = today;
    if (mem.picking) {
      var pt = M.byId(st.tasks, mem.picking);
      if (!pt || pt.deletedAt || pt.status === 'done') mem.picking = null;
    }
    var mode = mem.picking ? 'month' : mem.mode;   // 고르기 모드는 월간으로 (보기 기억은 바꾸지 않는다)
    var anchor = D.parseYmd(mem.anchor);
    root.style.overflow = 'hidden';

    var arms = [];
    var month = null;
    var monthHost = null;
    var titleEl = h('h2');
    live = { root: root, arms: arms, month: function () { return month; } };

    function arm(el, opts) {
      if (!DP()) return;
      var o = dragOpts();
      Object.keys(opts).forEach(function (k) { o[k] = opts[k]; });
      arms.push(DP().arm(el, o));
    }

    // ---------------------------------------------------------- 왼쪽: 배치할 일
    var all = unscheduledTasks(st, now);
    var active = statusOn();
    var ctxVals = {};
    if (active) all.forEach(function (x) { x.ctx = ctxOf(st, x.t, now); ctxVals[x.ctx] = true; });
    if (!active || (mem.ctxFilter && !ctxVals[mem.ctxFilter])) mem.ctxFilter = null;
    var shown = all.filter(function (x) { return !mem.ctxFilter || x.ctx === mem.ctxFilter; });
    live.shownIds = shown.map(function (x) { return x.t.id; });

    function placeMenu(anchorEl, t) {
      ui.menu(anchorEl, [
        { label: '날짜 골라서 넣기', icon: 'calendar', onClick: function () { startPick(t.id); } },
        { label: '시간 직접 정하기…', icon: 'clock', onClick: function () { A.scheduleTask(t.id); } },
        { label: '할 일 열기', icon: 'task', onClick: function () { A.openTask(t.id); } }
      ], { label: q(t.title) + ' 넣기' });
    }

    function card(x) {
      var t = x.t;
      var len = lengthFor(st, t, now);
      var hints = PL() ? PL().hintsOf(t) : null;
      var dueTxt = t.dueDate ? '마감 ' + D.relDay(t.dueDate, now) + (t.dueTime ? ' ' + t.dueTime : '') : '마감 없음';
      var putBtn = h('button.btn.btn-xs', { type: 'button', 'aria-haspopup': 'menu', 'aria-label': q(t.title) + ' 넣기',
        'data-focus-key': 'unsched-put:' + t.id, onclick: function (e) { e.stopPropagation(); placeMenu(e.currentTarget, t); } }, '넣기');
      var el = h('div.unsched', {
        'data-task-id': t.id, tabindex: '0', role: 'button', 'aria-roledescription': '끌 수 있는 할 일', 'data-focus-key': 'unsched:' + t.id,
        'aria-label': t.title + ', ' + (len != null ? D.duration(len) : '소요 시간 미정') + ', ' + dueTxt + '. 끌어서 날짜에 놓거나 Enter로 넣을 날짜를 골라요',
        ondblclick: function () { A.openTask(t.id); },
        onkeydown: function (e) {
          if (e.target !== el) return;
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); placeMenu(el, t); }
        }
      },
        h('span.unsched-grip', { 'aria-hidden': 'true' }, ui.icon('more')),
        h('div.row', h('span.t', t.title), putBtn),
        h('div.task-chips',
          ui.dueChip(t, now),
          ui.estimateChip(t),
          x.rem != null ? h('span.chip.chip-sched', '남은 ' + D.duration(x.rem)) : null,
          active && DN.status.contextChip ? DN.status.contextChip(t, { focusKey: 'unsched-ctx:' + t.id, where: 'calendar', source: 'calendar' }) : null,
          hints && hints.focus === 'deep' ? h('span.chip.chip-hint', '집중') : hints && hints.focus === 'light' ? h('span.chip.chip-hint', '가벼움') : null));
      if (mem.picking === t.id) el.classList.add('is-picking');
      arm(el, {
        grip: '.unsched-grip',
        ignore: 'button, a, input, select, textarea',   // 글자 칩(마감·소요 시간) 위에서도 끌 수 있게 — 누르는 칩은 button 이다
        payload: function () {
          var cur = M.byId(S.state.tasks, t.id);
          if (!cur || cur.deletedAt) return null;
          return { kind: 'task', id: t.id, minutes: lengthFor(S.state, cur, DN.app.now()), title: cur.title };
        },
        label: function (p) { return p.title + ' · ' + (p.minutes != null ? D.duration(p.minutes) : '소요 시간 미정'); }
      });
      return el;
    }

    var groups = {};
    shown.forEach(function (x) { (groups[groupOf(x.t, today)] = groups[groupOf(x.t, today)] || []).push(x); });
    var listEl = h('div.cal-side-list', { 'data-keep-scroll': 'cal-side' },
      shown.length ? GROUPS.map(function (g) {
        var xs = groups[g.id];
        if (!xs || !xs.length) return null;
        xs.sort(function (a, b) { return cmpTask(a.t, b.t); });
        return h('div.unsched-group', { role: 'group', 'aria-label': g.label },
          h('div.unsched-group-head', g.label + ' ' + xs.length), xs.map(card));
      }) : h('div.empty', all.length ? '이 맥락에는 넣을 일이 없어요.' : '모든 할 일을 넣었어요.'));

    var ctxRow = null;
    if (active && Object.keys(ctxVals).length) {
      var vals = Object.keys(ctxVals).sort(function (a, b) { return a === 'none' ? 1 : b === 'none' ? -1 : 0; });
      ctxRow = h('div.cal-ctx', { role: 'group', 'aria-label': '맥락' },
        h('button.pill', { type: 'button', 'aria-pressed': String(!mem.ctxFilter), onclick: function () { mem.ctxFilter = null; A.refresh(); } }, '전체'),
        vals.map(function (v) {
          return h('button.pill', { type: 'button', 'aria-pressed': String(mem.ctxFilter === v), onclick: function () { mem.ctxFilter = v; A.refresh(); } }, ctxLabel(v));
        }));
    }
    var toggle = h('button.cal-side-toggle', { type: 'button', 'aria-expanded': String(!!mem.sideOpen), 'aria-controls': 'cal-side-list',
      onclick: function () { mem.sideOpen = !mem.sideOpen; side.classList.toggle('is-open', mem.sideOpen); toggle.setAttribute('aria-expanded', String(mem.sideOpen)); } },
      '배치할 일 ' + shown.length + '개', ui.icon('chevronDown'));
    listEl.id = 'cal-side-list';
    var side = h('section.cal-side' + (mem.sideOpen ? '.is-open' : ''), { 'aria-label': '배치할 일' },
      h('div.cal-side-head', h('h2', '배치할 일'),
        h('div.meta', PL() ? '날짜에 끌어다 놓으면 알맞은 시간에 넣어요. 날짜 위에서 잠깐 기다리면 그날이 열려요.' : '시간표로 끌어다 놓거나 ‘넣기’를 눌러요. 마감일은 그대로예요.'),
        toggle),
      ctxRow, listEl);

    // ---------------------------------------------------------- 머리
    function monthTitle(d) { return d.getFullYear() + '년 ' + (d.getMonth() + 1) + '월'; }
    var days = mode === 'week' ? [0, 1, 2, 3, 4, 5, 6].map(function (i) { return D.addDays(D.startOfWeek(anchor), i); })
      : mode === 'day' ? [anchor] : [];
    titleEl.textContent = mode === 'month' ? monthTitle(anchor) : mode === 'week' ? D.weekLabel(days[0]) : D.longDay(anchor);

    function shift(n) {
      if (mode === 'month') {
        var f = new Date(anchor.getFullYear(), anchor.getMonth() + n, 1);
        mem.anchor = D.ymd(f);
      } else mem.anchor = D.ymd(D.addDays(anchor, n * (mode === 'week' ? 7 : 1)));
      mem.focusYmd = null;
      A.refresh();
    }
    function setMode(m) {
      if (mem.picking) endPick(false);
      mem.mode = m;
      S.mutate(null, function (s) { s.prefs.calendarMode = m; }, { silent: true });
      A.refresh();
    }
    var prevLabel = mode === 'month' ? '이전 달' : mode === 'week' ? '이전 주' : '이전 날';
    var nextLabel = mode === 'month' ? '다음 달' : mode === 'week' ? '다음 주' : '다음 날';
    var head = h('div.cal-head',
      titleEl,
      h('button.icon-btn', { type: 'button', 'aria-label': prevLabel, title: prevLabel, 'data-drop': mode === 'month' ? 'nav' : null, 'data-nav': '-1', onclick: function () { shift(-1); } }, ui.icon('chevronLeft')),
      h('button.btn.btn-sm', { type: 'button', onclick: function () { mem.anchor = today; mem.focusYmd = today; A.refresh(); } }, '오늘'),
      h('button.icon-btn', { type: 'button', 'aria-label': nextLabel, title: nextLabel, 'data-drop': mode === 'month' ? 'nav' : null, 'data-nav': '1', onclick: function () { shift(1); } }, ui.icon('chevronRight')),
      h('div.grow'),
      h('div.seg', { role: 'group', 'aria-label': '보기' }, MODES.map(function (m) {
        return h('button', { type: 'button', 'aria-pressed': String(mode === m), onclick: function () { setMode(m); } }, MODE_LABEL[m]);
      })),
      h('button.btn.btn-sm', { type: 'button', onclick: function () { DN.views.schedule.open({ event: true, start: defaultStart() }); } }, ui.icon('plus'), '일정 추가'));

    function defaultStart() {
      var showsToday = mode === 'month' ? mem.anchor.slice(0, 7) === today.slice(0, 7) : days.some(function (x) { return D.ymd(x) === today; });
      var d;
      if (showsToday) d = new Date(now);
      else {
        d = mode === 'month' ? new Date(anchor.getFullYear(), anchor.getMonth(), 1) : new Date(days[0]);
        d.setHours(9, 0, 0, 0);
      }
      return DN.views.schedule.findFreeSlot(S.state, d, 60);
    }

    var pickBar = null;
    if (mem.picking) {
      var pickTask = M.byId(st.tasks, mem.picking);
      pickBar = h('div.cal-pick', { role: 'status' },
        h('span', qj(pickTask.title, '를/을') + ' 넣을 날짜를 골라요. 화살표로 옮기고 Enter로 넣어요 · Shift+Enter 그날 열기 · Esc 취소'),
        h('button.link-btn', { type: 'button', onclick: function () { endPick(true); } }, '취소'));
    }

    // ---------------------------------------------------------- 본문
    var mainCol = h('section.cal-main', { 'aria-label': mode === 'month' ? '월간 달력' : '시간표' }, head, pickBar);
    var scroll = null;

    if (mode === 'month') {
      monthHost = h('div.cal-month', { 'data-keep-scroll': 'cal-month' });
      mainCol.appendChild(monthHost);
      paintMonth();
    } else {
      buildTimeline();
    }

    function monthCtx() {
      var pickTask = mem.picking ? M.byId(S.state.tasks, mem.picking) : null;
      return {
        anchor: mem.anchor, now: DN.app.now(), picking: mem.picking, pickTitle: pickTask ? pickTask.title : '',
        focusYmd: mem.focusYmd,
        onOpenDay: function (ymd, o) {
          o = o || {};
          mem.focusYmd = ymd;
          if (CD()) CD().open(ymd, { openedBy: o.pick ? 'pick' : 'click', focus: !!o.focus, taskId: o.pick ? mem.picking : undefined });
          if (o.pick) endPick(false, true);
        },
        onDropTask: function (taskId, ymd, cell) {
          mem.focusYmd = ymd;
          endPick(false, true);
          if (CP()) CP().dropOnDay(taskId, ymd, cell).then(function () {
            // 카드로 포커스를 돌려준다. 다 넣어 목록에서 빠졌으면 그 날짜 칸으로.
            setTimeout(function () {
              if (mem.popOpen || focusCard(taskId)) return;
              var m = live && live.month ? live.month() : null;
              if (m) m.focusDay(ymd);
            }, 0);
          });
        },
        onCancelPick: function () { endPick(true); },
        onPage: function (dm, focusYmd) {
          var f = new Date(anchor.getFullYear(), anchor.getMonth() + dm, 1);
          mem.anchor = D.ymd(f);
          mem.focusYmd = focusYmd;
          mem.focusAfter = focusYmd;
          A.refresh();
        }
      };
    }
    function paintMonth() {
      if (!DN.views.calMonth) { monthHost.appendChild(h('div.empty', '월간 보기를 불러오지 못했어요.')); return; }
      if (month) month.destroy();
      monthHost.textContent = '';
      month = DN.views.calMonth.render(monthHost, monthCtx());
      titleEl.textContent = monthTitle(D.parseYmd(mem.anchor));
    }
    // 끌기 중 달 넘기기 (칸 위치는 6주 고정이라 그대로)
    function pageDuringDrag(dm) {
      var a = D.parseYmd(mem.anchor);
      mem.anchor = D.ymd(new Date(a.getFullYear(), a.getMonth() + dm, 1));
      anchor = D.parseYmd(mem.anchor);
      mem.dirty = true;
      paintMonth();
    }
    live.pageDuringDrag = pageDuringDrag;

    function buildTimeline() {
      var tl = TL();
      var cols = '56px repeat(' + days.length + ', minmax(0, 1fr))';
      var dueByDay = {};
      M.liveTasks(st).forEach(function (t) { if (t.dueDate && t.status !== 'done') (dueByDay[t.dueDate] = dueByDay[t.dueDate] || []).push(t); });
      var daysHead = h('div.cal-days-head', { style: { gridTemplateColumns: cols } }, h('div'),
        days.map(function (d) {
          var key = D.ymd(d);
          var due = dueByDay[key] || [];
          return h('div.cal-day-label' + (key === today ? '.is-today' : ''),
            D.WEEKDAYS[d.getDay()], h('b', String(d.getDate())),
            due.length ? h('div.due', { title: due.map(function (t) { return t.title; }).join(', ') }, '마감 ' + due.length + ' · ' + due[0].title) : null);
        }));
      // 종일 줄 (없으면 숨김)
      var allDayCells = days.map(function (d) { return tl ? tl.allDayItems(D.ymd(d)) : []; });
      var anyAllDay = allDayCells.some(function (x) { return x.length; });
      var allDayRow = h('div.cal-allday', { style: { gridTemplateColumns: cols }, hidden: anyAllDay ? null : true, 'aria-label': '종일 일정' }, h('div.cal-allday-label', '종일'),
        allDayCells.map(function (items) {
          return h('div.cal-allday-cell', items.map(function (x) {
            var el = h('span.cal-allday-item', { role: 'button', tabindex: '0', title: x.title,
              onclick: function (e) { tl.extOpen(x, e.currentTarget); },
              onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tl.extOpen(x, e.currentTarget); } } }, x.title);
            tl.setGc(el, x.color);
            return el;
          }));
        }));

      var totalPx = minToPx(24 * 60);
      var hours = h('div.cal-hours', { style: { height: totalPx + 'px' } });
      for (var hr = 1; hr < 24; hr++) hours.appendChild(h('div.cal-hour-label', { style: { top: minToPx(hr * 60) + 'px' } }, D.pad(hr) + ':00'));
      var grid = h('div.cal-grid', { style: { gridTemplateColumns: cols, height: totalPx + 'px' } }, hours);
      days.forEach(function (d) {
        var key = D.ymd(d);
        var col = h('div.cal-col' + (key === today ? '.is-today' : ''), { 'data-day': key, 'data-drop': 'slot', 'aria-label': D.longDay(d) + ' 시간표' });
        for (var i = 0; i < 48; i++) col.appendChild(h('div.cal-slot' + (i % 2 === 0 ? '.hour' : ''), { style: { top: minToPx(i * 30) + 'px', height: minToPx(30) + 'px' } }));
        if (tl) tl.paintItems(col, key, { armBlock: armBlock });
        if (key === today) col.appendChild(h('div.cal-now', { style: { top: minToPx(now.getHours() * 60 + now.getMinutes()) + 'px' }, 'aria-hidden': 'true' }));
        // 빈 칸을 눌렀다 뗀 클릭만 '일정 추가'로 본다 (블록에서 누르고 다른 곳에서 뗀 클릭은 무시)
        var downEmpty = false;
        col.addEventListener('pointerdown', function (e) { downEmpty = e.target === col || e.target.classList.contains('cal-slot'); });
        col.addEventListener('click', function (e) {
          if (!downEmpty || (e.target !== col && !e.target.classList.contains('cal-slot'))) return;
          var start = tl ? tl.timeAt(col, key, e.clientY, 0) : D.parseYmd(key, '09:00');
          DN.views.schedule.open({ event: true, start: start });
        });
        grid.appendChild(col);
      });
      scroll = h('div.cal-scroll', { 'data-keep-scroll': 'cal', 'data-autoscroll': '' }, grid);
      mainCol.appendChild(daysHead);
      mainCol.appendChild(allDayRow);
      mainCol.appendChild(scroll);
    }

    // 시간표 블록 끌기 (주간·일간·하루 패널)
    function armBlock(el, b) {
      var t = b.taskId ? M.byId(S.state.tasks, b.taskId) : null;
      var label = t ? t.title : (b.title || '일정');
      arm(el, {
        ignore: 'button, a, input, select, textarea',
        payload: function (pt) {
          var cur = M.byId(S.state.blocks, b.id);
          if (!cur) return null;
          var r = el.getBoundingClientRect();
          var off = Math.round((pt.y - r.top) / HOUR_PX * 60 / SNAP) * SNAP;
          return { kind: 'block', id: b.id, minutes: D.minutesBetween(cur.start, cur.end), title: label, offsetMin: Math.max(0, off) };
        },
        label: function (p) { return p.title + ' · ' + D.duration(p.minutes); }
      });
    }

    root.appendChild(h('div.cal-layout' + (mode === 'month' ? '.is-month' : ''), side, mainCol));

    if (CD()) {
      CD()._mount(mainCol, {
        taskIds: function () {
          return (live && live.shownIds ? live.shownIds : []).filter(function (id) {
            var t = M.byId(S.state.tasks, id);
            return t && lengthFor(S.state, t, DN.app.now()) != null;
          });
        },
        armBlock: armBlock,
        cellFor: function (ymd) { return month ? month.cellFor(ymd) : null; },
        onPlaced: function () { },
        onClose: function () { }
      });
    }

    if (mode !== 'month' && !mem.scrolled && scroll) {
      mem.scrolled = true;
      setTimeout(function () { scroll.scrollTop = minToPx((Math.min(Math.max(now.getHours() - 1, 7), 16)) * 60); }, 0);
    }
    if (mem.focusAfter && month) {
      var fa = mem.focusAfter;
      mem.focusAfter = null;
      setTimeout(function () { if (month) month.focusDay(fa); }, 0);
    }

    // 고르기 모드
    function startPick(taskId) {
      var t = M.byId(S.state.tasks, taskId);
      if (!t) return;
      mem.picking = taskId;
      var n = DN.app.now(), tk = D.ymd(n);
      var a = D.parseYmd(mem.anchor);
      var inMonth = function (ymd) { var d = D.parseYmd(ymd); return d.getFullYear() === a.getFullYear() && d.getMonth() === a.getMonth(); };
      var target = t.dueDate && t.dueDate >= tk && mode === 'month' && inMonth(t.dueDate) ? t.dueDate : tk;
      if (target === tk && (mode !== 'month' || !inMonth(tk))) mem.anchor = tk;
      mem.focusYmd = target;
      mem.focusAfter = target;
      A.refresh();
    }
    function endPick(refocus, quiet) {
      var id = mem.picking;
      mem.picking = null;
      if (quiet) {
        if (month) month.setPicking(null);
        if (pickBar) pickBar.remove();
        var c = id ? root.querySelector('.unsched[data-task-id="' + id + '"]') : null;
        if (c) c.classList.remove('is-picking');
        return;
      }
      A.refresh();
      if (refocus && id) setTimeout(function () { focusCard(id); }, 0);
    }
    live.startPick = startPick;
    live.endPick = endPick;

    function onRootKey(e) {
      if (e.key === 'Escape' && mem.picking && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); endPick(true); }
    }
    root.addEventListener('keydown', onRootKey);

    return {
      destroy: function () {
        root.removeEventListener('keydown', onRootKey);
        arms.forEach(function (a) { a.destroy(); });
        stopDwell(); stopNavDwell();
        root.style.overflow = '';
        // 다른 화면으로 갔으면(다시 그리기가 아니면) 패널·고르기를 닫는다
        setTimeout(function () {
          if (DN.app.current().view === 'calendar') return;
          if (DP() && DP().active()) DP().cancel();
          if (CD() && CD().isOpen()) CD().close('nav');
          mem.picking = null;
        }, 0);
      },
      onChange: function () {
        if ((DP() && DP().active()) || mem.popOpen) { mem.dirty = true; return true; }
        mem.dirty = false;
        return false;
      },
      onTick: function (n) {
        var y = D.ymd(n);
        var busy = (DP() && DP().active()) || mem.popOpen;
        if (y !== mem.lastYmd && !busy) { DN.app.refresh(); return; }
        if (month) month.paintNow(n);
        var top = minToPx(n.getHours() * 60 + n.getMinutes()) + 'px';
        Array.prototype.forEach.call(document.querySelectorAll('.cal-layout .cal-now'), function (el) { el.style.top = top; });
      }
    };
  }

  function focusCard(id) {
    var c = document.querySelector('[data-focus-key="unsched:' + id + '"]');
    if (!c || !c.isConnected) return false;
    try { c.focus(); } catch (e) { return false; }
    return document.activeElement === c;
  }

  // ------------------------------------------------------------------ 끌기 (CAL §4, §10.1)
  var dwell = null, navDwell = null, overEl = null, fitCache = {}, lastSay = '', keepGhost = null;

  function stopDwell() {
    if (!dwell) return;
    clearTimeout(dwell.timer);
    if (dwell.cell) dwell.cell.classList.remove('is-dwelling', 'is-ding');
    dwell = null;
  }
  function stopNavDwell() { if (navDwell) { clearTimeout(navDwell.timer); navDwell = null; } }
  function clearOver() {
    if (overEl) overEl.classList.remove('is-over');
    overEl = null;
  }
  function say(t) { if (t && t !== lastSay && DP() && DP().say) { lastSay = t; DP().say(t); } }

  function fitText(cell, s) {
    var ymd = cell.getAttribute('data-day');
    if (fitCache[ymd] != null) return fitCache[ymd];
    var txt = '';
    var n = DN.app.now();
    var p = s.payload;
    if (p.kind === 'task' && PL()) {
      if (ymd < D.ymd(n)) txt = '지난 날짜';
      else {
        var o = { now: n, workHours: S.state.prefs.workHours, minutes: p.minutes != null ? p.minutes : 30, limit: 1 };
        var list = PL().suggestSlots(S.state, p.id, ymd, o);
        if (list.length) txt = D.hm(list[0].start) + ' 추천';
        else {
          var r = PL().placeOnDay(S.state, p.id, ymd, o);
          var t = M.byId(S.state.tasks, p.id);
          var mode = t ? PL().taskMode(S.state, t, { now: n }) : null;
          var wh = SL() ? SL().normalizeWorkHours(S.state.prefs.workHours) : null;
          if (r.reason === 'no_window' && mode && mode.ctx === 'work' && wh && !SL().isWorkingDay(D.parseYmd(ymd), wh)) txt = '업무는 근무일에만';
          else if (r.reason === 'after_due') txt = '마감보다 늦어요';
          else if (r.reason === 'no_window') txt = '알맞은 시간대 없음';
          else txt = '빈 시간 없음';
        }
      }
    }
    fitCache[ymd] = txt;
    return txt;
  }

  function dayLabel(ymd) {
    var d = D.parseYmd(ymd);
    return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + D.WEEKDAYS[d.getDay()] + '요일';
  }

  function startDwell(cell, s) {
    if (s.payload.kind !== 'task') return;
    var ymd = cell.getAttribute('data-day');
    var cd = CD();
    if (!cd) return;
    if (cd.isOpen() && cd.ymd() === ymd) return;
    cell.classList.remove('is-dwelling');
    void cell.offsetWidth;   // 막대가 0부터 다시 차오르게
    cell.classList.add('is-dwelling');
    var d = { ymd: ymd, cell: cell, timer: 0 };
    dwell = d;
    d.timer = setTimeout(function () {
      if (dwell !== d) return;
      cell.classList.remove('is-dwelling');
      cell.classList.add('is-ding');
      if ((s.pointerType === 'touch' || s.pointerType === 'pen') && navigator.vibrate) { try { navigator.vibrate(20); } catch (e) { /* 없음 */ } }
      d.timer = setTimeout(function () {
        cell.classList.remove('is-ding');
        if (dwell !== d) return;
        dwell = null;
        if (!(DP() && DP().active())) return;
        cd.open(ymd, { dragging: true, openedBy: 'dwell', taskId: s.payload.id });
      }, DING_MS);
    }, DWELL_MS);
  }
  function startNavDwell(btn) {
    var dm = Number(btn.getAttribute('data-nav')) || 0;
    if (!dm) return;
    var nd = { timer: 0 };
    navDwell = nd;
    function tick() {
      nd.timer = setTimeout(function () {
        if (navDwell !== nd || !(DP() && DP().active())) return;
        if (live && live.pageDuringDrag) live.pageDuringDrag(dm);
        fitCache = {};
        tick();
      }, NAV_DWELL_MS);
    }
    tick();
  }

  function dropKind(t) { return t ? t.getAttribute('data-drop') : null; }

  function dragOpts() {
    return {
      onStart: function () {
        fitCache = {}; lastSay = ''; keepGhost = null;
        ui.closeMenu(false);
      },
      onOver: function (target, s) {
        clearOver(); stopDwell(); stopNavDwell();
        var k = dropKind(target);
        if (!k) { if (TL()) TL().clearGhosts(); return; }
        if (k === 'day') {
          overEl = target;
          target.classList.add('is-over');
          var fit = target.querySelector('.cm-fit');
          if (fit) fit.textContent = fitText(target, s);
          say(dayLabel(target.getAttribute('data-day')) + ' 위');
          startDwell(target, s);
        } else if (k === 'nav') {
          overEl = target;
          target.classList.add('is-over');
          startNavDwell(target);
        }
        if (k !== 'slot' && TL()) TL().clearGhosts();
      },
      onMove: function (s) {
        var t = s.target, tl = TL();
        if (!tl || dropKind(t) !== 'slot') return;
        Array.prototype.forEach.call(document.querySelectorAll('.cal-ghost, .cd-ghost'), function (g) { if (g.parentNode !== t) g.remove(); });
        var inPanel = t.classList.contains('cd-col');
        var info = inPanel && CD() && CD()._dragInfo ? CD()._dragInfo() : null;
        var g = tl.ghostAt(t, t.getAttribute('data-day'), s.y, s.payload, inPanel
          ? { cls: 'cd-ghost', magnets: info ? info.magnets : [], allowed: s.payload.kind === 'task' && info ? info.allowed : null }
          : { cls: 'cal-ghost' });
        say(D.hm(g.start) + ' 위');
      },
      onDrop: function (target, s) {
        stopDwell(); stopNavDwell(); clearOver();
        var k = dropKind(target);
        var p = s.payload;
        var cd = CD();
        var dwellOpen = cd && cd.isOpen() && (cd.opts() || {}).openedBy === 'dwell';
        if (k === 'day') {
          if (TL()) TL().clearGhosts();
          if (p.kind !== 'task') return;
          if (dwellOpen) cd.close('drop-outside');
          var ymd = target.getAttribute('data-day');
          if (mem.picking) mem.picking = null;
          if (CP()) CP().dropOnDay(p.id, ymd, target);
        } else if (k === 'slot') {
          var tl = TL();
          if (!tl || !CP()) return;
          var ymd2 = target.getAttribute('data-day');
          var start = tl.timeAt(target, ymd2, s.y, p.offsetMin || 0);
          var info = target.classList.contains('cd-col') && cd && cd._dragInfo ? cd._dragInfo() : null;
          if (info && p.kind === 'task') {
            var g = tl.ghostAt(target, ymd2, s.y, p, { cls: 'cd-ghost', magnets: info.magnets, allowed: info.allowed });
            start = g.start;
          }
          var ghost = target.querySelector('.cal-ghost, .cd-ghost');
          keepGhost = ghost;
          var anchor = ghost || target;
          var done = function () { if (ghost) ghost.remove(); if (keepGhost === ghost) keepGhost = null; };
          var pr = p.kind === 'block'
            ? CP().dropAtTime(null, start, anchor, { blockId: p.id })
            : CP().dropAtTime(p.id, start, anchor, { copy: target.classList.contains('cd-col') ? 'day' : 'week' });
          pr.then(done, done);
        } else {
          // 달 넘기기 버튼 위에 놓기 = 취소
          if (TL()) TL().clearGhosts();
          if (dwellOpen) cd.close('drop-outside');
        }
      },
      onCancel: function () {
        stopDwell(); stopNavDwell(); clearOver();
        if (TL()) TL().clearGhosts();
        var cd = CD();
        if (cd && cd.isOpen() && (cd.opts() || {}).openedBy === 'dwell') cd.close('cancel');
      },
      onEnd: function () {
        stopDwell(); stopNavDwell(); clearOver();
        Array.prototype.forEach.call(document.querySelectorAll('.cal-ghost, .cd-ghost'), function (g) { if (g !== keepGhost) g.remove(); });
        setTimeout(function () {
          if (!mem.dirty || mem.popOpen || (DP() && DP().active())) return;
          mem.dirty = false;
          if (DN.app.current().view === 'calendar') DN.app.refresh();
        }, 0);
      }
    };
  }

  DN.views.calendar = { title: '캘린더', render: render, _mem: mem };
})();
