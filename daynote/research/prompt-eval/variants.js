'use strict';

// 프롬프트 후보 — 같은 사례를 각 후보의 (시스템 지시 · 보낸 글 · 답 형식)으로 만든다
//   v0 : 지금 앱 (capture.v13) — 앱과 똑같이 C.buildInput · C.SYSTEM · C.userText · C.SCHEMA
//   v1 : Codex 압축안 — 압축한 시스템 지시 + 지금 답 형식 + 사례의 user_prompt 그대로
//   v2 : v1 + 앱이 계산한 달력 줄 + 분류 먼저·빈 칸 생략 가능한 가벼운 답 형식 (Argon4 제안 반영)

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const C = require(path.join(ROOT, 'src/core/ai/capture'));
const D = require(path.join(ROOT, 'src/core/dates'));

const WD = ['일', '월', '화', '수', '목', '금', '토'];
function refDate(c) { const m = c.reference_at.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/); return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]); }
function ymd(d) { return D.ymd(d); }
function json(s, dflt) { try { return JSON.parse(s); } catch (e) { return dflt; } }

// ---------------------------------------------------------------- v0 — 지금 앱
function recentFromLast(last) {
  if (!last) return [];
  return (last.events || []).map((e) => (e.title || '일정') + ' (일정, ' + e.start.date + (e.start.time ? ' ' + e.start.time : '') + ')')
    .concat((last.tasks || []).map((t) => t.title + ' (할 일' + (t.due && t.due.date ? ', 마감 ' + t.due.date + (t.due.time ? ' ' + t.due.time : '') : '') + (t.do_at && t.do_at.date ? ', ' + t.do_at.date + ' ' + t.do_at.time + '에 하기' : '') + ')'));
}
function v0(c) {
  const ref = refDate(c);
  const note = { id: 'case-' + c.id, title: '', body: c.memo, updatedAt: ref.toISOString() };
  const ws = json(c.workspace_task_json, null);
  const input = C.buildInput(note, {
    today: ymd(ref) + ' (' + WD[ref.getDay()] + ')', timezone: c.timezone,
    projects: json(c.projects_json, []), openTasks: json(c.existing_tasks_json, []).map((t) => t.title),
    focusTask: ws ? ws.title : null, recent: recentFromLast(json(c.last_result_json, null))
  });
  return { system: C.SYSTEM, user: C.userText(input), schema: C.SCHEMA };
}

// ---------------------------------------------------------------- v1 — Codex 압축안
const V1_SYSTEM = fs.readFileSync(path.join(__dirname, 'variants/v1-codex-system.txt'), 'utf8');
function v1(c) { return { system: V1_SYSTEM, user: c.user_prompt, schema: C.SCHEMA }; }

// ---------------------------------------------------------------- v2 — 달력 줄 + 가벼운 답 형식
const V2_SYSTEM = fs.readFileSync(path.join(__dirname, 'variants/v2-system.txt'), 'utf8');
// 앱이 계산한 달력 — "다음 주 월요일" 같은 셈을 모델이 하지 않게
function calendarLine(ref) {
  const day = (n) => { const d = D.addDays(D.startOfDay(ref), n); return ymd(d) + '(' + WD[d.getDay()] + ')'; };
  const mon = D.startOfWeek(ref);
  // 해가 바뀌는 날은 연도까지 (연말 경계)
  const wk = (off) => ['월', '화', '수', '목', '금', '토', '일'].map((w, i) => { const d = D.addDays(mon, off + i); return w + ' ' + (d.getFullYear() === ref.getFullYear() ? ymd(d).slice(5) : ymd(d)); }).join(' ');
  const nextMonth1 = new Date(ref.getFullYear(), ref.getMonth() + 1, 1);
  return '달력(앱 계산 — 날짜는 여기서 고르세요): 오늘 ' + day(0) + ' · 내일 ' + day(1) + ' · 모레 ' + day(2) + ' · 글피 ' + day(3) +
    ' / 이번 주 ' + wk(0) + ' / 다음 주 ' + wk(7) + ' / 다다음 주 ' + wk(14) + ' / 다음 달 1일 ' + ymd(nextMonth1) + ' (연도는 오늘 기준 ' + ref.getFullYear() + ')';
}
function v2User(c) {
  return c.user_prompt.replace(/(시간대: [^\n]*\n)/, '$1' + calendarLine(refDate(c)) + '\n');
}
// 답 형식: 분류 먼저, 빈 목록·요약은 빼도 되게 (required 를 줄인다), 순서를 바꾼다
function clone(o) { return JSON.parse(JSON.stringify(o)); }
const S0 = clone(C.SCHEMA);
function slim(item, keep) {
  const o = clone(item);
  o.required = keep.filter((k) => o.properties[k]);
  return o;
}
const P = S0.properties;
const V2_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    entry_type: P.entry_type, note_kind: P.note_kind, note_title: P.note_title, note_project_hint: P.note_project_hint,
    tasks: { type: 'array', items: slim(P.tasks.items, ['title', 'evidence', 'due', 'do_at', 'size', 'basis']) },
    events: { type: 'array', items: slim(P.events.items, ['title', 'evidence', 'start']) },
    done_tasks: P.done_tasks, updated_tasks: P.updated_tasks, bulk_updates: P.bulk_updates, commands: P.commands,
    open_questions: P.open_questions, summary: P.summary, sections: P.sections
  },
  required: ['entry_type', 'note_kind', 'note_title']
};
function v2(c) { return { system: V2_SYSTEM, user: v2User(c), schema: V2_SCHEMA }; }

// ---------------------------------------------------------------- v3 — v2 + 목록은 늘 [] (빼면 모델이 다른 칸에 넣는다) + 약한 규칙 보강
const V3_SYSTEM = fs.readFileSync(path.join(__dirname, 'variants/v3-system.txt'), 'utf8');
const V3_SCHEMA = clone(V2_SCHEMA);
V3_SCHEMA.required = ['entry_type', 'note_kind', 'note_title', 'note_project_hint', 'tasks', 'events', 'done_tasks', 'updated_tasks', 'bulk_updates', 'commands'];
function v3(c) { return { system: V3_SYSTEM, user: v2User(c), schema: V3_SCHEMA }; }

// ---------------------------------------------------------------- v4 — v3 + 일정·자료 링크·시간 구간·중복 규칙 보강 + 답 형식에서 일정을 할 일보다 먼저
const V4_SYSTEM = fs.readFileSync(path.join(__dirname, 'variants/v4-system.txt'), 'utf8');
const V4_SCHEMA = clone(V3_SCHEMA);
(function () {
  const p = V4_SCHEMA.properties, order = ['entry_type', 'note_kind', 'note_title', 'note_project_hint', 'events', 'tasks', 'done_tasks', 'updated_tasks', 'bulk_updates', 'commands', 'open_questions', 'summary', 'sections'];
  V4_SCHEMA.properties = Object.fromEntries(order.map((k) => [k, p[k]]));
})();
function v4(c) { return { system: V4_SYSTEM, user: v2User(c), schema: V4_SCHEMA }; }

// ---------------------------------------------------------------- v5 — v4 + 근거는 줄 번호만 (Argon4 제안 — 앱이 줄을 찾아 근거로 쓰게 바꿔야 함, 시험만)
const V5_SYSTEM = fs.readFileSync(path.join(__dirname, 'variants/v5-system.txt'), 'utf8');
const V5_SCHEMA = clone(V4_SCHEMA);
(function lineOnly(o) {
  if (!o || typeof o !== 'object') return;
  if (o.properties && o.properties.evidence) {
    o.properties.evidence = { type: 'object', additionalProperties: false, required: ['line'], properties: { line: { type: 'integer' } } };
  }
  Object.values(o.properties || {}).forEach(lineOnly);
  if (o.items) lineOnly(o.items);
})(V5_SCHEMA);
function v5(c) { return { system: V5_SYSTEM, user: v2User(c), schema: V5_SCHEMA }; }

// ---------------------------------------------------------------- v41 — Codex v4.1 (규칙 보강, 달력은 날마다 연도까지) + V4 답 형식
const V41_SYSTEM = fs.readFileSync(path.join(__dirname, 'variants/v41-system.txt'), 'utf8');
function calendarLine41(ref) {
  const f = (d) => ymd(d) + '(' + WD[d.getDay()] + ')';
  const day = (n) => f(D.addDays(D.startOfDay(ref), n));
  const mon = D.startOfWeek(ref);
  const wk = (off) => Array.from({ length: 7 }, (_, i) => f(D.addDays(mon, off + i))).join(' ');
  return '달력(앱 계산): 오늘 ' + day(0) + ' · 내일 ' + day(1) + ' · 모레 ' + day(2) + ' · 글피 ' + day(3) + ' / 이번 주 ' + wk(0) + ' / 다음 주 ' + wk(7) + ' / 다다음 주 ' + wk(14) +
    ' / 다음 달 1일 ' + f(new Date(ref.getFullYear(), ref.getMonth() + 1, 1));
}
function v41(c) { return { system: V41_SYSTEM, user: c.user_prompt.replace(/(시간대: [^\n]*\n)/, '$1' + calendarLine41(refDate(c)) + '\n'), schema: V4_SCHEMA }; }

// ---------------------------------------------------------------- v42 — v4 + v4.1 에서 효과 있던 규칙만 (지난 기록+일정=mixed · "좀 나중에" · 부정·인용 명령 · 요약 반복 금지)
const V42_SYSTEM = fs.readFileSync(path.join(__dirname, 'variants/v42-system.txt'), 'utf8');
function v42(c) { return { system: V42_SYSTEM, user: v2User(c), schema: V4_SCHEMA }; }

module.exports = { v42, v0, v1, v2, v3, v4, v5, v41, calendarLine, calendarLine41, V2_SCHEMA, V3_SCHEMA, V4_SCHEMA, V5_SCHEMA };
