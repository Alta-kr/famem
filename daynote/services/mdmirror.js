'use strict';

// 마크다운 폴더 맞추기 — 앱이 저장할 때마다 src/core/mdexport 의 모양대로 .md 파일을 쓰고, 없어진 것은 지운다.
//   - 자기가 쓴 파일만 다룬다: <폴더>/.daynote/manifest.json 에 경로·내용 해시를 적어 두고, 거기 없는 파일은 건드리지 않는다
//   - 밖에서 고친 메모 파일(해시가 다름): 앱 쪽 메모가 그동안 안 바뀌었으면 → 앱으로 가져온다 (onExternal)
//     앱에서도 고쳤으면 → 파일을 '(파일에서 고친 것 …)' 이름으로 남겨 두고 앱 내용을 쓴다 (onConflict)
//   - 할 일·주간 보고·README 를 밖에서 고쳤으면 그 파일을 '(밖에서 고친 것 …)' 으로 남기고 새로 쓴다
//   - 같은 이름의 남의 파일이 이미 있으면 덮지 않고 ' (Daynote)' 를 붙인 이름으로 쓴다
//   - 쓰기는 임시 파일 → 이름 바꾸기, 한 번에 하나씩 (앞 작업이 끝나야 다음)

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const MD = require('../src/core/mdexport');

function sha(s) { return crypto.createHash('sha1').update(s, 'utf8').digest('hex'); }
function stampName(d) { const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()); }
async function readOr(file) { try { return await fsp.readFile(file, 'utf8'); } catch (e) { return null; } }
async function writeAtomic(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, file);
}
function withSuffix(rel, suffix) { const ext = path.extname(rel); return rel.slice(0, rel.length - ext.length) + suffix + ext; }

// opts: { getDir(): 폴더 또는 null(끔), onExternal([{ id, content }]), onConflict([{ id, title, copy }]), now?() }
function create(opts) {
  let chain = Promise.resolve();
  let timer = null;
  let lastState = null;
  let last = { at: null, files: 0, error: null, written: 0, removed: 0 };

  function manifestFile(dir) { return path.join(dir, '.daynote', 'manifest.json'); }
  function loadManifest(dir) {
    try { const m = JSON.parse(fs.readFileSync(manifestFile(dir), 'utf8')); return m && m.files ? m : { version: 1, files: {} }; }
    catch (e) { return { version: 1, files: {} }; }
  }
  async function saveManifest(dir, m) { await writeAtomic(manifestFile(dir), JSON.stringify(m, null, 1)); }
  // 우리가 만든 폴더가 비면 지운다 (맨 위 폴더는 남긴다)
  async function pruneDirs(dir, rels) {
    const seen = new Set();
    rels.forEach((r) => { let d = path.dirname(r); while (d && d !== '.' && !seen.has(d)) { seen.add(d); d = path.dirname(d); } });
    for (const d of Array.from(seen).sort((a, b) => b.length - a.length)) {
      try { const full = path.join(dir, d); if ((await fsp.readdir(full)).length === 0) await fsp.rmdir(full); } catch (e) {}
    }
  }

  async function run(state) {
    const dir = opts.getDir();
    if (!dir || !state) return last;
    const now = opts.now ? opts.now() : new Date();
    const want = MD.layout(state, now);
    const man = loadManifest(dir);
    const next = { version: 1, files: {} };
    const externals = [], conflicts = [];
    let written = 0, removed = 0;
    const noteById = {};
    (state.notes || []).forEach((n) => { noteById[n.id] = n; });
    // 지난번에 쓴 경로 — id 로 찾기 (제목이 바뀌어 경로가 바뀐 메모의 밖 고침도 알아채려고)
    const prevById = {};
    Object.keys(man.files).forEach((rel) => { const e = man.files[rel]; if (e.id) prevById[e.id] = rel; });

    // 1) 밖에서 고친 메모 찾기 — 지난번 경로 기준
    //    pending: 앱으로 가져가라고 보냈는데 아직 앱 메모가 그대로인 것 — 덮어쓰지 않고 다시 보낸다
    const handled = new Set(), copied = new Set();
    for (const rel of Object.keys(man.files)) {
      const e = man.files[rel];
      if (e.kind !== 'note' || !e.id) continue;
      const cur = await readOr(path.join(dir, rel));
      if (cur == null) continue;
      const note = noteById[e.id];
      const unchangedInApp = note && (note.updatedAt || note.createdAt) === e.updatedAt;
      if (sha(cur) === e.hash && !(e.pending && unchangedInApp)) continue;
      const parsed = MD.parseNoteFile(cur);
      if (!note || note.deletedAt || !parsed || parsed.id !== e.id) continue;   // 앱에서 지웠거나 id 를 지운 파일은 그대로 둔다(아래에서 추적만 끊는다)
      if (unchangedInApp) {
        externals.push({ id: e.id, content: parsed.content });
        next.files[rel] = Object.assign({}, e, { hash: sha(cur), pending: true });   // 앱이 가져가 저장하면 그때 새로 쓴다
        handled.add(rel);
      } else if (!e.pending) {
        const copy = withSuffix(rel, ' (파일에서 고친 것 ' + stampName(now) + ')');
        try { await fsp.copyFile(path.join(dir, rel), path.join(dir, copy)); copied.add(rel); } catch (err) {}
        conflicts.push({ id: e.id, title: note.title || '', copy });
      }
    }

    // 2) 써야 할 파일
    for (const rel of Object.keys(want)) {
      const w = want[rel];
      if (w.kind === 'note' && externals.some((x) => x.id === w.id)) {
        // 가져오는 중 — 이번에는 쓰지 않는다 (지난 경로를 그대로 추적)
        continue;
      }
      let target = rel;
      let entry = man.files[rel];
      // 같은 메모가 다른 경로에 있었으면(제목·프로젝트 바뀜) 그 기록을 따라온다
      const full = path.join(dir, target);
      let cur = await readOr(full);
      if (cur != null && !entry) {
        // 우리 기록에 없는 파일 — 내용이 같으면 넘겨받고, 다르면 남의 파일이라 덮지 않는다
        if (cur !== w.content) {
          const own = MD.parseNoteFile(cur);
          if (!(w.kind === 'note' && own && own.id === w.id)) {
            target = withSuffix(rel, ' (Daynote)');
            entry = man.files[target];
            cur = await readOr(path.join(dir, target));
          }
        }
      } else if (cur != null && entry && sha(cur) !== entry.hash && w.kind !== 'note') {
        // 할 일·보고·README 를 밖에서 고쳤다 — 그 파일을 남겨 두고 새로 쓴다
        try { await fsp.copyFile(full, path.join(dir, withSuffix(target, ' (밖에서 고친 것 ' + stampName(now) + ')'))); } catch (err) {}
      }
      const h = sha(w.content);
      if (cur !== w.content) { await writeAtomic(path.join(dir, target), w.content); written++; }
      next.files[target] = { hash: h, kind: w.kind, id: w.id || null, updatedAt: w.updatedAt || null };
      handled.add(target);
    }

    // 3) 이제 없는 파일 — 우리가 쓴 그대로면 지우고, 밖에서 고쳤으면 남겨 둔다 (추적만 끊는다)
    const gone = [];
    for (const rel of Object.keys(man.files)) {
      if (handled.has(rel) || next.files[rel]) continue;
      const full = path.join(dir, rel);
      const cur = await readOr(full);
      // 우리가 쓴 그대로이거나, 고친 내용을 '(파일에서 고친 것)' 으로 따로 남겨 둔 것이면 지운다
      if (cur != null && (sha(cur) === man.files[rel].hash || copied.has(rel))) { try { await fsp.unlink(full); removed++; gone.push(rel); } catch (e) {} }
    }
    await pruneDirs(dir, gone);
    await saveManifest(dir, next);
    last = { at: new Date().toISOString(), files: Object.keys(next.files).length, error: null, written, removed };
    if (externals.length && opts.onExternal) opts.onExternal(externals);
    if (conflicts.length && opts.onConflict) opts.onConflict(conflicts);
    return last;
  }

  function enqueue(state) {
    chain = chain.then(() => run(state)).catch((e) => { last = Object.assign({}, last, { error: e.message, at: new Date().toISOString() }); return last; });
    return chain;
  }
  return {
    // 저장할 때마다 — 잠깐 모았다가 한 번에
    schedule(stateJson, delayMs) {
      try { lastState = typeof stateJson === 'string' ? JSON.parse(stateJson) : stateJson; } catch (e) { return; }
      clearTimeout(timer);
      timer = setTimeout(() => { timer = null; enqueue(lastState); }, delayMs == null ? 1500 : delayMs);
    },
    // 바로 (창으로 돌아왔을 때 — 밖에서 고친 파일 확인)
    runNow(state) { if (state) lastState = typeof state === 'string' ? JSON.parse(state) : state; clearTimeout(timer); timer = null; return enqueue(lastState); },
    status() { return Object.assign({}, last); },
    _run: run
  };
}

module.exports = { create };
