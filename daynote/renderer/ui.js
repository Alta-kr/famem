'use strict';

// 화면 공용 도구 — 요소 만들기, 아이콘, 알림(되돌리기), 대화상자, 메뉴, 할 일 행.

(function () {
  var D = window.Daynote.dates;
  var M = window.Daynote.model;

  // h('div.cls#id', {attrs}, children...)
  function h(sel, attrs) {
    var m = /^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i.exec(sel) || [];
    var el = document.createElement(m[1] || 'div');
    (m[2] || '').replace(/([.#])([\w-]+)/g, function (_, t, v) { if (t === '.') el.classList.add(v); else el.id = v; });
    var kids = Array.prototype.slice.call(arguments, 2);
    if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;            // 아이콘 같은 고정 문자열에만 쓴다
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    append(el, kids);
    return el;
  }
  function append(el, kids) {
    kids.forEach(function (c) {
      if (c == null || c === false) return;
      if (Array.isArray(c)) append(el, c);
      else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    });
  }

  // ------------------------------------------------------------------ 아이콘
  var P = {
    today: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    note: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
    task: '<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    project: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    weekly: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    play: '<path d="M7 5l12 7-12 7z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    snooze: '<path d="M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18zM9 9h6l-6 6h6"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
    flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
    star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.5 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
    alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    chevronLeft: '<path d="M15 6l-6 6 6 6"/>',
    chevronRight: '<path d="M9 6l6 6-6 6"/>',
    sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    idea: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>',
    archive: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>',
    chevronDown: '<path d="M6 9l6 6 6-6"/>',
    command: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>',
    theme: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18a9 9 0 0 0 0-18z" fill="currentColor" stroke="none"/>',
    // 명령어 칩 자물쇠 (FEATURES §6.8) · 현재 상태와 맥락 (STATUS §10.8)
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"/>',
    home: '<path d="M4 11l8-7 8 7"/><path d="M6 9.5V20h12V9.5M10 20v-5h4v5"/>',
    bag: '<path d="M5 8h14l-1 12H6z"/><path d="M9 10V7a3 3 0 0 1 6 0v3"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    heart: '<path d="M12 20s-7-4.4-9-9a4.8 4.8 0 0 1 9-3 4.8 4.8 0 0 1 9 3c-2 4.6-9 9-9 9z"/>',
    book: '<path d="M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2z"/><path d="M4 20a2 2 0 0 0 2 2h13v-4M8 7h7"/>',
    coffee: '<path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16M8 3v3M12 3v3"/>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
    walk: '<circle cx="13" cy="4.5" r="1.8"/><path d="M10 21l2.5-6 2.5 2v4M9 11l3-3 3 3 3 1M12.5 15L11 9"/>',
    train: '<rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 11h14M9 21l1.5-4M15 21l-1.5-4M9 14h.01M15 14h.01"/>',
    leaf: '<path d="M5 19c0-8 5-14 15-15-1 10-7 15-15 15z"/><path d="M5 19l7-7"/>'
  };
  function icon(name, cls) {
    var span = document.createElement('span');
    span.innerHTML = '<svg class="ico' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + (P[name] || '') + '</svg>';
    return span.firstChild;
  }

  // ------------------------------------------------------------------ 알림
  var toastWrap = null;
  // opts: { action:{label, fn} | actions:[{label, fn}], duration, error } — 버튼은 배열 순서대로, 그 뒤에 '닫기'.
  //   버튼을 누르면 알림을 닫고 fn() 을 부른다.
  function toast(msg, opts) {
    opts = opts || {};
    if (!toastWrap) { toastWrap = h('div.toast-wrap', { role: 'status', 'aria-live': 'polite' }); document.body.appendChild(toastWrap); }
    var el = h('div.toast' + (opts.error ? '.is-error' : ''), h('span', msg));
    var timer;
    function close() { clearTimeout(timer); el.remove(); }
    var acts = (Array.isArray(opts.actions) ? opts.actions : []).concat(opts.action ? [opts.action] : [])
      .filter(function (a) { return a && a.label && typeof a.fn === 'function'; });
    acts.forEach(function (a) {
      el.appendChild(h('button', { type: 'button', onclick: function () { close(); a.fn(); } }, a.label));
    });
    el.appendChild(h('button', { type: 'button', 'aria-label': '알림 닫기', onclick: close }, '닫기'));
    // 같은 종류 알림은 새 것으로 바꾼다 (쌓이지 않게)
    while (toastWrap.children.length >= 2) toastWrap.firstChild.remove();
    toastWrap.appendChild(el);
    timer = setTimeout(close, opts.duration || (acts.length ? 7000 : 3500));
    return close;
  }

  // 되돌리기 알림 — store.undo 를 붙여 준다
  function undoToast(msg) {
    var S = window.Daynote.store;
    return toast(msg, { action: { label: '되돌리기', fn: function () { S.undo(); } } });
  }

  // ------------------------------------------------------------------ 대화상자
  function modal(opts) {
    var prevFocus = document.activeElement;
    var overlay = h('div.overlay');
    var box = h('div.modal' + (opts.wide ? '.modal-wide' : ''), { role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title });
    var foot = h('div.modal-foot');
    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      if (prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch (e) {}
      if (opts.onClose) opts.onClose();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      if (e.key === 'Tab') {   // 포커스를 대화상자 안에 가둔다
        var f = box.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    box.appendChild(h('div.modal-head', h('h2', opts.title),
      h('button.icon-btn', { type: 'button', 'aria-label': '닫기', onclick: close }, icon('x'))));
    var body = h('div.modal-body');
    append(body, [opts.body]);
    box.appendChild(body);
    if (opts.footLeft) foot.appendChild(h('div.left', opts.footLeft));
    (opts.actions || []).forEach(function (a) {
      foot.appendChild(h('button.btn' + (a.primary ? '.btn-primary' : '') + (a.danger ? '.btn-danger' : ''), {
        type: 'button', disabled: a.disabled,
        onclick: function () { var r = a.onClick ? a.onClick() : undefined; if (r !== false) close(); }
      }, a.label));
    });
    if (opts.actions && opts.actions.length) box.appendChild(foot);
    overlay.appendChild(box);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey, true);
    setTimeout(function () {
      var f = box.querySelector('[autofocus]') || box.querySelector('.modal-body input, .modal-body textarea, .modal-body select') || box.querySelector('.modal-foot .btn-primary');
      if (f) f.focus();
    }, 0);
    return { close: close, box: box, body: body, foot: foot };
  }

  function confirmDialog(title, message, okLabel) {
    return new Promise(function (resolve) {
      var done = false;
      modal({
        title: title, body: h('p', { style: { margin: 0, lineHeight: 1.6 } }, message),
        actions: [
          { label: '취소', onClick: function () { done = true; resolve(false); } },
          { label: okLabel || '확인', primary: true, onClick: function () { done = true; resolve(true); } }
        ],
        onClose: function () { if (!done) resolve(false); }
      });
    });
  }

  // ------------------------------------------------------------------ 떠 있는 상자(팝오버) · 메뉴
  // 한 번에 하나만 연다. Esc 로 닫으면 연 버튼으로 포커스를 돌려준다.
  // 연 버튼이 다시 그려져 사라졌으면 같은 data-focus-key 를 가진 새 버튼을 찾아 돌려준다.
  // 바깥을 누르거나 창 크기가 바뀌면 닫는다.
  var openPop = null;
  function closeMenu(restore) { if (openPop) openPop.close(restore); }

  function focusBack(anchor, key) {
    var target = anchor && anchor.isConnected ? anchor : key ? document.querySelector('[data-focus-key="' + key + '"]') : null;
    if (target && target.focus) try { target.focus(); } catch (e) {}
  }

  // content: 요소. opts: { role, label, className, onClose, keepOnResize }
  //   keepOnResize: 창 크기가 바뀌어도(폰 화상 키보드) 닫지 않고 위치만 다시 잡는다. 기준 요소가 문서에서 사라졌으면 닫는다.
  function popover(anchor, content, opts) {
    opts = opts || {};
    closeMenu(false);
    var key = anchor && anchor.getAttribute ? anchor.getAttribute('data-focus-key') : null;
    var el = h('div.menu' + (opts.className ? '.' + opts.className : ''), { role: opts.role || 'dialog', 'aria-label': opts.label || null });
    var closed = false;
    function place() {
      var r = anchor.getBoundingClientRect();
      var top = r.bottom + 4, left = r.left;
      var mh = el.offsetHeight, mw = el.offsetWidth;
      if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
      if (left + mw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - mw - 8);
      el.style.top = top + 'px'; el.style.left = left + 'px';
    }
    function onDown(e) { if (!el.contains(e.target) && !(anchor && anchor.contains(e.target))) close(false); }
    function onAnchorDown(e) { if (anchor && anchor.contains(e.target)) { e.preventDefault(); close(false); } }   // 연 버튼을 다시 누르면 닫기만 한다
    function onResize() {
      if (opts.keepOnResize && anchor && anchor.isConnected) { place(); return; }
      close(false);
    }
    function close(restore) {
      if (closed) return;
      closed = true;
      el.remove();
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('mousedown', onAnchorDown, true);
      window.removeEventListener('resize', onResize);
      if (anchor && anchor.removeAttribute) anchor.removeAttribute('aria-expanded');
      if (openPop && openPop.el === el) openPop = null;
      if (restore) focusBack(anchor, key);
      if (opts.onClose) opts.onClose();
    }
    function setContent(node, role) {
      el.textContent = '';
      append(el, [node]);
      if (role) el.setAttribute('role', role);
      place();
      var f = el.querySelector('input, select, textarea, button');
      if (f) f.focus();
    }
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === 'Tab' && el.getAttribute('role') === 'menu') { e.preventDefault(); close(true); }
    });
    append(el, [content]);
    document.body.appendChild(el);
    place();
    if (anchor && anchor.setAttribute) anchor.setAttribute('aria-expanded', 'true');
    setTimeout(function () {
      if (closed) return;
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('mousedown', onAnchorDown, true);
      window.addEventListener('resize', onResize);
    }, 0);
    openPop = { el: el, close: close, setContent: setContent, place: place, anchor: anchor, key: key };
    return openPop;
  }

  // 메뉴 — role=menu. ↑/↓·Home/End 로 옮기고 Enter 로 고르고 Esc 로 닫는다.
  // items: { label, onClick(pop), sub, icon, kind, checked, disabled, keepOpen } · { label } (제목) · { sep: true }
  //   checked 를 주면 고를 수 있는 항목(menuitemradio)이 되고, 지금 값에 체크 표시가 붙는다.
  //   keepOpen: 고른 뒤에도 닫지 않는다 (onClick 이 pop.setContent 로 내용을 바꿀 때 — 예: 날짜 고르기)
  // opts: { label, className }
  function menu(anchor, items, opts) {
    opts = opts || {};
    var box = document.createDocumentFragment();
    var pop;
    items.forEach(function (it) {
      if (it.sep) { box.appendChild(h('div.menu-sep', { role: 'separator' })); return; }
      if (it.label && !it.onClick) { box.appendChild(h('div.menu-label', { role: 'presentation' }, it.label)); return; }
      var radio = it.checked !== undefined;
      box.appendChild(h('button' + (it.kind ? '.kind-' + it.kind : '') + (it.checked ? '.is-checked' : ''), {
        type: 'button', role: radio ? 'menuitemradio' : 'menuitem', 'aria-checked': radio ? (it.checked ? 'true' : 'false') : null,
        disabled: it.disabled, tabindex: '-1',
        onclick: function () {
          if (it.keepOpen) { it.onClick(pop); return; }
          pop.close(true);
          it.onClick(pop);
          // 고른 결과로 화면이 다시 그려져 포커스를 잃었으면 같은 자리의 버튼으로 돌려준다
          setTimeout(function () {
            var a = document.activeElement;
            if (!a || a === document.body) focusBack(anchor, pop.key);
          }, 0);
        }
      },
        it.kind && !it.icon ? h('span.kind-dot', { 'aria-hidden': 'true' }) : null,
        it.icon ? (typeof it.icon === 'string' ? icon(it.icon) : it.icon) : null,
        h('span.menu-text', it.label),
        it.sub ? h('span.sub', it.sub) : null,
        radio ? h('span.menu-check', { 'aria-hidden': 'true' }, it.checked ? icon('check') : null) : null));
    });
    pop = popover(anchor, box, { role: 'menu', label: opts.label, className: opts.className });
    var el = pop.el;
    function buttons() { return Array.prototype.slice.call(el.querySelectorAll('button:not([disabled])')); }
    var bs = buttons();
    var start = el.querySelector('button.is-checked:not([disabled])') || bs[0];
    if (start) start.focus();
    el.addEventListener('keydown', function (e) {
      if (el.getAttribute('role') !== 'menu') return;
      var list = buttons();
      if (!list.length) return;
      var i = list.indexOf(document.activeElement);
      var next = null;
      if (e.key === 'ArrowDown') next = list[(i + 1) % list.length];
      else if (e.key === 'ArrowUp') next = list[(i - 1 + list.length) % list.length];
      else if (e.key === 'Home') next = list[0];
      else if (e.key === 'End') next = list[list.length - 1];
      if (next) { e.preventDefault(); next.focus(); }
    });
    return el;
  }

  // ------------------------------------------------------------------ 종류 칩 (할 일 · 일정 · 메모 · 아이디어 · 링크)
  var KIND_LABEL = { task: '할 일', event: '일정', memo: '메모', idea: '아이디어', link: '링크' };
  var KIND_ICON = { task: 'task', event: 'calendar', memo: 'note', idea: 'idea', link: 'link' };
  function kindChip(kind, extra) {
    var k = KIND_LABEL[kind] ? kind : 'memo';
    return h('span.chip.chip-kind.kind-' + k, icon(KIND_ICON[k]), KIND_LABEL[k] + (extra || ''));
  }

  // 한국어 조사 — pair 는 '받침 없을 때/있을 때': '와/과', '를/을', '는/은', '가/이', '로/으로'('ㄹ' 받침도 '로')
  // 한글이 아닌 글자로 끝나면 앞쪽을 쓴다.
  function josa(word, pair) {
    var s = String(word || '');
    var c = s.charCodeAt(s.length - 1);
    var p = pair.split('/');
    if (!(c >= 0xAC00 && c <= 0xD7A3)) return s + p[0];
    var fin = (c - 0xAC00) % 28;
    if (p[1] === '으로') return s + (fin === 0 || fin === 8 ? p[0] : p[1]);
    return s + (fin ? p[1] : p[0]);
  }

  // ------------------------------------------------------------------ 할 일 칩
  function projectChip(state, projectId) {
    var p = M.byId(state.projects, projectId);
    if (!p || p.deletedAt) return null;
    return h('span.chip.chip-project', { style: { '--pc': p.color } }, p.name);
  }

  function dueChip(task, now) {
    if (!task.dueDate) return null;
    now = now || window.Daynote.app.now();
    var due = D.parseYmd(task.dueDate, task.dueTime || '23:59');
    var diff = D.dayDiff(now, D.parseYmd(task.dueDate));
    var txt = '마감 ' + D.relDay(task.dueDate, now) + (task.dueTime ? ' ' + task.dueTime : '');
    if (task.status !== 'done' && due.getTime() < now.getTime()) return h('span.chip.chip-overdue', icon('flag'), '기한 지남 · ' + txt.replace('마감 ', ''));
    if (task.status !== 'done' && diff === 0) return h('span.chip.chip-today', icon('flag'), txt);
    return h('span.chip.chip-due', icon('flag'), txt);
  }

  // 실제 작업 시간 — 마감일과 다른 정보임을 아이콘과 문구로 구분한다
  function scheduleChip(state, task, now) {
    if (task.status === 'done') return null;
    var b = M.nextBlockForTask(state, task.id, now);
    if (b) return h('span.chip.chip-sched', icon('clock'), '작업 ' + D.relDay(D.ymd(b.start), now) + ' ' + D.hm(b.start));
    return h('span.chip.chip-unsched', '일정 미배치');
  }

  function estimateChip(task) {
    if (task.status === 'done') return null;
    if (task.estimateMinutes == null) return h('span.chip', '소요 시간 미정');
    if (task.estimateSource === 'ai') return h('span.chip.chip-guess', { title: 'AI 추정값 — 눌러서 확인·수정' }, '약 ' + D.duration(task.estimateMinutes) + ' (추정)');
    return h('span.chip', icon('clock'), D.duration(task.estimateMinutes));
  }

  function statusChips(state, task, now) {
    var out = [];
    if (task.status === 'in_progress') out.push(h('span.chip.chip-progress', '진행 중'));
    if (task.status === 'waiting') out.push(h('span.chip.chip-waiting', '대기' + (task.waitingFor ? ' · ' + task.waitingFor : '')));
    var blockers = M.unmetBlockers(state, task);
    if (blockers.length && task.status !== 'done') out.push(h('span.chip.chip-waiting', '선행: ' + blockers[0].title + (blockers.length > 1 ? ' 외 ' + (blockers.length - 1) : '')));
    if (task.snoozedUntil && new Date(task.snoozedUntil) > (now || window.Daynote.app.now()) && task.status !== 'done') {
      var s = new Date(task.snoozedUntil);
      out.push(h('span.chip.chip-waiting', icon('snooze'), D.relDay(D.ymd(s), now) + ' ' + D.hm(s) + '까지 미룸'));
    }
    if (task.priority === 'high') out.push(h('span.chip.chip-high', '우선순위 높음'));
    if (task.priority === 'low') out.push(h('span.chip', '우선순위 낮음'));
    return out;
  }

  function sourceChip(state, task) {
    var s = task.sources && task.sources[0];
    if (!s) return null;
    var r = M.resolveRef(state, s);
    var label = s.type === 'email' ? '메일' : s.type === 'note' ? '메모' : '출처';
    return h('span.chip' + (r.missing ? '.chip-missing' : ''), { title: r.missing ? '원본이 삭제되었습니다' : r.label }, icon(s.type === 'email' ? 'mail' : 'note'), label + (r.missing ? ' (삭제됨)' : ''));
  }

  // 할 일 행. opts: { selected, onOpen, compact, hideProject }
  // 완료해도 바로 사라지지 않는다 — 목록은 화면을 떠날 때까지 recentlyDone 으로 붙잡아 둔다.
  function taskRow(state, task, opts) {
    opts = opts || {};
    var A = window.Daynote.app;
    var now = window.Daynote.app.now();
    var done = task.status === 'done';
    var check = h('input.check', {
      type: 'checkbox', checked: done,
      'aria-label': done ? '‘' + task.title + '’ 완료 취소' : '‘' + task.title + '’ 완료',
      onclick: function (e) { e.stopPropagation(); },
      onchange: function () { A.toggleDone(task.id); }
    });
    var chips = h('div.task-chips',
      statusChips(state, task, now),
      dueChip(task, now),
      opts.compact ? null : scheduleChip(state, task, now),
      opts.compact ? null : estimateChip(task),
      opts.hideProject ? null : projectChip(state, task.projectId),
      opts.compact ? null : sourceChip(state, task),
      task.sample ? h('span.chip.chip-sample', '샘플') : null
    );
    var actions = h('div.task-actions',
      done ? null : h('button.icon-btn', { type: 'button', title: '일정에 배치', 'aria-label': '‘' + task.title + '’ 일정에 배치', onclick: function (e) { e.stopPropagation(); A.scheduleTask(task.id); } }, icon('calendar')),
      h('button.icon-btn', { type: 'button', title: '더 보기', 'aria-label': '‘' + task.title + '’ 메뉴', onclick: function (e) { e.stopPropagation(); A.taskMenu(task.id, e.currentTarget); } }, icon('more'))
    );
    var title = h('div.task-title', task.title || '(제목 없음)');
    var li = h('li.task-row' + (done ? '.is-done' : '') + (opts.selected ? '.is-selected' : ''), {
      tabindex: '0', 'data-task-id': task.id,
      'aria-label': task.title + (done ? ', 완료됨' : ''),
      onclick: function () { A.openTask(task.id); },
      onkeydown: function (e) {
        if (e.target !== li) return;
        if (e.key === 'Enter') { e.preventDefault(); A.openTask(task.id); }
        if (e.key === ' ') { e.preventDefault(); A.toggleDone(task.id); }
        if (e.key === 'F2') { e.preventDefault(); startRename(); }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          var rows = Array.prototype.slice.call(document.querySelectorAll('.task-row'));
          var i = rows.indexOf(li);
          var next = rows[i + (e.key === 'ArrowDown' ? 1 : -1)];
          if (next) next.focus();
        }
      }
    }, check, h('div.task-main', title, chips), actions);

    // 제목 더블클릭 → 그 자리에서 고치기
    function startRename() {
      var input = h('input.task-title-input', { value: task.title, 'aria-label': '할 일 제목' });
      title.replaceWith(input);
      input.focus(); input.select();
      var finished = false;
      function finish(save) {
        if (finished) return; finished = true;
        var v = input.value.trim();
        if (save && v && v !== task.title) window.Daynote.store.mutate('제목 변경', function (s) { M.updateTask(s, task.id, { title: v }); });
        else input.replaceWith(title);
      }
      input.addEventListener('click', function (e) { e.stopPropagation(); });
      input.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', function () { finish(true); });
    }
    title.addEventListener('dblclick', function (e) { e.stopPropagation(); startRename(); });
    return li;
  }

  function projectOptions(state, selected, emptyLabel) {
    var opts = [h('option', { value: '' }, emptyLabel || '프로젝트 없음')];
    M.liveProjects(state).forEach(function (p) { opts.push(h('option', { value: p.id, selected: p.id === selected }, p.name)); });
    return opts;
  }

  function highlight(text, q) {
    if (!q) return [text];
    var out = [], lower = text.toLowerCase(), ql = q.toLowerCase(), i = 0, j;
    while ((j = lower.indexOf(ql, i)) !== -1) { out.push(text.slice(i, j)); out.push(h('mark', text.slice(j, j + q.length))); i = j + q.length; }
    out.push(text.slice(i));
    return out;
  }

  window.Daynote.ui = {
    TOAST_ACTIONS: true, POPOVER_KEEP_ON_RESIZE: true,
    h: h, icon: icon, toast: toast, undoToast: undoToast, modal: modal, confirm: confirmDialog, menu: menu, closeMenu: closeMenu, popover: popover,
    kindChip: kindChip, KIND_LABEL: KIND_LABEL, KIND_ICON: KIND_ICON, josa: josa,
    projectChip: projectChip, dueChip: dueChip, scheduleChip: scheduleChip, estimateChip: estimateChip,
    statusChips: statusChips, sourceChip: sourceChip, taskRow: taskRow, projectOptions: projectOptions, highlight: highlight
  };
})();
