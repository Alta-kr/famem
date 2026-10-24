'use strict';

// 로그인 화면 — Daynote 는 구글 계정으로 로그인해야 쓴다 (데스크톱 앱).
//   로그인은 기본 브라우저에서 하고 돌아온다. 데이터는 지금처럼 이 컴퓨터에만 있다.
//   브라우저 미리보기(host.auth 없음)와 검사 실행(smoke·shots)은 이 화면 없이 바로 시작한다.
(function () {
  var DN = window.Daynote;
  var ui = DN.ui, h = ui.h;

  // 구글 로그인 버튼의 G 표시 (Google 브랜드 안내의 네 가지 색)
  function gLogo() {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 48 48'); svg.setAttribute('width', '18'); svg.setAttribute('height', '18'); svg.setAttribute('aria-hidden', 'true');
    [['#EA4335', 'M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z'],
     ['#4285F4', 'M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z'],
     ['#FBBC05', 'M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z'],
     ['#34A853', 'M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z']
    ].forEach(function (p) { var e = document.createElementNS(NS, 'path'); e.setAttribute('fill', p[0]); e.setAttribute('d', p[1]); svg.appendChild(e); });
    return svg;
  }

  // st: auth.status() 결과 · onDone: 로그인되면 부른다
  function show(auth, st, onDone) {
    var root = document.getElementById('app');
    root.textContent = '';
    var msg = h('p.login-msg', { role: 'status', 'aria-live': 'polite' });
    var cancelBtn = h('button.btn.btn-ghost.btn-sm', { type: 'button', hidden: true, onclick: function () { auth.cancel(); } }, '취소');
    var btn = h('button.login-google', { type: 'button', onclick: go }, gLogo(), h('span', 'Google 계정으로 로그인'));

    function setMsg(text, kind) { msg.textContent = text || ''; msg.className = 'login-msg' + (kind ? ' is-' + kind : ''); }
    function go() {
      btn.disabled = true; cancelBtn.hidden = false;
      setMsg(st.waitText || '브라우저에서 로그인을 마쳐 주세요. 끝나면 자동으로 돌아와요.', 'wait');
      auth.signIn().then(function (r) {
        btn.disabled = false; cancelBtn.hidden = true;
        if (r && r.ok) { setMsg(r.user.email + ' 계정으로 로그인했어요.', 'ok'); setTimeout(onDone, 300); return; }
        setMsg((r && r.message) || '로그인하지 못했어요.', r && r.error === 'cancelled' ? '' : 'err');
        if (r && r.error === 'not_configured') renderSetup();
      }, function () {
        btn.disabled = false; cancelBtn.hidden = true;
        setMsg('로그인하지 못했어요. 다시 시도해 주세요.', 'err');
      });
    }

    var setupBox = h('div.login-setup');
    function renderSetup() {
      setupBox.textContent = '';
      setupBox.appendChild(h('div',
        h('b', '처음 한 번 설정이 필요해요'),
        h('ol',
          h('li', 'Google Cloud 콘솔에서 OAuth 동의 화면을 만들고, ‘데스크톱 앱’ 종류의 OAuth 클라이언트 ID를 만드세요.'),
          h('li', 'Daynote 폴더의 ', h('code', '.env'), ' 파일에 두 줄을 넣으세요: ', h('code', 'GOOGLE_OAUTH_CLIENT_ID=…'), ' · ', h('code', 'GOOGLE_OAUTH_CLIENT_SECRET=…')),
          h('li', 'Daynote를 완전히 끄고(트레이 → 끝내기) 다시 켜세요.'))));
    }

    var card = h('div.login-card',
      h('div.login-brand', h('div.brand-mark', { 'aria-hidden': 'true' }, 'D'), h('span', 'Daynote')),
      h('h1.login-title', st.owner ? '다시 로그인해 주세요' : 'Google 계정으로 시작하기'),
      h('p.login-sub', st.subText ? st.subText : st.owner
        ? '이 컴퓨터의 Daynote는 ' + st.owner + ' 계정으로 쓰고 있어요.'
        : '처음 로그인한 계정이 이 컴퓨터 Daynote의 주인이 돼요. 메모·할 일은 지금처럼 이 컴퓨터에만 저장돼요.'),
      btn, h('div.login-row', msg, cancelBtn), setupBox,
      h('p.login-fine', st.fineText || 'Daynote는 이름과 이메일 주소만 받아요. 메일·드라이브 같은 다른 정보에는 접근하지 않아요.'));
    root.appendChild(h('div.login-screen', card));
    if (!st.configured) { setMsg('구글 로그인 설정(클라이언트 ID)이 아직 없어요.', 'err'); renderSetup(); btn.disabled = true; }
    else setTimeout(function () { btn.focus(); }, 0);
  }

  DN.login = { show: show };
})();
