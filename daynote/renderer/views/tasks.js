'use strict';

// 할 일 — 모든 할 일을 마감·상태 그룹으로 본다.
//
//  - 마감 그룹(기한 지남·오늘…)과 작업 일정(일정 미배치)은 다른 정보다. 미배치는 행의 칩으로만 보인다.
//  - 완료해도 행이 바로 사라지지 않는다. 이 화면에 머무는 동안 처음 보인 그룹 자리에 줄 그은 채 남는다.
//  - 필터·검색은 다시 그려도 유지된다.

(function () {
  var DN = window.Daynote;
  var M = DN.model, D = DN.dates, S = DN.store, ui = DN.ui, h = ui.h;

  var GROUPS = [
    { id: 'progress', label: '진행 중' },
    { id: 'overdue', label: '기한 지남' },
    { id: 'today', label: '오늘' },
    { id: 'tomorrow', label: '내일' },
    { id: 'week', label: '이번 주 (7일 내)' },
    { id: 'later', label: '이후' },
    { id: 'nodue', label: '마감 없음' },
    { id: 'waiting', label: '대기 · 선행 업무 대기' },
    { id: 'snoozed', label: '미뤄 둔 할 일' },
    { id: 'doneToday', label: '오늘 완료' },
    { id: 'done', label: '완료' }
  ];
  var MODES = [{ id: 'open', label: '남은 일' }, { id: 'done', label: '완료' }, { id: 'all', label: '전체' }];
  var PRIO = { high: 0, normal: 1, low: 2 };

  var filter = { projectId: '', mode: 'open', q: '' };
  // 완료한 행을 제자리에 붙잡아 두는 지도 (taskId → 그룹). 화면에 새로 들어오거나 필터를 바꾸면 비운다.
  var sticky = {};
  var stickyOwner = null;
  var searchCaret = null;   // 다시 그릴 때 검색칸 포커스·커서 복원

  function resetSticky() { sticky = {}; }

  function groupOf(st, t, now) {
    var today = D.ymd(now);
    if (t.status === 'done') return t.completedAt && D.ymd(t.completedAt) === today ? 'doneToday' : 'done';
    if (t.status === 'in_progress') return 'progress';
    if (t.status === 'waiting' || M.unmetBlockers(st, t).length) return 'waiting';
    if (t.snoozedUntil && new Date(t.snoozedUntil) > now) return 'snoozed';
    if (!t.dueDate) return 'nodue';
    if (D.parseYmd(t.dueDate, t.dueTime || '23:59') < now) return 'overdue';
    var diff = D.dayDiff(now, D.parseYmd(t.dueDate));
    if (diff === 0) return 'today';
    if (diff === 1) return 'tomorrow';
    if (diff <= 7) return 'week';
    return 'later';
  }

  function compare(a, b) {
    if (a.status === 'done' && b.status === 'done' && a._g === 'done') return (a.completedAt || '') < (b.completedAt || '') ? 1 : -1;
    var ad = (a.dueDate || '9999-99-99') + (a.dueTime || '99:99'), bd = (b.dueDate || '9999-99-99') + (b.dueTime || '99:99');
    if (ad !== bd) return ad < bd ? -1 : 1;
    var ap = PRIO[a.priority] != null ? PRIO[a.priority] : 1, bp = PRIO[b.priority] != null ? PRIO[b.priority] : 1;
    if (ap !== bp) return ap - bp;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  }

  function matchesFilter(t) {
    if (filter.projectId && t.projectId !== filter.projectId) return false;
    if (filter.q) {
      var q = filter.q.toLowerCase();
      if ((t.title || '').toLowerCase().indexOf(q) === -1 && (t.memo || '').toLowerCase().indexOf(q) === -1) return false;
    }
    return true;
  }

  // 지금 보기에서 이 할 일이 들어갈 그룹 (null 이면 숨김)
  function placeOf(st, t, now) {
    if (t.status === 'done' && sticky[t.id]) return sticky[t.id];
    var g = groupOf(st, t, now);
    if (filter.mode === 'open' && g === 'done') return null;
    if (filter.mode === 'done' && t.status !== 'done') return null;
    if (filter.mode === 'done') g = 'done';
    else if (filter.mode === 'all' && g === 'doneToday') g = 'done';
    return g;
  }

  function render(root, params) {
    var A = DN.app;
    params = params || {};
    var st = S.state;
    var now = A.now();

    // 다른 화면에서 새로 들어왔으면 붙잡아 둔 행을 비우고, 넘어온 조건을 적용한다
    if (stickyOwner !== A.current()) {
      stickyOwner = A.current();
      resetSticky();
      if (params.projectId !== undefined) filter.projectId = params.projectId || '';
      if (params.filter && MODES.some(function (m) { return m.id === params.filter; })) filter.mode = params.filter;
    }
    if (filter.projectId && !M.byId(st.projects, filter.projectId)) filter.projectId = '';

    var wrap = h('div.view-pad');
    root.appendChild(wrap);

    wrap.appendChild(h('div.page-head',
      h('div', h('h1.page-title', '할 일'), h('div.page-sub', '확정된 할 일을 마감과 상태별로 봅니다.')),
      h('div.page-actions', h('button.btn', {
        type: 'button', onclick: function () {
          A.go('today');
          setTimeout(function () { DN.assistant.next(); }, 0);   // 홈 채팅에 다음 할 일 추천
        }
      }, ui.icon('spark'), '지금 무엇을 할까?'))));

    // ── 툴바
    var proj = h('select.select', { 'aria-label': '프로젝트 필터' }, ui.projectOptions(st, filter.projectId, '모든 프로젝트'));
    proj.addEventListener('change', function () { filter.projectId = proj.value; resetSticky(); redraw(); });
    var seg = h('div.seg', { role: 'group', 'aria-label': '보기' }, MODES.map(function (m) {
      return h('button', { type: 'button', 'aria-pressed': filter.mode === m.id ? 'true' : 'false', onclick: function () { filter.mode = m.id; resetSticky(); redraw(); } }, m.label);
    }));
    var search = h('input.input.task-search', { type: 'search', placeholder: '제목·메모 검색 ( / )', 'aria-label': '할 일 검색', value: filter.q });
    search.addEventListener('input', function () { filter.q = search.value; resetSticky(); drawList(); });
    search.addEventListener('keydown', function (e) { if (e.key === 'Escape' && search.value) { e.stopPropagation(); search.value = ''; filter.q = ''; drawList(); } });
    wrap.appendChild(h('div.toolbar', proj, seg, h('div', { style: { flex: '1 1 200px', maxWidth: '320px', marginLeft: 'auto' } }, search)));

    // ── 추가 행
    var add = h('input', { placeholder: '할 일 추가 (Enter · 끝에 ! 를 붙이면 우선순위 높음)', 'aria-label': '할 일 추가' });
    add.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.isComposing) return;
      var v = add.value.trim();
      if (!v) return;
      var high = /!$/.test(v);
      var title = v.replace(/\s*!+$/, '').trim();
      if (!title) return;
      S.mutate('할 일 추가', function (s) {
        M.addTask(s, { title: title, projectId: filter.projectId || null, priority: high ? 'high' : null }, A.now());
      });
      setTimeout(function () { var f = document.querySelector('[aria-label="할 일 추가"]'); if (f) f.focus(); }, 0);
    });
    wrap.appendChild(h('div.add-row', { style: { marginBottom: '16px' } }, ui.icon('plus'), add));

    var listBox = h('div.task-groups');
    wrap.appendChild(listBox);

    function redraw() { A.refresh(); }   // 같은 화면을 스크롤 유지하며 다시 그린다 (sticky 는 호출하는 쪽에서 비운다)

    function drawList() {
      st = S.state;
      now = A.now();
      listBox.textContent = '';
      var live = M.liveTasks(st);
      if (!live.length) {
        listBox.appendChild(h('div.empty',
          h('h3', '아직 할 일이 없습니다'),
          '위 칸에 바로 적거나, 메모에서 할 일을 만들거나, 메모·메일에서 찾은 제안을 확인해 보세요.',
          h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'center' } },
            h('button.btn', { type: 'button', onclick: function () { A.go('notes'); } }, ui.icon('note'), '메모에서 할 일 만들기'),
            h('button.btn', { type: 'button', onclick: function () { A.go('inbox'); } }, ui.icon('inbox'), '새 할 일 제안 보기'))));
        return;
      }
      var buckets = {};
      live.forEach(function (t) {
        if (!matchesFilter(t)) return;
        var g = placeOf(st, t, now);
        if (!g) return;
        sticky[t.id] = g;
        t = Object.create(t); t._g = g;   // 정렬용 표시만 붙이고 원본은 건드리지 않는다
        (buckets[g] = buckets[g] || []).push(t);
      });
      var sel = A.detailTaskId();
      var shown = 0;
      GROUPS.forEach(function (g) {
        var items = buckets[g.id];
        if (!items || !items.length) return;
        items.sort(compare);
        shown += items.length;
        var open = items.filter(function (t) { return t.status !== 'done'; }).length;
        listBox.appendChild(h('section.task-group', { 'aria-label': g.label },
          h('div.task-group-head', h('span', g.label), h('span.count', String(g.id === 'done' || g.id === 'doneToday' ? items.length : open))),
          h('ul.task-list', items.map(function (t) {
            var real = M.byId(st.tasks, t.id);
            return ui.taskRow(st, real, { selected: real.id === sel });
          }))));
      });
      if (!shown) {
        listBox.appendChild(h('div.empty',
          filter.mode === 'done' && !filter.q && !filter.projectId ? '아직 완료한 할 일이 없습니다.' : '조건에 맞는 할 일이 없습니다.',
          filter.q || filter.projectId || filter.mode !== 'open'
            ? h('div', h('button.btn.btn-sm', { type: 'button', onclick: function () { filter = { projectId: '', mode: 'open', q: '' }; resetSticky(); redraw(); } }, '필터 지우기'))
            : null));
      }
    }
    drawList();

    // 다시 그리기 전에 검색칸에 있었으면 포커스와 커서를 돌려준다
    if (searchCaret) {
      search.focus();
      try { search.setSelectionRange(searchCaret[0], searchCaret[1]); } catch (e) {}
      searchCaret = null;
    }

    function onKey(e) {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      var tg = e.target;
      if (/INPUT|TEXTAREA|SELECT/.test(tg.tagName) || tg.isContentEditable || document.querySelector('.overlay')) return;
      e.preventDefault();
      search.focus(); search.select();
    }
    document.addEventListener('keydown', onKey);

    return {
      destroy: function () { document.removeEventListener('keydown', onKey); },
      onChange: function () {
        if (document.activeElement === search) searchCaret = [search.selectionStart, search.selectionEnd];
        return false;
      }
    };
  }

  DN.views = DN.views || {};
  DN.views.tasks = { title: '할 일', render: render };
})();
