'use strict';

// Ctrl+K — 검색·명령 팔레트.
//   빈 칸이면 자주 쓰는 명령 + 최근 항목 5개를 보여 준다.
//   글자를 치면 명령 · 할 일 · 메모 · 일정 · 프로젝트를 한꺼번에 찾는다 (포함 검색, 대소문자 무시).
//   ↑/↓ 로 고르고 Enter 로 실행, Esc 로 닫는다. 마우스로도 된다.
// 메모 편집기 안에서는 Ctrl+K 가 '링크 넣기' 라서 팔레트를 열지 않는다.

(function () {
  var DN = window.Daynote;
  var M = DN.model, D = DN.dates, S = DN.store, ui = DN.ui, h = ui.h;
  var PER_GROUP = 6;
  var RECENT = 5;
  var cur = null;   // { overlay, input, list, options, active, prevFocus }

  function now() { return DN.app.now(); }
  function norm(s) { return String(s || '').toLowerCase(); }

  function focusInput() {
    setTimeout(function () { var x = document.querySelector('.chat-input textarea'); if (x) x.focus(); }, 30);
  }

  function setTheme(t) {
    S.mutate(null, function (s) { if (t === 'system') delete s.prefs.theme; else s.prefs.theme = t; }, { silent: true });
    DN.app.applyPrefs();
  }

  // ------------------------------------------------------------------ 명령
  function commands() {
    var A = DN.app;
    var theme = S.state.prefs.theme === 'light' || S.state.prefs.theme === 'dark' ? S.state.prefs.theme : 'system';
    var out = [
      { group: '명령', icon: 'edit', label: '새로 적기', sub: '오늘 화면 입력창으로', words: '새 메모 할 일 일정 입력 쓰기 추가 적어 두기', run: function () { A.go('today'); focusInput(); } }
    ];
    A.nav().forEach(function (n) {
      out.push({ group: '이동', icon: n.icon, label: n.label, sub: '화면으로 이동', keys: 'Alt+' + n.key, words: '이동 화면 열기 ' + n.id, run: function () { A.go(n.id); } });
    });
    out.push({ group: '이동', icon: 'note', label: '메모 목록', sub: '메모 편집 화면', words: '이동 메모 편집 노트 notes', run: function () { A.go('notes'); } });
    out.push({ group: '이동', icon: 'inbox', label: '새 할 일 제안', sub: '메일·메모에서 찾은 제안', words: '이동 제안 메일 inbox 추천함', run: function () { A.go('inbox'); } });
    [['system', '시스템 설정 따르기'], ['light', '밝게'], ['dark', '어둡게']].forEach(function (t) {
      out.push({ group: '명령', icon: 'theme', label: '테마: ' + t[1], sub: theme === t[0] ? '지금 쓰는 중' : '', checked: theme === t[0], words: '테마 화면 모드 다크 라이트 밝게 어둡게 theme dark light', run: function () { setTheme(t[0]); ui.toast('테마를 ‘' + t[1] + '’로 바꿨어요.'); } });
    });
    out.push({ group: '명령', icon: 'settings', label: '설정 열기', sub: 'AI 연결 · 화면 · 단축키', words: '설정 연결 ai 키 단축키 settings', run: function () { A.go('settings'); } });
    return out.concat(statusCommands());
  }

  // ------------------------------------------------------------------ 상태 (STATUS §10.2) — 기능이 꺼져 있으면 없다
  function statusCtx() {
    var SU = DN.status, ST = DN.statusCore;
    if (!SU || !ST || typeof SU.profile !== 'function' || typeof SU.set !== 'function') return null;
    var pf = SU.profile();
    if (!pf || !pf.enabled) return null;
    var active = SU.isActive ? SU.isActive() : false;
    var cur = active && SU.current ? SU.current(now()) : null;
    return { SU: SU, ST: ST, pf: pf, active: active, cur: cur };
  }
  // 상태마다 알아듣는 말 (사전 + 사용자 말) — 검색어로만 쓴다
  function statusWords(pf, id) {
    var SW = DN.statusWords, out = [pf.statuses[id].label, id];
    (pf.statuses[id].words || []).forEach(function (w) { out.push(w); });
    if (SW && SW.PHRASES) {
      SW.PHRASES.forEach(function (g) {
        var to = g.id || (g.role && pf.roleMap && pf.roleMap[g.role]);
        if (to !== id) return;
        ['sure', 'tail', 'maybe'].forEach(function (k) { (g[k] || []).forEach(function (w) { out.push(w); }); });
      });
    }
    return out.join(' ');
  }
  function statusCommands() {
    var c = statusCtx();
    if (!c) return [];
    var A = DN.app, out = [];
    var curId = c.cur && !c.cur.guessed ? c.cur.id : null;
    c.pf.menu.forEach(function (id) {
      var d = c.pf.statuses[id];
      if (!d) return;
      out.push({ group: '상태', icon: d.icon || 'clock', label: '상태: ' + d.label, sub: curId === id ? '지금' : (d.overlay ? d.minutes + '분' : ''),
        checked: curId === id, words: '상태 지금 바꾸기 ' + statusWords(c.pf, id), isNow: curId === id,
        run: function () { c.SU.set({ id: id }, { source: 'palette' }); } });
    });
    var guessNow = !!(c.cur && c.cur.guessed);
    out.push({ group: '상태', icon: 'clock', label: '상태: 시간표대로', sub: guessNow ? '지금은 ‘' + c.cur.label + '’' : '근무 시간으로 짐작', checked: guessNow, isNow: guessNow,
      words: '상태 시간표 자동 짐작 시간표대로 auto', run: function () { if (c.SU.toGuess) c.SU.toGuess(); } });
    if (c.active) {
      out.push({ group: '상태', icon: 'undo', label: '상태: 이전 상태로', sub: '바로 전 상태로 돌아가요', words: '상태 이전 되돌리기 revert',
        run: function () { if (c.SU.revert) c.SU.revert(); } });
    }
    out.push({ group: '상태', icon: 'settings', label: '현재 상태 설정 열기', sub: '설정 › 현재 상태', words: '상태 설정 현재 상태 프리셋 맥락 정책',
      run: function () { A.go('settings', { section: 'status' }); } });
    // 메뉴에 없는 지금 상태(예: 회의 중)도 빈 칸에서 보이게
    if (curId && c.pf.menu.indexOf(curId) === -1 && c.pf.statuses[curId]) {
      out.unshift({ group: '상태', icon: c.pf.statuses[curId].icon || 'clock', label: '상태: ' + c.cur.label, sub: '지금', checked: true, isNow: true,
        words: '상태 ' + statusWords(c.pf, curId), run: function () { c.SU.set({ id: curId }, { source: 'palette' }); } });
    }
    return out;
  }

  // ------------------------------------------------------------------ 데이터 찾기
  function openNote(id) { DN.app.go('notes', { noteId: id }); }
  function openEvent(id) { DN.views.schedule.open({ blockId: id }); }

  function taskOpt(t, n) {
    var sub = '할 일' + (t.status === 'done' ? ' · 완료' : t.dueDate ? ' · 마감 ' + D.relDay(t.dueDate, n) : '');
    var p = t.projectId && M.byId(S.state.projects, t.projectId);
    if (p && !p.deletedAt) sub += ' · ' + p.name;
    return { group: '할 일', icon: 'task', kind: 'task', label: t.title || '(제목 없음)', sub: sub, at: t.updatedAt, run: function () { DN.app.openTask(t.id); } };
  }
  function noteOpt(note, n, q) {
    var k = note.kind === 'idea' || note.kind === 'link' ? note.kind : 'memo';
    var title = M.noteTitle(note);
    var sub = ui.KIND_LABEL[k] + ' · ' + D.relDay(D.ymd(note.updatedAt || note.createdAt), n);
    var snippet = null;
    if (q && norm(title).indexOf(q) === -1) {
      var body = String(note.body || '').replace(/\s+/g, ' ');
      var i = norm(body).indexOf(q);
      if (i !== -1) snippet = (i > 18 ? '…' : '') + body.slice(Math.max(0, i - 18), i + q.length + 40);
    }
    return { group: '메모', icon: ui.KIND_ICON[k], kind: k, label: title, sub: sub, snippet: snippet, at: note.updatedAt, run: function () { openNote(note.id); } };
  }
  function eventOpt(b, n) {
    var s = new Date(b.start);
    return { group: '일정', icon: 'calendar', kind: 'event', label: b.title || '일정', sub: '일정 · ' + D.relDay(D.ymd(s), n) + ' ' + D.hm(s), at: b.start, run: function () { openEvent(b.id); } };
  }
  function extOpt(x) {
    return { group: '일정', icon: 'calendar', kind: 'event', label: x.title || '일정', sub: 'Google · ' + (x.calendarName || '캘린더'), at: x.start,
      run: function () { DN.app.go('calendar', { anchor: D.ymd(x.start) }); } };
  }
  function projectOpt(p) {
    return { group: '프로젝트', icon: 'project', label: p.name, sub: '프로젝트', color: p.color, run: function () { DN.app.go('projects', { projectId: p.id }); } };
  }

  // 앞에서 맞으면 먼저, 그다음 최근 순
  // 이름 안에 검색어가 낱말 그대로 있으면 먼저 ('퇴근' → '상태: 퇴근 · 내 시간'이 '상태: 퇴근길'보다 앞)
  function exactToken(label, q) { return norm(label).split(/[\s·:,()]+/).indexOf(q) !== -1 ? 0 : 1; }
  function rank(list, q, field) {
    return list.map(function (o) { var l = o[field || 'label']; return { o: o, i: norm(l).indexOf(q), x: exactToken(l, q) }; })
      .sort(function (a, b) {
        var pa = a.i === 0 ? 0 : a.i > 0 ? 1 : 2, pb = b.i === 0 ? 0 : b.i > 0 ? 1 : 2;
        return pa - pb || a.x - b.x || String(b.o.at || '').localeCompare(String(a.o.at || ''));
      }).map(function (x) { return x.o; });
  }

  function results(query) {
    var st = S.state, n = now();
    var q = norm(query).trim();
    var cmds = commands();
    if (!q) {
      var recent = M.liveTasks(st).map(function (t) { return taskOpt(t, n); })
        .concat(M.liveNotes(st).filter(function (x) { return x.captureRole !== 'task_source'; }).map(function (x) { return noteOpt(x, n, ''); }))
        .sort(function (a, b) { return String(b.at || '').localeCompare(String(a.at || '')); })
        .slice(0, RECENT)
        .map(function (o) { return Object.assign(o, { group: '최근' }); });
      // '명령' 바로 뒤에 지금 상태 하나 (기능을 켠 뒤에만)
      var nowStatus = cmds.filter(function (c) { return c.group === '상태' && c.isNow; }).slice(0, 1);
      return cmds.filter(function (c) { return c.group === '명령'; }).concat(nowStatus, recent);
    }
    var out = [];
    var hitCmds = cmds.filter(function (c) { return norm(c.label + ' ' + (c.words || '')).indexOf(q) !== -1; });
    out = out.concat(rank(hitCmds, q).slice(0, PER_GROUP));
    var tasks = M.liveTasks(st).filter(function (t) { return norm(t.title + '\n' + (t.memo || '')).indexOf(q) !== -1; }).map(function (t) { return taskOpt(t, n); });
    out = out.concat(rank(tasks, q).slice(0, PER_GROUP));
    var notes = M.liveNotes(st).filter(function (x) { return x.captureRole !== 'task_source' && norm(x.title + '\n' + x.body).indexOf(q) !== -1; }).map(function (x) { return noteOpt(x, n, q); });
    out = out.concat(rank(notes, q).slice(0, PER_GROUP));
    var events = st.blocks.filter(function (b) { return !b.taskId && norm(b.title).indexOf(q) !== -1; }).map(function (b) { return eventOpt(b, n); });
    // Google 일정 (GOOGLE §9.3) — 읽기 전용이라 캘린더의 그날로 간다
    if (typeof M.externalItems === 'function') {
      events = events.concat(M.externalItems(st).filter(function (x) { return norm(x.title).indexOf(q) !== -1; }).map(function (x) { return extOpt(x); }));
    }
    out = out.concat(rank(events, q).slice(0, PER_GROUP));
    var projects = M.liveProjects(st).filter(function (p) { return norm(p.name).indexOf(q) !== -1; }).map(projectOpt);
    out = out.concat(rank(projects, q).slice(0, PER_GROUP));
    return out;
  }

  // ------------------------------------------------------------------ 화면
  function open(initial) {
    if (cur) { cur.input.focus(); return; }
    var prevFocus = document.activeElement;
    var input = h('input.pal-input', {
      type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'pal-list', 'aria-autocomplete': 'list',
      'aria-label': '검색하거나 명령 고르기', placeholder: '할 일·메모·일정·프로젝트 찾기, 또는 명령', spellcheck: 'false', autocomplete: 'off'
    });
    var list = h('div.pal-list#pal-list', { role: 'listbox', 'aria-label': '결과' });
    var box = h('div.modal.pal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': '검색·명령' },
      h('div.pal-head', ui.icon('search'), input, h('kbd', 'Esc')),
      list,
      h('div.pal-foot', h('span', h('kbd', '↑'), h('kbd', '↓'), ' 고르기'), h('span', h('kbd', 'Enter'), ' 열기'), h('span', h('kbd', 'Esc'), ' 닫기')));
    var overlay = h('div.overlay.pal-overlay', box);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(true); });
    cur = { overlay: overlay, input: input, list: list, options: [], active: 0, prevFocus: prevFocus };

    input.addEventListener('input', function () { paint(); });
    input.addEventListener('keydown', function (e) {
      if (e.isComposing || e.keyCode === 229) return;   // 한글 조합 중에는 고르기 키를 쓰지 않는다
      var n = cur.options.length;
      if (e.key === 'ArrowDown') { e.preventDefault(); if (n) setActive((cur.active + 1) % n, true); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) setActive((cur.active - 1 + n) % n, true); }
      else if (e.key === 'PageDown') { e.preventDefault(); if (n) setActive(Math.min(n - 1, cur.active + 5), true); }
      else if (e.key === 'PageUp') { e.preventDefault(); if (n) setActive(Math.max(0, cur.active - 5), true); }
      else if (e.key === 'Enter') { e.preventDefault(); runActive(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === 'Tab') { e.preventDefault(); }
    });

    document.body.appendChild(overlay);
    if (initial) input.value = initial;
    paint();
    input.focus();
    try { input.select(); } catch (e) {}
  }

  function close(restore) {
    if (!cur) return;
    var c = cur;
    cur = null;
    c.overlay.remove();
    if (restore && c.prevFocus && c.prevFocus.isConnected && c.prevFocus.focus) try { c.prevFocus.focus(); } catch (e) {}
  }

  function paint() {
    if (!cur) return;
    var q = cur.input.value.trim();
    var opts = results(q);
    cur.options = opts;
    cur.active = 0;
    cur.list.textContent = '';
    if (!opts.length) {
      cur.list.appendChild(h('div.pal-empty', '‘' + q + '’' + ui.josa(q, '와/과').slice(q.length) + ' 맞는 것이 없어요.',
        h('div.meta', 'Enter를 누르면 이 글을 오늘 화면 입력창에 옮겨 둘게요.')));
      cur.input.removeAttribute('aria-activedescendant');
      return;
    }
    var group = null, groupEl = null, gi = 0;
    opts.forEach(function (o, i) {
      if (o.group !== group) {
        group = o.group;
        var gid = 'pal-g-' + (gi++);
        groupEl = h('div.pal-group', { role: 'group', 'aria-labelledby': gid }, h('div.pal-group-title', { id: gid, role: 'presentation' }, group));
        cur.list.appendChild(groupEl);
      }
      var el = h('div.pal-opt' + (o.kind ? '.kind-' + o.kind : ''), {
        id: 'pal-opt-' + i, role: 'option', 'aria-selected': 'false',
        onmousemove: function () { if (cur && cur.active !== i) setActive(i, false); },
        onmousedown: function (e) { e.preventDefault(); },   // 입력칸 포커스를 빼앗지 않는다
        onclick: function () { setActive(i, false); runActive(); }
      },
        o.color ? h('span.pal-ico', h('span.pal-dot', { style: { background: o.color } })) : h('span.pal-ico', ui.icon(o.icon || 'spark')),
        h('span.pal-main',
          h('span.pal-label', ui.highlight(o.label, q)),
          o.snippet ? h('span.pal-snippet', ui.highlight(o.snippet, q)) : null),
        o.checked ? h('span.pal-check', ui.icon('check')) : null,
        o.sub ? h('span.pal-sub', o.sub) : null,
        o.keys ? h('kbd.pal-keys', o.keys) : null);
      groupEl.appendChild(el);
    });
    setActive(0, true);
  }

  function setActive(i, scroll) {
    if (!cur) return;
    var prev = cur.list.querySelector('.pal-opt.is-active');
    if (prev) { prev.classList.remove('is-active'); prev.setAttribute('aria-selected', 'false'); }
    cur.active = i;
    var el = document.getElementById('pal-opt-' + i);
    if (!el) return;
    el.classList.add('is-active');
    el.setAttribute('aria-selected', 'true');
    cur.input.setAttribute('aria-activedescendant', el.id);
    if (scroll) el.scrollIntoView({ block: 'nearest' });
  }

  function runActive() {
    if (!cur) return;
    var o = cur.options[cur.active];
    var text = cur.input.value.trim();
    if (!o) {
      // 맞는 것이 없으면 적은 글을 그대로 입력창에 넘긴다 (보내지는 않는다)
      if (!text) return;
      close(false);
      DN.app.go('today');
      setTimeout(function () {
        var x = document.querySelector('.chat-input textarea');
        if (!x) return;
        x.value = text;
        x.dispatchEvent(new Event('input', { bubbles: true }));
        x.focus();
      }, 30);
      return;
    }
    close(false);
    o.run();
  }

  // ------------------------------------------------------------------ 단축키
  document.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || (e.key !== 'k' && e.key !== 'K')) return;
    if (e.target && e.target.closest && e.target.closest('.CodeMirror')) return;   // 편집기: 링크 넣기
    if (cur) { e.preventDefault(); close(true); return; }
    if (document.querySelector('.overlay')) return;   // 다른 대화상자가 열려 있으면 그대로 둔다
    e.preventDefault();
    ui.closeMenu();
    open();
  }, true);

  DN.palette = { open: open, close: function () { close(true); }, isOpen: function () { return !!cur; } };
})();
