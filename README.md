# 거북이코드 (geobuke-code)

> **구현 직전 강제 게이트.** Claude Code의 PreToolUse hook으로, 코드를 쓰기 *전에* 계획 케이스의 침묵 누락과 시나리오 미지정을 차단한다.

`gbc`는 기존 코딩 에이전트(Claude Code) 위에 얹는 **얇은 게이트**다. 모델 계층을 소유하지 않는다 — 판단용 작은 호출(haiku)만 직접 하고, 코드 생성은 그대로 Claude Code가 한다.

## 무엇을 푸는가

구현 전에 강제되지 않는 두 가지가 반복 통증을 만든다:

1. **선행 케이스를 "추후작업"으로 미루다 누락** → 설계 공백 → 큰 결함
2. **시나리오 미지정으로 임의 구현** → 의도와 다른 동작

게이트는 코드 변경(Edit/Write/MultiEdit) 직전에 끼어들어:

- 계획 명세에 있는 케이스가 **침묵 누락**(언급도 등록도 없이 빠짐)되면 차단
- 의도·동작 **시나리오가 미지정**인 채 구현되면 차단
- **미루기는 명시 등록(`gbc defer add`)만 허용** — 침묵 누락 차단의 forcing function

게이트는 *완전 구현*을 요구하지 않는다. 케이스가 다뤄지기 시작했거나 명시 defer되면 통과한다.

## 설치

```bash
# 1) 전역 설치
npm install -g geobuke-code

# 2) 대상 프로젝트에 게이트 설치
cd <your-project>
gbc init                          # .claude/settings.json에 hook + /gate skill 머지 (동의·백업)
```

<details>
<summary>로컬 개발 설치 (소스에서 빌드)</summary>

```bash
# 1) 클론 + 빌드 (dist/ 생성)
git clone https://github.com/cubha/geobuke-code.git
cd geobuke-code
npm install && npm run build

# 2) gbc 명령 연결 — 택1
npm link                          # 권한 OK면 전역 gbc 생성
# ↑ EACCES(전역 node_modules가 root 소유)면 sudo 없이 PATH의 ~/.local/bin에 wrapper:
printf '#!/bin/sh\nexec node "%s/dist/cli.js" "$@"\n' "$PWD" > ~/.local/bin/gbc && chmod +x ~/.local/bin/gbc

# 3) 대상 프로젝트에 게이트 설치
cd <your-project>
gbc init
```

소스를 수정하면 `npm run build`만 다시 하면 된다 — wrapper/link는 같은 `dist/cli.js`를 가리키므로 재연결 불필요.

</details>

`gbc init`은 **프로젝트 로컬 `.claude/settings.json`만** 머지한다(append·멱등·백업). 전역 `~/.claude`는 건드리지 않는다. `~/.gbc/api-key`가 있으면 hook 명령에 키 주입까지 자동화한다(아래 [빠른 게이트 활성화](#빠른-게이트-활성화-api-키--선택)).

## 빠른 게이트 활성화 (API 키 — 선택)

`gbc init`은 키 주입 **없는** hook을 설치한다 → 기본은 `claude -p` 폴백(~13–20s). **haiku 직접 API(~1–3s)**를 쓰려면 키를 **hook 명령에만** 주입한다.

> ⚠️ **`export ANTHROPIC_API_KEY=…` 전역 설정 금지.** Claude Code 본체가 그 키로 **과금 전환**된다(구독 대신 키 과금). 게이트 hook 서브프로세스에만 주입해야 안전하다.

```bash
# 1) 키를 파일에 저장 (권한 600)
mkdir -p ~/.gbc && printf '%s' 'sk-ant-...' > ~/.gbc/api-key && chmod 600 ~/.gbc/api-key
```

```jsonc
// 2) 대상 프로젝트 .claude/settings.json의 PreToolUse command 앞에 키 주입을 추가:
//    "command": "node \"…/dist/cli.js\" hook pre-tool-use"
// →
"command": "ANTHROPIC_API_KEY=\"$(cat ~/.gbc/api-key)\" node \"…/dist/cli.js\" hook pre-tool-use"
```

`gbc status`엔 `트랜스포트: cli`로 보일 수 있다(status 명령 자체엔 키가 없어서). 무관하다 — 실제 hook 발동 시엔 위 주입으로 `api(haiku)` 경로로 동작한다.

## 동작 원리

```
phase-protocol/계획 → /plan(SubTask) → 【게이트: 구현 직전 케이스확정】 → 구현(Claude Code) → 검증
```

게이트는 계획 명세를 다음 우선순위로 읽는다(durable 소스):
`$GBC_SPEC_FILE` > `.gbc/spec.md` > `scratch.md`

코드 변경 직전 PreToolUse hook이 명세 ↔ 변경 ↔ 미룬 항목을 대조해 통과/차단을 판정한다.

### 시나리오 도출 루프 (수기 입력 불필요)

명세가 비어 **시나리오 미지정**으로 차단되면, 사용자가 파일을 직접 쓰지 않는다. 차단 메시지가 코딩 에이전트에게 다음을 지시한다:

```
요청에서 시나리오 도출 → 사용자에게 제시·검증 → gbc spec add로 등록 → 재시도
```

- **도출**은 코딩 에이전트 본체(Opus, 대화 맥락 보유)가, **게이트 판정**은 haiku가 한다 — 두 작업/두 모델 분리. gbc는 모델 계층을 소유하지 않는다(판단용 작은 호출만).
- **사용자 검증은 양보 불가**다 — 같은 에이전트가 도출+구현까지 자동으로 하면 자기 시나리오만 통과시키는 고무도장이 된다. 승인 없는 자동 등록을 금지한다.

## 지연(latency)과 트랜스포트

판정은 작은 LLM 호출이다. 두 트랜스포트:

| 조건 | 트랜스포트 | 지연 |
|---|---|---|
| `ANTHROPIC_API_KEY` 설정됨 | Anthropic API 직접 (haiku, 최소 시스템프롬프트) | ~1–3s (목표) |
| 미설정 | `claude -p` 폴백 (CC 인증 재사용, 무설정) | ~13–20s |

**작업단위 1회**: 게이트는 작업단위(계획 명세 해시)당 한 번만 발동한다. 명세가 바뀌거나 명세 밖 파일을 편집할 때만 재발동 → 매 편집 지연을 피한다.

> 빠른 게이트를 원하면 `ANTHROPIC_API_KEY`를 설정하라(설정법·과금 주의: 위 [「빠른 게이트 활성화」](#빠른-게이트-활성화-api-키--선택)). 없으면 `claude -p` 폴백으로 무설정 동작하되 작업단위당 한 번 느리다.

## 명령

| 명령 | 설명 |
|---|---|
| `gbc init` | hook + /gate skill 설치 |
| `gbc status` | 게이트 상태 + 로드된 명세 확인 |
| `gbc defer add "<케이스>"` | 케이스를 명시적으로 미루기 |
| `gbc defer list` | 미룬 항목 목록 |
| `gbc defer resolve <번호\|텍스트>` | 미룬 항목 해결 |
| `gbc spec add "<케이스>"` | 승인된 시나리오를 `.gbc/spec.md`에 등록 |
| `gbc spec show` | 등록된 케이스 목록 |
| `gbc spec clear` | 명세 비우기(작업단위 종료) |
| `gbc gate reset` | 작업단위 게이트 리셋 |
| `gbc metrics [--json]` | 계측 리포트(M1~M3) |

우회: `GBC_NO_GATE=1` (계측됨 — 우회 자체가 게이트 가치 측정 데이터).

## 계측 (M1~M3)

게이트는 모든 결정을 `.gbc/events.jsonl`(append-only, 메타데이터만 — 코드 본문 미기록)에 기록한다. `gbc metrics`로 집계를 본다. 끄려면 `GBC_NO_METRICS=1`.

| 지표 | 관측 | B-모드 신뢰도 |
|---|---|---|
| **M2** 게이트 적중 vs 도중발견 | 차단이 잡은 누락 케이스 수 vs `defer add`로 도중 등록된 수 | **강** (defer-registry와 1:1) |
| **M3** 재호출/iteration | 작업단위당 편집 반복 횟수 | proxy |
| **M1** post-gate 재작업 | 통과 후 churn(spec 변경·gate reset·defer) | **약** (churn proxy) |

> ⚠️ **진짜 M1**(통과 후 시나리오 위반율)은 게이트가 엔진 출력을 채점하는 **사후 대조**가 필요하다 — 이는 후속 A(standalone) 모드 영역이다. B-커널(hook)은 churn 약신호만 관측한다. `events.jsonl` 원시 로그는 그때 그대로 재사용된다.

## 정직한 한계

- 사후 대조가 아닌 **구현 전 게이트**다 — "도중 탈선"은 못 잡는다(설계상 후속 C 영역).
- 판정은 LLM이라 100% 아니다. **사람이 변이 전 케이스를 리뷰/편집하는 pause**가 진짜 가치다.
- MVP scope = **B-커널**(CC-native hook + defer-registry + /gate). standalone TUI·추출 모드는 후속 A(public). 계측은 B-모드 관측 프록시(M1~M3)까지 구현됨(위 [계측](#계측-m1m3)).
- **검증 상태**: 게이트 판정 품질은 **양 트랜스포트 모두 회귀 8/8(FP0 FN0)**. 직접 API(haiku) 경로 실측 **평균 1.7s**(1.1–2.5s), claude -p 폴백 ~18s. 직접 API용 게이트 프롬프트는 최소화하면서 정확도를 유지하도록 "동작 편집 vs 비-동작 편집" 2단계 분류로 튜닝했다(`ANTHROPIC_API_KEY=… node dist/eval/regression.js`로 재현).
- **fail-open**: 판정 호출이 실패하면(키 오류·네트워크 등) 게이트는 안전하게 통과시킨다(개발 차단 방지). 단 fail-open 통과는 작업단위 캐시에서 제외되고(다음 편집 재판정), `systemMessage` 경고 + `.gbc/failopen.log` 계측으로 드러난다(조용한 무력화 방지).

## 라이선스

MIT
