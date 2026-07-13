# gbc tui Windows 실사용 오류 분석 보고서 (spawn EPERM · 게이지 0% · 계정 연동)

> 분석일: 2026-07-13
> 프로젝트: geobuke-code 0.9.1 — `gbc tui` 회사 Windows PC 실사용 보고
> 분석 관점: ①매 프롬프트 제출마다 `🐢 오류: Error: spawn EPERM` ②컨텍스트 게이지 0%·비용 $0.00 고정 ③Claude 계정(구독) 연동 방법·연동 여부 ④ExperimentalWarning(JSON modules)

---

## 0. 한 줄 결론

**네 증상 중 실결함은 없다.** ①은 회사 보안정책이 SDK의 claude.exe 자식 프로세스 실행을 차단하는 환경 문제(과거 W3와 동일 패턴), ②는 ①의 파생(엔진이 한 번도 성공 못 해 데이터가 없음) + 게이지는 원래 미배선, ③은 연동이 안 된 게 아니라 **연동 이전 단계(프로세스 실행)에서 차단**된 것, ④는 무해 경고다. 0.9.1의 무응답 수정(`formatEngineFailure`)은 정상 동작 — 이전 버전이라면 화면에 아무것도 안 떴을 실패가 이제 `🐢 오류: Error: spawn EPERM`으로 보이는 것 자체가 수정의 성과다.

---

## 1. 증상별 원인 분석

### ① `Error: spawn EPERM` — 회사 보안정책의 자식 프로세스 실행 차단

**메커니즘 (코드·문서 근거 확정):**

1. `gbc tui` submit → `runEngine()`(src/engine.ts:130) → agent-sdk `query()` 호출.
2. **query()는 in-process API가 아니라 Claude Code CLI를 자식 프로세스로 spawn하는 구조다.** SDK는 플랫폼별 optionalDependency(`@anthropic-ai/claude-agent-sdk-win32-x64@0.3.202`)로 **번들된 `claude.exe`**를 설치하고 이를 실행한다(SDK README: "bundles a native Claude Code binary for your platform"). 상황에 따라 임시 디렉토리(`%TEMP%\claude\...`) 추출 경로도 사용한다(`extractFromBunfs.js`).
3. spawn된 프로세스가 게이트웨이 — 인증·API 호출·에이전트 루프 전부 그 안에서 돈다.
4. **EPERM = Windows가 이 실행을 거부** — 인증 실패도, gbc 버그도 아니고 OS/보안정책 수준의 차단.

**환경 이력 대조:** 같은 회사 PC에서 0.2.x 시절 `claude.exe` 직접 실행이 `Access denied`로 차단된 이력이 있다(W3, 0.2.4에서 "회사 보안정책의 claude.exe 차단 = 환경탓"으로 확정, `memory/project_0_2_4_plan.md`). 이번 EPERM은 동일 정책이 SDK의 자식 프로세스 spawn에 적용된 것으로 사실상 같은 뿌리다.

**대표 원인 후보(공식 이슈 트래커 기준):**

| 원인 | 설명 | 근거 |
|---|---|---|
| EDR/AppLocker의 미서명·비표준 경로 실행 차단 | `node_modules` 또는 `%TEMP%` 하위 exe 실행 거부 | claude-code#14242 등 |
| Enterprise Group Policy의 reg.exe 차단 | CLI가 내부적으로 reg.exe를 spawn하는 경로에서 EPERM | claude-code#33100 (closed as not planned) |
| 드라이브 루트/네트워크 드라이브 쓰기 제한 | 임시 디렉토리 생성 실패 | claude-code#14242 |

**우회 경로(효과 순):**

1. **`pathToClaudeCodeExecutable` 옵션 활용** (SDK 공식, sdk.d.ts:1686) — 번들 exe 대신 **회사가 이미 허용한 설치본 claude CLI 경로**를 지정. 단 회사 PC에서 `claude` CLI 자체가 실행 가능해야 함(과거 W3에선 그것도 차단됐으므로 먼저 `claude --version`으로 확인).
   - ⚠️ **gbc는 현재 이 옵션을 노출하지 않음**(`buildEngineOptions`가 미전달) → 개선 후보 (§3).
2. **`CLAUDE_CODE_TMPDIR` 환경변수** — 추출 위치를 %TEMP%에서 허용 경로로 이동(추출 경로 차단이 원인일 때만 유효).
3. **보안팀 예외 등록** — `%USERPROFILE%\...\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe` 실행 허용 요청. 근본 해결이지만 조직 절차 필요.
4. SDK 차원의 자동 우회책은 **없음**(관련 이슈들 closed as not planned).

### ② 게이지 0% · $0.00 — 두 필드는 사정이 다름

| 항목 | 배선 상태 | 0인 이유 |
|---|---|---|
| **cost `$0.00`** | **배선돼 있음** — 엔진 result 메시지 → `bridge.ts:31-39 mapEngineMessageToTuiEvents` → `STATUSLINE_UPDATE{costUsd}` → statusline | **엔진이 한 번도 성공 못 함**(①로 spawn 자체가 실패 → result 메시지 부재). 엔진이 성공하면 **구독 인증에서도 채워진다** — 0.7.0 E2E에서 $0.31/$0.26 실측(`memory/project_0_7_0_plan.md`). 단 공식 문서상 client-side 추정치이며 청구 권위 데이터 아님 |
| **게이지 `▱▱▱ 0%`** | **미배선(의도적)** — `usagePct`는 model.ts 초기값 0에서 갱신 경로 없음(`bridge.ts:10-12` 주석) | SDK의 컨텍스트 사용량 API가 v0.3.202에서도 여전히 `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`(sdk.d.ts:2383) — 안정화 전 배선 보류가 0.9.0 확정 결정. **연동돼도 현재 버전에선 항상 0%가 정상** |

### ③ Claude 계정(구독) 연동 — 방법과 현 상태 진단

**진단: "연동이 안 되어 있어서" EPERM이 나는 것이 아니다.** 인증은 spawn된 claude 프로세스 안에서 일어나는데, 그 프로세스가 실행 자체를 못 하므로 인증 단계까지 도달하지 못했다. 연동 여부는 현재 확인 불가 상태(① 해소가 선행 조건).

**연동 방법(① 해소 후):** gbc는 설계상 apiKey를 주입하지 않고 SDK의 자체 인증을 따른다(engine.ts:7-8 — ⓑ 과금 실측 불변식). SDK 인증 우선순위(공식 authentication 문서):

```
Bedrock/Vertex env > ANTHROPIC_AUTH_TOKEN > ANTHROPIC_API_KEY
  > apiKeyHelper > CLAUDE_CODE_OAUTH_TOKEN > 구독 OAuth(/login)
```

| 방법 | 절차 | 적합 상황 |
|---|---|---|
| **구독 OAuth (권장)** | 회사 PC에서 `claude` 실행 → `/login` 브라우저 인증. 크레덴셜은 `%USERPROFILE%\.claude\.credentials.json`에 저장되고 **SDK가 자동 상속** | Pro/Max 구독 보유, 브라우저 사용 가능 |
| **setup-token** | 다른 PC에서 `claude setup-token` → 1년 수명 토큰 발급 → 회사 PC에 `CLAUDE_CODE_OAUTH_TOKEN` 환경변수로 설정 | 회사 PC에서 브라우저 로그인 불가할 때 |
| **API 키** | `ANTHROPIC_API_KEY` 설정 | 구독 아닌 Console 과금 의도할 때만(gbc의 ⓑ 목적상 비권장) |

### ④ `ExperimentalWarning: Importing JSON modules` — 무해 경고 (근거 수준: 추정)

- gbc 소스는 ESM JSON import를 쓰지 않는다(package.json 읽기는 전부 `readFileSync`+`JSON.parse`, cli.ts:71·83). 출처는 gbc가 아닌 의존성 로드 체인.
- WSL Node v22.22.1에서는 ink 로드로 재현되지 않음 → 회사 PC의 **Node 버전이 낮을 가능성**(이 경고는 Node 22.12 미만에서 발생, 이후 JSON modules가 stable화되며 제거됨).
- **조치: 없음(동작 무영향).** 거슬리면 회사 PC에서 `node --version` 확인 후 22.12+ 업그레이드 권장.

---

## 2. 아키텍처 평가 (이 관점 한정)

| 항목 | 평가 | 근거 |
|---|---|---|
| 에러 표면화 | **양호(0.9.1 개선 입증)** | 이전이라면 무표시였을 spawn 실패가 `🐢 오류:`로 노출 — formatEngineFailure가 설계대로 동작 |
| 에러 진단 친절도 | **미흡** | `spawn EPERM` 원문만 노출 — startup-diagnostics(0.9.1 신설)는 미설치/버전충돌/React중복 3종만 분류, **EPERM/보안차단 패턴 부재**. 사용자가 원인을 알 수 없음 |
| 실행파일 경로 유연성 | **미흡** | SDK가 공식 지원하는 `pathToClaudeCodeExecutable`을 gbc가 노출하지 않아 회사 환경 우회 수단이 없음 |
| 인증 설계 | **양호** | apiKey 미주입·SDK 자체 인증 위임은 구독/키 어느 쪽도 수용하는 올바른 구조(0.7.0 실측 검증) |

## 3. 개선 로드맵 (0.9.2+ 후보 — 본 분석은 보고만, 수정 미실행)

### 즉시 개선 (Quick Win)
- [ ] **startup-diagnostics에 `spawn EPERM`/`EACCES` 패턴 추가** — "회사 보안정책이 claude 실행파일을 차단했을 가능성" + 확인 명령(`claude --version`) + 보안팀 예외 안내 문구. 기존 3종 분류의 자연 확장(순수함수+테스트, 0.9.1 ST2와 동일 패턴).
- [ ] **`GBC_CLAUDE_PATH` 환경변수 → `pathToClaudeCodeExecutable` 전달** — buildEngineOptions에 옵셔널 seam 추가. 회사 허용 설치본으로 우회하는 유일한 SDK 공식 경로.

### 단기 개선
- [ ] **auth 미로그인 감지 안내** — `auth_status` error 또는 인증 실패 결과에 `/login` 절차 안내 문구(①이 해소된 사용자가 다음으로 만날 벽).
- [ ] TUI 시작 시 엔진 사전 점검(선택) — 첫 submit 전에 spawn 가능 여부를 진단해 게이트 줄에 경고 표시.

### 사용자 즉시 조치 (코드 변경 없이)
1. 회사 PC에서 `claude --version` 실행 → 성공하면 claude CLI 자체는 허용된 것(향후 GBC_CLAUDE_PATH로 해결 가능). 실패(Access denied)하면 W3 때와 동일하게 보안팀 예외 없이는 A-모드 사용 불가.
2. `claude` 실행이 되면 `/login`으로 구독 연동(§1-③) — SDK가 자동 상속.
3. B-모드(게이트 hook)는 이 문제와 무관하게 정상 동작(spawn 경로 자체가 다름 — 이번 화면에서도 게이트 줄 `gated ✓`·spec 7케이스 정상 표시).

## 4. 리서치 출처
- SDK 로컬 소스: `node_modules/@anthropic-ai/claude-agent-sdk/` (sdk.d.ts:1686 pathToClaudeCodeExecutable · :2383 usage EXPERIMENTAL, extractFromBunfs.js, manifest.json, README)
- 공식 문서: code.claude.com/docs/en/authentication.md (인증 우선순위·credential 저장·setup-token), agent-sdk/cost-tracking.md (total_cost_usd는 추정치)
- GitHub Issues: anthropics/claude-code #33100(Group Policy reg.exe EPERM), #14242(EPERM mkdir drive root)
- 사내 이력: `memory/project_0_2_4_plan.md`(W3 — 회사 claude.exe Access denied 환경탓 확정), `memory/project_0_7_0_plan.md`(구독 인증 cost 실측 $0.31/$0.26)

---

> 이 보고서는 Claude Code `/analyze` 스킬로 생성되었습니다.
