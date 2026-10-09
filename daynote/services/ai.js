'use strict';

// AI 연결 — 메인 프로세스에서만 돈다. API 키는 환경변수로만 읽고 화면에는 넘기지 않는다.
// 여기서는 호출·재시도·오류 분류까지만 한다. 응답 검증과 저장은 화면 쪽 src/core/ai 가 맡는다.
//
// 어떤 AI 를 쓰나 (위에서부터 먼저 맞는 것)
//   DAYNOTE_AI_FAKE=1                 → 가짜 AI(규칙 기반, 데모)
//   DAYNOTE_AI_PROVIDER=gemini|claude → 그 제공자 (키가 있어야 함)
//   GEMINI_API_KEY (또는 GOOGLE_API_KEY) / 설정 화면에 저장한 키 → Gemini   ← 기본
//   ANTHROPIC_API_KEY                 → Claude Opus 5.5
//
// Gemini 는 두 모델을 나눠 쓴다 (실측: Flash-Lite 3~6초, 3.8 Flash 4~70초로 들쭉날쭉)
//   던진 글 분류(capture) → gemini-3.5-flash-lite (thinking minimal) — 빨라야 한다
//   나머지(정리·작게 나누기·구체화) → gemini-3.8-flash (thinking low)
//   한쪽이 일시 오류(한도·서버·연결)면 다른 쪽으로 한 번 더 — 끊기지 않게
//
// 두 제공자 모두 같은 프롬프트(organizeNote.SYSTEM)와 같은 JSON 스키마를 쓴다.
// 그래서 결과는 같은 검증기(validate.js)를 거치고, 어느 AI 를 쓰든 저장 규칙은 같다.

const organizeNote = require('../src/core/ai/organizeNote');
const capture = require('../src/core/ai/capture');

const assist = require('../src/core/ai/assist');

// 요청 종류별 지침·스키마
//   capture   : 홈 채팅 입력 자동 분류
//   breakdown : 할 일 작게 나누기
//   elaborate : 자세히 적어 두면 좋을 할 일 고르기
//   (그 밖)   : 메모 정리
function requestDef(input) {
  var p = input && input.purpose;
  if (p === 'capture') return capture;
  if (p === 'breakdown') return assist.BREAKDOWN;
  if (p === 'elaborate') return assist.ELABORATE;
  return organizeNote;
}
const fake = require('../src/core/ai/fake');

const MODELS = { claude: 'claude-opus-5-5', gemini: 'gemini-3.8-flash', geminiFast: 'gemini-3.5-flash-lite' };
const THINKING = { 'gemini-3.8-flash': 'low', 'gemini-3.5-flash-lite': 'minimal' };
let retryDelayMs = null;      // 테스트에서만 바꾼다
const inflight = new Set();   // 같은 메모를 동시에 두 번 정리하지 않는다

// 키는 이 모듈 안에만 둔다.
//   설정 화면에서 저장한 키 — 메인 프로세스가 복호화해 넣어 준다 (가장 우선: 사용자가 가장 최근에 직접 넣은 키)
//   환경변수·.env 키 — 앱이 켜질 때 captureEnvKeys() 로 옮겨 오고 process.env 에서는 지운다.
//     (process.env 에 남아 있으면 화면·빠른 메모 창 프로세스에도 물려 들어간다)
let savedKey = '';
const envKeys = { gemini: '', anthropic: '', source: null };
function setSavedKey(k) { savedKey = String(k || '').trim(); geminiClient = null; }
function captureEnvKeys() {
  const g = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  const a = process.env.ANTHROPIC_API_KEY || '';
  if (g) { envKeys.gemini = g.trim(); envKeys.source = process.env.DAYNOTE_KEY_FROM_DOTENV === '1' ? 'dotenv' : 'env'; }
  if (a) envKeys.anthropic = a.trim();
  ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'DAYNOTE_KEY_FROM_DOTENV'].forEach((k) => { delete process.env[k]; });
  geminiClient = null; claudeClient = null;
}
function envGemini() { return (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim() || envKeys.gemini; }
function geminiKey() { return savedKey || envGemini() || ''; }
function anthropicKey() { return (process.env.ANTHROPIC_API_KEY || '').trim() || envKeys.anthropic || ''; }
function keySource() {
  if (savedKey) return 'saved';
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return process.env.DAYNOTE_KEY_FROM_DOTENV === '1' ? 'dotenv' : 'env';
  return envKeys.gemini ? envKeys.source : null;
}
// 키에 공백·줄바꿈이 섞이면 SDK 오류 메시지에 키가 그대로 실릴 수 있다 — 아예 쓰지 않는다
function badKey(k) { return !!k && /[\s\u0000-\u001f]/.test(k); }
// 오류 메시지에서 키처럼 보이는 문자열을 가린다 (화면·저장 기록·백업으로 새지 않게)
function redact(msg) {
  let m = String(msg == null ? '' : msg);
  [savedKey, envKeys.gemini, envKeys.anthropic, process.env.GEMINI_API_KEY, process.env.GOOGLE_API_KEY, process.env.ANTHROPIC_API_KEY]
    .filter((k) => k && k.length >= 8).forEach((k) => { m = m.split(k).join('[키 가림]'); });
  return m.replace(/AIza[0-9A-Za-z_-]{10,}/g, '[키 가림]').replace(/sk-ant-[0-9A-Za-z_-]{10,}/g, '[키 가림]');
}

function mode() {
  if (process.env.DAYNOTE_AI_FAKE === '1') return 'fake';
  const want = String(process.env.DAYNOTE_AI_PROVIDER || '').toLowerCase();
  if (want === 'gemini') return geminiKey() && !badKey(geminiKey()) ? 'gemini' : null;
  if (want === 'claude') return anthropicKey() && !badKey(anthropicKey()) ? 'claude' : null;
  if (geminiKey() && !badKey(geminiKey())) return 'gemini';
  if (anthropicKey() && !badKey(anthropicKey())) return 'claude';
  return null;
}

function status() {
  const m = mode();
  if (m === 'fake') return { configured: true, provider: 'fake', model: '가짜 AI(테스트)' };
  if (m === 'gemini') return {
    configured: true, provider: 'gemini', model: MODELS.gemini, fastModel: MODELS.geminiFast, vendor: 'Google', keySource: keySource(),
    notice: 'Gemini API 무료 등급에서는 보낸 내용이 Google 제품 개선에 쓰일 수 있습니다. 결제를 연결한 유료 등급에서는 쓰이지 않습니다.'
  };
  if (m === 'claude') return { configured: true, provider: 'claude', model: MODELS.claude, vendor: 'Anthropic' };
  const want = String(process.env.DAYNOTE_AI_PROVIDER || '').toLowerCase();
  if (badKey(geminiKey()) || badKey(anthropicKey())) return { configured: false, provider: null, model: null, reason: 'AI 키에 공백이나 줄바꿈이 섞여 있어요. 키를 다시 복사해 넣어 주세요.' };
  return {
    configured: false, provider: null, model: null,
    reason: want === 'gemini' ? 'GEMINI_API_KEY 환경변수가 설정되어 있지 않습니다.'
      : want === 'claude' ? 'ANTHROPIC_API_KEY 환경변수가 설정되어 있지 않습니다.'
      : 'AI 키가 없습니다. 설정에서 Google AI Studio 키를 넣어 주세요.'
  };
}

function parseOutput(text, provider, model, usage) {
  let output;
  try { output = JSON.parse(text); }
  catch (e) { return { ok: false, error: { type: 'invalid_json', message: 'AI 응답을 읽지 못했습니다.', retryable: true }, raw: text }; }
  return { ok: true, provider, model, output, raw: text, usage: usage || null };
}

// ------------------------------------------------------------------ Claude
let claudeClient = null;
function claude() {
  if (!claudeClient) {
    const Anthropic = require('@anthropic-ai/sdk');
    claudeClient = new Anthropic({
      apiKey: anthropicKey(),
      maxRetries: 2,                            // 429·5xx·연결 오류는 SDK 가 자동 재시도
      timeout: 120 * 1000
    });
  }
  return claudeClient;
}

function classifyClaude(e) {
  const Anthropic = require('@anthropic-ai/sdk');
  if (e instanceof Anthropic.AuthenticationError) return { type: 'auth', message: 'API 키가 올바르지 않습니다. ANTHROPIC_API_KEY 를 확인해 주세요.', retryable: false };
  if (e instanceof Anthropic.PermissionDeniedError) return { type: 'permission', message: '이 API 키로는 요청할 권한이 없습니다.', retryable: false };
  if (e instanceof Anthropic.RateLimitError) return { type: 'rate_limit', message: '요청이 많아 잠시 제한되었습니다. 조금 뒤 다시 시도해 주세요.', retryable: true };
  if (e instanceof Anthropic.BadRequestError) return { type: 'bad_request', message: '요청을 처리하지 못했습니다: ' + redact(e.message), retryable: false };
  if (e instanceof Anthropic.APIConnectionError) return { type: 'network', message: 'AI 서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.', retryable: true };
  if (e instanceof Anthropic.APIError && e.status >= 500) return { type: 'server', message: 'AI 서버 오류입니다. 잠시 뒤 다시 시도해 주세요.', retryable: true };
  if (e instanceof Anthropic.APIError) return { type: 'api', message: 'AI 요청 오류(' + e.status + '): ' + redact(e.message), retryable: false };
  return { type: 'unknown', message: redact(e && e.message ? e.message : String(e)), retryable: true };
}

async function callClaude(input) {
  const def = requestDef(input);
  const res = await claude().beta.messages.create({
    model: MODELS.claude,
    max_tokens: 16000,
    // 거절 응답 시 서버가 권장 모델로 다시 시도한다
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    // 정리·추출은 깊은 추론보다 정확한 읽기 — 낮은 effort
    output_config: { effort: 'low', format: { type: 'json_schema', schema: def.SCHEMA } },
    // 고정된 지침은 캐시한다 (메모마다 바뀌는 내용은 뒤쪽 user 메시지에만)
    system: [{ type: 'text', text: def.SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: def.userText(input) }]
  });
  if (res.stop_reason === 'refusal') {
    return { ok: false, error: { type: 'refusal', message: '이 메모는 AI가 처리하지 않았습니다.' + (res.stop_details && res.stop_details.explanation ? ' (' + res.stop_details.explanation + ')' : ''), retryable: false } };
  }
  if (res.stop_reason === 'max_tokens') {
    return { ok: false, error: { type: 'truncated', message: '메모가 길어 결과가 중간에 끊겼습니다.', retryable: true } };
  }
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return parseOutput(text, 'claude', res.model, res.usage);
}

// ------------------------------------------------------------------ Gemini
let geminiClient = null;
function gemini() {
  if (!geminiClient) {
    const { GoogleGenAI } = require('@google/genai');
    geminiClient = new GoogleGenAI({ apiKey: geminiKey(), httpOptions: { timeout: 120 * 1000 } });
  }
  return geminiClient;
}

function classifyGemini(e) {
  const status = e && typeof e.status === 'number' ? e.status : null;
  if (status === 401 || status === 403) return { type: 'auth', message: 'Gemini API 키가 올바르지 않거나 권한이 없습니다. GEMINI_API_KEY 를 확인해 주세요.', retryable: false };
  if (status === 429) return { type: 'rate_limit', message: 'Gemini 사용 한도에 걸렸습니다(무료 등급은 분당·하루 요청 수가 정해져 있습니다). 조금 뒤 다시 시도해 주세요.', retryable: true };
  // 키가 틀리면 Gemini 는 400 + API_KEY_INVALID 를 준다
  if (status === 400 && /API[_ ]?key/i.test(e.message || '')) return { type: 'auth', message: 'Gemini API 키가 올바르지 않아요. 설정에서 키를 확인해 주세요.', retryable: false };
  if (status === 400) return { type: 'bad_request', message: 'Gemini가 요청을 처리하지 못했습니다: ' + redact(e.message || ''), retryable: false };
  if (status && status >= 500) return { type: 'server', message: 'Gemini 서버 오류입니다. 잠시 뒤 다시 시도해 주세요.', retryable: true };
  if (status) return { type: 'api', message: 'Gemini 요청 오류(' + status + '): ' + redact(e.message || ''), retryable: false };
  return { type: 'network', message: 'Gemini 서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요. (' + redact(e && e.message ? e.message : e) + ')', retryable: true };
}

async function callGemini(input, model) {
  const def = requestDef(input);
  model = model || MODELS.gemini;
  const res = await gemini().interactions.create({
    model: model,
    system_instruction: def.SYSTEM,
    input: def.userText(input),
    // 정리·추출은 깊은 추론보다 정확한 읽기 — 낮은 thinking
    generation_config: { thinking_level: THINKING[model] || 'low' },
    // Claude 와 같은 JSON 스키마로 구조를 고정한다
    response_format: { type: 'text', mime_type: 'application/json', schema: def.SCHEMA },
    // 요청·응답을 Google 쪽에 보관하지 않는다
    store: false
  });
  if (res.status && res.status !== 'completed') {
    const truncated = res.status === 'incomplete' || res.status === 'budget_exceeded';
    return { ok: false, error: {
      type: truncated ? 'truncated' : 'failed',
      message: truncated ? '메모가 길어 결과가 중간에 끊겼습니다.' : 'Gemini가 정리를 끝내지 못했습니다(상태: ' + res.status + ').',
      retryable: true
    } };
  }
  const u = res.usage || {};
  return parseOutput(res.output_text || '', 'gemini', model, {
    input_tokens: u.total_input_tokens, output_tokens: u.total_output_tokens, thought_tokens: u.total_thought_tokens
  });
}

// 분류는 빠른 모델 먼저, 그 밖은 3.8 Flash 먼저. 일시 오류(또는 모델 없음 404)면 다른 모델로 한 번 더.
async function callGeminiTiered(input) {
  const order = input && input.purpose === 'capture' ? [MODELS.geminiFast, MODELS.gemini] : [MODELS.gemini, MODELS.geminiFast];
  try { return await callGemini(input, order[0]); }
  catch (e) {
    const c = classifyGemini(e);
    if (!c.retryable && e.status !== 404) throw Object.assign(e, { _classified: c });
    // 잠깐 끊긴 연결이면 바로 다시 해도 실패하니 조금 쉬었다가 (한도 초과는 다른 모델이라 짧게)
    await new Promise((r) => setTimeout(r, retryDelayMs != null ? retryDelayMs : c.type === 'rate_limit' ? 300 : 1200));
    try { return await callGemini(input, order[1]); }
    catch (e2) { throw Object.assign(e2, { _classified: classifyGemini(e2) }); }
  }
}

async function organize(input) {
  const m = mode();
  if (!m) return { ok: false, error: { type: 'not_configured', message: status().reason, retryable: false } };
  const key = input && (input.noteId || input.requestId);
  if (!key) return { ok: false, error: { type: 'bad_input', message: '요청 정보가 없습니다.', retryable: false } };
  if (inflight.has(key)) return { ok: false, error: { type: 'busy', message: '이미 처리 중입니다.', retryable: false } };
  inflight.add(key);
  try {
    if (m === 'fake') {
      await new Promise((r) => setTimeout(r, 600));
      const out = fake.organize(input);
      return Object.assign({ raw: out.output ? JSON.stringify(out.output) : null, attempts: 1 }, out);
    }
    const call = m === 'gemini' ? () => callGeminiTiered(input) : () => callClaude(input);
    // JSON 을 못 읽은 경우만 한 번 더 요청한다
    let res = await call();
    let attempts = 1;
    if (!res.ok && res.error.type === 'invalid_json') { res = await call(); attempts = 2; }
    return Object.assign(res, { attempts });
  } catch (e) {
    return { ok: false, error: e._classified || (m === 'gemini' ? classifyGemini(e) : classifyClaude(e)), attempts: 1 };
  } finally {
    inflight.delete(key);
  }
}

// 테스트용: 실제 네트워크 없이 클라이언트를 바꿔 끼운다
function _setClients(c) { if (c.gemini) geminiClient = c.gemini; if (c.claude) claudeClient = c.claude; if ('retryDelayMs' in c) retryDelayMs = c.retryDelayMs; }

module.exports = { status, organize, MODELS, setSavedKey, captureEnvKeys, redact, _setClients };
