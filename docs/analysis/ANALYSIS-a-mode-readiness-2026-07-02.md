# A(100) v1.0.0 착수 준비도 분석 보고서

> 분석일: 2026-07-02
> 프로젝트: 거북이코드 (geobuke-code) v0.5.3
> 분석 관점: A(100) v1.0.0(standalone SDK Wrapper 피벗) 착수 전 아키텍처 준비도 — evaluateGate 순수코어 추출 가능성 · 판정 지점 3개(PreToolUse gate/Stop scope/verify) 결합도 · events.jsonl 조인 키 건전성 + 도그푸딩 계측 신호

---

## 0. 결론 요약 (TL;DR)

| 질문 | 판정 | 근거 |
|---|---|---|
| A-mode 투자 근거(계측) | **강함** | M2 게이트 적중 306 vs 도중발견 6(1.9%) — thesis 정량 실증. M1은 여전히 약신호(churn proxy)라 A2 사후대조가 유일 보완 |
| evaluateGate 추출 가능성 | **높음 — 경계 이미 그려짐** | 프로세스 결박은 hook.ts run* 래퍼 3개 + cli.ts 라우팅뿐. 순수 판정부(~70줄)+부수효과 5개를 `GateDecision` 효과-디스크립터로 분리 가능 |
| 판정 지점 3개 이식 난이도 | gate **상** · scope **중** · verify **하** | verify는 CLI 명령이라 SDK 무관 재사용. scope는 SDK Stop hook in-process 지원 확인됨. gate는 부수효과 5개 귀속 재설계 필요 |
| A2 조인 키(session_id+specHash) | **계획 전제에 반례 — 선행 패치 필요** | scope 이벤트 specHash="" 하드코딩(hook.ts:368) + CLI 이벤트 session="" → 현실적 조인 키는 session_id 단독 |
| SDK 와이어링 리스크(6/24 계획) | 3건 중 2건 **사전 해소** | settingSources 기본 미로드(이중발화 기본 격리) · BaseHookInput에 session_id/cwd 존재 확인 |

**착수 권고**: A1 스파이크 전에 **B-라인 소형 선행 패치(P0: 조인 키 충전 + fail-open 랩핑 + scope 경로비교 버그)**를 0.5.4로 처리하면, A-mode 사후대조가 소급 가능한 계측 위에 올라간다.

---

## 1. 도그푸딩 계측 신호 (2026-07-02 추출, 5 repo · 1743 events)

### A-mode 투자 근거
- **M2**: 게이트 적중(차단된 누락케이스) 306 vs 도중발견(defer) 6 → **도중발견 비율 1.9%** — 구현-전 게이트가 누락의 98%를 선차단. thesis 정량 실증.
- **M1 약신호**: 리셋 3 · 통과후 churn 62 — cached 비율 51~72%(작업단위 1회 캐싱 지배)라 pass 후 재판정 부재. **진짜 M1(시나리오 위반율)은 A2 사후대조가 유일한 보완** — 계획 A2의 존재 이유가 계측으로 확인됨.
- **M3**: 작업단위 31 · 평균 45.5 edit/단위 · 최대 142.

### 게이트 실동작 (repo별 block율)
| repo | gate | cached | pass | block |
|---|---|---|---|---|
| geobuke-code | 717 | 514 | 177 | 26 |
| claudepulse | 196 | 90 | 73 | 33 |
| codebase-viz | 96 | 53 | 24 | 19 |
| dev-note | 151 | 109 | 29 | 13 |
| fa-support | 252 | 111 | 101 | 40 |

### 기능 확산 격차 (hook-guest 모드의 규약 의존 한계)
- spec-add는 전 repo 활발(86/33/20/36/76) — 도출 루프 규약 확산 성공.
- **verify(geobuke 5·타repo 0) · done(geobuke 8·fa-support 2·타 0) · scope(geobuke 7건)** — 사람이 명령을 쳐야 하는 규약은 미확산. → **A-mode(루프 소유)가 자동화할 후보 목록** = done 경계 자동 감지, verify 자동 트리거, spec 선강제.
- **빈 specHash 게이트 이벤트 222/717(31%, geobuke)** — spec 없이 게이트를 마주치는 비율이 여전히 높음. A-mode에서 spec 선강제 UX 개선 여지.
- failopen.log 33건(geobuke) — fail-open 발생 이력 실존. A1 in-process 전환 시 fail-open 양상 재설계 지점.

---

## 2. 아키텍처 분석

### 3층 분리 현황 (준비도의 핵심 근거)
```
┌─ 프로세스 계약층 (결박 — 재작성 대상) ──────────────┐
│ hook.ts run* 3개 래퍼(stdin/exit/emit) · cli.ts main() │
├─ 판정·표현층 (순수 export — 그대로 재사용) ─────────┤
│ buildBlockReason·shouldCacheVerdict·formatScopeFindings │
│ buildSessionStart*/StopReminder (hook.ts export 함수들) │
├─ 엔진·상태층 (cwd 인자 기반 — 그대로 재사용) ───────┤
│ judge.ts(transport 추상화·opts.invoke 주입) + 20개 모듈 │
└──────────────────────────────────────────────┘
```
- `process.exit`/`process.stdin` 사용은 hook.ts·cli.ts 두 파일에만 존재. 나머지 20개 모듈은 전부 `cwd` 인자 기반이라 engine.ts가 그대로 소비 가능.
- `judge.ts`의 `selectedTransport()`/`opts.invoke` 주입 지점 = agent-sdk를 **세 번째 트랜스포트로 꽂는 자리**가 이미 열려 있음. 현 2경로(직접 API·`claude -p` spawn)와 동거 가능.
- 주의: 판정용 `@anthropic-ai/sdk`(Messages API)와 엔진용 `@anthropic-ai/claude-agent-sdk`는 **다른 SDK** — engine.ts는 엔진 구동, judge.ts는 판정으로 역할 분리 유지.

### evaluateGate 추출 설계 (Agent B 권장안)
`runPreToolUse`(hook.ts:167-345)에서 순수 판정부(spec 로드→캐시→judge→verdict→reason 조립, ~70줄)를 추출하고, 부수효과는 **효과 디스크립터로 반환**:

```typescript
interface GateDecision {
  verdict: Verdict;
  shouldMarkGated: boolean;
  shouldEnqueue: ScopeQueueEntry | null;
  pendingReview: PendingReview | null;
  goldenCapture: GoldenCase | null;
  event: GateEvent;
}
async function evaluateGate(input: EvaluateGateInput, judge: JudgeFn): Promise<GateDecision>
```
호출부 2개(stdin hook / SDK 콜백)가 디스크립터를 각자 커밋. 분리 시 정리할 결합 2건: ① `refreshVersionCache`가 judge와 `Promise.all` 병렬(hook.ts:232-234) — 시그니처 오염 금지, 래퍼 귀속. ② lazy `await import("./judge.js")` — SDK 래퍼는 장수 프로세스라 불필요, `JudgeFn` 주입으로 대체.

### 판정 지점 3개 결합도·이식 난이도
| 판정 지점 | 공유 | 고유 | SDK 이식 난이도 |
|---|---|---|---|
| PreToolUse gate | judge·spec·store·metrics·types | state 캐시·defer·review·golden·scope큐·notice (부수효과 5+1) | **상** — isGated 작업단위 캐시를 래퍼가 소유하는 재설계 필요 |
| Stop scope | 〃 | scope.ts 전체(grep IO)·SCOPE_MODEL·CLI스킵 조건 | **중** — SDK `StopHookInput` in-process 지원 확인(리서치 §4). CLI스킵 조건 재구현 |
| gbc verify | 〃(judgeReviewed만) | verify.ts·junit.ts. state/defer/golden 의존 0 | **하** — CLI 명령 그대로 재사용, SDK 래퍼 불요 |

### .gbc 상태파일 수명주기 (A-mode 상태 소유 결정의 입력)
작업단위 스코프(state.json·spec.md) / 영속(defers.json·config.json·golden.json·events.jsonl) / 턴 휘발(scope-queue.json) / block당 1개(pending-review.json). A-mode 래퍼가 "현재 작업단위" 경계를 소유하게 되면 state.json 캐시 의미론 재정의 필요.

---

## 3. 코드 품질 (confidence HIGH만, Agent C)

| # | 항목 | 심각도 | 위치 | A-mode 관련성 |
|---|---|---|---|---|
| 1 | fail-open 규약 우회 — run* 본문 비보호 예외가 설계된 fail-open 채널(failopen.log+systemMessage) 대신 `main().catch`→exit(1) 원시 스택으로 샘 | 🟡 (신뢰도 87) | hook.ts:167-175/462-469/619-626 · cli.ts:908-911 | A1이 hook.ts를 리팩토링하므로 **추출과 동시 수정이 최저비용** |
| 2 | scope 자기파일 제외 실패 — `entry.file`(절대) vs grep 출력(`./상대`) endsWith 불일치로 자기참조가 타파일 호출부처럼 오염, rung2/broken 오판정 유발. 테스트는 상대경로 픽스처라 은폐 | 🟡 (신뢰도 83) | scope.ts:200 | scope 판정 신뢰도 직결 — A-mode 이전에 수정해야 계측이 깨끗 |
| 3 | Anthropic 클라이언트 중복 생성(judgeViaApi/scopeViaApi 각각 new + 매호출 api-key readFileSync) | 🟢 (신뢰도 88) | judge.ts:150-174/508-521 | **지금 팩토리 추출=1줄, SDK 래퍼 후=변경점 2배** |
| 4 | 테스트 구조 갭 — processScopeQueue 비export·주입점 無(judgeScope 후 clearScopeQueue 전 예외 시 큐 누적 미커버), refreshVersionCache fetch 주입 無 | 🟢 (신뢰도 82) | hook.ts:409-459 · version.ts:104-123 | A1 추출 리팩토링이 자연히 주입점을 만드는 자리 |

이상 없음 판정(검토 완료): safeModel W2 stdin·grep `execFile -F --`·lstat 심링크 거부·store 비원자 쓰기(단일 사용자, 단 A-mode 동시성 도입 시 재검토)·cached-skip 핫패스.

### 조인 키 건전성 (Agent B 정밀 판정 — 계획 A2 전제의 반례)
| kind | session | specHash |
|---|---|---|
| gate/bypass/scope (hook발) | UUID 충전 | gate=logHash · **scope=`""` 무조건 하드코딩(hook.ts:368)** |
| defer-*/spec-*/done/verify/gate-reset (CLI발) | **`""`** | 충전 |

- scope specHash=""는 "Stop 시점 spec 비움" 탓이 아니라 `logScopeVerdicts`가 파라미터를 안 받는 구현 누락. `ScopeQueueEntry.specHash`는 큐잉 시 채워지나 downstream에서 dead data.
- **판정**: extraction.jsonl ⨝ events.jsonl 의 현실적 조인 키 = **session_id 단독**(hook발 이벤트 한정). specHash 드릴다운을 원하면 ① ScopeVerdict에 specHash 필드 추가+logScopeVerdicts 시그니처 수정, ② CLI 이벤트에 session 충전(A-mode 래퍼는 세션을 소유하므로 자연 해소) 선행 필요.

---

## 4. 외부 리서치 — agent-sdk 사실 재검증 (Context7, 2026-07-02)

6/24 계획의 와이어링 리스크 3건 재검증:
1. **이중발화 → 기본 해소**: v0.1.0 breaking change로 `settingSources` 기본값=아무것도 안 로드(설정·훅 격리). 이중발화 조건은 "project 소스를 명시 로드할 때"로 특정됨. `gbc run`은 기본값+프로그램 주입 hook만 사용이 정답.
2. **BaseHookInput 필드 → 확인**: `session_id`·`cwd`·`transcript_path` 존재. 게이트 파일해석·조인에 충분.
3. **deny 계약 → 동형 확인**: `hookSpecificOutput.permissionDecision:'deny'+reason` + top-level `systemMessage`. `canUseTool`(사람-pause)도 유효.
4. **신규 발견**: SDK가 `StopHookInput` 등 hook 전종 in-process 지원 → **scope 사후판정도 래퍼로 이식 가능**(계획엔 없던 옵션).

남은 진짜 미검증 = "게이트 루프가 SDK 구동 모델에서 한 사이클 완결되는가"(A1 성공기준 그대로) + 인증/과금 스코프(자식 프로세스 키 격리).

---

## 5. 개선 로드맵 (A 계획 보강 입력)

### 즉시 — A1 착수 전 B-라인 선행 패치 (P0, 0.5.4 후보)
- [ ] **조인 키 충전**: logScopeVerdicts에 specHash 전달 + CLI 이벤트(verify·done 최소) session 충전 검토 — *지금 고치면 A2 사후대조가 소급 가능한 계측이 쌓이기 시작*
- [ ] **scope.ts:200 경로 비교 수정** + production형(절대 file_path·`./`상대 grep) 픽스처 테스트 — scope 계측 신뢰도 회복
- [ ] **judge.ts 클라이언트 팩토리 추출**(1줄 비용, A-mode 후 2배)

### 단기 — Phase A1 (SDK Wrapper 스파이크)
- [ ] evaluateGate 효과-디스크립터 추출(§2 설계) — fail-open 랩핑(품질 #1)·judge 주입(#4 주입점)을 같은 리팩토링에서 동시 해소
- [ ] engine.ts(query 래핑+추출 sink) · SDK PreToolUse 콜백 · canUseTool stdin pause · `gbc run`
- [ ] 회귀: 단위 198 test() + 골든 replay(api/cli) = 판정 불변성 회귀락으로 활용

### 중장기 — Phase A2~A4
- [ ] A2 진짜 M1: 조인 키를 session_id 기반으로 재설계(P0 패치 후 specHash 드릴다운)
- [ ] A3 TUI: scope 사후판정 in-process 이식(신규 옵션) 포함 여부 결정
- [ ] A4: store.ts 비원자 쓰기 재검토(래퍼 동시성) · 패키징·발행

---

## 6. 리서치 출처
- Context7 `/nothflare/claude-agent-sdk-docs` — hooks/permissions/typescript/migration-guide (settingSources v0.1.0 breaking change, StopHookInput, canUseTool)
- 계측 원시자산: 5 repo `.gbc/events.jsonl`(1743 events) + `gbc metrics --all`/`repos list`(0.5.3)
- 코드 근거: 병렬 에이전트 3기(구조/아키텍처/품질) — 파일:라인 인용 본문 참조

---

> 이 보고서는 Claude Code `/analyze` 스킬로 자동 생성되었습니다.
