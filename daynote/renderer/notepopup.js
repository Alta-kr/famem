'use strict';

// 메모 팝업 — 메모를 누르면 화면을 옮기지 않고 그 자리에서 열어 읽고 고친다.
//   메모 화면과 같은 편집기(라이브 프리뷰). 저장은 [확인](Ctrl+Enter·Ctrl+S) — 고친 채로 X·Esc·바깥을 누르면 저장할지 묻는다
//   [AI로 정리] · [할 일로 이동] 은 고친 내용을 먼저 저장하고 한다. 왼쪽: 삭제 · 메모 화면에서 열기
(function () {
  var DN = window.Daynote;
  var M = DN.model, D = DN.dates, S = DN.store, ui = DN.ui, h = ui.h;
  var cur = null;

  function open(noteId) {
    var n = M.byId(S.state.notes, noteId);
    if (!n || n.deletedAt) { ui.toast('메모를 찾지 못했어요.'); return null; }
    if (cur) { cur.save(); cur.close(); }
    var A = DN.app;
    var status = h('span.np-status', '저장됨');
    function dirty() {
      var x = M.byId(S.state.notes, noteId);
      return !!x && (x.body !== editor.cm.getValue() || (x.title || '') !== titleEl.value);
    }
    // 저장 — 되돌리기 칸 하나 ('메모 고치기')
    function save() {
      var x = M.byId(S.state.notes, noteId);
      if (!x || x.deletedAt || !dirty()) return false;
      var body = editor.cm.getValue(), title = titleEl.value;
      S.mutate('메모 고치기', function (s) {
        var updated = M.updateNote(s, noteId, { body: body, title: title }, A.now());
        DN.aiProposals.refreshStale(s, updated);
      }, { source: 'notepopup' });
      status.textContent = '저장됨'; status.classList.remove('is-dirty');
      return true;
    }
    function markDirty() { var d = dirty(); status.textContent = d ? '고친 내용 있음 — [확인]으로 저장' : '저장됨'; status.classList.toggle('is-dirty', d); }
    var flush = save;

    var autoTitle = M.noteTitle(Object.assign({}, n, { title: '' }));
    var titleEl = h('input.note-title-input.np-title', { value: n.title || '', placeholder: autoTitle === '제목 없는 메모' ? '제목' : '제목 — 비워 두면 “' + autoTitle.slice(0, 30) + '”', 'aria-label': '메모 제목' });
    var ta = h('textarea');
    ta.value = n.body || '';
    var page = h('div.np-page', titleEl, ta);
    var projSlot = h('span.np-proj');
    function drawProj() {
      projSlot.textContent = '';
      var x = M.byId(S.state.notes, noteId);
      if (x) projSlot.appendChild(ui.noteProjectChip(S.state, x, { onChange: drawProj }));
    }
    drawProj();
    var meta = h('div.np-meta',
      projSlot,
      h('span', '적은 날 ' + D.relDay(D.ymd(n.createdAt), A.now()) + ' ' + D.hm(n.createdAt)),
      n.updatedAt && n.updatedAt !== n.createdAt ? h('span', '· 고친 때 ' + D.relDay(D.ymd(n.updatedAt), A.now()) + ' ' + D.hm(n.updatedAt)) : null,
      status);

    function act(fn) { return function () { flush(); m.close(); fn(); }; }
    var m = ui.modal({
      title: '메모', wide: true,
      body: [meta, h('div.np-scroll', page)],
      footLeft: [
        h('button.btn.btn-ghost.btn-sm', { type: 'button', title: '메모 삭제', onclick: act(function () {
          S.mutate('메모 삭제', function (s) { M.deleteNote(s, noteId, A.now()); DN.aiProposals.staleForDeletedNote(s, noteId); });
          ui.undoToast('메모를 삭제했어요.');
        }) }, ui.icon('trash'), '삭제'),
        h('button.btn.btn-ghost.btn-sm', { type: 'button', title: '메모 화면(목록·초안 검토)에서 열기', onclick: act(function () { A.go('notes', { noteId: noteId }); }) }, '메모 화면에서 열기')
      ],
      actions: [
        { label: 'AI로 정리', onClick: function () { save(); quickOrganize(noteId); } },
        { label: '할 일로 이동', onClick: function () { save(); A.memoToTask(noteId); } },
        { label: '확인', primary: true, onClick: function () { if (save()) ui.toast('메모를 저장했어요.'); } }
      ],
      // 고친 채로 닫으려 하면 묻는다 — 저장 · 저장 안 함 · 계속 고치기
      beforeClose: function (close) {
        if (!dirty()) return true;
        if (asking) return false;
        asking = true;
        ui.modal({
          title: '고친 내용을 저장할까요?',
          body: h('p', { style: { margin: 0, lineHeight: 1.6 } }, '‘' + (titleEl.value || autoTitle) + '’에 저장하지 않은 내용이 있어요.'),
          actions: [
            { label: '계속 고치기' },
            { label: '저장 안 함', onClick: function () { setTimeout(close, 0); } },
            { label: '저장', primary: true, onClick: function () { save(); ui.toast('메모를 저장했어요.'); setTimeout(close, 0); } }
          ],
          onClose: function () { asking = false; }
        });
        return false;
      },
      onClose: function () { cur = null; }
    });
    var asking = false;
    m.box.classList.add('np-modal');

    var editor = window.createEditor(ta);
    editor.cm.clearHistory();
    titleEl.addEventListener('input', markDirty);
    titleEl.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); editor.cm.focus(); editor.cm.setCursor(0, 0); } });
    editor.cm.on('changes', markDirty);
    // Ctrl+Enter · Ctrl+S — 저장 ([확인] 과 같다). Esc 는 대화상자가 받아 닫는다 (고쳤으면 물어본다)
    m.box.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.key === 's' || e.key === 'S')) {
        e.preventDefault(); e.stopPropagation();
        if (save()) ui.toast('메모를 저장했어요.');
        if (e.key === 'Enter') m.close();
      }
    }, true);
    setTimeout(function () {
      editor.cm.refresh();
      if (!n.body && !n.title) titleEl.focus();
      else { editor.cm.focus(); editor.cm.setCursor(editor.cm.lineCount(), 0); }
    }, 0);
    cur = { close: m.close, save: save, noteId: noteId };
    return cur;
  }

  // 홈 채팅과 같은 정리 — 메모는 남기고 할 일·일정을 만든다 (Ctrl+Z 한 번)
  function quickOrganize(noteId) {
    if (!DN.aiFlow.status().configured) { ui.toast('AI가 연결되어 있지 않아요. 설정에서 연결하면 바로 정리해요.'); return; }
    var key = M.uid('nq');
    S.mutate(null, function (s) {
      var x = M.byId(s.notes, noteId);
      x.capture = Object.assign({ created: [] }, x.capture || {}, { status: 'pending', error: null, changedByUser: false, kindByUser: false, at: DN.app.now().toISOString() });
    }, { source: 'notes' });
    ui.toast('정리하는 중…');
    DN.capture.classify(noteId, { join: key }).then(function (r) {
      if (r && r.reason === 'undone') return;
      var n = M.byId(S.state.notes, noteId);
      var items = n ? DN.aiProposals.captureItems(S.state, n).filter(function (it) { return it.ref.kind !== 'note'; }) : [];
      var cnt = {}; items.forEach(function (it) { cnt[it.kind] = (cnt[it.kind] || 0) + 1; });
      var parts = [cnt.task ? '할 일 ' + cnt.task + '개' : null, cnt.event ? '일정 ' + cnt.event + '개' : null, cnt.moved ? '날짜 변경 ' + cnt.moved + '개' : null, cnt.done ? '완료 ' + cnt.done + '개' : null].filter(Boolean);
      ui.toast(!r || !r.ok ? '정리하지 못했어요. 메모는 그대로예요.' : parts.length ? parts.join(' · ') + '로 정리했어요.' : '메모로 두는 게 맞아 보여요 — 따로 만든 항목은 없어요.');
    });
  }

  DN.notePopup = { open: open, isOpen: function () { return !!cur; } };
})();
