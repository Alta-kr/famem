'use strict';

// 구글 로그인 — 데스크톱 앱용 OAuth 2.0 (설치형 앱 방식, RFC 8252)
//   기본 브라우저에서 로그인 → 이 컴퓨터의 임시 주소(http://127.0.0.1:임의 포트)로 돌아온다 · PKCE(S256) · state 확인
//   Google 은 앱 안 웹뷰 로그인을 막으므로 반드시 기본 브라우저를 쓴다
//   받는 정보: 이름·이메일(openid email profile) 만 — 메일·드라이브 같은 권한은 받지 않는다
//   새로 고침 토큰은 Windows 보안 저장소(DPAPI, safeStorage)로 암호화해 userData 에 둔다. 화면에는 이름·이메일만
//   이 컴퓨터의 Daynote 는 처음 로그인한 계정의 것 — 다른 계정은 들어오지 못한다 (DAYNOTE_ALLOWED_EMAILS 로 더 열 수 있다)
//   메인 프로세스에서만 쓴다

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SCOPES = 'openid email profile';
const WAIT_MS = 5 * 60 * 1000;   // 브라우저에서 로그인을 마칠 때까지

function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}
function authUrl(o) {
  const q = new URLSearchParams({
    client_id: o.clientId, redirect_uri: o.redirectUri, response_type: 'code', scope: SCOPES,
    code_challenge: o.challenge, code_challenge_method: 'S256', state: o.state,
    access_type: 'offline', prompt: 'consent select_account'
  });
  if (o.hint) q.set('login_hint', o.hint);
  return AUTH_URL + '?' + q.toString();
}
// 토큰 주소에서 바로(HTTPS) 받은 id_token 은 서명 확인 없이 내용을 믿어도 된다 (Google OpenID Connect 문서) — 받는 쪽·발급처·만료만 본다
function readIdToken(idToken, clientId, nowMs) {
  const part = String(idToken || '').split('.')[1];
  if (!part) throw new Error('id_token 이 없어요');
  const p = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  if (p.aud !== clientId) throw new Error('다른 앱에 발급된 토큰이에요');
  if (p.iss !== 'https://accounts.google.com' && p.iss !== 'accounts.google.com') throw new Error('Google 이 발급한 토큰이 아니에요');
  if (p.exp && p.exp * 1000 < (nowMs || Date.now()) - 5 * 60 * 1000) throw new Error('토큰이 만료됐어요');
  if (!p.email || p.email_verified === false) throw new Error('확인된 이메일이 없는 계정이에요');
  return { sub: p.sub, email: String(p.email).toLowerCase(), name: p.name || p.email };
}
function maskEmail(e) {
  const m = /^(.)(.*)(@.*)$/.exec(String(e || ''));
  return m ? m[1] + '•'.repeat(Math.min(6, Math.max(2, m[2].length))) + m[3] : '';
}
function page(ok, title, msg) {
  const color = ok ? '#2f7d4f' : '#b3261e';
  return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Daynote 로그인</title>' +
    '<style>body{font-family:"Segoe UI","Malgun Gothic",sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f6f6f8;color:#1d1d1f}' +
    '.c{background:#fff;border-radius:14px;padding:32px 40px;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center;max-width:420px}' +
    'h1{font-size:19px;margin:0 0 10px;color:' + color + '}p{margin:0;color:#555;line-height:1.6}</style></head>' +
    '<body><div class="c"><h1>' + title + '</h1><p>' + msg + '</p></div></body></html>';
}

// opts: { dir, safeStorage, clientId, clientSecret, allowed: 'a@x.com,b@y.com', openExternal(url), fetch?, now? }
function create(opts) {
  const dir = opts.dir;
  const fetchImpl = opts.fetch || ((u, o) => fetch(u, o));
  const clientId = String(opts.clientId || '').trim();
  const clientSecret = String(opts.clientSecret || '').trim();
  const allowed = String(opts.allowed || '').split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const FILE = path.join(dir, 'account.json');
  const TOKEN = path.join(dir, 'account-token.bin');
  let pending = null;

  function readAccount() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (e) { return {}; } }
  function writeAccount(a) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(a, null, 2)); }
  function readToken() {
    try {
      if (!opts.safeStorage || !opts.safeStorage.isEncryptionAvailable()) return '';
      return opts.safeStorage.decryptString(fs.readFileSync(TOKEN));
    } catch (e) { return ''; }
  }
  function writeToken(t) {
    if (!t || !opts.safeStorage || !opts.safeStorage.isEncryptionAvailable()) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN, opts.safeStorage.encryptString(t));
  }
  function clearToken() { try { fs.unlinkSync(TOKEN); } catch (e) {} }

  function configured() { return !!(clientId && clientSecret); }
  function mayUse(email) {
    const a = readAccount();
    if (allowed.length) return allowed.indexOf(email) !== -1;
    return !a.owner || a.owner === email;
  }
  function status() {
    const a = readAccount();
    const u = a.user && mayUse(a.user.email) ? a.user : null;
    return {
      configured: configured(), signedIn: !!u, waiting: !!pending,
      user: u ? { email: u.email, name: u.name } : null,
      owner: a.owner ? maskEmail(a.owner) : null
    };
  }

  async function postForm(url, body) {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
    let json = {};
    try { json = await res.json(); } catch (e) {}
    return { ok: res.ok, status: res.status, json };
  }
  function revoke(token) {
    if (!token) return Promise.resolve();
    return postForm(REVOKE_URL, { token }).catch(() => {});
  }

  function cancel() { if (pending) pending.finish({ ok: false, error: 'cancelled', message: '로그인을 취소했어요.' }); }

  function signIn() {
    if (!configured()) return Promise.resolve({ ok: false, error: 'not_configured', message: '구글 로그인 설정(클라이언트 ID)이 아직 없어요.' });
    cancel();
    return new Promise((resolve) => {
      const { verifier, challenge } = pkce();
      const state = b64url(crypto.randomBytes(16));
      let redirectUri = '', done = false, timer = null;
      const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.pathname !== '/' || done) { res.writeHead(404); res.end(); return; }
        if (u.searchParams.get('state') !== state) { res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page(false, '로그인 요청이 맞지 않아요', 'Daynote 에서 다시 로그인해 주세요.')); return; }
        const err = u.searchParams.get('error');
        const code = u.searchParams.get('code');
        if (err || !code) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(page(false, '로그인하지 않았어요', '이 창을 닫고 Daynote 로 돌아가세요.'));
          finish({ ok: false, error: err === 'access_denied' ? 'denied' : 'failed', message: err === 'access_denied' ? 'Google 에서 로그인을 취소했어요.' : '로그인하지 못했어요.' });
          return;
        }
        exchange(code).then((r) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(r.ok ? page(true, '로그인됐어요', r.user.email + ' 계정으로 로그인했어요.<br>이 창을 닫고 Daynote 로 돌아가세요.')
            : page(false, '로그인하지 못했어요', r.message + '<br>이 창을 닫고 Daynote 로 돌아가세요.'));
          finish(r);
        });
      });
      function finish(r) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pending = null;
        setTimeout(() => { try { server.close(); } catch (e) {} }, 500);   // 브라우저가 결과 쪽을 다 받은 뒤
        resolve(r);
      }
      async function exchange(code) {
        try {
          const r = await postForm(TOKEN_URL, { code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier });
          if (!r.ok) return { ok: false, error: 'token', message: r.json.error === 'invalid_client' ? '클라이언트 ID·보안 비밀이 맞지 않아요.' : '로그인 확인에 실패했어요 (' + (r.json.error || r.status) + ').' };
          const user = readIdToken(r.json.id_token, clientId, opts.now ? opts.now() : Date.now());
          if (!mayUse(user.email)) {
            revoke(r.json.refresh_token || r.json.access_token);
            const a = readAccount();
            return { ok: false, error: 'not_allowed', message: '이 컴퓨터의 Daynote 는 ' + (allowed.length ? '허용된 계정' : maskEmail(a.owner) + ' 계정') + '으로만 쓸 수 있어요.' };
          }
          const a = readAccount();
          if (!a.owner && !allowed.length) a.owner = user.email;
          a.user = user;
          a.signedInAt = new Date().toISOString();
          writeAccount(a);
          clearToken();
          writeToken(r.json.refresh_token);
          return { ok: true, user: { email: user.email, name: user.name } };
        } catch (e) {
          return { ok: false, error: 'network', message: '로그인 확인 중 문제가 생겼어요 — 인터넷 연결을 확인해 주세요.' };
        }
      }
      server.on('error', () => finish({ ok: false, error: 'failed', message: '로그인 창을 준비하지 못했어요.' }));
      server.listen(0, '127.0.0.1', () => {
        redirectUri = 'http://127.0.0.1:' + server.address().port;
        const a = readAccount();
        timer = setTimeout(() => finish({ ok: false, error: 'timeout', message: '5분 안에 로그인을 마치지 않아서 멈췄어요.' }), WAIT_MS);
        pending = { finish };
        Promise.resolve(opts.openExternal(authUrl({ clientId, redirectUri, state, challenge, hint: a.owner }))).catch(() => finish({ ok: false, error: 'failed', message: '브라우저를 열지 못했어요.' }));
      });
    });
  }

  async function signOut() {
    cancel();
    const t = readToken();
    clearToken();
    const a = readAccount();
    delete a.user;
    writeAccount(a);
    await revoke(t);
    return { ok: true };
  }

  // 켤 때 — Google 쪽에서 연결을 끊었으면(계정 권한 해제 등) 로그아웃. 인터넷이 안 되면 그대로 둔다 (데이터는 이 컴퓨터에 있다)
  async function check() {
    const t = readToken();
    if (!t || !status().signedIn) return { ok: true, checked: false };
    try {
      const r = await postForm(TOKEN_URL, { client_id: clientId, client_secret: clientSecret, refresh_token: t, grant_type: 'refresh_token' });
      if (!r.ok && r.json.error === 'invalid_grant') { await signOut(); return { ok: false, signedOut: true }; }
      return { ok: true, checked: r.ok };
    } catch (e) { return { ok: true, checked: false }; }
  }

  return { configured, status, signIn, cancel, signOut, check };
}

module.exports = { create, authUrl, readIdToken, pkce, maskEmail };
