# Daynote v4 작업 진행 상황 (오케스트레이터용)

이 파일은 세션이 끊겼을 때 이어서 작업하기 위한 체크리스트다. 단계가 끝날 때마다 갱신하고 커밋한다.

- 계획: `dev-notes/IMPLEMENTATION_PLAN.md` (+ 캘린더 추가분 `DAYNOTE_CALENDAR_DESIGN.md`, 계획 §8)
- 지도: `dev-notes/maps/*.md`
- 브랜치: `web-mobile` · 테스트: `cd daynote && npm test` (TZ=UTC, TZ=Asia/Seoul 둘 다)
- 모델 배정(사용자 지시): 계획·검증·감독·적대적 리뷰 = opus/high · 복잡한 구현 = opus/medium · 명세가 촘촘한 구현 = sonnet/medium · 캡처·빌드 확인 = haiku/low
- 사용자 지시: 세션 한도 약 10%는 남겨 둘 것. 한도로 끊기면 초기화 뒤 이어서 할 것. 허락 묻지 말 것.

## 단계
- [x] 0. 이해·설계 (설계 문서 4개 + 통합 계획)
- [x] 1. 1차 핵심 모듈 7개 구현 (커밋 3d23272)
- [x] 1v. 1차 검증 7개 완료
- [x] gate. index.html 태그·자리 파일 (커밋 a3e1f79)
- [x] 1.5 캘린더 설계(DAYNOTE_CALENDAR_DESIGN.md, 계획 §8) + planner.js + 검증 완료 (614 tests)
- [x] 2. 2차 UI 연결 9개 + 캘린더 확장 구현·검증 완료
- [x] 3. 최종 리뷰 + 발견 22건 수정 (705 tests)
- [x] 4. 웹 데모 재게시 (버전 2)
- [x] 5. 보고 완료
- [x] 6. 3차: v1.1 직업 프리셋 4개(학생·교대 근무·자영업·육아·살림) 켜기, 적응형 2단계 소요 시간 학습, 백업 가져오기·홈 화면 추가(manifest) — 검증·수정 완료 (782 tests)
- [x] 7. Electron 실제 실행 확인(xvfb, `npm run smoke`): 화면 18개, AI 정리, 저장·재시작 유지, 콘솔 오류 0
- [x] 8. 웹 데모 재게시 (버전 4)
