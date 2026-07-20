# DESIGN-TOKENS — gbc tui (0.9.0 A3a, 0.9.3 D1/D2 + 마스코트·배지 최종판, 0.10.1 레이아웃 재확정+재배선 갱신)

canonical 디자인 토큰. 소스 오브 트루스는 코드(`src/tui/format.ts`의 `PALETTE`/`MASCOT_S2`/`WORDMARK_GEOBUKE`/`SHELL_BADGE_GLYPH`/`renderWordmark`/`renderShellBadge`/`formatWelcomeCard`/`shouldShowWordmark`/`computeFrameLayout`, `src/tui/ui/theme.ts`의 `toneColor`) — 이 문서는 그 값을 사람이 읽기 쉬운 형태로 미러링한다. 값이 갈리면 코드가 이긴다.

시각 기준(Ground Truth) 원본: 시안 A(토글 패널)+statusline 2줄+그린 톤, 사용자 확정 2026-07-10(`project_0_9_0_tui_stack_decision.md`). 마스코트 카와이 재설계·등껍질 배지는 실 터미널 시안 반복(tmux 실측)으로 사용자 확정 2026-07-14~15(`project_0_9_3_gate_false_positive_plan.md` 4~12차 후속). **0.10.1 레이아웃 재확정+재배선**: 카드+사이드바 동일폭 34·좌측 상시 스택(카드+사이드바)·워드마크 전체폭 상시노출·외부 '+' 프레임·첫 제출 시 스플래시 일괄소멸 — 아티팩트 `ff0eb0b1-192f-4334-b8d3-761deeae23c0`, braintrust 4렌즈 적대검토 통과(2026-07-20, `project_tui_turn_latency_conversation_ux.md`). 구 "스플래시 히어로 2컬럼 병치"(마스코트+카드가 워드마크 아래 나란히·세로스택으로 자체 조립되던 `SplashHero.tsx` 방식, 아티팩트 `cb7c6b1c-f254-415e-991a-a43d2a2e1f33`)는 0.10.1에서 완전히 대체됐다 — 마스코트는 좌측 사이드바 하나로 통합, 카드는 그 사이드바 위에 상시 스택, 워드마크는 `SplashHeader.tsx`로 분리돼 사이드바까지 포함한 전체 화면 폭 기준 최상단에 1회 그려진다.

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

half-block(▀/▄) 렌더 — 셀 상단=fg, 하단=bg로 2줄을 1행에 압축한다(`renderMascot`).

- **S3 "카와이"**(상수명은 `MASCOT_S2` 유지) — 측면 보행 자세, 30×16px → 8줄. **0.10.1부터 좌측 상시 사이드바(`Sidebar.tsx`) 하나에만 쓰인다**(사이드바 내부폭 30에 무잘림으로 들어감 — 모듈 로드 시 1회 렌더). 원/타원 래스터화+실루엣 전체 윤곽선(`B`) 기법 — 큰 머리가 목으로 몸통 밖까지 이어지고 눈 하이라이트(`W`)·볼터치(`P`)로 표정을 준다. 눈은 46×26 승인 시안과 동일한 **절대 반경(1.6×1.7)** 고정(비례축소 금지 — 저해상도에서 뭉개짐). 사용자 최종확정 2026-07-14, **이후 변경 금지(사용자 픽스 선언)**.
- **C4 미니**(폭에 따른 마스코트 폴백) — **0.10.1 SubTask8에서 완전 삭제**. 구 스플래시 히어로가 <60열에서 쓰던 12×6px 폴백이었으나, 스플래시 자체에 더 이상 독립 마스코트가 없어져(마스코트는 사이드바 하나로 통합) 폴백 개념이 무의미해졌다.

## 등껍질 배지 (`SHELL_BADGE_GLYPH`, 워드마크와 함께 상시노출 — 0.10.1부터 72열↑)

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

conhost급(ansi16) 폴백은 상위 3행=밝은 그린(ANSI 92), 하위 3행=그린(ANSI 32) 2단 근사. 워드마크 아래 태그라인(`formatTagline`): `거북이코드 v{package.json 버전} · 계획↔구현↔검증 게이트`, 색 `#166534`(PALETTE `D`와 동일), 워드마크 우측 정렬. **0.10.1**: 워드마크 표시 여부는 `shouldShowWordmark(columns)` 단일 판정(`SplashHeader.tsx` 전담) — `SPLASH_WORDMARK_MIN_COLUMNS`(72열) 이상이면 상단 전체폭(사이드바 포함)에 표시, 미만이면 태그라인 텍스트만 표시(판독 불가한 아스키 잔해 방지 강등 규칙). 구 2컬럼 병치 임계값(`SPLASH_HERO_MIN_COLUMNS`)은 마스코트+카드 병치 개념 자체가 폐기되며 함께 삭제됐다.

## 안내카드 (0.9.3 D1 — `formatWelcomeCard`, 0.10.1 폭·카피·배치 재확정)

3섹션 구성, Ink `Box borderStyle="round" borderColor="green"` 고정폭 **34칸**(`WelcomeCard.tsx` `CARD_WIDTH` — 0.10.1부터 좌측 사이드바와 **동일폭**, 이전 54. 내부폭 30 = 34−테두리2−paddingX2, `flexShrink={0}` — flexGrow 대화 컬럼과 나란한 행에서 쪼그라들지 않도록). **0.10.1 SubTask10부터 배치 자체가 바뀌었다**: 더 이상 스플래시 히어로(대화 스크롤백) 안이 아니라, `app.tsx` 루트의 **좌측 상시 스택**(사이드바 바로 위, 같은 열)에 `state.splashDismissed`(model.ts) 조건부로 렌더된다 — 첫 메시지 제출(TURN_START)과 동시에 사라진다:
1. 게이트 요약 — "🐢 게이트 활성"(1행) + "명세 없는 구현은 차단됩니다"(1행, 내부폭 30 예산에 맞춰 2행 분할) + `spec N케이스 · defer M`
2. 기본 스킬 — "🧩 기본 스킬" 헤딩 + gbc 자체 스킬(`install.ts`의 `GBC_SKILL_NAMES` = gate/gbc-mute/gbc-monitor) 각 1행(`/이름` accent + 짧은 blurb dim, `app.tsx`의 `SPLASH_SKILL_BLURBS` 큐레이션 — 0.10.1에서 폭 34 예산에 맞춰 재축약: `spec·verify 관리`/`현황 조회`/`리마인드 on/off`, 카피 무손실이며 원문은 ⌃S skills 패널의 `SkillInfo.description`에 그대로 보존)
3. 키맵 — 0.10.1부터 3행: `⌃M 메트릭 · ⌃R repos` / `⌃S skills · esc 중단` / `shift+↵ 개행 · ⌃C 종료(2회)`(이전 2행 구성은 폭 34에서 초과)

모든 행의 표시폭(CJK 2칸+` · ` 구분자 포함, `string-width` 기준)은 카드 내부폭 30 이하 — `test/tui-format.test.mjs`의 회귀 가드 테스트가 이를 고정한다.

## 레이아웃 — 시안 A(토글 패널형) + 전체폭 헤더 + 좌측 상시 스택(0.10.1 SubTask10 재배선)

화면 최상단(사이드바까지 포함한 전체 프레임 내부폭 기준)에 헤더, 그 아래 좌우 2컬럼 — 좌측(카드+사이드바 상시 스택)·우측(대화). 첫 메시지 제출과 동시에 헤더·카드·웰컴 라인이 **일괄 소멸**하고 사이드바+대화 컬럼만 남는다(`state.splashDismissed`, model.ts `TURN_START` — SubTask7).

- **`SplashHeader.tsx`**(전체폭 헤더, `app.tsx` 루트 최상단·좌우 컬럼 Row *바깥*) — `frameLayout.innerColumns`(프레임 활성 시 거터 뺀 값, 사이드바 폭 포함) 기준 `shouldShowWordmark` 단일 판정. `SPLASH_WORDMARK_MIN_COLUMNS`(72열) 이상이면 워드마크(그라데이션)+등껍질 배지+태그라인, 미만이면 태그라인 텍스트만. `state.splashDismissed`가 true면(첫 제출 이후) 렌더 자체가 사라진다 — Static 커밋이 아니라 일반 조건부 JSX라 매 리렌더 최신 `columns`를 받는다(리사이즈 즉시 반영).
- **좌측 상시 스택**(`app.tsx` 좌측 `Box flexDirection="column"`, 고정폭 34) — **안내카드**(`state.splashDismissed`일 때만, 위) + **사이드바**(`Sidebar.tsx`, 항상, 아래). 카드·사이드바 둘 다 `flexShrink={0}`로 flexGrow 대화 컬럼 옆에서 쪼그라들지 않게 고정.
  - **사이드바**(`Sidebar.tsx`, 0.10.0 A3b 다중탭 스위처) — 고정폭 **34**(`SIDEBAR_COLUMNS`, 안내카드와 동일폭). 등록 repo 목록(opt-in 탭 상태 글리프 ▶⏸●○✖)+하단 마스코트(S2, 이제 스플래시 전체를 통틀어 유일한 마스코트).
  - **안내카드**(`WelcomeCard.tsx`) — 위 "안내카드" 섹션 참조.
- **우측 대화 컬럼**(`flexGrow={1}`) — `Static`(대화 로그, "text"/"segments" 두 종류뿐 — 구 "hero" variant는 SubTask10에서 완전 삭제) 위에, 열려있을 때만 **계측(⌃M)/repos(⌃R)/skills(⌃S) 패널**이 겹쳐 뜬다(동시 노출 없음, model.ts `TOGGLE_PANEL`이 배타적으로 전환). **웰컴 라인**(`WELCOME_LINE`, format.ts — "🐢 무엇이든 입력하세요 — 게이트가 계획 없는 구현을 지켜줍니다.")은 입력창 바로 위, `state.splashDismissed`일 때만.
- **승인 프롬프트**(BLOCK 시)는 입력창 자리를 대체한다 — 패널과도 동시 노출 없음(`APPROVAL_REQUESTED`가 `panel:"none"`으로 강제).
- **statusline 2줄**: 게이트 줄(`formatGateLine` — 🐢 상태·spec/defer 카운트·단축키 힌트) + 시스템 줄(`formatStatusline` — dir·branch·model·usagePct 바·비용).
- **여백**(Ink `margin*` props, `app.tsx`): 헤더 위 2줄(`HERO_TOP_MARGIN`) · 헤더 좌측 여백 3칸(`HERO_LEFT_MARGIN`) · 워드마크↔배지 4칸(`WORDMARK_BADGE_GAP`, `SplashHeader.tsx`) · 웰컴 라인 위/아래 각 1줄.

**폐기(SubTask8~10)**: `SplashHero.tsx`(마스코트+카드+워드마크+웰컴을 대화 스크롤백 Static에 1회 커밋하던 구 컴포넌트) · `selectHeroLayout`/`HeroLayout`(2컬럼 병치 판정) · `SPLASH_HERO_MIN_COLUMNS`(73)/`SPLASH_WIDE_MIN_COLUMNS`(60) · `selectMascot`/`MASCOT_C4`. 마스코트+카드 "2컬럼 병치" 개념 자체가 없어졌다 — 마스코트는 사이드바 하나, 카드는 그 위 상시 스택.

## 외부 '+' 배경 프레임 (0.10.1 신설 — `computeFrameLayout`/`Frame.tsx`)

화면 전체(사이드바+대화 컬럼)를 감싸는 장식 프레임. ink엔 셀 단위 배경 페인팅이 없어 상하 밴드+좌우 거터를 텍스트로 수동 조립한다.

| 토큰 | 값 | 비고 |
|---|---|---|
| 활성 임계 폭 | `80`열 | 미만이면 프레임 전체 생략(부분 렌더 없음) |
| 활성 임계 행 | `30`행 | 미만이면 프레임 전체 생략 |
| 밴드(상/하) | 각 `1`행, `'+'.repeat(columns)` | |
| 거터(좌/우) | 각 `2`열, `'+'.repeat(2)` 세로 반복 | 거터 줄 수는 콘텐츠 실제 렌더 높이(`measureElement`)에 맞춰 동기화 |
| 색상 | `#166534`(PALETTE `D`) | 태그라인과 동일한 deep green — 배경 텍스처로 가라앉아 콘텐츠와 경합하지 않음 |

활성 시 `SplashHeader`(전체폭 기준)·`ReposPanel`(대화 컬럼 기준, `computeContentColumns`로 사이드바 폭 추가 차감)의 가용폭은 `columns`가 아니라 `computeFrameLayout(columns, rows).innerColumns`(= `columns − 거터×2`)를 써야 한다. 스트리밍 프리뷰·승인박스 행 예산(`computePreviewRowBudget`)도 `PREVIEW_RESERVED_ROWS + bandRows×2`로 밴드 2행을 추가 예약한다.

## 알려진 defer

- **컨텍스트 사용량 progress bar(usagePct)** — agent-sdk의 관련 API가 `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`로 명시된 실험적 control-request라 0.9.0에서 배선하지 않음. `formatUsageBar`는 이미 구현돼 있고 `Statusline.usagePct` 기본값 0을 그대로 그린다 — 데이터 소스만 비어있는 상태.
- **"구독 인증 시 비용 숨김"** — ST3에서 제거된 기능(model.ts/engine.ts 어디도 실제로 null을 만들 수 없어 죽은 분기였음). 필요해지면 ST4(bridge.ts)가 auth 신호를 관측해 `Statusline` 타입 자체를 확장하는 설계부터 다시 시작해야 한다.
