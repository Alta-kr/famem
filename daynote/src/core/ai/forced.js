'use strict';

// 명령어로 정한 종류 (DN.aiForced, 줄여 F) — '/할일 …', '/일정 …', '/메모 …' 처럼 사용자가 종류를 정해 적은 글.
//
//   1. createForced : 그 종류의 항목 딱 하나를 규칙으로 바로 만든다 (AI 를 기다리지 않는다, 같은 되돌리기 단계).
//                     만든 값은 capture.command.base 에 적어 둔다. 중복 검사·초안(proposals)은 없다.
//   2. refineForced : AI 결과가 오면 '다듬기'만 한다 — 제목·날짜·시각·길이·장소·프로젝트.
//                     지금 값이 base 와 같은 칸만 바꾼다(사용자가 손댄 칸은 그대로). 종류 판단·나누기·완료 보고·
//                     날짜 바꾸기 보고·중복 건너뛰기는 쓰지 않는다. AI 가 할 일·일정을 정확히 하나 줬을 때만 그 항목을 쓴다.
//   3. rulesItem    : AI 없이 첫 줄에서 날짜·시각·상대 시각·길이를 찾고, 실제로 칸에 쓴 표현만 제목에서 뺀다.
//
// 순수 함수(state 만 바꾼다). now 를 꼭 넘긴다 — 벽시계를 읽지 않는다.

(function (factory) {
  var node = typeof module !== 'undefined' && module.exports;
  function optional(name) { try { return require(name); } catch (e) { return null; } }
  var deps = node
    ? { dates: require('../dates'), model: require('../model'), suggest: require('../suggest'), validate: require('./validate'),
        proposals: require('./proposals'), status: optional('../status'), adapt: optional('../adapt') }
    : { dates: window.Daynote.dates, model: window.Daynote.model, suggest: window.Daynote.suggest, validate: window.Daynote.aiValidate,
        proposals: window.Daynote.aiProposals, status: window.Daynote.statusCore || null, adapt: window.Daynote.adapt || null };
  var api = factory(deps.dates, deps.model, deps.suggest, deps.validate, deps.proposals, deps.status, deps.adapt);
  if (node) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.aiForced = api; }
})(function (D, M, SG, V, P, ST, AD) {
  var TITLE_MAX = 120;
  var MEMO_MAX = 2000;
  var WORK_MIN = 30;        // 할 시각만 정한 할 일의 작업 시간
  var EVENT_MIN = 30;       // 길이를 모르는 일정 (AI 경로와 같은 짐작)
  var REFINED_LABEL = { title: '제목', dueDate: '날짜', date: '날짜', dueTime: '시각', time: '시각', at: '시각',
    durationMinutes: '길이', location: '장소', projectId: '프로젝트' };

  function iso(now) { return new Date(now).toISOString(); }
  function hmOf(d) { return D.pad(d.getHours()) + ':' + D.pad(d.getMinutes()); }
  var BULLET_RE = /^\s*(?:[-*+]|\d+[.)])?\s*\[[ xX]\]\s*|^\s*(?:[-*+•·]|\d+[.)])\s+/;

  // ------------------------------------------------------------------ 규칙 추출 (FEATURES §6.6)
  // 지운 자리들(겹치면 합친다)을 빼고 남은 글을 제목으로 다듬는다
  function cut(line, ranges) {
    var rs = ranges.filter(Boolean).sort(function (a, b) { return a[0] - b[0]; });
    var out = '', pos = 0;
    rs.forEach(function (r) {
      if (r[1] <= pos) return;
      if (r[0] > pos) out += line.slice(pos, r[0]);
      out += ' ';
      pos = Math.max(pos, r[1]);
    });
    out += line.slice(pos);
    return out.replace(/\s+/g, ' ').replace(/^[\s,.]+|[\s,.]+$/g, '').replace(/^(?:에|까지|부터)(?:\s+|$)/, '').replace(/^[\s,.]+/, '').trim();
  }
  // 표현 끝 바로 뒤의 조사까지 함께 뗀다
  function extend(line, end, re) {
    var m = line.slice(end).match(re);
    return m ? end + m[0].length : end;
  }
  function clip(t) { return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX - 3) + '…' : t; }
  function pf(opts) { return (opts && opts.profile) || (ST ? ST.profile({}) : null); }

  // rulesItem(text, 'task'|'event', now, opts{ profile }) → 항목 값 (§3.11)
  function rulesItem(text, kind, now, opts) {
    var ref = new Date(now);
    var lines = String(text == null ? '' : text).split('\n');
    var first = -1;
    for (var i = 0; i < lines.length; i++) if (lines[i].trim()) { first = i; break; }
    var raw = first < 0 ? '' : lines[first].replace(BULLET_RE, '').replace(/\s+/g, ' ').trim();
    var memo = first < 0 ? '' : lines.slice(first + 1).map(function (l) { return l.trim(); }).join('\n').trim().slice(0, MEMO_MAX);
    var line = raw;
    var context = null, atMode = null;
    if (kind !== 'event' && ST) {
      var tag = ST.extractContextTag(line, pf(opts));
      if (tag && tag.text) { context = { ctx: tag.ctx, tag: tag.tag }; line = tag.text; }
      var ex = ST.extractAtMode(line);
      if (ex) { atMode = { mode: ex.mode, phrase: ex.phrase }; line = ex.title; }
    }
    var fallback = line || raw;

    var due = SG.parseDueHint(line, ref);
    var dueAt = due ? line.indexOf(due.phrase) : -1;
    var dueRange = due && dueAt >= 0 ? [dueAt, dueAt + due.phrase.length] : null;
    var rel = V.relativeAt(line, ref);
    var relRange = rel ? [rel.index, extend(line, rel.index + rel.text.length, /^\s*에(?=[\s,.]|$)/)] : null;
    var tm = rel ? null : V.timeMatch(line);
    var tmEnd = tm ? tm.index + tm.text.length : 0;
    var today = D.ymd(ref);
    var used = [];

    if (kind === 'event') {
      var date = null, time = null, uncertain = true;
      if (rel) { date = rel.date; time = rel.time; uncertain = false; used.push(relRange); }
      else if (tm) {
        var h = +tm.candidates[0].slice(0, 2);
        time = tm.candidates.length === 1 ? tm.candidates[0] : (h >= 1 && h <= 6 ? tm.candidates[1] : tm.candidates[0]);
        uncertain = tm.candidates.length !== 1;
        used.push([tm.index, extend(line, tmEnd, /^\s*(?:에|부터|까지)(?=[\s,.]|$)/)]);
        if (due) { date = due.dueDate; used.push(dueRange); }
        else date = D.parseYmd(today, time) < ref ? D.ymd(D.addDays(ref, 1)) : today;
      } else if (due) { date = due.dueDate; time = '09:00'; used.push(dueRange); }
      if (!date) {
        var g = P.guessStart(null, null, ref);
        date = D.ymd(g.start); time = hmOf(g.start);
      }
      // 길이: 상대 시각 표현("1시간 후")은 길이가 아니므로 가리고 찾는다
      var scan = relRange ? line.slice(0, relRange[0]) + new Array(relRange[1] - relRange[0] + 1).join(' ') + line.slice(relRange[1]) : line;
      var span = V.durationSpan(scan, time);
      if (span) used.push([span.index, span.index + span.text.length]);
      var etitle = cut(line, used);
      return { kind: 'event', title: clip(etitle || fallback), date: date, time: time, timeUncertain: uncertain,
        durationMinutes: span ? span.minutes : EVENT_MIN, durationGuessed: !span };
    }

    var out = { kind: 'task', title: '', memo: memo, dueDate: null, dueTime: null, at: null, atMode: atMode, context: context };
    if (rel) { out.at = { date: rel.date, time: rel.time }; used.push(relRange); }
    else if (tm && tm.candidates.length === 1) {
      var t1 = tm.candidates[0];
      var untilM = line.slice(tmEnd).match(/^\s*까지/);
      if (untilM) {
        out.dueDate = due ? due.dueDate : today;
        out.dueTime = t1;
        used.push([tm.index, tmEnd + untilM[0].length]);
        if (due) used.push(dueRange);
      } else {
        var d = due ? due.dueDate : today;
        if (d === today && D.parseYmd(d, t1) < ref) out.dueDate = today;     // 오늘인데 이미 지난 시각 → 마감만 오늘
        else {
          out.at = { date: d, time: t1 };
          used.push([tm.index, extend(line, tmEnd, /^\s*(?:에|부터|까지)(?=[\s,.]|$)/)]);
          if (due) used.push(dueRange);
        }
      }
    } else if (due) { out.dueDate = due.dueDate; used.push(dueRange); }
    var title = cut(line, used);
    // 날짜·시각을 뗀 뒤 맨 앞에 남은 걸어 둔 상태 말('내일 퇴근하고 우유 사기')도 뗀다
    if (!atMode && ST && title) {
      var ex2 = ST.extractAtMode(title);
      if (ex2) { out.atMode = { mode: ex2.mode, phrase: ex2.phrase }; title = ex2.title; }
    }
    out.title = clip(title || fallback);
    return out;
  }

  // ------------------------------------------------------------------ 만들기 (FEATURES §6.5)
  function createForced(state, note, now) {
    var cap = note && note.capture;
    var cmd = cap && cap.command;
    if (!cmd) return { created: [] };
    var kind = cmd.kind;
    var at = iso(now);
    var src = [{ type: 'note', refId: note.id, excerpt: String(note.body || '').slice(0, 300) }];
    var created = [], base;
    if (kind === 'task') {
      var r = rulesItem(note.body, 'task', now, { profile: ST ? ST.profile(state.prefs) : null });
      var fields = { title: r.title, memo: r.memo, dueDate: r.dueDate, dueTime: r.dueTime, projectId: note.projectId || null,
        sources: src, origin: 'user', sample: !!note.sample };
      if (r.atMode) { fields.atMode = r.atMode.mode; fields.atModeSource = 'rule'; }
      if (r.context) { fields.context = r.context.ctx; fields.contextSource = 'user'; }
      var t = M.addTask(state, fields, now);
      var work = null;
      if (r.at) {
        var ws = D.parseYmd(r.at.date, r.at.time);
        work = M.addBlock(state, { taskId: t.id, title: t.title, start: ws.toISOString(), end: D.addMinutes(ws, WORK_MIN).toISOString(),
          sources: src.slice(), origin: 'user', durationGuessed: true, sample: !!note.sample });
      }
      created.push({ kind: 'task', id: t.id });
      base = { title: t.title, memo: t.memo, dueDate: t.dueDate, dueTime: t.dueTime, projectId: t.projectId,
        workId: work ? work.id : null, workStart: work ? work.start : null, workEnd: work ? work.end : null };
      note.captureRole = 'task_source';
    } else if (kind === 'event') {
      var e = rulesItem(note.body, 'event', now);
      var s = D.parseYmd(e.date, e.time);
      var b = M.addBlock(state, { kind: 'event', taskId: null, title: e.title, start: s.toISOString(), end: D.addMinutes(s, e.durationMinutes).toISOString(),
        projectId: note.projectId || null, sources: src, origin: 'user', timeUncertain: e.timeUncertain, durationGuessed: e.durationGuessed,
        sample: !!note.sample });
      created.push({ kind: 'block', id: b.id });
      base = { title: b.title, start: b.start, end: b.end, projectId: b.projectId, timeUncertain: !!b.timeUncertain, location: null };
      note.captureRole = 'task_source';
    } else {
      note.captureRole = 'memo';
      if (kind) { note.kind = kind; note.kindByUser = true; }
      base = { title: '', projectId: note.projectId || null };
    }
    note.capture = Object.assign({}, cap, {
      entryType: created.length ? 'task' : 'memo', created: created,
      command: Object.assign({}, cmd, { base: base, refined: [] })
    });
    if (!note.capture.at) note.capture.at = at;
    // 명령어는 사용자가 정한 종류다 — 이름표로 배운다 (명령어 글 자체에는 적용하지 않는다)
    if (AD && kind && AD.enabled(state)) AD.learn(state, { type: 'kind', text: note.body, to: kind, ref: note.id, sample: !!note.sample, source: 'command' }, now);
    return { created: created };
  }

  // ------------------------------------------------------------------ AI 다듬기 (FEATURES §6.7)
  // AI 가 할 일·일정을 정확히 하나 돌려줬을 때만 그 항목 (D14)
  function pickAiItem(validated) {
    var list = (validated && validated.items || []).filter(function (it) { return it.kind === 'task' || it.kind === 'event'; });
    return list.length === 1 ? list[0] : null;
  }
  function okv(fields, k) {
    var f = fields && fields[k];
    return f && f.status === 'ok' && f.value != null && f.value !== '' ? f.value : undefined;
  }

  function refineForced(state, args, now) {
    var note = M.byId(state.notes, args && args.note && args.note.id);
    if (!note || !note.capture || !note.capture.command) return null;
    var cap = note.capture, run = args.run || {}, out = args.output || {};
    var fin = { status: 'done', error: null, runId: run.id || null, doneAt: iso(now) };
    if (cap.changedByUser) {
      note.capture = Object.assign({}, cap, fin);
      return note.capture;
    }
    var cmd = cap.command, base = cmd.base || {}, kind = cmd.kind;
    var refined = (cmd.refined || []).slice();
    function mark(k) { if (refined.indexOf(k) === -1) refined.push(k); }
    var ai = pickAiItem(args.validated);
    var af = ai ? ai.fields : null;

    // 프로젝트: 사용자가 처음 고른 것 > AI 항목 > 글 전체 힌트
    var proj = base.projectId || null;
    if (!proj && ai && okv(af, 'projectId') && M.byId(M.liveProjects(state), af.projectId.value)) proj = af.projectId.value;
    if (!proj) { var mp = P.matchProject(state, out.note_project_hint); if (mp) proj = mp.id; }

    var ref = (cap.created || [])[0] || null;
    var item = ref ? M.byId(ref.kind === 'task' ? state.tasks : state.blocks, ref.id) : null;
    if (item && item.deletedAt) item = null;
    var large = [];

    if (kind === 'task' && item && ref.kind === 'task') {
      var t = item, patch = {};
      var titleEx = null;
      if (ai) {
        var title = okv(af, 'title');
        // AI 가 제목에 #태그·맨 앞의 걸어 둔 상태 말을 남겼으면 뗀다 (만들 때 rulesItem 이 뗀 것과 같게)
        if (title !== undefined && ST) {
          var tg = ST.extractContextTag(title, ST.profile(state.prefs));
          if (tg && tg.text) title = tg.text;
          titleEx = ai.kind === 'task' ? ST.extractAtMode(title) : null;
          if (titleEx) title = titleEx.title;
        }
        if (title !== undefined && t.title === base.title && title !== t.title) { patch.title = title; mark('title'); }
        if (ai.kind === 'task') {
          var dd = okv(af, 'dueDate'), dt = okv(af, 'dueTime');
          if (dd !== undefined && t.dueDate === base.dueDate && dd !== t.dueDate) { patch.dueDate = dd; mark('dueDate'); }
          if (dt !== undefined && t.dueTime === base.dueTime && dt !== t.dueTime) { patch.dueTime = dt; mark('dueTime'); }
        }
      }
      if (proj && t.projectId === base.projectId && proj !== t.projectId) { patch.projectId = proj; mark('projectId'); }
      if (Object.keys(patch).length) M.updateTask(state, t.id, patch, now);
      if (ai) {
        var wd = ai.kind === 'task' ? okv(af, 'atDate') : okv(af, 'date');
        var wt = ai.kind === 'task' ? okv(af, 'atTime') : okv(af, 'time');
        if (wd !== undefined && wt !== undefined && placeWork(state, t, base, wd, wt, note)) mark('at');
        // 맥락·걸어 둔 상태 (C16): 사용자가 정하지 않은 빈칸만
        if (ai.kind === 'task') {
          if (ai.context && t.context == null && t.contextSource !== 'user') { t.context = ai.context; t.contextSource = 'ai'; }
          if (ai.atMode && ai.atMode.mode && t.atMode == null) { t.atMode = ai.atMode.mode; t.atModeSource = 'ai'; }
          else if (titleEx && patch.title && t.atMode == null) { t.atMode = titleEx.mode; t.atModeSource = 'rule'; }
          applySched(t, ai.sched, now);
          // 큰 일: 단계 초안을 보관만 한다
          var ex = ai.extra;
          if (ex && ex.breakdown && ex.breakdown.length && !(t.steps && t.steps.length) && !t.breakdown) {
            t.breakdown = { status: 'pending', steps: ex.breakdown, source: 'capture', createdAt: iso(now), shownAt: null };
            large.push(t.id);
          }
        }
      }
    } else if (kind === 'event' && item && ref.kind === 'block') {
      var b = item, bp = {};
      if (ai) {
        var et = okv(af, 'title');
        if (et !== undefined && b.title === base.title && et !== b.title) { bp.title = et; mark('title'); }
        var curStart = new Date(b.start), len = new Date(b.end) - curStart;
        var startSame = b.start === base.start;
        var ns = null, setsTime = false;
        if (ai.kind === 'event') {
          var ed = okv(af, 'date'), eti = okv(af, 'time');
          if (ed !== undefined && eti !== undefined && startSame) { ns = D.parseYmd(ed, eti); setsTime = true; }
        } else {
          var td = okv(af, 'dueDate'), ad = okv(af, 'atDate'), at2 = okv(af, 'atTime');
          if (ad !== undefined && at2 !== undefined && startSame) { ns = D.parseYmd(ad, at2); setsTime = true; }
          else if (td !== undefined && startSame) ns = D.parseYmd(td, hmOf(curStart));      // 날짜만 — 시각은 그대로
        }
        if (ns && !isNaN(ns.getTime())) {
          if (ns.getTime() !== curStart.getTime()) {
            bp.start = ns.toISOString(); bp.end = new Date(ns.getTime() + len).toISOString();
            if (D.ymd(ns) !== D.ymd(curStart)) mark('date');
            if (hmOf(ns) !== hmOf(curStart)) mark('time');
          }
          if (setsTime && b.timeUncertain && b.timeUncertain === base.timeUncertain) { bp.timeUncertain = false; mark('time'); }
        }
        if (ai.kind === 'event') {
          var dm = okv(af, 'durationMinutes');
          if (dm !== undefined && b.end === base.end) {
            var st0 = new Date(bp.start || b.start);
            var ne = D.addMinutes(st0, dm).toISOString();
            if (ne !== (bp.end || b.end) || b.durationGuessed) { bp.end = ne; bp.durationGuessed = false; mark('durationMinutes'); }
          }
          var loc = okv(af, 'location');
          if (loc !== undefined && (b.location || null) === (base.location || null) && loc !== b.location) { bp.location = loc; mark('location'); }
        }
      }
      if (proj && b.projectId === base.projectId && proj !== b.projectId) { bp.projectId = proj; mark('projectId'); }
      if (Object.keys(bp).length) M.updateBlock(state, b.id, bp);
    } else if (kind !== 'task' && kind !== 'event') {
      if (!note.title && out.note_title) note.title = String(out.note_title).trim().slice(0, 80);
    }
    if (proj && !note.projectId) note.projectId = proj;

    note.capture = Object.assign({}, note.capture, fin, {
      largeTasks: large,
      command: Object.assign({}, cmd, { refined: refined })
    });
    return note.capture;
  }

  // 할 일의 작업 시간: 규칙으로 만든 작업 시간이 그대로면 옮기고, 처음부터 없었고 지금도 없으면 30분 새로
  function placeWork(state, t, base, date, time, note) {
    var s = D.parseYmd(date, time);
    if (isNaN(s.getTime())) return false;
    var bw = base.workId ? M.byId(state.blocks, base.workId) : null;
    if (bw) {
      if (bw.start !== base.workStart || bw.end !== base.workEnd) return false;
      if (s.toISOString() === bw.start) return false;
      var len = new Date(bw.end) - new Date(bw.start);
      M.updateBlock(state, bw.id, { start: s.toISOString(), end: new Date(s.getTime() + len).toISOString() });
      return true;
    }
    if (base.workId) return false;     // 사용자가 지운 작업 시간은 다시 만들지 않는다
    if (M.blocksForTask(state, t.id).some(function (x) { return x.kind === 'work'; })) return false;
    M.addBlock(state, { taskId: t.id, title: t.title, start: s.toISOString(), end: D.addMinutes(s, WORK_MIN).toISOString(),
      sources: (t.sources || []).slice(), origin: 'user', durationGuessed: true, sample: !!(note && note.sample) });
    return true;
  }

  // 배치 힌트 (CAL §8.5): 저장된 힌트가 없을 때만, 걸리는 시간은 예상 소요 시간이 비어 있을 때만
  function applySched(t, sc, now) {
    if (!sc) return;
    if (t.schedHints == null) {
      var h = { focus: sc.focus == null ? null : sc.focus, energy: sc.energy == null ? null : sc.energy,
        prefer: sc.prefer == null ? null : sc.prefer, splittable: sc.splittable == null ? null : sc.splittable };
      if (h.focus != null || h.energy != null || h.prefer != null || h.splittable != null) t.schedHints = Object.assign(h, { source: 'ai', at: iso(now) });
    }
    if (sc.minutes != null && t.estimateMinutes == null) { t.estimateMinutes = sc.minutes; t.estimateSource = 'ai'; }
  }

  return {
    REFINED_LABEL: REFINED_LABEL,
    rulesItem: rulesItem, createForced: createForced, pickAiItem: pickAiItem, refineForced: refineForced
  };
});
