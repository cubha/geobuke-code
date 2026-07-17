# 0.10.0 A3b 실기검증 이슈 3건 분석 보고서

> 분석일: 2026-07-16
> 프로젝트: geobuke-code (gbc) 0.10.0 A3b — 다중탭 스위처
> 분석 관점: tmux PTY 실기검증(2026-07-16)에서 발견된 이슈 3건 — ①auto-memory 격리 우회 ②ink Static 전체폭 렌더 ③"안녕하세요" 8회 중복
> 검증 세션 증거: `~/.claude/projects/-mnt-d-workspace-geobuke-code/67c09495-9228-4b66-9420-419936858001.jsonl`

---

## 요약 (TL;DR)

| # | 이슈 | 판정 | 심각도 | 처방 |
|---|---|---|---|---|
| ① | 새 TUI 세션이 이 프로젝트 auto-memory를 알고 응답 | **CLI 네이티브 기능 — gbc 결함 아님. 단 격리 불변식의 커버 범위 밖** | 🟡 (오염 아님·정책 결정 필요) | `settings: { autoMemoryEnabled: false }` 1줄 (결정 시) |
| ② | 스크롤백이 사이드바 우측 컬럼에 안 갇힘 | **ink 구조적 제약 — 코드로 해소 불가** | 🟡 (디자인 결정 필요) | 현 레이아웃 수용 or Static 포기(고비용) |
| ③ | "안녕하세요! 👋" 8회 중복 | **실 렌더 버그(유력) — ink 뷰포트 초과 미클리어** | 🔴 (출시 전 수정 권장) | 스트리밍 프리뷰 tail 윈도잉 |

**핵심 결론**: 사용자 최우선 제약이었던 "세션 간(탭 간) 컨텍스트 오염"은 **①에 해당하지 않는다** — auto-memory는 cwd(repo) 단위로 키잉되므로 각 탭은 자기 repo의 메모리만 본다. ①의 실체는 "gbc TUI ↔ 같은 repo의 Claude Code 세션" 간 공유이며, 읽기보다 **쓰기 역류**(TUI 대화가 사용자의 Claude Code 메모리를 오염)가 더 큰 리스크다.

---

## 1. 이슈 ① — auto-memory 주입 (settingSources:[] 격리 우회)

### 1-1. 실측 증거

검증 세션 트랜스크립트(67c09495) 전수 분석 결과:

- `entrypoint: "sdk-ts"`, `promptSource: "sdk"`, `cwd: /mnt/d/workspace/geobuke-code`, CLI `2.1.202` — **gbc가 spawn한 세션 맞음** (사용자가 직접 연 세션 아님).
- 유저 메시지는 `"ㅎㅇ"` 3바이트뿐. attachment 3건은 deferred-tools/agent-listing/skill-listing 델타로 **메모리 본문 없음**. 도구 호출 0회.
- 그런데 첫 응답이 MEMORY.md 내용("0.10.0 A3b ST1~ST12, verify 610/610, 다음=실터미널 검증→/ship")을 정확 서술.
- → 주입 지점은 트랜스크립트에 기록되지 않는 **시스템 프롬프트 레벨** = CLI 네이티브 auto-memory 로딩.

### 1-2. 메커니즘 (SDK 타입 정의로 확정)

`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`:

- auto-memory는 **cwd 기준 프로젝트 슬러그로 키잉**: 기본 경로 `~/.claude/projects/<sanitized-cwd>/memory/` (`autoMemoryDirectory` JSDoc, sdk.d.ts:6133).
- 시스템 프롬프트에 auto-memory 컨텍스트가 포함됨 (sdk.d.ts:1927 "working directory, **auto-memory**, git-status context", :3288).
- **`settingSources`는 설정 파일(settings.json·CLAUDE.md·skills·hooks)의 로드 소스만 제어**한다. **공식 문서가 명시적으로 확인**: "What settingSources does not control — Auto memory at ~/.claude/projects/&lt;project&gt;/memory/. Loaded into the system prompt at session start. To disable: Set `autoMemoryEnabled: false` in settings, or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in env" ([agent-sdk/claude-code-features](https://code.claude.com/docs/en/agent-sdk/claude-code-features.md)). auto-memory는 `Settings`의 별도 키 `autoMemoryEnabled`(sdk.d.ts:6129)가 지배하며, 어디서도 안 정하면 **기본값 enabled**. 즉 `settingSources: []`는 "이 키를 false로 정할 설정 파일마저 안 읽는" 상태라 오히려 항상 기본값(on)이 된다.
- 매 세션 로드 분량은 `MEMORY.md` 처음 200줄 또는 25KB([memory.md](https://code.claude.com/docs/en/memory.md)). 슬러그는 git repo 기준이라 **같은 repo의 worktree·서브디렉토리도 동일 메모리를 공유**한다.

**gbc 코드 결함이 아니다.** `buildEngineOptions`(src/engine.ts:154)의 두 불변식(settingSources:[]·apiKey 미주입)은 설계 목적(훅 재귀 방지·과금 관측)대로 정상 동작 중이고, auto-memory는 그 불변식이 애초에 커버하지 않는 하위 레이어다.

### 1-3. 오염 여부 재판정 — 사용자 최우선 제약과의 관계

| 경로 | 오염인가 | 근거 |
|---|---|---|
| 탭A(repoA) ↔ 탭B(repoB) | **아니오** | auto-memory가 cwd별 키잉 — 각 탭은 자기 repo 디렉토리의 메모리만 로드. 0.10.0의 오염 차단 5경로와 독립적으로 교차 없음 |
| gbc TUI ↔ 같은 repo의 Claude Code 세션 (읽기) | **공유(양면적)** | 같은 사용자·같은 머신·같은 프로젝트의 메모리. "이어서 아는" 연속성으로 볼 수도, "격리 세션" 기대 위반으로 볼 수도 있음 |
| gbc TUI → auto-memory 디렉토리 (쓰기) | **⚠️ 실질 리스크** | `autoMemoryEnabled`는 read/write 겸용 — TUI 세션도 메모리 기록 지시를 받으므로 TUI 잡담이 사용자의 Claude Code 프로젝트 메모리를 갱신·오염시킬 수 있음 |

**소급 범위**: 0.7.0 A-mode(`gbc run`)부터 engine.ts 경유 모든 SDK 세션에 동일 적용. 단 지금까지의 실사용(run/tui)은 전부 본인 repo·본인 메모리였으므로 사고는 아님.

### 1-4. 처방 (결정 대기)

- **끄기로 결정 시** — 공식 경로 2택, 어느 쪽이든 1줄+회귀락으로 공수 극소:
  - `buildEngineOptions`에 `settings: { autoMemoryEnabled: false }` (Options.settings가 `string | Settings`를 받아 파일 없이 in-process 주입 가능) — **권장**: 의미가 자기서술적이고 타입 체크됨.
  - 또는 `env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }` (SDK 문서의 권장 격리 패턴).
  - (참고: CLI 단발 실행엔 `--bare` 플래그도 auto-memory를 끄지만 hooks·CLAUDE.md까지 일괄 차단이라 engine 경로엔 과함.)
- **유지로 결정 시**: "TUI 세션은 이 repo의 Claude Code 메모리를 공유합니다" 문서 명시 + 쓰기 역류 리스크 수용을 기록.
- 절충: **읽기 유지·쓰기만 차단**은 단일 키라 불가 — 켜거나 끄거나 둘 중 하나.

---

## 2. 이슈 ② — Static 전체폭 렌더 (스크롤백이 우측 컬럼에 안 갇힘)

### 2-1. 판정: ink 구조적 제약 (코드 결함 아님)

ink의 `<Static>`은 트리 내 위치와 무관하게 **항상 동적 출력 위에 전체폭으로 prepend**된다(ink readme: "output is prepended to the dynamic output", 노드 트리당 최대 1개). `app.tsx:693`의 `<Static items={scrollback}>`를 2컬럼 `<Box>` 우측에 넣어도 스크롤백은 사이드바 옆이 아닌 화면 전체폭으로 흐른다. 터틀 덱 시안("우측에 대화만 흐름")과 불일치.

### 2-2. 현재 실제 레이아웃

```
┌──────────────────────────────────┐
│ (스크롤백 — 전체폭, Static)        │
│ ...                              │
├──────────┬───────────────────────┤
│ 사이드바   │ 스트리밍 프리뷰·입력창·  │
│ (repos·탭)│ statusline (동적 영역)  │
└──────────┴───────────────────────┘
```

### 2-3. 선택지

| 안 | 내용 | 비용 | 리스크 |
|---|---|---|---|
| **A. 현 상태 수용** (권장) | 스크롤백 전체폭 + 하단만 2컬럼. 시안과 부분 불일치를 공식 기록 | 0 | 시각적 기대와 차이 — 실사용감은 오히려 대화 가독폭이 넓어 유리할 수 있음 |
| B. Static 포기 + 자체 윈도잉 | scrollback을 동적 영역에서 직접 페이징 렌더 | 高 (0.9.0 스택결정 번복·스크롤 UX 자체구현) | 이슈 ③류 리렌더 부하 증폭, alt-screen에서 히스토리 탐색 UI까지 필요 |
| C. 사이드바를 오버레이 토글로 격하 | 기존 ⌃R 패널 방식 회귀 | 中 | "상시 탭 가시성" 요구(0.10.0 핵심) 후퇴 |

> 참고: alt-screen(cli.ts:1156)에서는 터미널 스크롤백 버퍼가 없어 Static으로 위로 밀려난 대화는 어차피 재열람 불가 — B안을 택해도 이 문제는 남는다. 장기적으론 "대화 히스토리 뷰"가 별도 과제.

---

## 3. 이슈 ③ — "안녕하세요! 👋" 8회 중복

### 3-1. 판정: 실 렌더 버그 유력 (tmux 캡처 함정 아님)

기지 tmux 함정 3종(CJK 폰트대체·배경색 파싱·window-size)은 글리프 치환·색 누락 계열이지 **줄 복제**를 만들지 않는다. 반면 ink에는 정확히 이 증상을 만드는 문서화된 제약이 있다:

- **터미널은 뷰포트보다 큰 출력을 다시 그릴 수 없다** — 출력 높이가 화면 행수를 넘으면 ink가 이전 프레임을 지우지 못하고 stale 줄이 위에 남는다(ink 3 릴리스 노트·[discussion #621](https://github.com/vadimdemedes/ink/discussions/621)·리사이즈 변형은 [issue #907](https://github.com/vadimdemedes/ink/issues/907)).

### 3-2. 발생 경로 (재현 가설)

`app.tsx:718` 스트리밍 프리뷰는 **누적 전체 텍스트**를 동적 영역에 렌더한다: `{state.streamingText && <Text>{state.streamingText}</Text>}`. 스로틀 틱마다 텍스트가 자라며 동적 영역(사이드바 포함 2컬럼 블록) 높이가 뷰포트를 초과하는 순간, ink가 직전 프레임을 못 지워 프레임 잔상이 쌓인다 — 응답 첫 줄 "안녕하세요! 👋"가 잔상 프레임 수만큼(8회) 반복 관측된 것과 정합. alt-screen이라 잔상이 스크롤로 밀려나지도 않는다.

### 3-3. 처방

- **스트리밍 프리뷰 tail 윈도잉**: 프리뷰를 마지막 N줄(예: 뷰포트 높이 − 고정 UI 행수)로 잘라 동적 영역 높이에 상한을 건다. 완성 시 commitStream이 전체 텍스트를 Static에 커밋하는 기존 구조는 그대로 — 정보 손실 없음.
- 수정 후 tmux PTY로 장문 스트리밍 재현 검증(긴 응답 유도 → capture-pane에 중복 줄 0 확인).

---

## 4. 개선 로드맵 (braintrust 4렌즈 패널 반영, 2026-07-16)

> UX·격리/신뢰·공수/회귀·선례 4렌즈 병렬 적대검토 결과. 3건 모두 **4/4 만장일치** — ①차단 ②A안 수용 ③발행 전 수정.

### 즉시 (0.10.0 발행 전 — 권장 패키지)
- [ ] **③ tail 윈도잉 수정 + 재현검증** (필수) — 선례 표준형은 "마지막 N줄 + `… +N줄` 접힘 표시"(Claude Code 본체·gemini-cli MaxSizedBox 동일 패턴). 상한 = `max(1, rows − 고정UI행수)` (`useWindowSize`가 rows 이미 제공, app.tsx:112에 구조분해만 추가). 함정 3: 소프트랩 행수(보수적 여유 2~3행), ANSI 스트립 선행(0.9.4 Warn1과 동일 표면), 최소 터미널 높이 README 명시. tmux 장문 재현으로 중복 0 확인.
- [ ] **① auto-memory 차단** (권장·사용자 확인 후) — `buildEngineOptions`에 `settings: { autoMemoryEnabled: false }` 1줄 + 제3 불변식 회귀락(~5줄, 기존 패턴 복제). SDK 공식 문서의 권장 격리 패턴과 정확히 일치. 구버전 CLI(2.1.112)에선 키 무시=fail-open(크래시 아님)으로 추정 — 사외 관찰 항목에 추가.
- [ ] **①-b 게이트 judge 경로 별도 차단** (격리 렌즈 신규 발견 高) — judge CLI 폴백(`--append-system-prompt`=프리셋 유지)은 buildEngineOptions를 안 타므로 **judge spawn env에 `CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1"` 별도 주입** 필요. keyless 환경 판정이 MEMORY.md "이미 완료" 서사에 오염되면 missing 오탐·snapshot replay 드리프트 발생 가능(0.5.x 소급). 단 headless `-p`의 메모리 로드는 미실측 — **적용 전 실홈 스모크 1회**로 확정.
- [ ] **② A안 수용** (코드 변경 0) — ink 계열(Claude Code·gemini-cli)은 예외 없이 대화 전체폭; 컬럼 가두기는 bubbletea(Go) 전용 그림. 80열 터미널에서 우측 44열에 코드블록을 가두면 가독성 오히려 악화. 시안 쪽을 현실로 수정·문서화.

### 단기 (0.10.x)
- [ ] 좁은 터미널(<100열) 사이드바 토글 키 또는 자동 축소(UX 렌즈 中) — 하단 동적영역 45% 잠식 완화
- [ ] **격리 범위 명세 문서화**(2렌즈 합의): gbc 세션이 "끊는 것"(settings·CLAUDE.md·auto-memory)과 "공유하는 것"(번들 스킬·계정 MCP 커넥터) 명시
- [ ] 보고서 §1-3 각주: 동일 repo의 worktree 탭들은 메모리 슬러그 공유 — 차단 시 함께 해소

### 중장기 (1.0.0 하드닝 / 백로그)
- [ ] alt-screen 대화 히스토리 재열람 수단(페이저 or 로그 파일 안내) — B안(자체 윈도잉)은 백로그에도 넣지 않음(gemini-cli가 실증한 가시밭길)
- [ ] 메모리 연속성 절충안 검토: opt-in 공유(`GBC_SHARE_MEMORY=1`류) 또는 `autoMemoryDirectory`를 gbc 전용 경로로 돌려 "gbc끼리의 연속성"만 제공
- [ ] 격리 불변식 3종(settingSources·apiKey·autoMemory) 통합 회귀락

---

## 5. 리서치 출처

- 로컬 실측: 검증 세션 트랜스크립트 67c09495(entrypoint/attachment 전수), `sdk.d.ts`(autoMemoryEnabled :6129 · autoMemoryDirectory :6135 · Options.settings :1866 인근 · 시스템 프롬프트 dynamic sections :1927/:3288), `src/engine.ts:154`
- 공식 문서: [memory.md](https://code.claude.com/docs/en/memory.md) · [agent-sdk claude-code-features.md](https://code.claude.com/docs/en/agent-sdk/claude-code-features.md) (settingSources가 auto-memory를 제어하지 않음 명시) · claude CLI v2.1+ `--help` (`--bare`)
- [ink readme — Static](https://github.com/vadimdemedes/ink) · [Ink 3 릴리스 노트](https://vadimdemedes.com/posts/ink-3) · [discussion #621 (출력 > 화면높이 클리어)](https://github.com/vadimdemedes/ink/discussions/621) · [issue #907 (리사이즈 잔상)](https://github.com/vadimdemedes/ink/issues/907)

---

> 이 보고서는 Claude Code `/analyze` 스킬로 생성되었습니다.
