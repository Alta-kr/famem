'use strict';

// 연결과 설정 — AI 처리, 배운 것, 근무 시간, 현재 상태, 연결(메일), 캘린더, 데이터, 화면, 단축키.
//
// 카드 순서: AI 처리 → Daynote가 배운 것 → 근무 시간 → 현재 상태 → 연결 → 캘린더 → 데이터 → 화면
//  - '배운 것'·'현재 상태'·'캘린더(Google)' 는 다른 파일이 DN.settingsCards.{learn,status,google} 로 등록한다.
//    등록이 없거나 그리다 실패하면 건너뛰거나(캘린더는 정적 카드로) 대신한다.
//  - 이 버전은 실제 메일 계정에 연결하지 않는다. '샘플 메일함' 만 연결 흐름을 보여준다.
//  - 연결 상태: disconnected 연결 전 · connecting 연결 중 · connected 연결됨 · error 동기화 실패 · reauth 재인증 필요

(function () {
  var DN = window.Daynote;
  DN.settingsCards = DN.settingsCards || {};
  var M = DN.model, D = DN.dates, S = DN.store, ui = DN.ui, h = ui.h;
  var A = function () { return DN.app; };
  var SL = function () { return DN.slots; };

  var connectTimer = null;
  var advOpen = false;          // AI 카드 '고급' 열림 여부 — 다시 그려도 유지
  var lastCheck = null;         // 마지막 연결 확인 결과 { ok, ms, model, message }
  var rendered = [];            // 지금 그려진 등록 카드 (destroy 용)
  var liveRoot = null;          // 설정 화면이 그려져 있는 root — 다른 화면으로 가면 null (늦게 온 다시 그리기를 막는다)
  var offAi = null;             // DN.aiFlow.onChange 구독 해제 함수 (AI 상태가 늦게 오면 AI 카드만 다시 그린다)

  var STATUS = {
    disconnected: { text: '연결된 메일 없음', dot: '' },
    connecting: { text: '연결 중…', dot: 'busy' },
    connected: { text: '연결됨', dot: 'ok' },
    error: { text: '동기화 실패', dot: 'err' },
    reauth: { text: '재인증 필요', dot: 'err' }
  };

  // 연결 카드 — gcal 은 'ready' (별도 캘린더 카드가 맡는다) 라 준비 중 목록에 나오지 않는다
  var PROVIDERS = [
    { id: 'gmail', name: 'Gmail', icon: 'mail', status: 'soon' },
    { id: 'outlook-mail', name: 'Outlook 메일', icon: 'mail', status: 'soon' },
    { id: 'gcal', name: 'Google 캘린더', icon: 'calendar', status: 'ready' },
    { id: 'outlook-cal', name: 'Outlook 캘린더', icon: 'calendar', status: 'soon' }
  ];

  function sampleMails() { return S.state.emails.filter(function (e) { return e.sample; }); }

  function scanAfterSync() {
    var cands = DN.suggest.scan(S.state, A().now());
    var added = [];
    S.mutate(null, function (s) {
      added = M.mergeSuggestions(s, cands, A().now());
    });
    return added.length;
  }

  function connectSample() {
    if (!sampleMails().length) { ui.toast('샘플 데이터를 먼저 불러오세요.'); return; }
    S.mutate(null, function (s) { s.emailConnection = { status: 'connecting', provider: 'sample', lastSyncAt: null, error: null }; });
    clearTimeout(connectTimer);
    connectTimer = setTimeout(function () {
      connectTimer = null;
      if (S.state.emailConnection.status !== 'connecting') return;
      S.mutate('메일 연결', function (s) {
        s.emailConnection = { status: 'connected', provider: 'sample', lastSyncAt: A().now().toISOString(), error: null };
      });
      var n = scanAfterSync();
      ui.toast('샘플 메일함에 연결했어요.' + (n ? ' 새 할 일 제안 ' + n + '개를 찾았어요.' : ''), n ? { action: { label: '제안 보기', fn: function () { A().go('inbox'); } } } : null);
    }, 700);
  }

  function syncNow() {
    var c = S.state.emailConnection;
    if (c.provider === 'sample' && !sampleMails().length) {
      S.mutate(null, function (s) { s.emailConnection.status = 'error'; s.emailConnection.error = '샘플 메일이 없어요. 샘플 데이터를 다시 불러오세요.'; });
      return;
    }
    S.mutate(null, function (s) { s.emailConnection.lastSyncAt = A().now().toISOString(); s.emailConnection.status = 'connected'; s.emailConnection.error = null; });
    var n = scanAfterSync();
    ui.toast(n ? '동기화했어요. 새 할 일 제안 ' + n + '개' : '동기화했어요. 새로 찾은 제안이 없어요.', n ? { action: { label: '제안 보기', fn: function () { A().go('inbox'); } } } : null);
  }

  function disconnect() {
    ui.confirm('메일 연결 해제', '연결을 해제하면 더 이상 메일을 가져오지 않아요. 이미 만든 할 일과 제안은 그대로 남아요.', '연결 해제').then(function (ok) {
      if (!ok) return;
      clearTimeout(connectTimer);
      S.mutate('메일 연결 해제', function (s) { s.emailConnection = { status: 'disconnected', provider: null, lastSyncAt: null, error: null }; });
      ui.undoToast('메일 연결을 해제했어요.');
    });
  }

  // 등록 카드 하나 그리기 — 실패하면 fallback (없으면 건너뜀)
  function card(name, ctx, fallback) {
    var c = DN.settingsCards && DN.settingsCards[name];
    if (!c || !c.render) return fallback ? fallback() : null;
    try {
      var el = c.render(ctx);
      if (el) { rendered.push(c); return el; }
    } catch (e) { console.error(e); }
    return fallback ? fallback() : null;
  }

  // ---------------------------------------------------------------- AI 처리
  // Google AI Studio 키를 붙여 넣으면 메인 프로세스가 운영체제 보안 저장소로 암호화해 둔다.
  // 화면은 키를 다시 받지 않는다 — 상태에는 '끝 4자리' 만 온다.
  var KEY_SOURCE = { env: '환경변수', dotenv: '앱 폴더의 .env 파일', saved: '이 앱에 저장한 키' };

  function aiLine(aiSt) {
    var browser = S.host.kind === 'browser';
    if (!aiSt.configured && aiSt.reason === '확인 중…') return { dot: '.busy', text: '확인 중…', sub: '' };
    if (browser && aiSt.provider !== 'fake') return { dot: '', text: '브라우저 미리보기', sub: 'AI는 데스크톱 앱에서 연결할 수 있어요.' };
    if (aiSt.provider === 'fake') return { dot: '.busy', text: '데모 모드 · 실제 AI가 아니에요', sub: '규칙으로 나눠요. 인터넷으로 보내는 것은 없어요.' };
    if (!aiSt.configured && aiSt.savedKey) return { dot: '.err', text: '저장한 키를 쓸 수 없어요', sub: '키(' + aiSt.savedKey + ')를 다시 붙여 넣어 주세요.' };
    if (!aiSt.configured) return { dot: '', text: 'AI 꺼짐', sub: '적은 글은 메모로만 저장돼요. 키를 넣으면 할 일·일정으로 나눠 드려요.' };
    if (aiSt.provider === 'gemini') return { dot: '.ok', text: '켜짐 · Google Gemini', sub: '처리 위치: Google 서버 (인터넷 필요)' };
    return { dot: '.ok', text: '켜짐 · Anthropic Claude', sub: '처리 위치: Anthropic 서버 (인터넷 필요)' };
  }

  // details 의 toggle 이벤트는 비동기라, 펼친 직후 다시 그리면 advOpen 이 아직 옛값일 수 있다 — 지우기 전에 DOM 에서 읽는다
  function syncAdv(scope) {
    var d = scope && scope.querySelector ? scope.querySelector('#set-ai-adv') : null;
    if (d) advOpen = d.open;
  }

  // AI 카드 모양을 정하는 값들 — 이것이 바뀌었을 때만 카드를 다시 그린다
  function aiSig(aiSt) {
    return [aiLine(aiSt).text, aiSt.configured ? 1 : 0, aiSt.provider || '', aiSt.savedKey || '', aiSt.keySource || '',
      aiSt.model || '', aiSt.fastModel || '', aiSt.vendor || '', aiSt.notice || '', aiSt.reason || ''].join('\u0001');
  }

  // AI 상태는 비동기로 온다(처음 '확인 중…', 데스크톱은 IPC). 설정 화면이 떠 있는 동안 바뀌면 AI 카드만 바꿔 끼운다.
  // 키 칸에 글이 있거나 포커스가 있으면 건드리지 않는다(붙여 넣던 키를 잃지 않게).
  function watchAi(root, ctx) {
    if (offAi) { offAi(); offAi = null; }
    if (!(DN.aiFlow && DN.aiFlow.onChange)) return;
    offAi = DN.aiFlow.onChange(function () {
      if (liveRoot !== root) return;
      var old = root.querySelector('#set-ai');
      if (!old || !old.parentNode) return;
      var aiSt = DN.aiFlow.status();
      if (old.getAttribute('data-ai-sig') === aiSig(aiSt)) return;
      var keyIn = old.querySelector('#set-ai-key');
      if (keyIn && (keyIn.value || document.activeElement === keyIn)) return;
      syncAdv(old);
      var fresh = safe(function () { return aiCard(ctx); });
      if (!fresh) return;
      var hadFocus = old.contains(document.activeElement);
      old.parentNode.replaceChild(fresh, old);
      if (hadFocus) { var hd = fresh.querySelector('#set-ai-h'); if (hd) hd.focus(); }
    });
  }

  function aiCard(ctx) {
    var aiSt = DN.aiFlow.status();
    var browser = S.host.kind === 'browser';
    var line = aiLine(aiSt);
    var showKey = aiSt.provider !== 'fake' && !browser;
    var result = h('span.help#set-ai-result', { role: 'status', 'aria-live': 'polite' });
    if (lastCheck) result.textContent = lastCheck.ok
      ? '잘 연결됐어요 · ' + (lastCheck.ms / 1000).toFixed(1) + '초'
      : '연결하지 못했어요. 키를 확인해 주세요.';
    var rerender = function () { DN.aiFlow.loadStatus().then(function () { ctx.rerender(); }); };

    var input = h('input.input#set-ai-key', {
      type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Google AI Studio 키를 붙여 넣으세요',
      style: { flex: '1', minWidth: '200px' }
    });
    function save() {
      var k = input.value.trim();
      if (!k) { input.focus(); return; }
      result.textContent = '저장하는 중…';
      S.host.ai.setKey(k).then(function (r) {
        input.value = '';
        if (!r || !r.ok) { result.textContent = (r && r.error) || '저장하지 못했어요.'; return; }
        lastCheck = null;
        ui.toast('AI 키를 저장했어요. 이제 적은 글을 자동으로 나눠 드려요.');
        rerender();
      });
    }
    function check() {
      result.textContent = '연결을 확인하는 중… (몇 초 걸려요)';
      S.host.ai.check().then(function (r) {
        lastCheck = r && r.ok
          ? { ok: true, ms: r.ms, model: r.model }
          : { ok: false, message: (r && r.error && r.error.message) || '알 수 없는 오류' };
        // 확인하는 사이 카드가 다시 그려졌으면 지금 문서에 있는 결과 칸에 쓴다
        var out = document.getElementById('set-ai-result') || result;
        out.textContent = lastCheck.ok
          ? '잘 연결됐어요 · ' + (lastCheck.ms / 1000).toFixed(1) + '초'
          : '연결하지 못했어요. 키를 확인해 주세요.';
        var adv = document.getElementById('set-ai-lastcheck');
        if (adv) adv.textContent = lastCheckText();
      });
    }
    function clearKey() {
      ui.confirm('저장한 키 지우기', '이 앱에 저장한 AI 키를 지워요. 지운 뒤에는 적은 글이 메모로만 저장돼요.', '지우기').then(function (ok) {
        if (ok) { lastCheck = null; S.host.ai.clearKey().then(rerender); }
      });
    }

    var keyHint = aiSt.savedKey
      ? h('div.help', '저장한 키 ' + aiSt.savedKey + ' · 이 컴퓨터의 보안 저장소에 암호화해 뒀어요 ',
          h('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: clearKey }, '지우기'))
      : null;

    function lastCheckText() {
      return !lastCheck ? '아직 확인하지 않았어요.'
        : lastCheck.ok ? (lastCheck.ms / 1000).toFixed(2) + '초 · ' + lastCheck.model
        : lastCheck.message;
    }
    var models = aiSt.provider === 'gemini'
      ? h('li', '모델: 나누기 ', h('b', aiSt.fastModel || 'gemini-3.5-flash-lite'), '(생각 최소), 작게 나누기·메모 정리 ', h('b', aiSt.model || ''), '(생각 적게) · 한쪽이 실패하면 서로 대신해요.')
      : aiSt.provider === 'claude' ? h('li', '모델: ', h('b', aiSt.model || ''))
      : aiSt.provider === 'fake' ? h('li', '모델: ', h('b', aiSt.model || '가짜 AI(테스트)'))
      : null;
    var adv = h('details.settings-adv#set-ai-adv', { open: advOpen },
      h('summary', ui.icon('chevronDown'), '고급'),
      h('ul.help', { style: { margin: '8px 0 0', paddingLeft: '18px', lineHeight: 1.7 } },
        aiSt.keySource ? h('li', '키 출처: ', KEY_SOURCE[aiSt.keySource] || aiSt.keySource) : null,
        models,
        h('li', '마지막 연결 확인: ', h('span#set-ai-lastcheck', lastCheckText())),
        aiSt.reason ? h('li', '상태 원문 사유: ', aiSt.reason) : null,
        h('li', '개발용 설정: 환경변수 GEMINI_API_KEY(또는 GOOGLE_API_KEY), ANTHROPIC_API_KEY, DAYNOTE_AI_PROVIDER=gemini|claude, DAYNOTE_AI_FAKE=1 을 읽어요. 우선순위: 이 앱에 저장한 키 > 환경변수 > 앱 폴더의 .env'),
        h('li', '저장 방식: Windows는 DPAPI, macOS는 키체인으로 암호화해요.')));
    adv.addEventListener('toggle', function () { advOpen = adv.open; });

    return h('section.card.settings-card#set-ai', { 'aria-labelledby': 'set-ai-h', 'data-ai-sig': aiSig(aiSt) },
      h('h3#set-ai-h', { tabindex: '-1' }, 'AI 처리'),
      h('div.status-line', h('span.status-dot' + line.dot), h('b', line.text)),
      line.sub ? h('div.help', line.sub) : null,
      showKey ? h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '12px' } },
        h('label', { for: 'set-ai-key', style: { fontSize: '14px', fontWeight: '500' } }, 'AI 키'),
        input,
        h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: save }, aiSt.savedKey ? '키 바꾸기' : '키 저장'),
        aiSt.configured ? h('button.btn.btn-sm', { type: 'button', onclick: check }, '연결 확인') : null) : null,
      showKey ? h('div.help', { style: { marginTop: '6px' } },
        h('a.link-btn', { href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener' }, '키 만들기'),
        ' Google AI Studio에서 무료로 만들 수 있어요.') : null,
      showKey ? keyHint : null,
      result,
      aiSt.notice ? h('div.conflict-box', { style: { margin: '10px 0 6px' } }, aiSt.notice) : null,
      h('p.help', { style: { lineHeight: 1.6, marginTop: '8px' } },
        '적은 글을 보낼 때마다 그 글과 프로젝트 이름, 열린 할 일 제목이 ' + (aiSt.vendor ? aiSt.vendor + ' API' : 'AI 제공자') + '로 전송돼요. ',
        '원문은 바뀌지 않고, AI가 만든 할 일·일정은 언제든 되돌리거나 고칠 수 있어요. ',
        '함께 보내는 것: 할 일 맥락 이름 목록, 지금 상태 이름(현재 상태를 쓸 때), 이 글에 나온 표현을 전에 어떻게 고쳤는지(배우기를 켰을 때).'),
      adv);
  }

  // ---------------------------------------------------------------- 근무 시간
  var DAY_BTNS = [[1, '월'], [2, '화'], [3, '수'], [4, '목'], [5, '금'], [6, '토'], [0, '일']];

  function workCard() {
    var sl = SL();
    var st = S.state;
    var base = sl.normalizeWorkHours(st.prefs.workHours);
    var cur = { start: base.start, end: base.end, days: base.days.slice() };
    var def = sl.normalizeWorkHours(null);

    var startIn = h('input.input#set-work-start', { type: 'time', step: '900', value: cur.start, 'aria-label': '시작 시각' });
    var endIn = h('input.input#set-work-end', { type: 'time', step: '900', value: cur.end, 'aria-label': '끝 시각' });
    var sum = h('div.help#set-work-sum', { 'aria-live': 'polite' });
    var err = h('div.field-error#set-work-err', { role: 'alert', hidden: true });
    var reset = h('button.link-btn', { type: 'button', onclick: restoreDefault }, '기본값으로 (' + sl.describeWorkHours(def) + ')');
    var dayBtns = {};

    function showErr(msg) { err.textContent = msg || ''; err.hidden = !msg; }
    function lengthText(v) {
      var mins = sl.parseHm(v.end) - sl.parseHm(v.start);
      return D.duration(mins);
    }
    function paintSum() { sum.textContent = sl.describeWorkHours(cur) + ' · 하루 ' + lengthText(cur); }
    function paintReset() { reset.hidden = !(S.state.prefs && S.state.prefs.workHours); }
    function isDefault(v) {
      return v.start === def.start && v.end === def.end && v.days.join() === def.days.join();
    }
    function commit(cand) {
      var r = sl.validateWorkHours(cand);
      if (!r.ok) { showErr(r.message); return false; }
      S.mutate(null, function (s) {
        if (isDefault(r.value)) delete s.prefs.workHours; else s.prefs.workHours = r.value;
      }, { silent: true, source: 'settings' });
      cur = { start: r.value.start, end: r.value.end, days: r.value.days.slice() };
      showErr('');
      paintSum();
      paintReset();
      return true;
    }
    function timeChange() {
      commit({ start: startIn.value, end: endIn.value, days: cur.days });
    }
    startIn.addEventListener('change', timeChange);
    endIn.addEventListener('change', timeChange);

    function paintDays() {
      DAY_BTNS.forEach(function (d) { dayBtns[d[0]].setAttribute('aria-pressed', cur.days.indexOf(d[0]) !== -1 ? 'true' : 'false'); });
    }
    function toggleDay(n) {
      var days = cur.days.slice(), i = days.indexOf(n);
      if (i === -1) days.push(n); else days.splice(i, 1);
      days.sort(function (a, b) { return a - b; });
      // 후보는 화면에 보이는 값으로 만든다 — 시각 칸이 틀린 채로 남아 있으면 그 오류를 그대로 보여 주고 저장하지 않는다
      if (commit({ start: startIn.value, end: endIn.value, days: days })) paintDays();
    }
    function restoreDefault() {
      // 이 링크는 누르면 숨겨진다 — 포커스가 body 로 빠지지 않게 카드 제목으로 옮긴다
      // (시각 칸에 두면 폰에서 시각 고르기 창이 뜰 수 있다)
      var hadFocus = document.activeElement === reset;
      S.mutate(null, function (s) { delete s.prefs.workHours; }, { silent: true, source: 'settings' });
      cur = { start: def.start, end: def.end, days: def.days.slice() };
      startIn.value = cur.start; endIn.value = cur.end;
      showErr('');
      paintDays(); paintSum(); paintReset();
      if (hadFocus) heading.focus();
    }

    var days = h('div.work-days', { role: 'group', 'aria-label': '근무 요일' }, DAY_BTNS.map(function (d) {
      var b = h('button.pill', { type: 'button', 'aria-pressed': cur.days.indexOf(d[0]) !== -1 ? 'true' : 'false', onclick: function () { toggleDay(d[0]); } }, d[1]);
      dayBtns[d[0]] = b;
      return b;
    }));
    paintSum();
    paintReset();
    var heading = h('h3#set-work-h', { tabindex: '-1' }, '근무 시간');

    return h('section.card.settings-card#set-work', { 'aria-labelledby': 'set-work-h' },
      heading,
      h('p.help', '할 일 추천과 ‘다른 시간 찾기’가 이 시간을 기준으로 해요. 근무 시간 밖에는 남은 시간을 짐작하지 않고 물어봐요.'),
      h('div.settings-row', h('div.lbl', '시간'), startIn, h('span', { 'aria-hidden': 'true' }, '~'), endIn),
      h('div.settings-row', h('div.lbl', '요일'), days),
      sum, err, reset);
  }

  // ---------------------------------------------------------------- 연결 (메일)
  function connCard() {
    var st = S.state;
    var c = st.emailConnection;
    var info = STATUS[c.status] || STATUS.disconnected;

    var mail = h('section.card.settings-card#set-conn', { 'aria-labelledby': 'set-conn-h' },
      h('h3#set-conn-h', { tabindex: '-1' }, '연결'),
      h('h4.settings-sub', '사용 중'),
      h('div.status-line', ui.icon('mail'), h('b', '메일 · ' + info.text), h('span.status-dot' + (info.dot ? '.' + info.dot : '')),
        c.provider === 'sample' ? h('span.chip.chip-sample', '샘플 메일함') : null),
      c.lastSyncAt ? h('div.help', '마지막 동기화: ' + D.longDay(c.lastSyncAt) + ' ' + D.hm(c.lastSyncAt)) : null,
      c.error ? h('div.conflict-box', { role: 'alert', style: { marginTop: '8px' } }, c.error) : null,
      h('p.help', { style: { lineHeight: 1.6 } },
        '연결하면 메일의 제목·보낸 사람·받은 시각·본문 일부를 읽기만 해요. 메일을 보내거나 지우거나 바꾸지 않아요. ',
        '읽은 내용에서 할 일처럼 보이는 문장은 ‘새 할 일 제안’에 모이고, 수락해야 할 일이 돼요.'),
      (function () {
        // 새 할 일 제안 — 사이드바에서 뺐으므로 여기서 연다
        var pending = st.suggestions.filter(function (s) { return s.status === 'pending'; }).length;
        return h('div.status-line',
          h('button.link-btn', { type: 'button', onclick: function () { A().go('inbox'); } }, '새 할 일 제안 보기'),
          pending ? h('span.chip.chip-sched', '확인할 제안 ' + pending + '개') : h('span.meta', '확인할 제안이 없어요'));
      })());

    var actions = h('div.sug-actions');
    if (c.status === 'connected') {
      actions.appendChild(h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: syncNow }, ui.icon('refresh'), '지금 동기화'));
      actions.appendChild(h('button.btn.btn-sm.btn-danger', { type: 'button', onclick: disconnect }, '연결 해제'));
    } else if (c.status === 'connecting') {
      actions.appendChild(h('button.btn.btn-sm', { type: 'button', onclick: function () { clearTimeout(connectTimer); S.mutate(null, function (s) { s.emailConnection.status = 'disconnected'; s.emailConnection.provider = null; }); } }, '취소'));
    } else if (c.status === 'error' || c.status === 'reauth') {
      actions.appendChild(h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: c.status === 'reauth' ? connectSample : syncNow }, ui.icon('refresh'), c.status === 'reauth' ? '다시 연결' : '다시 시도'));
      actions.appendChild(h('button.btn.btn-sm.btn-danger', { type: 'button', onclick: disconnect }, '연결 해제'));
    }
    if (actions.children.length) mail.appendChild(actions);

    // 체험 — 메일이 끊겼을 때만
    if (c.status === 'disconnected') {
      var n = sampleMails().length;
      mail.appendChild(h('h4.settings-sub', '체험'));
      mail.appendChild(h('div.provider-list',
        h('div.provider', ui.icon('inbox'),
          h('div.grow', h('div', h('b', '샘플 메일함'), ' ', h('span.chip.chip-sample', '체험')),
            h('div.help', n ? '실제 계정에 접속하지 않고 샘플 메일 ' + n + '통으로 흐름을 보여 줘요.' : '샘플 데이터를 먼저 불러오세요.')),
          n
            ? h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: connectSample }, '연결')
            : h('button.btn.btn-sm', { type: 'button', onclick: function () { A().loadSample(); } }, '샘플 불러오기'))));
    }

    // 준비 중 — 버튼 없이 이름만
    var soon = PROVIDERS.filter(function (p) { return p.status === 'soon'; });
    if (soon.length) {
      mail.appendChild(h('h4.settings-sub', '준비 중'));
      mail.appendChild(h('div.provider-list.is-soon', soon.map(function (p) {
        return h('div.provider', ui.icon(p.icon), h('div.grow', h('b', p.name)), h('span.chip', '준비 중'));
      })));
      mail.appendChild(h('p.help', { style: { marginTop: '8px' } }, '다음 버전에서 연결할 수 있게 준비하고 있어요.'));
    }
    return mail;
  }

  // Google 캘린더 카드가 없을 때 대신 보이는 정적 카드
  function calFallback() {
    return h('section.card.settings-card#set-gcal', { 'aria-labelledby': 'set-gcal-h' },
      h('h3#set-gcal-h', { tabindex: '-1' }, '캘린더'),
      h('div.status-line', h('span.status-dot.ok'), 'Daynote 안 캘린더만 사용 중'),
      h('p.help', '외부 캘린더 동기화는 아직 연결되지 않았어요.'));
  }

  // ---------------------------------------------------------------- 데이터
  function dataCard() {
    var st = S.state;
    var pathEl = h('code', '확인 중…');
    S.host.dataPath().then(function (p) { pathEl.textContent = p || '(알 수 없음)'; }, function () { pathEl.textContent = '(확인하지 못했어요)'; });
    return h('section.card.settings-card#set-data', { 'aria-labelledby': 'set-data-h' },
      h('h3#set-data-h', { tabindex: '-1' }, '데이터'),
      h('div.help', '모든 데이터는 이 컴퓨터에만 저장돼요. 백업 파일에는 가져온 Google 일정의 제목·시간이 들어가요. 로그인 정보는 들어가지 않아요.'),
      h('div.status-line', h('span', '저장 위치: '), pathEl),
      h('div.sug-actions',
        h('button.btn.btn-sm', { type: 'button', onclick: function () { S.host.revealData(); } }, '폴더 열기'),
        h('button.btn.btn-sm', {
          type: 'button', onclick: function () {
            S.flush();
            S.host.exportFile('daynote-백업-' + D.ymd(A().now()) + '.json', JSON.stringify(S.state, null, 2)).then(function (res) {
              if (res && res.canceled) return;
              if (res && res.ok === false) ui.toast('백업을 내보내지 못했어요' + (res.error ? ': ' + res.error : '.'), { error: true });
              else ui.toast('전체 백업을 JSON 파일로 내보냈어요.');
            });
          }
        }, ui.icon('download'), '전체 백업 내보내기'),
        st.meta.sampleLoaded
          ? h('button.btn.btn-sm.btn-danger', { type: 'button', onclick: function () { A().clearSample(); } }, '샘플 지우기')
          : h('button.btn.btn-sm', { type: 'button', onclick: function () { A().loadSample(); } }, '샘플 불러오기')));
  }

  // ---------------------------------------------------------------- 화면
  function viewCard() {
    var st = S.state;
    // 테마: 시스템(기본) · 밝게 · 어둡게 — 고르는 즉시 바뀌고, 되돌리기 대상이 아니다
    var THEMES = [['system', '시스템'], ['light', '밝게'], ['dark', '어둡게']];
    var curTheme = st.prefs.theme === 'light' || st.prefs.theme === 'dark' ? st.prefs.theme : 'system';
    var themeSeg = h('div.seg', { role: 'group', 'aria-label': '테마' }, THEMES.map(function (t) {
      return h('button', {
        type: 'button', 'data-theme-opt': t[0], 'aria-pressed': t[0] === curTheme ? 'true' : 'false',
        onclick: function () {
          S.mutate(null, function (s) { if (t[0] === 'system') delete s.prefs.theme; else s.prefs.theme = t[0]; }, { silent: true });
          A().applyPrefs();
          Array.prototype.forEach.call(themeSeg.querySelectorAll('button'), function (b) {
            b.setAttribute('aria-pressed', b.getAttribute('data-theme-opt') === t[0] ? 'true' : 'false');
          });
        }
      }, t[1]);
    }));
    var motion = h('input', {
      type: 'checkbox', id: 'set-motion', checked: !!st.prefs.reduceMotion,
      onchange: function () {
        // 설정값 쓰기는 조용히(§2.7) — 다시 그리지 않아 체크박스 포커스가 남는다
        var v = motion.checked;
        S.mutate(null, function (s) { s.prefs.reduceMotion = v; }, { silent: true, source: 'settings' });
        A().applyPrefs();
      }
    });
    // 창을 닫아도 트레이에 남아 빠른 메모 단축키가 계속 동작한다 (기본: 켬)
    var tray = h('input', {
      type: 'checkbox', id: 'set-tray', checked: st.prefs.closeToTray !== false,
      onchange: function () {
        var v = tray.checked;
        S.mutate(null, function (s) { s.prefs.closeToTray = v; }, { silent: true });
        if (S.host.setCloseToTray) S.host.setCloseToTray(v);
      }
    });
    var KEYS = [
      ['Ctrl + Shift + Space', '어디서나 빠른 메모 (Daynote가 켜져 있거나 트레이에 있을 때)'],
      ['Ctrl + K', '검색·명령 (메모 편집 중에는 링크 넣기)'],
      ['Alt + 1~6', '오늘 · 보관함 · 할 일 · 캘린더 · 프로젝트 · 주간 정리로 이동'],
      ['/', '입력창·검색 칸으로 (홈에서 입력창이 비어 있으면 ‘/’ 를 넣고 명령어 목록을 열어요)'],
      ['/ (입력창 맨 앞)', '명령어 — /할일 · /일정 · /메모 · /도움말 …'],
      ['Enter / Shift + Enter', '보내기 / 줄바꿈'],
      ['Ctrl + N', '빠른 메모 창'],
      ['Ctrl + Z', '되돌리기 (입력 칸 밖에서)'],
      ['Alt + ↑ / ↓', '오늘 할 일·메모 순서 바꾸기'],
      ['Ctrl + \\', '사이드바 접기/펴기'],
      ['Ctrl + Shift + T', '메모에서 문장을 선택한 뒤 할 일로 만들기'],
      ['Esc', '메뉴·상세 패널·대화상자 닫기']
    ];
    return h('section.card.settings-card#set-view', { 'aria-labelledby': 'set-view-h' },
      h('h3#set-view-h', { tabindex: '-1' }, '화면'),
      h('div.settings-row', h('div.grow', h('div.lbl', '테마'), h('div.help', '‘시스템’은 기기의 밝게/어둡게 설정을 따라가요.')), themeSeg),
      h('label.check-row', { for: 'set-motion' }, motion, '모션 줄이기 (애니메이션 끄기)'),
      h('label.check-row', { for: 'set-tray' }, tray, '창을 닫으면 트레이로 숨기기 (빠른 메모 단축키를 계속 쓸 수 있어요)'),
      h('h3', { style: { marginTop: '16px' } }, '단축키'),
      h('table', { style: { borderCollapse: 'collapse', fontSize: '13.5px' } }, KEYS.map(function (k) {
        return h('tr', h('td', { style: { padding: '4px 16px 4px 0', whiteSpace: 'nowrap' } }, h('kbd', k[0])), h('td.help', { style: { padding: '4px 0' } }, k[1]));
      })));
  }

  // ---------------------------------------------------------------- 페이지
  var SKIP_SOURCES = ['capture', 'chat', 'today', 'status', 'ai', 'gcal', 'gcal-settings'];
  var CARD_NAMES = ['status', 'google', 'learn'];

  function destroyCards() {
    var list = rendered;
    rendered = [];
    list.forEach(function (c) { try { if (c.destroy) c.destroy(); } catch (e) { console.error(e); } });
  }

  function safe(fn, fallback) {
    try { return fn(); } catch (e) { console.error(e); return fallback ? fallback() : null; }
  }

  function render(root, params) {
    destroyCards();
    liveRoot = root;
    var ctx = {
      params: params || {},
      // 카드가 부르는 다시 그리기. 비동기(키 저장 뒤 등)로 늦게 불려도 설정 화면을 떠났으면 아무것도 하지 않는다
      // (root 는 모든 화면이 함께 쓰는 #view 라 다른 화면을 지워 버리면 안 된다). 스크롤 위치는 지킨다.
      rerender: function () {
        if (liveRoot !== root) return;
        var top = root.scrollTop;
        syncAdv(root);
        root.textContent = '';
        render(root, {});
        root.scrollTop = top;
      }
    };
    var kids = [
      safe(function () { return aiCard(ctx); }),
      card('learn', ctx),
      DN.slots ? safe(workCard) : null,
      card('status', ctx),
      safe(connCard),
      card('google', ctx, calFallback),
      safe(dataCard),
      safe(viewCard)
    ];
    root.appendChild(h('div.view-pad',
      h('div.page-head', h('div', h('div.page-title', '연결과 설정'), h('div.page-sub', 'AI·근무 시간·연결·데이터·화면을 정해요.'))),
      kids));
    watchAi(root, ctx);

    // 바로 가기 — 한 번만 (archive 패턴: 앱은 다시 그릴 때도 같은 params 객체를 넘기므로 읽은 뒤 지운다).
    // 앱이 render 뒤에 #view 의 scrollTop 을 되돌리므로 스크롤·포커스는 그다음 틱에 한다.
    var sec = params && params.section;
    if (params) params.section = undefined;
    if (sec && /^(ai|learn|work|status|conn|gcal|data|view)$/.test(sec)) {
      setTimeout(function () {
        if (liveRoot !== root) return;
        var target = root.querySelector('#set-' + sec);
        if (!target) return;
        if (target.scrollIntoView) target.scrollIntoView({ block: 'start' });
        var head = target.querySelector('h3');
        if (head) {
          if (!head.hasAttribute('tabindex')) head.setAttribute('tabindex', '-1');
          try { head.focus({ preventScroll: true }); } catch (e) { head.focus(); }
        }
      }, 0);
    }

    return {
      onChange: function (info) {
        if (!info || info.type !== 'change') return false;
        for (var i = 0; i < CARD_NAMES.length; i++) {
          var c = DN.settingsCards[CARD_NAMES[i]];
          if (c && c.onChange) {
            var r = false;
            try { r = c.onChange(info); } catch (e) { console.error(e); }
            if (r === true) return true;
          }
        }
        return SKIP_SOURCES.indexOf(info.source) !== -1;
      },
      destroy: function () {
        // 앱이 #view 를 비우기 전에 부른다 — 고급 펼침 여부를 여기서 한 번 더 읽어 둔다
        if (liveRoot === root) syncAdv(root);
        if (liveRoot === root) liveRoot = null;
        if (offAi) { offAi(); offAi = null; }
        destroyCards();
      }
    };
  }

  DN.views = DN.views || {};
  DN.views.settings = { title: '연결과 설정', render: render };
})();
