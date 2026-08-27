# PLAN — 0.13.1「잔여 종결」배치

생성: 2026-08-26 · 근거 로드맵: `docs/plan/ROADMAP-0.13.1-residual-closeout.md` · planner(opus) 위임 산출 + 메인 세션 검수

## 사용자 요구사항 원문

> 0.13.1 로드맵확인. 이후 /sh-dev-loop --tdd --auto 진행해

로드맵(`docs/plan/ROADMAP-0.13.1-residual-closeout.md`)이 이미 커밋되어 있고, 그 배치("1.0.0(A4) 제외 전 항목 종결")를 `--tdd --auto` 모드로 구현하라는 지시. 신규 기능 0건 — 가드/상한/문구/실측/결정문만. 판정 입력(gbc judge 입력) 변경 금지.

## [사전 정정] 로드맵 대비 코드 실증 (planner 조사, 메인 세션이 재확인 완료)

| 항목 | 로드맵 주장 | 코드 실증 | 조치 |
|---|---|---|---|
| **Doc-1** | Unix 스타일만 있어 PowerShell 불가 | **이미 종결(0.12.0 ST13)** — `src/tui/startup-diagnostics.ts:86-89`에 PowerShell 예시+JS설치본 cli.js 우회 이미 반영, 회귀락 `test/tui-startup-diagnostics.test.mjs:107-115` | 재범위 → 잔여는 **README.md:373-391**(중립워딩 위반 + `C:\allowed\path\claude.exe` 오예시가 실측 우회와 모순) |
| **R-3** | Static 스크롤백 상한 없음 | **이미 종결(0.10.1+0.10.4)** — Static 자체가 0.10.1에 완전 폐기(`ChatBox.tsx:1-4`), 상한은 `format.ts:339 CHAT_SCROLLBACK_MAX_ENTRIES=500` + `scrollback.ts:26-30`이 repo별 오래된 것부터 폐기(관례 그대로) | **코드 SubTask 없음** → 종결 표기만 |
| **T-1** | `formatWelcomeCard`가 `SHORTCUT_ROWS` 참조하면 됨 | `HelpPanel.tsx:6`이 이미 `../format.js` import 중 — 그 방향은 ESM 순환 | **방향 반전**: 레지스트리를 `format.ts`로 이전, HelpPanel이 소비 |

메인 세션이 위 3건을 실제 파일 Read로 재확인 완료(startup-diagnostics.ts:86-89, ChatBox.tsx:1-4, format.ts:339, HelpPanel.tsx:1-24, README.md:373-391 전부 대조).

## SubTask 목록 + 라우팅

**라우팅 판정**: `[P]` 후보(독립 파일+독립 기능) 순수 단일 SubTask는 ST1·ST4 2건뿐 — chain A(ST2→ST3→ST7)·chain B(ST5→ST6a→ST6b)는 파일 공유로 내부 `[S]`. impl-handoff §5 하드 전제 "`[P]` 후보 독립 SubTask ≥ 4" 미충족 → **전량 `[S]` 인라인 순차** (team-dev 위임 없음).

```
[Task] 0.13.1 「잔여 종결」배치   라우팅: 전량 [S] (독립 SubTask 2 < 임계 4)

  ST1  Doc-1(재범위): README EPERM 절 정합화                    → README.md
  ST2  [TDD] R-2: closeWorkUnit 추출 + pendingReview 정리       → src/work-unit.ts(신규) · src/cli.ts · test/unit.test.mjs
  ST3  [TDD] R-1: readPendingReview seen 형상가드               → src/review.ts · test/unit.test.mjs
  ST7  [TDD] H-1: lock 버전 동기화 + 드리프트 기계가드           → package-lock.json · test/unit.test.mjs
  ST4  [TDD] T-3: 크래시 덤프 redaction 대칭화                  → src/tui/bridge.ts · test/tui-bridge.test.mjs
  ST5  [TDD] T-1: 키맵 레지스트리 단일소스화                    → src/tui/format.ts · src/tui/ui/HelpPanel.tsx · test/tui-format.test.mjs
  ST6a [TDD] T-2(순수): 턴시간 의미 정정 + 3경로 표기            → src/tui/model.ts · src/tui/format.ts · test/tui-model.test.mjs · test/tui-format.test.mjs
  ST6b T-2(배선): 승인대기 계측 + outcome 전달 [tmux 실렌더 검증] → src/tui/app.tsx
  ST9  H-2 조사: 머지완료 원격브랜치 목록화 (실삭제 제외, 코드 무변경)
  ST8  문서: 로드맵 정정 + T-4「현행 유지」결정문                → docs/plan/ROADMAP-0.13.1-residual-closeout.md
  ST10 M-1 관측: appliedStale 도그푸딩 (코드 무변경, ST2 이후)
```

**실행 순서**: ST1 → ST2(+build) → {ST3→ST7} → ST4 → ST5→ST6a→ST6b(tmux 검증) → ST9 → ST8(마지막, file:line 확정 후) → ST10(M-1)

## SubTask별 설계 요지

### ST1 — README EPERM 절 정합화 (TDD 부적격·문서)
`README.md:373-391`의 소제목·본문에서 "회사 보안정책"·"회사 EDR"·"보안팀" 워딩을 "환경" 계열로 중립화([[feedback_user_facing_copy_neutral]]). PowerShell 예시를 `C:\allowed\path\claude.exe`(차단 대상 자체)에서 실측 확인된 `...\node_modules\@anthropic-ai\claude-code\cli.js`로 교체 — `startup-diagnostics.ts:86-89`와 정합.

### ST2 — [TDD] closeWorkUnit 추출 (`src/work-unit.ts` 신규 · `src/cli.ts` `cmdDone`)
`clearPendingReview`가 `cli.ts:576`(reset --hard)·`cli.ts:799`(spec-add)에서만 호출되고 `cmdDone`(cli.ts:419-432)에 없음. 기존 `unit.test.mjs:4098` reset --hard 테스트는 `clearPendingReview`를 직접호출 검증이라 done 경로 실증엔 무의미(동어반복 회피 — [[feedback_regression_input_shape_contract]] 계열 3회째).
`closeWorkUnit(cwd)` = archiveSpec+resetGate+clearApplied+clearPendingReview(신규), archived 경로 반환. `cmdDone`은 beforeHash 캡처(archive 이전, 기존 불변식) → closeWorkUnit → logCli만. RED: tmp cwd(HOME/USERPROFILE 오버라이드, `.gbc/` 선생성)에서 pendingReview+원장 심어놓고 closeWorkUnit 후 둘 다 비어있음 확인.
판정입력 영향 없음(Tier1/2는 specHash 스코프, `gate-core.ts:632-633`). **완료 후 `npm run build` 필수**(M-1 선행조건).

### ST3 — [TDD] `seen` 형상가드 (`src/review.ts:25-30`)
소비처 2곳(`review.ts:84`·`gate-core.ts:633`) 모두 `??` 폴백이라 "존재하지만 타입이 틀린" 값을 못 막음. 가드는 **필드 strip**(레코드 전체 아님 — `missing` 생존이 Tier1 생존 조건). RED: `seen`이 문자열/숫자/객체/null 4종 손상 레코드에서 크래시 없이 `missing` 보존.

### ST7 — [TDD] lock 드리프트 (`package-lock.json`)
실측: deps 그래프는 현행 일치, `version` 필드만 0.10.4 고착. **추적 유지 + 기계가드** 채택(1.0.0 CI 결정 예정이라 지금 gitignore하면 재도입 비용). `package.json.version === lock.version === lock.packages[""].version` 가드 테스트를 `npm test`/`prepublishOnly`에 자동 편입.

### ST4 — [TDD] 크래시 덤프 redaction (`src/tui/bridge.ts:240-245`)
`formatCrashDump`가 `redactSecrets`(`extraction.ts:58-79` 기존 8패턴군 재사용, 신규 패턴 금지) 미적용. **본문 join 후 1회 적용, 절단보다 먼저**(PEM 블록이 여러 스크롤백 엔트리에 걸쳐 있어 엔트리별 적용은 놓침 — `formatBangOutput` 선례 규율). RED: 단일행 키 3종 + 여러 엔트리 걸친 PEM 블록(결정적 케이스) + 헤더 형식 불변 + 멱등성.

### ST5 — [TDD] 키맵 레지스트리 단일소스화 (`src/tui/format.ts` · `src/tui/ui/HelpPanel.tsx`)
레지스트리를 `format.ts`(Ink-free)로 이전, `{key, help, card: {order,label} | null}` — `card`를 **필수 nullable**로 둬 신규 키 추가 시 카드 노출 여부를 컴파일타임 강제(0.11.2 Alt+F 누락 재발 구조적 차단). 불변식: `tui-format.test.mjs:381`(카드 정확히 12행) · `:455`(행 폭≤30) 무수정 유지. 신규 테스트: 레지스트리 card≠null 집합 == 카드 렌더 키 집합(양방향).

### ST6a — [TDD] 턴시간 순수 로직 (`src/tui/model.ts` · `src/tui/format.ts`)
`computeTurnMs({startedAt,endedAt,approvalWaitMs})` = `max(0, endedAt-startedAt-approvalWaitMs)`. `StatuslineState.lastTurnOutcome: "ok"|"aborted"|"error"` 추가. `formatStatusline`은 **기존 세그먼트에 접미**(`"12.3s 중단"`) — 신규 세그먼트 추가 금지(overflow 클램프 순서가 "토큰=맨 끝" 고정, `tui-format.test.mjs:171` 불변).

### ST6b — 턴시간 배선 (`src/tui/app.tsx`, TDD 부적격·UI배선)
`makeInkCanUseTool`/`drainApprovals` 경계에서 승인대기 구간 누적 → `app.tsx:805` 패치에 전달. outcome은 기존 `formatEngineAbort`/`formatEngineFailure` 분기(`app.tsx:759-763`) 재사용. **tmux 80×24/100×40 실렌더 검증**.

### ST9 — H-2 조사 (코드 무변경)
`git branch -r --merged main` 등으로 머지완료 원격브랜치 목록화만. **실삭제는 별도 사용자 승인 후**(되돌리기 어려운 작업).

### ST8 — 로드맵 정정 + T-4 결정문 (`docs/plan/ROADMAP-0.13.1-residual-closeout.md`)
§Doc-1/§R-3 종결 표기(근거 file:line), §T-1 방향반전 사유, **§T-4 「현행 유지」결정문**(win32 shell:true+homedir 공백 — 실측 재현 0건, 재개조건="공백 homedir 실패 실측 시").

### ST10 — M-1 관측 (코드 무변경)
ST2 완료+build 후. **스크래치 repo에서 수행**(로드맵 5단계의 "파일 X 구현 삭제"를 본 repo 프로덕션 코드에 하면 파괴적 — 본 repo `.gbc` 원장 오염 방지). `appliedStale≥1` 관측이 종결 기준.

## 검증 규약 (planner 정정 반영)

1. `bash verify.sh`(플래그 없이) = 풀빌드+테스트 — 이 repo 테스트는 전부 `../dist/*.js` import라 `--no-build`는 stale dist로 거짓 green 위험([[feedback_stale_dist_confounds_llm_eval]]). SubTask 게이트는 기본 `bash verify.sh`.
2. `--full`/`--ts-only`는 이 repo verify.sh가 파싱 안 하는 플래그(조용히 무시되고 기본 동작) — 최종 게이트는 `bash verify.sh --eval`(빌드+테스트+eval).
3. SubTask마다 scope-critic, 발행 전 security-auditor QUICK, TUI 변경(ST5·ST6a·ST6b)은 tmux 80×24/100×40 두 크기 대조 필수.
4. eval 무변경이 정상 신호(7개 코드 SubTask 전부 판정입력 무영향 — 위 절별로 근거 명시함).

## 확정 제약 (변경 시 이 파일 갱신 필수)

- 판정 입력 변경 금지(교란분리 원칙)
- H-2 실삭제·H-1 최종 lock 정책은 사용자 확인 지점으로 별도 보고
- 테스트 정합성 가드 준수(green 위해 테스트 약화 금지)
