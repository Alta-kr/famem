'use strict';

// 캘린더에 할 일 넣기 — 날짜 칸에 놓으면 알맞은 시간에 자동으로(DN.planner), 시간표에 놓으면 그 시각에.
// 소요 시간이 없으면 먼저 묻고, 넣을 자리가 없으면 까닭과 가까운 날·나눠 넣기를 보여 준다.
// 저장은 늘 최신 상태로 다시 계산한 뒤 한 번의 S.mutate 로 한다(되돌리기 한 번에 사라진다).
// 주간·일간 시간표와 하루 패널이 같이 쓰는 시간표 그리기 도구(_tl)도 여기에 둔다.

(function () {
  var DN = window.Daynote;
  var M = DN.model, D = DN.dates, S = DN.store, ui = DN.ui, h = ui.h;
  var HOUR_PX = 48, SNAP = 15, DAY_MIN = 24 * 60;
  var DUR_CHOICES = [15, 30, 60, 90, 120];

  function PL() { return DN.planner || null; }
  function SL() { return DN.slots || null; }
  function A() { return DN.app; }
  function now() { return DN.app.now(); }
  function q(s) { return '‘' + s + '’'; }
  // 조사는 따옴표 안 낱말에 맞춘다: ‘엄마 생신 선물 주문’을
  function qj(s, pair) { var w = ui.josa(s, pair); return q(s) + w.slice(String(s).length); }
  function calMem() { return DN.views.calendar && DN.views.calendar._mem ? DN.views.calendar._mem : null; }
  function planOpts(extra) {
    var o = { now: now(), workHours: S.state.prefs.workHours };
    Object.keys(extra || {}).forEach(function (k) { if (extra[k] !== undefined) o[k] = extra[k]; });
    return o;
  }
  function liveTask(id) {
    var t = M.byId(S.state.tasks, id);
    return t && !t.deletedAt ? t : null;
  }
  // 숫자로 끝나는 시각에 붙는 조사: '21:00으로' · '19:45로'
  function timeRo(hm) { return hm + (/0$/.test(hm) ? '으로' : '로'); }
  function fmtDay(d) { return PL() ? PL().fmtDay(d, now()) : D.relDay(D.ymd(d), now()); }
  function fmtRange(s, e) { return D.hm(s) + '–' + D.hm(e); }
  function shortDay(ymd) {
    var d = D.parseYmd(ymd);
    return (d.getMonth() + 1) + '/' + d.getDate() + '(' + D.WEEKDAYS[d.getDay()] + ')';
  }
  function lengthFor(t) {
    var r = PL() ? PL().remainingMinutes(S.state, t, now()) : null;
    if (r != null && r > 0) return r;
    return t.estimateMinutes != null ? t.estimateMinutes : null;
  }
  function busyConflicts(s, e, ignoreId) {
    if (SL()) return SL().conflicts(SL().collectBusy(S.state, s, e, { ignoreId: ignoreId || null }), s, e);
    return M.conflictsFor(S.state, s.toISOString(), e.toISOString(), ignoreId || null);
  }

  // ------------------------------------------------------------------ 팝오버 (캘린더 다시 그리기 보호)
  // 열려 있는 동안 calendar 의 onChange 는 다시 그리지 않고 mem.dirty 만 세운다. 닫히면 밀린 것을 그린다.
  function settle() {
    var cm = calMem();
    if (!cm) return;
    cm.popOpen = false;
    setTimeout(function () {
      if (!cm.dirty || cm.popOpen || (DN.dragPlace && DN.dragPlace.active())) return;
      cm.dirty = false;
      if (A().current().view === 'calendar') A().refresh();
    }, 0);
  }
  function pop(anchor, node, opts) {
    opts = opts || {};
    var p = ui.popover(anchor, node, {
      label: opts.label, className: opts.className, keepOnResize: true, role: opts.role,
      onClose: function () { settle(); if (opts.onClose) opts.onClose(); }
    });
    var cm = calMem();
    if (cm) cm.popOpen = true;
    return p;
  }
  function anchorFor(el, ymd) {
    if (el && el.isConnected) return el;
    var c = ymd ? document.querySelector('.cm-day[data-day="' + ymd + '"]') : null;
    if (c) return c;
    c = ymd ? document.querySelector('.cd-sheet .cd-head h3') : null;
    return c || document.querySelector('.cal-head h2') || document.body;
  }
  // 팝오버에서 고른 뒤 다시 그려져 포커스를 잃었으면 그 날짜 칸으로 (하루 패널이 열려 있으면 패널이 맡는다)
  function refocus(ymd) {
    setTimeout(function () {
      var cd = DN.views.calDay;
      if (cd && cd.isOpen && cd.isOpen()) return;
      var ae = document.activeElement;
      if (ae && ae !== document.body) return;
      var c = document.querySelector('.cm-day[data-day="' + ymd + '"]');
      if (c) try { c.focus(); } catch (e) { /* 없음 */ }
    }, 0);
  }
  function focusFirst(el, sel) {
    setTimeout(function () { var f = el.querySelector(sel); if (f && f.isConnected) try { f.focus(); } catch (e) { /* 없음 */ } }, 0);
  }

  // ------------------------------------------------------------------ 새 블록 잠깐 강조 (.is-new 1.2 s)
  var flashed = { id: null, until: 0 };
  function flash(id) {
    flashed = { id: id, until: Date.now() + 1200 };
    setTimeout(function () {
      var el = document.querySelector('[data-block-id="' + id + '"]');
      if (el) el.classList.remove('is-new');
    }, 1250);
  }
  function isFlashed(id) { return flashed.id === id && Date.now() < flashed.until; }

  // ------------------------------------------------------------------ 저장 + 알림
  // block: { start: ISO, end: ISO } · o: { minutes, save, ymd, tail, other:true(→[다른 시간]) }
  function commitBlock(t, block, o) {
    o = o || {};
    var tnow = now(), newId = null;
    S.mutate('일정에 배치', function (s) {
      if (o.save) M.updateTask(s, t.id, { estimateMinutes: o.minutes }, tnow);
      newId = M.addBlock(s, { taskId: t.id, kind: 'work', start: block.start, end: block.end }).id;
    }, { source: 'calendar' });
    flash(newId);
    var s = new Date(block.start), e = new Date(block.end);
    var msg = qj(t.title, '를/을') + ' ' + fmtDay(s) + ' ' + fmtRange(s, e) + '에 넣었어요.' +
      (o.save ? ' 소요 시간도 ' + ui.josa(D.duration(o.minutes), '로/으로') + ' 저장했어요.' : '') + (o.tail || '');
    if (o.other && ui.TOAST_ACTIONS) {
      ui.toast(msg, {
        duration: 9000,
        actions: [
          { label: '다른 시간', fn: function () { alternativesPopover(newId, D.ymd(s)); } },
          { label: '되돌리기', fn: function () { S.undo(); } }
        ]
      });
    } else ui.undoToast(msg);
    var cd = DN.views.calDay;
    if (cd && cd.isOpen && cd.isOpen() && cd.repaint) setTimeout(function () { if (cd.isOpen()) cd.repaint(); }, 0);
    refocus(D.ymd(s));
    return newId;
  }

  // ------------------------------------------------------------------ 소요 시간 묻기 (§3.2)
  function askDuration(anchorEl, task) {
    return new Promise(function (resolve) {
      var done = false;
      function finish(v) { if (done) return; done = true; resolve(v); }
      var hints = PL() ? PL().hintsOf(task) : {};
      var deep = hints && hints.focus === 'deep';
      var suggested = deep ? 60 : 30;
      var err = h('div.field-error#dur-err', { role: 'alert' });
      var input = h('input.input#dur-custom', { type: 'text', inputmode: 'text', placeholder: '직접: 45분, 1:30', 'aria-describedby': 'dur-err', 'aria-label': '소요 시간 직접 입력', autocomplete: 'off' });
      var save = h('input', { type: 'checkbox', checked: true });
      var p;
      function pick(min) { finish({ minutes: min, save: !!save.checked }); p.close(false); }
      function fromInput() {
        var v = input.value.trim();
        if (!v) { pick(suggested); return; }
        var r = D.parseDuration(v);
        if (!r.ok) { err.textContent = r.message; input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
        pick(r.minutes);
      }
      input.addEventListener('keydown', function (e) {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') { e.preventDefault(); fromInput(); }
      });
      input.addEventListener('input', function () { err.textContent = ''; input.removeAttribute('aria-invalid'); });
      var phoneNoKeep = !ui.POPOVER_KEEP_ON_RESIZE && window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
      var node = h('div.dur-pop-body',
        h('div.dur-pop-title', q(task.title) + ' 얼마나 걸릴까요?'),
        h('div.dur-chips', { role: 'group', 'aria-label': '소요 시간' },
          DUR_CHOICES.map(function (m) {
            return h('button.pill' + (deep && m === 60 ? '.is-suggested' : ''), { type: 'button', 'data-min': String(m), onclick: function () { pick(m); } }, D.duration(m));
          })),
        phoneNoKeep ? null : h('div.field', input, err),
        h('label.check-row', save, '할 일에 소요 시간으로 저장'),
        h('div.dur-foot',
          h('button.btn.btn-sm', { type: 'button', onclick: function () { finish(null); p.close(true); } }, '취소'),
          h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: fromInput }, '넣기')));
      p = pop(anchorFor(anchorEl), node, { label: '소요 시간', className: 'dur-pop', onClose: function () { finish(null); } });
      focusFirst(p.el, '.dur-chips button[data-min="' + suggested + '"]');
    });
  }

  // ------------------------------------------------------------------ 날짜 칸에 놓기 = 자동 배치 (§3.1)
  // opts: { minutes?, save? } — 이미 물어본 길이를 이어서 쓸 때
  function dropOnDay(taskId, ymd, anchorEl, opts) {
    opts = opts || {};
    var t = liveTask(taskId);
    if (!t || t.status === 'done') { ui.toast('이미 끝낸 일이에요.'); return Promise.resolve(false); }
    if (ymd < D.ymd(now())) { ui.toast('지난 날짜에는 넣을 수 없어요.'); return Promise.resolve(false); }
    if (!PL()) { A().scheduleTask(taskId, { start: D.parseYmd(ymd, '09:00') }); return Promise.resolve(false); }
    var minutes = opts.minutes != null ? opts.minutes : lengthFor(t);
    var ask = minutes == null ? askDuration(anchorFor(anchorEl, ymd), t) : Promise.resolve({ minutes: minutes, save: !!opts.save });
    return ask.then(function (d) {
      if (!d) return false;
      t = liveTask(taskId);
      if (!t || t.status === 'done') { ui.toast('이미 끝낸 일이에요.'); return false; }
      var r = PL().placeOnDay(S.state, t.id, ymd, planOpts({ minutes: d.minutes }));
      if (r.ok) { commitBlock(t, r.block, { minutes: d.minutes, save: d.save, other: true }); return true; }
      if (r.reason === 'after_due') afterDuePopover(t, ymd, r, anchorFor(anchorEl, ymd), d);
      else failPopover(t, ymd, r, anchorFor(anchorEl, ymd), d);
      return false;
    });
  }

  // 가까운 날(또는 마감 전 날)로 다시 계산해 넣는다
  function placeAlt(t, alt, d, allowAfterDue) {
    var r = PL().placeOnDay(S.state, t.id, alt.ymd, planOpts({ minutes: d.minutes, allowAfterDue: allowAfterDue || undefined }));
    if (r.ok) commitBlock(t, r.block, { minutes: d.minutes, save: d.save, other: true });
    else ui.toast(r.message);
  }

  // 넣을 자리가 없을 때 (§3.4)
  function failPopover(t, ymd, r, anchor, d) {
    var p;
    var alt = r.alternatives && r.alternatives[0];
    var split = r.split;
    var acts = h('div.pl-fail-actions',
      alt ? h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: function () { p.close(false); placeAlt(t, alt, d); } },
        '가장 가까운 날로 · ' + fmtDay(alt.ymd) + ' ' + D.hm(alt.candidate.start)) : null,
      split ? h('button.btn.btn-sm', { type: 'button', onclick: function () {
        p.close(false);
        var sp = PL().splitPlan(S.state, t.id, ymd, planOpts({ minutes: d.minutes })) || split;
        commitBlock(t, { start: sp.first.startIso, end: sp.first.endIso }, {
          minutes: d.minutes, save: d.save, other: true,
          tail: ' 나머지 ' + ui.josa(D.duration(sp.restMinutes), '는/은') + ' 왼쪽 목록에 남아 있어요.'
        });
      } }, '첫 ' + D.duration(split.chunkMinutes) + '만 넣기') : null,
      h('button.btn.btn-sm', { type: 'button', onclick: function () { p.close(false); openDay(ymd, { openedBy: 'fail', taskId: t.id, focus: true }); } }, '그날 열어서 직접'));
    var node = h('div.pl-fail',
      h('div.pl-fail-title', r.message),
      r.detail ? h('div.meta', r.detail) : null,
      split ? h('div.meta', '나눠서 하면 들어가요: 첫 ' + ui.josa(D.duration(split.chunkMinutes), '를/을') + ' 넣고 나머지 ' +
        ui.josa(D.duration(split.restMinutes), '는/은') + ' 나중에.') : null,
      acts);
    p = pop(anchor, node, { label: '넣을 자리가 없어요', className: 'pl-pop' });
    focusFirst(p.el, '.pl-fail-actions button');
  }

  // 마감보다 늦은 날 (§3.5)
  function afterDuePopover(t, ymd, r, anchor, d) {
    var p;
    var alt = r.alternatives && r.alternatives[0];
    var node = h('div.pl-fail',
      h('div.pl-fail-title', r.message),
      h('div.pl-fail-actions',
        alt ? h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: function () { p.close(false); placeAlt(t, alt, d); } },
          '마감 전 가장 가까운 날로 · ' + fmtDay(alt.ymd) + ' ' + D.hm(alt.candidate.start)) : null,
        h('button.btn.btn-sm', { type: 'button', onclick: function () {
          p.close(false);
          var r2 = PL().placeOnDay(S.state, t.id, ymd, planOpts({ minutes: d.minutes, allowAfterDue: true }));
          if (r2.ok) commitBlock(t, r2.block, { minutes: d.minutes, save: d.save, other: true });
          else failPopover(t, ymd, r2, anchorFor(anchor, ymd), d);
        } }, '그래도 이 날에 넣기'),
        h('button.btn.btn-sm', { type: 'button', onclick: function () { p.close(false); openDay(ymd, { openedBy: 'fail', taskId: t.id, focus: true }); } }, '그날 열어서 직접')));
    p = pop(anchor, node, { label: '마감보다 늦은 날', className: 'pl-pop' });
    focusFirst(p.el, '.pl-fail-actions button');
  }

  function openDay(ymd, opts) {
    if (DN.views.calDay && DN.views.calDay.open) DN.views.calDay.open(ymd, opts);
  }

  // ------------------------------------------------------------------ [다른 시간] (§3.3)
  function alternativesPopover(blockId, ymd) {
    var b = M.byId(S.state.blocks, blockId);
    if (!b) return;
    var t = b.taskId ? liveTask(b.taskId) : null;
    var cell = document.querySelector('.cm-day[data-day="' + ymd + '"]');
    if (!cell || !t || !PL()) { if (DN.views.schedule) DN.views.schedule.open({ blockId: blockId }); return; }
    var minutes = D.minutesBetween(b.start, b.end);
    var list = PL().suggestSlots(S.state, t.id, ymd, planOpts({ minutes: minutes, ignoreBlockId: blockId, limit: 4 }));
    var curStart = new Date(b.start).getTime();
    var mine = list.filter(function (c) { return c.start.getTime() === curStart; })[0];
    var others = list.filter(function (c) { return c.start.getTime() !== curStart; }).slice(0, 3);
    var p;
    var node = h('div.pl-alt-body',
      h('div.pl-why-title', '이 시간에 넣은 까닭'),
      h('ul.pl-why', ((mine && mine.reasons) || ['직접 고른 시간이에요.']).map(function (x) { return h('li', x); })),
      others.length ? h('div.pl-alt-title', '다른 후보') : h('div.meta', '이 날에는 다른 후보가 없어요.'),
      others.map(function (c) {
        return h('button.pl-alt', { type: 'button', onclick: function () {
          p.close(false);
          S.mutate('일정 변경', function (s) { M.updateBlock(s, blockId, { start: c.startIso, end: c.endIso }); }, { source: 'calendar' });
          flash(blockId);
          ui.undoToast(fmtDay(c.start) + ' ' + timeRo(fmtRange(c.start, c.end)) + ' 옮겼어요.');
          refocus(ymd);
        } }, h('span.pl-alt-time', fmtRange(c.start, c.end)), ' · ' + (c.reasons[0] || ''));
      }),
      h('button.link-btn', { type: 'button', onclick: function () { p.close(false); openDay(ymd, { openedBy: 'alt', blockId: blockId, focus: true }); } }, '그날 열어서 직접 고르기'));
    p = pop(cell, node, { label: '다른 시간', className: 'pl-pop' });
    focusFirst(p.el, 'button');
  }

  // ------------------------------------------------------------------ 시간표에 놓기 (하루 패널 · 주간·일간)
  // opts: { blockId? (블록 옮기기), copy:'week'|'day' }
  function dropAtTime(taskId, startDate, anchorEl, opts) {
    opts = opts || {};
    var s = new Date(startDate);
    if (opts.blockId) {
      var b = M.byId(S.state.blocks, opts.blockId);
      if (!b) return Promise.resolve(false);
      // 같은 시각에 놓았으면(조금 움직였다 제자리) 아무것도 바꾸지 않는다 — 빈 되돌리기·알림을 만들지 않게
      if (new Date(b.start).getTime() === s.getTime()) return Promise.resolve(false);
      var len = D.minutesBetween(b.start, b.end);
      var e = D.addMinutes(s, len);
      var c = busyConflicts(s, e, b.id);
      S.mutate('일정 변경', function (st) { M.updateBlock(st, b.id, { start: s.toISOString(), end: e.toISOString() }); }, { source: 'calendar' });
      flash(b.id);
      ui.undoToast(fmtDay(s) + ' ' + timeRo(D.hm(s)) + ' 옮겼어요.' + (c.length ? ' 다른 일정과 겹쳐요.' : ''));
      repaintDay();
      return Promise.resolve(true);
    }
    var t = liveTask(taskId);
    if (!t || t.status === 'done') { ui.toast('이미 끝낸 일이에요.'); return Promise.resolve(false); }
    var minutes = lengthFor(t);
    var ask = minutes == null ? askDuration(anchorFor(anchorEl, D.ymd(s)), t) : Promise.resolve({ minutes: minutes, save: false });
    return ask.then(function (d) {
      if (!d) return false;
      t = liveTask(taskId);
      if (!t || t.status === 'done') return false;
      var e2 = D.addMinutes(s, d.minutes);
      var c2 = busyConflicts(s, e2, null);
      var tail = c2.length ? ' 다른 일정과 겹쳐요.' : '';
      if (opts.copy === 'week') {
        var tnow = now(), id = null;
        S.mutate('일정에 배치', function (st) {
          if (d.save) M.updateTask(st, t.id, { estimateMinutes: d.minutes }, tnow);
          id = M.addBlock(st, { taskId: t.id, kind: 'work', start: s.toISOString(), end: e2.toISOString() }).id;
        }, { source: 'calendar' });
        flash(id);
        ui.undoToast(q(t.title) + ' 작업 시간을 ' + fmtDay(s) + ' ' + D.hm(s) + '에 넣었어요.' +
          (d.save ? ' 소요 시간도 ' + ui.josa(D.duration(d.minutes), '로/으로') + ' 저장했어요.' : '') + tail);
      } else {
        commitBlock(t, { start: s.toISOString(), end: e2.toISOString() }, { minutes: d.minutes, save: d.save, tail: tail });
      }
      repaintDay();
      return true;
    });
  }
  function repaintDay() {
    var cd = DN.views.calDay;
    if (cd && cd.isOpen && cd.isOpen() && cd.repaint) setTimeout(function () { if (cd.isOpen()) cd.repaint(); }, 0);
  }

  // ------------------------------------------------------------------ 이 날 자동 배치 (§6)
  var SKIP_TEXT = {
    no_estimate: '소요 시간이 없어 뺀 일', no_slot: '빈 시간이 없어 뺀 일', no_window: '빈 시간이 없어 뺀 일',
    poor_fit: '알맞은 시간대가 없어 뺀 일', blocked: '선행 일이 남아 뺀 일', snoozed: '미뤄 둔 일', limit: '하루에 넣기엔 많아 뺀 일', past: '지난 날짜라 뺀 일'
  };
  function skipSummary(skipped) {
    var counts = {}, order = [];
    skipped.forEach(function (x) {
      var k = SKIP_TEXT[x.reason];
      if (!k) return;
      if (!counts[k]) { counts[k] = 0; order.push(k); }
      counts[k]++;
    });
    return order.map(function (k) { return k + ' ' + counts[k] + '개'; }).join(' · ');
  }
  function sig(r) { return JSON.stringify(r.placements.map(function (x) { return [x.taskId, x.block.start, x.block.end]; })); }

  function arrange(ymd, anchorEl, taskIds) {
    if (!PL()) return;
    var ids = (taskIds || []).slice();
    var r = PL().arrangeDay(S.state, ids, ymd, planOpts());
    var p = null, off = {};
    function body(res, note) {
      var summary = skipSummary(res.skipped);
      if (!res.placements.length) {
        return h('div.pl-arr',
          h('div.pl-arr-title', '넣을 수 있는 일이 없어요.'),
          summary ? h('div.meta', summary) : null,
          h('div.pl-fail-actions', h('button.btn.btn-sm', { type: 'button', onclick: function () { p.close(true); } }, '닫기')));
      }
      off = {};
      var go = h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: function () { commit(res); } });
      function count() {
        var n = res.placements.filter(function (x) { return !off[x.taskId]; }).length;
        go.textContent = '넣기 (' + n + '개)';
        go.disabled = n === 0;
      }
      var node = h('div.pl-arr',
        h('div.pl-arr-title', shortDay(ymd) + '에 ' + res.placements.length + '개를 이렇게 넣을까요?'),
        note ? h('div.meta', note) : null,
        // 보이는 순서는 시각순 (놓은 순서는 마감·우선순위순이라 읽기 어렵다)
        h('ul.pl-arr-list', res.placements.slice().sort(function (a, b) { return a.candidate.start - b.candidate.start; }).map(function (x) {
          var t = liveTask(x.taskId);
          var cb = h('input', { type: 'checkbox', checked: true, onchange: function () { off[x.taskId] = !cb.checked; count(); } });
          return h('li', h('label.check-row', cb, h('span', fmtRange(x.candidate.start, x.candidate.end) + ' ' + (t ? t.title : ''))),
            x.candidate.reasons[0] ? h('div.meta', x.candidate.reasons[0]) : null);
        })),
        summary ? h('div.meta', summary) : null,
        h('div.pl-fail-actions',
          h('button.btn.btn-sm', { type: 'button', onclick: function () { p.close(true); } }, '취소'),
          go));
      count();
      return node;
    }
    function commit(res) {
      var r2 = PL().arrangeDay(S.state, ids, ymd, planOpts());
      if (sig(r2) !== sig(res)) { r = r2; p.setContent(body(r2, '그 사이 일정이 바뀌어 다시 계산했어요.'), 'dialog'); return; }
      var chosen = res.placements.filter(function (x) { return !off[x.taskId]; });
      if (!chosen.length) return;
      p.close(false);
      if (DN.views.calDay && DN.views.calDay._focusNext) DN.views.calDay._focusNext('.cd-auto', 0);
      S.mutate('자동 배치', function (s) {
        chosen.forEach(function (x) { M.addBlock(s, { taskId: x.taskId, kind: 'work', start: x.block.start, end: x.block.end }); });
      }, { source: 'calendar' });
      ui.undoToast(shortDay(ymd) + '에 ' + chosen.length + '개를 넣었어요.');
      repaintDay();
    }
    p = pop(anchorFor(anchorEl, ymd), body(r), { label: '이 날 자동 배치', className: 'pl-arrange' });
    focusFirst(p.el, r.placements.length ? '.pl-fail-actions .btn-primary' : '.pl-fail-actions button');
  }

  // ------------------------------------------------------------------ 시간표 그리기 도구 (주간·일간·하루 패널)
  function minToPx(min) { return min / 60 * HOUR_PX; }
  function dayRange(ymd) {
    var s = D.parseYmd(ymd);
    return { s: s, e: D.addDays(s, 1), sIso: s.toISOString(), eIso: D.addDays(s, 1).toISOString() };
  }
  // 그날 시작한 시각 있는 항목(블록 + Google), 시작 → 긴 것 먼저 → id
  function timedItems(ymd) {
    var r = dayRange(ymd);
    return M.calendarItems(S.state, r.sIso, r.eIso, { includeAllDay: false })
      .filter(function (x) { return D.ymd(x.start) === ymd; })
      .sort(function (a, b) {
        var sa = new Date(a.start).getTime(), sb = new Date(b.start).getTime();
        if (sa !== sb) return sa - sb;
        var la = new Date(a.end).getTime() - sa, lb = new Date(b.end).getTime() - sb;
        if (la !== lb) return lb - la;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
  }
  // 종일 Google 일정 (여러 날이면 걸친 날마다)
  function allDayItems(ymd) {
    var r = dayRange(ymd);
    return M.calendarItems(S.state, r.sIso, r.eIso).filter(function (x) { return x.allDay; });
  }
  function extOpen(item, el) {
    if (DN.views.extEvent && DN.views.extEvent.open) DN.views.extEvent.open(item, el);
    else ui.toast(q(item.title) + ' · Google 일정이라 Daynote에서는 바꿀 수 없어요.');
  }
  function setGc(el, color) { if (color) el.style.setProperty('--gc', color); }

  // col 에 항목을 그린다. o: { cls:'cal-block'|..., extra:'cd-block', armBlock(el, b), onBlock(b, el) }
  function paintItems(col, ymd, o) {
    o = o || {};
    var st = S.state;
    var list = timedItems(ymd);
    var lanes = [], laneOf = {};
    function ms(v) { return new Date(v).getTime(); }
    list.forEach(function (b) {
      var lane = 0;
      while (lanes[lane] && lanes[lane] > ms(b.start)) lane++;
      lanes[lane] = ms(b.end);
      laneOf[b.id] = lane;
    });
    list.forEach(function (b) {
      var ext = M.isExternal(b);
      var overl = list.filter(function (x) { return x !== b && ms(x.start) < ms(b.end) && ms(x.end) > ms(b.start); });
      var n = Math.max(laneOf[b.id], overl.reduce(function (m, x) { return Math.max(m, laneOf[x.id]); }, 0)) + 1;
      var s = new Date(b.start), e = new Date(b.end);
      var top = minToPx(s.getHours() * 60 + s.getMinutes());
      var height = Math.max(minToPx(D.minutesBetween(s, e)), 22);
      var t = b.taskId ? M.byId(st.tasks, b.taskId) : null;
      var conflict = !ext && overl.some(function (x) { return !M.isExternal(x) || x.busy; });
      var label = ext ? b.title : t ? t.title : (b.title || '일정');
      var cls = 'div.cal-block' + (o.extra ? '.' + o.extra : '') + '.' + (ext ? 'ext' : b.kind === 'work' ? 'work' : 'event') +
        (ext && b.tentative ? '.is-tentative' : '') + (t && t.status === 'done' ? '.is-done' : '') +
        (conflict ? '.is-conflict' : '') + (!ext && isFlashed(b.id) ? '.is-new' : '');
      var aria = ext
        ? 'Google 일정: ' + label + ', ' + D.hm(s) + '부터 ' + D.hm(e) + '까지, 읽기 전용'
        : (b.kind === 'work' ? '작업: ' : '일정: ') + label + ', ' + D.hm(s) + '부터 ' + D.hm(e) + '까지' + (conflict ? ', 다른 일정과 겹침' : '');
      function act(el) {
        if (ext) extOpen(b, el);
        else if (o.onBlock) o.onBlock(b, el);
        else if (DN.views.schedule) DN.views.schedule.open({ blockId: b.id });
      }
      var el = h(cls, {
        role: 'button', tabindex: '0', draggable: 'false', 'aria-label': aria, 'data-block-id': ext ? null : b.id,
        style: { top: top + 'px', height: height + 'px', left: 'calc(' + (laneOf[b.id] / n * 100) + '% + 3px)', width: 'calc(' + (100 / n) + '% - 6px)', right: 'auto' },
        onclick: function (ev) { ev.stopPropagation(); act(ev.currentTarget); },
        onkeydown: function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); act(ev.currentTarget); } }
      },
        h('div.bt', label),
        height > 30 ? h('div.bm', D.hm(s) + '–' + D.hm(e) + (ext ? ' · Google' : b.kind === 'work' ? ' · 작업' : '')) : null,
        conflict ? h('div.conf', '겹침') : null);
      if (ext) setGc(el, b.color);
      else if (o.armBlock) o.armBlock(el, b);
      col.appendChild(el);
    });
    return list;
  }

  // 포인터 y → 15분 단위 시각
  function timeAt(col, ymd, clientY, offsetMin) {
    var r = col.getBoundingClientRect();
    var min = (clientY - r.top) / HOUR_PX * 60 - (offsetMin || 0);
    min = Math.round(min / SNAP) * SNAP;
    min = Math.max(0, Math.min(DAY_MIN - SNAP, min));
    var s = D.parseYmd(ymd);
    return D.addMinutes(s, min);
  }

  // 끌기 중 시간표 위 유령. o: { cls:'cal-ghost'|'cd-ghost', magnets:[{start:Date, rank}], allowed:[{start,end}]|null }
  // → { start, end, conflicts, magnet }
  function ghostAt(col, ymd, clientY, payload, o) {
    o = o || {};
    var cls = o.cls || 'cal-ghost';
    var unknown = payload.minutes == null;
    var minutes = unknown ? 30 : payload.minutes;
    var s = timeAt(col, ymd, clientY, payload.offsetMin || 0);
    var magnet = null;
    (o.magnets || []).some(function (m) {
      var px = Math.abs(minToPx(D.minutesBetween(m.start, s)));
      if (px <= 10) { magnet = m; s = new Date(m.start); return true; }
      return false;
    });
    var e = D.addMinutes(s, minutes);
    var c = busyConflicts(s, e, payload.kind === 'block' ? payload.id : null);
    var offband = !!(o.allowed && !o.allowed.some(function (w) { return s >= w.start && e <= w.end; }));
    var g = col.querySelector('.' + cls);
    if (!g) { g = h('div.' + cls, { 'aria-hidden': 'true' }); col.appendChild(g); }
    g.className = cls + (c.length ? ' is-conflict' : '') + (offband ? ' is-offband' : '');
    g.style.top = minToPx(s.getHours() * 60 + s.getMinutes()) + 'px';
    g.style.height = minToPx(minutes) + 'px';
    g.textContent = fmtRange(s, e) + (unknown ? ' · 소요 시간 미정' : '') + (c.length ? ' · 겹침 ' + c.length + '건' : '') +
      (offband ? ' · 추천 시간대 밖' : '') + (magnet ? ' · 추천 ' + magnet.rank : '');
    return { start: s, end: e, conflicts: c, magnet: magnet, el: g };
  }
  function clearGhosts(root) {
    Array.prototype.forEach.call((root || document).querySelectorAll('.cal-ghost, .cd-ghost'), function (g) { g.remove(); });
  }

  DN.views.calPlace = {
    dropOnDay: dropOnDay, dropAtTime: dropAtTime, askDuration: askDuration, alternativesPopover: alternativesPopover, arrange: arrange,
    _tl: { HOUR_PX: HOUR_PX, SNAP: SNAP, minToPx: minToPx, timedItems: timedItems, allDayItems: allDayItems, paintItems: paintItems,
      timeAt: timeAt, ghostAt: ghostAt, clearGhosts: clearGhosts, extOpen: extOpen, setGc: setGc, busyConflicts: busyConflicts },
    _fmt: { fmtDay: fmtDay, fmtRange: fmtRange, shortDay: shortDay, lengthFor: lengthFor, planOpts: planOpts, pop: pop }
  };
})();
