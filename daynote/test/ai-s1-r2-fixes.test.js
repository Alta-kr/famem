'use strict';

// AI 요청 처리 고침 (3) — Gemini 배열 오류 본문, Claude 재시도·마감 끊기, AI 요청도 net.fetch,
// 지운 메모·고친 메모에 늦게 온 분류 결과, 키를 바꾼 사이 끝난 연결 확인, DAYNOTE_AI_PROVIDER 공백.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('../src/core/model');
const V = require('../src/core/ai/validate');
const P = require('../src/core/ai/proposals');
const O = require('../src/core/ai/organizeNote');
const C = require('../src/core/ai/capture');
const fake = require('../src/core/ai/fake');

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
const CAP_INPUT = C.buildInput({ id: 'c1', title: '', body: '금요일까지 견적서 보내기', updatedAt: NOW.toISOString() },
  { today: '2026-10-05 (월)', projects: [], openTasks: [] });
const ORG_INPUT = O.buildInput({ id: 'n1', title: '회의', body: '- [ ] 금요일까지 견적서 회신', updatedAt: NOW.toISOString() },
  { today: '2026-10-05 (월)', projects: [], openTasks: [] });

// @google/genai 2.27 이 Gemini 오류 응답(배열 본문)에서 실제로 던지는 모양
function geminiSdkError(status, error) {
  return Object.assign(new Error(status + ' API error occurred: {"httpMeta":{"response":{},"request":{}}}'), {
    status: status, error: { httpMeta: { response: {}, request: {} } }, body: JSON.stringify([{ error: error }])
  });
}

// ---------------------------------------------------------------- Gemini 배열 오류 본문
test('Gemini 오류: 본문(e.body)의 배열 원문으로 키 오류·만료·지역·결제를 가리고, 고급에는 원문을 둔다', async () => {
  await withEnv({ GEMINI_API_KEY: 'AIzaSyEXAMPLEKEY_abcdefghijklmn' }, async () => {
    const ai = freshAi();
    const fail = (err) => ai._setClients({ retryDelayMs: 0, gemini: { interactions: { create: async () => { throw err; } } } });

    fail(geminiSdkError(400, { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] }));
    let r = await ai.organize(CAP_INPUT);
    assert.strictEqual(r.error.type, 'auth');
    assert.strictEqual(r.error.retryable, false);
    assert.match(r.error.detail, /API key not valid/);
    assert.doesNotMatch(r.error.detail, /httpMeta/);

    fail(geminiSdkError(400, { code: 400, message: 'API key expired. Please renew the API key.', status: 'INVALID_ARGUMENT',
      details: [{ reason: 'API_KEY_EXPIRED' }] }));
    r = await ai.organize(CAP_INPUT);
    assert.strictEqual(r.error.type, 'auth');

    // 메시지 없이 사유만 있어도
    fail(geminiSdkError(400, { code: 400, message: 'Invalid argument.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] }));
    r = await ai.organize(CAP_INPUT);
    assert.strictEqual(r.error.type, 'auth');

    fail(geminiSdkError(400, { code: 400, message: 'User location is not supported for the API use.', status: 'FAILED_PRECONDITION' }));
    r = await ai.organize(CAP_INPUT);
    assert.strictEqual(r.error.type, 'region');
    assert.match(r.error.detail, /FAILED_PRECONDITION: User location is not supported/);

    fail(geminiSdkError(400, { code: 400, message: 'Billing account is not enabled for this project.', status: 'FAILED_PRECONDITION' }));
    r = await ai.organize(CAP_INPUT);
    assert.strictEqual(r.error.type, 'billing');

    // 키 문제가 아닌 400 은 그대로 bad_request
    fail(geminiSdkError(400, { code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT' }));
    r = await ai.organize(CAP_INPUT);
    assert.strictEqual(r.error.type, 'bad_request');
    assert.match(r.error.detail, /invalid argument/);

    // 다른 HTTP 오류도 고급에는 원문이 남는다
    fail(geminiSdkError(429, { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' }));
    r = await ai.organize(CAP_INPUT);
    assert.strictEqual(r.error.type, 'rate_limit');
    assert.match(r.error.detail, /RESOURCE_EXHAUSTED: Resource has been exhausted/);

    // 본문을 못 읽으면 예전처럼 message 를 쓴다
    fail(Object.assign(new Error('400 something'), { status: 400, body: 'not json' }));
    r = await ai.organize(CAP_INPUT);
    assert.strictEqual(r.error.type, 'bad_request');
    assert.strictEqual(r.error.detail, '400 something');
  });
});

test('Gemini 오류: 실제 SDK 가 배열 본문 400 을 받으면 키 오류로 안내한다 (주입한 fetch 로 확인)', async () => {
  await withEnv({ GEMINI_API_KEY: 'AIzaSyEXAMPLEKEY_abcdefghijklmn' }, async () => {
    const ai = freshAi();
    const urls = [];
    ai.setFetch(async (u) => {
      urls.push(String(u && u.url ? u.url : u));
      return new Response(JSON.stringify([{ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } }]),
      { status: 400, headers: { 'content-type': 'application/json' } });
    });
    const r = await ai.organize(CAP_INPUT);
    assert.strictEqual(urls.length, 1, '주입한 fetch 로 한 번만 보낸다');
    assert.match(urls[0], /generativelanguage\.googleapis\.com/);
    assert.strictEqual(r.error.type, 'auth');
    assert.match(r.error.detail, /API key not valid/);
  });
});

// ---------------------------------------------------------------- AI 요청도 net.fetch
test('setFetch: 넣어 준 fetch 를 두 SDK 가 쓰고, 이미 만든 클라이언트는 새로 만든다', async () => {
  await withEnv({ GEMINI_API_KEY: 'AIzaSyEXAMPLEKEY_abcdefghijklmn' }, async () => {
    const ai = freshAi();
    let stubCalls = 0;
    ai._setClients({ retryDelayMs: 0, gemini: { interactions: { create: async () => { stubCalls++; throw new Error('stub'); } } } });
    let calls = 0;
    // Electron net.fetch 가 연결하지 못했을 때 던지는 모양
    ai.setFetch(async () => { calls++; throw new Error('net::ERR_NAME_NOT_RESOLVED'); });
    const r = await ai.organize(CAP_INPUT);
    assert.strictEqual(stubCalls, 0, '예전 클라이언트를 버렸다');
    assert.strictEqual(calls, 2, '두 모델 모두 주입한 fetch 로');
    assert.strictEqual(r.error.type, 'network');
    assert.strictEqual(r.error.retryable, true);
    assert.match(r.error.detail, /net::ERR_NAME_NOT_RESOLVED/);
  });
  await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test0000000000', DAYNOTE_AI_PROVIDER: 'claude' }, async () => {
    const ai = freshAi();
    let calls = 0;
    ai.setFetch(async () => {
      calls++;
      return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
        { status: 401, headers: { 'content-type': 'application/json' } });
    });
    const r = await ai.organize(ORG_INPUT);
    assert.strictEqual(calls, 1);
    assert.strictEqual(r.error.type, 'auth');
  });
});

test('Claude 연결 오류: 속 원인 코드(인증서·DNS)를 고급 detail 에 남긴다', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test0000000000', DAYNOTE_AI_PROVIDER: 'claude' }, async () => {
    const ai = freshAi();
    ai.setFetch(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) }); });
    const r = await ai.organize(ORG_INPUT);
    assert.strictEqual(r.error.type, 'network');
    assert.match(r.error.detail, /UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
  });
});

test('main: AI 요청에도 net.fetch 를 넣어 준다 (창을 띄우기 전에)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const i = src.indexOf('ai.setFetch(fetchFn)');
  assert.ok(i > 0, 'ai.setFetch(fetchFn) 없음');
  assert.ok(i > src.indexOf('const fetchFn = (u, init) => net.fetch(u, init)'));
  assert.ok(i < src.indexOf('  createWindow();', src.indexOf('app.whenReady()')));
});

// ---------------------------------------------------------------- Claude 재시도·마감
test('Claude 호출: 요청마다 시간 제한·재시도를 주고 (재시도 + 1) × 시간 제한이 전체 마감 안에 든다', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test', DAYNOTE_AI_PROVIDER: 'claude' }, async () => {
    const ai = freshAi();
    const opts = [];
    ai._setClients({ claude: { beta: { messages: { create: async (req, o) => {
      opts.push(o);
      return { stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify({ summary: '', sections: [], tasks: [], events: [], open_questions: [] }) }], usage: {} };
    } } } } });
    await ai.organize(ORG_INPUT);
    assert.strictEqual(opts.length, 1);
    const o = opts[0];
    assert.ok(o, '두 번째 인자가 있어야 한다');
    assert.ok(Number.isInteger(o.maxRetries) && o.maxRetries <= 1, String(o.maxRetries));
    assert.ok(o.timeout > 0 && o.timeout * (o.maxRetries + 1) < ai.DEADLINE_MS, String(o.timeout));
    assert.ok(o.signal && typeof o.signal.aborted === 'boolean', '끊을 수 있는 signal');
    assert.strictEqual(o.signal.aborted, false);
  });
});

test('Claude 호출: 전체 마감이 먼저 오면 요청을 끊어 뒤에서 재시도가 돌지 않는다', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test', DAYNOTE_AI_PROVIDER: 'claude' }, async () => {
    const ai = freshAi();
    let signal = null;
    let aborted = false;
    ai._setClients({ deadlineMs: 50, claude: { beta: { messages: { create: (req, o) => new Promise((resolve, reject) => {
      signal = o && o.signal;
      if (signal) signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' })); });
    }) } } } });
    const r = await ai.organize(ORG_INPUT);
    assert.strictEqual(r.error.type, 'timeout');
    assert.ok(signal, 'signal 을 넘겨야 한다');
    assert.strictEqual(signal.aborted, true);
    assert.strictEqual(aborted, true);
    ai._setClients({ deadlineMs: null });
  });
});

test('Gemini 호출: 전체 마감이 먼저 오면 요청을 끊고, 다른 모델로 다시 하지 않는다 (모델별 시간 제한은 그대로)', async () => {
  await withEnv({ GEMINI_API_KEY: 'AIzaSyEXAMPLEKEY_abcdefghijklmn', DAYNOTE_AI_PROVIDER: 'gemini' }, async () => {
    const ai = freshAi();
    const calls = [];
    ai._setClients({ retryDelayMs: 0, deadlineMs: 50, gemini: { interactions: { create: (req, o) => new Promise((resolve, reject) => {
      calls.push({ model: req.model, opts: o });
      const s = o && o.signal;
      if (s) s.addEventListener('abort', () => reject(Object.assign(new Error('Request aborted by client.'), { name: 'RequestAbortedError' })));
    }) } } });
    const r = await ai.organize(ORG_INPUT);
    assert.strictEqual(r.error.type, 'timeout');
    // 끊긴 첫 요청 뒤 다른 모델 요청이 나가지 않는다
    await new Promise((x) => setTimeout(x, 30));
    assert.strictEqual(calls.length, 1, JSON.stringify(calls.map((c) => c.model)));
    const o = calls[0].opts;
    assert.ok(o.signal, 'signal 을 넘겨야 한다');
    assert.strictEqual(o.signal.aborted, true);
    // SDK 는 signal 이 있으면 timeout 을 무시하므로, 모델별 시간 제한 값은 남기되 signal 에도 묶는다
    assert.strictEqual(o.timeout, 120000);
    assert.strictEqual(o.maxRetries, 0);
    ai._setClients({ deadlineMs: null });
  });
});

// ---------------------------------------------------------------- DAYNOTE_AI_PROVIDER
test('DAYNOTE_AI_PROVIDER: 앞뒤 공백을 떼고 anthropic 도 받으며, 모르는 값은 자동으로 고르되 고급 사유로 알린다', async () => {
  const both = { GEMINI_API_KEY: 'AIzaSyEXAMPLEKEY_abcdefghijklmn', ANTHROPIC_API_KEY: 'sk-ant-test' };
  const st = (want) => withEnv(Object.assign({ DAYNOTE_AI_PROVIDER: want }, both), () => freshAi().status());
  assert.strictEqual((await st('claude ')).provider, 'claude');
  assert.strictEqual((await st(' Claude')).provider, 'claude');
  assert.strictEqual((await st('anthropic')).provider, 'claude');
  assert.strictEqual((await st('gemini ')).provider, 'gemini');
  const a = await st('claude ');
  assert.strictEqual(a.reason, undefined, '알아본 값이면 사유 없음');
  const foo = await st('foo');
  assert.strictEqual(foo.configured, true);
  assert.strictEqual(foo.provider, 'gemini');
  assert.match(foo.reason, /gemini 또는 claude/);
  assert.ok(!/습니다/.test(foo.reason));
  const none = await st('');
  assert.strictEqual(none.reason, undefined);
  // 키 없는 쪽을 공백 섞어 고르면 그 키가 없다고 알린다
  const g = await withEnv({ DAYNOTE_AI_PROVIDER: ' gemini', ANTHROPIC_API_KEY: 'sk-ant-test' }, () => freshAi().status());
  assert.strictEqual(g.configured, false);
  assert.match(g.reason, /GEMINI_API_KEY/);
  assert.strictEqual(g.noKey, false);
});

// ---------------------------------------------------------------- 화면 쪽 입력 분류
function loadCapture() {
  const window = { Daynote: {} };
  const sandbox = { window, console, JSON, Object, Array, Promise, Intl, Date, Math, String, Number, setTimeout,
    document: { addEventListener() {} } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const load = (rel) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'), sandbox, { filename: rel });
  const DN = window.Daynote;
  Object.assign(DN, { model: M, dates: require('../src/core/dates'), aiOrganize: O, aiCapture: C, aiValidate: V, aiProposals: P });
  const pending = [];
  const S = {
    state: M.normalize(null),
    mutate(label, fn) { return fn(S.state); },
    whenReady() {},
    host: { ai: {
      status: () => Promise.resolve({ configured: true, provider: 'gemini', model: 'gemini-3.5-flash-lite' }),
      organizeNote: (input) => new Promise((r) => { pending.push({ input, resolve: r }); })
    } }
  };
  DN.store = S;
  DN.app = { now: () => new Date(NOW) };
  load('renderer/aiflow.js');
  load('renderer/capture.js');
  // 실제 제공자처럼 보낸 글에 맞춘 결과로 답한다
  const answer = () => {
    const p = pending.shift();
    const out = fake.organize(p.input).output;
    p.resolve({ ok: true, provider: 'gemini', model: 'gemini-3.5-flash-lite', output: out, raw: JSON.stringify(out) });
  };
  return { DN, S, answer, pending };
}
const liveTasks = (st) => st.tasks.filter((t) => !t.deletedAt);

test('입력 분류: 기다리는 사이 보관함에서 지운 메모의 결과로는 할 일을 만들지 않고, 실행 기록을 닫는다', async () => {
  // 지우지 않은 경우 — 같은 결과로 할 일이 생긴다 (아래 확인이 의미 있게)
  {
    const { DN, S, answer } = loadCapture();
    await DN.aiFlow.loadStatus();
    let done = null;
    DN.capture.submit('내일까지 견적서 보내기', null, (r) => { done = r; });
    answer();
    await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(done && done.ok, true);
    assert.strictEqual(liveTasks(S.state).length, 1);
  }
  const { DN, S, answer } = loadCapture();
  await DN.aiFlow.loadStatus();
  let done = null;
  const note = DN.capture.submit('내일까지 견적서 보내기', null, (r) => { done = r; });
  S.mutate('메모 삭제', (s) => { M.deleteNote(s, note.id, NOW); P.staleForDeletedNote(s, note.id); });
  answer();
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(done && done.reason, 'gone');
  assert.strictEqual(liveTasks(S.state).length, 0);
  assert.strictEqual(S.state.blocks.filter((b) => !b.deletedAt).length, 0);
  const run = S.state.aiRuns[0];
  assert.notStrictEqual(run.status, 'running');
  assert.strictEqual(run.error && run.error.type, 'canceled');
  assert.strictEqual(DN.capture.isRunning(note.id), false);
  // 지운 메모로는 다시 분류를 시작하지 않는다
  const again = await DN.capture.classify(note.id);
  assert.strictEqual(again, null);
});

// ---------------------------------------------------------------- 고친 메모에 늦게 온 결과
function sendAndEdit(text, patch) {
  const st = M.emptyState();
  const note = M.addNote(st, { title: '', body: text, captureRole: 'memo', capture: { status: 'pending', at: NOW.toISOString() } }, NOW);
  const sent = JSON.parse(JSON.stringify(note));
  const input = C.buildInput(sent, { today: '2026-10-05 (월)', projects: [], openTasks: [] });
  const out = Object.assign(fake.organize(input).output, { note_title: '견적서 발송' });
  const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION, noteHash: P.noteHash(sent) }, NOW);
  if (patch) M.updateNote(st, note.id, patch, NOW);                      // AI 가 읽는 사이 사용자가 고침
  const v = V.validateOrganizeNote(out, { note: sent, state: st, now: NOW });
  assert.ok(v.ok, v.errors && v.errors.join());
  P.applyCapture(st, { note: sent, run, validated: v, output: out }, NOW);
  return { st, note: M.byId(st.notes, note.id), out };
}

test('입력 분류: AI 가 읽는 사이 메모를 고쳤으면 원문을 숨기지(task_source) 않고 옛 글로 지은 제목도 붙이지 않는다', () => {
  // 고치지 않았으면 예전처럼 할 일만 적은 글은 원문을 숨긴다
  const base = sendAndEdit('내일까지 견적서 보내기');
  assert.strictEqual(base.out.entry_type, 'task');
  assert.strictEqual(base.note.captureRole, 'task_source');

  const body = '내일까지 견적서 보내기\n금액: 1,200만 원\n담당: 김 대리\n다음 회의: 10월 12일 오후 3시';
  const a = sendAndEdit('내일까지 견적서 보내기', { title: '견적 회의 메모', body });
  assert.strictEqual(a.note.captureRole, 'memo');
  assert.strictEqual(a.note.title, '견적 회의 메모');
  assert.strictEqual(a.note.body, body);
  assert.strictEqual(liveTasks(a.st).length, 1, '근거 문장이 남아 있는 할 일은 그대로 만든다');

  const b = sendAndEdit('내일까지 견적서 보내기', { body: body });
  assert.strictEqual(b.note.captureRole, 'memo');
  assert.strictEqual(b.note.title, '', '고치기 전 글로 지은 제목을 붙이지 않는다');

  // 근거 문장을 지웠으면 그 초안은 만들지 않는다
  const c = sendAndEdit('내일까지 견적서 보내기', { body: '견적은 취소됐어요' });
  assert.strictEqual(c.note.captureRole, 'memo');
  assert.strictEqual(liveTasks(c.st).length, 0);
});

// ---------------------------------------------------------------- 설정: 연결 확인 중 키 바꾸기·지우기
function nestedFn(src, name) {
  const start = src.indexOf('    function ' + name + '(');
  assert.ok(start >= 0, name + ' 없음');
  return src.slice(start, src.indexOf('\n    }\n', start) + 6);
}
function settingsHarness() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/views/settings.js'), 'utf8');
  const a = src.indexOf('  var CHECK_FAIL = {');
  const body = [
    'var lastCheck = null, checking = false, checkSeq = 0;',
    src.slice(a, src.indexOf('};', a) + 2),
    src.slice(src.indexOf('  function checkResultText('), src.indexOf('\n  }\n', src.indexOf('  function checkResultText(')) + 4),
    'function setCheckBtn() {}',
    'function rerender() { env.rerenders++; }',
    'function lastCheckText() { return lastCheck ? (lastCheck.ok ? "ok" : lastCheck.message) : "아직"; }',
    nestedFn(src, 'save'), nestedFn(src, 'check'), nestedFn(src, 'clearKey'),
    'return { save: save, check: check, clearKey: clearKey, get lastCheck() { return lastCheck; }, get checking() { return checking; } };'
  ].join('\n');
  const el = { textContent: '' };
  const env = { rerenders: 0, checks: [] };
  const input = { value: '', focus() {}, select() {} };
  const S = { host: { ai: {
    check: () => new Promise((r) => env.checks.push(r)),
    setKey: () => Promise.resolve({ ok: true }),
    clearKey: () => Promise.resolve({ ok: true })
  } } };
  const ui = { toast() {}, confirm: () => Promise.resolve(true) };
  const document = { getElementById: (id) => (id === 'set-ai-result' ? el : null) };
  const api = new Function('env', 'S', 'ui', 'document', 'input', 'result', body)(env, S, ui, document, input, el);
  return { api, env, el, input };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('설정 연결 확인: 확인하는 사이 키를 바꾸면 옛 키의 결과를 새 키 아래에 보이지 않는다', async () => {
  const { api, env, el, input } = settingsHarness();
  api.check();
  assert.match(el.textContent, /연결을 확인하는 중/);
  input.value = 'AIzaNEWKEYGOOD';
  api.save();
  await tick();
  assert.strictEqual(env.rerenders, 1);
  el.textContent = '연결을 확인하는 중… (몇 초 걸려요)';                       // 다시 그린 카드
  env.checks[0]({ ok: false, error: { type: 'auth', message: '키 오류', detail: 'API key not valid' } });
  await tick();
  assert.strictEqual(api.checking, false);
  assert.strictEqual(api.lastCheck, null);
  assert.strictEqual(el.textContent, '');
});

test('설정 연결 확인: 확인하는 사이 키를 지우면 \'잘 연결됐어요\' 를 보이지 않고, 지운 뒤 다시 확인하면 결과를 보인다', async () => {
  const { api, env, el } = settingsHarness();
  api.check();
  api.clearKey();
  await tick();
  env.checks[0]({ ok: true, ms: 1200, model: 'gemini-3.5-flash-lite' });
  await tick();
  assert.strictEqual(api.lastCheck, null);
  assert.doesNotMatch(el.textContent, /잘 연결됐어요/);
  api.check();
  env.checks[1]({ ok: true, ms: 1200, model: 'gemini-3.5-flash-lite' });
  await tick();
  assert.match(el.textContent, /잘 연결됐어요/);
});
