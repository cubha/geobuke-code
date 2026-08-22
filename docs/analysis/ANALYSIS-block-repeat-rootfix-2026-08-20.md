# block-repeat 완전일치 취약점 근본수정 — 0.13.0 P4

날짜: 2026-08-20 · 배치: 0.13.0(0.12.0 "후속 PR 배치" P4, 2회 순연 후 착수)

## 배경

block-repeat(`src/gate-core.ts` ⑧ block 분기)는 같은 작업단위(specHash)에서 이미 안내한 침묵-누락
케이스가 다시 발화하면, 사람 승인(ask)이 아니라 조용한 안내(emit-direct, allow)로 강등하는
메커니즘이다(0.9.3 ST2). 판별은 `sameMissingSet` — 정규화 후 배열 완전일치.

`0.12.3 잔여#3`(project_0_12_3_work_unit_history.md)이 "P4(block-repeat) 존폐는 여전히 미착수 —
판단 근거는 실사용 계측이어야 한다는 원칙 유지"로 남긴 항목을, 이번 배치에서 실 이벤트 로그를
직접 채굴해 방향을 확정했다.

## 실측 근거

대상: `fa-support` repo `.gbc/events.jsonl`, specHash `a0cddd870403eeb8`
(2026-07-30T07:16~08:00, 같은 세션·같은 작업단위, gate block 7연속, 강등 0건).

| 시각(UTC) | `missing[]` | 관계 |
|---|---|---|
| 07:16:44 (라인1222) | `["ScheduleReminderService의 scanContractReminders/scanScheduleReminders가 linkUrl을 meta로 전달", "기존 spec 2건은 objectContaining 추가로 갱신"]` | 기준(2항목) |
| 07:17:34 (라인1223) | `["알림 링크 생성 유틸(...) 신규 + ScheduleReminderService의 ... 전달, 기존 spec 2건은 ... 갱신"]` | 1222 병합 + **신규 절 추가**(음성) |
| 07:21:36 (라인1225) | `["ScheduleReminderService의 ... 전달, 기존 spec 2건은 ... 갱신"]` | 1222 두 항목 병합(양성) |
| 07:54:50 (라인1226) | `["scanScheduleReminders가 linkUrl을 meta로 전달"]` | 1222#1 축약(양성) |
| 08:00:17 (라인1228) | `["기존 spec 2건은 objectContaining 추가로 갱신"]` | 1222#2와 **바이트 동일**(양성, 그런데도 미강등) |

`sameMissingSet`(길이+정규화 완전일치)은 1222 대비 위 5건 어느 것과도 매칭하지 않는다 —
LLM이 매 judge 호출마다 같은 잔여 작업을 병합/분리/축약으로 재직렬화하기 때문. 예측된 취약점이
프로덕션 로그에서 그대로 재현됐다.

**1228이 1222#2와 바이트 동일한데도 강등되지 않은 이유**는 문구 드리프트가 아니라 구조적 원인이다
— `writePendingReview`(`src/review.ts`)가 매번 완전 덮어쓰기라, 1228 시점의 비교 대상은 1222가
아니라 직전 1226이었다. 문구 매칭을 고치기 전에 **누적 이력**이 먼저 필요했다.

보조 근거(정성): 같은 미강등 패턴이 최소 5개 클러스터 더 있다(geobuke-code 라인
3062-3064·3181-3182·2993-2994·2231/2236, fa-support 라인 1179/1180/1182·1253-1254). 반대로 LLM이
문구를 그대로 반복한 구간(fa-support 770-777, geobuke-code 3028-3034·3630-3633)에서는 강등이
정상 작동한다 — **메커니즘은 살아있고 매칭 술어만 취약**하다는 진단이 양방향으로 확인된다.

## 검토한 방향과 기각 사유

- **(b) 기능 폐기**: 기각. block-repeat는 실제로 발화하고 있고(위 770-777 등), 0.12.3 P2a
  원장(작업단위 적용이력)과는 축이 다르다 — P2a는 "편집이 실제로 적용됐나"를 묻고, block-repeat는
  "이 경고를 이미 보여줬나"를 묻는다.
- **(c) 관측만 강화**: 기각. 관측(위 채굴)을 이미 이번 계획 수립 과정에서 수행했다. 한 릴리스를
  더 기다릴 근거가 없다.
- **채택: (a) 근사매칭 교체.**

## 설계

### 2계층(Tier1/Tier2) 분리

- **Tier1(기존, 무변경)**: `sameMissingSet` 완전일치.
- **Tier2(신규)**: `isAnnouncedRepeat`(`src/text.ts`) — 누적 안내 이력(`PendingReview.seen`,
  `mergeAnnounced`로 갱신) 대비 새 `missing[]`의 바이그램 커버리지가 `REPEAT_COVERAGE_MIN` 이상이면
  강등.

Tier1만으로는 놓치는 케이스(문구 드리프트)를 Tier2가 잡고, Tier2가 오작동하면
`GBC_REPEAT_MATCH=exact`로 Tier1만 남기는 롤백 경로가 항상 열려 있다.

### 왜 유니그램이 아니라 바이그램인가

block-repeat 강등은 `mode:"emit-direct"` + permission 없음 = **allow**다(`gate-core.ts:621-628`).
즉 과잉억제는 "조용해짐"이 아니라 **사람 ask 없이 편집이 통과**하는 것이라, 미탐 방향의 실패가
더 위험하다. 유니그램(단순 토큰 집합)만 보면 "A가 B를 호출" 공지 후 "C가 B를 호출"(완전히 다른
의미의 새 위반)이 토큰 재조합만으로 높은 커버리지를 얻어 거짓 강등될 수 있다. 인접 바이그램
(`"a가 b를"`, `"b를 호출"` 등)은 이 재조합을 구조적으로 걸러낸다 — 회귀 테스트
`isAnnouncedRepeat(synthetic bigram negative)`가 이 경로를 직접 증명한다.

### REPEAT_COVERAGE_MIN = 0.8 캘리브레이션

위 실측 코퍼스(`test/fixtures/block-repeat-corpus.json`)로 도출:
- 양성 3건(1225_merge·1226_abbrev·1228_identical) coverageRatio = 1.0
- 음성 1건(1223_negative_new_clause, 신규 절 섞인 재진술) coverageRatio ≈ 0.611
- 합성 바이그램 전용 음성(주체 교체) coverageRatio = 0.5

0.8은 음성 상한(0.611)과 양성 하한(1.0) 사이에서 양쪽에 여유(≈0.19/0.2)를 둔 값.

### `sameMissingSet` 불변 유지

`gate-core.ts:536-538`(evidenceFlip 산정)이 같은 함수를 재사용한다. P2b(근거주입) 효과를 증명하는
지표가 이 함수의 완전일치 계약에 의존하므로, 여기서 술어를 느슨하게 하면 flip 지표가 과소집계된다
(0.12.0 F-3에서 이미 한 번 고친 결함의 역방향 재발). 그래서 `sameMissingSet` 자체는 손대지 않고,
block-repeat 쪽에만 `isAnnouncedRepeat`를 OR 조건으로 추가했다. 두 소비처가 이제 "같은 missing인가"에
의도적으로 다른 답을 낸다는 사실을 주석으로 명시(536-540행) — 명시하지 않으면 다음 세션이 통합하려
들 것이다.

### eval/golden 하네스가 무신호인 이유

`src/eval/regression.ts:105`가 `judge()`를 직접 호출해 `evaluateGate`(block-repeat 분기가 위치)를
우회한다. `src/golden.ts`도 judge 재실행만 한다. 즉 block-repeat는 두 하네스 어느 쪽으로도
도달 불가능하다 — `npm run eval` hard 22/22가 **이 배치 전후로 완전히 동일**한 것 자체가 "판정
로직이 judge 도달 이전 단계에서만 바뀌었다"는 정합성 증거이지, 커버리지 증거가 아니다. 실제
회귀락은 `test/gate-core.test.mjs`의 통합테스트(기존 block-repeat 5건 + evidenceFlip 3건 무변경
green, 신규 6건)가 전담한다.

## 예상되는 부작용 — 오탐율(진짜M1) 상승

`src/scoring.ts:99-105,309,314`는 block-repeat를 관측창 `repeated-unresolved`로 닫고, 이는 오탐
후보로 계수된다. 억제가 늘면(Tier2가 더 많은 케이스를 강등) `repeated-unresolved`도 늘어 오탐율
수치가 오른다. 이것은 회귀가 아니라 **더 정확한 억제가 계측에 반영된 결과**이지만, 미리 문서화하지
않으면 다음 세션이 "0.13.0이 오탐율을 악화시켰다"고 오독한다.

`repeatMatch?: "exact" | "covered"`(GateEvent 신규 필드)로 exact/covered를 분리 집계해야
baseline(UPR 61%/IPR 16%, `project_gate_false_positive_rca` 소급계산)과 like-for-like 비교가
성립한다. 단순 전후 비교는 금지.

## 관련

- 로드맵 배치 권위: `project_0_12_0_gate_fp_rootfix`(memory) "후속 PR 배치"
- RCA 원문: `project_gate_false_positive_rca`(memory)
- 회귀 입력 형상 계약 원칙: `feedback_regression_input_shape_contract`(memory) — 이번 코퍼스도
  손으로 재구성하지 않고 실측 이벤트 원문을 그대로 옮겼다(F-13·F-1과 동일 규율 적용).
