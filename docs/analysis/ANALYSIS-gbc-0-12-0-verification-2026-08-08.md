# 0.12.0 원요구사항 대비 구현결과 검증 + 구현코드 분석 보고서

> 분석일: 2026-08-08
> 프로젝트: geobuke-code(거북이코드) — 0.12.0 게이트 오탐 근본수정
> 분석 관점: 원요구사항(ST1~ST13) 대비 구현 정합성 검증 + 구현코드 품질·아키텍처 분석
> 대상 범위: `git diff main` (feature/silver_sh, 19 파일 변경 + 신규 3 파일)
> 원요구사항 출처: `project_0_12_0_gate_fp_rootfix` 메모리(planner 수립·사용자 승인, 2026-08-07)

> **[해소 현황 — 2026-08-09 갱신]** 사용자 결정(F-12 제외, 나머지 15건 0.12.0 일괄 반영)에 따라
> **F-1·F-2·F-3·F-4·F-5·F-6·F-7·F-8·F-9·F-10·F-11·F-13·F-14·F-15·F-16 = 15건 전부 해소**.
> **F-12만 미반영** — 캐시 가드는 원칙적이지 않다는 §0의 판단이 유지된 결과다(재제안 금지 근거는
> §0 세 번째 불릿).
>
> §0이 "발행 전 실제 질문"으로 남긴 **F-13(모델-행동 자동검증 0)은 코드로 닫혔다**: 골든 캡처가
> P2b 근거·재판정 결과를 남기고 `snapshot replay`가 2단계를 재현하며, eval에 통제 케이스 3건
> (16 근거有→pass / 17 **동일 편집 근거無**→block / 18 심볼만 존재→block)이 들어갔다. 16↔17이
> 근거 유무만 다르고 판정이 갈리므로 **P2b 효과의 통제 실험**이 성립한다(실측 eval hard 17/17).
>
> 같은 실험에서 나온 **P2b의 실제 한계**(문서·CHANGELOG 반영): 근거가 "헬퍼 함수가 타 파일에
> 존재한다" 수준이면 판정은 뒤집히지 않는다 — 호출·배선이 근거에 없으면 모델은 여전히 누락으로
> 본다. 오탐이 해소되는 것은 근거가 **자기완결형 구현**(마이그레이션 블록 등)일 때다. 이는 보수적
> 방향이라 그대로 둔다.

---

## 0. 요약 (Executive Summary)

**구현 자체는 요구사항을 충족한다.** ST1~ST13 중 13건 전부가 코드에 존재하고, 본 세션에서 재현한 게이트도 전부 통과했다(verify 957/957, eval hard 14/14 FP0/FN0, scope 6/6 — 전부 본 세션 실측).

**그러나 "이 수정이 실제로 오탐을 줄였는가"를 검증할 수단이 빠졌다.** 아래 16건이 그 결론으로 수렴한다:

| # | 갭 | 심각도 | 결과 |
|---|---|---|---|
| **F-13** | **P2b가 골든 replay·eval·단위테스트를 전부 우회** | 🔴 최상위 | 이 배치의 유일한 판정 변경에 모델-행동 검증 장치가 **하나도 없음** |
| F-12 | 근거주입 flip이 작업단위 pass 캐시(`markGated`)로 샌다 | 🔴 | 잘못된 flip 1건 → **그 작업단위 전체에서 게이트가 꺼짐**(F-13의 파급) |
| F-1 | `gbc metrics --since` **미구현**(ST2 명시 항목) | 🔴 | 0.12.0 이후 창만 볼 수 없음 → 기존 331건 block이 신규 신호를 희석 |
| F-4 | P2b가 **JS/TS 밖에서 조용히 무동작** (`--include` 4종 vs 토큰 20종) | 🔴 | 유일한 판정 개선이 타 언어 저장소에서 완전 무효 |
| F-8 | Write 억제 가드가 **Edit/MultiEdit 삭제형 편집에 구멍** | 🔴 | 정당한 block이 *편집 전* grep 근거로 pass로 뒤집힐 수 있음 |
| F-2 | `evidenceUsed`/`evidenceFlip`/`truncated` **집계·표시 없음** | 🟡 | P2b 발화·판정변경 횟수를 `gbc metrics`로 못 봄 |
| F-3 | P2b가 missing 셋에 **새 변동원(grep 예산)을 주입** | 🟡 | `block-repeat` 가드(완전일치) 약화 → "4회 재차단" 병리 악화 여지 |
| F-5 | block 경로 최악 지연 30s → **~92s**(동기 차단) | 🟡 | 전체 시간 예산 상한 부재 |
| F-6 | `gbc metrics` 신규 집계 로직 **테스트 0건** | 🟡 | "병합 후 계산 금지" 불변식에 회귀락 없음 |
| F-7 | `prepublishOnly` eval에 **타임아웃 가드 없음** | 🟡 | `npm publish`가 무한 대기 가능 |
| F-9 | `evidenceContext` **총량 무제한**(케이스당 4000자 × N) | 🟡 | 절단·예산 문제를 신설 경로에서 재도입 |
| F-14 | grep **예산 소진과 "근거 없음"이 구분 불가** | 🟡 | P0 측정 지표 왜곡 |
| F-10 | ⑥-2 근거수집 예외 흡수 **비대칭**(현재 도달 불가) | 🟢 | 관찰 |
| F-15 | API 트랜스포트에 gbc 측 타임아웃 없음(노출 2배) | 🟢 | 관찰 |
| F-16 | `judge.ts` lazy import의 "zero-dep" 근거가 이미 무효 | 🟢 | 주석 정확성 |
| F-11 | README·help 현행화 누락 | 🟢 | 관찰 |

**한 문장으로**: P2b는 **"block을 pass로 바꾸는 것이 존재 목적인, 의도적으로 관대한 판정 경로"**인데, 그 정밀도를 확인할 자동 장치가 **없고**(F-13), 사후에 집계할 지표도(F-2) 시간창도(F-1) 없다. 그리고 그 pass의 출구는 작업단위 전체 캐시다(F-12).

즉 F-12·F-8·F-4는 **독립된 결함이라기보다 F-13의 파급**이다 — 각각이 실제로 발화하는지 여부가 전적으로 P2b의 정밀도에 달려 있는데, 그 정밀도가 미측정이고 **현재 구조에서는 측정 불가능**하다. 측정 인프라를 넣은 릴리스인데 정작 그 릴리스 자신의 효과와 부작용은 잴 수 없다 — 이것이 본 보고서의 핵심 지적이다.

**보안 — 이상 없음(실검증)**: `realGrep`은 `execFile`(셸 미경유) + `-F`(고정문자열) + `--`(옵션 종결자)를 쓰고, `extractCaseSymbols`의 정규식이 `[A-Za-z_]` 앵커라 `-`로 시작하는 토큰을 애초에 만들 수 없다 → **커맨드/인자 인젝션 경로 없음**. grep `--include` allowlist가 `.env`·`.pem` 등을 대상 집합에서 배제하고 `--exclude-dir`가 `node_modules/.git/dist/.gbc`를 제외하므로 **민감정보 프롬프트 유출 경로도 없다**. 0.5.2부터 검증돼 온 동일 allowlist를 재사용한 결과다.

**발행 차단 여부 — 판단**

**코드 수정을 발행 전 조건으로 걸 만한 결함은 없다.** 발행 전에 권하는 것은 CHANGELOG 문구 1줄뿐이고, 나머지는 전부 0.12.1 이후로 충분하다.

- **F-4·F-8** — 현 사용 환경에서 실피해가 없다(등록 6 repo 전부 JS/TS → F-4 무영향; F-8은 LLM 판단 의존이고 Edit은 diff에 삭제가 그대로 보인다). 다만 릴리스의 핵심 주장("P2b가 오탐을 근본수정한다")의 **적용 범위를 좁히므로** CHANGELOG에 한 줄 명시를 권한다 — 없는 효과를 주장하지 않기 위한 정직 표기이고, 비용이 0이다.
- **F-1** — 소급 추가 가능함을 실측 확인했으므로 0.12.1로 미뤄도 손실이 없다.
- **F-12에 코드 가드를 넣는 것은 권하지 않는다.** 검토했으나 원칙적이지 않다: ⓐ P2b가 옳게 판정했다면 그 pass는 정상 pass와 동등하고 캐시하는 것이 맞다 — flip에만 캐시를 막으면 **P2b가 고치려던 바로 그 경로에만 지연 페널티**를 물린다. ⓑ 잘못된 1차 judge pass도 파급반경이 **동일한데** 아무 가드가 없다 — 문제가 정말 "cached-pass의 파급이 크다"면 결함은 캐시 설계에 있지 P2b 입구에 있지 않다. ⓒ 제어 조건으로 쓸 만한 `evidenceFlip`은 **F-3에서 부정확하다고 지목한 지표**다.
- **따라서 발행 전 실제 질문은 코드가 아니라 하나다**: *"의도적으로 관대한 판정 경로를, 모델 행동에 대한 자동 검증 0인 채로 내보내도 되는가"*(F-13). 이건 2줄로 답할 수 없고 **사용자의 결정 사항**이다.
  - "그대로 발행"도 근거 있는 선택이다 — 게이트가 `ask` 모드라 사용자가 화면에서 보고 승인하고, 매치 0이면 status quo이며, 등록 repo 6곳이 곧 도그푸딩 표본이다.
  - "F-13부터 닫고 발행"도 근거 있다 — 이 프로젝트는 **정확히 같은 형태의 사각지대**(골든 replay 무신호 = flip0 거짓안심)를 이미 한 번 겪었고, 그 교훈으로 ST6을 넣었다.

---

## 1. 원요구사항 대비 구현 추적표 (ST1~ST13)

판정 기준 — ✅충족 / 🔄명세변경(착수 전 문서화) / ⚠️부분 / ❌미구현

| ST | 원요구사항 | 실제 구현 | 근거 | 판정 |
|---|---|---|---|---|
| ST1 | `computeUnaddressedPass`+`aggregateUnaddressedPass` 순수함수(scoring.ts) | `BlockClassification.hasMissing`·`appliedAt` 필드 + `countFastSelfCorrected()` | `src/scoring.ts:139,145,359-380` | 🔄 |
| ST2 | `gbc metrics` UPR/IPR 노출 + 임계경고 + **`--since`** | 침묵-누락(missing>0) 부분집합 분리집계 + `SELF_CORRECTED_WARN_THRESHOLD`(0.4) 경고 + repo별계산후집계. **`--since` 없음** | `src/cli.ts:812,815-829,865-880,919-930` | ⚠️ |
| ST3 | `GateEvent.fileBytes?`/`truncated?` | 필드 선언 + evaluateGate에서 산출·이벤트 기록 | `src/metrics.ts:78-80` · `src/gate-core.ts:408-409,417` | ✅ |
| ST4 | gate-ack에 `missing[]` 기록 | `logCli`에 optional `missing` 파라미터, `kind==="gate-ack"`일 때만 전달 | `src/cli.ts:125-127,733` | ✅ |
| ST5 | `buildUserMessage` 절단 특성화 + 예산 불변식 잠금 | `MAX_CURRENT_FILE`(8000)·`MAX_FIELD`(4000) export + 드리프트 가드 테스트 | `src/judge.ts:529` · `src/normalize.ts:635` · `test/unit.test.mjs` | ✅ |
| ST6 | `GoldenCase.currentFileContent?` + 캡처·replay 전달 | 타입 필드 + 캡처 시 조건부 기록 + replay가 judge에 전달 | `src/types.ts:166-172` · `src/gate-core.ts:427` · `src/cli.ts:637-640` | ✅ |
| ST7 | cases.json **대칭 4쌍** + `expectedFailing` 하네스 | 케이스 4건 추가(12~15) + `expectedFailing` 필드·hard/knownFail 분리 게이트 | `test/cases.json` · `src/eval/regression.ts:244,274-305` | ⚠️(용어 모호) |
| ST8 | `judge()` `opts.invoke` seam | `JudgeInvoke` 타입 + `opts.invoke` 우회 분기 | `src/judge.ts:566,580,597-598` | ✅ |
| ST9 | `verify.sh --eval` opt-in 분리 | `--eval` 플래그 + `VERIFY_TIMEOUT_EVAL`(900s) + **`prepublishOnly`가 실 강제 게이트** | `verify.sh:1-99` · `package.json:22` | ✅ |
| ST10 | `extractCaseSymbols`(evidence.ts 신규) | 파일명 마스킹→식별자 추출, 불용어 2중 필터, 케이스당 5개 상한 | `src/evidence.ts:32-63` | ✅ |
| ST11 | 케이스별 근거수집기 + 포맷터 | `collectCaseEvidence` — self-file 포함, 심볼 캐시, 총 grep 8회 예산 | `src/evidence.ts:86-115` | ✅ |
| ST12 | block 경로 2단계 재판정 배선 + `evidenceUsed`/`evidenceFlip` | ⑥-2 블록 — Write 억제·매치0 생략·fail-open 값검사·verdict 교체 | `src/gate-core.ts:433-466` | ✅ |
| ST13 | EPERM 안내에 PowerShell 형식 + cli.js 병기 | `$env:GBC_CLAUDE_PATH` 구문 + `@anthropic-ai/claude-code/cli.js` 실측 우회 예시 | `src/tui/startup-diagnostics.ts:79-92` | ✅ |

### 1-1. 판정 부연

**ST1·ST2의 🔄(명세변경)** — UPR/IPR(Unaddressed Pass Rate / Ignored Pass Rate) 지표는 **착수 전에 이미 폐기**됐다. `project_gate_false_positive_rca` 메모리가 "self-corrected 오분류" 전제가 반증됐음을 기록했고, 그 결과 "UPR 201/325·IPR 52/325 baseline 재현"이라는 원 게이트(G5)도 무효화됐다. 대체 구현(`hasMissing` 파티션 + `countFastSelfCorrected`)이 같은 목적(오탐 행동신호의 모집단 분리)을 다른 방식으로 달성한다. **미구현이 아니라 정당한 명세 변경이며, 변경 사실이 착수 전에 문서화됐다.**

단, **`--since`는 UPR/IPR 폐기와 무관하다** — 시간창 제한의 필요성은 지표 이름과 독립적이며, 대체 지표(`silentOmissionFalsePositive.rate`)에 **동일하게** 적용된다. UPR/IPR을 걷어내면서 `--since`가 함께 떨어져 나간 것으로 보인다(F-1).

**ST7의 "대칭 4쌍"** — 원문이 "4쌍"(=8건)인지 "대칭구조를 이루는 4건"인지 모호하다. 실제로는 4건이 추가됐고, 12↔13이 대칭쌍(뒤쪽 기구현 pass ↔ 뒤쪽 미구현 block), 14가 미탐방지(심볼만 존재), 15가 Write 회귀유지를 담당한다. **커버리지 설계로서는 타당**하나 원문 대비 건수 해석이 갈리므로 판정을 확정하지 않고 모호성으로 표기한다.

### 1-2. 검증 게이트 재현 결과 (본 세션 실측)

| 게이트 | 결과 | 재현 여부 |
|---|---|---|
| `verify.sh --full` | **957/957 pass, fail 0** (36.7s) | ✅ 본 세션 재실행 |
| `npm run eval` hard | **14/14** (TP9·TN5·FP0·FN0), 평균지연 1978ms | ✅ 본 세션 재실행 |
| `npm run eval` known-fail | 1건(`12-대형파일_뒤쪽기구현_오탐방지`) — **설계 의도대로 실패** | ✅ 본 세션 재실행 |
| scope 회귀 | **6/6** | ✅ 본 세션 재실행 |
| `gbc metrics --all --json` | 크래시 없이 산출: fp.rate=**0.194**(block 434), silentOmission.rate=**0.206**(block 331), selfCorrectedFast=**57** | ✅ 본 세션 재실행 |
| hook 계약 불변(재init 불요) | `src/hook.ts`·`skills/` **변경 0** | ✅ `git diff main --stat` 확인 |

> 메모리·CHANGELOG의 기재값(0.195·56)과 현 실측값(0.194·57)의 미세 차이는 그 사이 이벤트가 누적된 결과다 — 불일치가 아니라 지표가 살아 있다는 신호.

---

## 2. 아키텍처 분석

### 2-1. P2b 데이터 흐름

```
PreToolUse hook
  └─ evaluateGate (src/gate-core.ts)
       ├─ ① readCurrentFile → currentFileContent (최대 1MB 읽기)
       ├─ ② deps.judge(spec, edit, defers, resolved, {currentFileContent, cwd})   ← 1차 판정
       │      └─ buildUserMessage에서 currentFileContent를 8000B로 head 절단
       ├─ ③ fileBytes/truncated 산출 → 이벤트 메타
       ├─ ⑥ 골든 캡처 (재판정 *이전* — 회귀락은 1차 원본 판정을 잠근다)
       ├─ ⑥-2 【P2b】 verdict==block && missing>0 && !isOverwriteEdit
       │      ├─ deps.collectCaseEvidence(cwd, missing)   ← grep 최대 8회
       │      ├─ matched 0건 → 재판정 생략 (원 verdict 유지)
       │      └─ matched >0 → deps.judge(..., {evidenceContext})   ← 2차 판정
       │             ├─ verdict2.failOpen → 폐기, 원 block 유지 (값검사)
       │             └─ else → verdict = verdict2 (교체)
       ├─ ⑦ pass 분기
       └─ ⑧ block / block-repeat 분기 (sameMissingSet 완전일치 가드)
```

### 2-2. 설계 결정 검토

**의존성 주입 일관성 — 양호.** `collectCaseEvidence`를 `GateDeps`에 넣은 것은 기존 `judge`·`readCurrentFile`·`readPendingReview` 주입 패턴과 동형이고, 덕분에 P2b 통합테스트 7건이 실 grep·실 LLM 없이 결정론으로 돌아간다.

**정적 import 비대칭 — 근거가 코드와 일치.** `judge.ts`는 lazy dynamic import(외부 SDK 무거움), `evidence.ts`는 정적 import. `evidence.ts`가 실제로 `node:child_process`(코어)만 타고 외부 패키지 의존이 없음을 확인했다 — 주석의 근거가 사실이다.

**evidence.ts를 scope.ts와 분리한 결정 — 타당.** 두 수집기의 self-file 정책이 **정반대**다(scope는 제외, gate는 포함). 부분 재사용(`collectGrepContext` 재사용)이 오히려 위험했을 것이고, 실제로는 순수 부품(`parseGrepOutput`·`formatGrepContext`·`realGrep`·`IDENT_KEYWORDS`)만 공유해 드리프트도 막았다.

**골든 캡처를 재판정 이전에 둔 것 — 타당.** 회귀락이 1차 원본 판정을 잠가야 드리프트 감지 기준이 흔들리지 않는다. 다만 부작용으로 **골든 replay는 P2b를 영원히 재현하지 못한다**(replay는 `judge()`를 직접 호출). 이는 `npm run eval`이 `evaluateGate`를 경유하지 않는 것과 같은 구조적 갭이며, 메모리에 이미 정정 기록돼 있다.

**⚠️ 안전성 주장의 범위 — 메모리의 "최악이 '개선 없음'이지 '회귀'가 아니다"는 성립하지 않는다.**

원 근거는 "매치 0 → 재판정 생략 → status quo로 degrade"였다. 매치 0 경로에서는 맞다. 그러나 **매치가 있는 경로**를 보면:

1. `verdict = verdict2`로 **무조건 교체**되며 단조성 가드(`missing2 ⊆ missing1`)가 없다. ⑥-2가 `verdict==="block"`일 때만 진입하므로 pass를 block으로 만들 수는 없어, block→block 축은 "기존 오탐의 형태 변화"에 그친다 — 여기까진 하한이 유지된다.
2. **그러나 block→pass 축은 다르다.** 그 pass는 그대로 `shouldCacheVerdict`를 통과해 작업단위 전체를 캐시 통과시킨다(**F-12**, F-12). 즉 최악은 "개선 없음"이 아니라 **"작업단위 전체에서 게이트가 꺼짐"**이다.

원 근거는 매치 0 경로만 계산에 넣었고, 매치가 있을 때 pass가 어디로 흘러가는지를 추적하지 않았다.

**⚠️ 골든 캡처 배치의 부작용** — 캡처를 재판정 이전에 둔 것 자체는 타당하나(회귀락이 원본 판정을 잠가야 함), 그 결과 **골든 replay·`npm run eval`·단위테스트 어느 것도 실제 P2b를 검증하지 못한다**(F-13, F-13). 이 배치의 유일한 판정 변경에 모델-드리프트 감지 장치가 없다.

---

## 3. 발견 사항

### 【F-1 · 🔴 높음】 `gbc metrics --since` 미구현 — 0.12.0 효과를 측정할 수 없다

**사실**: `--since`는 코드·테스트·CHANGELOG·help 텍스트 어디에도 없다(`grep -rn '--since' src/ test/ CHANGELOG.md` → 0건). `gbc metrics [--all] [--json]`이 전부다(`src/cli.ts:1288`).

**왜 문제인가**: 현재 침묵-누락 block 모집단이 **331건**이다. 0.12.0 배포 후 신규 block이 30건 쌓여도 전체 재계산 시 신규분은 8%에 불과해, P2b가 신규 창에서 오탐을 절반으로 줄여도 집계 rate는 20.6% → 19.6% 수준으로만 움직인다 — 노이즈와 구분 불가.

**원계획이 이미 이걸 알고 있었다**: 메모리의 PR#2 착수조건이 "0.12.0 설치시점을 `--since` 기준으로 재계산, **전체 재계산 금지**(기존 325건이 신규 행동을 희석해 효과와 무관하게 '변화 없음'으로 읽힘)"이다. **즉 후속 PR의 착수조건이 존재하지 않는 플래그에 의존하고 있다.**

**소급 가능성 — 실측 확인**: 원계획의 "나중엔 baseline 재도출 없이 못 넣는다"는 근거는 **성립하지 않는다**.
- 모든 이벤트가 `at`(ISO 타임스탬프)를 보유하고 `classifyBlockOutcome`이 이미 이를 정렬키로 쓴다 → `--since`는 순수 read-time 필터로 사후 구현 가능.
- 유실 위험은 로테이션뿐인데, 1세대 로테이션 임계가 `MAX_EVENTS_BYTES = 5MB`이고 **현재 최대 repo가 513KB(약 10%)**, `.1` 세대를 가진 repo는 **0개**다.

**판정**: 발행 차단 사유 **아님**. 다만 **0.12.1 필수** — 그리고 메모리의 "지금 아니면 못 넣는다" 근거는 사실과 다르므로 정정 기록이 필요하다.

### 【F-2 · 🟡 중간】 신규 계측 필드가 어디에도 집계되지 않는다

`fileBytes`·`truncated`·`evidenceUsed`·`evidenceFlip` 4개 필드는 **이벤트에 기록되기만 한다.** `computeMetrics`도 `printMetricsReport`도 이 필드를 읽지 않으며, 소비처는 타입 선언과 테스트 assertion뿐이다.

ST3의 문자 그대로의 명세("`GateEvent.fileBytes?`/`truncated?`")는 필드 추가까지이므로 **명세 위반은 아니다**. 그러나 목적(P2b 효과 측정) 관점에서는 **"P2b가 몇 번 발화했고 몇 번 판정을 뒤집었는가"를 제품 명령으로 볼 수 없다** — raw `events.jsonl`을 jq로 직접 파싱해야 한다. 이 저장소가 events.jsonl을 "1차 자산"으로 규정해왔으므로 치명적이진 않지만, **F-1과 겹쳐 "측정 인프라를 넣은 릴리스인데 정작 그 릴리스의 효과는 못 잰다"는 결과**를 만든다.

### 【F-3 · 🟡 중간】 P2b가 missing 셋에 새 변동원을 주입해 `block-repeat` 가드를 약화시킬 수 있다

`block-repeat` 가드는 `sameMissingSet` — 정규화 후 **완전 일치**를 요구한다(`src/gate-core.ts:423,455-460`).

P2b 이전에는 missing이 `(spec, editText, currentFile)`에만 의존했다. 이후에는 **grep 결과에도 의존**하며, grep 결과는 개발자가 파일을 쓸수록 변한다. 더 나아가 `collectCaseEvidence`에는 **자기참조 루프**가 있다:

```js
if (grepCalls >= MAX_GREP_SYMBOLS) continue;   // src/evidence.ts:103 — 예산 소진 시 조용히 스킵
```

grep 예산(8회)이 케이스 순서대로 소진되므로 **어느 심볼이 조회되는지가 missing 배열의 길이·순서에 좌우된다.** missing이 3건일 때 3번째 케이스는 예산을 못 받아 매치 0 → 유지되고, missing이 2건으로 줄면 2번째가 예산을 받아 매치 → 해소될 수 있다. 즉 **missing → 근거수집 → missing** 피드백 루프가 존재하며 비단조 진동이 이론적으로 가능하다.

가드가 덜 발화하면 RCA가 최초에 지목한 병리(**같은 작업단위에서 4회 재차단**)가 완화가 아니라 **악화**된다.

**단 과대평가 금지**: missing이 정당하게 줄어드는 것은 P2b의 의도된 동작이며, 그때 잔여 케이스로 재차단하는 것은 노이즈가 아니라 올바른 동작이다. 문제는 **정당한 축소와 예산발 지터를 구분할 수 없다**는 점이고, F-1·F-2 때문에 그 구분이 관측조차 되지 않는다.

**테스트 커버리지**: P2b 통합테스트 7건은 (전부해소·부분해소·매치0·Write억제·fail-open폐기·missing빈배열) 을 덮으나, **2차 판정이 1차보다 missing을 늘리는 경우**와 **동수-다른내용 교체**는 미커버다. 후자는 `evidenceFlip = ... || verdict2.missing.length !== verdict.missing.length`가 **길이만 비교**하므로 flip=false로 오기록된다 — P2b 효과를 증명해야 할 바로 그 지표의 정확도 결함이다.

### 【F-4 · 🔴 높음】 P2b가 JS/TS 저장소 밖에서는 **조용히 무동작**한다

`collectCaseEvidence`가 재사용하는 `realGrep`의 `--include`는 **`*.ts`/`*.js`/`*.tsx`/`*.jsx` 4종뿐**이다(`src/scope.ts:193`). 반면 근거수집기가 심볼을 뽑는 `FILE_TOKEN_RE`는 **20종 확장자**(`py`·`go`·`rs`·`java`·`rb`·`php`·`c`·`cpp`·`cs`·`kt`·`swift`·`json`·`css`·`html`·`md` 등)를 인식한다(`src/evidence.ts:22`).

**귀결**: Python·Go·Rust 저장소에서 gbc를 쓰면 `collectCaseEvidence`는 **어떤 매치도 반환할 수 없고**, ⑥-2는 항상 "매치 0 → 재판정 생략"으로 빠진다. 즉 **0.12.0의 유일한 판정 개선인 P2b가 JS/TS 이외 언어에서는 완전히 무동작**이며, 그 사실이 사용자에게도 로그에도 드러나지 않는다(`evidenceUsed` 키 자체가 생략되므로 "발화 안 함"과 "언어 미지원"이 구분되지 않는다).

부수적으로 `.py`/`.go` 파일명 토큰이 grep 예산(8회)을 소모하면서 항상 무매치이므로, 예산이 **정작 매치 가능한 JS/TS 심볼에 도달하기 전에 소진**될 수 있다(F-3의 자기참조 루프를 악화).

**영향 범위 스코핑**: 현재 등록된 6개 repo는 **전부 JS/TS**이므로 사용자의 현 사용에는 영향이 없다. 그러나 gbc는 npm 공개 패키지이며 README가 언어를 제한하지 않는다 — 외부 사용자에겐 "게이트가 조용히 덜 동작"하는 형태로 나타난다.

### 【F-5 · 🟡 중간】 block 경로 최악 지연이 3배로 늘었다 (동기 차단)

`GREP_TIMEOUT_MS`(4000ms)는 주석이 "grep 총 타임아웃"이라 적혀 있으나(`src/scope.ts:131`), 실제로는 `execFileAsync`의 `timeout` 옵션으로 **grep 호출 1회당** 적용된다(`src/scope.ts:200`). `collectCaseEvidence`는 심볼을 **순차 await**하므로(`src/evidence.ts:105`) 예산 8회 전부 타임아웃하면 32초다.

PreToolUse는 사용자 편집을 **동기 차단**한다. block 판정 1건의 최악 지연:

| | 0.11.3 이전 | 0.12.0 |
|---|---|---|
| 1차 judge (CLI 폴백) | 30s | 30s |
| grep 근거수집 | — | **+32s** |
| 2차 judge (CLI 폴백) | — | **+30s** |
| **합계(최악)** | **30s** | **~92s** |

실사용에서 로컬 grep은 수 ms로 끝나므로 평균 영향은 미미하다(본 세션 eval 평균지연 1978ms). 그러나 **전체 예산 상한이 없다** — `collectCaseEvidence`에는 호출 수 캡(8)만 있고 누적 시간 캡이 없다. `scope.ts`의 주석이 상정한 소비자는 Stop 훅(비차단)이었는데, 이제 차단성 핫패스가 같은 상수를 공유한다.

### 【F-6 · 🟡 중간】 `gbc metrics` 신규 집계 로직이 테스트되지 않는다

0.12.0의 `src/cli.ts` 변경분 중 **테스트로 잠긴 것이 없다.** `test/unit.test.mjs`가 `dist/cli.js`를 서브프로세스로 실행하는 테스트는 `defer`·`hook`·`init`·`update` 커맨드뿐이고, `metrics`를 실행하는 테스트는 전무하다(`grep -rn 'silentOmission\|selfCorrectedFast\|perRepoEvents' test/` → 0건).

특히 `loadMetricsEvents`의 `perRepoEvents`는 주석이 **"병합 후 계산 금지, repo별 계산 후 집계"**라는 강한 불변식을 선언한다(`src/cli.ts:775-813`). 이 불변식이 깨지면 교차repo 오귀속이 조용히 발생하는데(CLI 이벤트 `session=""`가 시간순으로 뒤섞임), 잠그는 회귀락이 없다. `SELF_CORRECTED_WARN_THRESHOLD=0.4` 경고 임계, `--json` 스키마 신규 3키도 마찬가지다.

동일하게 `src/eval/regression.ts`의 `expectedFailing` 분모 제외 로직도 단위 테스트가 없다 — **`npm run eval`을 실 LLM으로 돌려야만 검증된다**(본 세션에서 실행해 정상 동작 확인).

### 【F-7 · 🟡 중간】 발행 게이트가 타임아웃 가드 없이 실 LLM 호출에 의존한다

`/ship` 스킬은 `verify.sh --full`을 호출하지만 `verify.sh`의 인자 루프는 `--no-build`/`--eval`만 인식하므로 **`--full`은 조용히 무시**되고 eval은 돌지 않는다(`verify.sh:12-17`). 이를 알고 `package.json:22`의 `prepublishOnly`에 eval을 편입한 것은 **전역 스킬을 건드리지 않는 옳은 우회**이며, `scripts/publish.sh:29`가 `--ignore-scripts` 없이 `npm publish`를 호출하므로 실제로 발화한다.

다만 `verify.sh`는 eval에 `VERIFY_TIMEOUT_EVAL=900`s 가드를 두는 반면 **`prepublishOnly` 경로에는 어떤 타임아웃도 없다.** 키 없는 CLI 폴백에서 15케이스 × 최대 30s면 이론상 7.5분이고, 응답이 안 오면 `npm publish`가 무한정 매달릴 수 있다.

부수 관찰: `expectedFailing` 도입과 `prepublishOnly`의 eval 추가는 **짝으로 들어온 상호 의존 변경**이다 — `expectedFailing`이 없었다면 known-fail 12번 때문에 `prepublishOnly`가 0.12.0 발행 자체를 막았을 것이다. 한쪽만 revert하면 발행이 깨진다.

### 【F-8 · 🔴 높음】 Write 억제 가드가 Edit/MultiEdit **삭제형 편집**에 구멍이 있다

ST12 하드결정①은 "근거주입기는 *편집 전* 파일을 grep하므로 Write에서 '존재함'을 보고하면 block이 정답인 지점에 pass를 논증한다"는 정확한 위험 인식 위에 서 있다. 그런데 그 가드가 **Write에만** 걸려 있다:

- `isOverwriteEdit`은 `toolName === "Write"` 또는 `content`만 있고 `old_string`/`edits`가 없는 경우에만 true → **Edit/MultiEdit은 항상 통과**(`src/normalize.ts:19-21`, `src/gate-core.ts:439`).
- `collectCaseEvidence(cwd, missing)`는 **편집 대상 파일 경로도 diff도 받지 않는다**(`src/evidence.ts:86-90`). 따라서 grep 매치가 "이번 편집이 지우려는 바로 그 코드"인지 "편집과 무관한 형제 코드"인지 **구조적으로 구분할 수 없다**. 게다가 self-file을 의도적으로 포함하므로 자기 파일의 삭제 대상 코드가 그대로 증거로 잡힌다.
- GATE_SYSTEM의 반전 규칙(★★ — "구버전에만 있고 새 내용에 없으면 삭제되는 회귀")은 명시적으로 `[현재 파일 상태]` 섹션에만 적용된다. 신설된 `[관련 코드 근거(grep)]` 섹션(★★★)에는 **대응하는 반전 규칙이 없다**(`src/judge.ts:514-517`).

**시나리오**: 계획 케이스를 구현하던 기존 코드를 Edit으로 삭제하는 편집 → 1차 judge가 정당하게 block → grep이 *편집 전* 디스크에서 그 코드를 찾아 `matched:true` → 2차 프롬프트에 "이미 구현됨"으로 보이는 증거가 실림 → 정당한 block이 pass로 뒤집힐 수 있다.

**완화 요인**: Edit의 경우 `normalizeEdit`이 `old_string`/`new_string`을 편집 텍스트에 그대로 담으므로 2차 judge도 삭제 사실을 볼 수 있다(Write는 새 내용이 `MAX_FIELD` 4000자에서 잘려 더 위험했다). 따라서 이는 **결정론적 버그가 아니라 LLM 판단에 맡겨진 설계 구멍**이다. 그러나 프로젝트가 Write에 대해서는 같은 위험을 LLM에 맡기지 않고 코드로 차단했다는 점에서 **가드가 비대칭**이며, 회귀락도 없다(`test/gate-core.test.mjs`의 억제 테스트는 Write만 다룬다).

### 【F-9 · 🟡 중간】 `evidenceContext` 총량에 상한이 없다 — 절단 문제를 새 경로에서 재도입

`formatGrepContext`는 **호출 1회당** `MAX_SCOPE_CONTEXT_CHARS`(4000자)로 바운드한다(`src/scope.ts:112-123`). 그런데 케이스별 결과를 합치는 지점에는 총량 캡이 없다:

```js
const evidenceContext = matched.map((e) => `케이스: ${e.case}\n${e.context}`).join("\n\n");  // gate-core.ts:449
```

`verdict.missing`에는 길이 상한이 없고(`src/judge.ts:254` — `Array.isArray(j.missing) ? j.missing.map(String) : []`, 이후 `filterMissingBySpec`이 걸러낼 뿐 개수 제한 없음), 심볼 캐시 때문에 **여러 케이스가 같은 심볼을 공유하면 동일한 매치 목록이 케이스마다 반복 복제**된다(`test/evidence.test.mjs`의 캐시 공유 테스트가 이 동작을 확인). missing 10건이면 최대 40KB가 2차 프롬프트에 실릴 수 있다 — `MAX_CURRENT_FILE`(8000자, 파일 전체 절단 기준)의 **5배**다.

이 릴리스가 다루는 RCA의 주제가 정확히 "프롬프트 예산과 절단"이라는 점에서, 그 문제를 신설 경로에서 재도입한 셈이다. 해당 분기 테스트도 없다.

### 【F-10 · 🟢 낮음(관찰)】 ⑥-2의 예외 흡수 비대칭

⑥-2 블록에는 `collectCaseEvidence` 호출을 감싸는 try/catch가 없다. 예외 시 `evaluateGate` → `preToolUseBody` → `runHookSafely`의 catch로 흡수되어 **전체 fail-open ALLOW**가 되고 이미 확정됐던 정당한 block이 취소된다(`src/hook.ts:82-102`).

**현재는 도달 불가능하다** — `realGrep`이 execFile 실패·타임아웃·maxBuffer 초과를 자체 try/catch로 전부 흡수해 `""`를 반환하고, `extractCaseSymbols`/`parseGrepOutput`/`formatGrepContext`는 순수 문자열 연산이라 throw 경로가 없다. 흡수 방식도 프로젝트 전역 컨벤션(infra throw는 `runHookSafely`가 흡수)과 일치한다.

다만 바로 아래 `verdict2.failOpen` 값검사가 "재판정 실패 시 원 block 유지"를 **명시적으로** 보장하는 것과 대비하면, 같은 블록 안에서 근거수집 실패는 그 보호를 받지 못하는 **비대칭**이다. 향후 `collectCaseEvidence`에 throw 가능한 코드가 추가되면 즉시 실결함이 된다.

### 【F-12 · 🔴 최상위】 근거주입 flip이 작업단위 pass 캐시로 새어 게이트 전체를 무력화할 수 있다

**이것이 본 분석에서 가장 파급이 큰 발견이다.**

⑥-2가 `verdict`를 2차 결과로 교체한 뒤 ⑦ pass 분기로 흘러가는데, 그 끝에 캐시 판정이 있다:

```js
if (shouldCacheVerdict(verdict, specEmpty)) effects.markGated = { specHash, reason: verdict.reason };  // gate-core.ts:400
// shouldCacheVerdict = verdict==="pass" && !failOpen && !specEmpty   (gate-core.ts:79-81)
```

`shouldCacheVerdict`는 **이 pass가 근거주입 재판정 산물인지 전혀 구분하지 않는다.** 그리고 `markGated`가 찍히면 같은 `specHash`(작업단위)의 **이후 모든 편집이 judge 호출 없이 `cached`로 통과**한다(`gate-core.ts:299-306`).

**연쇄**: 노이즈 grep 매치 1건 → 모델이 "이미 구현됨"으로 과대신뢰 → block이 pass로 flip → `markGated` → **그 작업단위 전체에서 게이트가 꺼진다.**

즉 잘못된 flip 1건의 피해가 "오탐 1건 해소 실패"가 아니라 **작업단위 전체의 미탐(false negative) 창구**다. 이는 이 릴리스가 줄이려는 오탐보다 파급반경이 크다.

**"심볼 존재 ≠ 구현"이라는 방어는 코드 하드가드가 아니라 프롬프트 텍스트뿐이다**(`src/judge.ts:517`). 같은 프로젝트가 0.5.5에서 문서 파일 오분류를 막을 때는 `isDocFile` **코드 하드가드**를 넣었던 것과 대칭되지 않는다. 케이스 14(`심볼만존재_절단밖_로직미구현_미탐방지`)가 이 위험을 겨냥한 회귀락이지만, **`npm run eval`은 `evaluateGate`를 경유하지 않으므로 프롬프트 규칙만 검증하고 캐시 연쇄는 전혀 건드리지 못한다.**

**공정한 평가 — 이것은 P2b의 결함이 아니라 F-13의 파급이다.**

이 캐시 메커니즘은 P2b 이전부터 있었고, 1차 judge의 잘못된 pass도 **완전히 동일한** 연쇄를 만든다. P2b가 새 메커니즘을 만든 건 아니다. P2b가 바꾸는 것은 **그 상태에 진입하는 빈도**다 — "block을 pass로 바꾸는 것이 존재 목적인, 의도적으로 관대한 두 번째 경로"를 입구에 추가하기 때문이다.

그리고 **그것이 결함인지 여부는 전적으로 P2b의 정밀도에 달려 있다.** P2b가 옳게 판정한다면 그 pass는 정상 pass와 동등하고 캐시하는 것이 맞다. 문제는 **정밀도가 미측정이고, F-13 때문에 측정 불가능하다는 것**이다.

**따라서 "flip이면 `markGated` 억제" 같은 가드는 권하지 않는다**:
- P2b가 옳았다면 그 가드는 **P2b가 고치려던 바로 그 경로에만 지연 페널티**를 물린다(이후 모든 편집이 full judge, block이 나오면 grep+2차 judge까지).
- 잘못된 1차 pass는 파급반경이 같은데 가드가 없다 — 여러 경로로 도달 가능한 상태의 **한 입구만** 막는 것은 원칙적이지 않다. 진짜 우려가 "cached-pass 파급이 크다"면 결함은 캐시 설계 쪽이다.
- 제어 조건 후보인 `evidenceFlip`은 **F-3에서 부정확하다고 지목한 지표**다(길이 비교). 결함으로 판정한 지표를 제어 흐름에 쓰는 건 자기모순이다. 굳이 쓴다면 `evidenceUsed && verdict==="pass"`가 맞다.

**정정 기록**: 메모리의 안전성 주장("최악이 '개선 없음'이지 '회귀'가 아니다")은 매치 0 경로만 계산했고, **매치가 있을 때 pass가 캐시로 흘러가는 경로를 추적하지 않았다.** 주장의 범위를 좁혀야 한다.

### 【F-13 · 🔴 높음】 P2b는 이 프로젝트 유일의 모델-드리프트 감지 장치 **바깥**에 있다

- 골든 캡처(⑥)는 재판정(⑥-2) **이전**에 1차 verdict로 구성된다 — 의도된 설계다(회귀락은 원본 판정을 잠가야 함).
- `gbc gate snapshot replay`도 `judge()`를 직접 호출하며 `evidenceContext`를 전달하지 않는다(`src/cli.ts:636-639`).
- `npm run eval`(regression.ts)도 `judge()` 직접 호출 — `evaluateGate` 미경유.
- `test/gate-core.test.mjs`의 P2b 통합테스트 7건은 grep·judge를 **fake로 대체**하므로 코드 분기만 잠근다.

**결과**: "실제 grep 결과 + 실제 프롬프트 + 실제 모델이 `[관련 코드 근거(grep)]`를 보고 합리적으로 판단하는가"를 검증하는 자동 장치가 **하나도 없다.**

이것은 이 프로젝트가 자기 RCA에서 이미 진단한 실패 패턴의 재생산이다 — 메모리 기록: *"골든replay는 이 결함에 무신호(currentFileContent 미전달, cases.json 최대 182B) = flip0 거짓안심."* ST6이 `GoldenCase.currentFileContent`를 추가해 그 사각지대를 메웠는데, **P2b가 같은 형태의 새 사각지대를 만들었다.**

### 【F-14 · 🟡 중간】 grep 예산 소진과 "근거 없음"이 구분되지 않는다

`collectCaseEvidence`는 예산 소진 시 `continue`로 조용히 스킵하고 `matched:false`로 마감한다(`src/evidence.ts:103,112`). 이는 "grep했는데 매치 없음"과 **기록상 완전히 동일**하다.

예산 소진 순서는 `missing[]` 배열 순서에 좌우되는데, 그 순서는 **모델의 자유서술 출력 순서**라 결정론적이지 않다. 결과 자체는 보수적 방향이지만(못 찾으면 block 유지), `evidenceUsed`/`evidenceFlip`만으로는 "근거가 진짜 없어서 유지"와 "예산이 모자라 못 봤다"를 사후 구분할 수 없다 — **P0 측정 지표를 왜곡한다.** F-4(무매치 확장자가 예산을 먹는 문제)가 이를 악화시킨다.

### 【F-15 · 🟢 낮음】 API 트랜스포트에는 gbc 측 타임아웃이 없다

F-5의 92초 산식은 **CLI 폴백 경로 한정**이다. `judgeViaApi`/`createApiClient`는 `timeout`·`maxRetries`를 지정하지 않아(`src/judge.ts:268-301`) API 경로 상한이 `@anthropic-ai/sdk` 기본값에 위임돼 있다. 이제 block 경로에서 judge를 2회 부르므로 그 위임의 노출도 2배가 된다.

### 【F-16 · 🟢 낮음】 `judge.ts` lazy import의 "핫패스 zero-dep" 근거가 이미 무효

`gate-core.ts`의 헤더 주석과 `defaultGateDeps`는 "judge를 lazy dynamic import로 감싸 핫패스 zero-dep을 보존한다"고 설명하고, 0.12.0은 이 비대칭(evidence는 정적, judge는 동적)을 새 주석으로 재확인한다.

그러나 **`src/cli.ts:48`이 `judge.js`를 정적 import한다.** `package.json`의 bin은 `dist/cli.js` 단일 진입점이므로, ESM 의미론상 `gbc hook pre-tool-use`를 포함한 **모든** 서브커맨드에서 `judge.js`는 argv 디스패치 이전에 이미 평가된다. `await import("./judge.js")`는 모듈 캐시 히트일 뿐이다.

더구나 `judge.ts` 최상위는 node 코어 모듈만 쓰고 `@anthropic-ai/sdk`는 `createApiClient` 내부에서 별도 동적 import되므로, judge.ts 로딩 자체가 무겁지도 않다. **기능적 결함은 아니지만 주석이 사실과 다르고**, 0.12.0이 그 주석 위에 새 근거를 쌓았다. 남아 있는 실익은 **단위테스트 격리**(gate-core.test.mjs가 judge.js를 안 끌어옴)뿐이므로 주석을 그렇게 정정하는 것이 맞다.

### 【F-11 · 🟢 낮음】 문서 현행화 누락

README에 `--eval`·근거주입·신규 metrics 출력에 대한 언급이 없다(`grep` 0건). CHANGELOG는 충실하므로 사용자 도달성은 확보되나, `gbc metrics` help 한 줄(`src/cli.ts:1288`)도 침묵-누락 부분집합 출력이 추가된 사실을 반영하지 않는다.

---

## 4. 개선 로드맵

### 즉시 (0.12.0 발행 전 — 권고 1건, 비용 0)
- [ ] **【F-4·F-8】 CHANGELOG에 적용 범위 1줄 명시** — "근거주입은 grep `--include` 대상(`.ts`/`.js`/`.tsx`/`.jsx`)에서만 동작하며, `Write`(전체 덮어쓰기)에서는 억제된다." 없는 효과를 주장하지 않기 위한 정직 표기.
- [ ] **【F-13】 사용자 결정** — "자동 검증 0인 관대한 판정 경로를 지금 내보낼 것인가"에 대한 판단. 코드 작업이 아니라 의사결정 항목이다(§0 참조). 아래 0.12.1의 F-13 항목을 발행 전으로 당길지가 실질 선택지.

### 0.12.1 (필수)
- [ ] **【F-1】 `gbc metrics --since <ISO|Nd>` 구현** — read-time 필터라 소급 가능하지만, PR#2 착수조건이 여기 걸려 있어 가장 먼저.
- [ ] **【F-13】 P2b 드리프트 감지 장치 신설** — 골든 replay가 `evidenceContext`를 재현하도록 `GoldenCase`에 근거를 캡처하거나, `evaluateGate`를 경유하는 별도 e2e 케이스를 `cases.json`과 분리해 신설. **현재 P2b는 자동 검증이 0이다.**
- [ ] **【F-2】 `evidenceUsed`/`evidenceFlip`/`truncated` 집계 라인 추가** — `gbc metrics`에 "근거주입 발화 N건 · 판정변경 M건 · 절단 노출 K건".
- [ ] **【F-3】 `evidenceFlip` 판정식 수정** — 길이 비교 → `sameMissingSet` 재사용(같은 파일 455-460행에 이미 있다).
- [ ] **【F-9】 `evidenceContext` 총량 상한** — join 결과에 `MAX_SCOPE_CONTEXT_CHARS` 동급 캡 적용.
- [ ] **【F-8】 Edit 삭제형 가드** — `collectCaseEvidence`에 편집 대상 파일·`old_string`을 전달해 삭제 범위와 겹치는 self-file 매치를 증거에서 제외. 또는 GATE_SYSTEM ★★★에 반전 규칙 추가.
- [ ] **【F-4】 `--include` 확장 또는 `FILE_TOKEN_RE` 축소** — 둘 중 하나로 정합. 확장 시 grep 비용 재측정 필요.
- [ ] **【F-6】 `gbc metrics` 회귀락** — 특히 `perRepoEvents` "병합 후 계산 금지" 불변식.
- [ ] **회귀 테스트 3건** — ① 2차 판정이 missing을 늘리는 경우 ② 동수-다른내용 교체 ③ Edit 삭제형 self-file 매치.
- [ ] 메모리 `project_0_12_0_gate_fp_rootfix` 정정 — "`--since`는 지금 아니면 못 넣는다" 근거 무효(로테이션 여유 실측), PR#2 착수조건이 미구현 플래그에 의존 중.

### 0.12.2 이후
- [ ] **【F-12】 근거주입 pass의 정밀도 관측 후 판단** — F-13·F-2가 해소되면 "evidence-derived pass가 실제로 얼마나 정확한가"를 처음으로 잴 수 있다. **그 수치를 보고 나서** 캐시 진입을 제한할지, 캐시 설계 자체(작업단위 전체 개방)를 재검토할지 결정한다. 수치 없이 가드부터 넣지 않는다.
- [ ] **【F-14】 예산 소진 계측** — `evidenceBudgetExhausted?`를 이벤트에 남겨 "근거 없음"과 "못 봤음"을 분리. 발화하면 예산을 케이스 균등 배분으로 변경 검토.
- [ ] **【F-5·F-7】 시간 예산 상한** — `collectCaseEvidence` 누적 시간 캡 + `prepublishOnly` eval 타임아웃 가드.
- [ ] **P3(절단 개선)** — known-fail 12번의 해소 조건. `MAX_FIELD`(4000) < `MAX_CURRENT_FILE`(8000) 예산 역전도 함께.
- [ ] **【F-16】 주석 정정** — `judge.ts` lazy import의 실익을 "핫패스 zero-dep"에서 "단위테스트 격리"로 수정(`cli.ts:48` 정적 import가 전자를 무효화).
- [ ] **【F-11】 README·help 현행화**.

---

## 5. 기술 스택 최신성

| 기술 | 현재 | 최신 | 상태 |
|---|---|---|---|
| `@anthropic-ai/sdk` | `^0.110.0` | 0.116.0 | ⚠️ 캐럿이라 자동 수용, 실사용 영향 낮음 |
| `@anthropic-ai/claude-agent-sdk` | `0.3.202` (exact pin) | 0.3.226 | ⚠️ pin 고의(0.9.1 사내 레지스트리 dedup 충돌 대응) — 갱신 시 EPERM 현장 이슈 재검증 필요 |
| `ink` | `7.1.0` (exact pin) | 7.1.1 | ✅ patch만 차이 |
| `react` | `19.2.7` (exact pin) | 19.2.8 | ✅ patch만 차이 |
| `typescript` | `^5.6.0` | 7.0.2 | ⚠️ major 2세대 뒤 — 별도 마이그레이션 판단 필요, 본 릴리스와 무관 |
| Node engines | `>=22` (실행 v22.22.1) | — | ✅ |

> exact pin 3종은 전부 **의도된 결정**이며(사내 프록시 레지스트리 dedup 충돌 대응), 본 릴리스가 건드릴 사안이 아니다.

---

> 이 보고서는 Claude Code `/analyze` 스킬로 생성되었습니다.
