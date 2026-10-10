'use strict';

// ‘일정에 배치’ 대화상자 — 끌기의 키보드 대체 동작이자, 일반 일정 추가·수정 창.
// 겹침은 DN.slots 로 계산한다(Daynote 블록 + Google 바쁜 일정). 저장 직전에 최신 일정으로 다시 확인한다.
// 겹치면 주 버튼을 막고 [다른 시간 찾기]/[겹쳐 배치]를 보인다(FEATURES §3.2).
// 할 일이면 배치 알고리즘(DN.planner)의 추천 시간 칩 3개를 보인다(CAL §7.1).

(function () {
  var DN = window.Daynote;
  var M = DN.model, D = DN.dates, S = DN.store, ui = DN.ui, h = ui.h;
  var MAX_LEN = 240;

  function SL() { return DN.slots || null; }
  function PL() { return DN.planner || null; }
  function G() { return DN.gcal || null; }
  function q(s) { return '‘' + s + '’'; }

  function roundUp15(d) {
    if (SL()) return SL().roundUp15(d);
    d = new Date(d);
    d.setSeconds(0, 0);
    var m = d.getMinutes();
    if (m % 15) d.setMinutes(m + (15 - m % 15));
    return d;
  }

  // from 이후 첫 빈 구간(근무 시간 또는 07:00–23:00). 일정 정보가 이것뿐이므로 ‘후보’일 뿐 실제 여유를 보장하지 않는다.
  function findFreeSlot(state, from, minutes, ignoreId) {
    if (!SL()) return roundUp15(from);
    var wh = SL().normalizeWorkHours(state.prefs.workHours), now = DN.app.now();
    var busy = SL().collectBusy(state, from, D.addDays(from, SL().SEARCH_DAYS + 1), { ignoreId: ignoreId });
    var r = SL().findSlot(busy, { from: from, now: now, minutes: minutes, workHours: wh, mode: SL().defaultMode(from, wh) });
    return r.found ? r.start : roundUp15(from);   // 못 찾으면 예전처럼 from (미리보기가 겹침을 보여 준다)
  }

  function conflictsAt(state, s, e, ignoreId) {
    if (SL()) return SL().conflicts(SL().collectBusy(state, s, e, { ignoreId: ignoreId || null }), s, e);
    return M.conflictsFor(state, s.toISOString(), e.toISOString(), ignoreId || null);
  }

  function describeConflicts(state, list) {
    return list.map(function (b) {
      var t = b.taskId ? M.byId(state.tasks, b.taskId) : null;
      var google = b.provider === 'google' || b.external === 'google';
      return q(t ? t.title : b.title || '일정') + ' ' + D.hm(new Date(b.start)) + '–' + D.hm(new Date(b.end)) + (google ? ' (Google)' : '');
    }).join(', ');
  }

  // '오늘(토)' · '내일(일)' · '10월 12일 (월)'
  function dayWd(d, now) {
    var r = D.relDay(D.ymd(d), now);
    return /\(/.test(r) ? r : r + '(' + D.WEEKDAYS[d.getDay()] + ')';
  }

  var SYNC_TEXT = {
    synced: 'Google 캘린더 ‘Daynote’에 반영됨',
    pending: 'Google에 올리는 중이에요',
    failed: 'Google에 올리지 못했어요 · 설정에서 확인',
    uncertain: '시각을 확인하면 Google에 올라가요'
  };
  function syncLine(block) {
    var gs = DN.gcalSync, g = G();
    if (!block || !gs || !gs.status || !g || !g.blockSyncState) return null;
    var stt = null;
    try { stt = gs.status(); } catch (e) { return null; }
    if (!stt || !stt.signedIn) return null;
    var gc = S.state.gcal;
    if (!gc || !gc.settings || !gc.settings.exportEnabled) return null;
    var ctx = gs.ctx ? gs.ctx() : { now: DN.app.now() };
    var state = g.blockSyncState(S.state, block.id, ctx);
    if (!state || !SYNC_TEXT[state]) return null;
    return h('div.sched-sync.is-' + state, ui.icon(state === 'synced' ? 'check' : state === 'failed' ? 'alert' : 'refresh'), ' ' + SYNC_TEXT[state]);
  }

  // opts: { taskId?, blockId?, start?: Date, minutes?, event?: true }
  function open(opts) {
    opts = opts || {};
    var A = DN.app;
    var st = S.state;
    var block = opts.blockId ? M.byId(st.blocks, opts.blockId) : null;
    var task = M.byId(st.tasks, opts.taskId || (block && block.taskId));
    var isEvent = !task;
    var now = A.now();
    var wh = SL() ? SL().normalizeWorkHours(st.prefs.workHours) : null;

    var est = task && task.estimateMinutes != null ? task.estimateMinutes : null;
    var minutes = block ? D.minutesBetween(block.start, block.end)
      : opts.minutes || (est ? Math.min(est, MAX_LEN) : isEvent ? 60 : 30);
    var unknownEst = !!(task && est == null && !block && !opts.minutes);
    var aiEst = !!(task && !block && !opts.minutes && est != null && task.estimateSource === 'ai');
    var capped = !!(task && !block && !opts.minutes && est != null && est > MAX_LEN);
    var lenTouched = false;

    // 처음 시작 시각: 지정 → 블록 → (할 일) 오늘의 추천 1순위 → 가까운 날 → 빈 시간
    var start = block ? new Date(block.start) : opts.start ? new Date(opts.start) : null;
    if (!start && task && PL()) {
      var po = { now: now, minutes: minutes, workHours: st.prefs.workHours, limit: 1 };
      var first = PL().suggestSlots(st, task.id, D.ymd(now), po)[0];
      if (first) start = new Date(first.start);
      else {
        var nd = PL().nearestDay(st, task.id, D.ymd(now), po);
        if (nd) start = new Date(nd.candidate.start);
      }
    }
    if (!start) start = findFreeSlot(st, now, minutes);

    var titleIn = h('input.input', { value: block ? (block.title || '') : '', placeholder: '일정 이름 (예: 팀 회의)', 'aria-label': '일정 이름' });
    var dateIn = h('input.input', { type: 'date', value: D.ymd(start), 'aria-label': '날짜' });
    var timeIn = h('input.input', { type: 'time', step: '900', value: D.hm(start), 'aria-label': '시작 시각' });
    var tail = unknownEst ? ' (제안)' : aiEst ? ' (AI 추정)' : '';
    var durIn = h('select.select', { 'aria-label': '길이' },
      [15, 30, 45, 60, 90, 120, 180, 240].concat([minutes]).filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; })
        .map(function (m) { return h('option', { value: m, selected: m === minutes }, D.duration(m) + (m === minutes ? tail : '')); }));
    var guessChip = unknownEst ? h('span.chip.chip-guess', '제안값') : aiEst ? h('span.chip.chip-guess', 'AI 추정') : null;
    var lenHelp = unknownEst ? h('div.help', '소요 시간이 정해지지 않아 30분을 제안했어요. 맞는 길이를 골라 주세요.')
      : capped ? h('div.help', '소요 시간(' + D.duration(est) + ')이 길어 ' + D.duration(MAX_LEN) + '만 잡았어요. 나눠서 여러 번 배치해도 좋아요.') : null;
    var saveCb = unknownEst ? h('input', { type: 'checkbox' }) : null;
    var saveRow = saveCb ? h('label.check-row', saveCb, '이 길이를 ‘소요 시간’으로도 저장') : null;

    var preview = h('div#sched-preview', { 'aria-live': 'polite' });
    var state = 'idle';     // idle | conflict | found | not_found
    var found = null;       // { prev:{date,time}, text }
    var m = null;

    function range() {
      var s = D.parseYmd(dateIn.value, timeIn.value || '09:00');
      return { s: s, e: D.addMinutes(s, Number(durIn.value)) };
    }
    function primary() { return m ? m.foot.querySelector('.btn-primary') : null; }
    function setPrimary(enabled) {
      var b = primary();
      if (!b) return;
      b.disabled = !enabled;
      if (enabled) { b.removeAttribute('title'); b.removeAttribute('aria-describedby'); }
      else { b.title = '겹치는 일정이 있어요. 위에서 골라 주세요.'; b.setAttribute('aria-describedby', 'sched-preview'); }
    }
    function scopeText(mode) {
      return mode === 'work' && wh ? '근무 시간(' + SL().describeWorkHours(wh) + ') 안에서' : '07:00–23:00 사이에서';
    }

    function update(o) {
      o = o || {};
      var r = range();
      preview.textContent = '';
      if (isNaN(r.s.getTime())) { setPrimary(true); return; }
      var c = conflictsAt(S.state, r.s, r.e, block && block.id);
      if (!o.fromSearch && !o.keepNotFound) found = null;
      var when = D.relDay(D.ymd(r.s), now) + ' ' + D.hm(r.s) + '–' + D.hm(r.e);
      if (o.notFound) state = 'not_found';
      else if (found && o.fromSearch) state = 'found';
      else state = c.length ? 'conflict' : 'idle';
      if (state === 'found') {
        preview.appendChild(h('div.ok-box', found.text, ' ',
          h('button.link-btn', { type: 'button', onclick: function () {
            dateIn.value = found.prev.date; timeIn.value = found.prev.time; found = null; update(); refreshSugg();
          } }, '원래 시간으로')));
      } else if (c.length) {
        var findBtn = h('button.btn.btn-sm.btn-primary', { type: 'button', disabled: state === 'not_found', onclick: searchOther }, '다른 시간 찾기');
        preview.appendChild(h('div.conflict-box', ui.icon('alert'), ' ' + when + ' · 겹치는 일정: ' + describeConflicts(S.state, c),
          state === 'not_found' && o.notFoundText ? h('div.conflict-note', o.notFoundText) : null,
          h('div.conflict-actions', findBtn,
            h('button.btn.btn-sm', { type: 'button', onclick: function () { if (commit({ force: true })) m.close(); } }, '겹쳐 배치'))));
      } else {
        preview.appendChild(h('div.ok-box', when + ' · 겹치는 일정 없음'));
      }
      setPrimary(state === 'idle' || state === 'found');
      if (task && task.dueDate && D.parseYmd(task.dueDate, task.dueTime || '23:59') < r.s) {
        preview.appendChild(h('div.conflict-box.sched-due', '마감(' + D.relDay(task.dueDate, now) + (task.dueTime ? ' ' + task.dueTime : '') + ')보다 늦은 시간이에요.'));
      }
      if (r.s < now && !block) preview.appendChild(h('div.help.sched-past', '지난 시간이에요. 이미 한 일을 기록하는 거라면 그대로 저장하세요.'));
      paintPressed();
    }

    function searchOther() {
      if (!SL()) return;
      var r = range();
      var from = r.s < now ? now : r.s;
      var busy = SL().collectBusy(S.state, from, D.addDays(from, 15), { ignoreId: block && block.id });
      var len = Number(durIn.value);
      var res = SL().findSlot(busy, { from: from, now: now, minutes: len, workHours: wh, mode: SL().pickMode(r.s, wh) });
      if (!res.found) {
        var txt = res.reason === 'too_long'
          ? ui.josa(D.duration(len), '는/은') + ' 근무 시간보다 길어요.'
          : scopeText(res.mode) + ' ' + SL().SEARCH_DAYS + '일 동안 ' + D.duration(len) + ' 빈 시간을 찾지 못했어요. 길이를 줄이거나 겹쳐 배치할 수 있어요.';
        update({ notFound: true, notFoundText: txt, keepNotFound: true });
        return;
      }
      var prev = { date: dateIn.value, time: timeIn.value };
      var s = res.start, e = res.end;
      var span = dayWd(s, now) + ' ' + D.hm(s) + '–' + D.hm(e);
      var text = res.sameDay
        ? '빈 시간으로 옮겼어요 · ' + span + ' · ' + scopeText(res.mode) + ' 찾았어요'
        : D.relDay(D.ymd(r.s), now) + '은 빈 시간이 없어 ' + span + (/0$/.test(span) ? '으로' : '로') + ' 옮겼어요 · ' + scopeText(res.mode) + ' 찾았어요';
      found = { prev: prev, text: text };
      dateIn.value = D.ymd(s); timeIn.value = D.hm(s);
      update({ fromSearch: true });
      refreshSugg(true);
      var b = primary();
      if (b) setTimeout(function () { b.focus(); }, 0);
    }

    // ---------------------------------------------------------- 추천 시간 칩 (CAL §7.1)
    var suggBox = null, suggRow = null, suggHelp = null, suggList = [];
    if (task && PL()) {
      suggRow = h('div.sched-sugg', { role: 'group', 'aria-label': '추천 시간' });
      suggHelp = h('div.help.sched-sugg-help');
      suggBox = h('div.field', h('label', '추천 시간'), suggRow, suggHelp);
    }
    function paintPressed() {
      if (!suggRow) return;
      Array.prototype.forEach.call(suggRow.querySelectorAll('.sched-sugg-chip'), function (b) {
        b.setAttribute('aria-pressed', String(b.getAttribute('data-time') === timeIn.value));
      });
    }
    function refreshSugg(keepFound) {
      if (!suggRow) return;
      suggRow.textContent = '';
      suggHelp.textContent = '';
      if (!dateIn.value) return;
      var o = { now: now, minutes: Number(durIn.value), workHours: S.state.prefs.workHours, limit: 3 };
      if (block) o.ignoreBlockId = block.id;
      suggList = PL().suggestSlots(S.state, task.id, dateIn.value, o);
      if (!suggList.length) {
        suggRow.appendChild(h('span.meta', '이 날에는 추천할 시간이 없어요.'));
        suggRow.appendChild(h('button.link-btn', { type: 'button', onclick: function () {
          var nd = PL().nearestDay(S.state, task.id, dateIn.value, o);
          if (!nd) { suggHelp.textContent = '가까운 날에도 알맞은 시간이 없어요.'; return; }
          dateIn.value = nd.ymd; timeIn.value = D.hm(nd.candidate.start);
          refreshSugg(); update();
        } }, '가까운 날 보기'));
        return;
      }
      suggList.forEach(function (c) {
        suggRow.appendChild(h('button.pill.sched-sugg-chip', { type: 'button', 'data-time': D.hm(c.start), 'aria-pressed': 'false', title: c.reasons.join(' '),
          onclick: function () { timeIn.value = D.hm(c.start); update(); } }, D.hm(c.start) + ' · ' + c.label));
      });
      suggHelp.textContent = suggList[0].reasons[0] || '';
      if (!keepFound) paintPressed();
    }

    dateIn.addEventListener('change', function () { update(); refreshSugg(); });
    dateIn.addEventListener('input', function () { update(); });
    timeIn.addEventListener('change', function () { update(); });
    timeIn.addEventListener('input', function () { update(); });
    durIn.addEventListener('change', function () {
      if (!lenTouched) {
        lenTouched = true;
        if (guessChip) guessChip.remove();
        Array.prototype.forEach.call(durIn.options, function (op) { op.textContent = D.duration(Number(op.value)); });
        if (saveCb) saveCb.checked = true;
      }
      update(); refreshSugg();
    });

    function commit(o) {
      o = o || {};
      var r = range();
      if (isNaN(r.s.getTime())) { ui.toast('날짜와 시각을 확인해 주세요.'); return false; }
      if (isEvent && !titleIn.value.trim()) { ui.toast('일정 이름을 입력해 주세요.'); titleIn.focus(); return false; }
      // 저장 직전 최신 일정으로 다시 확인
      var c = conflictsAt(S.state, r.s, r.e, block && block.id);
      if (c.length && !o.force) { found = null; update(); return false; }
      var len = Number(durIn.value);
      var fields = { start: r.s.toISOString(), end: r.e.toISOString() };
      if (isEvent) fields.title = titleIn.value.trim();
      var guessed = unknownEst && !lenTouched;
      var saveEst = !!(saveCb && saveCb.checked && task);
      var tnow = A.now();
      S.mutate(block ? '일정 변경' : '일정에 배치', function (s) {
        if (saveEst) M.updateTask(s, task.id, { estimateMinutes: len }, tnow);
        if (block) M.updateBlock(s, block.id, fields);
        else M.addBlock(s, Object.assign({ taskId: task ? task.id : null, kind: task ? 'work' : 'event' }, guessed ? { durationGuessed: true } : {}, fields));
      });
      var when = D.relDay(D.ymd(r.s), now) + ' ' + D.hm(r.s);
      var msg;
      if (block) msg = (task ? q(task.title) + ' 작업 시간을 ' : '일정을 ') + when + (/0$/.test(when) ? '으로' : '로') + ' 옮겼어요.';
      else if (!task) msg = '일정을 ' + when + '에 배치했어요.';
      else if (guessed) msg = q(task.title) + ' 작업 시간을 ' + when + '에 ' + D.duration(len) + '(제안값)으로 배치했어요. 길이는 캘린더에서 바꿀 수 있어요.';
      else if (saveEst) msg = q(task.title) + ' 작업 시간을 ' + when + '에 배치했어요. 소요 시간도 ' + ui.josa(D.duration(len), '로/으로') + ' 저장했어요.';
      else msg = q(task.title) + ' 작업 시간을 ' + when + '에 배치했어요. 마감일은 그대로예요.';
      if (o.force && c.length) msg += ' 다른 일정과 겹쳐요.';
      ui.undoToast(msg);
      return true;
    }

    var hasExt = typeof M.externalItems === 'function' && M.externalItems(S.state).length > 0;
    var body = [
      task ? h('div', h('div.meta', '할 일'), h('div.sched-task-title', task.title),
        task.dueDate ? h('div.meta', '마감 ' + D.relDay(task.dueDate, now) + (task.dueTime ? ' ' + task.dueTime : '') + ' — 작업 시간과 별개예요') : null)
        : h('div.field', h('label', '일정 이름'), titleIn),
      h('div.field', h('label', '길이', guessChip ? ' ' : null, guessChip), durIn),
      lenHelp,
      saveRow,
      suggBox,
      h('div.field-row', h('div.field', h('label', '날짜'), dateIn), h('div.field', h('label', '시작'), timeIn)),
      block && block.sources && block.sources.length ? h('div.help', block.origin === 'ai_accepted' ? 'AI 초안에서 확정한 일정 · ' : '', '출처: ',
        (function (src) { var r = M.resolveRef(st, src); return r.missing ? '원본 메모가 삭제되었어요' : h('button.link-btn', { type: 'button', onclick: function () { m.close(); A.openRef(src); } }, q(r.label)); })(block.sources[0]),
        block.sources[0].excerpt ? ' — “' + block.sources[0].excerpt + '”' : '') : null,
      preview,
      block ? syncLine(block) : null,
      h('div.help', hasExt
        ? '빈 시간은 Daynote 캘린더와 Google 캘린더 기준이에요. 실제 여유는 직접 확인해 주세요.'
        : '빈 시간은 Daynote 캘린더 기준이에요. 실제 여유는 직접 확인해 주세요.')
    ];

    var actions = [{ label: '취소' }, { label: block ? '변경 저장' : '배치', primary: true, onClick: function () { return commit(); } }];
    var footLeft = null;
    if (block) {
      footLeft = h('button.btn.btn-danger', { type: 'button', onclick: function () {
        S.mutate('일정 삭제', function (s) { M.deleteBlock(s, block.id); });
        m.close();
        ui.undoToast(task ? '작업 시간을 지웠어요. 할 일은 그대로 있어요.' : '일정을 지웠어요.');
      } }, task ? '이 작업 시간 삭제' : '일정 삭제');
    }
    m = ui.modal({
      title: block ? (task ? '작업 시간 변경' : '일정 수정') : task ? '일정에 배치' : '일정 추가',
      body: body, actions: actions, footLeft: footLeft
    });
    m.box.classList.add('sched-modal');
    if (task && block) {
      m.foot.insertBefore(h('button.btn', { type: 'button', onclick: function () { m.close(); A.openTask(task.id); } }, '할 일 열기'), m.foot.children[1]);
    }
    refreshSugg();
    update();
    return m;
  }

  DN.views.schedule = { open: open, findFreeSlot: findFreeSlot };
})();
