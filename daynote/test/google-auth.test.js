'use strict';

// Google 로그인 서비스(services/google-auth.js)와 비밀 보관(services/keystore.js createSecretStore·loadDotEnv out)
// 가짜 fetch · 가짜 safeStorage · 임시 폴더 · 실제 127.0.0.1 루프백 (DAYNOTE_GOOGLE_DESIGN.md §12.3)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const A = require('../services/google-auth');
const K = require('../services/keystore');

const NOW = new Date(2026, 9, 5, 10, 0);
const CLIENT_ID = '1234567890-abcdefg.apps.googleusercontent.com';
const OTHER_ID = '9876543210-zyxwvut.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-testSecret_0123456789';
const ACCESS = 'ya29.a0AccessTokenTEST';
const REFRESH = '1//0gRefreshTokenTEST';
const SUB = '118000000000000000001';

// ---------------------------------------------------------------- 가짜 도구 (§12.1)
// 가짜 fetch — 요청을 기록하고 handler 가 응답을 정한다
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(String(url));
    const req = { url: u, method: init.method || 'GET', headers: init.headers || {}, body: init.body == null ? null : String(init.body) };
    calls.push(req);
    const r = await handler(req);                        // { status, json?, headers?, bytes? } 또는 throw new TypeError('fetch failed')
    const h = Object.fromEntries(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const res = { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: (k) => h[k.toLowerCase()] ?? null },
      json: async () => r.json, text: async () => (r.json === undefined ? '' : JSON.stringify(r.json)) };
    if (r.bytes) res.arrayBuffer = async () => r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.length);
    return res;
  };
  fn.calls = calls;
  return fn;
}
// 가짜 safeStorage (capture-v3.test.js 의 keystore 테스트와 같은 꼴)
const fakeSafe = { isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('enc:' + Buffer.from(s).toString('base64')),
  decryptString: (b) => Buffer.from(String(b).slice(4), 'base64').toString() };
// 가짜 브라우저 — 인가 URL 을 받아 루프백으로 리디렉트를 흉내 낸다 (응답도 기록)
function fakeBrowser({ code = 'c0de', state: forceState, error } = {}) {
  const seen = [];
  const responses = [];
  const open = async (url) => {
    const u = new URL(url); seen.push(u);
    const redirect = u.searchParams.get('redirect_uri');
    const qs = error ? `error=${error}&state=${u.searchParams.get('state')}` : `code=${code}&state=${forceState || u.searchParams.get('state')}`;
    setImmediate(() => http.get(`${redirect}/?${qs}`, (res) => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => responses.push({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', () => {}));
  };
  open.seen = seen; open.responses = responses;
  return open;
}
// id_token 만들기 (서명은 검사하지 않으므로 아무 값)
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const idToken = (claims) => `${b64u({ alg: 'RS256' })}.${b64u(claims)}.sig`;

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dn-gauth-'));
const decrypt = (file) => JSON.parse(fakeSafe.decryptString(fs.readFileSync(file)));
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const form = (req) => new URLSearchParams(req.body || '');
const isToken = (req) => req.url.origin + req.url.pathname === A.ENDPOINTS.token;
const isRevoke = (req) => req.url.origin + req.url.pathname === A.ENDPOINTS.revoke;
async function waitFor(pred, tries = 200) {
  for (let i = 0; i < tries; i++) { if (pred()) return true; await new Promise((r) => setTimeout(r, 5)); }
  return false;
}
function hit(port, { method = 'GET', path: p = '/', host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: host ? { Host: host } : {} }, (res) => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
const portOf = (authUrl) => Number(new URL(authUrl.searchParams.get('redirect_uri')).port);

// 서비스 + 가짜 Google. o.exchange / o.refresh / o.revoke 로 토큰 엔드포인트 응답을 바꾼다.
function setup(o = {}) {
  const dir = o.dir || tmpDir();
  const clock = { t: NOW.getTime() };
  const authUrls = [];
  const browser = o.browser || fakeBrowser(o.browserOpts);
  const statuses = [];
  let focused = 0;
  let refreshN = 0;
  const g = { scope: o.scope || A.SCOPES.join(' '), claims: o.claims || {} };
  const fetch = fakeFetch(async (req) => {
    if (isToken(req)) {
      const p = form(req);
      if (p.get('grant_type') === 'authorization_code') {
        if (o.exchange) return o.exchange(p, req);
        const nonce = authUrls[authUrls.length - 1].searchParams.get('nonce');
        return { status: 200, json: { access_token: ACCESS, expires_in: 3600, refresh_token: REFRESH, scope: g.scope, token_type: 'Bearer',
          id_token: idToken(Object.assign({ iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: Math.floor(clock.t / 1000) + 3600, nonce,
            sub: SUB, email: 'me@example.com', name: '김데이' }, g.claims)) } };
      }
      if (o.refresh) return o.refresh(p, req);
      refreshN++;
      return { status: 200, json: { access_token: 'ya29.a0Refreshed' + refreshN, expires_in: 3600, token_type: 'Bearer' } };
    }
    if (isRevoke(req)) return o.revoke ? o.revoke(req) : { status: 200, json: {} };
    if (o.other) return o.other(req);
    return { status: 404, json: { error: 'not_found' } };
  });
  const env = o.env === undefined ? { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, source: 'env' } : o.env;
  const auth = A.create(Object.assign({
    userDataDir: dir, safeStorage: fakeSafe, fetch, now: () => clock.t, env,
    openExternal: async (url) => { authUrls.push(new URL(url)); return browser(url); },
    onStatus: (s) => statuses.push(s.state), onFocusApp: () => { focused++; }
  }, o.create || {}));
  return { auth, dir, fetch, browser, clock, statuses, authUrls, focused: () => focused,
    tokenFile: path.join(dir, 'google-token.bin'), tokenCalls: () => fetch.calls.filter(isToken) };
}

const GENV = ['DAYNOTE_GOOGLE_CLIENT_ID', 'DAYNOTE_GOOGLE_CLIENT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_API_KEY'];
async function withEnv(vars, fn) {
  const saved = {};
  GENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  Object.assign(process.env, vars);
  try { return await fn(); }
  finally { GENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); }
}

// ---------------------------------------------------------------- keystore 추가분
test('createSecretStore: 암호화한 JSON 을 저장·읽기·지우기, 디스크에 평문 없음, exists', () => {
  const dir = path.join(tmpDir(), 'sub');                      // 없는 폴더도 만든다
  const st = K.createSecretStore(dir, fakeSafe, 'google-token.bin');
  assert.equal(st.exists(), false);
  assert.equal(st.read(), null);
  assert.deepEqual(st.write({ v: 1, refreshToken: REFRESH, n: 3 }), { ok: true });
  assert.equal(st.exists(), true);
  const raw = fs.readFileSync(path.join(dir, 'google-token.bin'));
  assert.ok(!raw.toString('latin1').includes(REFRESH));        // 평문 아님
  assert.ok(!raw.toString('latin1').includes('refreshToken'));
  assert.deepEqual(st.read(), { v: 1, refreshToken: REFRESH, n: 3 });
  assert.equal(fs.existsSync(path.join(dir, 'google-token.bin.tmp')), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'google-token.bin')).mode & 0o777, 0o600);
  assert.deepEqual(st.clear(), { ok: true });
  assert.equal(st.exists(), false);
  assert.equal(st.read(), null);
  assert.deepEqual(st.clear(), { ok: true });                   // 없어도 성공
});

test('createSecretStore: 암호화를 못 쓰면 저장을 거부하고, 깨진 파일·JSON 오류는 null', () => {
  const dir = tmpDir();
  const noSafe = Object.assign({}, fakeSafe, { isEncryptionAvailable: () => false });
  const st = K.createSecretStore(dir, noSafe, 'google-client.bin');
  assert.deepEqual(st.write({ clientId: 'x' }), { ok: false, error: '이 컴퓨터에서는 안전하게 저장할 수 없어요.' });
  assert.equal(st.exists(), false);
  const good = K.createSecretStore(dir, fakeSafe, 'google-client.bin');
  good.write({ clientId: 'x' });
  assert.equal(st.read(), null);                                // 암호화 불가면 읽지도 않는다
  fs.writeFileSync(path.join(dir, 'google-client.bin'), fakeSafe.encryptString('{not json'));
  assert.equal(good.read(), null);
  fs.writeFileSync(path.join(dir, 'google-client.bin'), fakeSafe.encryptString('[1,2]'));
  assert.equal(good.read(), null);
  const throwing = Object.assign({}, fakeSafe, { decryptString: () => { throw new Error('bad'); } });
  assert.equal(K.createSecretStore(dir, throwing, 'google-client.bin').read(), null);
  assert.throws(() => K.createSecretStore(dir, fakeSafe, '../x.bin'));
});

test('loadDotEnv(dir, out): 이번에 채운 키 이름만 out 에 넣고, 반환값과 기존 동작은 그대로', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '.env'), '# 주석\nGOOGLE_CLIENT_ID="111-abc.apps.googleusercontent.com"\nGOOGLE_CLIENT_SECRET=GOCSPX-abcdefghij\nDAYNOTE_GOOGLE_CLIENT_ID=\n');
  await withEnv({ GOOGLE_CLIENT_SECRET: 'already' }, async () => {
    const out = [];
    assert.equal(K.loadDotEnv(dir, out), false);               // Gemini 키는 없으므로 false
    assert.deepEqual(out, ['GOOGLE_CLIENT_ID']);               // 이미 있던 SECRET·빈 값은 채우지 않았다
    assert.equal(process.env.GOOGLE_CLIENT_ID, '111-abc.apps.googleusercontent.com');
    assert.equal(process.env.GOOGLE_CLIENT_SECRET, 'already');
  });
  await withEnv({}, async () => {
    assert.equal(K.loadDotEnv(dir), false);                    // out 없이도 동작
    assert.equal(process.env.GOOGLE_CLIENT_SECRET, 'GOCSPX-abcdefghij');
  });
  assert.equal(K.loadDotEnv(path.join(dir, 'none'), []), false);
});

// ---------------------------------------------------------------- §12.3
test('1. buildAuthUrl: 모든 매개변수 (범위 6개, S256, offline, prompt, include_granted_scopes)', () => {
  const s = A.buildAuthUrl({ endpoint: A.ENDPOINTS.auth, clientId: CLIENT_ID, redirectUri: 'http://127.0.0.1:5555', scopes: A.SCOPES,
    state: 'st4te', nonce: 'n0nce', challenge: 'ch4l' });
  assert.ok(s.startsWith(A.ENDPOINTS.auth + '?'));
  const q = new URL(s).searchParams;
  assert.equal(q.get('client_id'), CLIENT_ID);
  assert.equal(q.get('redirect_uri'), 'http://127.0.0.1:5555');
  assert.equal(q.get('response_type'), 'code');
  assert.deepEqual(q.get('scope').split(' '), A.SCOPES);
  assert.equal(A.SCOPES.length, 6);
  assert.ok(A.SCOPES.includes('https://www.googleapis.com/auth/calendar.app.created'));
  assert.equal(q.get('code_challenge'), 'ch4l');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('state'), 'st4te');
  assert.equal(q.get('nonce'), 'n0nce');
  assert.equal(q.get('access_type'), 'offline');
  assert.equal(q.get('prompt'), 'select_account consent');
  assert.equal(q.get('include_granted_scopes'), 'true');
  assert.equal(q.get('login_hint'), null);
  const h = new URL(A.buildAuthUrl({ clientId: CLIENT_ID, redirectUri: 'http://127.0.0.1:1', state: 's', nonce: 'n', challenge: 'c', loginHint: 'me@example.com' })).searchParams;
  assert.equal(h.get('prompt'), 'consent');
  assert.equal(h.get('login_hint'), 'me@example.com');
  assert.deepEqual(A.ENDPOINTS, { auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', revoke: 'https://oauth2.googleapis.com/revoke' });
});

test('2. makePkce: challenge = base64url(sha256(verifier)), verifier 는 43~128자 [A-Za-z0-9-._~]', () => {
  const p = A.makePkce();
  assert.match(p.verifier, /^[A-Za-z0-9\-._~]{43,128}$/);
  assert.equal(p.challenge, crypto.createHash('sha256').update(p.verifier).digest('base64url'));
  assert.notEqual(A.makePkce().verifier, p.verifier);
  const fixed = A.makePkce((n) => Buffer.alloc(n, 7), (b) => crypto.createHash('sha256').update(b).digest());
  assert.equal(fixed.verifier, Buffer.alloc(32, 7).toString('base64url'));
});

test('3. 클라이언트가 없으면 needs_setup 이고 signIn 은 not_configured (네트워크·브라우저 없음)', async () => {
  const t = setup({ env: null });
  const st = t.auth.status();
  assert.equal(st.available, true);
  assert.equal(st.state, 'needs_setup');
  assert.equal(st.signedIn, false);
  assert.deepEqual(st.client, { configured: false, source: null, idHint: null, hasSecret: false });
  assert.deepEqual(st.scopes, { calendarList: false, eventsRead: false, appCalendar: false });
  const r = await t.auth.signIn();
  assert.equal(r.ok, false);
  assert.equal(r.error.type, 'not_configured');
  assert.equal(r.error.message, '먼저 Google Cloud에서 만든 클라이언트를 붙여 넣어 주세요.');
  assert.equal(r.status.state, 'needs_setup');
  assert.equal(t.fetch.calls.length, 0);
  assert.equal(t.authUrls.length, 0);
});

test('4. parseClientInput: installed JSON 통과, web JSON 거부, ID 형식 오류 거부, 공백·따옴표·줄바꿈 제거', () => {
  const installed = JSON.stringify({ installed: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uris: ['http://localhost'] } });
  assert.deepEqual(A.parseClientInput({ text: installed }), { ok: true, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const web = A.parseClientInput({ text: JSON.stringify({ web: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } }) });
  assert.equal(web.ok, false);
  assert.equal(web.error.type, 'invalid_client_input');
  assert.equal(web.error.message, '웹 애플리케이션 유형의 클라이언트예요. ‘데스크톱 앱’ 유형으로 새로 만들어 주세요.');
  const badId = A.parseClientInput({ clientId: 'my-client-id', clientSecret: CLIENT_SECRET });
  assert.equal(badId.ok, false);
  assert.equal(badId.error.type, 'invalid_client_input');
  assert.match(badId.error.message, /apps\.googleusercontent\.com/);
  assert.equal(A.parseClientInput({ clientId: '' }).ok, false);
  assert.equal(A.parseClientInput({ text: '{oops' }).error.type, 'invalid_client_input');
  assert.equal(A.parseClientInput({ clientId: CLIENT_ID, clientSecret: 'bad secret!' }).ok, false);
  assert.deepEqual(A.parseClientInput({ clientId: `  "${CLIENT_ID}"\n`, clientSecret: ` '${CLIENT_SECRET}' ` }), { ok: true, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  assert.deepEqual(A.parseClientInput({ clientId: CLIENT_ID }), { ok: true, clientId: CLIENT_ID, clientSecret: null });

  // setClient: 설정에 저장 → 출처 saved, 화면에는 ID 일부·secret 여부만
  const t = setup({ env: null });
  const bad = t.auth.setClient({ clientId: 'nope' });
  assert.equal(bad.ok, false);
  assert.equal(bad.status.state, 'needs_setup');
  const r = t.auth.setClient({ text: installed });
  assert.equal(r.ok, true);
  assert.equal(r.status.state, 'signed_out');
  assert.deepEqual(r.status.client, { configured: true, source: 'saved', idHint: '1234…apps.googleusercontent.com', hasSecret: true });
  assert.ok(!JSON.stringify(r).includes(CLIENT_SECRET));
  assert.ok(!fs.readFileSync(path.join(t.dir, 'google-client.bin')).toString('latin1').includes(CLIENT_SECRET));
  assert.equal(decrypt(path.join(t.dir, 'google-client.bin')).clientSecret, CLIENT_SECRET);
  // 다른 인스턴스(앱 다시 켜기)도 저장한 값을 읽는다 — 설정에 저장한 값이 환경변수보다 우선
  const t2 = setup({ dir: t.dir, env: { clientId: OTHER_ID, clientSecret: null, source: 'env' } });
  assert.equal(t2.auth.status().client.source, 'saved');
  assert.equal(t2.auth.clearClient().status.client.source, 'env');   // 저장 값만 지운다
  assert.equal(fs.existsSync(path.join(t.dir, 'google-client.bin')), false);
});

test('5. 전체 로그인: 루프백 → 토큰 교환(code·verifier·같은 redirect_uri·secret) → signed_in, 상태 알림 순서, 창 앞으로', async () => {
  const t = setup();
  const r = await t.auth.signIn();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.status.state, 'signed_in');
  assert.equal(r.status.signedIn, true);
  assert.equal(r.status.email, 'me@example.com');
  assert.equal(r.status.name, '김데이');
  assert.equal(r.status.picture, null);
  assert.equal(r.status.accountId, sha256hex(SUB).slice(0, 16));
  assert.match(r.status.deviceId, /^[0-9a-f]{16}$/);
  assert.deepEqual(r.status.scopes, { calendarList: true, eventsRead: true, appCalendar: true });
  assert.deepEqual(r.status.client, { configured: true, source: 'env', idHint: '1234…apps.googleusercontent.com', hasSecret: true });
  assert.equal(r.status.error, null);
  assert.equal(r.status.exportCalendarId, null);

  const authUrl = t.authUrls[0];
  assert.match(authUrl.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(authUrl.searchParams.get('prompt'), 'select_account consent');
  const calls = t.tokenCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers['Content-Type'], 'application/x-www-form-urlencoded');
  const p = form(calls[0]);
  assert.equal(p.get('code'), 'c0de');
  assert.equal(p.get('grant_type'), 'authorization_code');
  assert.equal(p.get('client_id'), CLIENT_ID);
  assert.equal(p.get('client_secret'), CLIENT_SECRET);
  assert.equal(p.get('redirect_uri'), authUrl.searchParams.get('redirect_uri'));
  assert.equal(crypto.createHash('sha256').update(p.get('code_verifier')).digest('base64url'), authUrl.searchParams.get('code_challenge'));
  assert.deepEqual(t.statuses, ['connecting', 'signed_in']);
  assert.equal(t.focused(), 1);
  // 결과 페이지: 문구, 보안 헤더, 외부 링크·스크립트 없음
  assert.ok(await waitFor(() => t.browser.responses.length === 1));
  const page = t.browser.responses[0];
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('Daynote에 연결했어요 · me@example.com. 이 탭을 닫고 Daynote로 돌아가세요.'));
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['content-security-policy'], "default-src 'none'; style-src 'unsafe-inline'");
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.match(page.headers['content-type'], /^text\/html; charset=utf-8/);
  assert.ok(!/<script|https?:\/\//i.test(page.body));
  // 루프백 서버는 한 번만 쓰고 닫힌다
  await assert.rejects(hit(portOf(authUrl)), { code: 'ECONNREFUSED' });
});

test('6. 루프백 검사: POST 405, Host 다름 400, 다른 경로 404, state 틀림 400 → 계속 기다리다 맞는 state 로 끝난다', async () => {
  const responses = [];
  let settledBeforeGood = null;
  let settled = false;
  const browser = async (url) => {
    const u = new URL(url);
    const port = portOf(u);
    const st = u.searchParams.get('state');
    setImmediate(async () => {
      responses.push(await hit(port, { method: 'POST', path: '/?code=c0de&state=' + st }));
      responses.push(await hit(port, { host: 'evil.example:' + port, path: '/?code=c0de&state=' + st }));
      responses.push(await hit(port, { path: '/favicon.ico' }));
      responses.push(await hit(port, { path: '/?code=c0de&state=WRONG' + st.slice(5) }));
      responses.push(await hit(port, { path: '/?error=access_denied&state=WRONG' }));     // state 가 틀린 오류 응답도 무시
      await new Promise((r) => setTimeout(r, 20));
      settledBeforeGood = settled;
      responses.push(await hit(port, { path: '/?code=c0de&state=' + encodeURIComponent(st) }));
    });
  };
  const t = setup({ browser });
  const r = await t.auth.signIn();
  settled = true;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(await waitFor(() => responses.length === 6));
  assert.deepEqual(responses.map((x) => x.status), [405, 400, 404, 400, 400, 200]);
  assert.equal(settledBeforeGood, false);
  assert.equal(t.tokenCalls().length, 1);
  responses.forEach((x) => assert.equal(x.headers['cache-control'], 'no-store'));
});

test('7. error=access_denied 이면 denied 로 끝나고 상태는 signed_out', async () => {
  const t = setup({ browserOpts: { error: 'access_denied' } });
  const r = await t.auth.signIn();
  assert.equal(r.ok, false);
  assert.equal(r.error.type, 'denied');
  assert.equal(r.error.message, '권한 허용이 취소됐어요. 테스트 사용자로 추가한 계정인지 확인해 주세요.');
  assert.equal(r.status.state, 'signed_out');
  assert.equal(r.status.error.type, 'denied');
  assert.equal(t.tokenCalls().length, 0);
  assert.ok(await waitFor(() => t.browser.responses.length === 1));
  assert.ok(t.browser.responses[0].body.includes('연결하지 못했어요. Daynote에서 다시 시도해 주세요.'));
  assert.deepEqual(t.statuses, ['connecting', 'signed_out']);
});

test('8. 시간 제한(timeoutMs 50)이 지나면 timeout, 서버가 닫혀 그 포트 연결은 거부된다', async () => {
  const t = setup({ browser: async () => {}, create: { timeoutMs: 50 } });
  const r = await t.auth.signIn();
  assert.equal(r.ok, false);
  assert.equal(r.error.type, 'timeout');
  assert.equal(r.error.retryable, true);
  assert.equal(r.status.state, 'signed_out');
  await assert.rejects(hit(portOf(t.authUrls[0])), { code: 'ECONNREFUSED' });
});

test('8b. 제한 시간 직전에 온 code: 교환이 제한 시간을 넘겨도 끝까지 기다려 Google 이 내준 토큰을 버리지 않는다', async () => {
  let t = null;
  t = setup({ create: { timeoutMs: 40 }, exchange: async () => {
    await new Promise((r) => setTimeout(r, 120));                // 교환이 5분(여기서는 40ms) 제한을 넘긴다
    return { status: 200, json: { access_token: ACCESS, expires_in: 3600, refresh_token: REFRESH, scope: A.SCOPES.join(' '), token_type: 'Bearer',
      id_token: idToken({ iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: Math.floor(t.clock.t / 1000) + 3600,
        nonce: t.authUrls[0].searchParams.get('nonce'), sub: SUB, email: 'me@example.com', name: '김데이' }) } };
  } });
  const r = await t.auth.signIn();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.status.state, 'signed_in');
  assert.equal(r.status.error, null);
  assert.ok(fs.existsSync(t.tokenFile));
  assert.ok(await waitFor(() => t.browser.responses.length === 1));
  assert.ok(t.browser.responses[0].body.includes('Daynote에 연결했어요'));
});

test('9. cancelSignIn() 이면 canceled (화면 오류 없음), 새 signIn 도 진행 중인 것을 취소한다', async () => {
  const t = setup({ browser: async () => { setImmediate(() => t.auth.cancelSignIn()); } });
  const r = await t.auth.signIn();
  assert.equal(r.ok, false);
  assert.equal(r.error.type, 'canceled');
  assert.equal(r.status.state, 'signed_out');
  assert.equal(r.status.error, null);
  assert.deepEqual(t.auth.cancelSignIn(), { ok: true });
  await assert.rejects(hit(portOf(t.authUrls[0])), { code: 'ECONNREFUSED' });

  // 두 번째 signIn 이 첫 번째를 끝낸다
  let mode = 'idle';
  const fb = fakeBrowser();
  const t2 = setup({ browser: (url) => (mode === 'idle' ? Promise.resolve() : fb(url)) });
  const first = t2.auth.signIn();
  await waitFor(() => t2.authUrls.length === 1);
  mode = 'go';
  const second = await t2.auth.signIn();
  assert.equal((await first).error.type, 'canceled');
  assert.equal(second.ok, true);
  assert.equal(second.status.state, 'signed_in');
});

test('10. 응답 scope 에서 calendar.events.readonly 가 빠지면 scopes.eventsRead === false (signed_in 유지)', async () => {
  const t = setup({ scope: A.SCOPES.filter((s) => !s.endsWith('calendar.events.readonly')).join(' ') });
  const r = await t.auth.signIn();
  assert.equal(r.status.state, 'signed_in');
  assert.deepEqual(r.status.scopes, { calendarList: true, eventsRead: false, appCalendar: true });
  assert.equal(t.auth.hasScope('eventsRead'), false);
  assert.equal(t.auth.hasScope('appCalendar'), true);
  assert.equal(t.auth.hasScope('https://www.googleapis.com/auth/calendar.calendarlist.readonly'), true);
});

test('11. 토큰 파일: 날것의 바이트에 refresh token 없음, 풀면 있음, access token 은 파일에 없음', async () => {
  const t = setup();
  await t.auth.signIn();
  const raw = fs.readFileSync(t.tokenFile).toString('latin1');
  assert.ok(!raw.includes(REFRESH));
  assert.ok(!raw.includes(ACCESS));
  const plain = fakeSafe.decryptString(fs.readFileSync(t.tokenFile));
  assert.ok(plain.includes(REFRESH));
  assert.ok(!plain.includes(ACCESS));
  const tok = JSON.parse(plain);
  assert.equal(tok.v, 1);
  assert.equal(tok.clientId, CLIENT_ID);
  assert.equal(tok.refreshToken, REFRESH);
  assert.equal(tok.scope, A.SCOPES.join(' '));
  assert.equal(tok.grantedAt, NOW.toISOString());
  assert.deepEqual(tok.account, { sub: SUB, email: 'me@example.com', name: '김데이', pictureData: null });
  assert.equal(tok.exportCalendarId, null);
  if (process.platform !== 'win32') assert.equal(fs.statSync(t.tokenFile).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(t.auth.status()).includes(REFRESH));
  // 앱을 다시 켜도(새 인스턴스) 로그인 상태가 이어진다 — access token 은 refresh token 으로 새로 받는다
  const t2 = setup({ dir: t.dir });
  assert.equal(t2.auth.status().state, 'signed_in');
  const a = await t2.auth.getAccessToken();
  assert.equal(a.ok, true);
  assert.equal(a.accessToken, 'ya29.a0Refreshed1');
});

test('12. getAccessToken: 만료 60초 전부터 갱신, 동시에 2번 불러도 토큰 요청은 1번', async () => {
  const t = setup();
  await t.auth.signIn();
  const base = t.clock.t;
  let a = await t.auth.getAccessToken();
  assert.deepEqual(a, { ok: true, accessToken: ACCESS, expiresAt: base + 3600 * 1000 });
  t.clock.t = base + (3600 - 61) * 1000;
  a = await t.auth.getAccessToken();
  assert.equal(a.accessToken, ACCESS);
  assert.equal(t.tokenCalls().length, 1);                       // 교환 1번뿐
  t.clock.t = base + (3600 - 59) * 1000;
  const [x, y] = await Promise.all([t.auth.getAccessToken(), t.auth.getAccessToken()]);
  assert.equal(t.tokenCalls().length, 2);
  assert.equal(x.accessToken, 'ya29.a0Refreshed1');
  assert.equal(y.accessToken, 'ya29.a0Refreshed1');
  assert.equal(x.expiresAt, t.clock.t + 3600 * 1000);
  const p = form(t.tokenCalls()[1]);
  assert.equal(p.get('grant_type'), 'refresh_token');
  assert.equal(p.get('refresh_token'), REFRESH);
  assert.equal(p.get('client_id'), CLIENT_ID);
  assert.equal(p.get('client_secret'), CLIENT_SECRET);
  // forceRefresh 는 캐시를 건너뛴다
  const f = await t.auth.getAccessToken({ forceRefresh: true });
  assert.equal(f.accessToken, 'ya29.a0Refreshed2');
  assert.equal(t.tokenCalls().length, 3);
});

test('12b. 갱신이 네트워크 오류면 signed_in 그대로 + network(retryable), invalid_client 면 error 상태', async () => {
  let mode = 'network';
  const t = setup({ refresh: () => {
    if (mode === 'network') throw new TypeError('fetch failed');
    if (mode === 'client') return { status: 401, json: { error: 'invalid_client', error_description: 'The OAuth client was not found.' } };
    return { status: 200, json: { access_token: 'ya29.a0Again', expires_in: 3600 } };
  } });
  await t.auth.signIn();
  let r = await t.auth.getAccessToken({ forceRefresh: true });
  assert.equal(r.ok, false);
  assert.equal(r.error.type, 'network');
  assert.equal(r.error.retryable, true);
  assert.equal(t.auth.status().state, 'signed_in');
  mode = 'client';
  r = await t.auth.getAccessToken({ forceRefresh: true });
  assert.equal(r.error.type, 'invalid_client');
  const st = t.auth.status();
  assert.equal(st.state, 'error');
  assert.equal(st.signedIn, false);
  assert.equal(st.error.type, 'invalid_client');
  assert.equal(st.email, 'me@example.com');
  // 같은 클라이언트에 secret 을 다시 넣으면 토큰은 유지하고 오류만 지운다 → 다시 갱신 성공
  mode = 'ok';
  assert.equal(t.auth.setClient({ clientId: CLIENT_ID, clientSecret: 'GOCSPX-fixedSecret_99' }).status.state, 'signed_in');
  r = await t.auth.getAccessToken({ forceRefresh: true });
  assert.equal(r.accessToken, 'ya29.a0Again');
  assert.equal(form(t.tokenCalls().at(-1)).get('client_secret'), 'GOCSPX-fixedSecret_99');
});

test('13. 갱신이 invalid_grant 이면 reauth: refreshToken 지움, email 남김, 다음 signIn 의 login_hint 는 그 email', async () => {
  let expired = true;
  const t = setup({ refresh: () => (expired
    ? { status: 400, json: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }
    : { status: 200, json: { access_token: 'ya29.x', expires_in: 3600 } }) });
  await t.auth.signIn();
  const r = await t.auth.getAccessToken({ forceRefresh: true });
  assert.equal(r.ok, false);
  assert.equal(r.error.type, 'reauth');
  assert.equal(r.error.message, 'Google 로그인이 만료됐어요. 다시 연결해 주세요.');
  const st = t.auth.status();
  assert.equal(st.state, 'reauth');
  assert.equal(st.signedIn, false);
  assert.equal(st.email, 'me@example.com');
  assert.equal(t.statuses.at(-1), 'reauth');
  const tok = decrypt(t.tokenFile);
  assert.equal(tok.refreshToken, null);
  assert.equal(tok.account.email, 'me@example.com');
  assert.equal((await t.auth.getAccessToken()).error.type, 'reauth');   // 다시 갱신을 시도하지 않는다
  const before = t.tokenCalls().length;
  expired = false;
  const again = await t.auth.signIn();
  assert.equal(again.ok, true);
  assert.equal(t.authUrls.at(-1).searchParams.get('login_hint'), 'me@example.com');
  assert.equal(t.authUrls.at(-1).searchParams.get('prompt'), 'consent');
  assert.equal(again.status.state, 'signed_in');
  assert.equal(t.tokenCalls().length, before + 1);
});

test('14. 갱신 응답에 새 refresh_token 이 있으면 파일이 바뀌고 다음 갱신에 그것을 쓴다', async () => {
  const t = setup({ refresh: (p) => ({ status: 200, json: { access_token: 'ya29.a0New', expires_in: 3600, refresh_token: '1//0gROTATED', scope: A.SCOPES.join(' '), seen: p.get('refresh_token') } }) });
  await t.auth.signIn();
  const before = fs.readFileSync(t.tokenFile);
  await t.auth.getAccessToken({ forceRefresh: true });
  assert.notDeepEqual(fs.readFileSync(t.tokenFile), before);
  assert.equal(decrypt(t.tokenFile).refreshToken, '1//0gROTATED');
  await t.auth.getAccessToken({ forceRefresh: true });
  assert.equal(form(t.tokenCalls().at(-1)).get('refresh_token'), '1//0gROTATED');
});

test('15. signOut: 파일을 지우고 revoke 를 form 으로 POST, revoke 가 네트워크 오류여도 signed_out · revoked:false', async () => {
  const t = setup({ revoke: () => { throw new TypeError('fetch failed'); } });
  await t.auth.signIn();
  const device = t.auth.deviceId();
  const r = await t.auth.signOut();
  assert.equal(r.ok, true);
  assert.equal(r.revoked, false);
  assert.equal(r.status.state, 'signed_out');
  assert.equal(r.status.email, null);
  assert.equal(fs.existsSync(t.tokenFile), false);
  const rv = t.fetch.calls.filter(isRevoke);
  assert.equal(rv.length, 1);
  assert.equal(rv[0].method, 'POST');
  assert.equal(rv[0].headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(form(rv[0]).get('token'), REFRESH);
  assert.equal((await t.auth.getAccessToken()).error.type, 'not_signed_in');
  assert.equal(t.auth.deviceId(), device);                      // 기기 id 는 남는다
  assert.equal(fs.readFileSync(path.join(t.dir, 'device-id'), 'utf8').trim(), device);

  const ok = setup({ revoke: () => ({ status: 200, json: {} }) });
  await ok.auth.signIn();
  assert.equal((await ok.auth.signOut()).revoked, true);
  const gone = setup({ revoke: () => ({ status: 400, json: { error: 'invalid_token' } }) });
  await gone.auth.signIn();
  assert.equal((await gone.auth.signOut()).revoked, true);      // 이미 폐기됨
});

test('16. id_token 의 aud·iss·exp·nonce 중 하나라도 틀리면 bad_id_token', async () => {
  const nowMs = NOW.getTime();
  const good = { iss: 'accounts.google.com', aud: CLIENT_ID, exp: nowMs / 1000 + 60, nonce: 'n1', sub: SUB, email: 'a@b.c', name: 'A', picture: 'https://x/y' };
  const ok = A.parseIdToken(idToken(good), { clientId: CLIENT_ID, nonce: 'n1', now: nowMs });
  assert.deepEqual(ok, { ok: true, claims: { sub: SUB, email: 'a@b.c', name: 'A', picture: 'https://x/y' } });
  const bad = (patch) => A.parseIdToken(idToken(Object.assign({}, good, patch)), { clientId: CLIENT_ID, nonce: 'n1', now: nowMs });
  assert.deepEqual(bad({ aud: OTHER_ID }), { ok: false, reason: 'aud' });
  assert.deepEqual(bad({ iss: 'https://evil.example' }), { ok: false, reason: 'iss' });
  assert.deepEqual(bad({ exp: nowMs / 1000 - 1 }), { ok: false, reason: 'exp' });
  assert.deepEqual(bad({ nonce: 'n2' }), { ok: false, reason: 'nonce' });
  assert.deepEqual(A.parseIdToken('not.a.jwt!', { clientId: CLIENT_ID, now: nowMs }).ok, false);
  assert.deepEqual(A.parseIdToken(undefined, { clientId: CLIENT_ID, now: nowMs }), { ok: false, reason: 'format' });

  for (const claims of [{ aud: OTHER_ID }, { iss: 'https://evil.example' }, { exp: nowMs / 1000 - 5 }, { nonce: 'wrong' }]) {
    const t = setup({ claims });
    const r = await t.auth.signIn();
    assert.equal(r.ok, false, JSON.stringify(claims));
    assert.equal(r.error.type, 'bad_id_token');
    assert.equal(r.status.state, 'signed_out');
    assert.equal(fs.existsSync(t.tokenFile), false);
  }
});

test('17. redact 는 ya29.·1//·GOCSPX-·JWT·code=·refresh_token= 을 가리고, 실패 결과 JSON 에 토큰 조각이 없다', async () => {
  const jwt = idToken({ sub: 'x' });
  const text = `Bearer ${ACCESS} refresh ${REFRESH} secret ${CLIENT_SECRET} id ${jwt} ` +
    'GET /?code=4/0AeanS0abc&state=xyz body refresh_token=1%2F%2F0gq&client_secret=abc123 {"access_token":"opaque-value","code":"4/zzz"}';
  const out = A.redact(text);
  ['ya29.', REFRESH, 'GOCSPX-', jwt, '4/0AeanS0abc', '1%2F%2F0gq', 'abc123', 'opaque-value', '4/zzz'].forEach((frag) => {
    assert.ok(!out.includes(frag), frag + ' 가 남았다: ' + out);
  });
  assert.ok(out.includes('[가림]'));
  assert.equal(A.redact('평범한 문장'), '평범한 문장');
  assert.equal(A.redact(null), '');
  // 접두사 없는 옛 secret 도 알려진 값이면 가린다
  const t0 = setup({ env: null });
  t0.auth.setClient({ clientId: CLIENT_ID, clientSecret: 'oldStyleSecret0123' });
  assert.ok(!A.redact('invalid client oldStyleSecret0123').includes('oldStyleSecret0123'));

  // 토큰 교환이 이상한 오류를 내도 결과 JSON 에는 토큰·code·secret 이 없다
  const t = setup({ exchange: () => ({ status: 400, json: { error: 'weird', error_description: `bad ${REFRESH} ${ACCESS} code=c0de` } }) });
  const r = await t.auth.signIn();
  assert.equal(r.ok, false);
  const s = JSON.stringify(r);
  ['ya29.', '1//', 'GOCSPX-', CLIENT_SECRET, 'c0de'].forEach((frag) => assert.ok(!s.includes(frag), frag));
  const okT = setup();
  const okR = await okT.auth.signIn();
  const s2 = JSON.stringify([okR, okT.auth.status()]);
  ['ya29.', '1//', 'GOCSPX-', 'id_token', 'refresh'].forEach((frag) => assert.ok(!s2.includes(frag), frag));
});

test('18. 토큰 요청이 400 invalid_request + "client_secret is missing" 이면 needs_secret (secret 없이 보냈다)', async () => {
  const t = setup({ env: { clientId: CLIENT_ID, clientSecret: null, source: 'env' },
    exchange: () => ({ status: 400, json: { error: 'invalid_request', error_description: 'client_secret is missing.' } }) });
  assert.equal(t.auth.status().client.hasSecret, false);
  const r = await t.auth.signIn();
  assert.equal(r.ok, false);
  assert.equal(r.error.type, 'needs_secret');
  assert.equal(r.error.message, '이 클라이언트는 보안 비밀번호가 필요해요. 콘솔에서 복사한 보안 비밀번호를 함께 붙여 넣어 주세요.');
  assert.equal(form(t.tokenCalls()[0]).has('client_secret'), false);
  assert.equal(r.status.state, 'signed_out');
  const ic = setup({ exchange: () => ({ status: 401, json: { error: 'invalid_client' } }) });
  assert.equal((await ic.auth.signIn()).error.type, 'invalid_client');
  const nr = setup({ exchange: () => ({ status: 200, json: { access_token: ACCESS, expires_in: 3600 } }) });
  assert.equal((await nr.auth.signIn()).error.type, 'no_refresh_token');
  const net = setup({ exchange: () => { throw new TypeError('fetch failed'); } });
  const nn = await net.auth.signIn();
  assert.equal(nn.error.type, 'network');
  assert.equal(nn.error.retryable, true);
});

test('19. 클라이언트 ID 를 바꾸면 기존 토큰 파일은 무효 → signed_out', async () => {
  const t = setup();
  await t.auth.signIn();
  // 앱을 다시 켰는데 환경변수의 클라이언트가 바뀌었다 → 파일을 쓰지 않는다
  const other = setup({ dir: t.dir, env: { clientId: OTHER_ID, clientSecret: null, source: 'env' } });
  assert.equal(other.auth.status().state, 'signed_out');
  assert.equal(other.auth.status().email, null);
  assert.equal((await other.auth.getAccessToken()).error.type, 'not_signed_in');
  assert.equal(setup({ dir: t.dir }).auth.status().state, 'signed_in');     // 같은 클라이언트면 그대로
  // 설정에서 다른 클라이언트로 바꾸면 로컬 로그아웃 (+ 폐기 요청)
  const r = t.auth.setClient({ clientId: OTHER_ID });
  assert.equal(r.ok, true);
  assert.equal(r.status.state, 'signed_out');
  assert.equal(r.status.client.source, 'saved');
  assert.equal(fs.existsSync(t.tokenFile), false);
  assert.ok(await waitFor(() => t.fetch.calls.some(isRevoke)));
});

test('20. captureEnvClient: DAYNOTE_ 접두사 우선, 읽은 키는 env 에서 지움, .env 출처 구분, GOOGLE_API_KEY 는 그대로', async () => {
  await withEnv({ DAYNOTE_GOOGLE_CLIENT_ID: CLIENT_ID, DAYNOTE_GOOGLE_CLIENT_SECRET: CLIENT_SECRET, GOOGLE_CLIENT_ID: OTHER_ID,
    GOOGLE_CLIENT_SECRET: 'GOCSPX-other_000000', GOOGLE_API_KEY: 'AIzaGEMINI000000000000' }, async () => {
    const c = A.captureEnvClient();
    assert.deepEqual(c, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, source: 'env' });
    ['DAYNOTE_GOOGLE_CLIENT_ID', 'DAYNOTE_GOOGLE_CLIENT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'].forEach((k) => assert.equal(process.env[k], undefined, k));
    assert.equal(process.env.GOOGLE_API_KEY, 'AIzaGEMINI000000000000');
  });
  await withEnv({ GOOGLE_CLIENT_ID: ` "${OTHER_ID}" ` }, async () => {
    assert.deepEqual(A.captureEnvClient(process.env, []), { clientId: OTHER_ID, clientSecret: null, source: 'env' });
  });
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '.env'), `GOOGLE_CLIENT_ID=${CLIENT_ID}\nGOOGLE_CLIENT_SECRET=${CLIENT_SECRET}\n`);
  await withEnv({}, async () => {
    const keys = [];
    K.loadDotEnv(dir, keys);
    const c = A.captureEnvClient(process.env, keys);
    assert.deepEqual(c, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, source: 'dotenv' });
    assert.equal(process.env.GOOGLE_CLIENT_ID, undefined);
    // 이 값으로 만든 서비스는 needs_setup 을 건너뛰고 출처를 알려 준다
    const t = setup({ env: c });
    assert.deepEqual(t.auth.status().client, { configured: true, source: 'dotenv', idHint: '1234…apps.googleusercontent.com', hasSecret: true });
  });
  await withEnv({ GOOGLE_CLIENT_SECRET: 'GOCSPX-lonely_secret' }, async () => {
    assert.equal(A.captureEnvClient(), null);                // ID 가 없으면 null (secret 도 지운다)
    assert.equal(process.env.GOOGLE_CLIENT_SECRET, undefined);
  });
  const plain = { GOOGLE_CLIENT_ID: CLIENT_ID };
  assert.equal(A.captureEnvClient(plain).clientId, CLIENT_ID);
  assert.deepEqual(plain, {});
});

test('21. 통합: 가짜 Google HTTP 서버(127.0.0.1) + 실제 전역 fetch — form 인코딩과 Content-Type', async () => {
  const seen = [];
  let authUrl = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, type: req.headers['content-type'], body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/token') {
        const p = new URLSearchParams(body);
        if (p.get('grant_type') === 'authorization_code') {
          res.end(JSON.stringify({ access_token: ACCESS, expires_in: 3599, refresh_token: REFRESH, scope: A.SCOPES.join(' '), token_type: 'Bearer',
            id_token: idToken({ iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 3600,
              nonce: authUrl.searchParams.get('nonce'), sub: SUB, email: 'me@example.com', name: '김데이' }) }));
        } else {
          res.end(JSON.stringify({ access_token: 'ya29.a0Int', expires_in: 3599 }));
        }
        return;
      }
      if (req.url === '/revoke') { res.end('{}'); return; }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const browser = fakeBrowser({ code: '4/0AbCdEf' });
    const auth = A.create({
      userDataDir: tmpDir(), safeStorage: fakeSafe, env: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, source: 'env' },
      endpoints: { auth: A.ENDPOINTS.auth, token: base + '/token', revoke: base + '/revoke' },
      openExternal: async (url) => { authUrl = new URL(url); return browser(url); }
    });
    const r = await auth.signIn();
    assert.equal(r.ok, true, JSON.stringify(r));
    const tok = seen.find((x) => x.url === '/token');
    assert.equal(tok.method, 'POST');
    assert.equal(tok.type, 'application/x-www-form-urlencoded');
    const p = new URLSearchParams(tok.body);
    assert.equal(p.get('code'), '4/0AbCdEf');                  // 브라우저가 보낸 code 그대로
    assert.ok(tok.body.includes('code=4%2F0AbCdEf'));
    assert.equal(p.get('redirect_uri'), authUrl.searchParams.get('redirect_uri'));
    assert.ok(tok.body.includes('redirect_uri=http%3A%2F%2F127.0.0.1%3A'));
    assert.equal(p.get('client_secret'), CLIENT_SECRET);
    assert.equal((await auth.getAccessToken({ forceRefresh: true })).accessToken, 'ya29.a0Int');
    const out = await auth.signOut();
    assert.equal(out.revoked, true);
    const rv = seen.find((x) => x.url === '/revoke');
    assert.equal(rv.type, 'application/x-www-form-urlencoded');
    assert.equal(rv.body, 'token=' + encodeURIComponent(REFRESH));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---------------------------------------------------------------- 그 밖의 계약
test('사진: picture 를 =s64-c 로 받아 64KB 이하 image/* 면 data: URL 로 둔다, 실패하면 null', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const t = setup({ claims: { picture: 'https://lh3.googleusercontent.com/a/ACg8abc=s96-c' },
    other: (req) => (req.url.hostname === 'lh3.googleusercontent.com' ? { status: 200, headers: { 'Content-Type': 'image/png' }, bytes: png } : { status: 404 }) });
  const r = await t.auth.signIn();
  assert.equal(r.status.picture, 'data:image/png;base64,' + png.toString('base64'));
  assert.equal(t.fetch.calls.find((c) => c.url.hostname === 'lh3.googleusercontent.com').url.href, 'https://lh3.googleusercontent.com/a/ACg8abc=s64-c');
  const big = setup({ claims: { picture: 'https://lh3.googleusercontent.com/a/x' },
    other: () => ({ status: 200, headers: { 'Content-Type': 'image/png' }, bytes: Buffer.alloc(70 * 1024) }) });
  assert.equal((await big.auth.signIn()).status.picture, null);
  const html = setup({ claims: { picture: 'https://lh3.googleusercontent.com/a/x' },
    other: () => ({ status: 200, headers: { 'Content-Type': 'text/html' }, bytes: Buffer.from('<p>') }) });
  assert.equal((await html.auth.signIn()).status.picture, null);
});

test('Daynote 캘린더 id 는 토큰 파일에 영속되고 status 로 알린다, 로그아웃하면 함께 지워진다', async () => {
  const t = setup();
  assert.deepEqual(t.auth.setExportCalendarId('dn@group.calendar.google.com'), { ok: false });   // 로그인 전
  await t.auth.signIn();
  assert.deepEqual(t.auth.setExportCalendarId('dn@group.calendar.google.com'), { ok: true });
  assert.equal(t.auth.exportCalendarId(), 'dn@group.calendar.google.com');
  assert.equal(t.auth.status().exportCalendarId, 'dn@group.calendar.google.com');
  assert.equal(decrypt(t.tokenFile).exportCalendarId, 'dn@group.calendar.google.com');
  assert.equal(setup({ dir: t.dir }).auth.exportCalendarId(), 'dn@group.calendar.google.com');
  // 같은 계정으로 다시 로그인하면 유지
  await t.auth.signIn();
  assert.equal(t.auth.exportCalendarId(), 'dn@group.calendar.google.com');
  await t.auth.signOut();
  assert.equal(t.auth.exportCalendarId(), null);
  assert.equal(t.auth.status().exportCalendarId, null);
});

test('기기 id: 처음 한 번 16자리 hex 로 만들고 다시 켜도 같다', () => {
  const dir = tmpDir();
  const a = setup({ dir }).auth.deviceId();
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(setup({ dir }).auth.deviceId(), a);
  assert.equal(setup({ dir }).auth.status().deviceId, a);
});
