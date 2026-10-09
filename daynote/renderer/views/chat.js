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
    var tools = h('div.chat-tools', { role: 'group', 'aria-label': '도우미' },
      h('button.chat-tool', { type: 'button', onclick: function () { AS.next(); } }, ui.icon('spark'), '다음 할 일'),
      h('button.chat-tool', { type: 'button', onclick: function () { AS.breakdown(); } }, ui.icon('task'), '작게 나누기'),
      h('button.chat-tool', { type: 'button', onclick: function () { AS.rest(); } }, ui.icon('clock'), '휴식'));

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
      list.scrollTop = list.scrollHeight; grow();
      // 창이 뜨면 커서가 이미 입력창에 있게 — 다른 곳을 보고 있으면 건드리지 않는다
      var a = document.activeElement;
      if (!a || a === document.body || a.id === 'view') ta.focus();
    }, 0);
    return { refresh: paintList, focus: function () { ta.focus(); }, destroy: function () { offAi(); } };
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
    if (m.role === 'user') return bubble('user', h('div.msg-text', m.text));
    if (m.kind === 'text') {
      return bubble('assistant', h('div', h('div.msg-text', m.text),
        (m.actions || []).length ? h('div.msg-actions', m.actions.map(function (a) {
          return a === 'next' ? h('button.btn.btn-xs', { type: 'button', onclick: function () { AS.next(); } }, '다음 할 일 추천받기')
            : a === 'rest' ? h('button.btn.btn-xs', { type: 'button', onclick: function () { AS.rest(); } }, '휴식하기') : null;
        })) : null));
    }
    if (m.kind === 'thinking') return bubble('assistant', h('div.msg-text', h('span.spinner', { 'aria-hidden': 'true' }), ' ', m.text));
    if (m.kind === 'capture') return captureCard(m, st, now);
    if (m.kind === 'breakdown') return breakdownCard(m, st, now);
    if (m.kind === 'next') return nextCard(m, st, now);
    if (m.kind === 'elaborate') return elaborateCard(m, st, now);
    if (m.kind === 'rest') return restCard(m, st, now);
    return null;
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
      foot = h('div.cap-foot.meta', h('span', c.changedByUser ? '직접 고침' : 'AI가 정리함'), h('span', { 'aria-hidden': 'true' }, ' · '), h('span', h('kbd', 'Ctrl+Z'), '로 되돌리기'));
    }
    var rows = h('div.cap-rows', { role: 'list' }, items.map(function (it, i) { return capRow(n, it, i, items, st, now); }));
    return bubble('assistant', h('div.cap', head, rows, foot), 'msg-cap');
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

    var kindBtn = h('button.chip.chip-kind.cap-kind.kind-' + it.kind, {
      type: 'button', 'aria-haspopup': 'menu', 'data-focus-key': fk + ':kind',
      'aria-label': '종류: ' + ui.KIND_LABEL[it.kind] + ' — 바꾸기', title: '종류 바꾸기',
      onclick: function (e) { kindMenu(e.currentTarget, n, it, items); }
    }, ui.icon(ui.KIND_ICON[it.kind]), ui.KIND_LABEL[it.kind], ui.icon('chevronDown', 'cap-caret'));

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
        onclick: function (e) { dateMenu(e.currentTarget, it, now); }
      }, ui.icon(it.kind === 'task' ? 'flag' : 'clock'), d.label);
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

    return h('div.cap-row', { role: 'listitem', 'data-kind': it.kind }, kindBtn, titleBtn, dateBtn, uncertain, projBtn, removeBtn);
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
    var curYmd = it.kind === 'task' ? it.item.dueDate : D.ymd(it.item.start);
    var items = [{ label: it.kind === 'task' ? '언제까지 할까요?' : '언제로 옮길까요?' }].concat(opts.map(function (o) {
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
    var curYmd = isEvent ? D.ymd(x.start) : (x.dueDate || D.ymd(now));
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
      S.mutate(ymd ? '마감일 바꾸기' : '마감일 지우기', function (s) {
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
