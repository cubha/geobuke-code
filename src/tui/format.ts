// 0.9.0 A3a ST3 — 마스코트·statusline·게이트줄·경량 마크다운/diff 순수 포맷터.
// Ground Truth: gbc-tui-design.html 시안 A + project_0_9_0_tui_stack_decision.md(C1 확정).
// Ink/React를 import하지 않는다 — 색은 시맨틱 Tone으로만 표현하고, 실제 렌더(ANSI/Ink <Text
// color>)는 소비처(ST5) 책임이다. 단 마스코트는 픽셀아트 특성상 이 파일에서 ANSI 문자열까지 만든다.

import type { TuiState, Statusline } from "./model.js";

// ── 팔레트 & 마스코트 ──

export const PALETTE: Record<string, string> = {
  L: "#a7f3c9", // green-lt (머리·하이라이트) — GEOBUKE 그라데이션 1단과 동일값
  G: "#4ade80", // green (브랜드 주색) — GEOBUKE 그라데이션 4단과 동일값
  M: "#2f9e63", // green-dim — GEOBUKE 그라데이션 5단과 동일값
  D: "#166534", // green-deep
  C: "#e8f7d8", // 배(plastron) 크림
  B: "#0a1f16", // 눈동자·실루엣 윤곽선
  W: "#ffffff", // 눈 글린트·하이라이트
  P: "#f7b3a1", // 볼터치
  S: "#3fbf7f", // 등껍질 스컷 중간톤(SHELL_BADGE_CIRCLE_RESERVED 전용)
  "2": "#86efac", // GEOBUKE 그라데이션 2단 — SHELL_BADGE 전용
  "3": "#5fe694", // GEOBUKE 그라데이션 3단 — SHELL_BADGE 전용
  "6": "#1c7a48", // GEOBUKE 그라데이션 6단 — SHELL_BADGE 전용
};

const ANSI16_FG: Record<string, number> = {
  L: 92, G: 92, M: 32, D: 32, C: 97, B: 30, W: 97, P: 91, S: 32, "2": 92, "3": 92, "6": 32,
};
const ANSI16_BG: Record<string, number> = {
  L: 102, G: 102, M: 42, D: 42, C: 107, B: 40, W: 107, P: 101, S: 42, "2": 102, "3": 102, "6": 42,
};

// S3 "카와이" — 측면 보행 자세, 30×16px → 8줄(half-block). 구 S2는 머리(눈/입)가 몸통 실루엣
// 밖으로 튀어나오지 않아 "다리 달린 초록 언덕"처럼 보이는 결함이 있었다(사용자 실사용 지적,
// 2026-07-14). 원/타원 래스터화 + 실루엣 전체 윤곽선(B) 기법으로 재설계 — 큰 머리가 목으로
// 몸통 밖까지 확실히 이어지고, 눈 하이라이트·볼터치로 표정을 준다. 사용자 승인 시안 기반.
// 눈 크기는 캔버스 대비 비례축소가 아니라 승인 시안(46×26px)과 동일한 절대 반경(1.6×1.7)을
// 그대로 써서, 캔버스가 작아져도 눈·하이라이트가 뭉개지지 않게 한다(비례축소판은 사용자가
// "예시와 너무 다르다"고 재지적, 2026-07-14 2차 후속 — 저해상도 카와이 픽셀아트는 눈만큼은
// 비선형으로 크게 유지해야 표정이 읽힌다).
export const MASCOT_S2: readonly string[] = [
  "....................BBBBBB....",
  "...................BLLLLLLB...",
  "......BBBBBBBBB...BLLLLLLLLB..",
  "....BBDGSSDSGGDBBBLLLLLLLLLLB.",
  "...BSLLLLLGGSSSSGBLLBBWLBWLLB.",
  "..BGLLLLLLDGSSDSGGLLBBBLBBBLLB",
  ".BDDLLLLLLDDSDDDGDDLBBBLBBBLLB",
  "BBDGSSLLLGDGSSDSGGDLLPLLLLLLLB",
  "MMSSGGGGSSSSGGGGSSSLPPDLLDLLB.",
  "MMDSGGDGSSDSGGDGSSDLLLLDDLLLB.",
  "BBBDGDDDSDDDGDDDSDCLLLLLLLLB..",
  "..BMGGDGSSDSGGDGSCCCLLLLLLB...",
  "..BMMMSSGGGGSSCCCCCCCCMBBB....",
  "..BMMMMBMMCCCCCCCCCMMMMB......",
  "...BMMB.BMMBBBBMBBBBMMB.......",
  "....BB...BB....B....BB........",
];

// C4 미니 — <60열 폴백, 12×6px → 3줄.
export const MASCOT_C4: readonly string[] = [
  "..LLLLLL....",
  ".LGGGGGGL.MM",
  ".GGLGGLGG.MB",
  "DDDDDDDDDDMM",
  ".CCCCCCCC...",
  "..MM..MM....",
];

// 등껍질 배지 — 워드마크 우측 장식(≥96열 2컬럼 레이아웃 한정), 9×6, GEOBUKE 워드마크의 실제
// 'O' 글리프(WORDMARK_GEOBUKE 17~25열)에서 파생 — 사용자가 "박스드로잉선을 문자열 아스키
// 박스드로잉과 동일 색상/디자인으로" 요청(2026-07-14 7차 후속). 원본 O자는 속이 빈 고리
// 모양인데, 내부(고리 구멍 + 구멍 가장자리의 가는 박스드로잉 ╔═══·║)를 여백 없이 전부 █로
// 채운 뒤, 거북 등껍질 솔기 무늬로 **X자 이음매의 이중선 코너 4개**(위 ╝╚ + 아래 ╗╔, 중앙은
// █ 채움)를 넣었다(사용자 최종 선택 2026-07-15 — 단선 대각(╲╱│)판·중앙 세로줄기(║)판을
// 실크기 비교 후 "가운데 메꾼" 이 버전으로 확정). 솔기 문자는 별도 색 없이 아스키 외곽
// 그림자(╗║╚═╝)와 완전히 동일한 취급 — 해당 행의 그라데이션 색 그대로, 배경 미채움(가는
// 이중선+검은 틈) — 이라 워드마크 글자 사이 이음매와 같은 재질로 읽힌다.
export const SHELL_BADGE_GLYPH: readonly string[] = [
  " ██████╗ ",
  "███╝█╚██╗",
  "████████║",
  "███╗█╔██║",
  "╚██████╔╝",
  " ╚═════╝ ",
];

// 등껍질 배지 — 그라데이션 원형판(half-block, 14×12px → 6줄, 완전 원형). SHELL_BADGE를 워드마크
// O자 재사용판으로 교체하며 사용자 요청대로 보존(2026-07-14 7차 후속, "나중에 재사용할 수 있으니").
// 재사용 시 renderMascot(SHELL_BADGE_GRADIENT_RESERVED)로 그대로 렌더 가능.
export const SHELL_BADGE_GRADIENT_RESERVED: readonly string[] = [
  "..............",
  "....LLLLLL....",
  "...22222222...",
  "..2WWW222233..",
  ".33WWW3333GGG.",
  ".3333333333GG.",
  ".GGGGGGGGGGMM.",
  ".GGMGGGGGGMMM.",
  "..666MMMM666..",
  "...66666666...",
  "....666666....",
  "..............",
];

// 등껍질 배지 구버전(다색 스컷격자, 완전 원형 24×24px → 12줄) — 현재 어떤 레이아웃에도 배선되지
// 않은 보존용 상수. SHELL_BADGE를 그라데이션판으로 교체하며 사용자가 "나중에 재사용할 수 있으니"
// 폐기 대신 보관을 요청(2026-07-14 3차 후속). 재사용 시 이 배열을 그대로 renderMascot에 넘기면 됨.
export const SHELL_BADGE_CIRCLE_RESERVED: readonly string[] = [
  ".........BBBBBB.........",
  "......BBBGGGSSSBBB......",
  ".....BGGGDGGSSSDSSB.....",
  "....BSGGDDDGSSDDDSGB....",
  "...BSSGGGDGGSSSDSSGGB...",
  "..BSSLLLLLLGSSSSSSGGGB..",
  ".BGGLLLLLLLLGGGGGGSSSSB.",
  ".BGGLLLLLLLLGGGGGGSSSSB.",
  ".BGDLLLLLLLLLGGDGGSSSDB.",
  "BGDDLLLLLLLLGGDDDGSSDDDB",
  "BGGDGLLLLLLSGGGDGGSSSDSB",
  "BGGGGGSLLLSSGGGGGGSSSSSB",
  "BSSSSSGGGGGGSSSSSSGGGGGB",
  "BSSSSSGGGGGGSSSSSSGGGGGB",
  "BSSDSSGGGDGGSSSDSSGGGDGB",
  ".BDDDSGGDDDGSSDDDSGGDDB.",
  ".BSDSSGGGDGGSSSDSSGGGDB.",
  ".BSSSSGGGGGGSSSSSSGGGGB.",
  "..BGGGSSSSSSGGGGGGSSSB..",
  "...BGGSSSSSSGGGGGGSSB...",
  "....BGSSSDSSGGGDGGSB....",
  ".....BSSDDDSGGDDDGB.....",
  "......BBBDSSGGGBBB......",
  ".........BBBBBB.........",
];

export type MascotColorMode = "truecolor" | "ansi16";

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function fgCode(mode: MascotColorMode, key: string): string {
  if (mode === "truecolor") {
    const [r, g, b] = hexToRgb(PALETTE[key]);
    return `\x1b[38;2;${r};${g};${b}m`;
  }
  return `\x1b[${ANSI16_FG[key]}m`;
}

function bgCode(mode: MascotColorMode, key: string): string {
  if (mode === "truecolor") {
    const [r, g, b] = hexToRgb(PALETTE[key]);
    return `\x1b[48;2;${r};${g};${b}m`;
  }
  return `\x1b[${ANSI16_BG[key]}m`;
}

/** half-block(▀▄) 렌더 — 셀 상단=fg, 하단=bg. 트루컬러 기본, conhost급 제약은 ansi16 폴백. */
export function renderMascot(matrix: readonly string[], mode: MascotColorMode = "truecolor"): string[] {
  const out: string[] = [];
  for (let y = 0; y < matrix.length; y += 2) {
    const top = matrix[y];
    const bot = matrix[y + 1] ?? ".".repeat(top.length);
    let line = "";
    for (let x = 0; x < top.length; x++) {
      const t = top[x];
      const b = bot[x];
      if (t === "." && b === ".") {
        line += "\x1b[0m ";
      } else if (t !== "." && b !== ".") {
        line += `${fgCode(mode, t)}${bgCode(mode, b)}▀`;
      } else if (t !== ".") {
        line += `\x1b[0m${fgCode(mode, t)}▀`;
      } else {
        line += `\x1b[0m${fgCode(mode, b)}▄`;
      }
    }
    out.push(line + "\x1b[0m");
  }
  return out;
}

/**
 * 스플래시 구성요소(마스코트·워드마크)의 "넓은 레이아웃" 임계값 — 단일 소스. app.tsx의 워드마크
 * 표시 조건이 예전엔 `WORDMARK_GEOBUKE[0].length`(59)를 따로 써서 이 상수(60)와 1칸 어긋나
 * "59열=풀 워드마크+미니 마스코트"라는 의도치 않은 조합이 났었다(scope-critic 발견,
 * 2026-07-13 ST13-14 판정 DECISION_CHANGED:yes) — 두 소비처가 이 상수 하나만 참조하도록 통일.
 */
export const SPLASH_WIDE_MIN_COLUMNS = 60;

/** 활성 영역 폭에 따라 스플래시 마스코트를 고른다(<60열 → C4 미니). */
export function selectMascot(terminalWidth: number): readonly string[] {
  return terminalWidth < SPLASH_WIDE_MIN_COLUMNS ? MASCOT_C4 : MASCOT_S2;
}

/**
 * 워드마크+마스코트/카드 2컬럼 병치 레이아웃의 "히어로" 임계값(0.9.3 D1) — SPLASH_WIDE_MIN_COLUMNS
 * (마스코트 S2/C4 선택, 60열)와 *의도적으로 분리*한다. 최종 확정 시안(아티팩트 cb7c6b1c 장면01)의
 * 3단 반응형: <60열=마스코트 C4 미니+카드 세로스택, 60~95열=마스코트 S2+카드 세로스택(워드마크 생략),
 * ≥96열=워드마크+마스코트·카드 2컬럼 병치. 단일 임계값을 공유하면 이 중간 단계가 사라진다.
 *
 * 값 근거(2컬럼 폭 예산): HERO_LEFT_MARGIN(3) + 마스코트폭(S2 30) + MASCOT_CARD_GAP(6) +
 * CARD_WIDTH(54) = 93칸. 카와이 S2(30×16px, 구 24×10px보다 확대)로 교체하며 84→96으로 상향해
 * 예산을 실제로 커버하도록 재계산했다(구 84는 구버전 25폭 기준 88칸 요구보다도 작아 여유가 없었음).
 */
export const SPLASH_HERO_MIN_COLUMNS = 96;

// ── 시맨틱 톤 & 세그먼트 ──

export type Tone = "plain" | "dim" | "accent" | "warn" | "danger" | "code";

export interface TextSegment {
  text: string;
  tone: Tone;
}

export function joinTextSegments(segments: TextSegment[], sep = " · "): string {
  return segments.map((s) => s.text).join(sep);
}

// ── 워드마크 + 안내카드 (0.9.2 ST13) ──
// figlet "ANSI Shadow" 폰트로 생성한 정적 문자열을 그대로 임베드한다(zero-dep 원칙 — 런타임에
// figlet을 설치·실행하지 않는다. 빌드타임에 한 번 생성한 상수).
export const WORDMARK_GEOBUKE: readonly string[] = [
  " ██████╗ ███████╗ ██████╗ ██████╗ ██╗   ██╗██╗  ██╗███████╗",
  "██╔════╝ ██╔════╝██╔═══██╗██╔══██╗██║   ██║██║ ██╔╝██╔════╝",
  "██║  ███╗█████╗  ██║   ██║██████╔╝██║   ██║█████╔╝ █████╗  ",
  "██║   ██║██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔═██╗ ██╔══╝  ",
  "╚██████╔╝███████╗╚██████╔╝██████╔╝╚██████╔╝██║  ██╗███████╗",
  " ╚═════╝ ╚══════╝ ╚═════╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚══════╝",
];

/**
 * 워드마크 행별 그린 그라데이션(0.9.3 D1) — 승인 시안(아티팩트 cb7c6b1c 장면01) 사양.
 * 기존 구현은 WORDMARK_GEOBUKE 6행 전부를 단일 tone:"accent"로 렌더해 단색이었다(구현 갭 —
 * 사용자 실사용 지적, 2026-07-14). renderMascot과 동일 기법(사전 컬러링 ANSI 문자열)을 쓴다 —
 * Ink의 <Text color>는 한 Text당 단일 색이라 행별 다른 색은 원문에 이스케이프를 직접 심어야 한다.
 * ansi16 폴백은 상3행/하3행 2단 근사(트루컬러 6단 그라데이션을 16색 팔레트로 표현할 수 없음).
 */
const WORDMARK_GRADIENT_HEX: readonly string[] = ["a7f3c9", "86efac", "5fe694", "4ade80", "2f9e63", "1c7a48"];
const WORDMARK_ANSI16: readonly number[] = [92, 92, 92, 32, 32, 32];

/** 행별로 WORDMARK_GRADIENT_HEX 단색을 입히는 공용 렌더러 — 워드마크와 등껍질 배지가 공유한다. */
function renderGradientGlyph(lines: readonly string[], mode: MascotColorMode): string[] {
  return lines.map((line, i) => {
    if (mode === "truecolor") {
      const [r, g, b] = hexToRgb(`#${WORDMARK_GRADIENT_HEX[i]}`);
      return `\x1b[38;2;${r};${g};${b}m${line}\x1b[0m`;
    }
    return `\x1b[${WORDMARK_ANSI16[i]}m${line}\x1b[0m`;
  });
}

export function renderWordmark(mode: MascotColorMode = "truecolor"): string[] {
  return renderGradientGlyph(WORDMARK_GEOBUKE, mode);
}

/**
 * 등껍질 배지 렌더 — SHELL_BADGE_GLYPH(워드마크 O자 재사용)에 워드마크와 동일한 행별
 * 그라데이션을 입힌다. X자 솔기 문자(╲╱│)도 별도 색 없이 그 행의 색 그대로 — 아스키 외곽
 * 그림자(╗║╚═╝)와 같은 취급이라 워드마크와 완전히 같은 재질로 읽힌다.
 */
export function renderShellBadge(mode: MascotColorMode = "truecolor"): string[] {
  return renderGradientGlyph(SHELL_BADGE_GLYPH, mode);
}

/** 워드마크 아래 태그라인 — 버전은 호출부(package.json)가 넘긴다(하드코딩 drift 금지). */
export function formatTagline(version: string): string {
  return `거북이코드 v${version} · 계획↔구현↔검증 게이트`;
}

/** 스플래시 웰컴 라인 — 카드 아래, 입력창 위. "무엇을 입력하면 되는지"를 1줄로 안내(구현 갭 복원). */
export const WELCOME_LINE = "🐢 무엇이든 입력하세요 — 게이트가 계획 없는 구현을 지켜줍니다.";

/** 안내카드의 "기본 스킬" 섹션 한 항목(스플래시 전용 짧은 blurb — SKILL.md 전체 description은
 * 54칸 카드 폭에 안 맞아 별도 큐레이션 필요, ⌃S 패널의 SkillInfo.description과는 다른 텍스트). */
export interface CardSkill {
  name: string;
  blurb: string;
}

/**
 * 스플래시 안내카드(app.tsx가 마스코트와 병치 조립) — 게이트 요약·기본 스킬 3종·키맵 3섹션.
 * 0.9.3 D1: 시안 확정(아티팩트 cb7c6b1c 장면01) 대비 "기본 스킬" 섹션 전체와 "shift+↵ 개행" 키맵
 * 안내가 기존 구현엔 없었다(콘텐츠 누락 — 압축이 아니라 갭). 카드 테두리(┌─│└)는 이 함수가 만들지
 * 않는다 — Ink Box borderStyle이 CJK 폭을 정확히 계산해 그리므로 렌더 컴포넌트(WelcomeCard.tsx)
 * 소관, 이 함수는 데이터(TextSegment[][])만 순수 생성한다(format.ts의 Ink-free 원칙 유지).
 */
export function formatWelcomeCard(specCount: number, deferCount: number, skills: CardSkill[]): TextSegment[][] {
  const rows: TextSegment[][] = [
    [{ text: "🐢 게이트 활성 — 명세 없는 구현은 차단됩니다", tone: "accent" }],
    [
      { text: `spec ${specCount}케이스`, tone: "dim" },
      { text: `defer ${deferCount}`, tone: "dim" },
    ],
    [{ text: "🧩 기본 스킬", tone: "accent" }],
  ];
  for (const s of skills) {
    rows.push([
      { text: `/${s.name}`, tone: "accent" },
      { text: s.blurb, tone: "dim" },
    ]);
  }
  rows.push(
    [
      { text: "⌃M 메트릭", tone: "dim" },
      { text: "⌃R repos", tone: "dim" },
      { text: "⌃S skills", tone: "dim" },
    ],
    [
      { text: "shift+↵ 개행", tone: "dim" },
      { text: "esc 중단", tone: "dim" },
      { text: "⌃C 종료(2회)", tone: "dim" },
    ],
  );
  return rows;
}

// ── 스피너 (0.9.2 ST7 — 스트리밍 중 로딩 인디케이터) ──
// tick·elapsedMs는 호출부(app.tsx setInterval)가 계산해 넘긴다 — 이 파일은 순수부라 Date.now()를
// 직접 쓰지 않는다(다른 포맷터와 동일 원칙).

export const SPINNER_FRAMES: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function formatSpinnerLine(tick: number, elapsedMs: number): string {
  const frame = SPINNER_FRAMES[tick % SPINNER_FRAMES.length];
  const elapsedS = Math.floor(elapsedMs / 1000);
  return `${frame} 생각 중… ${elapsedS}s`;
}

// ── statusline (시스템 줄) ──
// model.ts의 Statusline을 그대로 재사용한다(별도 DTO를 두면 계약이 두 곳에서 각자 드리프트함 —
// ST3 자체검토에서 costUsd:number|null 독자 정의가 model.ts/engine.ts 어디서도 만들 수 없는
// 죽은 분기였음을 확인, 제거). "구독 인증 시 비용 숨김"은 그 신호(auth 방식)를 관측하는 ST4가
// 설계할 몫이며, 이 파일은 model.ts가 정의한 costUsd:number를 있는 그대로 표시한다.

/** 폭 초과 시 '…/마지막세그먼트'로 축약. */
export function abbreviateDir(dir: string, maxWidth: number): string {
  if (dir.length <= maxWidth) return dir;
  const parts = dir.split("/");
  const tail = parts[parts.length - 1];
  const abbreviated = `…/${tail}`;
  if (abbreviated.length <= maxWidth) return abbreviated;
  return `…/${tail.slice(-(Math.max(1, maxWidth - 2)))}`;
}

export function formatUsageBar(pct: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const bar = "▰".repeat(filled) + "▱".repeat(width - filled);
  return `${bar} ${Math.round(clamped)}%`;
}

export function formatStatusline(data: Statusline, opts?: { dirWidth?: number }): TextSegment[] {
  const dir = abbreviateDir(data.dir, opts?.dirWidth ?? 40);
  const branch = data.branch + (data.dirty ? "*" : "");
  const usageTone: Tone = data.usagePct >= 80 ? "warn" : "accent";
  const segments: TextSegment[] = [
    { text: dir, tone: "dim" },
    { text: branch, tone: "dim" },
    { text: data.model, tone: "dim" },
    { text: formatUsageBar(data.usagePct), tone: usageTone },
    { text: `$${data.costUsd.toFixed(2)}`, tone: "dim" },
  ];
  // ST15(0.9.2) — 마지막 턴 소요시간. 0/미지정(아직 턴 없음)이면 의미 없는 "0.0s"를 상시 노출하지
  // 않는다(스피너의 진행중 경과와 달리 이건 "지난 턴 결과"라 없을 수 있는 값).
  if (data.lastTurnMs > 0) {
    segments.push({ text: `${(data.lastTurnMs / 1000).toFixed(1)}s`, tone: "dim" });
  }
  // ST7(0.9.4 T1) — 첫 토큰까지 걸린 시간. lastTurnMs(턴 전체 소요)와 형식이 같아 접두어로 구분한다.
  if (data.lastTtftMs > 0) {
    segments.push({ text: `ttft ${(data.lastTtftMs / 1000).toFixed(1)}s`, tone: "dim" });
  }
  return segments;
}

// ── 게이트 줄 ──

export function formatGateLine(state: TuiState): TextSegment[] {
  // exitConfirmArmed(0.9.2 ST10)는 gateStatus/승인 상태와 무관하게 최우선 노출한다 — pushLine
  // 스크롤백은 후속 출력에 밀려나 사라지므로, 상시 노출 채널인 이 줄이 armed 여부의 유일하게
  // 신뢰 가능한 표시처다(scope-critic 발견, 2026-07-13 ST7-10 판정 DECISION_CHANGED:yes).
  const armedSeg: TextSegment[] = state.exitConfirmArmed ? [{ text: "⌃C 한 번 더=종료", tone: "warn" }] : [];

  if (state.gateStatus === "block" && state.approval) {
    return [
      ...armedSeg,
      { text: "🐢 BLOCK", tone: "danger" },
      { text: "승인 대기 중 — 엔진 일시정지 (canUseTool)", tone: "dim" },
    ];
  }

  const gateSeg: TextSegment =
    state.gateStatus === "pass" ? { text: "🐢 pass", tone: "accent" } : { text: "🐢 gated ✓", tone: "accent" };

  const segments: TextSegment[] = [
    gateSeg,
    { text: `spec ${state.specCount}케이스`, tone: "dim" },
    { text: `defer ${state.deferCount}`, tone: "dim" },
  ];
  if (state.streaming) segments.push({ text: "esc 중단", tone: "dim" });
  segments.push(
    { text: state.panel === "metrics" ? "⌃M 닫기" : "⌃M 메트릭", tone: "dim" },
    { text: state.panel === "repos" ? "⌃R 닫기" : "⌃R repos", tone: "dim" },
    { text: state.panel === "skills" ? "⌃S 닫기" : "⌃S skills", tone: "dim" },
  );
  return [...armedSeg, ...segments];
}

// ── 경량 마크다운/diff (ink-markdown 3년 방치 — 최소 자체구현) ──

const FENCE_RE = /^```(\w*)/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const DIFF_ADD_RE = /^\+(?!\+\+)/;
const DIFF_DEL_RE = /^-(?!--)/;

/**
 * 줄 단위 최소 파서: 헤딩·코드펜스만 항상 인식. diff +/- 강조는 ```diff 펜스 안에서만
 * 적용한다 — 펜스 밖 bare +/-는 대부분 마크다운 불릿리스트("- 항목")나 일반 문장이라
 * diff로 오판하면 오탐이 난다(ST3 자체검토에서 실측). 인라인 강조(bold 등)는 처리 안 함.
 */
export function formatMarkdownLite(input: string): TextSegment[] {
  const lines = input.split("\n");
  const out: TextSegment[] = [];
  let fenceLang: string | null = null;

  for (const line of lines) {
    const fence = line.match(FENCE_RE);
    if (fence) {
      fenceLang = fenceLang === null ? fence[1].toLowerCase() : null;
      out.push({ text: line, tone: "dim" });
      continue;
    }
    if (fenceLang === "diff") {
      if (DIFF_ADD_RE.test(line)) {
        out.push({ text: line, tone: "accent" });
      } else if (DIFF_DEL_RE.test(line)) {
        out.push({ text: line, tone: "danger" });
      } else {
        out.push({ text: line, tone: "code" });
      }
      continue;
    }
    if (fenceLang !== null) {
      out.push({ text: line, tone: "code" });
      continue;
    }
    const heading = line.match(HEADING_RE);
    if (heading) {
      out.push({ text: heading[2], tone: "accent" });
      continue;
    }
    out.push({ text: line, tone: "plain" });
  }
  return out;
}
