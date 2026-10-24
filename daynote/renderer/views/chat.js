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
    var list = h('div.chat-list', { role: 'log', 'aria-live': 'polite', 'aria-label': '적은 것과 정리 결과 · 할 일을 끌어 놓으면 작업 공간에 올라가요' });
    // 보낸 글·끌어 온 할 일은 채팅 화면 맨 위로 올리고, 답은 그 아래에 채운다 (AI 채팅처럼)
    var pinnedId = null;
    var spacer = h('div.chat-spacer', { 'aria-hidden': 'true' });
    function lastPin(msgs) { for (var i = msgs.length - 1; i >= 0; i--) if (msgs[i].pin) return msgs[i].id; return null; }
    function placePin(scroll) {
      var el = pinnedId && list.querySelector('[data-mid="' + pinnedId + '"]');
      spacer.style.height = '0px';
      if (!el) return false;
      var top = el.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop - 12;
      var below = list.scrollHeight - top;
      spacer.style.height = Math.max(0, list.clientHeight - below) + 'px';
      if (scroll) list.scrollTop = top;
      return true;
    }
    function paintList() {
      var st = S.state, now = A.now();
      var keepTop = list.scrollTop;
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
        if (node) { node.setAttribute('data-mid', m.id); list.appendChild(node); }
      });
      list.appendChild(spacer);
      var pin = lastPin(msgs);
      if (pin && pin !== pinnedId) { pinnedId = pin; placePin(true); }
      else if (pinnedId && placePin(false)) list.scrollTop = keepTop;
      else if (nearBottom) list.scrollTop = list.scrollHeight;
      startTimers();
    }
    // 할 일을 끌어 놓으면 작업 공간(채팅)에 작업 카드로 올린다
    function hasType(e, type) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], type) !== -1; }
    list.addEventListener('dragover', function (e) {
      if (!hasType(e, 'application/x-daynote-task')) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
      list.classList.add('is-drop-target');
    });
    list.addEventListener('dragleave', function (e) { if (!list.contains(e.relatedTarget)) list.classList.remove('is-drop-target'); });
    list.addEventListener('drop', function (e) {
      if (!hasType(e, 'application/x-daynote-task')) return;
      e.preventDefault();
      list.classList.remove('is-drop-target');
      AS.work(e.dataTransfer.getData('application/x-daynote-task'));
    });

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
    pinnedId = lastPin((st.chat || []).slice(-SHOW));
    paintList();

    // ---------------------------------------------------------------- 도우미 버튼 + 입력
    var tools = h('div.chat-tools', { role: 'group', 'aria-label': '도우미' },
      h('button.chat-tool', { type: 'button', onclick: function () { AS.next(); } }, ui.icon('spark'), '다음 할 일'),
      h('button.chat-tool', { type: 'button', onclick: function () { AS.breakdown(); } }, ui.icon('task'), '작업 작게 나누기'),
      h('button.chat-tool', { type: 'button', onclick: function () { AS.rest(); } }, ui.icon('clock'), '휴식'),
      h('button.chat-tool', { type: 'button', title: '오늘 끝낸 일을 보고, 남은 일마다 다음 시각을 정해요', onclick: function () { AS.dayClose(); } }, ui.icon('check'), '하루 마무리'));

    var t;
    function grow() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; }
    function keep() {
      clearTimeout(t);
      t = setTimeout(function () { S.mutate(null, function (s) { s.quickDraft = { text: ta.value, projectId: null }; }, { source: 'today' }); }, 300);
    }
    function sendNow() {
      var v = ta.value;
      if (!v.trim()) return;
      clearTimeout(t);
      S.mutate(null, function (s) { s.quickDraft = { text: '', projectId: null }; }, { source: 'today', silent: true });
      ta.value = ''; grow();
      AS.send(v, null);
      setTimeout(function () { var x = document.querySelector('.chat-input textarea'); if (x) x.focus(); }, 0);
    }
    ta.addEventListener('input', function () { grow(); keep(); });
    ta.addEventListener('keydown', function (e) {
      // 한글 조합 중 Enter 는 글자 확정이므로 보내지 않는다
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); sendNow(); }
    });
    // AI 연결 상태는 화면이 뜬 뒤에 알게 되므로 바뀌면 표시만 바꾼다
    var badge = h('span.chat-badge', aiBadge());
    var offAi = DN.aiFlow.onChange(function () { badge.textContent = ''; badge.appendChild(aiBadge()); });
    var input = h('div.chat-input', ta, h('div.chat-input-foot', badge,
      h('span.chat-input-hint', 'Enter 보내기 · Shift+Enter 줄바꿈'),
      h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: sendNow, 'aria-label': '보내기' }, '보내기')));

    root.appendChild(h('section.chat', { 'aria-label': '적어 두기' },
      h('div.chat-head', h('h2.panel-title', '적어 두기'), h('span.meta', '할 일·일정·메모는 Daynote가 나눠요')),
      list, tools, input));
    setTimeout(function () {
      if (!placePin(true)) list.scrollTop = list.scrollHeight;
      grow();
      // 창이 뜨면 커서가 이미 입력창에 있게 — 다른 곳을 보고 있으면 건드리지 않는다
      var a = document.activeElement;
      if (!a || a === document.body || a.id === 'view') ta.focus();
    }, 0);
    return { refresh: paintList, focus: function () { ta.focus(); }, destroy: function () { clearInterval(timerTick); timerTick = null; offAi(); } };
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
    return h('span.chip', { title: s.notice || '' }, s.provider === 'gemini' ? 'Gemini 3.5 Flash-Lite' : 'Claude Opus 5.5');
  }

  function bubble(role, content, extraClass) {
    return h('div.msg.msg-' + role + (extraClass ? '.' + extraClass : ''), h('div.msg-body', content));
  }

  // ------------------------------------------------------------------ 메시지 종류별
  function message(m, st, now) {
    var A = DN.app, AS = DN.assistant;
    if (m.role === 'user') return bubble('user', h('div.msg-text', m.text));
    if (m.kind === 'text') {
      return bubble('assistant', h('div', h('div.msg-text', m.text),
        (m.actions || []).length ? h('div.msg-actions', m.actions.map(function (a) {
          return a === 'next' ? h('button.btn.btn-xs', { type: 'button', onclick: function () { AS.next(); } }, '다음 할 일 추천받기')
            : a === 'rest' ? h('button.btn.btn-xs.btn-primary', { type: 'button', onclick: function () { AS.rest(); } }, '쉬러 가기') : null;
        })) : null));
    }
    if (m.kind === 'thinking') return bubble('assistant', h('div.msg-text', h('span.spinner', { 'aria-hidden': 'true' }), ' ', m.text));
    if (m.kind === 'capture') return captureCard(m, st, now);
    if (m.kind === 'breakdown') return withUsage(breakdownCard(m, st, now), m.usage, m.model);
    if (m.kind === 'next') return nextCard(m, st, now);
    if (m.kind === 'work') return workCard(m, st, now);
    if (m.kind === 'dayclose') return dayCloseCard(m, st, now);
    if (m.kind === 'overdue') return overdueCard(m, st, now);
    if (m.kind === 'weekstart') return weekStartCard(m, st, now);
    if (m.kind === 'elaborate') return withUsage(elaborateCard(m, st, now), m.usage, m.model);
    if (m.kind === 'rest') return restCard(m, st, now);
    return null;
  }

  // 설정에서 '쓴 토큰 보기' 를 켰으면 AI 답 아래에 토큰 한 줄
  function withUsage(el, usage, model) {
    var line = el && DN.aiFlow.usageLine(usage, model);
    if (line) (el.querySelector('.msg-body') || el).appendChild(line);
    return el;
  }

  // ------------------------------------------------------------------ 정리 결과 카드
  // 머리말 한 문장 + 정리한 것 한 줄씩: [종류 칩] 제목 [날짜 칩] [프로젝트 칩] [×]
  // 칩을 누르면 바로 고친다 (모두 Ctrl+Z 로 되돌릴 수 있다). 원문 메모는 빼도 지워지지 않는다.
  var KINDS = ['task', 'event', 'memo', 'idea', 'link'];
  var NOTE_KIND = { memo: 1, idea: 1, link: 1 };

  function captureCard(m, st, now) {
    var CP = DN.capture;
    var n = M.byId(st.notes, m.noteId);
    if (!n) return null;
    var c = n.capture || {};
    var running = CP.isRunning(n.id) || c.status === 'pending';

    if (n.deletedAt && c.entryType === 'command') return null;   // 명령은 결과 카드 대신 그 명령의 답이 뜬다
    if (n.deletedAt) return bubble('assistant', h('div.cap', h('div.cap-head.meta', '이 글은 메모에서 지웠어요.')), 'msg-cap');
    if (running) {
      return bubble('assistant', h('div.cap.is-pending', { 'aria-busy': 'true' },
        h('div.cap-skel',
          h('span.cap-skel-chip', { 'aria-hidden': 'true' }),
          h('span.cap-skel-text', h('span.spinner', { 'aria-hidden': 'true' }), '정리하는 중…'),
          h('span.cap-skel-bar', { 'aria-hidden': 'true' }))), 'msg-cap');
    }

    var items = CP.items(n);
    var head, foot;
    if (c.status === 'no_ai') {
      head = h('div.cap-head', h('span', '메모로 저장했어요'), h('span.cap-head-sub', ' · AI를 연결하면 자동으로 나눠 드려요'));
      foot = h('div.cap-foot', h('button.btn.btn-xs', { type: 'button', onclick: function () { DN.app.go('settings'); } }, ui.icon('settings'), '설정 열기'));
    } else if (c.status === 'failed') {
      head = h('div.cap-head', h('span', '메모로 남겨 뒀어요'), c.error && c.error.message ? h('span.cap-head-sub', ' · ' + c.error.message) : null);
      foot = h('div.cap-foot', h('button.btn.btn-xs', { type: 'button', onclick: function () { CP.classify(n.id); } }, ui.icon('refresh'), '다시 시도'));
    } else {
      var skipped = (c.skipped || []).length;
      head = h('div.cap-head', h('span', summary(items, now)),
        skipped ? h('span.cap-head-sub', ' · 비슷한 할 일이 이미 있어서 ' + skipped + '개는 만들지 않았어요') : null);
      foot = null;
    }
    var rows = h('div.cap-rows', { role: 'list' }, items.map(function (it, i) { return capRow(n, it, i, items, st, now); }));
    var run = (st.aiRuns || []).filter(function (r) { return r.noteId === n.id && r.kind === 'capture' && r.usage; }).pop();
    return bubble('assistant', h('div.cap', head, rows, foot, run ? DN.aiFlow.usageLine(run.usage, run.model) : null), 'msg-cap');
  }

  // "할 일로 정리했어요" · "메모와 할 일 2개로 나눴어요" · "아이디어로 남겼어요"
  // 날짜를 바꾼 내용 — "마감 → 내일(토)" · "오늘 19:00에 하기"
  function movedText(ch, now) {
    var to = ch.to || {};
    if (to.at) { var p = to.at.split(' '); return dayLabel(p[0], now) + ' ' + p[1] + '에 하기'; }
    if (to.planDate) return dayLabel(to.planDate, now) + '에 하기';
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
          : '‘' + mt + '’ 마감을 옮겼어요 → ' + dayLabel(to.dueDate, now) + (to.dueTime ? ' ' + to.dueTime : ''));
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
        h('button.cap-title', { type: 'button', title: '작업 공간에서 보기 (세부 할 일)', onclick: function () { DN.assistant.work(item.id); } }, title),
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
        h('button.cap-title', { type: 'button', title: '작업 공간에서 보기 (세부 할 일)', onclick: function () { DN.assistant.work(item.id); } }, title),
        h('button.icon-btn.cap-x', {
          type: 'button', title: '완료 취소', 'aria-label': '‘' + title + '’ 완료 취소',
          onclick: function () {
            CP.removeItem(n.id, it.ref);
            ui.undoToast('‘' + title + '’ 완료를 취소했어요.');
          }
        }, ui.icon('x')));
    }

    var kindBtn = h('button.chip.chip-kind.cap-kind.kind-' + it.kind, {
      type: 'button', 'aria-haspopup': 'menu', 'data-focus-key': fk + ':kind',
      'aria-label': '종류: ' + ui.KIND_LABEL[it.kind] + ' — 바꾸기', title: '종류 바꾸기',
      onclick: function (e) { kindMenu(e.currentTarget, n, it, items); }
    }, ui.icon(ui.KIND_ICON[it.kind]), ui.KIND_LABEL[it.kind], ui.icon('chevronDown', 'cap-caret'));

    var titleBtn = h('button.cap-title', {
      type: 'button', title: isNote ? '메모 열기' : it.kind === 'task' ? '할 일 열기' : '일정 열기',
      onclick: function () {
        if (isNote) A.openNote(n.id);
        else if (it.kind === 'task') DN.assistant.work(item.id);
        else DN.views.schedule.open({ blockId: item.id });
      }
    }, title);

    var dateBtn = null, uncertain = null;
    if (it.kind === 'task' || it.kind === 'event') {
      var d = dateInfo(it, now);
      dateBtn = h('button.chip.cap-date' + (d.cls ? '.' + d.cls : ''), {
        type: 'button', 'aria-haspopup': 'menu', 'data-focus-key': fk + ':date',
        'aria-label': (it.kind === 'task' ? (d.plan ? '할 날: ' : '마감: ') : '날짜: ') + d.label + ' — 바꾸기',
        title: d.overdue ? '날짜 바꾸기 · Alt+클릭: 지금부터 ' + M.POSTPONE_HOURS + '시간 뒤로 미루기' : '날짜 바꾸기',
        onclick: function (e) {
          if (d.overdue && e.altKey) { e.preventDefault(); ui.postponeOverdue(item.id); return; }
          dateMenu(e.currentTarget, it, now);
        }
      }, ui.icon(it.kind === 'task' ? (d.plan ? 'calendar' : 'flag') : 'clock'), d.label);
      if (it.kind === 'event' && item.timeUncertain) {
        uncertain = h('button.chip.chip-guess.cap-uncertain', {
          type: 'button', 'data-focus-key': fk + ':time', title: 'AI가 시각을 확실히 알 수 없었어요. 눌러서 정해 주세요.',
          onclick: function (e) { var pop = ui.popover(e.currentTarget, h('div'), { label: '날짜와 시각 정하기' }); pickForm(pop, it, now); }
        }, '시각 확인 필요');
      }
    }

    var pid = isNote ? n.projectId : item.projectId;
    var proj = pid && M.byId(st.projects, pid);
    if (proj && proj.deletedAt) proj = null;
    var projBtn = h('button.chip.cap-proj' + (proj ? '.chip-project' : '.is-empty'), {
      type: 'button', 'aria-haspopup': 'menu', 'data-focus-key': fk + ':proj',
      style: proj ? { '--pc': proj.color } : null,
      'aria-label': '프로젝트: ' + (proj ? proj.name : '없음') + ' — 바꾸기', title: '프로젝트 바꾸기 (이 글 전체)',
      onclick: function (e) { projectMenu(e.currentTarget, n, pid); }
    }, proj ? proj.name : '+ 프로젝트');

    var removeBtn = isNote ? null : h('button.icon-btn.cap-x', {
      type: 'button', title: '이 줄 빼기', 'aria-label': '‘' + title + '’ 빼기',
      onclick: function () {
        CP.removeItem(n.id, it.ref);
        ui.undoToast('‘' + title + '’' + ui.josa(title, '를/을').slice(title.length) + ' 뺐어요. 원문은 그대로 있어요.');
      }
    }, ui.icon('x'));

    var row = h('div.cap-row', { role: 'listitem', 'data-kind': it.kind }, kindBtn, titleBtn, dateBtn, uncertain, whereBtn(it, now), projBtn, removeBtn);
    // 방금(30분 안) 만든 할 일인데 마감도 작업 시간도 없으면 — "언제 할까요?" 를 바로 고르게
    var fresh = n.capture && n.capture.at && now - new Date(n.capture.at) < 30 * 60000;
    if (it.kind === 'task' && fresh && item.status !== 'done' && !item.dueDate &&
        !M.blocksForTask(st, item.id).some(function (b) { return new Date(b.end) > now; })) {
      return h('div.cap-row-wrap', row, h('div.cap-when', h('span.meta', '언제 할까요?'), whenChips(item.id, function (label) { ui.toast('‘' + item.title + '’ ' + label + '에 하기로 했어요.'); })));
    }
    return row;
  }

  // 날짜 칩 문구 — "오늘" · "내일(토)" · "10월 9일 (금)" (+ 일정·마감 시각)
  function dayLabel(ymd, now) {
    var rel = D.relDay(ymd, now);
    var d = D.parseYmd(ymd);
    if (rel === '내일' || rel === '어제') return rel + '(' + D.WEEKDAYS[d.getDay()] + ')';
    if (d.getFullYear() !== now.getFullYear()) return d.getFullYear() + '년 ' + rel;
    return rel;
  }
  // 이 줄이 홈의 어느 날 칸에 들어갔는지 — 오늘이 아니면 [→ 그날 보기] (오늘 목록에 안 보여도 어디 있는지 바로 알게)
  function whereBtn(it, now) {
    if (!(it.kind === 'task' || it.kind === 'event') || !it.item) return null;
    var day = it.kind === 'task' ? DN.horizon.anchorDay(S.state, it.item, now) : D.ymd(it.item.start);
    var today = D.ymd(now);
    if (!day || day <= today || it.item.status === 'done') return null;
    return h('button.chip.chip-btn.cap-where', { type: 'button', title: '홈에서 그날 칸 보기',
      onclick: function () {
        S.mutate(null, function (s) { s.prefs.homeView = day <= D.ymd(D.addDays(now, 1)) ? 'today' : 'day:' + day; });   // 내일은 [오늘] 안에
        if (DN.app.current().view !== 'today') DN.app.go('today');
      } }, '→ ' + DN.horizon.leftText(day, now) + ' 칸');
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
      // 할 날(그날 하기)만 있는 일 — 마감과 구분해서
      if (!x.dueDate && x.planDate) return { label: dayLabel(x.planDate, now) + '에 하기', cls: x.planDate <= D.ymd(now) ? 'chip-today' : '', plan: true };
      if (!x.dueDate) return { label: '날짜 없음', cls: 'is-none' };
      var due = D.dueAt(x.dueDate, x.dueTime);
      var when = dayLabel(x.dueDate, now) + (x.dueTime ? ' ' + x.dueTime : '');
      if (x.status === 'done') return { label: when, cls: '' };
      // 남은 시간도 같이 — 지났으면 "마감 지남" (Alt+클릭으로 24시간 미루기)
      if (due < now) return { label: '마감 지남 · ' + when + ' · ' + D.remainText(due, now), cls: 'chip-overdue', overdue: true };
      return { label: when + ' · ' + D.remainText(due, now), cls: x.dueDate === D.ymd(now) ? 'chip-today' : '' };
    }
    var s = new Date(x.start);
    // 길이를 짐작해 넣은 일정은 길이도 보여 준다 (캘린더에서 끌어 고치면 된다)
    var len = x.durationGuessed ? ' · 약 ' + Math.round((new Date(x.end) - s) / 60000) + '분' : '';
    return { label: dayLabel(D.ymd(s), now) + (x.timeUncertain ? '' : ' ' + D.hm(s)) + len, cls: D.ymd(s) === D.ymd(now) ? 'chip-today' : '' };
  }

  // ------------------------------------------------------------------ 종류 바꾸기
  function kindMenu(anchor, n, it, items) {
    ui.menu(anchor, [{ label: items.length > 1 ? '이 줄을 무엇으로 둘까요?' : '무엇으로 둘까요?' }].concat(KINDS.map(function (k) {
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
  function dateMenu(anchor, it, now) {
    var today = D.startOfDay(now);
    var mon = D.startOfWeek(now);
    var opts = [['오늘', today], ['내일', D.addDays(today, 1)]];
    var fri = D.addDays(mon, 4);
    if (fri >= today) opts.push(['이번 주 금요일', fri]);
    opts.push(['다음 주 월요일', D.addDays(mon, 7)]);
    // 시간 정한 할 일은 작업 시간의 날짜가 지금 날짜
    var curWork = it.kind === 'task' ? M.blocksForTask(S.state, it.item.id).filter(function (b) { return b.kind === 'work' && new Date(b.end) > now; })[0] : null;
    var planOnly = it.kind === 'task' && !curWork && !it.item.dueDate && !!it.item.planDate;
    var curYmd = it.kind === 'task' ? (curWork ? D.ymd(curWork.start) : it.item.dueDate || it.item.planDate) : D.ymd(it.item.start);
    var items = [{ label: it.kind === 'task' ? (planOnly ? '언제 할까요? (할 날)' : '언제까지 할까요?') : '언제로 옮길까요?' }].concat(opts.map(function (o) {
      var ymd = D.ymd(o[1]);
      return { label: o[0], sub: D.shortDay(o[1]), checked: curYmd === ymd, onClick: function () { setDate(it, ymd, null); } };
    }));
    items.push({ sep: true });
    items.push({ label: it.kind === 'task' ? '날짜 고르기…' : '날짜·시각 고르기…', icon: 'calendar', keepOpen: true, onClick: function (pop) { pickForm(pop, it, now); } });
    if (it.kind === 'task') items.push({ label: '날짜 없음', checked: !curYmd, onClick: function () { setDate(it, null, null); } });
    ui.menu(anchor, items, { label: '날짜 바꾸기', className: 'cap-menu' });
  }

  // 날짜(일정은 + 시각) 직접 고르기 — 메뉴 자리에 작은 입력 칸을 띄운다
  function pickForm(pop, it, now) {
    var x = it.item, isEvent = it.kind === 'event';
    var pfWork = isEvent ? null : M.blocksForTask(S.state, x.id).filter(function (b) { return b.kind === 'work' && new Date(b.end) > now; })[0];
    var curYmd = isEvent ? D.ymd(x.start) : (pfWork ? D.ymd(pfWork.start) : (x.dueDate || D.ymd(now)));
    var dateIn = h('input.input', { type: 'date', value: curYmd, 'aria-label': '날짜' });
    var timeIn = isEvent ? h('input.input', { type: 'time', value: x.timeUncertain ? '' : D.hm(x.start), 'aria-label': '시각' }) : null;
    function apply() {
      if (!dateIn.value) { dateIn.focus(); return; }
      pop.close(true);
      setDate(it, dateIn.value, timeIn && timeIn.value ? timeIn.value : null);
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
  function setDate(it, ymd, time) {
    var now = DN.app.now();
    if (it.kind === 'task') {
      S.mutate(ymd ? '날짜 바꾸기' : '날짜 지우기', function (s) {
        // 시간 정한 할 일이면 작업 시간을 같은 날로 옮긴다 (날짜 없음이면 작업 시간을 지운다)
        var work = M.blocksForTask(s, it.item.id).filter(function (b) { return b.kind === 'work' && new Date(b.end) > now; })[0];
        if (work) {
          var t = M.byId(s.tasks, it.item.id);
          if (!ymd) {
            M.deleteBlock(s, work.id);
            M.updateTask(s, it.item.id, { dueDate: null, dueTime: null }, now);
          } else {
            var ws = new Date(work.start);
            var wlen = Math.max(15, Math.round((new Date(work.end) - ws) / 60000)) || 30;
            var wn = D.parseYmd(ymd, time || D.hm(ws));
            M.updateBlock(s, work.id, { start: wn.toISOString(), end: D.addMinutes(wn, wlen).toISOString() });
            // 마감도 있던 할 일만 마감을 함께 옮긴다 — 할 시각만 있던 일에 마감을 새로 만들지 않는다
            if (t && t.dueDate) M.updateTask(s, it.item.id, { dueDate: ymd }, now);
          }
          return;
        }
        var cur = M.byId(s.tasks, it.item.id);
        // 할 날만 있던 일은 할 날을 옮긴다 (마감을 새로 만들지 않는다)
        if (cur && !cur.dueDate && cur.planDate) { M.updateTask(s, it.item.id, { planDate: ymd || null }, now); return; }
        M.updateTask(s, it.item.id, ymd ? { dueDate: ymd } : { dueDate: null, dueTime: null }, now);
      }, { source: 'capture' });
      return;
    }
    S.mutate('일정 옮기기', function (s) {
      var b = M.byId(s.blocks, it.item.id);
      if (!b) return;
      var start = new Date(b.start), end = new Date(b.end);
      var len = Math.max(15, Math.round((end - start) / 60000)) || 60;
      var ns = D.parseYmd(ymd, time || D.hm(start));
      var patch = { start: ns.toISOString(), end: D.addMinutes(ns, len).toISOString() };
      if (time) patch.timeUncertain = false;
      M.updateBlock(s, b.id, patch);
    }, { source: 'capture' });
  }

  // ------------------------------------------------------------------ 프로젝트 바꾸기 (적은 글 전체)
  function projectMenu(anchor, n, cur) {
    var st = S.state;
    var items = [{ label: '프로젝트 (이 글 전체에 적용)' }].concat(ui.projectMenuItems(st, cur, function (pid) { DN.capture.setProject(n.id, pid); ui.touchProject(pid); }));
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
      return bubble('assistant', h('div.msg-text', txt, m.resolved === 'applied' ? h('button.link-btn', { type: 'button', style: { marginLeft: '6px' }, onclick: function () { DN.assistant.work(t.id); } }, '작업 공간에서 보기') : null));
    }
    var draft = (m.draft || []).map(function (x) { return { title: x.title, minutes: x.minutes }; });
    var rows = h('ol.bd-steps');
    function save() { DN.assistant.update(m.id, { draft: draft }); }
    function paint() {
      rows.textContent = '';
      draft.forEach(function (s, i) {
        var tIn = h('input.input', { value: s.title || '', placeholder: '단계 ' + (i + 1), 'aria-label': (i + 1) + '번째 단계' });
        tIn.addEventListener('change', function () { s.title = tIn.value; save(); });
        rows.appendChild(h('li.bd-step', tIn, minuteScrub(s, i, save),
          h('button.icon-btn', { type: 'button', 'aria-label': (i + 1) + '번째 단계 지우기', onclick: function () { draft.splice(i, 1); save(); paint(); } }, ui.icon('x'))));
      });
    }
    paint();
    var total = draft.reduce(function (a, s) { return a + (s.minutes || 0); }, 0);
    return bubble('assistant', h('div.bd',
      m.intro ? h('div.msg-text', m.intro) : null,
      h('div.bd-title', '‘' + t.title + '’를 이렇게 나눠 보면 어떨까요?'),
      // 데모 모드(브라우저 미리보기·스크린샷)의 초안은 규칙으로 만든 일반 예시다 — 실제 AI 결과로 착각하지 않게
      DN.aiFlow.status().provider === 'fake' ? h('div.bd-demo', ui.icon('info'), '데모 AI 예시예요 — 어떤 일이든 같은 틀로 나눠요. 실제 앱에서는 Gemini가 이 일에 맞게 나눠 드려요.') : null,
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
    if (m.prep) return prepCard(m, st, t, now);
    var done = t.status === 'done' || t.deletedAt;
    var hasDraft = t.breakdown && (t.breakdown.status === 'pending' || t.breakdown.status === 'later');
    return bubble('assistant', h('div',
      m.intro ? h('div.msg-text.next-intro', m.intro) : null,
      h('div.meta', m.minutes ? D.duration(m.minutes) + ' 안에 하기 좋은 일' : '지금 하기 좋은 일'),
      h('div.next-title' + (done ? '.is-done' : ''), t.title),
      m.step ? h('div.meta', '먼저 이 단계부터: ' + m.step) : null,
      h('ul.next-reasons', (m.reasons || []).slice(0, 2).map(function (r) { return h('li', r); })),
      done ? h('div.meta', '이미 끝낸 일이에요.') : h('div.msg-actions',
        t.status === 'in_progress'
          ? h('button.btn.btn-primary.btn-xs', { type: 'button', onclick: function () { AS.work(t.id); } }, '작업 공간에서 보기')
          : h('button.btn.btn-primary.btn-xs', { type: 'button', onclick: function () { A.startTask(t.id); AS.work(t.id); } }, ui.icon('play'), '지금 시작'),
        h('button.btn.btn-xs', { type: 'button', onclick: function () { AS.next((m.skip || []).concat(t.id), { minutes: m.minutes, free: m.free }); } }, '다른 추천'),
        !(t.steps || []).length ? h('button.btn.btn-xs', { type: 'button', onclick: function () { AS.breakdown(t.id, null, { force: true }); } }, hasDraft ? '나눠 둔 단계 보기' : '작업 작게 나누기') : null)));
  }

  // 준비할 일 추천 — 할 일 자체가 아니라 그 일을 하기 전에 해 둘 세부 할 일 하나 ('해 뒀어요' 를 누르면 체크)
  //   카드는 할 일의 지금 상태로 그린다 (다른 곳에서 체크해도 맞게)
  function prepCard(m, st, t, now) {
    var AS = DN.assistant;
    var step = DN.steps.find(t.steps || [], m.stepId);
    var done = !step || step.done || t.status === 'done' || !!t.deletedAt;
    var left = t.status === 'done' || t.deletedAt ? 0 : DN.steps.prepLeaves(t.steps).length;
    return bubble('assistant', h('div',
      m.intro ? h('div.msg-text.next-intro', m.intro) : null,
      h('div.meta', '틈틈이 해 둘 준비' + (m.minutes ? ' · ' + D.duration(m.minutes) + ' 안에' : '')),
      h('div.next-title' + (done ? '.is-done' : ''), m.step),
      h('div.next-for',
        h('span.chip.chip-prep', '준비'),
        h('button.link-btn', { type: 'button', title: '이 할 일 자세히 보기', onclick: function () { DN.app.openTask(t.id); } }, t.title)),
      done ? null : h('ul.next-reasons', (m.reasons || []).slice(1, 3).map(function (r) { return h('li', r); })),
      done
        ? h('div.msg-actions',
            h('span.meta', !step ? '지워진 준비예요.' : left ? '해 뒀어요. ‘' + t.title + '’ 준비가 ' + left + '개 더 있어요.' : '해 뒀어요.'),
            h('button.btn.btn-xs', { type: 'button', onclick: function () { AS.next(null, { minutes: m.minutes, free: m.free }); } }, '다음 할 일'))
        : h('div.msg-actions',
            h('button.btn.btn-primary.btn-xs', { type: 'button', onclick: function () { AS.donePrep(t.id, m.stepId); } }, ui.icon('check'), '해 뒀어요'),
            h('button.btn.btn-xs', { type: 'button', onclick: function () { AS.next((m.skip || []).concat(m.key), { minutes: m.minutes, free: m.free }); } }, '다른 추천'))));
  }

  // ------------------------------------------------------------------ 단계 시간 — 숫자를 잡고 위아래로 끌어 맞추기
  // 위로 끌면 늘고 아래로 끌면 준다 (60분까지 5분, 그 위 10분씩). ↑/↓ 키도 같은 눈금.
  // 그냥 누르면(움직이지 않으면) 숫자를 직접 고칠 수 있다. 끄는 동안에는 저장하지 않고 놓을 때 한 번만.
  var SCRUB_PX = 8;   // 이만큼 움직일 때마다 한 눈금
  function minuteScrub(s, i, save) {
    var SP = DN.split;
    var input = h('input.input.bd-min', {
      type: 'text', inputmode: 'numeric', value: s.minutes != null ? String(s.minutes) : '', placeholder: '–',
      'aria-label': (i + 1) + '번째 단계 예상 시간(분) — 위아래로 끌거나 ↑/↓ 키로 조정', title: '위아래로 끌어서 조정 · ↑/↓ 키'
    });
    function set(v, commit) {
      s.minutes = v;
      input.value = v != null ? String(v) : '';
      if (commit) save();
    }
    input.addEventListener('change', function () {
      var n = parseInt(String(input.value).replace(/[^\d]/g, ''), 10);
      set(isFinite(n) && n > 0 ? Math.min(480, n) : null, true);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      set(SP.stepMinutes(s.minutes, e.key === 'ArrowUp' ? 1 : -1), true);
    });
    var drag = null;
    input.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || document.activeElement === input) return;   // 이미 고치는 중이면 글자 선택
      e.preventDefault();
      drag = { y: e.clientY, base: s.minutes, moved: false };
      try { input.setPointerCapture(e.pointerId); } catch (x) {}
      input.classList.add('is-scrubbing');
      document.documentElement.classList.add('is-scrubbing');
    });
    input.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var steps = Math.trunc((drag.y - e.clientY) / SCRUB_PX);
      if (steps) drag.moved = true;
      if (drag.moved) set(steps ? SP.stepMinutesBy(drag.base, steps) : drag.base, false);
    });
    function end() {
      if (!drag) return;
      var d = drag; drag = null;
      input.classList.remove('is-scrubbing');
      document.documentElement.classList.remove('is-scrubbing');
      if (d.moved) save();
      else { input.focus(); input.select(); }   // 그냥 눌렀으면 직접 입력
    }
    input.addEventListener('pointerup', end);
    input.addEventListener('pointercancel', end);
    input.addEventListener('lostpointercapture', end);
    return h('span.bd-min-wrap', input, h('span.bd-min-unit', { 'aria-hidden': 'true' }, '분'));
  }

  // ------------------------------------------------------------------ 작업 카드 (할 일 작업 공간)
  // 할 일을 채팅으로 끌어 오면 생긴다. 상태 버튼(지금 시작 · 일시 정지 · 이어서 하기 · 완료)은 이 일 하나만 바꾼다
  // — 다른 진행 중인 일은 그대로. 카드를 할 일 목록으로 끌어 놓으면 할 일로 돌아간다.
  var WORK_STATE = { todo: '할 일', in_progress: '진행 중', paused: '일시 정지', waiting: '대기', done: '완료' };
  function workCard(m, st, now) {
    var A = DN.app, AS = DN.assistant;
    var t = M.byId(st.tasks, m.taskId);
    if (!t || t.deletedAt) return bubble('assistant', h('div.msg-text.meta', '지워진 할 일이에요.'));
    if (m.closed) {
      return bubble('assistant', h('div.work.is-closed',
        h('span.meta', m.closed === 'returned' ? '할 일로 돌려보냈어요 · ' : '아래에서 이어서 보고 있어요 · '),
        h('button.link-btn', { type: 'button', onclick: function () { AS.work(t.id); } }, t.title)));
    }
    var done = t.status === 'done';
    var mins = M.workedMinutes(t, now);
    var steps = t.steps || [];
    var stepCnt = DN.steps.count(steps);
    var stateBtn = done ? null
      : t.status === 'in_progress'
        ? h('button.btn.btn-sm', { type: 'button', onclick: function () { A.pauseTask(t.id); } }, ui.icon('pause'), '일시 정지')
        : h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: function () { A.startTask(t.id); } }, ui.icon('play'), t.status === 'paused' ? '이어서 하기' : '지금 시작');
    var card = h('div.work' + (t.status === 'in_progress' ? '.is-running' : t.status === 'paused' ? '.is-paused' : done ? '.is-done' : ''), {
      draggable: done ? null : 'true',
      title: done ? null : '끌어서 할 일 목록에 놓으면 할 일로 돌아가요',
      ondragstart: function (e) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-daynote-work', m.id);
        e.dataTransfer.setData('text/plain', t.title);
      }
    },
      h('div.work-head',
        h('span.work-state', ui.icon(t.status === 'in_progress' ? 'play' : t.status === 'paused' ? 'pause' : done ? 'check' : 'task'), WORK_STATE[t.status] || '할 일',
          mins ? h('span.work-time', ' · ' + (mins >= 60 ? Math.floor(mins / 60) + '시간 ' + (mins % 60) + '분' : mins + '분')) : null),
        ui.dueChip(t, now, { add: !t.planDate }), ui.planChip(t, now)),
      h('div.work-title', { title: '오른쪽 클릭: 자세히 편집·미루기·삭제', oncontextmenu: function (e) { e.preventDefault(); A.taskMenu(t.id, e.currentTarget); } }, t.title || '(제목 없음)'),
      timeLine(st, t),
      t.status === 'paused' ? resumeBox(t) : (t.resumeNote && t.status === 'in_progress' ? h('div.work-resume', ui.icon('info'), '이어서: ' + t.resumeNote) : null),
      steps.length ? h('div.work-steps',
        h('div.meta', '단계 ' + stepCnt.done + '/' + stepCnt.total),
        progressBar(stepCnt.done, stepCnt.total),
        ui.stepTree(t, { editable: !done, label: '단계 체크' })) : null,
      done
        ? h('div.msg-actions', h('span.meta', '완료했어요.'), h('button.btn.btn-xs.btn-ghost', { type: 'button', onclick: function () { A.toggleDone(t.id); } }, '완료 취소'))
        : h('div.msg-actions',
            stateBtn,
            h('button.btn.btn-sm', { type: 'button', onclick: function () { A.toggleDone(t.id); } }, ui.icon('check'), '완료'),
            focusBtn(st, t),
            h('span.work-sep', { 'aria-hidden': 'true' }),
            h('button.btn.btn-xs', { type: 'button', onclick: function () { AS.breakdown(t.id, null, { force: true }); } }, ui.icon('task'), '작업 작게 나누기'),
            h('button.btn.btn-xs.btn-ghost', { type: 'button', onclick: function () { AS.next([t.id]); } }, '다른 추천')));
    return bubble('assistant', card, 'msg-work');
  }

  // ------------------------------------------------------------------ 연구 기반 도움들 (src/core/habits.js · DAYNOTE_UX_RESEARCH.md)
  // 진행 막대 — 끝에 가까울수록 힘이 난다 (목표 기울기 효과)
  function progressBar(done, total) {
    var pct = total ? Math.round(done / total * 100) : 0;
    return h('div.pbar', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': '진행 ' + pct + '%' },
      h('div.pbar-fill', { style: { width: pct + '%' } }));
  }
  // 집중 타이머 버튼 / 남은 시간 (25분 집중 → 쉬기)
  function focusBtn(st, t) {
    var f = st.meta.focus;
    if (f && f.taskId === t.id) {
      return h('span.focus-run', ui.icon('clock'), '집중 ', h('b', { 'data-timer-end': f.end }, ''), ' 남음',
        h('button.btn.btn-xs.btn-ghost', { type: 'button', onclick: function () { DN.assistant.stopFocus(); } }, '그만'));
    }
    return h('button.btn.btn-sm', { type: 'button', title: '25분 집중하고 5분 쉬어요 (끝나면 종소리)', onclick: function () { DN.assistant.startFocus(t.id, 25); } }, ui.icon('clock'), '25분 집중');
  }
  // 단계 합계 — 나눠 보면 예상이 더 정확해진다 (단계 합이 예상보다 길면 알려 주고 바꿀 수 있게)
  function stepsSumLine(t) {
    var steps = DN.steps ? DN.steps.leaves(t.steps || []) : (t.steps || []);   // 아래 단계가 있으면 맨 아래 단계들로
    if (!steps.length || !steps.every(function (x) { return x.estimateMinutes > 0; })) return null;
    var sum = steps.reduce(function (a, x) { return a + x.estimateMinutes; }, 0);
    if (t.estimateMinutes && sum <= t.estimateMinutes * 1.15) return null;
    return h('div.work-est.meta', ui.icon('info'), '단계를 더하면 ' + D.duration(sum) + (t.estimateMinutes ? ' — 예상(' + D.duration(t.estimateMinutes) + ')보다 길어요' : ''),
      h('button.link-btn', { type: 'button', onclick: function () { S.mutate('예상 시간 바꾸기', function (s) { M.updateTask(s, t.id, { estimateMinutes: sum }, DN.app.now()); }); } }, '예상을 ' + ui.josa(D.duration(sum), '로/으로')));
  }
  // 예상 시간과 현실적인 시간 (계획 오류 보정) — "예상 40분 · 평소엔 1.5배쯤 걸려요 → 약 60분"
  function timeLine(st, t) {
    var sumLine = stepsSumLine(t);
    if (!(t.estimateMinutes > 0)) return sumLine;
    var r = DN.habits.realistic(st, t);
    return h('div', h('div.work-est.meta', ui.icon('clock'), '예상 ' + D.duration(t.estimateMinutes),
      r ? h('span', ' · 지금까지 끝낸 일을 보면 평소 ' + r.ratio + '배쯤 걸려요 → ', h('b', '약 ' + D.duration(r.minutes))) : null), sumLine);
  }
  // 멈출 때 '이어서 할 첫 행동' 한 줄 — 다시 시작이 쉬워지고 머릿속 잔상이 줄어든다 (ready-to-resume plan)
  function resumeBox(t) {
    var ta = h('input.input.work-resume-in', { value: t.resumeNote || '', placeholder: '다음에 이어서 할 첫 행동 (예: 3번 슬라이드 그래프부터)', 'aria-label': '이어서 할 첫 행동' });
    function save() {
      var v = ta.value.trim();
      if (v === (t.resumeNote || '')) return;
      S.mutate('이어서 할 일 적기', function (s) { M.updateTask(s, t.id, { resumeNote: v || null }, DN.app.now()); });
    }
    ta.addEventListener('change', save);
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); save(); ta.blur(); } });
    return h('div.work-resume-box', h('div.meta', '멈춘 김에 — 어디서부터 이어서 할지 한 줄 적어 두면 다시 시작이 쉬워요.'), ta);
  }
  // 다음 시각 고르기 칩 (실행 의도) — 고르면 그때부터 빈 시간에 작업 시간을 잡는다
  function whenChips(taskId, onPicked, extra) {
    var now = DN.app.now();
    return h('div.when-chips', DN.habits.whenChoices(now).map(function (c) {
      return h('button.chip.chip-btn', { type: 'button', onclick: function () {
        var at = DN.assistant.planAt(taskId, c.at);
        // 그날 빈 시간이 없어 다른 날로 밀렸으면 실제 날을 알려 준다 ("오늘 저녁 08:00" 같은 모순 없이)
        if (at && onPicked) onPicked((D.ymd(at) === D.ymd(c.at) ? c.label : dayLabel(D.ymd(at), now)) + ' ' + D.hm(at));
      } }, c.label);
    }).concat(extra || []));
  }

  // 하루 마무리 / 하나씩 다시 정하기 — 남은 일마다 다음 시각
  function dayCloseCard(m, st, now) {
    var AS = DN.assistant;
    var done = (m.doneIds || []).map(function (id) { return M.byId(st.tasks, id); }).filter(Boolean);
    var left = (m.taskIds || []).map(function (id) { return M.byId(st.tasks, id); }).filter(function (t) { return t && !t.deletedAt; });
    var picked = m.picked || {};
    function pick(id, label) { var p = Object.assign({}, picked); p[id] = label; AS.update(m.id, { picked: p }); }
    var open = left.filter(function (t) { return !picked[t.id] && t.status !== 'done'; });
    // 한 번에 정하기 — 남은 일 전부 내일(할 날)로, 또는 전부 그대로
    function pickAll(mode) {
      var ids = open.map(function (t) { return t.id; });
      if (!ids.length) return;
      var p = Object.assign({}, picked);
      if (mode === 'tomorrow') {
        var tom = D.ymd(D.addDays(DN.app.now(), 1));
        S.mutate('남은 일 전부 내일로', function (s) { ids.forEach(function (id) { M.updateTask(s, id, { planDate: tom }, DN.app.now()); }); });
        ids.forEach(function (id) { p[id] = '내일 하기'; });
      } else ids.forEach(function (id) { p[id] = '그대로 두기'; });
      AS.update(m.id, { picked: p });
    }
    var SHOW = 5;
    var shown = left.slice(0, SHOW), hidden = left.length - shown.length;
    return bubble('assistant', h('div.dayclose',
      m.replan ? h('div.msg-text', m.intro || '하나씩 다시 정해 볼게요. 언제 하면 좋을까요?')
        : h('div.dc-done',
            h('div.dc-title', done.length ? '오늘 끝낸 일 ' + done.length + '개 — 수고했어요!' : '오늘 하루도 수고했어요.'),
            done.length ? h('ul.dc-list', done.slice(0, 6).map(function (t) { return h('li', ui.icon('check'), t.title); }).concat(done.length > 6 ? [h('li.meta', '… 외 ' + (done.length - 6) + '개')] : [])) : null),
      left.length ? h('div.dc-left',
        m.replan ? null : h('div.dc-sub', '오늘 하려던 일 중 남은 ' + left.length + '개 — 언제 할지 정해 두면 마음 놓고 쉴 수 있어요.'),
        open.length > 1 ? h('div.msg-actions.dc-bulk',
          h('button.btn.btn-primary.btn-xs', { type: 'button', onclick: function () { pickAll('tomorrow'); } }, '전부 내일 하기 (' + open.length + ')'),
          h('button.btn.btn-xs.btn-ghost', { type: 'button', onclick: function () { pickAll('keep'); } }, '전부 그대로')) : null,
        shown.map(function (t) {
          var p = picked[t.id];
          if (t.status === 'done') p = '끝냈어요';
          return h('div.dc-row' + (p ? '.is-set' : ''),
            h('div.dc-row-title', t.title),
            p ? h('span.meta', '→ ' + p)
              : whenChips(t.id, function (label) { pick(t.id, label); },
                  [h('button.chip.chip-btn.is-ghost', { type: 'button', onclick: function () { pick(t.id, '그대로 두기'); } }, '그대로')]));
        }),
        hidden > 0 ? h('div.meta.dc-more', '외 ' + hidden + '개는 위 버튼으로 함께 정할 수 있어요.') : null,
        !open.length ? h('div.dc-end', m.replan ? '다 정했어요.' : '다 정했어요. 오늘은 여기까지 — 푹 쉬어요.') : null)
        : (m.replan ? null : h('div.dc-end', '남은 일도 없어요. 오늘은 여기까지 — 푹 쉬어요.'))));
  }

  // 밀린 일 — 탓하지 않고 한 번에 다시 정하기
  function overdueCard(m, st, now) {
    var AS = DN.assistant;
    var list = (m.taskIds || []).map(function (id) { return M.byId(st.tasks, id); }).filter(function (t) { return t && !t.deletedAt && t.status !== 'done'; });
    if (m.resolved) return bubble('assistant', h('div.msg-text', m.resolved));
    return bubble('assistant', h('div.overdue-card',
      h('div.msg-text', '밀린 일이 ' + list.length + '개 있어요. 괜찮아요 — 일정은 원래 밀리기 마련이에요. 지금 다시 정하면 돼요.'),
      h('ul.dc-list', list.slice(0, 5).map(function (t) { return h('li', ui.dueChip(t, now), ' ', t.title); })),
      h('div.msg-actions',
        h('button.btn.btn-primary.btn-xs', { type: 'button', onclick: function () {
          var n = 0;
          S.mutate('밀린 일 내일로', function (s) { n = DN.habits.postponeOverdueToTomorrow(s, DN.app.now()).length; });
          AS.update(m.id, { resolved: '밀린 일 ' + n + '개를 내일로 옮겼어요. (Ctrl+Z로 되돌릴 수 있어요)' });
        } }, '전부 내일로'),
        h('button.btn.btn-xs', { type: 'button', onclick: function () { AS.update(m.id, { resolved: '하나씩 정해 볼게요.' }); AS.replan(list.map(function (t) { return t.id; })); } }, '하나씩 정하기'),
        h('button.btn.btn-xs.btn-ghost', { type: 'button', onclick: function () { AS.update(m.id, { resolved: '알겠어요. 나중에 다시 볼게요.' }); } }, '나중에'))));
  }

  // 새 주 시작 — 이번 주 꼭 끝낼 일 3가지
  function weekStartCard(m, st, now) {
    var AS = DN.assistant;
    if (m.resolved) return bubble('assistant', h('div.msg-text', m.resolved));
    var list = (m.taskIds || []).map(function (id) { return M.byId(st.tasks, id); }).filter(function (t) { return t && !t.deletedAt && t.status !== 'done'; });
    var chosen = {};
    var count = h('span.meta', '0/3');
    var boxes = list.map(function (t) {
      var cb = h('input', { type: 'checkbox', onchange: function () {
        if (cb.checked && Object.keys(chosen).length >= 3) { cb.checked = false; ui.toast('3개까지만 골라 주세요. 적을수록 끝내기 쉬워요.'); return; }
        if (cb.checked) chosen[t.id] = true; else delete chosen[t.id];
        count.textContent = Object.keys(chosen).length + '/3';
      } });
      return h('label.ws-row', cb, h('span', t.title), t.dueDate ? ui.dueChip(t, now) : null);
    });
    return bubble('assistant', h('div.weekstart',
      h('div.dc-title', '새로운 한 주예요!'),
      h('div.msg-text', '이번 주에 꼭 끝낼 일을 3가지만 골라 볼까요? 오늘 목록에 ★로 표시해 둘게요.'),
      h('div.ws-list', boxes),
      h('div.msg-actions',
        h('button.btn.btn-primary.btn-xs', { type: 'button', onclick: function () {
          var ids = Object.keys(chosen);
          if (!ids.length) { ui.toast('하나 이상 골라 주세요.'); return; }
          S.mutate('이번 주 목표', function (s) { DN.habits.setWeekGoals(s, ids, DN.app.now()); });
          AS.update(m.id, { resolved: '이번 주 목표: ' + ids.map(function (id) { var t = M.byId(S.state.tasks, id); return t ? '★ ' + t.title : ''; }).join(' · ') });
        } }, '이렇게 정하기'), count,
        h('button.btn.btn-xs.btn-ghost', { type: 'button', onclick: function () { AS.update(m.id, { resolved: '알겠어요. 이번 주도 화이팅이에요.' }); } }, '건너뛰기'))));
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
