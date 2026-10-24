'use strict';

// 마크다운 파일 모양 — 앱 데이터를 사람이 읽는 .md 파일 묶음으로 (어떤 파일을 어디에 어떤 내용으로)
//   <폴더>/README.md
//   <폴더>/<프로젝트>/메모/2026-10-21 제목.md     메모 하나에 파일 하나 (맨 위 --- 사이에 id·프로젝트·종류·날짜)
//   <폴더>/<프로젝트>/할 일.md                   진행 중 · 앞으로 · 날짜 없음 · 기다리는 중 · 끝낸 일(30일)
//   <폴더>/미분류/…                              프로젝트 없는 메모·할 일
//   <폴더>/주간 보고/2026-10-19 주간 보고.md
//   쓰기·지우기·밖에서 고친 것 가져오기는 services/mdmirror.js 가 한다. 여기는 순수 함수 (테스트 대상)
//   샘플 데이터와 '할 일로 바꾼 원문 메모(task_source)' 는 넣지 않는다

(function (factory) {
  var deps = (typeof module !== 'undefined' && module.exports)
    ? { dates: require('./dates'), model: require('./model'), steps: require('./steps') }
    : { dates: window.Daynote.dates, model: window.Daynote.model, steps: window.Daynote.steps };
  var api = factory(deps.dates, deps.model, deps.steps);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.mdexport = api; }
})(function (D, M, ST) {
  var UNFILED = '미분류', REPORTS = '주간 보고', NOTES_DIR = '메모', TASKS_FILE = '할 일.md';
  var KIND = { memo: '메모', idea: '아이디어', link: '링크' };
  var RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  // Windows 에서 쓸 수 없는 글자를 빼고 길이를 줄인 파일·폴더 이름
  function safeName(s, max) {
    var x = String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
    x = x.slice(0, max || 60).replace(/[. ]+$/, '').trim();
    if (!x) x = '제목 없음';
    if (RESERVED.test(x)) x += '_';
    return x;
  }
  function stamp(iso) { if (!iso) return ''; var d = new Date(iso); return D.ymd(d) + ' ' + D.hm(d); }
  function short(ymd) { return ymd ? D.shortDay(D.parseYmd(ymd)) : ''; }
  // 같은 이름이 있으면 (2), (3) …
  function uniq(used, name, ext) {
    var key = (name + ext).toLowerCase(), n = 2, out = name;
    while (used[key]) { out = name + ' (' + n++ + ')'; key = (out + ext).toLowerCase(); }
    used[key] = true;
    return out + ext;
  }

  // 프로젝트 id → 폴더 이름 (지운 프로젝트·없음 → 미분류)
  function folders(state) {
    var used = {}; used[UNFILED.toLowerCase()] = true; used[REPORTS.toLowerCase()] = true; used['readme.md'] = true;
    var map = {};
    state.projects.filter(function (p) { return !p.deletedAt && !p.sample; })
      .sort(function (a, b) { return (a.createdAt || '') < (b.createdAt || '') ? -1 : 1; })
      .forEach(function (p) { map[p.id] = uniq(used, safeName(p.name, 50), ''); });
    return map;
  }
  function folderOf(map, pid) { return (pid && map[pid]) || UNFILED; }

  function noteFile(state, n, proj) {
    var front = ['---', 'id: ' + n.id, '프로젝트: ' + (proj ? proj.name : UNFILED), '종류: ' + (KIND[n.kind] || '메모'),
      '적은 날: ' + stamp(n.createdAt), '고친 날: ' + stamp(n.updatedAt || n.createdAt), '홈: ' + (n.homeHiddenAt ? '보관함' : '홈'), '---'].join('\n');
    var body = String(n.body || '');
    var title = (n.title || '').trim();
    return front + '\n\n' + (title ? '# ' + title + '\n\n' : '') + body.replace(/\s+$/, '') + '\n';
  }

  function taskLine(t, indent) {
    var bits = [];
    if (t.status === 'done') { if (t.completedAt) bits.push(short(D.ymd(t.completedAt)) + ' 끝냄'); }
    else {
      if (t.dueDate) bits.push('마감 ' + short(t.dueDate) + (t.dueTime ? ' ' + t.dueTime : ''));
      if (t.planDate) bits.push('할 날 ' + short(t.planDate));
      if (t.estimateMinutes) bits.push('예상 ' + D.duration(t.estimateMinutes));
      if (t.status === 'waiting' && t.waitingFor) bits.push('기다림: ' + t.waitingFor);
    }
    var out = [indent + '- [' + (t.status === 'done' ? 'x' : ' ') + '] ' + (t.title || '(제목 없음)') + (bits.length ? ' — ' + bits.join(' · ') : '')];
    (function walk(list, ind) {
      (list || []).forEach(function (s) {
        out.push(ind + '- [' + (s.done ? 'x' : ' ') + '] ' + (s.prep ? '(준비) ' : '') + (s.title || ''));
        if (s.steps && s.steps.length) walk(s.steps, ind + '  ');
      });
    })(t.steps, indent + '  ');
    if (t.memo && t.memo.trim()) t.memo.trim().split('\n').forEach(function (l) { out.push(indent + '  > ' + l); });
    return out.join('\n');
  }
  function tasksFile(name, tasks, now) {
    var today = D.ymd(now), monthAgo = D.ymd(D.addDays(now, -30));
    function day(t) { return [t.planDate, t.dueDate].filter(Boolean).sort()[0] || null; }
    var groups = [
      ['진행 중', tasks.filter(function (t) { return t.status === 'in_progress' || t.status === 'paused'; })],
      ['앞으로 할 일', tasks.filter(function (t) { return t.status === 'todo' && day(t); }).sort(function (a, b) { return day(a) < day(b) ? -1 : day(a) > day(b) ? 1 : 0; })],
      ['날짜 없음', tasks.filter(function (t) { return t.status === 'todo' && !day(t); })],
      ['기다리는 중', tasks.filter(function (t) { return t.status === 'waiting'; })],
      ['끝낸 일 (최근 30일)', tasks.filter(function (t) { return t.status === 'done' && t.completedAt && D.ymd(t.completedAt) >= monthAgo; })
        .sort(function (a, b) { return a.completedAt < b.completedAt ? 1 : -1; })]
    ];
    var out = ['# ' + name + ' · 할 일', '', '> Modib이 ' + today + ' 기준으로 만든 목록이에요. 할 일은 앱에서 고쳐 주세요 (이 파일은 저장할 때마다 새로 써요).'];
    groups.forEach(function (g) {
      if (!g[1].length) return;
      out.push('', '## ' + g[0], '');
      g[1].forEach(function (t) { out.push(taskLine(t, '')); });
    });
    return out.join('\n') + '\n';
  }

  function readme(now) {
    return [
      '# Modib',
      '',
      'Modib이 메모·할 일·주간 보고를 마크다운으로 저장하는 폴더예요. 앱에서 저장할 때마다 맞춰서 써요.',
      '',
      '- `<프로젝트>/메모/` — 메모 하나에 파일 하나. 맨 위 `---` 사이는 Modib이 쓰는 정보예요 (id 는 지우지 마세요).',
      '- `<프로젝트>/할 일.md` — 그 프로젝트의 할 일 (진행 중 · 앞으로 · 날짜 없음 · 기다리는 중 · 끝낸 일).',
      '- `' + UNFILED + '/` — 프로젝트에 넣지 않은 메모·할 일.',
      '- `' + REPORTS + '/` — 주간 업무 보고.',
      '',
      '메모 파일을 직접 고치면 Modib으로 돌아왔을 때 앱에도 반영돼요. 앱과 파일 양쪽에서 고쳤으면 파일 쪽은',
      '`(파일에서 고친 것 …)` 이름으로 따로 남겨 둬요. 할 일·주간 보고 파일은 앱에서 고쳐 주세요.',
      '',
      '_' + D.ymd(now) + ' 기준_'
    ].join('\n') + '\n';
  }

  // 전체 파일 모양 — { '경로': { content, kind: 'note'|'tasks'|'report'|'readme', id?, updatedAt? } } (경로는 / 로 나눈 상대 경로)
  function layout(state, now) {
    now = now || new Date();
    var map = folders(state);
    var files = {};
    var usedIn = {};
    function put(dir, base, ext, entry) {
      usedIn[dir] = usedIn[dir] || {};
      var name = uniq(usedIn[dir], base, ext);
      files[dir + '/' + name] = entry;
    }
    files['README.md'] = { content: readme(now), kind: 'readme' };
    // 메모
    M.liveNotes(state).filter(function (n) { return !n.sample && n.captureRole !== 'task_source'; })
      .sort(function (a, b) { return (a.createdAt || '') < (b.createdAt || '') ? -1 : (a.createdAt || '') > (b.createdAt || '') ? 1 : (a.id < b.id ? -1 : 1); })
      .forEach(function (n) {
        var proj = n.projectId && M.byId(state.projects, n.projectId);
        if (proj && (proj.deletedAt || proj.sample)) proj = null;
        var dir = folderOf(map, proj && proj.id) + '/' + NOTES_DIR;
        put(dir, D.ymd(new Date(n.createdAt)) + ' ' + safeName(M.noteTitle(n), 60), '.md', { content: noteFile(state, n, proj), kind: 'note', id: n.id, updatedAt: n.updatedAt || n.createdAt });
      });
    // 할 일 — 프로젝트(폴더)마다 한 파일
    var byFolder = {};
    M.liveTasks(state).filter(function (t) { return !t.sample; }).forEach(function (t) {
      var proj = t.projectId && M.byId(state.projects, t.projectId);
      var f = folderOf(map, proj && !proj.deletedAt && !proj.sample ? proj.id : null);
      (byFolder[f] = byFolder[f] || { name: proj && !proj.deletedAt && !proj.sample ? proj.name : UNFILED, tasks: [] }).tasks.push(t);
    });
    Object.keys(byFolder).forEach(function (f) {
      var g = byFolder[f];
      var c = tasksFile(g.name, g.tasks, now);
      if (c.indexOf('## ') === -1) return;   // 보여 줄 할 일이 없으면 파일도 없다
      files[f + '/' + TASKS_FILE] = { content: c, kind: 'tasks' };
    });
    // 주간 보고
    (state.reports || []).forEach(function (r) {
      var body = String(r.body || r.draft || '').trim();
      if (!body || !r.weekStart) return;
      put(REPORTS, r.weekStart + ' 주간 보고', '.md', { content: body + '\n', kind: 'report', id: r.id });
    });
    return files;
  }

  // 메모 파일 읽기 — 맨 위 --- 사이에서 id, 그 아래가 내용
  function parseNoteFile(text) {
    var s = String(text || '').replace(/^﻿/, '').replace(/\r\n/g, '\n');
    var m = /^---\n([\s\S]*?)\n---\n?/.exec(s);
    if (!m) return null;
    var idm = /^id:\s*(\S+)\s*$/m.exec(m[1]);
    if (!idm) return null;
    return { id: idm[1], content: s.slice(m[0].length).replace(/^\n/, '') };
  }
  // 파일에서 고친 내용 → 메모의 제목·본문 (제목이 있던 메모면 맨 윗줄 '# 제목' 을 제목으로)
  function noteFromFile(note, content) {
    var c = String(content || '').replace(/\s+$/, '');
    var title = (note && note.title || '').trim();
    var hm = /^# (.*)\n?\n?/.exec(c);
    if (title && hm) return { title: hm[1].trim(), body: c.slice(hm[0].length) };
    return { title: note ? note.title || '' : '', body: c };
  }

  return { layout: layout, parseNoteFile: parseNoteFile, noteFromFile: noteFromFile, safeName: safeName, UNFILED: UNFILED, REPORTS: REPORTS };
});
