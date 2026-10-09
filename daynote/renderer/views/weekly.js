'use strict';

// 주간 정리 — 왼쪽은 기록에서 모은 사실, 오른쪽은 주간업무보고 초안 편집기.
//
//  - 사실 확인은 weekly.summarize 가 기록(히스토리·할 일)에서 모은 것만 보여준다.
//  - 초안은 weekly.draftReport 로 만든다. 기록에 없는 내용은 넣지 않는다.
//  - 사용자가 고친 본문(body)은 초안(draft)과 따로 보관한다. 다시 만들 때 덮어쓰지 않고 비교해서 고르게 한다.
//  - 자동 발송 없음. 복사·내보내기만.

(function () {
  var DN = window.Daynote;
  var M = DN.model, D = DN.dates, W = DN.weekly, S = DN.store, ui = DN.ui, h = ui.h;
  var A = function () { return DN.app; };

  var selected = {};        // 이월할 미완료 할 일 (주별로 따로)
  var reportMode = {};      // 주별 보고서 보기 방식: 'preview' | 'edit'

  // 보고서 미리보기 — 제목·목록·문단·구분선만 다루는 작은 마크다운 표시기 (글자는 모두 textContent)
  function renderMarkdown(text) {
    var h = DN.ui.h, out = [], list = null;
    function inline(s) {
      var parts = [], re = /\*\*([^*]+)\*\*/g, i = 0, m;
      while ((m = re.exec(s))) { parts.push(s.slice(i, m.index)); parts.push(h('strong', m[1])); i = m.index + m[0].length; }
      parts.push(s.slice(i));
      return parts;
    }
    String(text).split('\n').forEach(function (line) {
      var m;
      if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) { if (!list) { list = h('ul'); out.push(list); } list.appendChild(h('li', inline(m[1]))); return; }
      list = null;
      if (!line.trim()) return;
      if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) { out.push(h('h' + (m[1].length + 1) + '.md-h', inline(m[2]))); return; }
      if (/^\s*(---|\*\*\*)\s*$/.test(line)) { out.push(h('hr')); return; }
      out.push(h('p', inline(line)));
    });
    return out;
  }
  var genError = {};        // 초안 생성 실패 메시지 (주별)
  var SAVE_DELAY = 400;

  function thisWeek() { return D.ymd(D.startOfWeek(A().now())); }

  function historyIds(summary) {
    var ids = [];
    summary.completed.forEach(function (g) { g.items.forEach(function (it) { ids.push(it.historyId); }); });
    ['decisions', 'blockers', 'achievements', 'updates'].forEach(function (k) { summary[k].forEach(function (x) { ids.push(x.id); }); });
    return ids;
  }

  function render(root, params) {
    var st = S.state;
    var now = A().now();
    var week = params && params.week ? D.ymd(D.startOfWeek(D.parseYmd(params.week))) : thisWeek();
    var sel = selected[week] || (selected[week] = {});
    var summary = W.summarize(st, week, now);
    var report = M.reportFor(st, week);
    var saveTimer = null;
    var alive = true;         // 다시 그린 뒤 옛 textarea 의 blur 가 새 내용을 덮지 않게

    function goWeek(delta) {
      A().go('weekly', { week: D.ymd(D.addDays(D.parseYmd(week), delta * 7)) });
    }

    // ---------------------------------------------------------------- 머리
    var isThis = week === thisWeek();
    var head = h('div.page-head',
      h('div',
        h('div.page-title', '주간 정리'),
        h('div.page-sub', D.weekLabel(D.parseYmd(week)) + (isThis ? ' · 이번 주' : '') + ' · 기록 ' + summary.recordCount + '건')),
      h('div.page-actions',
        h('button.btn.btn-sm', { type: 'button', 'aria-label': '이전 주', onclick: function () { goWeek(-1); } }, ui.icon('chevronLeft'), '이전 주'),
        h('button.btn.btn-sm', { type: 'button', disabled: isThis, onclick: function () { A().go('weekly', {}); } }, '이번 주'),
        h('button.btn.btn-sm', { type: 'button', 'aria-label': '다음 주', onclick: function () { goWeek(1); } }, '다음 주', ui.icon('chevronRight')))
    );

    // ---------------------------------------------------------------- 사실 확인
    // 항목은 두 줄: 첫 줄은 제목(전체 폭), 둘째 줄은 날짜·프로젝트·상태
    function itemTitle(title, taskId, missing) {
      return missing || !taskId
        ? h('span.wk-title', title || '(제목 없음)')
        : h('button.wk-title.wk-link', { type: 'button', onclick: function () { A().openRef({ kind: 'task', id: taskId }); } }, title || '(제목 없음)');
    }
    function refItem(title, taskId, missing, extra) {
      return h('li.wk-item', itemTitle(title, taskId, missing),
        h('div.wk-meta', missing ? h('span.chip.chip-missing', '원본 삭제됨') : null, extra || null));
    }

    function histList(list) {
      if (!list.length) return h('div.help', '기록 없음');
      return h('ul', list.map(function (x) {
        var task = (x.refs || []).filter(function (r) { return r.kind === 'task'; })[0];
        var res = task ? M.resolveRef(st, task) : null;
        return h('li.wk-item',
          h('span.wk-title', x.title || '(제목 없음)'),
          x.body ? h('div.wk-body', x.body) : null,
          h('div.wk-meta', h('span', D.shortDay(x.at)), ui.projectChip(st, x.projectId),
            res ? (res.missing
              ? h('span.chip.chip-missing', '원본 삭제됨')
              : h('button.link-btn', { type: 'button', onclick: function () { A().openRef(task); } }, '관련 할 일')) : null));
      }));
    }

    function section(iconName, title, body) {
      return h('section.wk-section', h('h3', ui.icon(iconName), title), body);
    }

    var completedBody = summary.completed.length
      ? summary.completed.map(function (g) {
        return h('div',
          h('div.wk-proj', g.projectId ? ui.projectChip(st, g.projectId) || g.projectName : g.projectName, h('span.help', g.items.length + '개')),
          h('ul', g.items.map(function (it) { return refItem(it.title, it.taskId, it.missing, h('span', '완료 ' + D.shortDay(it.completedAt))); })));
      })
      : h('div.help', '이번 주에 완료한 기록이 없습니다.');

    var selCount = summary.unfinished.filter(function (t) { return sel[t.taskId]; }).length;
    var unfinishedBody = summary.unfinished.length
      ? h('div',
        h('p.help.wk-hint', '체크한 항목은 마감을 다음 주로 옮깁니다. 완료 처리가 아니며, 보고서 내용에는 영향을 주지 않습니다.'),
        h('ul', summary.unfinished.map(function (t) {
          var task = M.byId(st.tasks, t.taskId);
          var cb = h('input', {
            type: 'checkbox', checked: !!sel[t.taskId], 'aria-label': '‘' + t.title + '’ 다음 주로 이월',
            onchange: function () { if (cb.checked) sel[t.taskId] = true; else delete sel[t.taskId]; updateCarry(); }
          });
          return h('li.wk-item',
            h('button.wk-title.wk-link', { type: 'button', onclick: function () { A().openTask(t.taskId); } }, t.title || '(제목 없음)'),
            h('div.wk-meta', task ? ui.dueChip(task, now) : null, ui.statusChips(st, task, now),
              h('label.wk-carry', cb, h('span', '다음 주로 이월'))));
        })),
        h('div.report-state', carryBtn()))
      : h('div.help', '남은 일이 없습니다.');

    var carryButton;
    function carryBtn() {
      carryButton = h('button.btn.btn-sm', { type: 'button', disabled: !selCount, onclick: carry }, '선택한 항목 다음 주로 이월');
      return [carryButton, h('span', '마감이 있으면 7일 뒤로, 없으면 다음 주 월요일로 옮깁니다.')];
    }
    function updateCarry() {
      selCount = summary.unfinished.filter(function (t) { return sel[t.taskId]; }).length;
      if (carryButton) { carryButton.disabled = !selCount; carryButton.textContent = selCount ? '선택한 ' + selCount + '개 다음 주로 이월' : '선택한 항목 다음 주로 이월'; }
    }
    function carry() {
      var ids = summary.unfinished.filter(function (t) { return sel[t.taskId]; }).map(function (t) { return t.taskId; });
      if (!ids.length) return;
      var changed = S.mutate('다음 주로 이월', function (s) { return W.carryOver(s, ids, week, A().now()); });
      selected[week] = {};
      ui.undoToast(changed.length + '개 할 일의 마감을 다음 주로 옮겼습니다.');
    }

    var nextBody = summary.nextWeek.length
      ? h('ul', summary.nextWeek.map(function (t) {
        return refItem(t.title, t.taskId, false, h('span.help', '마감 ' + D.shortDay(D.parseYmd(t.dueDate))));
      }))
      : h('div.help', '다음 주 마감인 할 일이 없습니다.');

    var facts = h('div.card.card-pad',
      h('h2.section-title', { style: { marginBottom: '12px' } }, '사실 확인'),
      h('p.help', { style: { marginTop: 0 } }, '완료·결정·장애물 기록과 할 일에서 모았습니다. 기록에 없는 일은 여기에도, 보고서에도 들어가지 않습니다.'),
      section('check', '이번 주 완료', completedBody),
      section('task', '진행 중·남은 일', unfinishedBody),
      section('flag', '결정 사항', histList(summary.decisions)),
      section('alert', '이슈·장애물', histList(summary.blockers)),
      section('star', '성과', histList(summary.achievements)),
      summary.updates.length ? section('edit', '업데이트', histList(summary.updates)) : null,
      section('calendar', '다음 주 계획', nextBody));

    // ---------------------------------------------------------------- 보고서
    function newDraft() {
      return W.draftReport(W.summarize(S.state, week, A().now()), S.state);
    }

    function saveNew(draft, body) {
      var s2 = W.summarize(S.state, week, A().now());
      S.mutate('보고서 초안 만들기', function (s) {
        M.saveReport(s, week, { draft: draft, body: body, generatedAt: A().now().toISOString(), refs: historyIds(s2) }, A().now());
      });
    }

    function generate() {
      var draft;
      try {
        draft = newDraft();
        delete genError[week];
      } catch (e) {
        genError[week] = e && e.message ? e.message : '알 수 없는 오류';
        A().refresh();
        return;
      }
      var r = M.reportFor(S.state, week);
      if (r && r.body && r.body !== r.draft) { compare(r.body, draft); return; }
      saveNew(draft, draft);
      ui.toast('기록을 바탕으로 초안을 만들었습니다. 바로 고쳐 쓸 수 있습니다.');
    }

    function compare(mine, fresh) {
      ui.modal({
        title: '고친 내용이 있습니다',
        wide: true,
        body: [
          h('p.help', { style: { margin: 0 } }, '직접 고친 보고서가 있어 덮어쓰지 않았습니다. 어떻게 할지 골라 주세요.'),
          h('div.compare',
            h('div', h('div.field-label', '내 편집'), h('pre', mine)),
            h('div', h('div.field-label', '새 초안'), h('pre', fresh)))
        ],
        actions: [
          { label: '내 편집 유지' },
          {
            label: '새 초안을 아래에 덧붙이기', onClick: function () {
              S.mutate('새 초안 덧붙이기', function (s) {
                M.saveReport(s, week, { draft: fresh, body: mine.replace(/\s+$/, '') + '\n\n---\n\n' + fresh, generatedAt: A().now().toISOString(), refs: historyIds(W.summarize(s, week, A().now())) }, A().now());
              });
              ui.undoToast('새 초안을 내 편집 아래에 덧붙였습니다.');
            }
          },
          {
            label: '새 초안으로 바꾸기', primary: true, onClick: function () {
              saveNew(fresh, fresh);
              ui.undoToast('새 초안으로 바꿨습니다. 되돌리면 내 편집이 돌아옵니다.');
            }
          }
        ]
      });
    }

    function startEmpty() {
      var draft = newDraft();
      saveNew(draft, draft);
    }

    var reportCard = h('div.card.card-pad.report-card');
    reportCard.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
      h('h2.section-title', { style: { flex: 1 } }, '보고서 초안'),
      h('button.btn.btn-sm', {
        type: 'button', disabled: true, title: 'AI 제공자가 연결되지 않았습니다', 'aria-describedby': 'wk-ai-help'
      }, ui.icon('spark'), 'AI로 다듬기')));
    reportCard.appendChild(h('div.help#wk-ai-help', 'AI 제공자가 연결되지 않았습니다. 초안은 기록을 규칙대로 정리해 만듭니다.'));

    var hasReport = report && (report.generatedAt || report.body);
    if (genError[week]) {
      reportCard.appendChild(h('div.conflict-box', { role: 'alert', style: { marginTop: '12px' } },
        '초안을 만들지 못했습니다: ' + genError[week]));
      reportCard.appendChild(h('div.report-state', h('button.btn.btn-sm', { type: 'button', onclick: generate }, ui.icon('refresh'), '다시 시도')));
    }
    if (!hasReport) {
      if (summary.recordCount === 0 && !summary.unfinished.length && !summary.nextWeek.length) {
        reportCard.appendChild(h('div.empty',
          h('h3', '이번 주 기록이 아직 부족합니다'),
          h('p', '할 일을 완료하거나 프로젝트에 결정·장애물을 기록하면 여기에 모입니다. 그래도 빈 양식으로 직접 쓰기 시작할 수 있습니다.'),
          h('button.btn', { type: 'button', onclick: startEmpty }, '빈 양식으로 시작')));
      } else if (!genError[week]) {
        reportCard.appendChild(h('div.empty',
          h('h3', '아직 초안이 없습니다'),
          h('p', '이번 주 기록 ' + summary.recordCount + '건과 남은 일을 섹션별로 정리합니다. 만든 뒤 자유롭게 고칠 수 있습니다.'),
          h('button.btn.btn-primary', { type: 'button', onclick: generate }, '초안 만들기')));
      }
    } else {
      var edited = report.body !== report.draft;
      var stateLine = h('span', edited ? '직접 고친 내용 있음' : '초안 그대로');
      var saved = h('span', report.editedAt ? '저장됨 ' + D.hm(report.editedAt) : (report.generatedAt ? '초안 생성 ' + D.shortDay(report.generatedAt) + ' ' + D.hm(report.generatedAt) : ''));
      var mode = reportMode[week] || 'preview';
      var ta = h('textarea.report-editor', { 'aria-label': '주간업무보고 본문 (마크다운)', spellcheck: 'false' });
      ta.value = report.body || '';
      function grow() { ta.style.height = 'auto'; ta.style.height = Math.max(ta.scrollHeight + 2, 320) + 'px'; }
      ta.addEventListener('input', grow);
      ta.addEventListener('input', function () {
        saved.textContent = '저장 중…';
        clearTimeout(saveTimer);
        saveTimer = setTimeout(flushText, SAVE_DELAY);
      });
      ta.addEventListener('blur', flushText);
      function flushText() {
        if (!alive) return;
        clearTimeout(saveTimer); saveTimer = null;
        var v = ta.value;
        var cur = M.reportFor(S.state, week);
        if (cur && cur.body === v) { saved.textContent = cur.editedAt ? '저장됨 ' + D.hm(cur.editedAt) : saved.textContent; return; }
        S.mutate(null, function (s) { M.saveReport(s, week, { body: v }, A().now()); }, { source: 'weekly' });
        var r2 = M.reportFor(S.state, week);
        saved.textContent = '저장됨 ' + D.hm(r2.editedAt);
        stateLine.textContent = r2.body !== r2.draft ? '직접 고친 내용 있음' : '초안 그대로';
      }
      function setMode(m) { flushText(); reportMode[week] = m; A().refresh(); }
      reportCard.appendChild(h('div.report-toolbar',
        h('div.seg', { role: 'group', 'aria-label': '보고서 보기 방식' },
          h('button', { type: 'button', 'aria-pressed': String(mode === 'preview'), onclick: function () { if (mode !== 'preview') setMode('preview'); } }, '미리보기'),
          h('button', { type: 'button', 'aria-pressed': String(mode === 'edit'), onclick: function () { if (mode !== 'edit') setMode('edit'); } }, '편집')),
        h('div.report-state', stateLine, h('span', '·'), saved)));
      if (mode === 'edit') {
        reportCard.appendChild(ta);
        setTimeout(grow, 0);
      } else {
        reportCard.appendChild(h('div.report-preview', { 'aria-label': '보고서 미리보기' }, renderMarkdown(report.body || ''),
          (report.body || '').trim() ? null : h('p.help', '내용이 없습니다. ‘편집’에서 작성하세요.')));
      }
      reportCard.appendChild(h('div.report-state',
        h('button.btn.btn-sm', { type: 'button', onclick: function () { flushText(); generate(); } }, ui.icon('refresh'), '기록으로 다시 만들기'),
        h('button.btn.btn-sm', {
          type: 'button', onclick: function () {
            flushText();
            S.host.copyText(ta.value).then(function () { ui.toast('보고서를 클립보드에 복사했습니다.'); }, function () { ui.toast('복사하지 못했습니다.', { error: true }); });
          }
        }, ui.icon('copy'), '복사'),
        h('button.btn.btn-sm', {
          type: 'button', onclick: function () {
            flushText();
            S.host.exportFile('주간업무보고-' + week + '.md', ta.value).then(function (res) {
              if (res && res.canceled) return;
              if (res && res.ok === false) ui.toast('내보내지 못했습니다' + (res.error ? ': ' + res.error : '.'), { error: true });
              else ui.toast('마크다운 파일로 내보냈습니다.');
            });
          }
        }, ui.icon('download'), '.md 내보내기'),
        h('span', '자동으로 보내지 않습니다. 복사하거나 파일로 내보내 직접 전달하세요.')));
    }

    root.appendChild(h('div.view-pad', head, h('div.weekly-grid', facts, reportCard)));

    return {
      onChange: function (info) { return info && info.source === 'weekly'; },
      destroy: function () {
        alive = false;
        if (saveTimer) {
          clearTimeout(saveTimer);
          var ta = root.querySelector('.report-editor');
          if (ta) S.mutate(null, function (s) { M.saveReport(s, week, { body: ta.value }, A().now()); }, { source: 'weekly', silent: true });
        }
      }
    };
  }

  DN.views = DN.views || {};
  DN.views.weekly = { title: '주간 정리', render: render };
})();
