// !bash — TUI 입력창에서 사람이 직접 셸 명령을 실행하는 경로(0.12.3 Task C, 2026-08-03 제품결정
// 확정). 모델이 호출하는 도구 경로가 아니라 사람이 직접 타이핑하는 입력이라 evaluateGate(judge
// 판정)를 전혀 경유하지 않는다 — 게이트 thesis와 무충돌(사람 직접입력은 애초 게이트 범위 밖).
//
// argv 배열 spawn 필수(셸 문자열 통짜 실행 금지) — scope.ts realGrep·install.ts buildPreCommand와
// 동일 안전기준. 셸이 없으므로 파이프·리다이렉트·변수확장은 지원하지 않는다(따옴표는 공백 포함
// 인자를 묶는 용도일 뿐).
import { spawn as nodeSpawn } from "node:child_process";

// ===== 파서(순수) =====

export type BangParse =
  | { kind: "not-bang" }
  | { kind: "empty" }
  | { kind: "error"; reason: string }
  | { kind: "command"; cmd: string; args: string[] };

/**
 * 텍스트를 토큰 배열로 분리한다(순수, 셸 없음). 공백 분리 + '…'/"…" 리터럴(둘 다 안에서 변수확장
 * 없음, 셸이 없으므로) + 백슬래시 이스케이프(다음 한 글자를 리터럴로). 따옴표가 안 닫히면 null —
 * 조용히 봉합하지 않는다(사용자가 의도한 인자 경계와 다르게 실행되는 것이 더 나쁘다).
 */
function tokenize(s: string): string[] | null {
  const tokens: string[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        i++;
        continue;
      }
      if (ch === "\\" && i + 1 < s.length) {
        cur += s[i + 1];
        i += 2;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < s.length) {
      cur += s[i + 1];
      has = true;
      i += 2;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has) {
        tokens.push(cur);
        cur = "";
        has = false;
      }
      i++;
      continue;
    }
    cur += ch;
    has = true;
    i++;
  }
  if (quote) return null; // 미종결 따옴표
  if (has) tokens.push(cur);
  return tokens;
}

/** '!'로 시작하는 텍스트를 셸 명령으로 파싱한다(순수). '!' 아니면 not-bang(기존 프롬프트 경로). */
export function parseBangInput(text: string): BangParse {
  if (!text.startsWith("!")) return { kind: "not-bang" };
  const rest = text.slice(1);
  if (rest.includes("\n")) return { kind: "error", reason: "여러 줄 명령은 지원하지 않습니다." };
  if (rest.trim() === "") return { kind: "empty" };
  const tokens = tokenize(rest);
  if (tokens === null) return { kind: "error", reason: "따옴표가 닫히지 않았습니다." };
  if (tokens.length === 0) return { kind: "empty" };
  const [cmd, ...args] = tokens;
  return { kind: "command", cmd, args };
}

// ===== 러너(I/O, 주입 seam) =====

/** 명령 실행 상한(ms) — 무응답 프로세스가 TUI를 무기한 막지 않게. */
export const BANG_TIMEOUT_MS = 30_000;

/** 누적 출력 상한(바이트) — 대용량 스트림(예: `yes`)이 메모리를 무한정 먹지 않게. */
export const BANG_MAX_OUTPUT = 64 * 1024;

export interface BangResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  /** spawn 자체 실패(ENOENT 등) — throw 대신 값으로 반환해 TUI를 죽이지 않는다. */
  spawnError?: string;
}

/**
 * argv 배열로 spawn 실행(shell:false — 사용자 확정 안전기준). stdin은 "ignore" — 대화형 명령
 * (`!vim`·`!git commit` 등 에디터 대기)이 타임아웃까지 매달리는 것을 막는다. 절대 throw하지
 * 않는다(spawnFn 주입 seam은 judge.ts runClaudeCli의 관례와 동형).
 */
export function runBangCommand(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number; maxBytes?: number; spawnFn?: typeof nodeSpawn },
): Promise<BangResult> {
  const timeoutMs = opts.timeoutMs ?? BANG_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? BANG_MAX_OUTPUT;
  const spawnImpl = opts.spawnFn ?? nodeSpawn;
  return new Promise<BangResult>((resolve) => {
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = spawnImpl(cmd, args, { cwd: opts.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, truncated: false, spawnError: String(e) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let truncated = false;
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      finish(() => resolve({ code: null, stdout, stderr, timedOut, truncated, spawnError: undefined }));
    }, timeoutMs);
    // 예산 초과 시 즉시 resolve — "close"를 기다리지 않는다(0.12.3 초기구현 버그: kill() 호출 후
    // close 이벤트를 기다리면, 죽여도 즉시 종료를 보장 못 하는 프로세스에서 BANG_TIMEOUT_MS 전체를
    // 대기하게 된다. timeout 분기와 동일하게 kill 즉시 확정한다).
    const overBudget = (): boolean => stdout.length + stderr.length > maxBytes;
    child.stdout?.on("data", (d) => {
      if (done) return;
      stdout += String(d);
      if (overBudget()) {
        truncated = true;
        child.kill();
        finish(() => resolve({ code: null, stdout, stderr, timedOut, truncated }));
      }
    });
    child.stderr?.on("data", (d) => {
      if (done) return;
      stderr += String(d);
      if (overBudget()) {
        truncated = true;
        child.kill();
        finish(() => resolve({ code: null, stdout, stderr, timedOut, truncated }));
      }
    });
    child.on("error", (e) => {
      finish(() => resolve({ code: null, stdout, stderr, timedOut, truncated, spawnError: String(e) }));
    });
    child.on("close", (code) => {
      finish(() => resolve({ code, stdout, stderr, timedOut, truncated }));
    });
  });
}

// ===== 포맷터(순수) =====

/** ANSI CSI 이스케이프 + C0 제어문자(개행 제외) + CR 스트립 — ink 스크롤백에 원시 이스케이프가 그대로 들어가면 렌더가 깨진다. */
function stripAnsiAndControl(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\r/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

/** 줄 수 상한(초과 시 head+tail만 남기고 중간 생략). */
const DEFAULT_MAX_LINES = 200;

/**
 * BangResult를 스크롤백에 push할 라인 배열로 조립한다(순수). ANSI/제어문자 스트립 + 줄수 캡
 * (head+tail) + 종료코드/timeout/truncated/spawnError 고지. 정상 종료(0)는 종료코드를 고지하지
 * 않는다(잡음 최소화 — 실패했을 때만 신호).
 */
export function formatBangOutput(result: BangResult, opts: { maxLines?: number } = {}): string[] {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const lines: string[] = [];
  if (result.spawnError) {
    lines.push(`⚠ 실행 실패: ${result.spawnError}`);
    return lines;
  }
  const combined = stripAnsiAndControl(result.stdout + result.stderr);
  const outLines = combined.split("\n").filter((_, i, arr) => !(i === arr.length - 1 && arr[i] === ""));
  if (outLines.length <= maxLines) {
    lines.push(...outLines);
  } else {
    const headCount = Math.ceil(maxLines / 2);
    const tailCount = maxLines - headCount;
    lines.push(...outLines.slice(0, headCount));
    lines.push(`…(${outLines.length - maxLines}줄 생략)`);
    lines.push(...outLines.slice(outLines.length - tailCount));
  }
  if (result.timedOut) lines.push(`⚠ 타임아웃(${BANG_TIMEOUT_MS}ms) — 프로세스를 종료했습니다.`);
  if (result.truncated) lines.push(`⚠ 출력이 상한(${BANG_MAX_OUTPUT}B)을 넘어 일부 생략·절단됐습니다.`);
  if (result.code !== 0 && !result.timedOut) lines.push(`⚠ 종료코드 ${result.code}`);
  return lines;
}
