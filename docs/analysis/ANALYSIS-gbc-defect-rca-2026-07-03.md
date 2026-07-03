# gbc 결함 4건 원인분석 보고서 (codebase-viz 도그푸딩)

> 분석일: 2026-07-03
> 프로젝트: geobuke-code (npm 0.5.4)
> 분석 관점: codebase-viz 도그푸딩 세션(2026-07-03 01:00~01:20Z)에서 실측된 결함 4건 —
> (A) 문서 심사 시 미래 작업 침묵-누락 판정→defer 오용 유도, (B) missing 판정문 원문 ID 오매핑,
> (C) Stop 리마인드 "1회만 표시" 문구 위반, (D) defer 종결 상태 단일(resolved)로 행정 종결↔완료 미구분
> 증거: codebase-viz `.gbc/events.jsonl` · `pending-review.json`(01:11:12Z) · `defers.json` · `spec.archive/` — 전부 실측 대조 완료

---

## 0. 판정 요약

| # | 결함 | 원인 층위 | 근본원인 | 심각도 |
|---|---|---|---|---|
| A | 문서 편집을 침묵-누락 block → defer 오용 유도 | **LLM 프롬프트 준수 실패 + 코드 하드가드 부재** | GATE_SYSTEM 1단계("문서 → 무조건 pass")를 judge가 자기 서술로 인정하면서 위반. 게이트엔 scope와 달리 결정론적 파일필터가 없어 프롬프트가 유일한 방어선 | 🔴 |
| B | missing 판정문 ID 오매핑 (PERF-1↔ARCH-1) | **LLM 재서술 + 검증 부재** | GATE_SYSTEM에 원문 인용 제약 없음 + parseVerdict가 missing[]을 명세와 교차검증하지 않음. A와 결합 시 missing의 출처가 명세가 아니라 *편집 본문*이라 재서술 왜곡이 무제한 | 🟡 |
| C | Stop 리마인드 매 턴 반복 (문구는 "1회만") | **문구-계약 불일치 (구현 아님)** | "1회만"에 해당하는 로직이 코드에 존재하지 않음. `stop_hook_active` 가드는 턴 내 루프 방지일 뿐. 매 턴 반복은 의도된 설계(음소거가 opt-out)이고 문구가 계약을 과대표현 | 🟡 |
| D | 행정 종결이 resolved로 기록 → 완료 오독 | **수명주기 모델 표현력 부족 (설계 갭)** | `DeferStatus`에 종결 상태가 resolved 하나뿐. 철회(withdrawn)가 없어 "완료 아님" 종결이 불가. resolved는 judge에 [이미 완료된 항목]으로 전달되고 metrics에 완료로 남음 | 🟡 |

핵심 구조 진단: **A·B는 같은 병의 두 증상이다.** gbc 자신의 0.5.2 설계 원칙 — *"하드가드는 프롬프트가 아니라 코드에서 강제"*(scope의 `parseScopeVerdicts` 하드가드, `CODE_FILE_RE` 큐잉 필터) — 이 게이트(PreToolUse) 경로에는 적용되지 않았다. 게이트의 1단계 분류와 missing 도출 규칙은 전적으로 haiku의 프롬프트 준수에 의존하며, 위반해도 코드가 잡지 못한다.

---

## 1. 실측 시퀀스 재구성 (events.jsonl 확정)

```
07-02 14:56:08Z  gate block  (specHash="", missing=["분석 보고서 작성 전 계획 단계… 미지정", …])
                 → 분석 문서(MD) Write를 specEmpty block. ← 1단계 위반 #1 (문서인데 동작편집 취급)
07-03 01:09:50Z  spec-add    "분석 보고서: 범위=… 산출물=docs/analysis/ANALYSIS-*.md 1건 (사용자 승인 완료)"
07-03 01:11:12Z  gate block  (specHash=c353d87f, missing 8건 = SEC-1~4/PERF-1/ARCH-1~3 remediation)
                 → pending-review.json 기록. ← 1단계 위반 #2 + missing 출처 위반(명세 아닌 편집 본문)
07-03 01:11:55Z  defer-add ×4 (block 안내문의 'gbc defer add' 경로를 에이전트가 그대로 수행)
07-03 01:17:30Z  gate pass   (deferCount=4 — "미래 작업이 defer됨"으로 이제야 통과)
07-03 01:19:08Z  done        (spec 아카이브+리셋 — 정상)
07-03 01:11~02:05 Stop 리마인드 매 턴 발화 (6회+, 미해결 defer 4건 존속 구간)
07-03 02:05:53Z  defer-resolve (사용자 지적 후 resolve all — 행정 종결이 'resolved'로 영구 기록)
```

주목: 재Write가 "pass했으나 기록"이 아니라 **01:11:12Z에 block(ask 모드)** 이었고, 사용자가 ask 다이얼로그에서 허용해 편집이 적용된 것이다(발생 보고의 2번 항목은 ask-통과를 pass로 인지한 것 — gbc 동작 기준으론 block). 진짜 pass는 defer 4건 등록 후 01:17:30Z.

**반복 패턴 입증**: 동일 위반이 2026-06-24T00:06:06Z에도 있었다 — README 편집 block, judge 사유 원문: *"README는 문서이지만, 내용이 코드 동작(buildDiagrams, …)의 구현 완료를 선언하므로 계획 명세와의 대조 필수"*. 즉 **"코드에 관해 서술하는 문서"는 haiku가 1단계 무조건-pass를 목적론적 추론으로 재해석해 뒤집는 재현성 있는 실패 모드**다(최소 3회: 06-24 README, 07-02 첫 Write, 07-03 재Write).

---

## 2. 결함별 원인분석

### A. 문서 편집 침묵-누락 판정 → defer 오용 유도 🔴

**직접 증거 (pending-review.json reason 원문, 01:11:12Z):**
> "현재 편집은 분석 문서(마크다운) 작성으로 **동작과 무관하나**, 계획 명세에서 산출물=…라고 명기된 것은 문서 자체가 '다음 버전 마이그레이션 계획 근거'라는 뜻. … 추적 가능한 작업 단위(이슈/마일스톤/미룬항목 등록)가 문서 내에도 [명시적으로 미룬 항목]에도 없음."

judge가 **1단계 분류를 스스로 "동작과 무관"으로 판정해 놓고**(GATE_SYSTEM: "동작과 무관한 편집 → **무조건 pass**", `judge.ts:92`) 명세의 "용도=/braintrust 입력→마이그레이션 계획 근거" 문구를 근거로 목적론적 요구사항("각 항목별 배정 명기")을 발명해 block했다. 프롬프트 규칙 위반이 명문으로 남은 드문 케이스.

**원인 사슬 (3층):**

1. **[코드] 게이트에 결정론적 문서 필터 부재** — scope 경로는 `CODE_FILE_RE`(hook.ts:142)로 문서/설정을 큐잉에서 원천 제외하지만, 게이트 경로는 `.md` Write도 전량 judge에 보낸다. 1단계 분류가 프롬프트 유일 방어선인데, "코드를 서술하는 문서"는 haiku의 분류를 반복적으로 뒤집는 입력이다. (분석 문서는 코드 스니펫·함수명·동작 서술로 가득해 표면 특징이 동작편집과 유사.)
2. **[프롬프트] missing 도출 출처 무제약** — 2단계(b)의 missing은 "**계획에 적힌** 형제 케이스"로 정의되지만(judge.ts:98), 이 사건의 명세는 한 줄("산출물=분석 MD 1건")이고 missing 8건은 전부 **편집 본문(분석 문서의 remediation 항목)에서 추출**됐다. 출처 규칙 위반을 코드(parseVerdict)가 검증하지 않는다.
3. **[안내 채널 증폭] block 안내가 오판을 상태 오염으로 전파** — `buildBlockReason`(hook.ts:45-49)과 pending-review 안내는 missing이 있으면 무조건 "gate review로 분류하거나 defer add로 미루라"를 제시한다. 에이전트는 안내를 충실히 따랐고, 그 결과 **오판이 defers.json 4건 + events.jsonl(M2 게이트적중 +8, defer-add +4) + 이후 세션의 Stop/SessionStart 노이즈로 고착**됐다. defer의 의미론("구현 중 발생한 미룸")이 "계획 문서의 로드맵 항목"으로 확장 오염된 것도 이 지점.

**계측 오염 정량**: M2(게이트적중 vs 도중발견)에서 이 사건의 missing 8건은 "게이트적중"으로, defer 4건은 "도중발견"으로 집계된다(metrics.ts:187-190). 오탐이 thesis 지표를 **양방향으로 부풀린다**.

### B. missing 판정문 원문 ID 오매핑 🟡

**실측**: pending-review의 "PERF-1 캐시 이중 구조 충돌 해결 코드"(실제 PERF-1=동기 fs I/O, 캐시 이중 구조=ARCH-1), "ARCH-1 mermaid-renderer 모듈 분리 구현"(모듈 분리는 별개 §2 항목).

**원인 사슬:**
1. GATE_SYSTEM 출력 스키마(judge.ts:109-110)에 missing 항목의 **원문 인용(verbatim) 제약이 없다** — haiku가 자유 재서술하며 ID·내용을 재조합.
2. A와 결합해 악화: missing의 정당한 출처(명세)가 한 줄뿐이라, 모델은 4000자 절단된(normalize.ts MAX_FIELD) 편집 본문에서 항목을 압축·요약 재구성했다. 재서술 왜곡이 구조적으로 무제한.
3. `parseVerdict`(judge.ts:132-142)는 missing[]을 **string 캐스팅만** 하고 명세 텍스트와 교차검증하지 않는다 — scope의 코드 하드가드(파싱 결과를 filesWithContext로 눌러 검증)와 대조적.

### C. Stop 리마인드 반복 (문구 "1회만" 위반) 🟡

**원인: "1회 표시 로직 미동작"이 아니라 로직 자체가 존재하지 않는다.** 코드 사실관계:
- `buildStopReminder`(hook.ts:595)가 매번 "(이 리마인드는 1회만 표시됩니다.)"를 하드코딩 출력.
- 유일한 dedup은 `stop_hook_active` 가드(hook.ts:476) — 이것은 **같은 턴 안에서** Stop block→재응답→Stop 재발화 루프를 끊는 장치다. 턴이 바뀌면 새 Stop 훅이 뜨고 미해결 defer가 있는 한 매번 발화한다.
- 세션 단위 dedup 기계는 코드베이스에 이미 존재하나(업데이트 안내의 `wasNotified`/`markNotified`, cwd×session 키) Stop 리마인드엔 연결돼 있지 않다.

**설계 이력과의 정합**: 매 턴 반복 자체는 의도된 동작이다 — 0.2.6에서 이 반복이 시끄럽다는 이유로 `/gbc-mute`(세션 영속 음소거)를 만들었고, 당시 진단이 정확히 "stop_hook_active는 턴 내 루프만 끊고 세션 영속 상태 없음→매 턴 재발화"였다. 즉 **결함의 실체는 행동이 아니라 문구**: "1회만 표시됩니다"는 아마 "이 리마인드가 턴을 1회만 잡는다(루프 없음)"는 의미로 쓰였으나 사용자 계약으로는 "세션에 1회"로 읽히는 허위 진술이다.

### D. defer 종결 상태 단일 → 행정 종결이 완료로 기록 🟡

**코드 사실관계** (types.ts:34, defer.ts:137-144):
- `DeferStatus = open | in_progress | resolved` — 종결 상태가 resolved 하나. `resolveDefer`가 유일한 종결 전이. 삭제·철회 경로 없음.
- 이 사건에서 사용자는 "오등록 정정"을 원했지만 수단이 resolve all뿐 → defers.json에 4건 `status:"resolved"` 영구 기록.

**오염 반경 (resolved의 3개 소비처):**
1. **judge 입력**: `resolvedDeferItems`(defer.ts:77-81)가 resolved를 [이미 완료된 항목]으로 judge에 전달(hook.ts:227) — 철회된 항목(예: 이후 기각된 oxlint류)이 "**이미 완료됨**"으로 모델에 진술된다. 0.4.2의 재차단 방지엔 우연히 도움되지만 의미론이 거짓.
2. **계측**: `defer-resolve` 이벤트가 완료 신호로 남는다. 향후 A2(진짜 M1 사후대조)나 defer 해소율 지표를 만들면 가짜 완료 4건이 섞인다.
3. **사람/타 세션 가독**: `gbc defer list`·크로스repo 롤업에서 resolved=완료로 읽힌다.

---

## 3. 교차 진단 — 왜 지금 드러났나

- **입력 유형의 사각**: 게이트의 골든셋·단위 테스트는 코드 편집 케이스 중심이다. "코드에 관해 서술하는 문서"(분석 보고서·README 기능 서술)는 1단계 분류의 adversarial 입력인데 회귀락(golden replay)에 이 유형 케이스가 없다.
- **empty-spec 수정(2026-06-22)과의 비대칭**: 당시 "(c) 무차별 차단은 judge [1단계] 문서편집 통과 의도를 깨는 회귀"라며 기각했다 — 즉 **"문서는 통과"가 확정된 제품 의도**다. 그 의도를 프롬프트에만 두고 코드로 강제하지 않은 갭이 이번에 노출됐다.
- **defer 의미론의 확장 압력**: 게이트가 계획 단계 산출물(분석 문서)에 개입하면서, "구현 중 미룸"용 defer가 "로드맵 추적"으로 오용될 통로가 열렸다. 계획-추적은 메모리/계획 문서의 영역이라 이중화가 발생.

---

## 4. 개선 방향 판정 (발생 보고의 제안 4건 + 추가 1건)

> 구현 착수는 별도 결정. 아래는 원인분석에 근거한 타당성 판정.

| 제안 | 판정 | 근거·수정 방향 |
|---|---|---|
| ① 비코드 문서 심사 분기 | **채택하되 더 강하게** — 프롬프트 분기가 아니라 **결정론 하드가드** | "문서 내 배정 명기 인정" 같은 프롬프트 세공은 같은 실패 모드(haiku 재해석)에 다시 노출된다. 제품 의도가 "문서=무조건 pass"로 이미 확정돼 있으므로, scope의 `CODE_FILE_RE`를 게이트 진입부에 재사용해 **비코드 확장자는 judge 미호출 즉시 pass**가 정공법(0.6.0 후보, hook.ts `runPreToolUse` 초입 + 계측 태그 `doc-skip` 권장). 3회 재현 실패 모드를 원천 제거하고 판정 비용·지연도 절감 |
| ② missing 원문 인용 | **채택 + 코드 교차검증 병행** | 프롬프트에 verbatim 제약 추가만으로는 B는 줄지만 A의 "명세에 없는 항목 발명"은 못 막는다. `parseVerdict`에서 missing 각 항목이 명세 텍스트에 (정규화) 부분일치하는지 검사해 불일치 항목을 드롭/표시하는 **코드 하드가드**가 scope 철학과 정합 — 발명된 missing이 pending-review·defer로 흘러가는 길을 코드가 차단 |
| ③ Stop 리마인드 1회 로직 점검 | **문구 즉시 수정(필수) + 세션 dedup은 별도 결정** | 존재하지 않는 로직이므로 "점검"이 아니라 둘 중 하나: (a) 문구를 사실에 맞게 — "매 턴 표시됩니다. 끄려면 /gbc-mute" (최소·무위험), (b) `wasNotified` 기계를 재사용해 세션당 1회 dedup 기본화 (행동 계약 변경 — 리마인드의 존재 이유인 '이월 의식화'가 약해질 수 있어 설계 결정 필요). 최소안 (a)는 즉시 적용 가능 |
| ④ withdrawn 상태 추가 | **채택 (설계 갭 실증됨)** | `DeferStatus`에 `withdrawn` 추가 + `gbc defer withdraw <ref>`. 필수 동반 결정 3개: ⓐ judge 입력에서 withdrawn은 [이미 완료된 항목]에 **넣지 않는다**(거짓 진술 차단 — 명세에 없는 항목이라 재차단 위험도 없음) ⓑ metrics `defer-withdraw` 이벤트 분리 ⓒ `promote()` 하위호환(status 부재 시 기존 규칙 유지). 표면(list·리마인드·롤업)에서 withdrawn은 unresolved 집계 제외 |
| ⑤ (추가) block 안내의 defer 유도 조건화 | **검토 권장** | ①이 들어가면 문서발 오유도는 사라지지만, 코드 편집 block에서도 missing이 "미래 별도 작업"일 때 defer 등록이 로드맵 이중화를 만드는 구조는 남는다. 안내문에 "이 변경의 형제 케이스만 defer 대상, 별도 작업단위는 계획 문서에" 한 줄 추가가 저비용 완화 |

**우선순위 제안**: ③(a) 문구 수정(1줄, 무위험) → ① 문서 하드가드 + 골든셋에 문서형 케이스 추가(회귀락) → ② 프롬프트+parseVerdict 교차검증 → ④ withdrawn (④는 스키마·CLI·judge 입력 3면 변경이라 가장 큼). 전부 B-라인(hook 모드) 소관이며 A(100) 로드맵과 독립 — 0.6.0 재스코프 4건(verify 후속)과 함께 0.6.0 후보로 묶는 것이 자연스럽다.

---

## 5. 증거 출처

- `codebase-viz/.gbc/events.jsonl` — 07-02 14:56 block / 07-03 01:09 spec-add / 01:11:12 block(missing 8) / 01:11:55 defer-add×4 / 01:17:30 pass(deferCount 4) / 01:19:08 done / 02:05:53 defer-resolve. 06-24 00:06:06 README block(반복 패턴).
- `codebase-viz/.gbc/pending-review.json` — reason 원문("동작과 무관하나 … block") = 1단계 자인 위반.
- `codebase-viz/.gbc/defers.json` — 4건 status:resolved (행정 종결).
- `geobuke-code/src/judge.ts:87-110`(GATE_SYSTEM) · `132-142`(parseVerdict 무검증) · `src/hook.ts:32-50`(buildBlockReason) · `142`(CODE_FILE_RE, scope 전용) · `465-499`(runStop) · `589-597`(buildStopReminder "1회만" 문구) · `src/defer.ts:34-81, 137-144` · `src/types.ts:34` · `src/metrics.ts:187-202`(M2/churn 집계) · `src/review.ts`(pending-review 기록 경로).

---

> 이 보고서는 Claude Code `/analyze` 스킬로 생성되었습니다 (외부 리서치 생략 `--no-research`).
