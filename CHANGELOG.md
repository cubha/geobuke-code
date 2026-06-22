# Changelog

이 프로젝트의 주요 변경 사항을 기록한다. 형식은 [Keep a Changelog](https://keepachangelog.com/), 버전은 [SemVer](https://semver.org/)를 따른다.

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
