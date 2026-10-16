'use strict';

// AI 요청 처리 고침 (2) — 풀 수 없는 저장 키, 키 저장 실패, 메모마다 겹치는 요청, 앱 시작 직후 상태 확인 중 입력,
// 꺼지는 사이 남은 '생각 중' 말풍선, 키 문제 실패 카드의 [설정 열기].

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const K = require('../services/keystore');
const O = require('../src/core/ai/organizeNote');
const C = require('../src/core/ai/capture');

const ENV = ['DAYNOTE_AI_FAKE', 'DAYNOTE_AI_PROVIDER', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'DAYNOTE_KEY_FROM_DOTENV'];
function withEnv(vars, fn) {
  const saved = {};
  ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  Object.assign(process.env, vars);
  const restore = () => ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  return Promise.resolve().then(fn).finally(restore);
}
function freshAi() {
  delete require.cache[require.resolve('../services/ai')];
  return require('../services/ai');
}
const okSafe = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('enc:' + Buffer.from(s).toString('base64')),
  decryptString: (b) => Buffer.from(String(b).slice(4), 'base64').toString()
});
const KEY = 'AIzaSyEXAMPLEKEY_abcdefghijklmn';

// 화면 코드에서 함수 하나만 떼어 낸다 (들여쓰기 2칸의 function ... 부터 같은 들여쓰기의 닫는 } 까지)
function extractFn(rel, name) {
  const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const start = src.indexOf('  function ' + name + '(');
  assert.ok(start >= 0, name + ' 없음');
  const end = src.indexOf('\n  }\n', start);
  return src.slice(start, end + 4);
}

// ---------------------------------------------------------------- 풀 수 없는 저장 키
test('keystore: 파일은 있는데 복호화가 안 되면 read() 는 \'\' 이고 exists() 는 true', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-key-'));
  const safe = okSafe();
  const ks = K.create(dir, safe);
  assert.strictEqual(ks.exists(), false);
  assert.strictEqual(ks.save(KEY).ok, true);
  safe.decryptString = () => { throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.'); };
  assert.strictEqual(ks.read(), '');
  assert.strictEqual(ks.exists(), true);
  safe.isEncryptionAvailable = () => false;
  assert.strictEqual(ks.read(), '');
  assert.strictEqual(ks.exists(), true);
  ks.clear();
  assert.strictEqual(ks.exists(), false);
});

test('main aiStatus: 풀 수 없는 저장 키는 savedKeyBroken, 멀쩡한 키는 아니다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const m = /function aiStatus\(\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(m, 'aiStatus 없음');
  const make = (keystore) => new Function('keystore', 'ai', m[0] + '; return aiStatus;')(keystore, { status: () => ({ configured: false, reason: 'x' }) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-key-'));
  const safe = okSafe();
  const ks = K.create(dir, safe);
  assert.strictEqual(make(ks)().savedKeyBroken, false);                        // 키 없음
  ks.save(KEY);
  assert.deepStrictEqual([make(ks)().savedKey, make(ks)().savedKeyBroken], ['••••klmn', false]);
  safe.decryptString = () => { throw new Error('nope'); };
  assert.deepStrictEqual([make(ks)().savedKey, make(ks)().savedKeyBroken], [null, true]);
  assert.strictEqual(make(null)().savedKeyBroken, false);
});

test('설정 aiLine: 풀 수 없는 키는 err 줄, 멀쩡한 키인데 제공자를 Claude 로 강제해 꺼진 것은 err 줄이 아니다', () => {
  const mk = (kind) => new Function('S', extractFn('renderer/views/settings.js', 'aiLine') + '; return aiLine;')({ host: { kind } });
  const aiLine = mk('electron');
  const broken = aiLine({ configured: false, provider: null, reason: 'AI 키가 없습니다.', savedKey: null, savedKeyBroken: true });
  assert.strictEqual(broken.dot, '.err');
  assert.strictEqual(broken.text, '저장한 키를 쓸 수 없어요');
  const forced = aiLine({ configured: false, provider: null, reason: 'ANTHROPIC_API_KEY 환경변수가 설정되어 있지 않습니다.', savedKey: '••••abcd', savedKeyBroken: false });
  assert.notStrictEqual(forced.dot, '.err');
  assert.strictEqual(forced.text, 'AI 꺼짐');
  assert.strictEqual(aiLine({ configured: true, provider: 'gemini', savedKey: '••••abcd' }).text, '켜짐 · Google Gemini');
  // 브라우저 호스트는 savedKeyBroken 을 보내지 않는다
  assert.strictEqual(mk('browser')({ configured: false, provider: null, reason: '...' }).text, '브라우저 미리보기');
});

// ---------------------------------------------------------------- 키 저장 실패
test('keystore.save: 암호화가 던지거나 폴더에 쓸 수 없으면 던지지 않고 ok:false, tmp 파일도 남기지 않는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-key-'));
  const safe = okSafe();
  safe.encryptString = () => { throw new Error('Error while encrypting the text provided to safeStorage.encryptString.'); };
  const r = K.create(dir, safe).save(KEY);
  assert.deepStrictEqual(r, { ok: false, error: '키를 저장하지 못했어요.' });
  assert.deepStrictEqual(fs.readdirSync(dir), []);

  const asFile = path.join(dir, 'not-a-dir');
  fs.writeFileSync(asFile, 'x');
  const r2 = K.create(path.join(asFile, 'sub'), okSafe()).save(KEY);
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.error, '키를 저장하지 못했어요.');

  const throwsAvail = okSafe();
  throwsAvail.isEncryptionAvailable = () => { throw new Error('boom'); };
  assert.strictEqual(K.create(dir, throwsAvail).save(KEY).ok, false);

  const ks = K.create(dir, okSafe());
  assert.strictEqual(ks.save(KEY).ok, true);
  assert.ok(!fs.existsSync(path.join(dir, 'ai-key.bin.tmp')));
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(dir, 'ai-key.bin')).mode & 0o777, 0o600);
  assert.strictEqual(ks.read(), KEY);
});

test('설정 키 저장: 실패하면 붙여 넣은 값을 지우지 않고, 거부(reject)돼도 결과 칸에 알린다', () => {
  const src = extractFn('renderer/views/settings.js', 'save');
  const thenBody = src.slice(src.indexOf('.then(function (r) {'));
  const failIdx = thenBody.indexOf('if (!r || !r.ok)');
  const clearIdx = thenBody.indexOf("input.value = ''");
  assert.ok(failIdx >= 0 && clearIdx > failIdx, '실패 확인이 칸 비우기보다 먼저여야 한다');
  assert.match(src, /\.catch\(function \(\) \{ failed\('키를 저장하지 못했어요\.'\); \}\)/);
});

// ---------------------------------------------------------------- 같은 메모의 겹치는 요청
test('ai.organize: 같은 메모라도 입력 분류와 AI 정리는 서로 막지 않고, 같은 종류가 겹치면 다시 시도할 수 있는 busy', async () => {
  await withEnv({ GEMINI_API_KEY: 'AIzaFAKEENVKEY000000000000' }, async () => {
    const ai = freshAi();
    const NOW = new Date(2026, 9, 5, 10);
    const note = { id: 'note_abc', title: '회의', body: '- [ ] 금요일까지 견적서 회신', updatedAt: NOW.toISOString() };
    const ctx = { today: '2026-10-05 (월)', projects: [], openTasks: [] };
    const capIn = C.buildInput(note, ctx), orgIn = O.buildInput(note, ctx);
    const OUT = { summary: '요약', sections: [], tasks: [], events: [], open_questions: [] };
    ai._setClients({ retryDelayMs: 0, gemini: { interactions: { create: () => new Promise((r) => setTimeout(() => r({ status: 'completed', output_text: JSON.stringify(OUT) }), 30)) } } });
    const [a, b] = await Promise.all([ai.organize(capIn), ai.organize(orgIn)]);
    assert.ok(a.ok, JSON.stringify(a.error));
    assert.ok(b.ok, JSON.stringify(b.error));
    const [c, d] = await Promise.all([ai.organize(orgIn), ai.organize(orgIn)]);
    assert.ok(c.ok);
    assert.strictEqual(d.ok, false);
    assert.strictEqual(d.error.type, 'busy');
    assert.strictEqual(d.error.retryable, true);
    assert.ok(!/습니다/.test(d.error.message), '-어요 말투: ' + d.error.message);
    assert.ok((await ai.organize(orgIn)).ok, '끝난 뒤에는 다시 된다');
  });
});

// ---------------------------------------------------------------- 남은 '생각 중' 말풍선
test('recoverThinking: 앱이 꺼지는 사이 남은 thinking 말풍선을 끝난 글로 바꾼다', () => {
  const AS = require('../src/core/ai/assist');
  const state = { chat: [
    { id: 'm1', role: 'assistant', kind: 'thinking', text: '‘견적서 보내기’를 작은 단계로 나눠 보는 중이에요…' },
    { id: 'm2', role: 'assistant', kind: 'text', text: '안녕하세요' },
    { id: 'm3', role: 'assistant', kind: 'thinking', text: '자세히 적어 두면 좋을 할 일을 찾는 중이에요…' }
  ] };
  assert.strictEqual(AS.recoverThinking(state), 2);
  assert.deepStrictEqual(state.chat.map((m) => m.kind), ['text', 'text', 'text']);
  assert.strictEqual(state.chat[0].text, AS.INTERRUPTED_TEXT);
  assert.strictEqual(state.chat[1].text, '안녕하세요');
  assert.ok(!/습니다/.test(AS.INTERRUPTED_TEXT));
  assert.strictEqual(AS.recoverThinking({}), 0);
  assert.strictEqual(AS.recoverThinking(null), 0);
  assert.match(extractFn('renderer/assistant.js', 'watch'), /AS\.recoverThinking\(s\)/, 'watch() 에서 부른다');
});

// ---------------------------------------------------------------- 키 문제 실패 카드
test('chat needsSettings: 키·권한 문제만 [설정 열기] 를 준다', () => {
  const needsSettings = new Function(extractFn('renderer/views/chat.js', 'needsSettings') + '; return needsSettings;')();
  assert.strictEqual(needsSettings({ type: 'auth', retryable: false }), true);
  assert.strictEqual(needsSettings({ type: 'permission', retryable: false }), true);
  assert.strictEqual(needsSettings({ type: 'not_configured', retryable: false }), true);
  assert.strictEqual(needsSettings({ type: 'busy', retryable: true }), false);
  assert.strictEqual(needsSettings({ type: 'network', retryable: true }), false);
  assert.strictEqual(needsSettings({ type: 'refusal', retryable: false }), false);
  assert.strictEqual(needsSettings(null), false);
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'views', 'chat.js'), 'utf8');
  assert.match(src, /needsSettings\(c\.error\) \? settingsBtn : null/);
  assert.match(src, /needsSettings\(c\.error\) \? settingsButton\(\) : null, retry/);
});

// ---------------------------------------------------------------- 앱 시작 직후 '확인 중…' 사이에 보낸 글
function loadCapture(statusImpl) {
  const M = require('../src/core/model');
  const window = { Daynote: {} };
  const sandbox = { window, console, JSON, Object, Array, Promise, Intl, Date, Math, String, Number, setTimeout,
    document: { addEventListener() {} } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const load = (rel) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'), sandbox, { filename: rel });
  const DN = window.Daynote;
  const NOW = new Date(2026, 9, 5, 10);
  Object.assign(DN, { model: M, dates: require('../src/core/dates'), aiOrganize: O, aiCapture: C,
    aiValidate: require('../src/core/ai/validate'), aiProposals: require('../src/core/ai/proposals') });
  const calls = [];
  const S = {
    state: M.normalize(null),
    mutate(label, fn) { return fn(S.state); },
    whenReady() {},
    host: { ai: {
      status: statusImpl,
      organizeNote: (input) => { calls.push(input); return Promise.resolve({ ok: false, error: { type: 'network', message: '연결이 끊겼어요.', retryable: true } }); }
    } }
  };
  DN.store = S;
  DN.app = { now: () => new Date(NOW) };
  load('renderer/aiflow.js');
  load('renderer/capture.js');
  return { DN, S, M, calls };
}

test('입력 분류: AI 상태를 확인하는 중에 보낸 글은 no_ai 로 정하지 않고 상태를 받은 뒤 AI 로 보낸다', async () => {
  let resolveStatus;
  const { DN, S, M, calls } = loadCapture(() => new Promise((r) => { resolveStatus = r; }));
  DN.aiFlow.loadStatus();
  assert.strictEqual(DN.aiFlow.isLoading(), true);
  let done = null;
  const note = DN.capture.submit('점심 김밥 맛있었다', null, (r) => { done = r; });
  assert.strictEqual(DN.capture.isRunning(note.id), true, '첫 그림부터 정리하는 중');
  await new Promise((r) => setTimeout(r, 5));
  assert.notStrictEqual(M.byId(S.state.notes, note.id).capture.status, 'no_ai');
  assert.strictEqual(calls.length, 0);
  resolveStatus({ configured: true, provider: 'gemini', model: 'gemini-3.8-flash' });
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(M.byId(S.state.notes, note.id).capture.status, 'failed');
  assert.strictEqual(done && done.reason, 'failed');
  assert.strictEqual(DN.capture.isRunning(note.id), false);
});

test('입력 분류: 상태 확인이 실패(reject)해도 \'확인 중…\' 에 머물지 않고 no_ai 로 끝난다', async () => {
  const { DN, S, M, calls } = loadCapture(() => Promise.reject(new Error('ipc down')));
  DN.aiFlow.loadStatus();
  const note = DN.capture.submit('점심 김밥 맛있었다', null);
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(DN.aiFlow.isLoading(), false);
  const cap = M.byId(S.state.notes, note.id).capture;
  assert.strictEqual(cap.status, 'no_ai');
  assert.notStrictEqual(cap.reason, '확인 중…');
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(DN.capture.isRunning(note.id), false);
});

test('입력 분류: 상태를 이미 받았고 AI 가 꺼져 있으면 예전처럼 바로 no_ai', async () => {
  const { DN, S, M, calls } = loadCapture(() => Promise.resolve({ configured: false, provider: null, reason: 'AI 키가 없습니다.' }));
  await DN.aiFlow.loadStatus();
  const note = DN.capture.submit('점심 김밥 맛있었다', null);
  assert.strictEqual(DN.capture.isRunning(note.id), false);
  assert.strictEqual(M.byId(S.state.notes, note.id).capture.status, 'no_ai');
  assert.strictEqual(calls.length, 0);
});

test('main aiStatus: 풀 수 없는 저장 키면 reason 도 \'키가 없다\' 가 아니라 \'다시 붙여 넣어 주세요\'', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const m = /function aiStatus\(\) \{[\s\S]*?\n\}/.exec(src);
  const make = (keystore, st) => new Function('keystore', 'ai', m[0] + '; return aiStatus;')(keystore, { status: () => Object.assign({}, st) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-key-'));
  const safe = okSafe();
  const ks = K.create(dir, safe);
  ks.save(KEY);
  safe.decryptString = () => { throw new Error('nope'); };
  const none = { configured: false, provider: null, reason: 'AI 키가 없어요. 설정에서 Google AI Studio 키를 넣어 주세요.', noKey: true };
  assert.match(make(ks, none)().reason, /저장한 키를 이 컴퓨터에서 풀 수 없어요/);
  const forced = { configured: false, provider: null, reason: 'ANTHROPIC_API_KEY 환경변수가 설정되어 있지 않아요.', noKey: false };
  assert.strictEqual(make(ks, forced)().reason, forced.reason);
  safe.decryptString = okSafe().decryptString;
  assert.strictEqual(make(ks, none)().reason, none.reason);
});
