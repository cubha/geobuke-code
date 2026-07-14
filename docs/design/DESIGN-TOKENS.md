# DESIGN-TOKENS — gbc tui (0.9.0 A3a, 0.9.3 D1/D2 + 마스코트·배지 최종판 갱신)

canonical 디자인 토큰. 소스 오브 트루스는 코드(`src/tui/format.ts`의 `PALETTE`/`MASCOT_S2`/`MASCOT_C4`/`WORDMARK_GEOBUKE`/`SHELL_BADGE_GLYPH`/`renderWordmark`/`renderShellBadge`/`formatWelcomeCard`, `src/tui/ui/theme.ts`의 `toneColor`) — 이 문서는 그 값을 사람이 읽기 쉬운 형태로 미러링한다. 값이 갈리면 코드가 이긴다.

시각 기준(Ground Truth) 원본: 시안 A(토글 패널)+statusline 2줄+그린 톤, 사용자 확정 2026-07-10(`project_0_9_0_tui_stack_decision.md`). 스플래시(워드마크+마스코트+안내카드) 레이아웃 확정: 아티팩트 `cb7c6b1c-f254-415e-991a-a43d2a2e1f33`, 사용자 확정 2026-07-14. 마스코트 카와이 재설계·등껍질 배지는 실 터미널 시안 반복(tmux 실측)으로 사용자 확정 2026-07-14~15(`project_0_9_3_gate_false_positive_plan.md` 4~12차 후속).

## 팔레트

| 키 | hex | 용도 |
|---|---|---|
| `L` green-lt | `#a7f3c9` | 마스코트 머리·하이라이트 (워드마크 그라데이션 1단과 동일값) |
| `G` green (브랜드 주색) | `#4ade80` | 마스코트 몸통, accent 톤 (그라데이션 4단과 동일값) |
| `M` green-dim | `#2f9e63` | 마스코트 음영, 다리 (그라데이션 5단과 동일값) |
| `D` green-deep | `#166534` | 마스코트 깊은 음영, 태그라인 색 |
| `C` 크림(plastron) | `#e8f7d8` | 마스코트 배 |
| `B` 눈동자·윤곽선 | `#0a1f16` | 마스코트 눈동자, 실루엣 전체 윤곽선 |
| `W` 눈 글린트 | `#ffffff` | 마스코트 눈 하이라이트 |
| `P` 볼터치 | `#f7b3a1` | 마스코트 볼(블러셔) |
| `S` 스컷 중간톤 | `#3fbf7f` | 마스코트 등껍질 비늘(+구 배지 RESERVED판) |
| `2`/`3`/`6` | `#86efac`/`#5fe694`/`#1c7a48` | 워드마크 그라데이션 2·3·6단 미러(배지 RESERVED판 전용) |

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

- **S3 "카와이"**(상수명은 `MASCOT_S2` 유지) — 측면 보행 자세, 30×16px → 8줄. 기본(≥60열). 원/타원 래스터화+실루엣 전체 윤곽선(`B`) 기법 — 큰 머리가 목으로 몸통 밖까지 이어지고 눈 하이라이트(`W`)·볼터치(`P`)로 표정을 준다. 눈은 46×26 승인 시안과 동일한 **절대 반경(1.6×1.7)** 고정(비례축소 금지 — 저해상도에서 뭉개짐). 사용자 최종확정 2026-07-14, **이후 변경 금지(사용자 픽스 선언)**.
- **C4 미니** — 12×6px → 3줄. `<60`열 폴백(`selectMascot`, 임계값은 `SPLASH_WIDE_MIN_COLUMNS`).

## 등껍질 배지 (`SHELL_BADGE_GLYPH`, ≥96열 한정)

워드마크 우측에 `WORDMARK_BADGE_GAP`(4칸) 띄워 병치되는 원형 배지, 9×6. GEOBUKE 워드마크의 실제 'O' 글리프(`WORDMARK_GEOBUKE` 17~25열)에서 파생 — 내부를 `█`로 완전 채운 뒤 거북 등껍질 솔기로 **X자 이음매의 이중선 코너 4개**(위 `╝╚` + 아래 `╗╔`, 중앙은 채움)를 넣었다. 솔기·외곽 그림자(`╗║╚═╝`) 모두 그 행의 그라데이션 색 그대로(`renderShellBadge`=`renderWordmark`와 동일한 행 단일색 공용 경로) — 워드마크와 같은 재질로 읽힌다. 사용자 최종확정 2026-07-15. 중간 시안 2종은 미배선 보존: `SHELL_BADGE_CIRCLE_RESERVED`(다색 스컷격자 24×24 half-block), `SHELL_BADGE_GRADIENT_RESERVED`(그라데이션 원형 14×12 half-block).

## 워드마크 (0.9.3 D1)

`WORDMARK_GEOBUKE`(figlet "ANSI Shadow", 6행) — `renderWordmark`가 행별 그린 그라데이션을 입힌다:

| 행 | hex |
|---|---|
| 1 | `#a7f3c9` |
| 2 | `#86efac` |
| 3 | `#5fe694` |
| 4 | `#4ade80` |
| 5 | `#2f9e63` |
| 6 | `#1c7a48` |

conhost급(ansi16) 폴백은 상위 3행=밝은 그린(ANSI 92), 하위 3행=그린(ANSI 32) 2단 근사. 워드마크 아래 태그라인(`formatTagline`): `거북이코드 v{package.json 버전} · 계획↔구현↔검증 게이트`, 색 `#166534`(PALETTE `D`와 동일), 워드마크 우측 정렬.

## 안내카드 (0.9.3 D1 — `formatWelcomeCard`)

3섹션 구성, Ink `Box borderStyle="round" borderColor="green"` 고정폭 54칸(`WelcomeCard.tsx`):
1. 게이트 요약 — "🐢 게이트 활성 — 명세 없는 구현은 차단됩니다" + `spec N케이스 · defer M`
2. 기본 스킬 — "🧩 기본 스킬" 헤딩 + gbc 자체 스킬(`install.ts`의 `GBC_SKILL_NAMES` = gate/gbc-mute/gbc-monitor) 각 1행(`/이름` accent + 짧은 blurb dim, `app.tsx`의 `SPLASH_SKILL_BLURBS` 큐레이션)
3. 키맵 — `⌃M 메트릭 · ⌃R repos · ⌃S skills` 1행 + `shift+↵ 개행 · esc 중단 · ⌃C 종료(2회)` 1행

## 레이아웃 — 시안 A(토글 패널형) + 스플래시 히어로(0.9.3 D2)

- **Static 스크롤백**(스플래시 히어로 1회 + 대화 로그) 위에, 열려있을 때만 **계측(⌃M)/repos(⌃R)/skills(⌃S) 패널**이 겹쳐 뜬다 — 동시 노출 없음(model.ts `TOGGLE_PANEL`이 배타적으로 전환).
- **승인 프롬프트**(BLOCK 시)는 입력창 자리를 대체한다 — 패널과도 동시 노출 없음(`APPROVAL_REQUESTED`가 `panel:"none"`으로 강제).
- **statusline 2줄**: 게이트 줄(`formatGateLine` — 🐢 상태·spec/defer 카운트·단축키 힌트) + 시스템 줄(`formatStatusline` — dir·branch·model·usagePct 바·비용).
- **스플래시 히어로**(`SplashHero.tsx`) — 폭 3단 반응형, 임계값은 마스코트용(`SPLASH_WIDE_MIN_COLUMNS`=60)과 워드마크+병치용(`SPLASH_HERO_MIN_COLUMNS`=96, 카와이 마스코트 30폭 확대에 맞춰 84→96 상향 — 2컬럼 폭 예산 3+30+6+54=93칸)이 분리돼 있다:
  - `<60`열: 마스코트 C4 미니 + 안내카드 세로 스택(워드마크 생략)
  - `60~95`열: 마스코트 S2 + 안내카드 세로 스택(워드마크 생략)
  - `≥96`열: 워드마크(그라데이션)+등껍질 배지+태그라인 → 마스코트 S2 + 안내카드 **2컬럼 병치**(Ink `alignItems="center"`로 마스코트를 카드 세로 중앙에 정렬).
  - 워드마크·마스코트·배지 모두 `Mascot.tsx`(사전 컬러링 ANSI 줄 배열을 그대로 출력하는 범용 컴포넌트, 이름은 마스코트 전용처럼 보이지만 재사용)로 렌더.
  - **웰컴 라인**(`WELCOME_LINE`, format.ts) — "🐢 무엇이든 입력하세요 — 게이트가 계획 없는 구현을 지켜줍니다." 카드 아래, 폭 무관 공통 표시.
  - **여백**(Ink `margin*` props, `SplashHero.tsx`): 히어로 위 2줄(`HERO_TOP_MARGIN`, 태그라인↔마스코트 여백과 대칭) · 좌측 여백 3칸(`HERO_LEFT_MARGIN`, 전체 히어로) · 워드마크↔배지 4칸(`WORDMARK_BADGE_GAP`) · 마스코트↔카드 6칸(`MASCOT_CARD_GAP`) · 태그라인↔마스코트+카드 행 2줄(`marginTop={2}`, ≥96열만) · 카드↔웰컴 1줄(`marginTop={1}`) · 웰컴↔입력창 2줄(`marginBottom={2}`, Static 1회 커밋이라 세션 내내 재적용 안 되고 스플래시 직후에만 남음).

## 알려진 defer

- **컨텍스트 사용량 progress bar(usagePct)** — agent-sdk의 관련 API가 `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`로 명시된 실험적 control-request라 0.9.0에서 배선하지 않음. `formatUsageBar`는 이미 구현돼 있고 `Statusline.usagePct` 기본값 0을 그대로 그린다 — 데이터 소스만 비어있는 상태.
- **"구독 인증 시 비용 숨김"** — ST3에서 제거된 기능(model.ts/engine.ts 어디도 실제로 null을 만들 수 없어 죽은 분기였음). 필요해지면 ST4(bridge.ts)가 auth 신호를 관측해 `Statusline` 타입 자체를 확장하는 설계부터 다시 시작해야 한다.
