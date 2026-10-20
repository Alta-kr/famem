'use strict';

// 홈(오늘) — 세 칸만 둔다.
//   1) 채팅: 적으면 AI 가 메모/할 일로 나누고, 도우미 버튼(다음 할 일·작게 나누기·휴식)
//   2) 오늘: 위는 할 일, 아래는 메모. 끌어 놓아 순서(우선순위)를 바꾼다 — 키보드는 Alt+↑/↓
//   3) 오늘 일정

(function () {
  var DN = window.Daynote;
  var M = DN.model, D = DN.dates, S = DN.store, ui = DN.ui, h = ui.h;

  function render(root) {
    var A = DN.app;
    root.style.overflow = 'hidden';

    var chatHost = h('div.home-chat');
    var listsHost = h('div.home-lists');
    var home = h('div.home', chatHost, colBar(), listsHost);
    applyCols(home, S.state.prefs.homeCols);
    root.appendChild(home);

    var chat = DN.views.chat.render(chatHost);
    function paint() {
      var keep = Array.prototype.map.call(listsHost.querySelectorAll('[data-keep-scroll]'), function (e) { return [e.getAttribute('data-keep-scroll'), e.scrollTop]; });
      var act = document.activeElement;
      var focusEdge = act && listsHost.contains(act) ? act.getAttribute('data-split-edge') : null;
      listsHost.textContent = '';
      listsHost.appendChild(todayLists(S.state, A.now()));
      keep.forEach(function (p) { var e = listsHost.querySelector('[data-keep-scroll="' + p[0] + '"]'); if (e) e.scrollTop = p[1]; });
      if (focusEdge != null) { var bar = listsHost.querySelector('[data-split-edge="' + focusEdge + '"]'); if (bar) bar.focus(); }
    }
    paint();
    repaintLists = paint;   // 화면 안에서만 바뀌는 것(메모 체크·펼치기)은 오른쪽만 다시 — 채팅을 다시 그리면 깜빡인다
    // 창 크기가 바뀌면 다시 그린다 — 2주 띠 자동 접기·채팅 칸 기본 폭이 창 크기를 따른다
    var resizeT = null;
    function onResize() { clearTimeout(resizeT); resizeT = setTimeout(function () { if (S.state.prefs.homeCols == null) applyCols(home, null); paint(); }, 150); }
    window.addEventListener('resize', onResize);
    // 막대를 끄는 중에는 다시 그리지 않는다 — 끝나면 한 번만 그린다
    splitDrag.repaint = function () { chat.refresh(); paint(); };

    return {
      destroy: function () { repaintLists = null; window.removeEventListener('resize', onResize); clearTimeout(resizeT); root.style.overflow = ''; splitDrag.repaint = null; splitDrag.pending = false; if (chat.destroy) chat.destroy(); },
      // 입력창은 다시 만들지 않는다 — 쓰는 중에 AI 결과가 와도 입력·한글 조합이 끊기지 않게
      onChange: function (info) {
        if (info.source === 'today') return true;
        if (info.type === 'load') return false;
        if (splitDrag.active) { splitDrag.pending = true; return true; }
        chat.refresh();
        paint();
        return true;
      },
      onTick: function () {
        if (splitDrag.active) { splitDrag.pending = true; return; }
        paint();
      }
    };
  }

  var repaintLists = null;
  function listsOnly() { if (repaintLists) repaintLists(); else DN.app.refresh(); }

  // ------------------------------------------------------------------ 오늘의 할 일 · 메모
  function todayTaskList(st, now) {
    var today = D.ymd(now);
    var blockToday = {};
    st.blocks.forEach(function (b) { if (b.taskId && D.ymd(b.start) === today) blockToday[b.taskId] = true; });
    var open = [], done = [];
    M.liveTasks(st).forEach(function (t) {
      if (t.status === 'done') { if (t.completedAt && D.ymd(t.completedAt) === today && !t.homeClearedAt) done.push(t); return; }
      if (t.status === 'in_progress') { open.push(t); return; }
      // 앞날로 '할 날' 을 정한 일은 마감이 지났어도 그날 칸에서 — 끌어서 내일로 옮긴 일이 오늘에 남지 않게
      if (t.planDate && t.planDate > today) return;
      if (t.status === 'paused' || blockToday[t.id] || (t.dueDate && t.dueDate <= today) || (t.planDate && t.planDate <= today)) { open.push(t); return; }
      // 앞날에 자리가 있는 일(할 날 · 작업 시간 · 마감)은 그날 칸에서 — 오늘 만든 일이라도 (결과 카드의 [→ 그날 칸] 과 같게)
      var anchor = DN.horizon ? DN.horizon.anchorDay(st, t, now) : t.planDate;
      if (anchor && anchor > today) return;
      if (D.ymd(t.createdAt) === today) open.push(t);
    });
    function rank(t) {
      if (t.status === 'in_progress' || t.status === 'paused') return 0;
      if (t.dueDate && t.dueDate < today) return 1;
      if (t.dueDate === today) return 2;
      return 3;
    }
    // 사용자가 정한 순서가 먼저, 나머지는 급한 순
    open.sort(function (a, b) {
      var sa = typeof a.sortOrder === 'number', sb = typeof b.sortOrder === 'number';
      if (sa && sb) return a.sortOrder - b.sortOrder;
      if (sa !== sb) return sa ? -1 : 1;
      return rank(a) - rank(b) || (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || (a.createdAt < b.createdAt ? -1 : 1);
    });
    done.sort(function (a, b) { return a.completedAt < b.completedAt ? 1 : -1; });
    return { open: open, done: done };
  }

  function todayMemoList(st, now) {
    var today = D.ymd(now);
    return M.liveNotes(st).filter(function (n) {
      if (n.captureRole === 'task_source' || n.homeHiddenAt) return false;
      return !!n.homePinnedAt || D.ymd((n.capture && n.capture.at) || n.createdAt) === today;
    }).sort(function (a, b) {
      var sa = typeof a.sortOrder === 'number', sb = typeof b.sortOrder === 'number';
      if (sa && sb) return a.sortOrder - b.sortOrder;
      if (sa !== sb) return sa ? -1 : 1;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
  }

  function todayLists(st, now) {
    var A = DN.app;
    var tl = todayTaskList(st, now);
    var memos = todayMemoList(st, now);
    var sel = A.detailTaskId();
    var view = st.prefs.homeView || 'today';
    var tomorrow = D.ymd(D.addDays(now, 1));
    if (view === 'tomorrow') view = 'today';   // 내일은 [오늘] 안에 함께 보인다
    if (view.indexOf('day:') === 0 && view.slice(4) <= tomorrow) view = 'today';
    // 내일 할 일 — 오늘 목록 아래 '내일' 묶음으로
    var tmr = DN.horizon.byDay(st, [tomorrow], now)[0] || { day: tomorrow, tasks: [], events: [] };

    // 3개만 보기 — 할 일이 많으면 위 3개만 (나머지는 접어 둔다. 고를 게 적을수록 시작이 쉽다)
    var focusOnly = !!st.prefs.todayTop3 && tl.open.length > 3;
    var shownOpen = focusOnly ? tl.open.slice(0, 3) : tl.open;
    var taskUl = h('ul.home-list', { 'aria-label': '오늘의 할 일 (끌어서 순서 바꾸기, Alt+위/아래)' },
      shownOpen.map(function (t) { return taskRow(st, t, now, t.id === sel); }),
      focusOnly ? h('li.home-more', h('button.link-btn', { type: 'button', onclick: function () { S.mutate(null, function (s) { s.prefs.todayTop3 = false; }); } }, '나머지 ' + (tl.open.length - 3) + '개 보기')) : null,
      focusOnly ? null : tl.done.map(function (t) { return taskRow(st, t, now, t.id === sel); }));
    sortable(taskUl, shownOpen.map(function (t) { return t.id; }), function (ids) {
      var all = ids.concat(tl.open.map(function (t) { return t.id; }).filter(function (id) { return ids.indexOf(id) === -1; }));
      S.mutate('할 일 순서 바꾸기', function (s) { all.forEach(function (id, i) { var t = M.byId(s.tasks, id); if (t) t.sortOrder = (i + 1) * 10; }); });
    });

    var memoUl = h('ul.home-list', { 'aria-label': '오늘 적은 메모 (끌어서 순서 바꾸기, Alt+위/아래)' }, memos.map(function (n) { return memoRow(st, n, now); }));
    sortable(memoUl, memos.map(function (n) { return n.id; }), function (ids) {
      S.mutate('메모 순서 바꾸기', function (s) { ids.forEach(function (id, i) { var n = M.byId(s.notes, id); if (n) n.sortOrder = (i + 1) * 10; }); });
    });

    // 체크한 메모 — 화면에만 (다시 그려도 남는다). 지금 홈에 없는 메모는 빼 둔다
    Object.keys(memoSel).forEach(function (id) { if (!memos.some(function (n) { return n.id === id; })) delete memoSel[id]; });
    var selCount = Object.keys(memoSel).length;
    var openCount = tl.open.length;
    var secTasks = view !== 'today' ? rangeSection(st, now, view) : h('div.home-sec.home-sec-tasks',
      h('div.home-sec-head', h('h2', '할 일'), h('span.meta', openCount ? '남은 ' + openCount + '개' : ''), h('span.home-sec-tools',
        openCount > 3 ? h('button.btn.btn-ghost.btn-xs' + (st.prefs.todayTop3 ? '.is-on' : ''), { type: 'button', 'aria-pressed': String(!!st.prefs.todayTop3), title: '위 3개만 보여 줘요 — 고를 게 적을수록 시작이 쉬워요',
          onclick: function () { S.mutate(null, function (s) { s.prefs.todayTop3 = !s.prefs.todayTop3; }); } }, '3개만') : null,
        tl.done.length ? h('button.btn.btn-ghost.btn-xs', { type: 'button', title: '오늘 끝낸 일을 목록에서 치워요 (보관함에서 다시 볼 수 있어요)', onclick: function () { clearDone(tl.done); } }, '완료 비우기 (' + tl.done.length + ')') : null,
        h('button.btn.btn-ghost.btn-xs', { type: 'button', onclick: function () { A.go('tasks'); } }, '전체 보기'))),
      alertsLine(st, now, tl.open.concat(tmr.tasks)),
      h('div.home-scroll', { 'data-keep-scroll': 'home-tasks' },
        dayZone(h('div.hz-today-zone', tl.open.length || tl.done.length ? taskUl : h('div.empty.home-empty' + (tmr.tasks.length ? '.is-compact' : ''), '오늘 할 일이 없어요. 왼쪽에 적으면 할 일은 여기로 들어와요.')), D.ymd(now), { ownSort: true }),
        tomorrowGroup(st, now, tmr, sel)));
    var secMemos = h('div.home-sec.home-sec-memos',
      h('div.home-sec-head', h('h2', '메모'), h('span.meta', memos.length ? memos.length + '개' : ''),
        selCount ? h('button.btn.btn-ghost.btn-xs.is-on', { type: 'button', onclick: function () { shelve(Object.keys(memoSel)); } }, '체크한 메모 비우기 (' + selCount + ')') : null,
        memos.length ? h('button.btn.btn-ghost.btn-xs', { type: 'button', title: '홈의 메모를 모두 보관함으로 (지우지 않아요)', onclick: function () { shelve(memos.map(function (n) { return n.id; })); } }, '전체 비우기') : null,
        h('button.btn.btn-ghost.btn-xs.shelf-open-btn', { type: 'button', onclick: function () { shelfDock(); } }, '보관함')),
      h('div.home-scroll', { 'data-keep-scroll': 'home-memos' },
        memos.length ? memoUl : h('div.empty.home-empty', '오늘 적은 메모가 여기에 모여요.')));
    secTasks.id = 'home-sec-tasks';
    secMemos.id = 'home-sec-memos';
    // 작업 공간(채팅)의 작업 카드를 여기로 끌어 놓으면 '할 일' 로 돌려보낸다 (진행 중·일시 정지 → 할 일)
    //   메모를 끌어 놓으면 할 일로 정리한다 — 첫 줄이 제목, 아래 목록·들여쓴 줄은 세부 할 일 (세부 할 일 아래 단계까지)
    function hasType(e, t) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], t) !== -1; }
    function isWork(e) { return hasType(e, 'application/x-daynote-work'); }
    function isNote(e) { return hasType(e, 'application/x-daynote-note'); }
    secTasks.addEventListener('dragover', function (e) {
      if (!isWork(e) && !isNote(e)) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      secTasks.classList.add('is-drop-target');
      secTasks.classList.toggle('is-note-drop', isNote(e));
    });
    secTasks.addEventListener('dragleave', function (e) { if (!secTasks.contains(e.relatedTarget)) secTasks.classList.remove('is-drop-target', 'is-note-drop'); });
    secTasks.addEventListener('drop', function (e) {
      if (!isWork(e) && !isNote(e)) return;
      e.preventDefault();
      secTasks.classList.remove('is-drop-target', 'is-note-drop');
      if (isNote(e)) { A.memoToTask(e.dataTransfer.getData('application/x-daynote-note')); return; }
      DN.assistant.returnWork(e.dataTransfer.getData('application/x-daynote-work'));
    });
    // 할 일을 메모 칸에 끌어 놓으면 메모로 (오늘 목록의 할 일 · 작업 카드)
    function isTask(e) { return hasType(e, 'application/x-daynote-task'); }
    secMemos.addEventListener('dragover', function (e) {
      if (!isTask(e)) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      secMemos.classList.add('is-drop-target', 'is-note-drop');
    });
    secMemos.addEventListener('dragleave', function (e) { if (!secMemos.contains(e.relatedTarget)) secMemos.classList.remove('is-drop-target', 'is-note-drop'); });
    secMemos.addEventListener('drop', function (e) {
      if (!isTask(e)) return;
      e.preventDefault();
      secMemos.classList.remove('is-drop-target', 'is-note-drop');
      A.taskToMemo(e.dataTransfer.getData('application/x-daynote-task'));
    });
    var secs = [secTasks, secMemos, agenda(st, now)];
    secs.bars = [];
    var bar0 = splitter(secs, 0), bar1 = splitter(secs, 1);
    applySplit(secs, st.prefs.homeSplit);
    return h('section.home-today', { 'aria-label': '오늘' },
      h('div.home-today-head', h('h1.home-title', viewTitle(view, now)), h('span.meta', D.longDay(now)), viewTabs(view), stripToggle(st)),
      stripShown(st) ? dayStrip(st, now, view) : null,
      secs[0], bar0, secs[1], bar1, secs[2]);
  }

  // ------------------------------------------------------------------ 세 칸 높이 조정
  // 드래그 중에는 DOM 의 flex 만 바꾸고, 놓을 때 한 번만 prefs.homeSplit 에 저장한다 (silent, 되돌리기 대상 아님).
  // 드래그하는 동안에는 화면 다시 그리기를 미뤘다가(pending) 끝날 때 한 번만 그린다.
  // 비율 계산은 src/core/split.js 의 순수 함수 (test/split.test.js).
  var SPLIT_NAMES = [['할 일', '메모'], ['메모', '오늘 일정']];
  var SPLIT_SHORT = ['할 일', '메모', '일정'];
  var splitDrag = { active: false, pending: false, repaint: null, lastTotal: 0 };

  // 비율을 세 칸에 적용하고 두 막대의 ARIA 값을 맞춘다. min 을 모르면 마지막으로 잰 높이로 계산한다.
  function applySplit(secs, ratios, min) {
    var SP = DN.split;
    if (min == null) min = SP.minRatio(splitDrag.lastTotal);
    var r = SP.clampAll(ratios, min);
    secs.forEach(function (el, i) { el.style.flex = r[i] + ' 1 0'; });
    var text = r.map(function (x, i) { return SPLIT_SHORT[i] + ' ' + Math.round(x * 100) + '%'; }).join(', ');
    (secs.bars || []).forEach(function (bar) {
      var edge = Number(bar.getAttribute('data-split-edge'));
      bar.setAttribute('aria-valuenow', String(Math.round(r[edge] * 100)));
      bar.setAttribute('aria-valuetext', text);
    });
    return r;
  }

  // 지금 화면에 보이는 높이 → 비율. 높이를 잴 수 없으면(숨김 등) 저장값을 쓴다.
  function currentSplit(secs) {
    var hs = secs.map(function (el) { return el.getBoundingClientRect().height; });
    var total = hs[0] + hs[1] + hs[2];
    if (total > 0) splitDrag.lastTotal = total;
    var min = DN.split.minRatio(total);
    var ratios = total > 0 ? hs.map(function (x) { return x / total; }) : S.state.prefs.homeSplit;
    return { total: total, min: min, ratios: DN.split.clampAll(ratios, min) };
  }

  // 반올림한 뒤에 기본값인지 본다 — 기본값이면 저장하지 않는다
  function saveSplit(r) {
    var rounded = r ? DN.split.round(r) : null;
    S.mutate(null, function (s) {
      if (rounded && !DN.split.isDefault(rounded)) s.prefs.homeSplit = rounded;
      else delete s.prefs.homeSplit;
    }, { silent: true });
  }

  function splitter(secs, edge) {
    var SP = DN.split;
    var el = h('div.home-split', {
      role: 'separator', 'aria-orientation': 'horizontal', tabindex: '0',
      'aria-valuemin': '0', 'aria-valuemax': '100', 'data-split-edge': String(edge),
      'aria-controls': edge === 0 ? 'home-sec-tasks' : 'home-sec-memos',
      'aria-label': SPLIT_NAMES[edge][0] + '와 ' + SPLIT_NAMES[edge][1] + ' 사이 높이 조정',
      title: '끌어서 높이 조정 · ↑/↓ 5%씩 · Home/End 끝까지 · Enter·더블클릭: 기본값'
    });
    secs.bars.push(el);

    var drag = null;
    function onDocEnd(e) { end(e, true); }
    function finish() {
      splitDrag.active = false;
      el.classList.remove('is-dragging');
      document.documentElement.classList.remove('is-row-resizing');
      document.removeEventListener('pointerup', onDocEnd, true);
      document.removeEventListener('pointercancel', onDocEnd, true);
    }
    el.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      var cur = currentSplit(secs);
      if (!(cur.total > 0)) return;
      e.preventDefault(); e.stopPropagation();
      drag = { id: e.pointerId, y: e.clientY, start: cur.ratios, total: cur.total, min: cur.min, last: null };
      splitDrag.active = true;
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      el.classList.add('is-dragging');
      document.documentElement.classList.add('is-row-resizing');
      // 안전망: 포인터 캡처가 풀리거나 막대가 사라져도 끝은 반드시 처리한다
      document.addEventListener('pointerup', onDocEnd, { capture: true, once: true });
      document.addEventListener('pointercancel', onDocEnd, { capture: true, once: true });
    });
    el.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      drag.last = applySplit(secs, SP.moveEdge(drag.start, edge, (e.clientY - drag.y) / drag.total, drag.min), drag.min);
    });
    function end(e, fromDoc) {
      if (!drag) { if (fromDoc) finish(); return; }
      if (e && e.pointerId != null && e.pointerId !== drag.id && !fromDoc) return;
      var last = drag.last, id = drag.id;
      drag = null;
      try { if (el.hasPointerCapture(id)) el.releasePointerCapture(id); } catch (_) {}
      finish();
      if (last) saveSplit(last);
      if (splitDrag.pending) {
        splitDrag.pending = false;
        if (splitDrag.repaint) splitDrag.repaint();
      }
    }
    el.addEventListener('pointerup', function (e) { end(e); });
    el.addEventListener('pointercancel', function (e) { end(e); });
    el.addEventListener('lostpointercapture', function (e) { end(e); });

    function reset() {
      applySplit(secs, SP.DEFAULT);
      saveSplit(null);
    }
    function nudge(delta) {
      var cur = currentSplit(secs);
      var r = applySplit(secs, SP.moveEdge(cur.ratios, edge, delta, cur.min), cur.min);
      saveSplit(r);
    }
    el.addEventListener('dblclick', function (e) { e.preventDefault(); e.stopPropagation(); reset(); });
    el.addEventListener('keydown', function (e) {
      var delta = { ArrowUp: -SP.KEY_STEP, ArrowDown: SP.KEY_STEP, Home: -10, End: 10 }[e.key];
      if (delta != null) {
        e.preventDefault(); e.stopPropagation();
        nudge(delta);
      } else if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        reset();
      }
    });
    return el;
  }

  function taskRow(st, t, now, selected) {
    var A = DN.app;
    var done = t.status === 'done';
    var steps = t.steps || [];
    var stepCnt = DN.steps.count(steps);
    var check = h('input.check', { type: 'checkbox', checked: done, 'aria-label': '‘' + t.title + '’ ' + (done ? '완료 취소' : '완료'),
      onclick: function (e) { e.stopPropagation(); }, onchange: function () { A.toggleDone(t.id); } });
    var proj = t.projectId && M.byId(st.projects, t.projectId);
    var pendingDraft = !done && t.breakdown && (t.breakdown.status === 'pending' || t.breakdown.status === 'later') && !steps.length;
    var meta = h('div.home-meta',
      t.status === 'in_progress' ? h('span.chip.chip-progress', ui.icon('play'), '진행 중') : null,
      t.status === 'paused' ? h('span.chip.chip-paused', ui.icon('pause'), '일시 정지') : null,
      ui.dueChip(t, now, { add: true }),
      !done && t.planDate && (t.planDate !== D.ymd(now) || !t.dueDate) ? ui.planChip(t, now) : null,
      DN.habits && DN.habits.isWeekGoal(t, now) ? h('span.chip.chip-goal', { title: '이번 주 꼭 끝낼 일' }, '★ 이번 주') : null,
      steps.length ? h('span.chip.chip-steps', '단계 ' + stepCnt.done + '/' + stepCnt.total, h('span.mini-bar', h('span', { style: { width: Math.round(stepCnt.done / stepCnt.total * 100) + '%' } }))) : null,
      ui.prepChip(t),
      pendingDraft ? h('button.chip.chip-guess.chip-btn', { type: 'button', title: 'AI가 나눠 둔 단계 보기', onclick: function (e) { e.stopPropagation(); DN.assistant.breakdown(t.id); } }, '나눠 둔 단계 있음') : null,
      ui.projectPickChip(st, t));
    var main = h('div.home-main', h('div.home-row-title', t.title || '(제목 없음)'), meta.childNodes.length ? meta : null);
    var li = h('li.home-row' + (done ? '.is-done' : '') + (selected ? '.is-selected' : ''), {
      'data-id': done ? null : t.id, 'data-task-id': done ? null : t.id, draggable: done ? null : 'true', tabindex: '0',
      title: done ? null : '끌어서 순서 바꾸기 · 채팅으로 끌어 놓으면 작업 공간에 올라가요',
      // 누르면 세부 할 일이 펼쳐진다 (상세 편집은 오른쪽 클릭 → 자세히 편집)
      onclick: function () { toggle(); },
      oncontextmenu: function (e) { e.preventDefault(); A.taskMenu(t.id, e.currentTarget); },
      onkeydown: function (e) { if (e.target !== e.currentTarget) return; if (e.key === 'Enter') { e.preventDefault(); toggle(); } else if (e.key === ' ') { e.preventDefault(); A.toggleDone(t.id); } }
    },
      done ? h('span.drag-handle.is-off', { 'aria-hidden': 'true' }) : h('span.drag-handle', { 'aria-hidden': 'true', title: '끌어서 순서 바꾸기' }, '⋮⋮'),
      check,
      main);
    var toggle = ui.stepsToggle(li, t, main);
    return li;
  }

  // 링크 메모의 첫 주소 → { url, host } (주소가 없으면 null)
  function firstLink(n) {
    var m = /https?:\/\/[^\s<>"')\]]+/i.exec((n.title || '') + '\n' + (n.body || ''));
    if (!m) return null;
    var url = m[0].replace(/[.,;:!?]+$/, '');
    var host = url.replace(/^https?:\/\//i, '').split(/[\/?#]/)[0].replace(/^www\./i, '');
    return host ? { url: url, host: host } : null;
  }

  // ------------------------------------------------------------------ 앞을 내다보기 — 보기 탭 · 2주 띠 · 날짜별 묶음 · 다가오는 마감 (src/core/horizon.js)
  function setView(v) { S.mutate(null, function (s) { s.prefs.homeView = v; }); }
  function viewTitle(view, now) {
    if (view.indexOf('day:') === 0) return D.relDay(view.slice(4), now);
    return ({ today: '오늘', tomorrow: '내일', week: '이번 주', next: '다음 주' })[view] || '오늘';
  }
  function viewTabs(view) {
    return h('div.hz-tabs', { role: 'tablist', 'aria-label': '보는 기간' }, DN.horizon.VIEWS.map(function (v) {
      var on = view === v.id;
      return h('button.hz-tab' + (on ? '.is-on' : ''), { type: 'button', role: 'tab', 'aria-selected': String(on), onclick: function () { setView(v.id); } }, v.label);
    }));
  }
  // [오늘] 아래 '내일' 묶음 — 내일 할 일·일정. 머리에 끌어 놓으면 내일 할 일로
  function tomorrowGroup(st, now, g, sel) {
    var head = h('div.hz-group-head.hz-tomorrow-head',
      h('b', '내일'), h('span.meta', D.shortDay(D.parseYmd(g.day))),
      g.tasks.length || g.events.length ? h('span.meta', [g.tasks.length ? '할 일 ' + g.tasks.length : null, g.events.length ? '일정 ' + g.events.length : null].filter(Boolean).join(' · ')) : null);
    var events = g.events.map(function (b) {
      return h('div.hz-event', h('span.time', D.hm(b.start) + '–' + D.hm(b.end)), h('button.link-btn', { type: 'button', onclick: function () { DN.views.schedule.open({ blockId: b.id }); } }, b.title || '일정'));
    });
    return dayZone(h('div.hz-group.hz-tomorrow', head, events,
      g.tasks.length ? h('ul.home-list', { 'aria-label': '내일 할 일 (다른 날로 끌어 옮기기)' }, g.tasks.map(function (t) { return taskRow(st, t, now, t.id === sel); }))
        : h('div.hz-empty.meta', g.events.length ? '' : '비어 있어요 — 할 일이나 메모를 여기로 끌어 놓으면 내일 할 일로')), g.day);
  }
  // 할 날 정하기 — 끌어 놓기·칩·오른쪽 클릭 메뉴가 함께 쓴다
  function setPlan(taskId, day) {
    var t = M.byId(S.state.tasks, taskId);
    if (!t) return;
    var now = DN.app.now();
    if (day && t.planDate === day) return;
    S.mutate(day ? '할 날 정하기' : '할 날 지우기', function (s) { M.updateTask(s, taskId, { planDate: day || null }, now); });
    var note = !day ? '' : t.dueDate && day > t.dueDate ? ' — 마감(' + D.relDay(t.dueDate, now) + ')보다 늦어요' : t.status === 'in_progress' ? ' — 진행 중이라 오늘 목록에도 남아요' : '';
    var rel = D.relDay(day, now), left = day ? DN.horizon.leftText(day, now) : '';
    ui.undoToast(day ? '‘' + t.title + '’ ' + (rel === '오늘' ? '오늘 할게요' : rel + '에 할게요' + (left && left !== rel ? ' (' + left + ')' : '')) + note + '.' : '‘' + t.title + '’ 할 날을 지웠어요.');
  }
  // 날 묶음(오늘 목록 · 내일 · 이번 주의 각 날) — 어느 날에서 끌기 시작했는지 기억해 같은 날에 놓으면 (순서 바꾸기는 그대로) 날짜를 안 바꾼다
  var dragFromDay = null;
  //   opts.ownSort: 그 안에 자체 순서 바꾸기가 있으면(오늘 목록) 같은 날 끌기는 받지 않는다. 없으면(내일·이번 주 날 묶음) 같은 날 안에서도 끼워 넣기로 순서 바꾸기
  function dayZone(el, day, opts) {
    el.addEventListener('dragstart', function (e) { if (e.target.closest && e.target.closest('[data-task-id]') && !e.target.closest('[data-step-id]')) dragFromDay = day; }, true);
    el.addEventListener('dragend', function () { dragFromDay = null; }, true);
    return dropDay(el, day, Object.assign({ zone: true }, opts || {}));
  }
  // 끌고 있는 할 일 — dragover 에서는 끄는 내용(getData)을 못 읽어서 시작할 때 기억해 둔다
  var dragTaskId = null;
  document.addEventListener('dragstart', function (e) {
    var isStep = e.target && e.target.closest && e.target.closest('[data-step-id]');
    var x = !isStep && e.target && e.target.closest && e.target.closest('[data-task-id]');
    dragTaskId = x ? x.getAttribute('data-task-id') : null;
  }, true);
  document.addEventListener('dragend', function () { dragTaskId = null; }, true);
  // 놓을 자리 — 커서가 있는 두 줄 사이. 그 틈 한가운데에 선 하나를 그린다 (A 아래와 B 위는 같은 자리)
  //   rows: 놓을 수 있는 줄들(끌고 있는 줄은 뺀다) · 돌려주는 값: { beforeId, afterId } (끝이면 afterId)
  function dropLineAt(box, rows, clientY, idAttr) {
    var line = null;
    for (var c = box.firstChild; c; c = c.nextSibling) if (c.classList && c.classList.contains('drop-line')) { line = c; break; }
    if (!line) { line = h('div.drop-line', { 'aria-hidden': 'true' }); box.appendChild(line); }
    var br = box.getBoundingClientRect(), idx = rows.length;
    for (var i = 0; i < rows.length; i++) { var r = rows[i].getBoundingClientRect(); if (clientY < r.top + r.height / 2) { idx = i; break; } }
    var y;
    if (!rows.length) y = 6;
    else if (idx === 0) y = rows[0].getBoundingClientRect().top - br.top - 1;
    else if (idx === rows.length) y = rows[rows.length - 1].getBoundingClientRect().bottom - br.top - 1;
    else { var a = rows[idx - 1].getBoundingClientRect(), b = rows[idx].getBoundingClientRect(); y = (a.bottom + b.top) / 2 - br.top - 1; }
    line.style.top = Math.round(y) + 'px';
    return { beforeId: idx < rows.length ? rows[idx].getAttribute(idAttr) : null, afterId: idx === rows.length && rows.length ? rows[rows.length - 1].getAttribute(idAttr) : null };
  }
  function clearLine(box) { Array.prototype.forEach.call(box.querySelectorAll('.drop-line'), function (l) { l.remove(); }); clearNest(box); }
  // 할 일 줄의 가운데(위·아래 30% 를 뺀 곳)에 있으면 그 할 일 안으로 — 세부 할 일로 넣기
  function nestRowAt(rows, clientY, exceptTaskId) {
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], tid = r.getAttribute('data-task-id');
      if (!tid || tid === exceptTaskId) continue;
      var main = r.querySelector('.home-main') || r;
      var b = main.getBoundingClientRect();
      var band = Math.min(14, b.height * 0.3);
      if (clientY > b.top + band && clientY < b.bottom - band) return r;
    }
    return null;
  }
  function markSplit(box, on) { Array.prototype.forEach.call(box.querySelectorAll('.drop-line'), function (l) { l.classList.toggle('is-split', !!on); }); }
  function clearNest(box) { Array.prototype.forEach.call(box.querySelectorAll('.is-nest-target'), function (r) { r.classList.remove('is-nest-target'); }); }
  function showNest(box, row) { clearNest(box); Array.prototype.forEach.call(box.querySelectorAll('.drop-line'), function (l) { l.remove(); }); row.classList.add('is-nest-target'); }
  function stepData(e) { try { return JSON.parse(e.dataTransfer.getData('application/x-daynote-step') || 'null'); } catch (err) { return null; } }
  // 그날 목록의 순서 다시 매기기 (s 안에서 — 한 번의 되돌리기 칸에 함께)
  function orderInto(s, day, taskId, beforeId, afterId, now) {
    var list = (day === D.ymd(now) ? todayTaskList(s, now).open : DN.horizon.byDay(s, [day], now)[0].tasks).map(function (x) { return x.id; }).filter(function (id) { return id !== taskId; });
    var idx = beforeId ? list.indexOf(beforeId) : afterId ? list.indexOf(afterId) + 1 : list.length;
    if (idx < 0) idx = list.length;
    list.splice(idx, 0, taskId);
    list.forEach(function (id, i) { var x = M.byId(s.tasks, id); if (x) x.sortOrder = (i + 1) * 10; });
  }
  // Ctrl 을 누른 채 끌어 놓기 — 할 일을 나눠서 그날에도 하나 더 (제목 뒤 (1/2) · (2/2)). 세부 할 일은 그대로 복사
  //   이미 나눈 일이면 묶음 전체를 다시 매긴다 (1/3 · 2/3 · 3/3 — 새로 놓는 것이 마지막)
  var SPLIT_RE = /\s*\((\d+)\/(\d+)\)\s*$/;
  function baseTitle(title) { return String(title || '').replace(SPLIT_RE, '').trim(); }
  function splitTask(taskId, day, beforeId, afterId) {
    var now = DN.app.now();
    var t = M.byId(S.state.tasks, taskId);
    if (!t || t.deletedAt) return;
    var made = S.mutate('할 일 나누기', function (s) {
      var x = M.byId(s.tasks, taskId);
      var sid = x.split && x.split.id;
      var parts = sid ? s.tasks.filter(function (y) { return !y.deletedAt && y.split && y.split.id === sid; }) : [];
      if (!sid) { sid = M.uid('split'); x.split = { id: sid, part: 1 }; parts = [x]; }
      parts.sort(function (a, b) { return ((a.split.part || 0) - (b.split.part || 0)) || (a.createdAt < b.createdAt ? -1 : 1); });
      var base = baseTitle(x.title);
      var copy = M.addTask(s, {
        title: base, projectId: x.projectId || null, memo: x.memo || '', priority: x.priority || null, dueDate: x.dueDate || null, dueTime: x.dueTime || null,
        estimateMinutes: x.estimateMinutes || null, estimateSource: x.estimateSource || null,
        steps: JSON.parse(JSON.stringify(x.steps || [])), sources: JSON.parse(JSON.stringify(x.sources || [])),
        planDate: day || null, split: { id: sid }
      }, now);
      parts.push(copy);
      var n = parts.length;
      parts.forEach(function (p, i) { p.split = { id: sid, part: i + 1 }; p.title = baseTitle(p.title) + ' (' + (i + 1) + '/' + n + ')'; });
      if (day) orderInto(s, day, copy.id, beforeId, afterId, now);
      return copy;
    });
    ui.undoToast('‘' + baseTitle(t.title) + '’를 나눴어요 — ' + made.title + (day ? '를 ' + D.relDay(day, now) + '에' : '') + ' 놓았어요.');
  }
  // 세부 할 일 → 메인 할 일 (그날 할 일로, 놓은 자리에)
  function stepToTask(data, day, beforeId, afterId) {
    var now = DN.app.now(), ST = DN.steps;
    var src = M.byId(S.state.tasks, data.taskId);
    var node = src && ST.find(src.steps || [], data.stepId);
    if (!node) return;
    var made = S.mutate('세부 할 일을 할 일로', function (s) {
      var t = M.byId(s.tasks, data.taskId);
      t.steps = ST.remove(t.steps || [], data.stepId);
      var f = ST.toTaskFields(node);
      var nt = M.addTask(s, Object.assign(f, { projectId: t.projectId || null, planDate: day || null }), now);
      if (node.done) M.completeTask(s, nt.id, now);
      if (day) orderInto(s, day, nt.id, beforeId, afterId, now);
      return nt;
    });
    ui.undoToast('‘' + made.title + '’를 ‘' + src.title + '’에서 빼서 ' + (day ? D.relDay(day, now) + ' 할 일로' : '할 일로') + ' 만들었어요.');
  }
  // 할 일 → 다른 할 일의 세부 할 일 / 세부 할 일 → 다른 할 일 밑으로
  function nestInto(targetId, taskId, data) {
    var now = DN.app.now(), ST = DN.steps;
    var target = M.byId(S.state.tasks, targetId);
    if (!target) return;
    if (taskId) {
      var t = M.byId(S.state.tasks, taskId);
      if (!t || t.id === targetId) return;
      S.mutate('할 일을 세부 할 일로', function (s) {
        var x = M.byId(s.tasks, taskId), tg = M.byId(s.tasks, targetId);
        tg.steps = ST.append(tg.steps || [], ST.fromTask(x));
        M.deleteTask(s, taskId, now);
      });
      ui.undoToast('‘' + t.title + '’를 ‘' + target.title + '’의 세부 할 일로 넣었어요.');
      return;
    }
    if (!data || data.taskId === targetId) return;
    var src = M.byId(S.state.tasks, data.taskId);
    var node = src && ST.find(src.steps || [], data.stepId);
    if (!node) return;
    S.mutate('세부 할 일 옮기기', function (s) {
      var a = M.byId(s.tasks, data.taskId), b = M.byId(s.tasks, targetId);
      a.steps = ST.remove(a.steps || [], data.stepId);
      b.steps = ST.append(b.steps || [], node);
    });
    ui.undoToast('‘' + node.title + '’를 ‘' + target.title + '’ 밑으로 옮겼어요.');
  }
  function taskRowsIn(el) { return Array.prototype.filter.call(el.querySelectorAll('li[data-task-id]'), function (r) { return r.getAttribute('data-task-id') !== dragTaskId; }); }
  // 그날 목록의 그 자리에 끼워 넣기 — 할 날·순서를 한 번에 (Ctrl+Z 한 번)
  function placeInDay(taskId, day, beforeId, afterId) {
    var st = S.state, now = DN.app.now(), today = D.ymd(now);
    var t = M.byId(st.tasks, taskId);
    if (!t) return;
    var moved = (DN.horizon.anchorDay(st, t, now) || null) !== day && t.planDate !== day;
    var list = (day === today ? todayTaskList(st, now).open : DN.horizon.byDay(st, [day], now)[0].tasks).map(function (x) { return x.id; }).filter(function (id) { return id !== taskId; });
    var idx = beforeId ? list.indexOf(beforeId) : afterId ? list.indexOf(afterId) + 1 : list.length;
    if (idx < 0) idx = list.length;
    list.splice(idx, 0, taskId);
    S.mutate(moved ? '할 날 정하기' : '할 일 순서 바꾸기', function (s) {
      if (moved) M.updateTask(s, taskId, { planDate: day }, now);
      list.forEach(function (id, i) { var x = M.byId(s.tasks, id); if (x) x.sortOrder = (i + 1) * 10; });
    });
    if (!moved) return;
    var rel = D.relDay(day, now), left = DN.horizon.leftText(day, now);
    var note = t.dueDate && day > t.dueDate ? ' — 마감(' + D.relDay(t.dueDate, now) + ')보다 늦어요' : t.status === 'in_progress' ? ' — 진행 중이라 오늘 목록에도 남아요' : '';
    ui.undoToast('‘' + t.title + '’ ' + (rel === '오늘' ? '오늘 할게요' : rel + '에 할게요' + (left && left !== rel ? ' (' + left + ')' : '')) + note + '.');
  }
  // 끌어 놓을 수 있는 날 — 할 일을 놓으면 그날을 할 날로, 메모를 놓으면 AI 로 할 일로 정리해 그날 할 일로
  function dropDay(el, day, opts) {
    opts = opts || {};
    function has(e, t) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], t) !== -1; }
    function isTask(e) { return has(e, 'application/x-daynote-task'); }
    function isNote(e) { return has(e, 'application/x-daynote-note'); }
    function isStep(e) { return has(e, 'application/x-daynote-step'); }
    function same(e) { return isTask(e) && dragFromDay === day && opts.ownSort; }
    function nestAt(e) { return opts.zone && (isTask(e) || isStep(e)) ? nestRowAt(taskRowsIn(el), e.clientY, dragTaskId) : null; }
    function splitting(e) { return isTask(e) && e.ctrlKey; }
    el.addEventListener('dragover', function (e) {
      if ((!isTask(e) && !isNote(e) && !isStep(e)) || same(e)) return;
      e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = splitting(e) ? 'copy' : 'move';
      el.classList.add('is-drop'); el.classList.toggle('is-note-drop', isNote(e)); el.classList.toggle('is-split-drop', splitting(e));
      // 날 묶음이면 할 일 사이 어디에 넣을지 선으로 — 할 일 줄 가운데면 그 할 일 안으로(세부 할 일로). Ctrl 이면 나눠서 놓기
      var nest = splitting(e) ? null : nestAt(e);
      if (nest) showNest(el, nest);
      else if (opts.zone && (isTask(e) || isStep(e))) { clearNest(el); dropLineAt(el, taskRowsIn(el), e.clientY, 'data-task-id'); markSplit(el, splitting(e)); }
    });
    el.addEventListener('dragleave', function (e) { if (!el.contains(e.relatedTarget)) { el.classList.remove('is-drop', 'is-note-drop', 'is-split-drop'); clearLine(el); } });
    el.addEventListener('drop', function (e) {
      if ((!isTask(e) && !isNote(e) && !isStep(e)) || same(e)) return;
      e.preventDefault(); e.stopPropagation(); el.classList.remove('is-drop', 'is-note-drop', 'is-split-drop');
      dragFromDay = null;
      if (splitting(e)) {
        var spp = opts.zone ? dropLineAt(el, taskRowsIn(el), e.clientY, 'data-task-id') : { beforeId: null, afterId: null };
        clearLine(el);
        splitTask(e.dataTransfer.getData('application/x-daynote-task'), day, spp.beforeId, spp.afterId);
        return;
      }
      var nest = nestAt(e);
      if (nest) { clearLine(el); nestInto(nest.getAttribute('data-task-id'), isTask(e) ? e.dataTransfer.getData('application/x-daynote-task') : null, isStep(e) ? stepData(e) : null); return; }
      if (isStep(e)) {
        var sp = opts.zone ? dropLineAt(el, taskRowsIn(el), e.clientY, 'data-task-id') : { beforeId: null, afterId: null };
        clearLine(el);
        var d = stepData(e);
        if (d) stepToTask(d, day, sp.beforeId, sp.afterId);
        return;
      }
      if (isNote(e)) { clearLine(el); DN.app.memoToTask(e.dataTransfer.getData('application/x-daynote-note'), { planDate: day }); return; }
      var tid = e.dataTransfer.getData('application/x-daynote-task');
      if (opts.zone) {
        var p = dropLineAt(el, taskRowsIn(el), e.clientY, 'data-task-id');
        clearLine(el);
        placeInDay(tid, day, p.beforeId, p.afterId);
        return;
      }
      setPlan(tid, day);
    });
    return el;
  }
  // 앞으로 2주 띠 — 날마다 할 일·일정 수, 바쁜 날 표시. 누르면 그날, 할 일을 끌어 놓으면 그날 할 일로
  //   주말도 같은 색으로 이어 그린다 (한 묶음으로 보이면 더 일찍 시작한다 — Tu & Soman 2014)
  // 2주 띠 보이기 — prefs.homeStrip: 'show' | 'hide' | 없음(창 높이 760px 이상이면 보임)
  function stripShown(st) {
    var p = st.prefs.homeStrip;
    return p === 'show' ? true : p === 'hide' ? false : window.innerHeight >= 760;
  }
  function stripToggle(st) {
    var shown = stripShown(st);
    return h('button.hz-strip-toggle' + (shown ? '.is-on' : ''), { type: 'button', 'aria-pressed': String(shown), title: shown ? '2주 띠 접기' : '앞으로 2주 띠 펼치기',
      onclick: function () { S.mutate(null, function (s) { s.prefs.homeStrip = shown ? 'hide' : 'show'; }); } }, ui.icon('calendar'), '2주');
  }
  function dayStrip(st, now, view) {
    var hz = DN.horizon, today = D.ymd(now);
    var shown = {};
    hz.days(view === 'today' ? 'today+' : view, now).forEach(function (d) { shown[d] = true; });
    var WD = ['일', '월', '화', '수', '목', '금', '토'];
    return h('div.hz-strip', { role: 'list', 'aria-label': '앞으로 2주 — 눌러서 그날 보기, 할 일을 끌어 놓으면 그날 할 일로' }, hz.load(st, now, 14).map(function (d, i) {
      var date = D.parseYmd(d.day);
      var busy = d.minutes >= 360;
      var weekStart = date.getDay() === 1 && i > 0;
      var cell = h('button.hz-day' + (d.day === today ? '.is-today' : '') + (shown[d.day] ? '.is-shown' : '') + (busy ? '.is-busy' : '') + (weekStart ? '.is-week' : ''), {
        type: 'button', role: 'listitem',
        title: D.relDay(d.day, now) + ' · ' + hz.leftText(d.day, now) + ' — 할 일 ' + d.tasks + '개' + (d.due ? ' (마감 ' + d.due + ')' : '') + ' · 일정 ' + d.events + '개' + (d.minutes ? ' · 약 ' + D.duration(d.minutes) : ''),
        onclick: function () { setView(d.day <= D.ymd(D.addDays(now, 1)) ? 'today' : 'day:' + d.day); }
      },
        h('span.hz-wd', WD[date.getDay()]),
        h('span.hz-date', String(date.getDate())),
        h('span.hz-dots', { 'aria-hidden': 'true' },
          d.tasks ? h('span.hz-dot.is-task' + (d.due ? '.is-due' : ''), String(d.tasks)) : null,
          d.events ? h('span.hz-dot.is-event', String(d.events)) : null));
      return dropDay(cell, d.day);
    }));
  }
  // 날짜별 묶음 — 내일 · 이번 주 · 다음 주 · 하루
  function rangeSection(st, now, view) {
    var A = DN.app, hz = DN.horizon;
    var groups = hz.byDay(st, hz.days(view, now), now);
    var total = groups.reduce(function (a, g) { return a + g.tasks.length; }, 0);
    var body = groups.map(function (g) {
      var head = h('div.hz-group-head',
        h('b', D.relDay(g.day, now)), h('span.meta', hz.daysLeft(g.day, now) >= 2 ? hz.leftText(g.day, now) : D.shortDay(D.parseYmd(g.day))),
        g.tasks.length || g.events.length ? h('span.meta', [g.tasks.length ? '할 일 ' + g.tasks.length : null, g.events.length ? '일정 ' + g.events.length : null].filter(Boolean).join(' · ')) : null);
      var events = g.events.map(function (b) {
        return h('div.hz-event', h('span.time', D.hm(b.start) + '–' + D.hm(b.end)), h('button.link-btn', { type: 'button', onclick: function () { DN.views.schedule.open({ blockId: b.id }); } }, b.title || '일정'));
      });
      var ul = h('ul.home-list', g.tasks.map(function (t) { return taskRow(st, t, now, false); }));
      return dayZone(h('div.hz-group', head, events, g.tasks.length ? ul : h('div.hz-empty.meta', g.events.length ? '' : '비어 있어요 — 할 일을 여기로 끌어 놓으면 이날 할 일로')), g.day);
    });
    return h('div.home-sec.home-sec-tasks.is-range',
      h('div.home-sec-head', h('h2', '할 일 · 일정'), h('span.meta', total ? total + '개' : ''),
        h('button.btn.btn-ghost.btn-xs', { type: 'button', onclick: function () { A.go('calendar'); } }, '캘린더')),   // '오늘로' 는 위 [오늘] 탭과 같아서 뺐다
      h('div.home-scroll', { 'data-keep-scroll': 'home-range' }, body));
  }
  // 한 줄 요약 — "다가오는 마감 3 · 날짜 안 정한 할 일 1". 누르면 그 목록만 펼친다 (할 일 목록 자리를 지키려고)
  var alertOpen = null;   // 'up' | 'undated' | null
  function alertsLine(st, now, openToday) {
    var r = DN.habits && DN.habits.estimateRatio(st);
    var up = DN.horizon.upcoming(st, now, 7, openToday.map(function (t) { return t.id; }), r && r.ratio);
    var undated = undatedList(st, now, openToday);
    if (!up.length && !undated.length) return null;
    var prep = up.filter(function (u) { return u.prep; }).length;
    function chip(key, label, count, warn) {
      if (!count) return null;
      var on = alertOpen === key;
      return h('button.hz-alert' + (on ? '.is-on' : '') + (warn ? '.is-warn' : ''), { type: 'button', 'aria-expanded': String(on),
        onclick: function () { alertOpen = on ? null : key; listsOnly(); } }, label, h('b', String(count)), ui.icon(on ? 'chevronDown' : 'chevronRight'));
    }
    return h('div.hz-alerts',
      h('div.hz-alerts-row',
        chip('up', prep ? '지금 시작할 마감' : '다가오는 마감', up.length, !!prep),
        chip('undated', '날짜 안 정한 할 일', undated.length)),
      alertOpen === 'up' && up.length ? upcomingLine(st, now, openToday) : null,
      alertOpen === 'undated' && undated.length ? h('div.hz-undated', h('div.hz-undated-head', h('span.meta', '위 날짜 띠로 끌어 놓으면 그날 할 일이 돼요')),
        h('ul.home-list', undated.slice(0, 12).map(function (t) { return taskRow(st, t, now, false); }))) : null);
  }
  function undatedList(st, now, openToday) {
    var on = {};
    openToday.forEach(function (t) { on[t.id] = true; });
    return M.liveTasks(st).filter(function (t) {
      return t.status !== 'done' && t.status !== 'waiting' && !on[t.id] && !DN.horizon.anchorDay(st, t, now);
    }).sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
  }

  // 날짜 안 정한 할 일 — 마감·할 날·작업 시간이 없고 오늘 목록에도 없는 일. 그냥 두면 홈 어디에도 안 보여 잊힌다
  //   [보기] 를 누르면 펼쳐지고, 위의 2주 띠 날짜로 끌어 놓으면 그날 할 일이 된다
  // 다가오는 마감 — 오늘 목록에 없는 7일 안의 마감을 '며칠 후' 로. 늦어도 시작할 날이 온 일은 먼저 + [오늘 하기]
  function upcomingLine(st, now, openToday) {
    var hz = DN.horizon;
    var r = DN.habits && DN.habits.estimateRatio(st);
    var list = hz.upcoming(st, now, 7, openToday.map(function (t) { return t.id; }), r && r.ratio).slice(0, 3);
    if (!list.length) return null;
    return h('div.hz-upcoming', h('span.hz-up-label', '다가오는 마감'),
      list.map(function (u) {
        return h('span.hz-up' + (u.prep ? '.is-prep' : ''), { title: u.prep ? '예상 시간으로 거꾸로 세면 지금 시작해야 해요' : '' },
          h('button.link-btn', { type: 'button', onclick: function () { setView(u.left <= 1 ? 'today' : 'week'); } }, u.task.title),
          h('span.meta', ' ' + hz.leftText(u.task.dueDate, now) + (u.prep ? ' · 지금 시작해야 해요' : u.startBy && u.startBy < u.task.dueDate ? ' · 늦어도 ' + D.relDay(u.startBy, now) + ' 시작' : '')),
          h('button.btn.btn-xs.btn-ghost', { type: 'button', title: '오늘 할 일로 가져오기', onclick: function () { setPlan(u.task.id, D.ymd(now)); } }, '오늘 하기'));
      }),
      h('button.link-btn.hz-up-more', { type: 'button', onclick: function () { setView('week'); } }, '이번 주 보기'));
  }

  // ------------------------------------------------------------------ 비우기 · 보관함 팝업
  var memoSel = {};
  function clearDone(list) {
    var ids = list.map(function (t) { return t.id; });
    S.mutate('완료한 할 일 비우기', function (s) { ids.forEach(function (id) { var t = M.byId(s.tasks, id); if (t) t.homeClearedAt = DN.app.now().toISOString(); }); });
    ui.undoToast('끝낸 할 일 ' + ids.length + '개를 목록에서 치웠어요. 보관함에서 다시 볼 수 있어요.');
  }
  function shelve(ids) {
    if (!ids.length) return;
    S.mutate('메모 비우기', function (s) {
      ids.forEach(function (id) { var n = M.byId(s.notes, id); if (n) { n.homeHiddenAt = DN.app.now().toISOString(); n.homePinnedAt = null; } });
    });
    ids.forEach(function (id) { delete memoSel[id]; });
    ui.undoToast('메모 ' + ids.length + '개를 보관함에 넣었어요. 홈에서는 안 보여요.');
  }
  // 보관함 — [보관함] 을 누르면 화면 아래에 작은 폴더 줄 (메모를 끌 때 뜨는 것과 같은 모양)
  //   미분류 · 프로젝트 · 비운 완료 할 일 · 휴지통. 폴더를 누르면 그 안의 목록 창
  function shelfFolderOf(n) { var p = n.projectId && M.byId(S.state.projects, n.projectId); return p && !p.deletedAt ? p.id : null; }
  function shelfOnHome() { var on = {}; todayMemoList(S.state, DN.app.now()).forEach(function (n) { on[n.id] = true; }); return on; }
  function shelfArchived(onHome) { return M.liveNotes(S.state).filter(function (n) { return n.captureRole !== 'task_source' && !onHome[n.id]; }); }
  function shelfCleared() { return M.liveTasks(S.state).filter(function (t) { return t.status === 'done' && t.homeClearedAt; }); }
  function shelfTrash() { return S.state.notes.filter(function (n) { return n.deletedAt && !n.sample; }); }
  var shelfDockEl = null;
  function closeShelfDock() {
    if (!shelfDockEl) return;
    shelfDockEl.remove(); shelfDockEl = null;
    document.removeEventListener('mousedown', onShelfDown, true);
    document.removeEventListener('keydown', onShelfKey, true);
  }
  function onShelfDown(e) { if (shelfDockEl && !shelfDockEl.contains(e.target) && !(e.target.closest && e.target.closest('.shelf-open-btn'))) closeShelfDock(); }
  function onShelfKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closeShelfDock(); } }
  function shelfDock() {
    if (shelfDockEl) { closeShelfDock(); return; }
    var onHome = shelfOnHome(), all = shelfArchived(onHome);
    function count(pid) { return all.filter(function (n) { return shelfFolderOf(n) === pid; }).length; }
    function tile(cls, label, iconEl, cnt, open) {
      return h('button.dock-tile.shelf-dock-tile' + cls, { type: 'button', title: '‘' + label + '’ 열기', onclick: function () { closeShelfDock(); open(); } },
        h('div.dock-icon', iconEl), h('div.dock-name', label), h('div.shelf-dock-count', { title: cnt + '개' }, String(cnt)));
    }
    var projects = M.liveProjects(S.state).filter(function (p) { return !p.archivedAt || count(p.id); });
    var tiles = [tile('.is-none', '미분류', ui.folderIcon(ui.UNFILED_COLOR), count(null), function () { shelfPopup({ tab: 'memo', folder: null }); })]
      .concat(projects.map(function (p) { return tile('', p.name, ui.folderIcon(p.color), count(p.id), function () { shelfPopup({ tab: 'memo', folder: p.id }); }); }));
    tiles.push(tile('.is-done-folder', '비운 완료 할 일', h('span.shelf-done-icon', ui.icon('check')), shelfCleared().length, function () { shelfPopup({ tab: 'done' }); }));
    tiles.push(tile('.is-trash', '휴지통', h('span.dock-trash', ui.icon('trash')), shelfTrash().length, function () { shelfPopup({ tab: 'trash' }); }));
    shelfDockEl = h('div.note-dock.shelf-dock', { role: 'dialog', 'aria-label': '보관함 — 폴더를 고르세요' },
      h('div.shelf-dock-head', h('div.dock-hint', '보관함 — 폴더를 누르면 그 안을 봐요'),
        h('button.icon-btn.shelf-dock-x', { type: 'button', 'aria-label': '닫기', onclick: closeShelfDock }, ui.icon('x'))),
      h('div.dock-row', tiles));
    document.body.appendChild(shelfDockEl);
    setTimeout(function () {
      document.addEventListener('mousedown', onShelfDown, true);
      document.addEventListener('keydown', onShelfKey, true);
      var first = shelfDockEl && shelfDockEl.querySelector('.dock-tile'); if (first) first.focus();
    }, 0);
  }
  // 폴더 안 목록 창 — start: { tab: 'memo', folder } · { tab: 'done' } · { tab: 'trash' }. [← 폴더] 는 아래 폴더 줄로
  function shelfPopup(start) {
    start = start || { tab: 'memo', folder: null };
    var now = DN.app.now();
    var onHome = shelfOnHome();
    var q = '';
    var tab = start.tab, folder = start.folder || null;
    var listBox = h('div.shelf-list');
    var search = h('input.input.shelf-search', { type: 'search', placeholder: '찾기', 'aria-label': '보관함에서 찾기',
      oninput: function () { q = search.value.trim().toLowerCase(); draw(); } });
    var tabs = h('div.shelf-tabs', h('button.btn.btn-ghost.btn-xs.shelf-back', { type: 'button', onclick: function () { m.close(); shelfDock(); } }, ui.icon('chevronLeft'), '폴더'));
    var trashBtn = h('button.btn.btn-sm.btn-danger', { type: 'button', hidden: true, onclick: emptyTrash });
    function match(text) { return !q || String(text || '').toLowerCase().indexOf(q) !== -1; }
    function memos() {
      return shelfArchived(onHome).filter(function (n) { return shelfFolderOf(n) === folder && match((n.title || '') + ' ' + (n.body || '')); })
        .sort(function (a, b) { var x = a.homeHiddenAt || a.createdAt, y = b.homeHiddenAt || b.createdAt; return x < y ? 1 : -1; }).slice(0, 80);
    }
    function title() {
      if (tab === 'done') return '보관함 · 비운 완료 할 일';
      if (tab === 'trash') return '보관함 · 휴지통';
      var fp = folder && M.byId(S.state.projects, folder);
      return '보관함 · ' + (fp ? fp.name : '미분류');
    }
    function emptyTrash() {
      var list = shelfTrash();
      if (!list.length) return;
      ui.confirm('휴지통 비우기', '휴지통의 메모 ' + list.length + '개를 완전히 지워요. (바로 뒤 Ctrl+Z 로는 되돌릴 수 있어요)', '비우기').then(function (ok) {
        if (!ok) return;
        var ids = {}; list.forEach(function (n) { ids[n.id] = true; });
        S.mutate('휴지통 비우기', function (s) { s.notes = s.notes.filter(function (n) { return !ids[n.id]; }); });
        ui.undoToast('휴지통을 비웠어요 — 메모 ' + list.length + '개.');
        draw();
      });
    }
    function noteRow(n, buttons) {
      var body = (n.body || '').replace(/\s+/g, ' ').trim();
      var proj = n.projectId && M.byId(S.state.projects, n.projectId);
      var when = n.deletedAt ? '버린 날 ' + D.relDay(D.ymd(n.deletedAt), now) : n.homeHiddenAt ? '비운 날 ' + D.relDay(D.ymd(n.homeHiddenAt), now) : '적은 날 ' + D.relDay(D.ymd(n.createdAt), now);
      return h('div.shelf-row',
        h('div.shelf-main',
          h('div.shelf-title', M.noteTitle(n)),
          body && body !== M.noteTitle(n) ? h('div.shelf-preview', body.slice(0, 100)) : null,
          h('div.shelf-meta.meta', when, proj ? h('span.chip.chip-project', { style: { '--pc': proj.color } }, proj.name) : null)),
        buttons);
    }
    function draw() {
      var t = m && m.box.querySelector('.modal-head h2'); if (t) t.textContent = title();
      listBox.textContent = '';
      trashBtn.hidden = tab !== 'trash';
      if (tab === 'memo') {
        var list = memos();
        if (!list.length) { listBox.appendChild(h('div.empty', q ? '찾는 메모가 없어요.' : '이 폴더는 비어 있어요.')); return; }
        list.forEach(function (n) {
          listBox.appendChild(noteRow(n, [
            h('button.btn.btn-xs', { type: 'button', onclick: function () {
              S.mutate('메모 홈으로', function (s) { var x = M.byId(s.notes, n.id); if (x) { x.homeHiddenAt = null; x.homePinnedAt = DN.app.now().toISOString(); } });
              onHome[n.id] = true;
              ui.toast('‘' + M.noteTitle(n) + '’를 홈으로 불러왔어요.');
              draw();
            } }, '홈으로'),
            h('button.icon-btn', { type: 'button', title: '메모 열기', 'aria-label': '‘' + M.noteTitle(n) + '’ 열기', onclick: function () { m.close(); DN.app.openNote(n.id); } }, ui.icon('chevronRight'))]));
        });
      } else if (tab === 'trash') {
        var tr = shelfTrash().filter(function (n) { return match((n.title || '') + ' ' + (n.body || '')); }).sort(function (a, b) { return a.deletedAt < b.deletedAt ? 1 : -1; });
        trashBtn.textContent = '휴지통 비우기 (' + shelfTrash().length + ')';
        trashBtn.disabled = !shelfTrash().length;
        if (!tr.length) { listBox.appendChild(h('div.empty', q ? '찾는 메모가 없어요.' : '휴지통이 비어 있어요.')); return; }
        tr.forEach(function (n) {
          listBox.appendChild(noteRow(n, h('button.btn.btn-xs', { type: 'button', onclick: function () {
            S.mutate('메모 되살리기', function (s) { var x = M.byId(s.notes, n.id); if (x) { x.deletedAt = null; x.homeHiddenAt = x.homeHiddenAt || DN.app.now().toISOString(); } });
            ui.toast('‘' + M.noteTitle(n) + '’를 되살렸어요 — 원래 폴더에 있어요.');
            draw();
          } }, '되살리기')));
        });
      } else {
        var done = shelfCleared().filter(function (x) { return match(x.title); }).sort(function (a, b) { return a.homeClearedAt < b.homeClearedAt ? 1 : -1; }).slice(0, 80);
        if (!done.length) { listBox.appendChild(h('div.empty', '비운 완료 할 일이 없어요.')); return; }
        done.forEach(function (x) {
          listBox.appendChild(h('div.shelf-row',
            h('div.shelf-main', h('div.shelf-title.is-done', x.title), h('div.shelf-meta.meta', '끝낸 날 ' + D.relDay(D.ymd(x.completedAt), now))),
            h('button.btn.btn-xs', { type: 'button', title: '오늘 끝낸 일이면 오늘 목록에 다시 보여요', onclick: function () {
              S.mutate('완료 할 일 다시 보이기', function (s) { var y = M.byId(s.tasks, x.id); if (y) y.homeClearedAt = null; });
              ui.toast('‘' + x.title + '’를 다시 보이게 했어요.');
              draw();
            } }, '홈으로')));
        });
      }
    }
    var m = null;
    draw();
    m = ui.modal({ title: title(), wide: true,
      body: h('div.shelf', h('div.shelf-top', tabs, search), listBox),
      footLeft: [trashBtn, h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: function () { m.close(); DN.app.go('archive'); } }, '보관함 화면에서 보기')],
      actions: [{ label: '닫기', primary: true }] });
    draw();
  }

  function memoRow(st, n, now) {
    var A = DN.app;
    var proj = n.projectId && M.byId(st.projects, n.projectId);
    var made = M.tasksForNote(st, n.id).length;
    var c = n.capture || {};
    var kind = ui.KIND_LABEL[n.kind] && (n.kind === 'idea' || n.kind === 'link') ? n.kind : 'memo';
    var link = kind === 'link' ? firstLink(n) : null;
    var body = (n.body || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    var title = M.noteTitle(n);
    var preview = (body[0] && (body[0] === title || body[0].indexOf(title) === 0) ? body.slice(1) : body).join(' ');
    return h('li.home-row.home-memo', {
      'data-id': n.id, 'data-note-id': n.id, 'data-kind': kind, draggable: 'true', tabindex: '0', title: '끌어서 할 일 목록에 놓으면 할 일로 정리해요',
      onclick: function () { A.openNote(n.id); },
      onkeydown: function (e) { if (e.target === e.currentTarget && e.key === 'Enter') { e.preventDefault(); A.openNote(n.id); } }
    },
      h('span.drag-handle', { 'aria-hidden': 'true', title: '끌어서 순서 바꾸기' }, '⋮⋮'),
      h('input.check', { type: 'checkbox', checked: !!memoSel[n.id], 'aria-label': '‘' + M.noteTitle(n) + '’ 비울 메모로 고르기', title: '체크한 메모는 [체크한 메모 비우기] 로 보관함에 넣어요',
        onclick: function (e) { e.stopPropagation(); },
        onchange: function (e) { if (e.currentTarget.checked) memoSel[n.id] = true; else delete memoSel[n.id]; listsOnly(); } }),
      h('div.home-main',
        h('div.home-row-title', M.noteTitle(n)),
        preview ? h('div.home-preview', preview.slice(0, 120)) : null,
        h('div.home-meta',
          c.status === 'pending' ? h('span.chip', h('span.spinner', { 'aria-hidden': 'true' }), ' 정리 중') : ui.kindChip(kind),
          // 링크는 앱 밖(기본 브라우저)에서 연다 — 메인 프로세스가 새 창 요청을 브라우저로 넘긴다
          link ? h('a.home-link', { href: link.url, target: '_blank', rel: 'noopener noreferrer', title: link.url, draggable: 'false',
            onclick: function (e) { e.stopPropagation(); }, onkeydown: function (e) { e.stopPropagation(); } }, ui.icon('link'), link.host) : null,
          h('span.meta', D.hm(c.at || n.createdAt)),
          made ? h('span.chip', '할 일 ' + made + '개') : null,
          ui.noteProjectChip(st, n))));   // 눌러서 프로젝트 고르기 (할 일과 같은 칩)
  }

  // ------------------------------------------------------------------ 좌우 비율 (채팅 | 오늘 패널)
  // 막대를 끌면 채팅 쪽 비율이 바뀐다. 끄는 동안은 화면만 바꾸고 놓을 때 한 번 저장(prefs.homeCols).
  // ←/→ 5%씩, 더블클릭·Enter 는 반반으로. 양쪽 모두 최소 320px.
  function defaultCols() { var w = window.innerWidth; return w < 1150 ? 0.4 : w < 1350 ? 0.44 : DN.split.COL_DEFAULT; }
  function applyCols(home, r) {
    var SP = DN.split;
    r = typeof r === 'number' ? r : defaultCols();
    home.style.gridTemplateColumns = 'minmax(' + SP.COL_MIN_PX + 'px, ' + r + 'fr) 16px minmax(' + SP.COL_MIN_PX + 'px, ' + (1 - r) + 'fr)';
    var bar = home.querySelector('.home-colbar');
    if (bar) {
      bar.setAttribute('aria-valuenow', String(Math.round(r * 100)));
      bar.setAttribute('aria-valuetext', '채팅 ' + Math.round(r * 100) + '%, 오늘 ' + (100 - Math.round(r * 100)) + '%');
    }
  }
  function colBar() {
    var SP = DN.split;
    var drag = null;
    function homeEl() { return el.parentNode; }
    function width() { var hm = homeEl(); var cs = getComputedStyle(hm); return hm.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 16; }
    function current() { var r = S.state.prefs.homeCols; return typeof r === 'number' ? r : SP.COL_DEFAULT; }
    function save(r) {
      r = SP.clampCol(r, width());
      S.mutate(null, function (s) { if (Math.abs(r - SP.COL_DEFAULT) < 1e-3) delete s.prefs.homeCols; else s.prefs.homeCols = r; }, { silent: true });
      applyCols(homeEl(), r);
    }
    function finish() {
      if (!drag) return;
      var r = drag.last; drag = null;
      el.classList.remove('is-dragging');
      document.documentElement.classList.remove('is-col-resizing');
      if (r != null) save(r);
    }
    var el = h('div.home-colbar', {
      role: 'separator', 'aria-orientation': 'vertical', tabindex: '0', 'aria-valuemin': '0', 'aria-valuemax': '100',
      'aria-label': '채팅과 오늘 패널 너비 조정', title: '끌어서 너비 조정 · ←/→ 5%씩 · 더블클릭: 반반',
      onpointerdown: function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        var hm = homeEl(), rect = hm.getBoundingClientRect(), cs = getComputedStyle(hm);
        drag = { left: rect.left + parseFloat(cs.paddingLeft), total: width(), last: null };
        try { el.setPointerCapture(e.pointerId); } catch (x) {}
        el.classList.add('is-dragging');
        document.documentElement.classList.add('is-col-resizing');
      },
      onpointermove: function (e) {
        if (!drag) return;
        drag.last = SP.clampCol((e.clientX - drag.left - 8) / drag.total, drag.total);
        applyCols(homeEl(), drag.last);
      },
      onpointerup: finish, onpointercancel: finish, onlostpointercapture: finish,
      ondblclick: function () { save(SP.COL_DEFAULT); },
      onkeydown: function (e) {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); save(current() + (e.key === 'ArrowLeft' ? -0.05 : 0.05)); }
        else if (e.key === 'Enter') { e.preventDefault(); save(SP.COL_DEFAULT); }
      }
    });
    return el;
  }

  // ------------------------------------------------------------------ 끌어 놓아 순서 바꾸기 (+ Alt+↑/↓)
  function sortable(ul, ids, commit) {
    var dragId = null;
    function rows() { return Array.prototype.slice.call(ul.querySelectorAll('li[data-id]')); }
    function clearMarks() { rows().forEach(function (r) { r.classList.remove('drop-before', 'drop-after', 'is-dragging'); }); clearLine(ul); }
    function others() { return rows().filter(function (r) { return r.getAttribute('data-id') !== dragId; }); }
    function move(id, targetId, after) {
      var order = ids.filter(function (x) { return x !== id; });
      var i = order.indexOf(targetId);
      if (i < 0) return;
      order.splice(after ? i + 1 : i, 0, id);
      if (order.join() !== ids.join()) commit(order);
    }
    ul.addEventListener('dragstart', function (e) {
      var li = e.target.closest && e.target.closest('li[data-id]');
      if (!li) return;
      dragId = li.getAttribute('data-id');
      li.classList.add('is-dragging');
      // 할 일은 채팅(작업 공간)으로도 끌어 놓을 수 있다
      var tid = li.getAttribute('data-task-id');
      e.dataTransfer.effectAllowed = tid ? 'copyMove' : 'move';
      e.dataTransfer.setData('text/plain', dragId);
      if (tid) e.dataTransfer.setData('application/x-daynote-task', tid);
      // 메모는 할 일 목록으로 끌어 놓으면 할 일이 된다
      var nid = li.getAttribute('data-note-id');
      if (nid) { e.dataTransfer.effectAllowed = 'copyMove'; e.dataTransfer.setData('application/x-daynote-note', nid); }
    });
    function nestOk() { return dragId && others().some(function (r) { return r.getAttribute('data-task-id'); }) && M.byId(S.state.tasks, dragId); }
    ul.addEventListener('dragover', function (e) {
      if (!dragId) return;
      e.preventDefault();
      var split = e.ctrlKey && M.byId(S.state.tasks, dragId);
      if (e.dataTransfer) e.dataTransfer.dropEffect = split ? 'copy' : 'move';
      var nest = !split && nestOk() ? nestRowAt(others(), e.clientY, dragId) : null;
      if (nest) showNest(ul, nest);
      else { clearNest(ul); dropLineAt(ul, others(), e.clientY, 'data-id'); markSplit(ul, split); }
    });
    ul.addEventListener('drop', function (e) {
      if (!dragId) return;
      e.preventDefault();
      var split = e.ctrlKey && M.byId(S.state.tasks, dragId);
      var nest = !split && nestOk() ? nestRowAt(others(), e.clientY, dragId) : null;
      var p = nest ? null : dropLineAt(ul, others(), e.clientY, 'data-id');
      var id = dragId; dragId = null;
      clearMarks();
      if (split) { e.stopPropagation(); splitTask(id, D.ymd(DN.app.now()), p.beforeId, p.afterId); return; }
      if (nest) { e.stopPropagation(); nestInto(nest.getAttribute('data-task-id'), id, null); return; }
      if (p.beforeId) move(id, p.beforeId, false);
      else if (p.afterId) move(id, p.afterId, true);
    });
    ul.addEventListener('dragend', function () { dragId = null; clearMarks(); });
    ul.addEventListener('keydown', function (e) {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      var li = e.target.closest && e.target.closest('li[data-id]');
      if (!li || li !== e.target) return;
      e.preventDefault();
      var id = li.getAttribute('data-id');
      var i = ids.indexOf(id), j = e.key === 'ArrowUp' ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= ids.length) return;
      move(id, ids[j], e.key === 'ArrowDown');
      setTimeout(function () { var x = document.querySelector('li[data-id="' + id + '"]'); if (x) x.focus(); }, 0);
    });
  }

  // ------------------------------------------------------------------ 오늘 일정
  function agenda(st, now) {
    var A = DN.app;
    var today = D.ymd(now), nowIso = now.toISOString();
    var list = st.blocks.filter(function (b) {
      if (D.ymd(b.start) !== today) return false;
      var t = b.taskId && M.byId(st.tasks, b.taskId);
      return !(t && t.deletedAt);
    }).sort(function (a, b) { return a.start < b.start ? -1 : 1; });
    var allDay = DN.calsync ? DN.calsync.allDayOn(st, today) : [];
    // 오늘 패널의 맨 아래 칸 (할 일 · 메모 · 일정)
    return h('div.home-sec.home-sec-agenda', { 'aria-labelledby': 'agenda-title' },
      h('div.home-sec-head', h('h2#agenda-title', '오늘 일정'), h('span.meta', list.length ? list.length + '개' : ''),
        h('button.btn.btn-ghost.btn-xs', { type: 'button', onclick: function () {
          DN.views.schedule.open({ event: true, start: DN.views.schedule.findFreeSlot(S.state, A.now(), 60) });
        } }, ui.icon('plus'), '일정 추가'),
        h('button.btn.btn-ghost.btn-xs', { type: 'button', onclick: function () { A.go('calendar'); } }, '캘린더')),
      h('div.home-scroll', { 'data-keep-scroll': 'home-agenda' },
        allDay.length ? h('div.agenda-allday', { title: '외부 캘린더의 종일 일정' }, ui.icon('calendar'), h('span', '종일 · ' + allDay.map(function (x) { return x.title; }).join(', '))) : null,
        list.length ? list.map(function (b) {
          var t = b.taskId && M.byId(st.tasks, b.taskId);
          var conflict = M.conflictsFor(st, b.start, b.end, b.id).length > 0;
          var cls = '.agenda-item' + (b.kind === 'work' ? '.is-work' : '') + (b.origin === 'ics' ? '.is-ext' : '') + (b.start <= nowIso && b.end > nowIso ? '.is-now' : '') + (b.end <= nowIso ? '.is-past' : '');
          return h('div' + cls,
            h('span.time', D.hm(b.start) + '–' + D.hm(b.end)),
            h('span.t', h('button.link-btn', { type: 'button', style: { color: 'inherit', textDecoration: t && t.status === 'done' ? 'line-through' : 'none' },
              onclick: function () { if (t) DN.assistant.work(t.id); else DN.views.schedule.open({ blockId: b.id }); } }, t ? t.title : (b.title || '일정')),
              conflict ? h('span.meta', { style: { color: 'var(--warning)', marginLeft: '6px' } }, '· 겹침') : null));
        }) : allDay.length ? null : h('div.empty.home-empty', '오늘 잡힌 일정이 없어요.')));
  }

  DN.views.today = { title: '오늘', render: render, todayTaskList: todayTaskList, todayMemoList: todayMemoList };
})();
