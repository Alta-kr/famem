'use strict';

// 끌기 엔진 — 마우스·터치·펜을 포인터 이벤트 하나로 다룬다 (HTML5 draggable 을 쓰지 않는다).
// arm(el, opts) 로 끌 수 있게 만들고, 놓을 수 있는 곳은 [data-drop] 속성으로 표시한다.
// 한 번에 하나만 끈다. 끌기가 끝나면 400ms 안의 click 을 한 번 삼킨다(놓기가 칸 클릭으로 번지지 않게).
// 화면 낭독기에는 #dp-live 로 시작·대상·결과를 알린다.

(function () {
  var DN = window.Daynote = window.Daynote || {};

  var EDGE = 40, SCROLL_STEP = 12, SWALLOW_MS = 400;
  var DEFAULTS = { longPressMs: 350, threshold: 4, touchSlop: 8, ignore: 'button, a, input, select, textarea, .chip', grip: null };

  var cur = null;        // 진행 중인 끌기: { arm, opts, s, ghost, el, raf, scrollRaf, lastTarget }
  var pending = null;    // 아직 시작 전(문턱·길게 누르기 대기): { arm, opts, el, id, type, x0, y0, timer }
  var liveEl = null;

  function say(text) {
    if (!liveEl || !liveEl.isConnected) {
      liveEl = document.createElement('div');
      liveEl.className = 'sr-only';
      liveEl.id = 'dp-live';
      liveEl.setAttribute('aria-live', 'assertive');
      document.body.appendChild(liveEl);
    }
    liveEl.textContent = '';
    setTimeout(function () { if (liveEl) liveEl.textContent = text || ''; }, 20);
  }

  function call(fn, a, b) { if (typeof fn === 'function') { try { return fn(a, b); } catch (e) { console.error(e); } } return undefined; }

  function onDocMove(e) {
    if (pending && e.pointerId === pending.id) {
      var dx = e.clientX - pending.x0, dy = e.clientY - pending.y0;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (pending.type === 'touch') {
        if (dist > pending.opts.touchSlop) clearPending();   // 스크롤로 보고 포기
      } else if (dist >= pending.opts.threshold) {
        start(e.clientX, e.clientY);
      }
      return;
    }
    if (cur && e.pointerId === cur.pointerId) {
      cur.s.x = e.clientX; cur.s.y = e.clientY;
      if (e.cancelable && cur.s.pointerType === 'touch') e.preventDefault();
      schedule();
    }
  }
  function onDocUp(e) {
    if (pending && e.pointerId === pending.id) { clearPending(); return; }
    if (cur && e.pointerId === cur.pointerId) {
      cur.s.x = e.clientX; cur.s.y = e.clientY;
      updateTarget();
      finish(true);
    }
  }
  function onDocCancel(e) {
    if (pending && e.pointerId === pending.id) { clearPending(); return; }
    if (cur && e.pointerId === cur.pointerId) finish(false);
  }
  function onKey(e) {
    if (!cur) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  }
  function onBlur() { if (cur) finish(false); if (pending) clearPending(); }

  function listen(on) {
    var f = on ? 'addEventListener' : 'removeEventListener';
    document[f]('pointermove', onDocMove, { passive: false });
    document[f]('pointerup', onDocUp, true);
    document[f]('pointercancel', onDocCancel, true);
    document[f]('keydown', onKey, true);
    window[f]('blur', onBlur);
  }

  function clearPending() {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending = null;
    if (!cur) listen(false);
  }

  function start(x, y) {
    var p = pending;
    pending = null;
    clearTimeout(p.timer);
    var payload = call(p.opts.payload, { x: p.x0, y: p.y0 });
    if (!payload) { listen(false); return; }
    var s = { payload: payload, pointerType: p.type, x: x, y: y, target: null, startedAt: Date.now() };
    cur = { arm: p.arm, opts: p.opts, s: s, el: p.el, pointerId: p.id, raf: 0, scrollRaf: 0 };
    try { p.el.setPointerCapture(p.id); } catch (e) { /* 이미 놓았을 수 있다 */ }
    document.documentElement.classList.add('dp-dragging');
    p.el.classList.add('is-dragging');
    var label = call(p.opts.label, payload) || payload.title || '';
    var ghost = document.createElement('div');
    ghost.className = 'dp-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.textContent = label;
    document.body.appendChild(ghost);
    cur.ghost = ghost;
    placeGhost();
    say('‘' + (payload.title || label) + '’ 옮기는 중이에요.');
    call(p.opts.onStart, s);
    updateTarget();
    call(p.opts.onMove, s);
    autoScrollLoop();
  }

  function placeGhost() {
    if (!cur || !cur.ghost) return;
    cur.ghost.style.transform = 'translate3d(' + (cur.s.x + 12) + 'px,' + (cur.s.y + 12) + 'px,0)';
  }

  function schedule() {
    if (!cur || cur.raf) return;
    cur.raf = requestAnimationFrame(function () {
      if (!cur) return;
      cur.raf = 0;
      placeGhost();
      updateTarget();
      call(cur.opts.onMove, cur.s);
    });
  }

  function updateTarget() {
    if (!cur) return;
    var el = document.elementFromPoint(cur.s.x, cur.s.y);
    var t = el && el.closest ? el.closest('[data-drop]') : null;
    if (t !== cur.s.target) {
      cur.s.target = t;
      call(cur.opts.onOver, t, cur.s);
    }
  }

  // 대상(또는 포인터 아래)의 스크롤 상자 가장자리 40px 안이면 rAF 마다 12px
  function scroller() {
    var el = document.elementFromPoint(cur.s.x, cur.s.y);
    if (!el || !el.closest) return null;
    return el.closest('[data-autoscroll], .cal-scroll, .cd-body, .cal-side-list');
  }
  function autoScrollLoop() {
    if (!cur) return;
    cur.scrollRaf = requestAnimationFrame(function () {
      if (!cur) return;
      var box = scroller();
      if (box) {
        var r = box.getBoundingClientRect();
        var dy = 0, dx = 0;
        if (cur.s.y < r.top + EDGE && box.scrollTop > 0) dy = -SCROLL_STEP;
        else if (cur.s.y > r.bottom - EDGE && box.scrollTop + box.clientHeight < box.scrollHeight) dy = SCROLL_STEP;
        if (box.scrollWidth > box.clientWidth + 1) {
          if (cur.s.x < r.left + EDGE && box.scrollLeft > 0) dx = -SCROLL_STEP;
          else if (cur.s.x > r.right - EDGE && box.scrollLeft + box.clientWidth < box.scrollWidth) dx = SCROLL_STEP;
        }
        if (dy || dx) {
          box.scrollTop += dy; box.scrollLeft += dx;
          updateTarget();
          call(cur.opts.onMove, cur.s);
        }
      }
      autoScrollLoop();
    });
  }

  function swallowClick() {
    var until = Date.now() + SWALLOW_MS;
    function onClick(e) {
      document.removeEventListener('click', onClick, true);
      // 놓은 뒤 새로 뜬 알림·팝오버의 버튼은 삼키지 않는다
      if (e.target && e.target.closest && e.target.closest('.toast-wrap, .menu, .overlay')) return;
      if (Date.now() <= until) { e.preventDefault(); e.stopPropagation(); }
    }
    document.addEventListener('click', onClick, true);
    setTimeout(function () { document.removeEventListener('click', onClick, true); }, SWALLOW_MS);
  }

  function finish(dropped) {
    var c = cur;
    if (!c) return;
    cur = null;
    if (c.raf) cancelAnimationFrame(c.raf);
    if (c.scrollRaf) cancelAnimationFrame(c.scrollRaf);
    listen(false);
    if (c.ghost) c.ghost.remove();
    document.documentElement.classList.remove('dp-dragging');
    c.el.classList.remove('is-dragging');
    try { c.el.releasePointerCapture(c.pointerId); } catch (e) { /* 없음 */ }
    swallowClick();
    var target = dropped ? c.s.target : null;
    if (target) {
      say('넣었어요.');
      call(c.opts.onDrop, target, c.s);
    } else {
      // 놓을 대상 밖에 놓기 = 취소와 같다
      say('취소했어요.');
      call(c.opts.onCancel, c.s);
    }
    call(c.opts.onEnd, c.s);
  }

  // el 에서 시작하는 끌기를 준비한다
  function arm(el, options) {
    var opts = {};
    Object.keys(DEFAULTS).forEach(function (k) { opts[k] = DEFAULTS[k]; });
    Object.keys(options || {}).forEach(function (k) { if (options[k] !== undefined) opts[k] = options[k]; });
    var handle = { el: el };

    function onDown(e) {
      if (cur || pending) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.pointerType === 'pen' && e.button > 0) return;
      var t = e.target;
      var onGrip = !!(opts.grip && t.closest && t.closest(opts.grip));
      if (!onGrip && opts.ignore && t.closest && t.closest(opts.ignore) && el.contains(t.closest(opts.ignore))) return;
      pending = { arm: handle, opts: opts, el: el, id: e.pointerId, type: e.pointerType || 'mouse', x0: e.clientX, y0: e.clientY, timer: 0 };
      listen(true);
      if (pending.type === 'touch') {
        if (onGrip) { start(e.clientX, e.clientY); return; }
        pending.timer = setTimeout(function () { if (pending && pending.el === el) start(pending.x0, pending.y0); }, opts.longPressMs);
      }
    }
    // 끄는 중에는 터치 스크롤을 막는다 (non-passive)
    function onTouchMove(e) { if (cur && cur.el === el && e.cancelable) e.preventDefault(); }
    // 길게 누르기 중 브라우저 기본 메뉴(길게 누르면 뜨는 메뉴) 막기
    function onContext(e) { if (cur && cur.el === el) e.preventDefault(); }

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('contextmenu', onContext);
    handle.destroy = function () {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('touchmove', onTouchMove, { passive: false });
      el.removeEventListener('contextmenu', onContext);
      if (pending && pending.el === el) clearPending();
    };
    return handle;
  }

  DN.dragPlace = {
    arm: arm,
    active: function () { return !!cur; },
    cancel: function () { if (cur) finish(false); else clearPending(); },
    session: function () { return cur ? cur.s : null; },
    say: say
  };
})();
