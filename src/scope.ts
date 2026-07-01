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

// STUB(SubTask 2 RED) — 아래 구현 예정.
export function scopeQueuePath(cwd: string): string {
  return join(gbcDir(cwd), "scope-queue.json");
}

export function enqueueScope(_cwd: string, _entry: ScopeQueueEntry): void {
  throw new Error("not implemented");
}

export function readScopeQueue(_cwd: string): ScopeQueueEntry[] {
  return [];
}

export function clearScopeQueue(_cwd: string): void {
  throw new Error("not implemented");
}

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

export interface GrepParse {
  matches: GrepMatch[];
  truncated: boolean;
}

export function parseGrepOutput(_raw: string): GrepParse {
  return { matches: [], truncated: false };
}

export function formatGrepContext(_matches: GrepMatch[]): string {
  return "";
}
