# 0.6.1 스코프 확정용 사전감사 보고서 — A(1.0.0) 이전 잔여 전수

> 분석일: 2026-07-06
> 프로젝트: geobuke-code (거북이코드, npm 0.6.0)
> 분석 관점: A(1.0.0) 착수 이전에 정리해야 할 잔여 기술부채·보안 하드닝·결함 전수 도출 (0.6.1 스코프 확정). 외부 리서치 생략(--no-research 상당), 코드베이스 감사 중심.
> 방법: 에이전트 3병렬 — 구조 탐색(Explore very-thorough) · 아키텍처(code-explorer, evaluateGate 추출 관점) · 품질/보안(code-reviewer, HIGH confidence만)

---

## 1. 프로젝트 개요

- **목적**: Claude Code 계획↔구현↔검증 게이트. PreToolUse 구현-전 차단 + Stop scope 사후판정 + `gbc verify` 사후 결과검증 사다리.
- **스택**: TypeScript(ESM/NodeNext, strict) · node:test(단위 234) · 런타임 의존성 `@anthropic-ai/sdk` 1개(핫패스 lazy 격리 = 핫패스 zero-dep 유지) · node>=20.
- **완성도**: B-라인 기능 완결(0.6.0), 소스 내 정통 TODO/FIXME **0건**. 미완결은 설계문서 비목표 섹션·타입 주석(future work)·한계 주석으로 규율 관리됨.

## 2. 아키텍처 평가 (A1 추출 관점)

| 항목 | 평가 | 근거 |
|---|---|---|
| 레이어 분리 | 높음 | process.exit/stdin은 cli.ts·hook.ts에만. judge.ts는 types만 의존하는 리프(판정 코어 이미 순수) |
| 패턴 일관성 | 보통 | lstat 심링크 거부·Array.isArray 가드·safeModel이 지점별로 **선택적 적용** — 표준 패턴이 있는데 미적용 잔존지점 존재 |
| 확장성(A1 대비) | 보통 | hook.ts가 10+ 모듈 import하는 갓 모듈. 부수효과 다발(logEvent·markGated·enqueueScope·pendingReview)이 판정 분기에 인라인 |
| 테스트 가능성 | 높음 | 234 단위 + 골든 replay 28. 단 runRunnerCommand(실행기)는 커버 0 |

- **순환 의존 없음**, DAG 유지. `cli.ts → hook.ts → (상태 모듈들) → store.ts`.
- **fail-open 비대칭(구조적)**: judge 실패는 failOpenVerdict로 정직 흡수되나, `store.ts` mkdirSync/writeFileSync(gbcDir·writeJson)는 무방비 → 디스크/권한 실패 시 uncaught → main().catch exit(1). PreToolUse 계약상 exit 1은 비차단이라 fail-open이긴 하나 **비정형 fail-open**(failopen.log·systemMessage·계측 전부 누락).
- **env 읽기 산개**: 순수 모듈 6개(judge·spec·metrics·notice·version·run)가 process.env 직접 읽기. 그중 **judge.ts MODEL/SCOPE_MODEL/VERIFY_MODEL 3개만 모듈 로드시점 상수** — 현 CLI(프로세스 매회 신규)에선 무해하나 A-모드 in-process 장수 프로세스에서 세션 중 변경 미반영 잠복버그.

## 3. 기술 부채 & 리스크 — 0.6.1 후보 전수 인벤토리

### 코드 결함·하드닝 (R# = 0.6.1 실행 항목 후보)

| # | 항목 | 심각도 | 위치 | 공수 | 설명 |
|---|---|---|---|---|---|
| R1 | API 경로 safeModel 미적용 | 🟡 | judge.ts:206·566 | 소 | CLI 경로만 safeModel. API 경로는 오설정 env가 그대로 전달→SDK 거부→fail-open pass로 **원인 은폐**(트랜스포트 의존 동작 비대칭). 인젝션 아님(JSON body) |
| R2 | scope 자기파일 비교 lexical resolve | 🟢 | scope.ts:213-216 | 소 | realpath 아님 → 심링크 소스(모노repo 링크)에서 자기정의를 타파일로 오분류, 축A/rung2 정밀도 저하. 비차단 권고 경로라 보안경계 아님. realpathSync+fallback |
| R3 | loadDefers 형상 가드 부재 | 🟡 | defer.ts:30-32 (근원 store.ts readJson) | 소 | defers.json이 valid-JSON-비배열이면 .map throw→비정형 fail-open **매 편집 반복**(관측성 침묵 열화). scope.ts:38·repos.ts:17은 Array.isArray 가드 적용, defer·golden.ts:78·review.ts:20은 미적용 — `readJsonArray` 변형으로 근원 통일 권장 |
| R4 | MODEL 3상수 호출시점 파라미터화 | 🟡 | judge.ts:7·13·19 | 소~중 | 모듈 로드시점 고정 → A-모드 장수 프로세스 잠복버그. R1과 동일 지점이라 동시 처리 시너지 |
| R5 | buildCrossRepoHint 이중 syscall | 🟢 | hook.ts:599 | 소 | existsSync+lstatSync 분리 = 자기 프로젝트가 W1에서 폐기한 TOCTOU 패턴 잔존. cli.ts:747·872의 단일 lstat try/catch 표준으로 통일 |
| R6 | spec.ts 핫패스 console.error | 🟢 | spec.ts:28 | 소 | 순수 모듈의 유일한 stderr 직출력(GBC_SPEC_FILE cwd 밖 경고). in-process 콜백에서 스트림 오염 — 반환값/경고 필드로 순수화 |
| R7 | store.ts fail-open 정형화 | 🟡 | store.ts:7·21 | 중(설계결정 포함) | gbcDir mkdirSync·writeJson writeFileSync try/catch 감싸 "I/O 인프라 실패도 정형 fail-open(failopen.log+계측)" 통일 여부 결정. SDK in-process에선 uncaught 의미가 hook exit와 달라 피벗 전 결정 안전 |
| R8 | runRunnerCommand 테스트 0 | 🟢 | run.ts (test 갭) | 소 | 코드베이스 유일 의도적 셸 실행 경로가 무커버. echo/true 스모크+timeout-kill+비0 exit 3케이스 |
| R9 | 업데이트 안내 판정분기 분리 | 🟢 | hook.ts:216·246·325·371 | 중 | maybeUpdateNotice가 4분기 교차 삽입 — 직교 관심사 분리 시 A1 추출 대상 함수 대폭 축소. 위험 낮은 선행 리팩터 |

### 확인 후 비채택 (재제안 방지)

- **buildPreCommand 가드(K3)**: 호출부 2곳 모두 fileURLToPath 유래 CLI_PATH 또는 고정 상수 — 공격자가 npm 설치 경로 통제 전제 = 이미 더 강한 프리미티브 보유. 문서화된 수용 리스크로 종결(코드 주석 기존재). A4 하드닝에서 재평가만.
- **npm_token.txt**: .gitignore:19 등재+커밋 이력 0+npm files[]=dist,skills라 발행물에도 미포함 — 비노출 확정.
- **run.ts kill 트리 한계**: DESIGN 문서에 문서화된 수용 한계 유지.
- **PostToolUse ask-캡처**: A-라인 이관 확정(2026-07-06 결정, [[project_0_6_1_plan]]).

### 로컬 위생 (릴리스 무관, 세션 내 정리 가능)

- `.claude/settings.json.bak-*` 10개 누적 · `.claude/skills/`↔`skills/` 중복 보유(제품 소스는 skills/가 정본) — 정리해도 npm 발행 불필요.

## 4. 개선 로드맵

### 즉시 개선 = 0.6.1 스코프 (Quick Win, 전부 hook 계약 무변경=재init 불요)
- [ ] R1+R4: judge.ts 모델 처리 일원화 — 3상수 호출시점화 + API 경로 safeModel [TDD]
- [ ] R3: readJsonArray 도입 — defer/golden/review 형상 가드 통일 [TDD]
- [ ] R2: scope 자기파일 realpath 비교 [TDD]
- [ ] R5: buildCrossRepoHint 단일 lstat 표준화
- [ ] R6: spec.ts console.error 순수화
- [ ] R7: store.ts 정형 fail-open (설계 결정 선행)
- [ ] R8: runRunnerCommand 스모크 3케이스
- [ ] R9: 업데이트 안내 분기 분리 (A1 선행 리팩터)
- [ ] docs 2건(PR#29·#31) 발행 탑승 + version bump + CHANGELOG + /ship

### A1에서 수행 (0.6.1 아님 — 경계 명확화)
- evaluateGate 스코프 설계 결정("캐시/우회 포함 반순수" vs "verdict 매핑만 순수") = **A1 첫 결정**, 0.6.1로 당기지 않음(래퍼 구조 없이 결정 불가)
- PostToolUse ask-캡처 (in-process hook)

### 중장기 (A4 후보)
- CI 워크플로 부재(.github 없음) — 릴리스 수동 publish.sh 유지 중
- buildPreCommand 가드 재평가

## 5. 종합 판정

**0.6.1(기존 등록: safeModel+docs 탑승)만으로는 "A 이전 전체항목 완료"가 아니었다.** 본 감사로 신규 6건(R3~R9 중 기존 미등록분)이 추가 식별됐고, 전부 hook 계약 무변경·소~중 공수라 0.6.1 단일 릴리스에 수용 가능하다. R4·R6·R9는 A1 추출의 직접적 선행 정리라 0.6.1에서 소화하면 A1 스파이크가 순수하게 "추출+SDK 배선"만 남는다.

---

> 이 보고서는 Claude Code `/analyze` 스킬로 자동 생성되었습니다. (에이전트 3병렬 감사, 외부 리서치 생략)
