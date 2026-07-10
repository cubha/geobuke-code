# DESIGN-TOKENS — gbc tui (0.9.0 A3a)

canonical 디자인 토큰. 소스 오브 트루스는 코드(`src/tui/format.ts`의 `PALETTE`/`MASCOT_C1`/`MASCOT_C4`, `src/tui/ui/theme.ts`의 `toneColor`) — 이 문서는 그 값을 사람이 읽기 쉬운 형태로 미러링한다. 값이 갈리면 코드가 이긴다.

시각 기준(Ground Truth) 원본: 시안 A(토글 패널)+statusline 2줄+마스코트 C1(half-block)+그린 톤, 사용자 확정 2026-07-10(`project_0_9_0_tui_stack_decision.md`).

## 팔레트

| 키 | hex | 용도 |
|---|---|---|
| `L` green-lt | `#86efac` | 마스코트 상단 하이라이트 |
| `G` green (브랜드 주색) | `#4ade80` | 마스코트 몸통, accent 톤 |
| `M` green-dim | `#2f9e63` | 마스코트 음영, 다리 |
| `D` green-deep | `#166534` | 마스코트 아래 음영, 배(plastron) 테두리 |
| `C` 크림(plastron) | `#cbe6a3` | 마스코트 배 |
| `B` 눈동자 | `#06281a` | 마스코트 눈 |
| `W` 눈 글린트 | `#eafff3` | 마스코트 눈 하이라이트 |

conhost급(트루컬러 미지원) 환경엔 `ansi16` 폴백(`ANSI16_FG`/`ANSI16_BG`, format.ts)이 각 키를 표준 16색 코드로 근사한다.

## 시맨틱 톤 → Ink 색상

format.ts는 `Tone`(plain/dim/accent/warn/danger/code)만 다루고, 실제 터미널 색상 매핑은 `theme.ts`의 `toneColor`가 전담한다(Ink `<Text color>` 소비처 분리 — format.ts는 Ink를 import하지 않는다).

| Tone | Ink color | 의미 |
|---|---|---|
| `accent` | `green` | 브랜드 주색 — pass 게이트, diff 추가(+) |
| `warn` | `yellow` | 승인 대기(BLOCK 테두리) |
| `danger` | `red` | BLOCK 게이트, diff 삭제(-), 오류 |
| `dim` | `gray` | statusline·부가정보 |
| `code` | `cyan` | 코드 펜스 내부·spec 케이스 인용 |
| `plain` | (기본, 미지정) | 일반 텍스트 |

## 마스코트

두 벡터 모두 half-block(▀/▄) 렌더 — 셀 상단=fg, 하단=bg로 2줄을 1행에 압축한다(`renderMascot`).

- **C1 "워커"** — 측면 보행 자세, 24×10px → 5줄. 기본(≥60열). 사용자 확정본(2026-07-10), 변경 시 이 문서와 `format.ts`의 `MASCOT_C1` 동시 갱신.
- **C4 미니** — 12×6px → 3줄. `<60`열 폴백(`selectMascot`).

## 레이아웃 — 시안 A(토글 패널형)

- **Static 스크롤백**(마스코트 스플래시 1회 + 대화 로그) 위에, 열려있을 때만 **계측(⌃M)/repos(⌃R) 패널**이 겹쳐 뜬다 — 동시 노출 없음(model.ts `TOGGLE_PANEL`이 배타적으로 전환).
- **승인 프롬프트**(BLOCK 시)는 입력창 자리를 대체한다 — 패널과도 동시 노출 없음(`APPROVAL_REQUESTED`가 `panel:"none"`으로 강제).
- **statusline 2줄**: 게이트 줄(`formatGateLine` — 🐢 상태·spec/defer 카운트·단축키 힌트) + 시스템 줄(`formatStatusline` — dir·branch·model·usagePct 바·비용).

## 알려진 defer

- **컨텍스트 사용량 progress bar(usagePct)** — agent-sdk의 관련 API가 `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`로 명시된 실험적 control-request라 0.9.0에서 배선하지 않음. `formatUsageBar`는 이미 구현돼 있고 `Statusline.usagePct` 기본값 0을 그대로 그린다 — 데이터 소스만 비어있는 상태.
- **"구독 인증 시 비용 숨김"** — ST3에서 제거된 기능(model.ts/engine.ts 어디도 실제로 null을 만들 수 없어 죽은 분기였음). 필요해지면 ST4(bridge.ts)가 auth 신호를 관측해 `Statusline` 타입 자체를 확장하는 설계부터 다시 시작해야 한다.
