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
//   모든 작업(분류·정리·작게 나누기·구체화) → gemini-3.5-flash-lite (thinking minimal) 먼저 — 보통 1~3초
//   막히면 gemini-3.8-flash (thinking low) 로 대신. 무료 등급의 3.8 Flash 는 하루 20번이라 기본으로 쓰지 않는다
//   SDK 자체 재시도는 끈다 (한도 초과 오류 하나에 30초 넘게 기다렸다). 하루 한도에 걸린 모델은 풀릴 때까지 건너뛴다
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
const blockedUntil = {};      // 하루 한도에 걸린 모델 → 풀리는 시각(ms)
// 같은 요청도 서버 쪽에서 가끔 20~50초 걸린다(대부분 1~3초) — 8초 안에 답이 없으면 한 번 더 보내 먼저 온 답을 쓴다
const HEDGE_MS = 8000;
let hedgeMs = null;           // 테스트에서만 바꾼다
const inflight = new Set();   // 같은 메모를 동시에 두 번 정리하지 않는다
// 답 길이 상한 — 긴 글은 그만큼 늘리되 8,192 를 넘기지 않는다.
//   할 일 하나가 근거·날짜 칸까지 150~200 토큰이라 줄 수에 비례한다 (실측: 할 일 24줄 목록 326자 → 답 3,566 토큰)
const MAX_CAP = 8192;
function outCap(input, def) {
  const base = def.MAX_OUTPUT_TOKENS || 4096;
  const lines = ((input && input.lines) || []).filter((l) => String(l).trim());
  const chars = String((input && input.title) || '').length + lines.join('\n').length;
  return Math.min(MAX_CAP, Math.max(base, Math.round(800 + lines.length * 200 + chars * 0.5)));
}
// 같은 글이 답 길이 상한에 두 번 닿으면 그 글은 더 보내지 않는다 (되풀이 폭주에 비용·시간이 쌓이지 않게)
const truncatedTimes = new Map();   // 글 열쇠 → 끊긴 횟수
function textKey(input) { return String(input && (input.noteId || input.requestId)) + '|' + String((input && input.title) || '') + '|' + ((input && input.lines) || []).join('\n'); }

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
    configured: true, provider: 'gemini', model: MODELS.geminiFast, fastModel: MODELS.geminiFast, backupModel: MODELS.gemini, vendor: 'Google', keySource: keySource(),
    limited: Object.keys(blockedUntil).filter((k) => blockedUntil[k] > Date.now()),
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
  // 유료(결제 연결) 프로젝트의 '월 지출 한도' — 기다려도 안 풀린다 (다른 모델도 같은 프로젝트라 막힌다)
  if (status === 429 && /spend(ing)?\s*cap/i.test(e.message || '')) return { type: 'spend_cap', retryable: false,
    message: 'Google AI Studio에 정해 둔 이번 달 지출 한도를 넘어서 Gemini가 요청을 막았어요. ai.studio/spend 에서 한도를 올리면 바로 다시 돼요 (모든 PC 같은 키).' };
  if (status === 429) return Object.assign({ type: 'rate_limit', message: 'Gemini 사용 한도(분당·하루 요청 수)에 걸렸습니다. 조금 뒤 다시 시도해 주세요.', retryable: true }, limitInfo(e));
  // 키가 틀리면 Gemini 는 400 + API_KEY_INVALID 를 준다
  if (status === 400 && /API[_ ]?key/i.test(e.message || '')) return { type: 'auth', message: 'Gemini API 키가 올바르지 않아요. 설정에서 키를 확인해 주세요.', retryable: false };
  if (status === 400) return { type: 'bad_request', message: 'Gemini가 요청을 처리하지 못했습니다: ' + redact(e.message || ''), retryable: false };
  if (status && status >= 500) return { type: 'server', message: 'Gemini 서버 오류입니다. 잠시 뒤 다시 시도해 주세요.', retryable: true };
  if (status) return { type: 'api', message: 'Gemini 요청 오류(' + status + '): ' + redact(e.message || ''), retryable: false };
  return { type: 'network', message: 'Gemini 서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요. (' + redact(e && e.message ? e.message : e) + ')', retryable: true };
}

// 429 내용에서 하루 한도인지, 몇 뒤에 풀리는지 ("Please retry in 16h2m21s")
function limitInfo(e) {
  const msg = String(e && e.message || '');
  const m = /retry in\s*(?:(\d+)h)?\s*(?:(\d+)m(?!s))?\s*(?:([\d.]+)s)?/i.exec(msg);
  const ms = m && (m[1] || m[2] || m[3]) ? ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000 : null;
  return { daily: /per\s*day|PerDay|daily/i.test(msg) || (ms != null && ms > 15 * 60000), retryAfterMs: ms };
}
function dailyLimitError() {
  const until = Math.min.apply(null, [MODELS.geminiFast, MODELS.gemini].map((k) => blockedUntil[k] || Infinity));
  const h = isFinite(until) ? Math.max(1, Math.round((until - Date.now()) / 3600000)) : null;
  return { type: 'rate_limit', daily: true, retryable: false,
    message: 'Gemini 무료 한도를 오늘 다 썼어요' + (h ? ' (약 ' + h + '시간 뒤에 풀려요)' : '') + '. 결제를 연결한 유료 등급이면 한도가 크게 늘어요.' };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, retryDelayMs != null ? retryDelayMs : ms));

async function callGemini(input, model, signal, cap) {
  const def = requestDef(input);
  model = model || MODELS.gemini;
  const res = await gemini().interactions.create({
    model: model,
    system_instruction: def.SYSTEM,
    input: def.userText(input),
    // 정리·추출은 깊은 추론보다 정확한 읽기 — 낮은 thinking
    // 답 길이 상한 — 드물게 요약을 끝없이 되풀이하는 일이 있었다(실측 21,632 토큰). 닿으면 '끊김'으로 다시 시도
    generation_config: { thinking_level: THINKING[model] || 'low', max_output_tokens: cap || outCap(input, def) },
    // Claude 와 같은 JSON 스키마로 구조를 고정한다
    response_format: { type: 'text', mime_type: 'application/json', schema: def.SCHEMA },
    // 요청·응답을 Google 쪽에 보관하지 않는다
    store: false
  }, { maxRetries: 0, fetchOptions: signal ? { signal } : undefined });   // 재시도는 아래 callGeminiTiered 가 (다른 모델로 바로)
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

// 늦는 요청 대비 — 첫 요청이 HEDGE_MS 안에 안 끝나면 같은 요청을 하나 더. 먼저 온 성공을 쓰고 나머지는 끊는다
//   (금방 실패하면 기다리지 않고 바로 실패를 돌려준다 → 다른 모델로)
function callGeminiHedged(input, model, cap) {
  // 끊겨서 다시 보내는 길은 겹쳐 보내지 않는다 (긴 답 두 개 값을 내지 않게)
  const ms = cap ? 0 : hedgeMs != null ? hedgeMs : HEDGE_MS;
  return new Promise((resolve, reject) => {
    const ctrls = [];
    let settled = false, inFlight = 0, timer = null;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      ctrls.forEach((c) => { try { c.abort(); } catch (e) {} });
      fn(v);
    };
    function launch() {
      const c = new AbortController();
      ctrls.push(c); inFlight++;
      callGemini(input, model, c.signal, cap).then((r) => {
        inFlight--;
        // 성공이거나 다시 해도 소용없는 실패면 바로. 다시 할 만한 실패인데 다른 요청이 아직 가는 중이면 그쪽을 기다린다
        if (r.ok || !r.error || !r.error.retryable || inFlight === 0) finish(resolve, r);
      }, (e) => {
        inFlight--;
        if (inFlight === 0) finish(reject, e);
      });
    }
    launch();
    if (ms > 0) timer = setTimeout(() => { if (!settled) launch(); }, ms);
  });
}

// 빠른 모델(3.5 Flash-Lite) 먼저, 막히면 3.8 Flash. 하루 한도에 걸린 모델은 건너뛴다.
//   둘 다 잠깐 막혔으면(서버 오류·분당 한도) 조금 쉬었다가 빠른 모델로 한 번 더
async function callGeminiTiered(input) {
  const order = [MODELS.geminiFast, MODELS.gemini].filter((k) => !(blockedUntil[k] > Date.now()));
  if (!order.length) return { ok: false, error: dailyLimitError() };
  // 답이 상한에 닿아 끊기면(truncated) 다른 모델로 상한을 두 배로 해 딱 한 번만 더. 또 끊기면 멈춘다 (글은 메모로 남아 있다)
  let cap = null, truncs = 0;
  async function attempt(model) {
    try {
      const r = await callGeminiHedged(input, model, cap);
      // 예외 없이 '끝내지 못함(incomplete·failed)' 을 돌려줘도 다시 할 만한 실패면 다음으로 (JSON 을 못 읽은 건 organize 가 한 번 더)
      return { done: r.ok || !r.error || !r.error.retryable || r.error.type === 'invalid_json', res: r };
    } catch (e) {
      const c = classifyGemini(e);
      if (c.type === 'rate_limit' && c.daily) blockedUntil[model] = Date.now() + Math.min(Math.max(c.retryAfterMs || 0, 15 * 60000), 24 * 3600000);
      if (!c.retryable && e.status !== 404) throw Object.assign(e, { _classified: c });
      return { done: false, res: { ok: false, error: c } };
    }
  }
  let last = null;
  const errs = {};
  for (let i = 0; i < order.length; i++) {
    const a = await attempt(order[i]);
    if (a.done) return a.res;
    last = errs[order[i]] = a.res;
    if (last.error.type === 'truncated') {
      if (++truncs >= 2) return last;
      cap = Math.min(MAX_CAP, outCap(input, requestDef(input)) * 2);
      if (i === order.length - 1) return (await attempt(order[i])).res;   // 다른 모델이 없으면 같은 모델로 한 번
      continue;
    }
    if (i < order.length - 1) await sleep(last.error.type === 'rate_limit' ? 150 : 600);
  }
  if (last && last.error.type === 'truncated') return last;
  // 하루 한도로 다 막혔으면 기다리지 않고 알린다
  const left = order.filter((k) => !(blockedUntil[k] > Date.now()));
  if (!left.length) return { ok: false, error: dailyLimitError() };
  const e0 = errs[left[0]].error;   // 다시 해 볼 모델이 낸 오류 기준으로 기다린다
  const wait = e0.retryAfterMs != null ? e0.retryAfterMs : 1500;
  if (wait > 8000) return errs[left[0]];
  await sleep(wait);
  return (await attempt(left[0])).res;
}

async function organize(input) {
  const m = mode();
  if (!m) return { ok: false, error: { type: 'not_configured', message: status().reason, retryable: false } };
  const key = input && (input.noteId || input.requestId);
  if (!key) return { ok: false, error: { type: 'bad_input', message: '요청 정보가 없습니다.', retryable: false } };
  if (inflight.has(key)) return { ok: false, error: { type: 'busy', message: '이미 처리 중입니다.', retryable: false } };
  const tk = textKey(input);
  if ((truncatedTimes.get(tk) || 0) >= 2) return { ok: false, attempts: 0, error: { type: 'truncated', retryable: false,
    message: 'AI 답이 너무 길어져 두 번 끊겼어요. 같은 글은 더 보내지 않아요 — 글은 메모로 남아 있어요. 글을 나눠서 보내 주세요.' } };
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
    if (!res.ok && res.error.type === 'truncated') {
      truncatedTimes.set(tk, (truncatedTimes.get(tk) || 0) + 1);
      if (truncatedTimes.size > 200) truncatedTimes.delete(truncatedTimes.keys().next().value);
      res.error = Object.assign({}, res.error, { message: 'AI 답이 너무 길어져 중간에 끊겼어요. 글은 메모로 남겨 두었어요.' });
    }
    return Object.assign(res, { attempts });
  } catch (e) {
    return { ok: false, error: e._classified || (m === 'gemini' ? classifyGemini(e) : classifyClaude(e)), attempts: 1 };
  } finally {
    inflight.delete(key);
  }
}

// 테스트용: 실제 네트워크 없이 클라이언트를 바꿔 끼운다
function _setClients(c) { if (c.gemini) geminiClient = c.gemini; if (c.claude) claudeClient = c.claude; if ('retryDelayMs' in c) retryDelayMs = c.retryDelayMs; if ('hedgeMs' in c) hedgeMs = c.hedgeMs; }

module.exports = { status, organize, MODELS, setSavedKey, captureEnvKeys, redact, _setClients };
