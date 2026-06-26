# 거북이코드(gbc) 게이트 — defer-spec 드리프트 오탐 근본 원인 분석

> 분석일: 2026-06-26
> 프로젝트: geobuke-code (gbc) — 구현-전 게이트 (v0.4.1)
> 분석 관점: spec은 작업단위별 시나리오 명세인데, 작업단위가 끝났음에도 며칠 지난 항목이 spec에 잔존해 defer로 부활하는 현상의 근본 원인과 개선방안

---

## 0. 한 줄 답 — "왜 며칠 지난 항목이 부활하는가"

**시스템에 작업단위 "완료(end)" 이벤트가 존재하지 않는다.**

`.gbc/spec.md`는 **append 전용 누적 파일**이고, 작업단위 경계는 `gbc spec add`로 텍스트가 바뀔 때 **specHash 변화로만 감지**된다(= *시작* 트리거). 정리 경로는 수동 `gbc spec clear` 하나뿐 — `gate reset`도 `defer resolve`도 본문을 건드리지 않는다. 결과적으로 며칠 전 완료된 케이스가 `- [ ]` 미체크 상태로 spec.md에 영구 잔존하고, 새 작업단위를 등록하는 순간 judge에게 "현재 작업의 형제 케이스"로 다시 제시되어 침묵 누락으로 차단된다. **시간(며칠)은 hash와 무관하다 — 옛 텍스트가 지워지지 않을 뿐이다.**

---

## 1. 데이터 모델 — 3개의 분리된 진실 소스

게이트는 세 파일을 읽지만, 셋의 라이프사이클이 동기화되지 않는다.

| 파일 | 쓰기 경로 | 라이프사이클 | judge 입력 여부 |
|---|---|---|---|
| `.gbc/spec.md` | `addSpecCase`(append `- [ ]`), `clearSpec`(전체 비움) | **완료 시 자동 비움 없음.** `spec clear` 수동만 | ✅ 전체 본문 raw (`loadPlanSpec`) |
| `.gbc/defers.json` | `addDefer`, `resolveDefer`(status 전환) | open→in_progress→resolved | ⚠️ **resolved 제외** (`activeDeferItems`) |
| `.gbc/state.json` | `markGated`, `resetGate` | specHash 기준 1회 캐시 | ❌ (캐시 스킵 판정용) |

세 소스가 **공통 키 없이** 자유 텍스트로 따로 산다. 이것이 드리프트의 토양이다.

---

## 2. 재현 경로 (코드 라인 추적)

### 2-1. 작업단위 A (며칠 전)
1. `gbc spec add "C4: 그리드 컬럼 정의 검증 …"` → `addSpecCase`가 항상 `- [ ] …` 로 append (`src/spec.ts:70`).
2. 게이트 통과, 작업 완료. defer 트래커의 C4·C5 항목을 `gbc defer resolve` → `resolveDefer`가 **defers.json status만 전환** (`src/defer.ts:117`).
3. **spec.md 본문의 `- [ ] C4 / - [ ] C5`는 그대로 잔존.** resolve가 본문을 안 건드림. `addSpecCase`는 `- [x]`로 전환하는 경로 자체가 없음 — 툴 전체에 체크 전환 함수가 부재.

### 2-2. 작업단위 B (며칠 후, 무관한 리팩토링)
4. `gbc spec add "B1: …"` → spec.md = `C4, C5(미체크) + B1`.
5. 텍스트가 바뀌어 `computeSpecHash`(전체 텍스트 sha256, `src/spec.ts:51`) 변화 → `isGated`가 false (`src/state.ts:26`) → **새 작업단위로 간주, 게이트 재발동.**
6. `judge(specText, editText, activeDeferItems)` 호출 (`src/hook.ts:204`):
   - `specText` = spec.md **전체 본문** (C4·C5·B1 모두) — `buildUserMessage`가 raw 그대로 주입 (`src/judge.ts:79`).
   - `activeDeferItems`는 **resolved를 필터링** (`src/defer.ts:52`) → 완료된 C4·C5는 `[명시적으로 미룬 항목]`에서 빠짐.
7. judge 시점에 C4·C5는 **"계획에 적힌 형제 케이스인데, 이번 편집에서도 안 다뤄지고 명시 defer에도 없는 것"** = GATE_SYSTEM `[2단계](b)` 침묵 누락 정의에 정확히 부합 (`src/judge.ts:64`) → **block.**
8. 사용자는 "무관" 사유로 **신규 defer 등록** → defers.json에 같은 의미의 항목이 시점만 달리 중복 누적 (사용자 데이터의 #4/#11 C4, #8/#12 C5 중복이 이 메커니즘).

> **핵심 모순**: defer 트래커는 C4·C5를 "완료(resolved)"로 알지만, judge에는 그 사실이 전달되지 않는다(resolved는 입력에서 제외). 동시에 spec.md는 C4·C5를 "미체크(미완료)"로 보여준다. **judge가 보는 세계에서 C4·C5는 계획됐으나 처리도 defer도 안 된 항목** — 부활의 정체.

---

## 3. 근본 원인 (primary) vs 부차 요인

### 3-1. Primary — 작업단위 라이프사이클 부재 (데이터 모델 결함)
- **경계가 add-트리거다 (완료-트리거가 아님).** 작업단위 "시작"은 `spec add`의 hash 변화로 감지되지만, "완료"를 표현하는 이벤트가 시스템에 없다.
- **툴 전체가 append 전용.** 유일한 축소 경로는 수동 `gbc spec clear`(`src/cli.ts:339`). `gate review` 승인분조차 `addSpecCase`로 더미를 키운다(`src/cli.ts:515`) → **기존 도구만으로는 spec.md 더미가 절대 줄지 않음 = 누적이 구조적.**
- **`gate reset`은 종료가 아니다.** `resetGate`는 specHash를 보존한 채 gated 플래그만 내린다(`src/state.ts:38`) — "같은 작업단위 재게이트"이지 "단위 종료"가 아니다. 따라서 자연스러운 "새 일 시작" 동작이 옛 spec 본문을 그대로 둔다.
- "작업단위별 명세"라는 **의도**와, "모든 과거 케이스가 누적된 단일 파일"이라는 **실제**가 어긋난다.

### 3-2. 부차 요인 — judge의 무관 케이스 오연관 (정밀도)
- judge가 도메인적으로 무관한 케이스(파일 통합 리팩토링 vs 그리드 컬럼 검증)를 "형제"로 오분류하는 프롬프트 정밀도 한계도 존재한다.
- **그러나 이것은 primary가 아니다.** spec 더미가 클수록 오연관 표면이 늘 뿐이다. 라이프사이클이 원인, 프롬프트는 증상 증폭기. **프롬프트 튜닝을 "the fix"로 올리지 말 것.**

---

## 4. 개선방안 평가 (사용자 제시 a/b/c 비판적 검토)

자가검토가 흘렸던 **3가지 제약**을 먼저 고정한다:

> **C1. judge는 체크박스 상태를 전혀 안 본다.** `buildUserMessage`는 raw 텍스트를 넣고 GATE_SYSTEM에 `[x]`/완료 개념이 없다(`src/judge.ts:53-87`).
> **C2. defer 엔트리 ↔ spec 라인 안정 join key가 없다.** 사용자 데이터에서 이미 텍스트가 갈라짐(defer "…무관" vs spec "…1:1 매핑"). fuzzy 매칭은 신뢰 불가.
> **C3. 툴 전체가 append 전용.** 더미 축소 경로가 수동 `spec clear` 단 하나.

| 안 | 내용 | 판정 |
|---|---|---|
| **(a)** resolve 시 spec.md 라인 `- [x]` 전환 | 🔴 **비추** | C1: judge가 `[x]`를 안 봄 → 단독 무효. 게다가 `[ ]→[x]` 한 글자가 specHash를 바꿔 **다음 편집에서 새 작업단위로 재발동**(역효과). C2: 어느 라인을 체크할지 join 불가. 살리려면 GATE_SYSTEM에 "[x] 제외" 규칙 추가 + hash 계산에서 체크박스 무시까지 필요 — 복잡도 대비 무가치. |
| **(b)** judge가 resolved 교차조회해 형제 후보에서 제외 | 🟡 **부분완화(band-aid)** | resolved defer를 judge에 `[이미 완료된 항목]` 블록으로 **함께 전달**하면 join key 불필요(resolved 텍스트만 추가)하고 재플래그를 막는다. 단 **누적·hash churn은 미해결** — spec 더미는 계속 자람. |
| **(c)** 완료 라이프사이클(`spec clear`/`sweep` + 명시 완료 시 호출) + 중복 감지 | 🟢 **1순위** | primary(라이프사이클 부재)를 직접 친다. 개별 매핑(C2)이 필요 없어 가장 견고. |

---

## 5. 개선 로드맵

### 5-1. 즉시 개선 (Quick Win)
- [ ] **중복 등록 감지** — `addSpecCase`/`addDefer`에 정규화 텍스트 동일 항목 존재 시 skip 또는 경고. 사용자 데이터의 C4·C5 시점차 중복(#4/#11, #8/#12)을 바로 차단. (2차 증상 해소, 저위험)
- [ ] **(b) resolved 가시화** — `buildUserMessage`에 `[이미 완료된 항목]` 블록 추가, judge가 재플래그 안 하도록 GATE_SYSTEM 1줄 보강. join key 불필요, 즉시 오탐 완화. **단, 임시 완화임을 명시** (누적은 미해결).

### 5-2. 단기 개선 (1~2주) — primary fix
- [ ] **(c) 명시적 완료 신호 도입** — `gbc done`(또는 `gbc next`) 신설: spec.md를 archive(예: `.gbc/spec.archive/<specHash>-<at>.md`)한 뒤 `clearSpec` + `resetGate`. 작업단위를 **명시적으로 닫는** 유일한 정당 경로.
  - ⚠️ **`gate reset`에 clear를 얹지 말 것** — reset은 "같은 단위 재게이트" 의미라 다세션 단위가 오작동한다(advisor 제약). 완료 신호는 별도·명시적이어야 한다.
  - `resolve all`과 연동 검토: 미해결 defer가 0이 되는 순간을 완료 후보로 제안(자동 실행 X, 사용자 확인).
- [ ] **프로토콜 발화** — `DEFER_PROTOCOL`(`src/hook.ts:354`)에 "작업단위 완료 시 `gbc done`" 규약 1줄 추가. SKILL.md(gate)에도 완료 절차 명문화. (hint 문자열이 규약 주입의 결정론 채널이므로 여기 반영이 실효)

### 5-3. 중장기 개선 (1개월+)
- [ ] **spec ↔ defer 단일 모델 통합 검토** — 케이스를 `{id, text, status, specHash}` 단일 엔티티로 두고 spec.md/defers.json을 이 모델의 뷰로 파생. 세 진실 소스(§1)를 하나로 합쳐 드리프트를 구조적으로 제거. (큰 리팩터 — 도그푸딩 데이터로 ROI 확인 후 착수)
- [ ] **judge 정밀도 보강(부차)** — 형제 케이스 판정에 "현재 편집과 동일 기능 영역인가" 게이트를 명시화. **단 §3-2대로 secondary로 한정** — primary 해결 후 잔여 오탐에만 적용.

---

## 6. 결론

- 증상(며칠 지난 항목 부활)의 **primary 원인은 데이터 라이프사이클 결함**: 작업단위 완료 이벤트가 없어 spec.md가 영구 누적되고, resolved defer가 judge에 안 보여 완료 케이스가 "미처리 형제"로 되살아난다.
- (a)는 역효과(hash churn), (b)는 band-aid, **(c) 명시적 완료 라이프사이클이 정답**. (b)+중복감지를 Quick Win으로 먼저 깔아 출혈을 막고, (c)로 근본을 닫는다.
- 프롬프트 정밀도는 증상 증폭기일 뿐 — primary로 오인하지 말 것.

---

> 이 보고서는 Claude Code `/analyze` 스킬로 생성되었습니다. (제네릭 기술스택·트렌드 섹션은 단일 버그 분석 범위 밖이라 의도적으로 생략.)
