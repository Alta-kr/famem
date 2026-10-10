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
//   ExtItem       → Google 캘린더에서 가져온 일정(state.gcal.events)의 읽기 전용 투영 — 저장하지 않는다
//
// "지금 할 일 추천" 결과는 저장하지 않는다. recommend.js 가 매번 다시 계산하는 값이다.

(function (factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.model = api; }
})(function () {
  var SCHEMA_VERSION = 4;   // 2: AI 층(aiRuns·proposals·noteDigests) · 3: 홈 채팅(chat), 수동 순서(sortOrder), 단계 초안(breakdown) · 4: Google 캘린더(gcal, 되돌리기 제외) · 적응(learned) · 현재 상태(presence, 되돌리기 제외) · 할 일 맥락(context·atMode)

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
      meta: { createdAt: iso(), sampleLoaded: false },
      // 현재 상태 — 같은 기기 안에서만 산다. 되돌리기(undo) 대상이 아니다 (store.js KEEP_ON_UNDO)
      presence: { v: 1, activatedAt: null, current: null, shown: [], parked: [], log: [],
                  hints: { day: null, used: 0, overtimeDismiss: 0, presetSeen: {}, presetOffered: {} } },
      // 적응 — 사용자가 직접 고친 것에서 배운 규칙. 교정과 함께 되돌린다 (undo 대상)
      learned: { v: 1, rules: [], metrics: { learned: 0, applied: 0, reverted: 0, hinted: 0 }, bootstrappedAt: null, compactedAt: null },
      // Google 캘린더 동기화 — 가져온 일정·내보낸 링크·보낼 목록. 되돌리기 대상이 아니다. 토큰·비밀값은 절대 넣지 않는다
      gcal: { v: 1, accountId: null, settings: { exportEnabled: true, exportWork: true, exportTitles: true },
              calendars: [], exportCalendarId: null, events: [], links: {}, gens: {}, outbox: [],
              backoffUntil: null, lastSyncAt: null, lastError: null }
    };
  }

  function isPlainObject(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }

  // 저장된 파일을 읽을 때 빠진 필드를 채운다. 모르는 필드는 버리지 않는다.
  // 최상위 객체는 얕게 합치므로, 안쪽 기본값(presence.hints·learned.metrics·gcal.settings 등)은 아래에서 따로 채운다.
  function normalize(raw) {
    var s = emptyState();
    if (!raw || typeof raw !== 'object') return s;
    Object.keys(s).forEach(function (k) {
      if (raw[k] === undefined) return;
      if (Array.isArray(s[k])) s[k] = Array.isArray(raw[k]) ? raw[k] : [];
      else if (s[k] && typeof s[k] === 'object') s[k] = Object.assign({}, s[k], raw[k]);
      else s[k] = raw[k];
    });
    var E = emptyState();
    // 객체가 아닌 값(문자열·배열 등 망가진 파일)이면 위의 얕은 병합이 글자 단위 키를 만들 수 있다 — 기본값으로 둔다
    ['presence', 'learned', 'gcal'].forEach(function (k) { if (raw[k] !== undefined && !isPlainObject(raw[k])) s[k] = E[k]; });
    // 현재 상태
    if (!s.presence || typeof s.presence !== 'object') s.presence = E.presence;
    ['shown', 'parked', 'log'].forEach(function (k) { if (!Array.isArray(s.presence[k])) s.presence[k] = []; });
    s.presence.hints = Object.assign({}, E.presence.hints, isPlainObject(s.presence.hints) ? s.presence.hints : {});
    // 적응
    if (!Array.isArray(s.learned.rules)) s.learned.rules = [];
    s.learned.metrics = Object.assign({}, E.learned.metrics, isPlainObject(s.learned.metrics) ? s.learned.metrics : {});
    // Google 캘린더
    s.gcal.settings = Object.assign({}, E.gcal.settings, isPlainObject(s.gcal.settings) ? s.gcal.settings : {});
    ['calendars', 'events', 'outbox'].forEach(function (k) { if (!Array.isArray(s.gcal[k])) s.gcal[k] = []; });
    ['links', 'gens'].forEach(function (k) { if (!isPlainObject(s.gcal[k])) s.gcal[k] = {}; });
    s.version = SCHEMA_VERSION;
    s.tasks = s.tasks.map(normalizeTask);
    return s;
  }

  var TASK_NULLABLE = ['context', 'contextSource', 'atMode', 'atModeSource'];
  function normalizeTask(t) {
    var r = Object.assign({
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
      // 할 일 맥락 (현재 상태 기능). 규칙·학습·프로젝트로 정한 맥락은 저장하지 않고 읽을 때 계산한다.
      context: null,                      // null | 'work'|'home'|'errand'|'personal'|'family'|'study'|'u_…'
      contextSource: null,                // null | 'user' | 'ai'  ('user' + context null = 사용자가 '정하지 않음'으로 고정)
      atMode: null,                       // 걸어 둔 상태: null | 'work'|'off'|'out'|'pause'|'rest'
      atModeSource: null,                 // null | 'user' | 'ai' | 'rule'
      createdAt: iso(), updatedAt: iso(), startedAt: null, completedAt: null, deletedAt: null, archivedAt: null,
      sample: false
    }, t);
    // { context: undefined } 처럼 넘겨도 '없음'은 늘 null 이다 (저장했다 불러온 값과 같게)
    TASK_NULLABLE.forEach(function (k) { if (r[k] === undefined) r[k] = null; });
    return r;
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
      context: null,                      // 소속 할 일의 기본 맥락 (사용자만 정한다). 옛 프로젝트는 p.context || null 로 읽는다
      createdAt: iso(now), deletedAt: null, sample: false
    }, fields);
    p.context = (fields && fields.context) || null;
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
    // 제목이 바뀌면 AI 가 정한 맥락의 근거가 사라진다 — AI 맥락만 지운다 (사용자가 정한 값은 그대로)
    if ('title' in p && p.title !== t.title && t.contextSource === 'ai' && !('contextSource' in p)) {
      p.context = null;
      p.contextSource = null;
    }
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

  // 삭제된 할 일의 작업 블록은 캘린더·충돌 계산에서 뺀다
  function liveBlock(state, b) {
    if (b.taskId) { var t = byId(state.tasks, b.taskId); if (t && t.deletedAt) return false; }
    return true;
  }

  // 주어진 구간과 겹치는 블록 + 바쁜(busy) 종일 아닌 Google 일정.
  // opts.blocksOnly === true 면 예전처럼 Daynote 블록만 본다.
  function conflictsFor(state, startIso, endIso, ignoreId, opts) {
    var out = state.blocks.filter(function (b) {
      if (b.id === ignoreId) return false;
      if (!liveBlock(state, b)) return false;
      return b.start < endIso && b.end > startIso;
    });
    if (opts && opts.blocksOnly) return out;
    // 구간이 없거나 잘못되면 블록 쪽과 같이 겹치는 것이 없다 (경계 없는 externalItems 로 모든 일정을 돌려주지 않게)
    if (isNaN(msOf(startIso)) || isNaN(msOf(endIso))) return out;
    return out.concat(externalItems(state, startIso, endIso).filter(function (x) {
      return x.busy && !x.allDay && x.id !== ignoreId;
    }));
  }

  // ------------------------------------------------------------------ 외부 캘린더(Google) 일정 — 읽기 전용 투영
  // state.gcal.events(가져온 원본)를 화면·충돌 계산이 읽는 ExtItem 으로 바꾼다. 저장하지 않는 값이다.
  // id 는 'g:캘린더|이벤트' 꼴이라 blocks 에는 없다 — M.byId(state.blocks, id) 가 null 이므로 기존 편집 경로가 자연히 무시한다.
  //   ExtItem = { id, kind:'event', external:'google', readOnly:true, taskId:null,
  //               title, start, end, allDay, startDate, endDate, busy, tentative,
  //               calendarId, eventId, htmlLink, location, color, calendarName, origin, tz }
  function msOf(x) {
    if (x == null || x === '') return NaN;
    return (x instanceof Date ? x : new Date(x)).getTime();
  }

  function calendarIndex(state) {
    var map = {};
    var cals = (state.gcal && Array.isArray(state.gcal.calendars)) ? state.gcal.calendars : [];
    cals.forEach(function (c) { if (c && c.id) map[c.id] = c; });
    return map;
  }

  function extItem(ev, cal) {
    return {
      id: ev.key || ('g:' + ev.calendarId + '|' + ev.eventId),
      kind: 'event', external: 'google', readOnly: true, taskId: null,
      title: ev.title || '(제목 없음)',
      start: ev.start, end: ev.end, allDay: !!ev.allDay,
      startDate: ev.startDate || null, endDate: ev.endDate || null,
      busy: !!ev.busy,
      // 참석 미정·응답 전인 일정도 바쁨으로 보되 점선으로 그린다
      tentative: ev.status === 'tentative' || ev.response === 'tentative' || ev.response === 'needsAction',
      calendarId: ev.calendarId || null, eventId: ev.eventId || null,
      htmlLink: ev.htmlLink || null, location: ev.location || '',
      color: (cal && cal.color) || null, calendarName: (cal && cal.summary) || '',
      origin: ev.origin || 'google',
      tz: ev.tz || null                   // 원래 시간대 (정보 팝오버의 시간대 안내용)
    };
  }

  // 시작 시각 순, 같으면 id 사전순 (항상 같은 순서)
  function byStartThenId(a, b) {
    var sa = msOf(a.start), sb = msOf(b.start);
    if (isNaN(sa)) sa = Infinity;
    if (isNaN(sb)) sb = Infinity;
    if (sa !== sb) return sa < sb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  // 구간과 겹치는(end > from && start < to) Google 일정. from·to 를 빼면 그쪽 경계는 보지 않는다.
  function externalItems(state, fromIso, toIso) {
    var events = (state && state.gcal && Array.isArray(state.gcal.events)) ? state.gcal.events : [];
    if (!events.length) return [];
    var from = msOf(fromIso), to = msOf(toIso);
    var cals = calendarIndex(state);
    var out = [];
    events.forEach(function (ev) {
      if (!ev || typeof ev !== 'object' || ev.tombstone || ev.status === 'cancelled') return;
      var s = msOf(ev.start), e = msOf(ev.end);
      if (isNaN(s) || isNaN(e)) return;
      if (!isNaN(from) && !(e > from)) return;
      if (!isNaN(to) && !(s < to)) return;
      out.push(extItem(ev, cals[ev.calendarId]));
    });
    return out.sort(byStartThenId);
  }

  // 캘린더·오늘 일정이 그리는 목록: Daynote 블록(삭제된 할 일의 블록 제외) + Google 일정, 시작 순.
  // opts: { busyOnly?: Google 일정 중 바쁨만, includeAllDay?: 종일 일정 포함(기본 true) }
  function calendarItems(state, fromIso, toIso, opts) {
    opts = opts || {};
    var from = msOf(fromIso), to = msOf(toIso);
    var blocks = state.blocks.filter(function (b) {
      if (!liveBlock(state, b)) return false;
      if (!isNaN(from) && !(msOf(b.end) > from)) return false;
      if (!isNaN(to) && !(msOf(b.start) < to)) return false;
      return true;
    });
    var ext = externalItems(state, fromIso, toIso).filter(function (x) {
      if (opts.includeAllDay === false && x.allDay) return false;
      if (opts.busyOnly && !x.busy) return false;
      return true;
    });
    return blocks.concat(ext).sort(byStartThenId);
  }

  function isExternal(item) { return !!(item && item.external); }

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
  // 현재 상태(presence)와 Google 캘린더(gcal)는 건드리지 않는다. 샘플 글에서만 배운 규칙은 함께 지운다.
  function clearSample(state) {
    ['projects', 'notes', 'tasks', 'blocks', 'history', 'suggestions', 'emails', 'proposals'].forEach(function (k) {
      state[k] = state[k].filter(function (x) { return !x.sample; });
    });
    // 지워진 메모에 딸린 AI 실행 기록·정리본도 함께 지운다
    var alive = {};
    state.notes.forEach(function (n) { alive[n.id] = true; });
    state.aiRuns = state.aiRuns.filter(function (r) { return alive[r.noteId]; });
    state.noteDigests = state.noteDigests.filter(function (d) { return alive[d.noteId]; });
    if (state.learned && Array.isArray(state.learned.rules)) {
      state.learned.rules = state.learned.rules.filter(function (r) { return !(r && r.sample); });
    }
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
    externalItems: externalItems, calendarItems: calendarItems, isExternal: isExternal,
    liveCreated: liveCreated, liveCompleted: liveCompleted, liveUpdated: liveUpdated, captureHasResults: captureHasResults, revealSources: revealSources,
    addHistory: addHistory, updateHistory: updateHistory, deleteHistory: deleteHistory,
    mergeSuggestions: mergeSuggestions, acceptSuggestion: acceptSuggestion,
    dismissSuggestion: dismissSuggestion, restoreSuggestion: restoreSuggestion,
    reportFor: reportFor, saveReport: saveReport, clearSample: clearSample
  };
});
