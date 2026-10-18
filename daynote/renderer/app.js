'use strict';

// 앱 셸 — 탐색, 화면 전환, 상세 패널, 공통 동작(완료·시작·미루기·일정 배치), 단축키.
//
// 화면(view) 규칙:
//   Daynote.views.<이름> = { title, render(root, params) → { destroy?(), onChange?(info) → true 면 다시 그리지 않음 } }
//   상태가 바뀌면 지금 화면을 다시 그린다 (스크롤 위치는 지킨다).

(function () {
  var DN = window.Daynote;
  var M = DN.model, D = DN.dates, S = DN.store, ui = DN.ui, h = ui.h;

  // 사이드바 (Alt+1~6). 메모 목록은 보관함에서, 새 할 일 제안은 설정의 메일 연결에서 연다.
  var NAV = [
    { id: 'today', label: '오늘', icon: 'today', key: '1' },
    { id: 'archive', label: '보관함', icon: 'archive', key: '2' },
    { id: 'tasks', label: '할 일', icon: 'task', key: '3' },
    { id: 'calendar', label: '캘린더', icon: 'calendar', key: '4' },
    { id: 'projects', label: '프로젝트', icon: 'project', key: '5' },
    { id: 'weekly', label: '주간 정리', icon: 'weekly', key: '6' }
  ];

  var cur = { view: null, params: {}, handle: null };
  var detailTaskId = null;
  var detailHandle = null;
  var els = {};

  // 검증용으로 시계를 고정할 수 있다 (window.__daynoteNow = '2026-10-05T10:00')
  function now() { return window.__daynoteNow ? new Date(window.__daynoteNow) : new Date(); }

  // ------------------------------------------------------------------ 셸
  function buildShell() {
    var root = document.getElementById('app');
    root.textContent = '';
    els.nav = h('nav.nav', { 'aria-label': '주 메뉴' });
    els.navSub = h('div.nav');
    els.save = h('div.save-indicator', { role: 'status', 'aria-live': 'polite' });
    // 되돌리기 · 다시 실행 버튼 (Ctrl+Z · Ctrl+Y)
    els.undoBtn = h('button.icon-btn.hist-btn', { type: 'button', title: '되돌리기 (Ctrl+Z)', 'aria-label': '되돌리기', onclick: function () { undo(); } }, ui.icon('undo'));
    els.redoBtn = h('button.icon-btn.hist-btn', { type: 'button', title: '다시 실행 (Ctrl+Y)', 'aria-label': '다시 실행', onclick: function () { redo(); } }, ui.icon('redo'));
    els.hist = h('div.hist-btns', els.undoBtn, els.redoBtn);
    // 집중 타이머 — 어느 화면에서나 보이게 (UX 점검 W-03)
    els.focusTime = h('b', '');
    els.focus = h('div.focus-pill', { hidden: true },
      h('button.focus-pill-main', { type: 'button', title: '집중 중인 일 열기', onclick: function () {
        var f = S.state.meta.focus; if (!f) return;
        if (cur.view !== 'today') go('today');
        if (DN.assistant) DN.assistant.work(f.taskId);
      } }, ui.icon('clock'), h('span.focus-pill-label', '집중 '), els.focusTime),
      h('button.focus-pill-stop', { type: 'button', title: '집중 그만', 'aria-label': '집중 그만', onclick: function () { if (DN.assistant) DN.assistant.stopFocus(); } }, ui.icon('x')));
    els.sidebar = h('aside.sidebar',
      h('div.brand', h('div.brand-mark', { 'aria-hidden': 'true' }, 'D'), h('div.brand-name', 'Daynote'),
        h('button.icon-btn.brand-collapse', { type: 'button', 'aria-label': '사이드바 접기/펴기', title: '사이드바 접기/펴기 (Ctrl+\\)', onclick: toggleSidebar }, ui.icon('sidebar'))),
      els.nav,
      h('div.sidebar-foot', els.focus, els.navSub, h('div.sidebar-foot-row', els.save, els.hist))
    );
    els.banner = h('div');
    els.view = h('div.view', { id: 'view', tabindex: '-1' });
    els.main = h('main.main', els.banner, els.view);
    els.detail = h('div');
    els.shell = h('div.app', els.sidebar, els.main, els.detail);
    root.appendChild(els.shell);

    S.onStatus(renderSave);
    // 되돌릴 것·다시 실행할 것이 있을 때만 버튼을 켠다
    function renderHist() { els.undoBtn.disabled = !S.canUndo(); els.redoBtn.disabled = !S.canRedo(); }
    S.subscribe(renderHist);
    renderHist();
  }

  // 집중 남은 시간 — 사이드바 알약 · 창 제목(작업 표시줄) · 트레이 툴팁. 1초마다
  var baseTitle = 'Daynote', lastStatus = null;
  function focusTick() {
    var f = S.state.meta.focus;
    var title = baseTitle, status = '';
    if (f && els.focus) {
      var left = Math.max(0, new Date(f.end) - Date.now());
      var txt = Math.floor(left / 60000) + ':' + ('0' + (Math.floor(left / 1000) % 60)).slice(-2);
      var t = M.byId(S.state.tasks, f.taskId);
      els.focus.hidden = false;
      els.focusTime.textContent = txt + ' 남음';
      els.focus.title = t ? '집중: ' + t.title : '';
      title = '⏱ ' + txt + ' · ' + baseTitle;
      status = '집중 ' + Math.ceil(left / 60000) + '분 남음' + (t ? ' · ' + t.title : '');
    } else if (els.focus) els.focus.hidden = true;
    if (document.title !== title) document.title = title;
    if (status !== lastStatus) { lastStatus = status; if (S.host && S.host.setStatus) try { S.host.setStatus(status); } catch (e) {} }
  }
  setInterval(focusTick, 1000);
  S.subscribe(function () { focusTick(); });   // 시작·그만은 바로 보이게

  function renderNav() {
    var st = S.state;
    var n = now();
    var counts = {
      today: M.liveTasks(st).filter(function (t) {
        return t.status !== 'done' && t.dueDate && D.dayDiff(n, D.parseYmd(t.dueDate)) <= 0;
      }).length,
      tasks: M.liveTasks(st).filter(function (t) { return t.status !== 'done'; }).length
    };
    els.nav.textContent = '';
    NAV.forEach(function (it) {
      els.nav.appendChild(h('button.nav-item', {
        type: 'button', 'aria-current': cur.view === it.id ? 'page' : null, title: it.label + ' (Alt+' + it.key + ')',
        onclick: function () { go(it.id); }
      }, ui.icon(it.icon), h('span.nav-label', it.label), counts[it.id] ? h('span.nav-count', String(counts[it.id])) : null));
    });
    els.navSub.textContent = '';
    els.navSub.appendChild(h('button.nav-sub', { type: 'button', 'aria-current': cur.view === 'settings' ? 'page' : null, title: '설정 — 연결 · 화면 · 단축키', onclick: function () { go('settings'); } },
      ui.icon('settings'), h('span.nav-label', '설정')));

    els.banner.textContent = '';
    if (st.meta.sampleLoaded) {
      els.banner.appendChild(h('div.sample-banner', { role: 'note' },
        h('span', h('b', '샘플 데이터를 보는 중입니다.'), ' ‘샘플’ 표시가 붙은 항목은 둘러보기용이며, 직접 만든 항목은 지워지지 않습니다.'),
        h('button.btn.btn-sm', { type: 'button', onclick: clearSample }, '샘플 지우기')));
    }
  }

  function renderSave(s) {
    if (!els.save) return;
    els.save.className = 'save-indicator' + (s.phase === 'error' ? ' is-error' : s.phase === 'saving' || s.phase === 'pending' ? ' is-saving' : '');
    els.save.textContent = '';
    els.save.appendChild(h('span.dot'));
    if (s.phase === 'error') {
      els.save.appendChild(h('span', '저장 실패 · 내용은 보존 중 '));
      els.save.appendChild(h('button.link-btn', { type: 'button', onclick: function () { S.retrySave(); } }, '다시 시도'));
    } else if (s.phase === 'saved') {
      els.save.appendChild(h('span', s.at ? '저장됨 ' + D.hm(s.at) : '로컬에 저장됨'));
    } else {
      els.save.appendChild(h('span', '저장 중…'));
    }
  }

  function toggleSidebar() {
    S.mutate(null, function (s) { s.prefs.sidebarCollapsed = !s.prefs.sidebarCollapsed; }, { silent: true });
    applyPrefs();
  }
  function applyPrefs() {
    els.shell.classList.toggle('sidebar-collapsed', !!S.state.prefs.sidebarCollapsed || window.innerWidth < 1000);
    document.documentElement.classList.toggle('reduce-motion', !!S.state.prefs.reduceMotion);
    applyTheme(S.state.prefs.theme);
  }
  // 화면 테마 — 'system'(기본, 속성 없음 → OS 설정을 따른다) | 'light' | 'dark'
  function applyTheme(theme) {
    var root = document.documentElement;
    if (theme === 'light' || theme === 'dark') { if (root.getAttribute('data-theme') !== theme) root.setAttribute('data-theme', theme); }
    else if (root.hasAttribute('data-theme')) root.removeAttribute('data-theme');
  }

  // ------------------------------------------------------------------ 화면 전환
  function go(view, params) {
    if (!DN.views[view]) view = 'today';
    if (cur.handle && cur.handle.destroy) cur.handle.destroy();
    cur = { view: view, params: params || {}, handle: null };
    els.view.scrollTop = 0;
    renderView();
    renderNav();
    var v = DN.views[view];
    baseTitle = (v.title || '') + ' · Daynote';
    focusTick();
  }

  function renderView() {
    var scroll = els.view.scrollTop;
    var inner = Array.prototype.map.call(els.view.querySelectorAll('[data-keep-scroll]'), function (e) { return [e.getAttribute('data-keep-scroll'), e.scrollTop]; });
    if (cur.handle && cur.handle.destroy) cur.handle.destroy();
    els.view.textContent = '';
    cur.handle = DN.views[cur.view].render(els.view, cur.params) || {};
    els.view.scrollTop = scroll;
    inner.forEach(function (p) { var e = els.view.querySelector('[data-keep-scroll="' + p[0] + '"]'); if (e) e.scrollTop = p[1]; });
  }

  function onStoreChange(info) {
    renderNav();
    applyPrefs();
    // 외부 캘린더 가져오기는 일정이 보이는 화면만 다시 그린다 (메모·보고서를 쓰는 중에 화면이 바뀌지 않게)
    if (info.source === 'calendar' && ['today', 'calendar', 'settings'].indexOf(cur.view) === -1) return;
    if (detailTaskId) {
      var t = M.byId(S.state.tasks, detailTaskId);
      if (!t || t.deletedAt) closeDetail();
      else if (!(detailHandle && detailHandle.onChange && detailHandle.onChange(info))) renderDetail();
    }
    if (cur.handle && cur.handle.onChange && cur.handle.onChange(info)) return;
    renderView();
  }

  // ------------------------------------------------------------------ 상세 패널
  function openTask(id, opts) {
    detailTaskId = id;
    renderDetail();
    var row = els.view.querySelectorAll('.task-row');
    Array.prototype.forEach.call(row, function (r) { r.classList.toggle('is-selected', r.getAttribute('data-task-id') === id); });
    if (!(opts && opts.keepFocus)) setTimeout(function () { var f = els.detail.querySelector('.detail-title'); if (f) f.focus(); }, 0);
  }
  function renderDetail() {
    if (detailHandle && detailHandle.destroy) detailHandle.destroy();
    els.detail.textContent = '';
    if (!detailTaskId) return;
    detailHandle = DN.views.detail.render(els.detail, detailTaskId) || {};
  }
  function closeDetail() {
    detailTaskId = null;
    if (detailHandle && detailHandle.destroy) detailHandle.destroy();
    detailHandle = null;
    els.detail.textContent = '';
    Array.prototype.forEach.call(els.view.querySelectorAll('.task-row.is-selected'), function (r) { r.classList.remove('is-selected'); });
  }

  // ------------------------------------------------------------------ 공통 동작
  // 되돌리기 · 다시 실행 — 알림에서 반대 동작을 바로 누를 수 있게
  // 메모를 할 일로 — 오늘 화면에서 메모를 할 일 목록으로 끌어 놓을 때.
  //   AI 로 다시 정리한다 (마감·프로젝트를 알아내게, 목록이면 세부 할 일로). AI 가 없거나 할 일을 못 만들면 첫 줄 제목 + 아래 줄 세부 할 일로
  //   끌어 놓기 · AI 정리 · 대신 만들기는 되돌리기 한 칸 (Ctrl+Z 한 번에 메모로)
  function memoToTask(noteId) {
    var n = M.byId(S.state.notes, noteId);
    if (!n || n.deletedAt) return null;
    function local(key) {
      var t = S.withJoin(key, function () { return DN.capture.toTask(noteId); });
      if (!t) return null;
      var cnt = DN.steps.count(t.steps);
      ui.undoToast('‘' + t.title + '’ 할 일로 정리했어요' + (cnt.total ? ' — 세부 할 일 ' + cnt.total + '개' : '') + '.');
      return t;
    }
    if (!DN.aiFlow.status().configured) return local(null);
    var key = M.uid('mt');
    S.mutate('할 일로 정리', function (s) {
      var x = M.byId(s.notes, noteId);
      x.capture = Object.assign({ created: [] }, x.capture || {}, { status: 'pending', error: null, changedByUser: false, kindByUser: false });
    }, { source: 'capture', key: key });
    ui.toast('‘' + M.noteTitle(n) + '’ 할 일로 정리하는 중…');
    return DN.capture.classify(noteId, { moveToTask: true, join: key }).then(function (r) {
      if (r && r.reason === 'undone') return null;
      var note = M.byId(S.state.notes, noteId);
      var made = note && note.capture && (note.capture.created || []).filter(function (c) { return c.kind === 'task'; })
        .map(function (c) { return M.byId(S.state.tasks, c.id); }).filter(function (t) { return t && !t.deletedAt; });
      if (!r || !r.ok || !made || !made.length) return local(key);
      var t = made[0], cnt = DN.steps.count(t.steps);
      var proj = t.projectId && M.byId(S.state.projects, t.projectId);
      var bits = [t.dueDate ? '마감 ' + D.relDay(t.dueDate, now()) + (t.dueTime ? ' ' + t.dueTime : '') : null, proj ? proj.name : null, cnt.total ? '세부 할 일 ' + cnt.total + '개' : null].filter(Boolean);
      ui.undoToast('‘' + t.title + '’' + (made.length > 1 ? ' 외 ' + (made.length - 1) + '개' : '') + ' 할 일로 정리했어요' + (bits.length ? ' — ' + bits.join(' · ') : '') + '.');
      return t;
    });
  }

  // 할 일을 메모로 — 메모 칸에 끌어 놓을 때. 적은 글에서 만든 할 일이면 그 글을 다시 메모로 (원문 그대로),
  //   직접 만든 할 일이면 제목 · 세부 할 일(목록) · 메모로 새 메모를 만든다
  function taskToMemo(taskId) {
    var t = M.byId(S.state.tasks, taskId);
    if (!t || t.deletedAt) return null;
    var src = (t.sources || []).filter(function (x) { return x.type === 'note'; }).map(function (x) { return M.byId(S.state.notes, x.refId); })[0];
    var others = src && !src.deletedAt ? ((src.capture && src.capture.created) || []).filter(function (c) {
      if (c.id === taskId) return false;
      var it = M.byId(c.kind === 'task' ? S.state.tasks : S.state.blocks, c.id);
      return it && !it.deletedAt;
    }) : null;
    var note = S.mutate('메모로 옮기기', function (s) {
      if (src && !src.deletedAt && others && !others.length) return DN.aiProposals.captureToMemo(s, src.id, now());
      var lines = [t.title];
      DN.steps.walk(t.steps || [], function (x, d) { lines.push(new Array(d + 2).join('  ') + '- ' + (x.done ? '[x] ' : '') + x.title); });
      if (t.memo && t.memo.trim()) lines.push('', t.memo.trim());
      var n2 = M.addNote(s, { title: '', body: lines.join('\n'), projectId: t.projectId || null, captureRole: 'memo', fromTaskId: t.id,
        capture: { status: 'done', at: now().toISOString(), entryType: 'memo', created: [], changedByUser: true } }, now());
      M.deleteTask(s, taskId, now());
      return n2;
    });
    if (note) ui.undoToast('‘' + t.title + '’를 메모로 옮겼어요.');
    return note;
  }
  function undo() {
    var l = S.undo();
    if (!l) { ui.toast('되돌릴 작업이 없어요.'); return null; }
    ui.toast('‘' + l + '’' + ui.josa(l, '를/을').slice(l.length) + ' 되돌렸어요.', { action: { label: '다시 실행', fn: redo } });
    return l;
  }
  function redo() {
    var l = S.redo();
    if (!l) { ui.toast('다시 실행할 작업이 없어요.'); return null; }
    ui.toast('‘' + l + '’' + ui.josa(l, '를/을').slice(l.length) + ' 다시 실행했어요.', { action: { label: '되돌리기', fn: undo } });
    return l;
  }

  function toggleDone(id) {
    var t = M.byId(S.state.tasks, id);
    if (!t) return;
    if (t.status === 'done') {
      S.mutate('완료 취소', function (s) { M.reopenTask(s, id, now()); });
      ui.undoToast('‘' + t.title + '’ 완료를 취소했습니다. 이전 완료 기록은 히스토리에 ‘취소됨’으로 남습니다.');
    } else {
      S.mutate('완료', function (s) { M.completeTask(s, id, now()); });
      var ve = DN.habits && DN.habits.actualVsEstimate(M.byId(S.state.tasks, id), now());
      var nToday = M.liveTasks(S.state).filter(function (x) { return x.status === 'done' && x.completedAt && D.ymd(x.completedAt) === D.ymd(now()); }).length;
      var el = ui.undoToast('‘' + t.title + '’ 완료 — 오늘 ' + nToday + '번째예요!' + (ve ? ' (예상 ' + ve.estimate + '분 · 실제 ' + ve.actual + '분)' : ''));
      if (el && el.el) el.el.classList.add('is-celebrate');
    }
  }

  // 지금 시작 — 실행 직전 상태를 다시 확인한다. 다른 진행 중 업무는 그대로 (여러 일을 함께 진행)
  function startTask(id) {
    var check = DN.recommend.checkStartable(S.state, id, now());
    if (!check.ok) { ui.toast('시작하지 않았습니다: ' + check.reason, { error: true }); return Promise.resolve(false); }
    var t = check.task;
    if (t.status === 'in_progress') return Promise.resolve(true);
    // 여러 일을 함께 진행할 수 있다 — 다른 진행 중 업무는 그대로 둔다
    var resume = t.status === 'paused';
    S.mutate(resume ? '이어서 하기' : '지금 시작', function (s) { M.startTask(s, id, now()); });
    ui.undoToast('‘' + t.title + '’' + (resume ? ' 다시 시작했어요.' : ' 시작했어요.'));
    return Promise.resolve(true);
  }
  function pauseTask(id) {
    var t = S.mutate('일시 정지', function (s) { return M.pauseTask(s, id, now()); });
    if (t) ui.undoToast('‘' + t.title + '’ 일시 정지했어요. 한 시간은 남겨 뒀어요.');
    return t;
  }
  function returnToTodo(id) {
    var t = S.mutate('할 일로 돌려보내기', function (s) { return M.returnToTodo(s, id, now()); });
    if (t) ui.undoToast('‘' + t.title + '’ 할 일로 돌려보냈어요.');
    return t;
  }

  function snoozeMenu(id, anchor, after) {
    var opts = DN.recommend.snoozeOptions(now());
    ui.menu(anchor, [{ label: '언제 다시 볼까요?' }].concat(opts.map(function (o) {
      return {
        label: o.label, sub: D.shortDay(o.at) + ' ' + D.hm(o.at), onClick: function () {
          var t = M.byId(S.state.tasks, id);
          S.mutate('미루기', function (s) { M.snoozeTask(s, id, o.at.toISOString(), now()); });
          ui.undoToast('‘' + (t && t.title) + '’를 ' + o.label + '까지 미뤘습니다. 업무는 그대로 남아 있습니다.');
          if (after) after();
        }
      };
    })));
  }

  function taskMenu(id, anchor) {
    var t = M.byId(S.state.tasks, id);
    if (!t) return;
    var items = [{ label: '자세히 편집…', onClick: function () { openTask(id); } }];
    if (t.status !== 'done') {
      items.push({ label: '지금 시작', onClick: function () { startTask(id); } });
      items.push({ label: '일정에 배치…', onClick: function () { scheduleTask(id); } });
      items.push({ label: '할 날 정하기…', keepOpen: true, onClick: function (pop) {
        var box = document.createDocumentFragment();
        DN.horizon.planChoices(now()).concat(t.planDate ? [['할 날 지우기', null]] : []).forEach(function (c) {
          box.appendChild(ui.h('button', { type: 'button', role: 'menuitem', onclick: function () {
            pop.close(true);
            S.mutate(c[1] ? '할 날 정하기' : '할 날 지우기', function (s) { M.updateTask(s, id, { planDate: c[1] }, now()); });
            ui.undoToast(c[1] ? '‘' + t.title + '’ ' + D.relDay(c[1], now()) + '에 할게요.' : '‘' + t.title + '’ 할 날을 지웠어요.');
          } }, ui.h('span.menu-text', c[0]), c[1] ? ui.h('span.sub', D.relDay(c[1], now())) : null));
        });
        pop.setContent(box, 'menu');
      } });
      items.push({ label: '나중에 (미루기)…', onClick: function () { snoozeMenu(id, anchor); } });
    }
    items.push({ label: '삭제', onClick: function () { deleteTask(id); } });
    ui.menu(anchor, items);
  }

  function deleteTask(id) {
    var t = M.byId(S.state.tasks, id);
    S.mutate('삭제', function (s) { M.deleteTask(s, id, now()); });
    if (detailTaskId === id) closeDetail();
    ui.undoToast('‘' + t.title + '’를 삭제했습니다. 앞으로 잡힌 작업 시간도 함께 지웠습니다.');
  }

  function scheduleTask(id, opts) { return DN.views.schedule.open(Object.assign({ taskId: id }, opts || {})); }

  // 출처/참조 열기 — 메모·메일·할 일·프로젝트
  function openRef(ref) {
    var r = M.resolveRef(S.state, ref);
    if (r.missing) { ui.toast('원본이 삭제되어 열 수 없습니다.'); return; }
    if (r.kind === 'note') go('notes', { noteId: r.id });
    else if (r.kind === 'task') openTask(r.id);
    else if (r.kind === 'email') DN.views.inbox.openEmail(r.id);
    else if (r.kind === 'project') go('projects', { projectId: r.id });
  }

  function clearSample() {
    ui.confirm('샘플 데이터 지우기', '‘샘플’ 표시가 붙은 프로젝트·메모·할 일·일정·기록·메일을 지웁니다. 직접 만든 항목은 그대로 남습니다.', '샘플 지우기').then(function (ok) {
      if (!ok) return;
      closeDetail();
      S.mutate('샘플 지우기', function (s) {
        M.clearSample(s);
        s.suggestions = s.suggestions.filter(function (x) { return !x.sample; });
      });
      ui.undoToast('샘플 데이터를 지웠습니다.');
    });
  }

  function loadSample() {
    S.mutate('샘플 불러오기', function (s) { DN.sample.build(s, now()); });
    ui.toast('샘플 데이터를 불러왔습니다. 위쪽 띠에서 언제든 지울 수 있습니다.');
  }

  // 빠른 기록 대화상자 (Ctrl+N) — 닫아도 초안은 남는다
  function quickCapture() {
    var st = S.state;
    var ta = h('textarea.textarea', { rows: 6, placeholder: '떠오른 걸 적어 두세요 — 할 일·일정·메모는 AI가 바로 나눠요 (결과는 오늘 화면 채팅에)', 'aria-label': '빠른 메모' });
    ta.value = st.quickDraft.text || '';
    var proj = h('select.select', { 'aria-label': '프로젝트 (선택)' }, ui.projectOptions(st, st.quickDraft.projectId, '프로젝트 선택 안 함'));
    var t;
    function keep() {
      clearTimeout(t);
      t = setTimeout(function () { S.mutate(null, function (s) { s.quickDraft = { text: ta.value, projectId: proj.value || null }; }, { silent: true }); }, 250);
    }
    ta.addEventListener('input', keep); proj.addEventListener('change', keep);
    var m = ui.modal({
      title: '빠른 메모',
      body: [ta, h('div.field-row', h('div.field', proj), h('div.help', { style: { alignSelf: 'center' } }, 'Ctrl+Enter로 저장 · 닫아도 초안이 남습니다'))],
      actions: [{ label: '닫기' }, { label: '메모 저장', primary: true, onClick: function () { return saveQuick(ta.value, proj.value || null); } }],
      onClose: keep
    });
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { if (saveQuick(ta.value, proj.value || null) !== false) m.close(); } });
  }

  // 입력 저장 — 원문은 바로 메모로 저장되고, AI 가 메모/할 일·프로젝트를 나눠 바로 반영한다 (capture.js)
  function saveQuick(text, projectId, opts) {
    if (!text.trim()) { ui.toast('내용을 입력해 주세요.'); return false; }
    S.mutate(null, function (s) { s.quickDraft = { text: '', projectId: null }; }, { source: 'today', silent: true });
    // 어디서 적든 같은 길 — 홈 채팅과 똑같이 정리하고 결과 카드로 보여 준다 (UX 점검 C-03)
    var note = DN.assistant ? DN.assistant.send(text, projectId) : DN.capture.submit(text, projectId);
    if (!(opts && opts.silent)) {
      ui.toast('저장했어요. AI가 나눈 결과는 오늘 화면 채팅에 있어요 — 거기서 바로 고칠 수 있어요.', { action: { label: '결과 보기', fn: function () { go('today'); } } });
    }
    return note;
  }

  // ------------------------------------------------------------------ 단축키
  function onKey(e) {
    if (document.querySelector('.overlay')) return;
    var inField = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable || (e.target.closest && e.target.closest('.CodeMirror'));
    if (e.altKey && !e.ctrlKey && /^[1-6]$/.test(e.key)) { e.preventDefault(); go(NAV[Number(e.key) - 1].id); return; }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); quickCapture(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === '\\') { e.preventDefault(); toggleSidebar(); return; }
    // '/' — 지금 화면의 입력창·검색 칸으로 (홈: 적어 두기, 보관함: 검색)
    if (e.key === '/' && !inField && !e.ctrlKey && !e.metaKey && !e.altKey) {
      var slash = els.view.querySelector('[data-slash]');
      if (slash) { e.preventDefault(); slash.focus(); if (slash.select && slash.tagName === 'INPUT') slash.select(); }
      return;
    }
    var redoKey = (e.ctrlKey || e.metaKey) && ((e.key === 'y' || e.key === 'Y') || ((e.key === 'z' || e.key === 'Z') && e.shiftKey));
    if (redoKey && !inField) { e.preventDefault(); redo(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !inField) { e.preventDefault(); undo(); return; }
    if (e.key === 'Escape' && detailTaskId && !inField) { closeDetail(); return; }
  }

  // ------------------------------------------------------------------ 시작
  function start() {
    buildShell();
    S.load().then(function (res) {
      S.subscribe(onStoreChange);
      applyPrefs();
      go('today');
      if (DN.calsync) DN.calsync.start();
      if (res.recovered) ui.toast('지난번에 저장되지 않은 내용을 복구했습니다.', { duration: 6000 });
    }).catch(function (e) {
      document.getElementById('app').textContent = '데이터를 불러오지 못했습니다: ' + e.message;
    });
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', function () { if (els.shell) applyPrefs(); });
    // 미루기 만료·현재 시각 표시를 위해 1분마다 화면에 알린다
    setInterval(function () {
      if (cur.handle && cur.handle.onTick) cur.handle.onTick(now());
      renderNav();
    }, 60 * 1000);
  }

  DN.app = {
    now: now, go: go, undo: undo, redo: redo, memoToTask: memoToTask, taskToMemo: taskToMemo, refresh: function () { renderView(); renderNav(); }, openTask: openTask, closeDetail: closeDetail, toggleDone: toggleDone, startTask: startTask, pauseTask: pauseTask, returnToTodo: returnToTodo,
    snoozeMenu: snoozeMenu, taskMenu: taskMenu, deleteTask: deleteTask, scheduleTask: scheduleTask, openRef: openRef, applyPrefs: applyPrefs,
    quickCapture: quickCapture, saveQuick: saveQuick, loadSample: loadSample, clearSample: clearSample,
    current: function () { return cur; }, detailTaskId: function () { return detailTaskId; },
    nav: function () { return NAV.map(function (n) { return Object.assign({}, n); }); }
  };
  DN.views = DN.views || {};
  document.addEventListener('DOMContentLoaded', start);
})();
