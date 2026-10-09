'use strict';

// Daynote 데이터 모델과 상태 변경 규칙.
//
// 모든 함수는 순수한 자바스크립트 객체만 다룬다 (화면·저장소·Electron 을 모른다).
// 같은 할 일은 어디서 보든 tasks 배열의 같은 객체 하나를 id 로 참조한다 — 화면별 사본은 없다.
//
//   Project       → 여러 Note, Task, HistoryEntry
//   Task          → 선택적 Project, 여러 SourceReference(sources)
//                   마감일(dueDate/dueTime) 과 실제 작업 시간(blocks) 은 별개다
//   ScheduledBlock→ Task 참조(kind:'work') 또는 독립 일정(kind:'event')
//   Suggestion    → 출처와 검토 상태, 수락하면 만들어진 Task 를 가리킨다
//   HistoryEntry  → 발생 시각, 유형, 자동/직접, 원본 참조
//   WeeklyReport  → 대상 주, 자동 초안(draft)과 사용자 편집본(body)을 따로 보관
//
// "지금 할 일 추천" 결과는 저장하지 않는다. recommend.js 가 매번 다시 계산하는 값이다.

(function (factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.model = api; }
})(function () {
  var SCHEMA_VERSION = 3;   // 2: AI 층(aiRuns·proposals·noteDigests) · 3: 홈 채팅(chat), 수동 순서(sortOrder), 단계 초안(breakdown)

  var TASK_STATUS = { todo: '할 일', in_progress: '진행 중', waiting: '대기', done: '완료' };
  var PRIORITY = { high: '높음', normal: '보통', low: '낮음' };
  var HISTORY_TYPES = {
    task_done: '완료', task_reopened: '완료 취소', decision: '결정', update: '업데이트',
    achievement: '성과', blocker: '장애물'
  };
  var MANUAL_HISTORY_TYPES = ['decision', 'update', 'achievement', 'blocker'];

  var seq = 0;
  function uid(prefix) {
    seq = (seq + 1) % 1679616;
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + seq.toString(36);
  }

  function iso(now) { return (now instanceof Date ? now : new Date(now || Date.now())).toISOString(); }

  function emptyState() {
    return {
      version: SCHEMA_VERSION,
      projects: [], notes: [], tasks: [], blocks: [], history: [],
      suggestions: [], emails: [], reports: [],
      // AI 결과 층 — 원본(notes·emails)과 확정 데이터(tasks·blocks…) 사이에 둔다
      aiRuns: [], proposals: [], noteDigests: [],
      // 홈 채팅 기록 (최근 것만 보관)
      chat: [],
      emailConnection: { status: 'disconnected', provider: null, lastSyncAt: null, error: null },
      quickDraft: { text: '', projectId: null },
      prefs: { sidebarCollapsed: false, reduceMotion: false },
      meta: { createdAt: iso(), sampleLoaded: false }
    };
  }

  // 저장된 파일을 읽을 때 빠진 필드를 채운다. 모르는 필드는 버리지 않는다.
  function normalize(raw) {
    var s = emptyState();
    if (!raw || typeof raw !== 'object') return s;
    Object.keys(s).forEach(function (k) {
      if (raw[k] === undefined) return;
      if (Array.isArray(s[k])) s[k] = Array.isArray(raw[k]) ? raw[k] : [];
      else if (s[k] && typeof s[k] === 'object') s[k] = Object.assign({}, s[k], raw[k]);
      else s[k] = raw[k];
    });
    s.version = SCHEMA_VERSION;
    s.tasks = s.tasks.map(normalizeTask);
    return s;
  }

  function normalizeTask(t) {
    return Object.assign({
      id: uid('task'), title: '', memo: '', projectId: null, status: 'todo', priority: null,
      dueDate: null, dueTime: null,
      // 남은 예상 소요 시간(분). null 은 "미정" — 0분과 다르다.
      estimateMinutes: null, estimateSource: null,      // 'user' | 'ai'
      blockedBy: [], waitingFor: '', snoozedUntil: null,
      steps: [], sources: [],
      origin: 'user', proposalId: null,   // 'user' 직접 입력 | 'ai_accepted' AI 초안을 사용자가 확정
      sortOrder: null,                    // 홈에서 끌어 놓아 정한 순서 (작을수록 위)
      breakdown: null,                    // AI 가 나눠 둔 단계 초안 { status: pending|later|accepted|dismissed, steps, ... }
      elaboratedAt: null,
      createdAt: iso(), updatedAt: iso(), startedAt: null, completedAt: null, deletedAt: null, archivedAt: null,
      sample: false
    }, t);
  }

  // ------------------------------------------------------------------ 조회
  function byId(list, id) {
    if (!id) return null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function liveTasks(state) { return state.tasks.filter(function (t) { return !t.deletedAt && !t.archivedAt; }); }
  function liveNotes(state) { return state.notes.filter(function (n) { return !n.deletedAt; }); }
  function liveProjects(state) { return state.projects.filter(function (p) { return !p.deletedAt; }); }

  function blocksForTask(state, taskId) {
    return state.blocks.filter(function (b) { return b.taskId === taskId; })
      .sort(function (a, b) { return a.start < b.start ? -1 : 1; });
  }

  // 다음(또는 진행 중인) 작업 시간 블록
  function nextBlockForTask(state, taskId, now) {
    var t = (now ? new Date(now) : new Date()).toISOString();
    var list = blocksForTask(state, taskId).filter(function (b) { return b.end > t; });
    return list[0] || null;
  }

  function tasksForNote(state, noteId) {
    return liveTasks(state).filter(function (t) {
      return t.sources.some(function (s) { return s.type === 'note' && s.refId === noteId; });
    });
  }

  // 선행 업무 중 아직 끝나지 않은 것 (삭제된 선행 업무는 막지 않는다)
  function unmetBlockers(state, task) {
    return (task.blockedBy || []).map(function (id) { return byId(state.tasks, id); })
      .filter(function (b) { return b && !b.deletedAt && b.status !== 'done'; });
  }

  function noteTitle(note) {
    if (!note) return '';
    if (note.title && note.title.trim()) return note.title.trim();
    var first = (note.body || '').split('\n').map(function (l) { return l.replace(/^#+\s*/, '').trim(); })
      .filter(Boolean)[0];
    return first ? first.slice(0, 60) : '제목 없는 메모';
  }

  // 원본 참조를 화면 문구로 푼다. 원본이 지워졌으면 조용히 옛 정보를 보여주지 않고 그렇다고 말한다.
  function resolveRef(state, ref) {
    var item = null, label = ref.label || '', missing = false, kind = ref.kind || ref.type;
    if (kind === 'task') { item = byId(state.tasks, ref.id || ref.refId); if (item) label = item.title; }
    else if (kind === 'note') { item = byId(state.notes, ref.id || ref.refId); if (item) label = noteTitle(item); }
    else if (kind === 'email') { item = byId(state.emails, ref.id || ref.refId); if (item) label = item.subject; }
    else if (kind === 'project') { item = byId(state.projects, ref.id || ref.refId); if (item) label = item.name; }
    if (!item || item.deletedAt) missing = true;
    return { kind: kind, id: ref.id || ref.refId, label: label, missing: missing, item: item };
  }

  // ------------------------------------------------------------------ 메모
  function addNote(state, fields, now) {
    var n = Object.assign({
      id: uid('note'), title: '', body: '', projectId: null,
      createdAt: iso(now), updatedAt: iso(now), deletedAt: null, sample: false
    }, fields);
    state.notes.unshift(n);
    return n;
  }

  function updateNote(state, id, patch, now) {
    var n = byId(state.notes, id);
    if (!n) return null;
    Object.assign(n, patch, { updatedAt: iso(now) });
    return n;
  }

  function deleteNote(state, id, now) {
    var n = byId(state.notes, id);
    if (n) n.deletedAt = iso(now);
    return n;
  }

  // ------------------------------------------------------------------ 프로젝트
  var PROJECT_COLORS = ['#4F46E5', '#0F766E', '#B45309', '#9D174D', '#1D4ED8', '#4D7C0F'];
  function addProject(state, fields, now) {
    var p = Object.assign({
      id: uid('proj'), name: '새 프로젝트', description: '',
      color: PROJECT_COLORS[state.projects.length % PROJECT_COLORS.length],
      createdAt: iso(now), deletedAt: null, sample: false
    }, fields);
    state.projects.push(p);
    return p;
  }

  // ------------------------------------------------------------------ 할 일
  function addTask(state, fields, now) {
    var t = normalizeTask(Object.assign({ id: uid('task'), createdAt: iso(now), updatedAt: iso(now) }, fields));
    if (t.estimateMinutes != null && !t.estimateSource) t.estimateSource = 'user';
    state.tasks.unshift(t);
    return t;
  }

  function updateTask(state, id, patch, now) {
    var t = byId(state.tasks, id);
    if (!t) return null;
    var p = Object.assign({}, patch);
    // 사용자가 소요 시간을 직접 고치면 더 이상 추정값이 아니다
    if ('estimateMinutes' in p && !('estimateSource' in p)) p.estimateSource = p.estimateMinutes == null ? null : 'user';
    Object.assign(t, p, { updatedAt: iso(now) });
    return t;
  }

  function historyFor(task, type, now, extra) {
    return Object.assign({
      id: uid('hist'), projectId: task.projectId || null, at: iso(now), type: type, origin: 'auto',
      title: task.title, body: '', refs: [{ kind: 'task', id: task.id, label: task.title }],
      revokedAt: null, editedAt: null
    }, extra || {});
  }

  // 완료 → 프로젝트 히스토리에 자동 기록. 반환한 historyId 는 되돌리기에 쓴다.
  function completeTask(state, id, now) {
    var t = byId(state.tasks, id);
    if (!t || t.status === 'done') return null;
    var prevStatus = t.status;
    t.status = 'done';
    t.completedAt = iso(now);
    t.updatedAt = iso(now);
    t.snoozedUntil = null;
    var h = historyFor(t, 'task_done', now);
    state.history.push(h);
    return { task: t, historyId: h.id, prevStatus: prevStatus };
  }

  // 완료 취소.
  //  - 방금 한 완료를 되돌리는 경우(undoOf): 그 기록을 지운다 — 실수였으므로 이력에 남기지 않는다.
  //  - 나중에 다시 여는 경우: 과거 완료 기록은 그대로 두되 "취소됨" 으로 표시하고, 취소 기록을 새로 남긴다.
  function reopenTask(state, id, now, opts) {
    var t = byId(state.tasks, id);
    if (!t || t.status !== 'done') return null;
    opts = opts || {};
    t.status = opts.prevStatus && opts.prevStatus !== 'done' ? opts.prevStatus : 'todo';
    t.completedAt = null;
    t.updatedAt = iso(now);
    if (opts.undoOf) {
      state.history = state.history.filter(function (h) { return h.id !== opts.undoOf; });
      return t;
    }
    state.history.forEach(function (h) {
      if (h.type === 'task_done' && !h.revokedAt && h.refs.some(function (r) { return r.kind === 'task' && r.id === id; })) {
        h.revokedAt = iso(now);
      }
    });
    state.history.push(historyFor(t, 'task_reopened', now));
    return t;
  }

  // 지금 시작: 기존 Task 의 상태만 바꾼다. 복제·자동 완료·일정 변경은 하지 않는다.
  // 다른 업무가 진행 중이면 그 업무는 '할 일' 로 돌린다 (호출 전에 화면이 사용자에게 확인한다).
  function startTask(state, id, now) {
    var t = byId(state.tasks, id);
    if (!t || t.deletedAt || t.status === 'done') return null;
    var switched = [];
    state.tasks.forEach(function (o) {
      if (o.id !== id && o.status === 'in_progress' && !o.deletedAt) {
        o.status = 'todo';
        o.updatedAt = iso(now);
        switched.push(o.id);
      }
    });
    if (t.status !== 'in_progress') {
      t.status = 'in_progress';
      t.startedAt = t.startedAt || iso(now);
    }
    t.snoozedUntil = null;
    t.updatedAt = iso(now);
    return { task: t, switchedFrom: switched };
  }

  function snoozeTask(state, id, untilIso, now) {
    return updateTask(state, id, { snoozedUntil: untilIso }, now);
  }

  // 할 일 삭제는 보관 성격의 소프트 삭제다. 앞으로 잡힌 작업 블록만 지우고
  // 지나간 블록(실제로 일한 기록)은 남긴다. 히스토리는 "원본 삭제됨" 으로 보인다.
  function deleteTask(state, id, now) {
    var t = byId(state.tasks, id);
    if (!t) return null;
    t.deletedAt = iso(now);
    var nowIso = iso(now);
    state.blocks = state.blocks.filter(function (b) { return !(b.taskId === id && b.start > nowIso); });
    state.suggestions.forEach(function (s) { if (s.taskId === id) s.taskDeleted = true; });
    revealSources(state);
    return t;
  }

  // 적은 글이 할 일·일정만 남기고 숨은 경우(captureRole 'task_source'), 거기서 만든 것이 모두 지워지면
  // 원문이 어디에서도 안 보이게 된다 — 그럴 때는 다시 메모로 보이게 한다 (원문은 절대 잃지 않는다)
  function liveCreated(state, note) {
    return ((note.capture && note.capture.created) || []).filter(function (c) {
      var item = byId(c.kind === 'task' ? state.tasks : state.blocks, c.id);
      return item && !item.deletedAt;
    });
  }
  // 완료 보고("샤워 완료")로 끝낸 할 일 — 지워지지 않았으면 남은 것으로 센다
  function liveCompleted(state, note) {
    return ((note.capture && note.capture.completed) || []).filter(function (c) {
      var t = byId(state.tasks, c.id);
      return t && !t.deletedAt;
    });
  }
  // 날짜 바꾸기 보고("견적서는 내일 보낼게")로 고친 할 일
  function liveUpdated(state, note) {
    return ((note.capture && note.capture.updated) || []).filter(function (c) {
      var t = byId(state.tasks, c.id);
      return t && !t.deletedAt;
    });
  }
  // 이 글로 만든·끝낸·고친 것이 하나라도 남아 있나
  function captureHasResults(state, note) {
    return !!(liveCreated(state, note).length || liveCompleted(state, note).length || liveUpdated(state, note).length);
  }
  function revealSources(state) {
    if (state.__holdReveal) return;
    state.notes.forEach(function (n) {
      if (n.captureRole === 'task_source' && !n.deletedAt && !captureHasResults(state, n)) n.captureRole = 'memo';
    });
  }

  // ------------------------------------------------------------------ 일정 블록
  function addBlock(state, fields) {
    var b = Object.assign({ id: uid('blk'), kind: fields.taskId ? 'work' : 'event', taskId: null, title: '', start: null, end: null, origin: 'user', proposalId: null, sources: [], sample: false }, fields);
    state.blocks.push(b);
    return b;
  }
  function updateBlock(state, id, patch) {
    var b = byId(state.blocks, id);
    if (b) Object.assign(b, patch);
    return b;
  }
  // 블록 삭제는 할 일에 영향을 주지 않는다
  function deleteBlock(state, id) {
    var b = byId(state.blocks, id);
    state.blocks = state.blocks.filter(function (x) { return x.id !== id; });
    revealSources(state);
    return b;
  }

  // 주어진 구간과 겹치는 블록
  function conflictsFor(state, startIso, endIso, ignoreId) {
    return state.blocks.filter(function (b) {
      if (b.id === ignoreId) return false;
      if (b.taskId) { var t = byId(state.tasks, b.taskId); if (t && t.deletedAt) return false; }
      return b.start < endIso && b.end > startIso;
    });
  }

  // ------------------------------------------------------------------ 히스토리
  function addHistory(state, fields, now) {
    var h = Object.assign({
      id: uid('hist'), projectId: null, at: iso(now), type: 'update', origin: 'manual',
      title: '', body: '', refs: [], revokedAt: null, editedAt: null, sample: false
    }, fields);
    state.history.push(h);
    return h;
  }

  function updateHistory(state, id, patch, now) {
    var h = byId(state.history, id);
    if (!h || h.origin !== 'manual') return null;
    Object.assign(h, patch, { editedAt: iso(now) });
    return h;
  }

  function deleteHistory(state, id) {
    var h = byId(state.history, id);
    if (!h || h.origin !== 'manual') return null;
    state.history = state.history.filter(function (x) { return x.id !== id; });
    return h;
  }

  // ------------------------------------------------------------------ 새 할 일 제안
  // 같은 출처의 같은 문장은 상태(대기·수락·제외)와 관계없이 다시 만들지 않는다.
  function mergeSuggestions(state, candidates, now) {
    var known = {};
    state.suggestions.forEach(function (s) { known[s.key] = true; });
    var added = [];
    candidates.forEach(function (c) {
      if (known[c.key]) return;
      known[c.key] = true;
      var s = Object.assign({
        id: uid('sug'), status: 'pending', taskId: null, createdAt: iso(now), reviewedAt: null
      }, c);
      state.suggestions.push(s);
      added.push(s);
    });
    return added;
  }

  // 수락: 사용자가 고친 내용으로 확정 Task 를 만든다. 이미 수락한 제안은 기존 Task 를 돌려준다.
  function acceptSuggestion(state, id, fields, now) {
    var s = byId(state.suggestions, id);
    if (!s) return null;
    if (s.status === 'accepted' && s.taskId && byId(state.tasks, s.taskId)) {
      return { task: byId(state.tasks, s.taskId), duplicate: true };
    }
    fields = fields || {};
    var task = addTask(state, {
      title: fields.title || s.title,
      dueDate: fields.dueDate !== undefined ? fields.dueDate : (s.dueDate || null),
      projectId: fields.projectId !== undefined ? fields.projectId : (s.projectId || null),
      priority: fields.priority || null,
      estimateMinutes: fields.estimateMinutes != null ? fields.estimateMinutes : null,
      sources: [{ type: s.sourceType, refId: s.sourceId, excerpt: s.excerpt, suggestionId: s.id }],
      sample: !!s.sample
    }, now);
    s.status = 'accepted';
    s.taskId = task.id;
    s.reviewedAt = iso(now);
    return { task: task, duplicate: false };
  }

  function dismissSuggestion(state, id, now) {
    var s = byId(state.suggestions, id);
    if (!s || s.status !== 'pending') return s;
    s.status = 'dismissed';
    s.reviewedAt = iso(now);
    return s;
  }

  function restoreSuggestion(state, id) {
    var s = byId(state.suggestions, id);
    if (s && s.status === 'dismissed') { s.status = 'pending'; s.reviewedAt = null; }
    return s;
  }

  // ------------------------------------------------------------------ 주간 보고
  function reportFor(state, weekStartYmd) {
    for (var i = 0; i < state.reports.length; i++) if (state.reports[i].weekStart === weekStartYmd) return state.reports[i];
    return null;
  }

  function saveReport(state, weekStartYmd, patch, now) {
    var r = reportFor(state, weekStartYmd);
    if (!r) {
      r = { id: uid('rep'), weekStart: weekStartYmd, draft: '', body: '', generatedAt: null, editedAt: null, refs: [] };
      state.reports.push(r);
    }
    Object.assign(r, patch);
    if ('body' in patch && !('generatedAt' in patch)) r.editedAt = iso(now);
    return r;
  }

  // ------------------------------------------------------------------ 샘플 데이터
  // 샘플 항목은 sample:true 로 표시된다. 지우면 사용자가 직접 만든 것은 그대로 남는다.
  function clearSample(state) {
    ['projects', 'notes', 'tasks', 'blocks', 'history', 'suggestions', 'emails', 'proposals'].forEach(function (k) {
      state[k] = state[k].filter(function (x) { return !x.sample; });
    });
    // 지워진 메모에 딸린 AI 실행 기록·정리본도 함께 지운다
    var alive = {};
    state.notes.forEach(function (n) { alive[n.id] = true; });
    state.aiRuns = state.aiRuns.filter(function (r) { return alive[r.noteId]; });
    state.noteDigests = state.noteDigests.filter(function (d) { return alive[d.noteId]; });
    if (state.emailConnection.provider === 'sample') {
      state.emailConnection = { status: 'disconnected', provider: null, lastSyncAt: null, error: null };
    }
    state.meta.sampleLoaded = false;
    return state;
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION, TASK_STATUS: TASK_STATUS, PRIORITY: PRIORITY,
    HISTORY_TYPES: HISTORY_TYPES, MANUAL_HISTORY_TYPES: MANUAL_HISTORY_TYPES,
    uid: uid, iso: iso, emptyState: emptyState, normalize: normalize, normalizeTask: normalizeTask,
    byId: byId, liveTasks: liveTasks, liveNotes: liveNotes, liveProjects: liveProjects,
    blocksForTask: blocksForTask, nextBlockForTask: nextBlockForTask, tasksForNote: tasksForNote,
    unmetBlockers: unmetBlockers, noteTitle: noteTitle, resolveRef: resolveRef,
    addNote: addNote, updateNote: updateNote, deleteNote: deleteNote, addProject: addProject,
    addTask: addTask, updateTask: updateTask, completeTask: completeTask, reopenTask: reopenTask,
    startTask: startTask, snoozeTask: snoozeTask, deleteTask: deleteTask,
    addBlock: addBlock, updateBlock: updateBlock, deleteBlock: deleteBlock, conflictsFor: conflictsFor,
    liveCreated: liveCreated, liveCompleted: liveCompleted, liveUpdated: liveUpdated, captureHasResults: captureHasResults, revealSources: revealSources,
    addHistory: addHistory, updateHistory: updateHistory, deleteHistory: deleteHistory,
    mergeSuggestions: mergeSuggestions, acceptSuggestion: acceptSuggestion,
    dismissSuggestion: dismissSuggestion, restoreSuggestion: restoreSuggestion,
    reportFor: reportFor, saveReport: saveReport, clearSample: clearSample
  };
});
