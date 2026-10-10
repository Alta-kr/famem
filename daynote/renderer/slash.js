'use strict';

// 명령어 자동완성 팝업 (DN.slash) — 입력창 값이 '/명령' 한 토큰일 때만 목록을 띄운다.
// 순수 DOM 컴포넌트: ui.js 를 쓰지 않고 window.Daynote.commands 에만 기대므로 빠른 메모 창에서도 같은 파일을 쓴다.
// 한글 조합 중에도 값이 들어오므로 keydown 이 아니라 input 이벤트로 연다. 조합 중(isComposing·229) 키는 건드리지 않는다.
// 입력창의 Enter 리스너보다 먼저 attach 해야 한다(같은 요소의 리스너는 붙인 순서대로 불린다).

(function () {
  var DN = window.Daynote = window.Daynote || {};
  var OPEN_RE = /^[\/／][^\s\/／]*$/;
  var MIN_ROOM = 120;   // 위 자리가 모자랄 때 줄일 수 있는 최소 높이(px) — 폰 줄 두 개 남짓

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function attach(ta, o) {
    o = o || {};
    var prefix = o.idPrefix || 'slash';
    var CMD = function () { return DN.commands; };
    var pop = null, items = [], active = 0, dismissed = null, blurTimer = null, dead = false;

    ta.setAttribute('aria-autocomplete', 'list');
    ta.setAttribute('aria-expanded', 'false');

    function condition() {
      if (dead || !CMD() || !CMD().match) return false;
      var v = ta.value;
      if (!OPEN_RE.test(v) || v === dismissed) return false;
      try { if (ta.selectionStart !== v.length || ta.selectionEnd !== v.length) return false; } catch (e) {}
      return true;
    }

    function setAria(open) {
      ta.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) ta.setAttribute('aria-controls', prefix + '-list'); else ta.removeAttribute('aria-controls');
      if (open && items.length) ta.setAttribute('aria-activedescendant', prefix + '-opt-' + active);
      else ta.removeAttribute('aria-activedescendant');
    }

    function paintActive() {
      if (!pop) return;
      for (var i = 0; i < items.length; i++) {
        var n = document.getElementById(prefix + '-opt-' + i);
        if (!n) continue;
        var on = i === active;
        n.classList.toggle('is-active', on);
        n.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on) {
          // offsetParent 는 배치(홈: absolute, 빠른 창: 제자리)에 따라 달라지므로 화면 좌표로 비교한다
          var pr = pop.getBoundingClientRect(), nr = n.getBoundingClientRect();
          if (nr.top < pr.top) pop.scrollTop -= pr.top - nr.top;
          else if (nr.bottom > pr.bottom) pop.scrollTop += nr.bottom - pr.bottom;
        }
      }
      setAria(true);
    }

    function build() {
      if (!pop) {
        pop = el('div', 'slash-pop' + (o.placement === 'below' ? ' is-below' : ' is-above'));
        pop.id = prefix + '-list';
        pop.setAttribute('role', 'listbox');
        pop.setAttribute('aria-label', '명령어');
        (o.mount || ta.parentNode).appendChild(pop);
      }
      pop.textContent = '';
      items.forEach(function (it, i) {
        var row = el('div', 'slash-opt' + (it.kind ? ' kind-' + it.kind : ''));
        row.id = prefix + '-opt-' + i;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', 'false');
        var ico = o.iconFor ? o.iconFor(it.icon) : null;
        if (ico) { var w = el('span', 'slash-ico'); w.setAttribute('aria-hidden', 'true'); w.appendChild(ico); row.appendChild(w); }
        var main = el('span', 'slash-main');
        main.appendChild(el('b', 'slash-token', it.token));
        main.appendChild(el('span', 'slash-desc', it.desc));
        row.appendChild(main);
        if (it.alt && it.alt.length) row.appendChild(el('span', 'slash-alt', it.alt.join(' · ')));
        row.addEventListener('pointerdown', function (e) { e.preventDefault(); });
        row.addEventListener('pointermove', function () { if (active !== i) { active = i; paintActive(); } });
        row.addEventListener('click', function (e) { e.preventDefault(); active = i; choose(); ta.focus(); });
        pop.appendChild(row);
      });
      if (!items.length) pop.appendChild(el('div', 'slash-empty', '맞는 명령어가 없어요 · 그대로 보내면 글로 적어요'));
      else pop.appendChild(el('div', 'slash-foot', '↑↓ 고르기 · Enter·Tab 넣기 · Esc 닫기'));
    }

    // 홈(위로 뜨는 팝업): 입력창 위 남은 자리(화면·잘라 내는 조상 상자 안)가 모자라면 높이를 줄여
    // 모든 줄이 팝업 안 스크롤로 닿게 한다. 조상(.chat 은 overflow:hidden)을 스크롤하지는 않는다.
    function fitAbove() {
      if (!pop || o.placement === 'below') return;
      pop.style.maxHeight = '';
      var top = window.visualViewport ? window.visualViewport.offsetTop : 0;
      for (var p = pop.parentNode; p && p.nodeType === 1 && p !== document.body; p = p.parentNode) {
        var ov = window.getComputedStyle(p).overflowY;
        if (ov !== 'visible') top = Math.max(top, p.getBoundingClientRect().top);
      }
      var r = pop.getBoundingClientRect(), room = r.bottom - top - 8;
      if (r.top >= top + 8) return;
      pop.style.maxHeight = Math.max(MIN_ROOM, Math.floor(room)) + 'px';
    }

    function close() {
      if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
      pop = null; items = []; active = 0;
      ta.setAttribute('aria-expanded', 'false');
      ta.removeAttribute('aria-controls');
      ta.removeAttribute('aria-activedescendant');
      if (o.onResize) o.onResize();
    }

    function refresh() {
      if (!condition()) { if (pop) close(); return; }
      var prev = items[active] ? items[active].name : null;
      items = CMD().match(ta.value.slice(1)) || [];
      active = 0;
      for (var i = 0; i < items.length; i++) if (items[i].name === prev) active = i;
      build();
      fitAbove();
      paintActive();
      if (!items.length) setAria(true);
      if (o.onResize) o.onResize();
      // 같은 input 이벤트의 다른 리스너(입력창 높이 맞추기)가 자리를 옮긴 뒤 한 번 더 잰다
      if (o.placement !== 'below') setTimeout(function () { if (pop && !dead) { fitAbove(); paintActive(); } }, 0);
    }

    function complete(it) {
      ta.value = it.token + ' ';
      try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {}
      close();
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function choose() {
      var it = items[active];
      if (!it) return;
      if (it.noArgs) {
        var tok = it.token;
        close();
        // 바로 실행하는 명령은 입력을 써 버린다 — input 을 보내 임시 저장(초안) 같은 바깥 리스너도 빈 값을 알게 한다
        ta.value = '';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        if (o.onExecute) o.onExecute(tok);
      } else complete(it);
    }

    function onInput() { if (dismissed !== null && ta.value !== dismissed) dismissed = null; refresh(); }

    function onKey(e) {
      if (!pop) return;
      if (e.isComposing || e.keyCode === 229) return;
      if (!items.length) {
        // 맞는 명령이 없을 때: Esc 는 팝업만 닫는다(창 숨기기·상세 닫기로 번지지 않게). Enter 는 막지 않는다(보내기 → 모르는 명령 처리)
        if (e.key === 'Escape') { dismissed = ta.value; close(); e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }
        return;
      }
      var k = e.key, handled = true;
      if (k === 'ArrowDown') { active = (active + 1) % items.length; paintActive(); }
      else if (k === 'ArrowUp') { active = (active - 1 + items.length) % items.length; paintActive(); }
      else if (k === 'Tab' && !e.shiftKey) complete(items[active]);
      else if (k === 'Enter' && !e.shiftKey) choose();
      else if (k === 'Escape') { dismissed = ta.value; close(); e.stopPropagation(); }
      else handled = false;
      if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
    }

    function onBlur() { clearTimeout(blurTimer); blurTimer = setTimeout(function () { if (pop && !dead) close(); }, 150); }
    function onFocus() { clearTimeout(blurTimer); refresh(); }
    function onSel() { if (pop && !condition()) close(); }

    ta.addEventListener('input', onInput);
    ta.addEventListener('keydown', onKey);
    ta.addEventListener('blur', onBlur);
    ta.addEventListener('focus', onFocus);
    ta.addEventListener('click', onSel);
    ta.addEventListener('keyup', onSel);

    return {
      isOpen: function () { return !!pop; },
      close: close,
      refresh: refresh,
      destroy: function () {
        dead = true; clearTimeout(blurTimer);
        ta.removeEventListener('input', onInput);
        ta.removeEventListener('keydown', onKey);
        ta.removeEventListener('blur', onBlur);
        ta.removeEventListener('focus', onFocus);
        ta.removeEventListener('click', onSel);
        ta.removeEventListener('keyup', onSel);
        if (pop) close();
        ta.removeAttribute('aria-autocomplete');
        ta.removeAttribute('aria-expanded');
      }
    };
  }

  DN.slash = { attach: attach };
})();
