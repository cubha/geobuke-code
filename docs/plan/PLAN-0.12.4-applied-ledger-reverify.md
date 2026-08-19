# PLAN — 0.12.4 원장 재검증 + 저비용 동반락
생성: 2026-08-18 · 소스: 세션 대화(`/sh-dev-loop --tdd --auto 0.12.4 ...` 요청 + 사용자 D1/D2/D3 결정)

## 요구사항 (사용자 요청 원문 기준)

- R1. 원장(`applied.json`) 재검증 부재 — security-auditor Critical 이월 건을 최우선으로 해결한다. 판정 로직 변경이 포함되므로 골든/eval 대칭쌍이 필수다.
- R2. 세션 스코프 부재(Warning) — 저비용 동반락으로 이번 배치에서 다룬다. (D3 결정: `AppliedEntry.session_id` **기록만** 이번 배치에 포함하는 라이더로 채택, **필터링 로직은 다음 배치로 이월**)
- R3. F-2 — 골든 replay가 재캡처 시 `appliedContext`(P2a)를 잃는 버그를 고친다.
- R4. F-3 — `gate reset`이 `pendingReview`를 지우지 않아 재현실험에서 block-repeat 오염이 생기는 문제를 고친다. (D1 결정: `gate reset --hard`는 `state` + `pendingReview` + `applied.json`(원장) **전부** 초기화)
- R5. 형상계약(F-1 패턴) 확대 — eval 케이스의 `evidence_context`(및 후보였던 `current_file`/`old_strings`)가 손으로 조립한 문자열이 아니라 프로덕션 조립 함수의 실출력이어야 한다.
- R6. (D2 결정) 원장 재검증 로직 변경을 커버하는 eval 대칭쌍(stale 케이스)을 **구조전용 테스트가 아닌 실제 eval 케이스로 추가**한다(hard 케이스 수 N→N+1).

## 구현계획 (세션 중 planner 위임 산출 + 실제 진행된 SubTask)

- P1. [TDD] `src/golden.ts` `upsertGolden` — `STICKY_FIELDS` 필드보존을 `evidenceContext`/`expectedAfterEvidence`뿐 아니라 `appliedContext`까지 일반화 → R3 해결.
- P2. [TDD] `src/applied.ts` — `extractAppliedAnchors`(구두점전용 줄 제외 포함) + `verifyAppliedEntry`(3-상태: alive/stale/unverifiable) 순수코어 신설. `AppliedEntry`에 `outside?`/`session?` 필드 추가(session은 D3 라이더).
- P3. [TDD] `src/gate-core.ts` `evaluateGate` — P2의 재검증을 `selectAppliedForJudge` 직전에 배선(이 배치의 유일한 판정 입력 변경) → R1 핵심 해결. `appliedStale`/`appliedUnverified` 메트릭 필드 추가.
- P4. eval 대칭쌍 — `test/cases.json` 케이스22(원장 stale 대칭쌍) 신설 + `buildEvalAppliedContext`에 `fileStates` 파라미터 확장(R6). **이 과정에서 순수 구두점 줄(예: 단독 `}`) 앵커 오판 실결함을 발견해 P2에 소급 수정.**
- P5. `src/cli.ts`/`skills/gate/SKILL.md` — `gbc gate reset --hard` 플래그 신설(R4/D1).
- P6. `src/eval/evidence-input.ts` 신설 + `test/cases.json` 케이스16/18 — `evidence_context` 손조립 문자열을 raw `evidence_cases`(grep 매치)로 전환(R5, current_file/old_strings는 조사 결과 이미 raw로 확인되어 전환 불필요 판단).
- P7. 문서화 — `CHANGELOG.md`([0.12.4]), `README.md`, `package.json`(0.12.4 버전범프).

## 제외 합의 (요청했지만 하지 않기로 한 것)

- X1. 세션 스코프 **필터링** 로직(멀티탭 교차오염 방지) — D3로 이번 배치 범위 밖, 기록(라이더)만 포함.
- X2. `current_file`/`old_strings` 필드의 형상계약 전환 — 코드 확인 결과 이미 프로덕션 raw 형태라 불필요 판정, 전환 작업 안 함.
- X3. P4(block-repeat) 존폐 판단 — 실사용 계측이 쌓인 뒤로 이월, 이번 배치 범위 밖.
- X4. npm 발행/push/PR — 구현+로컬 커밋까지만, 발행 여부는 사용자 결정 대기 중.
