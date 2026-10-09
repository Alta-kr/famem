'use strict';

// AI 정리 검토 패널 — 메모 화면 오른쪽.
//
// 화면에서 세 가지를 섞지 않는다:
//   원본 메모        : 가운데 편집기 (AI 가 바꾸지 않음)
//   AI 결과          : 이 패널 — 점선 테두리와 'AI 초안' 표시
//   확정한 데이터    : '저장함' 영역 — 만들어진 할 일·일정으로 바로 이동
//
// 초안은 접힌 행(선택·제목·유형·날짜·상태)으로 보이고, 행을 누르면 칸이 펼쳐진다.
// 상태는 저장 가능 / 확인 권장 / 확인 필요 세 가지. 저장 바는 선택 중 몇 개가 지금 저장 가능한지 미리 알려 주고,
// 확인이 필요한 항목이 있으면 "저장 가능한 N개만 저장" 을 명시적으로 고르게 한다 (조용히 일부만 저장하지 않는다).
// "확인 필요" 칸은 값을 미리 채우지 않는다. 원문에 근거가 있는 후보만 버튼으로 보여준다.

(function () {
  var DN = window.Daynote;
  var M = DN.model, D = DN.dates, S = DN.store, ui = DN.ui, h = ui.h;
  var P = DN.aiProposals;
  var DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];

  // 화면 상태(저장하지 않음)
  var checked = {};       // 초안 id → 선택 여부
  var expanded = {};      // 초안 id → 펼침 여부
  var digestOpen = {};    // 메모 id → 정리 요약 펼침 여부
  var lastSave = {};      // 메모 id → { saved: [...], left: n, at }
  var showDismissed = false;

  function isChecked(p) {
    if (p.status !== 'pending') return false;
    return p.id in checked ? checked[p.id] : !!p.payload.defaultChecked;
  }

  function dateSummary(p, v, now) {
    var d = p.kind === 'task' ? v.dueDate : v.date;
    var t = p.kind === 'task' ? v.dueTime : v.time;
    if (!d) return p.kind === 'task' ? '마감 없음' : '날짜 미정';
    return (p.kind === 'task' ? '마감 ' : '') + D.relDay(d, now) + (t ? ' ' + t : '') + (p.kind === 'event' && v.durationMinutes ? ' · ' + D.duration(v.durationMinutes) : '');
  }

  function render(root, noteId, ctx) {
    var A = DN.app, F = DN.aiFlow;
    var st = S.state;
    var note = M.byId(st.notes, noteId);
    root.textContent = '';
    if (!note) return;
    var now = A.now();

    var aiStatus = F.status();
    var run = P.latestRun(st, noteId);
    var digest = P.digestFor(st, noteId);
    var props = P.forNote(st, noteId);
    var curHash = P.noteHash(note);
    var running = F.isRunning(noteId) || (run && run.status === 'running');

    var open = props.filter(function (p) { return p.status === 'pending' || p.status === 'stale'; });
    var saved = props.filter(function (p) { return p.status === 'accepted'; });
    var dismissed = props.filter(function (p) { return p.status === 'dismissed'; });

    function rerender() { render(root, noteId, ctx); }
    function edit(p, field, value, again) {
      S.mutate(null, function (s) { P.setEdit(s, p.id, field, value, A.now()); }, { source: 'review' });
      if (again) rerender(); else renderFoot();
    }

    // ---------------------------------------------------------------- 머리 · 실행 상태
    var head = h('div.review-head',
      h('div.review-title', ui.icon('spark'), h('span', 'AI 정리'),
        aiStatus.provider === 'fake' ? h('span.chip.chip-guess', { title: '실제 AI가 아니라 규칙으로 만든 시험용 결과입니다' }, '데모 모드 · 실제 AI 아님')
          : aiStatus.provider ? h('span.chip', { title: aiStatus.notice || '' }, aiStatus.provider === 'gemini' ? 'Gemini 3.8 Flash' : 'Claude Opus 5.5') : null),
      h('button.icon-btn', { type: 'button', 'aria-label': '검토 패널 닫기', onclick: function () { ctx.close(); } }, ui.icon('x')));

    var statusLine = h('div.review-status', { role: 'status', 'aria-live': 'polite' });
    if (running) {
      statusLine.appendChild(h('span.spinner', { 'aria-hidden': 'true' }));
      statusLine.appendChild(h('span', '정리 중이에요. 메모는 계속 편집할 수 있어요.'));
    } else if (!aiStatus.configured && !digest) {
      statusLine.classList.add('is-warn');
      statusLine.appendChild(h('span', aiStatus.reason || 'AI가 연결되어 있지 않습니다.'));
    } else if (run && (run.status === 'failed' || run.status === 'invalid')) {
      statusLine.classList.add('is-error');
      statusLine.appendChild(h('span', (run.status === 'invalid' ? '정리 결과를 쓰지 못했어요. ' : '정리에 실패했어요. ') + (run.error ? run.error.message : '')));
      if (!run.error || run.error.retryable) statusLine.appendChild(h('button.btn.btn-xs', { type: 'button', onclick: function () { ctx.organize(true); } }, '다시 시도'));
      if (digest) statusLine.appendChild(h('span.meta', '아래는 이전 정리 결과예요.'));
    } else if (digest) {
      statusLine.appendChild(h('span', D.relDay(D.ymd(digest.createdAt), now) + ' ' + D.hm(digest.createdAt) + ' 정리'
        + (run && run.stats && run.stats.dropped ? ' · 원문에 근거가 없는 ' + run.stats.dropped + '개는 뺐어요' : '')));
      if (digest.noteHash !== curHash) {
        statusLine.classList.add('is-warn');
        statusLine.appendChild(h('span', '· 그 뒤 메모가 바뀌었어요'));
        statusLine.appendChild(h('button.btn.btn-xs', { type: 'button', onclick: function () { ctx.organize(false); } }, '다시 정리'));
      }
    } else {
      statusLine.appendChild(h('span', '‘AI 정리’를 누르면 메모를 정리하고 할 일·일정 초안을 만들어요. 고른 것만 저장돼요.'));
    }

    var body = h('div.review-body', { 'data-keep-scroll': 'review' });

    // ---------------------------------------------------------------- 방금 저장한 결과
    var ls = lastSave[noteId];
    if (ls) {
      body.appendChild(h('div.save-result', { role: 'status' },
        h('div.save-result-h', ui.icon('check'), ls.message),
        h('ul', ls.saved.map(function (c) { return h('li', createdLink(c)); })),
        ls.left ? h('div.meta', '확인이 필요한 ' + ls.left + '개는 아래 초안에 그대로 남겨 두었어요.') : null,
        h('div.save-result-actions',
          h('button.btn.btn-xs', { type: 'button', onclick: function () { S.undo(); delete lastSave[noteId]; } }, ui.icon('undo'), '저장 되돌리기'),
          h('button.btn.btn-xs.btn-ghost', { type: 'button', onclick: function () { delete lastSave[noteId]; rerender(); } }, '닫기'))));
    }

    // ---------------------------------------------------------------- 초안
    if (digest || props.length) {
      var groupHead = h('div.review-sec-h', h('h3', '검토할 초안'), h('span.meta', open.length ? open.length + '개' : ''));
      body.appendChild(groupHead);
      if (open.length) {
        var tasks = open.filter(function (p) { return p.kind === 'task'; });
        var events = open.filter(function (p) { return p.kind === 'event'; });
        if (tasks.length) body.appendChild(h('div.review-kind', '할 일 ' + tasks.length));
        tasks.forEach(function (p) { body.appendChild(card(p)); });
        if (events.length) body.appendChild(h('div.review-kind', '일정 ' + events.length));
        events.forEach(function (p) { body.appendChild(card(p)); });
      } else {
        body.appendChild(h('div.review-empty', props.length
          ? '검토할 초안이 없어요. 모두 저장하거나 제외했어요.'
          : '이 메모에서 할 일이나 일정을 찾지 못했어요.'));
      }
    }

    // ---------------------------------------------------------------- 저장함 · 제외함
    if (saved.length) {
      body.appendChild(h('div.review-sec-h', h('h3', '저장함'), h('span.meta', saved.length + '개')));
      body.appendChild(h('ul.review-saved', saved.map(function (p) {
        return h('li', createdLink({ kind: p.resultRef && p.resultRef.kind, id: p.resultRef && p.resultRef.id, title: (p.acceptedValues && p.acceptedValues.title) || p.payload.title }));
      })));
    }
    if (dismissed.length) {
      body.appendChild(h('button.link-btn.review-dismissed-toggle', { type: 'button', 'aria-expanded': String(showDismissed), onclick: function () { showDismissed = !showDismissed; rerender(); } },
        (showDismissed ? '▾ ' : '▸ ') + '제외함 ' + dismissed.length + '개'));
      if (showDismissed) body.appendChild(h('ul.review-saved', dismissed.map(function (p) {
        return h('li', h('span', p.payload.title), ' ',
          h('button.link-btn', { type: 'button', onclick: function () { S.mutate('초안 다시 검토', function (s) { P.restore(s, p.id); }); } }, '다시 검토'));
      })));
    }

    // ---------------------------------------------------------------- 정리된 메모 (기본 접힘)
    if (digest) {
      var stale = digest.noteHash !== curHash;
      var dOpen = noteId in digestOpen ? digestOpen[noteId] : !open.length;
      body.appendChild(h('section.ai-box' + (stale ? '.is-stale' : ''), { 'aria-label': '정리된 메모' },
        h('div.ai-box-head',
          h('button.ai-box-toggle', { type: 'button', 'aria-expanded': String(dOpen), onclick: function () { digestOpen[noteId] = !dOpen; rerender(); } },
            h('span.ai-badge', 'AI 정리'), h('span', dOpen ? '정리된 메모 접기' : '정리된 메모 보기')),
          h('button.btn.btn-xs.btn-ghost', { type: 'button', onclick: function () { S.host.copyText(digestMarkdown(digest)).then(function () { ui.toast('정리 결과를 복사했어요.'); }); } }, ui.icon('copy'), '복사')),
        h('p.ai-summary', digest.summary),
        dOpen ? [
          digest.sections.map(function (sec) {
            return h('div.ai-sec', h('div.ai-sec-h', sec.heading),
              h('ul', sec.bullets.map(function (b) {
                return h('li', b.line != null ? h('button.line-link', { type: 'button', title: '원문 ' + b.line + '행 보기', onclick: function () { ctx.jump(b.line); } }, b.text) : b.text);
              })));
          }),
          digest.openQuestions.length ? h('div.ai-sec', h('div.ai-sec-h', '확인할 점'),
            h('ul', digest.openQuestions.map(function (q) {
              return h('li', q.line != null ? h('button.line-link', { type: 'button', onclick: function () { ctx.jump(q.line); } }, q.text) : q.text);
            }))) : null,
          h('div.meta', '원본 메모는 바뀌지 않아요.')
        ] : null));
    }

    // ---------------------------------------------------------------- 만든 항목 링크
    function createdLink(c) {
      if (c.kind === 'task') {
        var t = M.byId(S.state.tasks, c.id);
        if (!t || t.deletedAt) return h('span', '할 일 · ' + c.title + ' (삭제됨)');
        return h('button.created-link', { type: 'button', onclick: function () { A.openTask(t.id); } },
          h('span.chip', '할 일'), h('span.t', t.title), t.dueDate ? h('span.meta', '마감 ' + D.relDay(t.dueDate, A.now())) : null);
      }
      var b = M.byId(S.state.blocks, c.id);
      if (!b) return h('span', '일정 · ' + c.title + ' (삭제됨)');
      var cs = M.conflictsFor(S.state, b.start, b.end, b.id);
      return h('button.created-link', { type: 'button', onclick: function () { DN.views.schedule.open({ blockId: b.id }); } },
        h('span.chip.chip-progress', '일정'), h('span.t', b.title),
        h('span.meta', D.relDay(D.ymd(b.start), A.now()) + ' ' + D.hm(b.start) + '–' + D.hm(b.end)),
        cs.length ? h('span.chip.chip-overlap', ui.icon('alert'), '겹침 ' + cs.length) : null);
    }

    // ---------------------------------------------------------------- 초안 행
    function card(p) {
      var v = P.effective(p);
      var e = p.edits || {};
      var f = p.payload.fields;
      var isStale = p.status === 'stale';
      var rd = P.readiness(S.state, p);
      var isOpen = !!expanded[p.id];

      var cb = h('input', { type: 'checkbox', checked: isChecked(p), disabled: isStale, 'aria-label': '‘' + v.title + '’ 저장할 항목으로 선택' });
      cb.addEventListener('click', function (ev) { ev.stopPropagation(); });
      cb.addEventListener('change', function () { checked[p.id] = cb.checked; renderFoot(); });

      var pill = rd.level === 'blocked'
        ? h('span.state-pill.is-blocked', isStale ? '원문이 바뀜' : '확인 필요' + (rd.openLabels.length ? ' · ' + rd.openLabels.join(', ') : ''))
        : rd.level === 'note' ? h('span.state-pill.is-note', { title: rd.openLabels.join(', ') + ' 확인 권장 — 비워 둔 채로도 저장할 수 있어요' }, '저장 가능 · ' + rd.openLabels.join(', ') + ' 미정')
        : h('span.state-pill.is-ready', '저장 가능');

      var row = h('div.ai-row', {
        role: 'button', tabindex: '0', 'aria-expanded': String(isOpen),
        onclick: function () { expanded[p.id] = !isOpen; rerender(); },
        onkeydown: function (ev) { if (ev.target === row && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); expanded[p.id] = !isOpen; rerender(); } }
      },
        cb,
        h('div.ai-row-main',
          h('div.ai-row-title', v.title || '(제목 없음)'),
          h('div.ai-row-meta', h('span.kind', p.kind === 'task' ? '할 일' : '일정'), h('span', dateSummary(p, v, now)), pill,
            p.payload.duplicateOf ? h('span.state-pill.is-note', '비슷한 항목 있음') : null)),
        h('span.ai-row-chev', { 'aria-hidden': 'true' }, isOpen ? '▾' : '▸'));

      var detail = null;
      if (isOpen) {
        var titleIn = h('input.input.review-title-input', { value: v.title || '', 'aria-label': '초안 제목', 'data-fk': p.id + ':title' });
        titleIn.addEventListener('change', function () { edit(p, 'title', titleIn.value.trim(), true); });

        var notes = [];
        if (isStale) notes.push(h('div.review-flag.is-error', '원문에서 근거 문장이 사라졌어요. 다시 정리하거나 제외해 주세요.'));
        (p.payload.flags || []).forEach(function (fl) { notes.push(h('div.review-flag', fl)); });
        if (p.payload.duplicateOf) {
          var d = p.payload.duplicateOf;
          notes.push(h('div.review-flag', '이미 있는 ' + (d.kind === 'task' ? '할 일' : '일정') + ' ‘' + d.label + '’과(와) 비슷해요. ',
            d.kind === 'task' ? h('button.link-btn', { type: 'button', onclick: function () { A.openTask(d.id); } }, '열기') : null));
        }
        if (p.aiUpdate) {
          notes.push(h('div.review-flag.is-info', '다시 정리한 AI 결과가 이 초안과 달라요. 직접 고친 내용은 그대로 두었어요. ',
            h('button.link-btn', { type: 'button', onclick: function () { S.mutate('AI 새 버전 적용', function (s) { P.takeAiUpdate(s, p.id, A.now()); }); } }, '새 버전으로 바꾸기')));
        }

        var fields;
        if (p.kind === 'task') {
          fields = h('div.review-fields',
            fieldRow('마감일', 'dueDate', h('input.input', { type: 'date', value: v.dueDate || '', 'data-fk': p.id + ':dueDate' }), 'date'),
            v.dueDate || f.dueTime.status === 'confirm' ? fieldRow('마감 시각', 'dueTime', h('input.input', { type: 'time', value: v.dueTime || '', 'data-fk': p.id + ':dueTime' }), 'time') : null,
            fieldRow('프로젝트', 'projectId', h('select.select', { 'data-fk': p.id + ':projectId' }, ui.projectOptions(S.state, v.projectId)), 'select'),
            !v.dueDate && f.dueDate.status === 'ok' ? h('div.meta.review-span', '마감이 없는 할 일도 그대로 저장할 수 있어요.') : null);
        } else {
          var asTask = v.saveAs === 'task';
          var dur = h('select.select', { 'data-fk': p.id + ':durationMinutes' },
            h('option', { value: '' }, '소요 시간 선택'),
            DURATIONS.concat(v.durationMinutes && DURATIONS.indexOf(v.durationMinutes) === -1 ? [v.durationMinutes] : []).sort(function (a, b) { return a - b; })
              .map(function (m) { return h('option', { value: String(m), selected: v.durationMinutes === m }, D.duration(m)); }));
          var conflict = null;
          if (!asTask && v.date && v.time && v.durationMinutes) {
            var rg = P.eventRange(v);
            var cs = M.conflictsFor(S.state, rg.start, rg.end);
            conflict = cs.length
              ? h('div.review-flag.review-span', ui.icon('alert'), ' 겹치는 일정: ' + cs.map(function (b) { var t = b.taskId && M.byId(S.state.tasks, b.taskId); return '‘' + (t ? t.title : b.title || '일정') + '’ ' + D.hm(b.start) + '–' + D.hm(b.end); }).join(', ') + ' — 겹쳐도 저장할 수 있어요.')
              : h('div.meta.review-span', D.relDay(v.date, now) + ' ' + v.time + '–' + D.hm(rg.end) + ' · 겹치는 일정 없음');
          }
          var asTaskCb = h('input', { type: 'checkbox', checked: asTask, 'data-fk': p.id + ':saveAs' });
          asTaskCb.addEventListener('change', function () { edit(p, 'saveAs', asTaskCb.checked ? 'task' : 'event', true); });
          fields = h('div.review-fields',
            fieldRow('날짜', 'date', h('input.input', { type: 'date', value: v.date || '', 'data-fk': p.id + ':date' }), 'date'),
            fieldRow('시각', 'time', h('input.input', { type: 'time', value: v.time || '', 'data-fk': p.id + ':time' }), 'time'),
            asTask ? null : fieldRow('소요 시간', 'durationMinutes', dur, 'int'),
            f.location.value || f.location.status === 'confirm' || e.location ? fieldRow('장소', 'location', h('input.input', { value: v.location || '', 'data-fk': p.id + ':location' }), 'text') : null,
            conflict,
            h('label.check-row.review-span.review-asTask', asTaskCb, h('span', '캘린더 일정 대신 할 일로 저장 (시간이 정해지지 않았을 때)')));
        }

        detail = h('div.ai-card-detail',
          h('div.ai-card-top', titleIn,
            h('button.btn.btn-xs.btn-ghost', { type: 'button', 'aria-label': '‘' + v.title + '’ 초안 제외', onclick: function () {
              S.mutate('초안 제외', function (s) { P.dismiss(s, p.id, A.now()); });
              ui.undoToast('초안을 제외했어요. 다시 정리해도 다시 나타나지 않아요.');
            } }, '제외')),
          h('button.quote-link', { type: 'button', title: '원문에서 보기', onclick: function () { ctx.jump(p.source.line); } },
            h('span.ai-badge', 'AI 초안'), ' ', h('span.meta', p.source.line === 0 ? '제목' : '원문 ' + p.source.line + '행'), ' “' + p.source.quote + '”'),
          notes, fields);
      }

      // 칸 하나: 입력 + (확인 필요면) 이유와 근거 있는 후보 버튼. 오류 표시는 이 한 곳에서만 한다.
      function fieldRow(label, key, control, type) {
        var fd = f[key] || { status: 'ok', options: [] };
        var userSet = key in e;
        control.setAttribute('aria-label', label);
        control.addEventListener('change', function () {
          var val = control.value;
          if (type === 'int') val = val ? Number(val) : null;
          else val = val || null;
          edit(p, key, val, true);
        });
        var confirm = fd.status === 'confirm' && !userSet && v[key] == null;
        var required = rd.level === 'blocked' && rd.openFields.indexOf(key) !== -1;
        return h('div.review-field' + (confirm ? '.is-confirm' : '') + (required ? '.is-required' : ''),
          h('label', label, confirm ? h('span.confirm-badge' + (required ? '.is-required' : ''), required ? '필수 · 확인 필요' : '확인 권장') : userSet ? h('span.meta', ' · 직접 정함') : null),
          control,
          confirm ? h('div.confirm-help', { id: p.id + ':' + key + ':help' }, fd.message,
            fd.options.length ? h('div.confirm-opts', fd.options.map(function (o) {
              var shown = type === 'date' ? D.relDay(o.value, now) + ' (' + o.value + ')' : type === 'int' ? D.duration(o.value) : String(o.value);
              return h('button.btn.btn-xs', { type: 'button', onclick: function () { edit(p, key, o.value, true); } }, o.label + ': ' + shown);
            })) : null) : null);
      }

      return h('article.ai-card' + (isStale ? '.is-stale' : '') + (isChecked(p) ? '.is-checked' : '') + (isOpen ? '.is-open' : ''), { 'data-prop': p.id }, row, detail);
    }

    // ---------------------------------------------------------------- 저장 바
    var foot = h('div.review-foot');
    function renderFoot() {
      foot.textContent = '';
      var cur = M.byId; // 최신 상태로 다시 계산
      var sel = P.forNote(S.state, noteId).filter(function (p) { return (p.status === 'pending') && isChecked(p); });
      var part = P.partition(S.state, sel.map(function (p) { return p.id; }));
      var nReady = part.ready.length, nBlocked = part.blocked.length;
      Array.prototype.forEach.call(root.querySelectorAll('.ai-card'), function (el) {
        var p = cur(S.state.proposals, el.getAttribute('data-prop'));
        el.classList.toggle('is-checked', !!(p && isChecked(p)));
      });
      if (!open.length) return;
      foot.appendChild(h('div.foot-counts', { 'aria-live': 'polite' },
        h('span', '선택 ' + sel.length), h('span.sep', '·'), h('span.ok', '저장 가능 ' + nReady),
        nBlocked ? [h('span.sep', '·'), h('span.bad', '확인 필요 ' + nBlocked)] : null));
      var actions = h('div.foot-actions');
      if (nBlocked) {
        actions.appendChild(h('button.btn.btn-sm', { type: 'button', onclick: function () { goToBlocked(part.blocked[0].id); } }, '확인할 항목 보기'));
      }
      actions.appendChild(h('button.btn.btn-primary.btn-sm', { type: 'button', disabled: !nReady, onclick: function () { save(part.ready, nBlocked); } },
        !sel.length ? '저장할 항목을 고르세요' : !nReady ? '확인이 끝나면 저장할 수 있어요' : nBlocked ? '저장 가능한 ' + nReady + '개만 저장' : '선택한 ' + nReady + '개 저장'));
      foot.appendChild(actions);
    }

    // 확인이 필요한 첫 항목을 펼치고 문제 칸으로 포커스를 옮긴다
    function goToBlocked(id) {
      expanded[id] = true;
      rerender();
      var card = root.querySelector('[data-prop="' + id + '"]');
      if (!card) return;
      card.scrollIntoView({ block: 'start' });
      var target = card.querySelector('.review-field.is-required select, .review-field.is-required input') || card.querySelector('.review-flag.is-error') || card.querySelector('.ai-row');
      if (target) { if (!target.hasAttribute('tabindex') && !/INPUT|SELECT|BUTTON/.test(target.tagName)) target.setAttribute('tabindex', '-1'); target.focus(); }
    }

    function save(ids, nBlocked) {
      if (!ids.length) return;
      var res = S.mutate('AI 초안 저장', function (s) { return P.applySelections(s, ids, A.now()); });
      if (!res.ok) {   // 저장 직전 다시 확인했더니 바뀐 경우 — 아무것도 저장되지 않았다
        ui.toast('저장하지 않았어요. 초안이 바뀌었으니 다시 확인해 주세요.', { error: true });
        rerender();
        return;
      }
      ids.forEach(function (id) { delete checked[id]; delete expanded[id]; });
      var nt = res.created.filter(function (c) { return c.kind === 'task'; }).length;
      var ne = res.created.filter(function (c) { return c.kind === 'block'; }).length;
      var parts = [];
      if (nt) parts.push('할 일 ' + nt + '개');
      if (ne) parts.push('일정 ' + ne + '개');
      lastSave[noteId] = { saved: res.created, left: nBlocked, message: parts.join('와 ') + '를 저장했어요.' };
      rerender();
      var b = root.querySelector('.review-body'); if (b) b.scrollTop = 0;
    }

    root.appendChild(h('aside.review', { 'aria-label': 'AI 정리 검토' }, head, statusLine, body, foot));
    renderFoot();
  }

  function digestMarkdown(d) {
    var out = ['## 요약', d.summary, ''];
    d.sections.forEach(function (s) { out.push('### ' + s.heading); s.bullets.forEach(function (b) { out.push('- ' + b.text); }); out.push(''); });
    if (d.openQuestions.length) { out.push('### 확인할 점'); d.openQuestions.forEach(function (q) { out.push('- ' + q.text); }); }
    return out.join('\n');
  }

  // 메모를 떠나거나 되돌리면 저장 결과 안내는 지운다
  S.subscribe(function (info) { if (info.type === 'undo' || info.type === 'load') lastSave = {}; });

  DN.views.review = { render: render, _checked: checked, _expanded: expanded };
})();
