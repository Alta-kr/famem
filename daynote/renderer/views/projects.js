'use strict';

// 프로젝트 히스토리 — 프로젝트별 개요, 남은 할 일, 연결된 메모, 그리고 자동/직접 기록 타임라인.
//
//  - 자동 기록(완료·완료 취소)은 고칠 수 없다. 직접 작성한 기록만 수정·삭제한다.
//  - 참조는 지금 이름으로 보여 주고, 원본이 지워졌으면 기록 당시 이름과 함께 "원본 삭제됨" 이라고 말한다.
//  - 작성 중인 기록 초안과 필터는 화면을 다시 그려도 남는다 (모듈 변수에 보관).

(function () {
  var DN = window.Daynote;
  var M = DN.model, D = DN.dates, S = DN.store, ui = DN.ui, h = ui.h;

  var NONE = '__none__';   // "프로젝트 없음" 기록
  var TASK_LIMIT = 8;
  var TYPE_ICON = { task_done: 'check', task_reopened: 'undo', decision: 'flag', update: 'edit', achievement: 'star', blocker: 'alert' };
  var TYPE_FILTERS = [
    { id: 'all', label: '전체' }, { id: 'done', label: '완료' }, { id: 'decision', label: '결정' },
    { id: 'update', label: '업데이트' }, { id: 'achievement', label: '성과' }, { id: 'blocker', label: '장애물' }
  ];
  var ORIGIN_FILTERS = [{ id: 'all', label: '전체' }, { id: 'auto', label: '자동' }, { id: 'manual', label: '직접' }];

  // 화면을 다시 그려도 유지되는 값
  var view = { selected: null, filter: { type: 'all', origin: 'all', before: '' }, drafts: {} };

  function A() { return DN.app; }
  function now() { return A().now(); }

  function draftFor(pid) {
    if (!view.drafts[pid]) view.drafts[pid] = { type: 'update', title: '', body: '', date: '', refs: {} };
    return view.drafts[pid];
  }

  function projectIdOf(sel) { return sel === NONE ? null : sel; }
  function inProject(item, sel) { return (item.projectId || null) === projectIdOf(sel); }

  function pickSelected(st, params) {
    var live = M.liveProjects(st);
    var want = params && params.projectId !== undefined ? (params.projectId || NONE) : view.selected;
    if (want === NONE) return NONE;
    if (want && live.some(function (p) { return p.id === want; })) return want;
    return live.length ? live[0].id : NONE;
  }

  // ------------------------------------------------------------------ 왼쪽 목록
  function renderList(listEl, st, sel, select) {
    listEl.textContent = '';
    listEl.appendChild(h('h2', '프로젝트'));
    var open = function (pid) {
      return M.liveTasks(st).filter(function (t) { return t.status !== 'done' && (t.projectId || null) === pid; }).length;
    };
    M.liveProjects(st).forEach(function (p) {
      var n = open(p.id);
      listEl.appendChild(h('button.proj-item', {
        type: 'button', 'aria-current': sel === p.id ? 'true' : null, onclick: function () { select(p.id); }
      }, h('span.dot', { style: { background: p.color }, 'aria-hidden': 'true' }), h('span.n', p.name || '(이름 없음)'),
        n ? h('span.meta', { 'aria-label': '남은 할 일 ' + n + '개' }, String(n)) : null));
    });
    listEl.appendChild(h('button.proj-item', {
      type: 'button', 'aria-current': sel === NONE ? 'true' : null, onclick: function () { select(NONE); }
    }, h('span.dot', { style: { background: 'var(--border-input)' }, 'aria-hidden': 'true' }), h('span.n.muted', '프로젝트 없음')));
    listEl.appendChild(h('button.btn.btn-ghost.btn-sm', { type: 'button', style: { marginTop: '8px' }, onclick: newProject }, ui.icon('plus'), '새 프로젝트'));
  }

  function newProject() {
    var input = h('input.input', { placeholder: '예) 하반기 채용', 'aria-label': '프로젝트 이름', autofocus: true });
    function save() {
      var name = input.value.trim();
      if (!name) { ui.toast('프로젝트 이름을 입력해 주세요.'); return false; }
      var p = S.mutate('프로젝트 만들기', function (s) { return M.addProject(s, { name: name }, now()); });
      view.selected = p.id;
      A().go('projects', { projectId: p.id });
      ui.undoToast('‘' + name + '’ 프로젝트를 만들었습니다.');
    }
    var m = ui.modal({
      title: '새 프로젝트', body: h('div.field', h('label', '이름'), input),
      actions: [{ label: '취소' }, { label: '만들기', primary: true, onClick: save }]
    });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) { if (save() !== false) m.close(); } });
  }

  // ------------------------------------------------------------------ 머리글 · 개요
  function renderHead(st, sel) {
    if (sel === NONE) {
      return h('div.page-head', h('div',
        h('h1.page-title', '프로젝트 없음'),
        h('div.page-sub', '프로젝트를 정하지 않은 할 일과 기록입니다.')));
    }
    var p = M.byId(st.projects, sel);
    var name = h('input.proj-title-input', { value: p.name, 'aria-label': '프로젝트 이름', maxlength: '80' });
    var desc = h('textarea.textarea.proj-desc', { rows: 2, placeholder: '프로젝트 설명 (선택)', 'aria-label': '프로젝트 설명' });
    desc.value = p.description || '';
    function saveName() {
      var v = name.value.trim();
      if (!v) { name.value = p.name; return; }
      if (v !== p.name) S.mutate('프로젝트 이름 변경', function (s) { M.byId(s.projects, sel).name = v; }, { source: 'projects' });
    }
    function saveDesc() {
      if (desc.value !== (p.description || '')) S.mutate('프로젝트 설명 변경', function (s) { M.byId(s.projects, sel).description = desc.value; }, { source: 'projects' });
    }
    name.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); name.blur(); }
      if (e.key === 'Escape') { name.value = p.name; name.blur(); }
    });
    name.addEventListener('blur', saveName);
    desc.addEventListener('blur', saveDesc);
    return h('div.proj-head',
      h('div.proj-title-row', h('span.proj-color', { style: { background: p.color }, 'aria-hidden': 'true' }), name,
        p.sample ? h('span.chip.chip-sample', '샘플') : null),
      contextSelect(p),
      desc);
  }

  // 기본 맥락 (STATUS §6.5) — 소속 할 일이 따로 정하지 않으면 이 맥락으로 본다. 현재 상태를 켠 뒤에만 보인다
  function contextSelect(p) {
    var SU = DN.status;
    if (!SU || !SU.isActive || !SU.isActive() || !SU.profile) return null;
    var pf = SU.profile(), curCtx = p.context && pf.contexts[p.context] ? p.context : '';
    var sel = h('select.select.proj-ctx', { id: 'proj-ctx-' + p.id },
      h('option', { value: '', selected: !curCtx }, '정하지 않음'),
      pf.contextIds.map(function (id) { return h('option', { value: id, selected: curCtx === id }, pf.contexts[id].label); }));
    sel.addEventListener('change', function () {
      var v = sel.value || null, pid = p.id;
      S.mutate('프로젝트 맥락 바꾸기', function (s) { var x = M.byId(s.projects, pid); if (x) x.context = v; }, { source: 'projects' });
      var lab = v ? pf.contexts[v].label : null;
      ui.undoToast(lab ? '‘' + p.name + '’ 할 일은 ' + ui.josa(lab, '로/으로') + ' 볼게요.' : '‘' + p.name + '’의 기본 맥락을 지웠어요.');
    });
    return h('div.proj-ctx-row', h('label.field-label', { 'for': 'proj-ctx-' + p.id }, '기본 맥락'), sel,
      h('span.help', '이 프로젝트의 할 일을 어느 쪽 일로 볼지 정해요. 할 일마다 따로 정한 것이 먼저예요.'));
  }

  function renderOverview(st, sel) {
    var tasks = M.liveTasks(st).filter(function (t) { return inProject(t, sel); });
    var wk = D.startOfWeek(now()).toISOString();
    var stat = function (k, v) { return h('div.card.stat', h('div.k', k), h('div.v', String(v))); };
    return h('div.proj-overview',
      stat('진행 중', tasks.filter(function (t) { return t.status === 'in_progress'; }).length),
      stat('남은 할 일', tasks.filter(function (t) { return t.status !== 'done'; }).length),
      stat('이번 주 완료', tasks.filter(function (t) { return t.status === 'done' && t.completedAt && t.completedAt >= wk; }).length));
  }

  function renderTasks(st, sel) {
    var open = M.liveTasks(st).filter(function (t) { return inProject(t, sel) && t.status !== 'done'; })
      .sort(function (a, b) {
        var ar = a.status === 'in_progress' ? 0 : 1, br = b.status === 'in_progress' ? 0 : 1;
        if (ar !== br) return ar - br;
        var ad = a.dueDate || '9999', bd = b.dueDate || '9999';
        return ad < bd ? -1 : ad > bd ? 1 : (a.createdAt < b.createdAt ? -1 : 1);
      });
    var wrap = h('section.proj-section', h('div.proj-section-head', h('h2.panel-title', '남은 할 일'), h('span.meta', open.length + '개')));
    if (!open.length) { wrap.appendChild(h('p.muted.proj-none', '남은 할 일이 없습니다.')); return wrap; }
    var list = h('ul.task-list');
    var selId = A().detailTaskId();
    open.slice(0, TASK_LIMIT).forEach(function (t) { list.appendChild(ui.taskRow(st, t, { hideProject: true, selected: t.id === selId })); });
    wrap.appendChild(list);
    wrap.appendChild(h('button.link-btn.proj-more', { type: 'button', onclick: function () { A().go('tasks', { projectId: projectIdOf(sel) }); } },
      open.length > TASK_LIMIT ? '할 일 화면에서 모두 보기 (' + open.length + '개)' : '할 일 화면에서 모두 보기'));
    return wrap;
  }

  function renderNotes(st, sel) {
    var notes = M.liveNotes(st).filter(function (n) { return inProject(n, sel); })
      .sort(function (a, b) { return a.updatedAt < b.updatedAt ? 1 : -1; });
    var wrap = h('section.proj-section', h('div.proj-section-head', h('h2.panel-title', '연결된 메모'), h('span.meta', notes.length + '개')));
    if (!notes.length) { wrap.appendChild(h('p.muted.proj-none', '이 프로젝트에 연결된 메모가 없습니다.')); return wrap; }
    var list = h('ul.proj-notes');
    notes.forEach(function (n) {
      list.appendChild(h('li', h('button.proj-note', { type: 'button', onclick: function () { A().go('notes', { noteId: n.id }); } },
        ui.icon('note'), h('span.n', M.noteTitle(n)), h('span.meta', D.relDay(D.ymd(n.updatedAt), now())))));
    });
    wrap.appendChild(list);
    return wrap;
  }

  // ------------------------------------------------------------------ 직접 기록
  function refCandidates(st, sel) {
    var pid = projectIdOf(sel);
    var tasks = M.liveTasks(st).slice().sort(function (a, b) { return a.updatedAt < b.updatedAt ? 1 : -1; });
    var notes = M.liveNotes(st).slice().sort(function (a, b) { return a.updatedAt < b.updatedAt ? 1 : -1; });
    var mine = [], others = [];
    tasks.forEach(function (t) { ((t.projectId || null) === pid ? mine : others).push({ kind: 'task', id: t.id, label: t.title }); });
    notes.forEach(function (n) { ((n.projectId || null) === pid ? mine : others).push({ kind: 'note', id: n.id, label: M.noteTitle(n) }); });
    return { mine: mine, others: others.slice(0, 10) };
  }

  function renderCompose(st, sel) {
    var d = draftFor(sel);
    var today = D.ymd(now());
    var type = h('select.select.compose-type', { 'aria-label': '기록 유형' },
      M.MANUAL_HISTORY_TYPES.map(function (k) { return h('option', { value: k, selected: d.type === k }, M.HISTORY_TYPES[k]); }));
    var title = h('input.input', { placeholder: '무엇이 있었나요? 예) 설문 문항을 10개로 줄이기로 결정', 'aria-label': '기록 제목', value: d.title });
    var body = h('textarea.textarea', { rows: 3, placeholder: '자세한 내용 (선택)', 'aria-label': '기록 내용' });
    body.value = d.body;
    var date = h('input.input.compose-date', { type: 'date', 'aria-label': '날짜', value: d.date || today, max: today });

    type.addEventListener('change', function () { d.type = type.value; });
    title.addEventListener('input', function () { d.title = title.value; });
    body.addEventListener('input', function () { d.body = body.value; });
    date.addEventListener('change', function () { d.date = date.value === today ? '' : date.value; });

    var cands = refCandidates(st, sel);
    function chip(r) {
      var key = r.kind + ':' + r.id;
      var cb = h('input', { type: 'checkbox', checked: !!d.refs[key] });
      cb.addEventListener('change', function () { if (cb.checked) d.refs[key] = r; else delete d.refs[key]; });
      return h('label', cb, ui.icon(r.kind === 'task' ? 'task' : 'note'), r.label || '(제목 없음)');
    }
    var picker = h('div.ref-picker', { role: 'group', 'aria-label': '관련 메모·할 일' }, cands.mine.map(chip));
    var more = null;
    if (cands.others.length) {
      var othersBox = h('div.ref-picker', { hidden: true }, cands.others.map(chip));
      var anyOtherChecked = cands.others.some(function (r) { return d.refs[r.kind + ':' + r.id]; });
      if (anyOtherChecked) othersBox.hidden = false;
      more = h('div', h('button.link-btn.meta', { type: 'button', onclick: function () { othersBox.hidden = !othersBox.hidden; } }, '다른 프로젝트 항목도 보기'), othersBox);
    }

    function submit() {
      var t = title.value.trim();
      if (!t) { ui.toast('기록 제목을 입력해 주세요.'); title.focus(); return; }
      var day = date.value || today;
      var at = day === today ? now() : D.parseYmd(day, '12:00');
      var refs = Object.keys(d.refs).map(function (k) { var r = d.refs[k]; return { kind: r.kind, id: r.id, label: r.label }; });
      var typeLabel = M.HISTORY_TYPES[type.value];
      S.mutate('기록 추가', function (s) {
        M.addHistory(s, { projectId: projectIdOf(sel), type: type.value, origin: 'manual', title: t, body: body.value.trim(), refs: refs }, at);
      });
      delete view.drafts[sel];
      ui.undoToast('‘' + typeLabel + '’ 기록을 남겼습니다.');
    }
    title.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); } });
    body.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } });

    return h('section.card.compose', { 'aria-label': '히스토리 직접 기록' },
      h('div.panel-title', '기록 남기기'),
      h('div.row', type, date, h('div', { style: { flex: '1 1 260px' } }, title)),
      body,
      cands.mine.length || cands.others.length ? h('div.field', h('span.field-label', '관련 메모·할 일'), picker, more) : null,
      h('div.row', h('span.help', 'Ctrl+Enter로 저장'), h('button.btn.btn-primary.btn-sm', { type: 'button', style: { marginLeft: 'auto' }, onclick: submit }, '기록 저장')));
  }

  // ------------------------------------------------------------------ 타임라인
  function matches(hi, f) {
    if (f.type === 'done' && hi.type !== 'task_done' && hi.type !== 'task_reopened') return false;
    if (f.type !== 'all' && f.type !== 'done' && hi.type !== f.type) return false;
    if (f.origin === 'auto' && hi.origin !== 'auto') return false;
    if (f.origin === 'manual' && hi.origin !== 'manual') return false;
    if (f.before && hi.at > D.endOfDay(D.parseYmd(f.before)).toISOString()) return false;
    return true;
  }

  function renderFilters(rerender) {
    var f = view.filter;
    function seg(label, items, key) {
      return h('div.seg', { role: 'group', 'aria-label': label }, items.map(function (it) {
        return h('button', { type: 'button', 'aria-pressed': f[key] === it.id ? 'true' : 'false', onclick: function () { f[key] = it.id; rerender(); } }, it.label);
      }));
    }
    var before = h('input.input.compose-date', { type: 'date', 'aria-label': '이 날짜 이전 기록 보기', value: f.before });
    before.addEventListener('change', function () { f.before = before.value; rerender(); });
    return h('div.tl-filters',
      seg('유형', TYPE_FILTERS, 'type'),
      seg('출처', ORIGIN_FILTERS, 'origin'),
      h('label.tl-before', h('span.meta', '이 날짜 이전'), before,
        f.before ? h('button.btn.btn-ghost.btn-xs', { type: 'button', onclick: function () { f.before = ''; rerender(); } }, '처음부터') : null));
  }

  function refLink(st, ref) {
    var r = M.resolveRef(st, ref);
    if (r.missing) {
      return h('span.ref-link.is-missing', { title: '원본이 삭제되어 열 수 없습니다' }, ui.icon(ref.kind === 'task' ? 'task' : ref.kind === 'email' ? 'mail' : 'note'),
        '원본 삭제됨: ' + (ref.label || '(이름 없음)'));
    }
    return h('button.ref-link', { type: 'button', onclick: function () { A().openRef(ref); } },
      ui.icon(r.kind === 'task' ? 'task' : r.kind === 'email' ? 'mail' : r.kind === 'project' ? 'project' : 'note'), r.label || '(제목 없음)');
  }

  function renderItem(st, hi) {
    var auto = hi.origin !== 'manual';
    var revoked = hi.type === 'task_done' && hi.revokedAt;
    var at = new Date(hi.at);
    var actions = null;
    if (!auto) {
      actions = h('div.tl-actions',
        h('button.icon-btn', { type: 'button', title: '수정', 'aria-label': '‘' + hi.title + '’ 기록 수정', onclick: function () { editHistory(hi.id); } }, ui.icon('edit')),
        h('button.icon-btn', { type: 'button', title: '삭제', 'aria-label': '‘' + hi.title + '’ 기록 삭제', onclick: function () { deleteHistory(hi.id); } }, ui.icon('trash')));
    }
    return h('li.tl-item' + (auto ? '.is-auto' : '') + (revoked ? '.is-revoked' : ''),
      h('span.tl-icon.t-' + hi.type, { 'aria-hidden': 'true' }, ui.icon(TYPE_ICON[hi.type] || 'edit')),
      h('div.tl-body',
        h('div.tl-top',
          h('span.tl-title', hi.title || '(제목 없음)'),
          h('span.chip', M.HISTORY_TYPES[hi.type] || hi.type),
          h('span.chip' + (auto ? '.chip-auto' : '.chip-manual'), auto ? '자동 기록' : '직접 작성'),
          revoked ? h('span.chip.chip-waiting', '완료 취소됨') : null,
          !auto && hi.editedAt ? h('span.meta', { title: '수정 ' + D.ymd(hi.editedAt) + ' ' + D.hm(hi.editedAt) }, '수정됨') : null,
          hi.sample ? h('span.chip.chip-sample', '샘플') : null,
          h('span.tl-time', D.hm(at))),
        hi.body ? h('div.tl-text', hi.body) : null,
        hi.refs && hi.refs.length ? h('div.tl-refs', hi.refs.map(function (r) { return refLink(st, r); })) : null),
      actions);
  }

  function renderTimeline(st, sel, rerender) {
    var all = st.history.filter(function (x) { return inProject(x, sel); });
    var items = all.filter(function (x) { return matches(x, view.filter); })
      .sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : (a.id < b.id ? 1 : -1); });
    var wrap = h('section.proj-section', { 'aria-label': '히스토리' },
      h('div.proj-section-head', h('h2.panel-title', '히스토리'), h('span.meta', items.length + '개')),
      renderFilters(rerender));
    if (!all.length) {
      wrap.appendChild(h('div.empty', h('h3', '아직 기록이 없습니다'), '할 일을 완료하면 자동으로 기록되고, 결정·성과·장애물은 위에서 직접 남길 수 있습니다.'));
      return wrap;
    }
    if (!items.length) {
      wrap.appendChild(h('div.empty', '조건에 맞는 기록이 없습니다.',
        h('div', h('button.btn.btn-sm', { type: 'button', onclick: function () { view.filter = { type: 'all', origin: 'all', before: '' }; rerender(); } }, '필터 지우기'))));
      return wrap;
    }
    var tl = h('div.timeline');
    var n = now(), lastDay = null, list = null;
    items.forEach(function (hi) {
      var day = D.ymd(hi.at);
      if (day !== lastDay) {
        lastDay = day;
        var rel = D.relDay(day, n);
        var full = D.shortDay(D.parseYmd(day));
        tl.appendChild(h('h3.tl-day', rel && rel !== full ? rel + ' · ' + full : full));
        list = h('ul.tl-list');
        tl.appendChild(list);
      }
      list.appendChild(renderItem(st, hi));
    });
    wrap.appendChild(tl);
    return wrap;
  }

  function editHistory(id) {
    var hi = M.byId(S.state.history, id);
    if (!hi || hi.origin !== 'manual') return;
    var type = h('select.select', { 'aria-label': '기록 유형' },
      M.MANUAL_HISTORY_TYPES.map(function (k) { return h('option', { value: k, selected: hi.type === k }, M.HISTORY_TYPES[k]); }));
    var title = h('input.input', { value: hi.title, 'aria-label': '기록 제목' });
    var body = h('textarea.textarea', { rows: 4, 'aria-label': '기록 내용' });
    body.value = hi.body || '';
    ui.modal({
      title: '기록 수정',
      body: [h('div.field', h('label', '유형'), type), h('div.field', h('label', '제목'), title), h('div.field', h('label', '내용'), body)],
      actions: [{ label: '취소' }, {
        label: '저장', primary: true, onClick: function () {
          var t = title.value.trim();
          if (!t) { ui.toast('기록 제목을 입력해 주세요.'); return false; }
          S.mutate('기록 수정', function (s) { M.updateHistory(s, id, { type: type.value, title: t, body: body.value.trim() }, now()); });
          ui.undoToast('기록을 수정했습니다.');
        }
      }]
    });
  }

  function deleteHistory(id) {
    var hi = M.byId(S.state.history, id);
    if (!hi || hi.origin !== 'manual') return;
    ui.confirm('기록 삭제', '‘' + hi.title + '’ 기록을 삭제할까요? 연결된 메모나 할 일은 지워지지 않습니다.', '삭제').then(function (ok) {
      if (!ok) return;
      S.mutate('기록 삭제', function (s) { M.deleteHistory(s, id); });
      ui.undoToast('기록을 삭제했습니다.');
    });
  }

  // ------------------------------------------------------------------ 화면
  function render(root, params) {
    var st = S.state;
    var sel = view.selected = pickSelected(st, params);
    var listEl = h('nav.proj-list', { 'aria-label': '프로젝트 목록', 'data-keep-scroll': 'proj-list' });
    var mainEl = h('div.proj-main', { 'data-keep-scroll': 'proj-main' });
    root.appendChild(h('div.proj-layout', listEl, mainEl));

    function select(pid) { view.selected = pid; A().go('projects', { projectId: pid === NONE ? null : pid }); }
    function rerender() {
      var top = mainEl.scrollTop;
      drawMain();
      mainEl.scrollTop = top;
    }
    function drawMain() {
      st = S.state;
      mainEl.textContent = '';
      mainEl.appendChild(h('div.view-pad',
        renderHead(st, sel),
        renderOverview(st, sel),
        h('div.proj-columns', renderTasks(st, sel), renderNotes(st, sel)),
        renderCompose(st, sel),
        renderTimeline(st, sel, rerender)));
    }

    renderList(listEl, st, sel, select);
    drawMain();

    return {
      onChange: function (info) {
        // 이름·설명을 고친 경우: 입력 중인 칸을 다시 그리지 않고 목록만 새로 고친다
        if (info && info.source === 'projects') { renderList(listEl, S.state, sel, select); return true; }
        // 선택한 프로젝트가 없어졌으면(되돌리기 등) 전체를 다시 그린다
        return false;
      }
    };
  }

  DN.views = DN.views || {};
  DN.views.projects = { title: '프로젝트', render: render };
})();
