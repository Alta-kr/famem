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
    els.sidebar = h('aside.sidebar',
      h('div.brand', h('div.brand-mark', { 'aria-hidden': 'true' }, 'D'), h('div.brand-name', 'Daynote'),
        h('button.icon-btn.brand-collapse', { type: 'button', 'aria-label': '사이드바 접기/펴기', title: '사이드바 접기/펴기 (Ctrl+\\)', onclick: toggleSidebar }, ui.icon('sidebar'))),
      els.nav,
      h('div.sidebar-foot', els.navSub, els.save)
    );
    els.banner = h('div');
    els.view = h('div.view', { id: 'view', tabindex: '-1' });
    els.main = h('main.main', els.banner, els.view);
    els.detail = h('div');
    els.shell = h('div.app', els.sidebar, els.main, els.detail);
    root.appendChild(els.shell);

    S.onStatus(renderSave);
  }

  function renderNav() {
    var st = S.state;
    var n = now();
    // 지금 상태에서 숨긴 할 일은 '오늘' 숫자에서 뺀다 (상태 기능을 쓰지 않으면 sv 는 null)
    var sv = DN.status && DN.status.view ? DN.status.view(n) : null;
    var SC = DN.statusCore;
    var counts = {
      today: M.liveTasks(st).filter(function (t) {
        if (sv && SC && SC.isHidden && SC.isHidden(sv, t.id)) return false;
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
    document.title = (v.title || '') + ' · Daynote';
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
  function toggleDone(id) {
    var t = M.byId(S.state.tasks, id);
    if (!t) return;
    if (t.status === 'done') {
      S.mutate('완료 취소', function (s) { M.reopenTask(s, id, now()); });
      ui.undoToast('‘' + t.title + '’ 완료를 취소했습니다. 이전 완료 기록은 히스토리에 ‘취소됨’으로 남습니다.');
    } else {
      S.mutate('완료', function (s) { M.completeTask(s, id, now()); });
      ui.undoToast('‘' + t.title + '’ 완료 · 프로젝트 히스토리에 기록했습니다.');
    }
  }

  // 지금 시작 — 실행 직전 상태를 다시 확인하고, 다른 진행 중 업무가 있으면 전환할지 묻는다
  function startTask(id) {
    var check = DN.recommend.checkStartable(S.state, id, now());
    if (!check.ok) { ui.toast('시작하지 않았습니다: ' + check.reason, { error: true }); return Promise.resolve(false); }
    var t = check.task;
    if (t.status === 'in_progress') { openTask(id); ui.toast('이미 진행 중인 업무입니다. 관련 자료를 열었습니다.'); return Promise.resolve(true); }
    var others = M.liveTasks(S.state).filter(function (o) { return o.id !== id && o.status === 'in_progress'; });
    var ask = others.length
      ? ui.confirm('진행 중인 업무 전환', '‘' + others[0].title + '’' + (others.length > 1 ? ' 외 ' + (others.length - 1) + '개' : '') + '가 진행 중입니다. ‘' + t.title + '’로 전환할까요? 기존 업무는 ‘할 일’ 상태로 돌아가며, 되돌릴 수 있습니다.', '전환하고 시작')
      : Promise.resolve(true);
    return ask.then(function (ok) {
      if (!ok) return false;
      S.mutate('지금 시작', function (s) { M.startTask(s, id, now()); });
      openTask(id, { keepFocus: true });
      ui.undoToast('‘' + t.title + '’ 진행 중으로 바꿨습니다.' + (others.length ? ' 이전 업무는 할 일로 돌렸습니다.' : ''));
      return true;
    });
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
    var items = [{ label: '상세 열기', onClick: function () { openTask(id); } }];
    if (t.status !== 'done') {
      items.push({ label: '지금 시작', onClick: function () { startTask(id); } });
      items.push({ label: '일정에 배치…', onClick: function () { scheduleTask(id); } });
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
    var ta = h('textarea.textarea', { rows: 6, placeholder: '떠오른 생각을 적어 두세요. 분류는 나중에 해도 됩니다.', 'aria-label': '빠른 메모' });
    ta.value = st.quickDraft.text || '';
    var proj = h('select.select', { 'aria-label': '프로젝트 (선택)' }, ui.projectOptions(st, st.quickDraft.projectId, '프로젝트 선택 안 함'));
    var t, saved = false;
    function keep() {
      clearTimeout(t);
      if (saved) return;   // 저장하고 닫을 때는 방금 저장한 글을 초안으로 되살리지 않는다
      t = setTimeout(function () { S.mutate(null, function (s) { s.quickDraft = { text: ta.value, projectId: proj.value || null }; }, { silent: true }); }, 250);
    }
    function save() {
      var r = saveQuick(ta.value, proj.value || null);
      if (r !== false) { saved = true; clearTimeout(t); }
      return r;
    }
    ta.addEventListener('input', keep); proj.addEventListener('change', keep);
    var m = ui.modal({
      title: '빠른 메모',
      body: [ta, h('div.field-row', h('div.field', proj), h('div.help', { style: { alignSelf: 'center' } }, 'Ctrl+Enter로 저장 · 닫아도 초안이 남습니다'))],
      actions: [{ label: '닫기' }, { label: '메모 저장', primary: true, onClick: function () { return save(); } }],
      onClose: keep
    });
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { if (save() !== false) m.close(); } });
  }

  // 입력 저장 — 원문은 바로 메모로 저장되고, AI 가 메모/할 일·프로젝트를 나눠 바로 반영한다 (capture.js)
  // '/할일 …' 같은 명령어와 '퇴근' 같은 상태 보고도 여기서 가른다(홈 입력창의 assistant.send 와 같은 규칙, 결과는 알림으로).
  // opts.silent 이면 알림을 띄우지 않는다.
  function saveQuick(text, projectId, opts) {
    text = String(text || '');
    var quiet = !!(opts && opts.silent);
    function say(msg, o) { if (!quiet) ui.toast(msg, o); }
    var see = { action: { label: '오늘에서 보기', fn: function () { go('today'); } } };
    if (!text.trim()) { ui.toast('내용을 입력해 주세요.'); return false; }
    var p = DN.commands && DN.commands.parse ? DN.commands.parse(text)
      : { command: null, kind: null, args: text.trim(), raw: text, token: null, unknown: null, escaped: false };
    if (p.kind && !p.args) { ui.toast('‘' + p.token + '’ 뒤에 내용을 적어 주세요.'); return false; }
    S.mutate(null, function (s) { s.quickDraft = { text: '', projectId: null }; }, { source: 'today', silent: true });
    var AS = DN.assistant, SU = DN.status, note;
    if (p.command === 'help') {
      go('today');
      if (AS && AS.postHelp) AS.postHelp();
      return true;
    }
    if (p.command === 'status') {
      if (AS && AS.statusCommand) AS.statusCommand(p.args, { surface: 'toast' });
      return true;
    }
    if (p.kind) {
      note = DN.capture.submit(p.args, projectId, null, { command: p });
      var kl = ui.KIND_LABEL[p.kind] || '메모';
      say(ui.josa(kl, '로/으로') + ' 저장했어요.', see);
      return note;
    }
    if (p.escaped) {
      note = DN.capture.submit(p.args, projectId);
      say('저장했어요. AI가 메모인지 할 일인지 나누는 중이에요.', see);
      return note;
    }
    var d = (!p.unknown && SU && SU.detect) ? SU.detect(text) : null;
    if (d && d.tier === 'sure' && d.pure && SU.apply) {
      SU.apply(d, { source: 'text', surface: 'toast', text: text });
      return true;
    }
    if (d && d.tier === 'sure' && SU.apply) {
      SU.apply(d, { source: 'text', surface: 'toast', text: text, quiet: true });
      note = DN.capture.submit(text, projectId, null, { statusLine: d.statusLine });
      say('‘' + d.label + '’' + ui.josa(d.label, '로/으로').slice(d.label.length) + ' 바꾸고, 적은 글은 저장했어요.', see);
      return note;
    }
    if (SU && SU.touch) SU.touch();
    note = DN.capture.submit(text, projectId, null, { statusHint: d && d.tier === 'maybe' && SU.hintFor ? SU.hintFor(d) : null });
    var u = p.unknown;
    say('저장했어요. AI가 메모인지 할 일인지 나누는 중이에요.' +
      (u ? ' · ‘/' + u + '’' + ui.josa(u, '는/은').slice(u.length) + ' 없는 명령어라 그대로 저장했어요' : ''), see);
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
      if (slash) {
        e.preventDefault();
        slash.focus();
        if (slash.tagName === 'TEXTAREA' && !slash.value) {
          // 홈 입력창이 비어 있으면 '/' 를 넣어 명령어 목록을 연다
          slash.value = '/';
          try { slash.setSelectionRange(1, 1); } catch (err) {}
          slash.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (slash.select && slash.tagName === 'INPUT') slash.select();
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !inField) {
      e.preventDefault();
      var l = S.undo();
      ui.toast(l ? '‘' + l + '’을(를) 되돌렸습니다.' : '되돌릴 작업이 없습니다.');
      return;
    }
    if (e.key === 'Escape' && detailTaskId && !inField) { closeDetail(); return; }
  }

  // ------------------------------------------------------------------ 시작
  function start() {
    buildShell();
    S.load().then(function (res) {
      S.subscribe(onStoreChange);
      applyPrefs();
      go('today');
      if (res.recovered) ui.toast('지난번에 저장되지 않은 내용을 복구했습니다.', { duration: 6000 });
    }).catch(function (e) {
      document.getElementById('app').textContent = '데이터를 불러오지 못했습니다: ' + e.message;
    });
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', function () { if (els.shell) applyPrefs(); });
    // 미루기 만료·현재 시각 표시를 위해 1분마다 화면에 알린다
    setInterval(function () {
      if (DN.status && DN.status.tick) { try { DN.status.tick(now()); } catch (e) { console.error(e); } }
      if (cur.handle && cur.handle.onTick) cur.handle.onTick(now());
      renderNav();
    }, 60 * 1000);
  }

  DN.app = {
    now: now, go: go, refresh: function () { renderView(); renderNav(); }, openTask: openTask, closeDetail: closeDetail, toggleDone: toggleDone, startTask: startTask,
    snoozeMenu: snoozeMenu, taskMenu: taskMenu, deleteTask: deleteTask, scheduleTask: scheduleTask, openRef: openRef, applyPrefs: applyPrefs,
    quickCapture: quickCapture, saveQuick: saveQuick, loadSample: loadSample, clearSample: clearSample,
    current: function () { return cur; }, detailTaskId: function () { return detailTaskId; },
    nav: function () { return NAV.map(function (n) { return Object.assign({}, n); }); }
  };
  DN.views = DN.views || {};
  document.addEventListener('DOMContentLoaded', start);
})();
