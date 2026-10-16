'use strict';

// AI 요청 처리 고침 — Claude 스키마 한도, Gemini 시간 제한·재시도, 오류 문구, 키 저장 검사, AI 정리 중 되돌리기.
// 실제 네트워크 없이 바꿔 끼운 클라이언트로 확인한다.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const O = require('../src/core/ai/organizeNote');
const C = require('../src/core/ai/capture');
const A = require('../src/core/ai/assist');

const ENV = ['DAYNOTE_AI_FAKE', 'DAYNOTE_AI_PROVIDER', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'DAYNOTE_KEY_FROM_DOTENV'];
function withEnv(vars, fn) {
  const saved = {};
  ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  Object.assign(process.env, vars);
  const restore = () => ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  let r;
  try { r = fn(); } catch (e) { restore(); throw e; }
  if (r && typeof r.then === 'function') return r.finally(restore);
  restore();
  return r;
}
function freshAi() {
  delete require.cache[require.resolve('../services/ai')];
  return require('../services/ai');
}

const NOW = new Date(2026, 9, 5, 10);
const CAP_INPUT = C.buildInput({ id: 'c1', title: '', body: '금요일까지 견적서 보내기', updatedAt: NOW.toISOString() },
  { today: '2026-10-05 (월)', projects: [], openTasks: [] });
const ORG_INPUT = O.buildInput({ id: 'n1', title: '회의', body: '- [ ] 금요일까지 견적서 회신', updatedAt: NOW.toISOString() },
  { today: '2026-10-05 (월)', projects: [], openTasks: [] });
const ORG_OUTPUT = { summary: '요약', sections: [], tasks: [], events: [], open_questions: [] };

// 스키마 복잡도 — Anthropic 구조화 출력 한도: 합집합(anyOf·type 배열) 칸 16개, 선택(required 아님) 칸 24개
function complexity(schema) {
  let unions = 0, optional = 0;
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.properties) {
      const req = n.required || [];
      Object.keys(n.properties).forEach((k) => {
        const p = n.properties[k];
        if (p.anyOf || Array.isArray(p.type)) unions++;
        if (req.indexOf(k) < 0) optional++;
        walk(p);
      });
    }
    if (n.items) { if (n.items.anyOf || Array.isArray(n.items.type)) unions++; walk(n.items); }
    if (n.anyOf) n.anyOf.forEach(walk);
  })(schema);
  return { unions, optional };
}

const DEFS = { organize: O.SCHEMA, capture: C.SCHEMA, breakdown: A.BREAKDOWN.SCHEMA, elaborate: A.ELABORATE.SCHEMA };

test('Claude 스키마: 모든 요청이 합집합 16개·선택 24개 한도 안이고, 원래 스키마(Gemini 용)는 그대로', () => {
  const ai = freshAi();
  const before = JSON.stringify(DEFS);
  assert.ok(complexity(C.SCHEMA).unions > 16, '원래 capture 스키마는 한도를 넘는다(그래서 바꿔 보낸다)');
  Object.keys(DEFS).forEach((k) => {
    const c = complexity(ai._claudeSchema.toClaude(DEFS[k]));
    assert.ok(c.unions <= 16, k + ' 합집합 칸 ' + c.unions);
    assert.ok(c.optional <= 24, k + ' 선택 칸 ' + c.optional);
  });
  assert.strictEqual(JSON.stringify(DEFS), before);
});

// 스키마를 따라 예시 응답을 만든다. nulls: 값 없음 칸을 null(원래) / 표시값(Claude) 으로
function sample(s, mode) {
  const inner = s.anyOf && s.anyOf.find((x) => x.type !== 'null');
  if (inner) {
    if (mode === 'value') return sample(inner, mode);
    if (mode === 'null') return null;
    if (inner.type === 'string') return inner.enum ? 'none' : '';
    if (inner.type === 'integer') return -1;
    if (inner.type === 'boolean') return 'none';
    throw new Error('예상 못 한 null 칸');
  }
  if (s.type === 'object') { const o = {}; Object.keys(s.properties).forEach((k) => { o[k] = sample(s.properties[k], mode); }); return o; }
  if (s.type === 'array') return [sample(s.items, mode)];
  if (s.type === 'string') return s.enum ? s.enum[0] : '글';
  if (s.type === 'integer') return 3;
  if (s.type === 'boolean') return true;
  throw new Error('예상 못 한 타입');
}

test('Claude 스키마: 값 없음 표시("", -1, "none")를 null 로, "true"/"false" 를 참거짓으로 되돌린다', () => {
  const ai = freshAi();
  Object.keys(DEFS).forEach((k) => {
    const S = DEFS[k];
    assert.deepStrictEqual(ai._claudeSchema.fromClaude(S, sample(S, 'claude')), sample(S, 'null'), k);
    assert.deepStrictEqual(ai._claudeSchema.fromClaude(S, sample(S, 'value')), sample(S, 'value'), k);
  });
  const sched = ai._claudeSchema.fromClaude(C.SCHEMA.properties.tasks.items.properties.sched,
    { focus: 'deep', energy: 'none', prefer: 'evening', splittable: 'false', minutes: 30 });
  assert.deepStrictEqual(sched, { focus: 'deep', energy: null, prefer: 'evening', splittable: false, minutes: 30 });
});

test('Claude 호출: 바꾼 스키마를 보내고, 응답을 원래 모양으로 되돌려 돌려준다 (raw 도 같은 모양)', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test', DAYNOTE_AI_PROVIDER: 'claude' }, async () => {
    const ai = freshAi();
    const sent = [];
    const claudeOut = sample(C.SCHEMA, 'claude');
    ai._setClients({ claude: { beta: { messages: { create: async (req) => { sent.push(req); return { stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify(claudeOut) }], usage: {} }; } } } } });
    const r = await ai.organize(CAP_INPUT);
    assert.ok(r.ok, JSON.stringify(r.error));
    const schema = sent[0].output_config.format.schema;
    assert.ok(complexity(schema).unions <= 16);
    assert.strictEqual(sent[0].system[0].text, C.SYSTEM);                       // 공통 지침(캐시)은 그대로
    assert.deepStrictEqual(r.output, sample(C.SCHEMA, 'null'));
    assert.deepStrictEqual(JSON.parse(r.raw), r.output);
    await ai.organize(CAP_INPUT);
    assert.strictEqual(sent[1].output_config.format.schema, schema);           // 요청마다 같은 스키마
  });
});

test('Gemini 호출: 요청마다 시간 제한을 주고 SDK 자체 재시도는 끈다 (재시도는 다른 모델로 한 번만)', async () => {
  await withEnv({ GEMINI_API_KEY: 'g' }, async () => {
    const ai = freshAi();
    ai._setClients({ retryDelayMs: 0 });
    const opts = [];
    ai._setClients({ gemini: { interactions: { create: async (req, o) => { opts.push(o); throw Object.assign(new Error('503 busy'), { status: 503 }); } } } });
    const r = await ai.organize(CAP_INPUT);
    assert.strictEqual(r.error.type, 'server');
    assert.strictEqual(opts.length, 2);
    opts.forEach((o) => {
      assert.ok(o, '두 번째 인자가 있어야 한다');
      assert.strictEqual(o.maxRetries, 0);
      assert.ok(Number.isFinite(o.timeout) && o.timeout > 0 && o.timeout <= 120000, String(o.timeout));
    });
  });
});

test('전체 마감: 응답이 끝내 오지 않아도 다시 시도할 수 있는 오류로 끝나고, 같은 메모 자리를 비운다', async () => {
  await withEnv({ GEMINI_API_KEY: 'g' }, async () => {
    const ai = freshAi();
    ai._setClients({ retryDelayMs: 0, deadlineMs: 50, gemini: { interactions: { create: () => new Promise(() => {}) } } });
    const r = await ai.organize(CAP_INPUT);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.type, 'timeout');
    assert.strictEqual(r.error.retryable, true);
    ai._setClients({ deadlineMs: null, gemini: { interactions: { create: async () => ({ status: 'completed', output_text: JSON.stringify(ORG_OUTPUT) }) } } });
    const r2 = await ai.organize(CAP_INPUT);
    assert.ok(r2.ok, JSON.stringify(r2.error));                                 // 'busy' 가 아니다
  });
});

function noRaw(msg) {
  assert.ok(!/[{}]/.test(msg), '원문 JSON 이 보이면 안 된다: ' + msg);
  assert.ok(!/습니다/.test(msg), '-어요 말투: ' + msg);
}

test('Gemini 오류 문구: 짧은 한국어 + 원문은 detail, 저장한 키면 설정을 가리킨다, 로그인 화면(200)은 다시 시도', async () => {
  await withEnv({}, async () => {
    const ai = freshAi();
    ai.setSavedKey('AIzaSyEXAMPLEKEY_abcdefghijklmn');
    ai._setClients({ retryDelayMs: 0 });
    const fail = (err) => ai._setClients({ gemini: { interactions: { create: async () => { throw err; } } } });

    fail(Object.assign(new Error('401 {"error":{"message":"API key expired"}}'), { status: 401 }));
    let r = await ai.organize(ORG_INPUT);
    assert.strictEqual(r.error.type, 'auth');
    assert.match(r.error.message, /설정에서 키를 확인/);
    assert.ok(!/GEMINI_API_KEY/.test(r.error.message));
    assert.match(r.error.detail, /API key expired/);
    noRaw(r.error.message);

    fail(Object.assign(new Error('404 models/gemini-3.8-flash is not found for API version v1beta'), { status: 404 }));
    r = await ai.organize(ORG_INPUT);
    assert.strictEqual(r.error.type, 'model_not_found');
    assert.match(r.error.detail, /not found/);
    noRaw(r.error.message);

    fail(Object.assign(new Error('200 Unexpected Status or Content-Type: Status 200 Content-Type text/html. Body: <html>portal</html>'), { status: 200 }));
    r = await ai.organize(ORG_INPUT);
    assert.strictEqual(r.error.type, 'network');
    assert.strictEqual(r.error.retryable, true);
    assert.ok(!/html/.test(r.error.message));
    noRaw(r.error.message);

    fail(Object.assign(new Error('400 User location is not supported for the API use.'), { status: 400 }));
    r = await ai.organize(ORG_INPUT);
    assert.strictEqual(r.error.type, 'region');
    noRaw(r.error.message);

    fail(Object.assign(new Error('Request timed out: TimeoutError'), { name: 'APIConnectionTimeoutError' }));
    r = await ai.organize(ORG_INPUT);
    assert.strictEqual(r.error.type, 'timeout');
    assert.strictEqual(r.error.retryable, true);

    fail(new Error('Unable to make request: TypeError: fetch failed'));
    r = await ai.organize(ORG_INPUT);
    assert.strictEqual(r.error.type, 'network');
    assert.ok(!/fetch failed/.test(r.error.message));
    noRaw(r.error.message);
  });
  await withEnv({ GEMINI_API_KEY: 'g' }, async () => {
    const ai = freshAi();
    ai._setClients({ gemini: { interactions: { create: async () => { throw Object.assign(new Error('403'), { status: 403 }); } } } });
    const r = await ai.organize(ORG_INPUT);
    assert.strictEqual(r.error.type, 'auth');
    assert.match(r.error.message, /GEMINI_API_KEY/);                           // 환경변수 키면 그 이름을 알려 준다
  });
});

test('Claude 오류 문구: 크레딧 부족·모델 없음·엉뚱한 응답을 구분하고 원문은 detail 에만', async () => {
  const Anthropic = require('@anthropic-ai/sdk');
  await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test', DAYNOTE_AI_PROVIDER: 'claude' }, async () => {
    const ai = freshAi();
    const fail = (err) => ai._setClients({ claude: { beta: { messages: { create: async () => { throw err; } } } } });
    const body = (type, message) => ({ type: 'error', error: { type, message } });

    fail(Anthropic.APIError.generate(402, body('billing_error', 'Your credit balance is too low'), undefined, new Headers()));
    let r = await ai.organize(ORG_INPUT);
    assert.strictEqual(r.error.type, 'billing');
    assert.match(r.error.detail, /credit balance/);
    noRaw(r.error.message);

    fail(Anthropic.APIError.generate(400, body('invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'), undefined, new Headers()));
    r = await ai.organize(ORG_INPUT);
    assert.strictEqual(r.error.type, 'billing');

    fail(Anthropic.APIError.generate(404, body('not_found_error', 'model: claude-x'), undefined, new Headers()));
    r = await ai.organize(ORG_INPUT);
    assert.strictEqual(r.error.type, 'model_not_found');
    noRaw(r.error.message);

    fail(Anthropic.APIError.generate(400, body('invalid_request_error', 'something odd'), undefined, new Headers()));
    r = await ai.organize(ORG_INPUT);
    assert.strictEqual(r.error.type, 'bad_request');
    noRaw(r.error.message);

    ai._setClients({ claude: { beta: { messages: { create: async () => '<html>portal</html>' } } } });
    r = await ai.organize(ORG_INPUT);
    assert.strictEqual(r.error.type, 'network');
    assert.strictEqual(r.error.retryable, true);
    noRaw(r.error.message);
  });
});

test('keystore: Anthropic·OpenAI·GitHub 키는 Gemini 키로 저장하지 않는다', () => {
  const K = require('../services/keystore');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-key-'));
  const fakeSafe = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('enc:' + Buffer.from(s).toString('base64')),
    decryptString: (b) => Buffer.from(String(b).slice(4), 'base64').toString()
  };
  const ks = K.create(dir, fakeSafe);
  const r = ks.save('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789-ABCDEFGH');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Anthropic/);
  assert.strictEqual(ks.save('sk-proj-abcdefghijklmnopqrstuvwxyz0123').ok, false);
  assert.strictEqual(ks.save('ghp_abcdefghijklmnopqrstuvwxyz0123456789').ok, false);
  assert.strictEqual(ks.read(), '');
  assert.strictEqual(ks.save('AIzaSyEXAMPLEKEY_abcdefghijklmn').ok, true);
});

// ---------------------------------------------------------------- 화면 쪽 AI 정리 흐름
function loadAiFlow() {
  const M = require('../src/core/model');
  const window = { Daynote: {} };
  const sandbox = { window, console, JSON, Object, Array, Promise, Intl, Date, Math, String, Number, setTimeout,
    document: { addEventListener() {} } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const load = (rel) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'), sandbox, { filename: rel });
  const DN = window.Daynote;
  Object.assign(DN, { model: M, dates: require('../src/core/dates'), aiOrganize: O,
    aiValidate: require('../src/core/ai/validate'), aiProposals: require('../src/core/ai/proposals') });
  let resolveAi;
  const S = {
    state: { notes: [{ id: 'n1', title: '회의', body: '- [ ] 금요일까지 견적서 회신', updatedAt: NOW.toISOString() }],
      tasks: [], projects: [], events: [], aiRuns: [], proposals: [], noteDigests: [] },
    mutate(label, fn) { return fn(S.state); },
    whenReady() {},
    host: { ai: {
      status: () => Promise.resolve({ configured: true, provider: 'gemini', model: 'gemini-3.8-flash' }),
      organizeNote: () => new Promise((r) => { resolveAi = r; })
    } }
  };
  DN.store = S;
  DN.app = { now: () => new Date(NOW) };
  load('renderer/aiflow.js');
  return { DN, S, M, resolve: (v) => resolveAi(v) };
}

test('AI 정리: 결과를 기다리는 사이 되돌리기로 실행 기록이 사라지면 오류 없이 gone 으로 끝나고 화면을 다시 그린다', async () => {
  const { DN, S, resolve } = loadAiFlow();
  await DN.aiFlow.loadStatus();
  let notified = 0;
  DN.aiFlow.onChange(() => { notified++; });
  const p = DN.aiFlow.organize('n1');
  assert.strictEqual(S.state.aiRuns.length, 1);
  assert.strictEqual(DN.aiFlow.isRunning('n1'), true);
  S.state.aiRuns = [];                                                           // Ctrl+Z: 실행 기록 이전 상태로
  const before = notified;
  resolve({ ok: true, provider: 'gemini', model: 'gemini-3.8-flash', output: ORG_OUTPUT, raw: JSON.stringify(ORG_OUTPUT) });
  const r = await p;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'gone');
  assert.ok(notified > before, '화면을 다시 그리게 알린다');
  assert.strictEqual(DN.aiFlow.isRunning('n1'), false);
});

test('남은 오류 문구도 -어요 말투이고, 거절 이유·Gemini 상태 같은 원문은 detail 에만', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test', DAYNOTE_AI_PROVIDER: 'claude' }, async () => {
    const ai = freshAi();
    const reply = (res) => ai._setClients({ claude: { beta: { messages: { create: async () => res } } } });
    reply({ stop_reason: 'refusal', stop_details: { explanation: 'The request was declined by policy.' }, content: [] });
    let r = await ai.organize(ORG_INPUT);
    assert.strictEqual(r.error.type, 'refusal');
    assert.strictEqual(r.error.message, '이 메모는 AI가 처리하지 않았어요.');
    assert.match(r.error.detail, /declined by policy/);
    reply({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"a":' }] });
    r = await ai.organize(ORG_INPUT);
    assert.strictEqual(r.error.type, 'truncated');
    noRaw(r.error.message);
    reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }], usage: {} });
    r = await ai.organize(ORG_INPUT);
    assert.strictEqual(r.error.type, 'invalid_json');
    noRaw(r.error.message);
  });
  await withEnv({ GEMINI_API_KEY: 'AIzaSyEXAMPLEKEY_abcdefghijklmn', DAYNOTE_AI_PROVIDER: 'gemini' }, async () => {
    const ai = freshAi();
    ai._setClients({ retryDelayMs: 0, gemini: { interactions: { create: async () => ({ status: 'failed' }) } } });
    const r = await ai.organize(ORG_INPUT);
    assert.strictEqual(r.error.type, 'failed');
    assert.strictEqual(r.error.message, 'Gemini가 정리를 끝내지 못했어요.');
    assert.strictEqual(r.error.detail, '상태: failed');
  });
  await withEnv({}, async () => {
    const st = freshAi().status();
    assert.strictEqual(st.configured, false);
    assert.strictEqual(st.noKey, true);
    noRaw(st.reason);
  });
  await withEnv({ DAYNOTE_AI_PROVIDER: 'claude' }, async () => {
    const st = freshAi().status();
    assert.strictEqual(st.noKey, false);
    noRaw(st.reason);
  });
});
