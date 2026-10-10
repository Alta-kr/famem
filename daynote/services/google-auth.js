'use strict';

// Google 로그인 — 시스템 브라우저 + 루프백 리디렉트(http://127.0.0.1:<임의 포트>) + PKCE(S256)·state·nonce.
// 메인 프로세스에서만 쓴다. require('electron') 은 하지 않는다 (safeStorage·openExternal·fetch 를 주입받는다 → Node 테스트 가능).
//
// - refresh token 은 safeStorage 로 암호화한 <userData>/google-token.bin 에, access token 은 메모리에만 둔다.
// - 클라이언트(BYO 데스크톱 앱 유형) 는 <userData>/google-client.bin (설정에 저장) > 환경변수 > .env 순서로 읽는다.
// - 화면에는 GoogleStatus(계정 이메일·이름·사진, 상태, 권한 여부) 만 보낸다. 토큰·secret·code 는 절대 내보내지 않는다.
// - 오류 메시지·로그는 redact() 를 거친다.
//
// 설계: DAYNOTE_GOOGLE_DESIGN.md §4(인증 흐름), §5(클라이언트 설정), §8.5(API)

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createSecretStore } = require('./keystore');

const SCOPES = ['openid', 'email', 'profile',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/calendar.app.created'];
const ENDPOINTS = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke'
};

const TOKEN_FILE = 'google-token.bin';
const CLIENT_FILE = 'google-client.bin';
const DEVICE_FILE = 'device-id';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const CLIENT_ID_RE = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;
const CLIENT_SECRET_RE = /^[A-Za-z0-9_\-]{10,100}$/;
const REFRESH_MARGIN_MS = 60 * 1000;
const PICTURE_TIMEOUT_MS = 5000;
const PICTURE_MAX_BYTES = 64 * 1024;
const REVOKE_TIMEOUT_MS = 5000;

// 범위 이름 → 그 권한을 주는 범위들 (더 넓은 범위가 이미 허용돼 있으면 그것도 인정한다)
const G = 'https://www.googleapis.com/auth/';
const SCOPE_NAMES = {
  calendarList: [G + 'calendar.calendarlist.readonly', G + 'calendar.calendarlist', G + 'calendar.readonly', G + 'calendar'],
  eventsRead: [G + 'calendar.events.readonly', G + 'calendar.events', G + 'calendar.readonly', G + 'calendar'],
  appCalendar: [G + 'calendar.app.created', G + 'calendar']
};

// 오류 type → 화면 문구 (§부록 A)
const MESSAGES = {
  not_configured: '먼저 Google Cloud에서 만든 클라이언트를 붙여 넣어 주세요.',
  invalid_client_input: '클라이언트 ID 형식이 맞지 않아요. ‘…apps.googleusercontent.com’으로 끝나는 값을 붙여 넣어 주세요.',
  listen_failed: '로그인 창을 받을 준비를 하지 못했어요. 잠시 뒤 다시 시도해 주세요.',
  canceled: '로그인을 취소했어요.',
  timeout: '5분 안에 로그인이 끝나지 않아 연결을 멈췄어요.',
  denied: '권한 허용이 취소됐어요. 테스트 사용자로 추가한 계정인지 확인해 주세요.',
  state_mismatch: '잘못된 로그인 응답이에요.',
  needs_secret: '이 클라이언트는 보안 비밀번호가 필요해요. 콘솔에서 복사한 보안 비밀번호를 함께 붙여 넣어 주세요.',
  invalid_client: '클라이언트 ID나 보안 비밀번호가 맞지 않아요. 다시 확인해 주세요.',
  invalid_grant: 'Google 로그인이 만료됐어요. 다시 연결해 주세요.',
  reauth: 'Google 로그인이 만료됐어요. 다시 연결해 주세요.',
  bad_id_token: '로그인 정보를 확인하지 못했어요. 다시 시도해 주세요.',
  no_refresh_token: '로그인 정보를 다 받지 못했어요. 다시 시도해 주세요.',
  network: '인터넷에 연결되지 않아 Google에 닿지 못했어요. 연결되면 다시 시도해 주세요.',
  server: 'Google 서버 문제로 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.',
  storage: '이 컴퓨터에서는 안전하게 저장할 수 없어요.',
  not_signed_in: 'Google 계정이 연결되어 있지 않아요.',
  unavailable: 'Google 캘린더 연결은 데스크톱 앱에서만 쓸 수 있어요.',
  unknown: '알 수 없는 오류로 연결하지 못했어요.'
};
const RETRYABLE = new Set(['listen_failed', 'canceled', 'timeout', 'bad_id_token', 'no_refresh_token', 'network', 'server']);
const MSG_WEB_CLIENT = '웹 애플리케이션 유형의 클라이언트예요. ‘데스크톱 앱’ 유형으로 새로 만들어 주세요.';
const MSG_BAD_JSON = 'JSON 내용을 읽지 못했어요. 내려받은 파일 내용을 통째로 붙여 넣어 주세요.';
const MSG_BAD_SECRET = '보안 비밀번호 형식이 맞지 않아요. 콘솔에서 복사한 값을 그대로 붙여 넣어 주세요.';

function authError(type, message) {
  return { type, message: message || MESSAGES[type] || MESSAGES.unknown, retryable: RETRYABLE.has(type) };
}

// ------------------------------------------------------------------ 가림 (redact)
// 이 프로세스가 아는 비밀 값 (클라이언트 secret, refresh/access token) — 오류 문구에 그대로 섞여 들어와도 가린다.
const known = new Set();
function remember(v) {
  if (typeof v !== 'string' || v.length < 8) return;
  known.add(v);
  if (known.size > 64) known.delete(known.values().next().value);
}
const MASK = '[가림]';
function redact(text) {
  let s = String(text == null ? '' : text);
  known.forEach((k) => { if (s.includes(k)) s = s.split(k).join(MASK); });
  return s
    .replace(/eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]*/g, MASK)                       // JWT (id_token)
    .replace(/ya29\.[A-Za-z0-9_\-.]+/g, MASK)                                                       // access token
    .replace(/1\/\/[A-Za-z0-9_\-.]+/g, MASK)                                                        // refresh token
    .replace(/GOCSPX-[A-Za-z0-9_\-]+/g, MASK)                                                       // client secret
    .replace(/\b(code|code_verifier|refresh_token|access_token|id_token|client_secret|token)=[^&\s"'<>]+/g, '$1=' + MASK)
    .replace(/("(?:code|code_verifier|refresh_token|access_token|id_token|client_secret|refreshToken|accessToken|clientSecret)"\s*:\s*)"[^"]*"/g, '$1"' + MASK + '"')
    .replace(/\bBearer\s+[A-Za-z0-9_\-.~+\/]+=*/g, 'Bearer ' + MASK);
}

// ------------------------------------------------------------------ 순수 도우미
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const defaultSha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

function makePkce(randomBytes = crypto.randomBytes, sha256 = defaultSha256) {
  const verifier = b64url(randomBytes(32));                    // 43자, [A-Za-z0-9-_]
  const challenge = b64url(sha256(Buffer.from(verifier, 'ascii')));
  return { verifier, challenge };
}

function buildAuthUrl({ endpoint = ENDPOINTS.auth, clientId, redirectUri, scopes = SCOPES, state, nonce, challenge, loginHint } = {}) {
  const q = new URLSearchParams();
  q.set('client_id', clientId);
  q.set('redirect_uri', redirectUri);
  q.set('response_type', 'code');
  q.set('scope', scopes.join(' '));
  q.set('code_challenge', challenge);
  q.set('code_challenge_method', 'S256');
  q.set('state', state);
  q.set('nonce', nonce);
  q.set('access_type', 'offline');
  q.set('prompt', loginHint ? 'consent' : 'select_account consent');
  q.set('include_granted_scopes', 'true');
  if (loginHint) q.set('login_hint', loginHint);
  return endpoint + '?' + q.toString();
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a == null ? '' : a));
  const y = Buffer.from(String(b == null ? '' : b));
  if (x.length !== y.length || !x.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function toMs(now) {
  if (typeof now === 'function') return toMs(now());
  if (now instanceof Date) return now.getTime();
  return typeof now === 'number' ? now : Date.now();
}

// id_token 은 토큰 엔드포인트에서 TLS 로 직접 받았으므로 서명 대신 내용만 확인한다 (OIDC Core 3.1.3.7).
function parseIdToken(jwt, { clientId, nonce, now } = {}) {
  const parts = typeof jwt === 'string' ? jwt.split('.') : [];
  if (parts.length !== 3 || !parts[1]) return { ok: false, reason: 'format' };
  let c;
  try { c = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch (e) { return { ok: false, reason: 'format' }; }
  if (!c || typeof c !== 'object') return { ok: false, reason: 'format' };
  if (!ISSUERS.includes(c.iss)) return { ok: false, reason: 'iss' };
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!clientId || !aud.includes(clientId)) return { ok: false, reason: 'aud' };
  if (!(typeof c.exp === 'number' && c.exp * 1000 > toMs(now))) return { ok: false, reason: 'exp' };
  if (nonce != null && !safeEqual(c.nonce, nonce)) return { ok: false, reason: 'nonce' };
  if (!c.sub || typeof c.sub !== 'string') return { ok: false, reason: 'sub' };
  return {
    ok: true,
    claims: {
      sub: c.sub,
      email: typeof c.email === 'string' ? c.email : null,
      name: typeof c.name === 'string' ? c.name : null,
      picture: typeof c.picture === 'string' ? c.picture : null
    }
  };
}

// 붙여 넣은 값 다듬기: 줄바꿈 제거, 앞뒤 공백·따옴표 제거
function cleanValue(v) {
  return String(v == null ? '' : v).replace(/[\r\n]+/g, '').trim()
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '').trim();
}

function parseClientInput(input) {
  const bad = (message) => ({ ok: false, error: authError('invalid_client_input', message) });
  const o = input && typeof input === 'object' ? input : {};
  let id = cleanValue(o.clientId);
  let secret = cleanValue(o.clientSecret);
  const text = String(o.text == null ? '' : o.text).trim();
  if (text) {
    let j;
    try { j = JSON.parse(text); } catch (e) { return bad(MSG_BAD_JSON); }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return bad(MSG_BAD_JSON);
    if (j.web && !j.installed) return bad(MSG_WEB_CLIENT);
    const src = j.installed && typeof j.installed === 'object' ? j.installed : j;
    id = cleanValue(src.client_id);
    secret = cleanValue(src.client_secret);
  }
  if (!CLIENT_ID_RE.test(id)) return bad();
  if (secret && !CLIENT_SECRET_RE.test(secret)) return bad(MSG_BAD_SECRET);
  return { ok: true, clientId: id, clientSecret: secret || null };
}

// 환경변수(DAYNOTE_ 접두사 우선)·.env 의 클라이언트를 모듈로 옮기고 env 에서 지운다 (자식 프로세스에 물려주지 않게).
// GOOGLE_API_KEY 는 Gemini 키라서 건드리지 않는다.
const ENV_ID = ['DAYNOTE_GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_ID'];
const ENV_SECRET = ['DAYNOTE_GOOGLE_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET'];
function captureEnvClient(env = process.env, dotenvKeys = []) {
  const pick = (names) => names.find((k) => cleanValue(env[k])) || null;
  const idKey = pick(ENV_ID);
  const secretKey = pick(ENV_SECRET);
  const clientId = idKey ? cleanValue(env[idKey]) : '';
  const clientSecret = secretKey ? cleanValue(env[secretKey]) : '';
  ENV_ID.concat(ENV_SECRET).forEach((k) => { delete env[k]; });
  if (!clientId) return null;
  remember(clientSecret);
  const fromDotenv = Array.isArray(dotenvKeys) && dotenvKeys.includes(idKey);
  return { clientId, clientSecret: clientSecret || null, source: fromDotenv ? 'dotenv' : 'env' };
}

function idHint(clientId) {
  if (!clientId) return null;
  const at = clientId.indexOf('.apps.');
  return at > 4 ? clientId.slice(0, 4) + '…' + clientId.slice(at + 1) : clientId.slice(0, 4) + '…';
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function resultPage(message) {
  return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Daynote</title><style>body{font:16px/1.6 system-ui,-apple-system,"Segoe UI","Malgun Gothic",sans-serif;'
    + 'max-width:28em;margin:15vh auto;padding:0 16px;color:#222;background:#fff}</style></head><body><p>'
    + escapeHtml(message) + '</p></body></html>';
}
const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  'Referrer-Policy': 'no-referrer',
  'Connection': 'close'
};
const PAGE_FAIL = '연결하지 못했어요. Daynote에서 다시 시도해 주세요.';

// ------------------------------------------------------------------ 서비스
function create(opts = {}) {
  const {
    userDataDir, safeStorage,
    openExternal = async () => {},
    createServer = () => http.createServer(),
    randomBytes = crypto.randomBytes,
    sha256 = defaultSha256,
    now = Date.now,
    timeoutMs = 300000, exchangeTimeoutMs = 15000, requestTimeoutMs = 20000,
    endpoints = ENDPOINTS, scopes = SCOPES,
    env = null,
    onStatus = () => {}, onFocusApp = () => {}, log = () => {}
  } = opts;
  const fetchFn = opts.fetch || ((u, init) => globalThis.fetch(u, init));
  const setTimer = opts.setTimeout || global.setTimeout;
  const clearTimer = opts.clearTimeout || global.clearTimeout;
  const nowMs = () => toMs(now);
  const iso = () => new Date(nowMs()).toISOString();
  const say = (msg) => { try { log(redact(msg)); } catch (e) {} };

  const tokenStore = createSecretStore(userDataDir, safeStorage, TOKEN_FILE);
  const clientStore = createSecretStore(userDataDir, safeStorage, CLIENT_FILE);

  let clientCache;               // undefined = 아직 안 읽음, null = 없음
  let tokenCache;
  let access = null;             // { token, expiresAt }
  let pending = null;            // 진행 중인 로그인 흐름
  let refreshing = null;         // 진행 중인 갱신 Promise (동시에 불려도 한 번만 보낸다)
  let errorState = null;         // invalid_client — 상태 'error'
  let lastError = null;          // 마지막 로그인 실패 (화면 안내용)
  let gen = 0;                   // 로그인·로그아웃·클라이언트 변경마다 +1 — 늦게 끝난 갱신 결과를 버린다
  let device = null;
  let lastEmitted = null;

  if (env && env.clientSecret) remember(env.clientSecret);

  // ---------------- 파일
  function savedClient() {
    if (clientCache === undefined) {
      const c = clientStore.read();
      clientCache = c && typeof c.clientId === 'string' && c.clientId ? c : null;
      if (clientCache) remember(clientCache.clientSecret);
    }
    return clientCache;
  }
  function loadToken() {
    if (tokenCache === undefined) {
      const t = tokenStore.read();
      tokenCache = t && t.v === 1 && typeof t.clientId === 'string' ? t : null;
      if (tokenCache) remember(tokenCache.refreshToken);
    }
    return tokenCache;
  }
  function saveToken(t) {
    tokenCache = t;
    if (t) remember(t.refreshToken);
    return t ? tokenStore.write(t) : tokenStore.clear();
  }
  function effectiveClient() {
    const s = savedClient();
    if (s) return { clientId: s.clientId, clientSecret: s.clientSecret || null, source: 'saved' };
    if (env && env.clientId) return { clientId: env.clientId, clientSecret: env.clientSecret || null, source: env.source === 'dotenv' ? 'dotenv' : 'env' };
    return null;
  }
  // 지금 클라이언트로 받은 토큰만 쓴다 (클라이언트를 바꿨으면 무효 → signed_out)
  function currentToken(client = effectiveClient()) {
    const t = loadToken();
    return t && client && t.clientId === client.clientId ? t : null;
  }

  function deviceId() {
    if (device) return device;
    const file = path.join(userDataDir, DEVICE_FILE);
    try {
      const v = fs.readFileSync(file, 'utf8').trim();
      if (/^[0-9a-f]{16}$/.test(v)) { device = v; return device; }
    } catch (e) {}
    device = Buffer.from(randomBytes(8)).toString('hex');
    try { fs.mkdirSync(userDataDir, { recursive: true }); fs.writeFileSync(file, device + '\n'); } catch (e) {}
    return device;
  }

  // ---------------- 상태
  function scopeSet(t) { return new Set(String((t && t.scope) || '').split(/\s+/).filter(Boolean)); }
  function hasScopeIn(set, nameOrUrl) {
    const urls = Object.prototype.hasOwnProperty.call(SCOPE_NAMES, nameOrUrl) ? SCOPE_NAMES[nameOrUrl] : [String(nameOrUrl)];
    return urls.some((u) => set.has(u));
  }
  function accountIdOf(t) {
    const sub = t && t.account && t.account.sub;
    return sub ? Buffer.from(sha256(Buffer.from(String(sub), 'utf8'))).toString('hex').slice(0, 16) : null;
  }

  function status() {
    const client = effectiveClient();
    const t = currentToken(client);
    let state;
    if (!client) state = 'needs_setup';
    else if (pending) state = 'connecting';
    else if (!t) state = 'signed_out';
    else if (!t.refreshToken) state = 'reauth';
    else if (errorState) state = 'error';
    else state = 'signed_in';
    const set = scopeSet(t && t.refreshToken ? t : null);
    const acc = (t && t.account) || null;
    return {
      available: true,
      state,
      signedIn: state === 'signed_in',
      email: (acc && acc.email) || null,
      name: (acc && acc.name) || null,
      picture: (acc && acc.pictureData) || null,
      accountId: accountIdOf(t),
      deviceId: deviceId(),
      scopes: { calendarList: hasScopeIn(set, 'calendarList'), eventsRead: hasScopeIn(set, 'eventsRead'), appCalendar: hasScopeIn(set, 'appCalendar') },
      client: { configured: !!client, source: client ? client.source : null, idHint: client ? idHint(client.clientId) : null, hasSecret: !!(client && client.clientSecret) },
      exportCalendarId: (t && t.exportCalendarId) || null,
      error: state === 'error' ? errorState : (state === 'connecting' ? null : lastError)
    };
  }
  function emit() {
    const st = status();
    const key = JSON.stringify(st);
    if (key === lastEmitted) return st;
    lastEmitted = key;
    try { onStatus(st); } catch (e) {}
    return st;
  }
  const failWith = (error) => ({ ok: false, error, status: emit() });

  // ---------------- HTTP (토큰 엔드포인트, form)
  async function postForm(url, params, ms) {
    const body = new URLSearchParams();
    Object.keys(params).forEach((k) => { if (params[k] != null && params[k] !== '') body.append(k, String(params[k])); });
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ac ? setTimer(() => ac.abort(), ms) : null;
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
        signal: ac ? ac.signal : undefined
      });
      let json = null;
      try { json = await res.json(); } catch (e) { json = null; }
      return { ok: !!res.ok, status: res.status, json };
    } catch (e) {
      say('google token: ' + (ac && ac.signal.aborted ? 'timeout' : 'network') + ' ' + ((e && e.message) || e));
      return { ok: false, status: 0, network: true, json: null };
    } finally {
      if (timer) clearTimer(timer);
    }
  }
  // 토큰 엔드포인트 오류 → 인증 오류 type
  function tokenError(r) {
    if (r.network) return authError('network');
    const j = r.json || {};
    const code = typeof j.error === 'string' ? j.error : '';
    const desc = String(j.error_description || '');
    if (code === 'invalid_request' && /client_secret is missing/i.test(desc)) return authError('needs_secret');
    if (code === 'invalid_client' || code === 'unauthorized_client') return authError('invalid_client');
    if (code === 'invalid_grant') return authError('invalid_grant');
    if (r.status >= 500) return authError('server');
    return authError('unknown');
  }

  async function fetchPicture(url) {
    if (typeof url !== 'string' || !/^https:\/\/[^\s]+$/.test(url)) return null;
    const sized = /=s\d+(-c)?$/.test(url) ? url.replace(/=s\d+(-c)?$/, '=s64-c') : url + '=s64-c';
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ac ? setTimer(() => ac.abort(), PICTURE_TIMEOUT_MS) : null;
    try {
      const res = await fetchFn(sized, { method: 'GET', signal: ac ? ac.signal : undefined });
      if (!res || !res.ok || typeof res.arrayBuffer !== 'function') return null;
      const type = String((res.headers && res.headers.get('content-type')) || '').split(';')[0].trim().toLowerCase();
      if (!/^image\/(png|jpeg|gif|webp)$/.test(type)) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > PICTURE_MAX_BYTES) return null;
      return 'data:' + type + ';base64,' + buf.toString('base64');
    } catch (e) {
      return null;
    } finally {
      if (timer) clearTimer(timer);
    }
  }

  // ---------------- 로그인
  async function exchangeCode(flow, code) {
    const r = await postForm(endpoints.token, {
      code,
      client_id: flow.client.clientId,
      client_secret: flow.client.clientSecret || null,
      redirect_uri: flow.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: flow.pkce.verifier
    }, exchangeTimeoutMs);
    if (!r.ok) return { ok: false, error: tokenError(r) };
    const j = r.json || {};
    if (typeof j.access_token !== 'string' || !j.access_token) return { ok: false, error: authError('server') };
    remember(j.access_token);
    if (typeof j.refresh_token !== 'string' || !j.refresh_token) return { ok: false, error: authError('no_refresh_token') };
    remember(j.refresh_token);
    const idr = parseIdToken(j.id_token, { clientId: flow.client.clientId, nonce: flow.nonce, now: nowMs() });
    if (!idr.ok) { say('google id_token 거부: ' + idr.reason); return { ok: false, error: authError('bad_id_token') }; }
    const claims = idr.claims;
    const pictureData = await fetchPicture(claims.picture);
    if (flow.done) return { ok: false, error: authError('canceled') };
    const prev = loadToken();
    const sameAccount = prev && prev.clientId === flow.client.clientId && prev.account && prev.account.sub === claims.sub;
    const t = {
      v: 1,
      clientId: flow.client.clientId,
      refreshToken: j.refresh_token,
      scope: typeof j.scope === 'string' && j.scope.trim() ? j.scope.trim() : scopes.join(' '),
      grantedAt: iso(),
      account: { sub: claims.sub, email: claims.email, name: claims.name, pictureData },
      exportCalendarId: sameAccount ? (prev.exportCalendarId || null) : null
    };
    const w = saveToken(t);
    if (!w.ok) { tokenCache = undefined; return { ok: false, error: authError('storage', w.error === MESSAGES.storage ? undefined : redact(w.error)) }; }
    gen++;
    access = { token: j.access_token, expiresAt: nowMs() + Math.max(0, Number(j.expires_in) || 3600) * 1000 };
    errorState = null;
    lastError = null;
    return { ok: true, email: claims.email };
  }

  function cancelPending(type) {
    if (pending) pending.finish({ ok: false, error: authError(type) });
  }

  function signIn(o = {}) {
    cancelPending('canceled');
    const client = effectiveClient();
    if (!client) return Promise.resolve(failWith(authError('not_configured')));
    const prev = currentToken(client);
    const loginHint = (o && typeof o.loginHint === 'string' && o.loginHint.trim()) ? o.loginHint.trim()
      : (prev && prev.account && prev.account.email) || null;
    const flow = {
      client, done: false, server: null, port: 0, redirectUri: null, timer: null, exchange: null,
      pkce: makePkce(randomBytes, sha256),
      state: b64url(randomBytes(32)),
      nonce: b64url(randomBytes(16))
    };
    pending = flow;
    lastError = null;
    say('google 로그인 시작');

    return new Promise((resolve) => {
      flow.finish = (result) => {
        if (flow.done) return;
        flow.done = true;
        if (flow.timer) clearTimer(flow.timer);
        if (flow.server) {
          try { flow.server.close(); } catch (e) {}
          // 시간 초과·취소: 보내는 중인 응답이 없으니 남은 연결도 바로 끊는다 (결과 페이지는 Connection: close 로 스스로 닫힌다)
          const type = result.error && result.error.type;
          if ((type === 'timeout' || type === 'canceled') && typeof flow.server.closeAllConnections === 'function') {
            try { flow.server.closeAllConnections(); } catch (e) {}
          }
        }
        if (pending === flow) pending = null;
        if (!result.ok && result.error && result.error.type !== 'canceled') lastError = result.error;
        say('google 로그인 끝: ' + (result.ok ? 'ok' : result.error.type));
        const st = emit();
        resolve(result.ok ? { ok: true, status: st } : { ok: false, error: result.error, status: st });
      };

      const send = (res, code, message) => {
        try { res.writeHead(code, PAGE_HEADERS); res.end(resultPage(message)); } catch (e) {}
      };
      const handle = async (req, res) => {
        if (flow.done) return send(res, 400, PAGE_FAIL);
        if (req.method !== 'GET') return send(res, 405, PAGE_FAIL);
        if (req.headers.host !== '127.0.0.1:' + flow.port) return send(res, 400, PAGE_FAIL);   // DNS 리바인딩 방지
        let u;
        try { u = new URL(req.url, 'http://127.0.0.1:' + flow.port); } catch (e) { return send(res, 400, PAGE_FAIL); }
        if (u.pathname !== '/') return send(res, 404, PAGE_FAIL);
        if (!safeEqual(u.searchParams.get('state'), flow.state)) {               // 계속 기다린다
          say('google 로그인: state_mismatch');
          return send(res, 400, PAGE_FAIL);
        }
        if (u.searchParams.get('error')) {
          send(res, 200, PAGE_FAIL);
          flow.finish({ ok: false, error: authError('denied') });
          try { onFocusApp(); } catch (e) {}
          return;
        }
        const code = u.searchParams.get('code');
        if (!code) return send(res, 400, PAGE_FAIL);
        // 같은 code 로 두 번 들어와도(새로고침 등) 교환은 한 번만 하고 같은 결과를 보여 준다
        if (!flow.exchange) flow.exchange = exchangeCode(flow, code).catch((e) => ({ ok: false, error: authError('unknown', redact((e && e.message) || e)) }));
        const r = await flow.exchange;
        send(res, 200, r.ok ? 'Daynote에 연결했어요 · ' + (r.email || '') + '. 이 탭을 닫고 Daynote로 돌아가세요.' : PAGE_FAIL);
        if (flow.done) return;
        flow.finish(r);
        try { onFocusApp(); } catch (e) {}
      };

      let server;
      try { server = createServer(); } catch (e) { flow.finish({ ok: false, error: authError('listen_failed') }); return; }
      flow.server = server;
      server.on('request', (req, res) => { handle(req, res).catch(() => send(res, 500, PAGE_FAIL)); });
      server.on('clientError', (err, socket) => { try { socket.destroy(); } catch (e) {} });
      server.on('error', (e) => {
        say('google 로그인 서버 오류: ' + ((e && e.message) || e));
        flow.finish({ ok: false, error: authError('listen_failed') });
      });
      try {
        server.listen(0, '127.0.0.1', async () => {
          if (flow.done) { try { server.close(); } catch (e) {} return; }
          flow.port = server.address().port;
          flow.redirectUri = 'http://127.0.0.1:' + flow.port;
          emit();                                                                   // connecting
          const url = buildAuthUrl({
            endpoint: endpoints.auth, clientId: client.clientId, redirectUri: flow.redirectUri, scopes,
            state: flow.state, nonce: flow.nonce, challenge: flow.pkce.challenge, loginHint
          });
          if (url.indexOf(endpoints.auth + '?') !== 0) { flow.finish({ ok: false, error: authError('unknown') }); return; }
          flow.timer = setTimer(() => flow.finish({ ok: false, error: authError('timeout') }), timeoutMs);
          try { await openExternal(url); }
          catch (e) {
            say('google 로그인: 브라우저 열기 실패 ' + ((e && e.message) || e));
            flow.finish({ ok: false, error: authError('listen_failed', '로그인 창을 열지 못했어요. 잠시 뒤 다시 시도해 주세요.') });
          }
        });
      } catch (e) {
        flow.finish({ ok: false, error: authError('listen_failed') });
      }
    });
  }

  function cancelSignIn() {
    cancelPending('canceled');
    return { ok: true };
  }

  // ---------------- access token
  function getAccessToken(o = {}) {
    const client = effectiveClient();
    const t = currentToken(client);
    if (!client || !t) return Promise.resolve({ ok: false, error: authError('not_signed_in') });
    if (!t.refreshToken) return Promise.resolve({ ok: false, error: authError('reauth') });
    if (!o.forceRefresh && access && access.expiresAt - REFRESH_MARGIN_MS > nowMs()) {
      return Promise.resolve({ ok: true, accessToken: access.token, expiresAt: access.expiresAt });
    }
    if (refreshing) return refreshing;
    const myGen = gen;
    const p = refresh(client, t, myGen).catch((e) => ({ ok: false, error: authError('unknown', redact((e && e.message) || e)) }));
    refreshing = p;
    p.then(() => { if (refreshing === p) refreshing = null; });
    return p;
  }

  async function refresh(client, t, myGen) {
    const r = await postForm(endpoints.token, {
      grant_type: 'refresh_token',
      refresh_token: t.refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret || null
    }, requestTimeoutMs);
    if (myGen !== gen) return { ok: false, error: authError('not_signed_in') };   // 그 사이 로그아웃·재로그인
    const j = r.json || {};
    if (r.ok && typeof j.access_token === 'string' && j.access_token) {
      remember(j.access_token);
      const cur = loadToken();
      const next = Object.assign({}, cur);
      let changed = false;
      if (typeof j.refresh_token === 'string' && j.refresh_token && j.refresh_token !== cur.refreshToken) { next.refreshToken = j.refresh_token; changed = true; }
      if (typeof j.scope === 'string' && j.scope.trim() && j.scope.trim() !== cur.scope) { next.scope = j.scope.trim(); changed = true; }
      if (changed) {
        const w = saveToken(next);
        if (!w.ok) say('google 토큰 파일 갱신 실패: ' + w.error);
      }
      access = { token: j.access_token, expiresAt: nowMs() + Math.max(0, Number(j.expires_in) || 3600) * 1000 };
      errorState = null;
      emit();
      return { ok: true, accessToken: access.token, expiresAt: access.expiresAt };
    }
    const e = tokenError(r);
    if (e.type === 'invalid_grant') {
      // 만료·폐기 — refresh token 만 지우고 계정(이메일)은 남긴다 → reauth, 다시 연결 때 login_hint
      const cur = loadToken();
      saveToken(Object.assign({}, cur, { refreshToken: null }));
      access = null;
      emit();
      return { ok: false, error: authError('reauth') };
    }
    if (e.type === 'invalid_client' || e.type === 'needs_secret') {
      errorState = e;
      access = null;
      emit();
      return { ok: false, error: e };
    }
    return { ok: false, error: e };                                                // network·server — 상태는 그대로
  }

  // ---------------- 로그아웃 · 폐기
  async function revoke(token) {
    if (!token) return true;                         // 지울 것이 없다 (이미 만료·폐기)
    const r = await postForm(endpoints.revoke, { token }, REVOKE_TIMEOUT_MS);
    if (r.ok) return true;
    return r.status === 400 && !!r.json && r.json.error === 'invalid_token';
  }
  // 로컬부터 확실히 지운다 → 폐기할 토큰을 돌려준다
  function localSignOut() {
    cancelPending('canceled');
    const t = loadToken();
    const token = (t && t.refreshToken) || (access && access.token) || null;
    saveToken(null);
    access = null;
    errorState = null;
    lastError = null;
    gen++;
    return token;
  }
  async function signOut() {
    const token = localSignOut();
    emit();
    let revoked = false;
    try { revoked = await revoke(token); } catch (e) { revoked = false; }
    return { ok: true, revoked, status: emit() };
  }

  // 클라이언트가 바뀌면 이전 클라이언트로 받은 토큰은 쓸 수 없다 → 로컬 로그아웃 + (가능하면) 폐기
  function afterClientChange() {
    const after = effectiveClient();
    const t = loadToken();
    errorState = null;
    lastError = null;
    if (t && (!after || t.clientId !== after.clientId)) {
      const token = localSignOut();
      if (token) revoke(token).catch(() => {});
    }
  }

  // ---------------- 클라이언트 설정
  function setClient(input) {
    const p = parseClientInput(input);
    if (!p.ok) return { ok: false, error: p.error, status: status() };
    cancelPending('canceled');
    const rec = { v: 1, clientId: p.clientId, clientSecret: p.clientSecret, savedAt: iso() };
    const w = clientStore.write(rec);
    if (!w.ok) return { ok: false, error: authError('storage', w.error === MESSAGES.storage ? undefined : redact(w.error)), status: status() };
    clientCache = rec;
    remember(rec.clientSecret);
    afterClientChange();
    return { ok: true, status: emit() };
  }
  function clearClient() {                             // 설정에 저장한 값만 지운다 (환경변수·.env 값은 남는다)
    cancelPending('canceled');
    clientStore.clear();
    clientCache = null;
    afterClientChange();
    return { ok: true, status: emit() };
  }

  // ---------------- 기타
  function hasScope(nameOrUrl) {
    const t = currentToken();
    return !!(t && t.refreshToken) && hasScopeIn(scopeSet(t), nameOrUrl);
  }
  function exportCalendarId() {
    const t = currentToken();
    return (t && t.exportCalendarId) || null;
  }
  function setExportCalendarId(id) {
    const t = currentToken();
    if (!t) return { ok: false };
    const w = saveToken(Object.assign({}, t, { exportCalendarId: id ? String(id) : null }));
    emit();
    return { ok: !!w.ok };
  }

  return { status, setClient, clearClient, signIn, cancelSignIn, signOut, getAccessToken, hasScope, exportCalendarId, setExportCalendarId, deviceId };
}

module.exports = { create, SCOPES, ENDPOINTS, makePkce, buildAuthUrl, parseIdToken, parseClientInput, captureEnvClient, redact };
