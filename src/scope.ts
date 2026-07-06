// scope 판정 큐 + grep 결과 파싱 (축A 파급반경 + 축B Ponytail 사다리, 0.5.2).
// PreToolUse가 pass한 동작편집을 여기 큐잉 → Stop 훅이 grep 컨텍스트를 채워 배치 판정한다.
// 이 파일은 순수 로직·파일 IO만 담당(모델 호출 없음 — 그건 judge.ts judgeScope).
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { gbcDir, readJsonArray, writeJson } from "./store.js";
import type { ScopeQueueEntry, ScopeVerdict } from "./types.js";

const execFileAsync = promisify(execFile);

/** 큐 최대 엔트리 수(한 턴에 판정 대상 상한 — 초과 시 최신 유지). */
export const MAX_SCOPE_QUEUE = 20;
/** grep 매치 최대 수(프롬프트 비대 방지). */
export const MAX_GREP_MATCHES = 40;
/** grep 매치 한 줄 텍스트 최대 길이. */
export const MAX_GREP_LINE_LEN = 200;
/** grep 컨텍스트 총 문자 상한(프롬프트 예산 보호). */
export const MAX_SCOPE_CONTEXT_CHARS = 4000;

/** scope 판정 대기 큐 파일 경로 (.gbc/scope-queue.json). */
export function scopeQueuePath(cwd: string): string {
  return join(gbcDir(cwd), "scope-queue.json");
}

/**
 * 편집을 scope 큐에 append. MAX_SCOPE_QUEUE 초과 시 *최신* N개만 유지한다(오래된 것 드롭) —
 * 한 턴에 폭주하는 편집이 큐를 무한히 부풀리는 것을 막되, 방금 한 작업을 우선 판정.
 */
export function enqueueScope(cwd: string, entry: ScopeQueueEntry): void {
  const q = readScopeQueue(cwd);
  q.push(entry);
  const capped = q.length > MAX_SCOPE_QUEUE ? q.slice(q.length - MAX_SCOPE_QUEUE) : q;
  writeJson(scopeQueuePath(cwd), capped);
}

/** 큐 읽기(부재/파손/비배열 시 빈 배열) — 형상 가드는 store.ts readJsonArray로 통일(0.6.1 R3). */
export function readScopeQueue(cwd: string): ScopeQueueEntry[] {
  return readJsonArray<ScopeQueueEntry>(scopeQueuePath(cwd));
}

/** 큐 비우기(Stop 훅이 판정 후 호출 — 그 턴 판정분 회수). */
export function clearScopeQueue(cwd: string): void {
  writeJson(scopeQueuePath(cwd), []);
}

/**
 * judgeScope 판정 결과에 큐잉 시점 specHash를 보강한다(순수, file 매칭 — 같은 파일 다건이면 최신 우선).
 * judgeScope는 계측을 모른 채 유지하고, 조인키 충전은 이 seam에서만 일어난다(0.5.4, A2 사후대조 선행).
 * 큐에 없는 파일은 빈값("") — 현재 작업단위로 거짓 상관시키지 않는다.
 */
export function enrichVerdictsWithSpecHash(
  verdicts: ScopeVerdict[],
  queue: ScopeQueueEntry[],
): ScopeVerdict[] {
  const hashByFile = new Map<string, string>();
  for (const q of queue) hashByFile.set(q.file, q.specHash);
  return verdicts.map((v) => ({ ...v, specHash: hashByFile.get(v.file) ?? "" }));
}

/** grep 한 매치(file:line:content 파싱 결과). */
export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

/** grep 출력 파싱 결과 — matches 캡·truncated 표시. */
export interface GrepParse {
  matches: GrepMatch[];
  truncated: boolean;
}

/** `path:lineno:content` 한 줄을 파싱(선두 file은 콜론 포함 경로 대비 lineno 앵커로 분리). */
function parseGrepLine(line: string): GrepMatch | null {
  // file 경로에 콜론이 있을 수 있으므로 "숫자 라인번호"를 앵커로 뒤에서 찾는다: (.+):(\d+):(.*)
  const m = line.match(/^(.+?):(\d+):(.*)$/);
  if (!m) return null;
  const [, file, lineStr, rest] = m;
  const n = Number.parseInt(lineStr, 10);
  if (!Number.isFinite(n)) return null;
  let text = rest.trim();
  if (text.length > MAX_GREP_LINE_LEN) text = text.slice(0, MAX_GREP_LINE_LEN);
  return { file, line: n, text };
}

/**
 * grep 원시 출력(`file:line:content` 줄들)을 구조화. 깨진/빈 줄 skip, MAX_GREP_MATCHES로 캡하고
 * 초과분이 있으면 truncated=true. 빈 matches는 하드가드(탐색 결과 없음→미평가) 신호가 된다.
 */
export function parseGrepOutput(raw: string): GrepParse {
  const matches: GrepMatch[] = [];
  let truncated = false;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseGrepLine(line);
    if (!parsed) continue;
    if (matches.length >= MAX_GREP_MATCHES) {
      truncated = true;
      break;
    }
    matches.push(parsed);
  }
  return { matches, truncated };
}

/**
 * 매치들을 프롬프트용 컨텍스트 블록으로 포맷. 총 길이를 MAX_SCOPE_CONTEXT_CHARS로 바운드하고,
 * 예산을 넘기면 앞쪽 매치까지만 담는다(뒤는 버림 — grep 순서상 대개 근접 파일이 앞).
 */
export function formatGrepContext(matches: GrepMatch[]): string {
  if (matches.length === 0) return "";
  const lines: string[] = [];
  let total = 0;
  for (const m of matches) {
    const l = `${m.file}:${m.line}: ${m.text}`;
    if (total + l.length + 1 > MAX_SCOPE_CONTEXT_CHARS) break;
    lines.push(l);
    total += l.length + 1;
  }
  return lines.join("\n");
}

// ===== 실제 grep 실행 (SubTask 4, 비결정 I/O) =====

/** 심볼당 grep 호출 총 상한(Stop 지연 보호 — 배치 편집이 많아도 이 수만큼만 grep). */
export const MAX_GREP_SYMBOLS = 8;
/** grep 총 타임아웃(ms) — Stop 훅 내부 예산. 초과 시 그때까지 모은 것만 사용. */
export const GREP_TIMEOUT_MS = 4000;

const IDENT_KEYWORDS = new Set([
  "function", "const", "let", "var", "class", "interface", "type", "return", "export",
  "import", "async", "await", "true", "false", "null", "void", "string", "number", "boolean",
  "if", "else", "for", "while", "new", "this", "from",
]);

/**
 * 편집 본문에서 *정의/수정되는 심볼 이름*을 추출한다(순수). 이 이름들을 다른 파일에서 grep해
 * 호출부(축A)·유사 유틸(rung2) 단서를 찾는다. 노이즈 억제: 3자 미만·키워드 제외, 상한 적용.
 */
export function extractSymbols(editText: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /(?:function|class|interface|type)\s+([A-Za-z_]\w*)/g,
    /(?:const|let|var)\s+([A-Za-z_]\w*)\s*[=:]/g,
    /(?:export\s+(?:async\s+)?function\s+)([A-Za-z_]\w*)/g,
    // `name(...)` 형태의 정의/호출 심볼(메서드·팩토리)
    /\b([A-Za-z_]\w{2,})\s*\(/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(editText)) !== null) {
      const name = m[1];
      if (name.length >= 3 && !IDENT_KEYWORDS.has(name)) out.add(name);
    }
  }
  return [...out].slice(0, MAX_GREP_SYMBOLS);
}

/**
 * 자기파일 비교용 정규 경로(0.6.1 R2) — 심링크를 실경로로 해소해 동일 실체를 같은 키로 만든다.
 * realpath 실패(파일 미존재: Write 직전 신규 파일·브로큰 링크)는 기존 lexical resolve 폴백 —
 * 비교 정밀도만 낮아질 뿐 수집 동작은 보존(비차단 권고 경로라 보안 경계 아님).
 */
function canonicalPath(cwd: string, p: string): string {
  const abs = resolve(cwd, p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** collectGrepContext 결과 — 프롬프트용 컨텍스트 + 컨텍스트를 얻은 파일 집합(하드가드 입력). */
export interface GrepCollectResult {
  context: string;
  /** grep 매치를 하나라도 얻은 *편집 파일* 경로 집합(그 파일의 축A/rung2를 신뢰할 수 있음). */
  filesWithContext: Set<string>;
}

/** grep 실행 주입(테스트용). 미지정 시 실제 `grep -rn`. */
export type GrepRunner = (symbol: string, cwd: string) => Promise<string>;

async function realGrep(symbol: string, cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "grep",
      [
        "-rn", "--include=*.ts", "--include=*.js", "--include=*.tsx", "--include=*.jsx",
        "--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=dist", "--exclude-dir=.gbc",
        // "--"로 옵션 종결 — extractSymbols가 [A-Za-z_] 앵커라 현재는 "-" 시작 심볼이 없지만,
        // 패턴 확장 시 심볼이 grep 플래그로 해석되는 회귀를 방어(보안 QUICK W1).
        "-F", "--", symbol, ".",
      ],
      { cwd, timeout: GREP_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    // grep exit 1(매치 없음)·타임아웃·부재 → 빈 결과(하드가드가 흡수).
    return "";
  }
}

/**
 * 큐의 편집들에 대해 실제 grep을 돌려 코드베이스 컨텍스트를 모은다(비결정 I/O).
 * 각 편집의 정의 심볼을 *다른 파일에서* 찾아(자기 파일 제외) 호출부·유사 유틸 단서를 수집.
 * 심볼 총량은 MAX_GREP_SYMBOLS로 캡. grep 실패/무매치는 조용히 빈 컨텍스트 → 하드가드로 정직 처리.
 */
export async function collectGrepContext(
  cwd: string,
  entries: ScopeQueueEntry[],
  opts: { grep?: GrepRunner } = {},
): Promise<GrepCollectResult> {
  const grep = opts.grep ?? realGrep;
  const filesWithContext = new Set<string>();
  const allMatches: GrepMatch[] = [];
  const seenSymbols = new Set<string>();

  for (const entry of entries) {
    // 엔트리당 1회만 실경로 해석(심볼 루프 밖) — 매치별 canonicalPath는 남지만 상한(40)이 바운드.
    const entryAbs = canonicalPath(cwd, entry.file);
    for (const sym of extractSymbols(entry.edit)) {
      if (seenSymbols.size >= MAX_GREP_SYMBOLS) break;
      if (seenSymbols.has(sym)) continue;
      seenSymbols.add(sym);
      const raw = await grep(sym, cwd);
      const { matches } = parseGrepOutput(raw);
      // 자기 파일 매치는 제외(다른 파일의 호출부·중복만 단서로). cwd 기준 절대경로 동등 비교 —
      // production은 entry.file=절대(CC file_path) × grep 출력=./상대 조합이라 endsWith가 불일치했다(0.5.4).
      // 0.6.1 R2: 비교는 실경로(canonicalPath) — 심링크 소스에서 링크↔실경로가 서로 다른 lexical
      // 경로로 갈려 자기 매치가 타 파일 단서로 새던 오분류(근거 없는 축A/rung2 재료)를 차단.
      const others = matches.filter((m) => canonicalPath(cwd, m.file) !== entryAbs);
      if (others.length > 0) {
        filesWithContext.add(entry.file);
        allMatches.push(...others);
      }
    }
  }
  return { context: formatGrepContext(allMatches), filesWithContext };
}
