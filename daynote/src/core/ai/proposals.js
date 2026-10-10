'use strict';

// AI 초안(proposal) 관리 — 원본 · AI 결과 · 확정 데이터의 경계를 지키는 곳.
//
//   원본    : notes (AI 가 고치지 않는다)
//   AI 결과 : aiRuns(실행 기록), proposals(할 일·일정 초안), noteDigests(정리본)
//   확정    : tasks, blocks — applySelections 로만, 사용자가 고른 항목만 만들어진다
//
// 다시 정리해도
//   - 같은 근거 문장의 초안은 같은 key → 새로 만들지 않는다 (수락·제외한 것도 그대로)
//   - 사용자가 고친 초안은 덮어쓰지 않는다 (AI 새 버전은 aiUpdate 로 옆에 둔다)
//   - 원문에서 근거 문장이 사라진 초안은 'stale' 로 표시한다 (지우지 않는다)
//
// 적응(adapt): 결과 카드에서 사용자가 직접 고친 것(종류·프로젝트·날짜)은 같은 mutate 안에서 규칙으로 배운다(learnFrom).
//   확실한 규칙은 AI 결과 뒤(또는 AI 없이) applyLearned 로 적용하고 capture.learned 에 적는다. applyLearned 는 배우지 않는다.
//   now 를 넘기지 않은 교정은 배우지 않는다(벽시계를 읽지 않는다).
// 현재 상태(status): AI 가 고른 맥락·걸어 둔 상태를 할 일에 싣고(#태그는 사용자 값), 상태 보고는 제안 칩(statusHint)만 만든다.

(function (factory) {
  var node = typeof module !== 'undefined' && module.exports;
  var deps = node
    ? { dates: require('../dates'), model: require('../model'), suggest: require('../suggest'), validate: require('./validate'),
        adapt: require('../adapt'), status: require('../status') }
    : { dates: window.Daynote.dates, model: window.Daynote.model, suggest: window.Daynote.suggest, validate: window.Daynote.aiValidate,
        adapt: window.Daynote.adapt || null, status: window.Daynote.statusCore || null };
  var api = factory(deps.dates, deps.model, deps.suggest, deps.validate, deps.adapt, deps.status);
  if (node) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.aiProposals = api; }
})(function (D, M, SG, V, AD, ST) {
  var norm = SG.normalizeText;
  var RAW_LIMIT = 60000;

  function iso(now) { return new Date(now || Date.now()).toISOString(); }

  function ensure(state) {
    if (!state.aiRuns) state.aiRuns = [];
    if (!state.proposals) state.proposals = [];
    if (!state.noteDigests) state.noteDigests = [];
    return state;
  }

  // 메모 내용 지문 — 이 값이 같으면 "바뀌지 않은 메모" 다
  function noteHash(note) { return SG.hash((note.title || '') + '\n' + (note.body || '')); }

  function itemKey(kind, noteId, quote, ordinal) {
    return kind + ':note:' + noteId + ':' + SG.hash(norm(quote)) + ':' + (ordinal || 0);
  }

  // ------------------------------------------------------------------ 실행 기록
  function startRun(state, fields, now) {
    ensure(state);
    var run = Object.assign({
      id: M.uid('run'), kind: 'organize_note', noteId: null, noteHash: null, promptVersion: null,
      provider: null, model: null, status: 'running', attempts: 1,
      startedAt: iso(now), finishedAt: null, error: null, usage: null, rawOutput: null, stats: null, dropped: []
    }, fields);
    state.aiRuns.push(run);
    // 오래된 기록은 메모마다 최근 5개만 남긴다
    var mine = state.aiRuns.filter(function (r) { return r.noteId === run.noteId; });
    if (mine.length > 5) {
      var drop = mine.slice(0, mine.length - 5).map(function (r) { return r.id; });
      state.aiRuns = state.aiRuns.filter(function (r) { return drop.indexOf(r.id) === -1; });
    }
    return run;
  }

  function finishRun(state, runId, patch, now) {
    var run = M.byId(state.aiRuns, runId);
    if (!run) return null;
    if (patch.rawOutput && patch.rawOutput.length > RAW_LIMIT) patch.rawOutput = patch.rawOutput.slice(0, RAW_LIMIT);
    Object.assign(run, patch, { finishedAt: iso(now) });
    return run;
  }

  function latestRun(state, noteId) {
    ensure(state);
    var list = state.aiRuns.filter(function (r) { return r.noteId === noteId; });
    return list[list.length - 1] || null;
  }

  // 같은 메모 내용 + 같은 프롬프트로 이미 성공한 실행 → API 를 다시 부르지 않는다
  function reusableRun(state, noteId, hash, promptVersion) {
    ensure(state);
    for (var i = state.aiRuns.length - 1; i >= 0; i--) {
      var r = state.aiRuns[i];
      if (r.noteId === noteId && r.status === 'succeeded' && r.noteHash === hash && r.promptVersion === promptVersion && r.rawOutput) return r;
    }
    return null;
  }

  // 앱이 꺼진 사이 '실행 중' 으로 남은 기록은 실패로 바꾼다 (다시 시도할 수 있게)
  function recoverInterrupted(state, now) {
    ensure(state);
    state.aiRuns.forEach(function (r) {
      if (r.status === 'running') {
        r.status = 'failed';
        r.finishedAt = iso(now);
        r.error = { type: 'interrupted', message: '앱이 닫혀 정리가 끝나지 않았습니다.', retryable: true };
      }
    });
  }

  // ------------------------------------------------------------------ 병합
  function sameFields(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  // validated: validate.validateOrganizeNote 결과 (ok:true)
  function mergeOrganizeRun(state, args, now) {
    ensure(state);
    var note = args.note, run = args.run, v = args.validated;
    var hash = noteHash(note);
    var stats = { added: 0, updated: 0, keptEdited: 0, alreadyReviewed: 0, stale: 0, dropped: v.dropped.length };
    var seen = {};

    v.items.forEach(function (it) {
      var key = itemKey(it.kind, note.id, it.quote, it.ordinal);
      seen[key] = true;
      var payload = {
        title: it.title, fields: it.fields, flags: it.flags, basis: it.basis,
        duplicateOf: it.duplicateOf, defaultChecked: it.defaultChecked, extra: it.extra || null
      };
      // capture.v7: 맥락 · 걸어 둔 상태 · 배치 힌트 (검증을 통과한 값만, 할 일 초안에만)
      if (it.kind === 'task') {
        payload.context = it.context || null;
        payload.atMode = it.atMode || null;
        payload.sched = it.sched || null;
      }
      var ex = state.proposals.filter(function (p) { return p.key === key; })[0];
      if (ex) {
        if (ex.status === 'accepted' || ex.status === 'dismissed') { stats.alreadyReviewed++; return; }
        ex.source = { type: 'note', id: note.id, quote: it.quote, line: it.line, noteHash: hash };
        if (ex.edits && Object.keys(ex.edits).length) {
          // 사용자가 고친 초안 — 손대지 않고 새 AI 결과만 옆에 둔다
          if (!sameFields(ex.payload, payload)) ex.aiUpdate = { payload: payload, runId: run.id, at: iso(now) };
          if (ex.status === 'stale') ex.status = 'pending';
          stats.keptEdited++;
        } else {
          if (!sameFields(ex.payload, payload)) { ex.payload = payload; stats.updated++; }
          ex.status = 'pending';
          ex.aiUpdate = null;
        }
        ex.runId = run.id;
        ex.updatedAt = iso(now);
        return;
      }
      state.proposals.push({
        id: M.uid('prop'), key: key, kind: it.kind, origin: 'ai', status: 'pending',
        runId: run.id, promptVersion: run.promptVersion,
        source: { type: 'note', id: note.id, quote: it.quote, line: it.line, noteHash: hash },
        payload: payload, edits: null, aiUpdate: null, resultRef: null,
        createdAt: iso(now), updatedAt: iso(now), reviewedAt: null, sample: !!note.sample
      });
      stats.added++;
    });

    stats.stale = refreshStale(state, note);

    // 정리본은 메모마다 하나 — 어떤 메모 내용으로 만든 것인지 함께 둔다
    state.noteDigests = state.noteDigests.filter(function (d) { return d.noteId !== note.id; });
    state.noteDigests.push(Object.assign({ noteId: note.id, noteHash: hash, runId: run.id, createdAt: iso(now) }, v.digest));
    return stats;
  }

  // 근거 문장이 원문에 아직 있는가로 대기 초안의 상태를 맞춘다
  function refreshStale(state, note) {
    ensure(state);
    var lines = V.noteLines(note);
    var n = 0;
    state.proposals.forEach(function (p) {
      if (!p.source || p.source.id !== note.id) return;
      if (p.status !== 'pending' && p.status !== 'stale') return;
      var line = V.locate(lines, p.source.quote, p.source.line);
      if (line < 0) { if (p.status !== 'stale') { p.status = 'stale'; } n++; }
      else { p.source.line = line; if (p.status === 'stale') p.status = 'pending'; }
    });
    return n;
  }

  // 메모가 지워지면 그 메모의 대기 초안은 stale 로
  function staleForDeletedNote(state, noteId) {
    ensure(state);
    state.proposals.forEach(function (p) { if (p.source && p.source.id === noteId && p.status === 'pending') p.status = 'stale'; });
  }

  // ------------------------------------------------------------------ 검토
  // 화면에 보일 최종 값 = 사용자 수정 > 검증된 값
  function effective(p) {
    var f = p.payload.fields, e = p.edits || {};
    var out = {};
    Object.keys(f).forEach(function (k) { out[k] = k in e ? e[k] : f[k].value; });
    if ('saveAs' in e) out.saveAs = e.saveAs;
    return out;
  }

  function setEdit(state, id, field, value, now) {
    var p = M.byId(ensure(state).proposals, id);
    if (!p || (p.status !== 'pending' && p.status !== 'stale')) return null;
    p.edits = Object.assign({}, p.edits || {});
    p.edits[field] = value;
    p.updatedAt = iso(now);
    return p;
  }

  // AI 새 버전 받아들이기 — 사용자 수정을 버리고 새 초안으로
  function takeAiUpdate(state, id, now) {
    var p = M.byId(ensure(state).proposals, id);
    if (!p || !p.aiUpdate) return null;
    p.payload = p.aiUpdate.payload;
    p.runId = p.aiUpdate.runId;
    p.aiUpdate = null;
    p.edits = null;
    p.updatedAt = iso(now);
    return p;
  }

  function dismiss(state, id, now) {
    var p = M.byId(ensure(state).proposals, id);
    if (!p || p.status === 'accepted') return null;
    p.status = 'dismissed';
    p.reviewedAt = iso(now);
    return p;
  }

  function restore(state, id) {
    var p = M.byId(ensure(state).proposals, id);
    if (p && p.status === 'dismissed') { p.status = 'pending'; p.reviewedAt = null; }
    return p;
  }

  // 저장 가능 여부. 일정은 날짜·시각·길이가 모두 있어야 캘린더에 올릴 수 있다.
  function checkSelection(state, p, values) {
    var errs = [];
    if (!p) return ['초안을 찾을 수 없습니다.'];
    if (p.status === 'accepted') return ['이미 저장한 초안입니다.'];
    if (p.status === 'dismissed') return ['제외한 초안입니다.'];
    if (p.status === 'stale') errs.push('원문에서 근거 문장이 사라졌습니다. 다시 정리하거나 제외해 주세요.');
    if (!values.title || !String(values.title).trim()) errs.push('제목이 비어 있습니다.');
    var asEvent = p.kind === 'event' && values.saveAs !== 'task';
    if (p.kind === 'task' || !asEvent) {
      var d = p.kind === 'task' ? values.dueDate : values.date;
      var t = p.kind === 'task' ? values.dueTime : values.time;
      if (d && !V.DATE_RE.test(d)) errs.push('마감일 형식이 올바르지 않습니다.');
      if (t && !V.TIME_RE.test(t)) errs.push('마감 시각 형식이 올바르지 않습니다.');
      if (t && !d) errs.push('시각만 있고 날짜가 없습니다.');
    } else {
      if (!values.date || !V.DATE_RE.test(values.date)) errs.push('일정 날짜를 정해 주세요.');
      if (!values.time || !V.TIME_RE.test(values.time)) errs.push('일정 시각을 정해 주세요.');
      if (!(values.durationMinutes > 0)) errs.push('일정 소요 시간을 정해 주세요.');
    }
    if (values.projectId && !M.byId(M.liveProjects(state), values.projectId)) errs.push('프로젝트를 찾을 수 없습니다.');
    return errs;
  }

  function eventRange(values) {
    var s = D.parseYmd(values.date, values.time);
    return { start: s.toISOString(), end: D.addMinutes(s, values.durationMinutes).toISOString() };
  }

  // 새 할 일에 맥락·걸어 둔 상태·배치 힌트를 싣는다 (STATUS §14, CAL §8.4)
  //   맥락: 근거 문장의 #태그 → 사용자 값(제목에서 태그를 뗀다) > AI 값('ai')
  //   걸어 둔 상태: AI 값('ai'). 제목 맨 앞에 표현이 남아 있으면 한 번 더 떼고, AI 값이 없으면 'rule'
  //   배치 힌트: 사용자가 정한 힌트가 없을 때만 'ai'. 걸리는 시간은 예상 소요 시간이 비어 있을 때만
  function applyTaskExtras(state, t, p, now) {
    var pl = p.payload || {};
    if (ST) {
      var pf = ST.profile(state.prefs);
      var tag = ST.extractContextTag(p.source && p.source.quote || '', pf) || ST.extractContextTag(t.title, pf);
      if (tag) {
        var inTitle = ST.extractContextTag(t.title, pf);
        if (inTitle && inTitle.text) t.title = inTitle.text;
        t.context = tag.ctx; t.contextSource = 'user';
      } else if (pl.context) {
        t.context = pl.context; t.contextSource = 'ai';
      }
      var ex = ST.extractAtMode(t.title);
      if (ex) t.title = ex.title;
      if (pl.atMode && pl.atMode.mode) { t.atMode = pl.atMode.mode; t.atModeSource = 'ai'; }
      else if (ex) { t.atMode = ex.mode; t.atModeSource = 'rule'; }
    }
    applySched(t, pl.sched, now);
  }
  function applySched(t, sc, now) {
    if (!sc) return false;
    var changed = false;
    if (!(t.schedHints && t.schedHints.source === 'user')) {
      var h = { focus: sc.focus == null ? null : sc.focus, energy: sc.energy == null ? null : sc.energy,
        prefer: sc.prefer == null ? null : sc.prefer, splittable: sc.splittable == null ? null : sc.splittable };
      if (h.focus != null || h.energy != null || h.prefer != null || h.splittable != null) { t.schedHints = Object.assign(h, { source: 'ai', at: iso(now) }); changed = true; }
    }
    if (sc.minutes != null && t.estimateMinutes == null) { t.estimateMinutes = sc.minutes; t.estimateSource = 'ai'; changed = true; }
    return changed;
  }

  // 선택한 초안만 확정 데이터로 만든다. 하나라도 문제가 있으면 아무것도 바꾸지 않는다.
  // selections: [proposalId]  — 값은 proposal 의 사용자 수정 + 검증값(effective)
  function applySelections(state, ids, now) {
    ensure(state);
    var plan = [], errors = [];
    ids.forEach(function (id) {
      var p = M.byId(state.proposals, id);
      var values = p ? effective(p) : {};
      var errs = checkSelection(state, p, values);
      if (errs.length) errors.push({ id: id, title: values.title || (p && p.payload.title) || '', errors: errs });
      else plan.push({ p: p, values: values });
    });
    if (errors.length) return { ok: false, errors: errors, created: [] };

    var created = [];
    plan.forEach(function (x) {
      var p = x.p, v = x.values;
      var src = { type: 'note', refId: p.source.id, excerpt: p.source.quote, noteHash: p.source.noteHash, proposalId: p.id };
      var asEvent = p.kind === 'event' && v.saveAs !== 'task';
      if (!asEvent) {
        var task = M.addTask(state, {
          title: String(v.title).trim(),
          dueDate: (p.kind === 'task' ? v.dueDate : v.date) || null,
          dueTime: (p.kind === 'task' ? v.dueTime : v.time) || null,
          projectId: v.projectId || null,
          sources: [src], origin: 'ai_accepted', proposalId: p.id, sample: !!p.sample
        }, now);
        if (p.kind === 'task') applyTaskExtras(state, task, p, now);
        p.resultRef = { kind: 'task', id: task.id };
        created.push({ kind: 'task', id: task.id, title: task.title });
        // 시간 정한 할 일: 그 시각에 작업 시간(30분)을 잡아 오늘 일정에도 보이게. 할 일은 체크해야 끝난다.
        if (p.kind === 'task' && v.atDate && v.atTime && V.DATE_RE.test(v.atDate) && V.TIME_RE.test(v.atTime)) {
          var ws = D.parseYmd(v.atDate, v.atTime);
          M.addBlock(state, {
            taskId: task.id, title: task.title, start: ws.toISOString(), end: new Date(ws.getTime() + 30 * 60000).toISOString(),
            sources: [src], origin: 'ai_accepted', proposalId: p.id, durationGuessed: true, sample: !!p.sample
          });
        }
      } else {
        var r = eventRange(v);
        var blk = M.addBlock(state, {
          kind: 'event', taskId: null, title: String(v.title).trim(), start: r.start, end: r.end,
          location: v.location || null, projectId: v.projectId || null,
          sources: [src], origin: 'ai_accepted', proposalId: p.id, sample: !!p.sample
        });
        p.resultRef = { kind: 'block', id: blk.id };
        created.push({ kind: 'block', id: blk.id, title: blk.title, conflicts: M.conflictsFor(state, r.start, r.end, blk.id).length });
      }
      p.status = 'accepted';
      p.reviewedAt = iso(now);
      p.acceptedValues = v;
    });
    return { ok: true, errors: [], created: created };
  }

  // 초안 하나의 저장 준비 상태
  //   ready   : 지금 저장할 수 있다
  //   note    : 저장할 수 있지만 확인을 권하는 칸이 남아 있다 (예: 날짜 표현을 확정하지 못함 → 날짜 없이 저장됨)
  //   blocked : 이대로는 저장할 수 없다 (예: 일정의 소요 시간이 없음, 원문이 바뀜)
  var FIELD_LABEL = { title: '제목', dueDate: '마감일', dueTime: '마감 시각', atDate: '할 날짜', atTime: '할 시각', date: '날짜', time: '시각', durationMinutes: '소요 시간', location: '장소', projectId: '프로젝트' };
  function readiness(state, p) {
    var v = effective(p);
    var errs = checkSelection(state, p, v);   // 이미 저장·제외한 초안도 여기서 막힌다 (중복 생성 방지)
    var e = p.edits || {};
    var asEvent = p.kind === 'event' && v.saveAs !== 'task';
    var open = Object.keys(p.payload.fields).filter(function (k) {
      if (k in e) return false;
      if (!asEvent && (k === 'durationMinutes' || k === 'location')) return false;
      return p.payload.fields[k].status === 'confirm' && v[k] == null;
    });
    var level = errs.length ? 'blocked' : open.length ? 'note' : 'ready';
    return { level: level, errors: errs, openFields: open, openLabels: open.map(function (k) { return FIELD_LABEL[k] || k; }) };
  }

  // 선택한 초안을 저장 가능한 것과 확인이 필요한 것으로 나눈다 — 부분 저장은 화면이 명시적으로 고른다
  function partition(state, ids) {
    var ready = [], blocked = [];
    ids.forEach(function (id) {
      var p = M.byId(ensure(state).proposals, id);
      if (!p) return;
      var r = readiness(state, p);
      if (r.level === 'blocked') blocked.push({ id: id, errors: r.errors }); else ready.push(id);
    });
    return { ready: ready, blocked: blocked };
  }

  // ------------------------------------------------------------------ 빠른 입력 자동 분류
  // 오늘 화면 입력창에 적은 글(note.capture)을 AI 판단대로 바로 반영한다. 사용자는 나중에 한 번에 바꿀 수 있다.
  //  - 메모에 없는 정보(확인 필요 칸)는 비워 둔 채 만든다
  //  - 이미 있는 것과 비슷한 할 일은 만들지 않고 초안으로 남긴다
  //  - 시각·소요 시간이 다 있는 일정만 캘린더 블록, 아니면 할 일로 만든다
  //  - 적은 글 자체가 할 일뿐이면 원문은 출처로만 남기고 메모 목록에서는 숨긴다(captureRole 'task_source')
  var ENTRY = { memo: 1, task: 1, mixed: 1, done: 1, update: 1 };
  var NOTE_KIND = { memo: 1, idea: 1, link: 1 };
  function matchProject(state, hint) {
    if (!hint) return null;
    var h = norm(hint);
    return M.liveProjects(state).filter(function (p) { var n = norm(p.name); return n && (n === h || n.indexOf(h) !== -1 || h.indexOf(n) !== -1); })[0] || null;
  }

  function applyCapture(state, args, now) {
    ensure(state);
    var note = M.byId(state.notes, args.note.id);
    var out = args.output || {};
    var entryType = ENTRY[out.entry_type] ? out.entry_type : 'memo';
    // AI 가 끝나기 전에(또는 실패 뒤) 사용자가 직접 종류를 정했으면 그 결정을 덮지 않는다
    if (note.capture && note.capture.changedByUser) {
      note.capture = Object.assign({}, note.capture, { status: 'done', error: null, runId: args.run.id, doneAt: iso(now) });
      return note.capture;
    }
    mergeOrganizeRun(state, { note: args.note, run: args.run, validated: args.validated }, now);

    // 프로젝트: 사용자가 입력할 때 고른 프로젝트가 있으면 그것이 우선(할 일마다의 AI 판단도 덮는다).
    // 없을 때만 AI 판단을 쓴다.
    var userProject = note.projectId ? M.byId(state.projects, note.projectId) : null;
    var proj = userProject || matchProject(state, out.note_project_hint);
    if (proj && !note.projectId) note.projectId = proj.id;

    var mine = state.proposals.filter(function (p) { return p.runId === args.run.id && p.status === 'pending' && p.source.id === note.id; });
    var skipped = [];
    var guessedDur = {};   // 길이를 30분으로 짐작해 넣은 일정 초안
    var ids = [];
    mine.forEach(function (p) {
      if (p.payload.duplicateOf) { skipped.push({ id: p.id, reason: 'duplicate' }); return; }
      if (proj && (userProject || !p.payload.fields.projectId.value)) p.payload.fields.projectId = { value: proj.id, status: 'ok', message: '', options: [] };
      // 날짜·시각이 확실한 일정인데 길이만 없으면 30분으로 두고 캘린더에 넣는다 (나중에 끌어서 고치면 된다)
      if (p.kind === 'event') {
        var ev = effective(p);
        if (ev.date && ev.time && !(ev.durationMinutes > 0)) {
          p.edits = Object.assign({}, p.edits || {}, { durationMinutes: 30 });
          guessedDur[p.id] = true;
        }
      }
      if (p.kind === 'event' && readiness(state, p).level === 'blocked') {
        p.edits = Object.assign({}, p.edits || {}, { saveAs: 'task' });
      }
      if (readiness(state, p).level === 'blocked') { skipped.push({ id: p.id, reason: 'blocked' }); return; }
      ids.push(p.id);
    });
    var res = ids.length ? applySelections(state, ids, now) : { ok: true, created: [] };
    var created = res.ok ? res.created.map(function (c) { return { kind: c.kind, id: c.id }; }) : [];
    Object.keys(guessedDur).forEach(function (pid) {
      var gp = M.byId(state.proposals, pid);
      var gb = gp && gp.resultRef && gp.resultRef.kind === 'block' ? M.byId(state.blocks, gp.resultRef.id) : null;
      if (gb) gb.durationGuessed = true;
    });
    // 큰 할 일: AI 가 나눠 둔 단계 초안을 할 일에 보관만 한다 (나중에 여유 있을 때 제안)
    var large = [];
    if (res.ok) ids.forEach(function (pid) {
      var p = M.byId(state.proposals, pid);
      var ex = p && p.payload.extra;
      if (!ex || !ex.breakdown || !p.resultRef || p.resultRef.kind !== 'task') return;
      var t = M.byId(state.tasks, p.resultRef.id);
      if (!t || (t.steps && t.steps.length)) return;
      t.breakdown = { status: 'pending', steps: ex.breakdown, source: 'capture', createdAt: iso(now), shownAt: null };
      large.push(t.id);
    });

    // 완료 보고 ("샤워 완료") — 근거 문장이 원문에 있고, 지금 열린 할 일과 맞을 때만 완료로 표시한다
    var completed = completeReported(state, note, out.done_tasks, created, now);
    // 날짜 바꾸기 ("견적서는 내일 보낼게") — 앱이 날짜를 다시 계산해 맞을 때만 기존 할 일을 고친다
    var updated = updateReported(state, note, out.updated_tasks, created, completed, now);
    var reported = completed.length + updated.length;
    if (entryType === 'done' || entryType === 'update') entryType = reported ? (created.length ? 'mixed' : entryType) : 'memo';
    else if (reported && entryType === 'memo') entryType = 'mixed';
    if (entryType === 'done' && !completed.length) entryType = 'update';
    if (entryType === 'update' && !updated.length) entryType = 'done';

    if (entryType === 'task' && !created.length) entryType = 'memo';   // 할 일로 못 만들었으면 메모로 남긴다
    // 링크는 할 일이 같이 생겨도 자료로 남겨 둔다 (원문 URL 을 보관함에서 찾을 수 있게)
    var keepLink = note.kindByUser ? note.kind === 'link' : out.note_kind === 'link';
    // 할 일만 적은 글·완료 보고만 한 글은 원문을 숨긴다 (결과 카드와 할 일·히스토리에서 원문을 볼 수 있다)
    var sourceOnly = entryType === 'task' || entryType === 'done' || entryType === 'update';
    note.captureRole = sourceOnly && !skipped.length && !keepLink ? 'task_source' : 'memo';
    if (!note.title && note.captureRole === 'memo' && out.note_title) note.title = String(out.note_title).trim().slice(0, 80);
    // 메모 종류(메모/아이디어/링크) — 사용자가 직접 바꾼 적이 있으면 그대로 둔다
    if (!note.kindByUser) note.kind = NOTE_KIND[out.note_kind] ? out.note_kind : (note.kind || 'memo');
    note.capture = Object.assign({}, note.capture, {
      status: 'done', entryType: entryType, runId: args.run.id, doneAt: iso(now),
      created: created, skipped: skipped, completed: completed, updated: updated, projectByAi: !!(proj && !userProject), largeTasks: large
    });
    // 상태 보고(AI): 제안 칩만 둔다. 상태는 바꾸지 않는다 (기능을 켰고 오늘 예산이 남았을 때만)
    var hint = presenceHint(state, note, args.validated && args.validated.presence, now);
    if (hint) note.capture.statusHint = hint;
    return note.capture;
  }

  function presenceHint(state, note, pr, now) {
    if (!ST || !pr || !pr.role || pr.role === 'none') return null;
    var c = note.capture || {};
    if (c.statusLine || c.statusHint) return null;
    var pf = ST.profile(state.prefs);
    if (!ST.isActive(state, pf) || !ST.budgetOk(state, pf, now)) return null;
    var at = new Date(now);
    var r = ST.resolveRole(pr.role, {}, { profile: pf, eff: ST.effective(state, pf, at), current: ST.ensure(state).current, now: at });
    if (!r || !r.id) return null;
    ST.useBudget(state, pf, now);
    return { from: 'ai', role: pr.role, id: r.id, label: r.label, quote: pr.quote, at: iso(now) };
  }

  // AI 가 "끝냈다" 고 한 할 일을 실제 열린 할 일에서 찾아 완료한다.
  //   제목이 목록 그대로면 그것, 아니면 띄어쓰기를 무시하고 한쪽이 다른 쪽을 품는 것 하나만 (여럿이면 고르지 않는다)
  function nospace(s) { return String(s || '').replace(/\s+/g, '').toLowerCase(); }
  function findOpenTask(state, title, exclude) {
    var open = M.liveTasks(state).filter(function (t) { return t.status !== 'done' && !exclude[t.id]; });
    var exact = open.filter(function (t) { return t.title === title; });
    if (exact.length) return exact[0];
    var k = nospace(title);
    if (k.length < 2) return null;
    var near = open.filter(function (t) { var n = nospace(t.title); return n === k || n.indexOf(k) !== -1 || k.indexOf(n) !== -1; });
    return near.length === 1 ? near[0] : null;
  }
  // 날짜 바꾸기: due(마감) 또는 do_at(할 시각). 바꾸기 전 값을 함께 둬서 카드의 × 로 되돌린다
  function updateReported(state, note, list, created, completed, now) {
    var exclude = {};
    (created || []).concat(completed || []).forEach(function (c) { exclude[c.id] = true; });
    var body = nospace([note.title, note.body].join('\n'));
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (d) {
      if (!d || !d.title) return;
      var q = d.evidence && d.evidence.quote;
      if (!q || body.indexOf(nospace(q)) === -1) return;
      var t = findOpenTask(state, String(d.title), exclude);
      if (!t) return;
      var due = V.verifyWhen(d.due, q, note, now);
      var at = V.verifyWhen(d.do_at, q, note, now);
      if (at && !at.time) { due = due || at; at = null; }   // 시각 없는 '할 날' 은 마감으로
      if (!due && !at) return;
      var work = M.blocksForTask(state, t.id).filter(function (b) { return b.kind === 'work' && new Date(b.end) > new Date(now); })[0] || null;
      var rec = { kind: 'task', id: t.id, prev: { dueDate: t.dueDate, dueTime: t.dueTime }, prevWork: work ? { id: work.id, start: work.start, end: work.end } : null, newWorkId: null };
      if (due) M.updateTask(state, t.id, { dueDate: due.date, dueTime: due.time || null }, now);
      if (at) {
        var s = D.parseYmd(at.date, at.time);
        var len = work ? new Date(work.end) - new Date(work.start) : 30 * 60000;
        if (work) M.updateBlock(state, work.id, { start: s.toISOString(), end: new Date(s.getTime() + len).toISOString() });
        else rec.newWorkId = M.addBlock(state, { taskId: t.id, title: t.title, start: s.toISOString(), end: new Date(s.getTime() + len).toISOString(), origin: 'user', durationGuessed: true }).id;
      }
      rec.to = { dueDate: due ? due.date : null, dueTime: due ? due.time || null : null, at: at ? at.date + ' ' + at.time : null };
      exclude[t.id] = true;
      out.push(rec);
    });
    return out;
  }

  function completeReported(state, note, list, created, now) {
    var exclude = {};
    (created || []).forEach(function (c) { exclude[c.id] = true; });   // 방금 만든 할 일을 바로 완료하지는 않는다
    var body = nospace([note.title, note.body].join('\n'));
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (d) {
      if (!d || !d.title) return;
      var q = d.evidence && d.evidence.quote;
      if (!q || body.indexOf(nospace(q)) === -1) return;
      var t = findOpenTask(state, String(d.title), exclude);
      if (!t) return;
      var r = M.completeTask(state, t.id, now);
      if (!r) return;
      exclude[t.id] = true;
      out.push({ kind: 'task', id: t.id, historyId: r.historyId, prevStatus: r.prevStatus });
    });
    return out;
  }

  // "메모로 바꾸기" — AI 가 만든 할 일·일정을 지우고 메모로만 둔다
  //   opts.by === 'learned' (배운 대로 바꿈) 이면 사용자 결정 표시(changedByUser)를 세우지 않는다
  function captureToMemo(state, noteId, now, opts) {
    var byL = !!(opts && opts.by === 'learned');
    var note = M.byId(state.notes, noteId);
    if (!note || !note.capture) return null;
    (note.capture.created || []).forEach(function (c) {
      if (c.kind === 'task') M.deleteTask(state, c.id, now); else M.deleteBlock(state, c.id);
    });
    state.proposals.forEach(function (p) {
      if (p.source && p.source.id === noteId && (p.status === 'accepted' || p.status === 'pending')) { p.status = 'dismissed'; p.reviewedAt = iso(now); }
    });
    note.captureRole = 'memo';
    note.capture = Object.assign({}, note.capture, { entryType: 'memo', created: [], skipped: [] });
    if (!byL) note.capture.changedByUser = true;
    return note;
  }

  // "할 일로 바꾸기" — 적은 글 전체를 할 일 하나로 (원문 연결)
  function captureToTask(state, noteId, now, opts) {
    var byL = !!(opts && opts.by === 'learned');
    var note = M.byId(state.notes, noteId);
    if (!note) return null;
    var text = (note.body || note.title || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    var first = (text[0] || note.title || '').replace(/^\s*(?:[-*+]|\d+[.)])?\s*(\[[ xX]\]\s*)?/, '').trim();
    var task = M.addTask(state, {
      title: first.length > 120 ? first.slice(0, 117) + '…' : first || '(제목 없음)',
      projectId: note.projectId || null,
      sources: [{ type: 'note', refId: note.id, excerpt: text.join(' ').slice(0, 300) }],
      origin: 'user'
    }, now);
    note.captureRole = text.length <= 1 ? 'task_source' : 'memo';
    note.capture = Object.assign({}, note.capture || {}, {
      status: (note.capture && note.capture.status) || 'done', entryType: text.length <= 1 ? 'task' : 'mixed',
      created: ((note.capture && note.capture.created) || []).concat({ kind: 'task', id: task.id })
    });
    if (!byL) note.capture.changedByUser = true;
    return task;
  }

  // 프로젝트 바꾸기 — 메모와 거기서 만든 할 일·일정을 함께. 사용자가 고친 것이면 배운다(now 가 있을 때만)
  function captureSetProject(state, noteId, projectId, now, opts) {
    var byL = !!(opts && opts.by === 'learned');
    var note = M.byId(state.notes, noteId);
    if (!note) return null;
    var from = note.projectId || 'none';
    note.projectId = projectId || null;
    (note.capture && note.capture.created || []).forEach(function (c) {
      var item = M.byId(c.kind === 'task' ? state.tasks : state.blocks, c.id);
      if (item) item.projectId = projectId || null;
    });
    if (byL) return note;
    if (note.capture) note.capture.projectByAi = false;
    learnFrom(state, note, { type: 'project', from: from, to: projectId || 'none', text: note.body }, now);
    return note;
  }

  // ---------------------------------------------------------------- 적응 (ADAPT §7.5)
  // 줄 하나짜리 카드의 지금 종류 — 만든 항목이 하나면 그 종류, 없으면 메모 종류, 여럿이면 null
  function rowKind(state, note) {
    var c = M.liveCreated(state, note);
    return c.length === 1 ? (c[0].kind === 'task' ? 'task' : 'event') : c.length ? null : (note.kind || 'memo');
  }
  function excerptOf(item) { var s = item && item.sources && item.sources[0]; return (s && s.excerpt) || (item && item.title) || ''; }
  function adaptOn(state) { return !!(AD && AD.enabled(state)); }

  // 사용자의 교정에서 배운다. 같은 유형을 규칙이 바꾼 적이 있으면 그 규칙에 벌점을 준다.
  function learnFrom(state, note, ev, now) {
    if (now == null || !adaptOn(state) || !note) return;            // A17
    var cap = note.capture || {};
    var mine = (cap.learned || []).filter(function (x) { return x.type === ev.type && (!ev.refId || !x.refId || x.refId === ev.refId); });
    if (mine.length) {
      AD.penalize(state, [].concat.apply([], mine.map(function (x) { return x.ruleIds || []; })), now, 1);
      AD.count(state, 'reverted', mine.length);
      cap.learned = cap.learned.filter(function (x) { return mine.indexOf(x) === -1; });
    }
    var r = AD.learn(state, { type: ev.type, text: ev.text, from: ev.from, to: ev.to, refTime: ev.refTime,
      ref: note.id, sample: !!note.sample, source: 'correction' }, now);
    if (r && note.capture) note.capture.taught = true;
  }

  // 결과 카드의 날짜 칩 — 할 일은 마감일(지우면 시각도), 일정은 길이를 지키며 옮긴다(시각을 고르면 '확인 필요' 해제).
  // 앱이 계산할 수 없는 날짜 표현의 할 일을 고치면 날짜 어휘를 배운다 (일정은 1단계에서 배우지 않는다)
  function captureSetDate(state, noteId, ref, ymd, time, now) {
    var note = M.byId(state.notes, noteId);
    if (!ref) return null;
    if (ref.kind === 'task') {
      var t = M.byId(state.tasks, ref.id);
      if (!t) return null;
      var prev = t.dueDate || null;
      M.updateTask(state, t.id, ymd ? { dueDate: ymd } : { dueDate: null, dueTime: null }, now);
      if (note && ymd && ymd !== prev) {
        var text = excerptOf(t);
        if (!SG.parseDueHint(text, note.updatedAt)) {
          learnFrom(state, note, { type: 'date', from: prev, to: { date: ymd }, text: text, refTime: note.updatedAt, refId: t.id }, now);
        }
      }
      return t;
    }
    var b = M.byId(state.blocks, ref.id);
    if (!b || !ymd) return b || null;
    var start = new Date(b.start), end = new Date(b.end);
    var len = Math.max(15, Math.round((end - start) / 60000)) || 60;
    var ns = D.parseYmd(ymd, time || D.hm(start));
    var patch = { start: ns.toISOString(), end: D.addMinutes(ns, len).toISOString() };
    if (time) patch.timeUncertain = false;
    M.updateBlock(state, b.id, patch);
    return b;
  }

  // 배운 대로 적용할 계획 (순수 — 바꾸지 않는다)
  //   opts.hinted: 이번 실행에 AI 힌트로 보낸 규칙 id (AI 를 부르지 않았으면 [])
  function learnedBase(state, noteId) {
    if (!adaptOn(state)) return null;
    var note = M.byId(state.notes, noteId);
    if (!note || note.deletedAt) return null;
    var c = note.capture;
    if (!c || (c.status !== 'done' && c.status !== 'no_ai')) return null;
    if (c.changedByUser || c.command || (c.learned && c.learned.length)) return null;
    return note;
  }
  function hintedOk(s, opts) {
    var hinted = (opts && opts.hinted) || [];
    var seen = (s.ruleIds || []).some(function (id) { return hinted.indexOf(id) !== -1; });
    return !seen || s.confidence >= 0.8;
  }
  var LEARN_KINDS = { task: 1, event: 1, memo: 1, idea: 1, link: 1 };
  function planKind(state, note, now, opts) {
    var body = String(note.body || '');
    if (body.indexOf('\n') !== -1 || body.trim().length > 80 || note.kindByUser) return null;
    var items = captureItems(state, note);
    if (items.length !== 1) return null;
    var cur = items[0].kind;
    if (!LEARN_KINDS[cur]) return null;
    var s = AD.suggest(state, 'kind', body, now);
    if (!s || s.level !== 'strong' || s.to === cur || !hintedOk(s, opts)) return null;
    if (s.to === 'event' && !(cur === 'task' && items[0].item && items[0].item.dueDate)) return null;
    if (cur === 'event' && NOTE_KIND[s.to]) return null;
    return { type: 'kind', to: s.to, from: cur, ruleIds: s.ruleIds || [], phrase: s.phrase };
  }
  function planProject(state, note, now, opts) {
    var c = note.capture || {};
    if (note.projectId && c.projectByAi !== true) return null;
    var allowed = M.liveProjects(state).map(function (p) { return p.id; }).concat('none');
    var s = AD.suggest(state, 'project', note.body || '', now, { allowed: allowed });
    var cur = note.projectId || 'none';
    if (!s || s.level !== 'strong' || s.to === cur || !hintedOk(s, opts)) return null;
    return { type: 'project', to: s.to, from: cur, ruleIds: s.ruleIds || [], phrase: s.phrase };
  }
  function planDates(state, note, now) {
    var out = [];
    M.liveCreated(state, note).forEach(function (c) {
      if (c.kind !== 'task') return;
      var t = M.byId(state.tasks, c.id);
      if (!t || t.dueDate != null) return;
      var prop = t.proposalId ? M.byId(state.proposals || [], t.proposalId) : null;
      if (prop && !(prop.payload && prop.payload.fields && prop.payload.fields.dueDate && prop.payload.fields.dueDate.status === 'confirm')) return;
      var text = excerptOf(t);
      if (SG.parseDueHint(text, note.updatedAt)) return;
      var s = AD.suggest(state, 'date', text, now, { refTime: note.updatedAt });
      if (!s || s.level !== 'strong' || !s.value || !s.value.date || s.value.date < D.ymd(new Date(now))) return;
      out.push({ type: 'date', refId: t.id, to: s.value.date, from: null, ruleIds: s.ruleIds || [], phrase: s.phrase });
    });
    return out;
  }
  function planLearned(state, noteId, now, opts) {
    var empty = { kind: null, project: null, dates: [] };
    var note = learnedBase(state, noteId);
    if (!note || now == null) return empty;
    return { kind: planKind(state, note, now, opts), project: planProject(state, note, now, opts), dates: planDates(state, note, now) };
  }
  // 배운 대로 바꾼다 — 종류 → (다시 계산) 프로젝트 → (다시 계산) 날짜. capture.learned 에 적는다. 배우지는 않는다
  function applyLearned(state, noteId, now, opts) {
    var note = learnedBase(state, noteId);
    if (!note || now == null) return [];
    var entries = [];
    var k = planKind(state, note, now, opts);
    if (k) { captureSetKind(state, noteId, k.to, now, { by: 'learned' }); entries.push(k); }
    var pj = planProject(state, note, now, opts);
    if (pj) { captureSetProject(state, noteId, pj.to === 'none' ? null : pj.to, now, { by: 'learned' }); entries.push(pj); }
    planDates(state, note, now).forEach(function (d) {
      M.updateTask(state, d.refId, { dueDate: d.to }, now);
      entries.push(d);
    });
    if (!entries.length) return [];
    var at = iso(now);
    entries = entries.map(function (e) {
      var x = { type: e.type, to: e.to, from: e.from, ruleIds: e.ruleIds, phrase: e.phrase, at: at };
      if (e.refId) x.refId = e.refId;
      return x;
    });
    note.capture = Object.assign({}, note.capture, { learned: entries });
    AD.count(state, 'applied', entries.length);
    return entries;
  }

  // ---------------------------------------------------------------- 결과 카드에서 고치기
  // 홈 결과 카드의 '종류' 칩 — 적은 글 하나를 할 일 / 일정 / 메모 / 아이디어 / 링크 중 하나로 바꾼다.
  // 바꾼 것은 사용자 결정이라 다음 AI 정리가 덮지 않는다 (kindByUser · changedByUser).
  // 할 일 ↔ 일정을 오가도 원래 값(마감·완료·단계·소요 시간·장소·길이)을 잃지 않게 바꾸기 전 값을 함께 둔다.
  var KINDS = { task: 1, event: 1, memo: 1, idea: 1, link: 1 };
  var TASK_KEEP = ['dueDate', 'dueTime', 'memo', 'priority', 'estimateMinutes', 'estimateSource', 'steps', 'breakdown', 'blockedBy', 'waitingFor', 'snoozedUntil', 'proposalId', 'sortOrder', 'elaboratedAt',
    'context', 'contextSource', 'atMode', 'atModeSource', 'schedHints'];

  function hm(d) { return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  // 시각이 없으면 그날 9시, 오늘이면 다음 정시(자정을 넘기면 지금) — '시각 확인 필요' 로 표시한다
  function guessStart(dueDate, dueTime, now, slot) {
    var n = new Date(now);
    if (dueDate && dueTime) return { start: D.parseYmd(dueDate, dueTime), uncertain: false };
    var s;
    if (dueDate && dueDate !== D.ymd(n)) s = D.parseYmd(dueDate, '09:00');
    else {
      s = new Date(n); s.setMinutes(0, 0, 0); s.setHours(s.getHours() + 1);
      if (D.ymd(s) !== D.ymd(n)) { s = new Date(n); s.setSeconds(0, 0); }
    }
    // 여러 개를 한꺼번에 바꾸면 한 시간씩 띄워 겹치지 않게
    if (slot) s = new Date(s.getTime() + slot * 60 * 60000);
    return { start: s, uncertain: true };
  }

  function relink(state, oldId, ref) {
    state.proposals.forEach(function (p) { if (p.resultRef && p.resultRef.id === oldId) p.resultRef = ref; });
  }

  function taskToBlock(state, t, now, slot) {
    var back = t.convertedFrom && t.convertedFrom.kind === 'block' ? t.convertedFrom : null;
    var work = M.blocksForTask(state, t.id).filter(function (x) { return x.kind === 'work'; })[0] || null;
    var start, end, uncertain;
    // 시간 정한 할 일이면 그 작업 시간을 일정 시각으로
    if (work) {
      start = new Date(work.start); end = new Date(work.end); uncertain = false;
      M.deleteBlock(state, work.id);
    // 일정에서 왔던 할 일이고 날짜를 안 바꿨으면 원래 일정 그대로
    } else if (back && D.ymd(new Date(back.start)) === t.dueDate) {
      start = new Date(back.start); end = new Date(back.end); uncertain = !!back.timeUncertain;
    } else {
      var g = guessStart(t.dueDate, t.dueTime, now, slot);
      start = g.start; uncertain = g.uncertain;
      end = new Date(start.getTime() + (back ? new Date(back.end) - new Date(back.start) : 60 * 60000));
    }
    var saved = { kind: 'task', blockStart: start.toISOString(), hadWork: !!work, status: t.status, completedAt: t.completedAt, startedAt: t.startedAt, origin: t.origin, createdAt: t.createdAt };
    TASK_KEEP.forEach(function (k) { saved[k] = t[k]; });
    var b = M.addBlock(state, {
      kind: 'event', title: t.title, start: start.toISOString(), end: end.toISOString(),
      location: back ? back.location || null : null,
      projectId: t.projectId || null, sources: (t.sources || []).slice(), origin: 'user', timeUncertain: uncertain,
      convertedFrom: saved
    });
    relink(state, t.id, { kind: 'block', id: b.id });
    M.deleteTask(state, t.id, now);
    return b;
  }

  function blockToTask(state, b, now) {
    var back = b.convertedFrom && b.convertedFrom.kind === 'task' ? b.convertedFrom : null;
    var s = new Date(b.start);
    var fields = {
      title: b.title, projectId: b.projectId || null, sources: (b.sources || []).slice(), origin: 'user',
      convertedFrom: { kind: 'block', start: b.start, end: b.end, location: b.location || null, timeUncertain: !!b.timeUncertain }
    };
    if (back) {
      TASK_KEEP.forEach(function (k) { if (back[k] !== undefined) fields[k] = back[k]; });
      ['status', 'completedAt', 'startedAt', 'origin', 'createdAt'].forEach(function (k) { if (back[k] !== undefined) fields[k] = back[k]; });
      // 일정에서 날짜·시각을 직접 바꿨으면 그 값을 마감으로. 그대로면 원래 마감(없었으면 없음)
      if (b.start !== back.blockStart) { fields.dueDate = D.ymd(s); fields.dueTime = b.timeUncertain ? null : hm(s); }
    } else {
      fields.dueDate = D.ymd(s);
      fields.dueTime = b.timeUncertain ? null : hm(s);
    }
    var t = M.addTask(state, fields, now);
    // 시각이 확실한 일정이었으면 그 시각을 작업 시간으로 남긴다 — 오늘 일정에 그대로 보이고, 체크해야 끝난다
    //   (일정에서 손대지 않고 돌아오면 원래 할 일 그대로 — 원래 작업 시간이 있었을 때만 되살린다)
    var unchanged = back && b.start === back.blockStart;
    if (unchanged ? back.hadWork : !b.timeUncertain) {
      M.addBlock(state, { taskId: t.id, title: t.title, start: b.start, end: b.end, sources: (b.sources || []).slice(), origin: 'user' });
    }
    relink(state, b.id, { kind: 'task', id: t.id });
    M.deleteBlock(state, b.id);
    return t;
  }

  function captureSetKind(state, noteId, kind, now, opts) {
    var note = M.byId(state.notes, noteId);
    if (!note || !KINDS[kind]) return null;
    var byL = !!(opts && opts.by === 'learned');
    var fromKind = rowKind(state, note);
    var live = M.liveCreated(state, note).map(function (c) {
      return { kind: c.kind, item: M.byId(c.kind === 'task' ? state.tasks : state.blocks, c.id) };
    });
    var role = note.captureRole;
    var done = function (created) {
      // 사용자가 정했으니 '다시 시도' 로 AI 결과가 덮이지 않게 끝난 상태로 둔다
      note.capture = Object.assign({}, note.capture || {}, {
        status: 'done', error: null, created: created,
        entryType: !created.length ? 'memo' : note.captureRole === 'task_source' ? 'task' : 'mixed'
      });
      if (!byL) note.capture.changedByUser = true;
    };
    var learn = function () {
      if (!byL && fromKind && fromKind !== kind) learnFrom(state, note, { type: 'kind', from: fromKind, to: kind, text: note.body }, now);
    };

    if (NOTE_KIND[kind]) {
      captureToMemo(state, noteId, now, opts);
      note.kind = kind;
      if (!byL) note.kindByUser = true;
      done([]);
      learn();
      return note;
    }
    var next = [];
    // 바꾸는 동안 잠깐 비는 순간에 원문이 '메모로 드러나기' 가 일어나지 않게 막아 둔다
    state.__holdReveal = true;
    try {
      if (!live.length) {
        var t0 = captureToTask(state, noteId, now, opts);
        role = note.captureRole;
        live = [{ kind: 'task', item: t0 }];
      }
      var slot = 0;
      live.forEach(function (x) {
        if (kind === 'task') {
          next.push(x.kind === 'block' ? { kind: 'task', id: blockToTask(state, x.item, now).id } : { kind: 'task', id: x.item.id });
        } else if (x.kind === 'task' && x.item.status === 'done') {
          next.push({ kind: 'task', id: x.item.id });            // 끝낸 일은 일정으로 바꾸지 않는다 (완료 기록 보존)
        } else {
          var b = x.kind === 'task' ? taskToBlock(state, x.item, now, x.item.dueTime ? 0 : slot++) : x.item;
          next.push({ kind: 'block', id: b.id });
        }
      });
    } finally { delete state.__holdReveal; }
    note.captureRole = role;
    if (note.kindByUser) { note.kindByUser = false; }
    done(next);
    learn();
    M.revealSources(state);
    return note;
  }

  // 여러 줄 카드에서 한 줄만 종류 바꾸기 — 나머지 줄은 그대로 둔다
  //   메모 줄 → 메모/아이디어/링크: 메모 종류만 / 할 일·일정: 원문을 할 일(·일정)로 만들고 원문은 출처로 숨긴다
  //   할 일·일정 줄 → 메모류: 그 줄을 빼고 원문을 그 종류의 메모로 보이게 / 할 일 ↔ 일정: 원래 값을 지키며 바꾼다
  function captureSetItemKind(state, noteId, ref, kind, now) {
    var note = M.byId(state.notes, noteId);
    if (!note || !ref || !KINDS[kind]) return null;
    var fromKind = ref.kind === 'note' ? note.kind || 'memo' : ref.kind === 'task' ? 'task' : 'event';
    var curItem = ref.kind === 'note' ? null : M.byId(ref.kind === 'task' ? state.tasks : state.blocks, ref.id);
    var text = ref.kind === 'note' ? note.body : excerptOf(curItem);
    function swap(oldId, nref) {
      var c = note.capture || {};
      note.capture = Object.assign({}, c, { created: (c.created || []).map(function (x) { return x.id === oldId ? nref : x; }) });
    }
    state.__holdReveal = true;
    try {
      if (ref.kind === 'note') {
        if (NOTE_KIND[kind]) { note.kind = kind; note.kindByUser = true; }
        else {
          var t = captureToTask(state, noteId, now);
          note.captureRole = 'task_source';
          if (t && kind === 'event') swap(t.id, { kind: 'block', id: taskToBlock(state, t, now, 0).id });
        }
      } else {
        var cur = M.byId(ref.kind === 'task' ? state.tasks : state.blocks, ref.id);
        if (!cur) return note;
        if (NOTE_KIND[kind]) {
          captureRemoveItem(state, noteId, ref, now, { internal: true });
          note.captureRole = 'memo'; note.kind = kind; note.kindByUser = true;
        } else if (kind === 'event' && ref.kind === 'task') swap(cur.id, { kind: 'block', id: taskToBlock(state, cur, now, 0).id });
        else if (kind === 'task' && ref.kind === 'block') swap(cur.id, { kind: 'task', id: blockToTask(state, cur, now).id });
      }
    } finally { delete state.__holdReveal; }
    note.capture = Object.assign({}, note.capture || {}, { status: 'done', error: null, changedByUser: true });
    if (fromKind !== kind) learnFrom(state, note, { type: 'kind', from: fromKind, to: kind, text: text, refId: ref.id }, now);
    M.revealSources(state);
    return note;
  }

  // 결과 카드에서 한 줄 빼기 (×) — 만든 할 일·일정만 지운다. 원문은 남는다.
  //   opts.internal: 종류 바꾸기 안에서 부른 것 (배우기는 부른 쪽이 한다)
  function captureRemoveItem(state, noteId, ref, now, opts) {
    var note = M.byId(state.notes, noteId);
    if (!note || !note.capture || !ref) return null;
    // 완료 보고 줄을 빼면 "완료" 를 취소한다 (AI 가 잘못 짚은 것 — 완료 기록도 남기지 않는다)
    if (ref.kind === 'moved') {
      var u = (note.capture.updated || []).filter(function (c) { return c.id === ref.id; })[0];
      var tk = u && M.byId(state.tasks, u.id);
      if (tk) {
        M.updateTask(state, tk.id, { dueDate: u.prev.dueDate, dueTime: u.prev.dueTime }, now);
        if (u.prevWork) M.updateBlock(state, u.prevWork.id, { start: u.prevWork.start, end: u.prevWork.end });
        if (u.newWorkId) M.deleteBlock(state, u.newWorkId);
      }
      var restU = (note.capture.updated || []).filter(function (c) { return c.id !== ref.id; });
      note.capture = Object.assign({}, note.capture, { updated: restU, changedByUser: true });
      if (!M.captureHasResults(state, note)) { note.captureRole = 'memo'; note.capture.entryType = 'memo'; }
      return note;
    }
    if (ref.kind === 'done') {
      var d = (note.capture.completed || []).filter(function (c) { return c.id === ref.id; })[0];
      if (d) M.reopenTask(state, d.id, now, { undoOf: d.historyId, prevStatus: d.prevStatus });
      var rest = (note.capture.completed || []).filter(function (c) { return c.id !== ref.id; });
      note.capture = Object.assign({}, note.capture, { completed: rest, changedByUser: true });
      if (!M.captureHasResults(state, note)) { note.captureRole = 'memo'; note.capture.entryType = 'memo'; }
      return note;
    }
    // × 로 뺀 할 일·일정: 그 근거 문장을 그 종류로 본 규칙을 약하게 하고, 배운 대로 바꾼 종류였으면 벌점을 준다
    if (!(opts && opts.internal) && now != null && adaptOn(state)) {
      var gone = M.byId(ref.kind === 'task' ? state.tasks : state.blocks, ref.id);
      if (gone) AD.weaken(state, 'kind', excerptOf(gone), ref.kind === 'task' ? 'task' : 'event', now, 0.5);
      var lk = (note.capture.learned || []).filter(function (x) { return x.type === 'kind'; });
      if (lk.length) {
        AD.penalize(state, [].concat.apply([], lk.map(function (x) { return x.ruleIds || []; })), now, 1);
        AD.count(state, 'reverted', lk.length);
        note.capture.learned = note.capture.learned.filter(function (x) { return x.type !== 'kind'; });
      }
    }
    if (ref.kind === 'task') M.deleteTask(state, ref.id, now); else M.deleteBlock(state, ref.id);
    state.proposals.forEach(function (p) {
      if (p.resultRef && p.resultRef.id === ref.id && p.status === 'accepted') { p.status = 'dismissed'; p.reviewedAt = iso(now); }
    });
    var left = M.liveCreated(state, note).filter(function (c) { return c.id !== ref.id; });
    // 남은 게 없으면 원문이 숨지 않도록 메모로 보이게 한다
    if (!left.length && !M.liveCompleted(state, note).length && !M.liveUpdated(state, note).length) note.captureRole = 'memo';
    note.capture = Object.assign({}, note.capture, { created: left, entryType: left.length ? note.capture.entryType : 'memo', changedByUser: true });
    return note;
  }

  // 결과 카드에 보여 줄 줄들 — 메모 자신 + 만든 할 일·일정 (지워진 것은 뺀다)
  // 원문이 숨은(task_source) 글인데 살아 있는 항목이 없으면 메모 줄을 보여 준다
  function captureItems(state, note) {
    var out = [];
    M.liveCreated(state, note).forEach(function (x) {
      out.push({ kind: x.kind === 'task' ? 'task' : 'event', ref: x, item: M.byId(x.kind === 'task' ? state.tasks : state.blocks, x.id) });
    });
    // 완료 보고로 끝낸 할 일 줄
    M.liveCompleted(state, note).forEach(function (x) {
      out.push({ kind: 'done', ref: { kind: 'done', id: x.id }, item: M.byId(state.tasks, x.id) });
    });
    // 날짜를 바꾼 할 일 줄
    M.liveUpdated(state, note).forEach(function (x) {
      out.push({ kind: 'moved', ref: { kind: 'moved', id: x.id }, item: M.byId(state.tasks, x.id), change: x });
    });
    if (note.captureRole !== 'task_source' || !out.length) out.unshift({ kind: note.kind || 'memo', ref: { kind: 'note', id: note.id }, item: note });
    return out;
  }

  function forNote(state, noteId) {
    return ensure(state).proposals.filter(function (p) { return p.source && p.source.id === noteId; });
  }

  function digestFor(state, noteId) {
    return ensure(state).noteDigests.filter(function (d) { return d.noteId === noteId; })[0] || null;
  }

  return {
    noteHash: noteHash, itemKey: itemKey, startRun: startRun, finishRun: finishRun, latestRun: latestRun,
    reusableRun: reusableRun, recoverInterrupted: recoverInterrupted, mergeOrganizeRun: mergeOrganizeRun,
    refreshStale: refreshStale, staleForDeletedNote: staleForDeletedNote, effective: effective, setEdit: setEdit,
    takeAiUpdate: takeAiUpdate, dismiss: dismiss, restore: restore, checkSelection: checkSelection,
    applySelections: applySelections, readiness: readiness, partition: partition, FIELD_LABEL: FIELD_LABEL, forNote: forNote,
    applyCapture: applyCapture, captureToMemo: captureToMemo, captureToTask: captureToTask, captureSetProject: captureSetProject, digestFor: digestFor, eventRange: eventRange,
    captureSetKind: captureSetKind, captureSetItemKind: captureSetItemKind, captureRemoveItem: captureRemoveItem, captureItems: captureItems,
    captureSetDate: captureSetDate, planLearned: planLearned, applyLearned: applyLearned, guessStart: guessStart, matchProject: matchProject,
    TASK_KEEP: TASK_KEEP
  };
});
