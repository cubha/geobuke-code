# PLAN — 0.14.0 「repo 전파 + 판정응답 파싱 견고화」

생성: 2026-08-31 · 파이프라인: `/sh-dev-loop --tdd --auto` · 라우팅: 전량 `[S]`

## 사용자 요구사항 원문

1. > 우선 지금 gbc update하면 repo등록된 모든대상이 일괄적으로 init yes 되니?

   → 확인 결과 **아니오**(`cmdUpdate`는 cwd 하나만, 레지스트리 미참조). 이어서:

2. > gbc update --all를 추가하는거로하자

3. > (fail-open 배너를 보고) 이것도계속뜨는거같은데 그냥진행되고잇어. 뭐때문인지, pass해도되는건지 내용확인해봐
   >
   > 응 진행해 /sh-dev-loop --tdd --auto

   → 진단 결과 `parseVerdict`의 탐욕적 JSON 추출이 원인. 그 수정까지 이 배치에 포함.

## 확정 제약 · 결정

- **도그푸딩 hook 보존**(사용자 선택, AskUserQuestion 2026-08-29): `--all`이 타 repo dist를 가리키는
  hook을 만나면 **덮어쓰지 않는다**. 선택지 중 「보존 — 실존하는 cli.js면 안 건드림」이 채택됐고,
  「전역 경로로 정규화」·「--force 옵션 추가」는 기각.
- **판정 프롬프트 불변**: 이번 배치는 판정 응답의 **파싱**만 고친다. `GATE_SYSTEM`·프롬프트 조립은
  건드리지 않으므로 eval baseline(hard 22)은 **무변경이 정상 신호**다.
- **테스트 약화 금지**: 문구 변경으로 기존 단언이 깨지면 새 계약으로 **강화** 방향으로만 갱신하고
  그 사실을 보고한다.

## SubTask

```
[Task] 0.14.0   라우팅: 전량 [S] (독립 [P] 후보 2 < 임계 4)

  ST1  [TDD] gbc update --all — 레지스트리 전파        → src/install.ts · src/cli.ts · test/unit.test.mjs
  ST2  [TDD] 교차참조 도그푸딩 hook 보존               → src/install.ts · test/unit.test.mjs
  ST3  문서화(help · README)                          → src/cli.ts · README.md
  ST4  [TDD] 판정응답 JSON 추출 견고화                 → src/judge.ts · test/unit.test.mjs
```

ST1~ST3은 이 PLAN 작성 시점에 **이미 구현·검증 완료**(1252/1252). ST4가 이번 파이프라인의 신규 작업.

## SubTask별 요구 동작

### ST1 — `gbc update --all`
- 레지스트리(`~/.gbc/repos.json`) 등록 repo 전체를 순회해 각각 `gbc init --yes`.
- **전역 npm 설치는 1회**(공유 자원이라 repo마다 재설치할 이유가 없다).
- cwd 우선 · 중복 제거(레지스트리가 자기 자신을 포함하는 실측 사례 대응).
- 건너뛰기 2종: 디렉토리 없음(stale 항목) · `.gbc` 없음(gbc 프로젝트 아님). **조용히 빠뜨리지 않고 사유 보고**.
- fail-soft: 한 repo 실패가 순회를 중단시키지 않고, 끝에 실패 목록 + exit 1.
- `--dry-run`은 실행 없이 대상만 출력.
- 보안: 레지스트리 경로를 **명령 문자열에 보간하지 않고** `spawnSync`의 `cwd` 옵션으로만 전달.

### ST2 — 도그푸딩 hook 보존
- PreToolUse 명령이 **실존하는 cli.js**를 가리키면 정규화 대상에서 제외.
- 판정은 `normalizeHooks`(쓰기)와 `hasStalePreToolUse`(읽기)가 **같은 술어를 공유**해야 한다 —
  한쪽만 고치면 "정규화는 안 하는데 stale이라고 나그하는" 모순이 남는다.
- 죽은 경로는 정규화(자가치유). 옛 bash 키주입 형태는 계속 정규화(진짜 구식 감지 유지).

### ST3 — 문서화
`gbc --help`와 README 명령 표에 `--all` 반영.

### ST4 — 판정응답 JSON 추출 견고화 (이번 신규)

**결함**: `parseVerdict`가 `raw.match(/\{[\s\S]*\}/)` — 첫 `{`부터 **마지막** `}`까지 탐욕적으로 집는다.
모델이 JSON 뒤에 중괄호를 포함한 내용을 덧붙이면 잘린 구간이 "완결 JSON + 나머지"가 되어
`JSON.parse`가 `Unexpected non-whitespace character after JSON`으로 던진다. 예외는
`runHookSafely` fail-open으로 흡수되어 **그 편집은 게이트 검사를 받지 못한다**.

**실측**: daily-news-dispatch에서 2026-08-30 발생(판정 4152건 중 fail-open 10건, 그중 이 유형 3건).
재현 성공 — 실패 형태 2종: ⓐ JSON 뒤 둘째 `{...}` 블록 ⓑ 코드펜스 + 중괄호 낀 설명.
JSON 뒤 산문에 중괄호가 **없으면** 통과하므로 평소엔 드러나지 않는다.

**요구 동작**:
- 응답에서 **첫 번째 유효 JSON 객체**만 취한다(균형 잡힌 `{}` 스캔, 문자열 리터럴·이스케이프 인식).
- 앞쪽에 중괄호 낀 산문이 오는 경우까지 덮기 위해, 후보 `{`마다 시도해 **처음 파싱되는 것**을 채택.
- 유효 JSON이 하나도 없으면 기존처럼 throw(→ fail-open). **절단된 응답은 이 수정의 대상이 아니다**
  (다른 fail-open 유형 — 원인이 응답 truncation이라 파서로 못 고친다).
- 판정 프롬프트 무변경.

## 검증 규약

- SubTask 게이트는 `bash verify.sh`(플래그 없이) — 이 repo verify.sh는 `--full`/`--ts-only`를
  파싱하지 않고, 테스트가 전부 `../dist/*.js` import라 빌드 생략은 stale dist 거짓 green 위험.
- 최종 게이트 `bash verify.sh --eval`.
- eval hard 22 **무변경이 정상**(판정 프롬프트 무변경).
- 외부 I/O(프로세스 스폰) 포함 → 샌드박스 실증 필수(phase-protocol Post-Phase 6).

## 범위 확대 (Phase 3 scope-critic 판정 수용, 2026-08-31)

`scope-critic`이 ST4에 대해 `DECISION_CHANGED: yes` — 같은 탐욕적 패턴이 **두 곳 더** 있었다:
`parseReviewVerdict`(reviewed 경로) · `parseScoreVerdict`(score 경로). 직접 코드로 확인해 사실로
판정하고 범위를 넓혔다 — 셋 다 `extractFirstJsonObject`를 공유한다.

두 경로는 throw를 `try`로 잡아 `unverifiable`/`unscored`로 매핑하므로 **fail-open은 아니다**(심각도
차이). 그럼에도 고친 이유는 ST2에서 `isValidPreCommand`를 단일 술어로 묶은 것과 같다 — 같은 원인을
한쪽만 고치면 비대칭이 남아 다음 사람이 또 밟는다.

회귀락 2건 추가: `test/unit.test.mjs`(parseReviewVerdict) · `test/scoring.test.mjs`(parseScoreVerdict).
