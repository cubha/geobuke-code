---
name: gbc-mute
description: 거북이코드(gbc)의 defer Stop 리마인드를 on/off 토글한다. 미해결 defer가 있으면 Stop hook이 매 대화 종료(턴)마다 리마인드를 띄우는데, 이게 거슬릴 때 이 스킬로 음소거하거나 다시 켠다. '/gbc-mute', 'defer 알림 꺼줘', 'defer 알림 그만', '매번 뜨는 거 꺼줘', 'defer 음소거', 'Stop 리마인드 음소거', 'defer 알림 다시 켜줘', '음소거 해제', '리마인드 상태' 등 언급 시 호출.
---

# /gbc-mute — defer Stop 리마인드 음소거 토글

미해결 defer가 있으면 거북이코드 **Stop hook이 매 대화 종료(턴)마다** 리마인드를 띄운다. `stop_hook_active` 가드는 한 턴 안의 루프만 끊을 뿐 세션 영속 억제가 아니라, **새 턴마다 재발화**한다(이월해도 계속 노출됨). 이 스킬은 그 매-턴 리마인드를 켜고 끄는 전용 토글이다.

## 동작

토글은 `.gbc/config.json`의 `stopHintMuted` 플래그로 영속된다(`gbc defer unmute` 전까지 유지 — 새 defer·세션 교체·`gbc gate reset`에도 풀리지 않음).

| 사용자 의도 | 명령 |
|---|---|
| 현재 상태 확인 | `gbc defer list` (상단에 음소거 여부 표기) |
| 음소거 켜기 (매-턴 Stop 리마인드 끄기) | `gbc defer mute` |
| 음소거 끄기 (리마인드 다시 켜기) | `gbc defer unmute` |

## 실행 흐름 (에이전트)

1. **먼저 현재 상태를 확인**한다 — `gbc defer list`로 음소거 여부를 읽는다.
2. 사용자 발화에서 의도를 판정해 토글한다:
   - "꺼줘 / 그만 / 음소거 / 조용히" → `gbc defer mute`
   - "켜줘 / 다시 / 해제" → `gbc defer unmute`
   - 의도가 모호하면(예: "/gbc-mute"만 입력) → **현재 상태를 보여주고** 켤지 끌지 사용자에게 묻는다(상태-인지 토글, 무턱대고 뒤집지 않는다).
3. 실행 결과를 **사용자에게 표면화**한다(`gbc defer mute`/`unmute`의 출력을 그대로 전달).

## 끄는 범위 (중요)

- **Stop 채널만** 끈다 — 매 대화 종료마다 강요되던 알림.
- **SessionStart(세션 진입) 알림은 유지**한다. 새 세션 시작 시 "이전 작업 잔여"를 **한 번은** 회상하도록(완전 망각 방지). 즉 음소거는 "매 턴 강요"만 제거하고, 진입 시 1회 환기는 남긴다.
- 음소거 중이면 SessionStart 진입 알림 끝에 `🔕 음소거 중 (해제: /gbc-mute)` 한 줄이 따라붙고, `gbc status`·`gbc defer list`에도 상태가 표기되므로 "꺼둔 걸 잊는" 일이 없다.

## Known Pitfalls

- **음소거는 defer를 지우지 않는다.** 항목은 그대로 남아 게이트 판정·SessionStart 회상에 계속 쓰인다. 끄는 건 "매-턴 알림"뿐이다. 항목을 끝낸 거면 음소거가 아니라 `gbc defer resolve`다(→ `/gate`).
- **SessionStart는 음소거 대상이 아니다.** "진입 시에도 안 뜨게" 해달라는 요청이면 음소거로는 안 된다 — 그건 별개 채널(`GBC_NO_SESSION_HINT=1`)이며 의도적으로 분리돼 있다.
