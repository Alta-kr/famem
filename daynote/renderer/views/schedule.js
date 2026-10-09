'use strict';

// ‘일정에 배치’ 대화상자 — 드래그의 키보드 대체 동작이자, 일반 일정 추가·수정 창.
// 저장 직전에 지금의 일정으로 충돌을 다시 계산한다 (열어 둔 사이 바뀐 일정을 근거로 배치하지 않는다).

(function () {
  var DN = window.Daynote;
  var M = DN.model, D = DN.dates, S = DN.store, ui = DN.ui, h = ui.h;
  var DAY_START = 8, DAY_END = 20;   // 빈 시간 제안 범위 (업무 시간)

  function roundUp15(d) {
    d = new Date(d);
    d.setSeconds(0, 0);
    var m = d.getMinutes();
    if (m % 15) d.setMinutes(m + (15 - m % 15));
    return d;
  }

  // from 이후 첫 빈 구간. 일정 정보가 이것뿐이므로 ‘후보’일 뿐 실제 여유를 보장하지 않는다.
  function findFreeSlot(state, from, minutes, ignoreId) {
    var t = roundUp15(from);
    for (var day = 0; day < 14; day++) {
      var base = D.addDays(D.startOfDay(from), day);
      var s = day === 0 ? new Date(Math.max(t.getTime(), new Date(base).setHours(DAY_START))) : new Date(new Date(base).setHours(DAY_START));
      var end = new Date(new Date(base).setHours(DAY_END));
      while (s.getTime() + minutes * 60000 <= end.getTime()) {
        var e = D.addMinutes(s, minutes);
        if (!M.conflictsFor(state, s.toISOString(), e.toISOString(), ignoreId).length) return s;
        s = D.addMinutes(s, 15);
      }
    }
    return roundUp15(from);
  }

  function describeConflicts(state, list) {
    return list.map(function (b) {
      var t = b.taskId ? M.byId(state.tasks, b.taskId) : null;
      return '‘' + (t ? t.title : b.title || '일정') + '’ ' + D.hm(b.start) + '–' + D.hm(b.end);
    }).join(', ');
  }

  // opts: { taskId?, blockId?, start?: Date, minutes?, event?: true }
  function open(opts) {
    var A = DN.app;
    var st = S.state;
    var block = opts.blockId ? M.byId(st.blocks, opts.blockId) : null;
    var task = M.byId(st.tasks, opts.taskId || (block && block.taskId));
    var isEvent = !task;
    var now = A.now();

    var minutes = block ? D.minutesBetween(block.start, block.end)
      : opts.minutes || (task && task.estimateMinutes ? Math.min(task.estimateMinutes, 240) : isEvent ? 60 : 30);
    var unknownEst = task && task.estimateMinutes == null && !block && !opts.minutes;
    var start = block ? new Date(block.start) : opts.start ? new Date(opts.start) : findFreeSlot(st, now, minutes);

    var titleIn = h('input.input', { value: block ? (block.title || '') : '', placeholder: '일정 이름 (예: 팀 회의)', 'aria-label': '일정 이름' });
    var dateIn = h('input.input', { type: 'date', value: D.ymd(start), 'aria-label': '날짜' });
    var timeIn = h('input.input', { type: 'time', step: '900', value: D.hm(start), 'aria-label': '시작 시각' });
    var durIn = h('select.select', { 'aria-label': '길이' },
      [15, 30, 45, 60, 90, 120, 180, 240].concat([minutes]).filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; })
        .map(function (m) { return h('option', { value: m, selected: m === minutes }, D.duration(m)); }));
    var preview = h('div', { 'aria-live': 'polite' });
    var allowConflict = false;

    function range() {
      var s = D.parseYmd(dateIn.value, timeIn.value || '09:00');
      return { s: s, e: D.addMinutes(s, Number(durIn.value)) };
    }
    function update() {
      allowConflict = false;
      var r = range();
      var c = M.conflictsFor(S.state, r.s.toISOString(), r.e.toISOString(), block && block.id);
      preview.textContent = '';
      var dueWarn = null;
      if (task && task.dueDate && D.parseYmd(task.dueDate, task.dueTime || '23:59') < r.s) dueWarn = '마감(' + D.relDay(task.dueDate, now) + (task.dueTime ? ' ' + task.dueTime : '') + ')보다 늦은 시간입니다.';
      preview.appendChild(c.length
        ? h('div.conflict-box', ui.icon('alert'), ' ' + D.relDay(D.ymd(r.s), now) + ' ' + D.hm(r.s) + '–' + D.hm(r.e) + ' · 겹치는 일정: ' + describeConflicts(S.state, c))
        : h('div.ok-box', D.relDay(D.ymd(r.s), now) + ' ' + D.hm(r.s) + '–' + D.hm(r.e) + ' · 겹치는 일정 없음'));
      if (dueWarn) preview.appendChild(h('div.conflict-box', { style: { marginTop: '6px' } }, dueWarn));
      if (r.s < now && !block) preview.appendChild(h('div.help', { style: { marginTop: '6px' } }, '지난 시간입니다. 이미 한 일을 기록하는 용도라면 그대로 저장하세요.'));
    }
    [dateIn, timeIn, durIn].forEach(function (el) { el.addEventListener('change', update); el.addEventListener('input', update); });

    function nextFree() {
      var f = findFreeSlot(S.state, now, Number(durIn.value), block && block.id);
      dateIn.value = D.ymd(f); timeIn.value = D.hm(f); update();
    }

    function commit() {
      var r = range();
      if (isNaN(r.s.getTime())) { ui.toast('날짜와 시각을 확인해 주세요.'); return false; }
      if (isEvent && !titleIn.value.trim()) { ui.toast('일정 이름을 입력해 주세요.'); titleIn.focus(); return false; }
      // 저장 직전 최신 일정으로 다시 확인
      var c = M.conflictsFor(S.state, r.s.toISOString(), r.e.toISOString(), block && block.id);
      if (c.length && !allowConflict) {
        update();
        allowConflict = true;
        ui.toast('겹치는 일정이 있습니다. 그래도 배치하려면 한 번 더 눌러 주세요.');
        return false;
      }
      var fields = { start: r.s.toISOString(), end: r.e.toISOString() };
      if (isEvent) fields.title = titleIn.value.trim();
      S.mutate(block ? '일정 변경' : '일정에 배치', function (s) {
        if (block) M.updateBlock(s, block.id, fields);
        else M.addBlock(s, Object.assign({ taskId: task ? task.id : null, kind: task ? 'work' : 'event' }, fields));
      });
      ui.undoToast((task ? '‘' + task.title + '’ 작업 시간을 ' : '일정을 ') + D.relDay(D.ymd(r.s), now) + ' ' + D.hm(r.s) + '에 ' + (block ? '옮겼습니다.' : '배치했습니다.') + (task ? ' 마감일은 바뀌지 않습니다.' : ''));
      return true;
    }

    var body = [
      task ? h('div', h('div.meta', '할 일'), h('div', { style: { fontWeight: 600, fontSize: '15px' } }, task.title),
        task.dueDate ? h('div.meta', '마감 ' + D.relDay(task.dueDate, now) + (task.dueTime ? ' ' + task.dueTime : '') + ' — 작업 시간과 별개입니다') : null)
        : h('div.field', h('label', '일정 이름'), titleIn),
      h('div.field-row', h('div.field', h('label', '날짜'), dateIn), h('div.field', h('label', '시작'), timeIn)),
      h('div.field-row', h('div.field', h('label', '길이'), durIn),
        h('div.field', h('label', ' '), h('button.btn', { type: 'button', onclick: nextFree }, '다음 빈 시간 찾기'))),
      block && block.sources && block.sources.length ? h('div.help', block.origin === 'ai_accepted' ? 'AI 초안에서 확정한 일정 · ' : '', '출처: ',
        (function (src) { var r = M.resolveRef(st, src); return r.missing ? '원본 메모가 삭제되었습니다' : h('button.link-btn', { type: 'button', onclick: function () { m.close(); A.openRef(src); } }, '‘' + r.label + '’'); })(block.sources[0]),
        block.sources[0].excerpt ? ' — “' + block.sources[0].excerpt + '”' : '') : null,
      unknownEst ? h('div.help', '소요 시간이 정해지지 않아 30분으로 잡았습니다. 길이를 바꿔 주세요.') : null,
      preview,
      h('div.help', '빈 시간은 앱 캘린더 기준의 후보입니다. 실제로 여유가 있는지는 직접 확인해 주세요.')
    ];

    var actions = [{ label: '취소' }, { label: block ? '변경 저장' : '배치', primary: true, onClick: commit }];
    var footLeft = null;
    if (block) {
      footLeft = h('button.btn.btn-danger', { type: 'button', onclick: function () {
        S.mutate('일정 삭제', function (s) { M.deleteBlock(s, block.id); });
        m.close();
        ui.undoToast(task ? '작업 시간을 지웠습니다. 할 일은 그대로 있습니다.' : '일정을 지웠습니다.');
      } }, task ? '이 작업 시간 삭제' : '일정 삭제');
    }
    var m = ui.modal({
      title: block ? (task ? '작업 시간 변경' : '일정 수정') : task ? '일정에 배치' : '일정 추가',
      body: body, actions: actions, footLeft: footLeft
    });
    if (task && block) {
      m.foot.insertBefore(h('button.btn', { type: 'button', onclick: function () { m.close(); A.openTask(task.id); } }, '할 일 열기'), m.foot.children[1]);
    }
    update();
    return m;
  }

  DN.views.schedule = { open: open, findFreeSlot: findFreeSlot };
})();
