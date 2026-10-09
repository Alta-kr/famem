'use strict';

// AI 제공자 선택과 Gemini 호출 처리 — 실제 네트워크 없이, 바꿔 끼운 클라이언트로 확인한다.

const test = require('node:test');
const assert = require('node:assert');
const O = require('../src/core/ai/organizeNote');

const ENV = ['DAYNOTE_AI_FAKE', 'DAYNOTE_AI_PROVIDER', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY'];
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

const INPUT = O.buildInput({ id: 'n1', title: '회의', body: '- [ ] 금요일까지 견적서 회신', updatedAt: new Date(2026, 9, 5, 10).toISOString() },
  { today: '2026-10-05 (월)', projects: [], openTasks: [] });
const OUTPUT = { summary: '요약', sections: [], tasks: [], events: [], open_questions: [] };

test('제공자 선택: Gemini 키가 있으면 Gemini 3.8 Flash 가 기본, 강제 지정과 키 없음 처리', () => {
  withEnv({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }, () => {
    const s = freshAi().status();
    assert.strictEqual(s.provider, 'gemini');
    assert.strictEqual(s.model, 'gemini-3.8-flash');
    assert.match(s.notice, /무료 등급/);
  });
  withEnv({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a', DAYNOTE_AI_PROVIDER: 'claude' }, () => {
    assert.strictEqual(freshAi().status().provider, 'claude');
  });
  withEnv({ ANTHROPIC_API_KEY: 'a' }, () => { assert.strictEqual(freshAi().status().provider, 'claude'); });
  withEnv({ GOOGLE_API_KEY: 'g' }, () => { assert.strictEqual(freshAi().status().provider, 'gemini'); });
  withEnv({ DAYNOTE_AI_PROVIDER: 'gemini' }, () => {
    const s = freshAi().status();
    assert.strictEqual(s.configured, false);
    assert.match(s.reason, /GEMINI_API_KEY/);
  });
  withEnv({}, () => { assert.strictEqual(freshAi().status().configured, false); });
});

test('Gemini 호출: 같은 프롬프트·스키마로 요청하고, 요청을 보관하지 않으며, JSON 을 읽는다', async () => {
  await withEnv({ GEMINI_API_KEY: 'g' }, async () => {
    const ai = freshAi();
    let sent = null;
    ai._setClients({ gemini: { interactions: { create: async (req) => { sent = req; return { status: 'completed', output_text: JSON.stringify(OUTPUT), usage: { total_input_tokens: 900, total_output_tokens: 120 } }; } } } });
    const r = await ai.organize(INPUT);
    assert.ok(r.ok, JSON.stringify(r.error));
    assert.deepStrictEqual(r.output, OUTPUT);
    assert.strictEqual(r.provider, 'gemini');
    assert.strictEqual(sent.model, 'gemini-3.8-flash');
    assert.strictEqual(sent.system_instruction, O.SYSTEM);
    assert.strictEqual(sent.response_format.schema, O.SCHEMA);
    assert.strictEqual(sent.response_format.mime_type, 'application/json');
    assert.strictEqual(sent.store, false);
    assert.strictEqual(r.usage.input_tokens, 900);
  });
});

test('Gemini 오류: 한도 초과(429)는 한 번 더 시도하고, 키 오류(401)는 바로 실패, 끊긴 응답은 재시도 가능', async () => {
  await withEnv({ GEMINI_API_KEY: 'g' }, async () => {
    const ai = freshAi();
    ai._setClients({ retryDelayMs: 0 });
    let calls = 0;
    ai._setClients({ gemini: { interactions: { create: async () => { calls++; if (calls === 1) throw Object.assign(new Error('quota'), { status: 429 }); return { status: 'completed', output_text: JSON.stringify(OUTPUT) }; } } } });
    const r = await ai.organize(INPUT);
    assert.ok(r.ok);
    assert.strictEqual(calls, 2);

    ai._setClients({ gemini: { interactions: { create: async () => { throw Object.assign(new Error('bad key'), { status: 401 }); } } } });
    const r2 = await ai.organize(INPUT);
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(r2.error.type, 'auth');
    assert.strictEqual(r2.error.retryable, false);

    ai._setClients({ gemini: { interactions: { create: async () => ({ status: 'incomplete', output_text: '{"summ' }) } } });
    const r3 = await ai.organize(INPUT);
    assert.strictEqual(r3.error.type, 'truncated');
    assert.strictEqual(r3.error.retryable, true);

    let n = 0;
    ai._setClients({ gemini: { interactions: { create: async () => { n++; return { status: 'completed', output_text: n === 1 ? 'not json' : JSON.stringify(OUTPUT) }; } } } });
    const r4 = await ai.organize(INPUT);
    assert.ok(r4.ok);
    assert.strictEqual(r4.attempts, 2);
  });
});
