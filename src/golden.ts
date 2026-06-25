// 골든셋 캡처 + 게이트 판정 드리프트 회귀락 (A2). 순수 코어 — 비교/해시/집계는 결정론이라
// 단위테스트 대상. judge 재실행(LLM·네트워크)·캡처 훅·CLI 출력은 비결정이라 여기 없음.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { gbcDir, readJson, writeJson } from "./store.js";
import type { GoldenCase, GoldenExpected, VerdictKind } from "./types.js";

/** judge 출력의 비교 가능한 최소형(replay 결과) */
export interface VerdictLike {
  verdict: VerdictKind;
  missing: string[];
}

/** 기대 판정 vs 재판정 차이 */
export interface GoldenDiff {
  /** pass↔block 뒤집힘 — 유일한 하드 드리프트 신호(exit-1 근거) */
  decisionFlip: boolean;
  /** missing[] 집합 변화 — LLM 자유서술이라 정보용(절대 exit-1 안 함) */
  missingChanged: boolean;
  /** 둘 다 변화 없음 */
  match: boolean;
}

/** 한 케이스의 replay 결과 */
export interface ReplayOutcome {
  id: string;
  tool: string;
  expected: VerdictKind;
  actual: VerdictKind;
  diff: GoldenDiff;
}

/** replay 집계 */
export interface ReplaySummary {
  total: number;
  matched: number;
  flips: number;
  missingOnly: number;
  flipped: ReplayOutcome[];
}

/**
 * tool+edit+spec의 안정 해시 — upsert 디둑 키. 널바이트 구분자로 필드 경계 모호성 차단
 * (("a","bc") vs ("ab","c") 충돌 방지).
 */
export function goldenCaseId(tool: string, edit: string, spec: string): string {
  return createHash("sha256").update(`${tool}\x00${edit}\x00${spec}`).digest("hex").slice(0, 16);
}

/** 기대 vs 재판정 비교. decisionFlip=하드, missingChanged=정보용. */
export function diffVerdict(expected: GoldenExpected, actual: VerdictLike): GoldenDiff {
  const decisionFlip = expected.verdict !== actual.verdict;
  const norm = (xs: string[]): string[] => [...new Set(xs)].sort();
  const em = norm(expected.missing);
  const am = norm(actual.missing);
  const missingChanged = em.length !== am.length || em.some((v, i) => v !== am[i]);
  return { decisionFlip, missingChanged, match: !decisionFlip && !missingChanged };
}

/** id 디둑 upsert — 같은 id면 교체(최신 expected), 없으면 추가. */
export function upsertGolden(cases: GoldenCase[], c: GoldenCase): GoldenCase[] {
  return [...cases.filter((x) => x.id !== c.id), c];
}

/** replay 결과 집계 — 플립/정보용변화/일치 카운트 + 플립 케이스 목록. */
export function summarizeReplay(outcomes: ReplayOutcome[]): ReplaySummary {
  const flipped = outcomes.filter((o) => o.diff.decisionFlip);
  const matched = outcomes.filter((o) => o.diff.match).length;
  const missingOnly = outcomes.filter((o) => !o.diff.decisionFlip && o.diff.missingChanged).length;
  return { total: outcomes.length, matched, flips: flipped.length, missingOnly, flipped };
}

// ---------- IO (ST-A2-2에서 구현) ----------
function goldenPath(cwd: string): string {
  return join(gbcDir(cwd), "golden.json");
}

export function loadGolden(cwd: string): GoldenCase[] {
  return readJson<GoldenCase[]>(goldenPath(cwd), []);
}

export function addGoldenCase(cwd: string, c: GoldenCase): void {
  writeJson(goldenPath(cwd), upsertGolden(loadGolden(cwd), c));
}

export function clearGolden(cwd: string): void {
  writeJson(goldenPath(cwd), []);
}
