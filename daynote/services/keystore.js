'use strict';

// 비밀 값 보관 — 설정 화면에서 넣은 키·로그인 정보를 Windows 보안 저장소(DPAPI, Electron safeStorage)로 암호화해 둔다.
// 메인 프로세스에서만 쓴다. 화면(렌더러)에는 비밀 값을 돌려주지 않고 "저장됨 · 끝 4자리" 같은 표시만 알려 준다.
//
//   create(dir, safeStorage)                 — AI 키 (ai-key.bin, Gemini 키 형식만 받는다)
//   createSecretStore(dir, safeStorage, 파일) — 범용 암호화 JSON 파일 (google-token.bin · google-client.bin)
//
// 개발용으로 앱 폴더의 .env (GEMINI_API_KEY=..., GOOGLE_CLIENT_ID=...) 도 읽는다. 환경변수가 이미 있으면 그쪽이 우선.

const fs = require('fs');
const path = require('path');

// out (선택): 이번에 .env 에서 채운 키 이름을 넣어 준다 — Google 클라이언트 출처('dotenv')를 가리는 데 쓴다.
function loadDotEnv(dir, out) {
  const file = path.join(dir, '.env');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return false; }
  let found = false;
  text.split(/\r?\n/).forEach((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) return;
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (!process.env[m[1]] && v) {
      process.env[m[1]] = v;
      if (Array.isArray(out)) out.push(m[1]);
      if (m[1] === 'GEMINI_API_KEY' || m[1] === 'GOOGLE_API_KEY') found = true;
    }
  });
  if (found) process.env.DAYNOTE_KEY_FROM_DOTENV = '1';
  return found;
}

function create(userDataDir, safeStorage) {
  const file = path.join(userDataDir, 'ai-key.bin');
  function read() {
    try {
      const buf = fs.readFileSync(file);
      if (!safeStorage.isEncryptionAvailable()) return '';
      return safeStorage.decryptString(buf);
    } catch (e) { return ''; }
  }
  function save(key) {
    key = String(key || '').trim();
    if (!key) return { ok: false, error: '키가 비어 있어요.' };
    if (!/^[A-Za-z0-9_\-]{20,200}$/.test(key)) return { ok: false, error: '키 형식이 맞지 않아요. Google AI Studio에서 복사한 키를 그대로 붙여 넣어 주세요.' };
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: '이 컴퓨터에서는 키를 안전하게 저장할 수 없어요.' };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, safeStorage.encryptString(key));
    return { ok: true };
  }
  function clear() { try { fs.unlinkSync(file); } catch (e) {} return { ok: true }; }
  function hint(key) { return key ? '••••' + key.slice(-4) : null; }
  return { read, save, clear, hint };
}

// 범용 암호화 JSON 파일. 평문은 디스크에 닿지 않는다.
//   read()    → 객체 | null  (없음·암호화 불가·복호화 실패·JSON 오류 → null, 오류는 삼킨다)
//   write(o)  → { ok:true } | { ok:false, error }   (tmp 파일에 0o600 으로 쓰고 rename — 중간에 꺼져도 반쪽 파일이 남지 않는다)
//   clear()   → { ok:true }  (없어도 성공)
//   exists()  → boolean
const NO_SAFE_STORAGE = '이 컴퓨터에서는 안전하게 저장할 수 없어요.';

function createSecretStore(userDataDir, safeStorage, fileName) {
  const name = String(fileName || '');
  if (!name || path.basename(name) !== name) throw new Error('createSecretStore: 파일 이름만 넣어 주세요.');
  const file = path.join(userDataDir, name);
  const tmp = file + '.tmp';
  const canEncrypt = () => {
    try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch (e) { return false; }
  };

  function read() {
    try {
      if (!fs.existsSync(file) || !canEncrypt()) return null;
      const obj = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
    } catch (e) { return null; }
  }
  function write(obj) {
    if (!canEncrypt()) return { ok: false, error: NO_SAFE_STORAGE };
    try {
      const enc = safeStorage.encryptString(JSON.stringify(obj));
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(tmp, enc, { mode: 0o600 });
      fs.renameSync(tmp, file);
      return { ok: true };
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) {}
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }
  function clear() {
    try { fs.unlinkSync(file); } catch (e) {}
    try { fs.unlinkSync(tmp); } catch (e) {}
    return { ok: true };
  }
  function exists() { try { return fs.existsSync(file); } catch (e) { return false; } }
  return { read, write, clear, exists };
}

module.exports = { loadDotEnv, create, createSecretStore };
