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
    pause: '<path d="M8 5v14M16 5v14"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/>',
    redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 000 11H13"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
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
    upload: '<path d="M12 16V5M7 10l5-5 5 5M5 20h14"/>',
    pin: '<path d="M12 21s-6-5.6-6-11a6 6 0 0 1 12 0c0 5.4-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    idea: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>',
    archive: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>',
    chevronDown: '<path d="M6 9l6 6 6-6"/>',
    command: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>',
    theme: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18a9 9 0 0 0 0-18z" fill="currentColor" stroke="none"/>'
  };
  function icon(name, cls) {
    var span = document.createElement('span');
    span.innerHTML = '<svg class="ico' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + (P[name] || '') + '</svg>';
    return span.firstChild;
  }

  // ------------------------------------------------------------------ 알림
  var toastWrap = null;
  function toast(msg, opts) {
    opts = opts || {};
    if (!toastWrap) { toastWrap = h('div.toast-wrap', { role: 'status', 'aria-live': 'polite' }); document.body.appendChild(toastWrap); }
    var el = h('div.toast' + (opts.error ? '.is-error' : ''), h('span', msg));
    var timer;
    function close() { clearTimeout(timer); el.remove(); }
    if (opts.action) {
      el.appendChild(h('button', { type: 'button', onclick: function () { close(); opts.action.fn(); } }, opts.action.label));
    }
    el.appendChild(h('button', { type: 'button', 'aria-label': '알림 닫기', onclick: close }, '닫기'));
    // 같은 종류 알림은 새 것으로 바꾼다 (쌓이지 않게)
    while (toastWrap.children.length >= 2) toastWrap.firstChild.remove();
    toastWrap.appendChild(el);
    timer = setTimeout(close, opts.duration || (opts.action ? 7000 : 3500));
    close.el = el;   // 부르는 쪽이 모양을 더할 수 있게 (예: 완료 축하)
    return close;
  }

  // 되돌리기 알림 — store.undo 를 붙여 준다
  function undoToast(msg) {
    var S = window.Daynote.store;
    return toast(msg, { action: { label: '되돌리기', fn: function () { if (window.Daynote.app && window.Daynote.app.undo) window.Daynote.app.undo(); else S.undo(); } } });
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

  // content: 요소. opts: { role, label, className, onClose }
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
    function onAnchorDown(e) { if (anchor && anchor.contains(e.target)) { e.preventDefault(); anchor.__closedAt = Date.now(); close(false); } }   // 연 버튼을 다시 누르면 닫기만 한다
    function onResize() { close(false); }
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
  var KIND_LABEL = { task: '할 일', event: '일정', memo: '메모', idea: '아이디어', link: '링크', done: '완료', moved: '날짜 변경' };
  var KIND_ICON = { task: 'task', event: 'calendar', memo: 'note', idea: 'idea', link: 'link', done: 'check', moved: 'calendar' };
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

  // 마감 칩 — "마감 내일 18:00 · 21시간 남음" / 지났으면 "마감 지남 · 10월 3일 (토) · 2일 지남"
  // 지난 칩은 Alt+클릭으로 지금부터 24시간 뒤로 미룬다 (postponeOverdue)
  //   끝나지 않은 일의 칩은 누르면 마감을 고치는 창이 뜬다 (Enter·Space 도). opts.add: 마감이 없으면 '+ 마감' 칩
  function dueChip(task, now, opts) {
    now = now || window.Daynote.app.now();
    var open = task.status !== 'done';
    function editable(el, overdue) {
      if (!open) return el;
      el.classList.add('is-editable');
      el.setAttribute('role', 'button'); el.setAttribute('tabindex', '0');
      el.setAttribute('title', '눌러서 마감 고치기' + (overdue ? ' · Alt+클릭: 지금부터 ' + M.POSTPONE_HOURS + '시간 뒤로 미루기' : ''));
      el.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        if (overdue && e.altKey) { postponeOverdue(task.id); return; }
        dueEditor(el, task.id);
      });
      el.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault(); e.stopPropagation(); dueEditor(el, task.id);
      });
      el.addEventListener('dragstart', function (e) { e.preventDefault(); e.stopPropagation(); });
      return el;
    }
    if (!task.dueDate) return opts && opts.add && open && !task.planDate ? editable(h('span.chip.chip-add', icon('flag'), '+ 날짜')) : null;
    var due = D.dueAt(task.dueDate, task.dueTime);
    var diff = D.dayDiff(now, D.parseYmd(task.dueDate));
    var when = D.relDay(task.dueDate, now) + (task.dueTime ? ' ' + task.dueTime : '');
    if (!open) return h('span.chip.chip-due', icon('flag'), '마감 ' + when);
    var left = D.remainText(due, now);
    if (due.getTime() < now.getTime()) return editable(h('span.chip.chip-overdue.is-postponable', icon('flag'), '마감 지남 · ' + when + ' · ' + left), true);
    return editable(h('span.chip.' + (diff === 0 ? 'chip-today' : 'chip-due'), icon('flag'), '마감 ' + when + ' · ' + left));
  }

  // 마감 고치기 — 빠른 선택(오늘·내일·금요일·다음 주 월요일·하루 미루기) + 날짜·시각 + 마감 없애기
  //   토글 — 같은 칩을 다시 누르면 닫힌다 (popover 가 누르는 순간 닫으니 바로 다시 열지 않게). 창은 한 번에 하나만
  function justClosed(anchor) { return anchor && anchor.__closedAt && Date.now() - anchor.__closedAt < 500; }
  function dueEditor(anchor, taskId) {
    if (justClosed(anchor)) return null;
    var S = window.Daynote.store, A = window.Daynote.app;
    var t = M.byId(S.state.tasks, taskId);
    if (!t) return null;
    var now = A.now();
    // 마감(언제까지) · 할 날(이날 하기) 중 무엇을 정할지 — 할 날만 있는 일은 할 날부터
    var mode = !t.dueDate && t.planDate ? 'plan' : 'due';
    var dIn = h('input.input', { type: 'date', value: (mode === 'plan' ? t.planDate : t.dueDate) || '', 'aria-label': '날짜' });
    var tIn = h('input.input', { type: 'time', value: t.dueTime || '', 'aria-label': '마감 시각 (비우면 그날 안)' });
    var pop;
    function save(date, time, label) {
      if (mode === 'plan') {
        S.mutate(label || (date ? '할 날 정하기' : '할 날 지우기'), function (s) { M.updateTask(s, taskId, { planDate: date || null }, now); });
        if (pop) pop.close(true);
        undoToast(date ? '‘' + t.title + '’ ' + D.relDay(date, now) + '에 할게요.' : '‘' + t.title + '’ 할 날을 지웠어요.');
        return;
      }
      S.mutate(label || '마감 바꾸기', function (s) { M.updateTask(s, taskId, { dueDate: date || null, dueTime: date && time ? time : null }, now); });
      if (pop) pop.close(true);
      undoToast(date ? '‘' + t.title + '’ 마감을 ' + D.relDay(date, now) + (time ? ' ' + time : '') + '(으)로 정했어요.' : '‘' + t.title + '’ 마감을 없앴어요.');
    }
    // 마감 ↔ 할 날 옮기기 — "이건 마감이 아니라 그날 하려던 거야" (또는 반대)
    function swap() {
      // 할 날 탭에서는 지금 마감을 할 날로, 마감 탭에서는 지금 할 날을 마감으로 — 보고 있는 탭 쪽으로 옮긴다
      var to = mode;
      var day = to === 'plan' ? t.dueDate : t.planDate;
      S.mutate(to === 'plan' ? '마감을 할 날로' : '할 날을 마감으로', function (s) {
        M.updateTask(s, taskId, to === 'plan' ? { planDate: day, dueDate: null, dueTime: null } : { dueDate: day, planDate: null }, now);
      });
      if (pop) pop.close(true);
      undoToast('‘' + t.title + '’ ' + D.relDay(day, now) + (to === 'plan' ? ' — 마감이 아니라 그날 할 일로 바꿨어요.' : ' — 할 날을 마감으로 바꿨어요.'));
    }
    var quick = window.Daynote.horizon.planChoices(now);   // 오늘 · 내일 · 이번 주 금요일 · 다음 주 월요일 (한 곳에서 계산)
    var cur = function () { return mode === 'plan' ? t.planDate : t.dueDate; };
    var form = h('form.due-editor', { onsubmit: function (e) { e.preventDefault(); if (dIn.value) save(dIn.value, mode === 'plan' ? null : tIn.value); else dIn.focus(); } });
    function draw() {
      form.textContent = '';
      var list = quick.slice();
      if (cur()) list.push(['하루 미루기', D.ymd(D.addDays(D.parseYmd(cur()), 1))]);
      dIn.value = cur() || '';
      append(form, [
        h('div.due-mode', { role: 'tablist', 'aria-label': '무엇을 정할까요' },
          [['due', '마감 (언제까지)'], ['plan', '할 날 (이날 하기)']].map(function (m) {
            return h('button.due-mode-btn' + (mode === m[0] ? '.is-on' : ''), { type: 'button', role: 'tab', 'aria-selected': String(mode === m[0]),
              onclick: function () { mode = m[0]; draw(); } }, m[1]);
          })),
        h('div.due-quick', list.map(function (q) {
          return h('button.btn.btn-xs', { type: 'button', onclick: function () { save(q[1], mode === 'plan' ? null : (tIn.value || t.dueTime || ''), q[0] === '하루 미루기' ? (mode === 'plan' ? '할 날 미루기' : '마감 미루기') : null); } }, q[0]);
        })),
        h('div.due-fields' + (mode === 'plan' ? '.is-plan' : ''), dIn, mode === 'plan' ? null : tIn),
        (mode === 'plan' ? t.dueDate && !t.planDate : t.planDate && !t.dueDate) ? h('button.link-btn.due-swap', { type: 'button', onclick: swap },
          mode === 'plan' ? '지금 마감(' + D.relDay(t.dueDate, now) + ')을 할 날로 바꾸기' : '지금 할 날(' + D.relDay(t.planDate, now) + ')을 마감으로 바꾸기') : null,
        h('div.due-actions',
          cur() ? h('button.btn.btn-xs.btn-ghost', { type: 'button', onclick: function () { save(null, null, mode === 'plan' ? '할 날 지우기' : '마감 없애기'); } }, mode === 'plan' ? '할 날 지우기' : '마감 없애기') : null,
          h('button.btn.btn-xs.btn-primary', { type: 'submit' }, '저장'))]);
    }
    draw();
    pop = popover(anchor, form, { label: '날짜', className: 'menu-due' });
    return pop;
  }

  // 프로젝트 칩 — 누르면 프로젝트 바꾸기 (없으면 '+ 프로젝트')
  function projectPickChip(state, task) {
    var p = task.projectId && M.byId(state.projects, task.projectId);
    if (p && p.deletedAt) p = null;
    if (task.status === 'done') return p ? h('span.chip.chip-project', { style: { '--pc': p.color } }, p.name) : null;
    var el = p ? h('span.chip.chip-project.is-editable', { style: { '--pc': p.color } }, p.name) : h('span.chip.chip-add', icon('project'), '+ 프로젝트');
    el.setAttribute('role', 'button'); el.setAttribute('tabindex', '0'); el.setAttribute('title', '눌러서 프로젝트 바꾸기');
    el.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); projectPicker(el, task.id); });
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); projectPicker(el, task.id); } });
    el.addEventListener('dragstart', function (e) { e.preventDefault(); e.stopPropagation(); });
    return el;
  }
  function projectPicker(anchor, taskId) {
    if (justClosed(anchor)) return null;
    var S = window.Daynote.store, A = window.Daynote.app;
    var t = M.byId(S.state.tasks, taskId);
    if (!t) return null;
    function set(pid, name) {
      S.mutate('프로젝트 바꾸기', function (s) { M.updateTask(s, taskId, { projectId: pid || null }, A.now()); });
      undoToast(pid ? '‘' + t.title + '’를 ‘' + name + '’ 프로젝트로 옮겼어요.' : '‘' + t.title + '’를 프로젝트에서 뺐어요.');
    }
    var items = [{ label: '프로젝트 없음', checked: !t.projectId, onClick: function () { set(null); } }];
    M.liveProjects(S.state).forEach(function (p) {
      items.push({ label: p.name, checked: t.projectId === p.id, icon: h('span.proj-dot', { style: { background: p.color } }), onClick: function () { set(p.id, p.name); } });
    });
    items.push({ sep: true });
    items.push({ label: '새 프로젝트…', icon: 'plus', keepOpen: true, onClick: function (pop) {
      var inp = h('input.input', { placeholder: '프로젝트 이름', 'aria-label': '새 프로젝트 이름' });
      pop.setContent(h('form.due-editor', { onsubmit: function (e) {
        e.preventDefault();
        var name = inp.value.trim();
        if (!name) { inp.focus(); return; }
        var created = null;
        S.mutate('새 프로젝트', function (s) { created = M.addProject(s, { name: name.slice(0, 60) }, A.now()); M.updateTask(s, taskId, { projectId: created.id }, A.now()); });
        pop.close(true);
        undoToast('‘' + name + '’ 프로젝트를 만들고 ‘' + t.title + '’를 넣었어요.');
      } }, h('div.menu-label', '새 프로젝트'), inp, h('div.due-actions', h('button.btn.btn-xs.btn-primary', { type: 'submit' }, '만들고 넣기'))), 'dialog');
    } });
    return menu(anchor, items, { label: '프로젝트' });
  }

  // ------------------------------------------------------------------ 메모 분류 — 메모를 끌면 프로젝트 폴더·휴지통이 뜬다
  //   폴더에 놓으면 그 프로젝트로 (메모에서 만든 할 일·일정도 함께), 휴지통에 놓으면 메모를 지운다 (Ctrl+Z 로 되돌리기)
  //   메모 요소에 data-note-id 만 있으면 어디서 끌어도 된다 (오늘 메모 · 보관함)
  var NOTE_T = 'application/x-daynote-note';
  var dock = null;
  function hideDock() { if (dock) { dock.remove(); dock = null; } document.documentElement.classList.remove('is-note-dragging'); }
  function showDock(noteId) {
    var S = window.Daynote.store, A = window.Daynote.app;
    var n = M.byId(S.state.notes, noteId);
    if (!n) return;
    hideDock();
    function tile(cls, label, iconEl, act, extra) {
      var el = h('div.dock-tile' + cls, Object.assign({ 'data-act': act }, extra || {}), h('div.dock-icon', iconEl), h('div.dock-name', label));
      el.addEventListener('dragenter', function (e) { e.preventDefault(); el.classList.add('is-over'); });
      el.addEventListener('dragover', function (e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('is-over'); });
      el.addEventListener('dragleave', function (e) { if (!el.contains(e.relatedTarget)) el.classList.remove('is-over'); });
      el.addEventListener('drop', function (e) {
        e.preventDefault(); e.stopPropagation();
        var id = e.dataTransfer.getData(NOTE_T) || noteId;
        hideDock();
        act(id);
      });
      return el;
    }
    function folder(color) {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 48 40'); svg.setAttribute('aria-hidden', 'true');
      svg.innerHTML = '<path d="M2 8a4 4 0 0 1 4-4h12l4 4h20a4 4 0 0 1 4 4v22a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4z" fill="' + color + '" opacity=".35"/>' +
        '<path d="M2 14a4 4 0 0 1 4-4h36a4 4 0 0 1 4 4v20a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4z" fill="' + color + '"/>';
      return svg;
    }
    function moveTo(pid, name) {
      return function (id) {
        var note = M.byId(S.state.notes, id);
        if (!note) return;
        if ((note.projectId || null) === (pid || null)) { toast(pid ? '이미 ‘' + name + '’에 있어요.' : '이미 프로젝트 밖에 있어요.'); return; }
        window.Daynote.capture.setProject(id, pid);
        undoToast('‘' + M.noteTitle(note) + '’를 ' + (pid ? '‘' + name + '’ 프로젝트로 옮겼어요.' : '프로젝트에서 뺐어요.'));
      };
    }
    var projects = M.liveProjects(S.state).filter(function (p) { return !p.archivedAt; });
    var tiles = projects.map(function (p) {
      return tile(n.projectId === p.id ? '.is-current' : '', p.name, folder(p.color), moveTo(p.id, p.name), { title: n.projectId === p.id ? '지금 이 프로젝트에 있어요' : '‘' + p.name + '’에 넣기' });
    });
    if (n.projectId) tiles.unshift(tile('.is-none', '프로젝트 없음', folder('#8892A8'), moveTo(null)));
    tiles.push(tile('.is-new', '새 프로젝트', h('span.dock-plus', icon('plus')), function (id) {
      var inp = h('input.input', { placeholder: '프로젝트 이름', 'aria-label': '새 프로젝트 이름', autofocus: true });
      var m = modal({ title: '새 프로젝트에 넣기', body: inp, actions: [
        { label: '취소' },
        { label: '만들고 넣기', primary: true, onClick: function () {
          var name = inp.value.trim();
          if (!name) { inp.focus(); return false; }
          S.mutate('새 프로젝트에 넣기', function (s) { var created = M.addProject(s, { name: name.slice(0, 60) }, A.now()); window.Daynote.aiProposals.captureSetProject(s, id, created.id); });
          undoToast('‘' + name + '’ 프로젝트를 만들고 메모를 넣었어요.');
        } }] });
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); m.foot.querySelector('.btn-primary').click(); } });
    }));
    tiles.push(tile('.is-trash', '휴지통', h('span.dock-trash', icon('trash')), function (id) {
      var note = M.byId(S.state.notes, id);
      if (!note) return;
      S.mutate('메모 지우기', function (s) { M.deleteNote(s, id, A.now()); });
      undoToast('‘' + M.noteTitle(note) + '’ 메모를 휴지통에 버렸어요.');
    }, { title: '메모 지우기 (Ctrl+Z 로 되돌리기)' }));
    dock = h('div.note-dock', { role: 'region', 'aria-label': '메모 분류 — 폴더나 휴지통에 놓으세요' },
      h('div.dock-hint', '프로젝트 폴더에 놓으면 옮기고, 휴지통에 놓으면 지워요'),
      h('div.dock-row', tiles));
    document.body.appendChild(dock);
    watchDock();
    document.documentElement.classList.add('is-note-dragging');
  }
  // 할 일을 끌면 아래에 휴지통이 퉁 하고 뜬다 — 놓으면 지운다 (앞으로 잡힌 작업 시간도 함께, Ctrl+Z 로 되돌리기)
  function showTaskTrash(taskId) {
    var S = window.Daynote.store, A = window.Daynote.app;
    if (!M.byId(S.state.tasks, taskId)) return;
    hideDock();
    var bin = h('div.dock-tile.is-trash', { title: '할 일 지우기 (Ctrl+Z 로 되돌리기)' }, h('div.dock-icon', h('span.dock-trash', icon('trash'))), h('div.dock-name', '휴지통'));
    bin.addEventListener('dragenter', function (e) { e.preventDefault(); bin.classList.add('is-over'); });
    bin.addEventListener('dragover', function (e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; bin.classList.add('is-over'); });
    bin.addEventListener('dragleave', function (e) { if (!bin.contains(e.relatedTarget)) bin.classList.remove('is-over'); });
    bin.addEventListener('drop', function (e) {
      e.preventDefault(); e.stopPropagation();
      var id = e.dataTransfer.getData('application/x-daynote-task') || taskId;
      hideDock();
      var t = M.byId(S.state.tasks, id);
      if (!t) return;
      S.mutate('삭제', function (s) { M.deleteTask(s, id, A.now()); });
      undoToast('‘' + t.title + '’를 휴지통에 버렸어요. 앞으로 잡힌 작업 시간도 함께 지웠어요.');
    });
    dock = h('div.note-dock.is-trash-only', { role: 'region', 'aria-label': '할 일 지우기 — 휴지통에 놓으세요' }, bin);
    document.body.appendChild(dock);
    watchDock();
  }
  document.addEventListener('dragstart', function (e) {
    var tEl = e.target && e.target.closest && e.target.closest('[data-task-id]');
    if (tEl && e.dataTransfer && !(e.target.closest('[data-note-id]'))) {
      var tid = tEl.getAttribute('data-task-id');
      try { if (Array.prototype.indexOf.call(e.dataTransfer.types || [], 'application/x-daynote-task') === -1) e.dataTransfer.setData('application/x-daynote-task', tid); } catch (err) {}
      setTimeout(function () { showTaskTrash(tid); }, 0);
      return;
    }
    var el = e.target && e.target.closest && e.target.closest('[data-note-id]');
    if (!el || !e.dataTransfer) return;
    var id = el.getAttribute('data-note-id');
    try { if (Array.prototype.indexOf.call(e.dataTransfer.types || [], NOTE_T) === -1) e.dataTransfer.setData(NOTE_T, id); } catch (err) {}
    setTimeout(function () { showDock(id); }, 0);   // 끌기 시작한 그 순간에 화면을 바꾸면 끌기가 취소된다
  });
  // 끌기가 끝나면 닫는다. 놓은 곳이 다시 그려지면 끌던 요소가 사라져 dragend 가 문서까지 오지 않고,
  //   놓는 곳이 drop 을 멈추기도 한다 — 그래서 drop 은 캡처 단계에서 먼저 받고, 그래도 남으면 다음 마우스 움직임에 닫는다
  document.addEventListener('dragend', function () { setTimeout(hideDock, 0); }, true);
  document.addEventListener('drop', function () { setTimeout(hideDock, 0); }, true);
  // 끌기가 끝났는데 drop·dragend 가 오지 않은 경우(창 밖에 놓기 등) — 독이 떠 있을 때만 다음 마우스 움직임에 닫는다
  var dockShownAt = 0;
  function onDockMove() { if (!dock) { document.removeEventListener('mousemove', onDockMove, true); return; } if (Date.now() - dockShownAt > 300) hideDock(); }
  function watchDock() { dockShownAt = Date.now(); document.removeEventListener('mousemove', onDockMove, true); document.addEventListener('mousemove', onDockMove, true); }

  // 마감 지난 할 일을 지금 + 24시간으로 (Ctrl+Z 로 되돌릴 수 있다)
  function postponeOverdue(taskId) {
    var S = window.Daynote.store, now = window.Daynote.app.now();
    var t = S.mutate('마감 미루기', function (s) { return M.postponeTask(s, taskId, now); });
    if (t) undoToast('‘' + t.title + '’ 마감을 ' + D.relDay(t.dueDate, now) + ' ' + t.dueTime + '까지로 미뤘어요.');
    return t;
  }

  // 앱 밖 알림 — 사용자가 Daynote 를 보고 있지 않을 때만 (보고 있으면 화면 안 카드로 충분하다)
  function osNotify(title, body, opts) {
    opts = opts || {};
    if (!opts.always && document.hasFocus()) return false;
    var host = window.Daynote.store.host;
    if (host && host.notify) { try { host.notify(title, body, !!opts.sound); } catch (e) {} return true; }
    return false;
  }

  // 날짜 네 가지는 어느 화면에서나 같은 말·같은 아이콘으로 (UX 점검 C-01)
  //   마감(언제까지) = 깃발 · 할 날(이날 하기) = 달력 · 작업 시간(몇 시에) = 시계 · 일정 = 캘린더 카드
  // 할 날 칩 — 누르면 날짜 창(할 날 탭)
  function planChip(task, now) {
    if (!task.planDate || task.status === 'done') return null;
    now = now || window.Daynote.app.now();
    var el = h('span.chip.chip-plan.is-editable', { role: 'button', tabindex: '0', title: '할 날 — 이날 하기로 한 일 (눌러서 바꾸기)' }, icon('calendar'), D.relDay(task.planDate, now) + '에 하기');
    el.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); dueEditor(el, task.id); });
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); dueEditor(el, task.id); } });
    el.addEventListener('dragstart', function (e) { e.preventDefault(); e.stopPropagation(); });
    return el;
  }

  // 실제 작업 시간 — 마감일과 다른 정보임을 아이콘과 문구로 구분한다. 없으면 칩을 두지 않는다 ('없음' 칩은 잡음 — C-04)
  function scheduleChip(state, task, now) {
    if (task.status === 'done') return null;
    var b = M.nextBlockForTask(state, task.id, now);
    if (b) return h('span.chip.chip-sched', icon('clock'), '작업 ' + D.relDay(D.ymd(b.start), now) + ' ' + D.hm(b.start));
    return null;
  }

  function estimateChip(task) {
    if (task.status === 'done') return null;
    if (task.estimateMinutes == null) return null;
    if (task.estimateSource === 'ai') return h('span.chip.chip-guess', { title: 'AI 추정값 — 눌러서 확인·수정' }, '약 ' + D.duration(task.estimateMinutes) + ' (추정)');
    return h('span.chip', icon('clock'), D.duration(task.estimateMinutes));
  }

  function statusChips(state, task, now) {
    var out = [];
    if (task.status === 'in_progress') out.push(h('span.chip.chip-progress', '진행 중'));
    if (task.status === 'paused') out.push(h('span.chip.chip-paused', '일시 정지'));
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
      dueChip(task, now, { add: !task.planDate }),
      planChip(task, now),
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
    var main = h('div.task-main', title, chips);
    var li = h('li.task-row' + (done ? '.is-done' : '') + (opts.selected ? '.is-selected' : ''), {
      tabindex: '0', 'data-task-id': task.id,
      'aria-label': task.title + (done ? ', 완료됨' : '') + ' — 누르면 세부 할 일',
      onclick: function () { toggle(); },
      oncontextmenu: function (e) { e.preventDefault(); A.taskMenu(task.id, li); },
      onkeydown: function (e) {
        if (e.target !== li) return;
        if (e.key === 'Enter') { e.preventDefault(); toggle(); }
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
    }, check, main, actions);
    var toggle = stepsToggle(li, task, main);

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

  // ------------------------------------------------------------------ 세부 할 일 (할 일을 누르면 펼쳐진다)
  // 할 일 행을 누르면 상세 화면 대신 그 자리에서 세부 할 일(작게 나눈 단계)이 펼쳐진다. 체크·추가 가능.
  // 펼친 상태는 다시 그려도(체크 → 저장 → 다시 그림) 유지된다. 상세 편집은 오른쪽 클릭 메뉴의 '자세히 편집'.
  var expanded = {};
  var refocusAdd = null;
  var addingUnder = {};   // taskId → 하위 단계를 적는 중인 단계 id
  function setTaskSteps(taskId, fn, label) {
    var S = window.Daynote.store, A = window.Daynote.app;
    S.mutate(label, function (s) {
      var t = M.byId(s.tasks, taskId);
      if (t) M.updateTask(s, t.id, { steps: fn(t.steps || []) }, A.now());
    });
  }
  // 세부 할 일 나무 — opts.editable 이면 단계마다 [+ 하위] [×]. 체크하면 아래 단계도, 아래를 다 끝내면 위 단계도 끝
  function stepTree(task, opts) {
    opts = opts || {};
    var ST = window.Daynote.steps;
    var stop = function (e) { e.stopPropagation(); };
    var done = task.status === 'done';
    function rows(list, depth) {
      return h('ul.step-tree' + (depth ? '.is-sub' : ''), list.map(function (x) {
        var subs = x.steps || [];
        var adding = opts.editable && addingUnder[task.id] === x.id;
        var subInput = adding ? h('input.input.task-step-add.step-sub-add', {
          placeholder: '‘' + x.title + '’ 아래에 추가 (Enter · Esc)', 'aria-label': '‘' + x.title + '’ 하위 단계 추가', onclick: stop,
          onkeydown: function (e) {
            e.stopPropagation();
            if (e.key === 'Escape') { delete addingUnder[task.id]; setTaskSteps(task.id, function (l) { return l; }, null); return; }
            if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            var v = e.currentTarget.value.trim();
            if (!v) return;
            setTaskSteps(task.id, function (l) { return ST.add(l, x.id, v); }, '하위 단계 추가');
          } }) : null;
        return h('li' + (x.done ? '.is-done' : '') + (subs.length ? '.has-sub' : ''),
          h('div.step-row',
            h('label',
              h('input', { type: 'checkbox', checked: !!x.done, onchange: function () { setTaskSteps(task.id, function (l) { return ST.toggle(l, x.id); }, opts.label || '세부 할 일 체크'); } }),
              h('span.task-step-title', x.title),
              x.estimateMinutes ? h('span.meta', x.estimateMinutes + '분') : null,
              subs.length ? h('span.meta.step-sub-count', ST.count(subs).done + '/' + ST.count(subs).total) : null),
            opts.editable && !done ? h('span.step-tools',
              h('button.step-tool', { type: 'button', title: '아래에 하위 단계 추가', 'aria-label': '‘' + x.title + '’ 아래에 하위 단계 추가', onclick: function (e) {
                e.stopPropagation(); addingUnder[task.id] = x.id; setTaskSteps(task.id, function (l) { return l; }, null);
              } }, '+ 하위'),
              h('button.step-tool', { type: 'button', title: '이 단계 빼기', 'aria-label': '‘' + x.title + '’ 빼기', onclick: function (e) {
                e.stopPropagation(); setTaskSteps(task.id, function (l) { return ST.remove(l, x.id); }, '세부 할 일 빼기');
              } }, icon('x'))) : null),
          subs.length ? rows(subs, depth + 1) : null,
          subInput);
      }));
    }
    var tree = rows(task.steps || [], 0);
    if (opts.editable && addingUnder[task.id]) setTimeout(function () { var x = tree.querySelector('.step-sub-add'); if (x) x.focus(); }, 0);
    return tree;
  }
  function stepsPanel(task) {
    var A = window.Daynote.app, ST = window.Daynote.steps;
    var steps = task.steps || [];
    var stop = function (e) { e.stopPropagation(); };
    function setSteps(fn, label) { setTaskSteps(task.id, function (l) { return fn(l.slice()); }, label); }
    var add = h('input.input.task-step-add', {
      placeholder: '+ 세부 할 일 추가 (Enter)', 'aria-label': '‘' + task.title + '’ 세부 할 일 추가',
      onclick: stop,
      onkeydown: function (e) {
        e.stopPropagation();
        if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        var v = add.value.trim();
        if (!v) return;
        refocusAdd = task.id;
        setSteps(function (list) { return list.concat({ id: M.uid('step'), title: v.slice(0, 120), done: false, estimateMinutes: null }); }, '세부 할 일 추가');
      }
    });
    var cnt = ST.count(steps);
    var panel = h('div.task-steps', { onclick: stop, onkeydown: stop },
      steps.length ? h('div.task-steps-head.meta', '세부 할 일 ' + cnt.done + '/' + cnt.total) : null,
      steps.length ? stepTree(task, { editable: true }) : h('div.task-steps-empty',
        h('span.meta', '세부 할 일이 아직 없어요.'),
        task.status === 'done' ? null : h('button.btn.btn-xs', { type: 'button', onclick: function () {
          if (A.current().view !== 'today') A.go('today');
          window.Daynote.assistant.breakdown(task.id, null, { force: true });
        } }, icon('task'), '작업 작게 나누기')),
      task.status === 'done' ? null : add);
    if (refocusAdd === task.id) { refocusAdd = null; setTimeout(function () { var x = document.querySelector('[data-steps-for="' + task.id + '"] .task-step-add'); if (x) x.focus(); }, 0); }
    panel.setAttribute('data-steps-for', task.id);
    return panel;
  }
  // 행을 누르면 펼치기/접기 — mount 는 패널이 들어갈 곳(제목 아래)
  function stepsToggle(li, task, mount) {
    li.setAttribute('aria-expanded', expanded[task.id] ? 'true' : 'false');
    if (expanded[task.id]) mount.appendChild(stepsPanel(task));
    return function () {
      expanded[task.id] = !expanded[task.id];
      li.setAttribute('aria-expanded', expanded[task.id] ? 'true' : 'false');
      var old = mount.querySelector('.task-steps');
      if (old) old.remove();
      if (expanded[task.id]) mount.appendChild(stepsPanel(task));
    };
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

  // Alt 를 누르고 있는 동안만 '마감 지남' 칩이 눌러지는 모양으로 (Alt+클릭 = 24시간 미루기)
  function altState(e) { document.documentElement.classList.toggle('alt-down', !!e.altKey); }
  document.addEventListener('keydown', altState, true);
  document.addEventListener('keyup', altState, true);
  window.addEventListener('blur', function () { document.documentElement.classList.remove('alt-down'); });

  window.Daynote.ui = {
    h: h, icon: icon, toast: toast, undoToast: undoToast, modal: modal, confirm: confirmDialog, menu: menu, closeMenu: closeMenu, popover: popover,
    kindChip: kindChip, KIND_LABEL: KIND_LABEL, KIND_ICON: KIND_ICON, josa: josa,
    stepsPanel: stepsPanel, stepsToggle: stepsToggle, stepTree: stepTree, dueEditor: dueEditor, projectPicker: projectPicker, projectPickChip: projectPickChip,
    projectChip: projectChip, dueChip: dueChip, planChip: planChip, osNotify: osNotify, postponeOverdue: postponeOverdue, scheduleChip: scheduleChip, estimateChip: estimateChip,
    statusChips: statusChips, sourceChip: sourceChip, taskRow: taskRow, projectOptions: projectOptions, highlight: highlight
  };
})();
