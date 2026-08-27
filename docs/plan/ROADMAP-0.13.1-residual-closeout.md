# ROADMAP — 0.13.1 「잔여 종결」 배치

생성: 2026-08-26 · 상태: **구현 완료(2026-08-26) — 발행 대기**
갱신: 2026-08-26 · SubTask 계획 = `docs/plan/PLAN-0.13.1-residual-closeout.md`(전량 `[S]` 인라인 순차) · 검증 `bash verify.sh` **1236/1236**
목적: **1.0.0(A4)을 제외한 전 항목을 종결**한다. 0.13.0 발행(2026-08-22) 시점에 메모리 전반에 흩어져 있던 잔여·백로그·설계미결·신규후속을 한 배치로 모은다.

> **이 배치의 성격**: 신규 기능 0건. 전부 ⓐ가드/상한 ⓑ위생 ⓒ문구 ⓓ실측 ⓔ결정문이다.
> **판정 입력(judge에 실리는 것)은 이 배치에서 바꾸지 않는다** — 바꾸면 0.13.0 P4의 효과를 사후 귀속할 수 없다(교란분리 원칙, `project_gate_false_positive_rca` §Why). 판정 의미론을 건드리는 3건은 **결정문만** 여기서 쓰고 구현은 0.14.0으로 라우팅한다.

---

## 종결 후 남는 것 (이 배치의 성공 정의)

| 남는 것 | 조건 |
|---|---|
| **1.0.0 (A4)** | 하드닝+CI 결정+README 현행화+출시 — 원래부터 별도 마일스톤 |
| **0.14.0 (조건부)** | 아래 D-1·D-2·D-3의 결정 결과가 "변경한다"일 때만 생성. "현행 유지"면 그대로 소멸 |

그 외 모든 열린 항목은 이 배치에서 닫힌다.

---

## R — 코드 하드닝 (3건, 전부 판정 무관)

- **R-1** ✅**DONE** `[TDD]` **`readPendingReview`의 형상가드** → `src/review.ts`(`isStringArray` 기반) · 회귀락 `test/unit.test.mjs` 12건
  - **발행 전 `security-auditor`가 이 가드 자체에서 Critical을 잡아 범위가 커졌다**(그래서 이 감사가 값을 한다): 최초 구현은 컨테이너 레벨(`Array.isArray`)만 봐서 **"배열이지만 원소가 문자열이 아닌"** 손상이 그대로 통과했다. 실증: `isAnnouncedRepeat(['케이스 A 구현'], ['케이스 A 구현', 42])` → `TypeError: item.trim is not a function`(`text.ts normalizeCase`).
  - **왜 Critical인가**: 그 예외를 `runHookSafely`가 fail-open(allow)으로 흡수해 **편집이 무검사 통과**한다. 게다가 **자가치유가 안 된다** — 손상 레코드를 덮어쓸 `effects.pendingReview` 기록(`gate-core.ts:635`)이 크래시 지점(`:633`)보다 뒤라, 같은 작업단위(specHash 불변) 내내 모든 재차단이 같은 방식으로 샌다. `gbc done`/`gate reset --hard`로 해시가 바뀌어야 해소된다.
  - **감사 지적보다 범위가 넓었다**: `gate-core.ts:628` `sameMissingSet(prior.missing, …)`도 `normalizeCase`를 타므로 **`missing` 원소 손상도 같은 경로로 샌다** — 0.6.1 R3 가드가 컨테이너 레벨만 봤던 원래 사각지대다. 두 필드를 함께 막았다.
  - **두 필드의 처리가 갈리는 이유**: `seen`은 **필드만 strip**(missing 폴백으로 Tier1 생존), `missing`은 **레코드째 폐기**(Tier1 `sameMissingSet`·`cmdGateReview`의 필수 필드라 strip이 불가능하고, 손상된 채 살리면 크래시 경로가 남는다). 폐기는 게이트를 약화시키지 않는다 — 펜딩 이력이 사라지면 block-repeat 강등이 발동하지 않아 **hard block으로만 편향**된다(안전한 방향).
  → `src/review.ts`
  - 출처: 0.13.0 발행 직전 `security-auditor` Warning.
  - `missing`은 배열 검사를 하는데 신규 필드 `seen`은 안 한다. 손상된 `.gbc/pending-review.json`에서 `mergeAnnounced`의 스프레드·`isAnnouncedRepeat`의 `flatMap`이 `TypeError`.
  - 실제 영향은 `runHookSafely` fail-open 경계 안이라 **가시적 통과**(조용한 우회 아님) — 그래서 Critical이 아니다.
  - 기존 `missing` 가드와 **동일 패턴 1줄**. `seen`이 존재하는데 배열이 아니면 필드를 버린다(레코드 전체를 버리지 않는다 — `missing`이 살아있으면 Tier1은 계속 동작해야 한다).
  - 테스트: 손상 형상(문자열·숫자·객체·null) 4종에서 크래시 없이 Tier1이 살아있는지.
  - 계보: [[feedback_regression_input_shape_contract]]가 말한 형상계약의 같은 계열(F-13/0.12.0, F-1/0.12.3에 이은 3회째).

- **R-2** ✅**DONE** `[TDD]` **`gbc done`이 `pendingReview`를 지우게 한다** → **신규 `src/work-unit.ts` `closeWorkUnit()`**(archive→reset→clearApplied→clearPendingReview를 한 함수로 묶어 계약을 코드로 고정) · `cli.ts cmdDone`이 소비. `logCli`는 여전히 archive 이전 캡처한 `beforeHash`만 쓰므로 `done` 이벤트 내용 불변(순서 변경 무해 — `logEvent`는 전달인자만 직렬화)
  → `src/cli.ts`(done 경로)
  - 출처: 0.13.0 발행 직후 도그푸딩 실측(2026-08-22). `gbc done` 실행 후에도 **2026-08-13자 펜딩 레코드가 파일에 잔존**했다.
  - `clearPendingReview`는 `cli.ts:576`(`gate reset --hard`)과 `cli.ts:799`(spec-add 배치)에서만 호출되고 **done 경로에 없다**.
  - **판정 오염은 불가능** — Tier1·Tier2 둘 다 `prior?.specHash === specHash`로 스코프된다(`gate-core.ts:628-633`). 새 작업단위는 해시가 달라 무시된다. 즉 보안결함이 아니라 **위생 불일치**다.
  - 그럼에도 고치는 이유 2가지: ①`reset --hard`는 지우는데 `done`은 안 지우는 비대칭이 다음 감사자를 또 헷갈리게 한다 ②**M-1(appliedStale 관측)의 선행조건** — 옛 펜딩이 남아있으면 도그푸딩 관측이 오염된 상태에서 시작한다.
  - 테스트: `done` 후 `pending-review.json` 부재 확인(`reset --hard` 기존 테스트와 대칭).

- **R-3** ✅**종결(이미 반영 — 코드 SubTask 없음)** **`Static` 스크롤백 상한(cap)**
  → `src/tui/app.tsx`
  - 출처: 0.9.2 백로그. 마크다운 배선으로 턴당 엔트리 수가 늘었는데 상한 로직이 없어 장시간 세션에서 메모리가 가속 성장.
  - **로드맵 작성 시 전제가 틀렸다(코드 실증으로 정정)**: `Static` 자체가 0.10.1에 완전 폐기됐고(`src/tui/ui/ChatBox.tsx:1-4`), 상한은 이미 있다 — `src/tui/format.ts` `CHAT_SCROLLBACK_MAX_ENTRIES=500` + `src/tui/scrollback.ts:26-30`이 repo별로 오래된 것부터 폐기(로드맵이 요구한 `MAX_ANNOUNCED_SEEN` 관례 그대로).
  - 따라서 ink 재렌더 함정도 성립하지 않는다(Static 없음). **표기만 종결**, 구현 없음.

## T — TUI 백로그 (4건, 발행 비차단)

- **T-1** ✅**DONE** **키맵 안내 소스 이원화 해소**
  → `src/tui/ui/HelpPanel.tsx` · `src/tui/format.ts`(`formatWelcomeCard`)
  - 출처: 0.11.2 잔여. 두 곳이 키맵을 **각자 하드코딩**한 것이 0.11.2 Alt+F 누락의 근본원인. 현재 방어는 "카드가 HelpPanel 주요 토글키를 전부 싣는가" 테스트뿐(사후 검출이지 구조적 차단이 아님).
  - ⚠️ **로드맵이 지시한 방향은 ESM 순환이라 반전했다**: `HelpPanel.tsx:6`이 이미 `../format.js`를 import하는 쪽이라, `format.ts`가 `HelpPanel`의 `SHORTCUT_ROWS`를 참조하면 순환이 된다. **레지스트리를 `format.ts`(Ink-free)로 이전하고 HelpPanel이 소비**하는 방향으로 뒤집었다 — `src/tui/format.ts` `SHORTCUT_REGISTRY`(단일 소스) → `SHORTCUT_ROWS`(HelpPanel 전량) + `buildCardKeymapRows()`(카드 요약).
  - **구조적 차단 장치**: 엔트리의 `card` 필드를 **필수 nullable**(`{order,label} | null`)로 뒀다. 선택 필드면 신규 키 추가 시 카드 노출 결정을 깜빡해도 컴파일이 통과한다 — 0.11.2 Alt+F 누락을 사후검출 테스트가 아니라 타입으로 막는다.
  - ⚠️ 제약(준수 확인): `cardRows`가 `computeResponsiveLayout` 강등 사다리의 **입력**이라 행 수를 늘리면 저높이 터미널의 강등 임계가 밀린다(0.11.2 Why) — 키맵 5행·순서·문구 모두 이전과 **바이트 동일**함을 tmux 실렌더로 대조 확인(아래 §검증 요구).

- **T-2** ✅**DONE** **`lastTurnMs` 의미 정정**
  → `src/tui/` 상태모델
  - 출처: 0.9.2 백로그. 승인 대기시간이 포함돼 있고 정상/중단/오류 3경로 구분이 없어 오독 여지.
  - 승인 대기 구간 제외: `src/tui/model.ts` `computeTurnMs({startedAt,endedAt,approvalWaitMs})`(순수·음수 클램프) + `app.tsx`가 `makeInkCanUseTool` 클로저에서 repoId별로 대기시간을 누적(`drainApprovals`가 resolve하는 경로도 **같은 클로저**를 통과하므로 세션 사망·강제 deny drain도 계상된다). 제출은 repoId별로 직렬화(`runTurnThenDrain`)라 턴 시작 리셋이 진행중 턴을 지울 수 없다.
  - 3경로 구분: `Statusline.lastTurnOutcome: "ok"|"aborted"|"error"` — 판정은 기존 `formatEngineAbort`/`formatEngineFailure` 분기 재사용. 표기는 **기존 세그먼트에 접미**(`"12.3s 중단"`), 신규 세그먼트 금지 — 토큰 세그먼트가 "맨 끝=가장 먼저 잘리는 자리"로 고정돼 있어 세그먼트 수가 늘면 좁은 폭 클램프 순서가 바뀐다(`test/tui-format.test.mjs` 불변식 2건으로 잠금).

- **T-3** ✅**DONE** **크래시 덤프 redaction 비대칭**
  → 크래시 덤프 기록 경로
  - 출처: 0.10.0 security Info. extraction은 `redactSecrets` 8패턴군을 타는데 크래시 덤프는 평문 보존.
  - 실측 확인: 현재 `.gbc/crash-dump.txt`에 시크릿은 없으나(2026-08-13자, spawn ENOENT 스택) 구조적으로 열려 있다.
  - 수정: `src/tui/bridge.ts formatCrashDump`가 기존 `redactSecrets`(extraction.ts 8패턴군, **신규 패턴 추가 없음**)를 탄다. **엔트리별이 아니라 join 후 본문 전체에 1회, 절단보다 먼저** — PEM 블록 패턴은 여러 줄(=여러 스크롤백 엔트리)에 걸쳐 매치되므로 엔트리별 적용은 경계에 걸친 PEM을 놓친다(`formatBangOutput` 선례 규율). 회귀락 4건(단일행 키 3종·엔트리 걸친 PEM·헤더 형식 불변·멱등성).

- **T-4** ✅**종결 — 「현행 유지」결정** **win32 `shell:true` homedir 공백 가정**
  - **결정: 현행 유지(코드 변경 없음).** 근거 3가지: ①출처 자체가 0.10.0 security **Info**("기존 관례 연장")로 Critical·Warning이 아니다 ②**실측 재현 0건** — 0.9.3 사외 Windows 현장보고(`project_field_report_eperm_0_9_3`)를 포함해 이 저장소가 관측한 win32 실패는 전부 EPERM(번들 `claude.exe` 차단)이고 공백 homedir 기인 실패는 한 건도 없다 ③`shell:true` 제거는 win32 spawn 경로 전체를 건드리는 변경이라, 재현 케이스 없이 손대면 0.2.3 W3에서 이미 겪은 "환경 탓을 코드 탓으로 오인" 왕복을 되풀이한다.
  - **재개 조건(이걸 만족하기 전엔 재제안 금지)**: 공백이 포함된 homedir(예: `C:\Users\Hong Gil Dong`)에서 gbc의 win32 spawn이 **실제로 실패한 실측 로그**가 나올 것. 그때는 `shell:true` 제거 + 인자 배열 전달로 전환한다(우회가 아니라 근본 수정 경로가 이미 특정돼 있다).

## Doc — 문구 (1건)

- **Doc-1** ✅**DONE(재범위)** **EPERM 안내에 PowerShell 예시 병기**
  → ~~`src/startup-diagnostics.ts`~~ → **`README.md`**
  - ⚠️ **로드맵 전제가 틀렸다(코드 실증으로 정정)**: 코드 안내는 **0.12.0 ST13에서 이미 종결**됐다 — `src/tui/startup-diagnostics.ts:86-89`에 PowerShell `$env:` 예시와 "JS 설치본은 `cli.js` 지정" 문구가 이미 있고 회귀락도 있다(`test/tui-startup-diagnostics.test.mjs:107-115`).
  - **실제 잔여는 README였다**: `README.md`의 EPERM 절이 ⓐ"회사 보안정책·보안팀" 워딩([[feedback_user_facing_copy_neutral]] 위반) ⓑ`C:\allowed\path\claude.exe`라는 **오예시**(차단 대상인 번들 exe 자체를 가리켜 실측 확인된 우회법과 정면 모순)를 담고 있었다. 둘 다 정정해 `startup-diagnostics.ts:86-89`와 정합화.
  - 출처: 0.9.3 현장보고 잔여. 현재 안내가 Unix 스타일 `GBC_CLAUDE_PATH=<경로>`라 **PowerShell 사용자가 그대로 붙여넣기 불가**.
  - 병기: `$env:GBC_CLAUDE_PATH="<cli.js 절대경로>"` + "JS 설치본은 `cli.js`를 지정" 문구.
  - ⚠️ [[feedback_user_facing_copy_neutral]] 준수 — "회사/사내" 워딩 금지, "환경" 워딩.
  - **M-2/M-3의 선행조건**: 사용자가 실측할 때 이 문구를 그대로 쓸 수 있어야 한다. **이 배치에서 가장 먼저 처리한다.**

## M — 실측 (4건) ⚠️ 실행 주체가 갈린다

### M-1 ✅**DONE — `appliedStale:1` 관측 성공(2026-08-26)** `appliedStale` 도그푸딩 관측
- 출처: 0.12.4 잔여 #1. CHANGELOG에 명시된 **수락기준이 "실사용에서 `appliedStale`≥1건 관측"인데 미충족**. 카운터가 0인 채면 그 Critical 수정이 *"고쳐졌으되 발동 미확인"* 상태로 1.0.0에 들어간다.
- **선행조건**: ①R-2 먼저(옛 펜딩 오염 제거) ②`.gbc/applied.json`이 현재 **비어있다**(2026-08-22 `gbc done`으로 초기화됨) → 원장이 다시 쌓여야 stale이 생길 수 있다.
- 재현 절차:
  1. `gbc spec add`로 **형제 케이스 2개 이상**인 새 작업단위를 연다.
  2. 케이스 A를 **파일 X**에 구현 → PostToolUse가 원장에 앵커를 기록.
  3. 케이스 B를 **파일 Y**에서 편집 시도 → judge에 원장(파일 X 항목)이 실린다.
  4. 파일 X에서 **A의 구현을 삭제**(앵커 전부 제거)한다.
  5. 다시 파일 Y를 편집 → `verifyAppliedEntry`가 X 엔트리를 **stale로 판정해 drop**하고 `appliedStale` 카운터가 증가해야 한다.
- 관측 지점: `.gbc/events.jsonl`의 `appliedStale` 필드 · `gbc metrics`.
- **판정 기준**: `appliedStale≥1` 관측 시 종결. 관측 실패 시 그 자체가 결함 신호 → 원인 분석이 이 배치의 산출물이 된다.

**실측 결과(2026-08-26)** — 본 repo `.gbc` 오염을 피해 **스크래치 repo**에서 수행. 합성 호출이 아니라 **실제 hook 진입점**(`gbc hook post-tool-use` / `gbc hook pre-tool-use`)에 Claude Code가 보내는 것과 같은 형상의 stdin 페이로드를 먹였다([[feedback_regression_input_shape_contract]] 준수 — 프로덕션 조립 경로를 통과시켰다). 형제 케이스 2건(A=`src/x.ts` `computeAlpha` / B=`src/y.ts` `computeBeta`) 작업단위.

| 조건 | 게이트 판정 | events.jsonl 계측 |
|---|---|---|
| **통제군** — A 구현 생존(x.ts에 앵커 있음), B 편집 시도 | `pass` | `appliedCount:1` (stale 키 없음) |
| **실험군** — x.ts에서 A 구현 삭제(앵커 전멸) 후 **동일 편집** | **`block`** · `missing:["케이스A…"]` | **`appliedStale:1`** (appliedCount 키 소멸) |

즉 0.12.4의 Critical 수정은 "고쳐졌으되 발동 미확인" 상태가 아니다 — **삭제된 구현을 '이미 했음'으로 오인해 pass하던 경로가 실제로 block으로 뒤집히는 것**을 정·역 대조로 실증했다. 원장 엔트리 자체는 남는다(재검증은 읽기 시점 판정, 파괴적 정리 아님 — 설계대로).

### M-2 · M-3 · M-4 — **사용자 실기 필요(회사 Windows PC)**
> ⚠️ 이 3건은 **내가 대행할 수 없다**. 원인은 도구가 아니라 대상이다 — 전역 규칙의 winbridge는 사용자 **자택** 데스크톱에 도달하지만, EPERM은 **회사 보안정책이 번들 `claude.exe`를 차단**해 생긴 현상이라 자택 환경에서 재현되지 않는다. 세 건 모두 같은 세션에서 한 번에 처리하는 것이 효율적이다.

- **M-2** 번들 CLI ↔ `claude-agent-sdk` 0.3.202 **제어 프로토콜·플래그 호환**(`--include-partial-messages` 등) 확인. ⓐ**SDK 쪽 페어는 실측 확정**(2026-08-26): `node_modules/@anthropic-ai/claude-agent-sdk-<플랫폼>/claude --version` → **`2.1.202 (Claude Code)`**. SDK는 claude-code에 대한 의존성을 선언하지 않고 플랫폼별 바이너리를 동봉하므로, 페어는 추측하지 말고 이 명령으로 물어보면 된다(README에도 이 확인법을 반영). ⓑ남은 관측은 **회사 PC의 별도 설치본**(현장보고의 2.1.112 계열)이 이 SDK와 붙는지다 — 이게 M-2의 실제 미지수다.
- **M-3** `GBC_CLAUDE_PATH` 우회 실사용 검증(0.9.2·0.9.3 이월)
- **M-4** `resume` 회사환경 **필드 실측**(0.10.0 잔여 — 코드 계약은 완비, 실행 관찰만 남음)

**사용자 실행 블록** (회사 PC PowerShell, Doc-1 반영 후 문구와 동일):
```powershell
# 1) JS 설치본 cli.js 실경로 확인 (npm 레이아웃이면 아래 형태)
#    ...\node_modules\@anthropic-ai\claude-code\cli.js
$env:GBC_CLAUDE_PATH="<cli.js 절대경로>"

# 2) 같은 셸에서 실행 — M-2/M-3 동시 관측
gbc tui

# 3) 세션을 한 번 끊었다가 재개해 resume 필드 관측 (M-4)
#    확인 대상: 재개 후 대화 이력·탭 상태가 보존되는가
```
**회신받을 것**: ①`gbc tui`가 뜨는가(M-3) ②경고·오류 문구 원문(M-2) ③resume 후 보존 여부(M-4) ④`.gbc/events.jsonl` 마지막 몇 줄

## D — 결정문 (3건) — **결정만 여기서, 구현은 0.14.0**

> 세 건 모두 **판정 의미론 또는 판정 입력**을 건드린다. 0.13.1에 섞으면 0.13.0 P4의 효과를 사후 분리측정할 수 없다. 산출물은 코드가 아니라 **`docs/analysis/` 결정문**이다.

- **D-1** **`block-repeat` 존폐 + `?? "allow"` → `ask` 승격 판단** ⚠️ 최우선
  - 인과는 RCA에 이미 쓰여 있다: *"`block-repeat`은 ⓒ(작업단위 이력) 성공 시 **존재근거가 소멸**한다(도입 사유=재차단 노이즈). 그때 `hook.ts` `?? "allow"` 폴백을 두면 **정당화 없는 미탐만 잔존** → `allow`→`ask` 승격 재검토 필요."*
  - **현 상태의 긴장**: ⓒ(P2a)는 0.12.3에서 나갔는데, 0.13.0은 오히려 block-repeat을 근사매칭으로 **확장**했다. 이 정면 충돌이 다뤄지지 않은 채 1.0.0에 들어가려 하고 있다.
  - **데이터 임계(선행조건)**: `repeatMatch`가 2026-08-22 출하라 표본이 없다. 결정문은 **`repeatMatch` exact/covered 분리 집계 ≥30건** 또는 **관측기간 2주** 중 먼저 도달하는 시점에 쓴다.
  - 결정문이 답할 것: ①ⓒ 이후 재차단 노이즈가 실제로 줄었는가(events로 검증) ②`covered` 강등 중 사람이 봤어야 할 건이 있었는가 ③`allow` 유지 / `ask` 승격 / block-repeat 폐기 중 택1 + 근거.
  - **TP floor 원칙 준수**: 이 저장소는 0.5.5→0.9.3→0.12.x로 **3연속 오탐 억제하며 미탐을 한 번도 측정 안 했다**. "덜 막기"로 수렴하는 자기충족을 막으려면 결정문에 **대칭 근거**(기구현→pass 유지 / 미구현→block 유지)를 반드시 포함한다.

- **D-2** **`REPEAT_COVERAGE_MIN=0.8` 임계값 재검증**
  - 0.13.0이 **실측 4표본**(양성3·음성1)으로 임계값을 고정해 발행됐다. 사전 방어는 없고 사후 추적만 가능하다.
  - D-1과 **같은 데이터·같은 시점**에 처리한다(`repeatMatch`로 exact/covered 분리 집계). 표본이 쌓이면 0.8이 여전히 옳은지 재계산.
  - ⚠️ 오탐율 비교 시 함정: 억제가 늘면 `scoring.ts`의 `repeated-unresolved`(오탐 후보 계수)도 는다 — baseline UPR 61%/IPR 16%와 **단순 비교 금지**, `repeatMatch`로 분리해야 like-for-like가 성립한다.

- **D-3** **`AppliedEntry.session_id` 필터링 판단**
  - 출처: 0.12.4 D3 이월("기록만 포함, 필터링은 다음 배치, 실측 데이터가 쌓인 뒤 판단"). 멀티탭 교차오염 방지가 목적.
  - **판정 입력 변경**이므로 구현은 0.14.0. M-1의 원장 재구축 과정에서 나오는 데이터를 판단 근거로 쓴다.

## H — 위생 (2건, 코드 무관)

- **H-1** ✅**DONE — 「추적 유지 + 기계가드」결정** `package-lock.json` 0.10.4 고착
  - 실측: deps 그래프는 현행과 일치하고 **`version` 필드 2곳만** 고착돼 있었다(0.13.0으로 동기화 완료).
  - **결정: 추적 유지**(gitignore 기각 — 1.0.0에서 CI를 넣을 때 lock이 필요하고, 지금 빼면 재도입 비용만 생긴다). 대신 **드리프트를 기계가 막는다**: `package.json.version === lock.version === lock.packages[""].version` 가드 테스트를 `npm test`(→`prepublishOnly`)에 편입 — 산문 규칙이 아니라 게이트다.
  - ⚠️ **다음 릴리스 주의(이 가드의 부작용)**: `package.json`만 손으로 bump하면 `npm test`/`prepublishOnly`가 **실패한다**. 반드시 `npm version --no-git-tag-version <ver>`(둘 다 갱신) 또는 세 필드를 함께 수정할 것.
- **H-2** 🔎**조사 완료 · 실삭제는 사용자 승인 대기** **원격 브랜치 정리**
  - 현황: 원격 19개. `git branch -r --merged origin/main`은 **1개만** 잡는데, 이건 정리 대상이 없다는 뜻이 아니라 **PR이 전부 squash-merge라 브랜치 팁이 main의 조상이 아니기 때문**이다 — ancestor 판정으로는 이 저장소의 정리 대상을 못 찾는다(판정 도구를 먼저 의심할 것). 권위 있는 판정은 **PR 상태**다(`gh pr list --state merged`).
  - **삭제 후보 17개(전부 MERGED PR 대응 확인)**: `docs/changelog-release-meta`(#27) · `feat/0.12.2-project-root-divergence`(#54) · `feat/0.12.3-work-unit-history`(#55) · `feat/0.5.4-p0-scope-joinkey`(#26) · `feat/0.5.5-defect-rca-fixes`(#28) · `feat/0.7.0-a1-sdk-wrapper`(#33) · `feat/0.8.0-a2-real-m1`(#34) · `feat/0.9.0-a3a-tui`(#35) · `feat/0.9.4-tui-session-streaming`(#39) · `feature/0.10.0-a3b-tabs`(#40) · `feature/0.10.5-refactoring-batch`(#45) · `feature/0.10.6-hardening`(#46) · `feature/0.11.0-task-c-d`(#47) · `feature/0.12.0-gate-fp-rootfix`(#52) · `feature/0.12.4-applied-ledger-reverify`(#56) · `feature/0.2.2-spec-canonical-sessionstart`(#6) · `fix/help-withdraw-row`(#29)
  - ⛔ **보존 2개**: `origin/main` · **`origin/feature/silver_sh`** — 후자는 **현재 작업 브랜치이자 PR #21·#44·#50·#51에 재사용된 상시 브랜치**다. "머지된 PR의 head"라는 이유로 지우면 안 된다(로드맵이 인용한 체크아웃 충돌 사고 이력과 같은 계열의 함정).
  - **실삭제는 되돌리기 어려운 원격 조작이라 이 배치에서 실행하지 않는다** — 사용자 승인 후 별도 수행.

---

## 실행 순서 (의존 반영)

```
1) Doc-1            ← M-2/M-3의 선행조건(사용자가 쓸 문구)
2) R-2              ← M-1의 선행조건(펜딩 오염 제거)
3) R-1 · R-3 · T-1~T-4 · H-1 · H-2    ← 상호 독립, 병렬 가능
4) M-1              ← R-2 완료 후, 새 작업단위 필요
5) 0.13.1 발행
6) M-2·M-3·M-4      ← 사용자 회신 대기(발행과 병행 가능)
7) D-1·D-2·D-3      ← 데이터 임계 도달 후 결정문 작성 → 0.14.0 필요 여부 확정
```

## 검증 요구 (실행 결과 반영)

- ⚠️ **로드맵이 적은 플래그가 틀렸다(정정)**: 이 저장소 `verify.sh`는 `--no-build`·`--full`을 **파싱하지 않는다**(조용히 무시되고 기본 동작). 게다가 테스트가 전부 `../dist/*.js`를 import하므로 빌드를 건너뛰면 stale dist로 **거짓 green**이 난다([[feedback_stale_dist_confounds_llm_eval]]). → 실제 게이트는 플래그 없는 `bash verify.sh`(풀빌드+테스트), 최종은 `bash verify.sh --eval`.
- ✅ `bash verify.sh --eval` **1244/1244 pass** · eval hard 22건 baseline 유지 · scope 회귀 통과 (2026-08-26, R-1 Critical 수정 반영 후 재실행).
- ✅ **tmux 실렌더 두 크기 대조 완료**(T-1·T-2): 80×24 / 100×40 모두 웰컴카드 키맵 **5행·순서·문구 이전과 동일**, 테두리 파손 없음. 100×40에서 `?` HelpPanel을 열어 `SHORTCUT_REGISTRY` 15항목이 등록 순서대로 전량 표시됨을 확인(단일 소스가 양쪽을 실제로 먹이고 있다는 실렌더 증거). R-3은 코드 변경이 없어 대상 아님.
- ✅ `scope-critic` — ST6b에 "변경필요" 판정이 나왔으나 사유가 전부 *"예산 소진으로 코드 미읽음"*이었고, 지목한 3경로를 코드로 반증했다: ①in-flight 큐잉은 streaming 중이면 `enqueue`만 하고 `submit()`을 아예 안 부른다(`app.tsx:1275-1280`) → 진행중 턴의 리셋 재진입 불가 ②세션 사망 `drainApprovals`는 `makeInkCanUseTool`이 await하는 **바로 그 promise**를 resolve하므로 대기시간이 정상 계상된다 ③`approvalWaitMsRef`는 repoId 키라 탭 전환이 간섭하지 않는다. ST5의 컴파일타임 강제도 음성 테스트로 실재 확인(`card` 누락 시 `TS2741`).
- ✅ 발행 전 `security-auditor` QUICK — **Critical 1건 적발·수정·재검증 완료**(위 R-1). Info 3건(경로 컨테인먼트 정상·redaction 설계대로 동작·TUI 변경은 표시/계측 순수 데이터)은 조치 불요.
- ✅ **Critical 수정 재검증**(같은 감사자, 독립 재현): ①두 크래시 경로 모두 닫힘 확인 + **worst-case 합성**(`missing`·`seen` 동시 원소손상)에서도 우회 없음 — `prior===null`이면 `prior?.specHash === specHash` 단락평가로 `sameMissingSet`/`isAnnouncedRepeat` 호출 자체가 발생하지 않는다 ②`missing` 전체 폐기가 게이트를 약화시키는 경로는 **반증 실패**(block-repeat은 `prior` 생존이 도달 전제라 구조적으로 더 허용적일 수 없음. 유일한 부작용은 `cmdGateReview`가 "펜딩 없음"을 표시하는 가시성 손실뿐 — 이미 손상된 레코드라 감내 가능) ③이번 diff 나머지 파일에 동계열(컨테이너만 검사) 잔존 결함 **없음**(디스크에서 읽은 조작가능 상태를 파싱하는 지점은 `readPendingReview` 하나뿐).
  - ⚠️ 남는 설계 사실(결함 아님): `text.ts`의 `normalizeCase`/`tokenizeCase` 자체는 여전히 비문자열 입력을 방어하지 않는다 — 방어 위치는 **상류 게이트인 `review.ts`** 한 곳으로 의도적으로 모았다(형상 검증을 소비처마다 흩뿌리면 새 소비처가 생길 때마다 같은 결함이 재발한다).
- `npm run eval` **무변경이 정상 신호** — 이 배치는 판정 입력을 안 바꾼다(코드 7건 전부 판정 무관: 위생·형상가드·redaction·TUI 표시·lock).

## 착수 전 확인 (이행 완료)

- ✅ `gbc spec add`로 작업단위 개시(spec 10케이스).
- ✅ `/plan` 산출 = `docs/plan/PLAN-0.13.1-residual-closeout.md`. 라우팅 판정: `[P]` 후보 독립 SubTask가 2건뿐이라 impl-handoff 하드 전제(≥4) 미충족 → **전량 `[S]` 인라인 순차**(team-dev 위임 없음).

## 발행 후 남는 것

- **M-2 · M-3 · M-4** — 사용자 회사 PC 실측 대기(위 실행 블록 그대로). 발행과 병행 가능.
- **H-2 실삭제** — 사용자 승인 대기(후보 17개 확정, 보존 2개 명시).
- **D-1 · D-2 · D-3** — 데이터 임계(`repeatMatch` ≥30건 또는 2주) 도달 후 결정문 → 0.14.0 필요 여부 확정.
- **1.0.0(A4)** — 원래부터 별도 마일스톤.

## 이 배치에서 함께 닫는 stale 표기

메모리 인덱스의 아래 마커는 본문과 어긋나 있다(작업이 아니라 표기 정정):
- `0.10.5/0.10.6/0.11.0 (⏳ ship 대기)` → 본문은 전부 발행완료
- `게이트 오탐 근본수정 (⏳ 계획확정·구현 미착수)` → 0.12.0 발행완료
- `게이트 오탐 RCA (⏳ 미수정)` → **P0~P4 전량 발행완료**(P0·P1=0.12.0 / P2b=0.12.0·P2a=0.12.3 / P3=0.12.1 / P4=0.13.0)
- `0.9.0 A3a (ST7 실터미널 검증 대기)` → 0.10~0.13의 반복 tmux 실측으로 사실상 소멸
