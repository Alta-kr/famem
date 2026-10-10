'use strict';

// 현재 상태 — 말 사전·맥락 사전·프리셋 데이터 (DN.statusWords, 줄여 SW).
//
// 이 모듈은 데이터만 담는다. 함수도, 상태 변경도 없다. 읽는 곳은 src/core/status.js(DN.statusCore)와 테스트뿐이다.
// 화면 코드는 SW 를 직접 읽지 않고 ST.* 를 거친다.
//
// ── 원칙 ─────────────────────────────────────────────────────────
//   · 공통 사전(PHRASES)에는 뜻이 하나인 말만 둔다. 직업마다 뜻이 다른 말(오프·데이·마감했어·공강 …)은
//     프리셋 전용 말(PRESET_WORDS)로만 둔다. 다른 프리셋에서는 프리셋 제안 신호로만 센다.
//   · 오타는 사전에 넣지 않는다(오탐이 미탐보다 비싸다). 느슨한 맞춤은 /상태 명령에서만 한다.
//   · 정책표 값: 'up' 띄움 · 'normal' 보통 · 'down' 내림 · 'hide' 숨김 · 'after' (= 그 프로필의 afterWork 값)

(function (factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.statusWords = api; }
})(function () {
  // ------------------------------------------------------------------ 상태 (§2.2)
  // category: work 업무 · life 생활 · rest 쉬는 날 · moving 이동 · sleep 잠 · none 모두 보기 · overlay 덧씌움
  // place: office · home · out · moving · null.  minutes: 덧씌움 기본 분.  rec: normal|short|none
  // stale: 명시한 상태가 낡는 규칙 (h: 시간 뒤 · 'dayStart': since 뒤 첫 하루 시작 · 'until': 끝 시각)
  var STATUSES = {
    work:     { label: '업무 중',        category: 'work',    place: 'office', minutes: null, rec: 'normal', nudges: true,  busy: false, icon: 'briefcase', stale: { h: 16 } },
    wfh:      { label: '재택 근무',      category: 'work',    place: 'home',   minutes: null, rec: 'normal', nudges: true,  busy: false, icon: 'home',      stale: { h: 16 } },
    field:    { label: '외근 중',        category: 'work',    place: 'out',    minutes: null, rec: 'normal', nudges: true,  busy: false, icon: 'walk',      stale: { h: 16 } },
    to_work:  { label: '출근길',         category: 'moving',  place: 'moving', minutes: null, rec: 'normal', nudges: true,  busy: false, icon: 'train',     stale: { h: 2 } },
    to_home:  { label: '퇴근길',         category: 'moving',  place: 'moving', minutes: null, rec: 'normal', nudges: true,  busy: false, icon: 'train',     stale: { h: 2 } },
    out:      { label: '외출 중',        category: 'life',    place: 'out',    minutes: null, rec: 'normal', nudges: true,  busy: false, icon: 'bag',       stale: { h: 4 } },
    off:      { label: '퇴근 · 내 시간', category: 'life',    place: 'home',   minutes: null, rec: 'normal', nudges: true,  busy: false, icon: 'leaf',      stale: 'dayStart' },
    day_off:  { label: '쉬는 날',        category: 'rest',    place: 'home',   minutes: null, rec: 'normal', nudges: true,  busy: false, icon: 'leaf',      stale: 'dayStart' },
    sleep:    { label: '잘 시간',        category: 'sleep',   place: 'home',   minutes: null, rec: 'none',   nudges: false, busy: true,  icon: 'moon',      stale: { h: 10 } },
    none:     { label: '모두 보기',      category: 'none',    place: null,     minutes: null, rec: 'normal', nudges: true,  busy: false, icon: null,        stale: 'dayStart' },
    break:    { label: '휴식',           category: 'overlay', place: null,     minutes: 15,   rec: 'short',  nudges: false, busy: false, icon: 'coffee',    stale: 'until' },
    meal:     { label: '점심',           category: 'overlay', place: null,     minutes: 60,   rec: 'short',  nudges: false, busy: false, icon: 'coffee',    stale: 'until' },
    meeting:  { label: '회의 중',        category: 'overlay', place: null,     minutes: 60,   rec: 'none',   nudges: false, busy: true,  icon: 'user',      stale: 'until' },
    focus:    { label: '집중',           category: 'overlay', place: null,     minutes: 50,   rec: 'normal', nudges: false, busy: false, icon: 'book',      stale: 'until' },
    class:    { label: '수업 중',        category: 'overlay', place: null,     minutes: 50,   rec: 'none',   nudges: false, busy: true,  icon: 'book',      stale: 'until' },
    drive:    { label: '운전 중',        category: 'overlay', place: null,     minutes: 60,   rec: 'none',   nudges: false, busy: true,  icon: 'train',     stale: 'until' },
    exercise: { label: '운동',           category: 'overlay', place: null,     minutes: 60,   rec: 'none',   nudges: false, busy: true,  icon: 'walk',      stale: 'until' }
  };
  var STATUS_ORDER = ['work', 'wfh', 'field', 'to_work', 'to_home', 'out', 'off', 'day_off', 'sleep', 'none',
    'break', 'meal', 'meeting', 'focus', 'class', 'drive', 'exercise'];
  var CATEGORIES = ['work', 'life', 'rest', 'moving', 'sleep', 'none', 'overlay'];
  var LEVELS = ['up', 'normal', 'down', 'hide'];

  // 감지한 말의 뜻. 프리셋이 roleMap 으로 역할 → 상태를 바꾼다(§4.4)
  var ROLES = ['work_start', 'work_end', 'half_day', 'commute_in', 'commute_out', 'commute', 'break', 'meal', 'back', 'arrive',
    'out', 'field', 'meeting', 'focus', 'class', 'drive', 'exercise', 'day_off', 'sleep', 'wake', 'idle', 'reset'];
  var ROLE_STATUS = {
    work_start: 'work', work_end: 'off', half_day: 'off', commute_in: 'to_work', commute_out: 'to_home',
    break: 'break', meal: 'meal', out: 'out', field: 'field', meeting: 'meeting', focus: 'focus', class: 'class',
    drive: 'drive', exercise: 'exercise', day_off: 'day_off', sleep: 'sleep', reset: 'none'
  };

  // ------------------------------------------------------------------ 맥락 (§2.3)
  var CONTEXTS = [
    { id: 'work',     label: '업무',   desc: '회사·거래처·가게·알바 일',              icon: 'briefcase', aliases: ['업무', '일', '회사'] },
    { id: 'home',     label: '집안일', desc: '집에서만 할 수 있는 일',                icon: 'home',      aliases: ['집안일', '집', '살림'] },
    { id: 'errand',   label: '밖 볼일', desc: '나가야 할 수 있는 일(장보기·은행·택배)', icon: 'bag',       aliases: ['볼일', '밖', '장보기', '밖볼일'] },
    { id: 'personal', label: '개인',   desc: '건강·운동·취미·돈 관리·약속',          icon: 'user',      aliases: ['개인', '나', '건강', '운동'] },
    { id: 'family',   label: '가족',   desc: '아이·부모님·배우자',                    icon: 'heart',     aliases: ['가족', '육아'] },
    { id: 'study',    label: '공부',   desc: '과제·시험·자격증',                      icon: 'book',      aliases: ['공부', '과제'] }
  ];
  var NONE_LABEL = '정하지 않음';

  // ------------------------------------------------------------------ 맥락 단어 (§6.3) — strong 3 · mid 2 · weak 1
  // 띄어 쓴 키워드는 공백을 뺀 글과 비교한다. 라틴 키워드는 낱말 전체가 같을 때만 센다.
  var CONTEXT_WORDS = {
    work: {
      strong: ['보고서', '회의록', '기획안', '기획서', '제안서', '견적서', '견적', '발주', '결재', '품의', '거래처', '클라이언트', '고객사',
        '계약서', '세금계산서', '인보이스', '출장', '배포', '코드 리뷰', '스프린트', '인수인계', '업무', '납품', '협력사', '회사', '사무실'],
      mid: ['회의', '미팅', '발표', '슬라이드', '엑셀', '회신', '정산', '실적', '매출', '단가', '팀장', '부장', '과장', '대표님', '온보딩',
        '야근', '손님', '매장', '재고', '리뷰 답글', 'PR', 'PPT', 'KPI', 'OKR', 'QA'],
      weak: ['이슈', '버그', '자료', '메일']
    },
    home: {
      strong: ['빨래', '빨래 개기', '세탁기', '건조기', '설거지', '청소', '청소기', '분리수거', '다림질', '밥하기'],
      mid: ['쓰레기', '음식물', '재활용', '정리정돈', '옷장', '이불', '침구', '화장실', '욕실', '냉장고', '요리', '반찬', '화분', '전구',
        '보일러', '고양이 모래', '물 주기'],
      weak: ['필터', '커튼', '수리']
    },
    errand: {
      strong: ['장보기', '장 보기', '마트', '우체국', '택배 보내기', '세탁소', '빨래방', '주민센터', '동사무소', '은행', '다이소', '철물점',
        '미용실', '세차', '주유'],
      mid: ['반품', '구청', '약국', '편의점', '수선', '픽업', '찾아오기', '들르기'],
      weak: []
    },
    personal: {
      strong: ['운동', '헬스', '러닝', '달리기', '요가', '필라테스', '수영', '치과', '진료', '검진', '건강검진', '관리비', '공과금', '카드값',
        '여권', '항공권'],
      mid: ['병원', '산책', '스트레칭', '영양제', '약 먹기', '예약', '송금', '이체', '보험', '해지', '연말정산', '친구', '여행', '숙소', '티켓',
        '취미', '독서', '책 읽기', '영화', '일기'],
      weak: ['생일', '선물', '주문']
    },
    family: {
      strong: ['어린이집', '유치원', '등원', '하원', '준비물', '알림장', '학부모', '예방접종', '이유식', '기저귀', '운동회'],
      mid: ['아이', '애들', '아기', '엄마', '아빠', '부모님', '어머니', '아버지', '시댁', '처가', '남편', '아내', '와이프', '가족', '생신'],
      weak: []
    },
    study: {
      strong: ['공부', '인강', '복습', '예습', '자격증', '토익', '오픽', '숙제', '과제', '레포트'],
      mid: ['강의', '시험', '단어', '수업', '논문', '중간고사', '기말고사', '모의고사', '문제집'],
      weak: []
    }
  };
  var WORD_WEIGHT = { strong: 3, mid: 2, weak: 1, user: 3 };
  // 이 말로 시작하는 낱말은 건너뛴다 (청소년 ≠ 청소, 은행나무 ≠ 은행, 아이디어 ≠ 아이)
  var CONTEXT_EXCLUDE = ['청소년', '은행나무', '아이디어', '아이템', '아이콘', '아이폰', '아이패드'];
  // 제목이 이 말로 끝나면 밖 볼일 +2
  var ERRAND_ENDINGS = ['사기', '사 오기', '사오기', '사러 가기', '들르기', '맡기기', '찾아오기', '반납하기'];
  var ERRAND_ENDING_WEIGHT = 2;

  // ------------------------------------------------------------------ 걸어 둔 상태 (§2.4)
  var ATMODE_PHRASES = {
    work: ['출근하면', '출근해서', '출근하자마자', '회사 가서', '회사에서', '사무실에서'],
    off: ['퇴근하고', '퇴근하면', '퇴근 후에', '퇴근 후', '퇴근하고 나서', '일 끝나고', '집에 가서', '집 가서', '집에서'],
    out: ['나가는 김에', '밖에 나가면', '외출하면', '가는 길에', '오는 길에', '퇴근길에', '출근길에'],
    pause: ['점심 때', '점심에', '점심시간에', '쉬는 시간에', '쉴 때'],
    rest: ['쉬는 날에', '쉬는 날']
  };
  var ATMODES = ['work', 'off', 'out', 'pause', 'rest'];
  var ATMODE_LABEL = { work: '출근하면', off: '퇴근하고', out: '나가는 김에', pause: '쉬는 시간에', rest: '쉬는 날에' };
  // 이 상태(유효 상태의 바탕 id, pause 는 덧씌움 id)에서 '걸어 둔 상태가 맞다'
  var ATMODE_STATUS = {
    work: ['work', 'wfh', 'field'],
    off: ['off', 'to_home', 'day_off'],
    out: ['out', 'to_work', 'to_home', 'field'],
    pause: ['break', 'meal'],
    rest: ['day_off']
  };
  // 오늘 화면 '하기로 한 일' 묶음 머리 (§9.3)
  var ATMODE_HEAD = { work: '출근하면 하기로 한 일', off: '퇴근하고 하기로 한 일', out: '나간 김에 할 일', pause: '쉬는 시간에 하기로 한 일', rest: '쉬는 날 하기로 한 일' };

  // ------------------------------------------------------------------ 폰으로 할 일 (§2.5) — 제목 낱말이 이 말로 시작하면
  var PHONE_WORDS = ['전화', '통화', '연락', '문자', '카톡', '메시지', '답장', '예약', '주문', '결제', '송금', '이체', '신청', '조회', '알아보기'];

  // ------------------------------------------------------------------ 감지 문법 (§5.3·§5.4)
  var FILLERS = ['이제', '지금', '드디어', '방금', '막', '그럼', '자', '일단', '오늘은', '오늘', '나', '저', '나도', '저도'];
  // '고'·'시작'·'끝' 은 꼬리가 아니다. '요' 는 '잘게요'·'쉴게요' 처럼 끝에 붙는 높임만 받는다
  var TAILS = ['함', '했어', '했어요', '했음', '했다', '했습니다', '합니다', '해요', '할게', '할게요', '할께', '완료', '중', '중이야', '중이에요',
    '중임', '하는 중', '감', '가요', '갑니다', '간다', '왔어', '왔어요', '왔음', '옴', '도착', '도착했어', '들어감', '들어가요', '나감', '나가요',
    '이다', '이야', '야', '이에요', '예요', '입니다', '임', 'ㄱ', 'ㄱㄱ', '요'];
  // 시간 표현 — 그룹은 모두 잡지 않는 그룹이다. 해석은 status.js 가 조각마다 따로 한다
  var DURATION_RE = {
    minutes: '\\d+\\s*분(?:만|정도|동안)?',
    hours: '(?:\\d+|한|두|세)\\s*시간(?:\\s*반)?(?:만|정도|동안)?',
    half: '반\\s*시간(?:만|정도|동안)?',
    clock: '(?:오전|오후)?\\s*\\d{1,2}시(?:\\s*\\d{1,2}분|\\s*반)?\\s*(?:까지|에\\s*복귀|복귀)'
  };
  var BLOCK_ANYWHERE = ['?', '？', '언제', '몇 시', '몇시', '아직', '내일', '모레', '이따', '나중에', '다음 주', '다음주', '어제', '했었', '싶',
    '예정', '퇴사', '해야'];
  // '안' 은 §5.4 표 밖이지만 '못' 과 같은 부정이다 ('퇴근 안 해' 가 퇴근 제안이 되지 않게, '회의 안건' 도 상태가 아니다)
  var BLOCK_AFTER = ['하고', '하면', '하면서', '하자마자', '한 다음', '하고 나서', '후', '전', '시간', '길에', '하러', '하기', '가기', '보기',
    '하자', '했나', '하나', '하냐', '하니', '하지', '할까', '못', '안', '늦'];
  var BLOCK_BEFORE = ['안', '못'];
  // 핵심어 바로 앞의 다른 사람 (정규식 원문)
  var BLOCK_BEFORE_OTHERS = '(?:님|씨|남편|아내|와이프|엄마|아빠|친구|동생|형|누나|언니|오빠|팀장|부장|과장|대리|사장|선배|후배|아이|애|아들|딸)(?:은|는|이|가|도|께서)?';
  // '퇴근 못 함' 계열 → maybe work_start('야근')
  var NOT_YET_OFF = '퇴근\\s*못\\s*(?:함|해|했어|했음|해요|할\\s*듯|할\\s*것\\s*같아|하겠다|하겠어)?';
  var MAX_HEAD = 30;
  var MAX_RESIDUAL = 6;

  // ------------------------------------------------------------------ 문구 사전 (§5.6, 모든 프리셋 공통)
  // sure: 꼬리가 있어도 없어도 sure · tail: 꼬리가 있어야 sure(없으면 maybe) · maybe: 늘 maybe · special: 정확 일치만
  // id: 역할 대신 이 상태로 · label: 칩에 보일 말(없으면 상태 라벨) · gate: 문(§5.6) · 그 밖: 역할별 덧붙임
  var PHRASES = [
    { role: 'work_start', sure: ['출근', 'ㅊㄱ', '출근 완료', '회사 도착', '회사 왔어', '사무실 도착', '자리 도착', '업무 시작', '일 시작', '근무 시작',
      '작업 시작', '업무 중', '근무 중', '일하는 중', '작업 중'] },
    { role: 'work_start', sure: ['야근', '야근 시작'], label: '야근' },
    { role: 'work_start', sure: ['알바 출근'], label: '알바' },
    { role: 'work_start', id: 'wfh', sure: ['재택', '재택 시작', '재택근무', '재택 중'], label: '재택' },
    { role: 'work_end', sure: ['퇴근', 'ㅌㄱ', '칼퇴', '칼퇴근', '정시퇴근', '정시 퇴근', '바로 퇴근', '일 끝', '업무 끝', '오늘 일 끝', '근무 끝', '작업 끝', '오늘 끝'] },
    { role: 'work_end', sure: ['하교'], label: '하교' },
    { role: 'work_end', sure: ['알바 끝'], label: '알바 끝' },
    { role: 'work_end', home: true, sure: ['집 도착', '집 왔어', '집이야', '귀가'], label: '집' },
    { role: 'half_day', sure: ['반차'], label: '반차' },
    { role: 'half_day', half: 'am', sure: ['오전 반차'], label: '반차' },
    { role: 'half_day', half: 'pm', sure: ['오후 반차'], label: '반차' },
    { role: 'commute_in', sure: ['출근 중', '출근하는 중', '출근길', '회사 가는 중', '등교 중', '등굣길'] },
    { role: 'commute', maybe: ['지하철 탐', '버스 탐'] },
    { role: 'commute_out', sure: ['퇴근 중', '퇴근하는 중', '퇴근길', '집 가는 중', '집에 가는 중', '귀가 중'] },
    { role: 'break', sure: ['휴식', '휴식 중', '휴식 시작', '쉬는 중', '쉴게', '쉼', '잠깐 쉼', '잠깐 쉴게', '쉬는 시간', '휴게', '휴게 시간', '브레이크', '브레이크 타임'] },
    { role: 'break', maybe: ['커피', '커피 한잔', '커피 타임', '티타임'], label: '커피', gate: 'work' },
    { role: 'break', maybe: ['바람 쐬러', '담배', '흡연', '머리 식히기'], gate: 'work' },
    { role: 'meal', sure: ['점심', '점심시간', '점심 시간', '점심 먹으러', '점심 먹는 중'], label: '점심', gate: 'meal', lunch: true },
    { role: 'meal', sure: ['밥 먹으러', '밥 먹는 중', '식사', '식사 중'], label: '식사', gate: 'meal' },
    { role: 'meal', sure: ['저녁 먹으러', '저녁 먹는 중'], label: '저녁', gate: 'meal' },
    { role: 'back', sure: ['복귀', '자리 복귀', '업무 복귀', '다시 일', '돌아왔어', '다녀왔어', '다시 시작', '휴식 끝', '미팅 끝', '운동 끝', '수업 끝'] },
    { role: 'back', sure: ['점심 끝', '점심 먹었어'], gate: 'in_meal' },
    { role: 'back', sure: ['회의 끝'], gate: 'in_meeting' },
    { role: 'arrive', sure: ['도착', '도착했어', '다 왔어'], gate: 'moving_or_out' },
    { role: 'out', sure: ['외출', '외출 중', '잠깐 나갔다 올게', '나갔다 올게', '볼일 보러 감'] },
    { role: 'out', sure: ['장 보러 감', '장 보는 중', '마트 가는 중', '마트 왔어'], label: '장보기' },
    { role: 'out', sure: ['은행 가는 중'], label: '은행' },
    { role: 'out', sure: ['병원 가는 중'], label: '병원' },
    { role: 'out', maybe: ['나왔어', '밖이야'] },
    { role: 'field', sure: ['외근', '외근 중', '외근 나감', '거래처 가는 중', '거래처 방문 중', '현장 나감', '미팅 가는 중'] },
    { role: 'field', sure: ['출장', '출장 중'], label: '출장' },
    { role: 'meeting', sure: ['회의 들어감', '회의 중', '회의 시작', '상담 중', '면담 중'] },
    { role: 'meeting', sure: ['미팅 들어감', '미팅 중', '미팅 시작'], label: '미팅' },
    { role: 'meeting', maybe: ['회의'] },
    { role: 'meeting', maybe: ['미팅'], label: '미팅' },
    { role: 'focus', sure: ['집중 모드', '집중 시작', '몰입 모드', '방해 금지'], tail: ['집중'] },
    { role: 'class', sure: ['수업 중', '수업 들어감', '수업 시작'] },
    { role: 'class', sure: ['강의 중', '강의 들어감', '강의 시작'], label: '강의' },
    { role: 'class', maybe: ['학원'] },
    { role: 'drive', sure: ['운전 중', '운전 시작'], tail: ['운전'] },
    { role: 'exercise', sure: ['운동 중', '운동 시작', '운동 가는 중'], tail: ['운동'], label: '운동' },
    { role: 'exercise', sure: ['헬스장 도착', '헬스 중'], tail: ['헬스'], label: '헬스' },
    { role: 'exercise', sure: ['러닝 중'], tail: ['러닝'], label: '러닝' },
    { role: 'exercise', sure: ['요가 중'], tail: ['요가'], label: '요가' },
    { role: 'exercise', sure: ['필라테스 중'], tail: ['필라테스'], label: '필라테스' },
    { role: 'exercise', sure: ['수영 중'], tail: ['수영'], label: '수영' },
    { role: 'exercise', sure: ['산책 중'], tail: ['산책'], label: '산책' },
    { role: 'day_off', sure: ['쉬는 날', '오늘 쉼', '오늘 쉬어', '휴무', '휴무일', '휴일', '주말 모드'] },
    { role: 'day_off', sure: ['연차', '월차'], label: '연차' },
    { role: 'day_off', sure: ['휴가'], label: '휴가' },
    { role: 'sleep', sure: ['잘게', '자러 감', '잔다', '자야지', '취침', '굿나잇', '굿밤'] },
    { role: 'sleep', nap: true, sure: ['낮잠 잘게', '낮잠 잔다', '낮잠 자러 감'], tail: ['낮잠'], label: '낮잠' },
    { role: 'wake', special: ['기상', '일어났어', '일어남', '굿모닝'] },
    { role: 'idle', special: ['한가해', '한가함', '심심해', '뭐 하지', '뭐 할까', '할 거 없나'] },
    { role: 'reset', special: ['상태 해제', '상태 없음', '모두 보기', '다 보여 줘'] }
  ];
  var NAP_MINUTES = 60;
  var MEAL_MINUTES = { lunch: 60, other: 40 };

  // ------------------------------------------------------------------ 프리셋 전용 말 (§12.3)
  // 그 프리셋일 때만 상태다. 다른 프리셋에서는 ST.presetSignal 로만 센다 (그 말 안의 공통 핵심어도 상태가 아니다).
  var PRESET_WORDS = {
    office: [],
    freelance: [],
    shift: [
      { role: 'work_start', sure: ['데이', '데이 출근'], label: '데이' },
      { role: 'work_start', sure: ['이브닝', '이브닝 출근', '이브', '이브 출근'], label: '이브닝' },
      { role: 'work_start', sure: ['나이트', '나이트 출근'], label: '나이트' },
      { role: 'work_end', sure: ['인계 끝', '나이트 끝', '데이 끝'] },
      { role: 'day_off', sure: ['오프', '비번'], label: '오프' }
    ],
    shop: [
      { role: 'work_start', id: 'shop_open', sure: ['오픈', '가게 오픈', '문 열었어', '영업 시작', '장사 시작'] },
      { role: 'work_start', id: 'shop_prep', sure: ['오픈 준비'] },
      // 브레이크·브레이크 타임은 뜻이 하나라 공통 사전에 있다 (자영업에서는 휴식 라벨이 '브레이크')
      { role: 'work_start', id: 'shop_close', sure: ['마감 시작', '마감 정리'] },
      { role: 'work_end', sure: ['마감했어', '문 닫았어', '영업 끝', '장사 끝', '가게 마감'], label: '영업 끝' },
      { role: 'day_off', sure: ['정기휴무'], label: '휴무' },
      { role: 'idle', special: ['손님 없음'] },
      { role: 'break', id: 'busy', sure: ['바빠', '손님 많아', '정신없어'] }
    ],
    student: [
      { role: 'break', id: 'free_period', sure: ['공강'] },
      { role: 'work_start', id: 'study', sure: ['도서관 도착', '독서실 왔어', '스터디카페 도착', '공부 시작'] }
    ],
    home: [
      { role: 'work_end', id: 'me', sure: ['등원 완료', '등원시켰어', '어린이집 보냄'] },
      { role: 'work_start', id: 'kids', sure: ['하원', '하원 완료', '애들 왔어'] },
      { role: 'break', id: 'nap', sure: ['아기 낮잠', '낮잠 재웠어'] },
      { role: 'work_end', id: 'me', sure: ['애들 재웠어', '재웠다', '육퇴'], label: '내 시간' }
    ],
    creator: [
      { role: 'meeting', sure: ['스탠드업', '라이브 시작'] },
      { role: 'focus', sure: ['딥워크'] },
      { role: 'out', sure: ['촬영 나감'], label: '촬영' }
    ]
  };

  // ------------------------------------------------------------------ 프리셋 (§12.1·§12.2)
  // statuses: 이 프리셋 전용 상태 정의, 또는 기본 상태의 라벨·기본 분 고침
  // matrix: 공식(§7.3) 결과와 다른 칸만. 'after' = afterWork 값
  var PRESETS = {
    office: {
      label: '직장인', stage: 'v1', primary: ['work'],
      desc: '평일 근무 시간 동안 업무를 위로, 퇴근하면 업무 할 일은 접고 집안일·개인 일을 먼저 보여 줘요.',
      menu: ['work', 'meal', 'break', 'to_home', 'off', 'out', 'day_off'],
      roleMap: {}, statuses: {},
      matrix: { to_home: { work: 'after', errand: 'up' } },
      schedule: { mode: 'guess' }, afterWork: 'hide', contextLabels: {}
    },
    freelance: {
      label: '프리랜서·재택', stage: 'v1', primary: ['work'],
      desc: '정해진 근무 시간 없이 일할 때 써요. 일이 끝나도 업무 할 일은 숨기지 않고 아래로 내려 둬서 마감을 놓치지 않아요.',
      menu: ['wfh', 'break', 'meal', 'meeting', 'out', 'off', 'day_off'],
      roleMap: { work_start: 'wfh' },
      statuses: { wfh: { label: '작업 중' }, off: { label: '일 끝' } },
      matrix: { to_home: { work: 'after', errand: 'up' } },
      schedule: { mode: 'off' }, afterWork: 'down', contextLabels: {}
    },
    student: {
      label: '학생', stage: 'v1.1', primary: ['study'],
      desc: '수업 중에는 추천과 알림을 쉬고, 공부할 때는 공부를, 알바할 때는 알바 일을 먼저 보여 줘요.',
      menu: ['class', 'study', 'break', 'to_work', 'part_time', 'off', 'sleep'],
      roleMap: { work_start: 'part_time' },
      statuses: {
        study: { label: '공부 중', category: 'work', place: null, icon: 'book' },
        part_time: { label: '알바 중', category: 'work', place: 'out', icon: 'briefcase' },
        free_period: { label: '공강', category: 'overlay', minutes: 60, rec: 'normal', icon: 'coffee' },
        to_work: { label: '이동 중' }, off: { label: '집·자유' }, break: { label: '쉬는 시간' }
      },
      matrix: {
        study: { work: 'hide' },
        part_time: { work: 'up', study: 'down' },
        off: { study: 'normal', work: 'hide' },
        day_off: { study: 'normal', work: 'hide' },
        to_home: { work: 'after', errand: 'up' }
      },
      schedule: { mode: 'guess' }, afterWork: 'hide', contextLabels: { work: '알바' }
    },
    shift: {
      label: '교대 근무', stage: 'v1.1', primary: ['work'],
      desc: '근무표대로 일하는 사람을 위한 리듬이에요. 자정을 넘는 근무도 그대로 두고, 오프 날에는 밖 볼일을 먼저 보여 줘요.',
      menu: ['work', 'break', 'off', 'day_off', 'sleep'],
      roleMap: {},
      statuses: { work: { label: '근무 중' }, break: { label: '휴게' }, day_off: { label: '오프' } },
      matrix: { to_home: { work: 'after', errand: 'up' } },
      schedule: { mode: 'off' }, afterWork: 'hide', contextLabels: { work: '근무' }
    },
    shop: {
      label: '자영업', stage: 'v1.1', primary: ['work'],
      desc: '영업 중에는 짧은 일만 고르고, 영업이 끝나면 가게 일은 접어 둬요. 휴무일에도 가게 일은 아래에 남겨 둬요.',
      menu: ['shop_prep', 'shop_open', 'break', 'shop_close', 'off', 'day_off'],
      roleMap: { work_start: 'shop_open' },
      statuses: {
        shop_prep: { label: '오픈 준비', category: 'work', place: 'office', icon: 'bag' },
        shop_open: { label: '영업 중', category: 'work', place: 'office', nudges: false, icon: 'briefcase' },
        shop_close: { label: '마감 정리', category: 'work', place: 'office', icon: 'briefcase' },
        busy: { label: '바빠', category: 'overlay', minutes: 30, rec: 'none', busy: true, icon: 'coffee' },
        break: { label: '브레이크' }, off: { label: '영업 끝' }, day_off: { label: '휴무' }
      },
      matrix: { shop_prep: { errand: 'up' }, day_off: { work: 'down' }, to_home: { work: 'after', errand: 'up' } },
      schedule: { mode: 'guess' }, afterWork: 'hide', contextLabels: { work: '가게 일' }
    },
    home: {
      label: '육아·살림', stage: 'v1.1', primary: ['home', 'family'],
      desc: '아이와 함께일 때는 짧은 일만, 혼자 시간에는 집안일과 밖 볼일을 먼저 보여 줘요. 부업 일은 늘 보통으로 둬요.',
      menu: ['kids', 'me', 'nap', 'out', 'break', 'sleep'],
      roleMap: {},
      statuses: {
        kids: { label: '아이와 함께', category: 'life', place: 'home', rec: 'short', nudges: false, icon: 'heart' },
        me: { label: '혼자 시간', category: 'life', place: 'home', icon: 'user' },
        nap: { label: '아기 낮잠', category: 'overlay', minutes: 60, rec: 'short', icon: 'moon' }
      },
      matrix: {
        kids: { family: 'up', home: 'normal', personal: 'normal', work: 'normal' },
        me: { home: 'up', errand: 'up', family: 'normal', work: 'normal' },
        off: { home: 'down', personal: 'up', work: 'normal' },
        work: { work: 'normal' }, wfh: { work: 'normal' }, field: { work: 'normal' },
        to_work: { work: 'normal' }, to_home: { work: 'normal', errand: 'up' }, out: { work: 'normal' },
        day_off: { work: 'normal' }
      },
      schedule: { mode: 'off' }, afterWork: 'down', contextLabels: { work: '부업' }
    },
    creator: {
      label: '크리에이터', stage: 'v2', primary: ['work'],
      desc: '작업과 집중 시간을 중심으로, 작업이 끝나면 제작 일은 접어 둬요.',
      menu: ['wfh', 'focus', 'meeting', 'break', 'off', 'day_off'],
      roleMap: { work_start: 'wfh' },
      statuses: { wfh: { label: '작업 중' }, focus: { minutes: 90 }, off: { label: '작업 끝' } },
      matrix: { to_home: { work: 'after', errand: 'up' } },
      schedule: { mode: 'off' }, afterWork: 'hide', contextLabels: { work: '제작' }
    }
  };
  var PRESET_ORDER = ['office', 'freelance', 'student', 'shift', 'shop', 'home', 'creator'];

  // ------------------------------------------------------------------ 프리셋 제안 신호 (§12.4) — 할 일·메모 제목에서 센다
  var PRESET_SIGNALS = {
    student: { words: ['과제', '시험', '강의', '레포트', '중간고사'] },
    home: { words: ['등원', '하원', '어린이집', '이유식', '기저귀'] },
    shop: { words: ['발주', '매장', '손님', '영업', '재고'] },
    shift: { words: ['데이', '나이트', '오프', '인계', '근무표'] },
    freelance: { words: ['클라이언트', '견적', '인보이스'], unless: ['회사', '팀장'] },
    office: { words: ['회의', '보고서', '결재', '팀장'] }
  };
  // 신호 단어로 시작하지만 다른 뜻인 낱말
  var SIGNAL_EXCLUDE = ['데이터', '데이트', '오프라인', '오프닝', '영업일'];

  return {
    STATUSES: STATUSES, STATUS_ORDER: STATUS_ORDER, CATEGORIES: CATEGORIES, LEVELS: LEVELS, ROLES: ROLES, ROLE_STATUS: ROLE_STATUS,
    CONTEXTS: CONTEXTS, NONE_LABEL: NONE_LABEL, CONTEXT_WORDS: CONTEXT_WORDS, WORD_WEIGHT: WORD_WEIGHT,
    CONTEXT_EXCLUDE: CONTEXT_EXCLUDE, ERRAND_ENDINGS: ERRAND_ENDINGS, ERRAND_ENDING_WEIGHT: ERRAND_ENDING_WEIGHT,
    ATMODE_PHRASES: ATMODE_PHRASES, ATMODES: ATMODES, ATMODE_LABEL: ATMODE_LABEL, ATMODE_STATUS: ATMODE_STATUS, ATMODE_HEAD: ATMODE_HEAD,
    PHONE_WORDS: PHONE_WORDS,
    FILLERS: FILLERS, TAILS: TAILS, DURATION_RE: DURATION_RE, BLOCK_ANYWHERE: BLOCK_ANYWHERE, BLOCK_AFTER: BLOCK_AFTER,
    BLOCK_BEFORE: BLOCK_BEFORE, BLOCK_BEFORE_OTHERS: BLOCK_BEFORE_OTHERS, NOT_YET_OFF: NOT_YET_OFF, MAX_HEAD: MAX_HEAD, MAX_RESIDUAL: MAX_RESIDUAL,
    PHRASES: PHRASES, NAP_MINUTES: NAP_MINUTES, MEAL_MINUTES: MEAL_MINUTES,
    PRESET_WORDS: PRESET_WORDS, PRESETS: PRESETS, PRESET_ORDER: PRESET_ORDER, PRESET_SIGNALS: PRESET_SIGNALS, SIGNAL_EXCLUDE: SIGNAL_EXCLUDE
  };
});
