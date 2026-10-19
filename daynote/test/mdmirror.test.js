'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../src/core/model');
const MD = require('../src/core/mdexport');
const MIR = require('../services/mdmirror');

function at(min) { return new Date(2026, 9, 21, 10, min); }
function read(dir, rel) { return fs.readFileSync(path.join(dir, rel), 'utf8'); }
function exists(dir, rel) { return fs.existsSync(path.join(dir, rel)); }

test('마크다운 모양: 프로젝트 폴더/메모, 할 일.md(나눠서), 미분류, 주간 보고 · 샘플·원문 메모는 빼고', () => {
  const st = M.emptyState();
  const p = M.addProject(st, { name: '인공:조류?' }, at(0));
  const n1 = M.addNote(st, { title: '부품 리스트', body: '- 모터 드라이버\n- 배터리', projectId: p.id }, at(1));
  M.addNote(st, { body: '그냥 떠오른 생각' }, at(2));
  M.addNote(st, { body: '샘플', sample: true }, at(3));
  const src = M.addNote(st, { body: '할 일로 바꾼 원문' }, at(4)); src.captureRole = 'task_source';
  const t = M.addTask(st, { title: '발주 확인', projectId: p.id, dueDate: '2026-10-23', steps: [{ id: 's1', title: '메일 확인', done: true }] }, at(5));
  M.addTask(st, { title: '나중 일', projectId: p.id }, at(5));
  M.completeTask(st, M.addTask(st, { title: '끝낸 일', projectId: p.id }, at(5)).id, at(6));
  M.saveReport(st, '2026-10-19', { body: '# 주간업무보고\n- 했음' }, at(7));
  const files = MD.layout(st, at(10));
  const names = Object.keys(files).sort();
  assert.deepStrictEqual(names, ['README.md', '미분류/메모/2026-10-21 그냥 떠오른 생각.md', '인공 조류/메모/2026-10-21 부품 리스트.md', '인공 조류/할 일.md', '주간 보고/2026-10-19 주간 보고.md']);
  const note = files['인공 조류/메모/2026-10-21 부품 리스트.md'].content;
  assert.match(note, /^---\nid: note_/);
  assert.match(note, /프로젝트: 인공:조류\?/);
  assert.match(note, /\n# 부품 리스트\n\n- 모터 드라이버\n- 배터리\n$/);
  const tasks = files['인공 조류/할 일.md'].content;
  assert.match(tasks, /## 앞으로 할 일\n\n- \[ \] 발주 확인 — 마감 10\/23 \(금\)\n  - \[x\] 메일 확인/);
  assert.match(tasks, /## 날짜 없음\n\n- \[ \] 나중 일/);
  assert.match(tasks, /## 끝낸 일 \(최근 30일\)\n\n- \[x\] 끝낸 일/);
  // 파일에서 고친 내용 → 제목·본문
  const parsed = MD.parseNoteFile(note.replace('- 배터리', '- 배터리 2개'));
  assert.strictEqual(parsed.id, n1.id);
  assert.deepStrictEqual(MD.noteFromFile(n1, parsed.content), { title: '부품 리스트', body: '- 모터 드라이버\n- 배터리 2개' });
  assert.ok(t);
});

test('마크다운 폴더: 쓰기 · 제목 바뀜 · 지우기 · 밖에서 고친 메모 가져오기 · 양쪽에서 고치면 따로 남기기 · 남의 파일은 안 덮기', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-md-'));
  const ext = [], conf = [];
  let clock = at(10);
  const mir = MIR.create({ getDir: () => dir, onExternal: (l) => ext.push(...l), onConflict: (l) => conf.push(...l), now: () => clock });
  const st = M.emptyState();
  const n = M.addNote(st, { title: '회의 메모', body: '첫 줄' }, at(1));
  const gone = M.addNote(st, { body: '곧 지울 메모' }, at(2));
  // 남의 파일이 같은 이름으로 이미 있으면 덮지 않는다
  fs.mkdirSync(path.join(dir, '미분류', '메모'), { recursive: true });
  fs.writeFileSync(path.join(dir, '미분류', '메모', '2026-10-21 곧 지울 메모.md'), '내 파일');
  await mir._run(st);
  assert.ok(exists(dir, '미분류/메모/2026-10-21 회의 메모.md'));
  assert.strictEqual(read(dir, '미분류/메모/2026-10-21 곧 지울 메모.md'), '내 파일');
  assert.ok(exists(dir, '미분류/메모/2026-10-21 곧 지울 메모 (Daynote).md'));
  // 제목이 바뀌면 옛 파일은 지우고 새 이름으로
  M.updateNote(st, n.id, { title: '팀 회의 메모' }, at(3));
  M.deleteNote(st, gone.id, at(3));
  await mir._run(st);
  assert.ok(!exists(dir, '미분류/메모/2026-10-21 회의 메모.md'));
  assert.ok(exists(dir, '미분류/메모/2026-10-21 팀 회의 메모.md'));
  assert.ok(!exists(dir, '미분류/메모/2026-10-21 곧 지울 메모 (Daynote).md'));
  assert.strictEqual(read(dir, '미분류/메모/2026-10-21 곧 지울 메모.md'), '내 파일');
  // 밖에서 고친 메모 → 앱으로 가져가라고 알린다 (파일은 그대로)
  const rel = '미분류/메모/2026-10-21 팀 회의 메모.md';
  fs.writeFileSync(path.join(dir, rel), read(dir, rel).replace('첫 줄', '첫 줄\n파일에서 더한 줄'));
  await mir._run(st);
  assert.strictEqual(ext.length, 1);
  assert.strictEqual(ext[0].id, n.id);
  assert.match(read(dir, rel), /파일에서 더한 줄/);
  // 앱이 가져가 저장하면 그 내용으로 다시 쓴다
  const v = MD.noteFromFile(n, ext[0].content);
  M.updateNote(st, n.id, v, at(4));
  await mir._run(st);
  assert.match(read(dir, rel), /첫 줄\n파일에서 더한 줄\n$/);
  // 양쪽에서 고치면 파일 쪽을 '(파일에서 고친 것 …)' 으로 남기고 앱 내용을 쓴다
  fs.writeFileSync(path.join(dir, rel), read(dir, rel).replace('첫 줄', '파일 쪽 고침'));
  M.updateNote(st, n.id, { body: '앱 쪽 고침' }, at(5));
  clock = at(20);
  await mir._run(st);
  assert.strictEqual(conf.length, 1);
  assert.match(read(dir, rel), /앱 쪽 고침/);
  const copies = fs.readdirSync(path.join(dir, '미분류', '메모')).filter((f) => f.indexOf('파일에서 고친 것') !== -1);
  assert.strictEqual(copies.length, 1);
  assert.match(fs.readFileSync(path.join(dir, '미분류', '메모', copies[0]), 'utf8'), /파일 쪽 고침/);
});
