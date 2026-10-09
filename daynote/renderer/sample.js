'use strict';

// 샘플 데이터 — 처음 실행했을 때 앱이 어떻게 쓰이는지 보여 준다.
// 모든 날짜는 now 를 기준으로 계산하므로 언제 열어도 "오늘·이번 주" 가 의미 있게 보인다.
// 모든 항목은 sample:true 라서 model.clearSample 로 사용자 항목만 남기고 지울 수 있다.

(function (factory) {
  var deps = (typeof module !== 'undefined' && module.exports)
    ? { dates: require('../src/core/dates'), model: require('../src/core/model') }
    : { dates: window.Daynote.dates, model: window.Daynote.model };
  var api = factory(deps.dates, deps.model);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.sample = api; }
})(function (D, M) {
  function build(state, now) {
    now = now ? new Date(now) : new Date();
    var S = { sample: true };
    function day(n) { return D.ymd(D.addDays(now, n)); }
    function atDay(n, h, m) { var d = D.addDays(D.startOfDay(now), n); d.setHours(h, m || 0, 0, 0); return d; }
    function minsAgo(n) { return D.addMinutes(now, -n); }
    function iso(d) { return d.toISOString(); }
    function x(fields) { return Object.assign({}, S, fields); }

    // ── 프로젝트
    var pOnb = M.addProject(state, x({ name: '신규 온보딩 개선', description: '신규 입사자 첫 2주 경험 정리' }), now);
    var pRep = M.addProject(state, x({ name: '3분기 리포트', description: '3분기 실적 정리와 경영진 보고' }), now);
    var pSem = M.addProject(state, x({ name: '사내 세미나', description: '다음 달 사내 기술 세미나 준비' }), now);

    // ── 메모
    var nMeet = M.addNote(state, x({
      title: '온보딩 개선 회의',
      projectId: pOnb.id,
      body: '참석: 김민지, 박준호, 나\n\n## 결정\n- 첫 주 체크리스트를 노션에서 앱 안으로 옮긴다\n\n## 할 일\n- [ ] 신규 입사자 설문 문항 정리\n- [ ] 멘토 배정 기준 초안 작성\n- [x] 지난 분기 온보딩 피드백 모으기\n\n준호님, 다음 주 수요일까지 설문 초안 검토 부탁드립니다.\n'
    }), minsAgo(60 * 26));
    var nRep = M.addNote(state, x({
      title: '3분기 리포트 구성',
      projectId: pRep.id,
      body: '1. 핵심 지표 요약\n2. 분기 목표 대비 결과\n3. 다음 분기 계획\n\n> 매출 데이터는 재무팀 확정본을 기다리는 중\n'
    }), minsAgo(60 * 50));
    var nSem = M.addNote(state, x({
      title: '세미나 아이디어',
      projectId: pSem.id,
      body: '- 사내 자동화 도구 소개 (20분)\n- 장애 회고 사례 공유\n- 질의응답 15분\n'
    }), minsAgo(60 * 5));
    M.addNote(state, x({
      title: '점심 이후 집중 시간 확보하기',
      body: '오후 2시~4시는 회의 잡지 않기'
    }), minsAgo(30));

    // ── 할 일
    function task(fields, createdMinsAgo) { return M.addTask(state, x(fields), minsAgo(createdMinsAgo || 120)); }

    var tOverdue = task({ title: '분기 지표 대시보드 캡처 정리', projectId: pRep.id, dueDate: day(-2), estimateMinutes: 30, priority: 'high' }, 60 * 72);
    var tToday20 = task({ title: '멘토 배정 기준 초안 작성', projectId: pOnb.id, dueDate: day(0), dueTime: '18:00', estimateMinutes: 20,
      sources: [{ type: 'note', refId: nMeet.id, excerpt: '- [ ] 멘토 배정 기준 초안 작성' }] }, 60 * 24);
    var tToday60 = task({ title: '경영진 보고 슬라이드 다듬기', projectId: pRep.id, dueDate: day(0), estimateMinutes: 60, priority: 'high' }, 60 * 30);
    task({ title: '세미나 발표자 섭외 메일 보내기', projectId: pSem.id, dueDate: day(1), estimateMinutes: 15 }, 60 * 20);
    task({ title: '온보딩 설문 결과 요약', projectId: pOnb.id, dueDate: day(4), estimateMinutes: 45, priority: 'low' }, 60 * 10);
    task({ title: '개인 업무 도구 정리', estimateMinutes: 25, priority: 'low' }, 60 * 8);
    task({ title: '세미나 장소 후보 알아보기', projectId: pSem.id, dueDate: day(5) }, 60 * 6);
    task({ title: '팀 회고 안건 정리', estimateMinutes: 30, estimateSource: 'ai' }, 60 * 4);
    var tWait = task({ title: '3분기 매출 확정본 반영', projectId: pRep.id, status: 'waiting', waitingFor: '재무팀 확정 데이터 회신 대기', dueDate: day(3), estimateMinutes: 40,
      sources: [{ type: 'note', refId: nRep.id, excerpt: '매출 데이터는 재무팀 확정본을 기다리는 중' }] }, 60 * 40);
    task({ title: '리포트 최종본 공유', projectId: pRep.id, dueDate: day(4), estimateMinutes: 15, blockedBy: [tWait.id] }, 60 * 40);
    task({ title: '노트북 교체 신청서 작성', estimateMinutes: 10, snoozedUntil: iso(atDay(1, 9)) }, 60 * 48);
    var tProg = task({ title: '세미나 발표 자료 목차 잡기', projectId: pSem.id, status: 'in_progress', startedAt: iso(minsAgo(90)), dueDate: day(2), estimateMinutes: 40,
      sources: [{ type: 'note', refId: nSem.id, excerpt: '사내 자동화 도구 소개 (20분)' }] }, 60 * 3);
    var tLong = task({ title: '신규 입사자 가이드 문서 개편', projectId: pOnb.id, dueDate: day(6), estimateMinutes: 120, priority: 'normal',
      steps: [
        { id: 'step_s1', title: '기존 문서 훑어보고 빠진 내용 표시', estimateMinutes: 20, done: false },
        { id: 'step_s2', title: '목차 새로 짜기', estimateMinutes: 40, done: false },
        { id: 'step_s3', title: '본문 다시 쓰기', estimateMinutes: 60, done: false }
      ] }, 60 * 30);

    // 이번 주 완료 3개 — completeTask 로 히스토리 자동 기록
    var doneSpecs = [
      { title: '지난 분기 온보딩 피드백 모으기', projectId: pOnb.id, ago: 60 * 3 },
      { title: '세미나 일정 공지 초안', projectId: pSem.id, ago: 60 * 6 },
      { title: '리포트 목차 확정', projectId: pRep.id, ago: 60 * 2 }
    ];
    doneSpecs.forEach(function (d) {
      var t = task({ title: d.title, projectId: d.projectId, estimateMinutes: 30 }, d.ago + 60 * 24);
      M.completeTask(state, t.id, minsAgo(d.ago));
    });
    state.history.forEach(function (h) { h.sample = true; });

    // ── 일정 블록
    function block(fields) { return M.addBlock(state, x(fields)); }
    var mtgStart = D.addMinutes(now, 30);
    block({ title: '팀 주간 회의', start: iso(mtgStart), end: iso(D.addMinutes(mtgStart, 60)) });
    block({ taskId: tToday60.id, title: tToday60.title, start: iso(atDay(0, 14)), end: iso(atDay(0, 15)) });
    block({ title: '1:1 미팅', start: iso(atDay(1, 11)), end: iso(atDay(1, 11, 30)) });
    block({ title: '세미나 준비 회의', start: iso(atDay(2, 15)), end: iso(atDay(2, 16)) });
    block({ title: '재무팀 리뷰', start: iso(atDay(3, 10)), end: iso(atDay(3, 11)) });
    // 일부러 겹치는 한 쌍 (충돌 표시 확인용)
    block({ title: '디자인 리뷰', start: iso(atDay(3, 10, 30)), end: iso(atDay(3, 11, 30)) });
    block({ taskId: tLong.id, title: tLong.title, start: iso(atDay(4, 13)), end: iso(atDay(4, 15)) });

    // ── 수동 히스토리
    function hist(fields, minsBack) { return M.addHistory(state, x(fields), minsAgo(minsBack)); }
    var ref = {
      meet: { kind: 'note', id: nMeet.id, label: '온보딩 개선 회의' },
      rep: { kind: 'note', id: nRep.id, label: '3분기 리포트 구성' },
      wait: { kind: 'task', id: tWait.id, label: tWait.title },
      prog: { kind: 'task', id: tProg.id, label: tProg.title },
      over: { kind: 'task', id: tOverdue.id, label: tOverdue.title }
    };
    hist({ type: 'decision', projectId: pOnb.id, title: '첫 주 체크리스트를 앱 안으로 옮기기로 결정', body: '노션 문서는 읽기 전용으로 남긴다.', refs: [ref.meet] }, 60 * 26);
    hist({ type: 'decision', projectId: pRep.id, title: '리포트는 지표 요약을 맨 앞에 두기로', refs: [ref.rep] }, 60 * 24 * 8);
    hist({ type: 'blocker', projectId: pRep.id, title: '매출 확정 데이터 지연', body: '재무팀 마감이 늦어져 리포트 최종본이 밀림.', refs: [ref.wait] }, 60 * 30);
    hist({ type: 'achievement', projectId: pOnb.id, title: '온보딩 만족도 설문 응답률 85% 달성', refs: [ref.meet] }, 60 * 24 * 9);
    hist({ type: 'update', projectId: pSem.id, title: '발표 자료 목차 초안 시작', refs: [ref.prog] }, 90);

    // ── 이메일
    function mail(n, from, subject, minsBack, body) {
      state.emails.push({ id: 'mail_sample_' + n, messageId: '<sample-' + n + '@sample.daynote>', from: from, subject: subject,
        receivedAt: iso(minsAgo(minsBack)), body: body, sample: true });
    }
    mail(1, '박준호 <junho.park@example.com>', '온보딩 설문 초안 공유드립니다', 60 * 3,
      '안녕하세요.\n설문 초안 첨부합니다. ' + D.relDay(day(2), now) + '까지 문항 검토 부탁드립니다.\n감사합니다.');
    mail(2, '이서연 <seoyeon.lee@example.com>', '세미나 발표 시간 조율 요청', 60 * 6,
      '세미나 발표 순서를 정하려고 합니다. 가능한 시간대를 이번 주 안에 회신해 주실 수 있을까요?');
    mail(3, '재무팀 <finance@example.com>', '[요청] 3분기 비용 증빙 제출', 60 * 20,
      '3분기 비용 증빙을 ' + D.relDay(day(3), now) + '까지 공유 폴더에 올려 주세요.');
    mail(4, '총무팀 <office@example.com>', '[공지] 사무실 소독 안내', 60 * 28,
      '이번 주 금요일 오후 6시 이후 사무실 전체 소독이 진행됩니다. 개인 물품을 정리해 주세요.');

    state.meta.sampleLoaded = true;
    return state;
  }

  return { build: build };
});
