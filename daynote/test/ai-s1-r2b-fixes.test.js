'use strict';

// AI 요청 처리 고침 (4) — .env 와 환경변수의 Gemini 키 우선순위·출처, 감싼 응답의 지난 결과 재사용,
// 모델별 thinking·시간 제한이 MODELS 를 따르기, GOCSPX- 비밀번호 거절, 실패한 분류 기록의 모델,
// 실행 기록 전체 크기 제한, AI 를 연결한 뒤 'no_ai' 카드에서 나누기.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const M = require('../src/core/model');
const V = require('../src/core/ai/validate');
const P = require('../src/core/ai/proposals');
const O = require('../src/core/ai/organizeNote');
const C = require('../src/core/ai/capture');
const fake = require('../src/core/ai/fake');
const K = require('../services/keystore');

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
const NOW = new Date(2026, 9, 5, 10);
const ORG_NOTE = { id: 'n1', title: '회의', body: '- [ ] 금요일까지 견적서 회신', updatedAt: NOW.toISOString() };
const ORG_INPUT = O.buildInput(ORG_NOTE, { today: '2026-10-05 (월)', projects: [], openTasks: [] });
const CAP_INPUT = C.buildInput({ id: 'c1', title: '', body: '금요일까지 견적서 보내기', updatedAt: NOW.toISOString() },
  { today: '2026-10-05 (월)', projects: [], openTasks: [] });

// ---------------------------------------------------------------- .env 와 환경변수
async function dotenvCase(envVars, dotenvText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-envprio-'));
  fs.writeFileSync(path.join(dir, '.env'), dotenvText);
  try {
    return await withEnv(envVars, async () => {
      const out = [];
      const found = K.loadDotEnv(dir, out);
      const ai = freshAi();
      ai.captureEnvKeys();                       // main.js 순서: loadDotEnv → captureEnvKeys
      let sentKey = null;
      const GenAI = require('@google/genai');
      const Orig = GenAI.GoogleGenAI;
      GenAI.GoogleGenAI = function (opts) {
        sentKey = opts.apiKey;
        return { interactions: { create: async () => ({ status: 'completed', output_text: JSON.stringify({ summary: '', sections: [], tasks: [], events: [], open_questions: [] }) }) } };
      };
      try {
        ai._setClients({ retryDelayMs: 0 });
        await ai.organize(ORG_INPUT);
      } finally { GenAI.GoogleGenAI = Orig; }
      return { found, out, keySource: ai.status().keySource, sentKey };
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('.env: 환경변수 GOOGLE_API_KEY 가 있으면 .env 의 GEMINI_API_KEY 는 쓰지 않고 출처는 환경변수', async () => {
  const r = await dotenvCase({ GOOGLE_API_KEY: 'AIzaREAL_ENV_KEY_0000000' }, 'GEMINI_API_KEY=AIzaDOTENV_stale_key_00000\nFOO_S1=bar\n');
  assert.strictEqual(r.sentKey, 'AIzaREAL_ENV_KEY_0000000');
  assert.strictEqual(r.keySource, 'env');
  assert.strictEqual(r.found, false);
  assert.ok(!r.out.includes('GEMINI_API_KEY'));
  assert.ok(r.out.includes('FOO_S1'));               // 다른 이름은 그대로 채운다
  delete process.env.FOO_S1;
});

test('.env: 환경변수 GEMINI_API_KEY + .env GOOGLE_API_KEY 이면 출처를 .env 로 잘못 보이지 않는다', async () => {
  const r = await dotenvCase({ GEMINI_API_KEY: 'AIzaREAL_ENV_KEY_0000000' }, 'GOOGLE_API_KEY=AIzaDOTENV_key_000000000\n');
  assert.strictEqual(r.sentKey, 'AIzaREAL_ENV_KEY_0000000');
  assert.strictEqual(r.keySource, 'env');
  assert.strictEqual(r.found, false);
});

test('.env: 환경변수에 Gemini 키가 없을 때만 .env 키를 쓰고 출처를 .env 로 보인다', async () => {
  const r = await dotenvCase({}, 'GOOGLE_API_KEY=AIzaDOTENV_key_000000000\n');
  assert.strictEqual(r.sentKey, 'AIzaDOTENV_key_000000000');
  assert.strictEqual(r.keySource, 'dotenv');
  assert.strictEqual(r.found, true);
});

// ---------------------------------------------------------------- 감싼 응답과 지난 결과 재사용
test('Gemini 응답이 울타리·앞 문장으로 감싸 와도 raw 는 JSON 이라 같은 메모의 다음 AI 정리는 지난 결과를 다시 쓴다', async () => {
  const OUT = { summary: '요약', sections: [], tasks: [], events: [], open_questions: [] };
  const shapes = ['```json\n' + JSON.stringify(OUT) + '\n```', '다음은 결과입니다:\n' + JSON.stringify(OUT)];
  await withEnv({ GEMINI_API_KEY: 'AIzaSyEXAMPLEKEY_abcdefghijklmn' }, async () => {
    const ai = freshAi();
    for (const text of shapes) {
      ai._setClients({ retryDelayMs: 0, gemini: { interactions: { create: async () => ({ status: 'completed', output_text: text }) } } });
      const res = await ai.organize(ORG_INPUT);
      assert.ok(res.ok);
      // aiflow 가 저장하는 대로
      const st = M.emptyState();
      const run = P.startRun(st, { noteId: 'n1', noteHash: P.noteHash(ORG_NOTE), promptVersion: O.PROMPT_VERSION }, NOW);
      P.finishRun(st, run.id, { status: 'succeeded', rawOutput: res.raw || JSON.stringify(res.output) }, NOW);
      const reuse = P.reusableRun(st, 'n1', P.noteHash(ORG_NOTE), O.PROMPT_VERSION);
      assert.ok(reuse);
      assert.deepStrictEqual(JSON.parse(reuse.rawOutput), OUT);   // aiflow.js 의 JSON.parse 가 던지지 않는다
    }
  });
});

// ---------------------------------------------------------------- 모델별 thinking·시간 제한
test('Gemini: 빠른 모델 이름을 바꿔도 분류는 thinking minimal·60초, 정리는 low·120초', async () => {
  await withEnv({ GEMINI_API_KEY: 'AIzaSyEXAMPLEKEY_abcdefghijklmn' }, async () => {
    const ai = freshAi();
    const sent = [];
    const OUT = { summary: '', sections: [], tasks: [], events: [], open_questions: [], entry_type: 'memo', note_title: 't', note_project_hint: null, note_kind: 'memo' };
    ai._setClients({ retryDelayMs: 0, gemini: { interactions: { create: async (req, opts) => { sent.push({ model: req.model, thinking: req.generation_config.thinking_level, timeout: opts && opts.timeout }); return { status: 'completed', output_text: JSON.stringify(OUT) }; } } } });
    const orig = ai.MODELS.geminiFast;
    try {
      await ai.organize(CAP_INPUT);
      ai.MODELS.geminiFast = 'gemini-3.6-flash-lite';
      await ai.organize(Object.assign({}, CAP_INPUT, { noteId: 'c2' }));
      await ai.organize(ORG_INPUT);
    } finally { ai.MODELS.geminiFast = orig; }
    assert.deepStrictEqual(sent[0], { model: 'gemini-3.5-flash-lite', thinking: 'minimal', timeout: 60000 });
    assert.deepStrictEqual(sent[1], { model: 'gemini-3.6-flash-lite', thinking: 'minimal', timeout: 60000 });
    assert.deepStrictEqual(sent[2], { model: 'gemini-3.8-flash', thinking: 'low', timeout: 120000 });
  });
});

// ---------------------------------------------------------------- GOCSPX- 비밀번호
test('AI 키 칸: Google 캘린더 클라이언트 보안 비밀번호(GOCSPX-…)는 저장하지 않고 캘린더용이라고 알린다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-ks-gocspx-'));
  const fakeSafe = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('enc:' + Buffer.from(s).toString('base64')),
    decryptString: (b) => Buffer.from(String(b).slice(4), 'base64').toString()
  };
  try {
    const ks = K.create(dir, fakeSafe);
    const r = ks.save('GOCSPX-AbCdEfGhIjKlMnOpQrStUvWxYz012');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /캘린더/);
    assert.match(r.error, /AIza/);
    assert.strictEqual(ks.read(), '');
    assert.strictEqual(ks.save('AIzaSyEXAMPLEKEY_abcdefghijklmn').ok, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- 실패한 기록의 모델
test('organize 실패 결과에 실제로 부른 모델을 싣는다 (키 오류는 빠른 모델, JSON 못 읽음도)', async () => {
  await withEnv({ GEMINI_API_KEY: 'AIzaSyEXAMPLEKEY_abcdefghijklmn' }, async () => {
    const ai = freshAi();
    const err = Object.assign(new Error('API key not valid. API_KEY_INVALID'), { status: 400 });
    ai._setClients({ retryDelayMs: 0, gemini: { interactions: { create: async () => { throw err; } } } });
    const r = await ai.organize(CAP_INPUT);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.type, 'auth');
    assert.strictEqual(r.model, 'gemini-3.5-flash-lite');
    assert.strictEqual(r.provider, 'gemini');
    ai._setClients({ gemini: { interactions: { create: async () => ({ status: 'completed', output_text: '그냥 글' }) } } });
    const j = await ai.organize(CAP_INPUT);
    assert.strictEqual(j.error.type, 'invalid_json');
    assert.strictEqual(j.model, 'gemini-3.5-flash-lite');
  });
});

function loadCapture(reply) {
  const window = { Daynote: {} };
  const sandbox = { window, console, JSON, Object, Array, Promise, Intl, Date, Math, String, Number, setTimeout,
    document: { addEventListener() {} } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const load = (rel) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'), sandbox, { filename: rel });
  const DN = window.Daynote;
  Object.assign(DN, { model: M, dates: require('../src/core/dates'), aiOrganize: O, aiCapture: C, aiValidate: V, aiProposals: P });
  const S = {
    state: M.normalize(null),
    mutate(label, fn) { return fn(S.state); },
    whenReady() {},
    host: { ai: {
      status: () => Promise.resolve({ configured: true, provider: 'gemini', model: 'gemini-3.8-flash', fastModel: 'gemini-3.5-flash-lite' }),
      organizeNote: (input) => Promise.resolve(reply(input))
    } }
  };
  DN.store = S;
  DN.app = { now: () => new Date(NOW) };
  load('renderer/aiflow.js');
  load('renderer/capture.js');
  return { DN, S };
}

test('입력 분류: 키 오류로 실패한 실행 기록에는 status.model 이 아니라 실제로 부른 빠른 모델이 남는다', async () => {
  const { DN, S } = loadCapture(() => ({ ok: false, error: { type: 'auth', message: 'Gemini API 키가 올바르지 않아요.', retryable: false }, attempts: 1 }));
  await DN.aiFlow.loadStatus();
  let done = null;
  DN.capture.submit('내일 오후 3시 치과 예약', null, (r) => { done = r; });
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(done && done.reason, 'failed');
  assert.strictEqual(S.state.aiRuns[0].status, 'failed');
  assert.strictEqual(S.state.aiRuns[0].model, 'gemini-3.5-flash-lite');
  // 응답이 모델을 알려 주면 그 모델 (다른 모델로 넘어가 실패한 경우)
  const b = loadCapture(() => ({ ok: false, provider: 'gemini', model: 'gemini-3.8-flash', error: { type: 'rate_limit', message: '한도', retryable: true }, attempts: 1 }));
  await b.DN.aiFlow.loadStatus();
  b.DN.capture.submit('내일 오후 3시 치과 예약', null, () => {});
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(b.S.state.aiRuns[0].model, 'gemini-3.8-flash');
});

// ---------------------------------------------------------------- 실행 기록 크기
test('실행 기록: 던진 글이 쌓여도 전체 개수와 원문 응답 수가 제한되고, 재사용·돌고 있는 기록은 남는다', () => {
  const st = M.emptyState();
  const raw = JSON.stringify({ summary: 'x'.repeat(500) });
  // 정리한 메모 하나 — 성공한 기록 (재사용 대상)
  const org = P.startRun(st, { kind: 'organize_note', noteId: 'org1', noteHash: 'h1', promptVersion: 'v' }, NOW);
  P.finishRun(st, org.id, { status: 'succeeded', rawOutput: raw, usage: { input_tokens: 1 } }, NOW);
  const running = P.startRun(st, { kind: 'capture', noteId: 'run1' }, NOW);
  for (let i = 0; i < 3000; i++) {
    const r = P.startRun(st, { kind: 'capture', noteId: 'cap' + i }, NOW);
    P.finishRun(st, r.id, { status: 'succeeded', rawOutput: raw, usage: { input_tokens: 1 }, dropped: [{ x: 1 }] }, NOW);
  }
  assert.ok(st.aiRuns.length <= 1001, String(st.aiRuns.length));
  const withRaw = st.aiRuns.filter((r) => r.rawOutput).length;
  assert.ok(withRaw <= 202, String(withRaw));
  // 가장 최근 기록은 원문을 그대로 둔다
  assert.strictEqual(st.aiRuns[st.aiRuns.length - 1].rawOutput, raw);
  // 재사용할 정리 기록과 돌고 있는 기록은 남는다
  const reuse = P.reusableRun(st, 'org1', 'h1', 'v');
  assert.ok(reuse && reuse.rawOutput === raw);
  assert.ok(M.byId(st.aiRuns, running.id));
  assert.strictEqual(M.byId(st.aiRuns, running.id).status, 'running');
  // 원문을 비운 옛 기록은 사용량·버린 항목도 비운다
  const old = st.aiRuns.find((r) => r.kind === 'capture' && r.status === 'succeeded');
  assert.strictEqual(old.rawOutput, null);
  assert.strictEqual(old.usage, null);
  assert.deepStrictEqual(old.dropped, []);
});

// ---------------------------------------------------------------- AI 를 연결한 뒤의 'no_ai' 카드
test('chat: AI 를 연결하기 전에 적은 글(no_ai) 카드는 연결된 뒤 [AI로 나누기] 를 주고, 연결 여부가 바뀌면 카드를 다시 그린다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'views', 'chat.js'), 'utf8');
  const i = src.indexOf("c.status === 'no_ai' && !c.changedByUser && DN.aiFlow.status().configured");
  assert.ok(i > 0);
  const branch = src.slice(i, src.indexOf('} else if', i + 10));
  assert.match(branch, /CP\.classify\(n\.id\)/);
  assert.match(branch, /AI로 나누기/);
  // 배운 대로 고친 글(noAiLearned) 분기보다 뒤에 있어 그 글은 다시 분류하지 않는다
  assert.ok(src.indexOf('} else if (noAiLearned)') < i);
  assert.match(src, /if \(on !== aiOn\) \{ aiOn = on; paintList\(\); \}/);
});
