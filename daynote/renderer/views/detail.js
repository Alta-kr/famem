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

    var ctxRows = contextRows(st, t, now);
    var hintRows = schedHintRows(t, save);

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
        hintRows,
        field('프로젝트', proj),
        ctxRows,
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
        return !/상태|단계|선행|미루기|소요 시간 확인|마감일|맥락|언제 할지/.test(info.label || '');
      }
    };
    return handle;
  }

  // ------------------------------------------------------------------ 맥락 · 언제 할까요 (STATUS §10.6) — 현재 상태를 켠 뒤에만
  var LEVEL_WORD = { up: '맨 위', normal: '보통', down: '뒤로', hide: '숨김' };
  // '맥락 바꾸기'·'언제 할지 바꾸기'는 패널을 다시 그린다(이유·지금 효과 줄이 바뀐다) — 고른 칸으로 포커스를 돌려준다
  function refocusHost(el) { var p = el.closest ? el.closest('aside.detail') : null; return p ? p.parentNode : null; }
  function refocus(host, label) {
    if (!host) return;
    var a = document.activeElement;
    if (a && a !== document.body && host.contains(a)) return;
    var x = host.querySelector('select[aria-label="' + label + '"]');
    if (x) try { x.focus(); } catch (e) {}
  }
  function contextRows(st, t, now) {
    var SU = DN.status, ST = DN.statusCore, SW = DN.statusWords;
    if (!SU || !ST || !SU.isActive || !SU.isActive() || !SU.profile) return null;
    var pf = SU.profile();
    var r = ST.contextOf(st, t, pf, now);
    var ctxSel = h('select.select', { 'aria-label': '맥락' },
      pf.contextIds.map(function (id) { return h('option', { value: id, selected: r.value === id }, pf.contexts[id].label); }),
      h('option', { value: '', selected: !r.value }, '정하지 않음'));
    ctxSel.addEventListener('change', function () {
      var host = refocusHost(ctxSel);
      if (SU.setTaskContext) SU.setTaskContext(t.id, ctxSel.value || null, { source: 'detail' });
      refocus(host, '맥락');
    });
    var lab = r.value ? ST.contextLabel(pf, r.value) : '정하지 않음';
    var why = r.source === 'user' ? (r.value ? '직접 정함' : '직접 ‘정하지 않음’으로 정함')
      : r.source === 'project' ? '프로젝트 ‘' + (r.evidence || '') + '’' + ui.josa(r.evidence || '', '를/을').slice((r.evidence || '').length) + ' 따라 ' + lab
      : r.source === 'learned' ? '전에 고친 대로 ' + lab
      : r.source === 'ai' ? 'AI가 정했어요 · 직접 바꾸면 그대로 둬요'
      : r.source === 'rule' ? '‘' + r.evidence + '’' + ui.josa(r.evidence || '', '라는/이라는').slice((r.evidence || '').length) + ' 말로 ' + ui.josa(lab, '로/으로') + ' 봤어요 · 직접 바꾸면 그대로 둬요'
      : r.source === 'hint' ? '메일에서 온 할 일이라 ' + ui.josa(lab, '로/으로') + ' 봤어요 · 숨기지는 않아요'
      : '어느 쪽 일인지 몰라서 어느 상태에서나 보통으로 보여요';
    var effect = null;
    var v = SU.view ? SU.view(now) : null;
    var lv = v && v.levels && v.levels[t.id];
    if (lv && t.status !== 'done') {
      var bt = lv.breakthrough;
      var tail = '';
      if (bt && t.dueDate) {
        var when = D.relDay(t.dueDate, now) + (t.dueTime ? ' ' + t.dueTime : '');
        tail = bt.soon ? ' · ' + when + ' 마감이 가까워서' : ' · ' + when + ' 마감이라 뒤로 보여요';
      } else if (lv.reason === 'when') tail = ' · 하기로 한 때라서';
      else if (lv.reason === 'phone') tail = ' · 이동 중에 폰으로 할 수 있어서';
      else if (lv.reason === 'shown') tail = ' · 펼쳐 봐서 이번만 보여요';
      else if (lv.reason === 'started') tail = ' · 이 상태에서 시작한 일이라서';
      else if (lv.reason === 'block') tail = ' · 작업 시간이 잡혀 있어서';
      var label = v.label + (v.guessed ? ' · 시간표 기준' : '');
      var word = bt && !bt.soon ? '숨김' : LEVEL_WORD[lv.level] || '보통';
      effect = '지금(' + label + ')은 ' + word + tail;
    }
    var at = h('select.select', { 'aria-label': '언제 할까요' },
      h('option', { value: '', selected: !t.atMode }, '상관없음'),
      ((SW && SW.ATMODES) || ['work', 'off', 'out', 'pause', 'rest']).map(function (m) {
        return h('option', { value: m, selected: t.atMode === m }, (SW && SW.ATMODE_LABEL && SW.ATMODE_LABEL[m]) || m);
      }));
    at.addEventListener('change', function () {
      var host = refocusHost(at);
      if (SU.setTaskAtMode) SU.setTaskAtMode(t.id, at.value || null, { source: 'detail' });
      refocus(host, '언제 할까요');
    });
    var atWhy = !t.atMode ? null : t.atModeSource === 'ai' ? 'AI가 정했어요' : t.atModeSource === 'rule' ? '제목 앞의 말로 알아봤어요' : null;
    return h('div.detail-section.st-detail',
      h('div.field', h('label', '맥락'), ctxSel,
        h('div.help.st-detail-why', why),
        effect ? h('div.meta.st-detail-effect', effect) : null),
      h('div.field', h('label', '언제 할까요'), at, atWhy ? h('div.help', atWhy) : null));
  }

  // ------------------------------------------------------------------ 배치 힌트 (CAL §7.2) — 플래너가 있으면 늘 보인다
  function schedHintRows(t, save) {
    var PL = DN.planner;
    if (!PL || typeof PL.hintsOf !== 'function') return null;
    var hs = PL.hintsOf(t);
    var cur = { focus: hs.focus == null ? null : hs.focus, energy: hs.energy == null ? null : hs.energy,
      prefer: hs.prefer == null ? null : hs.prefer, splittable: hs.splittable == null ? null : hs.splittable };
    var src = hs.src || {};
    var anyAi = ['focus', 'prefer', 'splittable', 'energy'].some(function (k) { return src[k] === 'ai'; });
    var anyRule = ['focus', 'prefer', 'splittable', 'energy'].some(function (k) { return src[k] === 'rule'; });
    var meta = h('div.meta.st-hint-src', anyAi ? 'AI가 짐작했어요' : anyRule ? '제목으로 짐작했어요' : '');
    if (!anyAi && !anyRule) meta.hidden = true;
    function commit() {
      save({ schedHints: { focus: cur.focus, energy: cur.energy, prefer: cur.prefer, splittable: cur.splittable, source: 'user', at: DN.app.now().toISOString() } }, '배치 힌트 바꾸기');
      meta.textContent = ''; meta.hidden = true;
    }
    var seg = h('div.seg', { role: 'group', 'aria-label': '일의 성격' });
    [[null, '상관없음'], ['deep', '집중 필요'], ['light', '가벼운 일']].forEach(function (o) {
      seg.appendChild(h('button', { type: 'button', 'aria-pressed': cur.focus === o[0] ? 'true' : 'false', onclick: function (e) {
        var me = e.currentTarget;
        cur.focus = o[0];
        Array.prototype.forEach.call(seg.children, function (b) { b.setAttribute('aria-pressed', b === me ? 'true' : 'false'); });
        commit();
      } }, o[1]));
    });
    var prefer = h('select.select', { 'aria-label': '하기 좋은 때' },
      [['', '상관없음'], ['morning', '아침·오전'], ['afternoon', '오후'], ['evening', '저녁']].map(function (o) {
        return h('option', { value: o[0], selected: (cur.prefer || '') === o[0] }, o[1]);
      }));
    prefer.addEventListener('change', function () { cur.prefer = prefer.value || null; commit(); });
    var split = h('input', { type: 'checkbox', checked: cur.splittable === true });
    split.addEventListener('change', function () { cur.splittable = split.checked; commit(); });
    return h('div.field.detail-row.st-sched-hints', h('label', '배치 힌트'),
      h('div.st-sched-line', seg, prefer),
      h('label.check-row', split, h('span', '나눠서 해도 돼요')),
      meta);
  }

  DN.views.detail = { render: render };
})();
