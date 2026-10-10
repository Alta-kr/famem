'use strict';

// 현재 상태 — 화면 쪽 (DN.status). 계산은 코어(DN.statusCore, 줄여 ST)가 하고, 여기서는 저장·카드·칩·메뉴·알림을 맡는다.
//
//  - 상태(presence) 바꾸기는 모두 라벨 없는 S.mutate(null, fn, { source:'status' }) 다 — Ctrl+Z 대상이 아니다(STATUS 결정 10).
//    잘못 바꾼 상태는 카드·메뉴·알림의 [이전 상태로](기록 기반, ST.revert)로 되돌린다.
//  - 할 일 데이터를 바꾸는 것은 맥락 바꾸기('맥락 바꾸기')·언제 할까요('언제 할지 바꾸기')·[멈춰 두기]('상태 변경')뿐이다 — 이것들은 되돌릴 수 있다.
//  - 조용히(silent) 쓰는 것: 펼쳐 본 할 일(markShown), 깨우기(touch), 60초 정리(tick/settle), 잔소리 예산.
//  - 기능을 켜기 전(activatedAt 없음)에는 view 가 null 이고 맥락 칩도 그리지 않는다(P-1). 흐린 [상태 정하기] 칩만 있다.
//  - 다른 화면 모듈(assistant·app·views)은 함수 안에서만, 있을 때만 부른다(부분 병합에서도 던지지 않게).

(function () {
  var DN = window.Daynote;
  var MIN = 60000;
  var MERGE_MS = 2 * MIN;              // 2분 안에 연달아 바꾸면 마지막 카드를 고친다 (STATUS §4.6)

  function ST() { return DN.statusCore; }
  function SW() { return DN.statusWords; }
  function S() { return DN.store; }
  function M() { return DN.model; }
  function D() { return DN.dates; }
  function ui() { return DN.ui; }
  function h() { return DN.ui.h.apply(null, arguments); }
  function now() { return DN.app && DN.app.now ? DN.app.now() : new Date(); }
  function toDate(v) { return v instanceof Date ? v : new Date(v); }
  function ready() { return !!(ST() && S() && S().state); }

  // 받침에 맞춘 조사만 (josa 는 낱말까지 붙여 돌려준다)
  function jo(word, pair) { var w = String(word == null ? '' : word); return ui().josa(w, pair).slice(w.length); }
  function q(word) { return '‘' + word + '’'; }

  // ------------------------------------------------------------------ 읽기 (캐시)
  var rev = 0;                          // 저장소 변경 횟수 (subscribe) + 내 조용한 쓰기
  var viewCache = { key: null, v: null };

  function profile() {
    var st = S() && S().state;
    return ST().profile(st ? st.prefs : {});
  }
  function isActive() {
    if (!ready()) return false;
    return ST().isActive(S().state, profile());
  }
  function presenceKey(st) {
    var p = st.presence;
    if (!p) return '-';
    return [p.activatedAt, JSON.stringify(p.current), (p.shown || []).length, (p.parked || []).length, (p.log || []).length].join('|');
  }
  function view(n) {
    if (!ready()) return null;
    n = n ? toDate(n) : now();
    var st = S().state, pf = profile();
    var key = Math.floor(n.getTime() / MIN) + '|' + rev + '|' + pf.hash + '|' + presenceKey(st);
    if (viewCache.key === key) return viewCache.v;
    var v = ST().view(st, pf, n);
    viewCache = { key: key, v: v };
    return v;
  }
  function effective(n) { return ready() ? ST().effective(S().state, profile(), n || now()) : null; }
  function current(n) {
    if (!ready()) return null;
    return ST().current(S().state, profile(), n ? toDate(n) : now());
  }
  // 지금 '명시한' 상태 id (덧씌움이면 덧씌움, 짐작이면 null)
  function explicitId(eff) { return !eff ? null : eff.overlay ? eff.overlay.id : eff.guessed ? null : eff.id; }
  function presence() { return (S().state && S().state.presence) || null; }

  // ------------------------------------------------------------------ 쓰기 도우미
  function write(fn, silent) {
    var r = S().mutate(null, fn, { source: 'status', silent: !!silent });
    rev++;
    viewCache.key = null;
    return r;
  }
  function changeStatus(target, opts) {
    var pf = profile(), n = now();
    return write(function (s) { return ST().setStatus(s, target, opts, pf, n); });
  }
  function homeVisible() {
    var A = DN.app;
    return !!(A && A.current && A.current() && A.current().view === 'today');
  }
  function typing() {
    var x = document.querySelector('.chat-input textarea');
    return !!(x && x.value && x.value.trim());
  }

  // 숨긴 수 한 줄 ('업무 할 일 5개 숨김')
  function hiddenText(n) {
    var v = view(n);
    return v && v.summary && v.summary.hidden ? ST().hiddenSummaryText(v.summary, profile()) : '';
  }

  // ------------------------------------------------------------------ 카드 올리기 (흐름)
  function AS() { return DN.assistant; }
  function lastStatusMsg() {
    var chat = (S().state && S().state.chat) || [];
    var m = chat[chat.length - 1];
    return m && m.kind === 'status' ? m : null;
  }
  function postCard(tr, extra) {
    var as = AS();
    if (!as || !as.post) return null;
    extra = extra || {};
    var msg = { kind: 'status', to: tr.to, from: tr.from || null, source: extra.source || 'menu', at: tr.at,
      pure: !!extra.pure, parked: tr.parked || [], resume: tr.resume || [] };
    if (extra.pure && extra.text) msg.text = String(extra.text);
    var last = lastStatusMsg();
    if (last && Math.abs(toDate(tr.at).getTime() - toDate(last.at).getTime()) < MERGE_MS && !last.noteId && as.update) {
      // 연달아 바꾸면 마지막 카드를 새 상태로 고친다 (이어하기·멈춰 두기 후보는 합친다)
      var union = function (a, b) { var out = (a || []).slice(); (b || []).forEach(function (x) { if (out.indexOf(x) === -1) out.push(x); }); return out; };
      as.update(last.id, { to: msg.to, source: msg.source, at: msg.at, pure: msg.pure, text: msg.text,
        parked: union(last.parked, msg.parked), resume: union(last.resume, msg.resume) });
      return last;
    }
    return as.post(msg);
  }

  // ------------------------------------------------------------------ 알림 문구 (STATUS §10.4)
  function toastWithRevert(msg) {
    ui().toast(msg, { actions: [{ label: '이전 상태로', fn: function () { revert(); } }] });
  }
  function changedToast(tr, source) {
    var label = tr.to && tr.to.label ? tr.to.label : '';
    var hid = hiddenText();
    toastWithRevert(q(label) + jo(label, '로/으로') + ' 바꿨어요' + (hid ? ' · ' + hid : ''));
  }

  // ------------------------------------------------------------------ 말 (감지 · 적용)
  function detect(text) {
    if (!ready()) return null;
    var pf = profile(), n = now(), st = S().state;
    var eff = ST().effective(st, pf, n);
    var d = ST().detect(text, { profile: pf, eff: eff, current: (st.presence && st.presence.current) || null, now: n });
    // 다른 프리셋 전용 말은 세어 둔다 (프리셋 제안 §12.4) — 켠 뒤에만
    if (eff && !d && typeof ST().presetSignal === 'function') {
      var sig = ST().presetSignal(text, pf);
      if (sig) write(function (s) { ST().notePresetSignal(s, sig, n); }, true);
    }
    return d;
  }

  // d: Detection. opts { source, surface:'chat'|'toast', text, quiet }
  function apply(d, opts) {
    if (!d || !ready()) return null;
    opts = opts || {};
    var surface = opts.surface === 'toast' ? 'toast' : 'chat';
    if (d.role === 'idle') {
      // 상태는 그대로, 바로 '다음 할 일'
      if (surface === 'chat' && AS() && AS().next) AS().next();
      else if (surface === 'toast' && !opts.quiet) ui().toast('메모는 만들지 않았어요. 오늘 화면에서 ‘다음 할 일’을 골라 드릴게요.');
      return { noop: true, idle: true };
    }
    var cur = presence() && presence().current;
    if (d.same && !(cur && cur.id === 'sleep')) {
      var e0 = effective();
      var lab = (e0 && (e0.overlay ? e0.overlay.label : e0.label)) || d.label;
      if (!opts.quiet) ui().toast('이미 ' + q(lab) + jo(lab, '예요/이에요'));
      return { noop: true, same: true };
    }
    var target = { id: d.id, label: d.label, role: d.role || null };
    if (d.until) target.until = d.until;
    if (d.minutes) target.minutes = d.minutes;
    var tr = changeStatus(target, { source: opts.source || 'text', text: opts.text || null });
    if (!tr) return null;
    if (tr.noop) {
      if (!opts.quiet) ui().toast('이미 ' + q(tr.to.label) + jo(tr.to.label, '예요/이에요'));
      return tr;
    }
    if (surface === 'chat') {
      postCard(tr, { source: opts.source || 'text', pure: !!d.pure, text: d.pure ? opts.text : null });
    } else if (!opts.quiet) {
      var label = d.label || tr.to.label;
      if (d.pure) toastWithRevert(q(label) + jo(label, '로/으로') + ' 바꿨어요 · 메모는 만들지 않았어요');
      else changedToast(tr);
    }
    return tr;
  }

  // 애매한 말 → 결과 카드 제안 (예산을 쓴다)
  function hintFor(d) {
    if (!d || !ready() || !isActive() || d.id == null) return null;
    var pf = profile(), n = now();
    if (!ST().budgetOk(S().state, pf, n)) return null;
    write(function (s) { ST().useBudget(s, pf, n); }, true);
    return { from: 'rule', role: d.role || null, id: d.id, label: d.label, quote: d.statusLine || d.matched || null, at: n.toISOString() };
  }

  // 잘 시간에 글을 적으면 깨어 있는 것으로 본다
  function touch() {
    if (!ready()) return;
    var p = presence();
    if (!p || !p.current || p.current.id !== 'sleep') return;
    var n = now();
    write(function (s) { ST().wake(s, n); }, true);
  }

  // ------------------------------------------------------------------ 바꾸기
  // target { id, label?, until?, minutes? }, opts { source:'menu'|'chip'|'palette'|'hint'|'rest'|'confirm', quiet }
  function set(target, opts) {
    if (!ready()) return null;
    opts = opts || {};
    var tr = changeStatus(target, { source: opts.source || 'menu' });
    if (!tr) return null;
    if (opts.quiet) return tr;
    if (tr.noop) {
      var l = tr.to && tr.to.label ? tr.to.label : '';
      var since = tr.since ? ' (' + D().hm(tr.since) + '부터)' : '';
      ui().toast('이미 ' + q(l) + jo(l, '예요/이에요') + since);
      return tr;
    }
    changedToast(tr, opts.source);
    if (homeVisible()) postCard(tr, { source: opts.source || 'menu' });   // C28 — 홈이 보일 때만 카드
    return tr;
  }

  function revert() {
    if (!ready()) return null;
    var pf = profile(), n = now();
    var tr = write(function (s) { return ST().revert(s, pf, n); });
    if (!tr) { ui().toast('되돌릴 상태가 없어요.'); return null; }
    var l = tr.to && tr.to.label ? tr.to.label : '시간표';
    ui().toast(tr.to && tr.to.guessed ? '시간표대로 돌아갔어요 · 지금은 ' + q(l) + jo(l, '예요/이에요') : q(l) + jo(l, '로/으로') + ' 되돌렸어요');
    return tr;
  }

  function guessMessage() {
    var e = effective();
    var l = e ? e.label : '';
    return '시간표대로 둘게요. 지금은 ' + q(l) + '(시간표 기준)' + '이에요.';
  }
  function toGuess(opts) {
    if (!ready()) return null;
    var pf = profile(), n = now();
    var tr = write(function (s) { return ST().toGuess(s, n, pf); });
    if (!(opts && opts.quiet)) ui().toast(guessMessage());
    return tr;
  }

  // 덧씌움 늘리기 ([5분 더])
  function extend(minutes) {
    if (!ready()) return null;
    var p = presence(), cur = p && p.current, n = now();
    var eff = effective(n);
    if (!cur || !eff || !eff.overlay || cur.id !== eff.overlay.id) return null;
    var base = cur.until && toDate(cur.until).getTime() > n.getTime() ? toDate(cur.until) : n;
    var until = D().addMinutes(base, minutes);
    var tr = changeStatus({ id: cur.id, label: cur.label, until: until.toISOString() }, { source: 'menu' });
    ui().toast(q(cur.label) + jo(cur.label, '를/을') + ' ' + minutes + '분 늘렸어요 · ' + D().hm(until) + '까지');
    return tr;
  }

  // 덧씌움에서 돌아오기 ([지금 복귀]) — 아래 상태가 명시면 그 상태로, 짐작이면 시간표대로
  function back() {
    if (!ready()) return null;
    var eff = effective();
    if (!eff || !eff.overlay) return null;
    var tr = eff.guessed ? changeStatus({ id: null }, { source: 'menu' }) : changeStatus({ id: eff.id, label: eff.label }, { source: 'menu' });
    var e1 = effective();
    if (e1) ui().toast(q(e1.label) + jo(e1.label, '로/으로') + ' 돌아왔어요' + (e1.guessed ? ' (시간표 기준)' : ''));
    return tr;
  }

  // 짐작 상태를 명시로 ('뒤로 미룬 일' 머리의 [퇴근으로 정하기])
  function confirmGuess() {
    if (!ready()) return null;
    var pf = profile(), n = now();
    var tr = write(function (s) { return ST().confirmGuess(s, pf, n); });
    if (tr && !tr.noop) changedToast(tr, 'confirm');
    return tr;
  }

  // ------------------------------------------------------------------ /상태 (STATUS §5.10, PLAN C6)
  function overlayMessage(tr) {
    var cur = presence() && presence().current, n = now();
    if (!cur || !cur.until) return null;
    var mins = Math.max(1, Math.round((toDate(cur.until).getTime() - n.getTime()) / MIN));
    var backTo = cur.returnTo ? cur.returnTo.label : null;
    var e = effective(n);
    if (!backTo && e && !e.overlay) backTo = e.label;
    var pf = profile(), d = pf.statuses[cur.id];
    var verb = cur.id === 'break' ? mins + '분 쉬어요' : (d && d.overlay ? mins + '분 동안 ' + q(cur.label) : q(cur.label) + ' · ' + mins + '분');
    return verb + ' · ' + D().hm(cur.until) + '에 ' + (backTo ? q(backTo) + jo(backTo, '로/으로') : '시간표대로') + ' 돌아갈게요.';
  }
  function setFromCommand(args, opts) {
    opts = opts || {};
    if (!ready()) return { ok: false, message: '상태 기능을 불러오지 못했어요.' };
    var pf = profile(), n = opts.now ? toDate(opts.now) : now();
    var surface = opts.surface === 'toast' ? 'toast' : 'chat';
    var eff = ST().effective(S().state, pf, n);
    var a = ST().parseStatusArgs(args, pf, eff, n);
    if (a.cmd === 'picker') {
      if (surface === 'chat') { postPicker(); return { ok: true, posted: true }; }
      var c = current(n);
      return { ok: true, noop: true, message: c ? '지금 상태는 ' + q(c.label) + jo(c.label, '예요/이에요') + '.' : '‘/상태 회의 중’처럼 적으면 지금 상태를 바꿔요.' };
    }
    if (a.cmd === 'guess') {
      write(function (s) { return ST().toGuess(s, n, pf); });
      return { ok: true, label: '시간표대로', message: guessMessage() };
    }
    if (a.cmd === 'revert') {
      var rt = write(function (s) { return ST().revert(s, pf, n); });
      if (!rt) return { ok: false, message: '되돌릴 상태가 없어요.' };
      var rl = rt.to && rt.to.label ? rt.to.label : '시간표';
      return { ok: true, label: rl, message: q(rl) + jo(rl, '로/으로') + ' 되돌렸어요.' };
    }
    if (a.cmd !== 'set') {
      var u = a.label || String(args || '').trim();
      return { ok: false, message: q(u) + '라는 상태가 없어요. 설정 › 현재 상태에서 만들 수 있어요.' };
    }
    var target = { id: a.id, label: a.label };
    if (a.until) target.until = a.until;
    if (a.minutes) target.minutes = a.minutes;
    var tr = write(function (s) { return ST().setStatus(s, target, { source: opts.source || 'command' }, pf, n); });
    if (!tr) return { ok: false, message: q(a.label || args) + '라는 상태가 없어요. 설정 › 현재 상태에서 만들 수 있어요.' };
    var label = tr.to && tr.to.label ? tr.to.label : a.label;
    if (tr.noop) {
      return { ok: true, noop: true, label: label, message: '이미 ' + q(label) + jo(label, '예요/이에요') + (tr.since ? ' (' + D().hm(tr.since) + '부터).' : '.') };
    }
    if (surface === 'chat') {
      postCard(tr, { source: 'command' });
      return { ok: true, label: label, posted: true };
    }
    var om = overlayMessage(tr);
    var hid = hiddenText(n).replace(/ 숨김.*$/, '');
    return { ok: true, label: label,
      message: om || ('상태를 ' + q(label) + jo(label, '로/으로') + ' 바꿨어요.' + (hid ? ' ' + hid + jo(hid, '는/은') + ' 접어 뒀어요.' : '')) };
  }
  function postPicker() { if (AS() && AS().post) return AS().post({ kind: 'status-pick' }); return null; }

  // ------------------------------------------------------------------ 60초 tick · 근무 끝 줄 · 프리셋 제안
  var mem = { otDay: null, offered: {} };
  function logicalDayKey(n, pf) {
    var d = new Date(n.getTime());
    var ds = pf.schedule.dayStartMin || 0;
    if (d.getHours() * 60 + d.getMinutes() < ds) d = D().addDays(d, -1);
    return D().ymd(d);
  }
  function tick(n) {
    if (!ready()) return false;
    n = n ? toDate(n) : now();
    var pf = profile(), st = S().state;
    if (!st.presence || !st.presence.activatedAt) return false;
    var changed = !!write(function (s) { return ST().settle(s, pf, n); }, true);
    if (changed) viewCache.key = null;
    // 프리셋 맞추기 제안 — 홈이 보이고 타이핑 중이 아닐 때, 예산 안에서
    try {
      if (isActive() && homeVisible() && !typing() && typeof ST().presetOfferDue === 'function') {
        var pid = ST().presetOfferDue(st, pf, n);
        if (pid && !mem.offered[pid] && AS() && AS().post) {
          mem.offered[pid] = true;
          write(function (s) { ST().markPresetOffered(s, pid, n); }, true);
          AS().post({ kind: 'status-offer', preset: pid });
        }
      }
    } catch (e) { console.error(e); }
    return changed;
  }

  // 오늘 머리줄 아래 한 줄: 근무 시간이 지났어요 · [퇴근으로 바꾸기] · [닫기] (하루 1번, 두 번 닫으면 그만)
  function nudgeLine(n) {
    if (!ready() || !isActive()) return null;
    n = n ? toDate(n) : now();
    var pf = profile(), st = S().state;
    if (!pf.schedule.overtimeLine) return null;
    var key = logicalDayKey(n, pf);
    var eff = ST().effective(st, pf, n);
    var stillWork = !!(eff && !eff.guessed && !eff.overlay && eff.category === 'work');
    if (mem.otDay !== key) {
      if (typing() || !ST().overtimeDue(st, pf, n)) return null;
      mem.otDay = key;
      write(function (s) { ST().useBudget(s, pf, n); }, true);   // 하루 1번 — 보인 순간 예산을 쓴다
    }
    if (!stillWork || mem.otClosed === key) return null;
    var offId = pf.statuses.off ? 'off' : null;
    var line = h('div.status-nudge', { role: 'status' },
      h('span', '근무 시간이 지났어요'), h('span', { 'aria-hidden': 'true' }, '·'),
      offId ? h('button.link-btn', { type: 'button', onclick: function () { mem.otClosed = key; set({ id: offId }, { source: 'menu' }); } },
        q(pf.statuses.off.label) + jo(pf.statuses.off.label, '로/으로') + ' 바꾸기') : null,
      h('span', { 'aria-hidden': 'true' }, '·'),
      h('button.link-btn', { type: 'button', onclick: function () {
        mem.otClosed = key;
        write(function (s) { ST().dismissOvertime(s, pf, n); }, true);
        line.remove();
      } }, '닫기'));
    return line;
  }

  // ------------------------------------------------------------------ 상태 칩 (STATUS §10.1) · 빠르게 바꾸기 메뉴 (§10.2)
  function chipParts(n) {
    var pf = profile(), eff = effective(n);
    if (!eff) return { cls: 'is-unset', cat: 'none', label: '상태 정하기', title: null, aria: '지금 상태: 정하지 않음 — 상태 정하기' };
    if (eff.overlay) {
      var u = eff.overlay.until;
      return { cls: '', cat: 'overlay', label: eff.overlay.label + (u ? ' · ' + D().hm(u) + '까지' : ''),
        title: '끝나면 ' + q(eff.label) + jo(eff.label, '로/으로') + ' 돌아가요' + (eff.guessed ? ' (시간표 기준)' : ''),
        aria: '지금 상태: ' + eff.overlay.label + (u ? ', ' + D().hm(u) + '까지' : '') + ' — 바꾸기', icon: (pf.statuses[eff.overlay.id] || {}).icon };
    }
    var label = eff.label + (eff.guessed ? ' · 시간표 기준' : '');
    return { cls: eff.guessed ? 'is-guess' : '', cat: eff.category || 'none', label: label,
      title: eff.guessed ? '근무 시간으로 짐작한 상태예요. 눌러서 정할 수 있어요.' : null,
      aria: '지금 상태: ' + label + ' — 바꾸기', icon: (pf.statuses[eff.id] || {}).icon };
  }
  function chip(where) {
    if (!ready()) return null;
    var pf = profile();
    if (!pf.enabled) return null;
    var c = chipParts();
    var btn = h('button.status-chip.st-' + c.cat + (c.cls ? '.' + c.cls : ''), {
      type: 'button', 'aria-haspopup': 'menu', 'aria-label': c.aria, title: c.title,
      'data-focus-key': where === 'bar' ? 'presence-chip-bar' : 'presence-chip',
      onclick: function (e) { e.stopPropagation(); openMenu(e.currentTarget); }
    }, h('span.st-dot', { 'aria-hidden': 'true' }), h('span.st-label', c.label), ui().icon('chevronDown', 'st-caret'));
    return btn;
  }

  function lastUserLog() {
    var p = presence();
    var log = (p && p.log) || [];
    for (var i = log.length - 1; i >= 0; i--) {
      var s = log[i] && log[i].source;
      if (s && s !== 'until' && s !== 'expire' && s !== 'wake') return log[i];
    }
    return null;
  }

  function openMenu(anchor) {
    if (!ready()) return null;
    var pf = profile(), n = now(), eff = effective(n), xid = explicitId(eff);
    var A = DN.app;
    var items = [{ label: '지금 어떤 시간인가요?' }];
    if (eff && eff.overlay) {
      items.push({ label: '5분 더', icon: 'plus', onClick: function () { extend(5); } });
      items.push({ label: '15분 더', icon: 'plus', onClick: function () { extend(15); } });
      items.push({ label: '지금 복귀', icon: 'undo', onClick: function () { back(); } });
      items.push({ sep: true });
    }
    pf.menu.forEach(function (id) {
      var d = pf.statuses[id];
      if (!d) return;
      items.push({ label: d.label, icon: d.icon || 'clock', checked: xid === id, sub: d.overlay && d.minutes ? d.minutes + '분' : null,
        onClick: function () { set({ id: id }, { source: 'menu' }); } });
    });
    items.push({ sep: true });
    var g = ST().guess(pf, n);
    items.push({ label: '시간표대로 (자동)', icon: 'clock', checked: !!(eff && eff.guessed && !eff.overlay), sub: pf.schedule.mode === 'guess' ? '지금은 ' + q(g.label) : null,
      onClick: function () { toGuess(); } });
    items.push({ label: '모두 보기 (상태 없이)', icon: 'task', checked: xid === 'none', onClick: function () { set({ id: 'none' }, { source: 'menu' }); } });
    var last = lastUserLog();
    if (last && eff) {
      var fl = last.from ? (last.fromLabel || (pf.statuses[last.from] || {}).label || '') : '시간표대로';
      items.push({ label: '이전 상태로 (' + (last.from ? q(fl) : fl) + ')', icon: 'undo', onClick: function () { revert(); } });
    }
    items.push({ sep: true });
    items.push({ label: '현재 상태 설정…', icon: 'settings', onClick: function () { if (A && A.go) A.go('settings', { section: 'status' }); } });
    return ui().menu(anchor, items, { label: '지금 어떤 시간인가요?', className: 'cap-menu.status-menu' });
  }

  // ------------------------------------------------------------------ 상태 카드 (STATUS §10.3)
  function liveTask(id) {
    var t = M().byId(S().state.tasks || [], id);
    return t && !t.deletedAt && !t.archivedAt && t.status !== 'done' ? t : null;
  }
  function titles(list, max) {
    var out = list.slice(0, max || 3).map(function (t) { return t.title || '(제목 없음)'; });
    return out.join(' · ') + (list.length > (max || 3) ? ' 외 ' + (list.length - (max || 3)) + '개' : '');
  }
  function anchoredTasks(v, mode) {
    return (v && v.anchored || []).map(liveTask).filter(function (t) { return t && (!mode || t.atMode === mode); });
  }
  function levelTasks(v, pred) {
    if (!v) return [];
    return Object.keys(v.levels).filter(function (id) { return pred(v.levels[id], id); }).map(liveTask).filter(Boolean);
  }
  function recommendOne(v, n) {
    var R = DN.recommend;
    if (!R || !R.recommend || !v) return null;
    try {
      var st = S().state;
      var r = R.recommend(st, { now: n, workHours: st.prefs && st.prefs.workHours, statusView: v, status: current(n) });
      if (!r || !r.primary) return null;
      var t = liveTask(r.primary.taskId);
      return t ? { task: t, minutes: t.estimateMinutes } : null;
    } catch (e) { console.error(e); return null; }
  }
  function btn(label, fn, primary) {
    return h('button.btn.btn-xs' + (primary ? '.btn-primary' : ''), { type: 'button', onclick: fn }, label);
  }
  function startTask(id) { if (DN.app && DN.app.startTask) DN.app.startTask(id); }
  function firstEventTomorrow(n) {
    var M_ = M(), D_ = D(), st = S().state;
    var t0 = D_.startOfDay(D_.addDays(n, 1)), t1 = D_.addDays(t0, 1);
    var items = typeof M_.calendarItems === 'function'
      ? M_.calendarItems(st, t0.toISOString(), t1.toISOString(), { includeAllDay: false })
      : (st.blocks || []).filter(function (b) { return new Date(b.start) >= t0 && new Date(b.start) < t1; });
    items = items.filter(function (b) { return b.kind === 'event' || b.external; });
    items.sort(function (a, b) { return new Date(a.start) - new Date(b.start); });
    return items[0] || null;
  }

  // 카드가 지금 상태가 아니면 한 줄 기록으로 접는다 ('18:42–21:10 · 퇴근 · 내 시간')
  function cardEnd(m, eff) {
    var log = (presence() && presence().log) || [];
    var at = toDate(m.at).getTime();
    for (var i = 0; i < log.length; i++) {
      var t = toDate(log[i].at).getTime();
      if (t > at) return { ended: true, at: log[i].at };
    }
    var to = m.to || {};
    var live = to.guessed ? !!(eff && eff.guessed && !eff.overlay) : explicitId(eff) === to.id;
    return live ? { ended: false } : { ended: true, at: null };
  }

  function statusCard(m, st, n) {
    var pf = profile(), eff = effective(n), v = view(n);
    var to = m.to || {}, def = to.id ? pf.statuses[to.id] : null, label = to.label || (def && def.label) || '';
    var end = cardEnd(m, eff);
    var cls = 'msg-status';
    if (end.ended) {
      return h('div.msg.msg-assistant.' + cls + '.is-past', h('div.msg-body', h('div.st-card-past.meta',
        h('span.st-dot-sm.st-' + (def ? def.category : 'none'), { 'aria-hidden': 'true' }),
        D().hm(m.at) + (end.at ? '–' + D().hm(end.at) : '') + ' · ' + label,
        m.noteId ? h('span', ' · ', h('button.link-btn', { type: 'button', onclick: function () { if (DN.app) DN.app.go('notes', { noteId: m.noteId }); } }, '메모')) : null)));
    }
    var lines = [], actions = [];
    var cat = to.guessed ? 'guess' : def ? def.category : 'none';
    var head = q(label) + jo(label, '로/으로') + ' 바꿨어요 · ' + D().hm(m.at);
    function line(text, extraCls) { if (text) lines.push(h('div.st-line' + (extraCls ? '.' + extraCls : ''), text)); }
    var rec = null;
    var hid = v && v.summary && v.summary.hidden ? ST().hiddenSummaryText(v.summary, pf).replace(/ 숨김.*$/, '') : '';
    var revertBtn = btn('이전 상태로', function () { revert(); });

    if (to.guessed) {
      head = '시간표대로 둘게요 · ' + D().hm(m.at);
      line('지금은 ' + q(label) + '(시간표 기준)이에요. 할 일을 숨기지 않고 내리기만 해요.');
      actions.push(revertBtn);
    } else if (cat === 'work') {
      var resume = (m.resume || []).map(liveTask).filter(Boolean);
      if (resume.length) line('하던 ' + q(resume[0].title) + '부터 이어서 할까요?');
      var wn = anchoredTasks(v, 'work');
      if (wn.length) line(SW().ATMODE_HEAD.work + ': ' + titles(wn));
      rec = recommendOne(v, n);
      if (rec) line('지금 하기 좋은 일: ' + q(rec.task.title) + (rec.minutes ? ' · 약 ' + D().duration(rec.minutes) : ''));
      if (resume.length) actions.push(btn('이어하기', function () { startTask(resume[0].id); }, true));
      if (rec) actions.push(btn('지금 시작', function () { startTask(rec.task.id); }, !resume.length));
      actions.push(revertBtn);
    } else if (cat === 'life' || cat === 'rest') {
      var outPlace = def && def.place === 'out';
      var thanks = to.id === 'off' ? '수고했어요. ' : '';
      if (cat === 'rest') line('오늘은 쉬는 날로 둘게요.' + (hid ? ' ' + hid + jo(hid, '는/은') + ' 접어 뒀어요.' : ''));
      else if (hid) line(thanks + hid + jo(hid, '는/은') + ' 출근하면 다시 보여 드릴게요.');
      else if (thanks) line(thanks.trim());
      if (outPlace) {
        var outs = anchoredTasks(v).concat(levelTasks(v, function (l) { return l.level === 'up' && l.ctx === 'errand'; }));
        var seen = {};
        outs = outs.filter(function (t) { if (seen[t.id]) return false; seen[t.id] = true; return true; });
        if (outs.length) line('밖에 있는 김에: ' + titles(outs));
      }
      var bt = levelTasks(v, function (l) { return l.breakthrough && !l.breakthrough.soon && l.level === 'down'; })[0];
      if (bt && v.levels[bt.id].breakthrough) {
        var due = toDate(v.levels[bt.id].breakthrough.dueAt);
        line(q(bt.title) + jo(bt.title, '는/은') + ' ' + D().relDay(bt.dueDate, n) + (bt.dueTime ? ' ' + D().hm(due) : '') + ' 마감이라 남겨 뒀어요.');
      }
      var parked = (m.parked || []).map(liveTask).filter(function (t) { return t && t.status === 'in_progress'; });
      if (parked.length) line('하던 ' + q(parked[0].title) + jo(parked[0].title, '는/은') + ' 출근하면 맨 위에 둘게요.');
      if (!outPlace) {
        var anc = anchoredTasks(v);
        if (anc.length) line(SW().ATMODE_HEAD[anc[0].atMode] + ': ' + titles(anc.filter(function (t) { return t.atMode === anc[0].atMode; })));
      }
      rec = recommendOne(v, n);
      if (rec) line('지금 하기 좋은 일: ' + q(rec.task.title) + (rec.minutes ? ' · ' + D().duration(rec.minutes) : ''));
      if (rec) actions.push(btn('지금 시작', function () { startTask(rec.task.id); }, true));
      if (parked.length) {
        actions.push(btn('멈춰 두기', function () {
          var ids = parked.map(function (t) { return t.id; }), at = now();
          S().mutate('상태 변경', function (s) { ids.forEach(function (id) { M().updateTask(s, id, { status: 'todo' }, at); }); }, { source: 'status' });
          ui().undoToast('하던 일 ' + ids.length + '개를 멈춰 뒀어요.');
        }));
      }
      actions.push(revertBtn);
    } else if (cat === 'moving') {
      var phone = levelTasks(v, function (l) { return l.reason === 'phone'; });
      line(q(label) + jo(label, '예요/이에요') + '.' + (phone.length ? ' 전화·이체처럼 폰으로 할 수 있는 일을 위로 올렸어요.' : ''));
      if (phone.length) line(titles(phone));
      var outA = anchoredTasks(v, 'out');
      if (outA.length) line(SW().ATMODE_HEAD.out + ': ' + titles(outA));
      head = q(label) + jo(label, '로/으로') + ' 바꿨어요 · ' + D().hm(m.at);
      actions.push(revertBtn);
    } else if (cat === 'overlay') {
      var cur = presence() && presence().current;
      var until = cur && cur.id === to.id && cur.until ? cur.until : null;
      var backTo = cur && cur.returnTo ? cur.returnTo.label : (eff ? eff.label : null);
      var ret = until ? D().hm(until) + '에 ' + (backTo ? q(backTo) + jo(backTo, '로/으로') : '시간표대로') + ' 돌아갈게요.' : '';
      var mins = until ? Math.max(1, Math.round((toDate(until).getTime() - n.getTime()) / MIN)) : null;
      var pause = anchoredTasks(v, 'pause');
      if (to.id === 'break') {
        line((mins ? mins + '분 쉬어요' : '쉬어요') + (ret ? ' · ' + ret : ''));
        if (pause.length) line(SW().ATMODE_HEAD.pause + ': ' + titles(pause));
        actions.push(btn('스트레칭 보기', function () { if (AS() && AS().rest) AS().rest(); }));
        actions.push(btn('5분 더', function () { extend(5); }));
      } else if (to.id === 'meal') {
        line(label + ' 맛있게 드세요' + (ret ? ' · ' + ret : '.'));
        if (pause.length) line(label + ' 때 하기로 한 일: ' + titles(pause));
      } else if (to.id === 'drive') {
        line('운전 중엔 아무것도 띄우지 않아요. 안전 운전하세요.');
      } else if (to.id === 'focus') {
        line((mins ? mins + '분 ' : '') + '집중해요 · 알림을 멈췄어요.');
      } else if (def && def.rec === 'none') {
        line(label + '엔 추천과 알림을 쉬어요' + (ret ? ' · ' + ret : '.'));
        actions.push(btn('30분 더', function () { extend(30); }));
      } else {
        line((mins ? mins + '분 동안 ' : '') + q(label) + (ret ? ' · ' + ret : ''));
      }
      actions.push(btn('지금 복귀', function () { back(); }));
    } else if (cat === 'sleep') {
      var ev = firstEventTomorrow(n);
      line('푹 자요.' + (ev ? ' 내일 첫 일정은 ' + D().hm(ev.start) + ' ' + q(ev.title || '일정') + jo(ev.title || '일정', '예요/이에요') + '.' : ''));
    } else if (to.id === 'none') {
      line('상태 없이 모두 보여 드릴게요.');
      actions.push(btn('시간표대로', function () { toGuess(); }));
    } else {
      actions.push(revertBtn);
    }

    if (m.pure && m.text) {
      if (m.noteId) {
        actions.push(h('button.link-btn', { type: 'button', onclick: function () { if (DN.app) DN.app.go('notes', { noteId: m.noteId }); } }, '메모로 남겼어요'));
      } else {
        actions.push(btn('메모로 남기기', function () {
          var CP = DN.capture;
          if (!CP || !CP.submit) return;
          var note = CP.submit(m.text, null, null, { statusLine: m.text });
          if (note && AS() && AS().update) AS().update(m.id, { noteId: note.id });
        }));
      }
    }
    return h('div.msg.msg-assistant.' + cls, h('div.msg-body', h('div.st-card.st-' + cat,
      h('div.st-card-head', h('span.st-dot', { 'aria-hidden': 'true' }), h('span', head)),
      lines.length ? h('div.st-lines', lines) : null,
      actions.length ? h('div.msg-actions.st-actions', actions) : null)));
  }

  function pickCard(m, st, n) {
    var pf = profile(), eff = effective(n), xid = explicitId(eff);
    var pills = pf.menu.map(function (id) {
      var d = pf.statuses[id];
      return h('button.pill', { type: 'button', 'aria-pressed': xid === id ? 'true' : 'false', onclick: function () { set({ id: id }, { source: 'menu' }); } }, d.label);
    });
    pills.push(h('button.pill', { type: 'button', 'aria-pressed': eff && eff.guessed && !eff.overlay ? 'true' : 'false', onclick: function () { toGuess(); } }, '시간표대로'));
    return h('div.msg.msg-assistant.msg-status', h('div.msg-body', h('div.st-card.st-pick',
      h('div.st-card-head', h('span', '지금 어떤 시간인가요?')),
      h('div.st-pills', { role: 'group', 'aria-label': '지금 상태 고르기' }, pills))));
  }

  var OFFER_TEXT = {
    office: '회사에 다니시나 봐요. ‘직장인’ 리듬으로 맞추면 퇴근하면 업무 할 일은 접고 집안일·개인 일을 먼저 보여 드려요.',
    freelance: '혼자 일하시나 봐요. ‘프리랜서·재택’ 리듬으로 맞추면 일이 끝나도 업무 할 일을 숨기지 않고 아래로 내려 둬요.',
    student: '공부하시나 봐요. ‘학생’ 리듬으로 맞추면 수업 중엔 추천과 알림을 쉬어요.',
    shop: '가게를 운영하시나 봐요. ‘자영업’ 리듬으로 맞추면 영업 중엔 짧은 일만 골라 드려요.',
    shift: '교대로 일하시나 봐요. ‘교대 근무’ 리듬으로 맞추면 자정을 넘는 근무도 그대로 둬요.',
    home: '아이를 돌보시나 봐요. ‘육아·살림’ 리듬으로 맞추면 아이와 함께일 때는 짧은 일만 골라 드려요.'
  };
  function offerCard(m, st, n) {
    var SWd = SW(), p = SWd && SWd.PRESETS && SWd.PRESETS[m.preset];
    if (!p) return null;
    if (m.resolved) {
      return h('div.msg.msg-assistant.msg-status.is-past', h('div.msg-body', h('div.st-card-past.meta',
        m.resolved === 'applied' ? q(p.label) + ' 리듬으로 맞췄어요.' : q(p.label) + ' 리듬은 쓰지 않기로 했어요.')));
    }
    function resolve(r) { if (AS() && AS().update) AS().update(m.id, { resolved: r }); }
    return h('div.msg.msg-assistant.msg-status', h('div.msg-body', h('div.st-card.st-offer',
      h('div.st-line', OFFER_TEXT[m.preset] || (q(p.label) + ' 리듬으로 맞춰 볼까요? ' + (p.desc || ''))),
      h('div.msg-actions.st-actions',
        btn('맞추기', function () { applyPreset(m.preset); resolve('applied'); ui().toast(q(p.label) + ' 리듬으로 맞췄어요.'); }, true),
        btn('괜찮아요', function () { resolve('dismissed'); })))));
  }

  function card(m, st, n) {
    if (!m || !ready()) return null;
    n = n ? toDate(n) : now();
    try {
      if (m.kind === 'status') return statusCard(m, st, n);
      if (m.kind === 'status-pick') return pickCard(m, st, n);
      if (m.kind === 'status-offer') return offerCard(m, st, n);
    } catch (e) { console.error(e); }
    return null;
  }

  // 프리셋 바꾸기 — 묻지 않고 바로. 지금 상태 id 가 새 프리셋에 없으면 시간표대로 (STATUS §11)
  function applyPreset(id) {
    if (!ready()) return;
    var n = now();
    S().mutate(null, function (s) {
      var sp = s.prefs.statusProfile = Object.assign({ v: 1 }, s.prefs.statusProfile || {});
      sp.preset = id;
      var pf = ST().profile(s.prefs);
      var cur = s.presence && s.presence.current;
      if (cur && !pf.statuses[cur.id]) {
        ST().setStatus(s, { id: null }, { source: 'menu' }, pf, n);
      }
    }, { silent: true, source: 'status' });
    rev++; viewCache.key = null;
    S().mutate(null, function () {}, { source: 'status' });   // 화면에 알린다 (홈 칩·목록)
  }

  // ------------------------------------------------------------------ 맥락 칩 · 메뉴 (STATUS §6.5, §10.6)
  function ctxClass(pf, id) {
    if (!id) return 'ctx-none';
    var c = pf.contexts[id];
    return c && c.custom ? 'ctx-custom' : 'ctx-' + id;
  }
  // where: 'today'|'cap'|'detail' — 고친 결과를 그 화면이 다시 그리도록 source 를 고른다
  function contextChip(task, opts) {
    if (!task || !isActive()) return null;
    opts = opts || {};
    var pf = profile(), n = now();
    var r = ST().contextOf(S().state, task, pf, n);
    var fixed = r.source === 'user' || r.source === 'project';
    var label = r.value ? ST().contextLabel(pf, r.value) : (r.source === 'user' ? '정하지 않음' : '맥락');
    var guess = !!r.value && !fixed;
    var b = h('button.chip.ctx-chip.' + ctxClass(pf, r.value) + (guess ? '.is-guess' : '') + (!r.value && r.source !== 'user' ? '.is-empty' : ''), {
      type: 'button', 'aria-haspopup': 'menu', 'data-focus-key': opts.focusKey || null,
      'aria-label': '맥락: ' + label + (guess ? ' (추정)' : '') + ' — 바꾸기',
      title: guess ? (r.evidence ? q(r.evidence) + jo(r.evidence, '라는/이라는') + ' 말로 짐작했어요' : '짐작한 맥락이에요') : null,
      onclick: function (e) {
        e.stopPropagation();
        contextMenu(e.currentTarget, task.id, { source: opts.source || (opts.where === 'detail' ? 'detail' : 'status') });
      },
      onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }
    }, r.value ? h('span.kind-dot', { 'aria-hidden': 'true' }) : null, label + (guess ? ' (추정)' : ''), ui().icon('chevronDown', 'st-caret'));
    return b;
  }
  function contextMenu(anchor, taskId, opts) {
    if (!ready()) return null;
    opts = opts || {};
    var pf = profile(), t = M().byId(S().state.tasks, taskId);
    if (!t) return null;
    var r = ST().contextOf(S().state, t, pf, now());
    var key = anchor && anchor.getAttribute ? anchor.getAttribute('data-focus-key') : null;
    // 고른 뒤 칩이 다른 묶음으로 옮겨 사라지면(맥락 칩이 없는 묶음) 그 할 일 행으로 포커스를 돌려준다
    function choose(id) {
      setTaskContext(taskId, id, opts);
      setTimeout(function () {
        var a = document.activeElement;
        if (a && a !== document.body) return;
        var el = (key && document.querySelector('[data-focus-key="' + key + '"]')) ||
          document.querySelector('[data-id="' + taskId + '"][tabindex], [data-task-id="' + taskId + '"]');
        if (el && el.focus) try { el.focus(); } catch (e) {}
      }, 0);
    }
    var items = [{ label: '어느 쪽 일인가요?' }];
    pf.contextIds.forEach(function (id) {
      var c = pf.contexts[id];
      items.push({ label: c.label, icon: h('span.kind-dot.' + ctxClass(pf, id), { 'aria-hidden': 'true' }), checked: r.value === id,
        onClick: function () { choose(id); } });
    });
    items.push({ sep: true });
    items.push({ label: '정하지 않음', checked: !r.value && r.source === 'user', onClick: function () { choose(null); } });
    return ui().menu(anchor, items, { label: '어느 쪽 일인가요?', className: 'cap-menu.status-menu' });
  }
  function setTaskContext(taskId, ctxId, opts) {
    if (!ready()) return null;
    opts = opts || {};
    var pf = profile(), n = now();
    var r = S().mutate('맥락 바꾸기', function (s) { return ST().setTaskContext(s, taskId, ctxId, pf, n); }, { source: opts.source || 'today' });
    rev++; viewCache.key = null;
    if (!r || opts.quiet) return r;
    var title = (r.task && r.task.title) || '';
    var lab = ctxId ? ST().contextLabel(pf, ctxId) : null;
    if (r.learned === 'strong' && r.phrase && lab) {
      ui().undoToast('앞으로 ' + q(r.phrase) + jo(r.phrase, '가/이') + ' 들어간 할 일은 ' + lab + jo(lab, '로/으로') + ' 볼게요');
    } else if (lab) {
      ui().undoToast(q(title) + jo(title, '를/을') + ' ' + lab + jo(lab, '로/으로') + ' 뒀어요');
    } else {
      ui().undoToast(q(title) + '의 맥락을 정하지 않음으로 뒀어요');
    }
    return r;
  }
  function setTaskAtMode(taskId, mode, opts) {
    if (!ready()) return null;
    opts = opts || {};
    var n = now();
    var r = S().mutate('언제 할지 바꾸기', function (s) { return ST().setTaskAtMode(s, taskId, mode || null, n); }, { source: opts.source || 'detail' });
    rev++; viewCache.key = null;
    return r;
  }
  function markShown(taskId) {
    if (!ready() || !taskId) return;
    write(function (s) { ST().markShown(s, taskId); }, true);
  }

  // ------------------------------------------------------------------ 결과 카드 제안 줄 (STATUS §13)
  function resolveHint(noteId, value) {
    write(function (s) {
      var note = M().byId(s.notes || [], noteId);
      if (note && note.capture && note.capture.statusHint) note.capture.statusHint.resolved = value;
    }, value === 'applied');
  }
  function hintChip(note) {
    var hint = note && note.capture && note.capture.statusHint;
    if (!hint || !hint.id || !ready() || !profile().enabled) return null;
    if (hint.resolved === 'dismissed') return null;
    var label = hint.label || ((profile().statuses[hint.id] || {}).label) || '';
    if (hint.resolved === 'applied') return h('div.st-hint.meta', '상태를 ' + q(label) + jo(label, '로/으로') + ' 바꿨어요.');
    var lead = hint.from === 'ai' ? 'AI가 ' + q(label) + jo(label, '로/으로') + ' 봤어요' : '상태를 ' + q(label) + jo(label, '로/으로') + ' 바꿀까요?';
    return h('div.st-hint', { role: 'group', 'aria-label': '상태 제안' },
      h('span.st-hint-text', lead),
      h('button.btn.btn-xs', { type: 'button', onclick: function () {
        resolveHint(note.id, 'applied');
        set({ id: hint.id, label: hint.label }, { source: 'hint' });
      } }, '바꾸기'),
      h('button.btn.btn-xs.btn-ghost', { type: 'button', onclick: function () { resolveHint(note.id, 'dismissed'); } }, '아니요'));
  }

  // ------------------------------------------------------------------ AI 입력
  function contextsForAi() { return ready() ? ST().contextHintsForAi(profile()) : []; }
  function presenceForAi() {
    if (!isActive()) return null;
    var c = current();
    return c ? c.label + (c.guessed ? ' · 시간표 기준' : '') : null;
  }

  // ------------------------------------------------------------------ 휴식 타이머 (STATUS §8.4)
  function onRestTimer(msgId, timerEnd) {
    if (!isActive() || !timerEnd) return;
    var eff = effective();
    if (!eff) return;
    if (eff.overlay && eff.overlay.id === 'break') changeStatus({ id: 'break', until: timerEnd }, { source: 'rest' });
    else if (!eff.overlay && eff.category === 'work') changeStatus({ id: 'break', until: timerEnd }, { source: 'rest' });
  }
  function onRestDone() {
    if (!ready()) return;
    var p = presence(), cur = p && p.current;
    if (!cur || cur.id !== 'break' || cur.source !== 'rest') return;
    var pf = profile(), n = now();
    write(function (s) {
      if (ST().settle(s, pf, n)) return;
      var c = s.presence.current;
      if (!c || c.id !== 'break') return;
      ST().setStatus(s, c.returnTo ? { id: c.returnTo.id, label: c.returnTo.label } : { id: null }, { source: 'rest' }, pf, n);
    });
  }

  // ------------------------------------------------------------------ 시작
  function init() {
    if (!S()) return;
    S().subscribe(function () { rev++; viewCache.key = null; });
    S().whenReady(function () { try { tick(now()); } catch (e) { console.error(e); } });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);

  DN.status = {
    isActive: isActive, profile: profile, view: view, current: current,
    detect: detect, apply: apply, hintFor: hintFor, touch: touch,
    set: set, revert: revert, toGuess: toGuess, extend: extend, back: back, confirmGuess: confirmGuess,
    setFromCommand: setFromCommand, postPicker: postPicker, tick: tick,
    chip: chip, openMenu: openMenu, card: card, nudgeLine: nudgeLine,
    contextChip: contextChip, contextMenu: contextMenu, setTaskContext: setTaskContext, setTaskAtMode: setTaskAtMode, markShown: markShown,
    hintChip: hintChip, contextsForAi: contextsForAi, presenceForAi: presenceForAi,
    onRestTimer: onRestTimer, onRestDone: onRestDone, applyPreset: applyPreset
  };
})();
