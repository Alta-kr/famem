'use strict';

// UX v2 — 다섯 종류(할 일/일정/메모/아이디어/링크) 분류, 결과 카드에서 고치기, 모델 2단, 키 보관

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../src/core/model');
const V = require('../src/core/ai/validate');
const P = require('../src/core/ai/proposals');
const C = require('../src/core/ai/capture');
const fake = require('../src/core/ai/fake');
const D = require('../src/core/dates');

const NOW = new Date(2026, 9, 9, 10, 20);

function setup() {
  const st = M.emptyState();
  M.addProject(st, { id: 'p1', name: '신규 온보딩 개선' }, NOW);
  return st;
}
function submit(st, text, patch) {
  const note = M.addNote(st, { title: '', body: text, capture: { status: 'pending', at: NOW.toISOString() } }, NOW);
  note.updatedAt = NOW.toISOString();
  const input = C.buildInput(note, { today: '2026-10-09 (금)', projects: st.projects.map((p) => p.name), openTasks: [] });
  const out = Object.assign(fake.organize(input).output, patch || {});
  const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, NOW);
  const v = V.validateOrganizeNote(out, { note, state: st, now: NOW });
  assert.ok(v.ok, v.errors.join());
  P.applyCapture(st, { note, run, validated: v, output: out }, NOW);
  return note;
}
const live = (list) => list.filter((x) => !x.deletedAt);

test('스키마 v3: note_kind 가 있고 모든 속성이 required', () => {
  assert.strictEqual(C.PROMPT_VERSION, 'capture.v6');
  assert.deepStrictEqual(C.SCHEMA.properties.note_kind.enum, ['memo', 'idea', 'link']);
  assert.deepStrictEqual(C.SCHEMA.required.slice().sort(), Object.keys(C.SCHEMA.properties).sort());
  assert.match(C.SYSTEM, /note_kind/);
});

test('메모 종류: 링크·아이디어·메모를 note.kind 로 남긴다', () => {
  const st = setup();
  assert.strictEqual(submit(st, 'https://example.com/a 나중에 읽기').kind, 'link');
  assert.strictEqual(submit(st, '온보딩에 퀴즈 넣으면 어떨까').kind, 'idea');
  assert.strictEqual(submit(st, '오늘 점심 김밥 맛있었다').kind, 'memo');
  // 이상한 값은 memo
  assert.strictEqual(submit(st, '그냥 기록', { note_kind: 'weird' }).kind, 'memo');
});

test('종류 바꾸기: 할 일 → 아이디어 → 할 일 → 일정 → 할 일, 원문은 그대로', () => {
  const st = setup();
  const note = submit(st, '내일까지 견적서 보내기');
  assert.strictEqual(note.captureRole, 'task_source');
  assert.strictEqual(live(st.tasks).length, 1);

  P.captureSetKind(st, note.id, 'idea', NOW);
  assert.strictEqual(note.kind, 'idea');
  assert.strictEqual(note.kindByUser, true);
  assert.strictEqual(note.captureRole, 'memo');
  assert.strictEqual(live(st.tasks).length, 0);

  P.captureSetKind(st, note.id, 'task', NOW);
  assert.strictEqual(live(st.tasks).length, 1);

  P.captureSetKind(st, note.id, 'event', NOW);
  assert.strictEqual(live(st.tasks).length, 0);
  assert.strictEqual(st.blocks.length, 1);
  const b = st.blocks[0];
  assert.strictEqual(b.kind, 'event');
  assert.strictEqual(b.timeUncertain, true);                 // 시각이 없었으니 확인 필요
  assert.deepStrictEqual(note.capture.created, [{ kind: 'block', id: b.id }]);
  assert.strictEqual(note.body, '내일까지 견적서 보내기');

  // 일정 → 할 일: 일정을 손대지 않았으면 원래 할 일 그대로 (마감 없던 일에 오늘 날짜가 붙지 않음)
  P.captureSetKind(st, note.id, 'task', NOW);
  assert.strictEqual(st.blocks.length, 0);
  const t = live(st.tasks)[0];
  assert.strictEqual(t.dueTime, null);
  assert.strictEqual(t.dueDate, null);
});

test('할 일 ↔ 일정: 완료·단계·소요 시간은 지키고, 일정에서 바꾼 날짜는 마감이 된다', () => {
  const st = setup();
  const note = submit(st, '내일까지 견적서 보내기');
  const t0 = live(st.tasks)[0];
  M.updateTask(st, t0.id, { estimateMinutes: 40, steps: [{ id: 's1', title: '초안', done: false }] }, NOW);
  P.captureSetKind(st, note.id, 'event', NOW);
  const b = st.blocks[0];
  assert.strictEqual(D.ymd(new Date(b.start)), '2026-10-10');      // 마감일 9시
  // 원래 초안(proposal)은 새 일정을 가리킨다
  assert.ok(st.proposals.some((p) => p.resultRef && p.resultRef.id === b.id));
  M.updateBlock(st, b.id, { start: new Date(2026, 9, 12, 14, 0).toISOString(), end: new Date(2026, 9, 12, 15, 0).toISOString(), timeUncertain: false });
  P.captureSetKind(st, note.id, 'task', NOW);
  const t = live(st.tasks)[0];
  assert.strictEqual(t.dueDate, '2026-10-12');
  assert.strictEqual(t.dueTime, '14:00');
  assert.strictEqual(t.estimateMinutes, 40);
  assert.strictEqual(t.steps.length, 1);
  // 다시 일정으로: 길이 그대로
  P.captureSetKind(st, note.id, 'event', NOW);
  const b2 = st.blocks[0];
  assert.strictEqual(new Date(b2.end) - new Date(b2.start), 60 * 60000);
  assert.strictEqual(b2.timeUncertain, false);
});

test('끝낸 할 일은 일정으로 바꾸지 않고, 여러 개는 한 시간씩 띄운다', () => {
  const st = setup();
  const note = submit(st, '- [ ] 견적서 보내기\n- [ ] 설문 정리하기\n- [ ] 회의록 공유하기');
  const ts = live(st.tasks);
  assert.strictEqual(ts.length, 3);
  M.completeTask(st, ts[0].id, NOW);
  P.captureSetKind(st, note.id, 'event', NOW);
  assert.strictEqual(live(st.tasks).length, 1);
  assert.strictEqual(live(st.tasks)[0].status, 'done');
  const starts = st.blocks.map((b) => b.start);
  assert.strictEqual(new Set(starts).size, starts.length);
});

test('원문 보존: 할 일을 다른 화면에서 지우거나 일정을 지워도 원문이 메모로 돌아온다', () => {
  const st = setup();
  // A: 두 개 중 하나는 할 일 화면에서, 하나는 카드에서
  const a = submit(st, '- [ ] 견적서 보내기\n- [ ] 설문 정리하기');
  assert.strictEqual(a.captureRole, 'task_source');
  const [r1, r2] = a.capture.created;
  M.deleteTask(st, r1.id, NOW);
  P.captureRemoveItem(st, a.id, r2, NOW);
  assert.strictEqual(a.captureRole, 'memo');
  assert.strictEqual(P.captureItems(st, a).length, 1);
  // B: 일정으로 바꾼 뒤 캘린더에서 지움
  const b = submit(st, '내일까지 견적서 보내기');
  P.captureSetKind(st, b.id, 'event', NOW);
  assert.strictEqual(b.captureRole, 'task_source');
  M.deleteBlock(st, b.capture.created[0].id);
  assert.strictEqual(b.captureRole, 'memo');
  assert.ok(!('__holdReveal' in st));
});

test('사용자가 종류를 정한 뒤 늦게 온(또는 다시 시도한) AI 결과는 덮지 않는다', () => {
  const st = setup();
  const note = submit(st, '오늘 점심 김밥 맛있었다');
  P.captureSetKind(st, note.id, 'event', NOW);
  const blockId = note.capture.created[0].id;
  assert.strictEqual(note.capture.status, 'done');
  const input = C.buildInput(note, { today: '2026-10-09 (금)', projects: [], openTasks: [] });
  const out = fake.organize(input).output;
  const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, NOW);
  P.applyCapture(st, { note, run, validated: V.validateOrganizeNote(out, { note, state: st, now: NOW }), output: out }, NOW);
  assert.deepStrictEqual(note.capture.created, [{ kind: 'block', id: blockId }]);
  assert.strictEqual(st.blocks.length, 1);
});

test('사용자가 바꾼 종류는 다시 정리해도 AI 가 덮지 않는다', () => {
  const st = setup();
  const note = submit(st, '오늘 점심 김밥 맛있었다');
  P.captureSetKind(st, note.id, 'link', NOW);
  const input = C.buildInput(note, { today: '2026-10-09 (금)', projects: [], openTasks: [] });
  const out = Object.assign(fake.organize(input).output, { note_kind: 'memo' });
  const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, NOW);
  P.applyCapture(st, { note, run, validated: V.validateOrganizeNote(out, { note, state: st, now: NOW }), output: out }, NOW);
  assert.strictEqual(note.kind, 'link');
});

test('한 줄 빼기: 만든 할 일만 지우고, 남은 게 없으면 원문이 메모로 보인다', () => {
  const st = setup();
  const note = submit(st, '내일까지 견적서 보내기');
  const ref = note.capture.created[0];
  assert.strictEqual(P.captureItems(st, note).length, 1);    // task_source 는 메모 줄 없이 할 일만
  P.captureRemoveItem(st, note.id, ref, NOW);
  assert.strictEqual(live(st.tasks).length, 0);
  assert.strictEqual(note.captureRole, 'memo');
  assert.deepStrictEqual(P.captureItems(st, note).map((i) => i.kind), ['memo']);
});

test('결과 줄: 혼합 입력은 메모 줄 + 할 일 줄', () => {
  const st = setup();
  const note = submit(st, '오늘 회의 분위기 좋았음\n온보딩 설문은 금요일까지 정리해서 공유 부탁드립니다');
  const kinds = P.captureItems(st, note).map((i) => i.kind);
  assert.strictEqual(kinds[0], 'memo');
  assert.ok(kinds.includes('task'));
});

// ---------------------------------------------------------------- 모델 2단
const ENV = ['DAYNOTE_AI_FAKE', 'DAYNOTE_AI_PROVIDER', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'DAYNOTE_KEY_FROM_DOTENV'];
async function withEnv(vars, fn) {
  const saved = {};
  ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  Object.assign(process.env, vars);
  try { return await fn(); }
  finally { ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); }
}
function freshAi() { delete require.cache[require.resolve('../services/ai')]; return require('../services/ai'); }
const OUT = { summary: '', sections: [], tasks: [], events: [], open_questions: [], entry_type: 'memo', note_title: 't', note_project_hint: null, note_kind: 'memo' };
function capInput(id) {
  return C.buildInput({ id: id, title: '', body: 'x', updatedAt: NOW.toISOString() }, { today: '2026-10-09', projects: [], openTasks: [] });
}

test('분류는 Flash-Lite(minimal) 먼저, 정리는 3.8 Flash(low) 먼저', async () => {
  await withEnv({ GEMINI_API_KEY: 'g' }, async () => {
    const ai = freshAi();
    const sent = [];
    ai._setClients({ retryDelayMs: 0, gemini: { interactions: { create: async (req) => { sent.push(req); return { status: 'completed', output_text: JSON.stringify(OUT) }; } } } });
    const r = await ai.organize(capInput('a'));
    assert.ok(r.ok);
    assert.strictEqual(sent[0].model, 'gemini-3.5-flash-lite');
    assert.strictEqual(sent[0].generation_config.thinking_level, 'minimal');
    assert.strictEqual(r.model, 'gemini-3.5-flash-lite');
    await ai.organize(Object.assign({}, capInput('b'), { purpose: undefined }));
    assert.strictEqual(sent[1].model, 'gemini-3.8-flash');
    assert.strictEqual(sent[1].generation_config.thinking_level, 'low');
  });
});

test('빠른 모델이 한도·서버 오류면 3.8 Flash 로 바로 대체한다', async () => {
  await withEnv({ GEMINI_API_KEY: 'g' }, async () => {
    const ai = freshAi();
    const models = [];
    ai._setClients({ retryDelayMs: 0, gemini: { interactions: { create: async (req) => {
      models.push(req.model);
      if (req.model === 'gemini-3.5-flash-lite') throw Object.assign(new Error('quota'), { status: 429 });
      return { status: 'completed', output_text: JSON.stringify(OUT) };
    } } } });
    const r = await ai.organize(capInput('c'));
    assert.ok(r.ok);
    assert.deepStrictEqual(models, ['gemini-3.5-flash-lite', 'gemini-3.8-flash']);
    assert.strictEqual(r.model, 'gemini-3.8-flash');
  });
});

test('키 오류(401)는 다른 모델로 넘기지 않는다', async () => {
  await withEnv({ GEMINI_API_KEY: 'g' }, async () => {
    const ai = freshAi();
    let calls = 0;
    ai._setClients({ retryDelayMs: 0, gemini: { interactions: { create: async () => { calls++; throw Object.assign(new Error('bad key'), { status: 401 }); } } } });
    const r = await ai.organize(capInput('d'));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.type, 'auth');
    assert.strictEqual(calls, 1);
  });
});

test('설정에서 저장한 키로도 연결되고, 상태에 키 출처가 나온다 (키 자체는 없음)', async () => {
  await withEnv({}, async () => {
    const ai = freshAi();
    assert.strictEqual(ai.status().configured, false);
    ai.setSavedKey('AIzaTESTKEY000000000000000');
    const s = ai.status();
    assert.strictEqual(s.provider, 'gemini');
    assert.strictEqual(s.keySource, 'saved');
    assert.ok(!JSON.stringify(s).includes('AIzaTESTKEY'));
    ai.setSavedKey('');
  });
});

// ---------------------------------------------------------------- 키 보관
test('keystore: 암호화해 저장·읽기·지우기, 형식 검사, 끝 4자리만 힌트', () => {
  const K = require('../services/keystore');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-key-'));
  const fakeSafe = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('enc:' + Buffer.from(s).toString('base64')),
    decryptString: (b) => Buffer.from(String(b).slice(4), 'base64').toString()
  };
  const ks = K.create(dir, fakeSafe);
  assert.strictEqual(ks.read(), '');
  assert.strictEqual(ks.save('short').ok, false);
  assert.strictEqual(ks.save('AIzaSyEXAMPLEKEY_abcdefghijklmn').ok, true);
  assert.ok(!fs.readFileSync(path.join(dir, 'ai-key.bin'), 'utf8').includes('AIzaSyEXAMPLE'));   // 평문 아님
  assert.strictEqual(ks.read(), 'AIzaSyEXAMPLEKEY_abcdefghijklmn');
  assert.strictEqual(ks.hint(ks.read()), '••••klmn');
  ks.clear();
  assert.strictEqual(ks.read(), '');
});

test('.env: 환경변수가 없을 때만 채우고 출처를 표시한다', async () => {
  const K = require('../services/keystore');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-env-'));
  fs.writeFileSync(path.join(dir, '.env'), '# 주석\nGEMINI_API_KEY="abc123"\n');
  await withEnv({}, async () => {
    assert.strictEqual(K.loadDotEnv(dir), true);
    assert.strictEqual(process.env.GEMINI_API_KEY, 'abc123');
    assert.strictEqual(freshAi().status().keySource, 'dotenv');
  });
  await withEnv({ GEMINI_API_KEY: 'from-env' }, async () => {
    K.loadDotEnv(dir);
    assert.strictEqual(process.env.GEMINI_API_KEY, 'from-env');
  });
});

test('키 격리: 앱이 켜질 때 환경변수의 키를 모듈로 옮기고 process.env 에서 지운다', async () => {
  await withEnv({ GEMINI_API_KEY: 'AIzaENVKEY0000000000000000', DAYNOTE_KEY_FROM_DOTENV: '1' }, async () => {
    const ai = freshAi();
    ai.captureEnvKeys();
    assert.strictEqual(process.env.GEMINI_API_KEY, undefined);
    const s = ai.status();
    assert.strictEqual(s.provider, 'gemini');
    assert.strictEqual(s.keySource, 'dotenv');
    // 설정에서 저장한 키가 있으면 그게 우선
    ai.setSavedKey('AIzaSAVED00000000000000000');
    assert.strictEqual(ai.status().keySource, 'saved');
    ai.setSavedKey('');
  });
});

test('키 가림: 오류 메시지 속 키는 가리고, 공백·줄바꿈이 섞인 키는 쓰지 않는다', async () => {
  await withEnv({ GEMINI_API_KEY: 'AIzaLEAKY000000000000000000' }, async () => {
    const ai = freshAi();
    assert.ok(!ai.redact('Headers.append: "AIzaLEAKY000000000000000000" is invalid').includes('LEAKY'));
    assert.ok(!ai.redact('x AIzaOTHERKEY123456789 y').includes('OTHERKEY'));
    let sent = 0;
    ai._setClients({ retryDelayMs: 0, gemini: { interactions: { create: async () => { sent++; throw new Error('Headers.append: "AIzaLEAKY000000000000000000" is an invalid header value'); } } } });
    const r = await ai.organize(capInput('leak'));
    assert.strictEqual(r.ok, false);
    assert.ok(!JSON.stringify(r).includes('LEAKY'));
    assert.strictEqual(sent, 2);
  });
  await withEnv({ GEMINI_API_KEY: 'AIzaBAD\n000000000000000000' }, async () => {
    const s = freshAi().status();
    assert.strictEqual(s.configured, false);
    assert.match(s.reason, /공백이나 줄바꿈/);
  });
});

test('Gemini 400 + API_KEY_INVALID 는 키 오류로 안내한다', async () => {
  await withEnv({ GEMINI_API_KEY: 'g' }, async () => {
    const ai = freshAi();
    ai._setClients({ retryDelayMs: 0, gemini: { interactions: { create: async () => { throw Object.assign(new Error('API key not valid. Please pass a valid API key. [API_KEY_INVALID]'), { status: 400 }); } } } });
    const r = await ai.organize(capInput('k400'));
    assert.strictEqual(r.error.type, 'auth');
  });
});

test('한 줄만 종류 바꾸기: 다른 줄은 그대로, 숨은 원문이 중간에 드러나지 않는다', () => {
  const st = setup();
  const note = submit(st, '- [ ] 견적서 보내기\n- [ ] 설문 정리하기');
  assert.strictEqual(note.captureRole, 'task_source');
  const [r1, r2] = note.capture.created;
  P.captureSetItemKind(st, note.id, r1, 'event', NOW);
  assert.strictEqual(note.captureRole, 'task_source');
  assert.deepStrictEqual(note.capture.created.map((c) => c.kind), ['block', 'task']);
  assert.strictEqual(note.capture.created[1].id, r2.id);
  assert.strictEqual(note.capture.status, 'done');
  // 일정 줄을 링크로: 그 줄은 빠지고 원문이 링크 메모로 보인다
  P.captureSetItemKind(st, note.id, note.capture.created[0], 'link', NOW);
  assert.strictEqual(note.captureRole, 'memo');
  assert.strictEqual(note.kind, 'link');
  assert.deepStrictEqual(P.captureItems(st, note).map((i) => i.kind), ['link', 'task']);
  assert.ok(!('__holdReveal' in st));
});

// ---------------------------------------------------------------- 상대 시각 일정 ("30분 후 샤워하기")
test('상대 시각: "30분 후" 일정은 앱이 기준 시각으로 계산해 바로 캘린더에 넣는다 (길이 없으면 30분)', () => {
  const st = setup();
  const at = new Date(2026, 9, 9, 21, 5);
  const note = M.addNote(st, { title: '', body: '오늘 일정에 30분 후 샤워하기', capture: { status: 'pending', at: at.toISOString() } }, at);
  note.updatedAt = at.toISOString();
  // AI 가 기준 시각을 UTC 로 잘못 읽어 12:35 를 줬다고 해도 앱 계산(21:35)이 이긴다
  const out = { summary: '', sections: [], tasks: [], open_questions: [], entry_type: 'task', note_title: '샤워', note_project_hint: null, note_kind: 'memo',
    events: [{ title: '샤워', evidence: { quote: '오늘 일정에 30분 후 샤워하기', line: 1 }, start: { text: '30분 후', date: '2026-10-09', time: '12:35' }, duration_minutes: null, location: null, project_hint: null, basis: 'explicit' }] };
  const v = V.validateOrganizeNote(out, { note, state: st, now: at });
  assert.ok(v.ok, v.errors.join());
  const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, at);
  P.applyCapture(st, { note, run, validated: v, output: out }, at);
  assert.strictEqual(st.blocks.length, 1);
  const b = st.blocks[0];
  const s = new Date(b.start), e = new Date(b.end);
  assert.deepStrictEqual([s.getDate(), s.getHours(), s.getMinutes()], [9, 21, 35]);
  assert.strictEqual(e - s, 30 * 60000);
  assert.strictEqual(b.durationGuessed, true);
  assert.strictEqual(live(st.tasks).length, 0);
});

test('상대 시각 표현: 분·시간·반·한글 숫자, 자정 넘김', () => {
  const V2 = require('../src/core/ai/validate');
  const note = (body, at) => ({ id: 'x', title: '', body, updatedAt: at.toISOString() });
  function startOf(body, text, at) {
    const out = { summary: '', sections: [], tasks: [], open_questions: [],
      events: [{ title: 't', evidence: { quote: body, line: 1 }, start: { text, date: null, time: null }, duration_minutes: 30, location: null, project_hint: null, basis: 'explicit' }] };
    const v = V2.validateOrganizeNote(out, { note: note(body, at), state: M.emptyState(), now: at });
    const f = v.items[0].fields;
    return [f.date.value, f.time.value];
  }
  const at = new Date(2026, 9, 9, 21, 5);
  assert.deepStrictEqual(startOf('1시간 반 뒤에 전화', '1시간 반 뒤', at), ['2026-10-09', '22:35']);
  assert.deepStrictEqual(startOf('한 시간 후 회의', '한 시간 후', at), ['2026-10-09', '22:05']);
  assert.deepStrictEqual(startOf('3시간 뒤 출발', '3시간 뒤', at), ['2026-10-10', '00:05']);
  assert.deepStrictEqual(startOf('10분 있다가 전화', '10분 있다가', at), ['2026-10-09', '21:15']);
});

test('프롬프트의 기준 시각은 현지 시각(UTC 표기 아님)', () => {
  const O = require('../src/core/ai/organizeNote');
  const at = new Date(2026, 9, 9, 21, 5);
  const input = O.buildInput({ id: 'n', title: '', body: 'x', updatedAt: at.toISOString() }, { today: '2026-10-09 (금)', projects: [], openTasks: [] });
  const text = O.userText(input);
  assert.match(text, /기준 시각.*2026-10-09 21:05 \(금\)/);
  assert.ok(!/기준 시각.*Z\b/.test(text));
});

// ---------------------------------------------------------------- 시간 정한 할 일 (do_at)
test('시간 정한 할 일: "30분 후 샤워하기" 는 할 일 + 그 시각 작업 시간(30분), 체크해야 끝난다', () => {
  const st = setup();
  const at = new Date(2026, 9, 9, 21, 5);
  const note = M.addNote(st, { title: '', body: '오늘 일정에 30분 후 샤워하기', capture: { status: 'pending', at: at.toISOString() } }, at);
  note.updatedAt = at.toISOString();
  const input = C.buildInput(note, { today: '2026-10-09 (금)', projects: [], openTasks: [] });
  const out = fake.organize(input).output;
  const v = V.validateOrganizeNote(out, { note, state: st, now: at });
  const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, at);
  P.applyCapture(st, { note, run, validated: v, output: out }, at);
  const t = live(st.tasks)[0];
  assert.ok(t, '할 일이 생겨야 한다');
  const work = st.blocks.filter((b) => b.taskId === t.id);
  assert.strictEqual(work.length, 1);
  assert.strictEqual(work[0].kind, 'work');
  const s = new Date(work[0].start);
  assert.deepStrictEqual([s.getDate(), s.getHours(), s.getMinutes()], [9, 21, 35]);
  assert.strictEqual(new Date(work[0].end) - s, 30 * 60000);
  // 일정으로 바꾸면 작업 시간 그 시각의 일정, 다시 할 일로 바꾸면 작업 시간이 돌아온다
  P.captureSetKind(st, note.id, 'event', at);
  const ev = st.blocks.filter((b) => b.kind === 'event');
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(new Date(ev[0].start).getHours(), 21);
  assert.strictEqual(st.blocks.filter((b) => b.kind === 'work').length, 0);
  P.captureSetKind(st, note.id, 'task', at);
  const t2 = live(st.tasks)[0];
  assert.strictEqual(st.blocks.filter((b) => b.kind === 'work' && b.taskId === t2.id).length, 1);
});

test('시간 정한 할 일: 시각을 검증 못 하면 할 일만 만들고 작업 시간은 만들지 않는다', () => {
  const st = setup();
  const at = new Date(2026, 9, 9, 10, 0);
  const note = M.addNote(st, { title: '', body: '이따 보고서 쓰기', capture: { status: 'pending', at: at.toISOString() } }, at);
  note.updatedAt = at.toISOString();
  const out = { summary: '', sections: [], events: [], open_questions: [], entry_type: 'task', note_title: '보고서', note_project_hint: null, note_kind: 'memo',
    tasks: [{ title: '보고서 쓰기', evidence: { quote: '이따 보고서 쓰기', line: 1 }, due: { text: null, date: null, time: null }, do_at: { text: '이따', date: '2026-10-09', time: '15:00' }, project_hint: null, basis: 'explicit', size: 'small', breakdown: [] }] };
  const v = V.validateOrganizeNote(out, { note, state: st, now: at });
  const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, at);
  P.applyCapture(st, { note, run, validated: v, output: out }, at);
  assert.strictEqual(live(st.tasks).length, 1);
  assert.strictEqual(st.blocks.length, 0);
});

// ---------------------------------------------------------------- 완료 보고 ("샤워 완료")
function submitWith(st, text, at) {
  const note = M.addNote(st, { title: '', body: text, capture: { status: 'pending', at: at.toISOString() } }, at);
  note.updatedAt = at.toISOString();
  const open = M.liveTasks(st).filter((t) => t.status !== 'done').map((t) => t.title);
  const input = C.buildInput(note, { today: '2026-10-09 (금)', projects: [], openTasks: open });
  const out = fake.organize(input).output;
  const v = V.validateOrganizeNote(out, { note, state: st, now: at });
  const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, at);
  P.applyCapture(st, { note, run, validated: v, output: out }, at);
  return { note, out };
}

test('완료 보고: "샤워 완료" 는 메모가 아니라 열린 할 일 "샤워하기" 를 완료한다 (히스토리에도 남음)', () => {
  const st = setup();
  const at = new Date(2026, 9, 9, 22, 0);
  const t = M.addTask(st, { title: '샤워하기' }, at);
  const { note, out } = submitWith(st, '샤워 완료', at);
  assert.deepStrictEqual(out.done_tasks.map((d) => d.title), ['샤워하기']);
  assert.strictEqual(t.status, 'done');
  assert.strictEqual(note.capture.entryType, 'done');
  assert.strictEqual(note.captureRole, 'task_source');          // 메모 목록에 "샤워 완료" 가 쌓이지 않음
  assert.ok(st.history.some((h) => h.type === 'task_done' && h.refs.some((r) => r.id === t.id)));
  assert.deepStrictEqual(P.captureItems(st, note).map((i) => i.kind), ['done']);
  // × (완료 취소): 할 일은 다시 열리고, 완료 기록도 지워지고, 원문은 메모로 보인다
  P.captureRemoveItem(st, note.id, { kind: 'done', id: t.id }, at);
  assert.strictEqual(t.status, 'todo');
  assert.ok(!st.history.some((h) => h.type === 'task_done' && h.refs.some((r) => r.id === t.id)));
  assert.strictEqual(note.captureRole, 'memo');
});

test('완료 보고: 근거가 원문에 없거나, 목록에 없거나, 여러 개와 애매하게 겹치면 완료하지 않는다', () => {
  const st = setup();
  const at = new Date(2026, 9, 9, 22, 0);
  const a = M.addTask(st, { title: '보고서 초안 쓰기' }, at);
  const b = M.addTask(st, { title: '보고서 표 정리' }, at);
  const note = M.addNote(st, { title: '', body: '보고서 완료', capture: { status: 'pending', at: at.toISOString() } }, at);
  note.updatedAt = at.toISOString();
  const base = { summary: '', sections: [], tasks: [], events: [], open_questions: [], entry_type: 'done', note_title: '보고서', note_project_hint: null, note_kind: 'memo' };
  const apply = (done) => {
    const out = Object.assign({}, base, { done_tasks: done });
    const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, at);
    note.capture = { status: 'pending' };
    P.applyCapture(st, { note, run, validated: V.validateOrganizeNote(out, { note, state: st, now: at }), output: out }, at);
  };
  apply([{ title: '보고서', evidence: { quote: '보고서 완료', line: 1 } }]);          // 둘 다 품음 → 고르지 않음
  apply([{ title: '보고서 초안 쓰기', evidence: { quote: '초안 다 씀', line: 1 } }]);   // 근거가 원문에 없음
  apply([{ title: '회의록 공유', evidence: { quote: '보고서 완료', line: 1 } }]);       // 목록에 없음
  assert.strictEqual(a.status, 'todo');
  assert.strictEqual(b.status, 'todo');
  assert.strictEqual(note.capture.entryType, 'memo');
  assert.strictEqual(note.captureRole, 'memo');
});

// ---------------------------------------------------------------- 날짜 바꾸기 ("견적서는 내일 보낼게")
test('날짜 바꾸기: "견적서는 내일 보낼게" 는 새 할 일이 아니라 기존 할 일 마감을 내일로, × 로 되돌린다', () => {
  const st = setup();
  const at = new Date(2026, 9, 9, 22, 0);
  const t = M.addTask(st, { title: '견적서 보내기', dueDate: '2026-10-09' }, at);
  const { note, out } = submitWith(st, '견적서는 내일 보낼게', at);
  assert.deepStrictEqual(out.updated_tasks.map((u) => u.title), ['견적서 보내기']);
  assert.strictEqual(live(st.tasks).length, 1);                     // 새 할 일을 만들지 않음
  assert.strictEqual(t.dueDate, '2026-10-10');
  assert.strictEqual(note.capture.entryType, 'update');
  assert.strictEqual(note.captureRole, 'task_source');
  assert.deepStrictEqual(P.captureItems(st, note).map((i) => i.kind), ['moved']);
  P.captureRemoveItem(st, note.id, { kind: 'moved', id: t.id }, at);
  assert.strictEqual(t.dueDate, '2026-10-09');
  assert.strictEqual(note.captureRole, 'memo');
});

test('날짜 바꾸기: 할 시각(do_at)이면 작업 시간을 옮기거나 만든다. 지난 날짜·검증 안 되는 날짜는 받지 않는다', () => {
  const st = setup();
  const at = new Date(2026, 9, 9, 15, 0);
  const t = M.addTask(st, { title: '운동하기' }, at);
  const note = M.addNote(st, { title: '', body: '운동은 저녁 7시에 할게', capture: { status: 'pending', at: at.toISOString() } }, at);
  note.updatedAt = at.toISOString();
  const base = { summary: '', sections: [], tasks: [], events: [], open_questions: [], entry_type: 'update', note_title: '운동', note_project_hint: null, note_kind: 'memo', done_tasks: [] };
  const apply = (u) => {
    const out = Object.assign({}, base, { updated_tasks: u });
    const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, at);
    note.capture = { status: 'pending' };
    P.applyCapture(st, { note, run, validated: V.validateOrganizeNote(out, { note, state: st, now: at }), output: out }, at);
  };
  const nul = { text: null, date: null, time: null };
  apply([{ title: '운동하기', evidence: { quote: '운동은 저녁 7시에 할게', line: 1 }, due: nul, do_at: { text: '저녁 7시', date: '2026-10-09', time: '19:00' } }]);
  const w = st.blocks.filter((b) => b.taskId === t.id && b.kind === 'work');
  assert.strictEqual(w.length, 1);
  assert.strictEqual(new Date(w[0].start).getHours(), 19);
  assert.strictEqual(t.dueDate, null);                                 // 마감은 그대로
  // × 로 되돌리면 새로 만든 작업 시간은 지운다
  P.captureRemoveItem(st, note.id, { kind: 'moved', id: t.id }, at);
  assert.strictEqual(st.blocks.filter((b) => b.taskId === t.id).length, 0);
  // 원문에 없는 날짜 표현 / 지난 날짜는 무시
  apply([{ title: '운동하기', evidence: { quote: '운동은 저녁 7시에 할게', line: 1 }, due: { text: '다음 주 월요일', date: '2026-10-12', time: null }, do_at: nul }]);
  apply([{ title: '운동하기', evidence: { quote: '운동은 저녁 7시에 할게', line: 1 }, due: { text: null, date: '2026-10-01', time: null }, do_at: nul }]);
  assert.strictEqual(t.dueDate, null);
  assert.strictEqual(note.capture.entryType, 'memo');
});
