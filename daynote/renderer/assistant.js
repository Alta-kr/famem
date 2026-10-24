'use strict';

// 홈 채팅 도우미 — 채팅 기록과 버튼 동작, "잠깐 여유 있을 때" 제안.
//
//   보내기     : 적은 글을 메모로 저장하고 AI 가 메모/할 일로 나눈다(capture.js). 큰 일은 단계 초안을 보관만 한다.
//   다음 할 일 : 규칙 기반 추천(recommend.js) — AI·인터넷 없이 바로. 세부 할 일 중 '준비' 는 남는 시간에 먼저
//               ("30분 남았어" 처럼 남는 시간을 말하면 그 시간 안에 할 것으로)
//   작게 나누기: 나눠 둔 초안이 있으면 그걸, 없으면 AI 에게 나눠 달라고 한 뒤 고칠 수 있는 카드로
//   휴식       : 스트레칭 3가지 + 5분 타이머
//   자동 제안  : 할 일을 끝낸 직후 / 한동안 입력이 없을 때 / 앱을 열었을 때 — 20분에 한 번 이하
//
// 채팅 메시지는 state.chat 에 남고, 카드는 저장된 할 일·메모의 "현재 상태" 로 그린다(사본을 만들지 않음).

(function () {
  var DN = window.Daynote;
  var M = DN.model, D = DN.dates, S = DN.store, R = DN.recommend;
  var AS = DN.aiAssist;
  var MAX_MESSAGES = 200;
  var THINK_MS = 1000;   // AI 없이 답할 때도 이만큼 생각하는 척
  var IDLE_MIN = 3;
  var lastActivity = Date.now();
  var pending = {};   // 요청 중인 AI 작업

  function now() { return DN.app.now(); }

  function post(msg) {
    var m = Object.assign({ id: M.uid('msg'), at: now().toISOString(), role: 'assistant' }, msg);
    S.mutate(null, function (s) {
      if (!s.chat) s.chat = [];
      s.chat.push(m);
      if (s.chat.length > MAX_MESSAGES) s.chat.splice(0, s.chat.length - MAX_MESSAGES);
    }, { source: 'chat' });
    return m;
  }

  function update(id, patch) {
    S.mutate(null, function (s) {
      var m = M.byId(s.chat || [], id);
      if (m) Object.assign(m, patch);
    }, { source: 'chat' });
  }

  function aiReady() { return DN.aiFlow.status().configured; }

  function call(input) {
    return S.host.ai.organizeNote(input).catch(function (e) {
      return { ok: false, error: { type: 'ipc', message: e && e.message ? e.message : String(e), retryable: true } };
    }).then(function (res) { DN.aiFlow.recordUsage(res); res.exchangeId = DN.aiFlow.recordExchange(input, res); return res; });
  }

  function todayStr() { var n = now(); return D.ymd(n) + ' (' + D.WEEKDAYS[n.getDay()] + ')'; }

  // ------------------------------------------------------------------ 보내기
  function send(text, projectId) {
    text = String(text || '').trim();
    if (!text) return null;
    // 보낸 글 · 메모 저장 · AI 정리는 되돌리기 칸을 만들지 않는다 (AI 정리는 되돌리지 않는다)
    //   AI 가 알아들은 명령(마감 미루기 등)은 그 명령만 한 칸으로 되돌릴 수 있다
    var key = M.uid('send');
    var um = { id: M.uid('msg'), at: now().toISOString(), role: 'user', kind: 'text', text: text, pin: true };   // 보낸 글은 채팅 화면 맨 위로 올라가고 답이 그 아래에 붙는다
    S.mutate(null, function (s) {
      if (!s.chat) s.chat = [];
      s.chat.push(um);
      if (s.chat.length > MAX_MESSAGES) s.chat.splice(0, s.chat.length - MAX_MESSAGES);
    }, { source: 'chat' });
    // 자주 쓰는 짧은 명령("할 일 추천해줘", "쉬고 싶어", "캘린더 보여줘")은 AI 없이 바로 — 메모로 남기지 않는다
    var local = DN.aiCommands.matchLocal(S.state, text, focusTask(), now());
    if (local) {
      // AI 없이 알아들은 말도 1초쯤 생각하는 모습을 보인 뒤 답한다 (바로 튀어나오면 어색하다)
      var wait = post({ kind: 'thinking', text: '생각하는 중…' });
      setTimeout(function () {
        S.mutate(null, function (s) { s.chat = (s.chat || []).filter(function (x) { return x.id !== wait.id; }); }, { source: 'chat' });
        S.withJoin(key, function () { runCommand(local); });
      }, THINK_MS);
      return null;
    }
    var note = DN.capture.submit(text, projectId, function (r, noteId) {
      if (!r || !r.ok || !r.capture) return;
      var large = (r.capture.largeTasks || []).map(function (id) { return M.byId(S.state.tasks, id); }).filter(Boolean);
      if (large.length) {
        post({ kind: 'text', text: '‘' + large[0].title + '’' + (large.length > 1 ? ' 외 ' + (large.length - 1) + '개' : '') +
          '는 꽤 큰 일 같아요. 작은 단계로 나눠 둘게요 — 잠깐 여유 있을 때 보여 드릴게요.' });
      }
    }, { join: key });
    if (note) post({ kind: 'capture', noteId: note.id });
    return note;
  }

  // ------------------------------------------------------------------ 다음 할 일
  // opts: { minutes: 남는 시간(분), free: 남는 시간을 말했다, prepOnly: 준비할 일만 (자동 제안), intro }
  function next(skip, opts) {
    opts = opts || {};
    var r = R.recommend(S.state, { now: now(), skipIds: skip || [], workHours: S.state.prefs.workHours, availableMinutes: opts.minutes || null });
    var pick = opts.prepOnly ? r.prep[0] : r.primary;
    if (pick) {
      post({ kind: 'next', taskId: pick.taskId, step: pick.step ? pick.step.title : null, reasons: pick.reasons, skip: skip || [],
        prep: !!pick.prep, stepId: pick.prep ? pick.step.id : null, key: pick.key, prepLeft: r.prep.length,
        minutes: opts.minutes || null, free: !!opts.free, intro: opts.intro || null });
      return r;
    }
    if (opts.prepOnly) return r;   // 자동 제안 — 준비할 일이 없으면 조용히
    if (r.empty === 'all_skipped') { post({ kind: 'text', text: '추천할 후보를 모두 보여 드렸어요. 넘긴 할 일도 그대로 남아 있어요.' }); return r; }
    if (r.empty === 'time_short') { post({ kind: 'text', text: '남은 시간 안에 끝낼 수 있는 할 일이 없어요. 큰 일을 작게 나눠 볼까요?' }); breakdown(); return r; }
    // 지금 할 만한 일이 없어 보이면 — 자세히 적어 두면 좋을 할 일을 찾는다
    post({ kind: 'text', text: r.empty === 'no_tasks' ? '아직 할 일이 없어요. 생각나는 걸 편하게 적어 주세요.' : '지금 바로 시작할 할 일이 없어 보여요.' });
    if (r.empty !== 'no_tasks') elaborate();
    return r;
  }

  // ------------------------------------------------------------------ 작게 나누기
  function pickTaskToBreak() {
    var pend = AS.pendingBreakdowns(S.state, now());
    if (pend.length) return pend[0];
    var open = M.liveTasks(S.state).filter(function (t) { return t.status !== 'done' && t.status !== 'waiting' && !(t.steps || []).length && !(t.breakdown && t.breakdown.status === 'dismissed'); });
    open.sort(function (a, b) { return (b.estimateMinutes || 0) - (a.estimateMinutes || 0) || (a.dueDate || '9999').localeCompare(b.dueDate || '9999'); });
    return open[0] || null;
  }

  // ------------------------------------------------------------------ 작업 공간 (할 일을 채팅으로 끌어 놓기)
  // 작업 카드: 지금 시작 · 일시 정지 · 완료 · 작업 작게 나누기 · 다른 추천. 같은 할 일의 이전 카드는 접는다.
  function work(taskId) {
    var t = M.byId(S.state.tasks, taskId);
    if (!t || t.deletedAt) return null;
    S.mutate(null, function (s) {
      (s.chat || []).forEach(function (m) { if (m.kind === 'work' && m.taskId === taskId && !m.closed) m.closed = 'moved'; });
    }, { source: 'chat', silent: true });
    return post({ kind: 'work', taskId: taskId, pin: true });
  }
  // ------------------------------------------------------------------ 채팅 명령 실행
  // commands.js 가 알아들은(또는 AI 가 돌려준) 명령을 실제로 한다. 대상 할 일이 없으면 묻는다.
  var VIEW_LABEL = { today: '오늘', archive: '보관함', tasks: '할 일', calendar: '캘린더', projects: '프로젝트', weekly: '주간 정리', settings: '설정' };
  function runCommand(c) {
    var A = DN.app;
    var t = c.taskId ? M.byId(S.state.tasks, c.taskId) : null;
    if ((DN.aiCommands.NEEDS_TASK[c.action] && !t) || c.missing) {
      post({ kind: 'text', text: typeof c.missing === 'string' ? '‘' + c.missing + '’라는 할 일을 찾지 못했어요. 할 일 목록에서 채팅으로 끌어 와 주시면 그 일로 할게요.'
        : '어떤 할 일인지 알려 주세요. 할 일을 채팅으로 끌어 와도 돼요.' });
      return;
    }
    switch (c.action) {
      case 'recommend': next(null, { minutes: c.minutes || null, free: !!c.free }); break;
      case 'breakdown': breakdown(t ? t.id : null, null, { force: !!t }); break;
      case 'rest': rest(); break;
      case 'work': work(t.id); break;
      case 'start': A.startTask(t.id); work(t.id); break;
      case 'pause':
        if (t.status !== 'in_progress') post({ kind: 'text', text: '‘' + t.title + '’는 지금 진행 중이 아니에요.' });
        else { A.pauseTask(t.id); work(t.id); }   // 작업 카드에서 '이어서 할 첫 행동' 을 적을 수 있다
        break;
      case 'complete':
        if (t.status !== 'done') A.toggleDone(t.id);
        post({ kind: 'text', text: '‘' + t.title + '’ 완료했어요. 수고했어요!' });
        break;
      case 'return_todo': A.returnToTodo(t.id); post({ kind: 'text', text: '‘' + t.title + '’ 할 일로 돌려보냈어요.' }); break;
      case 'schedule': A.scheduleTask(t.id); break;
      case 'delete': A.deleteTask(t.id); post({ kind: 'text', text: '‘' + t.title + '’ 지웠어요. 알림의 되돌리기나 Ctrl+Z로 살릴 수 있어요.' }); break;
      case 'open':
        post({ kind: 'text', text: (VIEW_LABEL[c.view] || c.view) + (c.mode === 'week' ? '(주간)' : '') + ' 화면을 열었어요. 돌아오려면 사이드바의 ‘오늘’을 눌러 주세요.' });
        A.go(c.view, c.mode ? { mode: c.mode } : undefined);
        break;
      case 'search':
        if (DN.palette) DN.palette.open(c.query);
        break;
      case 'list_today': listToday(c.period); break;
      case 'day_close': dayClose(); break;
      case 'fix_ampm': fixAmPm(c.pm); break;
    }
  }
  // AI 가 글에서 읽은 명령 중 할 일 상태를 바꾸는 것 — 실행 전에 대상·바뀌는 내용을 보여 주고 묻는다
  //   ("민수가 '우유 사기 완료 처리해 달라'고 했다" 같은 인용을 명령으로 잘못 읽어도 그냥 실행되지 않게)
  //   AI 없이 알아들은 짧은 명령("완료 처리해 줘")은 작업 공간의 할 일에 바로 한다
  var CONFIRM = { complete: '완료로 표시', delete: '지우기', return_todo: '할 일로 되돌리기', start: '지금 시작', pause: '일시 정지', schedule: '일정에 넣기' };
  function needsConfirm(c) { return !!(c && CONFIRM[c.action] && c.taskId && !c.missing); }
  function askCommand(c) {
    var t = M.byId(S.state.tasks, c.taskId);
    post({ kind: 'confirm', cmd: { action: c.action, taskId: c.taskId }, title: t ? t.title : '', quote: c.quote || '', status: 'pending' });
  }
  function confirmCommand(msgId, yes) {
    var m = M.byId(S.state.chat || [], msgId);
    if (!m || m.status !== 'pending') return;
    update(msgId, { status: yes ? 'done' : 'cancelled' });
    if (yes) runCommand(m.cmd);
  }

  // 마감이 없던 할 일을 "하루 미뤄줘" — 오늘 기준 하루 뒤(내일)로 넣었다. 다른 날을 버튼으로 고른다 (Ctrl+Z 로도 되돌릴 수 있다)
  function askDate(taskId, at) {
    var base = D.ymd(at || now());
    var t = M.byId(S.state.tasks, taskId);
    post({ kind: 'pickdate', taskId: taskId, title: t ? t.title : '', base: base, chosen: t && t.dueDate || D.ymd(D.addDays(D.parseYmd(base), 1)) });
  }
  function pickDate(msgId, ymd) {
    var m = M.byId(S.state.chat || [], msgId);
    var t = m && M.byId(S.state.tasks, m.taskId);
    if (!t || t.deletedAt) return;
    S.mutate('마감 바꾸기', function (st) {
      M.updateTask(st, t.id, { dueDate: ymd }, now());
      var mm = M.byId(st.chat || [], msgId);
      if (mm) mm.chosen = ymd;
    }, { source: 'chat' });
  }

  // "아니 오후야" — 방금(30분 안) 채팅으로 넣은 일정·작업 시간 중 마지막 것의 오전/오후를 바꾼다 (Ctrl+Z 로 되돌릴 수 있다)
  function fixAmPm(pm) {
    var n = now();
    var cands = DN.aiProposals.recentCreated(S.state, n).map(function (r) {
      if (r.kind === 'block') return { title: r.item.title || '일정', block: r.item };
      var w = M.blocksForTask(S.state, r.item.id).filter(function (b) { return b.kind === 'work'; }).pop();
      return w ? { title: r.item.title, block: w } : null;
    }).filter(Boolean);
    var last = cands[cands.length - 1];
    if (!last) { post({ kind: 'text', text: '고칠 만한 방금 적은 일정이 없어요. 어떤 일정인지 함께 적어 주세요 (예: "기도회 오후 8시야").' }); return; }
    var b = last.block, h0 = new Date(b.start).getHours();
    var shift = pm && h0 < 12 ? 12 : !pm && h0 >= 12 ? -12 : 0;
    if (!shift) { post({ kind: 'text', text: '‘' + last.title + '’는 이미 ' + (pm ? '오후' : '오전') + ' ' + D.hm(b.start) + '이에요.' }); return; }
    var s = D.addMinutes(new Date(b.start), shift * 60), e = D.addMinutes(new Date(b.end), shift * 60);
    S.mutate('오전/오후 고치기', function (st) { M.updateBlock(st, b.id, { start: s.toISOString(), end: e.toISOString() }); }, { source: 'chat' });
    post({ kind: 'text', text: '‘' + last.title + '’ 시각을 고쳤어요 → ' + D.relDay(D.ymd(s), n) + ' ' + D.hm(s) + ' (' + (pm ? '오후' : '오전') + '). 되돌리려면 Ctrl+Z.' });
  }

  // "오늘 할 일 뭐야?" — 오늘 할 일을 채팅에 요약
  function listToday(period) {
    var n = now();
    // "내일 아침" · "이번 주 남은 일" · "다음 주" — 그 기간의 할 일·일정을 날짜별로 (오늘 전체는 아래 오늘 목록 그대로)
    if (period && !(period.from === D.ymd(n) && period.to === period.from && !period.part)) { listPeriod(period, n); return; }
    var list = DN.aiCommands.todayTasks(S.state, n);
    var events = S.state.blocks.filter(function (b) { return b.kind === 'event' && DN.dates.ymd(b.start) === DN.dates.ymd(n) && new Date(b.end) > n; })
      .sort(function (a, b) { return a.start < b.start ? -1 : 1; });
    if (!list.length && !events.length) { post({ kind: 'text', text: '오늘은 남은 할 일도 일정도 없어요. 쉬어 가도 좋겠어요.' }); return; }
    var lines = [];
    if (list.length) {
      lines.push('오늘 할 일 ' + list.length + '개예요.');
      list.slice(0, 8).forEach(function (t) {
        var tag = t.status === 'in_progress' ? ' (진행 중)' : t.status === 'paused' ? ' (일시 정지)' : '';
        var due = t.dueDate ? ' · 마감 ' + DN.dates.relDay(t.dueDate, n) + (t.dueTime ? ' ' + t.dueTime : '') + ' · ' + DN.dates.remainText(DN.dates.dueAt(t.dueDate, t.dueTime), n) : '';
        lines.push('• ' + t.title + tag + due);
      });
      if (list.length > 8) lines.push('… 외 ' + (list.length - 8) + '개');
    }
    if (events.length) {
      lines.push('남은 일정: ' + events.map(function (b) { return DN.dates.hm(b.start) + ' ' + b.title; }).join(', '));
    }
    post({ kind: 'text', text: lines.join('\n'), actions: list.length ? ['next'] : [] });
  }

  var AG_TAG = { work: '', due: '마감', plan: '할 날', doing: '진행 중', late: '마감 지남', event: '일정' };
  function listPeriod(p, n) {
    var days = DN.aiCommands.agenda(S.state, p, n);
    var one = p.from === p.to;
    var dayName = function (k) { var d = D.parseYmd(k); var r = D.relDay(k, n); return /^(오늘|내일|모레)$/.test(r) ? r + '(' + D.WEEKDAYS[d.getDay()] + ')' : (d.getMonth() + 1) + '/' + d.getDate() + ' (' + D.WEEKDAYS[d.getDay()] + ')'; };
    var title = one ? dayName(p.from) + (p.part ? ' ' + p.part.label : '') : p.label;
    var count = days.reduce(function (a, d) { return a + d.items.length; }, 0);
    var line = function (it) {
      var name = it.task ? it.task.title : (it.block.title || '일정');
      var tag = it.kind === 'due' ? '마감' + (it.at ? ' ' + it.at : '') : it.kind === 'late' ? '마감 지남 ' + it.task.dueDate.slice(5).replace('-', '/') : AG_TAG[it.kind];
      return '• ' + (it.at && it.kind !== 'due' ? it.at + ' ' : '') + name + (tag ? ' · ' + tag : '');
    };
    var lines = [];
    if (!count) {
      lines.push((one ? title : p.label === '이번 주 남은' ? '이번 주 남은 날' : p.label) + '에는 잡힌 할 일·일정이 없어요.');
    } else {
      lines.push(title + ' 할 일·일정 ' + count + '개예요.');
      var shown = 0;
      days.forEach(function (d) {
        if (shown >= 15) return;
        if (!one) lines.push(dayName(d.ymd));
        d.items.forEach(function (it) { if (shown++ < 15) lines.push(line(it)); });
      });
      if (count > 15) lines.push('… 외 ' + (count - 15) + '개');
    }
    // 여러 날을 물었으면 날짜 없는 할 일도 알려 준다 (그중에서 골라 드릴 수 있게)
    var undated = !one ? M.liveTasks(S.state).filter(function (t) { return t.status !== 'done' && !t.dueDate && !t.planDate && !M.blocksForTask(S.state, t.id).length; }).length : 0;
    if (undated) lines.push('날짜를 안 정한 할 일도 ' + undated + '개 있어요.');
    post({ kind: 'text', text: lines.join('\n'), actions: ['next'] });
  }

  // 지금 작업 공간에 올라 있는 할 일 — 가장 최근의 접히지 않은 작업 카드 (끝낸·지운 일은 빼고)
  function focusTask() {
    var chat = S.state.chat || [];
    for (var i = chat.length - 1; i >= 0; i--) {
      var m = chat[i];
      if (m.kind !== 'work' || m.closed) continue;
      var t = M.byId(S.state.tasks, m.taskId);
      if (t && !t.deletedAt && t.status !== 'done') return t;
    }
    return null;
  }
  // 작업 카드를 할 일 목록으로 끌어 놓으면 — 할 일로 돌려보내고 카드는 접는다
  function returnWork(msgId) {
    var m = M.byId(S.state.chat || [], msgId);
    if (!m || m.kind !== 'work') return;
    var t = M.byId(S.state.tasks, m.taskId);
    if (t && (t.status === 'in_progress' || t.status === 'paused')) DN.app.returnToTodo(t.id);
    update(msgId, { closed: 'returned' });
  }

  // opts.force: 사용자가 직접 '작업 작게 나누기' 를 눌렀다 — 작은 일이어도 AI 초안을 보여 준다 (고쳐서 쓰게)
  function breakdown(taskId, intro, opts) {
    var t = taskId ? M.byId(S.state.tasks, taskId) : pickTaskToBreak();
    if (!t) { post({ kind: 'text', text: '나눌 만한 할 일이 없어요.' }); return; }
    if (t.breakdown && (t.breakdown.status === 'pending' || t.breakdown.status === 'later') && t.breakdown.steps && t.breakdown.steps.length) {
      S.mutate(null, function (s) { AS.markShown(s, t.id, now()); }, { source: 'chat', silent: true });
      post({ kind: 'breakdown', taskId: t.id, intro: intro || null, draft: t.breakdown.steps.map(function (x) { return { title: x.title, minutes: x.minutes }; }) });
      return;
    }
    if (!aiReady()) {
      post({ kind: 'breakdown', taskId: t.id, intro: 'AI가 연결되어 있지 않아 직접 나눠 볼 수 있게 칸을 준비했어요.', draft: [{ title: '', minutes: 15 }, { title: '', minutes: null }, { title: '', minutes: null }] });
      return;
    }
    if (pending['bd:' + t.id]) return;
    pending['bd:' + t.id] = true;
    var wait = post({ kind: 'thinking', job: 'bd:' + t.id, taskId: t.id, text: '‘' + t.title + '’를 작은 단계로 나눠 보는 중이에요…' });
    var proj = t.projectId && M.byId(S.state.projects, t.projectId);
    call(AS.BREAKDOWN.buildInput(t, { today: todayStr(), projectName: proj && proj.name })).then(function (res) {
      delete pending['bd:' + t.id];
      var v = res.ok ? AS.validateBreakdown(res.output) : null;
      if (!v || !v.ok) {
        update(wait.id, { kind: 'text', text: '단계를 나누지 못했어요. ' + (res.error ? res.error.message : '응답 형식이 맞지 않았어요.') + ' 직접 나눠 볼 수 있게 칸을 준비했어요.' });
        post({ kind: 'breakdown', taskId: t.id, draft: [{ title: '', minutes: 15 }, { title: '', minutes: null }] });
        return;
      }
      if (!v.isLarge && (opts && opts.force && v.steps.length)) v.isLarge = true;
      if (!v.isLarge) { update(wait.id, { kind: 'text', text: '‘' + t.title + '’는 이미 충분히 작은 일 같아요. 바로 시작해 봐도 좋겠어요.' }); return; }
      S.mutate(null, function (s) { AS.storeBreakdown(s, t.id, v, 'button', now()); AS.markShown(s, t.id, now()); }, { source: 'chat' });
      update(wait.id, { kind: 'breakdown', taskId: t.id, intro: intro || null, reason: v.reason, draft: v.steps, usage: res.usage || null, model: res.model || null, exchangeId: res.exchangeId || null });
    });
  }

  // 준비 하나 해 뒀어요 — 그 세부 할 일을 체크 (카드는 할 일의 지금 상태로 다시 그려진다)
  function donePrep(taskId, stepId) {
    var t = M.byId(S.state.tasks, taskId);
    var st = t && DN.steps.find(t.steps || [], stepId);
    if (!st || st.done) return;
    S.mutate('준비 해 둠', function (s) {
      var tt = M.byId(s.tasks, taskId);
      if (tt) M.updateTask(s, taskId, { steps: DN.steps.toggle(tt.steps || [], stepId) }, now());
    }, { source: 'chat' });
  }

  function applyBreakdown(msgId, taskId, steps) {
    var t = S.mutate('단계 나누기', function (s) { return AS.applyBreakdown(s, taskId, steps, now()); }, { source: 'chat' });
    if (!t) { DN.ui.toast('적을 단계가 없어요. 한 줄 이상 적어 주세요.'); return false; }
    update(msgId, { resolved: 'applied', resolvedCount: steps.filter(function (x) { return x.title && x.title.trim(); }).length });
    return true;
  }

  function deferBreakdown(msgId, taskId, mode) {
    S.mutate(mode === 'never' ? '단계 나누기 건너뜀' : null, function (s) { AS.deferBreakdown(s, taskId, mode, now()); }, { source: 'chat' });
    update(msgId, { resolved: mode === 'never' ? 'never' : 'later' });
  }

  // ------------------------------------------------------------------ 자세히 적기
  function elaborate(candidateIds, intro) {
    var cands = candidateIds ? candidateIds.map(function (id) { return M.byId(S.state.tasks, id); }).filter(Boolean) : AS.elaborateCandidates(S.state, now());
    if (!cands.length) { if (!candidateIds) post({ kind: 'text', text: '자세히 적어 둘 만한 할 일도 없어요. 잠깐 쉬어 가도 좋겠어요.', actions: ['rest'] }); return; }
    if (!aiReady()) { post({ kind: 'elaborate', intro: intro || null, picks: [AS.localElaboratePick(cands[0])] }); return; }
    if (pending.el) return;
    pending.el = true;
    var wait = post({ kind: 'thinking', job: 'el', text: '자세히 적어 두면 좋을 할 일을 찾는 중이에요…' });
    call(AS.ELABORATE.buildInput(cands, { today: todayStr() })).then(function (res) {
      delete pending.el;
      var v = res.ok ? AS.validateElaborate(res.output, cands.map(function (t) { return t.id; })) : null;
      var picks = v && v.ok && v.picks.length ? v.picks : [AS.localElaboratePick(cands[0])];
      update(wait.id, { kind: 'elaborate', intro: intro || null, picks: picks, usage: res.ok ? res.usage || null : null, model: res.ok ? res.model || null : null, exchangeId: res.exchangeId || null });
    });
  }

  function saveElaboration(msgId, taskId, text) {
    var t = S.mutate('할 일 자세히 적기', function (s) { return AS.saveElaboration(s, taskId, text, now()); }, { source: 'chat' });
    if (!t) return false;
    var m = M.byId(S.state.chat, msgId);
    var done = Object.assign({}, (m && m.done) || {}); done[taskId] = 'saved';
    update(msgId, { done: done });
    return true;
  }
  function skipElaboration(msgId, taskId) {
    S.mutate(null, function (s) { AS.skipElaboration(s, taskId, now()); }, { source: 'chat' });
    var m = M.byId(S.state.chat, msgId);
    var done = Object.assign({}, (m && m.done) || {}); done[taskId] = 'skipped';
    update(msgId, { done: done });
  }

  // ------------------------------------------------------------------ 휴식
  // ------------------------------------------------------------------ 연구 기반 도움들 (src/core/habits.js)
  // 하루 마무리 — 오늘 끝낸 일을 보여 주고(작은 성취), 남은 일마다 다음 시각을 정한다(계획이 잔상을 없앤다)
  function dayClose() {
    var HB = DN.habits;
    var r = HB.dayClose(S.state, now(), DN.aiCommands.todayTasks(S.state, now()));
    S.mutate(null, function (s) { s.meta.dayCloseOffered = DN.dates.ymd(now()); }, { source: 'chat', silent: true });
    post({ kind: 'dayclose', doneIds: r.done.map(function (t) { return t.id; }), taskIds: r.left.map(function (t) { return t.id; }), picked: {} });
  }
  // 밀린 일 — 탓하지 않고 한 번에 다시 정하기 (자기 용서가 다음 미루기를 줄인다)
  function overdueOffer() {
    var list = DN.habits.overdueTasks(S.state, now());
    if (!list.length) { post({ kind: 'text', text: '밀린 일이 없어요.' }); return; }
    post({ kind: 'overdue', taskIds: list.map(function (t) { return t.id; }) });
  }
  function replan(taskIds, intro) { post({ kind: 'dayclose', replan: true, intro: intro || null, doneIds: [], taskIds: taskIds, picked: {} }); }
  // 새 주 시작 — 이번 주 꼭 끝낼 일 3가지 (새 출발 효과)
  function weekStart() {
    var open = M.liveTasks(S.state).filter(function (t) { return t.status !== 'done'; })
      .sort(function (a, b) { return (a.dueDate || '9999') < (b.dueDate || '9999') ? -1 : 1; }).slice(0, 10);
    S.mutate(null, function (s) { s.meta.weekStartOffered = DN.habits.weekKey(now()); }, { source: 'chat', silent: true });
    if (open.length) post({ kind: 'weekstart', taskIds: open.map(function (t) { return t.id; }) });
  }
  // 할 일 하나를 정한 때에 놓는다 — 그때부터 빈 시간에 (예상 시간, 없으면 30분)
  function planAt(taskId, at) {
    var t = M.byId(S.state.tasks, taskId);
    if (!t) return null;
    var minutes = Math.max(15, Math.min(240, t.estimateMinutes || 30));
    var start = DN.views.schedule.findFreeSlot(S.state, at, minutes);
    S.mutate('다음 시각 정하기', function (s) {
      M.addBlock(s, { taskId: taskId, kind: 'work', start: start.toISOString(), end: DN.dates.addMinutes(start, minutes).toISOString(), origin: 'user' });
    });
    return start;
  }
  // 오래 집중했으면 쉬어 가기 권하기 (50분, 미세 휴식) — 쓰는 중·일정 중에는 묻지 않는다
  function checkLongFocus() {
    if (DN.rest && DN.rest.isOpen()) return;
    if (S.state.meta.focus) return;   // 집중 타이머가 끝나면 그쪽에서 쉬기를 권한다
    var t = DN.habits.longFocus(S.state, now());
    if (!t) return;
    var last = S.state.meta.lastRestNudgeAt;
    if (last && now() - new Date(last) < DN.habits.LONG_FOCUS_MIN * 60000) return;
    var input = document.querySelector('.chat-input textarea');
    if (input && document.activeElement === input && input.value.trim()) return;
    if (!DN.app || DN.app.current().view !== 'today') return;
    S.mutate(null, function (s) { s.meta.lastRestNudgeAt = now().toISOString(); }, { source: 'chat', silent: true });
    post({ kind: 'text', text: '‘' + t.title + '’에 ' + DN.habits.LONG_FOCUS_MIN + '분 넘게 집중했어요. 3분만 쉬어 가면 다음 집중이 더 잘 돼요.', actions: ['rest'] });
    DN.ui.osNotify('잠깐 쉬어 갈까요?', '‘' + t.title + '’에 ' + DN.habits.LONG_FOCUS_MIN + '분 넘게 집중했어요. 3분만 쉬어요.');
  }

  // 일한 흐름 — 50분쯤 이어서 일한 뒤 할 일·단계를 끝내면 쉬기를 권한다 (일이 끝나는 지점에서)
  var workRun = null;
  function touchWork() { workRun = DN.habits.touchWork(workRun, now()); }
  function rested() { workRun = null; }
  function doneCount(st) {
    return M.liveTasks(st).reduce(function (n, t) {
      return n + (t.status === 'done' ? 1 : 0) + DN.steps.count(t.steps).done;
    }, 0);
  }
  // 끝낸 직후 — 쉴 때가 됐으면 쉬기를, 아니면 (할 일을 끝냈을 때) 평소 제안
  function afterBoundary(taskDone, title) {
    if (DN.rest && DN.rest.isOpen()) return;
    var meta = S.state.meta;
    if (!meta.focus && DN.habits.restDue(workRun, now(), meta.lastRestNudgeAt)) {
      var input = document.querySelector('.chat-input textarea');
      if (!(input && document.activeElement === input && input.value.trim())) {
        var mins = DN.habits.workRunMinutes(workRun, now());
        S.mutate(null, function (s) { s.meta.lastRestNudgeAt = now().toISOString(); }, { source: 'chat', silent: true });
        post({ kind: 'text', text: (taskDone ? (title ? '‘' + title + '’ 끝! ' : '하나 끝냈어요! ') : '단계 하나 끝냈어요. ') +
          DN.dates.duration(mins) + ' 이어서 일했어요. 일이 끝난 지금이 쉬기 좋은 때예요 — ' + DN.habits.REST_DEFAULT_MIN + '분 쉬어 갈까요?', actions: ['rest'] });
        return;
      }
    }
    if (taskDone) tryNudge('completed');
  }

  // 집중 타이머 — 25분 집중 → 종소리 → 쉬러 가기 권하기 (정해 둔 휴식이 피로를 줄인다, Biwer 외 2023)
  //   네 번째마다 조금 길게(15분) 쉬기를 권한다. 상태는 meta.focus (앱을 다시 켜도 이어진다)
  var FOCUS_MIN = 25;
  var focusTimer = null;
  function startFocus(taskId, minutes) {
    var t = M.byId(S.state.tasks, taskId);
    if (!t) return;
    if (t.status !== 'in_progress') DN.app.startTask(taskId);
    var mins = minutes || FOCUS_MIN;
    var start = now(), end = new Date(Date.now() + mins * 60000);   // 블록은 앱 시계, 타이머는 실제 시계
    // 집중 시간은 캘린더에도 — 그 시간은 '빈 시간' 이 아니다 (Microsoft Focus Time 2023)
    S.mutate(null, function (s) {
      var b = M.addBlock(s, { taskId: taskId, title: t.title, start: start.toISOString(), end: new Date(start.getTime() + mins * 60000).toISOString(), origin: 'focus' });
      s.meta.focus = { taskId: taskId, end: end.toISOString(), minutes: minutes || FOCUS_MIN, blockId: b.id };
    }, { source: 'chat' });
    armFocus();
  }
  // 그만 — 캘린더 블록은 지금까지로 줄인다 (5분이 안 되면 지운다)
  function stopFocus() {
    clearTimeout(focusTimer);
    S.mutate(null, function (s) {
      var f = s.meta.focus;
      var b = f && f.blockId && M.byId(s.blocks, f.blockId);
      if (b) {
        var nowIso = now().toISOString();
        if (new Date(nowIso) - new Date(b.start) < 5 * 60000) M.deleteBlock(s, b.id);
        else if (b.end > nowIso) M.updateBlock(s, b.id, { end: nowIso });
      }
      s.meta.focus = null;
    }, { source: 'chat' });
  }
  function armFocus() {
    clearTimeout(focusTimer);
    var f = S.state.meta.focus;
    if (!f) return;
    focusTimer = setTimeout(endFocus, Math.max(0, new Date(f.end) - Date.now()) + 200);
  }
  function endFocus() {
    var f = S.state.meta.focus;
    if (!f || new Date(f.end) > new Date(Date.now() + 1000)) return;
    var t = M.byId(S.state.tasks, f.taskId);
    var today = DN.dates.ymd(now());
    var cnt = 0;
    S.mutate(null, function (s) {
      s.meta.focus = null;
      var c = s.meta.focusCount && s.meta.focusCount.day === today ? s.meta.focusCount.n : 0;
      cnt = c + 1;
      s.meta.focusCount = { day: today, n: cnt };
    }, { source: 'chat' });
    if (DN.rest && DN.rest.chime) DN.rest.chime();
    var longBreak = cnt % 4 === 0;
    var msg = f.minutes + '분 집중했어요 (오늘 ' + cnt + '번째). ' + (longBreak ? '네 번 했으니 15분쯤 길게 쉬어 가요.' : '3분 쉬어 가면 다음 집중이 더 잘 돼요.');
    post({ kind: 'text', text: (t ? '‘' + t.title + '’에 ' : '') + msg, actions: ['rest'] });
    DN.ui.osNotify('집중 끝' + (t ? ' — ' + t.title : ''), msg, { sound: true });
  }

  // 휴식 — 앱 전체를 가리는 휴식 화면 (renderer/rest.js). 모드를 주지 않으면 쉬기 전 화면에서 고른다
  function rest(mode) {
    if (DN.rest) DN.rest.open({ mode: mode });
    else post({ kind: 'rest', stretches: AS.pickStretches(3, Date.now()), timerEnd: null });
  }
  function startTimer(msgId, minutes) {
    var end = new Date(Date.now() + minutes * 60000).toISOString();
    update(msgId, { timerEnd: end, timerDone: false });
    setTimeout(function () { finishTimer(msgId); }, minutes * 60000 + 200);
  }
  function finishTimer(msgId) {
    var m = M.byId(S.state.chat || [], msgId);
    if (!m || m.timerDone || !m.timerEnd || new Date(m.timerEnd) > new Date(Date.now() + 1000)) return;
    update(msgId, { timerDone: true });
    post({ kind: 'text', text: '휴식 끝! 다시 시작해 볼까요?', actions: ['next'] });
    DN.ui.toast('5분 휴식이 끝났어요.');
  }

  // ------------------------------------------------------------------ 자동 제안 ("잠깐 여유 있을 때")
  function tryNudge(reason) {
    if (!DN.app || DN.app.current().view !== 'today') return;
    if (S.state.meta.focus) return;   // 집중하는 동안에는 제안을 미룬다 (끝나면 다음 끊는 지점에서 — Iqbal & Bailey 2008)
    if (DN.rest && DN.rest.isOpen()) return;   // 쉬는 동안에는 아무것도 묻지 않는다
    var input = document.querySelector('.chat-input textarea');
    if (input && document.activeElement === input && input.value.trim()) return;   // 쓰는 중에는 끼어들지 않는다
    var cal = R.calendarContext(S.state, now());
    if (cal.busyWith) return;                                                         // 일정 중에는 묻지 않는다
    var lastCaptureAt = S.state.notes.reduce(function (m, x) { return x.capture && x.capture.at && x.capture.at > m ? x.capture.at : m; }, '') || null;
    var nowD = now(), today = DN.dates.ymd(nowD), meta = S.state.meta;
    var recentCapture = lastCaptureAt && nowD - new Date(lastCaptureAt) < 10 * 60000;
    if (reason === 'open' && !recentCapture) {
      if (DN.habits.shouldOfferWeekStart(S.state, nowD) && nowD.getDay() >= 1 && nowD.getDay() <= 3) { weekStart(); return; }
      if (meta.overdueOffered !== today && DN.habits.overdueTasks(S.state, nowD).length >= 3) {
        S.mutate(null, function (s) { s.meta.overdueOffered = today; }, { source: 'chat', silent: true });
        overdueOffer(); return;
      }
    }
    // 저녁(17:30 이후) 여유 있을 때 하루에 한 번 — 하루 마무리
    if ((reason === 'idle' || reason === 'open') && !recentCapture && meta.dayCloseOffered !== today &&
        nowD.getHours() * 60 + nowD.getMinutes() >= 17 * 60 + 30 && DN.aiCommands.todayTasks(S.state, nowD).length) {
      post({ kind: 'text', text: '하루를 마무리할 시간이에요. 남은 일에 다음 시각을 정해 두면 마음 편히 쉴 수 있어요.' });
      dayClose(); return;
    }
    // 최근 채팅에 이미 띄운 준비 카드는 다시 권하지 않는다
    var shownPrep = (S.state.chat || []).slice(-30).filter(function (m) { return m.kind === 'next' && m.prep && m.key; }).map(function (m) { return m.key; });
    var n = AS.nextNudge(S.state, { now: now(), reason: reason, lastNudgeAt: S.state.meta.lastNudgeAt, lastNudgeType: S.state.meta.lastNudgeType, lastCaptureAt: lastCaptureAt, workHours: S.state.prefs.workHours, shownPrep: shownPrep });
    if (!n) return;
    S.mutate(null, function (s) { s.meta.lastNudgeAt = now().toISOString(); s.meta.lastNudgeType = n.type; }, { source: 'chat', silent: true });
    var intro = reason === 'completed' ? '하나 끝내셨네요. 한숨 돌리는 김에 —' : reason === 'idle' ? '잠깐 여유가 있어 보여서요 —' : '다시 오셨네요 —';
    if (n.type === 'prep') next(shownPrep, { prepOnly: true, intro: intro + ' 미리 해 두면 좋은 준비가 있어요.' });
    else if (n.type === 'breakdown') breakdown(n.taskId, intro + ' 아까 큰 일로 보여서 나눠 둔 단계가 있어요. 이렇게 세분화해 보면 어떨까요?');
    else elaborate(n.candidates, intro + ' 할 일 중에 조금 더 자세히 적어 두면 시작하기 쉬운 게 있어요.');
  }

  // 되돌리기·다시 실행·앱 다시 켜기 뒤에 기다리는 요청이 없는 '…하는 중이에요' 말풍선 풀기 (거기서 멈춰 보이지 않게)
  function settleThinking(why) {
    var stuck = (S.state.chat || []).filter(function (m) { return m.kind === 'thinking' && !(m.job && pending[m.job]); });
    if (stuck.length) {
      S.mutate(null, function (s) {
        stuck.forEach(function (x) {
          var m = M.byId(s.chat || [], x.id);
          if (m) Object.assign(m, { kind: 'text', text: (why === 'load' ? '앱이 닫혀서 끝내지 못했어요.' : '되돌리기로 멈췄어요.') +
            (x.taskId ? ' 다시 하려면 할 일을 채팅으로 가져와 [작업 작게 나누기]를 눌러 주세요.' : '') });
        });
      }, { source: 'chat' });
    }
    armFocus();   // 집중 타이머가 되돌아왔으면 다시 맞추고, 이미 지났으면 바로 끝 알림
  }

  // 정리 결과 한 줄 — 빠른 메모 창에 보여 줄 것
  function quickSummary(n) {
    var c = n.capture || {};
    if (c.status === 'failed' || c.status === 'no_ai') return '메모로 저장했어요';
    var items = DN.aiProposals.captureItems(S.state, n).filter(function (it) { return it.ref.kind !== 'note'; });
    if (!items.length) return '메모로 저장했어요';
    var it = items[0], x = it.item || {};
    var label = it.kind === 'task' ? '할 일' : it.kind === 'event' ? '일정' : it.kind === 'done' ? '완료' : it.kind === 'moved' ? '날짜 변경' : '메모';
    var when = it.kind === 'event' && x.start ? ' · ' + DN.dates.relDay(DN.dates.ymd(x.start), now()) + ' ' + DN.dates.hm(x.start)
      : x.dueDate ? ' · ' + DN.dates.relDay(x.dueDate, now()) + ' 마감' : x.planDate ? ' · ' + DN.dates.relDay(x.planDate, now()) + '에 하기' : '';
    return label + when + ' — ' + (x.title || '') + (items.length > 1 ? ' 외 ' + (items.length - 1) + '개' : '');
  }

  var watching = false;
  var quickKey = null;   // 빠른 메모 단축키 (데스크톱 앱에서 등록됐을 때만)
  function watch() {
    if (watching) return;
    watching = true;
    ['keydown', 'mousedown', 'wheel'].forEach(function (ev) { document.addEventListener(ev, function () { lastActivity = Date.now(); }, true); });
    var lastDone = doneCount(S.state);
    settleThinking('load');
    S.subscribe(function (info) {
      if (info.type === 'undo' || info.type === 'redo') settleThinking(info.type);
      var n = doneCount(S.state);
      var more = info.type === 'change' && n > lastDone;
      lastDone = n;
      if (info.type !== 'change' || info.source === 'rest' || info.source === 'calendar') return;   // 쉬기·캘린더 가져오기는 '일한 것' 이 아니다
      touchWork();
      if (!more) return;
      var doneTask = M.liveTasks(S.state).filter(function (t) { return t.status === 'done' && t.completedAt; })
        .sort(function (a, b) { return a.completedAt < b.completedAt ? 1 : -1; })[0];
      var taskDone = info.label === '완료' || (doneTask && now() - new Date(doneTask.completedAt) < 5000);
      setTimeout(function () { afterBoundary(taskDone, taskDone && doneTask ? doneTask.title : null); }, 1500);
    });
    setInterval(function () {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastActivity >= IDLE_MIN * 60000) { lastActivity = Date.now(); tryNudge('idle'); }
    }, 30000);
    setTimeout(function () { tryNudge('open'); }, 8000);
    setInterval(function () {
      // 진행 중인 일이 있으면 일하는 중 (화면을 안 보고 있어도)
      if (M.liveTasks(S.state).some(function (t) { return t.status === 'in_progress'; })) touchWork();
      if (document.visibilityState === 'visible') checkLongFocus();
    }, 60000);
    armFocus();   // 앱을 다시 켰을 때 집중 타이머 이어서 (이미 지났으면 바로 끝 알림)
    // 빠른 메모 창(Ctrl+Shift+Space)에서 보낸 글 — 홈 입력과 똑같이 흐름에 올리고 분류한다
    var host = S.host;
    if (host.onQuickCapture) host.onQuickCapture(function (text) {
      if (!text.trim()) return;
      var note = send(text);
      if (!host.quickResult) return;
      if (!note) { host.quickResult('바로 실행했어요'); return; }
      // 정리가 끝나면 "할 일 · 내일 마감 — 견적서 보내기" 처럼 한 줄 (최대 10초 기다림)
      var tries = 0;
      (function wait() {
        var n = M.byId(S.state.notes, note.id);
        var c = n && n.capture;
        if (c && c.status !== 'pending') { host.quickResult(quickSummary(n)); return; }
        if (++tries < 40) setTimeout(wait, 250);
      })();
    });
    if (host.setCloseToTray) host.setCloseToTray(S.state.prefs.closeToTray !== false);
    if (host.ready) host.ready().then(function (r) { quickKey = r && r.quickKey; }).catch(function () {});
    // 꺼져 있는 동안 끝난 휴식 타이머 정리
    (S.state.chat || []).forEach(function (m) { if (m.kind === 'rest' && m.timerEnd && !m.timerDone) setTimeout(function () { finishTimer(m.id); }, Math.max(0, new Date(m.timerEnd) - Date.now()) + 200); });
  }

  document.addEventListener('DOMContentLoaded', function () {
    S.whenReady(watch);
  });

  DN.assistant = {
    send: send, next: next, donePrep: donePrep, breakdown: breakdown, applyBreakdown: applyBreakdown, deferBreakdown: deferBreakdown,
    elaborate: elaborate, saveElaboration: saveElaboration, skipElaboration: skipElaboration,
    rest: rest, startTimer: startTimer, tryNudge: tryNudge, update: update, post: post, work: work, returnWork: returnWork, focusTask: focusTask, runCommand: runCommand,
    needsConfirm: needsConfirm, askCommand: askCommand, confirmCommand: confirmCommand, CONFIRM_LABEL: CONFIRM, askDate: askDate, pickDate: pickDate,
    rested: rested, startFocus: startFocus, stopFocus: stopFocus, dayClose: dayClose, overdueOffer: overdueOffer, replan: replan, weekStart: weekStart, planAt: planAt, checkLongFocus: checkLongFocus,
    quickKey: function () { return quickKey; }
  };
})();
