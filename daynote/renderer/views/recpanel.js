'use strict';

// "할 일 추천" — 홈 채팅 열 안, 도우미 버튼 줄 바로 위 (DAYNOTE_FEATURES_SPEC.md §5).
//   CTA 줄 .rec-cta : 지금 비어 있으면(진행 중·15분 안 일정·바쁜 상태가 없으면) 보인다.
//   패널 section.rec-panel#rec-panel : 쓸 수 있는 시간(칩·직접 입력)을 고르면 추천을 보여 준다.
// 패널 DOM 은 한 번만 만들고, 저장소가 바뀌면 칩·결과 칸만 다시 그린다 — 입력칸 포커스·한글 조합이 끊기지 않게.
// 결과는 저장하지 않는다(그릴 때마다 R.recommend 로 다시 계산). 상태 기능(DN.status)은 있으면 쓴다.

(function () {
  var DN = window.Daynote;
  var CHIPS = [15, 30, 60, 120];
  var HOUR = 60 * 60 * 1000;

  // 모듈 기억 — 다시 그려도(화면을 옮겨 다녀도) 유지한다
  var mem = { open: false, minutes: null, choice: null /* '15'|'30'|'60'|'120'|'cal'|'custom' */,
              customText: '', error: null, skip: [], dismissedUntil: null };

  function statusNow(now) {
    try { return DN.status && DN.status.current ? DN.status.current(now) : null; } catch (e) { return null; }
  }
  function statusView(now) {
    try { return DN.status && DN.status.view ? DN.status.view(now) : null; } catch (e) { return null; }
  }
  function workHours() { return (DN.store.state.prefs || {}).workHours; }

  function freeNow(now) {
    var SL = DN.slots;
    if (!SL || !SL.freeNow) return { free: false, reason: null, current: null, next: null, freeMinutes: null, workTime: false };
    return SL.freeNow(DN.store.state, now, { workHours: workHours(), status: statusNow(now) });
  }

  function mount(host, opts) {
    opts = opts || {};
    var ui = DN.ui, h = ui.h, D = DN.dates, S = DN.store, M = DN.model;
    var A = DN.app;
    var lastVisible = null;
    var destroyed = false;

    // ---------------------------------------------------------------- CTA
    var ctaText = h('span.rec-cta-text');
    var ctaBtn = h('button.btn.btn-primary.rec-cta-btn', {
      type: 'button', 'aria-expanded': 'false', 'aria-controls': 'rec-panel', onclick: function () { openPanel(); }
    }, ui.icon('spark'), '할 일 추천');
    var cta = h('div.rec-cta', { role: 'region', 'aria-label': '지금 할 일 추천' },
      ctaText, h('div.rec-cta-actions', ctaBtn,
        h('button.icon-btn.rec-cta-x', { type: 'button', 'aria-label': '지금은 괜찮아요', title: '지금은 괜찮아요', onclick: dismiss }, ui.icon('x'))));

    // ---------------------------------------------------------------- 패널 (한 번만 만든다)
    var chipsBox = h('div.rec-chips', { role: 'group', 'aria-label': '쓸 수 있는 시간' });
    var input = h('input.input#rec-custom-in', {
      type: 'text', autocomplete: 'off', placeholder: '직접 (예: 45, 1시간 30분, 1:30)', 'aria-describedby': 'rec-custom-msg'
    });
    input.addEventListener('input', function () { mem.customText = input.value; });
    var msg = h('div.help#rec-custom-msg');
    var form = h('form.rec-custom', { onsubmit: function (e) { e.preventDefault(); submitCustom(); } },
      input, h('button.btn.btn-sm', { type: 'submit' }, '추천 받기'));
    var results = h('div.rec-results', { 'aria-live': 'polite' });
    var panel = h('section.rec-panel#rec-panel', { 'aria-labelledby': 'rec-title', 'data-keep-scroll': 'rec' },
      h('div.rec-head', h('h3#rec-title', '얼마나 시간이 있어요?'),
        h('button.icon-btn', { type: 'button', 'aria-label': '추천 닫기', title: '추천 닫기', onclick: function () { closePanel(true); } }, ui.icon('x'))),
      chipsBox, form, msg, results);
    panel.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); closePanel(true); }
    });

    // ---------------------------------------------------------------- 동작
    function dismissUntil(fn, now) {
      mem.dismissedUntil = fn && fn.next ? fn.next.start : now.getTime() + HOUR;
    }
    function dismiss() {
      var now = A.now();
      dismissUntil(freeNow(now), now);
      paint();
      focusInput();
    }
    function focusInput() {
      setTimeout(function () { var x = document.querySelector('.chat-input textarea'); if (x) x.focus(); }, 0);
    }
    function openPanel() {
      mem.open = true;
      paint();
      setTimeout(function () { var b = chipsBox.querySelector('button'); if (b) b.focus(); }, 0);
    }
    function closePanel(restoreFocus) {
      mem.open = false;
      mem.minutes = null; mem.choice = null; mem.skip = []; mem.error = null;
      paint();
      if (!restoreFocus) return;
      setTimeout(function () {
        if (cta.parentNode && !cta.hidden) ctaBtn.focus();
        else { var x = document.querySelector('.chat-input textarea'); if (x) x.focus(); }
      }, 0);
    }
    function choose(minutes, choice) {
      mem.minutes = minutes; mem.choice = choice; mem.skip = []; mem.error = null;
      paintChips(A.now(), freeNow(A.now()));
      paintMsg();
      paintResults();
    }
    function submitCustom() {
      var r = D.parseDuration ? D.parseDuration(input.value) : { ok: false, message: '시간을 적어 주세요.' };
      mem.customText = input.value;
      if (!r.ok) {
        mem.error = r.message;
        paintMsg();
        return;
      }
      mem.error = null;
      var same = null;
      CHIPS.forEach(function (m) { if (m === r.minutes) same = String(m); });
      var fn = freeNow(A.now());
      if (!same && calChip(fn) === r.minutes) same = 'cal';
      choose(r.minutes, same || 'custom');
    }
    function startTask(id) {
      if (!A.startTask) return;
      var p = A.startTask(id);
      Promise.resolve(p).then(function (ok) {
        if (!ok || destroyed) return;
        var now = A.now();
        dismissUntil(freeNow(now), now);
        mem.open = false;
        mem.minutes = null; mem.choice = null; mem.skip = []; mem.error = null;
        paint();
      });
    }
    function breakdown(id) { if (DN.assistant && DN.assistant.breakdown) DN.assistant.breakdown(id); }

    // ---------------------------------------------------------------- 그리기
    function calChip(fn) {
      return fn && fn.freeMinutes != null && fn.freeMinutes >= 15 && fn.freeMinutes <= 720 ? fn.freeMinutes : null;
    }
    function ctaLine(fn, now) {
      if (!fn.workTime) return '근무 시간이 아니에요 · 할 일을 골라 볼까요?';
      if (fn.next) {
        var min = Math.max(0, Math.floor((fn.next.start - now.getTime()) / 60000));
        return '지금 비어 있어요 · ‘' + (fn.next.title || '일정') + '’까지 ' + D.duration(min);
      }
      return '지금 비어 있어요 · 오늘 남은 일정이 없어요';
    }
    function paintChips(now, fn) {
      var act = document.activeElement;
      var focusKey = act && chipsBox.contains(act) ? act.getAttribute('data-choice') : null;
      chipsBox.textContent = '';
      function pill(label, minutes, choice) {
        return h('button.pill', { type: 'button', 'data-choice': choice, 'aria-pressed': mem.choice === choice ? 'true' : 'false',
          onclick: function () { input.value = ''; mem.customText = ''; choose(minutes, choice); } }, label);
      }
      CHIPS.forEach(function (m) { chipsBox.appendChild(pill(D.duration(m), m, String(m))); });
      var cal = calChip(fn);
      if (cal != null) chipsBox.appendChild(pill('다음 일정까지 ' + D.duration(cal), cal, 'cal'));
      if (focusKey) { var b = chipsBox.querySelector('[data-choice="' + focusKey + '"]'); if (b) b.focus(); }
    }
    function paintMsg() {
      msg.textContent = mem.error || '';
      if (mem.error) { msg.setAttribute('role', 'alert'); msg.classList.add('is-error'); input.setAttribute('aria-invalid', 'true'); }
      else { msg.removeAttribute('role'); msg.classList.remove('is-error'); input.removeAttribute('aria-invalid'); }
    }

    function taskOf(id) { return M.byId(S.state.tasks, id); }
    function titleLink(t) {
      return h('button.link-btn.rec-title', { type: 'button', onclick: function () { A.openTask(t.id); } }, t.title || '(제목 없음)');
    }
    function label(st) { return st ? (st.overlay && st.overlay.label ? st.overlay.label : st.label) : ''; }

    function paintResults() {
      var act = document.activeElement;
      var focusAct = act && results.contains(act) ? act.getAttribute('data-act') : null;
      results.textContent = '';
      if (mem.minutes == null) return;
      var now = A.now();
      var R = DN.recommend;
      var r = R.recommend(S.state, {
        now: now, availableMinutes: mem.minutes, skipIds: mem.skip,
        workHours: workHours(), status: statusNow(now), statusView: statusView(now)
      });
      var dur = D.duration(mem.minutes);
      var st = r.context && r.context.status;
      var out = [];
      if (r.empty === 'quiet') {
        out.push(h('p.rec-empty', '‘' + label(st) + '’ 중이라 추천은 쉬어요. 끝나면 다시 골라 드릴게요.'));
      } else if (r.primary) {
        out = out.concat(primaryView(r, dur, now));
      } else if (r.empty === 'no_tasks') {
        out.push(h('p.rec-empty', '아직 할 일이 없어요. 생각나는 걸 적어 주세요.'),
          h('div.rec-actions', h('button.btn.btn-sm', { type: 'button', 'data-act': 'write', onclick: function () { closePanel(false); focusInput(); } }, '적으러 가기')));
      } else if (r.empty === 'time_short') {
        var bigger = null;
        CHIPS.forEach(function (m) { if (bigger == null && m > mem.minutes) bigger = m; });
        out.push(h('p.rec-empty', dur + ' 안에 끝낼 수 있는 할 일이 없어요.'),
          h('div.rec-actions',
            bigger != null ? h('button.btn.btn-sm', { type: 'button', 'data-act': 'bigger', onclick: function () { input.value = ''; mem.customText = ''; choose(bigger, String(bigger)); } }, D.duration(bigger) + '으로 보기') : null,
            r.tooLong && r.tooLong[0] ? h('button.btn.btn-sm', { type: 'button', 'data-act': 'split', onclick: function () { breakdown(r.tooLong[0].taskId); } }, '큰 일 나눠 보기') : null));
      } else if (r.empty === 'all_hidden') {
        out.push(h('p.rec-empty', '지금(‘' + label(st) + '’)은 할 만한 일이 없어요. 쉬어도 돼요.'),
          h('div.rec-actions', h('button.btn.btn-sm', { type: 'button', 'data-act': 'hidden', onclick: function () {
            var T = DN.views.today;
            if (T && T.showHidden) T.showHidden();
          } }, '접어 둔 일 보기')));
      } else if (r.empty === 'all_excluded') {
        var ex = r.excluded || {};
        var parts = [['waiting', '대기'], ['blocked', '선행 업무'], ['snoozed', '미룸']].filter(function (p) { return ex[p[0]] > 0; })
          .map(function (p) { return p[1] + ' ' + ex[p[0]]; });
        out.push(h('p.rec-empty', ['지금 바로 시작할 할 일이 없어요'].concat(parts).join(' · ')));
      } else if (r.empty === 'all_skipped') {
        out.push(h('p.rec-empty', '후보를 모두 봤어요.'),
          h('div.rec-actions', h('button.btn.btn-sm', { type: 'button', 'data-act': 'reset', onclick: function () { mem.skip = []; paintResults(); } }, '처음부터 다시')));
      }
      out.forEach(function (x) { if (x) results.appendChild(x); });
      if (focusAct) {
        var b = results.querySelector('[data-act="' + focusAct + '"]');
        if (b) b.focus();
      }
    }

    function primaryView(r, dur, now) {
      var p = r.primary, t = taskOf(p.taskId);
      if (!t) return [];
      var steps = t.steps || [];
      var draft = t.breakdown && (t.breakdown.status === 'pending' || t.breakdown.status === 'later') && t.breakdown.steps && t.breakdown.steps.length;
      var sum = h('div.rec-sum', dur + ' 안에 할 만한 일' + (r.tooLong && r.tooLong.length ? ' · 더 긴 일 ' + r.tooLong.length + '개는 뺐어요' : ''));
      var reasons = (p.reasons || []).slice(0, 2);
      var chips = h('div.rec-chips-row', ui.estimateChip(t), ui.dueChip(t, now));
      var item = h('div.rec-item.is-primary',
        h('div.rec-item-title', titleLink(t)),
        p.step ? h('div.rec-step', '먼저 이 단계부터: ‘' + p.step.title + '’') : null,
        reasons.length ? h('ul.rec-reasons', reasons.map(function (x) { return h('li', x); })) : null,
        chips.childNodes.length ? chips : null,
        h('div.rec-actions',
          h('button.btn.btn-primary.btn-sm', { type: 'button', 'data-act': 'start', onclick: function () { startTask(t.id); } },
            ui.icon('play'), t.status === 'in_progress' ? '이어하기' : '지금 시작'),
          h('button.btn.btn-sm', { type: 'button', 'data-act': 'other', onclick: function () { mem.skip.push(p.taskId); paintResults(); } }, '다른 후보'),
          !steps.length ? h('button.btn.btn-ghost.btn-sm', { type: 'button', 'data-act': 'split', onclick: function () { breakdown(t.id); } },
            draft ? '나눠 둔 단계 보기' : '작게 나누기') : null));
      var alts = (r.alternatives || []).map(function (a) {
        var at = taskOf(a.taskId);
        if (!at) return null;
        return h('li.rec-alt', titleLink(at),
          at.estimateMinutes != null ? h('span.meta', '약 ' + D.duration(at.estimateMinutes)) : null,
          h('button.btn.btn-xs', { type: 'button', 'aria-label': '‘' + at.title + '’ 시작', onclick: function () { startTask(at.id); } }, '시작'));
      }).filter(Boolean);
      return [sum, item, alts.length ? h('div.rec-alts', h('div.rec-alts-title', '다른 후보'), h('ul', alts)) : null];
    }

    function paint() {
      if (destroyed) return;
      var now = A.now();
      var fn = freeNow(now);
      if (mem.dismissedUntil != null && now.getTime() >= mem.dismissedUntil) mem.dismissedUntil = null;
      var showCta = !mem.open && fn.free && mem.dismissedUntil == null;
      if (showCta) {
        ctaText.textContent = ctaLine(fn, now);
        if (cta.parentNode !== host) host.insertBefore(cta, host.firstChild);
        cta.hidden = false;
      } else if (cta.parentNode === host) {
        var hadFocus = cta.contains(document.activeElement);
        host.removeChild(cta);
        if (hadFocus && !mem.open) focusInput();
      }
      ctaBtn.setAttribute('aria-expanded', mem.open ? 'true' : 'false');
      if (mem.open) {
        if (panel.parentNode !== host) {
          host.appendChild(panel);
          input.value = mem.customText || '';
        }
        paintChips(now, fn);
        paintMsg();
        paintResults();
      } else if (panel.parentNode === host) {
        host.removeChild(panel);
      }
      host.classList.toggle('is-empty', !showCta && !mem.open);
      var visible = showCta || mem.open;
      if (visible !== lastVisible) {
        lastVisible = visible;
        if (opts.onCtaVisible) opts.onCtaVisible(visible);
      }
    }

    paint();
    return {
      paint: paint,
      destroy: function () { destroyed = true; host.textContent = ''; },
      ctaVisible: function () { return cta.parentNode === host; },
      isOpen: function () { return !!mem.open; }
    };
  }

  DN.views = DN.views || {};
  DN.views.recPanel = { mount: mount, _mem: mem };
})();
