# Daynote · Google 로그인 + Google 캘린더 양방향 동기화 설계 (v1)

> 대상: `daynote/`. Electron 32 데스크톱 앱이고 렌더러는 브라우저에서도 돈다. 기준은 branch `web-mobile`의 commit `d75f062`, 작성일은 2026-10-10이다.
> 이 문서는 구현 전에 고정하는 **계약서**다. 모듈 API·IPC 채널·데이터 모양·문구를 정확히 적어 두었다. 그래서 다섯 트랙(코어·인증·REST·배선·화면)이 동시에 구현할 수 있다(§13).
> 근거는 scratchpad의 `maps/{data,settings,recommend,ui,tests,capture}.md`, `DAYNOTE_UX_V2.md`(원칙 1·2·6), `DAYNOTE_UX_P1_REPORT.md`(P2 설정), `daynote/README.md`다.
> 표기 규칙은 이렇다. 코어(`src/core`, `renderer`)는 ES5로 쓴다(`var`, `function`). `services`·`main`·`test`는 최신 Node 문법을 쓴다. 화면 문구는 `-어요` 체로 쓴다.

---

## 0. 한눈에 보는 결정

| # | 주제 | 결정 | 이유 |
|---|---|---|---|
| D1 | 로그인 방식 | 시스템 기본 브라우저와 루프백 리디렉트 `http://127.0.0.1:<임의 포트>`를 쓴다. PKCE(S256), `state`, `nonce`를 함께 쓴다. | Google은 앱 안 웹뷰 로그인을 막는다. 사용자 지정 스킴을 쓰면 `second-instance`의 argv를 따로 처리해야 한다(main.js:322는 `showMain`만 한다). |
| D2 | OAuth 클라이언트 | Google Cloud의 **"데스크톱 앱"** 유형을 쓴다. v1에서는 사용자가 **자기 프로젝트에서 만든 클라이언트를 붙여 넣는다**(BYO). | 캘린더 범위는 민감 범위라서 모든 사람에게 배포하려면 Google 앱 확인을 받아야 한다. 테스트 모드에서 본인 계정만 쓰면 바로 된다. |
| D3 | 클라이언트 보안 비밀번호 | 있으면 토큰 요청에 함께 보낸다. **기밀로 여기지 않는다**(설치형 앱). 그래도 화면·백업·로그에는 내보내지 않고 암호화해 둔다. | 데스크톱 유형도 실제로는 secret을 요구하는 사례가 있다. 보안은 PKCE, 루프백, state가 맡는다. |
| D4 | 범위 | `openid email profile`, `calendar.calendarlist.readonly`, `calendar.events.readonly`, `calendar.app.created` | 쓰기는 **Daynote가 만든 캘린더에만** 한다. 모든 캘린더 쓰기 권한(`calendar.events`, `calendar`)은 요청하지 않는다. |
| D5 | 토큰 | 메인 프로세스에만 둔다. refresh token은 `safeStorage`로 암호화한 `google-token.bin`에, access token은 메모리에 둔다. 화면에는 `{signedIn, email, name, picture?}`와 상태만 보낸다. | 기존 AI 키와 같은 원칙이다(settings map §12.1). |
| D6 | 가져온 일정 저장 | `blocks`가 아닌 **별도 컬렉션 `state.gcal.events`**에 둔다. 바쁨·캘린더·오늘 화면은 투영 함수 `M.calendarItems()`·`M.externalItems()`로 읽는다. | undo와 어긋나지 않는다. 읽기 전용이 보장된다. 종일·한가함·거절 일정의 바쁨 규칙을 따로 둘 수 있다. blocks를 바꾸는 12곳을 고치지 않아도 된다(§3 D6). |
| D7 | 내보내기 대상 | 앱이 만든 **전용 보조 캘린더 ‘Daynote’**에 쓴다. 기본(primary) 캘린더에는 쓰지 않는다. | 최소 권한이다. 동료와 공유된 기본 캘린더를 어지럽히지 않고 알림도 보내지 않는다. Google에서 한 번에 숨기거나 지울 수 있다. |
| D8 | Google 원본 일정 | Daynote에서는 **읽기 전용**이다. 보기와 "Google 캘린더에서 열기"만 된다. | 참석자·반복·주최자 규칙을 다시 만들지 않아도 되고 쓰기 권한도 필요 없다. |
| D9 | 충돌 | 3방향으로 비교한다. 기준은 마지막으로 맞춘 해시와 etag다. Daynote가 만든 항목은 **양쪽 다 바뀌면 Daynote가 이긴다**. 한쪽만 바뀌었으면 그쪽을 반영한다. | 기기 사이 시계 차이에 기대지 않는 "마지막 작성자" 규칙이다. UX 원칙 6("사용자가 정한 건 덮어쓰지 않는다")과 맞는다. |
| D10 | 내보내기 실행 | 상태를 비교해 할 일(op)을 계산하고(reconcile), 재시도 정보와 함께 **`state.gcal.outbox`에 영속**한다. | 블록을 바꾸는 모든 경로(AI·드래그·삭제·되돌리기·할 일 삭제)를 가로채지 않아도 된다. |
| D11 | 되돌리기 | `state.gcal` 조각은 `prefs`처럼 **undo 대상에서 뺀다**. | 동기화 커서와 링크가 되돌아가면 Google과 영구히 어긋난다(§3 D11). |
| D12 | 누가 동기화를 이끄나 | 상태를 가진 렌더러의 `renderer/gcalsync.js`가 이끈다. 메인은 "인증된 HTTP 실행기"만 맡는다. 병합 규칙은 순수 모듈 `src/core/gcal.js`에 둔다. | "메인은 데이터 파일을 직접 쓰지 않는다" 규칙을 지킨다(settings map §0). |

---

## 1. 범위

**v1에 넣는 것**
- Google 로그인과 로그아웃(토큰 폐기 포함). 클라이언트 설정이 없을 때의 '준비 필요' 상태와 설정 안내.
- 캘린더 목록을 보고 가져올 캘린더를 고른다. 기본값은 primary다.
- 가져오기. 창은 오늘 −7일부터 +60일까지다. 첫 동기화는 전체로, 그 뒤는 syncToken으로 증분 동기화한다. 410을 받으면 전체 동기화로 돌아간다. 페이지를 나눠 받고, 취소된 일정을 지우고, 종일·반복·시간대를 처리한다.
- 내보내기. Daynote의 일정 블록과 작업 블록을 ‘Daynote’ 캘린더에 올린다. 생성·수정·삭제를 전파하고, 오프라인 대기열·백오프·레이트 리밋을 처리한다.
- 되읽기. ‘Daynote’ 캘린더에서 사용자가 바꾼 시간·제목이나 삭제한 일정을 Daynote에 반영한다. 이것이 양방향이다.
- 바쁜 시간을 반영한다. `recommend.js`의 가용 시간 T와 `busyWith`, 충돌 표시, 빈 시간 찾기, 캘린더 화면, 오늘 일정 목록이 모두 바쁜 시간을 본다.
- 웹 데모와 `serve.js`에서는 '데스크톱 앱에서만' 상태를 보여 준다.

**v1에서 빼는 것**
- 푸시 알림(`events.watch`). 데스크톱에는 공개 HTTPS 수신 주소가 없어서 주기적으로 폴링한다.
- Google 원본 일정의 편집, 참석자·회의 링크, 종일 일정 만들기.
- 여러 Google 계정을 동시에 연결하는 것, Outlook, Gmail.
- AI 중복 판단(`validate.findDupEvent`)에 Google 일정을 넣는 것. 이것은 2단계로 미룬다(§15).

---

## 2. 구조

```
┌──────────── renderer (sandbox · CSP: connect-src 없음 → 외부 호출 불가) ────────────┐
│ views/settings.js  ─ ‘Google 캘린더’ 카드      views/calendar.js · today.js · palette.js │
│        │                                          ▲ M.calendarItems() / externalItems() │
│ renderer/gcalsync.js (DN.gcalSync) ── S.mutate(null, fn, {source:'gcal'})             │
│        │  계획·병합: src/core/gcal.js (순수, Node 테스트)   state.gcal (undo 제외)      │
└────────┼──────────────────────────────────────────────────────────────────────────────┘
         │ window.daynoteHost.google.* / .gcal.*   (preload.js, ipcRenderer.invoke)
┌────────▼──────────────── main (Node 20 / Electron 32) ───────────────────────────────┐
│ main.js: ipcMain.handle('google:*' | 'gcal:*') + 보낸 창 확인 + CHECK_RUN 이면 비활성  │
│ services/google-auth.js ─ PKCE · 루프백 서버 · 토큰 교환/갱신/폐기 · 상태               │
│      └ services/keystore.js createSecretStore() → google-token.bin / google-client.bin │
│ services/gcal.js ─ Calendar REST v3 (주입된 fetch = electron net.fetch, googleapis 없음) │
└────────┬──────────────────────────────────────────────────────────────────────────────┘
         │ HTTPS
   accounts.google.com · oauth2.googleapis.com · www.googleapis.com/calendar/v3
```

| 층 | 책임 | 하지 않는 일 |
|---|---|---|
| `src/core/gcal.js` | 원본 이벤트 정규화, 병합 계획과 적용, 내보내기 대상 판정, 본문과 해시, reconcile, 결과 반영, 백오프 계산 | 네트워크, 시계 읽기(`now`는 항상 인자로 받는다), DOM |
| `renderer/gcalsync.js` | 언제 동기화할지 정한다(시작·주기·변경 뒤·온라인 복귀·버튼). 한 번에 하나만 돌린다. IPC를 부르고 결과를 `S.mutate`로 넣는다. 토스트를 띄운다. | 토큰, HTTP |
| `services/google-auth.js` | OAuth 전 과정, 토큰 저장, 상태 기계, 상태 변경 알림 | 캘린더 데이터 |
| `services/gcal.js` | REST 호출, 페이지 넘기기, 401 갱신 재시도, 429·5xx 재시도, 오류 분류, 쓰기 화이트리스트 | 병합 규칙, 상태 저장 |
| `main.js` | 인스턴스 생성(지연), IPC 배선, 보낸 창 확인, 로그인 뒤 창을 앞으로 가져오기 | 데이터 파일 쓰기 |

---

## 3. 결정의 근거

**D1 루프백 + PKCE.** 구글의 설치형 앱 지침과 RFC 8252가 권하는 방식이다. 서버는 `127.0.0.1`에만 바인딩한다. `localhost`로 바인딩하면 IPv6이나 DNS 문제가 생길 수 있다. 포트는 운영체제가 정하게 둔다(`listen(0)`). 서버는 한 번만 쓰고, 5분이 지나면 닫힌다. 리디렉트 URI 문자열은 인가 요청과 토큰 요청에서 **완전히 같아야** 한다. 그래서 `http://127.0.0.1:<port>`(경로 없음) 한 가지로 고정한다. 데스크톱 클라이언트는 루프백 포트를 콘솔에 따로 등록하지 않아도 된다.

**D2 BYO 클라이언트.** 캘린더 범위는 '민감 범위'다. 외부 사용자 유형 앱이 테스트 사용자 밖의 사람에게 쓰이려면 브랜드 확인과 민감 범위 확인을 받아야 한다(개인정보처리방침, 홈페이지, 시연 영상 등). 확인을 받기 전까지는 각 사용자가 자기 프로젝트를 만들어 테스트 모드로 쓰는 것이 유일하게 현실적인 방법이다. 나중에 Daynote가 확인을 받으면 **기본 클라이언트 ID를 앱에 넣어 배포**하는 경로를 추가한다(§15). 이때 설치형 앱의 클라이언트 ID와 secret은 공개 값으로 본다.

**D3 secret 취급.** RFC 8252 §8.5에 따르면 설치형 앱의 secret은 비밀을 지킬 수 없다. 보호는 PKCE(가로챈 code로는 교환할 수 없다), 루프백(다른 앱은 그 포트에 응답할 수 없다), `state`(CSRF 방지)가 맡는다. 그런데 Google의 데스크톱 유형 클라이언트는 secret이 자동으로 생기고, 토큰 요청에 secret이 없으면 `invalid_request: client_secret is missing`을 내는 사례가 보고되어 있다. 그래서 다음처럼 한다.
- secret을 붙여 넣었으면 **항상 보낸다**. 없으면 빼고 보낸다. 서버가 secret이 없다고 답하면 오류 `needs_secret`으로 안내한다.
- 저장은 `google-client.bin`에 `safeStorage`로 암호화해서 한다. 렌더러에는 `hasSecret: true`만 알린다. 백업 JSON(`S.state`)에는 들어가지 않는다. 오류 메시지는 `redact()`로 가린다. `.env`는 이미 `.gitignore`에 있다.
- 2025년부터 새로 만든 클라이언트의 secret은 **만들 때 한 번만** 보인다. 그 뒤 콘솔에는 끝 4자리만 보인다. 그래서 설정 안내에 "만들 때 바로 복사하거나 JSON을 내려받으세요. 잃어버리면 콘솔에서 새 secret을 추가하세요"를 넣는다(§14).

**D4 범위(최소 집합).**

| 범위 | 쓰는 곳 | 더 넓은 대안을 쓰지 않는 이유 |
|---|---|---|
| `openid email profile` | 계정 표시(이메일·이름·사진). `id_token`으로 받아 userinfo를 따로 부르지 않는다. | — |
| `.../auth/calendar.calendarlist.readonly` | 캘린더 고르기 목록, ‘Daynote’ 캘린더를 다시 찾기 | `calendar.readonly`는 모든 캘린더 설정·ACL까지 읽는다. |
| `.../auth/calendar.events.readonly` | 고른 캘린더의 일정 읽기. 공유받은 팀 캘린더도 포함한다. | `calendar.events.owned.readonly`는 내가 소유한 캘린더만 읽어서 구독·공유 캘린더를 못 읽는다. `calendar.events`는 모든 캘린더에 쓰기까지 한다. |
| `.../auth/calendar.app.created` | ‘Daynote’ 보조 캘린더를 만들고(`calendars.insert`), 그 캘린더의 일정만 생성·수정·삭제한다. | `calendar.events`나 `calendar.events.owned`는 기본 캘린더를 포함한 모든 캘린더에 쓸 수 있다. |

- `include_granted_scopes=true`를 붙인다. 나중에 "기본 캘린더에 쓰기" 같은 옵션을 넣으면 범위를 점진적으로 추가할 수 있다.
- **부분 동의.** Google 동의 화면에서는 범위마다 체크박스를 끌 수 있다. 그래서 토큰 응답의 `scope`를 반드시 확인하고 `status.scopes`에 반영한다. 읽기 범위가 빠지면 상태를 `needs_scope`로 둔다. `app.created`만 빠지면 가져오기는 되고 올리기 영역에만 "권한 없음"을 표시한다.

**D5 토큰.** 기존 `keystore.js` 패턴(`create(dir, safeStorage)`)을 따른다. 다만 키 형식 정규식과 파일 이름이 고정되어 있으므로 범용 `createSecretStore()`를 새로 추가하고, 기존 함수와 테스트는 그대로 둔다. access token은 파일에 쓰지 않는다. 앱을 다시 켜면 refresh token으로 새로 받는다.

**D6 가져온 일정은 별도 컬렉션.** 데이터 지도를 바탕으로 판단했다.
1. **undo.** `store.undo()`는 `prefs`만 빼고 상태 스냅숏 전체를 되돌린다. 가져온 일정이 `blocks`에 있으면, 사용자가 동기화 전에 한 일을 Ctrl+Z 할 때 가져온 일정도 함께 되돌아간다. syncToken은 이미 앞으로 갔으므로 그 변경은 다음 전체 동기화 때까지 사라진다. 별도 조각에 두고 undo에서 빼면 이 문제가 생기지 않는다(D11).
2. **읽기 전용 보장.** `blocks`를 쓰는 곳은 12곳이 넘는다. `schedule.open({blockId})`, 캘린더 드래그, `deleteBlock`, `M.deleteTask`(앞으로의 블록 삭제), `proposals`의 task↔event 변환, `chat.setDate`, `clearSample`, `validate.findDupEvent`, `palette` 등이다. 모두 "사용자가 편집할 수 있는 블록"이라고 가정한다. 별도 컬렉션이면 이 경로들이 Google 일정을 건드릴 일이 원천적으로 없다.
3. **바쁨 규칙이 다르다.** 종일 일정, `transparency: transparent`(한가함), 내가 거절한 일정, `workingLocation`은 바쁜 시간이 아니다. `kind:'event'` 하나로는 이 차이를 담을 수 없다.
4. **크기.** 반복 인스턴스까지 펼치면 수백 개가 된다. `blocks`가 커지면 `conflictsFor`(O(n))와 `agenda`(O(n²))가 느려지고, 라벨 있는 mutate마다 스냅숏도 커진다.
5. **비용.** 읽는 쪽 다섯 곳(`conflictsFor`, `calendarContext`, `placeBlocks`, `agenda`, `palette`)에 투영 함수 하나만 끼우면 된다. `findFreeSlot`은 `conflictsFor`를 거치므로 자동으로 따라온다.

**D7 전용 ‘Daynote’ 캘린더.**
- 최소 권한 범위인 `calendar.app.created` 하나로 쓰기가 끝난다.
- 기본 캘린더는 회사 동료와 공유되는 경우가 많다. "견적서 작성" 같은 작업 블록이 동료에게 보이면 곤란하다. 보조 캘린더는 기본적으로 비공개다.
- 사용자가 Google 캘린더에서 체크 하나로 숨기거나 색을 바꿀 수 있다. 캘린더를 지우면 Daynote가 올린 것이 모두 사라진다.
- 단점: 보조 캘린더의 일정은 기본 캘린더의 free/busy에 들어가지 않는다. 그래서 동료가 회의를 잡을 때 내 작업 시간이 바쁨으로 보이지 않는다. 이것은 §15의 "고급: 기본 캘린더에 바쁨으로 올리기"(범위 `calendar.events.owned`를 점진적으로 추가)로 미룬다.
- 기본값: 로그인 직후 **올리기는 켜짐**, 작업 시간 포함, 제목 그대로. 첫 업로드가 끝나면 토스트로 알린다("Daynote 일정 5개를 Google 캘린더 ‘Daynote’에 올렸어요"). 설정에서 끌 수 있다.

**D8 Google 원본 일정은 읽기 전용.** 일정 클릭은 정보 팝오버를 연다. 팝오버에는 제목, 시간, 캘린더, 장소, "Google 캘린더에서 열기"가 있다. "Google 캘린더에서 열기"는 `window.open(htmlLink)`를 부르고, 이것은 `setWindowOpenHandler`를 거쳐 `shell.openExternal`로 간다. 이 경로는 이미 있다. 드래그, 삭제, 일정 대화상자는 막는다.

**D9 충돌 규칙.** 블록에는 `updatedAt`이 없다(`M.updateBlock`은 시간을 기록하지 않는다). 기기 시계와 Google 서버 시계를 비교하는 것은 불안정하다. 그래서 **링크에 저장한 기준값**과 비교하는 3방향 병합을 쓴다. 기준값은 마지막으로 맞춘 본문 해시와 etag다. 표는 §7.4에 있다.

**D10 상태 기반 reconcile.** 블록을 바꾸는 경로가 많다(대화상자, 드래그, AI 캡처, 변환, `deleteTask`, 되돌리기, 샘플). 이 경로마다 op를 끼워 넣으면 반드시 빠뜨린다. 대신 "지금 블록"과 "링크(마지막으로 올린 것)"를 비교해서 insert, patch, delete를 계산한다. outbox는 그 계산 결과에 재시도 정보(`attempts`, `nextAt`, `lastError`)를 붙여 영속하는 목록이다. 앱을 다시 켜도 남는다. 같은 블록에 대한 op는 하나로 합쳐진다.

**D11 `state.gcal`은 undo에서 뺀다.** 사용자가 블록을 추가하면 이것이 Google에 올라가고 링크가 생긴다. 그 뒤 Ctrl+Z를 누르면 블록은 사라지지만 링크는 남는다(undo 제외). 다음 reconcile은 블록 없는 링크를 보고 delete를 낸다. 그래서 Google에서도 사라진다. 반대로 링크까지 되돌아가면 Google에 고아 일정이 남는다. 그래서 반드시 뺀다. 구현은 `store.undo()`에서 `prefs`를 보존하는 줄 옆에 `gcal`도 보존하는 것이다(§8.9).

**D12 렌더러가 이끈다.** 앱 데이터의 주인은 렌더러다. 메인이 직접 병합하면 데이터의 원본이 둘이 된다. 메인은 받은 요청만 실행한다. 그래서 테스트가 쉽다. 병합은 순수 코어를, HTTP는 가짜 fetch를 쓴 서비스 테스트로 검증한다.

---

## 4. 인증 흐름

### 4.1 순서

```
사용자: 설정 › Google 캘린더 › [Google 계정으로 연결]
renderer  host.google.signIn()                         ─invoke 'google:signIn'→ main
main      auth.signIn():
          1) 클라이언트 확인 (없으면 {ok:false, error:{type:'not_configured'}})
          2) verifier=b64url(randomBytes(32)), challenge=b64url(sha256(verifier)), state=b64url(32B), nonce=b64url(16B)
          3) server = createServer(); listen(0,'127.0.0.1') → port; redirectUri='http://127.0.0.1:'+port
          4) 상태 'connecting' → onStatus → 'google:changed'
          5) openExternal(buildAuthUrl(...))   ← URL 이 ENDPOINTS.auth 로 시작하는지 assert
브라우저   Google 로그인 · 동의 → 302 http://127.0.0.1:PORT/?state=…&code=…&scope=…
main      루프백 요청 검사(§4.3) → 토큰 교환(§4.4) → id_token 검증 → 범위 확인 → 사진(선택)
          → google-token.bin 기록 → 상태 'signed_in' → 브라우저에 결과 페이지 → 서버 닫기 → onFocusApp()(=showMain)
renderer  'google:changed' 수신 → DN.gcalSync: 계정 비교/초기화 → 캘린더 목록 → 첫 동기화
```

### 4.2 인가 URL

```
https://accounts.google.com/o/oauth2/v2/auth
  ?client_id=<clientId>
  &redirect_uri=http://127.0.0.1:<port>
  &response_type=code
  &scope=openid email profile https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.app.created
  &code_challenge=<b64url(sha256(verifier))>&code_challenge_method=S256
  &state=<b64url 32B>&nonce=<b64url 16B>
  &access_type=offline
  &prompt=consent            (login_hint 가 없으면 'select_account consent')
  &include_granted_scopes=true
  [&login_hint=<email>]      (reauth 때 이전 계정)
```
`prompt=consent`는 refresh token을 매번 확실히 받기 위해 붙인다. 값은 `URLSearchParams`로 인코딩한다.

### 4.3 루프백 서버 규칙
- `http.createServer`로 만들고 `127.0.0.1`에만 바인딩한다. 이 서버는 인증 한 번에만 쓴다. 5분(`timeoutMs`)이 지나면 `timeout`으로 끝내고 서버를 닫는다.
- 요청은 다음 순서로 검사한다.
  - 메서드가 GET이 아니면 405를 돌려준다.
  - `Host` 헤더가 `127.0.0.1:<port>`가 아니면 400을 돌려준다. DNS 리바인딩을 막기 위해서다.
  - 경로가 `/`가 아니면 404를 돌려준다. `/favicon.ico` 같은 요청이다.
  - `state`가 다르면 400을 돌려주고 **계속 기다린다**. 비교는 `crypto.timingSafeEqual`로 한다.
  - `error=access_denied` 같은 오류 응답이면 `denied`로 끝낸다.
  - `code`가 있으면 토큰 교환을 **기다렸다가**(최대 15초) 결과 페이지로 응답한다.
- 응답 헤더: `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`, `Referrer-Policy: no-referrer`, `Connection: close`.
- 결과 페이지 문구:
  - 성공: "Daynote에 연결했어요 · <email>. 이 탭을 닫고 Daynote로 돌아가세요."
  - 실패: "연결하지 못했어요. Daynote에서 다시 시도해 주세요."
  - 외부 링크와 스크립트는 넣지 않는다.
- `cancelSignIn()`을 부르거나 새 `signIn()`이 시작되면 진행 중인 서버를 닫고 `canceled`로 끝낸다.

### 4.4 토큰 교환과 검증
```
POST https://oauth2.googleapis.com/token
Content-Type: application/x-www-form-urlencoded
code=…&client_id=…&client_secret=…(있을 때만)&redirect_uri=http://127.0.0.1:<port>&grant_type=authorization_code&code_verifier=…
→ 200 { access_token, expires_in, refresh_token, scope:"openid https://… …", token_type:"Bearer", id_token }
```
- `refresh_token`이 없으면 `no_refresh_token` 오류다. `prompt=consent`를 썼으므로 정상이라면 생기지 않는다.
- `id_token`은 페이로드만 base64url로 풀어서 다음을 확인한다: `iss ∈ {https://accounts.google.com, accounts.google.com}`, `aud === clientId`, `exp*1000 > now`, `nonce === 보낸 nonce`. 서명은 확인하지 않는다. 토큰 엔드포인트에서 TLS로 직접 받은 토큰은 OIDC Core 3.1.3.7에 따라 서명 검증을 생략할 수 있다.
- 확인한 claims에서 `{sub, email, name, picture}`를 뽑는다. `accountId`는 `sha256(sub)`의 hex 앞 16자다. 렌더러가 계정이 바뀌었는지 알아내는 데 쓴다.
- 사진(선택): `picture` URL의 크기 접미사를 `=s64-c`로 바꿔 5초 안에 받는다. `image/*`이고 64KB 이하이면 `data:` URL로 바꿔 토큰 파일의 `account.pictureData`에 둔다. 렌더러 CSP가 `img-src 'self' data:`라서 원격 이미지는 보여 줄 수 없기 때문이다. 실패하면 null로 두고, 화면은 이름 첫 글자 아바타를 그린다.

**토큰 파일** `<userData>/google-token.bin`은 `safeStorage.encryptString(JSON)`으로 만든다. 쓰기는 tmp 파일에 쓴 다음 rename하고, 권한은 0o600이다.
```js
{ v: 1, clientId: '…apps.googleusercontent.com', refreshToken: '1//…' | null,
  scope: 'openid https://… …', grantedAt: ISO,
  account: { sub, email, name, pictureData: 'data:image/png;base64,…' | null },
  exportCalendarId: null | 'xxxx@group.calendar.google.com' }
```
`clientId`가 지금 설정과 다르면(클라이언트를 바꾼 경우) 이 파일을 무효로 보고 `signed_out`으로 둔다.

### 4.5 갱신
- `getAccessToken()`은 메모리의 access token이 `expiresAt − 60초` 안에 있으면 그대로 돌려준다. 아니면 갱신한다. **동시에 여러 번 불려도 갱신 요청은 한 번만 보낸다.** 진행 중인 Promise를 공유하면 된다.
```
POST https://oauth2.googleapis.com/token
grant_type=refresh_token&refresh_token=…&client_id=…&client_secret=…(있을 때)
→ 200 { access_token, expires_in, scope, token_type, id_token? , refresh_token? }
```
- 응답에 새 `refresh_token`이 있으면 바꾸고, 없으면 기존 것을 유지한다. `scope`가 오면 다시 계산한다.
- `400 invalid_grant`는 만료나 폐기를 뜻한다. 테스트 모드 앱은 refresh token이 7일 만에 만료되므로 흔히 생긴다. 이때는 토큰 파일에서 `refreshToken`만 지우고 `account`(이메일)는 남긴다. 상태는 `reauth`로 바꾼다. 다시 연결할 때 `login_hint`로 이메일을 쓴다.
- `invalid_client`나 `unauthorized_client`이면 상태를 `error`, 오류 type을 `invalid_client`로 둔다. 클라이언트 설정을 확인해야 한다.
- 네트워크 오류이면 상태는 `signed_in` 그대로 두고 `{ok:false, error:{type:'network', retryable:true}}`를 돌려준다.

### 4.6 로그아웃과 폐기
1. 진행 중인 로그인을 취소한다.
2. refresh token을 읽어 둔다.
3. 토큰 파일을 지우고 메모리를 비운다. 상태를 `signed_out`으로 바꾸고 알린다. 실패해도 로컬은 확실히 로그아웃되도록 **로컬부터** 지운다.
4. 폐기를 요청한다. `POST https://oauth2.googleapis.com/revoke`(form `token=<refresh_token>`), 제한 시간 5초. 200이거나 `400 invalid_token`(이미 폐기됨)이면 `revoked:true`다. 네트워크 오류이면 `revoked:false`이고, 화면이 Google 계정 설정 링크를 안내한다.
- `exportCalendarId`도 함께 지워진다(토큰 파일 안에 있으므로). 다시 로그인하면 표식으로 캘린더를 다시 찾는다(§7.3.6).
- `device-id`(아래)는 지우지 않는다.

**기기 id** `<userData>/device-id`는 평문 파일이다. 처음 한 번 `randomBytes(8).hex`로 만든다. 같은 계정을 여러 PC에서 쓸 때 "내가 올린 일정"을 구분하는 데 쓴다(§7.4). 비밀이 아니다.

### 4.7 상태 기계 (`GoogleStatus.state`)

```
            setClient            signIn            코드 교환 성공
needs_setup ─────────→ signed_out ─────→ connecting ─────────────→ signed_in
     ▲ clearClient         ▲  ▲ cancel/timeout/denied ┘                │  │
     └─────────────────────┘  │                                       │  │ refresh invalid_grant
                              │ signOut                                │  ▼
                              └────────────────────────────────────── reauth ── signIn ─→ connecting
signed_in ── invalid_client ─→ error (클라이언트 확인)        범위 부족: signed_in + scopes.* false (needs_scope 표시)
```

### 4.8 인증 오류 type

| type | 원인 | 화면 문구 (§부록 A) | retryable |
|---|---|---|---|
| `not_configured` | 클라이언트 ID 없음 | 준비 필요 | – |
| `invalid_client_input` | 붙여 넣은 값의 형식이 틀림, 또는 웹 유형 JSON | 형식 안내 | – |
| `listen_failed` | 루프백 포트를 열지 못함 | 다시 시도 | ✓ |
| `canceled` / `timeout` | 사용자가 취소함 / 5분이 지남 | 조용히 / 안내 | ✓ |
| `denied` | `error=access_denied`. 테스트 사용자가 아닌 경우도 포함 | 테스트 사용자 확인 안내 | – |
| `state_mismatch` | (기록용) 잘못된 state 요청 | 서버가 계속 기다림 | – |
| `needs_secret` | 토큰 요청이 `client_secret is missing`으로 실패 | 보안 비밀번호 붙여 넣기 안내 | – |
| `invalid_client` | 클라이언트 ID나 secret이 틀림 | 클라이언트 확인 | – |
| `invalid_grant` → 상태 `reauth` | refresh token 만료나 폐기 | 다시 로그인 | – |
| `bad_id_token` | aud, iss, exp, nonce 불일치 | 다시 시도 | ✓ |
| `no_refresh_token` | 응답에 refresh token 없음 | 다시 시도 | ✓ |
| `network` / `server` | 연결 실패 / 5xx | 다시 시도 | ✓ |
| `unavailable` | 브라우저, 검사 실행, 아직 준비 안 됨 | 데스크톱 앱에서만 | – |

---

## 5. 클라이언트 설정과 '준비 필요'

**어디서 읽나(우선순위).** **설정에 저장한 값 > 환경변수 > 앱 폴더 `.env`** 순서다. AI 키와 같은 순서다.
- 환경변수 이름은 `DAYNOTE_GOOGLE_CLIENT_ID`/`DAYNOTE_GOOGLE_CLIENT_SECRET`을 먼저 보고, 그다음 `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`을 본다.
- **`GOOGLE_API_KEY`는 절대 쓰지 않는다.** `services/ai.js`가 이것을 Gemini 키로 읽고 지운다.
- 시작할 때 `captureEnvClient()`가 값을 모듈 안으로 옮기고 `process.env`에서 지운다. `ai.captureEnvKeys()`와 같은 방식이고, 자식 프로세스에 물려주지 않기 위해서다.
- `.env`에서 온 값인지 알기 위해 `loadDotEnv(dir, out)`에 선택 인자 `out`을 추가한다. `out`은 배열이고, 이번에 채운 키 이름이 들어간다. 반환값과 기존 동작은 그대로다.
- `.env`는 패키지 앱에서 asar 안에 있으므로 사실상 개발용이다.

**저장 위치.** `<userData>/google-client.bin`이다. 암호화한 `{ v:1, clientId, clientSecret|null, savedAt }`를 담는다.

**붙여 넣기 해석 (`parseClientInput`).**
- `{clientId, clientSecret}` 필드 두 개를 받는다. 또는 **다운로드한 JSON 전체**(`{text}`)를 받는다.
- JSON이면:
  - `installed.client_id`와 `installed.client_secret`을 쓴다.
  - 최상위 키가 `web`이면 거부한다: "웹 애플리케이션 유형의 클라이언트예요. ‘데스크톱 앱’ 유형으로 새로 만들어 주세요."
- 클라이언트 ID 형식: `^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$`. 앞뒤 공백, 따옴표, 줄바꿈은 지운다.
- secret은 선택이다. 형식: `^[A-Za-z0-9_\-]{10,100}$`. 요즘 값은 `GOCSPX-`로 시작한다.
- 로그인한 상태에서 클라이언트 ID를 바꾸면 기존 토큰은 쓸 수 없다. 그래서 화면에서 확인을 받은 뒤 로그아웃 처리한다.

**'준비 필요' 상태.** 클라이언트 ID가 어디에도 없으면 `state:'needs_setup'`이다.
- 설정 카드는 짧은 설명, **[설정 방법 보기]**(§14 내용을 담은 모달과 "Google Cloud 콘솔 열기" 링크), 붙여 넣기 칸을 보여 준다.
- 붙여 넣기 칸은 ID와 secret, 또는 JSON이다.
- 환경변수나 `.env`로 설정되어 있으면 이 상태를 건너뛴다. 출처는 '고급'에 표시한다.

---

## 6. 데이터 모델

### 6.1 `state.gcal` (새 최상위 키, undo 대상 아님)

`M.emptyState()`에 추가해야 한다. 추가하지 않으면 `normalize`가 다음 실행 때 이 키를 지운다(data map §3).
```js
gcal: {
  v: 1,
  accountId: null,                 // 이 데이터가 어느 계정 것인지 (status.accountId 와 다르면 resetForAccount)
  settings: { exportEnabled: true, exportWork: true, exportTitles: true },
  calendars: [],                   // CalendarEntry[]
  exportCalendarId: null,          // main 이 정해 status 로 알려 준 ‘Daynote’ 캘린더 id 의 사본
  events: [],                      // GEvent[] — Google 원본(읽기 전용) + 다른 기기가 올린 Daynote 일정 거울
  links: {},                       // { [blockId]: Link } — 내가 올린 Daynote 블록 ↔ Google 이벤트
  gens: {},                        // { [blockId]: n } — 이벤트 id 세대 (지워진 id 를 다시 못 쓸 때 +1)
  outbox: [],                      // OutboxEntry[]
  backoffUntil: null,              // ISO — 레이트 리밋 때 모든 호출을 멈출 시각
  lastSyncAt: null, lastError: null   // {type, message, at}
}
```
- `SCHEMA_VERSION`을 4로 올리고 model.js:23의 주석에 `4: Google 캘린더 동기화(gcal) — 되돌리기 대상 아님`을 덧붙인다. 옛 v3 파일은 그대로 읽힌다. 이때 기본값이 채워진다.
- `normalize()`는 `gcal`을 얕게만 합친다. 그래서 이 줄을 추가한다: `s.gcal.settings = Object.assign({}, emptyState().gcal.settings, s.gcal.settings || {})`. 나머지 안쪽 값의 방어는 `G.ensure(state)`가 맡는다.
- `clearSample`은 바꾸지 않는다. 샘플 블록(`sample:true`)은 애초에 내보내지 않는다.
- **백업 내보내기**(`JSON.stringify(S.state)`)에는 가져온 일정의 제목과 시간이 들어간다. 토큰과 secret은 들어가지 않는다. 데이터 카드 도움말에 이 사실을 한 줄 적는다.

### 6.2 `CalendarEntry`
```js
{ id: 'primary@gmail.com' | '…@group.calendar.google.com', summary: '내 캘린더', primary: true,
  color: '#7986cb',                // calendarList.backgroundColor (데이터 색 — 프로젝트 색과 같은 취급)
  accessRole: 'owner'|'writer'|'reader'|'freeBusyReader', timeZone: 'Asia/Seoul',
  selected: true,                  // 가져오기 대상 (처음엔 primary 만 true)
  isExport: false,                 // ‘Daynote’ 캘린더 (가져오기 목록에서 숨기고 되읽기 전용으로 동기화)
  syncToken: null, windowStart: null, windowEnd: null, fullSyncAt: null,
  lastSyncAt: null, nextPullAt: null, error: null }
```

### 6.3 `GEvent` (가져온 일정, 정규화 결과)
```js
{ key: 'g:' + calendarId + '|' + eventId,   // 화면·충돌에서 id 로 쓴다
  calendarId, eventId, recurringEventId: null | 'seriesId',
  etag, updated: ISO,                       // 순서 판정용 (오래된 것이 새것을 덮지 않게)
  status: 'confirmed' | 'tentative',
  title: '팀 주간 회의',                    // summary, 없으면 '(제목 없음)', 300자에서 자름
  location: '', htmlLink: 'https://www.google.com/calendar/event?eid=…', eventType: 'default'|'outOfOffice'|'focusTime',
  allDay: false,
  start: '2026-10-12T01:00:00.000Z', end: '2026-10-12T02:00:00.000Z',   // 항상 toISOString() (UTC Z)
  startDate: null, endDate: null,           // 종일: 'YYYY-MM-DD' (endDate 는 배타적)
  tz: 'Asia/Seoul' | null,                  // event.start.timeZone || 캘린더 timeZone (표시용)
  busy: true,
  response: null | 'accepted' | 'tentative' | 'needsAction',   // attendees[self].responseStatus
  origin: 'google' | 'daynote_other',       // 다른 기기의 Daynote 가 올린 것
  daynoteId: null | 'blk_…' }
```
- 일정 설명(description)과 참석자 목록은 저장하지 않는다. 데이터를 최소로 둔다.
- **`busy` 규칙:** 다음을 모두 만족할 때만 바쁨이다.
  - `!allDay`
  - `transparency !== 'transparent'`
  - `eventType`이 `workingLocation`이나 `birthday`가 아님. 이 두 종류는 아예 저장하지 않는다.
  - 내 응답이 `declined`가 아님. 거절한 일정도 저장하지 않는다.

  `tentative`과 `needsAction`은 바쁨으로 보되 점선 스타일로 그린다.

### 6.4 `Link`, `OutboxEntry`
```js
Link = { eventId, calendarId, gen: 0, etag, remoteUpdated: ISO, hash: 'fnv1a hex',   // 마지막으로 맞춘 본문의 해시
         end: ISO /* 블록 끝 — 정리·삭제 판단용 */, pushedAt: ISO }
OutboxEntry = { id: 'op:' + blockId | 'op:orphan:' + eventId, op: 'insert' | 'patch' | 'delete',
                blockId: 'blk_…' | null, eventId: null | string, calendarId,
                attempts: 0, nextAt: null | ISO, lastError: null | { type, message, at }, createdAt: ISO }
```
- 본문은 outbox에 저장하지 않는다. 보낼 때마다 지금 상태로 계산한다(`dueOps`). 그래서 대기 중에 블록이 또 바뀌면 바뀐 뒤의 최신 값이 올라간다.

### 6.5 화면용 투영 `ExtItem` (model.js가 만든다, 저장하지 않음)
```js
{ id: ev.key, kind: 'event', external: 'google', readOnly: true, taskId: null,
  title, start, end, allDay, startDate, endDate, busy, tentative,
  calendarId, eventId, htmlLink, location, color, calendarName, origin }
```
`id`는 `blocks`에 없는 값이므로 `M.byId(state.blocks, id)`는 null을 돌려준다. 기존 편집 경로는 자연히 무시한다.

---

## 7. 동기화 알고리즘

### 7.1 시간 창, 전체 동기화와 증분 동기화
- `G.windowFor(now)`는 `{ start: 로컬 자정(now − 7일), end: 로컬 자정(now + 61일) }`을 ISO로 돌려준다.
- 전체 동기화 요청: `timeMin=start`, `timeMax=end`, `singleEvents=true`, `maxResults=250`, `fields=EVENT_FIELDS`.
  - `orderBy`는 **쓰지 않는다**. 증분 요청에서 쓸 수 없는 매개변수이고, 정렬은 앱이 한다.
  - `timeMin`은 일정의 끝 시각 하한이고, `timeMax`는 시작 시각 상한(배타)이다.
- 증분 동기화 요청: `syncToken`, `singleEvents=true`, `maxResults=250`, `fields`만 보낸다. **`timeMin`, `timeMax`, `orderBy`, `q`, `updatedMin`, `privateExtendedProperty`는 함께 쓸 수 없다.** 증분 결과에는 삭제된 일정이 항상 들어 있다(`status:'cancelled'`).
- `G.needsFullSync(cal, now)`가 참이 되는 경우는 다음과 같다.
  - `!cal.syncToken`
  - 창이 7일 이상 밀렸을 때: `windowFor(now).end − cal.windowEnd ≥ 7일`. 증분 결과는 처음에 받지 않은 먼 미래 일정을 채워 주지 않기 때문이다.
  - `now − cal.fullSyncAt ≥ 7일`
- 페이지 넘기기는 서비스가 한다. `nextPageToken`이 없을 때까지 받는다. `nextSyncToken`은 **마지막 페이지에만** 온다. 짧은 페이지라고 끝이 아니다. `maxPages`(40 = 1만 개)를 넘으면 `too_many_changes`로 실패시키고, 엔진은 그 캘린더를 초기화한 뒤 전체 동기화한다.

```
EVENT_FIELDS = 'nextPageToken,nextSyncToken,timeZone,items(id,status,etag,updated,summary,location,htmlLink,eventType,'
             + 'transparency,start,end,recurringEventId,originalStartTime,attendees(self,responseStatus),extendedProperties/private)'
```

### 7.2 가져오기 병합 (Daynote 캘린더가 아닌 캘린더)

`planPull(state, calendarId, res, ctx)`의 결과는 `PullPlan`이다.
```js
{ calendarId, full: boolean,
  upserts: [GEvent], removeKeys: [key], removeSeries: [recurringEventId],
  refetchSeries: [recurringEventId],         // 증분에서 반복 인스턴스가 바뀐 시리즈 → events.instances 로 다시 받기
  cursor: { syncToken, windowStart, windowEnd, fullSyncAt? },
  stats: { seen, upserted, removed, skippedStale, outOfWindow } }
```
규칙은 다음과 같다.
1. 각 항목을 `normalizeEvent(raw, ctx)`로 정규화한다.
   - **시각 일정:** `start.dateTime`은 오프셋이 있는 RFC3339다. `new Date(...).toISOString()`으로 UTC로 바꾼다. 오프셋이 없는 비정상 값이면 `start.timeZone`이 `Asia/Seoul`일 때 `+09:00`을 붙인다. 그 밖의 시간대는 로컬 시간으로 해석하고 `tz`를 기록한다.
   - **종일 일정:** `start.date`/`end.date`를 받는다. `end.date`는 배타적이다. `startDate`와 `endDate`에 저장하고, `start`와 `end`는 `D.parseYmd(date)`(로컬 자정)의 ISO로 둔다. 바쁨이 아니다.
   - **취소:** `status:'cancelled'` 항목은 묘비 `{tombstone:true, calendarId, eventId, recurringEventId?}`가 된다. 증분 결과에는 id와 status만 오는 경우도 있다.
   - **버리는 항목:** `workingLocation`, `birthday`, 내가 거절한 일정은 `null`이 되고 저장하지 않는다. 이미 저장된 것이 있으면 지운다.
   - **다른 기기 항목:** `extendedProperties.private.daynoteId`가 있으면 `origin:'daynote_other'`. 단 가져오기 캘린더 안에 있어야 한다. 보통은 Daynote 캘린더 쪽에서 생긴다.
2. **전체 동기화**(`res.full`)이면 응답에 없는 그 캘린더의 기존 일정은 모두 `removeKeys`로 보낸다. 다른 캘린더는 건드리지 않는다.
3. **증분 동기화**이면:
   - 묘비의 `key`를 지운다. 묘비의 `eventId`가 어떤 인스턴스의 `recurringEventId`와 같으면 시리즈 전체(`removeSeries`)를 지운다. `singleEvents=true`이면 시리즈를 지울 때 인스턴스별 묘비가 오지만 두 경우 모두 처리한다.
   - 살아 있는 항목은 `upsert`한다. 단 기존 항목의 `updated`가 더 크면 건너뛴다(`skippedStale`).
   - 지금 창 밖에 있는 항목은 넣지 않는다. 같은 키가 있으면 지운다.
   - `recurringEventId`가 있는 항목이 하나라도 오면 그 시리즈를 `refetchSeries`에 넣는다. 시리즈 시간을 바꾸면 인스턴스 id(`<series>_<원래시작>`)가 바뀌고, 옛 인스턴스가 남을 수 있기 때문이다. 다시 받을 때는 `events.instances(calendarId, seriesId, timeMin, timeMax)`를 부르고 `applySeries`로 창 안의 인스턴스를 통째로 바꾼다.
4. `applyPull(state, plan, now)`은 mutator다. 일정을 반영하고 캘린더 커서를 갱신한다. 반환값은 `{changed}`다. `changed === 0`이면 엔진이 `silent` mutate로 저장만 한다.
5. **410 Gone**은 `res.ok === false`이고 `error.type === 'sync_token_gone'`이다. 이때 `resetCalendar(state, calendarId)`로 커서와 그 캘린더 일정을 지우고 곧바로 전체 동기화를 한 번 더 한다.
6. `prune(state, now)`는 `end < windowFor(now).start`인 일정을 지운다. 같은 함수가 `end`가 30일 넘게 지난 링크도 정리한다. 정리만 하고 Google 일정은 남겨 둔다.

**시간대.** Daynote의 모든 날짜 계산은 OS 로컬 시간 기준이다(`dates.js`). 대상 사용자는 Asia/Seoul이다. 시각 일정은 순간(UTC)으로 저장하므로 시간대가 달라도 정확하다. 종일 일정은 "날짜"이므로 로컬 자정으로 펼친다. 일정의 `tz`가 로컬과 다르면 정보 팝오버에 "원래 시간대: 뉴욕 09:00"처럼 덧붙인다.

### 7.3 내보내기

#### 7.3.1 대상 판정
- `exportable(state, b, ctx)`는 **새로 올릴지** 정한다. 다음을 모두 만족해야 한다.
  - `gcal.settings.exportEnabled`
  - `b.start`와 `b.end`가 있음
  - `!b.sample`
  - `!b.timeUncertain`(AI가 시각을 확정하지 못한 블록은 확인 뒤에 올린다)
  - `b.end >= now − 24시간`
  - `b.kind === 'event'`이거나, `b.kind === 'work'`이면서 `exportWork`가 켜져 있고 할 일이 있고 삭제되지 않았음
- `keepLinked(state, b, ctx)`는 **이미 올린 것을 계속 맞출지** 정한다. 위 조건에서 시간 조건만 뺀 것이다. 거짓이 되는 경우는 종류 설정을 껐을 때, 할 일이 삭제됐을 때, `timeUncertain`이 됐을 때다.

#### 7.3.2 본문과 해시
`eventBody(state, b, ctx)`의 결과는 `{ body, hash }`다.
```js
body = {
  summary: titles ? (b.kind === 'work' ? liveTaskTitle : (b.title || '일정')) : (b.kind === 'work' ? '집중 작업' : '바쁨'),
  description: b.kind === 'work' ? 'Daynote 작업 시간' : 'Daynote 일정',     // 고정 문구(바뀔 때마다 patch 하지 않게)
  location: (b.kind === 'event' && titles && b.location) || undefined,
  start: { dateTime: sec(b.start), timeZone: ctx.tz },   // sec(): 초 단위로 자른 'YYYY-MM-DDTHH:MM:SSZ'
  end:   { dateTime: sec(b.end),   timeZone: ctx.tz },
  transparency: 'opaque',
  reminders: { useDefault: false },                       // Daynote 일정으로 알림이 두 번 오지 않게
  extendedProperties: { private: { daynoteId: b.id, daynoteKind: b.kind, daynoteDevice: ctx.deviceId, daynoteV: '1' } }
}
hash = fnv1a(JSON.stringify([summary, description, location||'', sec(start), sec(end), transparency]))
```
- `remoteHash(raw)`는 Google에서 받은 이벤트로 **같은 규칙**의 해시를 만든다. `dateTime`을 UTC 초 단위로 정규화한다.
- `ctx.tz`는 `Intl.DateTimeFormat().resolvedOptions().timeZone`이다. 없으면 `'Asia/Seoul'`.

#### 7.3.3 이벤트 id(멱등성)
- `eventIdFor(blockId, gen)`은 `'dn' + hex(utf8(blockId)) + (gen ? 'g' + gen.toString(32) : '')`다.
- Google 이벤트 id 규칙은 base32hex(`a-v`, `0-9`), 길이 5~1024자다. 위 값은 그 규칙을 만족하고 결정적이다.
- **insert는 이 id를 직접 지정한다.** 그래서 응답을 못 받고 재시도해도 이벤트가 두 개 생기지 않는다. 두 번째 요청은 409를 받는다.
- 409를 받으면 서비스가 GET으로 확인한다.
  - 같은 `daynoteId`의 살아 있는 이벤트이면 `adopted: true`, 성공이다.
  - 취소된 이벤트(지워진 id는 다시 쓸 수 없음)이면 `id_taken`이다. 코어가 `gens[blockId]++`를 하고 다음 회차에 새 id로 insert한다.

#### 7.3.4 reconcile (멱등)
```
reconcile(state, ctx):
  for b in state.blocks:
    L = links[b.id]
    if !L:  if exportable(b) → want insert(b.id)
    else if !keepLinked(b): want (L.end > now ? delete : unlink)
    else if eventBody(b).hash !== L.hash → want patch(b.id)
  for (id, L) in links where !byId(blocks, id) → want delete(id)          // 지운 블록, 되돌리기로 사라진 블록
  outbox ← merge(outbox, wants):
    같은 blockId 의 기존 항목: op 가 같으면 attempts/nextAt 유지, 다르면 op 만 교체(attempts 0, nextAt 유지)
    want 없는 항목 제거 (단 orphan delete 는 성공/포기 전까지 유지)
    unlink 는 즉시 links 에서 지움 (Google 일정은 남김)
  → { inserts, patches, deletes, unlinked }
```
- export가 꺼져 있으면 아무것도 하지 않는다. 단 `disableExport(state, {removeFuture:true}, now)`가 넣은 delete 항목은 계속 처리한다(`draining`).
- 비용은 O(blocks + links)다. 블록 수십~수백 개는 문제없다.

#### 7.3.5 보내기와 결과 반영
- `dueOps(state, ctx, limit=25)`는 `nextAt <= now`이고 `backoffUntil`이 지난 항목만 고른다. 고른 항목마다 지금 본문을 계산해 `DispatchOp`로 돌려준다.
```js
DispatchOp = { opId, op, calendarId, eventId /* insert: eventIdFor(blockId, gen) */, daynoteId, body /* insert|patch */, hash, gen }
```
- `applyPushResults(state, ops, results, ctx)`의 처리는 다음과 같다.

| 결과 | 처리 |
|---|---|
| insert 성공(또는 adopted) | `links[blockId] = {eventId, calendarId, gen, etag, remoteUpdated: updated, hash: op.hash, end: block?.end, pushedAt: now}`를 만들고 항목을 지운다. 보낸 뒤 블록이 또 바뀌었으면 다음 reconcile에서 patch가 나간다. |
| patch 성공 | 링크의 `etag`, `remoteUpdated`, `hash = op.hash`, `end`를 갱신하고 항목을 지운다. |
| delete 성공, 또는 404·410(이미 없음) | 링크를 지우고 항목을 지운다. |
| patch에 404·410 | Google에서 지워졌다. Daynote가 바꾸던 중이므로 Daynote가 이긴다. 링크를 지우고 `gens+1`을 한다. 다음 회차에 insert한다. |
| `id_taken` | `gens+1`을 하고 바로 다시 시도한다(`nextAt = now`). |
| `rate_limit`, `quota` | `backoffUntil = now + max(retryAfter, backoffMs)`. 이번 회차의 남은 op는 보내지 않는다. |
| `network`, `server`, `timeout` | `attempts++`, `nextAt = now + backoffMs(attempts)`, `lastError`를 기록한다. |
| `bad_request` 등 재시도해도 안 되는 오류 | `attempts++`, `nextAt = now + 24시간`, `lastError`를 기록한다. 설정 카드에 "1개는 Google이 받지 않았어요"로 보인다. |
| `calendar_missing`(내보내기 캘린더 404) / `write_denied` | `lastError`를 `calendar_missing`으로 두고 올리기를 멈춘다. 화면에 "다시 만들기"를 띄운다. |

- `backoffMs(attempts, retryAfterMs, rand)`는 `retryAfterMs`가 있으면 그 값을 쓴다. 없으면 `min(15초 × 2^(attempts−1), 30분) × (0.5 + rand/2)`다.
- 시도 횟수가 `MAX_ATTEMPTS`(8)를 넘어도 항목을 지우지 않는다. **조용히 버리지 않고** 6시간 간격으로 계속 시도한다.

#### 7.3.6 ‘Daynote’ 캘린더 확보
서비스의 `ensureExportCalendar({tz, preferId})`는 다음 순서를 따른다.
1. `preferId`가 있으면 `GET /users/me/calendarList/{id}`로 확인한다. 있고 `accessRole === 'owner'`이면 그것을 쓴다.
2. 없으면 `calendarList`를 모두 받아서 설명에 표식 `[daynote-export:v1]`이 있는 owner 캘린더를 찾는다. 다른 기기나 재설치 뒤에도 같은 캘린더를 다시 쓰기 위해서다.
3. 그래도 없으면 `POST /calendars`로 새로 만든다: `{summary:'Daynote', description:'Daynote가 만든 일정과 작업 시간이에요. 이 캘린더를 지우면 Daynote가 올린 일정도 함께 지워져요. [daynote-export:v1]', timeZone: tz}`.
4. `auth.setExportCalendarId(id)`로 토큰 파일에 기록하고 결과를 돌려준다. 메인은 이후 쓰기 요청을 **이 캘린더에만** 허용한다.

### 7.4 ‘Daynote’ 캘린더 되읽기 (양방향)
- Daynote 캘린더도 다른 캘린더와 같은 방식으로 전체·증분 동기화한다. 다만 결과는 `planOwnPull`로 처리한다.
- **소유 판정:** 다음 중 하나라도 맞으면 내 항목이다.
  - `daynoteDevice === ctx.deviceId`
  - `links[daynoteId]`가 있음
  - `byId(blocks, daynoteId)`가 있음

  셋 다 아니면 다른 기기가 올린 항목이다. 다른 기기 항목은 `origin:'daynote_other'`인 `GEvent`로 거울만 만든다. 읽기 전용이고, 바쁨이며, 정보 팝오버에 "다른 기기의 Daynote"라고 표시한다.
- `daynoteId`가 없는 항목은 사용자가 Google에서 이 캘린더에 직접 만든 일정이다. Google 원본(`origin:'google'`)으로 다룬다.

**충돌 표 (내 항목).** 기호는 이렇다. `local = eventBody(b).hash !== L.hash`(Daynote에서 바뀜), `remote = item.etag !== L.etag`(Google에서 바뀜).

| 블록 | 링크 | Google 항목 | local | remote | 결과 |
|---|---|---|---|---|---|
| 있음 | 있음 | 살아 있음 | ✗ | ✗ | 아무것도 안 한다. 내가 쓴 것이 돌아온 경우(echo)도 여기다. |
| 있음 | 있음 | 살아 있음 | ✓ | ✗ | reconcile이 patch를 낸다(Daynote → Google). |
| 있음 | 있음 | 살아 있음 | ✗ | ✓ | **Google 값을 반영한다.** 일정 블록은 시작·끝·제목·장소를 반영하는데, 제목과 장소는 `exportTitles`일 때만이다. 작업 블록은 시작·끝만 반영한다. 반영한 뒤 `L.hash = remoteHash(item)`, `L.etag`, `L.remoteUpdated`를 갱신한다. 반영하지 않은 필드(작업 블록 제목 등)가 다르면 다음 reconcile이 patch로 되돌린다. |
| 있음 | 있음 | 살아 있음 | ✓ | ✓ | **Daynote가 이긴다.** Google 변경은 다음 patch가 덮는다. `L.etag`는 갱신하지 않는다. |
| 있음 | 있음 | 취소됨 | ✗ | – | **Daynote 블록을 지운다.** 라벨 있는 mutate `'Google에서 지운 일정 반영'`과 되돌리기 토스트를 쓴다. 링크를 지우고 `gens+1`을 한다. |
| 있음 | 있음 | 취소됨 | ✓ | – | 링크를 지우고 `gens+1`을 한다. 다음 reconcile이 새 id로 다시 insert한다(Daynote가 이김). |
| 있음 | 없음 | 살아 있음 | – | – | 링크를 다시 맺는다(백업 복원·재설치). `L.hash = remoteHash(item)`이므로 내용이 다르면 reconcile이 patch를 낸다. |
| 없음 | 있음/없음 | 살아 있음(내 기기 표식) | – | – | 고아다. `op:orphan:<eventId>` delete를 outbox에 넣는다. |
| 없음 | 있음 | 취소됨 | – | – | 링크만 정리한다. |

- 전체 동기화(410 뒤 포함)에서 창 안에 있어야 할 링크된 이벤트가 **보이지 않으면** 지워졌는지 확신할 수 없다. 이때는 데이터를 잃지 않는 쪽을 택한다. 링크를 지우고 `gens+1`을 해서 다시 올린다.
- Google에서 바꾼 것을 반영한 경우(편집이 생긴 경우) 엔진이 토스트를 띄운다: "Google 캘린더에서 바꾼 일정 2개를 반영했어요".
- 지운 것을 반영하는 일은 `applyRemoteDeletes`가 따로 한다. 라벨이 있으므로 undo할 수 있다. undo하면 블록이 돌아오고, 링크는 없고 gen이 올라가 있다. 그래서 다음 reconcile이 새 id로 다시 올린다. 일관성이 유지된다.

### 7.5 재시도, 레이트 리밋, 오프라인
- **서비스 안(요청 1건):**
  - 429, `403 rateLimitExceeded`/`userRateLimitExceeded`, 5xx, 네트워크 오류는 최대 3번 다시 시도한다. 간격은 1초, 2초, 4초에 지터를 더한다. `Retry-After` 헤더가 있으면 그 값을 따른다.
  - `403 quotaExceeded`/`dailyLimitExceeded`는 다시 시도하지 않는다. `{type:'quota', retryAfterMs: 1시간}`을 돌려준다.
  - 401이면 `getAccessToken({forceRefresh:true})`를 한 번 부르고 다시 시도한다. 또 401이면 `auth` 오류다.
  - 요청마다 `AbortController`로 20초 제한을 건다.
- **엔진(회차):**
  - `gcal.backoffUntil`이 미래이면 회차를 건너뛴다. 단 사용자가 직접 [지금 동기화]를 누르면 안내 문구만 보여 준다.
  - 캘린더별 오류는 `cal.error`와 `cal.nextPullAt`에 기록한다. 하나가 실패해도 다른 캘린더는 계속 동기화한다.
- **오프라인:** `fetch`가 TypeError를 던지면 `network`다. outbox는 상태에 영속되므로 앱을 꺼도 남는다. 렌더러의 `online` 이벤트, 창이 보이게 되는 것(`visibilitychange`), 10분 주기에 다시 시도한다.
- **메인의 fetch:** `electron.net.fetch`를 주입한다. Node의 전역 fetch와 달리 시스템 프록시와 OS 인증서 저장소를 따른다. 회사 PC 대응이다. 테스트에서는 가짜 fetch를 주입한다.

### 7.6 엔진 (`renderer/gcalsync.js`) 회차
```
syncNow({reason}) — 한 번에 하나만 실행; 실행 중이면 rerun 표시 후 같은 Promise 반환
  st = await loadStatus();  if !st.signedIn → phase 'idle', return
  mutate(silent): G.ensure(s); if s.gcal.accountId !== st.accountId → G.resetForAccount(s, st.accountId)
                  s.gcal.exportCalendarId = st.exportCalendarId
  if 캘린더 목록이 없거나 24시간 지남 → host.gcal.calendars() → mutate(G.mergeCalendarList)
  if settings.exportEnabled && !exportCalendarId && st.scopes.appCalendar → host.gcal.ensureExportCalendar({tz})
  if backoffUntil > now → 끝
  for cal of (선택된 가져오기 캘린더 + (exportEnabled ? Daynote 캘린더 : [])):
     req = G.pullRequest(cal, now); res = await host.gcal.list(req)
     if res.error?.type ∈ {sync_token_gone, too_many_changes}: mutate(G.resetCalendar); res = await list(G.pullRequest(...))
     if !res.ok: mutate(cal.error 기록; rate_limit 이면 backoffUntil); continue
     if cal.isExport:
        plan = G.planOwnPull(S.state, res, ctx); mutate(null, G.applyOwnPull)
        if plan.remoteDeletes.length: S.mutate('Google에서 지운 일정 반영', G.applyRemoteDeletes); ui.undoToast(...)
     else:
        plan = G.planPull(S.state, cal.id, res, ctx); mutate(null, G.applyPull)
        for sid of plan.refetchSeries: r = await host.gcal.instances({calendarId, eventId:sid, ...windowFor(now)}); mutate(G.applySeries)
  if exportEnabled || draining:
     mutate(G.reconcile)
     최대 4회: ops = G.dueOps(S.state, ctx, 25); if !ops.length break
               r = await host.gcal.push(ops); mutate(G.applyPushResults); if backoffUntil > now break
  mutate: G.prune; gcal.lastSyncAt = now; gcal.lastError = 대표 오류 | null
```
- 동기화에서 생긴 mutate는 모두 `S.mutate(null, fn, {source:'gcal', silent: changed === 0})`다. undo 스택에 쌓이지 않는다. 바뀐 것이 없으면 다시 그리지 않는다.
- **언제 실행하나:**
  - `S.whenReady`에서 3초 뒤.
  - 10분 주기(`setInterval`). 트레이에 숨은 창에서도 최소 1분 간격으로 돈다.
  - `google:changed`로 `signed_in`이 됐을 때.
  - `online` 이벤트, 또는 `visibilitychange`로 보이게 됐는데 마지막 동기화가 2분 넘게 지났을 때.
  - 설정 버튼, 캘린더 선택이나 올리기 설정을 바꿨을 때.
- **올리기만 하는 실행:** `S.subscribe`가 받는 변경 중 `source !== 'gcal'`인 `change`나 `undo`가 생기면 4초 디바운스 뒤 reconcile과 push만 한다. 블록이 바뀌지 않았으면 op가 없으므로 비용이 없다.
- 동기화는 적기(캡처)와 무관하다. 캡처를 막거나 기다리게 하지 않는다(UX 원칙 1·2).

---

## 8. 모듈 API (계약)

### 8.1 `src/core/gcal.js` — UMD, `window.Daynote.gcal`, `require('./dates')`, `require('./model')`, ES5
```js
var G = {
  // 상수
  WINDOW_PAST_DAYS: 7, WINDOW_FUTURE_DAYS: 60, RESYNC_DRIFT_DAYS: 7, FULL_SYNC_MAX_AGE_DAYS: 7,
  EXPORT_PAST_HOURS: 24, LINK_KEEP_DAYS: 30, MAX_ATTEMPTS: 8, MARKER: 'daynote-export:v1',

  // 상태 조각
  emptyGcal: function () {},                              // → GcalSlice (§6.1 기본값; model.emptyState 와 같은 값)
  ensure: function (state) {},                            // → state.gcal (빠진 키 채움, 멱등)
  resetForAccount: function (state, accountId) {},        // events·calendars·links·gens·outbox·exportCalendarId·backoff 비움, settings 유지, accountId 설정
  mergeCalendarList: function (state, items, ctx) {},     // items: calendarList 원본 → {added, removed}; 처음엔 primary selected; 선택·커서 보존;
                                                          //   목록에서 사라진 캘린더의 일정 삭제; id === exportCalendarId 면 isExport
  setSelected: function (state, calendarId, on) {},       // 끄면 그 캘린더 일정·커서 삭제 → {removed}
  disableExport: function (state, opts, now) {},          // opts.removeFuture: true → 미래 링크 delete 항목(draining), false → 링크 전부 unlink

  // 시간 창
  windowFor: function (now) {},                           // → { start: ISO, end: ISO }
  needsFullSync: function (cal, now) {},                  // → boolean
  pullRequest: function (cal, now) {},                    // → { calendarId, syncToken } | { calendarId, timeMin, timeMax }

  // 정규화
  eventKey: function (calendarId, eventId) {},            // → 'g:' + calendarId + '|' + eventId
  normalizeEvent: function (raw, ctx) {},                 // → GEvent | { tombstone:true, calendarId, eventId, recurringEventId } | null
  isBusy: function (ev) {},                               // → boolean (§6.3)

  // 가져오기
  planPull: function (state, calendarId, res, ctx) {},    // → PullPlan (§7.2)  res = gcal:list 성공 응답
  applyPull: function (state, plan, now) {},              // → { changed }
  applySeries: function (state, calendarId, seriesId, items, ctx) {},   // → { changed }
  resetCalendar: function (state, calendarId) {},         // → { removed }
  prune: function (state, now) {},                        // → { removed, linksDropped }

  // 내보내기
  eventIdFor: function (blockId, gen) {},                 // → string (base32hex)
  exportable: function (state, block, ctx) {},            // → boolean
  keepLinked: function (state, block, ctx) {},            // → boolean
  eventBody: function (state, block, ctx) {},             // → { body, hash }
  remoteHash: function (raw) {},                          // → string
  reconcile: function (state, ctx) {},                    // → { inserts, patches, deletes, unlinked }
  dueOps: function (state, ctx, limit) {},                // → DispatchOp[]
  applyPushResults: function (state, ops, results, ctx) {},   // → { done, failed, backoffUntil, exportError }
  backoffMs: function (attempts, retryAfterMs, rand) {},  // → number

  // Daynote 캘린더 되읽기
  planOwnPull: function (state, res, ctx) {},             // → OwnPlan
  applyOwnPull: function (state, plan, ctx) {},           // → { changed, edited, relinked, orphans, mirrored }
  applyRemoteDeletes: function (state, plan, ctx) {},     // → { deleted }  (라벨 있는 mutate 안에서)

  // 표시
  summary: function (state, now) {}                       // → { calendars, selected, events, pending, failed, lastSyncAt, lastError, exportError }
};
// ctx = { now: Date, deviceId: string, tz: string, selfEmail?: string }   — 시계는 절대 직접 읽지 않는다
// OwnPlan = { full, cursor, adoptLinks:[{blockId, link}], remoteEdits:[{blockId, patch, link}], remoteDeletes:[{blockId}],
//             reinserts:[blockId], orphans:[{eventId}], mirrors:[GEvent], removeKeys:[key], dropLinks:[blockId], stats }
```
- 해시는 모듈 안의 작은 `fnv1a`를 쓴다. suggest에 의존하지 않기 위해서다.
- `index.html`에서 `split.js` 바로 뒤에 `<script src="../src/core/gcal.js">`를 넣는다. `build-web`은 고칠 것이 없다.

### 8.2 `src/core/model.js` 변경
```js
SCHEMA_VERSION = 4;
emptyState().gcal = { /* §6.1 */ };
normalize(): + s.gcal.settings 기본값 병합 (§6.1)

externalItems(state, fromIso?, toIso?)        // → ExtItem[]  state.gcal.events 투영, 범위 겹침(start < toIso && end > fromIso), 시작순
calendarItems(state, fromIso, toIso, opts?)   // → (Block | ExtItem)[]  opts: { busyOnly?: boolean, includeAllDay?: boolean=true }
                                              //   blocks 는 기존 규칙(삭제된 할 일의 블록 제외), busyOnly 면 ExtItem 중 busy 만
conflictsFor(state, startIso, endIso, ignoreId, opts?)
                                              // 기존 blocks 결과 + busy 이고 종일 아닌 ExtItem. opts.blocksOnly === true 면 예전과 같다
isExternal(item)                              // → !!item.external
```
- `conflictsFor`를 부르는 곳은 다음과 같다: `schedule.js:28,72,94`, `calendar.js:179,195`, `today.js:387`, `review.js:179,250`, `notes.js:249`, `proposals.js:291`. 모두 결과의 `title`, `start`, `end`, 개수만 쓴다. 그래서 Google 일정이 섞여도 안전하다. 확인 완료.
- `state.gcal`이 없을 수도 있다고 보고 `(state.gcal && state.gcal.events) || []`로 읽는다.

### 8.3 `src/core/recommend.js` 변경
- `calendarContext(state, now)`에서 기존 `live` 계산에 `M.externalItems(state, nowIso, eod)` 중 `busy && !allDay`인 것을 합친다. 그래서 Google 회의 중이면 `busyWith`에 들어가고, 다음 Google 회의까지의 시간이 T가 된다. `blockTitle`은 `taskId`가 없으면 `b.title`을 쓰므로 그대로 동작한다.
- 기존 테스트 18개는 고치지 않고 통과해야 한다. `gcal`이 비어 있으면 결과가 같다.
- 같이 고칠 것: `src/core/ai/assist.js:173`의 `looksIdle`가 `R.recommend(state, {now})`를 부를 때 `workHours`를 넘기지 않는다. 이참에 `state.prefs.workHours`를 넘기도록 고친다(recommend map §4.4).

### 8.4 `services/keystore.js` 추가 (기존 `create`·`loadDotEnv` 동작 유지)
```js
loadDotEnv(dir, out?)                                   // out: string[] — 이번에 채운 키 이름을 push (선택)
createSecretStore(userDataDir, safeStorage, fileName) → {
  read(),        // → object | null   (없음·암호화 불가·복호화 실패·JSON 오류 → null, 오류 삼킴)
  write(obj),    // → { ok:true } | { ok:false, error: '이 컴퓨터에서는 안전하게 저장할 수 없어요.' | e.message }
                 //   mkdir -p → writeFileSync(tmp, encryptString(JSON.stringify(obj)), {mode:0o600}) → renameSync
  clear(),       // → { ok:true }  (unlink, 오류 무시)
  exists()       // → boolean
}
module.exports = { loadDotEnv, create, createSecretStore };
```

### 8.5 `services/google-auth.js` (CommonJS, `require('electron')` 금지)
```js
const SCOPES = ['openid', 'email', 'profile',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/calendar.app.created'];
const ENDPOINTS = { auth: 'https://accounts.google.com/o/oauth2/v2/auth',
                    token: 'https://oauth2.googleapis.com/token', revoke: 'https://oauth2.googleapis.com/revoke' };

create(opts) → AuthService
opts = {
  userDataDir, safeStorage,
  fetch,                         // (url, init) → Promise<{ ok, status, headers:{get}, json(), text() }>   main: electron net.fetch
  openExternal,                  // (url) → Promise    main: shell.openExternal
  createServer = () => http.createServer(),
  randomBytes = crypto.randomBytes, sha256 = (buf) => crypto.createHash('sha256').update(buf).digest(),
  now = Date.now, setTimeout = global.setTimeout, clearTimeout = global.clearTimeout,
  timeoutMs = 300000, exchangeTimeoutMs = 15000, requestTimeoutMs = 20000,
  endpoints = ENDPOINTS, scopes = SCOPES,
  env = null,                    // captureEnvClient() 결과 { clientId, clientSecret, source:'env'|'dotenv' } | null
  onStatus = () => {},           // (GoogleStatus) — 바뀔 때마다
  onFocusApp = () => {},         // 로그인 끝나면 Daynote 창을 앞으로
  log = () => {}                 // 이미 redact 된 문자열만
}

AuthService = {
  status(),                                  // → GoogleStatus (동기, 파일 복호화 결과 캐시)
  setClient(input),                          // input: { clientId?, clientSecret?, text? } → { ok:true, status } | { ok:false, error, status }
  clearClient(),                             // → { ok:true, status }  (저장 값만 지움; env/.env 값은 남음)
  signIn(opts),                              // opts: { loginHint? } → Promise<{ ok:true, status } | { ok:false, error, status }>
  cancelSignIn(),                            // → { ok:true }
  signOut(),                                 // → Promise<{ ok:true, revoked:boolean, status }>
  getAccessToken(opts),                      // opts: { forceRefresh? } → Promise<{ ok:true, accessToken, expiresAt } | { ok:false, error }>
  hasScope(nameOrUrl),                       // 'calendarList'|'eventsRead'|'appCalendar' 또는 전체 URL → boolean
  exportCalendarId(), setExportCalendarId(id),   // 토큰 파일에 영속
  deviceId()                                 // userData/device-id
}

// 순수 도우미 (테스트가 직접 부른다)
makePkce(randomBytes, sha256)              // → { verifier, challenge }
buildAuthUrl({ endpoint, clientId, redirectUri, scopes, state, nonce, challenge, loginHint })   // → string
parseIdToken(jwt, { clientId, nonce, now }) // → { ok:true, claims:{ sub, email, name, picture } } | { ok:false, reason }
parseClientInput(input)                     // → { ok:true, clientId, clientSecret|null } | { ok:false, error:{ type:'invalid_client_input', message } }
captureEnvClient(env = process.env, dotenvKeys = [])   // → { clientId, clientSecret, source } | null ; 읽은 키를 env 에서 지운다
redact(text)                                // → string  (ya29.…, 1//…, GOCSPX-…, eyJ….….…, code=…, refresh_token=…, 알려진 값 → '[가림]')
module.exports = { create, SCOPES, ENDPOINTS, makePkce, buildAuthUrl, parseIdToken, parseClientInput, captureEnvClient, redact };
```
**`GoogleStatus`** (렌더러가 보는 전부다. 토큰은 없다)
```js
{ available: true,
  state: 'needs_setup' | 'signed_out' | 'connecting' | 'signed_in' | 'reauth' | 'error' | 'unavailable',
  signedIn: boolean,
  email: string|null, name: string|null, picture: 'data:image/…' | null,
  accountId: string|null,                     // sha256(sub) 앞 16 hex
  deviceId: string,
  scopes: { calendarList: boolean, eventsRead: boolean, appCalendar: boolean },
  client: { configured: boolean, source: 'saved'|'env'|'dotenv'|null, idHint: '1234…apps.googleusercontent.com'|null, hasSecret: boolean },
  exportCalendarId: string|null,
  error: null | { type, message, retryable },
  reason?: string }                           // available:false 일 때 화면 문구
```

### 8.6 `services/gcal.js` (CommonJS)
```js
create({ auth, fetch, sleep = (ms) => new Promise(r => setTimeout(r, ms)), now = Date.now, random = Math.random,
         base = 'https://www.googleapis.com/calendar/v3', pageSize = 250, maxPages = 40, retries = 3,
         requestTimeoutMs = 20000, log = () => {} }) → {
  listCalendars(),                         // → { ok:true, items:[RawCalendarListEntry] } | { ok:false, error }   (minAccessRole=freeBusyReader, 페이지 이어 받기)
  ensureExportCalendar({ tz, preferId }),  // → { ok:true, calendar:{ id, summary, timeZone }, created } | { ok:false, error }   (§7.3.6)
  listEvents({ calendarId, syncToken, timeMin, timeMax }),
                                           // → { ok:true, items:[RawEvent], nextSyncToken, full, pages, timeZone } | { ok:false, error }
  listInstances({ calendarId, eventId, timeMin, timeMax }),   // → { ok:true, items } | { ok:false, error }
  push(ops)                                // ops: DispatchOp[] (≤50) → { ok:true, results:[PushResult] } | { ok:false, error }
}
PushResult = { opId, ok:true, eventId, etag, updated, adopted? }
           | { opId, ok:false, error:{ type, status, reason, retryable, retryAfterMs, message } }
ApiError.type ∈ 'auth'|'reauth'|'needs_scope'|'forbidden'|'write_denied'|'not_found'|'calendar_missing'|'gone'|'sync_token_gone'
              |'too_many_changes'|'rate_limit'|'quota'|'server'|'network'|'timeout'|'bad_request'|'conflict'|'id_taken'|'not_signed_in'
// 순수 도우미
classifyHttpError({ status, body, headers, context: 'list'|'insert'|'patch'|'delete'|'calendar' })   // → ApiError
sanitizeBody(body)                         // 허용 키만: summary, description, location, start{dateTime,timeZone}, end{…}, transparency,
                                           //   reminders{useDefault}, extendedProperties.private 의 'daynote*' 키(값 ≤1024자) → body | null
EVENT_FIELDS                               // §7.1
module.exports = { create, classifyHttpError, sanitizeBody, EVENT_FIELDS };
```
- 요청 형식:
  - 목록: `GET {base}/calendars/{encodeURIComponent(cid)}/events?singleEvents=true&maxResults=250&fields=…[&timeMin&timeMax | &syncToken][&pageToken]`
  - 생성: `POST …/events?sendUpdates=none`, 본문에 `id` 포함
  - 수정: `PATCH …/events/{id}?sendUpdates=none`
  - 삭제: `DELETE …/events/{id}?sendUpdates=none`
  - 반복 인스턴스: `GET …/events/{id}/instances?timeMin&timeMax&maxResults=250&fields=…`
- 헤더: `Authorization: Bearer <token>`, `Accept: application/json`. 본문이 있으면 `Content-Type: application/json`.
- 상태 코드 분류:
  - 목록에서 410 → `sync_token_gone`. 삭제에서 410·404 → 성공(`ok:true`).
  - 수정에서 404·410 → `gone`.
  - 생성에서 409 → GET으로 확인한 뒤 `adopted`나 `id_taken`.
  - 캘린더 경로가 404 → `calendar_missing`.
  - 403 `insufficientPermissions`·`ACCESS_TOKEN_SCOPE_INSUFFICIENT` → `needs_scope`. 403 `forbidden`(Daynote 캘린더 쓰기) → `write_denied`.
- **쓰기 화이트리스트:** `push`는 `op.calendarId !== auth.exportCalendarId()`이면 요청하지 않고 `write_denied`를 돌려준다. 고아 delete를 빼면 eventId는 `^[a-v0-9]{5,1024}$`여야 한다.

### 8.7 `main.js` 배선과 IPC 표
```js
// 모듈 맨 위 (기존 loadDotEnv 줄 교체)
const dotenvKeys = [];
keystoreMod.loadDotEnv(__dirname, dotenvKeys);
const googleAuthMod = require('./services/google-auth');
const gcalMod = require('./services/gcal');
const envGoogleClient = googleAuthMod.captureEnvClient(process.env, dotenvKeys);   // ai.captureEnvKeys() 바로 옆
let googleAuth = null, gcalSvc = null;

// app.whenReady() 안, keystore 생성 다음 (safeStorage·net 은 ready 뒤에만 유효)
if (!CHECK_RUN) {
  const fetchFn = (u, init) => net.fetch(u, init);               // electron import 목록에 net 추가
  googleAuth = googleAuthMod.create({ userDataDir: app.getPath('userData'), safeStorage, fetch: fetchFn,
    openExternal: (u) => shell.openExternal(u), env: envGoogleClient,
    onStatus: (st) => { if (mainWindow) mainWindow.webContents.send('google:changed', st); },
    onFocusApp: showMain });
  gcalSvc = gcalMod.create({ auth: googleAuth, fetch: fetchFn });
}

const G_UNAVAILABLE = () => ({ available: false, state: 'unavailable', signedIn: false, email: null, name: null, picture: null,
  reason: CHECK_RUN ? '검사 실행 중에는 Google 연결을 쓰지 않아요.' : '잠시 뒤 다시 시도해 주세요.' });
const fromMain = (e) => !!mainWindow && e.sender === mainWindow.webContents;
function gh(fn) {                       // 보낸 창 확인 + 미준비 + 예외 → 평범한 객체
  return async (e, arg) => {
    if (!fromMain(e)) return { ok: false, error: { type: 'forbidden', message: '허용되지 않은 요청이에요.', retryable: false } };
    if (!googleAuth) return { ok: false, error: { type: 'unavailable', message: G_UNAVAILABLE().reason, retryable: false }, status: G_UNAVAILABLE() };
    try { return await fn(arg || {}); }
    catch (err) { return { ok: false, error: { type: 'unknown', message: googleAuthMod.redact(String(err && err.message || err)), retryable: false } }; }
  };
}
```
IPC 채널은 다음과 같다. 이름은 기존 `namespace:verb` 규칙을 따르고, 모두 `ipcMain.handle`/`invoke`를 쓴다. `google:changed`만 예외로 send다.

| 채널 | 인자 (preload에서 강제 변환) | 반환 |
|---|---|---|
| `google:status` | – | `GoogleStatus` (googleAuth가 없으면 `G_UNAVAILABLE()`) |
| `google:setClient` | `{ clientId:String, clientSecret:String, text:String }` (각 ≤ 20000자) | `{ ok, error?, status }` |
| `google:clearClient` | – | `{ ok:true, status }` |
| `google:signIn` | `{ loginHint: String\|null }` | `{ ok:true, status }` \| `{ ok:false, error, status }` |
| `google:cancelSignIn` | – | `{ ok:true }` |
| `google:signOut` | – | `{ ok:true, revoked, status }` |
| `google:changed` (main→renderer) | `GoogleStatus` | – |
| `gcal:calendars` | – | `{ ok, items, error? }` |
| `gcal:ensureExportCalendar` | `{ tz:String, preferId:String\|null }` | `{ ok, calendar, created, error? }` |
| `gcal:list` | `{ calendarId, syncToken?, timeMin?, timeMax? }` (문자열, ≤ 2048자) | `{ ok, items, nextSyncToken, full, pages, timeZone }` \| `{ ok:false, error }` |
| `gcal:instances` | `{ calendarId, eventId, timeMin, timeMax }` | `{ ok, items }` \| `{ ok:false, error }` |
| `gcal:push` | `DispatchOp[]` (≤ 50, 메인에서 `sanitizeBody`) | `{ ok, results }` \| `{ ok:false, error }` |

- 모든 반환값은 구조화 복제를 거친다. 그래서 `Error` 인스턴스가 아닌 평범한 객체만 돌려준다.
- 스모크 검사의 화면 목록과 `ai:*` 핸들러는 바꾸지 않는다. CHECK_RUN이면 `googleAuth`가 null이므로 네트워크를 쓰지 않는다.

### 8.8 `preload.js` 표면 (`window.daynoteHost`에 추가)
```js
google: {
  status: () => ipcRenderer.invoke('google:status'),
  setClient: (input) => ipcRenderer.invoke('google:setClient', { clientId: String((input && input.clientId) || ''),
    clientSecret: String((input && input.clientSecret) || ''), text: String((input && input.text) || '') }),
  clearClient: () => ipcRenderer.invoke('google:clearClient'),
  signIn: (opts) => ipcRenderer.invoke('google:signIn', { loginHint: opts && opts.loginHint ? String(opts.loginHint) : null }),
  cancelSignIn: () => ipcRenderer.invoke('google:cancelSignIn'),
  signOut: () => ipcRenderer.invoke('google:signOut'),
  onChanged: (fn) => ipcRenderer.on('google:changed', (_e, st) => fn(st))
},
gcal: {
  calendars: () => ipcRenderer.invoke('gcal:calendars'),
  ensureExportCalendar: (o) => ipcRenderer.invoke('gcal:ensureExportCalendar', { tz: String((o && o.tz) || 'Asia/Seoul'), preferId: o && o.preferId ? String(o.preferId) : null }),
  list: (req) => ipcRenderer.invoke('gcal:list', req),
  instances: (req) => ipcRenderer.invoke('gcal:instances', req),
  push: (ops) => ipcRenderer.invoke('gcal:push', ops)
}
```

### 8.9 `renderer/store.js` 변경
1. **브라우저 대체 host에 스텁을 추가한다.** 추가하지 않으면 웹 데모, `serve.js`, 설정 화면이 깨진다.
```js
var G_UNAVAILABLE = { available: false, state: 'unavailable', signedIn: false, email: null, name: null, picture: null,
  reason: 'Google 캘린더 연결은 데스크톱 앱에서만 쓸 수 있어요.' };
function gNo() { return Promise.resolve({ ok: false, error: { type: 'unavailable', message: G_UNAVAILABLE.reason, retryable: false }, status: G_UNAVAILABLE }); }
// host 객체에:
google: { status: function () { return Promise.resolve(G_UNAVAILABLE); }, setClient: gNo, clearClient: gNo, signIn: gNo,
          cancelSignIn: function () { return Promise.resolve({ ok: true }); }, signOut: gNo, onChanged: function () {} },
gcal: { calendars: gNo, ensureExportCalendar: gNo, list: gNo, instances: gNo, push: gNo }
```
2. **undo에서 `gcal`을 뺀다.**
```js
// mutate: 라벨 스냅숏에서 gcal 을 빼고 복제 (메모리 절약)
var before = null;
if (label) { var g = state.gcal; state.gcal = null; before = clone(state); state.gcal = g; }
// undo: prefs 와 같이 지금 값을 유지
var prefs = state.prefs, gcal = state.gcal;
state = last.snapshot; state.prefs = prefs; state.gcal = gcal;
```
- 옛 preload에 `host.google`이 없을 수도 있다. 그래서 `DN.gcalSync`는 `S.host.google`이 없으면 `available() === false`로 처리한다.

### 8.10 `renderer/gcalsync.js` (`DN.gcalSync`, IIFE, ES5)
`index.html`에서 `aiflow.js` 다음에 넣는다. 의존하는 것은 `DN.store`, `DN.gcal`, `DN.ui`이고, `DN.app`은 늦게 참조한다.
```js
DN.gcalSync = {
  available: function () {},              // → boolean  (S.host.google 있고 status.available)
  status: function () {},                  // → 캐시된 GoogleStatus (초기값 { available:false, state:'loading', signedIn:false })
  loadStatus: function () {},              // → Promise<GoogleStatus>  (캐시 갱신 + 알림)
  onChange: function (fn) {},              // → unsubscribe  fn({ status, phase })
  phase: function () {},                   // → 'idle'|'syncing'|'pushing'|'offline'|'backoff'|'error'
  syncNow: function (opts) {},             // opts: { reason:'start'|'timer'|'manual'|'signin'|'select'|'online'|'focus' } → Promise<SyncReport>
  schedulePush: function () {},            // 4초 디바운스 reconcile+push
  signIn: function () {}, cancelSignIn: function () {}, signOut: function () {},   // host 감싸기 + 상태·state.gcal 정리
  setClient: function (input) {}, clearClient: function () {},
  setSelected: function (calendarId, on) {},       // mutate(G.setSelected) → syncNow('select')
  setExport: function (patch) {},                  // patch ⊂ { exportEnabled, exportWork, exportTitles } (끌 때는 화면이 removeFuture 를 물어 opts 로)
  refreshCalendars: function () {}, ensureExportCalendar: function () {},
  ctx: function () {}                              // → { now: A.now(), deviceId, tz }
};
// SyncReport = { ok, pulled:{ [calendarId]: { full, upserted, removed } }, pushed:{ done, failed }, edited, remoteDeleted, error? }
```
- 로그아웃 순서: `host.google.signOut()` → `S.mutate(null, s => G.resetForAccount(s, null), {source:'gcal'})` → 토스트.
- `signed_out`이나 `reauth` 상태에서는 타이머를 멈춘다. 다만 outbox는 남긴다. reauth 뒤 같은 계정이면 이어서 보낸다.

---

## 9. 화면

### 9.1 설정 › ‘Google 캘린더’ 카드
기존 정적 '캘린더' 카드(settings.js:190-193)를 바꾼다. 카드는 `section.card.settings-card[aria-labelledby=set-gcal]` > `h3#set-gcal '캘린더'`다. 상태 줄은 기존 `.status-line .status-dot(.ok|.busy|.err)`를 다시 쓴다. Outlook 캘린더는 P2 설정 정리 방향에 맞춰 '준비 중' 줄에 둔다.

| 상태 | 상태 줄 | 내용·버튼 |
|---|---|---|
| `unavailable`(브라우저·검사 실행) | 점 없음, **데스크톱 앱에서만 쓸 수 있어요** | help: "Google 로그인은 Daynote 데스크톱 앱에서 브라우저를 열어 진행해요. 웹 미리보기에서는 앱 안 캘린더만 써요." |
| `needs_setup` | 점 없음, **준비 필요** | help: "Google 캘린더를 연결하려면 Google Cloud에서 ‘데스크톱 앱’용 OAuth 클라이언트를 한 번 만들어 붙여 넣어야 해요. 10분쯤 걸려요." 버튼은 [설정 방법 보기]이다. 그 아래 입력: `label '클라이언트 ID'` + `input.input#gc-id`(placeholder `1234-abc.apps.googleusercontent.com`), `label '클라이언트 보안 비밀번호'` + `input[type=password]#gc-secret`(placeholder `GOCSPX-로 시작해요`), `link-btn 'JSON 내용으로 붙여 넣기'`(textarea로 바뀜), 그리고 [저장]. help: "보안 비밀번호는 이 컴퓨터에 암호화해 두고 화면에 다시 보여 주지 않아요." |
| `signed_out` | 점 없음, **연결 전** | 데이터 범위 문단(아래)과 **[Google 계정으로 연결]**(primary) |
| `connecting` | `busy`, **브라우저에서 로그인을 기다리는 중…** | help: "열린 브라우저에서 계정을 고르고 ‘허용’을 눌러 주세요. 모든 항목에 체크해야 캘린더를 가져올 수 있어요." 버튼은 [취소]다. |
| `signed_in` | `ok`, **연결됨** · `b(email)` | 계정 줄(`.gcal-account`: 아바타 `img.gcal-avatar[src=data:…]`, 없으면 첫 글자 원, 그리고 이름). 이어서 아래 세 묶음. |
| `reauth` | `err`, **다시 로그인이 필요해요** · email | help: "로그인이 만료됐어요. 테스트 모드 앱은 Google 정책상 7일마다 만료돼요." 버튼은 [다시 연결](primary, loginHint)과 [연결 해제]다. |
| `error` | `err`, **연결 설정 오류** | `div.conflict-box[role=alert]`에 오류 문구, 버튼은 [클라이언트 바꾸기] |

`signed_in` 묶음은 다음과 같다.
1. **가져올 캘린더**(`h4`): `ul.gcal-cal-list`의 각 줄은 `label.check-row`이다. 줄 안에 `input[type=checkbox]`, `span.gcal-dot`(색은 `el.style.setProperty('--gc', color)`로 넣는다. ui map G1 함정), 이름, 기본 캘린더면 `chip '기본'`이 있다.
   - `isExport` 캘린더는 목록에 넣지 않는다.
   - `freeBusyReader` 캘린더는 비활성으로 두고 help를 단다: "바쁨 정보만 볼 수 있는 캘린더는 아직 못 가져와요."
   - 범위 `eventsRead`가 없으면 묶음 전체 대신 `conflict-box`를 보여 준다: "캘린더 권한이 허용되지 않았어요. ‘다시 연결’에서 모든 항목에 체크해 주세요." 버튼은 [다시 연결]이다.
2. **Daynote 일정 올리기**(`h4`):
   - `check-row #gc-export`: "Daynote에서 만든 일정을 Google 캘린더 ‘Daynote’에 올리기"
   - 그 아래 들여 쓴 `check-row #gc-work`: "작업 시간도 올리기"
   - `#gc-titles`: "제목 그대로 올리기 (끄면 ‘바쁨’으로만 보여요)"
   - `appCalendar` 범위가 없으면 help: "Daynote 캘린더를 만들 권한이 없어요. 다시 연결해 주세요."
   - `exportError === 'calendar_missing'`이면 `conflict-box`: "Google에서 ‘Daynote’ 캘린더를 찾을 수 없어요." 버튼은 [다시 만들기]와 [올리기 끄기]다.
   - 올리기를 끌 때는 `ui.modal`로 묻는다. 제목은 "Daynote 일정 올리기를 끌까요?", 본문은 "Google에 올린 앞으로의 일정 N개를 어떻게 할까요?", 선택지는 [Google에서도 지우기](danger)와 [그대로 두기]다.
3. **상태와 동작:**
   - `div.help`: "마지막 동기화: 오늘 10:32 · 가져온 일정 42개 · 올릴 일정 0개"
   - 실패가 있으면 덧붙인다: " · 올리지 못한 일정 1개"
   - [지금 동기화]: `refresh` 아이콘. 진행 중이면 '동기화 중…'으로 바뀌고 비활성이 된다.
   - `lastError`가 있으면 `conflict-box[role=alert]`에 §부록 A의 문구와 다음 행동 버튼을 넣는다.
   - **데이터 범위 문단**(`p.help`, 지워선 안 된다): "가져오기: 고른 캘린더의 일정 제목·시간·장소만 읽어 캘린더 화면과 ‘다음 할 일’ 추천의 바쁜 시간에 써요. Google 일정은 Daynote에서 바꾸지 않아요. 올리기: Daynote가 만든 ‘Daynote’ 캘린더에만 써요. 다른 캘린더는 건드리지 않아요."
   - [연결 해제](`btn-danger`) → `ui.confirm('Google 연결을 해제할까요?', '이 컴퓨터에 저장된 Google 로그인 정보를 지우고 Google에도 권한 해제를 요청해요. 가져온 Google 일정은 Daynote에서 사라져요. Google 캘린더의 ‘Daynote’ 캘린더와 그 일정은 그대로 남아요.', '연결 해제')`
     - 성공 토스트: "Google 연결을 해제했어요."
     - `revoked:false`이면: "이 컴퓨터에서는 해제했어요. Google 쪽 권한은 Google 계정 설정에서 지울 수 있어요." 토스트 동작은 [열기] → `window.open('https://myaccount.google.com/connections')`.
4. **고급**(`details`/`summary` 새 패턴. P2 설정의 '고급'과 같이 쓴다):
   - "클라이언트: 1234…apps.googleusercontent.com (이 앱에 저장 / 환경변수 / 앱 폴더의 .env)", 버튼 [클라이언트 바꾸기], [저장한 클라이언트 지우기]
   - "권한: 캘린더 목록 보기 ✓ · 일정 보기 ✓ · Daynote 캘린더 쓰기 ✓"
   - "테스트 모드 앱은 7일마다 다시 로그인해야 해요."
   - `link-btn` "Google 계정에서 연결된 앱 보기"

**다시 그리기 문제.** 지금 설정 화면은 `{}`를 돌려주므로 아무 mutate에나 통째로 다시 그려진다. 그러면 입력 중인 클라이언트 ID가 사라진다. 그래서 `render`는 `{ onChange: function (info) { if (info.source === 'gcal' || info.source === 'gcal-settings') { paintGoogleCard(); return true; } return false; } }`를 돌려준다. `DN.gcalSync.onChange`에서도 `paintGoogleCard()`만 다시 그린다. 입력칸이 있는 `needs_setup` 상태에서는 입력값이 있으면 다시 그리지 않는다.

**[설정 방법 보기] 모달**(`ui.modal({wide:true})`)은 §14 단계 1~7의 줄임판이다. 링크 버튼 "Google Cloud 콘솔 열기"는 `window.open('https://console.cloud.google.com/auth/clients')`이고 `openExternal`로 간다.

### 9.2 캘린더 화면 (`views/calendar.js`)
- `placeBlocks(col, d)`의 목록을 `S.state.blocks.filter(...)`에서 **`M.calendarItems(S.state, dayStartIso, dayEndIso, {includeAllDay:false})`**로 바꾼다. 차선 계산을 같이 하므로 겹친 일정이 나란히 그려진다.
  - 외부 항목은 `div.cal-block.ext(.is-tentative)`로 그린다.
  - 속성은 `draggable='false'`, `aria-label='Google 일정: 팀 회의, 10:00부터 11:00까지, 읽기 전용'`이다.
  - 클릭과 Enter는 `extInfo(item, el)` 팝오버를 연다(`ui.popover`, label 'Google 일정').
    - 팝오버 내용: 제목, `D.relDay` + 시간, 캘린더 점과 이름, 장소, 시간대 안내, "Google 일정이라 Daynote에서는 바꿀 수 없어요."
    - 버튼: [Google 캘린더에서 열기](`window.open(htmlLink)`)
    - 다른 기기 항목: "다른 기기의 Daynote가 올린 일정이에요."
  - 외부 항목은 투영 객체라서 `__lane`이 저장되지 않는다. 기존 블록의 `__lane` 저장 버그는 따로 고친다.
- **종일 줄:** 날짜 머리 아래에 `div.cal-allday`를 넣는다. 날짜별 `span.cal-allday-item`(캘린더 색 막대와 제목)이 들어가고 클릭은 같은 팝오버를 연다. 여러 날에 걸친 종일 일정은 해당하는 각 날에 표시한다. 종일 일정이 하나도 없으면 줄을 숨긴다.
- 드래그 유령의 충돌 표시(`conflictsFor`)에는 Google 일정이 자동으로 들어간다. "겹침 N건"이다.
- **스타일**(새 토큰 없이 기존 토큰만 쓴다):
```css
.cal-block.ext { background: var(--surface-subtle); color: var(--text-secondary); border: 1px dashed var(--border-strong);
  box-shadow: inset 3px 0 0 var(--gc, var(--text-tertiary)); cursor: default; }
.cal-block.ext.is-tentative { background-image: repeating-linear-gradient(135deg, transparent 0 6px, var(--surface-hover) 6px 7px); }
.cal-allday { display: grid; border-bottom: 1px solid var(--grid-line); min-height: 0; }
.cal-allday-item { font-size: 12px; border-radius: 6px; padding: 1px 6px; background: var(--surface-subtle);
  box-shadow: inset 3px 0 0 var(--gc, var(--text-tertiary)); color: var(--text-secondary); }
.agenda-item.is-ext .t::after { content: ' · Google'; color: var(--text-tertiary); }
```

### 9.3 오늘 화면, 추천, 일정 대화상자, 팔레트
- **오늘 일정**(`today.js:369` `agenda`): 목록을 `M.calendarItems(st, 오늘 0시, 내일 0시)`로 바꾼다. 종일 항목은 맨 위에 "종일 · 연차"처럼 둔다. 외부 항목은 `.agenda-item.is-ext`이고 클릭하면 같은 정보 팝오버를 연다. 겹침 표시는 그대로 `conflictsFor`를 쓴다.
- **추천:** 바꿀 것이 없다. `calendarContext`가 Google 일정을 보므로 다음이 자동으로 된다.
  - `nextCard`의 근거가 "다음 일정 ‘팀 주간 회의’까지 30분이 있고…"가 된다.
  - Google 회의 중에는 T를 모른다.
  - `assistant.tryNudge`가 회의 중에는 끼어들지 않는다.
- **일정 대화상자**(`schedule.js`):
  - 충돌 문구에서 외부 항목 제목 뒤에 " (Google)"을 붙인다.
  - `findFreeSlot`은 `conflictsFor`를 거치므로 Google의 바쁜 시간을 피한다.
  - 블록 편집 화면 아래에 동기화 상태를 한 줄 넣는다. `links`와 `outbox`를 보고 정한다.
    - "Google 캘린더 ‘Daynote’에 반영됨"
    - "Google에 올리는 중이에요"
    - "Google에 올리지 못했어요 · 설정에서 확인"
    - "시각을 확인하면 Google에 올라가요" (`timeUncertain`)
  - 기존 문구 "빈 시간은 앱 캘린더 기준의 후보입니다…"는 연결 중이면 "Google 캘린더의 바쁜 시간도 반영한 후보예요."로 바꾼다.
- **팔레트**(`palette.js:105`): '일정' 그룹에 외부 항목을 합친다. sub는 `'Google · ' + calendarName`이다. 실행하면 `A.go('calendar', {anchor: D.ymd(start)})`로 간다. `calendar.js`는 `params.anchor`를 한 번 읽고 지운다(archive 패턴).

### 9.4 토스트 문구
- 첫 업로드: "Daynote 일정 N개를 Google 캘린더 ‘Daynote’에 올렸어요."
- 되읽기 편집: "Google 캘린더에서 바꾼 일정 N개를 반영했어요."
- 되읽기 삭제: "Google 캘린더에서 지운 일정 N개를 Daynote에서도 지웠어요." + [되돌리기]
- 로그인 완료: "Google 계정(<email>)을 연결했어요. 일정을 가져오는 중이에요."
- 수동 동기화가 오프라인일 때: "인터넷에 연결되지 않아 동기화를 미뤘어요. 연결되면 다시 할게요."

---

## 10. 웹 데모와 검사 실행
- `serve.js`와 `dist-web`에서는 `window.daynoteHost`가 없으므로 §8.9의 스텁이 쓰인다. 설정 카드는 '데스크톱 앱에서만 쓸 수 있어요'를 보여 주고, 엔진 타이머는 시작하지 않는다.
- `state.gcal`은 기본값(빈 값)이다. 그래서 캘린더와 추천의 동작이 지금과 같다.
- `build-web.js`는 고칠 것이 없다. `src/core/gcal.js`와 `renderer/gcalsync.js`는 자동으로 복사되고 `index.html` 태그로 불린다. 파일 이름이 `quick.js`로 끝나지 않으므로 필터에 걸리지 않는다.
- `--smoke`와 `--shots`에서는 `googleAuth`가 null이므로 상태가 `unavailable`이다. 그래서 네트워크를 쓰지 않는다. 스모크의 `settings` 방문은 오류 없이 그려져야 한다. 샷 `15-연결과설정`에는 '데스크톱 앱에서만' 대신 "검사 실행 중에는 Google 연결을 쓰지 않아요."가 보인다.

---

## 11. 보안·개인정보 체크리스트
- [ ] refresh token, access token, secret, code는 **렌더러·`S.state`·백업·로그·오류 메시지 어디에도** 나가지 않는다. 오류 메시지는 `redact()`를 거친다. 테스트로 `JSON.stringify(result)`에 토큰 조각이 없는지 확인한다.
- [ ] 토큰과 클라이언트 파일은 `safeStorage`로 암호화한다. Windows는 DPAPI다. `isEncryptionAvailable()`이 거짓이면 저장을 거부하고 "이 컴퓨터에서는 안전하게 저장할 수 없어요."를 보여 준다. Linux의 `basic_text` 백엔드는 약하므로 고급에 안내한다.
- [ ] 루프백 서버는 127.0.0.1 전용이고 한 번만 쓰며 5분 뒤 닫힌다. Host 검사, state·nonce 상수 시간 비교, `no-store`, CSP 헤더를 갖춘다.
- [ ] `openExternal`은 우리가 만든 `ENDPOINTS.auth` URL에만 쓴다. 앱 안 웹뷰 로그인은 쓰지 않는다.
- [ ] `google:*`와 `gcal:*` 핸들러는 `e.sender === mainWindow.webContents`를 확인한다. 빠른 메모 창이나 다른 창에서 온 요청은 거부한다.
- [ ] 쓰기는 `exportCalendarId` 한 곳에만 한다(메인 화이트리스트와 `calendar.app.created` 범위로 이중으로 막는다). 본문은 `sanitizeBody`를 거치고, `sendUpdates=none`으로 보낸다.
- [ ] 저장하는 데이터를 최소로 둔다. 설명과 참석자 목록은 저장하지 않는다. 사진은 64px `data:` URL만 둔다. 렌더러 CSP는 바꾸지 않는다.
- [ ] 로그아웃하면 로컬을 먼저 지우고 폐기를 요청한다. 실패하면 사용자가 직접 해제할 수 있는 경로를 안내한다.
- [ ] 메일과 일정 본문은 데이터일 뿐 지시가 아니다(README 원칙). 일정 제목을 AI 프롬프트에 넣는 것은 v1에서 하지 않는다.

---

## 12. 테스트 계획

규칙은 `node:test`와 `node:assert/strict`, 한국어 테스트 이름, 고정 시계 `NOW = new Date(2026, 9, 5, 10, 0)`(월), 상태는 `M.emptyState()`와 mutator로 만드는 것이다. 공용 헬퍼 없이 파일마다 정의한다. 실제 네트워크는 쓰지 않는다. 다만 루프백 테스트는 실제 `http`를 127.0.0.1에서 쓴다.

### 12.1 가짜 도구 (각 테스트 파일에 복사)
```js
// 가짜 fetch — 요청을 기록하고 handler 가 응답을 정한다
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(String(url));
    const req = { url: u, method: init.method || 'GET', headers: init.headers || {}, body: init.body == null ? null : String(init.body) };
    calls.push(req);
    const r = await handler(req);                        // { status, json?, headers? } 또는 throw new TypeError('fetch failed')
    const h = Object.fromEntries(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: (k) => h[k.toLowerCase()] ?? null },
             json: async () => r.json, text: async () => (r.json === undefined ? '' : JSON.stringify(r.json)) };
  };
  fn.calls = calls;
  return fn;
}
// 가짜 safeStorage (capture-v3.test.js:258-275 와 같은 꼴)
const fakeSafe = { isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('enc:' + Buffer.from(s).toString('base64')),
  decryptString: (b) => Buffer.from(String(b).slice(4), 'base64').toString() };
// 가짜 브라우저 — 인가 URL 을 받아 루프백으로 리디렉트를 흉내 낸다
function fakeBrowser({ code = 'c0de', state: forceState, error } = {}) {
  const seen = [];
  const open = async (url) => {
    const u = new URL(url); seen.push(u);
    const redirect = u.searchParams.get('redirect_uri');
    const qs = error ? `error=${error}&state=${u.searchParams.get('state')}` : `code=${code}&state=${forceState || u.searchParams.get('state')}`;
    setImmediate(() => http.get(`${redirect}/?${qs}`, (res) => res.resume()).on('error', () => {}));
  };
  open.seen = seen; return open;
}
// id_token 만들기 (서명은 검사하지 않으므로 아무 값)
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const idToken = (claims) => `${b64u({ alg: 'RS256' })}.${b64u(claims)}.sig`;
```

### 12.2 `test/gcal-core.test.js` (순수 코어, ~35개)
1. `normalizeEvent`: `'2026-10-12T10:00:00+09:00'`을 `'2026-10-12T01:00:00.000Z'`로 바꾸고, `tz`를 보존한다.
2. 종일 일정은 `startDate`/`endDate`(배타)를 갖고, `start`는 `D.parseYmd(startDate)`의 ISO이며, `busy:false`다.
3. `transparency:'transparent'` → `busy:false`. 내가 거절한 일정, `workingLocation`, `birthday` → `null`.
4. `tentative`/`needsAction`은 바쁨이고 `tentative:true`로 투영된다.
5. id와 status만 있는 취소 항목은 묘비가 된다.
6. `pullRequest`: 커서가 없으면 창(`timeMin`/`timeMax`)을 보내고, 있으면 `syncToken`만 보낸다. `orderBy`는 어느 쪽에도 없다.
7. `needsFullSync`: 창이 7일 밀렸을 때, `fullSyncAt`이 7일 지났을 때 참이다.
8. 전체 `planPull`: 응답에 없는 그 캘린더의 일정만 지우고, 다른 캘린더는 그대로 둔다.
9. 증분 upsert: `updated`가 더 새로우면 바꾸고, 오래된 응답이면 건너뛴다(`skippedStale`).
10. 반복 인스턴스 묘비는 그 인스턴스만 지운다. id가 시리즈 id인 묘비는 모든 인스턴스를 지운다.
11. 반복 인스턴스가 바뀌면 `refetchSeries`에 시리즈가 들어가고, `applySeries`가 창 안의 인스턴스를 통째로 바꾼다.
12. 증분 결과 중 창 밖 항목은 넣지 않는다. 같은 키가 있으면 지운다.
13. `resetCalendar`(410) 뒤에는 `pullRequest`가 전체 동기화 요청을 만든다.
14. `prune`은 창 시작보다 먼저 끝난 일정과 30일 지난 링크를 정리한다.
15. `M.conflictsFor`는 바쁜 Google 일정을 포함하고, 종일·한가함 일정은 뺀다. `{blocksOnly:true}`이면 예전과 같다.
16. `M.calendarItems`는 삭제된 할 일의 블록을 빼고, Google 일정을 시작 순으로 합친다.
17. `R.calendarContext`: Google 회의 중이면 `busyWith`가 그 회의다. 다음 Google 회의까지 30분이면 `recommend`의 T가 30이다(`source:'calendar'`, `until:'next'`).
18. 종일 '연차' 일정만 있으면 T는 기존 규칙과 같다(종일은 바쁨이 아님).
19. `eventIdFor`: base32hex 문자만 쓰고, 길이가 5~1024자이며, 같은 입력이면 같다. `gen`이 다르면 다르다.
20. `exportable`: 샘플, `timeUncertain`, 삭제된 할 일의 작업, 24시간 전에 끝난 블록은 제외한다. `exportWork:false`이면 작업 블록을 뺀다.
21. `eventBody`: `exportTitles:false`이면 제목이 '바쁨'/'집중 작업'이다. `extendedProperties.private.daynoteId`를 넣는다. 밀리초만 다른 시각은 같은 해시가 된다.
22. `remoteHash(Google 원본)`이 `eventBody(같은 블록).hash`와 같다. `+09:00`과 `Z` 표기 차이도 같게 본다.
23. `reconcile`: 새 블록은 insert, 바뀐 블록은 patch, 지운 블록은 delete, 그대로이면 op 없음. 두 번 불러도 결과가 같다.
24. 합치기: insert 대기 중에 블록을 지우면 항목이 사라진다. patch 대기 중에 지우면 delete로 바뀌고 `nextAt`이 유지된다.
25. **undo 시나리오:** 블록 추가 → insert 성공(링크) → `store` 되돌리기로 블록이 사라지고 `gcal`은 유지 → reconcile이 delete를 낸다.
26. `applyPushResults` insert: 링크의 `hash`는 **보낸 본문의 해시**다. 보낸 뒤 블록이 또 바뀌면 다음 reconcile이 patch를 낸다.
27. 409 adopted면 링크를 맺는다. `id_taken`이면 `gens+1`이 되고 다음 `dueOps`의 eventId가 다르다.
28. patch에 404/410이면 링크를 지우고 `gen+1`을 한 뒤 insert한다.
29. `rate_limit`이면 `backoffUntil`이 설정되고, 같은 회차의 `dueOps`는 빈 배열이다. `network` 오류에서는 `attempts`와 `nextAt`이 늘어난다. `backoffMs`는 지터 범위와 30분 상한을 지킨다. 8회가 넘어도 항목은 남는다.
30. `planOwnPull` 충돌 표의 9칸을 각각 확인한다(§7.4).
31. 내가 쓴 것이 돌아오면(etag 같음) 변화가 없다.
32. 다른 기기 표식이 있는 항목은 `events`에 `origin:'daynote_other'`, `busy`로 거울이 생긴다.
33. 링크를 잃은 상태(백업 복원)에서는 `daynoteId`로 링크를 다시 맺고, 내용이 다르면 patch가 나간다.
34. 지운 것 반영(`applyRemoteDeletes`) 뒤 store를 되돌리면 블록이 돌아오고, reconcile이 새 gen으로 insert를 낸다.
35. `resetForAccount`는 계정이 바뀌면 조각을 비우고 `settings`는 유지한다. `mergeCalendarList`는 처음에 primary만 고르고, 선택을 보존하고, 사라진 캘린더의 일정을 지우고, `isExport`를 표시한다.

### 12.3 `test/google-auth.test.js` (서비스, 가짜 fetch, 가짜 safeStorage, 임시 폴더, 실제 루프백)
1. `buildAuthUrl`에 모든 매개변수가 있다: `client_id`, `redirect_uri=http://127.0.0.1:<port>`, `response_type=code`, 범위 6개, `code_challenge`, `S256`, `state`, `nonce`, `access_type=offline`, `prompt`, `include_granted_scopes=true`.
2. `makePkce`: `challenge === base64url(sha256(verifier))`이고, verifier는 43~128자의 `[A-Za-z0-9-._~]`다.
3. 클라이언트가 없으면 `status().state === 'needs_setup'`이고 `signIn`은 `not_configured`다.
4. `parseClientInput`: installed JSON은 통과, web JSON은 거부, ID 형식 오류는 거부, 공백과 따옴표는 지운다.
5. **전체 로그인:** `fakeBrowser`로 루프백을 흉내 내면, 토큰 요청 본문에 `code`, `code_verifier`, 같은 `redirect_uri`, `grant_type=authorization_code`, `client_secret`이 있다. 결과는 `signed_in`, email, name이고 `onStatus`가 `connecting → signed_in` 순서로 불리며 `onFocusApp`이 한 번 불린다.
6. state가 틀리면 400을 받고 계속 기다리다가, 맞는 state가 오면 끝난다.
7. `error=access_denied`이면 `denied`로 끝나고 상태는 `signed_out`이다.
8. 시간 제한(`timeoutMs: 50`)이 지나면 `timeout`으로 끝나고, 그 포트로 연결하면 거부된다(서버가 닫힘).
9. `cancelSignIn()`을 부르면 `canceled`다.
10. 응답 `scope`에서 `calendar.events.readonly`가 빠지면 `scopes.eventsRead === false`다.
11. 토큰 파일을 날것으로 읽은 바이트에 refresh token 문자열이 없다. fakeSafe로 풀면 있다. access token은 파일에 없다.
12. `getAccessToken`은 만료 60초 전이면 갱신한다. 동시에 2번 불러도 토큰 요청은 1번이다.
13. 갱신이 `invalid_grant`이면 `reauth`가 되고 `refreshToken`은 지워지며 email은 남는다. 다음 `signIn`의 `login_hint`가 그 email이다.
14. 갱신 응답에 새 `refresh_token`이 있으면 파일이 바뀐다.
15. `signOut`은 파일을 지우고 revoke를 POST한다(`token=<refresh>`, form). revoke가 네트워크 오류여도 `signed_out`이고 `revoked:false`다.
16. id_token의 `aud`, `iss`, `exp`, `nonce` 중 하나라도 틀리면 `bad_id_token`이다.
17. `redact`는 `ya29.`, `1//`, `GOCSPX-`, JWT, `code=`를 가린다. 실패 결과의 `JSON.stringify`에 토큰 조각이 없다.
18. 토큰 요청 400 `invalid_request` + "client_secret is missing"이면 `needs_secret`이다.
19. 클라이언트 ID를 바꾸면 기존 토큰 파일을 무효로 보고 `signed_out`이 된다.
20. `captureEnvClient`: `DAYNOTE_` 접두사가 우선이고, 읽은 키는 `process.env`에서 지워지며, 출처가 `dotenv`인지 구분된다(`withEnv` 헬퍼 복사).
21. **통합 1건:** 가짜 Google HTTP 서버(`http.createServer`, 127.0.0.1:0)를 `endpoints.token`/`revoke`로 지정하고 실제 전역 fetch를 쓴다. `Content-Type: application/x-www-form-urlencoded`와 인코딩을 확인한다.

### 12.4 `test/gcal-service.test.js` (가짜 auth `{getAccessToken, exportCalendarId}`, 가짜 fetch, `sleep` 기록)
1. 전체 `listEvents` 쿼리: `singleEvents=true`, `maxResults=250`, `timeMin`, `timeMax`, `fields`가 있고 `orderBy`는 없다. 2페이지를 이어 받고, 마지막 페이지의 `nextSyncToken`을 돌려준다.
2. 증분은 `syncToken`만 보내고 `timeMin`이 없다.
3. 410이면 `sync_token_gone`이다. `maxPages`를 넘으면 `too_many_changes`다.
4. 429와 `Retry-After: 2`이면 `sleep(2000)` 뒤에 성공한다. `retries`를 넘으면 `rate_limit`이고 `retryAfterMs`가 있다.
5. `403 userRateLimitExceeded`는 다시 시도한다. `403 insufficientPermissions`는 `needs_scope`이고 다시 시도하지 않는다. `403 quotaExceeded`는 `quota`이고 `retryAfterMs`가 1시간이다.
6. 401이면 `forceRefresh`를 한 번 하고 성공한다. 연속 401이면 `auth`다.
7. `TypeError('fetch failed')`이면 `network`이고 `retryable`이다. AbortController 시간 제한이면 `timeout`이다.
8. push insert: `POST …/events?sendUpdates=none`, 본문에 `id`가 있고, 모르는 키는 `sanitizeBody`로 지워진다.
9. push 409 → GET → 같은 `daynoteId`의 살아 있는 이벤트면 `adopted:true`, 취소된 이벤트면 `id_taken`이다.
10. push delete가 204, 410, 404이면 모두 `ok:true`다. patch가 404이면 `gone`이다.
11. 다른 `calendarId`로 push하면 요청 없이 `write_denied`다.
12. `ensureExportCalendar`: `preferId`가 있으면 확인해서 쓰고, 표식이 있는 캘린더가 있으면 다시 쓰고, 없으면 `POST /calendars` 뒤 `setExportCalendarId`를 부른다.
13. `listCalendars`는 페이지를 이어 받는다. 캘린더 경로가 404이면 `calendar_missing`이다.

### 12.5 기존 테스트에 추가
- `test/store.test.js`: 라벨 있는 mutate 뒤에 `gcal.links`를 바꾸고 undo해도 `gcal`은 지금 값이고 데이터는 되돌아간다. 브라우저 host의 `google.status()`는 `available:false`다(vm 컨텍스트, 지연 평가).
- `test/model.test.js`: `normalize({version:3, …})`가 `gcal` 기본값을 채우고 `settings` 안쪽을 병합한다. `SCHEMA_VERSION === 4`.
- `test/recommend.test.js`는 그대로 18개가 통과한다(회귀 확인).

### 12.6 화면 확인 (자동 단위 테스트 밖)
- **Playwright + `serve.js`**(tests map §10 방법):
  - 1) 기본 브라우저 host에서 설정 카드가 '데스크톱 앱에서만'이고 콘솔 오류가 0이다.
  - 2) `addInitScript`로 가짜 `window.daynoteHost`를 만든다. load와 save는 localStorage를 쓰고, `google.status`와 `gcal.*`은 정해 둔 응답을 돌려준다. 이 상태에서 확인한다: `signed_in` 카드, 캘린더 목록, 동기화 뒤 캘린더 주간 화면의 `.cal-block.ext`와 `.cal-allday-item`, 오늘 일정의 `.is-ext`, Google 회의 중 '다음 할 일' 근거 문구. `timezoneId:'Asia/Seoul'`, `__daynoteNow`를 고정한다. 390px 폭에서 가로 스크롤이 없어야 한다.
- **Electron 실제 확인**(개발자 PC): 테스트 모드 프로젝트로 로그인, Google에서 일정 이동, Daynote에서 블록 이동·삭제, 오프라인 상태에서 편집한 뒤 재연결, 7일 만료 재현(Google 계정에서 권한 해제하면 바로 `invalid_grant`가 된다).

---

## 13. 구현 순서와 병렬 분담

계약(§6, §8)은 이 문서로 고정한다. 각 트랙은 가짜 상대편으로 테스트하며 동시에 진행한다.

| 트랙 | 파일 | 먼저 필요한 것 | 완료 기준 |
|---|---|---|---|
| **A 코어** | `src/core/gcal.js`(새), `src/core/model.js`, `src/core/recommend.js`, `src/core/ai/assist.js`(workHours), `test/gcal-core.test.js`, `test/model.test.js` 추가 | 없음 | §12.2·§12.5 통과, 기존 123개 통과 |
| **B 인증** | `services/keystore.js`(createSecretStore, loadDotEnv out), `services/google-auth.js`(새), `test/google-auth.test.js` | 없음 | §12.3 통과, 기존 keystore 테스트 통과 |
| **C REST** | `services/gcal.js`(새), `test/gcal-service.test.js` | B의 인터페이스(가짜로 대체 가능) | §12.4 통과 |
| **D 배선** | `main.js`, `preload.js`, `renderer/store.js`(스텁, undo), `test/store.test.js` 추가, `renderer/index.html` 태그 2개 | B·C의 `create` 시그니처 | 스모크가 통과한다(Electron이 설치된 곳에서). 브라우저 `serve.js`의 콘솔 오류 0 |
| **E 화면** | `renderer/gcalsync.js`(새), `views/settings.js`, `views/calendar.js`, `views/today.js`, `views/schedule.js`, `palette.js`, `styles.css` | A의 API, D의 host 표면(가짜 host로 시작 가능) | §12.6의 Playwright 확인 |
| **F 문서** | `README.md`(§14 붙여 넣기, "미구현" 표에서 외부 캘린더 줄 수정, 테스트 목록 갱신) | – | – |

권장 병합 순서는 **A → B → C → D → E → F**다. A·B·C는 서로 의존하지 않는다. E는 A가 병합된 뒤 가짜 host로 먼저 만들 수 있다.

---

## 14. README 설정 안내 (그대로 붙여 넣을 텍스트)

````markdown
### Google 캘린더 연결 (처음 한 번, 10분쯤)

Daynote는 Google 캘린더의 일정을 가져와 캘린더 화면과 ‘다음 할 일’ 추천에 바쁜 시간으로 쓰고,
Daynote에서 만든 일정·작업 시간을 Google 캘린더의 **‘Daynote’ 캘린더**에 올립니다.
아직 Google 앱 확인을 받기 전이라, 연결하려면 본인 Google Cloud 프로젝트에서 OAuth 클라이언트를 한 번 만들어야 합니다.

1. **프로젝트 만들기** — https://console.cloud.google.com 에 로그인 → 위쪽 프로젝트 선택 → **새 프로젝트** → 이름 `Daynote` → 만들기.
2. **Calendar API 켜기** — 왼쪽 메뉴 **API 및 서비스 → 라이브러리** → `Google Calendar API` 검색 → **사용**.
3. **동의 화면(Google 인증 플랫폼)** — 왼쪽 메뉴 **Google 인증 플랫폼**(예전 이름: OAuth 동의 화면) → **시작하기**
   - 앱 정보: 앱 이름 `Daynote`, 사용자 지원 이메일 = 내 주소
   - **대상: 외부(External)** → 연락처 이메일 → 정책 동의 → 만들기
   - 게시 상태는 **테스트(Testing)** 그대로 둡니다.
4. **테스트 사용자 추가** — **대상(Audience)** → **테스트 사용자 → 사용자 추가** → Daynote에 연결할 Gmail 주소 입력 → 저장.
   (여기에 없는 계정으로 로그인하면 “액세스 차단됨/access_denied”가 뜹니다.)
5. **범위 추가(권장)** — **데이터 액세스** → **범위 추가 또는 삭제** → 아래 세 개를 찾아 체크 → 업데이트 → 저장
   - `.../auth/calendar.calendarlist.readonly` (캘린더 목록 보기)
   - `.../auth/calendar.events.readonly` (일정 보기)
   - `.../auth/calendar.app.created` (Daynote가 만든 캘린더만 만들고 고치기)
6. **OAuth 클라이언트 만들기** — **클라이언트 → 클라이언트 만들기**
   - 애플리케이션 유형: **데스크톱 앱** (웹 애플리케이션이 아닙니다)
   - 이름: `Daynote 데스크톱` → 만들기
   - 뜨는 창에서 **클라이언트 ID**와 **클라이언트 보안 비밀번호**를 복사하거나 **JSON 다운로드**를 누릅니다.
     보안 비밀번호는 **만들 때 한 번만** 보입니다. 놓쳤다면 그 클라이언트에서 새 보안 비밀번호를 추가하세요.
7. **Daynote에 붙여 넣기** — Daynote → **설정 → 캘린더**(‘준비 필요’) → 클라이언트 ID·보안 비밀번호를 붙여 넣거나
   **JSON 내용으로 붙여 넣기**에 내려받은 파일 내용을 통째로 붙여 넣고 **저장** → **Google 계정으로 연결**.
8. 브라우저가 열리면 4번에 넣은 계정을 고릅니다. “Google에서 확인하지 않은 앱” 화면이 나오면 본인이 만든 앱이므로
   **고급 → Daynote(으)로 이동**을 누르고, 권한 화면에서 **모든 항목에 체크**한 뒤 계속합니다.
   “Daynote에 연결했어요” 탭이 보이면 닫고 Daynote로 돌아가면 됩니다.

알아 둘 점
- 클라이언트 보안 비밀번호는 설치형 앱 특성상 완전한 비밀이 아니지만, Daynote는 이 컴퓨터에 암호화해 두고 화면·백업·로그에 내보내지 않습니다. GitHub 등에 올리지 마세요.
- **테스트 모드 앱은 Google 정책상 7일마다 다시 로그인해야 합니다.** 설정에 ‘다시 로그인이 필요해요’가 보이면 **다시 연결**을 누르세요.
  (개인용으로 **앱 게시 → 프로덕션**으로 바꾸면 7일 만료는 없어지지만, ‘확인되지 않은 앱’ 경고는 계속 보입니다.)
- 로그인 정보(refresh token)는 Windows 보안 저장소(DPAPI)로 암호화해 `%APPDATA%\daynote\google-token.bin`에 둡니다. 데이터 파일·백업에는 들어가지 않습니다.
- 연결 해제는 설정 → 캘린더 → **연결 해제**. 이 컴퓨터의 로그인 정보를 지우고 Google에도 권한 해제를 요청합니다. Google 쪽은 https://myaccount.google.com/connections 에서도 확인·해제할 수 있습니다.
- Google 캘린더의 ‘Daynote’ 캘린더를 지우면 Daynote가 올린 일정도 함께 지워집니다. Daynote의 일정은 그대로입니다.

개발용 설정 (설정 화면 대신)
```
# 앱 폴더 .env (git 에 올리지 않음) 또는 환경변수 — 설정에 저장한 값이 있으면 그쪽이 우선
GOOGLE_CLIENT_ID=1234567890-abcdefg.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
```
(`DAYNOTE_GOOGLE_CLIENT_ID` / `DAYNOTE_GOOGLE_CLIENT_SECRET` 도 읽고, 있으면 그쪽이 먼저입니다. `GOOGLE_API_KEY` 는 Gemini 키 이름이라 쓰지 않습니다.)
````

README 표 "실제 동작 / 시연 / 미구현"도 고친다. '미구현'에서 "외부 캘린더 동기화"를 빼고 "Outlook 캘린더, Google 원본 일정 편집"을 넣는다. '실제 동작'에 "Google 캘린더 가져오기·‘Daynote’ 캘린더로 올리기(데스크톱)"를 더한다.

---

## 15. 남은 위험과 추후 과제
- **확인 받은 공용 클라이언트:** Daynote 이름으로 브랜드·민감 범위 확인을 받으면 기본 클라이언트 ID를 앱에 넣는다. BYO는 '고급'으로 옮긴다. 그 전까지 일반 사용자에게는 설정 장벽이 높다(문서와 JSON 붙여 넣기로 줄인다).
- **동료에게 바쁨 보이기:** 옵션 "작업 시간을 기본 캘린더에 ‘바쁨’으로도 올리기"를 고려한다. 범위 `calendar.events.owned`를 `include_granted_scopes`로 점진적으로 추가하는 방식이다.
- **AI 중복 판단:** `validate.findDupEvent`가 Google 일정도 보게 하면 "내일 3시 팀 회의" 캡처가 Google의 같은 회의와 겹치는 것을 막을 수 있다. 이때 `duplicateOf`가 블록이 아닌 id를 가리키므로 `resolveRef`와 검토 화면을 함께 손봐야 한다.
- **푸시 알림:** 데스크톱에는 수신 주소가 없다. 계속 10분 폴링과 포커스·온라인 시점에 동기화한다.
- **반복 시리즈 대량 변경:** 증분 결과에서 반복 시리즈 대량 변경은 `maxPages` 가드와 시리즈 다시 받기로 막는다. 극단적인 경우 전체 동기화로 돌아간다.
- **테스트 모드 7일 만료:** 상태 `reauth`로 드러내고 다시 연결을 버튼 하나로 끝낸다. 앱을 게시하면 사라진다.
- **기존 버그(이번 범위에 같이 처리 권장):** `calendar.placeBlocks`가 `__lane`을 상태 객체에 저장한다. 투영 객체를 쓰면 이 문제를 피할 수 있다.
- **여러 기기·백업 복원:** 소유 판정(§7.4)과 이벤트 id 멱등성으로 중복과 고아를 막는다. 다만 두 기기가 같은 블록을 동시에 고치면 마지막으로 보낸 쪽이 이긴다(Daynote끼리의 충돌).

---

## 부록 A. 오류 type → 화면 문구

| type | 문구 (`-어요`) | 다음 행동 버튼 |
|---|---|---|
| `unavailable` | Google 캘린더 연결은 데스크톱 앱에서만 쓸 수 있어요. | – |
| `not_configured` | 먼저 Google Cloud에서 만든 클라이언트를 붙여 넣어 주세요. | 설정 방법 보기 |
| `invalid_client_input` | 클라이언트 ID 형식이 맞지 않아요. ‘…apps.googleusercontent.com’으로 끝나는 값을 붙여 넣어 주세요. / 웹 애플리케이션 유형의 클라이언트예요. ‘데스크톱 앱’ 유형으로 새로 만들어 주세요. | – |
| `needs_secret` | 이 클라이언트는 보안 비밀번호가 필요해요. 콘솔에서 복사한 보안 비밀번호를 함께 붙여 넣어 주세요. | 클라이언트 바꾸기 |
| `invalid_client` | 클라이언트 ID나 보안 비밀번호가 맞지 않아요. 다시 확인해 주세요. | 클라이언트 바꾸기 |
| `denied` | 권한 허용이 취소됐어요. 테스트 사용자로 추가한 계정인지 확인해 주세요. | 다시 연결 |
| `timeout` | 5분 안에 로그인이 끝나지 않아 연결을 멈췄어요. | 다시 연결 |
| `canceled` | (표시 안 함) | – |
| `listen_failed` | 로그인 창을 받을 준비를 하지 못했어요. 잠시 뒤 다시 시도해 주세요. | 다시 시도 |
| `reauth` / `invalid_grant` | Google 로그인이 만료됐어요. 다시 연결해 주세요. | 다시 연결 |
| `needs_scope` | 캘린더 권한이 허용되지 않았어요. 다시 연결할 때 모든 항목에 체크해 주세요. | 다시 연결 |
| `network` / `timeout`(요청) | 인터넷에 연결되지 않아 동기화를 미뤘어요. 연결되면 다시 할게요. | 지금 동기화 |
| `rate_limit` | Google이 잠시 요청을 막았어요. N분 뒤 다시 할게요. | – |
| `quota` | 오늘 쓸 수 있는 Google 요청량을 다 썼어요. 잠시 뒤 다시 할게요. | – |
| `server` | Google 서버 문제로 동기화하지 못했어요. 잠시 뒤 다시 할게요. | 지금 동기화 |
| `calendar_missing` | Google에서 ‘Daynote’ 캘린더를 찾을 수 없어요. | 다시 만들기 · 올리기 끄기 |
| `write_denied` | ‘Daynote’ 캘린더에 쓸 권한이 없어요. 다시 연결해 주세요. | 다시 연결 |
| `bad_request` (op) | 일정 1개는 Google이 받지 않았어요. 시간을 확인해 주세요. | – |
| `unknown` | 알 수 없는 오류로 동기화하지 못했어요. | 지금 동기화 |
