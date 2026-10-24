'use strict';

// 메모 3,000개 실측 — 앱이 실제로 쓰는 길(services/ai.organize: 빠른 모델 → 막히면 다른 모델, 답 길이 상한, 끊김 재시도 제한)로 AI 를 부르고
// 답을 results/raw.jsonl 에 한 줄씩 쌓는다 (중간에 끊겨도 이어서). 채점은 score.js.
//   node research/memo3000/run.js [--conc 8] [--limit N] [--ids 1,2,3]
// 키는 .env 에서만 읽고 출력하지 않는다. 시스템 환경 변수의 옛 키는 지운다.

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
delete process.env.GEMINI_API_KEY;
require(path.join(ROOT, 'services/keystore')).loadDotEnv(ROOT);
const ai = require(path.join(ROOT, 'services/ai'));
const C = require(path.join(ROOT, 'src/core/ai/capture'));
const H = require('./harness');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const CONC = +opt('--conc', 8);
const LIMIT = +opt('--limit', 0);
const IDS = opt('--ids', null);
const OUT = path.join(__dirname, 'results', 'raw.jsonl');
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const done = new Set();
if (fs.existsSync(OUT)) fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).forEach((l) => { try { const r = JSON.parse(l); if (r.ok || (r.error && r.error.retryable === false)) done.add(r.id); } catch (e) {} });

let rows = H.load();
if (IDS) { const w = new Set(IDS.split(',')); rows = rows.filter((r) => w.has(r.id)); }
rows = rows.filter((r) => !done.has(r.id));
if (LIMIT) rows = rows.slice(0, LIMIT);
console.log('보낼 사례', rows.length, '(이미 끝난 것', done.size + ')', '프롬프트', C.PROMPT_VERSION);

let i = 0, n = 0, fail = 0;
const t0 = Date.now();
async function worker() {
  while (i < rows.length) {
    const r = rows[i++];
    const { input } = H.setup(r);
    const s = Date.now();
    let res;
    try { res = await ai.organize(input); } catch (e) { res = { ok: false, error: { type: 'exception', message: String(e && e.message || e).replace(/AIza[0-9A-Za-z_-]+/g, '[키]'), retryable: true } }; }
    const rec = { id: r.id, ok: !!res.ok, ms: Date.now() - s, model: res.model || null, attempts: res.attempts, usage: res.usage || null, output: res.ok ? res.output : null, error: res.ok ? null : res.error };
    fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
    n++; if (!res.ok) fail++;
    if (n % 50 === 0) console.log(n + '/' + rows.length, '실패', fail, Math.round((Date.now() - t0) / 1000) + 's');
  }
}
Promise.all(Array.from({ length: CONC }, worker)).then(() => console.log('끝', n, '실패', fail, Math.round((Date.now() - t0) / 1000) + 's'));
