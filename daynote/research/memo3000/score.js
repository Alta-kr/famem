'use strict';

// 메모 3,000개 채점 — AI 답(results/raw.jsonl)을 실제 앱 코드에 넣어(검증 → 명령 확인 → 적용) 최종 결과로 본다.
//   앱 순서 그대로: 짧은 명령은 AI 없이 바로 알아듣는 것(matchLocal)이 먼저, 아니면 AI 답.
//   node research/memo3000/score.js  → results/score.json · results/fails.csv · 화면 요약

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const M = require(path.join(ROOT, 'src/core/model'));
const D = require(path.join(ROOT, 'src/core/dates'));
const V = require(path.join(ROOT, 'src/core/ai/validate'));
const P = require(path.join(ROOT, 'src/core/ai/proposals'));
const C = require(path.join(ROOT, 'src/core/ai/capture'));
const CMD = require(path.join(ROOT, 'src/core/ai/commands'));
const H = require('./harness');

const raw = {};
fs.readFileSync(path.join(__dirname, 'results', 'raw.jsonl'), 'utf8').split('\n').filter(Boolean).forEach((l) => { const r = JSON.parse(l); if (!raw[r.id] || r.ok) raw[r.id] = r; });
const rows = H.load();

const hm = (iso) => D.ymd(iso) + ' ' + D.hm(iso);
function quoted(r, ctx) {
  const m = r.memo_raw.match(/'([^']+)'/);
  if (!m) return null;
  return ctx.tasks.find((t) => t.title === m[1]) || null;
}

function outcome(r, rec) {
  const S = H.setup(r);
  const { st, note, now, byKey, focus } = S;
  const local = CMD.matchLocal(st, r.memo_raw, focus);
  if (local) return { S, path: 'local', cmds: [local], created: [], events: [], updated: [], completed: [], memoKept: false, entryType: 'command' };
  if (!rec || !rec.ok) return { S, path: 'ai', error: rec ? rec.error : { type: 'not_run' } };
  const out = rec.output;
  const v = V.validateOrganizeNote(out, { note, state: st, now });
  if (!v.ok) return { S, path: 'ai', error: { type: 'invalid', message: v.errors.slice(0, 3).join(', ') } };
  const cmds = CMD.resolve(st, note, out.commands, focus);
  const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, now);
  P.applyCapture(st, { note, run, validated: v, output: out, commands: cmds }, now);
  const ctxIds = new Set(Object.values(byKey).map((t) => t.id));
  const created = M.liveTasks(st).filter((t) => !ctxIds.has(t.id)).map((t) => {
    const w = M.blocksForTask(st, t.id).filter((b) => b.kind === 'work')[0];
    return { title: t.title, due: t.dueDate, dueTime: t.dueTime, plan: t.planDate || null, at: w ? hm(w.start) : null, mins: w ? Math.round((new Date(w.end) - new Date(w.start)) / 60000) : null, est: t.estimateMinutes };
  });
  const events = st.blocks.filter((b) => !b.taskId).map((b) => ({ title: b.title, at: hm(b.start), mins: Math.round((new Date(b.end) - new Date(b.start)) / 60000) }));
  const after = {};
  Object.keys(byKey).forEach((k) => {
    const t = M.byId(st.tasks, byKey[k].id);
    const w = t && M.blocksForTask(st, t.id).filter((b) => b.kind === 'work')[0];
    after[k] = t ? { due: t.dueDate, dueTime: t.dueTime, plan: t.planDate || null, at: w ? hm(w.start) : null, status: t.status, deleted: !!t.deletedAt } : { deleted: true };
  });
  return {
    S, path: 'ai', out, cmds, created, events, after,
    updated: note.capture.updated || [], completed: (note.capture.completed || []).map((c) => c.id),
    memoKept: note.captureRole === 'memo' && !note.deletedAt, kept: note.capture.kept || null, entryType: note.capture.entryType
  };
}

// ---------------------------------------------------------------- 사례별 판정 → [통과?, 까닭]
function judge(r, o) {
  if (o.error) return [false, '오류: ' + o.error.type];
  const S = o.S, ctx = S.ctx, key = (t) => t && Object.keys(S.byKey).find((k) => S.byKey[k].title === t.title);
  const it = r.intent_type, slot = r.expected_slot_action;
  const eDue = r.expected_due_date, eDueT = r.expected_due_time || null, eAt = r.expected_do_at_date ? r.expected_do_at_date + ' ' + r.expected_do_at_time : null;
  const newItems = o.created.length + o.events.length;
  function slotNew() {
    if (newItems === 0) return [false, '새 할 일 없음'];
    const t = o.created[0], ev = o.events[0];
    if (slot === 'none') return t && !t.due && !t.at && !ev ? [true] : [false, '날짜 생김 ' + JSON.stringify(t || ev)];
    if (slot === 'due') {
      if (t && t.due === eDue && (t.dueTime || null) === eDueT) return [true];
      if (t && !eDueT && t.plan === eDue) return [true, '할 날로'];
      // 밤 9시에 "15:00까지" — 데이터는 오늘(이미 지남), 앱은 내일로 읽는다 (정책 차이로 따로 센다)
      if (t && eDueT && t.dueTime === eDueT && r.anchor_time > eDueT && t.due === D.ymd(D.addDays(D.parseYmd(eDue), 1))) return [true, '지난 시각 → 내일'];
      return [false, '마감 다름 ' + JSON.stringify(t || ev) + ' 기대 ' + eDue + ' ' + (eDueT || '')];
    }
    if (slot === 'do_at') {
      const at = (t && t.at) || (ev && ev.at);
      if (at === eAt) {
        const dm = +r.expected_duration_minutes;
        const mins = t && t.at ? t.mins : ev && ev.mins;
        if (dm && mins !== dm) return [false, '길이 다름 ' + mins + ' 기대 ' + dm];
        return [true, ev && !(t && t.at) ? '일정으로' : undefined];
      }
      if (t && t.due === r.expected_do_at_date && t.dueTime === r.expected_do_at_time) return [true, '마감 시각으로'];
      return [false, '할 시각 다름 ' + JSON.stringify(t || ev) + ' 기대 ' + eAt];
    }
    return [false, '?'];
  }
  if (it === 'note_pure_log') {
    if (newItems || o.updated.length || o.completed.length) return [false, '기록인데 할 일·변경 생김 ' + JSON.stringify(o.created.concat(o.events))];
    if (o.cmds && o.cmds.length) return [false, '기록인데 명령 ' + JSON.stringify(o.cmds)];
    return o.memoKept ? [true] : [false, '메모 안 남음'];
  }
  if (/^task_/.test(it)) {
    if (it === 'task_explicit_duration' && slot === 'none') {
      if (!newItems) return [false, '새 할 일 없음'];
      const t = o.created[0];
      return t ? [true, t.est === +r.expected_duration_minutes ? '길이 기록' : '길이 미기록'] : [false, '일정으로 ' + JSON.stringify(o.events[0])];
    }
    const res = slotNew();
    if (res[0] && newItems > 1) return [false, '할 일이 여러 개로 ' + newItems];
    return res;
  }
  if (it === 'mixed_note_and_task') { const res = slotNew(); if (!res[0]) return res; return o.memoKept ? res : [false, '기록 문장 메모 안 남음']; }
  if (it === 'mixed_done_and_new_task') {
    const q = quoted(r, ctx), k = key(q);
    if (!k || !o.completed.includes(S.byKey[k].id)) return [false, '완료 안 됨'];
    return slotNew();
  }
  // 기존 할 일 바꾸기
  if (/^update_slot|^mixed_multi/.test(it)) {
    const q = quoted(r, ctx) || (S.focus && { title: S.focus.title });
    const k = key(q), a = k && o.after[k];
    if (!a) return [false, '대상 못 찾음'];
    const others = Object.keys(o.after).filter((x) => x !== k && (o.after[x].due !== (ctx.tasks.find((t) => t.key === x) || {}).due || o.after[x].at));
    if (others.length) return [false, '다른 할 일이 바뀜'];
    if (newItems) return [false, '새 할 일이 생김 ' + JSON.stringify(o.created.concat(o.events)[0])];
    let res;
    if (slot === 'clear') res = a.due === null ? [true] : [false, '마감 안 지움 ' + a.due];
    else if (slot === 'pending') {
      const before = ctx.tasks.find((t) => t.key === k).due;
      res = before ? [false, '?'] : a.due ? [true, '앱 계산(오늘 기준) ' + a.due] : [true, '그대로'];
    } else if (slot === 'due') res = a.due === eDue && (a.dueTime || null) === eDueT ? [true] : a.plan === eDue ? [true, '할 날로'] : [false, '마감 다름 ' + a.due + ' ' + (a.dueTime || '') + ' 기대 ' + eDue];
    else if (slot === 'do_at') res = a.at === eAt ? [true] : (a.due === r.expected_do_at_date && a.dueTime === r.expected_do_at_time) ? [true, '마감 시각으로'] : [false, '할 시각 다름 ' + JSON.stringify(a) + ' 기대 ' + eAt];
    if (it === 'mixed_multi_actions' && res[0]) {
      const want = r.expected_command_or_bulk.split(':');
      if (!(o.cmds || []).some((c) => c.action === want[0] && (!want[1] || c.view === want[1]))) return [false, '명령 빠짐 ' + r.expected_command_or_bulk];
    }
    return res;
  }
  if (/^command_/.test(it) || it === 'bulk_update_overdue_or_proj') {
    const exp = r.expected_command_or_bulk;
    const cm = o.cmds || [];
    if (it === 'bulk_update_overdue_or_proj') {
      const mm = exp.match(/^bulk:([a-z_]+):project=(.+)$/);
      const b = ((o.out && o.out.bulk_updates) || [])[0];
      if (!b) return [false, '묶음 변경 없음 ' + JSON.stringify(o.updated.length ? 'updated ' + o.updated.length : o.created.concat(o.events)[0] || '')];
      if (b.filter !== mm[1]) return [false, '조건 다름 ' + b.filter + ' 기대 ' + mm[1]];
      if (b.project_hint !== mm[2]) return [false, '프로젝트 다름 ' + b.project_hint];
      const d = b.due && b.due.date;
      return d === eDue ? [true] : [false, '날짜 다름 ' + d + ' 기대 ' + eDue];
    }
    if (newItems) return [false, '명령인데 할 일 생김 ' + JSON.stringify(o.created.concat(o.events)[0])];
    const [act, arg] = exp.split(':');
    const c = cm.find((x) => x.action === act);
    if (!c) return [false, '명령 다름 ' + JSON.stringify(cm.map((x) => x.action)) + ' 기대 ' + exp];
    if (act === 'delete') {
      const want = /workspace/.test(arg) ? S.focus : S.byKey[(arg.match(/\d+/) || [])[0]];
      return c.taskId === (want && want.id) ? [true] : [false, '삭제 대상 다름'];
    }
    if (act === 'open') return c.view === arg ? [true] : [false, '화면 다름 ' + c.view];
    if (act === 'search') return c.query && c.query.replace(/\s/g, '').indexOf(arg.replace(/\s/g, '')) !== -1 ? [true] : [false, '찾을 말 다름 ' + c.query];
    if (/^(start|pause|breakdown)$/.test(act)) { const q = quoted(r, ctx), k = key(q); return !q || c.taskId === S.byKey[k].id ? [true] : [false, '대상 다름']; }
    return [true];
  }
  return [false, '알 수 없는 유형'];
}

const per = {}, fails = [], cost = { in: 0, cached: 0, out: 0, n: 0, ms: [] }, models = {};
const flags = { keptMemo: 0, confirmCmds: 0, localPath: 0 };
rows.forEach((r) => {
  const rec = raw[r.id];
  const o = outcome(r, rec);
  const [ok, why] = judge(r, o);
  const g = per[r.intent_type] = per[r.intent_type] || { n: 0, ok: 0, notes: {} };
  g.n++; if (ok) g.ok++;
  if (why) g.notes[(ok ? '✓ ' : '✗ ') + why.replace(/ \{.*$| 기대.*$|\d{4}-\d\d-\d\d.*$/, '')] = (g.notes[(ok ? '✓ ' : '✗ ') + why.replace(/ \{.*$| 기대.*$|\d{4}-\d\d-\d\d.*$/, '')] || 0) + 1;
  if (!ok) fails.push({ id: r.id, intent: r.intent_type, style: r.writing_style, why, memo: r.memo_raw.replace(/\n/g, ' / '), out: o.out ? JSON.stringify({ e: o.out.entry_type, t: o.out.tasks.map((x) => [x.title, x.due && x.due.date, x.due && x.due.time, x.do_at && x.do_at.date, x.do_at && x.do_at.time]), ev: (o.out.events || []).map((x) => [x.title, x.start]), u: o.out.updated_tasks.map((x) => [x.title, x.due && x.due.date, x.due && x.due.time, x.do_at && x.do_at.date, x.do_at && x.do_at.time]), c: o.out.commands.map((x) => x.action + ':' + (x.target || x.view || x.query || '')), b: o.out.bulk_updates.map((x) => x.filter + ':' + x.project_hint) }) : '' });
  if (o.path === 'local') flags.localPath++;
  if (o.kept) flags.keptMemo++;
  if ((o.cmds || []).some((c) => /^(complete|delete|return_todo|start|pause|schedule)$/.test(c.action) && c.taskId && o.path === 'ai')) flags.confirmCmds++;
  if (rec && rec.usage) { cost.in += rec.usage.input_tokens || 0; cost.out += (rec.usage.output_tokens || 0) + (rec.usage.thought_tokens || 0); cost.n++; }
  if (rec && rec.ok) { cost.ms.push(rec.ms); models[rec.model] = (models[rec.model] || 0) + 1; }
});
const total = Object.values(per).reduce((a, g) => ({ n: a.n + g.n, ok: a.ok + g.ok }), { n: 0, ok: 0 });
cost.ms.sort((a, b) => a - b);
const pct = (q) => cost.ms[Math.floor(cost.ms.length * q)] || 0;
const usd = cost.in / 1e6 * 0.30 + cost.out / 1e6 * 2.5;   // 3.5 Flash-Lite 기준 (캐시 할인 전 상한)
const summary = { prompt: C.PROMPT_VERSION, total, rate: +(total.ok / total.n * 100).toFixed(1), per, flags, models,
  latency: { p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), max: cost.ms[cost.ms.length - 1] }, tokens: { in: cost.in, out: cost.out, n: cost.n }, usdUpperBound: +usd.toFixed(2) };
fs.writeFileSync(path.join(__dirname, 'results', 'score.json'), JSON.stringify(summary, null, 1));
const esc = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
fs.writeFileSync(path.join(__dirname, 'results', 'fails.csv'), '﻿id,intent,style,why,memo,ai\n' + fails.map((f) => [f.id, f.intent, f.style, f.why, f.memo, f.out].map(esc).join(',')).join('\n'));
console.log('통과', total.ok + '/' + total.n, summary.rate + '%', '| 프롬프트', C.PROMPT_VERSION);
Object.keys(per).forEach((k) => console.log(' ', k.padEnd(30), per[k].ok + '/' + per[k].n, JSON.stringify(per[k].notes)));
console.log('메모 지킴', flags.keptMemo, '| 확인 카드 명령', flags.confirmCmds, '| AI 없이 알아들음', flags.localPath, '| 모델', JSON.stringify(models), '| 지연', JSON.stringify(summary.latency), '| 비용 상한 $' + summary.usdUpperBound);
