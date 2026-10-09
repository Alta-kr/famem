'use strict';

// 연결과 설정 — 이메일 연결, 캘린더·AI 연결 상태, 데이터 위치·백업, 화면 설정, 단축키.
//
// 이 버전은 실제 메일 계정에 연결하지 않는다. '샘플 메일함' 만 연결 흐름을 보여준다.
// 연결 상태: disconnected 연결 전 · connecting 연결 중 · connected 연결됨 · error 동기화 실패 · reauth 재인증 필요

(function () {
  var DN = window.Daynote;
  var M = DN.model, D = DN.dates, S = DN.store, ui = DN.ui, h = ui.h;
  var A = function () { return DN.app; };

  var connectTimer = null;

  var STATUS = {
    disconnected: { text: '연결 전', dot: '' },
    connecting: { text: '연결 중…', dot: 'busy' },
    connected: { text: '연결됨', dot: 'ok' },
    error: { text: '동기화 실패', dot: 'err' },
    reauth: { text: '재인증 필요', dot: 'err' }
  };

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
      ui.toast('샘플 메일함에 연결했습니다.' + (n ? ' 새 할 일 제안 ' + n + '개를 찾았습니다.' : ''), n ? { action: { label: '제안 보기', fn: function () { A().go('inbox'); } } } : null);
    }, 700);
  }

  function syncNow() {
    var c = S.state.emailConnection;
    if (c.provider === 'sample' && !sampleMails().length) {
      S.mutate(null, function (s) { s.emailConnection.status = 'error'; s.emailConnection.error = '샘플 메일이 없습니다. 샘플 데이터를 다시 불러오세요.'; });
      return;
    }
    S.mutate(null, function (s) { s.emailConnection.lastSyncAt = A().now().toISOString(); s.emailConnection.status = 'connected'; s.emailConnection.error = null; });
    var n = scanAfterSync();
    ui.toast(n ? '동기화했습니다. 새 할 일 제안 ' + n + '개' : '동기화했습니다. 새로 찾은 제안이 없습니다.', n ? { action: { label: '제안 보기', fn: function () { A().go('inbox'); } } } : null);
  }

  function disconnect() {
    ui.confirm('메일 연결 해제', '연결을 해제하면 더 이상 메일을 가져오지 않습니다. 이미 만든 할 일과 제안은 그대로 남습니다.', '연결 해제').then(function (ok) {
      if (!ok) return;
      clearTimeout(connectTimer);
      S.mutate('메일 연결 해제', function (s) { s.emailConnection = { status: 'disconnected', provider: null, lastSyncAt: null, error: null }; });
      ui.undoToast('메일 연결을 해제했습니다.');
    });
  }

  // ---------------------------------------------------------------- AI 연결
  // Google AI Studio 키를 붙여 넣으면 메인 프로세스가 Windows 보안 저장소(DPAPI)로 암호화해 둔다.
  // 화면은 키를 다시 받지 않는다 — 상태에는 '끝 4자리' 만 온다.
  var KEY_SOURCE = { env: '환경변수', dotenv: '앱 폴더의 .env 파일', saved: '이 앱에 저장한 키' };

  function aiCard(root) {
    var aiSt = DN.aiFlow.status();
    var rerender = function () { DN.aiFlow.loadStatus().then(function () { root.textContent = ''; render(root); }); };
    var label = !aiSt.configured ? '연결 안 됨'
      : aiSt.provider === 'fake' ? '데모 모드 — 실제 AI가 아니에요'
      : aiSt.provider === 'gemini' ? '연결됨 · Google Gemini'
      : '연결됨 · Anthropic Claude (' + aiSt.model + ')';
    var result = h('span.help', { role: 'status', 'aria-live': 'polite' });

    var input = h('input.input#set-ai-key', {
      type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'AIza로 시작하는 키를 붙여 넣으세요',
      'aria-describedby': 'set-ai-key-help', style: { flex: '1', minWidth: '220px' }
    });
    function save() {
      var k = input.value.trim();
      if (!k) { input.focus(); return; }
      result.textContent = '저장하는 중…';
      S.host.ai.setKey(k).then(function (r) {
        input.value = '';
        if (!r || !r.ok) { result.textContent = (r && r.error) || '저장하지 못했어요.'; return; }
        ui.toast('AI 키를 저장했어요. 이제 적은 글을 자동으로 나눠 드려요.');
        rerender();
      });
    }
    function check() {
      result.textContent = '연결을 확인하는 중… (몇 초 걸려요)';
      S.host.ai.check().then(function (r) {
        result.textContent = r && r.ok
          ? '잘 연결됐어요 · ' + (r.ms / 1000).toFixed(1) + '초 · ' + r.model
          : '연결하지 못했어요: ' + ((r && r.error && r.error.message) || '알 수 없는 오류');
      });
    }
    function clearKey() {
      ui.confirm('저장한 키 지우기', '이 앱에 저장한 AI 키를 지웁니다. 지운 뒤에는 적은 글이 메모로만 저장돼요.', '지우기').then(function (ok) {
        if (ok) S.host.ai.clearKey().then(rerender);
      });
    }

    var models = aiSt.provider === 'gemini'
      ? h('ul.help', { style: { margin: '6px 0 0', paddingLeft: '18px', lineHeight: 1.7 } },
          h('li', '적은 글 나누기: ', h('b', aiSt.fastModel || 'gemini-3.5-flash-lite'), ' — 빠른 모델 (보통 2~5초)'),
          h('li', '작게 나누기·메모 정리: ', h('b', aiSt.model), ' — 더 꼼꼼한 모델'),
          h('li', '한쪽이 바쁘거나 한도에 걸리면 다른 모델이 대신해요.'))
      : null;

    return h('section.card.settings-card', { 'aria-labelledby': 'set-ai' },
      h('h3#set-ai', 'AI 연결'),
      h('div.status-line', h('span.status-dot' + (aiSt.configured ? (aiSt.provider === 'fake' ? '.busy' : '.ok') : '')), label,
        aiSt.keySource ? h('span.meta', ' · ' + (KEY_SOURCE[aiSt.keySource] || aiSt.keySource) + (aiSt.savedKey && aiSt.keySource === 'saved' ? ' ' + aiSt.savedKey : '')) : null),
      models,
      aiSt.provider === 'fake' ? null : h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '12px' } },
        h('label.sr-only', { for: 'set-ai-key' }, 'Google AI Studio API 키'),
        input,
        h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: save }, aiSt.savedKey ? '키 바꾸기' : '키 저장'),
        aiSt.configured ? h('button.btn.btn-sm', { type: 'button', onclick: check }, '연결 확인') : null,
        aiSt.savedKey ? h('button.btn.btn-sm.btn-danger', { type: 'button', onclick: clearKey }, '저장한 키 지우기') : null),
      h('p.help#set-ai-key-help', { style: { marginTop: '6px' } },
        'Google AI Studio(aistudio.google.com)에서 무료로 만들 수 있어요. 키는 이 컴퓨터의 Windows 보안 저장소로 암호화해 두고, 화면에는 끝 4자리만 보여요.'),
      result,
      aiSt.notice ? h('div.conflict-box', { style: { margin: '10px 0 6px' } }, aiSt.notice) : null,
      h('p.help', { style: { lineHeight: 1.6 } },
        '적은 글을 보낼 때마다 그 글과 프로젝트 이름, 열린 할 일 제목이 ' + (aiSt.vendor ? aiSt.vendor + ' API' : 'AI 제공자') + '로 전송돼요. ',
        '원문은 바뀌지 않고, AI가 만든 할 일·일정은 언제든 되돌리거나 고칠 수 있어요.'));
  }

  function render(root) {
    var st = S.state;
    var c = st.emailConnection;
    var info = STATUS[c.status] || STATUS.disconnected;

    // ---------------------------------------------------------------- 이메일
    var mail = h('section.card.settings-card', { 'aria-labelledby': 'set-mail' },
      h('h3#set-mail', '이메일 연결'),
      h('div.status-line', h('span.status-dot' + (info.dot ? '.' + info.dot : '')), h('b', info.text),
        c.provider === 'sample' ? h('span.chip.chip-sample', '샘플 메일함') : null),
      c.lastSyncAt ? h('div.help', '마지막 동기화: ' + D.longDay(c.lastSyncAt) + ' ' + D.hm(c.lastSyncAt)) : null,
      c.error ? h('div.conflict-box', { role: 'alert', style: { marginTop: '8px' } }, c.error) : null,
      h('p.help', { style: { lineHeight: 1.6 } },
        '연결하면 메일의 제목·보낸 사람·받은 시각·본문 일부를 읽기만 합니다. 메일을 보내거나 지우거나 바꾸지 않습니다. ',
        '읽은 내용에서 할 일처럼 보이는 문장은 ‘새 할 일 제안’에 모이고, 수락해야 할 일이 됩니다.'),
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

    if (c.status === 'disconnected') {
      var hasSample = sampleMails().length > 0;
      mail.appendChild(h('div.provider-list',
        h('div.provider', ui.icon('mail'), h('div.grow', h('b', 'Gmail'), h('div.help', '이 버전에서는 아직 지원하지 않습니다.')),
          h('button.btn.btn-sm', { type: 'button', disabled: true }, '연결')),
        h('div.provider', ui.icon('mail'), h('div.grow', h('b', 'Outlook'), h('div.help', '이 버전에서는 아직 지원하지 않습니다.')),
          h('button.btn.btn-sm', { type: 'button', disabled: true }, '연결')),
        h('div.provider', ui.icon('inbox'),
          h('div.grow', h('b', '샘플 메일함으로 체험'),
            h('div.help', hasSample ? '샘플 메일 ' + sampleMails().length + '통으로 연결 흐름을 체험합니다. 실제 계정에는 접속하지 않습니다.' : '샘플 데이터를 먼저 불러오세요.')),
          hasSample
            ? h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: connectSample }, '연결')
            : h('button.btn.btn-sm', { type: 'button', onclick: function () { A().loadSample(); } }, '샘플 불러오기'))));
    }

    // ---------------------------------------------------------------- 캘린더 · AI
    var cal = h('section.card.settings-card', { 'aria-labelledby': 'set-cal' },
      h('h3#set-cal', '캘린더'),
      h('div.status-line', h('span.status-dot.ok'), '앱 안 캘린더만 사용 중'),
      h('p.help', '외부 캘린더(Google·Outlook) 동기화는 별도 기능으로, 이 버전에서는 아직 지원하지 않습니다.'));

    var ai = aiCard(root);

    // ---------------------------------------------------------------- 데이터
    var pathEl = h('code', '확인 중…');
    S.host.dataPath().then(function (p) { pathEl.textContent = p || '(알 수 없음)'; }, function () { pathEl.textContent = '(확인하지 못했습니다)'; });
    var data = h('section.card.settings-card', { 'aria-labelledby': 'set-data' },
      h('h3#set-data', '데이터'),
      h('div.help', '모든 데이터는 이 컴퓨터에만 저장됩니다.'),
      h('div.status-line', h('span', '저장 위치: '), pathEl),
      h('div.sug-actions',
        h('button.btn.btn-sm', { type: 'button', onclick: function () { S.host.revealData(); } }, '폴더 열기'),
        h('button.btn.btn-sm', {
          type: 'button', onclick: function () {
            S.flush();
            S.host.exportFile('daynote-백업-' + D.ymd(A().now()) + '.json', JSON.stringify(S.state, null, 2)).then(function (res) {
              if (res && res.canceled) return;
              if (res && res.ok === false) ui.toast('백업을 내보내지 못했습니다' + (res.error ? ': ' + res.error : '.'), { error: true });
              else ui.toast('전체 백업을 JSON 파일로 내보냈습니다.');
            });
          }
        }, ui.icon('download'), '전체 백업 내보내기'),
        st.meta.sampleLoaded
          ? h('button.btn.btn-sm.btn-danger', { type: 'button', onclick: function () { A().clearSample(); } }, '샘플 지우기')
          : h('button.btn.btn-sm', { type: 'button', onclick: function () { A().loadSample(); } }, '샘플 불러오기')));

    // ---------------------------------------------------------------- 화면
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
      onchange: function () { S.mutate(null, function (s) { s.prefs.reduceMotion = motion.checked; }); }
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
      ['/', '입력창·검색 칸으로 (홈·보관함·할 일)'],
      ['Enter / Shift + Enter', '보내기 / 줄바꿈'],
      ['Ctrl + N', '빠른 메모 창'],
      ['Ctrl + Z', '되돌리기 (입력 칸 밖에서)'],
      ['Alt + ↑ / ↓', '오늘 할 일·메모 순서 바꾸기'],
      ['Ctrl + \\', '사이드바 접기/펴기'],
      ['Ctrl + Shift + T', '메모에서 문장을 선택한 뒤 할 일로 만들기'],
      ['Esc', '메뉴·상세 패널·대화상자 닫기']
    ];
    var view = h('section.card.settings-card', { 'aria-labelledby': 'set-view' },
      h('h3#set-view', '화면'),
      h('div.settings-row', h('div.grow', h('div.lbl', '테마'), h('div.help', '‘시스템’은 Windows의 밝게/어둡게 설정을 따라가요.')), themeSeg),
      h('label.check-row', { for: 'set-motion' }, motion, '모션 줄이기 (애니메이션 끄기)'),
      h('label.check-row', { for: 'set-tray' }, tray, '창을 닫으면 트레이로 숨기기 (빠른 메모 단축키를 계속 쓸 수 있어요)'),
      h('h3', { style: { marginTop: '16px' } }, '단축키'),
      h('table', { style: { borderCollapse: 'collapse', fontSize: '13.5px' } }, KEYS.map(function (k) {
        return h('tr', h('td', { style: { padding: '4px 16px 4px 0', whiteSpace: 'nowrap' } }, h('kbd', k[0])), h('td.help', { style: { padding: '4px 0' } }, k[1]));
      })));

    root.appendChild(h('div.view-pad',
      h('div.page-head', h('div', h('div.page-title', '연결과 설정'), h('div.page-sub', '외부 연결 상태와 데이터, 화면 설정을 관리합니다.'))),
      mail, cal, ai, data, view));
    return {};
  }

  DN.views = DN.views || {};
  DN.views.settings = { title: '연결과 설정', render: render };
})();
