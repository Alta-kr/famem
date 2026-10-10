'use strict';

// 홈(오늘) — 세 칸만 둔다.
//   1) 채팅: 적으면 AI 가 메모/할 일로 나누고, 도우미 버튼(다음 할 일·작게 나누기·휴식), 할 일 추천(recpanel.js)
//   2) 오늘: 위는 할 일, 아래는 메모. 끌어 놓아 순서(우선순위)를 바꾼다 — 키보드는 Alt+↑/↓
//   3) 오늘 일정 (Daynote 블록 + Google 일정)
// 현재 상태(DN.status)를 켜면 할 일을 묶음으로 나눈다(DAYNOTE_STATUS_DESIGN.md §9). 켜기 전(view 가 null)에는 지금 마크업 그대로다(I1).

(function () {
  var DN = window.Daynote;
  var M = DN.model, D = DN.dates, S = DN.store, ui = DN.ui, h = ui.h;

  // 모듈 기억 (저장하지 않는다): 뒤로 미룬 일 펼침 · 숨긴 일 펼침 · 잘 시간에 '그래도 보기' · 마지막 바탕 상태
  var mem = { downOpen: true, showHidden: false, sleepOpen: false, baseId: null };
  var repaintToday = null;   // 오늘 화면이 떠 있는 동안만 — chat.refresh + paint

  // 상태 기능 (statusui.js) — 없거나 켜기 전이면 null
  function statusView(now) {
    try { return DN.status && DN.status.view ? DN.status.view(now) : null; } catch (e) { return null; }
  }
  function statusProfile(st) {
    if (DN.status && DN.status.profile) { try { return DN.status.profile(); } catch (e) { /* 아래로 */ } }
    return DN.statusCore && DN.statusCore.profile ? DN.statusCore.profile(st.prefs) : null;
  }
  // 다시 그려도 포커스를 지킨다 (data-focus-key 가 같은 요소로)
  function focusKeyIn(host) {
    var act = document.activeElement;
    return act && host.contains(act) ? act.getAttribute('data-focus-key') : null;
  }
  function refocus(host, key) {
    if (!key) return;
    var el = host.querySelector('[data-focus-key="' + String(key).replace(/"/g, '\\"') + '"]');
    if (el && el.focus) el.focus();
  }

  function render(root) {
    var A = DN.app;
    root.style.overflow = 'hidden';

    var statusBar = h('div.home-status');
    var chatHost = h('div.home-chat');
    var listsHost = h('div.home-lists');
    var home = h('div.home', statusBar, chatHost, listsHost);
    root.appendChild(home);

    var chat = DN.views.chat.render(chatHost);
    // 좁은 화면의 맨 위 고정 줄 — 상태 칩 + 짧은 숨김 수 (넓은 화면에서는 CSS 로 숨는다)
    function paintStatusBar() {
      var fk = focusKeyIn(statusBar);
      statusBar.textContent = '';
      var chip = null;
      try { chip = DN.status && DN.status.chip ? DN.status.chip('bar') : null; } catch (e) { chip = null; }
      if (chip) statusBar.appendChild(chip);
      var sv = chip ? statusView(A.now()) : null;
      if (sv && sv.summary && sv.summary.hidden && DN.statusCore) {
        statusBar.appendChild(h('span.meta.home-status-hidden', DN.statusCore.hiddenSummaryText(sv.summary, statusProfile(S.state), { short: true })));
      }
      home.classList.toggle('has-status', !!chip);
      refocus(statusBar, fk);
    }
    function paint() {
      paintStatusBar();
      var keep = Array.prototype.map.call(listsHost.querySelectorAll('[data-keep-scroll]'), function (e) { return [e.getAttribute('data-keep-scroll'), e.scrollTop]; });
      var act = document.activeElement;
      var focusEdge = act && listsHost.contains(act) ? act.getAttribute('data-split-edge') : null;
      var fk = focusKeyIn(listsHost);
      listsHost.textContent = '';
      listsHost.appendChild(todayLists(S.state, A.now()));
      keep.forEach(function (p) { var e = listsHost.querySelector('[data-keep-scroll="' + p[0] + '"]'); if (e) e.scrollTop = p[1]; });
      if (focusEdge != null) { var bar = listsHost.querySelector('[data-split-edge="' + focusEdge + '"]'); if (bar) bar.focus(); }
      refocus(listsHost, fk);
    }
    paint();
    // 막대를 끄는 중에는 다시 그리지 않는다 — 끝나면 한 번만 그린다
    splitDrag.repaint = function () { chat.refresh(); paint(); };
    repaintToday = function () { chat.refresh(); paint(); };

    return {
      destroy: function () { root.style.overflow = ''; splitDrag.repaint = null; splitDrag.pending = false; repaintToday = null; if (chat.destroy) chat.destroy(); },
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
        if (chat.tick) chat.tick();
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
      if (t.status === 'done') { if (t.completedAt && D.ymd(t.completedAt) === today) done.push(t); return; }
      if (t.status === 'in_progress' || blockToday[t.id] || (t.dueDate && t.dueDate <= today) || D.ymd(t.createdAt) === today) open.push(t);
    });
    function rank(t) {
      if (t.status === 'in_progress') return 0;
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
      if (n.captureRole === 'task_source') return false;
      return D.ymd((n.capture && n.capture.at) || n.createdAt) === today;
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
    var sv = statusView(now);

    var taskBody, openCount;
    if (sv) {
      var grouped = statusTaskBody(st, tl, sv, now, sel);
      taskBody = grouped.body;
      openCount = grouped.count;
    } else {
      // 상태를 켜기 전 — 지금 마크업 그대로 (I1)
      var taskUl = h('ul.home-list', { 'aria-label': '오늘의 할 일 (끌어서 순서 바꾸기, Alt+위/아래)' },
        tl.open.map(function (t) { return taskRow(st, t, now, t.id === sel); }),
        tl.done.map(function (t) { return taskRow(st, t, now, t.id === sel); }));
      sortable(taskUl, tl.open.map(function (t) { return t.id; }), function (ids) {
        S.mutate('할 일 순서 바꾸기', function (s) { ids.forEach(function (id, i) { var t = M.byId(s.tasks, id); if (t) t.sortOrder = (i + 1) * 10; }); });
      });
      taskBody = tl.open.length || tl.done.length ? taskUl : h('div.empty.home-empty', '오늘 할 일이 없어요. 왼쪽에 적으면 할 일은 여기로 들어와요.');
      openCount = tl.open.length;
    }

    var memoUl = h('ul.home-list', { 'aria-label': '오늘 적은 메모 (끌어서 순서 바꾸기, Alt+위/아래)' }, memos.map(function (n) { return memoRow(st, n, now); }));
    sortable(memoUl, memos.map(function (n) { return n.id; }), function (ids) {
      S.mutate('메모 순서 바꾸기', function (s) { ids.forEach(function (id, i) { var n = M.byId(s.notes, id); if (n) n.sortOrder = (i + 1) * 10; }); });
    });

    var secTasks = h('div.home-sec.home-sec-tasks',
      h('div.home-sec-head', h('h2', '할 일'), h('span.meta', openCount ? '남은 ' + openCount + '개' : ''),
        h('button.btn.btn-ghost.btn-xs', { type: 'button', onclick: function () { A.go('tasks'); } }, '전체 보기')),
      h('div.home-scroll', { 'data-keep-scroll': 'home-tasks' }, taskBody));
    var secMemos = h('div.home-sec.home-sec-memos',
      h('div.home-sec-head', h('h2', '메모'), h('span.meta', memos.length ? memos.length + '개' : ''),
        h('button.btn.btn-ghost.btn-xs', { type: 'button', onclick: function () { A.go('archive'); } }, '보관함')),
      h('div.home-scroll', { 'data-keep-scroll': 'home-memos' },
        memos.length ? memoUl : h('div.empty.home-empty', '오늘 적은 메모가 여기에 모여요.')));
    secTasks.id = 'home-sec-tasks';
    secMemos.id = 'home-sec-memos';
    var secs = [secTasks, secMemos, agenda(st, now)];
    secs.bars = [];
    var bar0 = splitter(secs, 0), bar1 = splitter(secs, 1);
    applySplit(secs, st.prefs.homeSplit);
    var headChip = null, nudge = null;
    try { headChip = DN.status && DN.status.chip ? DN.status.chip('head') : null; } catch (e) { headChip = null; }
    try { nudge = DN.status && DN.status.nudgeLine ? DN.status.nudgeLine(now) : null; } catch (e) { nudge = null; }
    return h('section.home-today', { 'aria-label': '오늘' },
      h('div.home-today-head', h('h1.home-title', '오늘'), h('span.meta', D.longDay(now)), headChip),
      nudge,
      secs[0], bar0, secs[1], bar1, secs[2]);
  }

  // ------------------------------------------------------------------ 상태별 묶음 (STATUS §9.3–9.6)
  var WHEN_HEAD = { off: '퇴근하고 하기로 한 일', work: '출근하면 하기로 한 일', out: '나간 김에 할 일', rest: '쉬는 날 하기로 한 일', pause: '쉬는 시간에 하기로 한 일' };

  function ctxChipOf(t) {
    var chip = null;
    try { chip = DN.status && DN.status.contextChip ? DN.status.contextChip(t, { focusKey: 'today-ctx:' + t.id, where: 'today' }) : null; } catch (e) { chip = null; }
    if (!chip) return null;
    // 칩을 눌러도 행(상세 열기)이 같이 눌리지 않게
    return h('span.today-ctx', { onclick: function (e) { e.stopPropagation(); }, onkeydown: function (e) { e.stopPropagation(); } }, chip);
  }

  function statusTaskBody(st, tl, sv, now, sel) {
    var A = DN.app, ST = DN.statusCore, R = DN.recommend;
    var pf = statusProfile(st);
    // 바탕 상태가 바뀌면 펼친 숨김·잘 시간 보기를 다시 접는다
    if (mem.baseId != null && mem.baseId !== sv.id) { mem.showHidden = false; mem.sleepOpen = false; }
    mem.baseId = sv.id;

    var ranked = [];
    try { ranked = R.recommend(st, { now: now, workHours: st.prefs.workHours, statusView: sv }).ranked.map(function (x) { return x.taskId; }); } catch (e) { ranked = []; }
    var part = ST.partitionToday(st, tl.open, sv, { rankedIds: ranked, now: now });
    var task = function (id) { return M.byId(st.tasks, id); };
    var tasksOf = function (ids) { return ids.map(task).filter(Boolean); };
    var whenT = tasksOf(part.when), upNormalT = tasksOf(part.up.concat(part.normal)), extraT = tasksOf(part.extra);
    var downT = tasksOf(part.down), hiddenT = tasksOf(part.hidden);
    var groups = { when: part.when.slice(), upNormal: part.up.concat(part.normal), down: part.down.slice() };
    var count = part.when.length + part.up.length + part.normal.length + part.down.length;

    function commitOrder(key) {
      return function (ids) {
        var order = ST.joinOrder(groups, key, ids);
        S.mutate('할 일 순서 바꾸기', function (s) { order.forEach(function (id, i) { var t = M.byId(s.tasks, id); if (t) t.sortOrder = (i + 1) * 10; }); });
      };
    }
    function list(label, ts, opts, key) {
      var ul = h('ul.home-list', { 'aria-label': label + (key ? ' (끌어서 순서 바꾸기, Alt+위/아래)' : '') },
        ts.map(function (t) { return taskRow(st, t, now, t.id === sel, Object.assign({ noDrag: !key }, opts)); }));
      if (key) sortable(ul, ts.map(function (t) { return t.id; }), commitOrder(key));
      return ul;
    }
    var out = [];
    var doneUl = tl.done.length ? h('ul.home-list.today-done', { 'aria-label': '오늘 끝낸 할 일' },
      tl.done.map(function (t) { return taskRow(st, t, now, t.id === sel); })) : null;

    // 잘 시간 — 내일 첫 일정 · 내일 마감만 한 줄로, [그래도 보기]로 전부
    if (sv.category === 'sleep') {
      var all = tasksOf(part.when.concat(part.up, part.normal, part.extra, part.down, part.hidden));
      out.push(h('div.today-sleep', h('span', sleepLine(st, now)),
        all.length ? h('button.link-btn', { type: 'button', 'aria-expanded': mem.sleepOpen ? 'true' : 'false',
          onclick: function () { mem.sleepOpen = !mem.sleepOpen; if (repaintToday) repaintToday(); } }, mem.sleepOpen ? '접기' : '그래도 보기') : null));
      if (mem.sleepOpen && all.length) out.push(list('지금은 뒤로 미룬 일', all, { dim: true, ctx: true }, null));
      if (doneUl) out.push(doneUl);
      return { body: h('div.today-groups', out), count: count };
    }

    var anyVisible = whenT.length || upNormalT.length || extraT.length || downT.length;
    if (!anyVisible && !hiddenT.length && !tl.done.length) {
      return { body: h('div.empty.home-empty', '오늘 할 일이 없어요. 왼쪽에 적으면 할 일은 여기로 들어와요.'), count: count };
    }
    if (!anyVisible && hiddenT.length) {
      out.push(h('div.empty.home-empty.today-all-hidden', sv.id === 'off'
        ? '퇴근 시간이에요. 지금 할 일은 없어요 — 푹 쉬어요.'
        : '지금(‘' + sv.label + '’)은 할 만한 일이 없어요. 쉬어도 돼요.'));
    }
    if (whenT.length) {
      var mode = whenT[0].atMode;
      out.push(h('div.today-group-head.is-when', h('span', { 'aria-hidden': 'true' }, '★'), WHEN_HEAD[mode] || '하기로 한 일'));
      out.push(list(WHEN_HEAD[mode] || '하기로 한 일', whenT, { ctx: true }, 'when'));
    }
    if (upNormalT.length) out.push(list('오늘의 할 일', upNormalT, {}, 'upNormal'));
    if (extraT.length) {
      out.push(h('div.today-group-head', { title: '오늘 목록에는 없지만 지금 상태에 맞는 일이에요' }, '지금 하기 좋은 일'));
      out.push(list('지금 하기 좋은 일', extraT, { ctx: true, estimate: true }, null));
    }
    if (downT.length) {
      var toggle = h('button.today-group-toggle', { type: 'button', 'aria-expanded': mem.downOpen ? 'true' : 'false',
        onclick: function () { mem.downOpen = !mem.downOpen; if (repaintToday) repaintToday(); } },
        ui.icon(mem.downOpen ? 'chevronDown' : 'chevronRight'),
        sv.guessed ? '시간표로 보면 지금은 ‘' + sv.label + '’이라 뒤로 미룬 일 ' + downT.length + '개'
                   : '지금은 뒤로 미룬 일 ' + downT.length + '개');
      out.push(h('div.today-group-head.is-down', toggle,
        sv.guessed ? h('button.link-btn.today-confirm', { type: 'button', onclick: function () {
          if (DN.status && DN.status.confirmGuess) DN.status.confirmGuess();
        } }, '‘' + sv.label + '’' + ui.josa(sv.label, '로/으로').slice(String(sv.label).length) + ' 정하기') : null));
      if (mem.downOpen) out.push(list('지금은 뒤로 미룬 일', downT, { dim: true, ctx: true }, 'down'));
    }
    if (hiddenT.length) {
      var text = ST.hiddenSummaryText(part.summary, pf);
      var openLabel = text.replace(' 숨김', '') + ' 보기 (지금은 숨김)';
      out.push(h('div.hidden-line', { role: 'group', 'aria-label': text },
        h('span', text), h('span', { 'aria-hidden': 'true' }, '·'),
        h('button.link-btn', { type: 'button', 'aria-expanded': mem.showHidden ? 'true' : 'false',
          'aria-label': mem.showHidden ? '숨긴 할 일 접기' : openLabel, 'data-focus-key': 'today-hidden',
          onclick: function () { mem.showHidden = !mem.showHidden; if (repaintToday) repaintToday(); } }, mem.showHidden ? '접기' : '보기')));
      if (mem.showHidden) {
        out.push(list('숨긴 할 일', hiddenT, { dim: true, ctx: true, onOpen: function (t) {
          if (DN.status && DN.status.markShown) DN.status.markShown(t.id);
          A.openTask(t.id);
        } }, null));
      }
    }
    if (doneUl) out.push(doneUl);
    return { body: h('div.today-groups', out), count: count };
  }

  // 잘 시간 한 줄: 내일 첫 일정 10:00 ‘팀 회의’ · 내일 마감 ‘견적서 보내기’ 외 1개
  function sleepLine(st, now) {
    var tomorrow = D.addDays(D.startOfDay(now), 1);
    var tYmd = D.ymd(tomorrow);
    var parts = [];
    var items = M.calendarItems ? M.calendarItems(st, tomorrow.toISOString(), D.addDays(tomorrow, 1).toISOString(), { includeAllDay: false }) : [];
    var first = items.filter(function (x) { return D.ymd(x.start) === tYmd; })[0];
    if (first) {
      var ft = first.taskId && M.byId(st.tasks, first.taskId);
      parts.push('내일 첫 일정 ' + D.hm(first.start) + ' ‘' + (ft ? ft.title : (first.title || '일정')) + '’');
    }
    var due = M.liveTasks(st).filter(function (t) { return t.status !== 'done' && t.dueDate === tYmd; });
    if (due.length) parts.push('내일 마감 ‘' + due[0].title + '’' + (due.length > 1 ? ' 외 ' + (due.length - 1) + '개' : ''));
    return parts.length ? parts.join(' · ') : '잘 시간이에요. 내일 일정과 마감은 아직 없어요.';
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

  // opts (상태 묶음에서만): { dim, ctx: 맥락 칩, estimate: 소요 시간 칩, noDrag, onOpen(t) } — 없으면 지금 행 그대로
  function taskRow(st, t, now, selected, opts) {
    var A = DN.app;
    opts = opts || {};
    var done = t.status === 'done';
    var steps = t.steps || [];
    var stepsDone = steps.filter(function (s) { return s.done; }).length;
    var check = h('input.check', { type: 'checkbox', checked: done, 'aria-label': '‘' + t.title + '’ ' + (done ? '완료 취소' : '완료'),
      onclick: function (e) { e.stopPropagation(); }, onchange: function () { A.toggleDone(t.id); } });
    var proj = t.projectId && M.byId(st.projects, t.projectId);
    var pendingDraft = !done && t.breakdown && (t.breakdown.status === 'pending' || t.breakdown.status === 'later') && !steps.length;
    var meta = h('div.home-meta',
      t.status === 'in_progress' ? h('span.chip.chip-progress', '진행 중') : null,
      ui.dueChip(t, now),
      opts.estimate && !done && t.estimateMinutes != null ? ui.estimateChip(t) : null,
      steps.length ? h('span.chip', '단계 ' + stepsDone + '/' + steps.length) : null,
      pendingDraft ? h('button.chip.chip-guess.chip-btn', { type: 'button', title: 'AI가 나눠 둔 단계 보기', onclick: function (e) { e.stopPropagation(); DN.assistant.breakdown(t.id); } }, '나눠 둔 단계 있음') : null,
      proj ? h('span.chip.chip-project', { style: { '--pc': proj.color } }, proj.name) : null,
      opts.ctx && !done ? ctxChipOf(t) : null);
    var drag = !done && !opts.noDrag;
    var open = function () { if (opts.onOpen) opts.onOpen(t); else A.openTask(t.id); };
    return h('li.home-row' + (done ? '.is-done' : '') + (selected ? '.is-selected' : '') + (opts.dim ? '.is-dim' : ''), {
      'data-id': done ? null : t.id, draggable: drag ? 'true' : null, tabindex: '0',
      onclick: open,
      onkeydown: function (e) { if (e.target !== e.currentTarget) return; if (e.key === 'Enter') { e.preventDefault(); open(); } else if (e.key === ' ') { e.preventDefault(); A.toggleDone(t.id); } }
    },
      drag ? h('span.drag-handle', { 'aria-hidden': 'true', title: '끌어서 순서 바꾸기' }, '⋮⋮') : h('span.drag-handle.is-off', { 'aria-hidden': 'true' }),
      check,
      h('div.home-main', h('div.home-row-title', t.title || '(제목 없음)'), meta.childNodes.length ? meta : null));
  }

  // 링크 메모의 첫 주소 → { url, host } (주소가 없으면 null)
  function firstLink(n) {
    var m = /https?:\/\/[^\s<>"')\]]+/i.exec((n.title || '') + '\n' + (n.body || ''));
    if (!m) return null;
    var url = m[0].replace(/[.,;:!?]+$/, '');
    var host = url.replace(/^https?:\/\//i, '').split(/[\/?#]/)[0].replace(/^www\./i, '');
    return host ? { url: url, host: host } : null;
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
      'data-id': n.id, 'data-kind': kind, draggable: 'true', tabindex: '0',
      onclick: function () { A.go('notes', { noteId: n.id }); },
      onkeydown: function (e) { if (e.target === e.currentTarget && e.key === 'Enter') { e.preventDefault(); A.go('notes', { noteId: n.id }); } }
    },
      h('span.drag-handle', { 'aria-hidden': 'true', title: '끌어서 순서 바꾸기' }, '⋮⋮'),
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
          proj ? h('span.chip.chip-project', { style: { '--pc': proj.color } }, proj.name) : null)));
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
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
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

  // ------------------------------------------------------------------ 오늘 일정 (GOOGLE §9.3)
  // Daynote 블록 + Google 일정(M.calendarItems). 종일 일정은 맨 위에 '종일 · 제목', 시간 있는 것은 오늘 시작하는 것만.
  function agendaList(st, now) {
    var today = D.ymd(now);
    var sod = D.startOfDay(now), eod = D.addDays(sod, 1);
    var items = M.calendarItems
      ? M.calendarItems(st, sod.toISOString(), eod.toISOString())
      : st.blocks.filter(function (b) { var t = b.taskId && M.byId(st.tasks, b.taskId); return !(t && t.deletedAt); });
    var allDay = items.filter(function (x) { return x.allDay; });
    var timed = items.filter(function (x) { return !x.allDay && D.ymd(x.start) === today; })
      .sort(function (a, b) { var d = new Date(a.start).getTime() - new Date(b.start).getTime(); return d || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    return { allDay: allDay, timed: timed };
  }

  function openExt(item, ev) {
    var A = DN.app;
    if (DN.views.extEvent && DN.views.extEvent.open) DN.views.extEvent.open(item, ev.currentTarget);
    else A.go('calendar', { anchor: D.ymd(A.now()) });
  }

  function agenda(st, now) {
    var A = DN.app;
    var ms = now.getTime();
    var ag = agendaList(st, now);
    var count = ag.allDay.length + ag.timed.length;
    var isExt = function (x) { return M.isExternal ? M.isExternal(x) : !!x.external; };
    var rows = [];
    ag.allDay.forEach(function (x) {
      rows.push(h('div.agenda-item.agenda-allday' + (isExt(x) ? '.is-ext' : '') + (x.tentative ? '.is-tentative' : ''),
        h('span.time', { 'aria-hidden': 'true' }),
        h('span.t', h('button.link-btn', { type: 'button', style: { color: 'inherit', textDecoration: 'none' },
          onclick: function (ev) { if (isExt(x)) openExt(x, ev); else A.go('calendar', { anchor: D.ymd(A.now()) }); } }, '종일 · ' + (x.title || '일정')))));
    });
    ag.timed.forEach(function (b) {
      var ext = isExt(b);
      var t = !ext && b.taskId && M.byId(st.tasks, b.taskId);
      var s0 = new Date(b.start).getTime(), e0 = new Date(b.end).getTime();
      var conflict = M.conflictsFor(st, b.start, b.end, b.id).length > 0;
      var cls = '.agenda-item' + (b.kind === 'work' ? '.is-work' : '') + (ext ? '.is-ext' : '') + (ext && b.tentative ? '.is-tentative' : '') +
        (s0 <= ms && e0 > ms ? '.is-now' : '') + (e0 <= ms ? '.is-past' : '');
      rows.push(h('div' + cls, ext ? { title: 'Google' + (b.calendarName ? ' · ' + b.calendarName : '') } : null,
        h('span.time', D.hm(b.start) + '–' + D.hm(b.end)),
        h('span.t', h('button.link-btn', { type: 'button', style: { color: 'inherit', textDecoration: t && t.status === 'done' ? 'line-through' : 'none' },
          onclick: function (ev) {
            if (ext) openExt(b, ev);
            else if (t) A.openTask(t.id);
            else DN.views.schedule.open({ blockId: b.id });
          } }, t ? t.title : (b.title || '일정')),
          conflict ? h('span.meta', { style: { color: 'var(--warning)', marginLeft: '6px' } }, '· 겹침') : null)));
    });
    // 오늘 패널의 맨 아래 칸 (할 일 · 메모 · 일정)
    return h('div.home-sec.home-sec-agenda', { 'aria-labelledby': 'agenda-title' },
      h('div.home-sec-head', h('h2#agenda-title', '오늘 일정'), h('span.meta', count ? count + '개' : ''),
        h('button.btn.btn-ghost.btn-xs', { type: 'button', onclick: function () {
          DN.views.schedule.open({ event: true, start: DN.views.schedule.findFreeSlot(S.state, A.now(), 60) });
        } }, ui.icon('plus'), '일정 추가'),
        h('button.btn.btn-ghost.btn-xs', { type: 'button', onclick: function () { A.go('calendar'); } }, '캘린더')),
      h('div.home-scroll', { 'data-keep-scroll': 'home-agenda' },
        rows.length ? rows : h('div.empty.home-empty', '오늘 잡힌 일정이 없어요.')));
  }

  // 숨긴 할 일 펼치기 — 추천 패널의 [접어 둔 일 보기] 등에서 부른다
  function showHidden() {
    mem.showHidden = true;
    if (repaintToday) {
      repaintToday();
      setTimeout(function () {
        var b = document.querySelector('[data-focus-key="today-hidden"]');
        if (b && b.scrollIntoView) b.scrollIntoView({ block: 'nearest' });
      }, 0);
    } else if (DN.app && DN.app.go) DN.app.go('today');
  }

  DN.views.today = { title: '오늘', render: render, todayTaskList: todayTaskList, todayMemoList: todayMemoList, showHidden: showHidden };
})();
