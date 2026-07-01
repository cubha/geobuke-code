// scope 판정 큐 + grep 결과 파싱 (축A 파급반경 + 축B Ponytail 사다리, 0.5.2).
// PreToolUse가 pass한 동작편집을 여기 큐잉 → Stop 훅이 grep 컨텍스트를 채워 배치 판정한다.
// 이 파일은 순수 로직·파일 IO만 담당(모델 호출 없음 — 그건 judge.ts judgeScope).
import { join } from "node:path";
import { gbcDir, readJson, writeJson } from "./store.js";
import type { ScopeQueueEntry } from "./types.js";

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

/** 큐 읽기(부재/파손 시 빈 배열). */
export function readScopeQueue(cwd: string): ScopeQueueEntry[] {
  const raw = readJson<ScopeQueueEntry[]>(scopeQueuePath(cwd), []);
  return Array.isArray(raw) ? raw : [];
}

/** 큐 비우기(Stop 훅이 판정 후 호출 — 그 턴 판정분 회수). */
export function clearScopeQueue(cwd: string): void {
  writeJson(scopeQueuePath(cwd), []);
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
