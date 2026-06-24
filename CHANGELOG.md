# Changelog

이 프로젝트의 주요 변경 사항을 기록한다. 형식은 [Keep a Changelog](https://keepachangelog.com/), 버전은 [SemVer](https://semver.org/)를 따른다.

## [0.3.0] - 2026-06-24

### Fixed
- **업데이트 안내 가시성 갭 — 통과된 작업단위에서도 배너 노출** — 평상 작업은 대부분 "이미 게이트 통과한 작업단위"(cached-skip)라, 그 경로가 `maybeUpdateNotice`를 호출하지 않고 즉시 통과하던 탓에 **보이는 배너(PreToolUse `systemMessage`)가 거의 안 떴다**(SessionStart 안내는 모델 컨텍스트로만 주입돼 사용자 화면 배너가 아님). cached-skip 경로에도 업데이트 안내를 emit하도록 수정 → **매 세션 첫 편집에 배너 1회**(세션당 dedup). `permissionDecision` 없이 `systemMessage` 단독이라 통과 동작은 불변, 네트워크 없음(캐시만 읽음). 이제 신버전·재init 안내를 보려고 `gbc gate reset`을 칠 필요가 없다.

### Added
- **캐시 자동 refresh (judge 경로 piggyback)** — 사용자가 `gbc status`를 직접 치지 않아도 신버전 캐시가 최신이 되게, PreToolUse가 judge를 도는 편집(cache-miss)에서 버전 캐시가 stale이면 `refreshVersionCache()`를 **judge와 병렬로** 시작한다. judge가 네트워크·≥1.5s라 refresh는 그 안에 끝나 **편집 지연 0**이고, 같은 편집의 안내가 갱신된 캐시를 즉시 반영한다. 갱신은 24h TTL당 1회. `shouldRefreshCache` 순수 술어 신설(`GBC_NO_UPDATE_NOTICE=1`이면 비활성).

### Notes
- **핫패스(cached-skip)에는 네트워크를 절대 넣지 않는다** — refresh는 judge가 도는 비-핫패스에서만 병렬로 건다(0.2.7 "hook 핫패스 동기 네트워크 금지" 원칙 보존).
- **검토 후 제외한 self-heal**: PreToolUse가 SessionStart hook 누락 시 `.claude/settings.json`을 자동 보정하는 안은, CC 공식 문서가 "Hooks cannot modify persistent configuration files"로 명시한 설계 원칙에 어긋나 채택하지 않았다. 대신 cached-skip 배너에 실리는 init-staleness 안내가 `gbc update`(CLI 갱신 + `gbc init --yes`로 SessionStart hook 복구)를 안정적으로 유도한다.
- **소급 적용 아님**: 이 동작은 0.3.0 이상 머신에서만 효과. 구버전(SessionStart hook 미등록 코호트)은 1회 `gbc update`로 최신화해야 자동 refresh 채널이 복구된다.
- 새 hook 명령이 아니라 기존 PreToolUse hook의 동작 확장이므로 **재init 불필요**(설치된 프로젝트는 CLI 갱신만으로 반영).

## [0.2.9] - 2026-06-24

### Added
- **크로스-repo defer 가시성** — 세션 진입(SessionStart) 시 현재 repo의 미해결 defer 상세에 더해, **등록된 다른 repo들의 미해결 defer 요약**을 한 줄로 환기한다(`🌐 타 repo 미해결: dev-note 진행중1·미착수1 · fa-support 미착수1`). 여러 repo를 오가며 작업할 때, 다른 repo에 걸린 미완 작업을 그 repo를 열지 않고도 인지한다.
- **`gbc repos add|remove|list`** — 크로스-repo 레지스트리 관리. 글로벌 `~/.gbc/repos.json`에 감시 대상 repo를 등록한다(`add` 경로 생략 시 현재 폴더). `list`는 각 repo의 미해결 defer 수·gbc 설치 여부를 표시.

### Notes
- 크로스-repo 요약은 **카운트만** 표시한다 — 번호 매긴 상세 리스트는 현재 repo에만(번호가 `gbc defer <N>` 인덱스 ref와 cwd 기준으로 묶이므로, 타 repo에 번호를 주면 ref가 깨진다).
- **SessionStart에서만** 환기한다(매 대화 종료 Stop 리마인드엔 미첨부 — 노이즈 방지). 현재 repo·미해결 0건 repo는 요약에서 제외. 끄려면 `GBC_NO_CROSS_REPO=1`(또는 세션 힌트 전체 `GBC_NO_SESSION_HINT=1`). 등록 경로 부재·읽기 실패는 repo별 조용히 무시(fail-silent).
- 새 hook이 아니라 기존 SessionStart hook의 출력 확장이므로 **재init 불필요**(설치된 프로젝트는 CLI 갱신만으로 반영). 감시하려면 `gbc repos add`로 레지스트리만 시드.

## [0.2.8] - 2026-06-23

### Fixed
- **dev placeholder hook을 stale로 오판하던 false-positive 수정** — `gbc init`이 `${CLAUDE_PROJECT_DIR}/dist/cli.js` placeholder로 설치한 hook을, 런타임 절대경로와 글자가 다르다는 이유만으로 "구식"으로 판정해 매 세션 `gbc init --yes` 재실행을 헛권하던 버그(geobuke-code 자기 repo 도그푸딩에서 실제로 발현). `hasStalePreToolUse`(read-time)·`normalizeHooks`(write-time)가 절대경로와 placeholder **두 정식 형태를 모두 인정**하도록 `canonicalPreCommands` 공통 기준 도입. 진짜 구식(옛 bash 키주입) 감지는 유지.

### Added
- **`gbc init --dev`** — hook 명령에 절대경로 대신 `${CLAUDE_PROJECT_DIR}/dist/cli.js` placeholder를 굽는 opt-in 플래그. dist 위치가 옮겨다니는 클론(자기 repo 도그푸딩)에서도 hook이 안 깨진다. **기본(플래그 없음)은 절대경로 유지** — npm 전역·외부 도그푸딩 등 일반 동작은 완전 불변. `stopCommand`/init 프리뷰도 선택된 경로를 반영.

## [0.2.7] - 2026-06-23

### Added
- **`gbc update [--dry-run]`** — `npm i -g geobuke-code@latest`로 CLI를 갱신하고, 현재 폴더가 `.gbc`를 가지면 새 바이너리로 `gbc init --yes`까지 수행하는 명령. (무음 자동 업데이트는 네트워크 차단·EACCES 권한·핫패스 fail-silent 철학·갱신 채널 소유 문제로 채택하지 않음.)

### Changed
- **신버전 안내 표시 지연 제거** — `runSessionStart`가 stale 캐시일 때 *표시 전에* 버전 캐시를 선행 refresh(≤1.5s, fail-silent)해, 신버전이 다음 세션이 아니라 그 세션에 즉시 노출된다. stale일 때만(24h당 1회) 발생.

## [0.2.6] - 2026-06-22

### Added
- **defer Stop 리마인드 음소거** — `gbc defer mute`/`gbc defer unmute`와 별도 `/gbc-mute` 스킬. 미해결 defer가 있을 때 매 대화 종료(Stop hook)마다 강제 노출되던 리마인드를 토글로 끈다. **Stop 채널만** 끄고 SessionStart(startup|resume) 진입 알림은 유지. 음소거 상태는 `.gbc/config.json`에 영속(`gate reset`이 푸는 `state.json`과 분리)되어 새 defer 추가·세션 교체에도 유지된다. 상태는 SessionStart 줄·`gbc status`·`gbc defer list` 3곳에 표면화.

## [0.2.5] - 2026-06-22

### Added
- **defer 3-상태 수명주기 (open / in_progress / resolved)** — 기존 2-state(등록/해소)를 3-state로 확장. 착수했지만 미종결인 항목이 "진행중"으로 구분돼, SessionStart·Stop 리마인드가 `진행중 N · 미착수 M`으로 표면화한다(착수한 채 잊히는 것 방지).
  - 신규 명령 `gbc defer start <ref>`(open→진행중)·`gbc defer reopen <ref>`(→open). `gbc defer resolve`는 복수/`all` 전환 지원(반환 `DeferEntry[]`). `ref = 번호 | 텍스트 | all`, 복수 인덱스(`2 3`)·부분텍스트·전환별 적격 처리.
  - **gate-neutral**: judge 입력은 open+in_progress(미해결 전부) — 차단 로직은 2-state와 **동일**하게 유지. resolved만 판정에서 제외.
- **자연어/편집대상 감지 기반 백그라운드 전환** — 사용자가 `gbc defer …`를 직접 칠 필요 없이, 에이전트가 대화·편집 대상을 감지해 전환을 실행하고 표면화한다. 전환 행동 규약을 SessionStart/Stop hint 문자열에 임베드(매 세션 컨텍스트에 규약을 주입하는 결정론적 채널).

### Changed
- **resolve = 항상 사람의 명시 선언** — judge가 편집을 보고 resolve를 추론하지 않는다. 모호한 완료 신호는 resolve하지 말고 사용자에게 확인(resolved 항목은 리마인드에서 사라지므로 잘못 resolve하면 미완성인 채 잊힘). start만 편집 감지로 자동(보수적·실착수 시만).

### Fixed
- **hint 번호 ↔ CLI 인덱스 정합** — SessionStart/Stop 리마인드가 미해결 부분집합을 1..N으로 번호 매기던 것을, `gbc defer list`·인덱스 ref와 동일한 **전체-리스트 인덱스**로 통일. resolved 항목이 앞에 있을 때 표시 번호 ≠ 실제 인덱스가 되어 `start <표시번호>`가 엉뚱한(되살아난) 항목을 치던 버그 수정.

### Internal
- 옛 `{resolved:bool}` 데이터는 읽을 때 `status`로 자동 승격(저장은 `status` 단일 소스). 기존 데이터 판정 결과 불변(`resolved:true`→제외, `false`→open→포함). 영향 파일: `types.ts`·`defer.ts`·`cli.ts`·`hook.ts`·`metrics.ts`·`skills/gate/SKILL.md`.

## [0.2.4] - 2026-06-22

### Changed
- **`gbc status`에서 신버전 업데이트 나그 제거 (A)** — `cmdStatus`가 `buildVersionNotice`를 직접 호출해, 명시 진단 명령인 `gbc status`에도 신버전 안내가 노출되던 의도 이탈 수정. 업데이트 안내(①신버전/②init-staleness)의 자리는 **SessionStart·PreToolUse 자동 채널 전용**이다. 부수효과로 `gbc status`의 `GBC_NO_UPDATE_NOTICE` opt-out 누수도 닫힘. 버전 캐시 stale-refresh(SessionStart seed 신선도 목적)와 설치 버전 표시 줄은 유지.

### Docs
- **corporate Windows keyless 주의 (W3 검증 결과)** — `claude.exe`가 EDR·보안정책에 막히는 환경에선 키 없는 `claude -p` 폴백이 실패해 게이트가 조용히 fail-open(OFF)되므로, `ANTHROPIC_API_KEY` 설정으로 CLI spawn을 우회해 게이트를 유지하도록 README에 명시. **집 native Windows 검증 결과 W3 코드는 정상**(keyless에서 게이트가 fail-open 없이 LLM block 판정까지 정상 수행) — 회사 증상은 환경(EDR/정책의 `claude.exe` 차단) 탓으로 확인되어 코드 변경 불필요.

## [0.2.3] - 2026-06-22

### Added
- **업데이트 안내 (①신버전 / ②init-staleness)** — CC 본체의 신버전 notice처럼, gbc도 갱신이 필요하면 안내한다. 두 신호를 분리한다:
  - **②init-staleness(결정론적·네트워크 없음)**: 프로젝트 `.claude/settings.json`의 hook 상태로 판단 — SessionStart hook 미등록(0.2.1 이하 init) 또는 PreToolUse 명령 구식이면 `gbc init --yes` 재실행을 안내. 버전 숫자가 아니라 **실제 hook 상태**로 판단해 정말 필요한 프로젝트만 알린다.
  - **①신버전(캐시 비교)**: `~/.gbc/version-check.json` 캐시에 npm 최신 버전을 두고 설치 버전과 비교만 한다. 갱신은 hook 핫패스가 아닌 안전 지점(SessionStart 출력 후·`gbc status`)에서 `fetch`(1.5s 타임아웃, spawn 아님)로만 — **PreToolUse 게이트 경로엔 동기 네트워크 없음**.
  - **채널**: PreToolUse(cache-miss, 세션당 1회 `systemMessage`) + SessionStart + `gbc status`. PreToolUse 경로를 쓰는 이유 — 안내가 필요한 "설치만 하고 init 안 한" 코호트는 SessionStart hook이 아예 없어 그 채널로는 도달 못 하기 때문(전 코호트 도달).
  - `GBC_NO_UPDATE_NOTICE=1` opt-out. 조회 실패·타임아웃은 조용히 무시(fail-silent) — **안내 실패가 게이트 결정에 절대 영향 없음**. `gbc status`에 설치 버전 표시 추가.

### Changed
- **native Windows `claude -p` 폴백 지원 (W3)** — 키 없는 native Windows에서 `claude.cmd`(배치 shim)를 Node 18+가 셸 없이 spawn 못 하던(CVE-2024-27980 ENOENT→fail-open) 한계 해소.
  - win32에서만 `spawn(..., { shell: true })` 분기. **POSIX(WSL/Mac/Linux) 경로는 byte-for-byte 불변**(검증된 회귀 8/8 보존) — 위험을 미검증 플랫폼에만 격리.
  - **인젝션 회피**: shell 경로에서 system+user 프롬프트를 argv가 아닌 **stdin**으로 합쳐 전달 → argv는 고정 플래그뿐이라 셸 메타문자 인젝션 표면이 없음. `GBC_MODEL`은 `safeModel`로 화이트리스트(`[\w.-]+`) 검증. **kill-timeout(30s)** 추가로 무응답 stdin이 PreToolUse를 무한 차단하는 것(ENOENT보다 나쁜 케이스)을 fail-open으로 강제.
  - stdin 결합 방식의 판정 품질 동일성은 WSL `claude -p` 실측으로 검증. win32 *실행*은 회사 머신 사용자 검증 대상(단위 테스트 절대제외 — 외부 CLI·플랫폼).
- **`GBC_SPEC_FILE` 경로 해석 (W1)** — 상대경로를 hook 프로세스 cwd가 아닌 **프로젝트 cwd 기준**으로 `path.resolve`(정확성 수정). cwd 밖을 가리키면 **차단이 아니라 경고만**(stderr) — `GBC_SPEC_FILE`은 0.2.2에서 의도한 escape-hatch라 cwd 밖 공유 명세를 명시 지정하는 정당 용례를 보존.

### Internal
- **케이스 정규화 단일화 (W2)** — `gbc spec add`만 적용하던 케이스 정규화(trim·줄바꿈→공백·길이상한)를 `src/text.ts` `normalizeCase`로 추출해 `gbc defer add`에도 적용. spec/defer 비대칭(같은 입력을 한쪽만 정규화하던 것) 제거.

## [0.2.2] - 2026-06-22

### Fixed
- **빈 명세 캐시 게이트 영구 우회** — 빈 `.gbc/spec.md`에서 judge가 사소한 편집을 `[1단계]`대로 올바르게 pass한 결과가 빈 문자열 해시(상수 `e3b0c44…`)로 작업단위 캐시(`markGated`)에 들어가면, 명세가 비어 있는 한 해시가 안 바뀌어 `isGated`가 영원히 hit → 동작 편집까지 judge 없이 통과해 게이트가 교차세션으로 무력화되던 결함.
  - `runPreToolUse`: 빈 명세는 캐시 **read**를 건너뛰고(`!specEmpty && isGated`) 항상 재판정 → 기존에 오염된 `state.json`도 자동 무시(self-healing). pass 분기는 fail-open을 먼저 분기해 빈-spec 정상 pass의 오라벨 방지. `shouldCacheVerdict(verdict, specEmpty)`로 빈 명세 pass는 캐시 **write**도 금지.

### Changed (breaking)
- **시나리오 명세 단일 정본화** — `loadPlanSpec`이 더 이상 `scratch.md`를 명세 소스로 자동 폴백하지 않는다. 명세 소스는 `$GBC_SPEC_FILE` > `.gbc/spec.md`만.
  - **이유**: `scratch.md`는 흔히 하네스의 세션 진행추적 파일이라, 그 진행 노트를 시나리오 명세로 오인해 "시나리오 미지정" 차단을 건너뛰는 **거짓음성**이 발생했다. gbc가 소유하지 않은 파일을 추측 폴백하던 것이 모호성의 원천.
  - **마이그레이션**: `scratch.md`를 명세로 쓰던 사용자는 (a) 내용을 `.gbc/spec.md`로 옮기거나 `gbc spec add`로 등록, 또는 (b) `GBC_SPEC_FILE=scratch.md`로 명시 지정. 기능 손실 없음 — magic 폴백이 explicit 지정으로 바뀐 것.

### Added
- **세션 진입 잔여 defer 알림** — SessionStart hook(`gbc hook session-start`)이 세션 시작·재개 시 `.gbc/defers.json`의 미해결 항목을 표면화한다. 잔여 없거나 `GBC_NO_SESSION_HINT=1`이면 무출력. `.gbc/`만 읽어(scratch/메모리 미접근) 다른 하네스와 컨텍스트 혼재·환각 없음.
  - `gbc init`이 SessionStart hook을 `matcher: "startup|resume"`로 멱등 등록(compact마다 반복 안 함). 기존 설치는 `gbc init --yes` 재실행으로 추가.

## [0.2.1] - 2026-06-22

### Changed
- **크로스플랫폼 키 해석** — API 키를 셸 주입이 아니라 **gbc 코드가 직접 읽는다**(`resolveApiKey`: `ANTHROPIC_API_KEY` env > `~/.gbc/api-key` 파일, `.trim()` 적용).
  - hook 명령이 셸 무관 순수 형태(`node "<path>" hook pre-tool-use`)로 단일화 → native Windows(cmd.exe)/bash/zsh/Mac에서 **동일 명령** 동작. PowerShell 래퍼의 알려진 버그(키보드 입력 비활성화·stdio 행) 회피.
  - `buildPreCommand`에서 bash 전용 키주입 분기·`shDquote` 백슬래시 이스케이프 제거(Windows 경로 `C:\...` 보존). cliPath는 설치 경로(사용자 입력 아님)라 인젝션 위험 없음 + settings 기록은 `JSON.stringify`가 이스케이프 담당.
  - `gbc init`이 기존 hook(keyless·옛 bash 키주입)을 pure 명령으로 정규화(`normalizeHooks`, 멱등). 기존 설치는 `gbc init --yes` 재실행으로 이관.

### Note
- **기존 설치 무중단**: 옛 bash-prefix 명령도 새 코드에서 그대로 동작한다(resolveApiKey가 env 우선이라 셸 prefix가 세팅한 env를 읽음). 재-init은 "셸 무관 동일 명령" 미관 목적이며 기능상 필수 아님.
- **native Windows 한계**: `claude -p` 폴백은 `claude.cmd` 배치 shim을 셸 없이 실행 못 해 fail-open될 수 있음 → Windows에선 API 키 파일 사용 권장. 폴백 자체의 Windows 지원은 후속(`judgeViaCli` shell 분기, 인젝션 주의로 별도 스코프).
- 로직 + Linux/WSL 실행 실증 완료(api 경로·init 마이그레이션). **native Windows 실행은 회사 머신에서 사용자 검증 필요**.

## [0.2.0] - 2026-06-21

### Added
- **계측 레이어 (M1~M3)** — 게이트 결정을 `.gbc/events.jsonl`(append-only, 메타데이터만)에 기록.
  - `gbc metrics [--json]` 명령 — M1~M3 집계 리포트.
  - **M2**(게이트 적중 vs 도중발견) 강신호, **M3**(작업단위당 편집 반복) proxy, **M1**(통과 후 churn) 약신호. 진짜 M1(사후 대조)은 후속 A 모드 영역임을 출력·문서에 명시.
  - `GBC_NO_METRICS=1` opt-out. 이벤트 라인 4KB 캡(O_APPEND atomic), 코드 본문 미기록.
  - hook stdin의 `session_id`를 작업단위 그룹핑 키로 사용(공식 hook 스키마).
- npm 배포 스크립트 `scripts/publish.sh` (`npm run release`) — `npm_token.txt`에서 토큰을 읽어 1회성 인증으로 publish(영속 .npmrc/전역 config 미생성).

### Fixed
- M1 churn이 **빈 spec(상수 해시) 작업단위에서 교차세션 합산되던 결함** — `specHash=""` 센티넬로 빈-스펙 작업단위를 churn 집계에서 제외.

## [0.1.0] - 2026-06-21

### Added
- **B-커널 게이트** — Claude Code PreToolUse hook으로 구현 직전 침묵 누락·시나리오 미지정 차단.
- defer-registry(`gbc defer`), 명세 저장소(`gbc spec`), 작업단위 1회 캐시, 시나리오 도출 루프.
- 이중 트랜스포트(직접 haiku API / `claude -p` 폴백), fail-open 강화(캐시 제외·`systemMessage` 경고·`failopen.log`).
- `gbc init` — 프로젝트 로컬 hook 설치(머지·백업·멱등), API 키 주입 자동화 + keyless hook 업그레이드.
- 최초 npm 발행.

[0.2.3]: https://github.com/cubha/geobuke-code/releases/tag/v0.2.3
[0.2.2]: https://github.com/cubha/geobuke-code/releases/tag/v0.2.2
[0.2.1]: https://github.com/cubha/geobuke-code/releases/tag/v0.2.1
[0.2.0]: https://github.com/cubha/geobuke-code/releases/tag/v0.2.0
[0.1.0]: https://github.com/cubha/geobuke-code/releases/tag/v0.1.0
