'use strict';

// 메모 작업 공간 — 검색 가능한 목록 + 라이브 프리뷰 마크다운 편집기(MD_Reflo 엔진).
// 문장을 골라 ‘할 일로 만들기’ 하면 원문 연결(출처)을 가진 Task 가 생긴다.
// 메모 화면은 글 쓰는 곳이라 다른 기능을 늘어놓지 않는다 — 연결된 할 일만 아래에 조용히 보인다.

(function () {
  var DN = window.Daynote;
  var M = DN.model, D = DN.dates, S = DN.store, ui = DN.ui, h = ui.h;
  var SAVE_DELAY = 600;

  var mem = { noteId: null, query: '', review: {} };   // review: 메모별 검토 패널 열림 여부

  function render(root, params) {
    var A = DN.app;
    if (params && params.noteId) { mem.noteId = params.noteId; params.noteId = null; }
    var st = S.state;
    var notes = M.liveNotes(st);
    if (!M.byId(notes, mem.noteId)) mem.noteId = notes[0] ? sortNotes(notes)[0].id : null;

    var listBox = h('div.notes-items', { 'data-keep-scroll': 'notes', role: 'list' });
    var search = h('input.input', { type: 'search', placeholder: '메모 검색', 'aria-label': '메모 검색', value: mem.query });
    search.addEventListener('input', function () { mem.query = search.value; renderList(); });
    var listCol = h('section.notes-list', { 'aria-label': '메모 목록' },
      h('div.notes-list-head',
        h('div.row', h('h2', '메모'), h('button.btn.btn-sm', { type: 'button', onclick: newNote, title: '새 메모' }, ui.icon('plus'), '새 메모')),
        h('div.search', ui.icon('search'), search)),
      listBox);

    var editorCol = h('section.note-editor', { 'aria-label': '메모 편집' });
    var reviewCol = h('div.review-col');
    var layout = h('div.notes-layout', listCol, editorCol, reviewCol);
    root.appendChild(layout);
    root.style.overflow = 'hidden';

    var ed = null;            // { editor, noteId, timer, statusEl, linkedEl }
    var ed_aiBtn = null;
    var unsubStatus = false;

    function sortNotes(list) { return list.slice().sort(function (a, b) { return a.updatedAt < b.updatedAt ? 1 : -1; }); }

    function pendingCount(noteId) {
      return (S.state.proposals || []).filter(function (p) { return p.source && p.source.id === noteId && p.status === 'pending'; }).length;
    }

    function renderList() {
      var q = mem.query.trim().toLowerCase();
      var list = sortNotes(M.liveNotes(S.state)).filter(function (n) {
        if (n.captureRole === 'task_source' && n.id !== mem.noteId) return false;   // 할 일로만 쓰인 입력은 보관함 목록에서 숨김(원문 링크로는 열림)
        return !q || (n.title + '\n' + n.body).toLowerCase().indexOf(q) !== -1;
      });
      listBox.textContent = '';
      if (!list.length) {
        listBox.appendChild(h('div.empty', q ? '‘' + mem.query + '’와 일치하는 메모가 없습니다.' : '아직 메모가 없습니다.'));
        return;
      }
      list.forEach(function (n) {
        var body = n.body.replace(/[#>*`\-\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
        var snippet = body;
        if (q) {
          var i = body.toLowerCase().indexOf(q);
          snippet = i > 20 ? '…' + body.slice(i - 20) : body;
        }
        var linked = M.tasksForNote(S.state, n.id).length;
        listBox.appendChild(h('button.note-item', {
          type: 'button', role: 'listitem', 'aria-current': n.id === mem.noteId ? 'true' : null,
          onclick: function () { open(n.id); }
        },
          h('div.t', ui.highlight(M.noteTitle(n), mem.query.trim())),
          h('div.p', snippet ? ui.highlight(snippet.slice(0, 120), mem.query.trim()) : '내용 없음'),
          h('div.m', D.relDay(D.ymd(n.updatedAt), A.now()) + ' ' + D.hm(n.updatedAt),
            n.projectId ? ui.projectChip(S.state, n.projectId) : null,
            linked ? h('span', '· 할 일 ' + linked) : null,
            pendingCount(n.id) ? h('span.chip.chip-guess', { title: '검토를 기다리는 AI 초안' }, 'AI 초안 ' + pendingCount(n.id)) : null,
            n.sample ? h('span.chip.chip-sample', '샘플') : null)));
      });
    }

    function flushPending() {
      if (ed && ed.timer) { clearTimeout(ed.timer); ed.timer = null; commitBody(); }
    }

    function commitBody() {
      if (!ed) return;
      var body = ed.editor.cm.getValue();
      var title = ed.titleEl.value;
      var n = M.byId(S.state.notes, ed.noteId);
      if (!n || (n.body === body && n.title === title)) { setStatus(); return; }
      S.mutate(null, function (s) {
        var updated = M.updateNote(s, ed.noteId, { body: body, title: title }, A.now());
        DN.aiProposals.refreshStale(s, updated);
      }, { source: 'notes' });
    }

    function scheduleSave() {
      if (!ed) return;
      clearTimeout(ed.timer);
      ed.statusEl.className = 'status';
      ed.statusEl.textContent = '편집 중…';
      ed.timer = setTimeout(function () { ed.timer = null; commitBody(); }, SAVE_DELAY);
    }

    function setStatus() {
      if (!ed) return;
      var s = S.status();
      var el = ed.statusEl;
      el.textContent = '';
      el.className = 'status' + (s.phase === 'error' ? ' is-error' : '');
      if (ed.timer) { el.textContent = '편집 중…'; return; }
      if (s.phase === 'error') {
        el.appendChild(h('span', '저장 실패 · 작성한 내용은 보존 중입니다 '));
        el.appendChild(h('button.btn.btn-xs', { type: 'button', onclick: function () { S.retrySave(); } }, '다시 시도'));
      } else if (s.phase === 'saving' || s.phase === 'pending') el.textContent = '저장 중…';
      else {
        var n = M.byId(S.state.notes, ed.noteId);
        el.textContent = '저장됨' + (n ? ' · ' + D.hm(n.updatedAt) : '');
      }
    }

    function open(id) {
      flushPending();
      mem.noteId = id;
      renderList();
      renderEditor();
      renderReview();
    }

    function newNote() {
      flushPending();
      var n = S.mutate('새 메모', function (s) { return M.addNote(s, {}, A.now()); }, { source: 'notes' });
      mem.query = ''; search.value = '';
      open(n.id);
      setTimeout(function () { if (ed) ed.titleEl.focus(); }, 0);
    }

    function renderEditor() {
      editorCol.textContent = '';
      ed = null;
      var n = M.byId(S.state.notes, mem.noteId);
      if (!n) {
        editorCol.appendChild(h('div.empty', { style: { margin: 'auto' } },
          h('h3', '첫 메모를 작성해 보세요'),
          h('div', '생각나는 대로 적고, 실행할 문장은 골라서 할 일로 바꿀 수 있습니다.'),
          h('button.btn.btn-primary', { type: 'button', onclick: newNote }, '새 메모')));
        return;
      }
      var statusEl = h('div.status', { role: 'status', 'aria-live': 'polite' });
      var proj = h('select.select', { 'aria-label': '메모의 프로젝트' }, ui.projectOptions(S.state, n.projectId));
      proj.addEventListener('change', function () {
        S.mutate('메모 프로젝트 변경', function (s) { M.updateNote(s, n.id, { projectId: proj.value || null }, A.now()); }, { source: 'notes' });
      });
      var aiBtn = h('button.btn.btn-sm.btn-ai', { type: 'button', title: '메모를 정리하고 할 일·일정 초안을 만듭니다. 고른 것만 저장됩니다.', onclick: function () { organize(false); } });
      ed_aiBtn = aiBtn;
      var toolbar = h('div.note-toolbar', proj, aiBtn,
        h('button.btn.btn-sm', { type: 'button', title: '선택한 문장(없으면 지금 줄)을 할 일로 (Ctrl+Shift+T)', onclick: function () { makeTask(); } }, ui.icon('task'), '할 일로 만들기'),
        n.sample ? h('span.chip.chip-sample', '샘플') : null,
        statusEl,
        h('button.icon-btn', { type: 'button', 'aria-label': '메모 삭제', title: '메모 삭제', onclick: deleteNote }, ui.icon('trash')));

      var titleEl = h('input.note-title-input', { value: n.title, placeholder: M.noteTitle(Object.assign({}, n, { title: '' })) === '제목 없는 메모' ? '제목' : M.noteTitle(Object.assign({}, n, { title: '' })), 'aria-label': '메모 제목' });
      var ta = h('textarea');
      ta.value = n.body;
      var page = h('div.page', titleEl, ta);
      var scroller = h('div.editor-scroll', page);
      var linkedEl = h('div.note-linked');
      editorCol.appendChild(toolbar);
      editorCol.appendChild(scroller);
      editorCol.appendChild(linkedEl);

      var editor = window.createEditor(ta);
      editor.cm.clearHistory();
      ed = { editor: editor, noteId: n.id, timer: null, statusEl: statusEl, linkedEl: linkedEl, titleEl: titleEl };
      setStatus();
      renderLinked();

      titleEl.addEventListener('input', scheduleSave);
      titleEl.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); editor.cm.focus(); editor.cm.setCursor(0, 0); } });
      editor.cm.on('changes', scheduleSave);
      editor.cm.addKeyMap({ 'Shift-Ctrl-T': function () { makeTask(); }, 'Shift-Cmd-T': function () { makeTask(); } });
      scroller.addEventListener('mousedown', function (e) {
        if (e.target === scroller || e.target === page) { e.preventDefault(); editor.cm.focus(); editor.cm.setCursor(editor.cm.lineCount(), 0); }
      });

      // 선택하면 작은 ‘할 일로 만들기’ 버튼을 띄운다
      var pop = null;
      function hidePop() { if (pop) { pop.remove(); pop = null; } }
      editor.cm.on('cursorActivity', function (cm) {
        hidePop();
        if (!cm.somethingSelected()) return;
        var text = cm.getSelection().trim();
        if (text.length < 2) return;
        var c = cm.cursorCoords(cm.getCursor('from'), 'local');
        pop = h('div.sel-pop', h('button', { type: 'button', onmousedown: function (e) { e.preventDefault(); }, onclick: function () { hidePop(); makeTask(); } }, ui.icon('task'), '할 일로 만들기'),
          h('span', { style: { color: '#C9CDC6', fontSize: '12px', alignSelf: 'center', paddingRight: '6px' } }, 'Ctrl+Shift+T'));
        pop.style.top = Math.max(0, c.top + cm.getWrapperElement().offsetTop - 42) + 'px';
        pop.style.left = Math.max(0, c.left + cm.getWrapperElement().offsetLeft) + 'px';
        page.appendChild(pop);
      });
      editor.cm.on('blur', function () { setTimeout(hidePop, 150); });

      function makeTask() {
        var cm = editor.cm;
        var raw = cm.somethingSelected() ? cm.getSelection() : cm.getLine(cm.getCursor().line);
        var excerpt = raw.split('\n').map(function (l) { return l.trim(); }).filter(Boolean).join(' ').trim();
        var title = excerpt.replace(/^([-*+]|\d+[.)])\s+/, '').replace(/^\[[ xX]\]\s*/, '').replace(/^#+\s*/, '').replace(/\*\*|__|==|`/g, '').trim();
        if (!title) { ui.toast('할 일로 만들 문장을 선택하거나, 그 줄에 커서를 두세요.'); return; }
        flushPending();
        var note = M.byId(S.state.notes, n.id);
        var dup = M.tasksForNote(S.state, n.id).filter(function (t) { return t.sources.some(function (s) { return s.refId === n.id && s.excerpt === excerpt; }); })[0];
        if (dup) {
          ui.toast('이 문장으로 만든 할 일이 이미 있습니다.', { action: { label: '열기', fn: function () { A.openTask(dup.id); } } });
          return;
        }
        var task = S.mutate('할 일 만들기', function (s) {
          return M.addTask(s, {
            title: title.length > 120 ? title.slice(0, 117) + '…' : title,
            projectId: note.projectId || null,
            sources: [{ type: 'note', refId: n.id, excerpt: excerpt }]
          }, A.now());
        }, { source: 'notes' });
        renderLinked();
        renderList();
        A.openTask(task.id);
        ui.undoToast('할 일을 만들었습니다. 마감일·작업 시간은 오른쪽에서 정하세요. 원문 메모와 연결되어 있습니다.');
      }

      function deleteNote() {
        flushPending();
        var linked = M.tasksForNote(S.state, n.id).length;
        S.mutate('메모 삭제', function (s) { M.deleteNote(s, n.id, A.now()); DN.aiProposals.staleForDeletedNote(s, n.id); });
        ui.undoToast('메모를 삭제했습니다.' + (linked ? ' 연결된 할 일 ' + linked + '개는 남고, 출처는 ‘삭제됨’으로 보입니다.' : ''));
      }

      if (!n.body && !n.title) setTimeout(function () { titleEl.focus(); }, 0);
      else setTimeout(function () { editor.cm.refresh(); }, 0);
    }

    function renderLinked() {
      if (!ed) return;
      var tasks = M.tasksForNote(S.state, ed.noteId);
      var events = S.state.blocks.filter(function (b) { return !b.taskId && (b.sources || []).some(function (s) { return s.type === 'note' && s.refId === ed.noteId; }); });
      ed.linkedEl.textContent = '';
      ed.linkedEl.hidden = !tasks.length && !events.length;
      if (ed.linkedEl.hidden) return;
      var sel = A.detailTaskId();
      ed.linkedEl.appendChild(h('h4', ui.icon('link'), '이 메모에서 만든 항목 · 할 일 ' + tasks.length + (events.length ? ' · 일정 ' + events.length : '')));
      if (tasks.length) ed.linkedEl.appendChild(h('ul.task-list', tasks.map(function (t) { return ui.taskRow(S.state, t, { compact: true, selected: t.id === sel }); })));
      events.forEach(function (b) {
        var cs = M.conflictsFor(S.state, b.start, b.end, b.id).length;
        ed.linkedEl.appendChild(h('button.created-link', { type: 'button', onclick: function () { DN.views.schedule.open({ blockId: b.id }); } },
          h('span.chip.chip-progress', '일정'), h('span.t', b.title),
          h('span.meta', D.relDay(D.ymd(b.start), A.now()) + ' ' + D.hm(b.start) + '–' + D.hm(b.end)),
          cs ? h('span.chip.chip-overlap', '겹침 ' + cs) : null));
      });
    }

    // ---------------------------------------------------------------- AI 정리
    function reviewOpen() {
      var id = mem.noteId;
      if (!id) return false;
      if (id in mem.review) return mem.review[id];
      return !!(DN.aiProposals.digestFor(S.state, id) || DN.aiProposals.forNote(S.state, id).some(function (p) { return p.status === 'pending' || p.status === 'stale'; }));
    }

    function renderReview() {
      var open = reviewOpen();
      layout.classList.toggle('has-review', open);
      reviewCol.hidden = !open;
      updateAiBtn();
      if (!open) { reviewCol.textContent = ''; return; }
      var keep = reviewCol.querySelector('.review-body');
      var scroll = keep ? keep.scrollTop : 0;
      var focusKey = document.activeElement && reviewCol.contains(document.activeElement) ? document.activeElement.getAttribute('data-fk') : null;
      DN.views.review.render(reviewCol, mem.noteId, {
        organize: organize,
        jump: jump,
        close: function () { mem.review[mem.noteId] = false; renderReview(); }
      });
      var body = reviewCol.querySelector('.review-body');
      if (body) body.scrollTop = scroll;
      if (focusKey) { var f = reviewCol.querySelector('[data-fk="' + focusKey + '"]'); if (f) f.focus(); }
    }

    function updateAiBtn() {
      if (!ed_aiBtn) return;
      var running = DN.aiFlow.isRunning(mem.noteId);
      ed_aiBtn.disabled = running;
      ed_aiBtn.textContent = '';
      ed_aiBtn.appendChild(ui.icon('spark'));
      ed_aiBtn.appendChild(document.createTextNode(running ? '정리 중…' : DN.aiProposals.digestFor(S.state, mem.noteId) ? 'AI 다시 정리' : 'AI 정리'));
    }

    // 버튼을 눌렀을 때만 AI 를 부른다. 바뀌지 않은 메모는 지난 결과를 다시 쓴다(force 가 아니면).
    function organize(force) {
      var id = mem.noteId;
      if (!id) return;
      flushPending();
      mem.review[id] = true;
      renderReview();
      DN.aiFlow.organize(id, { force: force }).then(function (r) {
        if (mem.noteId === id) renderReview();
        if (r.ok && r.reused) ui.toast('메모가 바뀌지 않아 지난 정리 결과를 다시 썼습니다. AI를 호출하지 않았습니다.');
        else if (r.ok) {
          var st2 = r.stats;
          ui.toast('정리했습니다. 새 초안 ' + st2.added + '개' + (st2.keptEdited ? ', 직접 고친 초안 ' + st2.keptEdited + '개는 그대로 두었습니다' : '') + (st2.dropped ? ', 근거 없는 항목 ' + st2.dropped + '개는 버렸습니다' : '') + '.');
        }
        else if (r.reason === 'empty') ui.toast('정리할 내용이 없습니다. 메모를 먼저 적어 주세요.');
        else if (r.reason === 'not_configured') ui.toast(r.message || 'AI가 연결되어 있지 않습니다.', { error: true });
        else if (r.reason === 'failed' || r.reason === 'invalid') ui.toast('AI 정리에 실패했습니다. 메모는 안전하게 저장되어 있습니다.', { error: true });
      });
    }

    // 원문 줄로 이동 (0 = 제목, 1부터 본문)
    function jump(line) {
      if (!ed || line == null) return;
      if (line === 0) { ed.titleEl.focus(); return; }
      var cm = ed.editor.cm, ln = Math.min(line - 1, cm.lineCount() - 1);
      cm.focus();
      cm.setCursor({ line: ln, ch: 0 });
      cm.scrollIntoView({ line: ln, ch: 0 }, 120);
      var mk = cm.markText({ line: ln, ch: 0 }, { line: ln, ch: cm.getLine(ln).length }, { className: 'cm-flash' });
      setTimeout(function () { mk.clear(); }, 1600);
    }

    var offAi = DN.aiFlow.onChange(function () { renderReview(); });

    renderList();
    renderEditor();
    renderReview();

    S.onStatus(function () { if (ed && unsubStatus === false) setStatus(); });

    return {
      destroy: function () { flushPending(); unsubStatus = true; offAi(); root.style.overflow = ''; },
      // 편집기는 다시 만들지 않는다 (커서·실행 취소 기록을 지킨다)
      onChange: function (info) {
        if (info.type === 'load' || info.type === 'undo') { ed = null; return false; }
        if (ed && !M.byId(M.liveNotes(S.state), ed.noteId)) { ed = null; return false; }
        renderList();
        renderLinked();
        if (info.source !== 'notes') setStatus();
        if (info.source !== 'review') renderReview(); else updateAiBtn();
        return true;
      }
    };
  }

  DN.views.notes = { title: '메모', render: render };
})();
