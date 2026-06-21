# Changelog

이 프로젝트의 주요 변경 사항을 기록한다. 형식은 [Keep a Changelog](https://keepachangelog.com/), 버전은 [SemVer](https://semver.org/)를 따른다.

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

[0.2.0]: https://github.com/cubha/geobuke-code/releases/tag/v0.2.0
[0.1.0]: https://github.com/cubha/geobuke-code/releases/tag/v0.1.0
