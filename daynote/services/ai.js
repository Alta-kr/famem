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
// 모델별 설정은 MODELS 의 자리(빠른 모델 / 그 밖)로 정한다 — 모델 이름을 한 곳에서 바꿔도 thinking·시간 제한이 따라가게
function geminiTier(model) {
  return model === MODELS.geminiFast ? { thinking: 'minimal', timeout: 60 * 1000 } : { thinking: 'low', timeout: GEMINI_TIMEOUT_DEFAULT_MS };
}
let retryDelayMs = null;      // 테스트에서만 바꾼다
// 요청 하나(두 모델 + JSON 재요청까지)의 전체 마감. 모델별 시간 제한은 callGemini, Claude 는 클라이언트 timeout.
const DEADLINE_MS = 4 * 60 * 1000;
let deadlineMs = DEADLINE_MS;
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
// 키에 공백·줄바꿈이 섞이면 SDK 오류 메시지에 키가 그대로 실릴 수 있다 — 아예 쓰지 않는다.
// 둥근 따옴표 같은 ASCII 밖 글자도 요청 머리말에 실을 수 없어 매번 실패하니 미리 막는다.
function badKey(k) { return !!k && /[^\x21-\x7e]/.test(k); }
// 오류 메시지에서 키처럼 보이는 문자열을 가린다 (화면·저장 기록·백업으로 새지 않게)
function redact(msg) {
  let m = String(msg == null ? '' : msg);
  [savedKey, envKeys.gemini, envKeys.anthropic, process.env.GEMINI_API_KEY, process.env.GOOGLE_API_KEY, process.env.ANTHROPIC_API_KEY]
    .filter((k) => k && k.length >= 8).forEach((k) => { m = m.split(k).join('[키 가림]'); });
  return m.replace(/AIza[0-9A-Za-z_-]{10,}/g, '[키 가림]').replace(/sk-ant-[0-9A-Za-z_-]{10,}/g, '[키 가림]');
}

// DAYNOTE_AI_PROVIDER — 앞뒤 공백은 떼고(Windows cmd 의 `set X=claude && …` 는 끝에 공백이 붙는다), 회사 이름도 받는다
function wantProvider() {
  const w = String(process.env.DAYNOTE_AI_PROVIDER || '').trim().toLowerCase();
  return w === 'anthropic' ? 'claude' : w === 'google' ? 'gemini' : w;
}
const PROVIDER_WARNING = 'DAYNOTE_AI_PROVIDER 값은 gemini 또는 claude 여야 해요. 지금은 자동으로 골랐어요.';

function mode() {
  if (process.env.DAYNOTE_AI_FAKE === '1') return 'fake';
  const want = wantProvider();
  if (want === 'gemini') return geminiKey() && !badKey(geminiKey()) ? 'gemini' : null;
  if (want === 'claude') return anthropicKey() && !badKey(anthropicKey()) ? 'claude' : null;
  if (geminiKey() && !badKey(geminiKey())) return 'gemini';
  if (anthropicKey() && !badKey(anthropicKey())) return 'claude';
  return null;
}

function status() {
  const m = mode();
  const want = wantProvider();
  // 알아볼 수 없는 값이면 자동으로 고르되, 고급의 '상태 원문 사유' 에 알린다
  const warn = want && want !== 'gemini' && want !== 'claude' ? { reason: PROVIDER_WARNING } : {};
  if (m === 'fake') return { configured: true, provider: 'fake', model: '가짜 AI(테스트)' };
  if (m === 'gemini') return Object.assign({
    configured: true, provider: 'gemini', model: MODELS.gemini, fastModel: MODELS.geminiFast, vendor: 'Google', keySource: keySource(),
    notice: 'Gemini API 무료 등급에서는 보낸 내용이 Google 제품 개선에 쓰일 수 있어요. 결제를 연결한 유료 등급에서는 쓰이지 않아요.'
  }, warn);
  if (m === 'claude') return Object.assign({ configured: true, provider: 'claude', model: MODELS.claude, vendor: 'Anthropic' }, warn);
  if (badKey(geminiKey()) || badKey(anthropicKey())) return { configured: false, provider: null, model: null, reason: 'AI 키에 공백이나 줄바꿈, 따옴표 같은 다른 문자가 섞여 있어요. 키를 다시 복사해 넣어 주세요.' };
  return {
    configured: false, provider: null, model: null,
    reason: want === 'gemini' ? 'GEMINI_API_KEY 환경변수가 설정되어 있지 않아요.'
      : want === 'claude' ? 'ANTHROPIC_API_KEY 환경변수가 설정되어 있지 않아요.'
      : 'AI 키가 없어요. 설정에서 Google AI Studio 키를 넣어 주세요.',
    // 고를 공급자가 정해지지 않았고 키가 그냥 없는 경우 — main 이 '저장한 키를 못 푼다' 로 바꿔 말할 수 있게
    noKey: want !== 'gemini' && want !== 'claude'
  };
}

// schema 를 주면(Claude) '값 없음' 표시를 null 로 되돌린 결과를 output·raw 로 쓴다 (지난 결과 재사용도 같은 모양이 되게)
// 코드 울타리(```json … ```)나 앞뒤 문장으로 감싼 JSON 도 읽는다 — 내용 검사는 렌더러 검증기가 그대로 한다
function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch (e) { /* 아래에서 감싼 모양을 벗겨 본다 */ }
  const t = String(text || '').trim().replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```\s*$/, '');
  try { return JSON.parse(t); } catch (e) { /* 바깥 { … } 만 꺼내 본다 */ }
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch (e) { /* 못 읽음 */ } }
  return undefined;
}
function parseOutput(text, provider, model, usage, schema) {
  let output = parseJsonLoose(text);
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return { ok: false, provider, model, error: { type: 'invalid_json', message: 'AI 응답을 읽지 못했어요.', retryable: true }, raw: text };
  }
  if (schema) output = fromClaude(schema, output);
  // raw 는 읽은 결과를 다시 JSON 으로 — 울타리·앞 문장으로 감싼 응답도 '지난 결과 재사용'(aiflow 의 JSON.parse)이 읽을 수 있게
  return { ok: true, provider, model, output, raw: JSON.stringify(output), usage: usage || null };
}

// ------------------------------------------------------------------ Claude 용 스키마
// Anthropic 구조화 출력은 anyOf(합집합) 칸을 요청 하나에 16개까지만 받는다 (넘으면 400 "Schema is too complex").
// 빠른 입력 분류(capture) 스키마는 null 을 허용하는 칸이 29개라, Claude 에 보낼 때만 null 대신 '값 없음' 표시를 쓴다:
//   글자 → ""  ·  정수 → -1  ·  선택지 → "none"  ·  참/거짓 → "true" | "false" | "none"
// 받은 응답은 fromClaude 로 원래 스키마 모양(null)으로 되돌려 같은 검증기를 거친다. Gemini 는 원래 스키마 그대로.
const NONE_ENUM = 'none';
const CLAUDE_NONE_NOTE = '출력 형식 안내: 이 요청의 JSON 스키마에는 null 이 없습니다. 지침에서 null 이라고 한 값은 글자 칸이면 빈 문자열 "", 정수 칸이면 -1, 선택지·참거짓 칸이면 "none" 으로 적습니다.';
function nullableInner(s) {
  if (!s || !Array.isArray(s.anyOf) || s.anyOf.length !== 2) return null;
  const rest = s.anyOf.filter((x) => !(x && x.type === 'null' && Object.keys(x).length === 1));
  return rest.length === 1 ? rest[0] : null;
}
function isNoneEnum(t) { return t && t.type === 'string' && Array.isArray(t.enum) && t.enum.indexOf(NONE_ENUM) < 0; }
function toClaudeSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const inner = nullableInner(s);
  if (inner) {
    const t = toClaudeSchema(inner);
    if (isNoneEnum(t)) return Object.assign({}, t, { enum: t.enum.concat([NONE_ENUM]), description: '없으면 "none"' });
    if (t.type === 'string' && !t.enum) return Object.assign({}, t, { description: '없으면 빈 문자열 ""' });
    if (t.type === 'integer') return Object.assign({}, t, { description: '없으면 -1' });
    if (t.type === 'boolean') return { type: 'string', enum: ['true', 'false', NONE_ENUM], description: '없으면 "none"' };
    return Object.assign({}, s, { anyOf: [t, { type: 'null' }] });
  }
  const out = Object.assign({}, s);
  if (s.properties) {
    out.properties = {};
    Object.keys(s.properties).forEach((k) => { out.properties[k] = toClaudeSchema(s.properties[k]); });
  }
  if (s.items) out.items = toClaudeSchema(s.items);
  return out;
}
// 원래 스키마(s)를 따라가며 Claude 응답(v)의 '값 없음' 표시를 null 로 되돌린다
function fromClaude(s, v) {
  if (!s || typeof s !== 'object') return v;
  const inner = nullableInner(s);
  if (inner) {
    if (v == null) return null;
    if (isNoneEnum(inner)) return v === NONE_ENUM ? null : v;
    if (inner.type === 'string' && !inner.enum) return v === '' ? null : v;
    if (inner.type === 'integer') return v === -1 ? null : v;
    if (inner.type === 'boolean') return v === 'true' ? true : v === 'false' ? false : v === NONE_ENUM ? null : v;
    return fromClaude(inner, v);
  }
  if (s.properties && v && typeof v === 'object' && !Array.isArray(v)) {
    const out = Object.assign({}, v);
    Object.keys(s.properties).forEach((k) => { if (k in out) out[k] = fromClaude(s.properties[k], out[k]); });
    return out;
  }
  if (s.items && Array.isArray(v)) return v.map((x) => fromClaude(s.items, x));
  return v;
}
const claudeSchemas = new WeakMap();        // 요청마다 같은 바이트가 가도록 한 번만 바꾼다
function claudeSchemaFor(schema) {
  if (!claudeSchemas.has(schema)) claudeSchemas.set(schema, toClaudeSchema(schema));
  return claudeSchemas.get(schema);
}

// ------------------------------------------------------------------ Claude
let claudeClient = null;
// 요청마다 시간 제한·재시도를 준다 — (재시도 + 1) × 시간 제한이 전체 마감(DEADLINE_MS) 안에 들게.
// SDK 기본(2번 재시도 × 120초)이면 끊긴 연결은 마감까지 4분을 다 기다리고, 한도 초과(429)는 retry-after 만큼 두 번 기다린다.
const CLAUDE_TIMEOUT_MS = 100 * 1000;
const CLAUDE_MAX_RETRIES = 1;                 // 429·5xx·연결 오류는 SDK 가 한 번만 더
function claudeRequestOptions(signal) {
  return Object.assign({ timeout: CLAUDE_TIMEOUT_MS, maxRetries: CLAUDE_MAX_RETRIES }, signal ? { signal } : {});
}
// AI 요청도 Google 캘린더처럼 Electron net.fetch 로 보낸다 — 시스템 프록시·OS 인증서 저장소를 따른다 (회사 PC 대응).
// 넣어 주지 않으면(테스트·명령줄) SDK 기본 fetch.
let aiFetch = null;
function setFetch(fn) { aiFetch = typeof fn === 'function' ? fn : null; geminiClient = null; claudeClient = null; }
function claude() {
  if (!claudeClient) {
    const Anthropic = require('@anthropic-ai/sdk');
    claudeClient = new Anthropic(Object.assign({
      apiKey: anthropicKey(),
      maxRetries: CLAUDE_MAX_RETRIES,
      timeout: CLAUDE_TIMEOUT_MS
    }, aiFetch ? { fetch: aiFetch } : {}));
  }
  return claudeClient;
}

// 화면에 보이는 message 는 짧은 한국어 문구만. 제공자 원문(가린 것)은 detail 에 — 설정 '고급'·실행 기록에서만 본다.
const MSG = {
  billing: '결제·크레딧을 확인해 주세요. AI 계정의 사용 가능 금액이 부족해요.',
  model: 'AI 모델을 찾지 못했어요. 앱을 업데이트해 주세요.',
  timeout: 'AI 응답이 너무 오래 걸려 멈췄어요. 잠시 뒤 다시 시도해 주세요.',
  portal: 'AI 서버 대신 다른 응답이 왔어요. 인터넷 연결(와이파이 로그인 화면 등)을 확인해 주세요.'
};
const BILLING_RE = /credit balance|billing|prepa(?:y|id)/i;
function isTimeoutError(e) { return !!e && (e.name === 'APIConnectionTimeoutError' || /timed? ?out/i.test(e.message || '')); }
// 연결 오류의 속 원인 코드(ENOTFOUND, UNABLE_TO_VERIFY_LEAF_SIGNATURE 등) — '고급' 에서 프록시·인증서 문제를 알아볼 수 있게
function causeCode(e) {
  for (let c = e && e.cause, i = 0; c && i < 4; c = c.cause, i++) { if (c.code) return String(c.code); }
  return '';
}
function withCause(detail, e) {
  const c = causeCode(e);
  return c && detail.indexOf(c) < 0 ? detail + ' (' + c + ')' : detail;
}

function classifyClaude(e) {
  const Anthropic = require('@anthropic-ai/sdk');
  const d = { detail: redact(withCause(e && e.message ? e.message : String(e), e)) };
  const err = (type, message, retryable) => Object.assign({ type, message, retryable }, d);
  if (e instanceof Anthropic.AuthenticationError) return err('auth', 'Claude API 키가 올바르지 않아요. ANTHROPIC_API_KEY 를 확인해 주세요.', false);
  if (e instanceof Anthropic.APIError && (e.status === 402 || (e.status === 400 && BILLING_RE.test(e.message || '')))) return err('billing', MSG.billing, false);
  if (e instanceof Anthropic.PermissionDeniedError) return err('permission', '이 API 키로는 요청할 권한이 없어요.', false);
  if (e instanceof Anthropic.RateLimitError) return err('rate_limit', '요청이 많아 잠시 제한됐어요. 조금 뒤 다시 시도해 주세요.', true);
  if (e instanceof Anthropic.NotFoundError) return err('model_not_found', MSG.model, false);
  if (e instanceof Anthropic.BadRequestError) return err('bad_request', 'AI가 이 요청을 받지 않았어요. 잠시 뒤 다시 시도해 주세요.', false);
  if (e instanceof Anthropic.APIConnectionTimeoutError) return err('timeout', MSG.timeout, true);
  if (e instanceof Anthropic.APIConnectionError) return err('network', 'AI 서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.', true);
  if (e instanceof Anthropic.APIError && e.status >= 500) return err('server', 'AI 서버에 문제가 있어요. 잠시 뒤 다시 시도해 주세요.', true);
  if (e instanceof Anthropic.APIError) return err('api', 'AI 요청이 실패했어요(' + e.status + '). 잠시 뒤 다시 시도해 주세요.', false);
  return err('unknown', 'AI 처리 중 알 수 없는 오류가 났어요. 잠시 뒤 다시 시도해 주세요.', true);
}

async function callClaude(input, signal) {
  const def = requestDef(input);
  const res = await claude().beta.messages.create({
    model: MODELS.claude,
    max_tokens: 16000,
    // 거절 응답 시 서버가 권장 모델로 다시 시도한다
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    // 정리·추출은 깊은 추론보다 정확한 읽기 — 낮은 effort
    // 스키마는 Claude 용으로 바꾼 것(합집합 칸 없음) — 위 toClaudeSchema 참고
    output_config: { effort: 'low', format: { type: 'json_schema', schema: claudeSchemaFor(def.SCHEMA) } },
    // 고정된 지침은 캐시한다 (메모마다 바뀌는 내용은 뒤쪽 user 메시지에만). '값 없음' 안내는 공통 지침 뒤 별도 블록.
    system: [{ type: 'text', text: def.SYSTEM, cache_control: { type: 'ephemeral' } }, { type: 'text', text: CLAUDE_NONE_NOTE }],
    messages: [{ role: 'user', content: def.userText(input) }]
  }, claudeRequestOptions(signal));
  // 와이파이 로그인 화면 같은 엉뚱한 응답은 본문이 없다 — 연결 문제로 다룬다
  if (!res || !Array.isArray(res.content)) {
    return { ok: false, error: { type: 'network', message: MSG.portal, retryable: true, detail: redact(String(res).slice(0, 200)) } };
  }
  if (res.stop_reason === 'refusal') {
    return { ok: false, error: { type: 'refusal', message: '이 메모는 AI가 처리하지 않았어요.', retryable: false, detail: res.stop_details && res.stop_details.explanation ? redact(String(res.stop_details.explanation).slice(0, 200)) : undefined } };
  }
  if (res.stop_reason === 'max_tokens') {
    return { ok: false, error: { type: 'truncated', message: '메모가 길어 결과가 중간에 끊겼어요.', retryable: true } };
  }
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return parseOutput(text, 'claude', res.model, res.usage, def.SCHEMA);
}

// ------------------------------------------------------------------ Gemini
let geminiClient = null;
function gemini() {
  if (!geminiClient) {
    const { GoogleGenAI } = require('@google/genai');
    geminiClient = new GoogleGenAI({ apiKey: geminiKey(), httpOptions: Object.assign({ timeout: 120 * 1000 }, aiFetch ? { fetch: aiFetch } : {}) });
  }
  return geminiClient;
}

// 키를 어디서 고치면 되는지 — 설정에 저장한 키면 설정, 아니면 환경변수 이름
function geminiKeyHint() { return keySource() === 'saved' || !keySource() ? '설정에서 키를 확인해 주세요.' : 'GEMINI_API_KEY 를 확인해 주세요.'; }

// Gemini(interactions) 는 오류 본문을 배열로 준다: [{"error":{"code":400,"message":"API key not valid…","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}]
// SDK 는 이 모양을 못 읽어 message 가 '400 API error occurred: {"httpMeta":…}' 뿐이고, 원문은 e.body(문자열)에만 있다.
// 던지지 않는다 — 못 읽으면 빈 값.
function geminiErrorInfo(e) {
  const out = { text: '', status: '', reasons: [] };
  if (!e) return out;
  [e.body, e.error].some((src) => {
    let o = src;
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch (x) { return false; } }
    if (Array.isArray(o)) o = o[0];
    const er = o && typeof o === 'object' && o.error && typeof o.error === 'object' ? o.error : null;
    if (!er) return false;
    out.text = typeof er.message === 'string' ? er.message : '';
    out.status = typeof er.status === 'string' ? er.status : '';
    (Array.isArray(er.details) ? er.details : []).forEach((x) => {
      if (x && typeof x.reason === 'string') out.reasons.push(x.reason);
      if (x && x.errorInfo && typeof x.errorInfo.reason === 'string') out.reasons.push(x.errorInfo.reason);
    });
    return !!(out.text || out.status || out.reasons.length);
  });
  return out;
}

function classifyGemini(e) {
  const status = e && typeof e.status === 'number' ? e.status : null;
  const info = geminiErrorInfo(e);
  // 규칙은 SDK message 와 본문 원문(메시지·상태·사유) 모두에 맞춰 본다
  const msg = [(e && e.message) || '', info.text, info.status].concat(info.reasons).join(' ');
  // 고급·실행 기록에는 제공자 원문을 (본문을 못 읽었으면 예전처럼 SDK message)
  const raw = info.text ? (status ? status + ' ' : '') + (info.status ? info.status + ': ' : '') + info.text
    : withCause(e && e.message ? e.message : String(e), e);
  const d = { detail: redact(raw) };
  const err = (type, message, retryable) => Object.assign({ type, message, retryable }, d);
  if (status === 402 || ((status === 400 || status === 403) && BILLING_RE.test(msg))) return err('billing', MSG.billing, false);
  if (status === 401 || status === 403) return err('auth', 'Gemini API 키가 올바르지 않거나 권한이 없어요. ' + geminiKeyHint(), false);
  if (status === 429) return err('rate_limit', 'Gemini 사용 한도에 걸렸어요(무료 등급은 분당·하루 요청 수가 정해져 있어요). 조금 뒤 다시 시도해 주세요.', true);
  // 키가 틀리면 Gemini 는 400 + API_KEY_INVALID 를 준다
  if (status === 400 && /API[_ ]?key|API_KEY_INVALID|API_KEY_EXPIRED/i.test(msg)) return err('auth', 'Gemini API 키가 올바르지 않아요. ' + geminiKeyHint(), false);
  if (status === 400 && /location is not supported|not (?:available|supported) in your (?:country|region)/i.test(msg)) return err('region', '지금 있는 지역에서는 Gemini API를 쓸 수 없어요.', false);
  if (status === 400) return err('bad_request', 'Gemini가 이 요청을 받지 않았어요. 잠시 뒤 다시 시도해 주세요.', false);
  if (status === 404) return err('model_not_found', MSG.model, false);
  if (status && status >= 500) return err('server', 'Gemini 서버에 문제가 있어요. 잠시 뒤 다시 시도해 주세요.', true);
  // 200 인데 JSON 이 아니면(와이파이 로그인 화면 등) 연결 문제 — 다시 시도할 수 있다
  if (status && status < 300) return err('network', MSG.portal, true);
  if (status) return err('api', 'Gemini 요청이 실패했어요(' + status + '). 잠시 뒤 다시 시도해 주세요.', false);
  if (isTimeoutError(e)) return err('timeout', MSG.timeout, true);
  if (isConnectError(e)) return err('network', 'Gemini 서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.', true);
  // 요청을 만들다 난 오류(키 글자 문제 등)는 연결 문제가 아니고, 다시 해도 똑같이 실패한다
  return err('unknown', 'Gemini 요청을 보내지 못했어요. 잠시 뒤 다시 시도해 주세요.', false);
}
// 실제로 연결이 안 된 경우만 — SDK 의 연결·중단 오류, 또는 fetch 실패·네트워크 오류 코드
const NET_CODES = ['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE'];
function isConnectError(e) {
  if (!e) return false;
  if (e.name === 'ConnectionError' || e.name === 'RequestTimeoutError' || e.name === 'RequestAbortedError') return true;
  const codes = [e.code, e.cause && e.cause.code, e.cause && e.cause.cause && e.cause.cause.code];
  if (codes.some((c) => NET_CODES.indexOf(c) >= 0)) return true;
  // Electron net.fetch 는 'net::ERR_NAME_NOT_RESOLVED' 같은 오류를 준다 (SDK 는 'Unexpected HTTP client error: Error: net::ERR_…' 로 감싼다)
  return /^Unable to make request\b|fetch failed|failed to fetch|net::ERR_/i.test(e.message || '');
}

// 요청마다 시간 제한·재시도를 직접 준다. interactions 는 클라이언트의 httpOptions.timeout 을 따르지 않고,
// SDK 기본값(모델마다 4번 더 재시도, 끊긴 연결은 약 5분씩 대기)이면 메모 하나에 몇십 분이 걸릴 수 있다.
// 재시도는 callGeminiTiered 의 '다른 모델로 한 번 더' 만 한다.
// 빠른 모델은 60초, 그 밖은 120초 (geminiTier)
const GEMINI_TIMEOUT_DEFAULT_MS = 120 * 1000;
// signal: 전체 마감에서 요청을 끊는 신호. SDK 는 signal 이 있으면 timeout 을 쓰지 않으니 모델별 시간 제한도 함께 묶는다.
function geminiRequestOptions(model, signal) {
  const timeout = geminiTier(model).timeout;
  const o = { timeout: timeout, maxRetries: 0 };
  if (signal && typeof AbortSignal === 'function' && typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function') {
    o.signal = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
  }
  return o;
}

async function callGemini(input, model, signal) {
  const def = requestDef(input);
  model = model || MODELS.gemini;
  const res = await gemini().interactions.create({
    model: model,
    system_instruction: def.SYSTEM,
    input: def.userText(input),
    // 정리·추출은 깊은 추론보다 정확한 읽기 — 낮은 thinking
    generation_config: { thinking_level: geminiTier(model).thinking },
    // Claude 와 같은 JSON 스키마로 구조를 고정한다
    response_format: { type: 'text', mime_type: 'application/json', schema: def.SCHEMA },
    // 요청·응답을 Google 쪽에 보관하지 않는다
    store: false
  }, geminiRequestOptions(model, signal));
  if (res.status && res.status !== 'completed') {
    const truncated = res.status === 'incomplete' || res.status === 'budget_exceeded';
    return { ok: false, provider: 'gemini', model: model, error: {
      type: truncated ? 'truncated' : 'failed',
      message: truncated ? '메모가 길어 결과가 중간에 끊겼어요.' : 'Gemini가 정리를 끝내지 못했어요.',
      retryable: true,
      detail: '상태: ' + res.status
    } };
  }
  const u = res.usage || {};
  return parseOutput(res.output_text || '', 'gemini', model, {
    input_tokens: u.total_input_tokens, output_tokens: u.total_output_tokens, thought_tokens: u.total_thought_tokens
  });
}

// 분류는 빠른 모델 먼저, 그 밖은 3.8 Flash 먼저. 일시 오류(또는 모델 없음 404)면 다른 모델로 한 번 더.
async function callGeminiTiered(input, signal) {
  const order = input && input.purpose === 'capture' ? [MODELS.geminiFast, MODELS.gemini] : [MODELS.gemini, MODELS.geminiFast];
  // 던지는 오류에는 그 오류를 낸 모델을 붙인다 (실행 기록에 실제로 부른 모델이 남게)
  try { return await callGemini(input, order[0], signal); }
  catch (e) {
    const c = classifyGemini(e);
    if (!c.retryable && e.status !== 404) throw Object.assign(e, { _classified: c, _model: order[0] });
    // 잠깐 끊긴 연결이면 바로 다시 해도 실패하니 조금 쉬었다가 (한도 초과는 다른 모델이라 짧게)
    await new Promise((r) => setTimeout(r, retryDelayMs != null ? retryDelayMs : c.type === 'rate_limit' ? 300 : 1200));
    // 그 사이 전체 마감이 지났으면 다른 모델로 다시 하지 않는다 (결과는 이미 '시간 초과' 로 알렸다)
    if (signal && signal.aborted) throw Object.assign(e, { _classified: c, _model: order[0] });
    try { return await callGemini(input, order[1], signal); }
    catch (e2) { throw Object.assign(e2, { _classified: classifyGemini(e2), _model: order[1] }); }
  }
}

async function organize(input) {
  const m = mode();
  if (!m) return { ok: false, error: { type: 'not_configured', message: status().reason, retryable: false } };
  const key = input && (input.noteId || input.requestId);
  if (!key) return { ok: false, error: { type: 'bad_input', message: '요청 정보가 없어요.', retryable: false } };
  // 같은 메모라도 종류가 다른 요청(입력 분류 · AI 정리)은 서로 막지 않는다. 같은 종류가 겹치면 잠시 뒤 다시 할 수 있다.
  const slot = (input.purpose || 'organize') + ':' + key;
  if (inflight.has(slot)) return { ok: false, error: { type: 'busy', message: '이 메모는 아직 정리하고 있어요. 잠시 뒤 다시 해 주세요.', retryable: true } };
  inflight.add(slot);
  let timer = null;
  try {
    if (m === 'fake') {
      await new Promise((r) => setTimeout(r, 600));
      const out = fake.organize(input);
      return Object.assign({ raw: out.output ? JSON.stringify(out.output) : null, attempts: 1 }, out);
    }
    // 마감이 먼저 오면 요청을 끊는다 — 사용자에게 실패를 알린 뒤에도 재시도·다른 모델 요청이 뒤에서 돌지 않게
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const signal = ctrl ? ctrl.signal : undefined;
    const call = m === 'gemini' ? () => callGeminiTiered(input, signal) : () => callClaude(input, signal);
    const work = (async () => {
      try {
        // JSON 을 못 읽은 경우만 한 번 더 요청한다
        let res = await call();
        let attempts = 1;
        if (!res.ok && res.error.type === 'invalid_json' && !(signal && signal.aborted)) { res = await call(); attempts = 2; }
        return Object.assign(res, { attempts });
      } catch (e) {
        return { ok: false, provider: m, model: m === 'gemini' ? (e && e._model) || null : MODELS.claude,
          error: e._classified || (m === 'gemini' ? classifyGemini(e) : classifyClaude(e)), attempts: 1 };
      }
    })();
    // 전체 마감 — 어떤 경우에도 화면이 '정리하는 중…' 에 머물지 않고, 같은 메모를 다시 시도할 수 있게 자리를 비운다
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        if (ctrl) ctrl.abort();
        resolve({ ok: false, error: { type: 'timeout', message: MSG.timeout, retryable: true }, attempts: 1 });
      }, deadlineMs);
    });
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    inflight.delete(slot);
  }
}

// 테스트용: 실제 네트워크 없이 클라이언트를 바꿔 끼운다
function _setClients(c) {
  if (c.gemini) geminiClient = c.gemini; if (c.claude) claudeClient = c.claude;
  if ('retryDelayMs' in c) retryDelayMs = c.retryDelayMs;
  if ('deadlineMs' in c) deadlineMs = c.deadlineMs == null ? DEADLINE_MS : c.deadlineMs;
}

module.exports = { status, organize, MODELS, DEADLINE_MS, setSavedKey, setFetch, captureEnvKeys, redact, _setClients,
  _claudeSchema: { toClaude: toClaudeSchema, fromClaude: fromClaude, NOTE: CLAUDE_NONE_NOTE } };
