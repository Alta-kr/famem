'use strict';

// 메모 3,000개 데이터셋 → 앱 상태·AI 입력 (run.js 와 score.js 가 같은 상태를 만든다)
//   context_snapshot "1: 제목 (due: 2026-10-23) | 2: 제목 (due: null) | workspace: 1" → 열린 할 일 두 개 + 작업 공간 할 일
//   projects_context "a|b|c" → 프로젝트

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const M = require(path.join(ROOT, 'src/core/model'));
const C = require(path.join(ROOT, 'src/core/ai/capture'));
const D = require(path.join(ROOT, 'src/core/dates'));
const csv = require(path.join(ROOT, 'research/prompt-eval/csv'));

function load() { return csv(fs.readFileSync(path.join(__dirname, 'dataset.csv'), 'utf8').replace(/^﻿/, '')); }

function refDate(r) {
  const [y, mo, d] = r.anchor_date.split('-').map(Number);
  const [h, mi] = (r.anchor_time || '09:00').split(':').map(Number);
  return new Date(y, mo - 1, d, h, mi);
}
function parseContext(s) {
  const tasks = [];
  let workspace = null;
  String(s || '').split('|').map((x) => x.trim()).forEach((part) => {
    const w = part.match(/^workspace:\s*(\S+)/);
    if (w) { workspace = /^\d+$/.test(w[1]) ? w[1] : null; return; }
    const m = part.match(/^(\d+):\s*(.*)\s*\(due:\s*([^)]*)\)\s*$/);
    if (m) tasks.push({ key: m[1], title: m[2].trim(), due: /^\d{4}-\d{2}-\d{2}$/.test(m[3].trim()) ? m[3].trim() : null });
  });
  return { tasks, workspace };
}

function setup(r) {
  const now = refDate(r);
  const st = M.emptyState();
  String(r.projects_context || '').split('|').map((x) => x.trim()).filter(Boolean).forEach((name) => M.addProject(st, { name }, D.addDays(now, -10)));
  const ctx = parseContext(r.context_snapshot);
  const byKey = {};
  ctx.tasks.forEach((t) => { byKey[t.key] = M.addTask(st, { title: t.title, dueDate: t.due }, D.addDays(now, -2)); });
  const focus = ctx.workspace ? byKey[ctx.workspace] || null : null;
  const note = M.addNote(st, { title: '', body: r.memo_raw, capture: { status: 'pending', at: now.toISOString(), viaChat: true } }, now);
  note.updatedAt = now.toISOString();
  const open = M.liveTasks(st).filter((t) => t.status !== 'done');
  const info = (t) => ({ title: t.title, dueDate: t.dueDate || null, dueTime: t.dueTime || null, state: null, project: null });
  const opts = {
    today: D.ymd(now) + ' (' + D.WEEKDAYS[now.getDay()] + ')', timezone: 'Asia/Seoul',
    projects: M.liveProjects(st).map((p) => p.name), openTasks: open.map((t) => t.title), openTaskInfo: open.map(info), recent: []
  };
  if (focus) { opts.focusTask = focus.title; opts.focusInfo = info(focus); }
  const input = C.buildInput(note, opts);
  input.noteId = 'n' + r.id;   // 같은 메모 글이 여러 사례에 있어도 따로 센다
  return { now, st, note, input, byKey, focus, ctx };
}

module.exports = { load, setup, refDate, parseContext };
