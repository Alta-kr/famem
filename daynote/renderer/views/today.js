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
    // 창 크기가 바뀌면 다시 그린다 — 2주 띠 자동 접기·채팅 칸 기본 폭이 창 크기를 따른다
    var resizeT = null;
    function onResize() { clearTimeout(resizeT); resizeT = setTimeout(function () { if (S.state.prefs.homeCols == null) applyCols(home, null); paint(); }, 150); }
    window.addEventListener('resize', onResize);
    // 막대를 끄는 중에는 다시 그리지 않는다 — 끝나면 한 번만 그린다
    splitDrag.repaint = function () { chat.refresh(); paint(); };

    return {
      destroy: function () { window.removeEventListener('resize', onResize); clearTimeout(resizeT); root.style.overflow = ''; splitDrag.repaint = null; splitDrag.pending = false; if (chat.destroy) chat.destroy(); },
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
        dayZone(h('div.hz-today-zone', tl.open.length || tl.done.length ? taskUl : h('div.empty.home-empty' + (tmr.tasks.length ? '.is-compact' : ''), '오늘 할 일이 없어요. 왼쪽에 적으면 할 일은 여기로 들어와요.')), D.ymd(now)),
        tomorrowGroup(st, now, tmr, sel)));
    var secMemos = h('div.home-sec.home-sec-memos',
      h('div.home-sec-head', h('h2', '메모'), h('span.meta', memos.length ? memos.length + '개' : ''),
        selCount ? h('button.btn.btn-ghost.btn-xs.is-on', { type: 'button', onclick: function () { shelve(Object.keys(memoSel)); } }, '체크한 메모 비우기 (' + selCount + ')') : null,
        memos.length ? h('button.btn.btn-ghost.btn-xs', { type: 'button', title: '홈의 메모를 모두 보관함으로 (지우지 않아요)', onclick: function () { shelve(memos.map(function (n) { return n.id; })); } }, '전체 비우기') : null,
        h('button.btn.btn-ghost.btn-xs', { type: 'button', onclick: function (e) { shelfPopup(e.currentTarget); } }, '보관함')),
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
  function dayZone(el, day) {
    el.addEventListener('dragstart', function (e) { if (e.target.closest && e.target.closest('[data-task-id]')) dragFromDay = day; }, true);
    el.addEventListener('dragend', function () { dragFromDay = null; }, true);
    return dropDay(el, day);
  }
  // 끌어 놓을 수 있는 날 — 할 일을 놓으면 그날을 할 날로, 메모를 놓으면 AI 로 할 일로 정리해 그날 할 일로
  function dropDay(el, day) {
    function has(e, t) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], t) !== -1; }
    function isTask(e) { return has(e, 'application/x-daynote-task'); }
    function isNote(e) { return has(e, 'application/x-daynote-note'); }
    function same(e) { return isTask(e) && dragFromDay === day; }
    el.addEventListener('dragover', function (e) {
      if ((!isTask(e) && !isNote(e)) || same(e)) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      el.classList.add('is-drop'); el.classList.toggle('is-note-drop', isNote(e));
    });
    el.addEventListener('dragleave', function (e) { if (!el.contains(e.relatedTarget)) el.classList.remove('is-drop', 'is-note-drop'); });
    el.addEventListener('drop', function (e) {
      if ((!isTask(e) && !isNote(e)) || same(e)) return;
      e.preventDefault(); e.stopPropagation(); el.classList.remove('is-drop', 'is-note-drop');
      dragFromDay = null;
      if (isNote(e)) { DN.app.memoToTask(e.dataTransfer.getData('application/x-daynote-note'), { planDate: day }); return; }
      setPlan(e.dataTransfer.getData('application/x-daynote-task'), day);
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
        onclick: function () { alertOpen = on ? null : key; DN.app.refresh(); } }, label, h('b', String(count)), ui.icon(on ? 'chevronDown' : 'chevronRight'));
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
  // 보관함 팝업 — 홈에 없는 메모(비운 메모 · 지난 메모)와 비운 완료 할 일. [홈으로] 로 다시 불러온다
  function shelfPopup(anchor) {
    var st = S.state, now = DN.app.now();
    var onHome = {};
    todayMemoList(st, now).forEach(function (n) { onHome[n.id] = true; });
    var q = '';
    var tab = 'memo';
    var listBox = h('div.shelf-list');
    var search = h('input.input.shelf-search', { type: 'search', placeholder: '찾기', 'aria-label': '보관함에서 찾기',
      oninput: function () { q = search.value.trim().toLowerCase(); draw(); } });
    var tabs = h('div.shelf-tabs', { role: 'tablist' });
    function memos() {
      return M.liveNotes(S.state).filter(function (n) { return n.captureRole !== 'task_source' && !onHome[n.id]; })
        .filter(function (n) { return !q || ((n.title || '') + ' ' + (n.body || '')).toLowerCase().indexOf(q) !== -1; })
        .sort(function (a, b) { var x = a.homeHiddenAt || a.createdAt, y = b.homeHiddenAt || b.createdAt; return x < y ? 1 : -1; }).slice(0, 80);
    }
    function cleared() {
      return M.liveTasks(S.state).filter(function (t) { return t.status === 'done' && t.homeClearedAt; })
        .filter(function (t) { return !q || t.title.toLowerCase().indexOf(q) !== -1; })
        .sort(function (a, b) { return a.homeClearedAt < b.homeClearedAt ? 1 : -1; }).slice(0, 80);
    }
    function draw() {
      tabs.textContent = '';
      [['memo', '메모'], ['done', '비운 완료 할 일']].forEach(function (t) {
        tabs.appendChild(h('button.shelf-tab' + (tab === t[0] ? '.is-on' : ''), { type: 'button', role: 'tab', 'aria-selected': String(tab === t[0]),
          onclick: function () { tab = t[0]; draw(); } }, t[1]));
      });
      listBox.textContent = '';
      if (tab === 'memo') {
        var list = memos();
        if (!list.length) { listBox.appendChild(h('div.empty', q ? '찾는 메모가 없어요.' : '보관함이 비어 있어요.')); return; }
        list.forEach(function (n) {
          var body = (n.body || '').replace(/\s+/g, ' ').trim();
          var proj = n.projectId && M.byId(S.state.projects, n.projectId);
          listBox.appendChild(h('div.shelf-row',
            h('div.shelf-main',
              h('div.shelf-title', M.noteTitle(n)),
              body && body !== M.noteTitle(n) ? h('div.shelf-preview', body.slice(0, 100)) : null,
              h('div.shelf-meta.meta', n.homeHiddenAt ? '비운 날 ' + D.relDay(D.ymd(n.homeHiddenAt), now) : '적은 날 ' + D.relDay(D.ymd(n.createdAt), now),
                proj ? h('span.chip.chip-project', { style: { '--pc': proj.color } }, proj.name) : null)),
            h('button.btn.btn-xs', { type: 'button', onclick: function () {
              S.mutate('메모 홈으로', function (s) { var x = M.byId(s.notes, n.id); if (x) { x.homeHiddenAt = null; x.homePinnedAt = DN.app.now().toISOString(); } });
              onHome[n.id] = true;
              ui.toast('‘' + M.noteTitle(n) + '’를 홈으로 불러왔어요.');
              draw();
            } }, '홈으로'),
            h('button.icon-btn', { type: 'button', title: '메모 열기', 'aria-label': '‘' + M.noteTitle(n) + '’ 열기', onclick: function () { m.close(); DN.app.openNote(n.id); } }, ui.icon('chevronRight'))));
        });
      } else {
        var done = cleared();
        if (!done.length) { listBox.appendChild(h('div.empty', '비운 완료 할 일이 없어요.')); return; }
        done.forEach(function (t) {
          listBox.appendChild(h('div.shelf-row',
            h('div.shelf-main', h('div.shelf-title.is-done', t.title), h('div.shelf-meta.meta', '끝낸 날 ' + D.relDay(D.ymd(t.completedAt), now))),
            h('button.btn.btn-xs', { type: 'button', title: '오늘 끝낸 일이면 오늘 목록에 다시 보여요', onclick: function () {
              S.mutate('완료 할 일 다시 보이기', function (s) { var x = M.byId(s.tasks, t.id); if (x) x.homeClearedAt = null; });
              ui.toast('‘' + t.title + '’를 다시 보이게 했어요.');
              draw();
            } }, '홈으로')));
        });
      }
    }
    draw();
    var m = ui.modal({ title: '보관함', wide: true,
      body: h('div.shelf', h('div.shelf-top', tabs, search), listBox),
      footLeft: h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: function () { m.close(); DN.app.go('archive'); } }, '보관함 화면에서 보기'),
      actions: [{ label: '닫기', primary: true }] });
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
        onchange: function (e) { if (e.currentTarget.checked) memoSel[n.id] = true; else delete memoSel[n.id]; DN.app.refresh(); } }),
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
    function clearMarks() { rows().forEach(function (r) { r.classList.remove('drop-before', 'drop-after', 'is-dragging'); }); }
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
    ul.addEventListener('dragover', function (e) {
      if (!dragId) return;
      var li = e.target.closest && e.target.closest('li[data-id]');
      e.preventDefault();
      rows().forEach(function (r) { r.classList.remove('drop-before', 'drop-after'); });
      if (!li || li.getAttribute('data-id') === dragId) return;
      var r = li.getBoundingClientRect();
      li.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
    });
    ul.addEventListener('drop', function (e) {
      if (!dragId) return;
      e.preventDefault();
      var li = e.target.closest && e.target.closest('li[data-id]');
      var id = dragId; dragId = null;
      clearMarks();
      if (!li || li.getAttribute('data-id') === id) return;
      var r = li.getBoundingClientRect();
      move(id, li.getAttribute('data-id'), e.clientY >= r.top + r.height / 2);
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
