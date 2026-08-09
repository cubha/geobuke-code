# 0.12.0 요구사항 대비 실검증 매트릭스

> 검증일: 2026-08-09 · 대상: `feature/silver_sh` (미커밋 작업트리 — 추적파일 22개 변경 + 신규 4개, `git diff main --stat` 실측 1768++/91--)
> 요구사항 출처 ① `project_0_12_0_gate_fp_rootfix` 메모리 ST1~ST13(planner 수립·사용자 승인 2026-08-07)
> 요구사항 출처 ② `ANALYSIS-gbc-0-12-0-verification-2026-08-08.md` F-1~F-16 중 **F-12 제외 15건**(사용자 결정)
> 검증 방식: 코드 실조회(`grep`/`sed`) + 게이트 실행 + `dist/cli.js` 실행 관찰. 문서 기재값 인용 없음.

---

## 0. 검증 게이트 실측 (본 세션 재실행)

| 게이트 | 명령 | 결과 |
|---|---|---|
| 정적+단위 | `bash verify.sh --full` | **1030/1030 pass · fail 0** (빌드 포함, exit 0) — 최초 1027, ship 전 보안 후속 회귀락 3건 추가 |
| 판정 회귀 | `npm run eval` | **hard 17/17** — TP=11 · TN=6 · **FP=0 · FN=0**, 평균지연 1918ms |
| known-fail | 동일 | 1건(`12-대형파일_뒤쪽기구현_오탐방지`) — **설계 의도대로 실패**(P3 대상, 비차단) |
| scope 회귀 | 동일 | **6/6** |
| 라이브 계측 | `node dist/cli.js metrics --all` | 크래시 없이 산출 — **`[P2b] 근거주입 3건 · 판정전환 1건(33.3%)`** |

> ⚠️ `verify.sh`의 인자 루프는 `--no-build`/`--eval`만 인식하므로 **`--full`은 미인식 플래그**다(무시 → 기본 경로 = 빌드+단위테스트, eval 제외). 결과적으로 "빌드 포함 전체 실행"이 맞아 표기는 정확하지만, `--full`이 뭔가를 *추가로* 켠다는 뜻은 아니다. eval의 실 강제 게이트는 `package.json:prepublishOnly`다.

---

## 1. 원요구사항 ST1~ST13

| ST | 원요구사항 | 구현 위치 | 실검증 근거 | 판정 |
|---|---|---|---|---|
| ST1 | 오탐 행동신호 순수함수(`src/scoring.ts`) | `scoring.ts:141,143,362,382,386` | `hasMissing`·`appliedAt` 필드 + `classifyBlockOutcomeAcrossRepos` + `countFastSelfCorrected`(120s 임계) 실조회 | 🔄 명세변경(승인) |
| ST2 | `gbc metrics` 오탐지표 + 임계경고 + **`--since`** | `cli.ts:948-960,1372-1379` · `metrics.ts:159,176` | 라이브 실행에서 전체/침묵-누락 2단 출력 + `🚨 자가수정 비중 60.1%(임계 40%)` 경고 발화 확인. `--since 7d` 정상 축소(전체 대비 254 이벤트), `--since 어제` **exit 1** | ✅ (F-1로 승격) |
| ST3 | `GateEvent.fileBytes?`/`truncated?` | `metrics.ts:78-80` · `gate-core.ts:333-341` | 필드 선언 + `Buffer.byteLength` 산출 + `fileBytes` 없으면 키 자체 생략 | ✅ |
| ST4 | gate-ack에 `missing[]` 기록 | `cli.ts:126-128,758-759` | `logCli` optional 파라미터, `kind === "gate-ack"`일 때만 전달 | ✅ |
| ST5 | 절단 특성화 + 예산 불변식 잠금 | `judge.ts:195,212` · `normalize.ts:7` · `unit.test.mjs:245-254` | `MAX_CURRENT_FILE=8000` / `MAX_FIELD=4000` export + **역전 상태를 현행 사실로 고정**하는 락(P3 착수 시 강제 실패) | ✅ |
| ST6 | `GoldenCase.currentFileContent?` + 캡처·replay 전달 | `types.ts:176` | 필드 + 프라이버시 주석. 0.12.0 검증 후속에서 `evidenceContext`·`expectedAfterEvidence`까지 확장 | ✅ |
| ST7 | cases.json 대칭 케이스 + `expectedFailing` 하네스 | `test/cases.json`(18건) · `eval/regression.ts` | 12↔13 대칭쌍 / 14 미탐방지 / 15 Write회귀 / **16↔17 근거유무 대조군** / 18 심볼만존재. `expectedFailing:true`는 12번 1건 | ✅ (원문 "4쌍" 문언 모호는 잔존) |
| ST8 | `judge()` `opts.invoke` seam | `judge.ts:442,457,465-472` | `JudgeInvoke` 타입 + 우회 분기. `judgeReviewed`/`judgeScope`/`judgeM1Violation`과 동형 | ✅ |
| ST9 | `verify.sh --eval` opt-in 분리 | `verify.sh:6,15,28,92` · `package.json:22` | `--eval` 플래그 + `VERIFY_TIMEOUT_EVAL=900` + `prepublishOnly`가 실 강제 게이트 | ✅ |
| ST10 | `extractCaseSymbols`(`src/evidence.ts` 신규) | `evidence.ts:44-80` | 파일명 마스킹(인덱스 기반·전 출현) → 식별자 추출, `IDENT_KEYWORDS`+`COMMON_TECH_WORDS` 2중 필터, 케이스당 5개 상한 | ✅ |
| ST11 | 케이스별 근거수집기 + 포맷터 | `evidence.ts:216,276-306` | self-file 포함, 심볼 캐시 공유, `MAX_GREP_SYMBOLS`(8) 예산, `formatEvidenceContext` | ✅ |
| ST12 | block 경로 2단계 재판정 + `evidenceUsed`/`evidenceFlip` | `gate-core.ts:366-449` | ⑥-2 블록 전체 실조회 — Write 억제·매치0 생략·fail-open **값검사**·verdict 교체 | ✅ |
| ST13 | EPERM 안내 PowerShell + cli.js 병기 | `startup-diagnostics.ts:79-92` | `$env:GBC_CLAUDE_PATH="C:\path\to\cli.js"` + `node_modules/@anthropic-ai/claude-code/cli.js` 실측 우회 예시 | ✅ |

**ST1 🔄 판정 근거**: UPR/IPR 지표는 착수 *전* `project_gate_false_positive_rca`에서 폐기됐다(self-corrected 오분류 전제 반증). 대체 구현이 같은 목적(오탐 행동신호 모집단 분리)을 달성하며, 변경 사실이 착수 전 문서화됐다 — 미구현이 아니다.

---

## 2. 검증 후속 F-1~F-16 (F-12 제외 15건)

| F# | 지적 | 반영 위치 | 실검증 근거 | 판정 |
|---|---|---|---|---|
| F-1 | `--since` 미구현 | `metrics.ts:159,176` · `cli.ts:948` | `parseSince`(ISO/`Nd`/`Nh`/`Nm`) + `filterEventsSince`(경계 포함). 라이브 3케이스 실행 확인 | ✅ |
| F-2 | 신규 계측 필드 무집계 | `metrics.ts:224-241,309-333` · `cli.ts:869,910` | `Metrics.evidence` 롤업 8키 + `[P2b]` 렌더 블록. **라이브 출력 실확인** | ✅ |
| F-3 | `evidenceFlip` 길이 비교 | `gate-core.ts:429` | `sameMissingSet` 재사용(⑧ block-repeat와 동일 기준). 회귀락 `gate-core.test.mjs:708,725` | ✅ |
| F-4 | JS/TS 밖 조용한 무동작 | `evidence.ts:26,36,GREPPABLE_EXT` · `scope.ts:139` | `GREP_INCLUDE_EXTS` 단일 소스 import, 대상 밖 확장자는 심볼로 미방출(마스킹은 유지). 드리프트 락 2건 | ⚠️ **범위 명시로 해소**(아래 주) |
| F-5 | block 경로 지연 무계 | `evidence.ts:176,182,286` | `EVIDENCE_TIME_BUDGET_MS=8000` + `START_DEADLINE_MS = 예산 − GREP_TIMEOUT_MS` → **선언값이 곧 실제 상한** | ✅ |
| F-6 | metrics 집계 로직 테스트 0 | `scoring.test.mjs:538-565` · `unit.test.mjs:3587-3612` | 교차repo 불변식(병합 계산과 **결과가 다름**까지 단정) + `parseSince`/`filterEventsSince` 6건 | ✅ |
| F-7 | `prepublishOnly` eval 무한대기 | `eval/regression.ts:38-66` | `GBC_EVAL_TIMEOUT_MS`(기본 900s) — 셸 `timeout` 비의존(하네스 자신이 상한 보유) | ✅ |
| F-8 | Edit 삭제형 근거 누수 | `evidence.ts:computeDeletionScope` · `gate-core.ts:381-393` | 삭제 줄 범위 산출 → `collectCaseEvidence` 전달 → 겹치는 매치 제외. 회귀락 3건(배선/실동작/**과잉억제 금지**) | ✅ |
| F-9 | `evidenceContext` 총량 무제한 | `evidence.ts:91,211-239` | `MAX_EVIDENCE_CONTEXT_CHARS=8000` + 케이스 라벨 캡 + 생략 건수 표기. "첫 1건은 담되 라벨은 자름" 경계 테스트 포함 | ✅ |
| F-10 | 근거수집 예외 흡수 비대칭 | `gate-core.ts:390-395,453` | try/catch로 흡수 후 `evidenceFailed` 계측. 회귀락 `gate-core.test.mjs:837,857,871` | ✅ |
| F-11 | README·help 현행화 | `README.md:288,289,426-428` · `cli.ts:1372` · `skills/gbc-monitor/SKILL.md:47` | replay 2단계·`--since`·`[P2b]` 롤업 3곳 반영 + 모니터 스킬 해석 가이드 | ✅ |
| **F-13** | **P2b 모델-행동 자동검증 0** | `golden.ts:56,86` · `cli.ts:652-672` · `regression.ts:30,74` | 골든이 근거·재판정 결과 캡처 → replay가 `<id>#p2b` 재현 + eval `evidence_context` 지원. **통제실험 실측: 16(근거有)=pass · 17(동일편집 근거無)=block** | ✅ |
| F-14 | 예산소진과 "근거 없음" 미구분 | `evidence.ts:199,206,286-289` | `budgetSkipped` + 사유(`count`/`time`) — 해소법이 다르므로 분리 | ✅ |
| F-15 | API 트랜스포트 타임아웃 부재 | `judge.ts:20,28,292-300` | `GATE_API_LIMITS`(30s/1회) vs `BATCH_API_LIMITS`(60s/2회) 분화 | ✅ |
| F-16 | lazy import "zero-dep" 근거 무효 | `gate-core.ts:6-7,243-250` | 주석 정정 — 실익은 **단위테스트 격리** 하나로 축소 명시 | ✅ |
| ~~F-12~~ | ~~flip이 `markGated` 캐시로 샘~~ | — | **사용자 결정으로 미반영.** 재제안 방지 근거는 ANALYSIS §3 F-12 및 메모리 잔여 항목 | ⛔ 제외 |

**F-4 판정을 ✅가 아닌 ⚠️로 두는 이유(정직 표기)**: 해소 방향이 *`--include` 확장*이 아니라 *심볼 추출 축소*였다. 따라서 **Python·Go 저장소에서 P2b가 무동작이라는 사실 자체는 그대로다** — 고쳐진 것은 "매치가 원천 불가능한 토큰이 grep 예산(8)을 먹어 정작 매치 가능한 심볼을 밀어내던" 부작용이다. 확장을 택하지 않은 이유는 `realGrep`이 `collectGrepContext`(축A/축B scope 판정)와 공유되어, 넓히면 게이트와 무관한 판정까지 동시에 바뀌기 때문. 이 범위 제한은 CHANGELOG "적용 범위(정직 표기)" 문단에 명시돼 있다.

---

## 3. 역방향 대조 — 변경 파일 → 요구사항 (미승인 변경 없음 확인)

요구사항→코드 표는 **요청하지 않은 변경**을 구조적으로 못 잡는다. `git diff main --stat` 전 항목을 역으로 귀속시킨다.

| 변경 파일 | 귀속 | 확인 |
|---|---|---|
| `src/evidence.ts` (신규) | ST10·ST11 + F-4·F-5·F-8·F-9·F-14 | — |
| `src/gate-core.ts` | ST3·ST12 + F-3·F-8·F-10·F-13·F-16 | — |
| `src/cli.ts` | ST4·ST6 + F-1·F-2·F-6·F-11·F-13 | — |
| `src/metrics.ts` | ST3 + F-1·F-2·F-10·F-14 | — |
| `src/judge.ts` | ST5·ST8 + F-15 | ⚠️ 부수 행동변경 1건(아래) |
| `src/scope.ts` | ST11 + F-4(`GREP_INCLUDE_EXTS` export·doc) + F-8(`canonicalPath` export) | — |
| `src/scoring.ts` | ST1 + F-6 | — |
| `src/golden.ts` · `src/types.ts` | ST6 + F-13 | — |
| `src/normalize.ts` | **ST5 전용** — `MAX_FIELD` export + 주석. diff 6줄, 로직 변경 0 | ✅ 실diff 확인 |
| `src/eval/regression.ts` | ST7 + F-7·F-13 | — |
| `src/tui/startup-diagnostics.ts` | ST13 | — |
| `verify.sh` · `package.json` | ST9 (+ `version` → **0.12.0** 실확인) | ✅ |
| `test/gate-sdk.test.mjs` (+2) | **ST12 파급** — `GateDeps`에 `collectCaseEvidence`가 늘어 테스트 헬퍼 기본값 주입. 프로덕션 `gate-sdk.ts`는 무변경(하드결정④의 "무영향" 주장과 정합) | ✅ 실diff 확인 |
| `test/judge-invoke.test.mjs` (신규) | ST8 | — |
| `test/tui-startup-diagnostics.test.mjs` | ST13 | — |
| `test/evidence.test.mjs`(신규)·`gate-core`·`unit`·`scoring`·`cases.json` | 각 ST/F의 회귀락 | — |
| `skills/gbc-monitor/SKILL.md` (+1) | F-11 | ⚠️ 재init 영향(아래) |
| `README.md` · `CHANGELOG.md` · `docs/analysis/*` | F-11 + 기록 | — |

**⚠️ 부수 행동변경 1건 — `gbc verify`/scope/score의 API 상한**: F-15는 "게이트에 타임아웃 부재"를 지적했는데, 수정은 `createApiClient`에 상한을 **주입 가능**하게 바꾸면서 배치 판정 3종(`judgeReviewed`·`judgeScope`·`judgeM1Violation`)에도 `BATCH_API_LIMITS`(60s/2회)를 명시했다. 이전에는 이 경로에 gbc측 상한이 **아예 없었다**(SDK 기본값 위임). 즉 게이트 외 기능의 실효 상한이 바뀐다. **판정 로직 변경은 아니므로 "판정변경 정확히 1개(P2b)"는 유지되지만**, 상한 분화 자체가 의도된 설계다 — 게이트 상한(30s)을 전역 적용했다면 `gbc verify`의 코드 독해 판정이 정당한 결과를 `unverifiable`로 강등시켰을 것이다. 회귀락은 `judge.ts` 상수 doc + 단위테스트로 잠겨 있다.

**⚠️ 재init 영향 정정**: `gbc init`은 `copyFileSync`로 SKILL.md **내용을 복사**한다(`cli.ts:216-221`). F-11이 `skills/gbc-monitor/SKILL.md`에 `[P2b]` 해석 항목을 추가했으므로, 기존 설치 6 repo는 **재init 전까지 그 항목이 없는 구버전 스킬을 유지**한다. hook 계약(`settings.json`·`src/hook.ts`)은 무변경이라 **게이트 동작상 재init은 여전히 불필요**하지만, "재init 불요"를 무조건으로 쓰면 부정확하다 → CHANGELOG를 조건부 문구로 정정했다.

---

## 4. 잔여 (코드 변경 아님)

- **`/ship` + `npm run release` = 사용자 명시 승인 대기.**
- **관측 1건**: `classifyBlockOutcomeAcrossRepos` 추출은 함수 의미론만 잠근다 — 호출부(`cli.ts:990`)를 `classifyBlockOutcome(mergedEvents)`로 되돌려도 타입 에러가 나지 않는다(scope-critic 유효 지적, 회귀락은 함수 레벨에만 존재).
- **수용한 보안 Warning 1건**: 근거가 저장소 파일에서 오므로 저장소 쓰기 권한자가 그 텍스트로 판정에 영향을 줄 수 있다(프롬프트 인젝션). 구조적 통제는 기능 자체와 상충 — README에 한계로 명시. 수정 대상 아님.
- **PR#2 착수조건**: 0.12.0 설치시점을 `--since` 기준으로 재계산, 신규 창 block 표본 30건 축적 후(전체 재계산 금지 = 희석).
