'use strict';

// AI 키 보관 — 설정 화면에서 넣은 키를 Windows 보안 저장소(DPAPI, Electron safeStorage)로 암호화해 둔다.
// 메인 프로세스에서만 쓴다. 화면(렌더러)에는 키를 돌려주지 않고 "저장됨 · 끝 4자리" 만 알려 준다.
//
// 개발용으로 앱 폴더의 .env (GEMINI_API_KEY=...) 도 읽는다. 환경변수가 이미 있으면 그쪽이 우선.

const fs = require('fs');
const path = require('path');

function loadDotEnv(dir) {
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

module.exports = { loadDotEnv, create };
