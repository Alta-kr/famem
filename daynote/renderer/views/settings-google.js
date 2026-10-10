'use strict';

// 설정 › ‘캘린더’(Google 캘린더) 카드 (DN.settingsCards.google) — GOOGLE §9.1 · 부록 A.
//
//  - 상태(GoogleStatus.state)마다 다른 내용: 쓸 수 없음 / 준비 필요(클라이언트 붙여 넣기) / 연결 전 / 로그인 기다리는 중 /
//    연결됨(가져올 캘린더 · Daynote 일정 올리기 · 상태와 동작) / 다시 로그인 필요 / 연결 설정 오류. 그리고 ‘고급’.
//  - 이 카드만 다시 그린다: 동기화 엔진(DN.gcalSync.onChange)과 source 'gcal'|'gcal-settings' 변경일 때.
//    입력칸에 포커스가 있거나(또는 준비 필요 상태에서 값을 넣어 둔 채면) 다시 그리지 않는다 — 입력 중인 값을 지키려고.
//  - 화면은 토큰·보안 비밀번호를 받지 않는다. 클라이언트는 ‘1234…apps.googleusercontent.com’ 같은 힌트로만 보인다.

(function () {
  var DN = window.Daynote;
  DN.settingsCards = DN.settingsCards || {};

  var CONSOLE_URL = 'https://console.cloud.google.com/auth/clients';
  var CONNECTIONS_URL = 'https://myaccount.google.com/connections';
  var BROWSER_REASON = 'Google 캘린더 연결은 데스크톱 앱에서만 쓸 수 있어요.';
  var SOURCE_TEXT = { saved: '이 앱에 저장', env: '환경변수', dotenv: '앱 폴더의 .env' };

  // 부록 A — 오류 type → 문구와 다음 행동
  var ERR = {
    unavailable: { text: BROWSER_REASON },
    not_configured: { text: '먼저 Google Cloud에서 만든 클라이언트를 붙여 넣어 주세요.', act: 'guide' },
    invalid_client_input: { text: '클라이언트 ID 형식이 맞지 않아요. ‘…apps.googleusercontent.com’으로 끝나는 값을 붙여 넣어 주세요.' },
    needs_secret: { text: '이 클라이언트는 보안 비밀번호가 필요해요. 콘솔에서 복사한 보안 비밀번호를 함께 붙여 넣어 주세요.', act: 'client' },
    invalid_client: { text: '클라이언트 ID나 보안 비밀번호가 맞지 않아요. 다시 확인해 주세요.', act: 'client' },
    denied: { text: '권한 허용이 취소됐어요. 테스트 사용자로 추가한 계정인지 확인해 주세요.', act: 'signin' },
    timeout: { text: '5분 안에 로그인이 끝나지 않아 연결을 멈췄어요.', act: 'signin' },
    listen_failed: { text: '로그인 창을 받을 준비를 하지 못했어요. 잠시 뒤 다시 시도해 주세요.', act: 'retry' },
    bad_id_token: { text: '로그인 확인에 실패했어요. 잠시 뒤 다시 시도해 주세요.', act: 'retry' },
    no_refresh_token: { text: '로그인 정보를 받지 못했어요. 잠시 뒤 다시 시도해 주세요.', act: 'retry' },
    reauth: { text: 'Google 로그인이 만료됐어요. 다시 연결해 주세요.', act: 'signin' },
    invalid_grant: { text: 'Google 로그인이 만료됐어요. 다시 연결해 주세요.', act: 'signin' },
    auth: { text: 'Google 로그인이 만료됐어요. 다시 연결해 주세요.', act: 'signin' },
    needs_scope: { text: '캘린더 권한이 허용되지 않았어요. 다시 연결할 때 모든 항목에 체크해 주세요.', act: 'signin' },
    network: { text: '인터넷에 연결되지 않아 동기화를 미뤘어요. 연결되면 다시 할게요.', act: 'sync' },
    rate_limit: { text: 'Google이 잠시 요청을 막았어요. {N}분 뒤 다시 할게요.' },
    quota: { text: '오늘 쓸 수 있는 Google 요청량을 다 썼어요. 잠시 뒤 다시 할게요.' },
    server: { text: 'Google 서버 문제로 동기화하지 못했어요. 잠시 뒤 다시 할게요.', act: 'sync' },
    calendar_missing: { text: 'Google에서 ‘Daynote’ 캘린더를 찾을 수 없어요.', act: 'recreate' },
    write_denied: { text: '‘Daynote’ 캘린더에 쓸 권한이 없어요. 다시 연결해 주세요.', act: 'signin' },
    bad_request: { text: '일정 1개는 Google이 받지 않았어요. 시간을 확인해 주세요.' },
    unknown: { text: '알 수 없는 오류로 동기화하지 못했어요.', act: 'sync' }
  };
  var ACT_LABEL = { guide: '설정 방법 보기', client: '클라이언트 바꾸기', signin: '다시 연결', retry: '다시 시도', sync: '지금 동기화', recreate: '다시 만들기' };

  // 다시 그려도 남는 화면 값
  var mem = { advOpen: false, jsonMode: false, changingClient: false, err: null, busy: null, draft: null, refocus: null };
  var root = null, unsub = null, pending = false;

  function h() { return DN.ui.h.apply(null, arguments); }
  function ui() { return DN.ui; }
  function GS() { return DN.gcalSync || null; }
  function S() { return DN.store; }
  function now() { return DN.app && DN.app.now ? DN.app.now() : new Date(); }
  function status() {
    var g = GS();
    if (!g) return { available: false, state: 'unavailable', signedIn: false, reason: BROWSER_REASON };
    return g.status() || { available: false, state: 'loading', signedIn: false };
  }
  function gcal() { var s = S() && S().state; return (s && s.gcal) || null; }

  function errText(e) {
    if (!e) return '';
    var m = ERR[e.type];
    if (!m) return e.message || ERR.unknown.text;
    if (e.type === 'invalid_client_input' && e.message) return e.message;
    var text = m.text;
    if (text.indexOf('{N}') >= 0) {
      var g = gcal(), until = g && g.backoffUntil ? new Date(g.backoffUntil).getTime() : NaN;
      var n = isNaN(until) ? 1 : Math.max(1, Math.ceil((until - now().getTime()) / 60000));
      text = text.replace('{N}', String(n));
    }
    return text;
  }

  function statusLine(dot, kids) {
    return h('div.status-line', dot ? h('span.status-dot.' + dot) : null, kids);
  }

  function scopes(st) { return st.scopes || { calendarList: true, eventsRead: true, appCalendar: true }; }

  // ---------------------------------------------------------------- 동작
  function act(kind) {
    var g = GS();
    if (!g) return;
    if (kind === 'guide') guideModal();
    else if (kind === 'client') { mem.changingClient = true; mem.err = null; paint(true); focusId('gc-id'); }
    else if (kind === 'signin' || kind === 'retry') doSignIn();
    else if (kind === 'sync') g.syncNow({ reason: 'manual' });
    else if (kind === 'recreate') {
      mem.err = null;
      g.ensureExportCalendar().then(function (r) {          // 실패하면 이유를 카드 위쪽에 보여 준다
        if (r && r.ok === false) { mem.err = r.error || { type: 'unknown' }; paint(true); }
      });
    }
  }

  function actBtn(kind, primary) {
    if (!kind || !ACT_LABEL[kind]) return null;
    return h('button.btn.btn-sm' + (primary ? '.btn-primary' : ''), { type: 'button', id: 'gc-act-' + kind, onclick: function () { act(kind); } }, ACT_LABEL[kind]);
  }

  function errBox(e, extra) {
    if (!e || e.type === 'canceled') return null;
    var m = ERR[e.type] || ERR.unknown;
    return h('div.conflict-box.gcal-alert', { role: 'alert' }, h('div', errText(e)),
      (m.act || extra) ? h('div.gcal-actions', actBtn(m.act), extra || null) : null);
  }

  function doSignIn() {
    var g = GS();
    if (!g || mem.busy === 'signin') return;
    mem.err = null; mem.busy = 'signin';
    g.signIn().then(function (res) {
      mem.busy = null;
      if (!res || !res.ok) mem.err = (res && res.error) || null;
      paint(true);
    });
  }

  function doCancel() {
    var g = GS();
    if (g) g.cancelSignIn().then(function () { mem.busy = null; paint(true); });
  }

  function doSignOut() {
    ui().confirm('Google 연결을 해제할까요?',
      '이 컴퓨터에 저장된 Google 로그인 정보를 지우고 Google에도 권한 해제를 요청해요. 가져온 Google 일정은 Daynote에서 사라져요. Google 캘린더의 ‘Daynote’ 캘린더와 그 일정은 그대로 남아요.',
      '연결 해제').then(function (ok) {
      if (!ok || !GS()) return;
      mem.busy = 'signout';
      GS().signOut().then(function (res) {
        mem.busy = null;
        if (!res || !res.ok) mem.err = (res && res.error) || { type: 'unknown' };
        paint(true);
      });
    });
  }

  function readDraft() {
    if (!root) return null;
    var id = root.querySelector('#gc-id'), sec = root.querySelector('#gc-secret'), js = root.querySelector('#gc-json');
    return { id: id ? id.value : '', secret: sec ? sec.value : '', json: js ? js.value : '' };
  }

  function saveClient() {
    var g = GS();
    if (!g || mem.busy === 'save') return;
    var d = readDraft() || { id: '', secret: '', json: '' };
    var input = mem.jsonMode ? { text: d.json } : { clientId: d.id, clientSecret: d.secret };
    if (mem.jsonMode ? !d.json.trim() : !d.id.trim()) {
      mem.draft = d;
      mem.err = { type: 'invalid_client_input', message: mem.jsonMode ? '내려받은 JSON 파일 내용을 붙여 넣어 주세요.' : '' };
      paint(true);
      focusId(mem.jsonMode ? 'gc-json' : 'gc-id');
      return;
    }
    var go = function () {
      mem.busy = 'save'; mem.draft = d; mem.err = null;
      paint(true);
      g.setClient(input).then(function (res) {
        mem.busy = null;
        if (res && res.ok) {
          mem.draft = null; mem.changingClient = false; mem.jsonMode = false; mem.err = null;
          ui().toast('클라이언트를 저장했어요.');
          paint(true);
          focusId('gc-signin');
        } else {
          mem.err = (res && res.error) || { type: 'unknown' };
          paint(true);
          focusId(mem.jsonMode ? 'gc-json' : 'gc-id');
        }
      });
    };
    if (status().signedIn) {
      ui().confirm('클라이언트를 바꿀까요?', '클라이언트를 바꾸면 지금 로그인은 쓸 수 없어서 연결을 해제해요. 저장한 뒤 새 클라이언트로 다시 연결해 주세요.', '바꾸기')
        .then(function (ok) {
          if (!ok) return;
          g.signOut().then(function () { go(); });
        });
      return;
    }
    go();
  }

  function clearSaved() {
    ui().confirm('저장한 클라이언트를 지울까요?', '이 앱에 저장한 클라이언트 ID와 보안 비밀번호를 지워요. 환경변수나 .env 에 넣은 값이 있으면 그 값을 써요.', '지우기')
      .then(function (ok) {
        if (!ok || !GS()) return;
        GS().clearClient().then(function (res) {
          if (res && !res.ok) mem.err = res.error || null;
          paint(true);
        });
      });
  }

  function guideModal() {
    var steps = [
      ['프로젝트 만들기', 'console.cloud.google.com에서 새 프로젝트를 만들어요. 이름은 ‘Daynote’면 돼요.'],
      ['Calendar API 켜기', 'API 및 서비스 › 라이브러리에서 ‘Google Calendar API’를 찾아 사용을 눌러요.'],
      ['동의 화면', 'Google 인증 플랫폼 › 시작하기에서 앱 이름 ‘Daynote’, 대상은 외부(External)로 만들어요. 게시 상태는 테스트 그대로 둬요.'],
      ['테스트 사용자 추가', '대상 › 테스트 사용자에 Daynote에 연결할 Gmail 주소를 넣어요. 여기에 없는 계정은 ‘액세스 차단됨’이 떠요.'],
      ['범위 추가(권장)', '데이터 액세스에서 calendar.calendarlist.readonly · calendar.events.readonly · calendar.app.created 세 개를 체크해요.'],
      ['OAuth 클라이언트 만들기', '클라이언트 › 클라이언트 만들기에서 유형을 ‘데스크톱 앱’으로 골라요. 보안 비밀번호는 만들 때 한 번만 보여요.'],
      ['Daynote에 붙여 넣기', '클라이언트 ID와 보안 비밀번호를 붙여 넣거나, 내려받은 JSON 내용을 통째로 붙여 넣고 저장해요. 그다음 ‘Google 계정으로 연결’을 눌러요.']
    ];
    var body = [
      h('p.help', '처음 한 번, 10분쯤 걸려요. 아직 Google 앱 확인을 받기 전이라 본인 Google Cloud 프로젝트에서 클라이언트를 만들어야 해요.'),
      h('ol.gcal-steps', steps.map(function (s) { return h('li', h('b', s[0]), h('span', s[1])); })),
      h('p.help', '브라우저에서 ‘Google에서 확인하지 않은 앱’이 보이면 고급 › Daynote(으)로 이동을 누르고, 권한 화면에서 모든 항목에 체크해 주세요. 테스트 모드 앱은 7일마다 다시 로그인해야 해요.')
    ];
    ui().modal({
      title: 'Google 캘린더 연결 준비', wide: true, body: body,
      footLeft: h('button.btn', { type: 'button', onclick: function () { window.open(CONSOLE_URL); } }, ui().icon('link'), 'Google Cloud 콘솔 열기'),
      actions: [{ label: '닫기', primary: true }]
    });
  }

  // 올리기 끄기 — 앞으로의 올린 일정이 있으면 어떻게 할지 묻는다
  function turnExportOff(box) {
    var g = gcal(), t = now().getTime(), n = 0;
    if (g && g.links) Object.keys(g.links).forEach(function (id) {
      var L = g.links[id], e = L && L.end ? new Date(L.end).getTime() : NaN;
      if (L && (isNaN(e) || e > t)) n++;
    });
    if (!n) { GS().setExport({ exportEnabled: false }, { removeFuture: false }); return; }
    var decided = false;
    ui().modal({
      title: 'Daynote 일정 올리기를 끌까요?',
      body: h('p', { style: { margin: 0, lineHeight: 1.6 } }, 'Google에 올린 앞으로의 일정 ' + n + '개를 어떻게 할까요?'),
      actions: [
        { label: '그대로 두기', onClick: function () { decided = true; GS().setExport({ exportEnabled: false }, { removeFuture: false }); } },
        { label: 'Google에서도 지우기', danger: true, onClick: function () { decided = true; GS().setExport({ exportEnabled: false }, { removeFuture: true }); } }
      ],
      onClose: function () { if (!decided && box) { box.checked = true; } }
    });
  }

  // ---------------------------------------------------------------- 부분
  function scopeParagraph() {
    return h('p.help.gcal-scope', '가져오기: 고른 캘린더의 일정 제목·시간·장소만 읽어 캘린더 화면과 ‘다음 할 일’ 추천의 바쁜 시간에 써요. Google 일정은 Daynote에서 바꾸지 않아요. 올리기: Daynote가 만든 ‘Daynote’ 캘린더에만 써요. 다른 캘린더는 건드리지 않아요.');
  }

  function avatar(st) {
    if (st.picture && /^data:image\//.test(st.picture)) return h('img.gcal-avatar', { src: st.picture, alt: '' });
    var name = st.name || st.email || '?';
    return h('span.gcal-avatar.is-letter', { 'aria-hidden': 'true' }, name.charAt(0).toUpperCase());
  }

  function setupForm(st) {
    var d = mem.draft || { id: '', secret: '', json: '' };
    var busy = mem.busy === 'save';
    function onEnter(e) { if (e.key === 'Enter' && !e.isComposing && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); saveClient(); } }
    var fields = mem.jsonMode
      ? [h('div.field',
          h('label', { for: 'gc-json' }, 'JSON 내용'),
          h('textarea.input.gcal-json#gc-json', { rows: '5', spellcheck: 'false', placeholder: '{"installed":{"client_id":"…","client_secret":"…"}}', value: d.json, disabled: busy })),
        h('button.link-btn', { type: 'button', id: 'gc-mode', onclick: function () { mem.jsonMode = false; mem.draft = null; mem.err = null; paint(true); focusId('gc-id'); } }, '클라이언트 ID로 붙여 넣기')]
      : [h('div.field',
          h('label', { for: 'gc-id' }, '클라이언트 ID'),
          h('input.input#gc-id', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: '1234-abc.apps.googleusercontent.com', value: d.id, disabled: busy, onkeydown: onEnter })),
        h('div.field',
          h('label', { for: 'gc-secret' }, '클라이언트 보안 비밀번호'),
          h('input.input#gc-secret', { type: 'password', autocomplete: 'off', placeholder: 'GOCSPX-로 시작해요', value: d.secret, disabled: busy, onkeydown: onEnter })),
        h('button.link-btn', { type: 'button', id: 'gc-mode', onclick: function () { mem.jsonMode = true; mem.draft = null; mem.err = null; paint(true); focusId('gc-json'); } }, 'JSON 내용으로 붙여 넣기')];
    return h('div.gcal-setup',
      st.state === 'needs_setup' ? statusLine(null, h('b', '준비 필요')) : statusLine(null, h('b', '클라이언트 바꾸기')),
      h('p.help', 'Google 캘린더를 연결하려면 Google Cloud에서 ‘데스크톱 앱’용 OAuth 클라이언트를 한 번 만들어 붙여 넣어야 해요. 10분쯤 걸려요.'),
      h('div.gcal-actions', h('button.btn.btn-sm', { type: 'button', id: 'gc-guide', onclick: guideModal }, '설정 방법 보기')),
      h('div.gcal-form', fields),
      mem.err ? errBox(mem.err) : null,
      h('div.gcal-actions',
        h('button.btn.btn-primary', { type: 'button', id: 'gc-save', disabled: busy, onclick: saveClient }, busy ? '저장하는 중…' : '저장'),
        mem.changingClient ? h('button.btn', { type: 'button', id: 'gc-change-cancel', onclick: function () { mem.changingClient = false; mem.draft = null; mem.err = null; mem.jsonMode = false; paint(true); } }, '취소') : null),
      h('p.help', '보안 비밀번호는 이 컴퓨터에 암호화해 두고 화면에 다시 보여 주지 않아요.'));
  }

  function calendarGroup(st) {
    var sc = scopes(st);
    var head = h('h4.settings-sub', '가져올 캘린더');
    if (!sc.calendarList || !sc.eventsRead) {
      return [head, h('div.conflict-box.gcal-alert', { role: 'alert' },
        h('div', '캘린더 권한이 허용되지 않았어요. ‘다시 연결’에서 모든 항목에 체크해 주세요.'),
        h('div.gcal-actions', actBtn('signin')))];
    }
    var g = gcal();
    var cals = ((g && g.calendars) || []).filter(function (c) { return c && !c.isExport; });
    if (!cals.length) {
      var ph = GS() ? GS().phase() : 'idle';
      return [head, h('p.help', ph === 'syncing' ? '캘린더 목록을 가져오는 중이에요.' : '아직 캘린더 목록이 없어요. ‘지금 동기화’를 눌러 주세요.')];
    }
    var anyFb = false;
    var list = h('ul.gcal-cal-list', cals.map(function (c, i) {
      var id = 'gc-cal-' + i;
      var fb = c.accessRole === 'freeBusyReader';
      if (fb) anyFb = true;
      var dot = h('span.gcal-dot', { 'aria-hidden': 'true' });
      if (c.color) dot.style.setProperty('--gc', c.color);
      var box = h('input', { type: 'checkbox', id: id, checked: !!c.selected && !fb, disabled: fb,
        onchange: function (e) { if (GS()) GS().setSelected(c.id, e.target.checked); } });
      return h('li.gcal-cal' + (fb ? '.is-disabled' : ''),
        h('label.check-row', { for: id }, box, dot, h('span.gcal-cal-name', c.summary || c.id),
          c.primary ? h('span.chip', '기본') : null,
          c.error && c.selected ? h('span.chip.chip-overdue', '받지 못함') : null));
    }));
    return [head, list, anyFb ? h('p.help', '바쁨 정보만 볼 수 있는 캘린더는 아직 못 가져와요.') : null];
  }

  function exportGroup(st, sum) {
    var g = gcal();
    var set = (g && g.settings) || { exportEnabled: true, exportWork: true, exportTitles: true };
    var sc = scopes(st);
    var exp = h('input#gc-export', { type: 'checkbox', checked: !!set.exportEnabled,
      onchange: function (e) {
        if (!GS()) return;
        if (e.target.checked) GS().setExport({ exportEnabled: true });
        else turnExportOff(e.target);
      } });
    var work = h('input#gc-work', { type: 'checkbox', checked: !!set.exportWork, disabled: !set.exportEnabled,
      onchange: function (e) { if (GS()) GS().setExport({ exportWork: e.target.checked }); } });
    var titles = h('input#gc-titles', { type: 'checkbox', checked: !!set.exportTitles, disabled: !set.exportEnabled,
      onchange: function (e) { if (GS()) GS().setExport({ exportTitles: e.target.checked }); } });
    var problem = null;
    if (set.exportEnabled && sum && sum.exportError === 'calendar_missing') {
      problem = h('div.conflict-box.gcal-alert', { role: 'alert' }, h('div', ERR.calendar_missing.text),
        h('div.gcal-actions', actBtn('recreate'),
          h('button.btn.btn-sm', { type: 'button', id: 'gc-export-off', onclick: function () { turnExportOff(null); } }, '올리기 끄기')));
    } else if (set.exportEnabled && sum && sum.exportError === 'write_denied') {
      problem = errBox({ type: 'write_denied' });
    }
    return [
      h('h4.settings-sub', 'Daynote 일정 올리기'),
      h('label.check-row', { for: 'gc-export' }, exp, 'Daynote에서 만든 일정을 Google 캘린더 ‘Daynote’에 올리기'),
      h('div.gcal-sub-rows',
        h('label.check-row', { for: 'gc-work' }, work, '작업 시간도 올리기'),
        h('label.check-row', { for: 'gc-titles' }, titles, '제목 그대로 올리기 (끄면 ‘바쁨’으로만 보여요)')),
      !sc.appCalendar ? h('p.help', 'Daynote 캘린더를 만들 권한이 없어요. 다시 연결해 주세요.') : null,
      sum && sum.draining ? h('p.help', 'Google에서 지울 일정 ' + sum.draining + '개를 정리하고 있어요.') : null,
      problem
    ];
  }

  function syncLine(sum) {
    var D = DN.dates, t = now();
    var parts = [];
    if (sum.lastSyncAt) {
      var d = new Date(sum.lastSyncAt);
      parts.push('마지막 동기화: ' + D.relDay(D.ymd(d), t) + ' ' + D.hm(d));
    } else {
      parts.push('아직 동기화하지 않았어요');
    }
    parts.push('가져온 일정 ' + sum.events + '개');
    parts.push('올릴 일정 ' + sum.pending + '개');
    if (sum.failed) parts.push('올리지 못한 일정 ' + sum.failed + '개');
    return h('div.help.gcal-sync-line', { id: 'gc-sync-line' }, parts.join(' · '));
  }

  function statusGroup(st, sum) {
    var ph = GS() ? GS().phase() : 'idle';
    var syncing = ph === 'syncing' || ph === 'pushing';
    var g = gcal();
    var last = g && g.lastError && g.lastError.type !== 'calendar_missing' && g.lastError.type !== 'write_denied' ? g.lastError : null;
    return [
      h('h4.settings-sub', '상태'),
      syncLine(sum),
      last ? errBox(last) : null,
      h('div.gcal-actions',
        h('button.btn.btn-sm', { type: 'button', id: 'gc-sync', disabled: syncing, 'aria-busy': syncing ? 'true' : 'false',
          onclick: function () { if (GS()) GS().syncNow({ reason: 'manual' }); } },
          ui().icon('refresh'), syncing ? '동기화 중…' : '지금 동기화'),
        h('button.btn.btn-sm.btn-danger', { type: 'button', id: 'gc-signout', disabled: mem.busy === 'signout', onclick: doSignOut }, '연결 해제')),
      scopeParagraph()
    ];
  }

  function advanced(st) {
    var c = st.client || {};
    var sc = scopes(st);
    function mark(b) { return b ? ' ✓' : ' ✗'; }
    var det = h('details.settings-adv.gcal-adv#gc-adv', { open: mem.advOpen },
      h('summary#gc-adv-sum', ui().icon('chevronDown'), '고급'),
      h('p.help', '클라이언트: ' + (c.idHint || '없음') + (c.source && SOURCE_TEXT[c.source] ? ' (' + SOURCE_TEXT[c.source] + ')' : '')),
      h('div.gcal-actions',
        st.state !== 'needs_setup' ? h('button.btn.btn-sm', { type: 'button', id: 'gc-change', onclick: function () { act('client'); } }, '클라이언트 바꾸기') : null,
        c.source === 'saved' ? h('button.btn.btn-sm', { type: 'button', id: 'gc-clear', onclick: clearSaved }, '저장한 클라이언트 지우기') : null),
      st.signedIn ? h('p.help', '권한: 캘린더 목록 보기' + mark(sc.calendarList) + ' · 일정 보기' + mark(sc.eventsRead) + ' · Daynote 캘린더 쓰기' + mark(sc.appCalendar)) : null,
      h('p.help', '테스트 모드 앱은 7일마다 다시 로그인해야 해요.'),
      h('button.link-btn', { type: 'button', id: 'gc-connections', onclick: function () { window.open(CONNECTIONS_URL); } }, 'Google 계정에서 연결된 앱 보기'));
    det.addEventListener('toggle', function () { mem.advOpen = det.open; });
    return det;
  }

  function body(st) {
    var state = st.state;
    if (state === 'loading') return [statusLine(null, h('span', '연결 상태를 확인하는 중이에요…'))];
    if (!st.available || state === 'unavailable') {
      var reason = st.reason || BROWSER_REASON;
      return [
        statusLine(null, h('b', reason)),
        h('p.help', 'Google 로그인은 Daynote 데스크톱 앱에서 브라우저를 열어 진행해요. 웹 미리보기에서는 앱 안 캘린더만 써요.')
      ];
    }
    if (state === 'needs_setup' || mem.changingClient) return [setupForm(st), state !== 'needs_setup' ? advanced(st) : null];

    if (state === 'connecting') {
      return [
        statusLine('busy', h('b', '브라우저에서 로그인을 기다리는 중…')),
        h('p.help', '열린 브라우저에서 계정을 고르고 ‘허용’을 눌러 주세요. 모든 항목에 체크해야 캘린더를 가져올 수 있어요.'),
        h('div.gcal-actions', h('button.btn', { type: 'button', id: 'gc-cancel', onclick: doCancel }, '취소'))
      ];
    }
    if (state === 'signed_out') {
      return [
        statusLine(null, h('b', '연결 전')),
        scopeParagraph(),
        mem.err ? errBox(mem.err) : null,
        h('div.gcal-actions', h('button.btn.btn-primary', { type: 'button', id: 'gc-signin', disabled: mem.busy === 'signin', onclick: doSignIn },
          ui().icon('calendar'), 'Google 계정으로 연결')),
        advanced(st)
      ];
    }
    if (state === 'reauth') {
      return [
        statusLine('err', [h('b', '다시 로그인이 필요해요'), st.email ? h('span', ' · ' + st.email) : null]),
        h('p.help', '로그인이 만료됐어요. 테스트 모드 앱은 Google 정책상 7일마다 만료돼요.'),
        mem.err ? errBox(mem.err) : null,
        h('div.gcal-actions',
          h('button.btn.btn-primary', { type: 'button', id: 'gc-signin', disabled: mem.busy === 'signin', onclick: doSignIn }, '다시 연결'),
          h('button.btn.btn-danger', { type: 'button', id: 'gc-signout', onclick: doSignOut }, '연결 해제')),
        advanced(st)
      ];
    }
    if (state === 'error') {
      var e = st.error || { type: 'invalid_client' };
      return [
        statusLine('err', h('b', '연결 설정 오류')),
        h('div.conflict-box.gcal-alert', { role: 'alert' }, h('div', errText(e)),
          h('div.gcal-actions', h('button.btn.btn-sm', { type: 'button', id: 'gc-change-err', onclick: function () { act('client'); } }, '클라이언트 바꾸기'))),
        advanced(st)
      ];
    }
    // signed_in
    var sum = DN.gcal && S() ? DN.gcal.summary(S().state, now()) : { events: 0, pending: 0, failed: 0, lastSyncAt: null, draining: 0 };
    return [
      statusLine('ok', [h('b', '연결됨'), st.email ? h('span', ' · ') : null, st.email ? h('b', st.email) : null]),
      h('div.gcal-account', avatar(st), h('div.gcal-account-text', h('b', st.name || st.email || 'Google 계정'), st.name && st.email ? h('span.help', st.email) : null)),
      mem.err ? errBox(mem.err) : null,
      h('div.gcal-group', calendarGroup(st)),
      h('div.gcal-group', exportGroup(st, sum)),
      h('div.gcal-group', statusGroup(st, sum)),
      advanced(st)
    ];
  }

  // ---------------------------------------------------------------- 그리기
  function focusId(id) {
    setTimeout(function () { var el = root && root.querySelector('#' + id); if (el && !el.disabled) try { el.focus(); } catch (e) {} }, 0);
  }

  // 입력 중이면 다시 그리지 않는다
  function typing() {
    if (!root) return false;
    var a = document.activeElement;
    if (a && root.contains(a) && (a.tagName === 'INPUT' && a.type !== 'checkbox' || a.tagName === 'TEXTAREA')) return true;
    if (status().state === 'needs_setup' || mem.changingClient) {
      var d = readDraft();
      if (d && (d.id || d.secret || d.json)) return true;
    }
    return false;
  }

  function paint(force) {
    if (!root) return;
    if (!force && typing()) { pending = true; return; }
    pending = false;
    var a = document.activeElement;
    var inCard = !!(a && root.contains(a));
    var focusedId = inCard && a.id ? a.id : null;
    var lost = !a || a === document.body || focusedId === 'set-gcal-h';
    if (mem.changingClient || status().state === 'needs_setup') {
      var d = readDraft();
      if (d && (d.id || d.secret || d.json)) mem.draft = d;
    }
    root.textContent = '';
    root.appendChild(h('h3#set-gcal-h', { tabindex: '-1' }, '캘린더'));
    var st = status();
    if (st.state === 'needs_setup') mem.changingClient = false;
    body(st).forEach(function (n) { if (n) root.appendChild(n); });
    // 포커스 되살리기. 누른 버튼이 잠깐 비활성(동기화 중…·연결 중)이 되면 카드 제목에 두었다가, 다시 쓸 수 있게 되면 돌려준다
    //   (키보드 사용자가 [지금 동기화] 뒤에 포커스를 잃지 않게)
    var back = mem.refocus && lost ? root.querySelector('#' + mem.refocus) : null;
    if (back && !back.disabled) { mem.refocus = null; focusEl(back); return; }
    if (!mem.refocus || !lost) mem.refocus = null;
    if (!focusedId) return;
    var el = root.querySelector('#' + focusedId);
    if (el && !el.disabled) { focusEl(el); return; }
    if (focusedId !== 'set-gcal-h') mem.refocus = focusedId;
    focusEl(root.querySelector('#set-gcal-h'));
  }
  function focusEl(el) { if (el) try { el.focus(); } catch (e) {} }

  function render(ctx) {
    void ctx;
    destroy();
    mem.refocus = null;
    root = h('section.card.settings-card.gcal-card#set-gcal', { 'aria-labelledby': 'set-gcal-h' });
    root.addEventListener('focusout', function () {
      setTimeout(function () { if (pending && root && !typing()) paint(); }, 0);
    });
    var g = GS();
    if (g) {
      unsub = g.onChange(function () { paint(); });
      if (g.status().state === 'loading') g.loadStatus();
    }
    paint(true);
    return root;
  }

  function onChange(info) {
    if (!info || info.type !== 'change') return false;
    if (info.source === 'gcal' || info.source === 'gcal-settings') { paint(); return true; }
    return false;
  }

  function destroy() {
    if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
    // 설정 화면 전체를 다시 그릴 때(다른 카드의 변경 등) 붙여 넣던 클라이언트 값을 잃지 않게 남겨 둔다
    if (root && (mem.changingClient || status().state === 'needs_setup')) {
      var d = readDraft();
      if (d && (d.id || d.secret || d.json)) mem.draft = d;
    }
    root = null;
    pending = false;
  }

  DN.settingsCards.google = { render: render, onChange: onChange, destroy: destroy };
})();
