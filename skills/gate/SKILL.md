---
name: gate
description: 거북이코드 구현-전 게이트를 관리한다. 로드된 계획 명세 확인, 미룬(defer) 항목 등록·조회·해결, 작업단위 게이트 리셋, 작업단위 명시 종료(gbc done), 구현 후 결과검증(gbc verify). PreToolUse hook이 코드 변경을 차단했을 때 이 스킬로 케이스를 명시적으로 미루거나 게이트 상태를 점검한다. '/gate', '게이트 상태', '케이스 미루기', 'defer 등록', '게이트 리셋', '작업단위 종료', 'gbc done', '결과검증', 'gbc verify', '게이트가 막아' 등 언급 시 호출.
---

# /gate — 구현-전 게이트 관리

거북이코드(`gbc`)는 코드 변경(Edit/Write/MultiEdit) 직전에 PreToolUse hook으로 동작해, **계획 명세의 케이스를 침묵 누락하거나 시나리오 미지정으로 구현이 진행되는 것**을 차단한다. 이 스킬은 그 게이트를 사람이 관리하는 표면이다.

## 핵심 원칙

- **미루기는 명시 등록만 허용한다.** "추후작업"이라고 머릿속/주석으로만 미루면 게이트가 침묵 누락으로 차단한다. 정당한 미루기는 반드시 `gbc defer add`로 등록해야 통과된다. (= 통증 "추후작업 미루다 누락" 직격)
- **게이트는 완전구현을 요구하지 않는다.** 케이스가 다뤄지기 시작했거나 명시 defer되면 통과. 침묵 누락과 시나리오 미지정만 막는다.

## defer 수명주기 — 자연어로 전환한다 (사용자가 명령을 직접 칠 필요 없음)

defer 항목은 **open(미착수) → in_progress(진행중) → resolved(해결)** 3상태를 갖는다. 대부분의 경우 사용자는 `gbc defer …`를 직접 입력하지 않는다 — **에이전트가 대화(자연어)와 편집 대상을 감지해 백그라운드에서 전환을 실행**하고, 사용자에게 표면화한다. (명령은 수동 보정용으로 항상 사용 가능.)

| 전환 | 트리거(감지) | 에이전트 행동 |
|---|---|---|
| **start** (open→진행중) | 그 defer 항목을 **실제로 착수**할 때(NL "이거 할게" 또는 해당 코드 편집 시작) | `gbc defer start <ref>` 자동 실행 + 표면화. 보수적으로 — 실제 착수할 때만(투기적 표시 금지). |
| **resolve** (→해결) | **사용자의 명시적 완료 선언**("X 끝났어", "점검 OK") | 명확하면 `gbc defer resolve <ref>` 실행 + **반드시 표면화**. |
| **reopen** (→open) | 사용자가 보류/이월/잘못된 resolve 취소를 요청 | `gbc defer reopen <ref>` 실행 + 표면화. |

**resolve 모호성 규칙 (load-bearing — 미완성 항목이 조용히 잊히는 harm 차단):**
- **명확한 완료 선언**("로그인 검증 끝냈어") → 자동 resolve + 표면화.
- **모호한 신호**("다음으로 넘어가자", "대충 됐어") → **resolve하지 말고 사용자에게 확인**한다. resolve된 항목은 리마인드/SessionStart에서 사라지므로, 잘못 resolve하면 미완성인 채 잊힌다.
- resolve는 **절대 게이트(judge)가 편집을 보고 추론하지 않는다** — 항상 사람의 명시 선언이 트리거. (start만 편집 감지로 자동.)
- 모든 자동 전환은 **사용자에게 표면화**해 catch·reopen할 수 있게 한다.

> 이상적 흐름: defer 확인 → (특정/전체 항목) start → 구현 → **사용자 점검** → resolve. 세션 내 완전 해소 안 되는 항목은 in_progress로 이월되고, SessionStart가 "진행중 N · 미착수 M"으로 구분 표면화한다.

## 명령 (bash로 실행)

게이트는 현재 프로젝트 루트의 `gbc`를 사용한다. 작업 디렉토리에서 실행:

| 의도 | 명령 |
|---|---|
| 게이트 상태·로드된 명세 확인 | `gbc status` |
| 미룬 항목 목록(상태: 미해결/진행중/해결) | `gbc defer list` |
| 케이스를 명시적으로 미루기 (→ open) | `gbc defer add "<케이스 설명>"` |
| 착수 표시 (open → 진행중) | `gbc defer start <번호\|텍스트\|all>` |
| 종결 표시 (→ 해결) | `gbc defer resolve <번호\|텍스트\|all>` |
| 백로그로 되돌리기 (→ open) | `gbc defer reopen <번호\|텍스트\|all>` |
| 승인된 시나리오를 명세에 등록 | `gbc spec add "<케이스>"` |
| 등록된 케이스 목록 | `gbc spec show` |
| 명세 비우기(아카이브 없이) | `gbc spec clear` |
| **작업단위 명시 종료**(명세 아카이브→비움 + 게이트 리셋) | `gbc done` |
| **사후 결과검증**(케이스↔증거 대조, verified>reviewed>unverifiable) | `gbc verify` |
| 작업단위 게이트만 리셋(명세 보존·같은 단위 재게이트) | `gbc gate reset` |
| block이 도출한 누락 케이스 체크리스트 보기 | `gbc gate review` |
| 누락 케이스 일괄 분류(승인→spec / 미룸→defer) | `gbc gate review --spec <번호\|텍스트\|all> --defer <번호\|텍스트\|all>` |
| 판정 골든셋 캡처 토글·조회 | `gbc gate snapshot <on\|off\|status\|list\|clear>` |
| 골든 케이스 재판정·드리프트 점검(temp 0, 뒤집힘 시 exit 1) | `gbc gate snapshot replay [--samples N]` |

## 사용 흐름

1. **게이트가 침묵 누락으로 차단했을 때**: hook이 사유와 누락 케이스를 알려주고, 그 케이스들은 `.gbc/pending-review.json`에 기록된다. 케이스가 여러 개면 하나씩 `gbc spec add`/`gbc defer add`를 반복하지 말고 **체크리스트로 일괄 분류**한다:
   1. `gbc gate review` — 도출된 누락 케이스를 번호 목록으로 본다.
   2. 사용자에게 제시·검증받는다(승인할 케이스 / 미룰 케이스 구분).
   3. `gbc gate review --spec <승인 번호들> --defer <미룸 번호들>` — 한 번에 승인은 spec.md 등록, 미룸은 defer 등록(겹치면 spec 우선). 펜딩은 비워진다.
   4. 재시도하면 등록 기준으로 재판정 → 통과.
   - 단건이면 종전대로 (a) 지금 이 변경에서 직접 다루거나 (b) `gbc defer add "케이스"`로 미뤄도 된다. (절대 주석으로만 미루지 말 것)
2. **시나리오 미지정으로 차단됐을 때 — 에이전트 도출 루프**: 사용자가 명세를 수기로 쓰지 않는다. 에이전트가 다음을 수행한다:
   1. 사용자 요청에서 의도·동작 시나리오와 형제 케이스를 **도출**한다.
   2. 도출한 케이스를 사용자에게 **제시하고 검증받는다** — **사용자 승인 없이 자동 등록·구현 금지**(같은 에이전트가 도출+구현하면 고무도장이 됨).
   3. 승인된 케이스를 `gbc spec add "<케이스>"`로 등록하거나 `.gbc/spec.md`에 직접 작성한다.
   4. 재시도하면 통과한다.
   > 시나리오 도출은 코딩 에이전트 본체(Opus)가 대화 맥락으로, 게이트 판정은 haiku가 — 두 작업/두 모델 분리(gbc는 모델 계층을 소유하지 않는다).
3. **세션 종료 시**: Stop hook이 미해결 defer를 "진행중 N · 미착수 M"으로 구분 리마인드한다. `gbc defer list`로 확인하고, 사용자 완료 선언이 있었으면 resolve, 아니면 다음 세션으로 의식적으로 이월한다(진행중 항목은 in_progress 그대로 남아 다음 SessionStart에 표면화).
4. **작업단위(현재 명세) 전체가 끝났을 때 — `gbc done`으로 명시 종료**: 명세(`.gbc/spec.md`)를 `.gbc/spec.archive/`로 보존한 뒤 비우고 게이트를 리셋한다. **이걸 하지 않으면** 며칠 뒤 무관한 새 작업을 시작할 때 옛 명세의 미체크 케이스가 "현재 작업의 형제 케이스"로 부활해 침묵 누락 오탐을 낸다(2026-06-26 진단·근본수정). `gbc spec clear`는 아카이브 없이 비우기만, `gbc gate reset`은 명세를 **보존**한 채 같은 단위를 재게이트하는 별개 동작이다 — 작업단위를 끝낼 땐 `gbc done`을 쓴다.

## 사후 결과검증 — `gbc verify` (구현 *후* 게이트)

게이트(PreToolUse)는 구현 *전* "계획 케이스를 다루는가"만 본다. `gbc verify`는 구현 *후* "결과물이 케이스를 실제로 충족했는가"를 **증거와 대조**해 본다. gbc는 **테스트를 실행하지 않는다** — 표준 결과(JUnit XML)를 *읽거나*, 러너가 없으면 LLM이 최종 코드를 *독해*한다(provider 패턴·RCE 차단·이식성).

**판정 사다리** (강→약):

| 강도 | 판정 | 증거 | 바인딩 |
|---|---|---|---|
| 강 | **verified** | 테스트 실행 통과/실패(JUnit XML) | `::test <테스트명>` |
| 중 | **reviewed** | LLM이 최종 코드 독해(주소화 판정·*동작 증명 아님*) | `::file <경로>` |
| 약 | **unverifiable** | 증거 없음(결과파일·파일·바인딩 부재) — 정직 바닥 | (없음) |

**케이스↔증거 바인딩** — spec 케이스 줄 끝에 접미사로 붙인다:

```
gbc spec add "빈 자격증명 거부 ::test login_empty_creds"      # 러너 결과로 verified
gbc spec add "로그인 검증 로직 ::file src/auth.ts"            # 코드 독해로 reviewed
gbc spec add '경계조건 처리 ::test "should handle empty"'      # 공백 포함 테스트명은 따옴표
```

- **verified 쓰려면**: 러너가 JUnit XML을 `.gbc/verify-results.xml`로 떨구게 한다. 예 — `vitest run --reporter=junit --outputFile=.gbc/verify-results.xml`, `pytest --junit-xml=.gbc/verify-results.xml`, `node --test --test-reporter=junit --test-reporter-destination=.gbc/verify-results.xml`. gbc는 이 파일을 **읽기만** 한다(실행·spawn 안 함). ⚠️ gbc는 결과파일 신선도를 검사하지 않는다 — **코드 변경 후 러너를 재실행**하고 verify해야 옛 결과에 대한 거짓 verified를 피한다(provenance 스탬프는 후속).
- **reviewed**: 러너 없이도 동작. `::file` 케이스의 코드를 LLM이 독해해 충족 여부 판정(refute-first). 단 **독해는 동작 증명이 아니다** — 미묘한 버그·런타임 오류는 못 잡는다.
- **failed·unverifiable 케이스**는 `gbc verify`가 `gbc defer add "..."` 형태로 **후보 제안만** 한다 — 자동 등록하지 않는다(사람이 분류). defer 원칙과 동일.
- 바인딩이 cwd(프로젝트) 밖을 가리키면 읽지 않고 거부한다(`review:outside` — spec.md는 커밋/PR 파일이라 유출 방지).

## 명세 소스

게이트는 다음 우선순위로 계획 명세를 읽는다(durable 소스만):
`$GBC_SPEC_FILE` > `.gbc/spec.md`

`.gbc/spec.md`가 단일 정본(canonical)이다. `scratch.md` 자동 폴백은 0.2.2에서 제거됐다(진행추적 파일을 명세로 오인하던 거짓음성 차단) — 다른 파일을 명세로 쓰려면 `$GBC_SPEC_FILE`로 명시 지정한다.

명세가 비면 "시나리오 미지정"으로 모든 코드 변경이 차단된다. 보통 위 「사용 흐름」 2의 도출 루프가 `gbc spec add`로 `.gbc/spec.md`를 채운다(수기 작성 불필요).

## Known Pitfalls

- **주석 defer는 defer가 아니다.** `// 비밀번호 검증은 다음에` 같은 코드 주석은 게이트가 침묵 누락으로 본다. 반드시 `gbc defer add`로 레지스트리에 등록해야 한다.
- **게이트는 작업단위당 1회만 발동한다.** 명세가 바뀌거나 명세 밖 파일을 편집할 때 재발동한다. 강제로 다시 점검하려면 `gbc gate reset`.
- **작업단위를 끝내면 `gbc done`을 호출한다 — 안 하면 옛 케이스가 부활한다.** 명세는 append로만 누적되고 작업단위 "완료" 이벤트가 없어, 끝난 케이스가 `.gbc/spec.md`에 미체크로 남으면 다음 작업단위 등록 시 형제 케이스로 재차단된다(드리프트 오탐). `gbc done`이 명세를 아카이브·비워 이 누적을 끊는다. (완화책으로 0.4.2부터 resolved된 defer는 judge에 `[이미 완료된 항목]`으로 전달돼 재플래그를 줄이지만, 근본 정리는 `gbc done`이다.)
- **같은 케이스 중복 등록은 자동 skip된다(0.4.2).** `gbc spec add`/`gbc defer add`/`gbc gate review`가 정규화 동일 케이스(미해결)를 다시 등록하려 하면 "중복 등록 skip"으로 알리고 더미를 키우지 않는다. resolved된 항목의 동일 텍스트 재등록은 정당한 재-defer로 허용된다.
- **게이트가 한 repo에서 아예 안 먹는다면** hook이 미등록·구식일 수 있다. `gbc repos list`가 등록된 각 repo의 게이트 건강성(`⚠️게이트hook부재`/`⚠️SessionStart누락`)을 표시한다 — 떴으면 그 repo에서 `gbc init --yes` 재실행. (크로스-repo는 hook 등록 여부만 검사하고 명령 freshness는 각 repo `gbc status`로 확인.)
- **`--no-gate` / `GBC_NO_GATE=1` 우회는 계측된다.** 우회 자체가 게이트 가치 측정 데이터가 된다.
- **판정 드리프트가 의심되면**(모델/gbc 업그레이드 후 게이트가 전과 다르게 군다) `gbc gate snapshot on`으로 한동안 캡처하고, 나중에 `gbc gate snapshot replay`로 재판정해 pass↔block 뒤집힘을 점검한다. 골든셋은 **편집 본문을 로컬 `.gbc/golden.json`에만** 저장한다(gitignore·로컬 pre-flight 전용 — 커밋하면 privacy 불변식 위반).
- **`gbc verify`의 reviewed/unverifiable는 "통과"가 아니다.** verified만 테스트 실행으로 증명된 통과다. reviewed는 LLM 코드 독해(그럴듯함, 동작 보증 아님), unverifiable은 증거 없음(모름). 셋을 한 칸으로 뭉치지 말 것 — 거짓 확신(reviewed를 pass로)·거짓 경보(unverifiable을 fail로) 둘 다 harm이다. 강한 검증을 원하면 케이스에 `::test` 바인딩 + 러너 JUnit 출력을 배선한다.
