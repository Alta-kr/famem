'use strict';

// 할 일 상세 패널 — 오른쪽에 필요할 때만 열린다.
// 어느 화면에서 열어도 같은 Task 하나를 고친다. 입력값은 칸을 떠날 때(change) 저장한다.

(function () {
  var DN = window.Daynote;
  var M = DN.model, D = DN.dates, S = DN.store, ui = DN.ui, h = ui.h;

  function render(root, taskId) {
    var A = DN.app;
    var st = S.state;
    var t = M.byId(st.tasks, taskId);
    if (!t) return {};
    var now = A.now();

    function save(patch, label) {
      S.mutate(label || '할 일 수정', function (s) { M.updateTask(s, taskId, patch, A.now()); }, { source: 'detail' });
    }

    function field(label, control, help) {
      return h('div.field', h('label', label), control, help ? h('div.help', help) : null);
    }

    // 제목
    var title = h('textarea.detail-title', { rows: 1, 'aria-label': '할 일 제목' });
    title.value = t.title;
    function fit() { title.style.height = 'auto'; title.style.height = title.scrollHeight + 'px'; }
    title.addEventListener('input', fit);
    title.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
    title.addEventListener('change', function () { var v = title.value.trim(); if (v) save({ title: v }, '제목 변경'); else title.value = t.title; });
    setTimeout(fit, 0);

    var done = t.status === 'done';

    // 상태
    var status = h('select.select', { 'aria-label': '상태', disabled: done },
      ['todo', 'in_progress', 'waiting'].map(function (k) { return h('option', { value: k, selected: t.status === k }, M.TASK_STATUS[k]); }),
      done ? h('option', { value: 'done', selected: true }, '완료') : null);
    status.addEventListener('change', function () {
      if (status.value === 'in_progress') { A.startTask(taskId); return; }
      save({ status: status.value }, '상태 변경');
    });
    var waitingFor = h('input.input', { value: t.waitingFor || '', placeholder: '무엇을 기다리나요? (예: 재무팀 회신)', 'aria-label': '대기 사유' });
    waitingFor.addEventListener('change', function () { save({ waitingFor: waitingFor.value.trim() }); });

    var prio = h('select.select', { 'aria-label': '우선순위' },
      h('option', { value: '' }, '미지정'),
      ['high', 'normal', 'low'].map(function (k) { return h('option', { value: k, selected: t.priority === k }, M.PRIORITY[k]); }));
    prio.addEventListener('change', function () { save({ priority: prio.value || null }, '우선순위 변경'); });

    // 마감일 — 실제 작업 시간과 별개
    var dueDate = h('input.input', { type: 'date', value: t.dueDate || '', 'aria-label': '마감일' });
    var dueTime = h('input.input', { type: 'time', value: t.dueTime || '', 'aria-label': '마감 시각 (선택)' });
    dueDate.addEventListener('change', function () { save({ dueDate: dueDate.value || null, dueTime: dueDate.value ? (dueTime.value || null) : null }, '마감일 변경'); });
    dueTime.addEventListener('change', function () { if (dueDate.value) save({ dueTime: dueTime.value || null }, '마감 시각 변경'); });

    // 남은 예상 소요 시간 — 비워 두면 '미정' (0분이 아니다)
    var est = h('input.input', { type: 'number', min: '1', step: '5', placeholder: '미정', value: t.estimateMinutes != null ? t.estimateMinutes : '', 'aria-label': '남은 예상 소요 시간(분)' });
    est.addEventListener('change', function () {
      var v = est.value === '' ? null : Math.max(1, Math.round(Number(est.value)));
      save({ estimateMinutes: v }, '소요 시간 변경');
    });
    var estHelp = t.estimateMinutes == null
      ? '비워 두면 ‘소요 시간 미정’입니다. 추천에서 0분으로 보지 않습니다.'
      : t.estimateSource === 'ai' ? h('span', h('span.chip.chip-guess', 'AI 추정값'), ' 확인 후 맞으면 ',
          h('button.link-btn', { type: 'button', onclick: function () { save({ estimateMinutes: t.estimateMinutes, estimateSource: 'user' }, '소요 시간 확인'); } }, '이 값으로 확정'))
        : '분 단위 · 남은 시간 기준';

    var proj = h('select.select', { 'aria-label': '프로젝트' }, ui.projectOptions(st, t.projectId));
    proj.addEventListener('change', function () { save({ projectId: proj.value || null }, '프로젝트 변경'); });

    // 선행 업무
    var blockers = (t.blockedBy || []).map(function (id) { return M.byId(st.tasks, id); }).filter(Boolean);
    var blockerList = h('div', blockers.map(function (b) {
      return h('div.block-row',
        h('span.when', (b.status === 'done' ? '✓ ' : '') + b.title + (b.deletedAt ? ' (삭제됨)' : '')),
        h('button.btn.btn-xs.btn-ghost', { type: 'button', onclick: function () { save({ blockedBy: t.blockedBy.filter(function (x) { return x !== b.id; }) }, '선행 업무 해제'); } }, '해제'));
    }));
    var addBlocker = h('select.select', { 'aria-label': '선행 업무 추가' },
      h('option', { value: '' }, '선행 업무 추가…'),
      M.liveTasks(st).filter(function (o) { return o.id !== t.id && o.status !== 'done' && (t.blockedBy || []).indexOf(o.id) === -1; })
        .map(function (o) { return h('option', { value: o.id }, o.title); }));
    addBlocker.addEventListener('change', function () { if (addBlocker.value) save({ blockedBy: (t.blockedBy || []).concat(addBlocker.value) }, '선행 업무 추가'); });

    // 작은 단계 — 긴 업무를 나눠 두면 '지금 할 일 추천'이 단계 단위로 제안할 수 있다
    var steps = h('div', (t.steps || []).map(function (sp, i) {
      var cb = h('input', { type: 'checkbox', checked: sp.done, 'aria-label': sp.title + ' 단계 완료' });
      cb.addEventListener('change', function () {
        var next = t.steps.map(function (x, j) { return j === i ? Object.assign({}, x, { done: cb.checked }) : x; });
        save({ steps: next }, '단계 완료');
      });
      return h('div.step-row', cb, h('span', { style: { flex: 1, textDecoration: sp.done ? 'line-through' : 'none' } }, sp.title),
        h('span.meta', sp.estimateMinutes != null ? D.duration(sp.estimateMinutes) : '미정'),
        h('button.icon-btn', { type: 'button', 'aria-label': sp.title + ' 단계 삭제', style: { width: '26px', height: '26px' }, onclick: function () { save({ steps: t.steps.filter(function (_, j) { return j !== i; }) }, '단계 삭제'); } }, ui.icon('x')));
    }));
    var stepTitle = h('input.input', { placeholder: '단계 추가 (예: 개요 잡기)', 'aria-label': '새 단계 이름' });
    var stepEst = h('input.input.est', { type: 'number', min: '1', placeholder: '분', 'aria-label': '새 단계 예상 시간(분)' });
    function addStep() {
      var v = stepTitle.value.trim();
      if (!v) return;
      save({ steps: (t.steps || []).concat({ id: M.uid('step'), title: v, done: false, estimateMinutes: stepEst.value ? Number(stepEst.value) : null }) }, '단계 추가');
      renderAgain();
    }
    stepTitle.addEventListener('keydown', function (e) { if (e.key === 'Enter') addStep(); });
    stepEst.addEventListener('keydown', function (e) { if (e.key === 'Enter') addStep(); });

    var memo = h('textarea.textarea', { rows: 3, placeholder: '메모', 'aria-label': '할 일 메모' });
    memo.value = t.memo || '';
    memo.addEventListener('change', function () { save({ memo: memo.value }); });

    // 출처
    var sources = (t.sources || []).map(function (src) {
      var r = M.resolveRef(st, src);
      return h('div.source-item',
        h('div.meta', src.type === 'email' ? '메일' : src.type === 'note' ? '메모' : '출처', ' · ',
          r.missing ? h('span', { style: { color: 'var(--error)' } }, '원본이 삭제되었습니다') : h('button.link-btn', { type: 'button', onclick: function () { A.openRef(src); } }, r.label || '원문 열기')),
        src.excerpt ? h('div.excerpt', '“' + src.excerpt + '”') : null);
    });

    // 작업 시간 블록 — 지워도 할 일은 남는다
    var blocks = M.blocksForTask(st, taskId).map(function (b) {
      var past = new Date(b.end) < now;
      return h('div.block-row', ui.icon('clock'),
        h('span.when', D.relDay(D.ymd(b.start), now) + ' ' + D.hm(b.start) + '–' + D.hm(b.end) + (past ? ' (지남)' : '')),
        h('button.btn.btn-xs.btn-ghost', { type: 'button', onclick: function () { A.scheduleTask(taskId, { blockId: b.id }); } }, '변경'),
        h('button.btn.btn-xs.btn-ghost', { type: 'button', 'aria-label': '이 작업 시간 삭제', onclick: function () {
          S.mutate('작업 시간 삭제', function (s) { M.deleteBlock(s, b.id); });
          ui.undoToast('작업 시간을 지웠습니다. 할 일은 그대로 있습니다.');
        } }, '삭제'));
    });

    var snoozed = t.snoozedUntil && new Date(t.snoozedUntil) > now;

    var actions = h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
      done
        ? h('button.btn', { type: 'button', onclick: function () { A.toggleDone(taskId); } }, '완료 취소')
        : [
          t.status !== 'in_progress' ? h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: function () { A.startTask(taskId); } }, ui.icon('play'), '지금 시작') : null,
          h('button.btn.btn-sm', { type: 'button', onclick: function () { A.toggleDone(taskId); } }, ui.icon('check'), '완료'),
          h('button.btn.btn-sm', { type: 'button', onclick: function () { A.scheduleTask(taskId); } }, ui.icon('calendar'), '일정에 배치'),
          h('button.btn.btn-sm', { type: 'button', onclick: function (e) { A.snoozeMenu(taskId, e.currentTarget); } }, ui.icon('snooze'), '나중에')
        ]);

    var panel = h('aside.detail', { 'aria-label': '할 일 상세' },
      h('div.detail-head', h('div.panel-title', '할 일 상세'),
        h('button.icon-btn', { type: 'button', 'aria-label': '할 일 삭제', title: '삭제', onclick: function () { A.deleteTask(taskId); } }, ui.icon('trash')),
        h('button.icon-btn', { type: 'button', 'aria-label': '상세 닫기', title: '닫기 (Esc)', onclick: function () { A.closeDetail(); } }, ui.icon('x'))),
      h('div.detail-body',
        h('div', title, t.sample ? h('span.chip.chip-sample', '샘플') : null,
          t.origin === 'ai_accepted' ? h('span.chip.chip-guess', { title: 'AI 초안을 검토해 직접 확정한 할 일입니다' }, 'AI 초안에서 확정') : null),
        actions,
        done ? h('div.ok-box', '완료됨 · ' + D.relDay(D.ymd(t.completedAt), now) + ' ' + D.hm(t.completedAt)) : null,
        snoozed ? h('div.conflict-box', D.relDay(D.ymd(t.snoozedUntil), now) + ' ' + D.hm(t.snoozedUntil) + '까지 미뤄 두었습니다. ',
          h('button.link-btn', { type: 'button', onclick: function () { save({ snoozedUntil: null }, '미루기 해제'); } }, '미루기 해제')) : null,
        h('div.field-row', field('상태', status), field('우선순위', prio)),
        t.status === 'waiting' ? field('대기 사유', waitingFor) : null,
        h('div.detail-section', h('h4', '마감일'), h('div.field-row', dueDate, dueTime),
          h('div.help', '마감일은 ‘언제까지’입니다. 실제로 일할 시간은 아래 작업 시간에서 정합니다.')),
        h('div.detail-section', h('h4', '작업 시간'), blocks.length ? blocks : h('div.help', '아직 배치하지 않았습니다.'),
          done ? null : h('div', h('button.btn.btn-sm', { type: 'button', onclick: function () { A.scheduleTask(taskId); } }, ui.icon('plus'), '작업 시간 추가'))),
        field('남은 예상 소요 시간 (분)', est, estHelp),
        field('프로젝트', proj),
        h('div.detail-section', h('h4', '선행 업무'), blockerList, addBlocker,
          blockers.some(function (b) { return b.status !== 'done' && !b.deletedAt; }) ? h('div.help', '선행 업무가 끝나기 전에는 ‘지금 할 일 추천’에 나오지 않습니다.') : null),
        h('div.detail-section', h('h4', '단계'), steps, h('div.step-row', stepTitle, stepEst, h('button.btn.btn-sm', { type: 'button', onclick: addStep }, '추가'))),
        h('div.detail-section', h('h4', '메모'), memo),
        sources.length ? h('div.detail-section', h('h4', '출처'), sources) : null,
        h('div.meta', '만든 날 ' + D.shortDay(t.createdAt) + (t.startedAt ? ' · 시작 ' + D.shortDay(t.startedAt) : ''))
      ));
    root.appendChild(panel);

    function renderAgain() {
      root.textContent = '';
      var hd = render(root, taskId);
      handle.onChange = hd.onChange;
      setTimeout(function () { var f = root.querySelector('input[placeholder^="단계 추가"]'); if (f) f.focus(); }, 0);
    }

    panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); A.closeDetail(); } });

    var handle = {
      // 패널에서 직접 고친 변경은 다시 그리지 않는다 (입력 중인 칸의 포커스를 지킨다).
      // 단, 상태나 버튼 구성이 바뀌는 변경은 다시 그린다.
      onChange: function (info) {
        if (info.source !== 'detail') return false;
        return !/상태|단계|선행|미루기|소요 시간 확인|마감일/.test(info.label || '');
      }
    };
    return handle;
  }

  DN.views.detail = { render: render };
})();
