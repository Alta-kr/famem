'use strict';

// 결과 채점 — 사례의 기대 답(expected_*)과 비교한다
//   node research/prompt-eval/score.js v0 v1 v2      → results/summary.json · results/cases.csv
//
// 사례마다 해당되는 검사만 센다:
//   분류      : entry_type · note_kind
//   항목 수   : 할 일 수 · 일정 수
//   날짜·시각 : 할 일 마감(due)·할 시각(do_at), 일정 시작, 명시한 길이
//   준비·크기 : prep_steps 개수, large 여부
//   기존 할 일: 완료 보고 · 날짜 변경 · 묶음 변경 · 앱 명령
// 제목은 글자가 달라도 같은 일로 본다 (낱자 겹침). 날짜·시각은 정확히 같아야 한다.

const fs = require('fs');
const path = require('path');
const cases = require('./csv')(fs.readFileSync(path.join(__dirname, 'cases.csv'), 'utf8'));
const byId = Object.fromEntries(cases.map((c) => [c.id, c]));
const PRICE = { input: 0.30, cached: 0.03, output: 2.50 };   // gemini-3.5-flash-lite, 100만 토큰당 USD

const ns = (s) => String(s || '').replace(/[\s·,.'"‘’“”()~\-]/g, '').toLowerCase();
function bigrams(s) { const o = []; for (let i = 0; i < s.length - 1; i++) o.push(s.slice(i, i + 2)); return o; }
function sim(a, b) {
  a = ns(a); b = ns(b);
  if (!a || !b) return 0;
  if (a === b || a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return 1;
  const x = bigrams(a), y = bigrams(b);
  if (!x.length || !y.length) return 0;
  let hit = 0; const pool = y.slice();
  x.forEach((g) => { const i = pool.indexOf(g); if (i !== -1) { hit++; pool.splice(i, 1); } });
  return 2 * hit / (x.length + y.length);
}
// 기대 항목마다 가장 비슷한 결과 항목 (한 번씩만)
//   제목이 달라도("등기 보내기"·"등기 발송") 개수가 같으면 남은 것끼리 적힌 순서대로 짝짓는다
function pair(exp, got, key) {
  const left = got.slice();
  const out = exp.map((e) => {
    let best = -1, bi = -1;
    left.forEach((g, i) => { const s = sim(e[key || 'title'], g[key || 'title']); if (s > best) { best = s; bi = i; } });
    if (bi === -1 || best < 0.34) return [e, null];
    return [e, left.splice(bi, 1)[0]];
  });
  if (exp.length === got.length) out.forEach((p) => { if (!p[1] && left.length) p[1] = left.shift(); });
  return out;
}
const w = (o) => o || { text: null, date: null, time: null };
const eqWhen = (a, b) => (w(a).date || null) === (w(b).date || null) && (w(a).time || null) === (w(b).time || null);
const arr = (x) => (Array.isArray(x) ? x : []);
const show = (o) => (o ? (o.date || '-') + (o.time ? ' ' + o.time : '') : '-');

function check(c, out0) {
  let out = out0;
  const exp = JSON.parse(c.expected_core_json);
  const intents = JSON.parse(c.expected_command_intents_json || '[]');
  const R = [];
  const add = (group, name, pass, detail) => R.push({ group, name, pass: !!pass, detail: detail || '' });
  if (!out) { add('응답', 'JSON', false, '응답 없음·형식 오류'); return R; }
  // 방금 것 정정: 같은 항목을 다시 적든(tasks/events) 날짜 변경(updated_tasks)으로 적든 앱은 둘 다 그 항목을 고친다 — 같은 답으로 본다
  if (/정정/.test(c.category) && !arr(out.tasks).length && !arr(out.events).length && arr(out.updated_tasks).length && arr(exp.tasks).length) {
    out = Object.assign({}, out, { tasks: arr(out.updated_tasks).map((u) => Object.assign({ size: 'small' }, u)), updated_tasks: [] });
  }
  add('분류', 'entry_type', out.entry_type === c.expected_entry_type, c.expected_entry_type + ' → ' + out.entry_type);
  add('분류', 'note_kind', out.note_kind === c.expected_note_kind, c.expected_note_kind + ' → ' + out.note_kind);
  const gt = arr(out.tasks), ge = arr(out.events);
  add('항목 수', '할 일 수', gt.length === arr(exp.tasks).length, arr(exp.tasks).length + ' → ' + gt.length + (gt.length ? ' [' + gt.map((t) => t.title).join(', ') + ']' : ''));
  add('항목 수', '일정 수', ge.length === arr(exp.events).length, arr(exp.events).length + ' → ' + ge.length + (ge.length ? ' [' + ge.map((t) => t.title).join(', ') + ']' : ''));
  pair(arr(exp.tasks), gt).forEach(([e, g]) => {
    if (!g) { add('항목 수', '할 일 찾기', false, '‘' + e.title + '’ 없음'); return; }
    add('날짜·시각', '할 일 마감', eqWhen(e.due, g.due), '‘' + e.title + '’ 마감 ' + show(e.due) + ' → ' + show(g.due));
    add('날짜·시각', '할 일 할 시각', eqWhen(e.do_at, g.do_at), '‘' + e.title + '’ 할 시각 ' + show(e.do_at) + ' → ' + show(g.do_at));
    if (arr(e.prep_steps).length) add('준비·크기', '준비 단계', arr(g.prep_steps).length === arr(e.prep_steps).length, '‘' + e.title + '’ 준비 ' + arr(e.prep_steps).length + ' → ' + arr(g.prep_steps).length);
    if (e.size === 'large') add('준비·크기', '큰 일', g.size === 'large', '‘' + e.title + '’ large → ' + g.size);
  });
  pair(arr(exp.events), ge).forEach(([e, g]) => {
    if (!g) { add('항목 수', '일정 찾기', false, '‘' + e.title + '’ 없음'); return; }
    add('날짜·시각', '일정 시작', eqWhen(e.start, g.start), '‘' + e.title + '’ ' + show(e.start) + ' → ' + show(g.start));
    if (e.duration_minutes) add('날짜·시각', '일정 길이', g.duration_minutes === e.duration_minutes, '‘' + e.title + '’ ' + e.duration_minutes + '분 → ' + g.duration_minutes);
  });
  const ed = arr(exp.done_tasks), gd = arr(out.done_tasks);
  if (ed.length || gd.length) add('기존 할 일', '완료 보고', ed.length === gd.length && pair(ed, gd).every(([, g]) => g), '[' + ed.map((x) => x.title).join(', ') + '] → [' + gd.map((x) => x.title).join(', ') + ']');
  const eu = arr(exp.updated_tasks), gu = arr(out.updated_tasks);
  if (eu.length || gu.length) {
    const ps = pair(eu, gu);
    add('기존 할 일', '날짜 변경', eu.length === gu.length && ps.every(([e, g]) => g && eqWhen(e.due, g.due) && eqWhen(e.do_at, g.do_at)),
      eu.map((e) => e.title + ' 마감 ' + show(e.due) + '/시각 ' + show(e.do_at)).join(', ') + ' → ' + gu.map((g) => g.title + ' 마감 ' + show(g.due) + '/시각 ' + show(g.do_at)).join(', '));
  }
  const eb = arr(exp.bulk_updates), gb = arr(out.bulk_updates);
  if (eb.length || gb.length) add('기존 할 일', '묶음 변경', eb.length === gb.length && eb.every((e, i) => gb[i] && gb[i].filter === e.filter && (gb[i].project_hint || null) === (e.project_hint || null) && eqWhen(e.due, gb[i].due) && eqWhen(e.do_at, gb[i].do_at)),
    eb.map((e) => e.filter + '/' + (e.project_hint || '-') + ' ' + show(e.due)).join(', ') + ' → ' + gb.map((e) => e.filter + '/' + (e.project_hint || '-') + ' ' + show(e.due)).join(', '));
  const gc = arr(out.commands).map((x) => x.action || x.type);
  if (intents.length || gc.length) add('기존 할 일', '앱 명령', intents.slice().sort().join(',') === gc.slice().sort().join(','), '[' + intents.join(', ') + '] → [' + gc.join(', ') + ']');
  return R;
}

function pct(a, b) { return b ? Math.round(a / b * 1000) / 10 : null; }
function quantile(xs, q) { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; }

const variants = process.argv.slice(2);
const summary = {}, rows = [];
for (const v of variants) {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', v + '.json'), 'utf8'));
  const groups = {}, names = {};
  let pass = 0, core = 0, n = 0;
  const tok = { input: 0, cached: 0, output: 0, thought: 0 }, ms = [];
  data.results.forEach((r) => {
    const c = byId[r.id];
    const R = check(c, r.output);
    n++;
    const allOk = R.every((x) => x.pass);
    const coreOk = R.filter((x) => x.name !== 'note_kind').every((x) => x.pass);
    if (allOk) pass++;
    if (coreOk) core++;
    R.forEach((x) => {
      (groups[x.group] = groups[x.group] || [0, 0])[1]++; if (x.pass) groups[x.group][0]++;
      (names[x.name] = names[x.name] || [0, 0])[1]++; if (x.pass) names[x.name][0]++;
    });
    if (r.usage) Object.keys(tok).forEach((k) => { tok[k] += r.usage[k] || 0; });
    if (r.ms) ms.push(r.ms);
    rows.push({ variant: v, id: r.id, category: c.category, memo: c.memo.replace(/\r?\n/g, ' / '), pass: allOk, core: coreOk,
      fails: R.filter((x) => !x.pass).map((x) => x.name + ': ' + x.detail).join(' | '), check_points: c.check_points,
      input: r.usage ? r.usage.input : '', cached: r.usage ? r.usage.cached : '', output: r.usage ? r.usage.output : '', ms: r.ms || '' });
  });
  const cost = ((tok.input - tok.cached) * PRICE.input + tok.cached * PRICE.cached + (tok.output + tok.thought) * PRICE.output) / 1e6;
  summary[v] = {
    model: data.model, cases: n, pass: pass, passRate: pct(pass, n), corePass: core, corePassRate: pct(core, n),
    groups: Object.fromEntries(Object.entries(groups).map(([k, [a, b]]) => [k, { pass: a, total: b, rate: pct(a, b) }])),
    checks: Object.fromEntries(Object.entries(names).map(([k, [a, b]]) => [k, { pass: a, total: b, rate: pct(a, b) }])),
    tokens: { input: tok.input, cached: tok.cached, output: tok.output, thought: tok.thought, perCase: { input: Math.round(tok.input / n), cached: Math.round(tok.cached / n), output: Math.round(tok.output / n) } },
    costUSD: { total: Math.round(cost * 1e5) / 1e5, perCase: Math.round(cost / n * 1e7) / 1e7, per1000: Math.round(cost / n * 1000 * 100) / 100 },
    latencyMs: { p50: quantile(ms, 0.5), p90: quantile(ms, 0.9), avg: Math.round(ms.reduce((a, b) => a + b, 0) / (ms.length || 1)) }
  };
}
fs.writeFileSync(path.join(__dirname, 'results', 'summary.json'), JSON.stringify(summary, null, 2));
const esc = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
const cols = ['variant', 'id', 'category', 'memo', 'pass', 'core', 'fails', 'check_points', 'input', 'cached', 'output', 'ms'];
fs.writeFileSync(path.join(__dirname, 'results', 'cases.csv'), '﻿' + cols.join(',') + '\r\n' + rows.map((r) => cols.map((k) => esc(r[k])).join(',')).join('\r\n'));
for (const v of variants) {
  const s = summary[v];
  console.log(v, '통과', s.pass + '/' + s.cases, '(note_kind 빼면 ' + s.corePass + ')', '| 입력', s.tokens.perCase.input, '캐시', s.tokens.perCase.cached, '출력', s.tokens.perCase.output, '| $/1000건', s.costUSD.per1000, '| p50', s.latencyMs.p50 + 'ms');
  console.log('   ', Object.entries(s.groups).map(([k, x]) => k + ' ' + x.rate + '%').join(' · '));
}
