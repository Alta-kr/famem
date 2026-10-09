'use strict';

// UX 스크린샷 — `electron . --profile=shots --shots` 로 창을 띄우지 않고 화면별 PNG 를 만든다.
// 시계를 고정하고 샘플 데이터를 불러와 언제 찍어도 같은 모습이 나오게 한다.
// AI 정리 화면은 데모 모드(규칙 기반 가짜 AI)로 찍는다 — 화면에도 '데모 모드 · 실제 AI 아님' 으로 표시된다.

const fs = require('fs');
const path = require('path');

process.env.DAYNOTE_AI_FAKE = '1';

const NOW = '2026-10-05T10:00:00';   // 월요일 오전

const MEMO = [
  '- [ ] 설문 문항 정리해서 금요일까지 공유',
  '수요일 오후 3시 디자인 리뷰 회의',
  '목요일까지 견적서 회신 부탁드립니다.',
  '예산 논의는 다음에 해야 함',
  '',
  '참석: 김민지, 박준호'
].join('\n');

// [파일 이름, 화면에서 실행할 코드(Promise 가능), 설명]
const STEPS = [
  ['01-첫실행-오늘', `
    window.__daynoteNow = '${NOW}';
    // 지난 실행의 데이터를 다 불러온 뒤에 비워야 첫 화면(안내)이 찍힌다
    new Promise(r => Daynote.store.whenReady(r)).then(() => {
      Daynote.store.replaceAll(Daynote.model.emptyState());
      Daynote.store.mutate(null, s => { s.prefs.theme = 'light'; }, { silent: true });   // OS 테마와 상관없이 같은 모습
      Daynote.app.applyPrefs();
      Daynote.app.go('today');
      return new Promise(r => setTimeout(r, 400));
    });`],
  ['02-홈-채팅-할일메모-일정', `
    Daynote.app.loadSample();
    clearToasts();
    Daynote.store.mutate(null, s => { s.meta.lastNudgeAt = new Date('${NOW}').toISOString(); });
    Daynote.app.go('today');
    var wait = (ms) => new Promise(r => setTimeout(r, ms));
    var throws = ['내일까지 견적서 보내기', '목요일 오후 2시 팀 회의', '온보딩에 퀴즈 넣으면 어떨까', 'https://linear.app/method 나중에 읽기', '오늘 회의 분위기 좋았음\\n온보딩 설문은 내일까지 정리해서 공유 부탁드립니다'];
    throws.reduce((p, t) => p.then(() => { Daynote.assistant.send(t); return wait(700); }), Promise.resolve())
      .then(() => wait(900)).then(() => { clearToasts(); var l = document.querySelector('.chat-list'); l.scrollTop = l.scrollHeight; });`],
  ['02a-홈-종류메뉴', `
    var ks = document.querySelectorAll('.cap-kind');
    ks[ks.length - 1].click(); null;`],
  ['02b-홈-작게나누기-제안', `
    Daynote.ui.closeMenu();
    Daynote.store.mutate(null, s => { s.meta.lastNudgeAt = null; });
    Daynote.assistant.tryNudge('completed');
    new Promise(r => setTimeout(r, 300)).then(() => { var l = document.querySelector('.chat-list'); l.scrollTop = l.scrollHeight; });`],
  ['02c-홈-다음할일-휴식', `
    Daynote.assistant.next();
    Daynote.assistant.rest();
    new Promise(r => setTimeout(r, 300)).then(() => { var l = document.querySelector('.chat-list'); l.scrollTop = l.scrollHeight; });`],
  ['03-메모-AI정리전', `
    window.__daynoteNow = '${NOW}';
    var n = Daynote.store.mutate(null, s => Daynote.model.addNote(s, { title: '온보딩 주간 회의', body: ${JSON.stringify(MEMO)}, projectId: s.projects[0].id }, new Date('${NOW}')));
    window.__shotNote = n.id;
    Daynote.app.go('notes', { noteId: n.id });`],
  ['04-AI검토-초안목록', `
    document.querySelector('.btn-ai').click();
    new Promise(r => setTimeout(r, 1500)).then(clearToasts);`],
  ['05-AI검토-확인필요-이동', `
    var b = [...document.querySelectorAll('.review-foot button')].find(x => x.textContent.includes('확인할 항목'));
    if (b) b.click();`],
  ['06-AI검토-부분저장후', `
    [...document.querySelectorAll('.review-foot button')].find(x => x.className.includes('primary')).click();
    new Promise(r => setTimeout(r, 300)).then(() => { document.querySelector('.review-body').scrollTop = 0; });`],
  ['07-AI검토-전체완료', `
    var c = [...document.querySelectorAll('.ai-card')].find(x => x.textContent.includes('일정'));
    var d = c && c.querySelector('select[data-fk$=":durationMinutes"]');
    if (d) { d.value = '60'; d.dispatchEvent(new Event('change', { bubbles: true })); }
    new Promise(r => setTimeout(r, 300)).then(() => {
      [...document.querySelectorAll('.review-foot button')].find(x => x.className.includes('primary')).click();
      return new Promise(r => setTimeout(r, 400));
    }).then(() => { document.querySelector('.review-body').scrollTop = 0; });`],
  ['08-할일-목록', `
    clearToasts();
    Daynote.app.go('tasks');`],
  ['09-할일-상세패널', `
    var t = Daynote.store.state.tasks.find(x => x.origin === 'ai_accepted') || Daynote.store.state.tasks[0];
    Daynote.app.openTask(t.id);`],
  ['10-캘린더-주간', `
    Daynote.app.closeDetail();
    Daynote.app.go('calendar');
    new Promise(r => setTimeout(r, 200)).then(() => { document.querySelector('.cal-scroll').scrollTop = 8 * 48; });`],
  ['11-캘린더-일정배치대화상자', `
    var t = Daynote.store.state.tasks.find(x => x.status !== 'done' && !x.deletedAt);
    Daynote.app.scheduleTask(t.id); null;`],
  ['11b-일정배치대화상자-모션줄이기', `
    document.querySelectorAll('.overlay').forEach(o => o.remove());
    Daynote.store.mutate(null, s => { s.prefs.reduceMotion = true; });
    var t = Daynote.store.state.tasks.find(x => x.status !== 'done' && !x.deletedAt);
    Daynote.app.scheduleTask(t.id); null;`],
  ['12-프로젝트-히스토리', `
    document.querySelectorAll('.overlay').forEach(o => o.remove());
    Daynote.store.mutate(null, s => { s.prefs.reduceMotion = false; });
    Daynote.app.go('projects', { projectId: Daynote.store.state.projects[0].id });`],
  ['13-주간정리-보고서-미리보기', `
    Daynote.app.go('weekly');
    new Promise(r => setTimeout(r, 200)).then(() => {
      var b = [...document.querySelectorAll('#view button')].find(x => x.textContent.includes('초안 만들기'));
      if (b) b.click();
      return new Promise(r => setTimeout(r, 300));
    }).then(clearToasts);`],
  ['13b-주간정리-보고서-편집', `
    [...document.querySelectorAll('.report-toolbar .seg button')].find(x => x.textContent === '편집').click();`],
  ['14-새할일제안-추천함', `
    Daynote.app.go('inbox');
    new Promise(r => setTimeout(r, 300)).then(clearToasts);`],
  ['14b-보관함-할일필터', `
    clearToasts();
    Daynote.app.go('archive', { kind: 'task' });`],
  ['14c-검색명령-CtrlK', `
    Daynote.app.go('today');
    Daynote.palette.open('온보딩'); null;`],
  ['15-연결과설정', `
    Daynote.palette.close();
    clearToasts();
    Daynote.app.go('settings');`],
  ['15b-홈-다크모드', `
    Daynote.store.mutate(null, s => { s.prefs.theme = 'dark'; }, { silent: true });
    Daynote.app.applyPrefs();
    Daynote.app.go('today');
    new Promise(r => setTimeout(r, 200)).then(() => { var l = document.querySelector('.chat-list'); l.scrollTop = l.scrollHeight; });`],
  ['16-작은창-1280x800', `
    Daynote.store.mutate(null, s => { s.prefs.theme = 'light'; }, { silent: true });
    Daynote.app.applyPrefs();
    Daynote.app.go('today');`, { width: 1280, height: 800 }]
];

// 모든 단계 앞에 붙는 도우미: 알림 지우기
const PRELUDE = `window.clearToasts = function () { document.querySelectorAll('.toast').forEach(t => t.remove()); };`;
// 캡처 직전: 진행 중인 전환 애니메이션을 끝 상태로 (숨긴 창에서는 애니메이션이 진행되지 않아 반투명하게 찍힌다)
const SETTLE = `document.getAnimations().forEach(a => { try { a.finish(); } catch (e) {} }); null;`;

module.exports = async function takeShots(win, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(1200);
  const done = [];
  for (const [name, js, size] of STEPS) {
    if (size) { win.setContentSize(size.width, size.height); await wait(400); }
    try {
      // 마지막 식이 Promise 면 끝날 때까지 기다린다 (화면의 CSP 때문에 eval 은 쓰지 않는다)
      await win.webContents.executeJavaScript(PRELUDE + js, true);
    } catch (e) {
      console.log('SHOT-ERROR ' + name + ' ' + e.message);
    }
    await wait(700);
    await win.webContents.executeJavaScript(SETTLE, true);
    // 숨긴 창은 첫 캡처에 지난 화면이 찍힐 수 있다 — 다시 그리게 하고 한 번 버린 뒤 찍는다
    try { win.webContents.invalidate(); } catch (e) {}
    await wait(100);
    if (!done.length) { await win.webContents.capturePage(); await wait(200); }
    const img = await win.webContents.capturePage();
    const file = path.join(outDir, name + '.png');
    fs.writeFileSync(file, img.toPNG());
    done.push(file);
    console.log('SHOT ' + file + ' ' + img.getSize().width + 'x' + img.getSize().height);
  }
  return done;
};
