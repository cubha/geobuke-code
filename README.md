# 거북이코드 (geobuke-code)

> **계획 ↔ 구현 ↔ 검증을 잇는 게이트.** 코드를 쓰기 *전에* 계획 케이스의 침묵 누락·시나리오 미지정을 PreToolUse hook으로 차단하고, 구현 *후* `gbc verify`로 케이스가 실제 충족됐는지 증거(테스트 결과·코드 독해)와 대조한다.

`gbc`는 기존 코딩 에이전트(Claude Code) 위에 얹는 **얇은 게이트·검증 층**이다. 모델 계층을 소유하지 않는다 — 판단용 작은 호출(haiku)만 직접 하고, 코드 생성은 그대로 Claude Code가 한다. **테스트를 실행하지도 않는다** — 표준 결과(JUnit)를 *읽을* 뿐이다.

## 무엇을 푸는가

구현 전후로 강제되지 않는 것들이 반복 통증을 만든다:

1. **선행 케이스를 "추후작업"으로 미루다 누락** → 설계 공백 → 큰 결함
2. **시나리오 미지정으로 임의 구현** → 의도와 다른 동작
3. **"됐다"는데 케이스가 실제 충족됐는지 대조 안 됨** → 통과 후 누락 발견

**① 구현 전 게이트** — 코드 변경(Edit/Write/MultiEdit) 직전에 끼어들어:

- 계획 명세에 있는 케이스가 **침묵 누락**(언급도 등록도 없이 빠짐)되면 차단
- 의도·동작 **시나리오가 미지정**인 채 구현되면 차단
- **미루기는 명시 등록(`gbc defer add`)만 허용** — 침묵 누락 차단의 forcing function

게이트는 *완전 구현*을 요구하지 않는다. 케이스가 다뤄지기 시작했거나 명시 defer되면 통과한다.

**② 구현 후 결과검증(`gbc verify`)** — 구현이 끝난 뒤 케이스가 실제 충족됐는지 **증거와 대조**하는 판정 사다리:

- **verified** — 테스트 실행 결과(JUnit XML)가 케이스를 통과/실패로 증명(`::test` 바인딩)
- **reviewed** — 러너가 없으면 LLM이 최종 코드를 *독해*해 경량 판정(`::file` 바인딩, 동작 증명 아님)
- **unverifiable** — 증거가 없으면 정직하게 미검증(거짓 통과·거짓 경보 안 함)

gbc는 테스트를 *실행하지 않고* 표준 결과를 *읽는다* — 러너가 어떤 것이든(jest·vitest·pytest·go…) JUnit만 내면 이식된다 ([`gbc verify`](#사후-결과검증-gbc-verify)).

그 위에 운영을 돕는 얇은 층이 붙는다:

- **누락 케이스 일괄 분류** — 차단이 도출한 형제 케이스를 번호 체크리스트로 받아 한 번에 승인(spec)/미룸(defer) ([`gbc gate review`](#누락-케이스-일괄-분류-gbc-gate-review))
- **크로스-repo 가시성** — 등록한 다른 repo의 미해결 defer 요약 + 게이트 hook 건강성 롤업("회사 repo에서 게이트가 조용히 안 먹는다"를 한 명령으로 진단) ([크로스-repo](#크로스-repo-가시성))
- **판정 드리프트 회귀락** — 실제 판정을 캡처해두고 모델/프롬프트/SDK 변화 후 재판정해 pass↔block 뒤집힘을 잡는 로컬 pre-flight ([`gbc gate snapshot`](#판정-드리프트-회귀락-gbc-gate-snapshot))
- **관측 계측(M1~M3)** — 게이트 적중·재호출·통과 후 churn. 여러 repo는 `gbc metrics --all`로 병합 ([계측](#계측-m1m3))
- **운영 현황 관측(`/gbc-monitor` 스킬)** — 위 게이트 상태·계측·repo 건강성·드리프트락을 묶어 조회·해석하는 읽기전용 표면(상태 변경은 `/gate`) ([`/gbc-monitor`](#운영-현황-관측-gbc-monitor))

## 설치

```bash
# 1) 전역 설치
npm install -g geobuke-code

# 2) 대상 프로젝트에 게이트 설치
cd <your-project>
gbc init                          # .claude/settings.json에 hook(PreToolUse+Stop+SessionStart) + /gate · /gbc-mute · /gbc-monitor skill 머지 (동의·백업)
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

`gbc init`은 **프로젝트 로컬 `.claude/settings.json`만** 머지한다(append·멱등·백업). 전역 `~/.claude`는 건드리지 않는다. hook 명령은 **셸 무관 순수 형태**(`node "<path>" hook pre-tool-use`)라 Windows(cmd.exe)/bash/zsh/Mac에서 동일하게 동작한다.

## 빠른 게이트 활성화 (API 키 — 선택)

키가 없으면 `claude -p` 폴백(~13–20s)으로 무설정 동작한다. **haiku 직접 API(~1–3s)**를 쓰려면 **키 파일만 만들면 된다** — gbc가 실행 시 직접 읽으므로 settings.json 수정이나 셸 주입은 불필요하다.

> ⚠️ **native Windows에선 API 키를 권장한다.** 키 없는 `claude -p` 폴백도 지원하지만(win32에선 `claude.cmd` 실행을 위해 셸 경유, 프롬프트는 인젝션 회피로 stdin 전달, 무응답 방지 kill-timeout), 폴백은 느리므로(~13–20s) 위 키 파일로 API 경로(~1–3s)를 쓰는 편이 빠르고 확실하다.

> 🔒 **회사·보안통제(EDR/그룹정책) 환경에선 API 키가 사실상 필수다.** native Windows에서 `claude.exe`가 EDR·정책에 막히면(증상: `claude exited 1: 액세스가 거부되었습니다`), 키 없는 `claude -p` 폴백 호출이 매번 실패해 게이트가 **조용히 fail-open**된다 — 게이트가 느려지는 게 아니라 **꺼진다**(`.gbc/failopen.log`에 누적). 이때 `ANTHROPIC_API_KEY`(또는 키 파일)를 설정하면 CLI spawn을 건너뛰고 직접 API로 판정하므로 **막힌 환경에서도 게이트가 살아 있다**. 즉 이 경우 키는 속도가 아니라 **게이트 작동 자체**의 문제다. (깨끗한 native Windows에선 keyless 폴백도 정상 동작함이 검증됨 — 실패는 환경의 CLI 차단에서 비롯된다.)

키 해석 순서: `ANTHROPIC_API_KEY` 환경변수 > `~/.gbc/api-key` 파일.

```bash
# bash / zsh / WSL / Mac
mkdir -p ~/.gbc && printf '%s' 'sk-ant-...' > ~/.gbc/api-key && chmod 600 ~/.gbc/api-key
```

```powershell
# native Windows (PowerShell) — -NoNewline 필수(끝에 개행 붙으면 키 오염)
New-Item -ItemType Directory -Force -Path "$HOME\.gbc" | Out-Null
Set-Content -Path "$HOME\.gbc\api-key" -Value "sk-ant-..." -NoNewline
```

> ⚠️ **`export ANTHROPIC_API_KEY=…` 전역 설정(또는 settings.json top-level `env`) 금지.** Claude Code 본체가 그 키로 **과금 전환**된다(구독 대신 키 과금). 키 파일 방식은 gbc 판정 호출에만 키가 쓰이므로 이 함정을 구조적으로 피한다.

`gbc status`는 키 파일/환경변수를 반영해 `트랜스포트: api`로 표시한다.

## 동작 원리

```
phase-protocol/계획 → /plan(SubTask) → 【게이트: 구현 직전 케이스확정】 → 구현(Claude Code) → 【gbc verify: 구현 후 케이스↔증거 대조】
```

게이트는 계획 명세를 `.gbc/spec.md`(단일 정본)에서 읽는다. 다른 파일을 명세로 쓰려면 `$GBC_SPEC_FILE` 환경변수로 그 경로를 명시 지정한다(우선순위 `$GBC_SPEC_FILE` > `.gbc/spec.md`). gbc가 소유하지 않은 파일을 자동 폴백하지 않으므로, 진행추적 파일 등이 명세로 오인되지 않는다.

코드 변경 직전 PreToolUse hook이 명세 ↔ 변경 ↔ 미룬 항목을 대조해 통과/차단을 판정한다.

### 동작 시점

`gbc init`이 프로젝트 `.claude/settings.json`에 아래 hook을 멱등 등록한다. gbc는 `.gbc/`만 읽으므로(다른 하네스의 메모리·진행추적 파일 미접근) 어떤 환경에서든 동일하게 동작한다.

| 시점 | hook (matcher) | 동작 |
|---|---|---|
| **세션 시작·재개** | SessionStart (`startup\|resume`) | `.gbc/defers.json`의 미해결 항목을 "진행중 N · 미착수 M"로 구분 표면화(이전 작업 잔여 환기). 잔여 없으면 무출력. `compact`엔 발화 안 함(노이즈 방지) |
| **코드 변경 직전** | PreToolUse (`Edit\|Write\|MultiEdit`) | 명세 ↔ 변경 ↔ defer 대조 → 통과(침묵)/차단(시나리오 도출 지시)/fail-open |
| **작업단위당 1회** | (PreToolUse 캐시) | 같은 명세 해시 내에선 첫 편집만 판정, 이후 통과 → 매 편집 지연 회피 |
| **응답 종료** | Stop | 계측 flush(`events.jsonl`) + 미해결 defer가 있으면 리마인드(매 대화 종료마다). 거슬리면 `gbc defer mute`(또는 `/gbc-mute` 스킬)로 끈다 — SessionStart 진입 알림은 유지 |
| **업데이트 필요 시** | (PreToolUse·SessionStart) | hook 구버전(②) 또는 신버전 출시(①)면 갱신 안내. PreToolUse는 세션당 1회(`systemMessage` 비차단) — **통과된 작업단위(cached-skip) 편집에도 표시**(0.3.0: 평상 작업 대부분이 cached-skip이라, 여기서 빠지면 배너가 거의 안 떴음). SessionStart는 진입 시 표시(모델 컨텍스트). `gbc status`는 캐시만 갱신하고 안내는 **표시하지 않는다**(명시 진단 명령). 게이트 통과/차단 동작은 불변 |

> 세션 진입 알림만 끄려면 `GBC_NO_SESSION_HINT=1`. 매 대화 종료(Stop) defer 리마인드만 끄려면 `gbc defer mute`(영속, 해제 `unmute` · 스킬 `/gbc-mute`) — 진입 알림은 남는다. 업데이트 안내만 끄려면 `GBC_NO_UPDATE_NOTICE=1`.
> 프로젝트 hook이 구식이거나(SessionStart 누락·옛 명령) 새 버전이 나오면 gbc가 감지해 **`gbc update`**(전역 최신 + 현재 프로젝트 재init 한방) 또는 수동 `npm i -g geobuke-code@latest → gbc init --yes`를 안내한다. 단 안내는 **이미 hook이 등록된 프로젝트**(=한 번이라도 `gbc init`을 한 코호트)에만 도달한다 — 전혀 init하지 않은 프로젝트엔 실행할 hook이 없어 구조적으로 알릴 수 없다(gbc는 전역 hook을 깔지 않는다).
> **업데이트 안내(①)는 네트워크를 게이트 핫패스에 들이지 않는다**: `~/.gbc/version-check.json` 캐시만 비교하고, 갱신 fetch는 안전한 비-핫패스에서만 짧은 타임아웃(1.5s)으로. ⓐSessionStart는 캐시가 stale이면 **표시 전에 갱신**해 신버전이 그 세션에 바로 뜬다(1세션 지연 없음). ⓑ**PreToolUse는 judge를 도는 편집(cache-miss)에서 캐시가 stale이면 refresh를 judge와 *병렬*로 건다**(0.3.0) — judge가 ≥1.5s라 지연 0이고, 사용자가 `gbc status`를 직접 치지 않아도 캐시가 최신이 된다. **cached-skip 핫패스에는 네트워크를 절대 넣지 않는다.** 조회 실패는 조용히 무시(fail-silent)되어 게이트 결정에 영향이 없다. 캐시 TTL 12h.

### 시나리오 도출 루프 (수기 입력 불필요)

명세가 비어 **시나리오 미지정**으로 차단되면, 사용자가 파일을 직접 쓰지 않는다. 차단 메시지가 코딩 에이전트에게 다음을 지시한다:

```
요청에서 시나리오 도출 → 사용자에게 제시·검증 → gbc spec add로 등록 → 재시도
```

- **도출**은 코딩 에이전트 본체(Opus, 대화 맥락 보유)가, **게이트 판정**은 haiku가 한다 — 두 작업/두 모델 분리. gbc는 모델 계층을 소유하지 않는다(판단용 작은 호출만).
- **사용자 검증은 양보 불가**다 — 같은 에이전트가 도출+구현까지 자동으로 하면 자기 시나리오만 통과시키는 고무도장이 된다. 승인 없는 자동 등록을 금지한다.

### 누락 케이스 일괄 분류 (`gbc gate review`)

명세가 있는데 **형제 케이스를 침묵 누락**해 차단되면, 판정이 도출한 누락 케이스들이 `.gbc/pending-review.json`에 기록된다. 케이스가 여러 개일 때 하나씩 `gbc spec add`/`gbc defer add`를 반복하지 않고 **체크리스트로 한 번에 분류**한다:

```
gbc gate review                              # 누락 케이스를 번호 목록으로 (사용자에게 제시·검증)
gbc gate review --spec 1 3 --defer 2         # 1,3은 승인→spec / 2는 미룸→defer (한 번에)
```

- 승인(`--spec`)은 `.gbc/spec.md`에, 미룸(`--defer`)은 defer 레지스트리에 등록하고 펜딩을 비운다. 한 케이스가 양쪽에 걸리면 **spec 우선**(이중 등록 방지). ref는 `번호|텍스트|all`(defer 명령과 동일).
- 분류 후 같은 편집을 재시도하면 등록된 케이스 기준으로 재판정된다. 여기서도 **사용자 검증이 분류 전제** — 도출된 케이스를 사용자에게 보여주고 승인받은 뒤 등록한다.
- 펜딩은 "가장 최근 차단의 도출"이라 다음 차단이 덮어쓴다. 단건이면 종전대로 지금 변경에서 직접 다루거나 `gbc defer add`로 미뤄도 된다.

## 사후 결과검증 (`gbc verify`)

게이트(PreToolUse)가 구현 *전* "케이스를 다루는가"를 본다면, `gbc verify`는 구현 *후* "결과물이 케이스를 실제 충족했는가"를 **증거와 대조**한다. gbc는 **테스트를 실행하지 않는다** — 표준 결과(JUnit XML)를 *읽거나*, 러너가 없으면 LLM이 최종 코드를 *독해*한다. 실행은 환경(사용자 러너·CI) 몫이고 gbc는 결과 포맷만 소비한다(provider 패턴 — 돌리면 환경마다 깨지고 임의 명령 실행은 공급망 RCE다; 읽으면 러너 불문 이식된다).

**판정 사다리** (강→약):

| 강도 | 판정 | 증거 | 바인딩 |
|---|---|---|---|
| 강 | **verified** | 테스트 실행 통과/실패(JUnit XML) | `::test <테스트명>` |
| 중 | **reviewed** | LLM이 최종 코드 독해(주소화 판정·*동작 증명 아님*) | `::file <경로>` |
| 약 | **unverifiable** | 증거 없음(결과파일·파일·바인딩 부재) — 정직 바닥 | (없음) |

**케이스↔증거 바인딩** — spec 케이스 줄 끝에 접미사로 붙인다(줄 끝 단일 토큰, 공백 포함 이름은 따옴표):

```bash
gbc spec add "빈 자격증명 거부 ::test login_empty_creds"     # 러너 결과로 verified
gbc spec add "로그인 검증 로직 ::file src/auth.ts"           # 코드 독해로 reviewed
gbc spec add '경계조건 처리 ::test "should handle empty"'     # 공백 포함 테스트명은 따옴표
gbc verify                                                   # 사다리 리포트
```

- **verified 쓰려면** 러너가 JUnit XML을 `.gbc/verify-results.xml`로 떨구게 한다 — `vitest run --reporter=junit --outputFile=.gbc/verify-results.xml`, `pytest --junit-xml=.gbc/verify-results.xml`, `node --test --test-reporter=junit --test-reporter-destination=.gbc/verify-results.xml` 등. gbc는 이 파일을 **읽기만** 한다(spawn·실행 안 함).
- **reviewed**는 러너 없이도 동작 — `::file` 케이스의 코드를 LLM이 독해해 충족 여부를 refute-first로 판정한다. 단 **독해는 동작 증명이 아니다**(미묘한 버그·런타임 오류는 못 잡는다).
- **fail-open은 `unverifiable`로** 떨어진다 — 검토 호출이 실패해도 절대 `pass`로 뭉개지 않는다(거짓 확신 차단, 게이트 fail-open 철학의 미러).
- **failed·unverifiable 케이스**는 `gbc verify`가 `gbc defer add "..."` 형태로 **후보 제안만** 한다 — 자동 등록하지 않는다(사람이 분류, defer 원칙과 동일).
- **보안**: `::file` ref가 프로젝트(cwd) 밖을 가리키거나 심링크면 읽지 않고 거부한다 — spec.md는 커밋/PR 기여 파일이라, 임의 경로 파일을 LLM에 전송하는 유출을 막는다.
- **신선도**: verified는 디스크의 결과파일을 그대로 읽는다(신선도 검사 없음) — **코드 변경 후 러너를 재실행**하고 verify해야 옛 결과에 대한 거짓 verified를 피한다(provenance 스탬프는 후속 과제).

## 지연(latency)과 트랜스포트

판정은 작은 LLM 호출이다. 두 트랜스포트:

| 조건 | 트랜스포트 | 지연 |
|---|---|---|
| 키 있음 (`ANTHROPIC_API_KEY` env 또는 `~/.gbc/api-key` 파일) | Anthropic API 직접 (haiku, 최소 시스템프롬프트) | ~1–3s (목표) |
| 키 없음 | `claude -p` 폴백 (CC 인증 재사용, 무설정 · native Windows 포함) | ~13–20s |

**작업단위 1회**: 게이트는 작업단위(계획 명세 해시)당 한 번만 발동한다. 명세가 바뀌거나 명세 밖 파일을 편집할 때만 재발동 → 매 편집 지연을 피한다.

> 빠른 게이트를 원하면 `~/.gbc/api-key` 키 파일을 만들어라(설정법·과금 주의: 위 [「빠른 게이트 활성화」](#빠른-게이트-활성화-api-키--선택)). 없으면 `claude -p` 폴백으로 무설정 동작하되 작업단위당 한 번 느리다.

## 명령

| 명령 | 설명 |
|---|---|
| `gbc init` | hook + `/gate` · `/gbc-mute` · `/gbc-monitor` 스킬 설치 + 크로스-repo 레지스트리 자동등록(opt-out: `--no-register`) |
| `gbc update` | 전역 최신 설치(`npm i -g …@latest`) + 현재 프로젝트 재init 한방. `--dry-run`으로 실행 명령만 미리보기 |
| `gbc status` | 게이트 상태 + 로드된 명세 + Stop 리마인드 음소거 여부 |
| `gbc defer add "<케이스>"` | 케이스를 명시적으로 미루기 (→ open) |
| `gbc defer list` | 미룬 항목 목록 (상태: 미해결/진행중/해결) |
| `gbc defer start <번호\|텍스트\|all>` | 착수 표시 (open → 진행중) |
| `gbc defer resolve <번호\|텍스트\|all>` | 종결 표시 (→ 해결) |
| `gbc defer reopen <번호\|텍스트\|all>` | 백로그로 되돌리기 (→ open) |
| `gbc defer mute` / `unmute` | 대화 종료(Stop)마다 뜨는 defer 리마인드 끄기/켜기 (영속) · 스킬: `/gbc-mute` |
| `gbc spec add "<케이스>"` | 승인된 시나리오를 `.gbc/spec.md`에 등록 |
| `gbc spec show` | 등록된 케이스 목록 |
| `gbc spec clear` | 명세 비우기(아카이브 없이) |
| `gbc done` | 작업단위 명시 종료(명세 아카이브→비움 + 게이트 리셋) |
| `gbc verify` | 사후 결과검증 — 케이스↔증거 대조(verified>reviewed>unverifiable). 바인딩: `<케이스> ::test <테스트명>` / `::file <경로>` |
| `gbc gate reset` | 작업단위 게이트 리셋 |
| `gbc gate review` | 차단이 도출한 누락 케이스 체크리스트 보기 |
| `gbc gate review --spec <ref> --defer <ref>` | 누락 케이스 일괄 분류(승인→spec / 미룸→defer) |
| `gbc gate snapshot <on\|off\|status\|list\|clear>` | 골든셋 캡처 토글·조회(판정 드리프트 회귀락) |
| `gbc gate snapshot replay [--samples N]` | 골든 케이스 재판정(temp 0)·드리프트 시 exit 1 |
| `gbc metrics [--all] [--json]` | 계측 리포트(M1~M3). `--all`=등록 repo들의 events.jsonl 병합 집계 |
| `gbc repos add [경로]` | 크로스-repo 레지스트리에 추가(생략 시 현재 폴더) |
| `gbc repos list` | 등록된 repo + 각 repo의 미해결 defer 수 + **게이트 건강성**(hook 부재/구식 코호트) |
| `gbc repos remove [경로]` | 레지스트리에서 제거 |
| `/gbc-monitor` 스킬 | 위 관측 명령(status·metrics --all·repos list·snapshot status)을 묶어 조회·해석하는 **읽기전용** 표면. 상태 변경은 `/gate` |

우회: `GBC_NO_GATE=1` (계측됨 — 우회 자체가 게이트 가치 측정 데이터).

## 크로스-repo 가시성

여러 repo를 오가며 작업할 때, **다른 repo에 걸린 미완 작업**을 그 repo를 열지 않고도 인지하기 위한 기능이다. 세션 진입(SessionStart) 시 현재 repo의 미해결 defer 상세에 더해, **등록된 다른 repo들의 미해결 defer 요약**을 한 줄로 환기한다.

`gbc init`을 하면 그 repo는 **레지스트리에 자동 등록**된다(opt-out: `gbc init --no-register`). 따라서 보통은 아래를 따로 칠 필요 없이, init한 repo들이 서로의 미완 작업을 자동으로 환기한다. 수동 관리가 필요할 때만:

```bash
# 감시할 repo를 글로벌 레지스트리(~/.gbc/repos.json)에 등록 (각 repo에서 1회, 또는 경로 지정)
gbc repos add                 # 현재 폴더
gbc repos add /path/to/other-repo
gbc repos list                # 등록 현황 + 각 repo 미해결 defer 수
```

이후 등록된 repo에서 세션을 열면 진입 시 이렇게 뜬다:

```
🐢 거북이 게이트 — 미해결 defer 1건 (진행중 0 · 미착수 1, 이전 작업 잔여):
1. [미착수] dist 재빌드 자동화                     ← 현재 repo: 번호 매긴 상세
필요하면 사용자에게 이어서 처리할지 확인하세요. 규약 — …

🌐 타 repo 미해결: dev-note 진행중1·미착수1 · fa-support 미착수1   ← 등록된 타 repo: 카운트만
```

- **카운트만** 표시한다 — 번호 매긴 상세 리스트는 **현재 repo에만**. 번호는 `gbc defer <N>` 인덱스 ref와 현재 cwd 기준으로 묶이므로, 타 repo에 번호를 주면 "어느 repo의 N"인지 ref가 깨진다. 타 repo 항목을 다루려면 그 repo로 들어가서 번호로 조작한다.
- **SessionStart에서만** 환기한다(매 대화 종료 Stop 리마인드엔 미첨부 — 노이즈 방지). 현재 repo와 미해결 0건 repo는 요약에서 제외(전부 깨끗하면 `🌐` 줄 자체가 없다).
- gbc가 설치되지 않은(`.gbc/` 없는) repo는 등록돼 있어도 조용히 건너뛴다(fail-silent) — 레지스트리는 넉넉히 등록해도 안전하다.
- 끄려면 `GBC_NO_CROSS_REPO=1`(이 줄만) 또는 `GBC_NO_SESSION_HINT=1`(세션 진입 힌트 전체).

> CLI에서 repo별 alias(`alias cc-x='cd <dir> && claude'`)를 쓴다면, alias에 `gbc repos add . 2>/dev/null;`를 끼워 **여는 repo를 자동 등록**할 수 있다(등록은 멱등).

### 게이트 건강성 롤업 (`gbc repos list`)

"회사 repo에서 게이트가 조용히 안 먹는다"를 한 명령으로 진단한다. `gbc repos list`는 각 등록 repo의 `.claude/settings.json`을 읽어 hook 등록 상태를 표시한다:

```
📁 등록된 repo 3개:
  [○깨끗] /path/to/healthy
  [○깨끗] /path/to/old        ⚠️SessionStart누락        ← 0.2.1 이하 init 코호트
  [●미해결2] /path/to/broken  ⚠️게이트hook부재          ← PreToolUse 게이트가 아예 없음(조용히 죽음)

⚠️ 게이트 hook 부재/SessionStart 누락 repo는 해당 repo에서 'gbc init --yes' 재실행으로 복구하세요.
   (크로스-repo는 hook *등록 여부*만 검사 — 명령 freshness[설치경로 의존]는 각 repo에서 'gbc status'로 확인)
```

- **검사 대상**: 게이트 hook(`PreToolUse`)·SessionStart hook의 **등록 여부**. 둘 다 cliPath 없이 결정론적으로 판정된다.
- **검사 안 하는 것**: hook 명령의 *freshness*(구버전 prefix 등). gbc는 단일 전역 설치지만 각 repo의 hook 명령엔 설치 시점의 절대경로가 구워져 있어, 현재 런타임 경로로 타 repo를 stale 판정하면 false-positive가 난다. 명령이 구식인지는 그 repo에서 `gbc status`로 확인한다(진짜 사후대조 freshness는 A-mode 과제).

## 계측 (M1~M3)

게이트는 모든 결정을 `.gbc/events.jsonl`(append-only, 메타데이터만 — 코드 본문 미기록)에 기록한다. `gbc metrics`로 집계를 본다. 끄려면 `GBC_NO_METRICS=1`.

여러 repo의 게이트 ROI를 한 번에 보려면 `gbc metrics --all` — 등록된 repo들의 `events.jsonl`을 병합 집계한다. 병합 시 각 이벤트의 `specHash`를 repo 경로로 태깅해 **repo간 boilerplate 명세 해시 충돌**을 막는다(태깅 없이 합치면 한 repo의 통과 뒤 다른 repo의 변이가 M1 churn으로 오집계된다; M2/M3는 세션 UUID 키라 원래 안전). symlink로 등록된 경로는 거부한다(등록 경로 밖 임의 디렉터리 읽기 차단).

| 지표 | 관측 | B-모드 신뢰도 |
|---|---|---|
| **M2** 게이트 적중 vs 도중발견 | 차단이 잡은 누락 케이스 수 vs `defer add`로 도중 등록된 수 | **강** (defer-registry와 1:1) |
| **M3** 재호출/iteration | 작업단위당 편집 반복 횟수 | proxy |
| **M1** post-gate 재작업 | 통과 후 churn(spec 변경·gate reset·defer) | **약** (churn proxy) |

> ⚠️ **진짜 M1**(통과 후 시나리오 위반율)은 게이트가 엔진 출력을 채점하는 **사후 대조**가 필요하다 — 이는 후속 A(standalone) 모드 영역이다. B-커널(hook)은 churn 약신호만 관측한다. `events.jsonl` 원시 로그는 그때 그대로 재사용된다.

## 판정 드리프트 회귀락 (`gbc gate snapshot`)

게이트 판정은 LLM(haiku)이라 **모델 업그레이드·프롬프트 수정·SDK 변경**이 같은 편집에 대한 통과/차단을 조용히 바꿀 수 있다. 골든셋은 실제 판정을 캡처해두고 나중에 재판정해 그 드리프트를 잡는다.

```bash
gbc gate snapshot on          # 캡처 모드 ON (opt-in)
# … 평소처럼 작업 — judge가 평가하는 편집이 .gbc/golden.json에 기록된다 …
gbc gate snapshot list        # 캡처된 케이스 확인 (판정·도구·편집 머리말)
gbc gate snapshot off         # 캡처 종료

# 나중에(모델/gbc 업그레이드 후 등) 드리프트 점검:
gbc gate snapshot replay              # 각 케이스를 temp 0으로 재판정, 캡처 시점과 비교
gbc gate snapshot replay --samples 5  # 케이스당 5회 모달 판정(잔여 비결정 흡수)
```

- **하드 신호 = 판정 뒤집힘(pass↔block)만.** 하나라도 뒤집히면 `replay`는 **exit 1**(로컬 pre-flight 게이트로 사용 가능). `missing[]` 변화는 LLM 자유서술이라 정보용으로만 표시하고 절대 실패시키지 않는다.
- **결정성**: replay는 judge를 `temperature 0`으로 재실행한다(핫패스 게이트는 불변). `claude -p` 폴백 트랜스포트는 temperature 핀을 지원하지 않아 best-effort다 — 직접 API 키가 있을 때 가장 안정적. temp 0도 bit-stable은 아니므로 `--samples N`으로 다수결 모달을 쓸 수 있다.
- **캡처 시점**: judge가 *실제로 평가한* cache-miss 편집만 기록된다(cached-skip·fail-open 제외). 특정 편집을 캡처하려면 `gbc gate reset` 후 그 편집을 수행한다.
- **⚠️ 로컬 전용(privacy)**: `golden.json`은 정규화된 **편집 본문**을 담는다 — `events.jsonl`이 불변식으로 절대 저장하지 않는 내용이다. `.gbc/`는 gitignore이므로 이 골든셋은 **로컬 드리프트 점검**이지 커밋되는 CI 스위트가 아니다. 공유 CI로 쓰려면 편집 본문을 커밋하는 privacy 트레이드오프를 명시적으로 감수해야 한다.

## 운영 현황 관측 (`/gbc-monitor`)

위 운영층 명령들(`gbc status`·`gbc metrics --all`·`gbc repos list`·`gbc gate snapshot status`)은 강력하지만, 세션 안에서 **발견가능성**이 없었다 — 명령·플래그를 외워 직접 치거나 매번 요청해야 했다. `/gbc-monitor` 스킬은 이들을 **묶어 조회하고 해석**하는 읽기전용 표면이다.

```
/gbc-monitor                  # 게이트 현황 종합(4개 묶음 + 해석)
게이트 현황 보여줘 / 계측 어때 / repo 건강성  # 자연어로도 트리거(특정 항목만도 가능)
```

핵심은 **단순 별칭이 아니라 해석**이다 — 숫자가 정상/주의/행동필요 중 무엇인지 판정해준다:

- `repos ✗부재` → 게이트가 조용히 죽은 상태 → 그 repo `gbc init` 재실행 안내(단 `/tmp/*` 잔재는 `gbc repos remove` 청소 후보)
- `M1 churn` → **약신호 proxy** — "통과 후 결함 수"로 과대해석 금지(진짜 M1은 A-mode 사후대조 과제)
- `명세 비어있음 → 차단` → 버그가 아니라 게이트가 의도대로 켜진 정상 동작
- `M2 도중발견 비율 낮음` → 누락이 늦게 새기보다 게이트가 사전 차단을 잘 한다는 긍정 신호

### 경계 — 관측하고, 액션은 가리킨다

`/gbc-monitor`와 `/gate`를 가르는 단 하나의 선: **"그 명령이 상태를 바꾸거나(mutate) API를 쓰는가?"** 그렇다면 `/gate`의 영역이다(미루기·리셋·`snapshot on/off/clear`·`replay`). `/gbc-monitor`는 **읽기전용 조회만** 하고, 변경이 필요하면 직접 실행하지 않고 `/gate`로 *가리킨다*. 이 분리 덕에 모니터링은 부작용 걱정 없이 언제든 안전하게 부를 수 있다. `gbc init`이 이 스킬을 `/gate`·`/gbc-mute`와 함께 설치한다.

## 정직한 한계

- **자동 in-loop 게이트는 구현 전까지다** — "도중 탈선"은 못 잡는다(후속 C 영역). 구현 *후*는 `gbc verify`로 대조하지만, 이는 자동 루프 게이트가 아니라 **명시 호출**이고 바인딩·증거에 의존한다.
- **`gbc verify`의 강도는 사다리다**: verified(테스트 실행 증명) > reviewed(LLM 코드 독해, 동작 보증 아님) > unverifiable(증거 없음). reviewed/unverifiable를 "통과"로 뭉치지 않는다 — 거짓 확신(reviewed→pass)·거짓 경보(unverifiable→fail) 둘 다 harm이다. 강한 검증을 원하면 `::test` 바인딩 + 러너 JUnit 출력을 배선한다.
- 판정은 LLM이라 100% 아니다. **사람이 변이 전 케이스를 리뷰/편집하는 pause**가 진짜 가치다.
- scope = **B-커널**(CC-native hook + defer-registry + /gate) + 그 위 운영층(누락 케이스 일괄 분류·크로스-repo 가시성/건강성·판정 드리프트 회귀락·관측 계측 M1~M3) + **사후 결과검증(`gbc verify`)**. **standalone TUI·엔진 래핑 추출 모드·진짜 자동 사후대조 M1**(통과 후 시나리오 위반율을 루프에서 채점)은 후속 A(public) 영역이다 — `gbc verify`는 그 사전 단계로, 명시 호출 시 케이스↔증거를 사다리로 대조한다(루프에 박힌 자동 채점은 아직 아니다).
- **검증 상태**: 게이트 판정 품질은 **양 트랜스포트 모두 회귀 8/8(FP0 FN0)**. 직접 API(haiku) 경로 실측 **평균 1.7s**(1.1–2.5s), claude -p 폴백 ~18s. 직접 API용 게이트 프롬프트는 최소화하면서 정확도를 유지하도록 "동작 편집 vs 비-동작 편집" 2단계 분류로 튜닝했다(`ANTHROPIC_API_KEY=… node dist/eval/regression.js`로 재현).
- **fail-open**: 판정 호출이 실패하면(키 오류·네트워크 등) 게이트는 안전하게 통과시킨다(개발 차단 방지). 단 fail-open 통과는 작업단위 캐시에서 제외되고(다음 편집 재판정), `systemMessage` 경고 + `.gbc/failopen.log` 계측으로 드러난다(조용한 무력화 방지).

## 라이선스

MIT
