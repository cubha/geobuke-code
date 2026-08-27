# geobuke-code — 프로젝트 규칙

## 🧨 tmux 사용 규칙 (TUI 실렌더 검증)

이 repo는 TUI 렌더 검증에 tmux를 상시 사용한다. **tmux 서버가 죽으면 사용자의 모든 세션이 동시에 소멸**하므로 아래를 지킨다. (2026-08-26 이 repo 작업 중 2회 전멸 — 원인 F-NEW-34)

**금지**
- `tmux set-option -g window-size manual` — 직후 `new-session`/`new-window` 한 번에 서버 SIGSEGV. tmux 3.4~3.6 공통 결함이라 **버전을 올려도 안 고쳐진다**.
- `tmux kill-server` — 남의 세션까지 죽는다. 정리는 `tmux kill-session -t <이름>`.

**대신 이렇게**
- 폭 강제: 세션을 먼저 만든 뒤 `tmux resize-window -t <세션> -x N -y M` 만 사용(윈도우 스코프라 안전).
- 캡처·실험: 전용 소켓 격리 `tmux -L gbcv -f /dev/null new-session -d …` → 끝나면 `tmux -L gbcv kill-server`.
- 실제 폭은 `tmux display -p '#{pane_width}x#{pane_height}'`로 반드시 재확인.

상세 기법·함정은 memory `feedback_tui_tmux_capture_technique.md`, 결함 원인은 `~/.claude/HARNESS-AUDIT.md` F-NEW-34.
