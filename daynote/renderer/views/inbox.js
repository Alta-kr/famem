'use strict';

// 새 할 일 제안 추천함 — 메모·메일에서 규칙으로 찾은 "할 일 같은 문장" 을 검토한다.
//
//  - 제안은 확정된 할 일이 아니다. 사용자가 수락해야 Task 가 된다.
//  - 같은 출처의 같은 문장은 다시 만들지 않는다 (model.mergeSuggestions 가 key 로 거른다).
//  - 메일·메모 본문은 데이터다. 화면에는 textContent 로만 넣는다.

(function () {
  var DN = window.Daynote;
  var M = DN.model, D = DN.dates, S = DN.store, ui = DN.ui, h = ui.h;
  var A = function () { return DN.app; };

  var tab = 'pending';
  var editingId = null;
  var lastVisit = null;     // 화면에 들어올 때 한 번만 조용히 다시 확인하려고

  // 탭·수정 폼 전환 — 같은 화면을 스크롤 유지한 채 다시 그린다
  function redraw() { A().refresh(); }

  var TABS = [
    { id: 'pending', label: '검토 대기' },
    { id: 'accepted', label: '수락함' },
    { id: 'dismissed', label: '제외함' }
  ];

  // 메모·메일을 다시 훑어 새 제안만 더한다. 새 것이 없으면 상태를 건드리지 않는다.
  function rescan(quiet) {
    var cands = DN.suggest.scan(S.state, A().now());
    var known = {};
    S.state.suggestions.forEach(function (s) { known[s.key] = true; });
    var fresh = cands.filter(function (c) { return !known[c.key]; });
    if (fresh.length) {
      S.mutate(quiet ? null : '제안 다시 확인', function (s) { M.mergeSuggestions(s, fresh, A().now()); });
    }
    if (!quiet) ui.toast(fresh.length ? '새 제안 ' + fresh.length + '개를 찾았습니다.' : '새로 찾은 제안이 없습니다.');
    return fresh.length;
  }

  function sourceOf(st, s) {
    return M.resolveRef(st, { kind: s.sourceType, id: s.sourceId });
  }

  function openSource(s) {
    var r = sourceOf(S.state, s);
    if (r.missing) { ui.toast('원문이 삭제되어 열 수 없습니다.'); return; }
    if (s.sourceType === 'note') A().go('notes', { noteId: s.sourceId });
    else openEmail(s.sourceId);
  }

  // 메일 원문 — 본문은 pre-wrap 텍스트로만 보여준다
  function openEmail(emailId) {
    var st = S.state;
    var e = M.byId(st.emails, emailId);
    if (!e) { ui.toast('메일을 찾을 수 없습니다.'); return; }
    var from = S.state.suggestions.filter(function (s) { return s.sourceType === 'email' && s.sourceId === e.id; });
    var STATUS = { pending: '검토 대기', accepted: '수락함', dismissed: '제외함' };
    var m = ui.modal({
      title: e.subject || '(제목 없음)',
      wide: true,
      body: [
        h('div.sug-meta',
          h('span', '보낸 사람: ', e.from || '(알 수 없음)'),
          e.receivedAt ? h('span', '받은 시각: ' + D.longDay(e.receivedAt) + ' ' + D.hm(e.receivedAt)) : null,
          e.sample ? h('span.chip.chip-sample', '샘플') : null),
        h('div', {
          style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.65, fontSize: '14px', padding: '12px 14px', background: 'var(--surface-subtle)', borderRadius: 'var(--r-control)', maxHeight: '360px', overflow: 'auto' }
        }, e.body || ''),
        h('div',
          h('div.field-label', '이 메일에서 나온 제안'),
          from.length
            ? h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px' } }, from.map(function (s) {
              return h('li', { style: { marginBottom: '4px' } }, s.title, ' ', h('span.help', '· ' + STATUS[s.status]),
                s.taskId && M.byId(S.state.tasks, s.taskId) && !M.byId(S.state.tasks, s.taskId).deletedAt
                  ? [' ', h('button.link-btn', { type: 'button', onclick: function () { m.close(); A().openTask(s.taskId); } }, '할 일 보기')] : null);
            }))
            : h('div.help', '이 메일에서 찾은 제안이 없습니다.'))
      ],
      actions: [{ label: '닫기' }]
    });
  }

  function render(root) {
    var st = S.state;
    var now = A().now();
    var visit = A().current();
    if (lastVisit !== visit) {
      lastVisit = visit;
      editingId = null;
      setTimeout(function () { if (A().current() === visit) rescan(true); }, 0);
    }

    var counts = { pending: 0, accepted: 0, dismissed: 0 };
    st.suggestions.forEach(function (s) { if (counts[s.status] != null) counts[s.status]++; });

    var head = h('div.page-head',
      h('div',
        h('div.page-title', '새 할 일 제안'),
        h('div.page-sub', '메모와 메일에서 할 일처럼 보이는 문장을 찾아 모았습니다.')),
      h('div.page-actions',
        h('button.btn.btn-sm', { type: 'button', onclick: function () { rescan(false); } }, ui.icon('refresh'), '메모·메일 다시 확인')));

    var notice = h('div.help', { role: 'note', style: { marginBottom: '14px' } },
      '여기 있는 제안은 확정된 할 일이 아니며, 수락해야 할 일이 됩니다. 이미 있는 할 일 중 지금 할 것을 고르는 ‘지금 할 일 추천’과는 다른 기능입니다.');

    var seg = h('div.seg', { role: 'group', 'aria-label': '제안 상태' }, TABS.map(function (t) {
      return h('button', { type: 'button', 'aria-pressed': tab === t.id ? 'true' : 'false', onclick: function () { tab = t.id; editingId = null; redraw(); } },
        t.label + ' ' + counts[t.id]);
    }));

    var list = st.suggestions.filter(function (s) { return s.status === tab; })
      .sort(function (a, b) {
        var ka = a.reviewedAt || a.createdAt || '', kb = b.reviewedAt || b.createdAt || '';
        return tab === 'pending' ? (ka < kb ? -1 : ka > kb ? 1 : 0) : (ka < kb ? 1 : ka > kb ? -1 : 0);
      });

    var body;
    if (!list.length) {
      var EMPTY = {
        pending: ['검토할 제안이 없습니다', '메모에 ‘- [ ] 할 일’ 체크박스를 적거나, 요청이 담긴 메일이 오면 여기에 나타납니다.'],
        accepted: ['수락한 제안이 없습니다', '검토 대기 탭에서 제안을 수락하면 할 일로 만들어지고 여기에 남습니다.'],
        dismissed: ['제외한 제안이 없습니다', '제외한 제안은 여기서 다시 검토할 수 있습니다.']
      }[tab];
      body = h('div.empty', h('h3', EMPTY[0]), h('p', EMPTY[1]),
        tab === 'pending' && !st.meta.sampleLoaded && !st.notes.length && !st.emails.length
          ? h('button.btn', { type: 'button', onclick: function () { A().loadSample(); } }, '샘플 데이터로 둘러보기') : null);
    } else {
      body = h('div', list.map(function (s) { return card(st, s, now); }));
    }

    root.appendChild(h('div.view-pad', head, notice, h('div', { style: { marginBottom: '14px' } }, seg), body));
    return {};
  }

  function card(st, s, now) {
    var src = sourceOf(st, s);
    var task = s.taskId ? M.byId(st.tasks, s.taskId) : null;
    var taskGone = s.taskDeleted || (s.taskId && (!task || task.deletedAt));
    var isMail = s.sourceType === 'email';

    var meta = h('div.sug-meta',
      h('span', ui.icon(isMail ? 'mail' : 'note'), ' ', isMail ? '메일' : '메모', ' · ', src.label || '(제목 없음)'),
      src.missing ? h('span.chip.chip-missing', '원문 삭제됨')
        : h('button.link-btn', { type: 'button', onclick: function () { openSource(s); } }, '원문 보기'));

    var reason = h('div.sug-meta', { style: { marginTop: '4px' } }, h('span', '추천 이유: ', s.reason || ''));

    var dateLine = null;
    if (s.dueDate) {
      dateLine = h('div.sug-meta', { style: { marginTop: '4px' } },
        h('span', '제안 날짜: ' + D.relDay(s.dueDate, now)),
        s.dueEstimated ? h('span.chip.chip-guess', { title: s.dueHint ? '‘' + s.dueHint + '’에서 추정' : null }, '추정 날짜 · 확인 필요') : null);
    }

    var actions = h('div.sug-actions');
    if (s.status === 'pending') {
      actions.appendChild(h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: function () { accept(s, null); } }, ui.icon('check'), '수락'));
      actions.appendChild(h('button.btn.btn-sm', { type: 'button', 'aria-expanded': editingId === s.id ? 'true' : 'false', onclick: function () { editingId = editingId === s.id ? null : s.id; redraw(); } }, ui.icon('edit'), '수정 후 수락'));
      actions.appendChild(h('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: function () { dismiss(s); } }, '제외'));
    } else if (s.status === 'accepted') {
      if (taskGone) actions.appendChild(h('span.chip.chip-missing', '만든 할 일이 삭제됨'));
      else if (task) actions.appendChild(h('button.btn.btn-sm', { type: 'button', onclick: function () { A().openTask(task.id); } }, '생성된 할 일 보기'));
      actions.appendChild(h('span.help', '수락함' + (s.reviewedAt ? ' · ' + D.shortDay(s.reviewedAt) : '')));
    } else if (s.status === 'dismissed') {
      actions.appendChild(h('button.btn.btn-sm', {
        type: 'button', onclick: function () {
          S.mutate('제안 다시 검토', function (x) { M.restoreSuggestion(x, s.id); });
          ui.undoToast('‘' + s.title + '’을 검토 대기로 돌렸습니다.');
        }
      }, ui.icon('undo'), '다시 검토'));
      actions.appendChild(h('span.help', '제외함' + (s.reviewedAt ? ' · ' + D.shortDay(s.reviewedAt) : '')));
    }

    var edit = null;
    if (s.status === 'pending' && editingId === s.id) {
      var title = h('input.input', { value: s.title, 'aria-label': '할 일 제목', autofocus: true });
      var due = h('input.input', { type: 'date', value: s.dueDate || '', 'aria-label': '마감일' });
      var proj = h('select.select', { 'aria-label': '프로젝트' }, ui.projectOptions(st, s.projectId, '프로젝트 없음'));
      edit = h('div',
        h('div.sug-edit', title, due, proj),
        h('div.sug-actions',
          h('button.btn.btn-sm.btn-primary', {
            type: 'button', onclick: function () {
              var v = title.value.trim();
              if (!v) { ui.toast('제목을 입력해 주세요.'); title.focus(); return; }
              editingId = null;
              accept(s, { title: v, dueDate: due.value || null, projectId: proj.value || null });
            }
          }, '이대로 수락'),
          h('button.btn.btn-sm', { type: 'button', onclick: function () { editingId = null; redraw(); } }, '취소')));
      edit.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.stopPropagation(); editingId = null; redraw(); }
      });
    }

    return h('article.card.sug' + (s.status !== 'pending' ? '.is-done' : ''), { 'aria-label': s.title },
      h('div.sug-head',
        h('div.sug-title', s.title),
        h('span.chip', isMail ? '메일' : '메모'),
        ui.projectChip(st, s.projectId),
        s.sample ? h('span.chip.chip-sample', '샘플') : null),
      h('div.sug-quote', s.excerpt || ''),
      meta, reason, dateLine, edit, actions);
  }

  function accept(s, fields) {
    var cur = M.byId(S.state.suggestions, s.id);
    if (!cur) return;
    if (cur.status === 'accepted') { ui.toast('이미 수락한 제안입니다.'); return; }
    var res = S.mutate('제안 수락', function (x) { return M.acceptSuggestion(x, s.id, fields || {}, A().now()); });
    if (!res) return;
    ui.toast('‘' + res.task.title + '’ 할 일을 만들었습니다.', {
      action: { label: '생성된 할 일 보기', fn: function () { A().openTask(res.task.id); } }
    });
  }

  function dismiss(s) {
    S.mutate('제안 제외', function (x) { M.dismissSuggestion(x, s.id, A().now()); });
    ui.undoToast('‘' + s.title + '’ 제안을 제외했습니다. 제외함 탭에서 다시 볼 수 있습니다.');
  }

  DN.views = DN.views || {};
  DN.views.inbox = { title: '새 할 일 제안', render: render, openEmail: openEmail, rescan: rescan };
})();
