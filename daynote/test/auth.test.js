'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const AUTH = require('../services/auth');

// 가짜 보안 저장소 (DPAPI 대신)
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('enc:' + s), decryptString: (b) => String(b).replace(/^enc:/, '') };
function idToken(p) { return 'h.' + Buffer.from(JSON.stringify(p)).toString('base64url') + '.s'; }
function get(url) { return new Promise((r, j) => http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => r({ status: res.statusCode, body: b })); }).on('error', j)); }

// 브라우저 대신: 열라는 주소를 읽고, 로그인한 척 임시 주소로 code 를 돌려준다
function fakeGoogle(email, seen) {
  return {
    openExternal(url) {
      const u = new URL(url);
      seen.url = u;
      setTimeout(() => get(u.searchParams.get('redirect_uri') + '/?code=abc&state=' + u.searchParams.get('state')).then((r) => { seen.page = r.body; }), 10);
    },
    fetch: async (url, o) => {
      const body = new URLSearchParams(o.body);
      seen.posts = (seen.posts || []).concat([{ url, grant: body.get('grant_type'), verifier: body.get('code_verifier') }]);
      if (url.endsWith('/revoke')) return { ok: true, status: 200, json: async () => ({}) };
      if (body.get('grant_type') === 'refresh_token') return seen.revoked ? { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) } : { ok: true, status: 200, json: async () => ({ access_token: 'x' }) };
      return { ok: true, status: 200, json: async () => ({ id_token: idToken({ aud: 'cid', iss: 'https://accounts.google.com', exp: Date.now() / 1000 + 3600, email, email_verified: true, name: '배' }), refresh_token: 'rt-' + email, access_token: 'at' }) };
    }
  };
}

test('구글 로그인: 브라우저 → 임시 주소 → 토큰 교환, 처음 계정이 주인, 다른 계정은 막음, 로그아웃·연결 끊김', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-auth-'));
  const seen = {};
  const g = fakeGoogle('Me@Gmail.com', seen);
  const a = AUTH.create({ dir, safeStorage, clientId: 'cid', clientSecret: 'sec', openExternal: g.openExternal, fetch: g.fetch });
  assert.strictEqual(a.status().signedIn, false);
  const r = await a.signIn();
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.user.email, 'me@gmail.com');
  // PKCE·범위·임시 주소
  assert.strictEqual(seen.url.searchParams.get('code_challenge_method'), 'S256');
  assert.strictEqual(seen.url.searchParams.get('scope'), 'openid email profile');
  assert.match(seen.url.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(seen.posts[0].verifier && seen.posts[0].verifier.length >= 43);
  await new Promise((res) => setTimeout(res, 50));
  assert.match(seen.page, /로그인됐어요/);
  assert.deepStrictEqual(a.status().user, { email: 'me@gmail.com', name: '배' });
  // 토큰은 암호화해 저장 (평문 파일 없음)
  assert.strictEqual(fs.readFileSync(path.join(dir, 'account-token.bin'), 'utf8'), 'enc:rt-Me@Gmail.com');
  assert.ok(!fs.readFileSync(path.join(dir, 'account.json'), 'utf8').includes('rt-'));

  // 로그아웃 → 다른 계정은 못 들어온다 (주인은 남는다)
  await a.signOut();
  assert.strictEqual(a.status().signedIn, false);
  const other = fakeGoogle('other@gmail.com', {});
  const b = AUTH.create({ dir, safeStorage, clientId: 'cid', clientSecret: 'sec', openExternal: other.openExternal, fetch: other.fetch });
  const r2 = await b.signIn();
  assert.strictEqual(r2.error, 'not_allowed');
  assert.match(r2.message, /m••@gmail\.com/);
  assert.strictEqual(b.status().signedIn, false);

  // 다시 주인으로 → Google 에서 연결을 끊으면 켤 때 로그아웃
  const s3 = {};
  const g3 = fakeGoogle('me@gmail.com', s3);
  const c = AUTH.create({ dir, safeStorage, clientId: 'cid', clientSecret: 'sec', openExternal: g3.openExternal, fetch: g3.fetch });
  assert.strictEqual((await c.signIn()).ok, true);
  assert.strictEqual((await c.check()).checked, true);
  s3.revoked = true;
  assert.strictEqual((await c.check()).signedOut, true);
  assert.strictEqual(c.status().signedIn, false);
});

test('구글 로그인: 설정이 없으면 시작하지 않는다 · 다른 앱용 토큰은 거부', async () => {
  const a = AUTH.create({ dir: os.tmpdir(), safeStorage, clientId: '', clientSecret: '', openExternal: () => { throw new Error('열면 안 됨'); } });
  assert.strictEqual((await a.signIn()).error, 'not_configured');
  assert.throws(() => AUTH.readIdToken(idToken({ aud: 'other', iss: 'https://accounts.google.com', email: 'a@b.c' }), 'cid'), /다른 앱/);
});
