'use strict';

// 사례 100개를 후보 프롬프트로 실제 Gemini 에 보내 결과를 남긴다
//   node research/prompt-eval/run.js v0 v1 v2 [--model gemini-3.5-flash-lite] [--only 001,089] [--conc 5]
//   결과: results/<후보>.json — [{ id, ok, output, raw, usage, ms, error }]
//   키는 daynote/.env (화면·결과 파일에 남기지 않는다)

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
delete process.env.GEMINI_API_KEY;   // 옛 시스템 환경변수 말고 .env 의 키
require(path.join(ROOT, 'services/keystore')).loadDotEnv(ROOT);
const KEY = process.env.GEMINI_API_KEY;
const { GoogleGenAI } = require(path.join(ROOT, 'node_modules/@google/genai'));
const V = require('./variants');
const cases = require('./csv')(fs.readFileSync(path.join(__dirname, process.env.CASES || 'cases.csv'), 'utf8'));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const MODEL = opt('--model', 'gemini-3.5-flash-lite');
const CONC = +opt('--conc', 5);
const ONLY = opt('--only', null);
const variants = args.filter((a, i) => /^v\d/.test(a) && !/^--/.test(args[i - 1] || ''));
const THINKING = { 'gemini-3.8-flash': 'low', 'gemini-3.5-flash-lite': 'minimal' };
const client = new GoogleGenAI({ apiKey: KEY });
const red = (s) => String(s || '').split(KEY).join('[KEY]').replace(/AIza[0-9A-Za-z_-]{10,}/g, '[KEY]');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function once(p) {
  const t0 = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await client.interactions.create({
        model: MODEL, system_instruction: p.system, input: p.user,
        generation_config: { thinking_level: THINKING[MODEL] || 'low' },
        response_format: { type: 'text', mime_type: 'application/json', schema: p.schema },
        store: false
      }, { maxRetries: 0 });
      const raw = res.output_text || '';
      let output = null;
      try { output = JSON.parse(raw); } catch (e) {}
      const u = res.usage || {};
      return { ok: !!output, status: res.status, output, raw, ms: Date.now() - t0, attempts: attempt + 1,
        usage: { input: u.total_input_tokens || 0, cached: u.total_cached_tokens || 0, output: u.total_output_tokens || 0, thought: u.total_thought_tokens || 0 } };
    } catch (e) {
      if (attempt < 3 && (e.status === 429 || e.status >= 500 || !e.status)) { await sleep(2000 * (attempt + 1)); continue; }
      return { ok: false, error: { status: e.status || null, message: red(e.message).slice(0, 300) }, ms: Date.now() - t0, attempts: attempt + 1 };
    }
  }
}

(async () => {
  const list = ONLY ? cases.filter((c) => ONLY.split(',').indexOf(c.id) !== -1) : cases;
  for (const v of variants) {
    const out = new Array(list.length);
    let next = 0, done = 0;
    const t0 = Date.now();
    await Promise.all(Array.from({ length: CONC }, async () => {
      while (next < list.length) {
        const i = next++;
        const c = list[i];
        const r = await once(V[v](c));
        out[i] = Object.assign({ id: c.id }, r);
        done++;
        if (done % 10 === 0 || done === list.length) process.stdout.write(v + ' ' + done + '/' + list.length + '\n');
      }
    }));
    const TAG = opt('--tag', '');
    const file = path.join(__dirname, 'results', v + (MODEL !== 'gemini-3.5-flash-lite' ? '-' + MODEL : '') + (TAG ? '-' + TAG : '') + '.json');
    fs.writeFileSync(file, JSON.stringify({ variant: v, model: MODEL, at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), results: out }, null, 1));
    console.log(v, '→', path.relative(process.cwd(), file), '실패', out.filter((x) => !x.ok).length);
  }
})();
