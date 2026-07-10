// 0.9.0 A3a ST3 — 마스코트·statusline·게이트줄·경량 마크다운/diff 순수 포맷터.
// Ground Truth: gbc-tui-design.html 시안 A + project_0_9_0_tui_stack_decision.md(C1 확정).
// Ink/React를 import하지 않는다 — 색은 시맨틱 Tone으로만 표현하고, 실제 렌더(ANSI/Ink <Text
// color>)는 소비처(ST5) 책임이다. 단 마스코트는 픽셀아트 특성상 이 파일에서 ANSI 문자열까지 만든다.

import type { TuiState, Statusline } from "./model.js";

// ── 팔레트 & 마스코트 ──

export const PALETTE: Record<string, string> = {
  L: "#86efac", // green-lt
  G: "#4ade80", // green (브랜드 주색)
  M: "#2f9e63", // green-dim
  D: "#166534", // green-deep
  C: "#cbe6a3", // 배(plastron) 크림
  B: "#06281a", // 눈동자
  W: "#eafff3", // 눈 글린트
};

const ANSI16_FG: Record<string, number> = { L: 92, G: 92, M: 32, D: 32, C: 97, B: 30, W: 97 };
const ANSI16_BG: Record<string, number> = { L: 102, G: 102, M: 42, D: 42, C: 107, B: 40, W: 107 };

// C1 "워커" — 측면 보행 자세, 24×10px → 5줄(half-block). 사용자 확정(2026-07-10).
export const MASCOT_C1: readonly string[] = [
  "......LLLLLLLL..........",
  "....LLGGGGGGGGLL........",
  "...LGGGGGGGGGGGGL.......",
  "..LGGLGGGLGGGLGGGL......",
  "..GGGGGGGGGGGGGGGG.MMMM.",
  ".DGGGGGGGGGGGGGGGGDMBWM.",
  ".DDDDDDDDDDDDDDDDDDMMMM.",
  "..CCCCCCCCCCCCCCCC.MMM..",
  "...MMM...MMM...MMM.MM...",
  "...DDD...DDD...DDD......",
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

/** 활성 영역 폭에 따라 스플래시 마스코트를 고른다(<60열 → C4 미니). */
export function selectMascot(terminalWidth: number): readonly string[] {
  return terminalWidth < 60 ? MASCOT_C4 : MASCOT_C1;
}

// ── 시맨틱 톤 & 세그먼트 ──

export type Tone = "plain" | "dim" | "accent" | "warn" | "danger" | "code";

export interface TextSegment {
  text: string;
  tone: Tone;
}

export function joinTextSegments(segments: TextSegment[], sep = " · "): string {
  return segments.map((s) => s.text).join(sep);
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
  return [
    { text: dir, tone: "dim" },
    { text: branch, tone: "dim" },
    { text: data.model, tone: "dim" },
    { text: formatUsageBar(data.usagePct), tone: usageTone },
    { text: `$${data.costUsd.toFixed(2)}`, tone: "dim" },
  ];
}

// ── 게이트 줄 ──

export function formatGateLine(state: TuiState): TextSegment[] {
  if (state.gateStatus === "block" && state.approval) {
    return [
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
  );
  return segments;
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
