'use strict';

// AI 답을 실제 앱 코드(검증 validate → 적용 applyCapture)에 넣어 최종 결과를 본다
//   node research/prompt-eval/app-check.js vF 041,087,...       (CASES=cases-regression.csv 로 회귀 사례)
//   지금 앱 검증은 summary·sections·open_questions 를 꼭 요구하므로 없으면 빈 값으로 채운다 (최종안을 앱에 넣을 때 할 일)

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const M = require(path.join(ROOT, 'src/core/model'));
const D = require(path.join(ROOT, 'src/core/dates'));
const V = require(path.join(ROOT, 'src/core/ai/validate'));
const P = require(path.join(ROOT, 'src/core/ai/proposals'));
const C = require(path.join(ROOT, 'src/core/ai/capture'));
const CMD = require(path.join(ROOT, 'src/core/ai/commands'));
const cases = require('./csv')(fs.readFileSync(path.join(__dirname, process.env.CASES || 'cases.csv'), 'utf8'));
const [variant, ids] = process.argv.slice(2);
const results = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', variant + '.json'), 'utf8')).results;

function refDate(c) { const m = c.reference_at.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/); return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]); }
const json = (s, d) => { try { return JSON.parse(s); } catch (e) { return d; } };

function run(c, out) {
  const now = refDate(c);
  const st = M.emptyState();
  json(c.projects_json, []).forEach((name) => M.addProject(st, { name }, now));
  // 이미 있는 할 일 — 마감이 지난 것도 있게 (묶음 수정 사례)
  json(c.existing_tasks_json, []).forEach((t) => {
    const x = M.addTask(st, { title: t.title, dueDate: t.due && t.due.date || null, dueTime: t.due && t.due.time || null }, D.addDays(now, -3));
    if (t.project) { const p = st.projects.find((pp) => pp.name === t.project); if (p) x.projectId = p.id; }
    if (t.state === 'in_progress') x.status = 'in_progress';
  });
  const note = M.addNote(st, { title: '', body: c.memo, capture: { status: 'pending', at: now.toISOString(), viaChat: true } }, now);
  note.updatedAt = now.toISOString();
  // 최종안 답 → 앱 형식 (빠진 칸은 빈 값, 줄 번호는 앱 기준(0번 줄=제목)으로 +1)
  const o = Object.assign({ summary: '', sections: [], open_questions: [], tasks: [], events: [], done_tasks: [], updated_tasks: [], bulk_updates: [], commands: [] }, JSON.parse(JSON.stringify(out)));
  ['tasks', 'events', 'done_tasks', 'updated_tasks', 'bulk_updates', 'commands'].forEach((k) => o[k].forEach((x) => {
    if (x.evidence && typeof x.evidence.line === 'number') x.evidence.line += 1;
    if (k === 'tasks') Object.assign(x, Object.assign({ project_hint: null, typical_minutes: null, prep_steps: [], breakdown: [] }, x));
    if (k === 'events') Object.assign(x, Object.assign({ duration_minutes: null, location: null, typical_minutes: null, basis: 'explicit' }, x));
    if (k === 'commands') Object.assign(x, Object.assign({ target: null, view: null, query: null, evidence: { quote: c.memo.split(/\r?\n/)[0], line: 1 } }, x));
  }));
  const v = V.validateOrganizeNote(o, { note, state: st, now });
  if (!v.ok) return { error: '검증 실패: ' + v.errors.join(', ') };
  const runRec = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: 'final' }, now);
  const cmds = CMD.resolve(st, note, o.commands, null);
  P.applyCapture(st, { note, run: runRec, validated: v, output: o, commands: cmds }, now);
  const hm = (iso) => D.ymd(iso) + ' ' + D.hm(iso);
  return {
    entryType: note.capture.entryType, memoKept: note.captureRole === 'memo' && !note.deletedAt, kept: note.capture.kept || undefined,
    tasks: M.liveTasks(st).filter((t) => t.sources.some((s) => s.refId === note.id)).map((t) => t.title + (t.dueDate ? ' 마감 ' + t.dueDate + (t.dueTime ? ' ' + t.dueTime : '') : '') + (t.steps.length ? ' 세부 ' + t.steps.length : '') +
      M.blocksForTask(st, t.id).map((b) => ' @' + hm(b.start)).join('')),
    events: st.blocks.filter((b) => !b.taskId).map((b) => (b.title || '') + ' ' + hm(b.start)),
    completed: (note.capture.completed || []).map((x) => (M.byId(st.tasks, x.id) || {}).title),
    updated: (note.capture.updated || []).map((u) => { const t = M.byId(st.tasks, u.id); return t ? t.title + ' → ' + (t.dueDate || '') + (t.dueTime ? ' ' + t.dueTime : '') : u.id; }),
    commands: cmds.length ? cmds.map((c) => c.action + (c.taskId ? ':' + (M.byId(st.tasks, c.taskId) || {}).title : '')) : undefined
  };
}

const want = ids ? ids.split(',') : results.map((r) => r.id);
want.forEach((id) => {
  const c = cases.find((x) => x.id === id), r = results.find((x) => x.id === id);
  if (!c || !r || !r.output) return;
  console.log(id, '|', c.memo.replace(/\r?\n/g, ' / '), '\n   ', JSON.stringify(run(c, r.output)));
});
