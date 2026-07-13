# Changelog

이 프로젝트의 주요 변경 사항을 기록한다. 형식은 [Keep a Changelog](https://keepachangelog.com/), 버전은 [SemVer](https://semver.org/)를 따른다.

## [Unreleased]

`gbc tui`/`gbc run` 사내 프록시(Nexus/Artifactory류) 레지스트리 환경 설치 실패 근본수정(0.9.1 예정). 실사용자(0.9.0 배포 직후)가 회사망에서 3단계 연쇄 크래시를 겪은 것을 계기로 한 수정: ①`ink` caret range가 이미 전역에 있던 구버전과 dedup 충돌(`useWindowSize` export 없음) ②개별 패키지 재설치가 React peer dependency를 중복 설치(`useReducer` 등 훅 디스패처 null) ③두 경우 모두 원시 스택트레이스만 노출하던 에러 처리.

### Fixed
- **`ink` optionalDependency를 exact pin으로 변경**(`^7.1.0` → `7.1.0`, `react`와 동일 패턴 통일) — 캐럿 range가 사내 프록시에 남아있던 다른 버전과 dedup 충돌하는 것을 원천 차단.
- **`gbc tui`/`gbc run`의 크래시 진단 메시지 개선** — 기존 "미설치"(Cannot find module/package) 판별에 더해 "버전불일치"(SyntaxError: 요청한 export 없음)·"React 인스턴스 중복"(훅 디스패처 null) 패턴도 인식해 `npm ls -g` 진단 명령과 정확한 pin 버전 재설치 명령을 안내한다(`src/tui/startup-diagnostics.ts` 신규, 순수함수·단위테스트). 안내 문구의 버전은 `package.json`에서 매번 동적으로 읽어 다음 릴리스에서도 drift 없음.
- **README 설치 안내 전체를 exact pin으로 통일**(설치 섹션·풀스크린 TUI 섹션·A-모드 미리보기 섹션 3곳) + "사내 프록시 레지스트리 환경" 트러블슈팅 섹션 신설(캐럿/미지정 설치 금지, 세 패키지 한 번에 설치, `npm ls -g` 진단).

## [0.9.0] - 2026-07-11

A3a 단일-repo full TUI — `gbc run`(A-모드 in-process 엔진) 위에 승인 프롬프트·게이트 줄·계측/repo 토글 패널을 갖춘 풀스크린 화면(`gbc tui`)을 얹는다. 시안 A(토글 패널)·statusline 2줄·마스코트(half-block)·그린 톤. 계획·스택 결정: `memory/project_0_9_0_tui_stack_decision.md`. **실터미널 수동 도그푸딩(한글 IME·bracketed paste·리사이즈 등)은 이 릴리스 전에 완료하지 못해 0.9.x 후속 패치로 대응 예정** — 알려진 후속 항목은 아래 참조.

### Added
- **`gbc tui [--model <m>]`** — 풀스크린 TUI. `y/n/e/d` 승인 프롬프트(에이전트 자신의 `Bash("gbc spec add ...")` 호출을 `canUseTool`이 pause — 게이트 자체의 4지선다가 아니다), `⌃M`/`⌃R`로 계측(진짜 M1/M2/M3)·repo 상태 패널 토글(Esc로 닫힘), Static 스크롤백 + 마스코트 스플래시. 단일-repo 전용(multi-repo 스위처는 A3b 이후).
- **`src/tui/*`** — 렌더-비의존 순수 상태모델(`model.ts` reducer)·멀티라인 에디터 텍스트버퍼(`editor.ts`)·마스코트/statusline/경량 md·diff 포맷터(`format.ts`)·SDK↔TuiEvent 순수 매핑(`bridge.ts`) + Ink 컴포넌트(`app.tsx`, `ui/*.tsx`). 순수부(model/editor/format/bridge)는 TDD 회귀락, UI 컴포넌트는 절대제외(수동 스모크 + scope-critic 3라운드).
- **승인 큐 직렬화** — 한 턴 안에서 SDK가 서로 다른 tool_use 2개에 `canUseTool`을 겹쳐 호출할 가능성에 대비해 단일 ref 대신 큐로 승인 요청을 직렬화한다(화면엔 한 번에 하나만, 응답 즉시 다음 것을 이어서 연다).

### Changed
- **`engines` `>=22`로 상향(Breaking)** — `gbc tui`가 요구하는 ink 7/React 19 최소 버전. B-모드(hook 게이트)만 쓰는 설치는 `npm i -g geobuke-code --omit=optional`로 ink/react/agent-sdk를 건너뛸 수 있다.
- `ink`·`react`가 `@anthropic-ai/claude-agent-sdk`와 함께 `optionalDependencies`에 추가됨(TUI 쓸 때만 설치). `gbc tui`는 이 셋을 함수 내부에서만 동적 import해 B-모드 hook 핫패스·다른 gbc 커맨드는 무영향으로 격리한다(`test/tui-isolation.test.mjs` 회귀락).

### Known follow-ups (0.9.x 예정, security-auditor QUICK 스캔 Warning)
- 승인 프롬프트 기본 selection이 `y`(승인)라 Enter 한 번으로 즉시 허용됨 — stdin 경로(`makeStdinPauseCanUseTool`)의 "고무도장 방지" 기본 거부 원칙과 반대. generic 도구 승인 화면도 실행될 도구명·명령/경로를 표시하지 않음. 기본값을 거부로, generic 승인에 도구명·인자 표시 추가 예정.
- agent-sdk 동적 import 격리는 코드 리뷰로 확인됐으나 `test/tui-isolation.test.mjs`가 ink/react만 로더로 차단해 기계적 회귀락은 아직 없음.

## [0.8.0] - 2026-07-08

A2 진짜 M1 사후대조 — 0.7.0이 깐 `.gbc/extraction.jsonl`(A-모드 엔진 출력)을 `events.jsonl`(게이트 판정)과 **session_id로 조인**해, B-모드가 구조적으로 못 재던 두 숫자를 착지: **통과 후 시나리오 위반율(진짜 M1)** + **차단 오탐율**. hook/gate-core 계약 무변경 = **재init 불요**(단 `/gbc-monitor` 스킬 문서 갱신 반영은 재init 필요). 계획·실측: `memory/project_0_8_0_plan.md`. **minor 근거**: 신규 커맨드(`gbc score`)·metrics 표면 확장이나 기존 판정·hook·CLI 계약 불변.

### Added
- **`gbc score [--json]`** — A-모드 세션의 extraction⨝events 조인 후보를 사후대조 채점한다(후보당 haiku 1호출, `GBC_SCORE_MODEL` opt-in). 통과 당시 명세는 `specHash`로 resolve(현행 spec.md 해시 일치 → `spec.archive/<hash>-*.md` 파일명 매칭) — **resolve 실패 시 다른 명세로 채점하지 않고 unscored**(오염 금지). 결과는 `.gbc/scores.json` 스냅샷(파생 아티팩트 — 재채점 시 덮어씀). 채점은 비용이 드는 **명시 명령** — 게이트 핫패스·metrics 순수 집계에 절대 실리지 않는다.
- **`gbc metrics` `[진짜 M1]` 섹션**(단일 repo 조회 시) — **위반율**: 채점 완료분(violated+compliant)만 분모(unscored 포함 시 과소평가). **오탐율**: LLM 재판정이 아니라 **행동신호**로 grounding(게이트 자체가 LLM이라 재판정은 일치도지 truth가 아님) — `block→spec 보강→통과`=정상 / `무시(gate-reset·bypass)`·`포기(무대응)`=오탐 후보 / `자가수정`=모호(오탐으로 세지 않음) / `fail-open 통과`=판정불능(분자·분모 제외). 표본 0은 0%가 아니라 `—(표본 0)` 정직 표기. `--json`은 `realM1` 필드 병합.
- **조인·채점 코어(`src/scoring.ts`)** — `joinBySession`(extraction 없는 B-모드 세션 `scorable:false` 정직 태그)·`selectScoringCandidates`(**specHash 전환점 다중 앵커** — 한 세션이 done→spec-add로 여러 작업단위를 낼 때 2번째 단위 편집이 1번째 명세로 오채점되는 것 차단)·`classifyBlockOutcome`(행동신호 분류, 동시 세션 혼입 시 `ambiguous` 정직 표기)·`computeRealM1`(집계). 전부 순수함수 — 32단정 TDD 회귀락.
- **score 판정 경로(`src/judge.ts`)** — `judgeM1Violation`: 기존 reviewed/scope 경로와 동형(build/parse 순수 분리·invoke seam). **어떤 실패 경로도 compliant로 떨어지지 않는다**(호출 실패·파싱 불가·미지 verdict → unscored — reviewed의 unverifiable 규율 미러).

### Fixed
- **block→failopen 오분류(잠복)** — 차단 후 재시도가 판정불능(fail-open)으로 통과된 경우를 "포기(오탐 후보)"로 오분류해 오탐율이 조용히 부풀 수 있던 것을 `failed-open` 별도 분류로 차단(scope-critic 적발 — 실존 failopen 이력 33건이 재료였다). `fail-open≠pass` 원칙대로 정상 해소로도 오탐으로도 세지 않는다.

### Security
- **scores.json 전이적 정화** — 채점 입력(extraction text)은 기록 시점에 이미 redaction+캡 적용된 값이라, 파생 아티팩트(`scores.json`의 reason/uncovered)도 원시 시크릿을 담지 않는다. `.gbc/` gitignore 최종 방어선 동일.

## [0.7.0] - 2026-07-08

A1 SDK Wrapper 스파이크 — 게이트 루프가 **in-process agent-sdk**로 구동되는 A-모드의 실행 가능한 첫 절개. B-모드(stdin hook)와 완전 호환(hook 계약 무변경 = 재init 불요). 실험적 `gbc run` 커맨드 추가. 계획·실측: `memory/project_0_7_0_plan.md`. **minor 근거**: 신규 커맨드·신규 판정 트랜스포트(SDK 콜백) 추가이나 기존 B-모드 API·hook 계약은 불변.

### Added
- **`gbc run "<프롬프트>" [--yes] [--model <m>] [--max-turns <N>]`** (실험적 A-모드) — `@anthropic-ai/claude-agent-sdk`를 in-process로 구동해 게이트를 SDK **PreToolUse 콜백**으로 발화한다(stdin hook과 동일한 `evaluateGate` 코어 공유). `canUseTool` **사람-pause**(`--yes`=자동 허용)로 고무도장을 막고, SDK 스트림을 `.gbc/extraction.jsonl`로 관측(진짜 M1 사후대조 축, 0.8.0에서 events⨝extraction 조인). agent-sdk는 **optionalDependencies**라 별도 설치 필요(`npm i @anthropic-ai/claude-agent-sdk`) — 미설치 시 설치 안내.
- **판정 코어 추출(`src/gate-core.ts`)** — `evaluateGate`가 부수효과를 커밋하지 않고 `GateDecision` 디스크립터(판정·응답채널·효과·계측)로 반환. stdin hook과 SDK 콜백이 이 코어와 `commitGateEffects`를 **공유**한다. 추출은 원본 `preToolUseBody`와 git 독립대조로 동작 1:1 확인, 분기별 단정 테스트가 회귀락.
- **A-모드 extraction sink(`src/extraction.ts`)** — session_id 단독 조인키, 자유텍스트만 시크릿 redaction(sk-ant/Bearer/KEY·TOKEN 대입)+길이 캡, 파일 상한 초과 시 1세대 로테이션. `GBC_NO_EXTRACTION=1` opt-out.

### Changed
- **`@anthropic-ai/sdk` `^0.40` → `^0.110`** — agent-sdk peer(`>=0.93`) 충족 위한 판정 SDK 통일. 유일 소비자 judge의 `messages.create`/content-block 표면은 불변이며, A1 E2E에서 haiku 게이트 판정(block→pass)이 0.110로 라이브 정상 동작함을 실측 확인.

### Security
- **자격증명 미주입 + 설정 격리** — `gbc run`은 agent-sdk에 API 키를 주입하지 않는다(SDK 자체 인증 우선순위 관측 — 스파이크 실측: 구독 인증 경로). `settingSources: []`로 프로젝트 `.claude/settings.json`을 로드하지 않아 gbc 자신의 stdin PreToolUse hook이 겹쳐 발화·재귀하는 것을 막는다(gbc-init된 repo에서 도구당 게이트 1발화 실측 확인). A-mode 엔진은 런타임 격리(B-모드 hook 핫패스는 agent-sdk를 절대 로드 안 함).
- **extraction redaction 커버리지 확장** — `.gbc/extraction.jsonl` 자유텍스트 마스킹에 AWS access key id·GitHub 토큰·Bearer/Basic·URL 임베디드 크리덴셜·PEM 프라이빗 키 블록 패턴 추가(발행 전 보안검토 반영). ⚠️ **패턴 기반 best-effort이지 완전한 시크릿 스캐닝이 아니다** — 최종 방어선은 `.gbc/` gitignore + `GBC_NO_EXTRACTION=1` opt-out.
- **`--yes` 위험 범위 명시** — 게이트(`evaluateGate`)는 코드 편집(Edit/Write/MultiEdit)만 판정하고 Bash 등 그 외 도구의 승인은 `canUseTool` 사람-pause에 달렸다. `gbc run --yes`는 **모든 도구를 무관문 자동승인**(Bash 임의 명령 포함)하므로 비대화형·신뢰 프롬프트 전용임을 usage·README에 명시(보안검토 권고).

## [0.6.1] - 2026-07-06

pre-A(1.0.0) 잔여 전량 소화 — A-모드 착수 전 기술부채·하드닝·정리 14건 일괄 처분(전수감사 `docs/analysis/ANALYSIS-061-pre-a-audit-2026-07-06.md`). **hook 계약 무변경 = 기존 설치처 재init 불요.** 0.7.5(#29)·상단 소개 정합화(#31) 문서 커밋 동반 발행.

### Fixed
- **API 경로 safeModel 미적용(R1)** — 모델 새니타이즈가 CLI 트랜스포트에만 걸려, 오설정 `GBC_*MODEL` env가 API 경로에선 그대로 SDK로 가 거부→fail-open pass로 원인이 은폐되던 트랜스포트 비대칭 해소. 판정 모델은 `gateModel()/scopeModel()/verifyModel()` 리졸버로 일원화 — 호출 시점 env 해석(R4: 모듈 로드시점 상수는 A-모드 in-process 장수 프로세스에서 세션 중 변경 미반영 잠복버그) + 양 트랜스포트 공통 safeModel 통과.
- **배열 판독 형상 가드 근원 통일(R3)** — `.gbc/*.json`(defers·golden·scope-queue·repos)이 valid-JSON이지만 비배열일 때 `.map` throw→exit 1 비정형 fail-open(failopen.log·계측 누락)으로 새던 것을 `store.ts readJsonArray`로 근원 흡수. `pending-review.json`은 객체/`missing` 배열 형상 가드(비정형이면 null — `gate review` 크래시 제거).
- **scope 자기파일 비교 realpath 기반(R2)** — 심링크 소스에서 자기 매치가 타 파일 단서로 유입돼 축A/rung2 오분류 재료가 되던 것을 실경로 비교로 차단(realpath 실패=신규 파일·브로큰 링크는 기존 lexical resolve 폴백).
- **hook stdin 파싱 크래시 벡터** — valid-JSON 비객체 입력(`null`·숫자)이 속성 접근 TypeError→exit 1로 새던 것을 빈 입력과 동일 취급으로 흡수(`parseHookInput`).

### Changed
- **훅 경계 정형 fail-open(R7 설계결정)** — 디스크/권한 등 인프라 I/O 실패(store.ts `gbcDir`/`writeJson` 등)가 uncaught→exit 1 *비정형* fail-open(계측·고지 전무)으로 새던 것을 훅 경계 `runHookSafely`가 정형 흡수(failopen.log+`systemMessage` 고지+exit 0). store.ts 원시함수는 의도적으로 계속 throw — CLI 경로(`gbc spec add` 등)는 디스크 실패를 성공처럼 삼키면 안 된다(정직성). A-모드 in-process 전환 시 이 경계가 콜백 예외 정책 seam.
- **업데이트 안내 분기 분리(R9)** — `maybeUpdateNotice`가 게이트 4분기(doc-skip·cached·pass·block)에 교차 삽입돼 있던 것을 단일 출구 `exitGate`로 직교 분리(출력 JSON 동등·안내는 출구 시점 계산 유지). A1 evaluateGate 추출 대상 축소 선행 리팩터.
- **소청소(R5·R6·F2~F4)** — `buildCrossRepoHint` 단일 lstat 표준화(TOCTOU 패턴 잔존 제거) · `loadPlanSpec` 컨테인먼트 경고 stderr 직출력→반환 `warning` 필드 순수화(`gbc status`가 표면화) · `time.ts` 신설(nowIso ×5·nowStamp ×2 사본 통합) · hook 설정 타입(`Settings` 등) types.ts 단일화 · defer 레이블 `Record<DeferStatus,string>` 좁히기 · dead import 제거.

### Added
- **runRunnerCommand 스모크 3케이스(R8)** — 유일 의도적 셸 실행 경로(`verify --run`) 무커버 해소: 정상 종료 / 러너 비0 exit=ok+reason(게이트 않음 계약) / timeout-kill. 단위 248.

## [0.6.0] - 2026-07-05

verify 실행형 확장 — 사후 결과검증의 3대 마찰(옛 결과 거짓 verified·러너 배선 진입장벽·실행↔판독 2단계) 제거. **minor 근거**: `--run`이 "gbc는 테스트를 실행하지 않는다" 불변식을 "**spec-유래 명령을 절대 실행하지 않는다**(신뢰 소스 고정 명령만 예외)"로 의도적·국소적으로 재정의. 설계·위협모델: `docs/design/DESIGN-verify-run-2026-07-05.md`(advisor 적대검증 6항목 반영).

### Added
- **provenance 신선도 스탬프** — JUnit 결과파일이 마지막 관측 편집(events.jsonl gate pass/cached/failopen)보다 오래됐으면 verified를 **unverifiable로 강등**(옛 pass=거짓확신·옛 fail=거짓경보 대칭 차단). 편집 신호 부재(hook 미설치 standalone)는 stale로 뭉개지 않고 "신선도 미평가"로 정직 고지. `VerifyReport.provenance`(junitMtime/lastEditAt/stale/unknown) + 리포트 3분기 캡션(stale 경고/미평가/신선 — "게이트 관측 기준, 절대 보증 아님": ask-승인 block 편집은 구조적 미탐지).
- **`gbc verify --init`** — 러너 감지(vitest>jest>mocha>node:test) → JUnit 리포터를 `.gbc/verify-results.xml`로 배선하는 명령 안내. 러너 미설치면 **node:test 제로설치 리포터 템플릿**(`.gbc/junit-reporter.mjs`, 의존성 0, Node 20+) 생성. 비파괴(기록은 `.gbc/` 하위 고정 경로만·사용자 파일 무수정)·무실행(안내만). jest/mocha는 JUnit 비내장을 정직 안내(gbc가 npm install 대행 안 함). 실제 node:test 왕복(테스트 실행→XML→verify 판정) 라이브 실증.
- **`gbc verify --run ["<명령>"] [--save]`** — 신뢰 소스 고정 러너 명령 실행 후 즉시 판독. 명령 소스는 정확히 2개: CLI 인자(1회성)·홈 pin `~/.gbc/verify-run.json`(`--save`, **repo 밖이라 PR이 심을 수 없음** — repo 내부 `.gbc/config.json`안은 `git add -f` 공급망 벡터라 설계 단계 기각). **spec-유래 명령 구조적 배제**(해석 함수가 spec을 입력으로 받지 않음). run-start mtime 검사 — 러너가 결과를 갱신하지 않으면(리포터 미배선·timeout) 옛 결과를 verified로 치지 않고 강등+배선 안내. `GBC_RUN_ACTIVE` 재귀 가드, kill-timeout `GBC_RUN_TIMEOUT_MS`(기본 10분), 실행 전 명령+소스 에코. 러너 exit≠0은 게이트하지 않음(판정은 XML 몫).

### Security
- README·gate SKILL.md에 **allowlist confused-deputy 경고** 명기 — `Bash(gbc *)` 와일드카드 allowlist 시 `--run "<임의명령>"` 인자형이 에이전트의 무프롬프트 임의 실행권이 되고, `--save`된 pin은 이후 인자 없는 `--run`이 그대로 재실행. gbc를 allowlist하려면 `--run` 인자형 제외 권고.
- 케이스 필터 실행 요구의 합법 배출구 명문화 — 필터는 `npm test -- -t "이름"`처럼 **명령 리터럴에 직접 pin**(spec-유래 문자열은 명령행에 영원히 오르지 않음).

## [0.5.5] - 2026-07-03

codebase-viz 도그푸딩 실측 결함 4건 수정 — 게이트 문서 오판정·missing 발명·안내 문구 허위·defer 종결 상태 부족. 근거: `docs/analysis/ANALYSIS-gbc-defect-rca-2026-07-03.md`.

### Fixed
- **게이트 문서 하드가드(결함A)** — "코드를 서술하는 문서"(.md 분석 보고서·README)를 haiku judge가 GATE_SYSTEM 1단계("문서→무조건 pass")를 자인하면서 block하던 실증 실패 모드(3회)를 코드에서 근절: 문서 확장자(`.md/.mdx/.txt/.rst/.adoc`)는 judge 미호출 즉시 pass(`isDocFile`) + `doc-skip` 계측. 코드 whitelist 부정형이 아닌 문서 blocklist — 미등재 코드 확장자(.vue/.sql 등)의 게이트 우회 구멍을 만들지 않는다.
- **missing 명세 교차검증(결함B)** — judge가 missing[]을 편집 본문에서 발명·ID 재조합(원문 오매핑)하던 것을 이중 차단: GATE_SYSTEM에 원문 인용(verbatim) 제약 + `filterMissingBySpec` 코드 하드가드(명세 무근거 항목 드롭, verdict 불변, 드롭 시 reason 정직 고지). 골든 재실측: gate 8/8 + scope 6/6, decisionFlip 0 — 케이스 3에서 발명 missing 4건 드롭 라이브 실증.
- **Stop 리마인드 허위 문구(결함C)** — "(이 리마인드는 1회만 표시됩니다)"에 해당하는 로직은 존재하지 않음(매 턴 표시가 의도 설계, opt-out=`/gbc-mute`). 문구를 사실 계약으로 정정.
- **block 안내 defer 유도 조건화** — defer 대상을 "이 변경의 형제 케이스"로 한정 안내(별도 작업단위·로드맵 항목의 defer 오용 유도 차단).

### Added
- **`gbc defer withdraw <ref>`(결함D)** — 철회 종결 상태 `withdrawn` 신설: 오등록 정정·기각 등 "완료 아님" 종결을 `resolved`(완료)와 구분. withdrawn은 리마인드·집계에서 빠지되 judge [이미 완료된 항목]엔 절대 전달되지 않는다(철회를 완료로 거짓 진술 금지). 복구는 `gbc defer reopen`. 인덱스 ref에도 적격(open·in_progress) 강제 — resolved 정정은 reopen 경유만. `defer-withdraw` 이벤트 계측.
- 미해결 필터 단일 술어 `isClosedStatus`(resolved|withdrawn) — 기존 `!== "resolved"` 부정형 필터 9곳(defer·hook·cli) 전수 교체.

### 주의
- **버전 혼재**: 0.5.4 이하 gbc는 `withdrawn`을 미해결로 오분류한다(크로스-repo 요약 등 표면 노이즈, 게이트 판정 무영향). 여러 repo 운용 시 전 repo 동시 업데이트 권장.

## [0.5.4] - 2026-07-03

A(100) standalone 피벗 착수 전 선행 패치(P0) — 사후대조(진짜 M1) 조인키 정합 + scope 판정 입력 신뢰도 수정. 근거: `docs/analysis/ANALYSIS-a-mode-readiness-2026-07-02.md`.

### Fixed
- **scope 이벤트 조인키 specHash 충전** — `events.jsonl`의 `kind:scope` 이벤트가 specHash를 무조건 `""`로 기록해 session×작업단위 조인이 성립하지 않던 것을, 큐잉 시점 `ScopeQueueEntry.specHash`를 판정 결과에 보강(`enrichVerdictsWithSpecHash`, 순수·file 매칭·미매칭 `""`)해 기록하도록 수정. CLI 트랜스포트 degraded 경로도 동일 충전. judgeScope 프롬프트/파싱 무변경(골든 판정 불변) — 계측 seam에서만 충전한다.
- **scope 자기파일 제외가 production 경로 조합에서 실패** — `collectGrepContext`의 자기 파일 매치 제외가 endsWith 비교라 CC `file_path`(절대경로) × grep 출력(`./`상대경로) 조합에서 불일치 → 자기참조가 탐색 컨텍스트에 오염돼 rung2/broken 오판정을 유발하던 버그. cwd 기준 `path.resolve` 동등 비교로 교체(구 양방향 endsWith의 접미 우연일치 과잉 제외도 함께 해소). production형 픽스처(절대×상대) 회귀 테스트 추가 — 기존 테스트는 양쪽 상대경로라 버그를 은폐했다.

### Changed
- **Anthropic API 클라이언트 팩토리 단일화** — `judgeViaApi`/`scopeViaApi`가 각각 수행하던 SDK lazy import+키 해석+클라이언트 생성을 내부 `createApiClient()` 한 지점으로. 동작 불변(매 호출 생성·캐싱 없음). A-mode `engine.ts`가 클라이언트 생명주기를 가져갈 seam 선정비.

## [0.5.3] - 2026-07-02

하드닝·유지보수 릴리스 — 이월 잔여 항목 전량 처분(W2 stdin 통일 + 비차단 하드닝 2건 + verify 모델 A/B).

### Security
- **W2 — CLI 폴백 user 프롬프트 stdin 통일** — POSIX `claude -p` 폴백(게이트·verify·scope 3경로)이 동적 user 프롬프트(diff·spec 본문 포함)를 argv로 전달해 프로세스 목록(ps·procfs cmdline)에 노출되던 것을 stdin 전달로 교체(`buildCliInvocation` + `runClaudeCli` 공용 러너). 정적 시스템 프롬프트는 `--append-system-prompt` argv 유지(판정 품질 변수 차단). 골든 재실측: api gate 8/8+scope 6/6 · cli gate 8/8.
- **version-check `latest` semver 형식 검증** — `~/.gbc/version-check.json` 변조 시 비-semver 문자열이 업데이트 안내 문구에 실리지 않게 읽기 지점(`readVersionCache`)+쓰기 지점(`refreshVersionCache`) 이중 검증(`isValidVersion`). 무효 캐시는 stale 취급 → 다음 refresh가 자가치유.
- **spec.archive 보존상한** — `gbc done` 아카이브가 무기한 누적되던 것을 최신 20개 보존으로 상한(`pruneSpecArchive`, `GBC_ARCHIVE_KEEP` 조정, fail-silent).

### Added
- **`GBC_VERIFY_MODEL`** — verify reviewed 판정 모델을 게이트 `GBC_MODEL`과 분리 opt-in(scope `GBC_SCOPE_MODEL` 동형). 기본 haiku 유지 — A/B 실측(8케이스, 오버클레임 함정 포함)에서 haiku·sonnet 정확도 8/8 동률, 지연은 haiku가 절반(~2s vs ~3.5s).

## [0.5.2] - 2026-07-01

게이트에 코드 품질 두 축을 편입한다 — **축A 파급반경**(같은 원인이 인접 경계 너머 재발하는 단편적 수정)과 **축B Ponytail 최소구현 사다리**(YAGNI→기존코드 재사용→표준라이브러리). "백그라운드 자동화 서비스가 사용자에게 탐색을 떠넘기지 않는다"는 원칙에 따라, gbc가 **직접 grep으로 코드베이스를 탐색해 판정**한다.

### Added
- **scope 사후 판정 (Stop 시점, 축A 파급반경 · 축B 최소구현 사다리)** — PreToolUse에서 pass한 코드 편집을 `.gbc/scope-queue.json`에 큐잉(API 0회)하고, 응답 종료(Stop) 시점에 gbc가 **실제 grep으로 인접 호출부·유사 유틸을 탐색**해 배치 판정한다(`src/scope.ts` `collectGrepContext`, `src/judge.ts` `judgeScope`/`SCOPE_SYSTEM`). 차단이 아니라 사후 권고(`formatScopeFindings`). 게이트(`GATE_SYSTEM`)는 **무변경** — 축을 같은 호출에 섞으면 침묵-누락 골든이 8/8→6/8로 퇴행함이 실측돼(스파이크), 완전히 별도 호출로 분리했다. 골든 8/8(FP0 FN0) 유지 확인.
- **코드 하드가드 (탐색 근거 없는 확신 차단)** — grep이 컨텍스트를 못 찾은 파일은 파서(`parseScopeVerdicts`)가 축A·rung2를 `unknown`으로 강제하고 `degraded=true`로 정직 고지한다(rung1/rung3는 grep 무관이라 유지). 프롬프트 지시가 아닌 코드 레벨 방어 — 모델의 근거 없는 hallucination을 구조적으로 막는다.
- **`GBC_SCOPE_MODEL` / `GBC_NO_SCOPE`** — scope 판정 모델은 기본 haiku, `GBC_SCOPE_MODEL=claude-sonnet-4-6`로 opt-in(게이트 `GBC_MODEL`과 **물리 분리** — 공유 시 비용 배증). `GBC_NO_SCOPE=1`로 기능 전체 opt-out.
- **`gbc metrics` scope 롤업 + `events.jsonl` scope 계측** — `[scope]` 요약(파급반경 broken·사다리 걸림·탐색불가 미평가 건수). `events.jsonl`엔 열거형 태그(axis/axisA/rung/spec_present/context_mode/transport/degraded)만 기록하고 코드 본문·사유는 저장하지 않는다(프라이버시 불변식 유지).
- **scope 하드 타임아웃 + CLI 트랜스포트 skip** — scope 판정 호출에 `SCOPE_TIMEOUT_MS`(10s) 상한. 초과·실패는 unknown+degraded fail-open하고 `failopen.log`에 `scope` 태그로 계측(조용한 무력화 방지). 키 없는 환경(claude -p 폴백, 호출당 18~30s 실측)은 Stop 지연 예산을 초과하므로 **판정을 시도조차 안 하고 skip** — degraded 계측만 남긴다(조건부 degradation 정직 고지).
- **scope 판정 입력에 계획 명세 포함** — rung1(YAGNI)은 "요청이 무엇이었나" 없이 판정 불가라 `buildScopeMessage`에 `[계획 명세]` 섹션을 포함(스파이크의 rung1 정확도가 명세 존재 조건에서 검증된 것과 판정 조건 정렬).
- **scope 골든셋(`test/scope-cases.json`) + 회귀 확장** — 축A/rung2 정답라벨 케이스 6건(grep 컨텍스트 포함 5 + 무컨텍스트 하드가드 1)을 `eval/regression.ts`에 편입. 초회 실측 gate 8/8 + scope 6/6.

### Notes
- **재init 불필요** — `gbc init`이 등록하는 Stop hook **명령**은 동일하고 `runStop`이 확장됐을 뿐이다. 기존 설치처는 전역 패키지 갱신(`gbc update`)으로 새 동작을 받는다. 로컬 dist 도그푸딩 설치처는 재빌드로 반영.
- **설계 검증** — BLOCKER 스파이크(48건 실측) + 2라운드 브레인트러스트(9렌즈) + Stop훅 CC 타임아웃(600s) 실증 + gbc 자체 코퍼스 라이브 도그푸딩(실제 파급반경 결함 탐지)을 거쳐 3차 설계로 확정.

## [0.5.1] - 2026-06-29

순수 대화 세션(코드 편집 없이 대화만)에서 업데이트 안내가 사용자에게 영영 안 보이던 가시성 갭을 닫는다. 0.3.0이 PreToolUse(편집) 경로의 배너는 고쳤지만, 도구 호출이 0인 세션은 PreToolUse가 안 떠서 SessionStart 채널만 남는데 그게 모델 컨텍스트로만 주입돼 사용자 화면엔 안 떴다.

### Fixed
- **SessionStart 업데이트 안내 — 사용자에게 직접 배너 렌더 (3층 갭)** — SessionStart hook 출력을 plaintext stdout(= CC가 `additionalContext`로 모델 컨텍스트에만 주입)에서 **JSON 청중분리**로 바꿨다: defer/크로스repo 힌트는 `hookSpecificOutput.additionalContext`(Claude용)로 유지하되, **업데이트 안내는 top-level `systemMessage`로 분리**해 사용자 화면에 `⎿ SessionStart:startup says:` 배너로 직접 표시한다(`src/hook.ts` `buildSessionStartPayload`). 실제 CC TUI 도그푸딩으로 렌더 확인. 이제 "안녕"만 치고 끝내는 세션에서도 신버전·재init 안내가 LLM의 자발적 relay에 의존하지 않고 항상 보인다. 비차단(exit 0)·결정론적·기존 opt-out(`GBC_NO_SESSION_HINT`/`GBC_NO_UPDATE_NOTICE`) 보존.

### Changed
- **업데이트 안내 캐시 TTL 24h → 12h** — 신버전 출시 후 기존 설치처가 더 빨리 인지하도록 `~/.gbc/version-check.json` 캐시 만료를 절반으로 단축(`src/version.ts`). refresh는 비-핫패스(SessionStart stale·PreToolUse judge 병렬)에서만 일어나므로 핫패스 부담 없음. ⚠️ **소급 안 됨** — TTL은 설치된 코드에 컴파일돼 있어, 기존 설치처는 이 버전을 받은 *다음부터* 12h가 적용된다. 현재 신버전을 못 받은 설치처는 수동 `npm i -g geobuke-code@latest`로 1회 갱신해야 한다.

### Notes
- **재init 불필요** — SessionStart hook의 출력 형식이 바뀌었지만 hook **명령** 자체는 동일하므로 settings.json 재등록은 불필요하다. 다만 기존 설치처는 새 동작(JSON 청중분리)을 받으려면 전역 패키지를 갱신해야 한다: `gbc update`(또는 `npm i -g geobuke-code@latest`). 로컬 dist 경유 도그푸딩 설치처는 재빌드로 반영된다.

## [0.5.0] - 2026-06-26

> (소급 기록 — 발행 당시 CHANGELOG 누락, 0.5.4 릴리즈메타 정비에서 보충. 정본 상세는 PR #20)

구현 전 게이트에 더해 **구현 후 결과검증**을 추가한다 — gbc 정체성이 "구현 전 게이트"에서 **계획↔구현↔검증 게이트**로 확장. gbc는 테스트를 *실행하지 않고* 표준 결과를 *읽는다*(provider 고정·RCE 차단).

### Added
- **`gbc verify` — 사후 결과검증 판정 사다리** — verified(JUnit XML이 케이스 통과/실패 증명, `::test` 바인딩) > reviewed(러너 없으면 LLM 최종 코드 독해, `::file` 바인딩 — *동작 증명 아님*) > unverifiable(증거 0이면 정직 미검증). 신규 `src/verify.ts`(runVerify·parseBinding — `::test`/`::file` end-anchored)·`src/junit.ts`(zero-dep JUnit 리더).
- **케이스 검증 바인딩** — spec 케이스에 `::test <테스트명>`/`::file <경로>` 접미사. `::file`은 cwd 컨테인먼트 + lstat 심링크 거부.

### Notes
- **fail-open → unverifiable** — 게이트 failOpenVerdict(pass)를 절대 복사하지 않는다. 검증 실패 시 'pass'가 아니라 '모름'을 보고해 거짓 확신을 막는다(사다리 핵심 가드). 미해결 후보는 defer *제안만*(자동 등록 안 함).
- 문서 정체성 현행화: "구현 전 게이트" → "계획↔구현↔검증".

## [0.4.2] - 2026-06-26

> (소급 기록 — 발행 당시 CHANGELOG 누락, 0.5.4 릴리즈메타 정비에서 보충. 정본 상세는 PR #19)

며칠 지난 완료 spec 케이스가 새 작업단위에서 형제로 부활해 침묵누락 오탐을 내던 defer-spec 드리프트 근본수정. 근본원인 = 작업단위 **"완료" 이벤트 부재**(`.gbc/spec.md`가 append 전용 누적 — 경계는 specHash 시작 트리거뿐, 정리는 수동 spec clear 하나).

### Added
- **`gbc done` — 작업단위 명시 종료** — spec 본문 아카이브(`.gbc/spec.archive/`) → 비움 + 게이트 리셋(gate reset 로직 불변).

### Fixed
- **resolved defer → judge `[이미 완료된 항목]` 블록 전달** + GATE_SYSTEM 제외규칙 — 과거 완료 케이스를 침묵누락으로 재플래그(re-flag)하는 오탐 차단.
- **spec/defer 중복등록 감지** — 정규화 동일 케이스 skip(resolved 재등록은 허용).

### Notes
- DEFER_PROTOCOL·gate SKILL.md·help에 완료 규약 발화.

## [0.4.1] - 2026-06-25

게이트 운영 현황을 한 곳에서 조회·해석하는 읽기전용 관측 스킬을 추가한다. 0.4.0이 깐 운영층 명령들(`metrics --all`·`repos list`·`gate snapshot`)이 세션 안에서 발견가능성(discoverability)이 없어 매번 외워 치거나 요청해야 했던 갭을 메운다.

### Added
- **`/gbc-monitor` 스킬 — 운영 현황 관측** — `gbc status`·`gbc metrics --all`·`gbc repos list`·`gbc gate snapshot status`를 묶어 조회하고, 숫자가 정상/주의/행동필요 중 무엇인지 **해석**한다(예: `repos ✗부재`=게이트가 조용히 죽은 상태 → `gbc init` 재실행 안내, `M1 churn`=약신호 proxy라 결함 수로 과대해석 금지, 빈 spec 차단=버그 아닌 정상 동작). 단순 명령 별칭이 아니라 4개 묶음 + 판정이 가치다. `gbc init`이 `/gate`·`/gbc-mute`와 함께 설치한다.

### Notes
- **읽기전용 경계** — `/gbc-monitor`는 관측하고 액션을 *가리킨다*, 직접 실행하지 않는다. 판정 기준은 "그 명령이 상태를 바꾸거나(mutate) API를 쓰는가?" — 그렇다면 `/gate`의 영역(미루기·리셋·캡처 토글·`snapshot replay`). 이 분리 덕에 모니터링은 부작용 걱정 없이 언제든 안전하게 부를 수 있다.
- **재init 필요** — 새 스킬이 추가됐다. 설치된 프로젝트는 `gbc update`(또는 `npm i -g geobuke-code@latest && gbc init --yes`)로 갱신한다.

## [0.4.0] - 2026-06-25

도그푸딩으로 검증한 게이트 운영층 5기능을 한 번에 발행한다. 멀티에이전트 시너지 검토(install-safe·12후보→5생존)로 "현재 하네스와 충돌 없이 도그푸딩 가능 + 게이트와 상승효과"를 만족하는 기능만 선별했다. 전부 기존 `.gbc/`·`~/.gbc/` 네임스페이스에만 쓰고 공유 `.claude/settings.json`은 건드리지 않는다(install verdict=safe).

### Added
- **`gbc gate review` — 누락 케이스 일괄 분류 (A1)** — 게이트가 차단하며 도출한 형제 케이스(`missing[]`)가 그동안 차단 사유 문장으로만 평탄화돼 사라졌다. 이제 `.gbc/pending-review.json`에 구조 보존되어, `gbc gate review`로 번호 체크리스트를 보고 `gbc gate review --spec <번호|텍스트|all> --defer <번호|텍스트|all>`로 한 번에 승인(→spec.md)/미룸(→defer)으로 분류한다(겹치면 spec 우선). 케이스가 여럿일 때 `gbc spec add`/`gbc defer add`를 반복할 필요가 없다.
- **`gbc init` 크로스-repo 레지스트리 자동등록 (B0)** — `gbc init` 시 현재 repo를 `~/.gbc/repos.json`에 멱등 자동등록한다(0.2.9가 깐 레지스트리가 비어 dormant이던 결함 충전). opt-out: `gbc init --no-register`.
- **`gbc repos list` 게이트 건강성 롤업 (B1)** — 각 등록 repo의 `.claude/settings.json`을 읽어 게이트 hook 부재(`⚠️게이트hook부재`)·SessionStart hook 누락(`⚠️SessionStart누락`)을 표시한다("회사 repo에서 게이트가 조용히 안 먹는다"를 한 명령으로 진단). 검사 대상은 hook **등록 여부**뿐 — 명령 freshness는 각 repo 설치경로가 달라(cliPath 의존) 크로스-repo로는 false-positive라 검사하지 않는다(각 repo `gbc status`로 확인).
- **`gbc metrics --all` 교차-repo 집계 (B2)** — 등록된 repo들의 `events.jsonl`을 병합 집계한다. 병합 시 각 이벤트의 `specHash`를 repo 경로로 태깅해 repo간 boilerplate 명세 해시 충돌을 막는다(태깅 없이 합치면 한 repo의 통과 뒤 다른 repo의 변이가 M1 churn으로 오집계; M2/M3는 세션 UUID 키라 원래 안전). symlink 등록 경로는 거부.
- **`gbc gate snapshot` 판정 드리프트 회귀락 (A2)** — 게이트 판정(LLM haiku)을 골든셋으로 캡처(`snapshot on`)해두고, 모델/프롬프트/SDK 변화 후 `snapshot replay`로 재판정해 pass↔block 뒤집힘(드리프트)을 잡는다. 하드 신호는 판정 뒤집힘만(하나라도 있으면 exit 1) — `missing[]` 변화는 LLM 자유서술이라 정보용. replay는 `temperature 0`으로 재판정(핫패스 게이트는 불변), `--samples N`(홀수 강제) 모달로 잔여 비결정을 흡수한다.

### Notes
- **드리프트 회귀락은 로컬 전용(privacy)** — `golden.json`은 정규화된 **편집 본문**을 담는다(`events.jsonl`이 불변식으로 절대 저장하지 않는 내용). `.gbc/`는 gitignore이므로 로컬 드리프트 점검이지 커밋되는 CI 스위트가 아니다. 캡처는 opt-in이며, judge가 실제 평가한 cache-miss 편집만 기록된다(cached-skip·fail-open 제외).
- **재init 필요** — A1이 PreToolUse hook 출력(차단 사유에 `gbc gate review` 안내)과 펜딩 기록 동작을 확장하고, 새 스킬 명령이 추가됐다. 설치된 프로젝트는 `gbc update`(또는 `npm i -g geobuke-code@latest && gbc init --yes`)로 갱신한다.
- **경계 재정의** — 게이트 심화·크로스-repo 조정은 B-커널(hook-게스트)에서 도그푸딩 가능하므로 B로 귀속하고, A(public)는 standalone TUI + 엔진 래핑 + 진짜 사후대조 M1로 순수화했다.

## [0.3.0] - 2026-06-24

### Fixed
- **업데이트 안내 가시성 갭 — 통과된 작업단위에서도 배너 노출** — 평상 작업은 대부분 "이미 게이트 통과한 작업단위"(cached-skip)라, 그 경로가 `maybeUpdateNotice`를 호출하지 않고 즉시 통과하던 탓에 **보이는 배너(PreToolUse `systemMessage`)가 거의 안 떴다**(SessionStart 안내는 모델 컨텍스트로만 주입돼 사용자 화면 배너가 아님). cached-skip 경로에도 업데이트 안내를 emit하도록 수정 → **매 세션 첫 편집에 배너 1회**(세션당 dedup). `permissionDecision` 없이 `systemMessage` 단독이라 통과 동작은 불변, 네트워크 없음(캐시만 읽음). 이제 신버전·재init 안내를 보려고 `gbc gate reset`을 칠 필요가 없다.

### Added
- **캐시 자동 refresh (judge 경로 piggyback)** — 사용자가 `gbc status`를 직접 치지 않아도 신버전 캐시가 최신이 되게, PreToolUse가 judge를 도는 편집(cache-miss)에서 버전 캐시가 stale이면 `refreshVersionCache()`를 **judge와 병렬로** 시작한다. judge가 네트워크·≥1.5s라 refresh는 그 안에 끝나 **편집 지연 0**이고, 같은 편집의 안내가 갱신된 캐시를 즉시 반영한다. 갱신은 24h TTL당 1회. `shouldRefreshCache` 순수 술어 신설(`GBC_NO_UPDATE_NOTICE=1`이면 비활성).

### Notes
- **핫패스(cached-skip)에는 네트워크를 절대 넣지 않는다** — refresh는 judge가 도는 비-핫패스에서만 병렬로 건다(0.2.7 "hook 핫패스 동기 네트워크 금지" 원칙 보존).
- **검토 후 제외한 self-heal**: PreToolUse가 SessionStart hook 누락 시 `.claude/settings.json`을 자동 보정하는 안은, CC 공식 문서가 "Hooks cannot modify persistent configuration files"로 명시한 설계 원칙에 어긋나 채택하지 않았다. 대신 cached-skip 배너에 실리는 init-staleness 안내가 `gbc update`(CLI 갱신 + `gbc init --yes`로 SessionStart hook 복구)를 안정적으로 유도한다.
- **소급 적용 아님**: 이 동작은 0.3.0 이상 머신에서만 효과. 구버전(SessionStart hook 미등록 코호트)은 1회 `gbc update`로 최신화해야 자동 refresh 채널이 복구된다.
- 새 hook 명령이 아니라 기존 PreToolUse hook의 동작 확장이므로 **재init 불필요**(설치된 프로젝트는 CLI 갱신만으로 반영).

## [0.2.9] - 2026-06-24

### Added
- **크로스-repo defer 가시성** — 세션 진입(SessionStart) 시 현재 repo의 미해결 defer 상세에 더해, **등록된 다른 repo들의 미해결 defer 요약**을 한 줄로 환기한다(`🌐 타 repo 미해결: dev-note 진행중1·미착수1 · fa-support 미착수1`). 여러 repo를 오가며 작업할 때, 다른 repo에 걸린 미완 작업을 그 repo를 열지 않고도 인지한다.
- **`gbc repos add|remove|list`** — 크로스-repo 레지스트리 관리. 글로벌 `~/.gbc/repos.json`에 감시 대상 repo를 등록한다(`add` 경로 생략 시 현재 폴더). `list`는 각 repo의 미해결 defer 수·gbc 설치 여부를 표시.

### Notes
- 크로스-repo 요약은 **카운트만** 표시한다 — 번호 매긴 상세 리스트는 현재 repo에만(번호가 `gbc defer <N>` 인덱스 ref와 cwd 기준으로 묶이므로, 타 repo에 번호를 주면 ref가 깨진다).
- **SessionStart에서만** 환기한다(매 대화 종료 Stop 리마인드엔 미첨부 — 노이즈 방지). 현재 repo·미해결 0건 repo는 요약에서 제외. 끄려면 `GBC_NO_CROSS_REPO=1`(또는 세션 힌트 전체 `GBC_NO_SESSION_HINT=1`). 등록 경로 부재·읽기 실패는 repo별 조용히 무시(fail-silent).
- 새 hook이 아니라 기존 SessionStart hook의 출력 확장이므로 **재init 불필요**(설치된 프로젝트는 CLI 갱신만으로 반영). 감시하려면 `gbc repos add`로 레지스트리만 시드.

## [0.2.8] - 2026-06-23

### Fixed
- **dev placeholder hook을 stale로 오판하던 false-positive 수정** — `gbc init`이 `${CLAUDE_PROJECT_DIR}/dist/cli.js` placeholder로 설치한 hook을, 런타임 절대경로와 글자가 다르다는 이유만으로 "구식"으로 판정해 매 세션 `gbc init --yes` 재실행을 헛권하던 버그(geobuke-code 자기 repo 도그푸딩에서 실제로 발현). `hasStalePreToolUse`(read-time)·`normalizeHooks`(write-time)가 절대경로와 placeholder **두 정식 형태를 모두 인정**하도록 `canonicalPreCommands` 공통 기준 도입. 진짜 구식(옛 bash 키주입) 감지는 유지.

### Added
- **`gbc init --dev`** — hook 명령에 절대경로 대신 `${CLAUDE_PROJECT_DIR}/dist/cli.js` placeholder를 굽는 opt-in 플래그. dist 위치가 옮겨다니는 클론(자기 repo 도그푸딩)에서도 hook이 안 깨진다. **기본(플래그 없음)은 절대경로 유지** — npm 전역·외부 도그푸딩 등 일반 동작은 완전 불변. `stopCommand`/init 프리뷰도 선택된 경로를 반영.

## [0.2.7] - 2026-06-23

### Added
- **`gbc update [--dry-run]`** — `npm i -g geobuke-code@latest`로 CLI를 갱신하고, 현재 폴더가 `.gbc`를 가지면 새 바이너리로 `gbc init --yes`까지 수행하는 명령. (무음 자동 업데이트는 네트워크 차단·EACCES 권한·핫패스 fail-silent 철학·갱신 채널 소유 문제로 채택하지 않음.)

### Changed
- **신버전 안내 표시 지연 제거** — `runSessionStart`가 stale 캐시일 때 *표시 전에* 버전 캐시를 선행 refresh(≤1.5s, fail-silent)해, 신버전이 다음 세션이 아니라 그 세션에 즉시 노출된다. stale일 때만(24h당 1회) 발생.

## [0.2.6] - 2026-06-22

### Added
- **defer Stop 리마인드 음소거** — `gbc defer mute`/`gbc defer unmute`와 별도 `/gbc-mute` 스킬. 미해결 defer가 있을 때 매 대화 종료(Stop hook)마다 강제 노출되던 리마인드를 토글로 끈다. **Stop 채널만** 끄고 SessionStart(startup|resume) 진입 알림은 유지. 음소거 상태는 `.gbc/config.json`에 영속(`gate reset`이 푸는 `state.json`과 분리)되어 새 defer 추가·세션 교체에도 유지된다. 상태는 SessionStart 줄·`gbc status`·`gbc defer list` 3곳에 표면화.

## [0.2.5] - 2026-06-22

### Added
- **defer 3-상태 수명주기 (open / in_progress / resolved)** — 기존 2-state(등록/해소)를 3-state로 확장. 착수했지만 미종결인 항목이 "진행중"으로 구분돼, SessionStart·Stop 리마인드가 `진행중 N · 미착수 M`으로 표면화한다(착수한 채 잊히는 것 방지).
  - 신규 명령 `gbc defer start <ref>`(open→진행중)·`gbc defer reopen <ref>`(→open). `gbc defer resolve`는 복수/`all` 전환 지원(반환 `DeferEntry[]`). `ref = 번호 | 텍스트 | all`, 복수 인덱스(`2 3`)·부분텍스트·전환별 적격 처리.
  - **gate-neutral**: judge 입력은 open+in_progress(미해결 전부) — 차단 로직은 2-state와 **동일**하게 유지. resolved만 판정에서 제외.
- **자연어/편집대상 감지 기반 백그라운드 전환** — 사용자가 `gbc defer …`를 직접 칠 필요 없이, 에이전트가 대화·편집 대상을 감지해 전환을 실행하고 표면화한다. 전환 행동 규약을 SessionStart/Stop hint 문자열에 임베드(매 세션 컨텍스트에 규약을 주입하는 결정론적 채널).

### Changed
- **resolve = 항상 사람의 명시 선언** — judge가 편집을 보고 resolve를 추론하지 않는다. 모호한 완료 신호는 resolve하지 말고 사용자에게 확인(resolved 항목은 리마인드에서 사라지므로 잘못 resolve하면 미완성인 채 잊힘). start만 편집 감지로 자동(보수적·실착수 시만).

### Fixed
- **hint 번호 ↔ CLI 인덱스 정합** — SessionStart/Stop 리마인드가 미해결 부분집합을 1..N으로 번호 매기던 것을, `gbc defer list`·인덱스 ref와 동일한 **전체-리스트 인덱스**로 통일. resolved 항목이 앞에 있을 때 표시 번호 ≠ 실제 인덱스가 되어 `start <표시번호>`가 엉뚱한(되살아난) 항목을 치던 버그 수정.

### Internal
- 옛 `{resolved:bool}` 데이터는 읽을 때 `status`로 자동 승격(저장은 `status` 단일 소스). 기존 데이터 판정 결과 불변(`resolved:true`→제외, `false`→open→포함). 영향 파일: `types.ts`·`defer.ts`·`cli.ts`·`hook.ts`·`metrics.ts`·`skills/gate/SKILL.md`.

## [0.2.4] - 2026-06-22

### Changed
- **`gbc status`에서 신버전 업데이트 나그 제거 (A)** — `cmdStatus`가 `buildVersionNotice`를 직접 호출해, 명시 진단 명령인 `gbc status`에도 신버전 안내가 노출되던 의도 이탈 수정. 업데이트 안내(①신버전/②init-staleness)의 자리는 **SessionStart·PreToolUse 자동 채널 전용**이다. 부수효과로 `gbc status`의 `GBC_NO_UPDATE_NOTICE` opt-out 누수도 닫힘. 버전 캐시 stale-refresh(SessionStart seed 신선도 목적)와 설치 버전 표시 줄은 유지.

### Docs
- **corporate Windows keyless 주의 (W3 검증 결과)** — `claude.exe`가 EDR·보안정책에 막히는 환경에선 키 없는 `claude -p` 폴백이 실패해 게이트가 조용히 fail-open(OFF)되므로, `ANTHROPIC_API_KEY` 설정으로 CLI spawn을 우회해 게이트를 유지하도록 README에 명시. **집 native Windows 검증 결과 W3 코드는 정상**(keyless에서 게이트가 fail-open 없이 LLM block 판정까지 정상 수행) — 회사 증상은 환경(EDR/정책의 `claude.exe` 차단) 탓으로 확인되어 코드 변경 불필요.

## [0.2.3] - 2026-06-22

### Added
- **업데이트 안내 (①신버전 / ②init-staleness)** — CC 본체의 신버전 notice처럼, gbc도 갱신이 필요하면 안내한다. 두 신호를 분리한다:
  - **②init-staleness(결정론적·네트워크 없음)**: 프로젝트 `.claude/settings.json`의 hook 상태로 판단 — SessionStart hook 미등록(0.2.1 이하 init) 또는 PreToolUse 명령 구식이면 `gbc init --yes` 재실행을 안내. 버전 숫자가 아니라 **실제 hook 상태**로 판단해 정말 필요한 프로젝트만 알린다.
  - **①신버전(캐시 비교)**: `~/.gbc/version-check.json` 캐시에 npm 최신 버전을 두고 설치 버전과 비교만 한다. 갱신은 hook 핫패스가 아닌 안전 지점(SessionStart 출력 후·`gbc status`)에서 `fetch`(1.5s 타임아웃, spawn 아님)로만 — **PreToolUse 게이트 경로엔 동기 네트워크 없음**.
  - **채널**: PreToolUse(cache-miss, 세션당 1회 `systemMessage`) + SessionStart + `gbc status`. PreToolUse 경로를 쓰는 이유 — 안내가 필요한 "설치만 하고 init 안 한" 코호트는 SessionStart hook이 아예 없어 그 채널로는 도달 못 하기 때문(전 코호트 도달).
  - `GBC_NO_UPDATE_NOTICE=1` opt-out. 조회 실패·타임아웃은 조용히 무시(fail-silent) — **안내 실패가 게이트 결정에 절대 영향 없음**. `gbc status`에 설치 버전 표시 추가.

### Changed
- **native Windows `claude -p` 폴백 지원 (W3)** — 키 없는 native Windows에서 `claude.cmd`(배치 shim)를 Node 18+가 셸 없이 spawn 못 하던(CVE-2024-27980 ENOENT→fail-open) 한계 해소.
  - win32에서만 `spawn(..., { shell: true })` 분기. **POSIX(WSL/Mac/Linux) 경로는 byte-for-byte 불변**(검증된 회귀 8/8 보존) — 위험을 미검증 플랫폼에만 격리.
  - **인젝션 회피**: shell 경로에서 system+user 프롬프트를 argv가 아닌 **stdin**으로 합쳐 전달 → argv는 고정 플래그뿐이라 셸 메타문자 인젝션 표면이 없음. `GBC_MODEL`은 `safeModel`로 화이트리스트(`[\w.-]+`) 검증. **kill-timeout(30s)** 추가로 무응답 stdin이 PreToolUse를 무한 차단하는 것(ENOENT보다 나쁜 케이스)을 fail-open으로 강제.
  - stdin 결합 방식의 판정 품질 동일성은 WSL `claude -p` 실측으로 검증. win32 *실행*은 회사 머신 사용자 검증 대상(단위 테스트 절대제외 — 외부 CLI·플랫폼).
- **`GBC_SPEC_FILE` 경로 해석 (W1)** — 상대경로를 hook 프로세스 cwd가 아닌 **프로젝트 cwd 기준**으로 `path.resolve`(정확성 수정). cwd 밖을 가리키면 **차단이 아니라 경고만**(stderr) — `GBC_SPEC_FILE`은 0.2.2에서 의도한 escape-hatch라 cwd 밖 공유 명세를 명시 지정하는 정당 용례를 보존.

### Internal
- **케이스 정규화 단일화 (W2)** — `gbc spec add`만 적용하던 케이스 정규화(trim·줄바꿈→공백·길이상한)를 `src/text.ts` `normalizeCase`로 추출해 `gbc defer add`에도 적용. spec/defer 비대칭(같은 입력을 한쪽만 정규화하던 것) 제거.

## [0.2.2] - 2026-06-22

### Fixed
- **빈 명세 캐시 게이트 영구 우회** — 빈 `.gbc/spec.md`에서 judge가 사소한 편집을 `[1단계]`대로 올바르게 pass한 결과가 빈 문자열 해시(상수 `e3b0c44…`)로 작업단위 캐시(`markGated`)에 들어가면, 명세가 비어 있는 한 해시가 안 바뀌어 `isGated`가 영원히 hit → 동작 편집까지 judge 없이 통과해 게이트가 교차세션으로 무력화되던 결함.
  - `runPreToolUse`: 빈 명세는 캐시 **read**를 건너뛰고(`!specEmpty && isGated`) 항상 재판정 → 기존에 오염된 `state.json`도 자동 무시(self-healing). pass 분기는 fail-open을 먼저 분기해 빈-spec 정상 pass의 오라벨 방지. `shouldCacheVerdict(verdict, specEmpty)`로 빈 명세 pass는 캐시 **write**도 금지.

### Changed (breaking)
- **시나리오 명세 단일 정본화** — `loadPlanSpec`이 더 이상 `scratch.md`를 명세 소스로 자동 폴백하지 않는다. 명세 소스는 `$GBC_SPEC_FILE` > `.gbc/spec.md`만.
  - **이유**: `scratch.md`는 흔히 하네스의 세션 진행추적 파일이라, 그 진행 노트를 시나리오 명세로 오인해 "시나리오 미지정" 차단을 건너뛰는 **거짓음성**이 발생했다. gbc가 소유하지 않은 파일을 추측 폴백하던 것이 모호성의 원천.
  - **마이그레이션**: `scratch.md`를 명세로 쓰던 사용자는 (a) 내용을 `.gbc/spec.md`로 옮기거나 `gbc spec add`로 등록, 또는 (b) `GBC_SPEC_FILE=scratch.md`로 명시 지정. 기능 손실 없음 — magic 폴백이 explicit 지정으로 바뀐 것.

### Added
- **세션 진입 잔여 defer 알림** — SessionStart hook(`gbc hook session-start`)이 세션 시작·재개 시 `.gbc/defers.json`의 미해결 항목을 표면화한다. 잔여 없거나 `GBC_NO_SESSION_HINT=1`이면 무출력. `.gbc/`만 읽어(scratch/메모리 미접근) 다른 하네스와 컨텍스트 혼재·환각 없음.
  - `gbc init`이 SessionStart hook을 `matcher: "startup|resume"`로 멱등 등록(compact마다 반복 안 함). 기존 설치는 `gbc init --yes` 재실행으로 추가.

## [0.2.1] - 2026-06-22

### Changed
- **크로스플랫폼 키 해석** — API 키를 셸 주입이 아니라 **gbc 코드가 직접 읽는다**(`resolveApiKey`: `ANTHROPIC_API_KEY` env > `~/.gbc/api-key` 파일, `.trim()` 적용).
  - hook 명령이 셸 무관 순수 형태(`node "<path>" hook pre-tool-use`)로 단일화 → native Windows(cmd.exe)/bash/zsh/Mac에서 **동일 명령** 동작. PowerShell 래퍼의 알려진 버그(키보드 입력 비활성화·stdio 행) 회피.
  - `buildPreCommand`에서 bash 전용 키주입 분기·`shDquote` 백슬래시 이스케이프 제거(Windows 경로 `C:\...` 보존). cliPath는 설치 경로(사용자 입력 아님)라 인젝션 위험 없음 + settings 기록은 `JSON.stringify`가 이스케이프 담당.
  - `gbc init`이 기존 hook(keyless·옛 bash 키주입)을 pure 명령으로 정규화(`normalizeHooks`, 멱등). 기존 설치는 `gbc init --yes` 재실행으로 이관.

### Note
- **기존 설치 무중단**: 옛 bash-prefix 명령도 새 코드에서 그대로 동작한다(resolveApiKey가 env 우선이라 셸 prefix가 세팅한 env를 읽음). 재-init은 "셸 무관 동일 명령" 미관 목적이며 기능상 필수 아님.
- **native Windows 한계**: `claude -p` 폴백은 `claude.cmd` 배치 shim을 셸 없이 실행 못 해 fail-open될 수 있음 → Windows에선 API 키 파일 사용 권장. 폴백 자체의 Windows 지원은 후속(`judgeViaCli` shell 분기, 인젝션 주의로 별도 스코프).
- 로직 + Linux/WSL 실행 실증 완료(api 경로·init 마이그레이션). **native Windows 실행은 회사 머신에서 사용자 검증 필요**.

## [0.2.0] - 2026-06-21

### Added
- **계측 레이어 (M1~M3)** — 게이트 결정을 `.gbc/events.jsonl`(append-only, 메타데이터만)에 기록.
  - `gbc metrics [--json]` 명령 — M1~M3 집계 리포트.
  - **M2**(게이트 적중 vs 도중발견) 강신호, **M3**(작업단위당 편집 반복) proxy, **M1**(통과 후 churn) 약신호. 진짜 M1(사후 대조)은 후속 A 모드 영역임을 출력·문서에 명시.
  - `GBC_NO_METRICS=1` opt-out. 이벤트 라인 4KB 캡(O_APPEND atomic), 코드 본문 미기록.
  - hook stdin의 `session_id`를 작업단위 그룹핑 키로 사용(공식 hook 스키마).
- npm 배포 스크립트 `scripts/publish.sh` (`npm run release`) — `npm_token.txt`에서 토큰을 읽어 1회성 인증으로 publish(영속 .npmrc/전역 config 미생성).

### Fixed
- M1 churn이 **빈 spec(상수 해시) 작업단위에서 교차세션 합산되던 결함** — `specHash=""` 센티넬로 빈-스펙 작업단위를 churn 집계에서 제외.

## [0.1.0] - 2026-06-21

### Added
- **B-커널 게이트** — Claude Code PreToolUse hook으로 구현 직전 침묵 누락·시나리오 미지정 차단.
- defer-registry(`gbc defer`), 명세 저장소(`gbc spec`), 작업단위 1회 캐시, 시나리오 도출 루프.
- 이중 트랜스포트(직접 haiku API / `claude -p` 폴백), fail-open 강화(캐시 제외·`systemMessage` 경고·`failopen.log`).
- `gbc init` — 프로젝트 로컬 hook 설치(머지·백업·멱등), API 키 주입 자동화 + keyless hook 업그레이드.
- 최초 npm 발행.

[0.6.1]: https://github.com/cubha/geobuke-code/releases/tag/v0.6.1
[0.6.0]: https://github.com/cubha/geobuke-code/releases/tag/v0.6.0
[0.5.5]: https://github.com/cubha/geobuke-code/releases/tag/v0.5.5
[0.5.4]: https://github.com/cubha/geobuke-code/releases/tag/v0.5.4
[0.5.3]: https://github.com/cubha/geobuke-code/releases/tag/v0.5.3
[0.5.2]: https://github.com/cubha/geobuke-code/releases/tag/v0.5.2
[0.5.1]: https://github.com/cubha/geobuke-code/releases/tag/v0.5.1
[0.5.0]: https://github.com/cubha/geobuke-code/releases/tag/v0.5.0
[0.4.2]: https://github.com/cubha/geobuke-code/releases/tag/v0.4.2
[0.4.1]: https://github.com/cubha/geobuke-code/releases/tag/v0.4.1
[0.4.0]: https://github.com/cubha/geobuke-code/releases/tag/v0.4.0
[0.3.0]: https://github.com/cubha/geobuke-code/releases/tag/v0.3.0
[0.2.9]: https://github.com/cubha/geobuke-code/releases/tag/v0.2.9
[0.2.8]: https://github.com/cubha/geobuke-code/releases/tag/v0.2.8
[0.2.7]: https://github.com/cubha/geobuke-code/releases/tag/v0.2.7
[0.2.6]: https://github.com/cubha/geobuke-code/releases/tag/v0.2.6
[0.2.5]: https://github.com/cubha/geobuke-code/releases/tag/v0.2.5
[0.2.4]: https://github.com/cubha/geobuke-code/releases/tag/v0.2.4
[0.2.3]: https://github.com/cubha/geobuke-code/releases/tag/v0.2.3
[0.2.2]: https://github.com/cubha/geobuke-code/releases/tag/v0.2.2
[0.2.1]: https://github.com/cubha/geobuke-code/releases/tag/v0.2.1
[0.2.0]: https://github.com/cubha/geobuke-code/releases/tag/v0.2.0
[0.1.0]: https://github.com/cubha/geobuke-code/releases/tag/v0.1.0
