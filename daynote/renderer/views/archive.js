'use strict';

// 보관함 — 적은 것 모두를 최근 순으로. 날짜별로 묶고, 종류·프로젝트·검색으로 좁힌다.
//   한 줄 = 적은 원문(두 줄까지) + Daynote 가 정리한 종류 칩 + 프로젝트 + 시각
//   줄을 누르면 메모 화면에서 원문을 연다. 할 일(또는 일정) 하나로만 쓰인 글은 그 할 일을 연다.
//   종류 필터는 정리 결과 중 하나라도 그 종류면 보여 준다 (메모 + 할 일로 나뉜 글은 '메모'·'할 일' 둘 다에 나온다).

(function () {
  var DN = window.Daynote;
  var M = DN.model, D = DN.dates, S = DN.store, ui = DN.ui, h = ui.h;
  var KINDS = ['all', 'task', 'event', 'memo', 'idea', 'link'];
  var ORDER = ['memo', 'idea', 'link', 'task', 'event'];
  var NONE = '__none';
  var PAGE = 150;

  var mem = { kind: 'all', projectId: '', query: '', limit: PAGE };

  function when(n) { return (n.capture && n.capture.at) || n.createdAt; }

  // 적은 것 하나 = 메모 하나 (+ 거기서 만든 할 일·일정)
  function entries(st) {
    return M.liveNotes(st).map(function (n) {
      return { note: n, at: when(n), items: DN.capture.items(n) };
    }).sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
  }

  function original(n) {
    var body = String(n.body || '').replace(/\r/g, '').replace(/\n{2,}/g, '\n').trim();
    if (!body) return (n.title || '').trim() || '(내용 없음)';
    if (n.title && n.title.trim() && body.indexOf(n.title.trim()) !== 0) return n.title.trim() + '\n' + body;
    return body;
  }

  function projectIds(e) {
    var ids = [e.note.projectId || null];
    e.items.forEach(function (it) { if (it.ref.kind !== 'note') ids.push(it.item.projectId || null); });
    return ids;
  }

  function matchesFilter(e, f) {
    if (f.kind !== 'all' && !e.items.some(function (it) { return it.kind === f.kind; })) return false;
    if (f.projectId) {
      var ids = projectIds(e);
      if (f.projectId === NONE ? ids.some(Boolean) : ids.indexOf(f.projectId) === -1) return false;
    }
    return true;
  }

  // 검색: 원문 + 만든 할 일·일정 제목. 맞은 할 일·일정 제목을 돌려준다 (원문에 없을 때 줄 아래 보여 주려고)
  function matchQuery(e, q) {
    if (!q) return { ok: true, hits: [] };
    var ql = q.toLowerCase();
    var inText = ((e.note.title || '') + '\n' + (e.note.body || '')).toLowerCase().indexOf(ql) !== -1;
    var hits = e.items.filter(function (it) { return it.ref.kind !== 'note' && String(it.item.title || '').toLowerCase().indexOf(ql) !== -1; });
    return { ok: inText || hits.length > 0, hits: inText ? [] : hits };
  }

  function dayHead(ymd, now) {
    var d = D.parseYmd(ymd);
    var rel = D.relDay(ymd, now);
    if (rel === '오늘' || rel === '어제') return rel;
    var label = (d.getMonth() + 1) + '월 ' + d.getDate() + '일 (' + D.WEEKDAYS[d.getDay()] + ')';
    return d.getFullYear() !== now.getFullYear() ? d.getFullYear() + '년 ' + label : label;
  }

  function open(e) {
    var A = DN.app;
    var n = e.note;
    var made = e.items.filter(function (it) { return it.ref.kind !== 'note'; });
    if (n.captureRole === 'task_source' && made.length === 1) {
      if (made[0].kind === 'task') { A.openTask(made[0].item.id); return; }
      if (made[0].kind === 'event') { DN.views.schedule.open({ blockId: made[0].item.id }); return; }
    }
    A.go('notes', { noteId: n.id });
  }

  function render(root, params) {
    var A = DN.app;
    params = params || {};
    if (params.kind && KINDS.indexOf(params.kind) !== -1) mem.kind = params.kind;
    if (params.projectId !== undefined) mem.projectId = params.projectId || '';
    if (params.query !== undefined) mem.query = params.query || '';
    params.kind = undefined; params.projectId = undefined; params.query = undefined;   // 다시 그릴 때는 화면에서 고친 값을 쓴다
    mem.limit = PAGE;

    var wrap = h('div.view-pad.arc');
    root.appendChild(wrap);

    var countEl = h('span.meta');
    wrap.appendChild(h('div.page-head',
      h('div', h('h1.page-title', '보관함'), h('div.page-sub', '적은 것 모두를 최근 순으로 모아 둬요. 원문은 그대로 남아 있어요.')),
      h('div.page-actions', countEl)));

    // ── 필터: 종류 칩 · 프로젝트 · 검색
    var kindBox = h('div.arc-kinds', { role: 'group', 'aria-label': '종류' });
    function paintKinds() {
      kindBox.textContent = '';
      KINDS.forEach(function (k) {
        kindBox.appendChild(h('button.pill.arc-kind' + (k === 'all' ? '' : '.kind-' + k), {
          type: 'button', 'aria-pressed': mem.kind === k ? 'true' : 'false',
          onclick: function () { mem.kind = k; mem.limit = PAGE; paintKinds(); paintList(); }
        }, k === 'all' ? null : h('span.kind-dot', { 'aria-hidden': 'true' }), k === 'all' ? '전체' : ui.KIND_LABEL[k]));
      });
    }
    paintKinds();

    var proj = h('select.select.arc-proj', { 'aria-label': '프로젝트 필터' });
    function paintProjects() {
      proj.textContent = '';
      proj.appendChild(h('option', { value: '' }, '모든 프로젝트'));
      M.liveProjects(S.state).forEach(function (p) { proj.appendChild(h('option', { value: p.id, selected: p.id === mem.projectId }, p.name)); });
      proj.appendChild(h('option', { value: NONE, selected: mem.projectId === NONE }, '프로젝트 없음'));
      if (mem.projectId && !proj.querySelector('option[value="' + mem.projectId + '"]')) mem.projectId = '';
      proj.value = mem.projectId;
    }
    paintProjects();
    proj.addEventListener('change', function () { mem.projectId = proj.value; mem.limit = PAGE; paintList(); });

    var search = h('input.input', { type: 'search', placeholder: '원문·할 일 검색  ( / )', 'aria-label': '보관함 검색', value: mem.query, 'data-slash': '' });
    search.addEventListener('input', function () { mem.query = search.value; mem.limit = PAGE; paintList(); });
    search.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && search.value) { e.stopPropagation(); search.value = ''; mem.query = ''; paintList(); }
      if (e.key === 'ArrowDown') { var first = listBox.querySelector('.arc-row'); if (first) { e.preventDefault(); first.focus(); } }
    });

    wrap.appendChild(h('div.arc-filters', kindBox, h('div.arc-filter-right', proj, h('div.search.arc-search', ui.icon('search'), search))));

    var listBox = h('div.arc-results', { 'aria-live': 'polite' });
    wrap.appendChild(listBox);

    function paintList() {
      var act = document.activeElement;
      var focusId = act && listBox.contains(act) && act.getAttribute('data-note-id');
      draw();
      if (focusId) { var again = listBox.querySelector('.arc-row[data-note-id="' + focusId + '"]'); if (again) again.focus(); }
    }
    function draw() {
      var st = S.state, now = A.now();
      var q = mem.query.trim();
      var all = entries(st);
      var shown = [];
      all.forEach(function (e) {
        if (!matchesFilter(e, mem)) return;
        var mq = matchQuery(e, q);
        if (!mq.ok) return;
        e.hits = mq.hits;
        shown.push(e);
      });
      countEl.textContent = all.length ? (shown.length === all.length ? '모두 ' + all.length + '개' : all.length + '개 중 ' + shown.length + '개') : '';
      listBox.textContent = '';
      if (!shown.length) { listBox.appendChild(emptyState(all.length, q)); return; }

      var groups = [], byDay = {};
      shown.slice(0, mem.limit).forEach(function (e) {
        var day = D.ymd(e.at);
        if (!byDay[day]) { byDay[day] = []; groups.push(day); }
        byDay[day].push(e);
      });
      groups.forEach(function (day) {
        var id = 'arc-day-' + day;
        listBox.appendChild(h('section.arc-day', { 'aria-labelledby': id },
          h('h2.arc-day-head', { id: id }, dayHead(day, now), h('span.count', String(byDay[day].length))),
          h('ul.arc-list', byDay[day].map(function (e) { return h('li', row(e, q, st)); }))));
      });
      if (shown.length > mem.limit) {
        listBox.appendChild(h('div.arc-more', h('button.btn.btn-sm', { type: 'button', onclick: function () { mem.limit += PAGE; paintList(); } },
          '더 보기 (' + (shown.length - mem.limit) + '개 남음)')));
      }
    }

    function row(e, q, st) {
      var n = e.note, c = n.capture || {};
      var count = {};
      e.items.forEach(function (it) { count[it.kind] = (count[it.kind] || 0) + 1; });
      var chips = ORDER.filter(function (k) { return count[k]; }).map(function (k) { return ui.kindChip(k, count[k] > 1 ? ' ' + count[k] : ''); });
      var pid = projectIds(e).filter(Boolean)[0];
      var running = DN.capture.isRunning(n.id) || c.status === 'pending';
      return h('button.arc-row', {
        type: 'button', 'data-note-id': n.id,
        onclick: function () { open(e); },
        onkeydown: function (ev) {
          if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
          ev.preventDefault();
          var rows = Array.prototype.slice.call(listBox.querySelectorAll('.arc-row'));
          var i = rows.indexOf(ev.currentTarget);
          var next = rows[i + (ev.key === 'ArrowDown' ? 1 : -1)];
          if (next) next.focus(); else if (ev.key === 'ArrowUp') search.focus();
        }
      },
        h('div.arc-main',
          h('div.arc-text', ui.highlight(original(n), q)),
          e.hits.length ? h('div.arc-hits', e.hits.slice(0, 2).map(function (it) {
            return h('span', ui.KIND_LABEL[it.kind] + ': ', ui.highlight(it.item.title || '', q));
          })) : null,
          h('div.arc-meta',
            running ? h('span.chip', h('span.spinner', { 'aria-hidden': 'true' }), ' 정리 중') : chips,
            !running && c.status === 'failed' ? h('span.chip.chip-guess', { title: '정리하지 못해 메모로 남겨 둔 글이에요' }, '정리 못 함') : null,
            pid ? ui.projectChip(st, pid) : null,
            n.sample ? h('span.chip.chip-sample', '샘플') : null)),
        h('span.arc-time', D.hm(e.at)));
    }

    function emptyState(total, q) {
      if (!total) {
        return h('div.empty.arc-empty',
          h('h3', '아직 적은 게 없어요'),
          h('div', '오늘 화면에서 생각나는 걸 적으면 여기에 차곡차곡 쌓여요.'),
          h('button.btn.btn-primary', { type: 'button', onclick: function () { DN.app.go('today'); } }, ui.icon('edit'), '적으러 가기'));
      }
      var msg;
      if (q) msg = '‘' + q + '’' + ui.josa(q, '와/과').slice(q.length) + ' 맞는 글이 없어요.';
      else if (mem.kind !== 'all' && mem.projectId) msg = '이 프로젝트에는 ' + ui.josa(ui.KIND_LABEL[mem.kind], '로/으로') + ' 정리된 글이 없어요.';
      else if (mem.kind !== 'all') msg = ui.josa(ui.KIND_LABEL[mem.kind], '로/으로') + ' 정리된 글이 아직 없어요.';
      else msg = mem.projectId === NONE ? '프로젝트 없이 적은 글이 없어요.' : '이 프로젝트로 적은 글이 아직 없어요.';
      return h('div.empty.arc-empty', h('div', msg),
        h('button.btn.btn-sm', { type: 'button', onclick: function () {
          mem.kind = 'all'; mem.projectId = ''; mem.query = ''; search.value = ''; proj.value = '';
          paintKinds(); paintList(); search.focus();
        } }, '필터 지우기'));
    }

    paintList();

    return {
      // 검색 중에도 입력칸을 다시 만들지 않는다 — 목록만 다시 그린다
      onChange: function (info) {
        if (info.type === 'load') return false;
        paintProjects();
        paintList();
        return true;
      }
    };
  }

  DN.views = DN.views || {};
  DN.views.archive = { title: '보관함', render: render };
})();
