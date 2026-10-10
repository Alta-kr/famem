'use strict';

// 홈 흐름(Stream) 패널 — 적은 글과 Daynote 의 정리 결과 카드 + 도우미 버튼 + 입력창.
// 카드(정리 결과·단계 나누기·추천·휴식)는 저장된 할 일·메모의 현재 상태로 그린다.
// 적는 순간에는 아무것도 묻지 않는다 — 종류·날짜·프로젝트는 결과 카드의 칩으로 나중에 고친다.

(function () {
  var DN = window.Daynote;
  var M = DN.model, D = DN.dates, S = DN.store, ui = DN.ui, h = ui.h;
  var SHOW = 60;
  var timerTick = null;
  var EXAMPLES = ['내일까지 견적서 보내기', '다음 주 화요일 3시 치과', '온보딩에 퀴즈 넣으면 어떨까'];

  function render(root) {
    var A = DN.app, AS = DN.assistant;
    var st = S.state;
    root.textContent = '';

    var ta = h('textarea', { rows: 1, placeholder: '생각나는 걸 적고 Enter — Daynote가 알아서 나눠요', 'aria-label': '적어 두기 (Enter 보내기 · Shift+Enter 줄바꿈)', 'data-slash': '' });
    ta.value = st.quickDraft.text || '';

    // ---------------------------------------------------------------- 메시지 (입력창과 따로 다시 그린다)
    var list = h('div.chat-list', { role: 'log', 'aria-live': 'polite', 'aria-label': '적은 것과 정리 결과' });
    function paintList() {
      var st = S.state, now = A.now();
      var nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      list.textContent = '';
      var msgs = (st.chat || []).slice(-SHOW);
      list.classList.toggle('is-empty', !msgs.length);
      if (!msgs.length) list.appendChild(onboarding());
      var lastDay = null;
      msgs.forEach(function (m) {
        var day = D.ymd(m.at);
        if (day !== lastDay) { list.appendChild(h('div.chat-day', D.relDay(day, now))); lastDay = day; }
        var node = message(m, st, now);
        if (node) list.appendChild(node);
      });
      if (nearBottom) list.scrollTop = list.scrollHeight;
      startTimers();
    }

    // 첫 화면 — 무엇을 하는 앱인지 30초 안에 보이게. 예시는 입력창에 채우기만 한다 (보내지 않음)
    function onboarding() {
      var key = AS.quickKey && AS.quickKey();
      return h('div.chat-empty',
        h('div.chat-empty-mark', { 'aria-hidden': 'true' }, ui.icon('edit')),
        h('h3.chat-empty-title', '생각나는 걸 그냥 적어 보세요'),
        h('p.chat-empty-sub', '할 일인지, 일정인지, 메모인지는 Daynote가 알아서 나눠요.'),
        h('div.chat-examples', { role: 'group', 'aria-label': '예시 (누르면 입력창에 채워져요)' }, EXAMPLES.map(function (ex) {
          return h('button.chat-example', { type: 'button', onclick: function () { fill(ex); } }, ex);
        })),
        key ? h('p.chat-empty-hint', '어디서든 ', h('kbd', String(key).replace(/CommandOrControl|CmdOrCtrl/, 'Ctrl')), '로 바로 적을 수 있어요') : null);
    }
    function fill(text) {
      ta.value = text;
      grow(); keep();
      ta.focus();
      try { ta.setSelectionRange(text.length, text.length); } catch (e) {}
    }
    paintList();

    // ---------------------------------------------------------------- 도우미 버튼 + 입력
    var nextTool = h('button.chat-tool', { type: 'button', onclick: function () { AS.next(); } }, ui.icon('spark'), '다음 할 일');
    var tools = h('div.chat-tools', { role: 'group', 'aria-label': '도우미' },
      nextTool,
      h('button.chat-tool', { type: 'button', onclick: function () { AS.breakdown(); } }, ui.icon('task'), '작게 나누기'),
      h('button.chat-tool', { type: 'button', onclick: function () { AS.rest(); } }, ui.icon('clock'), '휴식'));

    // 할 일 추천 패널 자리 (recpanel.js) — CTA 나 패널이 보이면 '다음 할 일' 도구는 숨긴다
    var recHost = h('div.rec-host');

    var t;
    var note = null;   // '/할일' 만 적었을 때의 안내 줄
    function grow() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; }
    function keep() {
      clearTimeout(t);
      t = setTimeout(function () { S.mutate(null, function (s) { s.quickDraft = { text: ta.value, projectId: null }; }, { source: 'today' }); }, 300);
    }
    function clearNote() { if (note) { note.remove(); note = null; } }
    function sendNow() {
      var v = ta.value;
      if (!v.trim()) return;
      // 명령어만 있고 본문이 없으면 보내지 않고 글도 지우지 않는다
      var p = DN.commands && DN.commands.parse ? DN.commands.parse(v) : null;
      if (p && p.kind && !p.args) {
        clearNote();
        note = h('div.chat-input-note', { role: 'status' }, '‘' + p.token + '’ 뒤에 적을 내용을 써 주세요.');
        ta.parentNode.insertBefore(note, ta.nextSibling);
        return;
      }
      clearNote();
      clearTimeout(t);
      S.mutate(null, function (s) { s.quickDraft = { text: '', projectId: null }; }, { source: 'today', silent: true });
      ta.value = ''; grow();
      AS.send(v, null);
      setTimeout(function () { var x = document.querySelector('.chat-input textarea'); if (x) x.focus(); }, 0);
    }
    // AI 연결 상태는 화면이 뜬 뒤에 알게 되므로 바뀌면 표시만 바꾼다
    var badge = h('span.chat-badge', aiBadge());
    var offAi = DN.aiFlow.onChange(function () { badge.textContent = ''; badge.appendChild(aiBadge()); });
    var inputBox = h('div.chat-input', ta, h('div.chat-input-foot', badge,
      h('span.chat-input-hint', 'Enter 보내기 · Shift+Enter 줄바꿈 · / 명령어'),
      h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: sendNow, 'aria-label': '보내기' }, '보내기')));

    // 명령어 자동완성은 Enter 리스너보다 먼저 붙인다 (같은 요소의 리스너는 붙인 순서대로 불린다)
    var slash = DN.slash && DN.slash.attach ? DN.slash.attach(ta, {
      mount: inputBox, placement: 'above', idPrefix: 'slash',
      iconFor: function (n) { return ui.icon(n); },
      onExecute: function (text) { clearNote(); ta.value = ''; grow(); AS.send(text, null); }
    }) : null;
    ta.addEventListener('input', function () { clearNote(); grow(); keep(); });
    ta.addEventListener('keydown', function (e) {
      // 한글 조합 중 Enter 는 글자 확정이므로 보내지 않는다
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); sendNow(); }
    });

    root.appendChild(h('section.chat', { 'aria-label': '적어 두기' },
      h('div.chat-head', h('h2.panel-title', '적어 두기'), h('span.meta', '할 일·일정·메모는 Daynote가 나눠요')),
      list, recHost, tools, inputBox));
    var rec = DN.views.recPanel && DN.views.recPanel.mount
      ? DN.views.recPanel.mount(recHost, { onCtaVisible: function (v) { nextTool.hidden = !!v; } }) : null;
    setTimeout(function () {
      list.scrollTop = list.scrollHeight; grow();
      // 창이 뜨면 커서가 이미 입력창에 있게 — 다른 곳을 보고 있으면 건드리지 않는다
      var a = document.activeElement;
      if (!a || a === document.body || a.id === 'view') ta.focus();
    }, 0);
    return {
      refresh: function () { paintList(); if (rec && rec.paint) rec.paint(); },
      focus: function () { ta.focus(); },
      destroy: function () { offAi(); if (slash && slash.destroy) slash.destroy(); if (rec && rec.destroy) rec.destroy(); },
      tick: function () { if (rec && rec.paint) rec.paint(); }
    };
  }

  // 휴식 타이머 표시
  function startTimers() {
    clearInterval(timerTick);
    timerTick = setInterval(function () {
      var els = document.querySelectorAll('[data-timer-end]');
      if (!els.length) { clearInterval(timerTick); return; }
      Array.prototype.forEach.call(els, function (el) {
        var left = Math.max(0, Math.round((new Date(el.getAttribute('data-timer-end')) - Date.now()) / 1000));
        el.textContent = Math.floor(left / 60) + ':' + D.pad(left % 60);
      });
    }, 1000);
  }

  function aiBadge() {
    var s = DN.aiFlow.status();
    if (s.provider === 'fake') return h('span.chip.chip-guess', { title: '실제 AI가 아니라 규칙으로 나누는 데모입니다' }, '데모 모드');
    if (!s.configured) return h('span.chip', { title: s.reason || '' }, 'AI 미연결 · 메모로만 저장');
    return h('span.chip', { title: s.notice || '' }, s.provider === 'gemini' ? 'Gemini 3.8 Flash' : 'Claude Opus 5.5');
  }

  function bubble(role, content, extraClass) {
    return h('div.msg.msg-' + role + (extraClass ? '.' + extraClass : ''), h('div.msg-body', content));
  }

  // ------------------------------------------------------------------ 메시지 종류별
  function message(m, st, now) {
    var A = DN.app, AS = DN.assistant;
    if (m.role === 'user') return userBubble(m.text);
    if (m.kind === 'text') {
      return bubble('assistant', h('div', h('div.msg-text', m.text),
        (m.actions || []).length ? h('div.msg-actions', m.actions.map(function (a) {
          return a === 'next' ? h('button.btn.btn-xs', { type: 'button', onclick: function () { AS.next(); } }, '다음 할 일 추천받기')
            : a === 'rest' ? h('button.btn.btn-xs', { type: 'button', onclick: function () { AS.rest(); } }, '휴식하기')
            : a === 'showHidden' ? h('button.btn.btn-xs', { type: 'button', onclick: function () {
              if (DN.views.today && DN.views.today.showHidden) DN.views.today.showHidden();
            } }, '접어 둔 일 보기') : null;
        })) : null));
    }
    if (m.kind === 'thinking') return bubble('assistant', h('div.msg-text', h('span.spinner', { 'aria-hidden': 'true' }), ' ', m.text));
    if (m.kind === 'capture') return captureCard(m, st, now);
    if (m.kind === 'breakdown') return breakdownCard(m, st, now);
    if (m.kind === 'next') return nextCard(m, st, now);
    if (m.kind === 'elaborate') return elaborateCard(m, st, now);
    if (m.kind === 'rest') return restCard(m, st, now);
    if (m.kind === 'help') return helpCard();
    if (/^status/.test(m.kind || '')) return DN.status && DN.status.card ? DN.status.card(m, st, now) : null;
    return null;
  }

  // 내 말풍선 — 명령어로 시작하면 토큰을 칩으로 (그릴 때만 해석하고, 저장은 원문 그대로)
  function userBubble(text) {
    var CMD = DN.commands;
    var p = CMD && CMD.parse ? CMD.parse(text) : null;
    if (p && p.command && p.token) {
      return bubble('user', h('div.msg-text', h('span.chip.msg-cmd', p.token), p.args ? ' ' + p.args : null));
    }
    return bubble('user', h('div.msg-text', text));
  }

  // 입력창에 글을 채우고 (명령어 목록이 따라오도록) input 이벤트를 보낸다
  function fillInput(text) {
    var x = document.querySelector('.chat-input textarea');
    if (!x) return;
    x.value = text;
    x.dispatchEvent(new Event('input', { bubbles: true }));
    x.focus();
    try { x.setSelectionRange(text.length, text.length); } catch (e) {}
  }

  // /도움말 카드 — 명령어 표 순서대로 7줄
  function helpCard() {
    var CMD = DN.commands;
    var cmds = CMD && CMD.COMMANDS ? CMD.COMMANDS : [];
    return bubble('assistant', h('div.help-card',
      h('div.help-card-title', '명령어'),
      h('ul', cmds.map(function (c) {
        var tok = '/' + c.ko[0];
        var alt = ['/' + c.name].concat(c.short.map(function (x) { return '/' + x; })).join(' · ');
        return h('li',
          h('button.chip.help-cmd', { type: 'button', title: '입력창에 ‘' + tok + '’ 넣기', onclick: function () { fillInput(tok + ' '); } }, tok),
          h('span.meta', alt),
          h('div', c.desc),
          h('div.meta', '예) ' + c.example));
      })),
      h('div.meta', '명령어 없이 적으면 Daynote가 알아서 나눠요 · 명령어로 정한 종류도 결과 카드에서 바꿀 수 있어요 · ‘/’를 글자로 쓰려면 //로 시작하세요')), 'msg-help');
  }

  // ------------------------------------------------------------------ 정리 결과 카드
  // 머리말 한 문장 + 정리한 것 한 줄씩: [종류 칩] 제목 [날짜 칩] [프로젝트 칩] [맥락 칩] [×]
  // 칩을 누르면 바로 고친다 (모두 Ctrl+Z 로 되돌릴 수 있다). 원문 메모는 빼도 지워지지 않는다.
  var KINDS = ['task', 'event', 'memo', 'idea', 'link'];
  var NOTE_KIND = { memo: 1, idea: 1, link: 1 };
  var REFINED_LABEL = { title: '제목', dueDate: '날짜', date: '날짜', dueTime: '시각', time: '시각', at: '시각', durationMinutes: '길이', location: '장소', projectId: '프로젝트' };

  function undoHint() { return h('span', h('kbd', 'Ctrl+Z'), '로 되돌리기'); }
  function dot() { return h('span', { 'aria-hidden': 'true' }, ' · '); }
  function foot() {   // span 사이에 ' · ' 를 넣는다 (null 은 건너뜀)
    var parts = Array.prototype.slice.call(arguments).filter(Boolean), out = [];
    parts.forEach(function (p, i) { if (i) out.push(dot()); out.push(p); });
    return h('div.cap-foot.meta', out);
  }

  // 명령어로 정한 글 — 항목이 처음부터 있으므로 스켈레톤 없이 그린다 (FEATURES §6.8)
  function commandCard(n, c, items, now) {
    var CP = DN.capture;
    var running = CP.isRunning(n.id);
    var memoLike = !!NOTE_KIND[c.command.kind];
    var head = h('div.cap-head', h('span', summary(items, now)), h('span.cap-head-sub', ' · 명령어로 지정'));
    var retry = h('button.btn.btn-xs', { type: 'button', onclick: function () { CP.classify(n.id); } }, ui.icon('refresh'), '다시 다듬기');
    var ft;
    if (running) {
      ft = h('div.cap-foot.meta', h('span.spinner', { 'aria-hidden': 'true' }), h('span', ' AI가 제목·날짜를 다듬는 중…'));
    } else if (c.status === 'pending') {
      ft = foot(h('span', '다듬기가 멈췄어요'), retry);
    } else if (c.status === 'no_ai') {
      ft = foot(h('span', memoLike ? '명령어로 지정' : '명령어로 지정 · AI 없이 날짜만 찾았어요'));
    } else if (c.status === 'failed') {
      ft = foot(h('span', '명령어로 지정 · AI로 다듬지 못했어요'), retry);
    } else {
      var labels = [];
      (c.command.refined || []).forEach(function (k) {
        var l = REFINED_LABEL[k] || (DN.aiForced && DN.aiForced.REFINED_LABEL && DN.aiForced.REFINED_LABEL[k]);
        if (l && labels.indexOf(l) === -1) labels.push(l);
      });
      labels = labels.slice(0, 3);
      var what = labels.join('·');
      ft = foot(h('span', '명령어로 지정'), labels.length ? h('span', 'AI가 ' + ui.josa(what, '를/을') + ' 다듬음') : null, undoHint());
    }
    return { head: head, foot: ft };
  }

  function captureCard(m, st, now) {
    var CP = DN.capture;
    var n = M.byId(st.notes, m.noteId);
    if (!n) return null;
    var c = n.capture || {};
    if (n.deletedAt) return bubble('assistant', h('div.cap', h('div.cap-head.meta', '이 글은 메모에서 지웠어요.')), 'msg-cap');

    var learned = c.learned || [];
    var head, ft, items;
    if (c.command && !c.changedByUser) {
      items = CP.items(n);
      var cc = commandCard(n, c, items, now);
      head = cc.head; ft = cc.foot;
    } else {
      if (!c.command && (CP.isRunning(n.id) || c.status === 'pending')) {
        return bubble('assistant', h('div.cap.is-pending', { 'aria-busy': 'true' },
          h('div.cap-skel',
            h('span.cap-skel-chip', { 'aria-hidden': 'true' }),
            h('span.cap-skel-text', h('span.spinner', { 'aria-hidden': 'true' }), '정리하는 중…'),
            h('span.cap-skel-bar', { 'aria-hidden': 'true' }))), 'msg-cap');
      }
      items = CP.items(n);
      var settingsBtn = h('button.btn.btn-xs', { type: 'button', onclick: function () { DN.app.go('settings'); } }, ui.icon('settings'), '설정 열기');
      if (c.status === 'no_ai' && learned.length) {
        head = h('div.cap-head', h('span', summary(items, now)), h('span.cap-head-sub', ' · AI 없이 배운 대로'));
        ft = h('div.cap-foot', settingsBtn, whyBtn(n));
      } else if (c.status === 'no_ai') {
        head = h('div.cap-head', h('span', '메모로 저장했어요'), h('span.cap-head-sub', ' · AI를 연결하면 자동으로 나눠 드려요'));
        ft = h('div.cap-foot', settingsBtn);
      } else if (c.status === 'failed') {
        head = h('div.cap-head', h('span', '메모로 남겨 뒀어요'), c.error && c.error.message ? h('span.cap-head-sub', ' · ' + c.error.message) : null);
        ft = h('div.cap-foot', h('button.btn.btn-xs', { type: 'button', onclick: function () { CP.classify(n.id); } }, ui.icon('refresh'), '다시 시도'));
      } else {
        var skipped = (c.skipped || []).length;
        head = h('div.cap-head', h('span', summary(items, now)),
          skipped ? h('span.cap-head-sub', ' · 비슷한 할 일이 이미 있어서 ' + skipped + '개는 만들지 않았어요') : null);
        var AD = DN.adapt;
        if (learned.length && !c.changedByUser) {
          ft = foot(h('span', 'AI가 정리함'), h('span', '배운 대로 ' + learned.length + '곳 고침'), whyBtn(n), undoHint());
        } else if (c.changedByUser && c.taught && AD && AD.enabled && AD.enabled(S.state)) {
          ft = foot(h('span', '직접 고침'), h('span', '다음 정리에 참고해요'),
            h('button.link-btn', { type: 'button', onclick: function () { DN.app.go('settings', { section: 'learn' }); } }, '배운 것 보기'));
        } else {
          ft = foot(h('span', c.changedByUser ? '직접 고침' : 'AI가 정리함'), undoHint());
        }
      }
    }
    var rows = h('div.cap-rows', { role: 'list' }, items.map(function (it, i) { return capRow(n, it, i, items, st, now); }));
    var hint = DN.status && DN.status.hintChip ? DN.status.hintChip(n) : null;
    return bubble('assistant', h('div.cap', head, rows, hint ? h('div.cap-hint', hint) : null, ft), 'msg-cap');
  }

  // ------------------------------------------------------------------ [왜?] — 배운 대로 고친 까닭 (ADAPT §7.7.1)
  function whyBtn(n) {
    return h('button.link-btn.cap-why', {
      type: 'button', 'aria-haspopup': 'dialog', 'data-focus-key': 'cap:' + n.id + ':why',
      onclick: function (e) { learnWhy(e.currentTarget, n.id); }
    }, '왜?');
  }
  function fmtDate(ymd) {
    var d = D.parseYmd(ymd);
    return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 (' + D.WEEKDAYS[d.getDay()] + ')';
  }
  function josaTail(word, pair) { return ui.josa(word, pair).slice(word.length); }
  function learnWhy(anchor, noteId) {
    var AD = DN.adapt;
    var n = M.byId(S.state.notes, noteId);
    if (!n || !n.capture) return;
    var pop = null;
    var rows = (n.capture.learned || []).map(function (en) {
      var rules = (en.ruleIds || []).map(function (id) { return AD && AD.get ? AD.get(S.state, id) : null; }).filter(Boolean);
      var top = rules.slice().sort(function (a, b) { return (Number(b.n) || 0) - (Number(a.n) || 0); })[0] || null;
      var cnt = top ? Math.max(1, Number(top.n) || 1) : 0;
      var ph = String(en.phrase || (top && (top.label || top.key)) || '');
      var q = '‘' + ph + '’';
      var line;
      if (en.type === 'kind') {
        var k = ui.KIND_LABEL[en.to] || en.to;
        line = q + josaTail(ph, '는/은') + ' 전에 ' + ui.josa(k, '로/으로') + ' ' + (cnt || 1) + '번 고쳐서 ' + ui.josa(k, '로/으로') + ' 뒀어요.';
      } else if (en.type === 'project') {
        var p = en.to && en.to !== 'none' ? M.byId(S.state.projects, en.to) : null;
        line = p ? q + josaTail(ph, '가/이') + ' 들어간 글은 전에 ‘' + p.name + '’' + josaTail(p.name, '로/으로') + ' ' + (cnt || 1) + '번 옮겨서 그 프로젝트로 뒀어요.'
          : q + josaTail(ph, '가/이') + ' 들어간 글은 전에 프로젝트 없이 ' + (cnt || 1) + '번 옮겨서 프로젝트 없이 뒀어요.';
      } else if (en.type === 'date') {
        var says = top && AD && AD.says ? AD.says('date', top.to, { phrase: ph }) : null;
        line = q + josaTail(ph, '는/은') + ' 전에 ' + (says ? ui.josa(says, '로/으로') + ' ' : '') + (cnt || 1) + '번 고쳐서 마감을 ' + ui.josa(fmtDate(en.to), '로/으로') + ' 뒀어요.';
      } else {
        line = q + josaTail(ph, '는/은') + ' 전에 고친 대로 뒀어요.';
      }
      return h('li.learn-why-row',
        h('div', line),
        top ? h('button.btn.btn-xs.btn-ghost', { type: 'button', onclick: function () {
          if (pop) pop.close(true);
          DN.capture.forgetRule(top.id, top.label || ph);
        } }, '이 규칙 지우기') : h('div.meta', '(지운 규칙)'));
    });
    var node = h('div',
      h('ul.learn-why-list', rows),
      h('div.meta', '틀렸으면 칩을 눌러 고쳐 주세요. 고치면 이 규칙은 약해져요.'));
    pop = ui.popover(anchor, node, { label: '배운 대로 고친 까닭', className: 'learn-why' });
    var b = pop.el.querySelector('button');
    if (b) b.focus();
  }

  // "할 일로 정리했어요" · "메모와 할 일 2개로 나눴어요" · "아이디어로 남겼어요"
  // 날짜를 바꾼 내용 — "마감 → 내일(토)" · "오늘 19:00에 하기"
  function movedText(ch, now) {
    var to = ch.to || {};
    if (to.at) { var p = to.at.split(' '); return dayLabel(p[0], now) + ' ' + p[1] + '에 하기'; }
    return '마감 ' + dayLabel(to.dueDate, now) + (to.dueTime ? ' ' + to.dueTime : '');
  }
  function summary(items, now) {
    now = now || DN.app.now();
    // 기존 할 일에 대한 보고 — "‘샤워하기’를 완료했어요" · "‘견적서 발송’ 마감을 내일(토)로 옮겼어요"
    var done = items.filter(function (it) { return it.kind === 'done'; });
    var moved = items.filter(function (it) { return it.kind === 'moved'; });
    if (done.length || moved.length) {
      var parts = [];
      if (done.length) {
        var t0 = done[0].item.title;
        parts.push(done.length === 1 ? '‘' + t0 + '’' + ui.josa(t0, '를/을').slice(t0.length) + ' 완료했어요' : '할 일 ' + done.length + '개를 완료했어요');
      }
      if (moved.length) {
        var m0 = moved[0], mt = m0.item.title, to = m0.change.to || {};
        parts.push(moved.length > 1 ? '할 일 ' + moved.length + '개의 날짜를 바꿨어요'
          : to.at ? '‘' + mt + '’' + ui.josa(mt, '를/을').slice(mt.length) + ' ' + movedText(m0.change, now).replace(/에 하기$/, '에 하기로 했어요')
          : '‘' + mt + '’ 마감을 ' + ui.josa(dayLabel(to.dueDate, now) + (to.dueTime ? ' ' + to.dueTime : ''), '로/으로') + ' 옮겼어요');
      }
      var others = items.filter(function (it) { return it.kind !== 'done' && it.kind !== 'moved' && it.ref.kind !== 'note'; });
      if (others.length) parts.unshift(summary(others, now));
      return parts.join(' · ');
    }
    var count = {};
    items.forEach(function (it) { count[it.kind] = (count[it.kind] || 0) + 1; });
    var parts = KINDS.filter(function (k) { return NOTE_KIND[k] && count[k]; }).map(function (k) { return ui.KIND_LABEL[k]; })
      .concat(['task', 'event'].filter(function (k) { return count[k]; }).map(function (k) { return ui.KIND_LABEL[k] + (count[k] > 1 ? ' ' + count[k] + '개' : ''); }));
    if (!parts.length) return '메모로 남겼어요';
    if (parts.length === 1) {
      var only = items[0].kind;
      return ui.josa(parts[0], '로/으로') + (NOTE_KIND[only] ? ' 남겼어요' : ' 정리했어요');
    }
    var last = parts.pop();
    return ui.josa(parts.join(', '), '와/과') + ' ' + ui.josa(last, '로/으로') + ' 나눴어요';
  }

  function capRow(n, it, idx, items, st, now) {
    var A = DN.app, CP = DN.capture;
    var item = it.item;
    var isNote = it.ref.kind === 'note';
    var title = isNote ? M.noteTitle(n) : (item.title || '(제목 없음)');
    var fk = 'cap:' + n.id + ':' + idx;   // 다시 그려도 같은 자리로 포커스를 돌려주는 열쇠

    // 날짜 바꾸기 줄 — 바뀐 날짜를 보여 주고, × 는 '되돌리기' (원래 날짜로)
    if (it.kind === 'moved') {
      return h('div.cap-row.is-moved', { role: 'listitem', 'data-kind': 'moved' },
        h('span.chip.chip-kind.kind-moved', ui.icon('calendar'), '날짜 변경'),
        h('button.cap-title', { type: 'button', title: '할 일 열기', onclick: function () { A.openTask(item.id); } }, title),
        h('span.chip.cap-date.chip-today', '→ ' + movedText(it.change, now)),
        h('button.icon-btn.cap-x', {
          type: 'button', title: '원래 날짜로 되돌리기', 'aria-label': '‘' + title + '’ 날짜 변경 되돌리기',
          onclick: function () {
            CP.removeItem(n.id, it.ref);
            ui.undoToast('‘' + title + '’ 날짜를 원래대로 되돌렸어요.');
          }
        }, ui.icon('x')));
    }
    // 완료 보고 줄 — 종류·날짜는 바꿀 게 없다. × 는 '완료 취소'
    if (it.kind === 'done') {
      return h('div.cap-row.is-done', { role: 'listitem', 'data-kind': 'done' },
        h('span.chip.chip-kind.kind-done', ui.icon('check'), '완료'),
        h('button.cap-title', { type: 'button', title: '할 일 열기', onclick: function () { A.openTask(item.id); } }, title),
        h('button.icon-btn.cap-x', {
          type: 'button', title: '완료 취소', 'aria-label': '‘' + title + '’ 완료 취소',
          onclick: function () {
            CP.removeItem(n.id, it.ref);
            ui.undoToast('‘' + title + '’ 완료를 취소했어요.');
          }
        }, ui.icon('x')));
    }

    // 명령어로 만든 줄은 잠금 표시 (사용자가 바꾸면 사라진다). 배운 대로 정한 종류는 title 만 다르다
    var c = n.capture || {};
    var forced = !!(c.command && !c.changedByUser) && (NOTE_KIND[c.command.kind] ? isNote : !isNote);
    var byLearned = !forced && (c.learned || []).some(function (x) { return x.type === 'kind'; });
    var kindBtn = h('button.chip.chip-kind.cap-kind.kind-' + it.kind + (forced ? '.is-forced' : ''), {
      type: 'button', 'aria-haspopup': 'menu', 'data-focus-key': fk + ':kind',
      'aria-label': '종류: ' + ui.KIND_LABEL[it.kind] + (forced ? ', 명령어로 지정' : '') + ' — 바꾸기',
      title: forced ? '‘' + c.command.token + '’ 명령어로 정한 종류예요. 눌러서 바꿀 수 있어요.'
        : byLearned ? '배운 대로 정한 종류예요. 눌러서 바꿀 수 있어요.' : '종류 바꾸기',
      onclick: function (e) { kindMenu(e.currentTarget, n, it, items, forced); }
    }, ui.icon(ui.KIND_ICON[it.kind]), ui.KIND_LABEL[it.kind], forced ? ui.icon('lock', 'cap-lock') : null, ui.icon('chevronDown', 'cap-caret'));

    var titleBtn = h('button.cap-title', {
      type: 'button', title: isNote ? '메모 열기' : it.kind === 'task' ? '할 일 열기' : '일정 열기',
      onclick: function () {
        if (isNote) A.go('notes', { noteId: n.id });
        else if (it.kind === 'task') A.openTask(item.id);
        else DN.views.schedule.open({ blockId: item.id });
      }
    }, title);

    var dateBtn = null, uncertain = null;
    if (it.kind === 'task' || it.kind === 'event') {
      var d = dateInfo(it, now);
      dateBtn = h('button.chip.cap-date' + (d.cls ? '.' + d.cls : ''), {
        type: 'button', 'aria-haspopup': 'menu', 'data-focus-key': fk + ':date',
        'aria-label': (it.kind === 'task' ? '마감: ' : '날짜: ') + d.label + ' — 바꾸기', title: '날짜 바꾸기',
        onclick: function (e) { dateMenu(e.currentTarget, n, it, now); }
      }, ui.icon(it.kind === 'task' ? 'flag' : 'clock'), d.label);
      if (it.kind === 'event' && item.timeUncertain) {
        uncertain = h('button.chip.chip-guess.cap-uncertain', {
          type: 'button', 'data-focus-key': fk + ':time', title: 'AI가 시각을 확실히 알 수 없었어요. 눌러서 정해 주세요.',
          onclick: function (e) { var pop = ui.popover(e.currentTarget, h('div'), { label: '날짜와 시각 정하기' }); pickForm(pop, n, it, now); }
        }, '시각 확인 필요');
      }
    }

    var pid = isNote ? n.projectId : item.projectId;
    var proj = pid && M.byId(st.projects, pid);
    if (proj && proj.deletedAt) proj = null;
    var projBtn = h('button.chip.cap-proj' + (proj ? '.chip-project' : '.is-empty'), {
      type: 'button', 'aria-haspopup': 'menu', 'data-focus-key': fk + ':proj',
      'aria-label': '프로젝트: ' + (proj ? proj.name : '없음') + ' — 바꾸기', title: '프로젝트 바꾸기 (이 글 전체)',
      onclick: function (e) { projectMenu(e.currentTarget, n, pid); }
    }, proj ? proj.name : '+ 프로젝트');
    if (proj) projBtn.style.setProperty('--pc', proj.color);   // 사용자 지정 속성은 setProperty 로만 들어간다

    // 할 일 맥락 칩 (현재 상태 기능을 켰을 때만 그려진다)
    var ctxChip = it.kind === 'task' && item && DN.status && DN.status.contextChip
      ? DN.status.contextChip(item, { focusKey: fk + ':ctx', where: 'cap' }) : null;

    var removeBtn = isNote ? null : h('button.icon-btn.cap-x', {
      type: 'button', title: '이 줄 빼기', 'aria-label': '‘' + title + '’ 빼기',
      onclick: function () {
        CP.removeItem(n.id, it.ref);
        ui.undoToast('‘' + title + '’' + ui.josa(title, '를/을').slice(title.length) + ' 뺐어요. 원문은 그대로 있어요.');
      }
    }, ui.icon('x'));

    return h('div.cap-row', { role: 'listitem', 'data-kind': it.kind }, kindBtn, titleBtn, dateBtn, uncertain, projBtn, ctxChip, removeBtn);
  }

  // 날짜 칩 문구 — "오늘" · "내일(토)" · "10월 9일 (금)" (+ 일정·마감 시각)
  function dayLabel(ymd, now) {
    var rel = D.relDay(ymd, now);
    var d = D.parseYmd(ymd);
    if (rel === '내일' || rel === '어제') return rel + '(' + D.WEEKDAYS[d.getDay()] + ')';
    if (d.getFullYear() !== now.getFullYear()) return d.getFullYear() + '년 ' + rel;
    return rel;
  }
  function dateInfo(it, now) {
    var x = it.item;
    if (it.kind === 'task') {
      // 시간 정한 할 일 — 작업 시간이 있으면 그 시각을 먼저 ("오늘 21:35 · 30분", 마감은 뒤에)
      var work = M.blocksForTask(S.state, x.id).filter(function (b) { return b.kind === 'work' && new Date(b.end) > now; })[0];
      if (work) {
        var ws = new Date(work.start);
        return {
          label: dayLabel(D.ymd(ws), now) + ' ' + D.hm(ws) + ' · ' + Math.round((new Date(work.end) - ws) / 60000) + '분' + (x.dueDate ? ' (마감 ' + dayLabel(x.dueDate, now) + ')' : ''),
          cls: D.ymd(ws) === D.ymd(now) ? 'chip-today' : ''
        };
      }
      if (!x.dueDate) return { label: '날짜 없음', cls: 'is-none' };
      var due = D.parseYmd(x.dueDate, x.dueTime || '23:59');
      var cls = x.status !== 'done' && due < now ? 'chip-overdue' : x.dueDate === D.ymd(now) ? 'chip-today' : '';
      return { label: dayLabel(x.dueDate, now) + (x.dueTime ? ' ' + x.dueTime : ''), cls: cls };
    }
    var s = new Date(x.start);
    // 길이를 짐작해 넣은 일정은 길이도 보여 준다 (캘린더에서 끌어 고치면 된다)
    var len = x.durationGuessed ? ' · ' + Math.round((new Date(x.end) - s) / 60000) + '분' : '';
    return { label: dayLabel(D.ymd(s), now) + (x.timeUncertain ? '' : ' ' + D.hm(s)) + len, cls: D.ymd(s) === D.ymd(now) ? 'chip-today' : '' };
  }

  // ------------------------------------------------------------------ 종류 바꾸기
  function kindMenu(anchor, n, it, items, forced) {
    var q = forced ? '명령어로 정한 종류예요. 무엇으로 바꿀까요?' : items.length > 1 ? '이 줄을 무엇으로 둘까요?' : '무엇으로 둘까요?';
    ui.menu(anchor, [{ label: q }].concat(KINDS.map(function (k) {
      return { label: ui.KIND_LABEL[k], icon: ui.KIND_ICON[k], kind: k, checked: it.kind === k, onClick: function () { changeKind(n, it, k, items); } };
    })), { label: '종류 바꾸기', className: 'cap-menu' });
  }

  // 줄이 하나뿐이면 적은 글 전체를 바꾼다 (DN.capture.setKind).
  // 여러 줄이면 그 줄만 바꾼다 — 나머지 줄은 그대로 둔다 (DN.capture.setItemKind).
  // 할 일 ↔ 일정 변환·원문 보존 규칙은 모두 core(proposals.js)에 있다.
  function changeKind(n, it, kind, items) {
    if (it.kind === kind) return;
    if (items.length <= 1) DN.capture.setKind(n.id, kind);
    else DN.capture.setItemKind(n.id, it.ref, kind);
  }

  // ------------------------------------------------------------------ 날짜 바꾸기
  function dateMenu(anchor, n, it, now) {
    var today = D.startOfDay(now);
    var mon = D.startOfWeek(now);
    var opts = [['오늘', today], ['내일', D.addDays(today, 1)]];
    var fri = D.addDays(mon, 4);
    if (fri >= today) opts.push(['이번 주 금요일', fri]);
    opts.push(['다음 주 월요일', D.addDays(mon, 7)]);
    var curYmd = it.kind === 'task' ? it.item.dueDate : D.ymd(it.item.start);
    var items = [{ label: it.kind === 'task' ? '언제까지 할까요?' : '언제로 옮길까요?' }].concat(opts.map(function (o) {
      var ymd = D.ymd(o[1]);
      return { label: o[0], sub: D.shortDay(o[1]), checked: curYmd === ymd, onClick: function () { setDate(n, it, ymd, null); } };
    }));
    items.push({ sep: true });
    items.push({ label: it.kind === 'task' ? '날짜 고르기…' : '날짜·시각 고르기…', icon: 'calendar', keepOpen: true, onClick: function (pop) { pickForm(pop, n, it, now); } });
    if (it.kind === 'task') items.push({ label: '날짜 없음', checked: !curYmd, onClick: function () { setDate(n, it, null, null); } });
    ui.menu(anchor, items, { label: '날짜 바꾸기', className: 'cap-menu' });
  }

  // 날짜(일정은 + 시각) 직접 고르기 — 메뉴 자리에 작은 입력 칸을 띄운다
  function pickForm(pop, n, it, now) {
    var x = it.item, isEvent = it.kind === 'event';
    var curYmd = isEvent ? D.ymd(x.start) : (x.dueDate || D.ymd(now));
    var dateIn = h('input.input', { type: 'date', value: curYmd, 'aria-label': '날짜' });
    var timeIn = isEvent ? h('input.input', { type: 'time', value: x.timeUncertain ? '' : D.hm(x.start), 'aria-label': '시각' }) : null;
    function apply() {
      if (!dateIn.value) { dateIn.focus(); return; }
      pop.close(true);
      setDate(n, it, dateIn.value, timeIn && timeIn.value ? timeIn.value : null);
    }
    var form = h('form.cap-pick', { onsubmit: function (e) { e.preventDefault(); apply(); } },
      h('div.cap-pick-title', isEvent ? '날짜와 시각' : '마감일'),
      h('div.cap-pick-row', dateIn, timeIn),
      isEvent && x.timeUncertain ? h('div.meta', '시각을 비워 두면 지금처럼 ‘시각 확인 필요’로 남겨요.') : null,
      h('div.cap-pick-foot',
        h('button.btn.btn-xs.btn-ghost', { type: 'button', onclick: function () { pop.close(true); } }, '취소'),
        h('button.btn.btn-xs.btn-primary', { type: 'submit' }, '적용')));
    pop.setContent(form, 'dialog');
  }

  // ymd: 'YYYY-MM-DD' 또는 null(날짜 없음, 할 일만). time: 'HH:MM' (일정에서 고른 경우)
  // 고친 날짜는 capture 를 거쳐 저장한다 — 날짜 교정도 배우기에 쓰인다 (proposals.captureSetDate)
  function setDate(n, it, ymd, time) {
    DN.capture.setDate(n.id, it.ref, ymd, time);
  }

  // ------------------------------------------------------------------ 프로젝트 바꾸기 (적은 글 전체)
  function projectMenu(anchor, n, cur) {
    var st = S.state;
    var items = [{ label: '프로젝트 (이 글 전체에 적용)' }];
    M.liveProjects(st).forEach(function (p) {
      items.push({ label: p.name, icon: h('span.cap-proj-dot', { style: { background: p.color }, 'aria-hidden': 'true' }), checked: p.id === cur, onClick: function () { DN.capture.setProject(n.id, p.id); } });
    });
    items.push({ label: '없음', checked: !cur, onClick: function () { DN.capture.setProject(n.id, null); } });
    ui.menu(anchor, items, { label: '프로젝트 바꾸기', className: 'cap-menu' });
  }

  // 단계 나누기 — 고칠 수 있는 목록
  function breakdownCard(m, st, now) {
    var AS = DN.assistant;
    var t = M.byId(st.tasks, m.taskId);
    if (!t) return null;
    if (m.resolved) {
      var txt = m.resolved === 'applied' ? '‘' + t.title + '’를 ' + (m.resolvedCount || '') + '단계로 나눴어요.'
        : m.resolved === 'later' ? '좋아요, 나중에 다시 보여 드릴게요.' : '알겠어요. 이 할 일은 나누지 않을게요.';
      return bubble('assistant', h('div.msg-text', txt, m.resolved === 'applied' ? h('button.link-btn', { type: 'button', style: { marginLeft: '6px' }, onclick: function () { DN.app.openTask(t.id); } }, '할 일 보기') : null));
    }
    var draft = (m.draft || []).map(function (x) { return { title: x.title, minutes: x.minutes }; });
    var rows = h('ol.bd-steps');
    function save() { DN.assistant.update(m.id, { draft: draft }); }
    function paint() {
      rows.textContent = '';
      draft.forEach(function (s, i) {
        var tIn = h('input.input', { value: s.title || '', placeholder: '단계 ' + (i + 1), 'aria-label': (i + 1) + '번째 단계' });
        tIn.addEventListener('change', function () { s.title = tIn.value; save(); });
        var mIn = h('input.input.bd-min', { type: 'number', min: '1', max: '480', value: s.minutes != null ? s.minutes : '', placeholder: '분', 'aria-label': (i + 1) + '번째 단계 예상 시간(분)' });
        mIn.addEventListener('change', function () { s.minutes = mIn.value ? Number(mIn.value) : null; save(); });
        rows.appendChild(h('li.bd-step', tIn, mIn,
          h('button.icon-btn', { type: 'button', 'aria-label': (i + 1) + '번째 단계 지우기', onclick: function () { draft.splice(i, 1); save(); paint(); } }, ui.icon('x'))));
      });
    }
    paint();
    var total = draft.reduce(function (a, s) { return a + (s.minutes || 0); }, 0);
    return bubble('assistant', h('div.bd',
      m.intro ? h('div.msg-text', m.intro) : null,
      h('div.bd-title', '‘' + t.title + '’를 이렇게 나눠 보면 어떨까요?'),
      m.reason ? h('div.meta', m.reason) : null,
      rows,
      h('button.link-btn.bd-add', { type: 'button', onclick: function () { draft.push({ title: '', minutes: null }); save(); paint(); var ins = rows.querySelectorAll('input:not(.bd-min)'); if (ins.length) ins[ins.length - 1].focus(); } }, '+ 단계 추가'),
      total ? h('div.meta', '합계 약 ' + D.duration(total) + ' · 고친 내용은 적용할 때 그대로 들어가요') : null,
      h('div.msg-actions',
        h('button.btn.btn-primary.btn-xs', { type: 'button', onclick: function () {
          Array.prototype.forEach.call(rows.querySelectorAll('input'), function (el) { el.dispatchEvent(new Event('change')); });
          AS.applyBreakdown(m.id, t.id, draft);
        } }, '이렇게 나누기'),
        h('button.btn.btn-xs', { type: 'button', onclick: function () { AS.deferBreakdown(m.id, t.id, 'later'); } }, '나중에'),
        h('button.btn.btn-xs.btn-ghost', { type: 'button', onclick: function () { AS.deferBreakdown(m.id, t.id, 'never'); } }, '필요 없어요'))));
  }

  // 다음 할 일 추천
  function nextCard(m, st, now) {
    var A = DN.app, AS = DN.assistant;
    var t = M.byId(st.tasks, m.taskId);
    if (!t) return null;
    var done = t.status === 'done' || t.deletedAt;
    var hasDraft = t.breakdown && (t.breakdown.status === 'pending' || t.breakdown.status === 'later');
    return bubble('assistant', h('div',
      m.statusLabel ? h('div.meta.next-status', '지금: ' + m.statusLabel) : null,
      h('div.meta', '지금 하기 좋은 일'),
      h('div.next-title' + (done ? '.is-done' : ''), t.title),
      m.step ? h('div.meta', '먼저 이 단계부터: ' + m.step) : null,
      h('ul.next-reasons', (m.reasons || []).slice(0, 2).map(function (r) { return h('li', r); })),
      done ? h('div.meta', '이미 끝낸 일이에요.') : h('div.msg-actions',
        t.status === 'in_progress'
          ? h('button.btn.btn-primary.btn-xs', { type: 'button', onclick: function () { A.openTask(t.id); } }, '이어하기')
          : h('button.btn.btn-primary.btn-xs', { type: 'button', onclick: function () { A.startTask(t.id); } }, ui.icon('play'), '지금 시작'),
        h('button.btn.btn-xs', { type: 'button', onclick: function () { AS.next((m.skip || []).concat(t.id)); } }, '다른 추천'),
        !(t.steps || []).length ? h('button.btn.btn-xs', { type: 'button', onclick: function () { AS.breakdown(t.id); } }, hasDraft ? '나눠 둔 단계 보기' : '작게 나누기') : null)));
  }

  // 자세히 적기 제안
  function elaborateCard(m, st, now) {
    var AS = DN.assistant;
    return bubble('assistant', h('div',
      m.intro ? h('div.msg-text', m.intro) : null,
      (m.picks || []).map(function (p) {
        var t = M.byId(st.tasks, p.taskId);
        if (!t) return null;
        var state = m.done && m.done[p.taskId];
        if (state) return h('div.el-pick.is-done', h('b', t.title), ' — ', state === 'saved' ? '적어 두었어요.' : '다음에 볼게요.');
        var ta = h('textarea.textarea', { rows: 3, placeholder: p.hints && p.hints.length ? p.hints.join(' · ') : '자유롭게 적어 주세요', 'aria-label': '‘' + t.title + '’ 자세히 적기' });
        return h('div.el-pick',
          h('div.el-title', '‘' + t.title + '’'),
          p.why ? h('div.meta', p.why) : null,
          h('div.el-q', p.question),
          ta,
          h('div.msg-actions',
            h('button.btn.btn-primary.btn-xs', { type: 'button', onclick: function () { if (!AS.saveElaboration(m.id, t.id, ta.value)) ui.toast('내용을 적어 주세요.'); } }, '할 일에 적어 두기'),
            h('button.btn.btn-xs.btn-ghost', { type: 'button', onclick: function () { AS.skipElaboration(m.id, t.id); } }, '다음에')));
      })));
  }

  // 휴식
  function restCard(m, st, now) {
    var AS = DN.assistant;
    var running = m.timerEnd && !m.timerDone && new Date(m.timerEnd) > new Date();
    return bubble('assistant', h('div.rest',
      h('div.msg-text', '잠깐 쉬어 가요. 이 중에 하나만 해도 좋아요.'),
      h('ul.rest-list', (m.stretches || []).map(function (s) {
        return h('li', h('b', s.title), h('div.meta', s.how));
      })),
      m.timerDone ? h('div.meta', '5분 휴식을 마쳤어요.')
        : running ? h('div.rest-timer', ui.icon('clock'), ' 남은 시간 ', h('span', { 'data-timer-end': m.timerEnd }, ''))
        : h('div.msg-actions',
          h('button.btn.btn-primary.btn-xs', { type: 'button', onclick: function () { AS.startTimer(m.id, 5); } }, '5분 타이머 시작'),
          h('button.btn.btn-xs.btn-ghost', { type: 'button', onclick: function () { AS.rest(); } }, '다른 스트레칭'))));
  }

  DN.views.chat = { render: render };
})();
