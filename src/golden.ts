// 골든셋 캡처 + 게이트 판정 드리프트 회귀락 (A2). 순수 코어 — 비교/해시/집계는 결정론이라
// 단위테스트 대상. judge 재실행(LLM·네트워크)·캡처 훅·CLI 출력은 비결정이라 여기 없음.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { gbcDirPath, ensureGbcDir, readJsonArray, writeJson } from "./store.js";
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

/**
 * 이 골든 케이스가 P2b 2단계까지 재현할 대상인가(0.12.0 F-13, 순수 술어). 근거 원문과 재판정
 * 기대가 **둘 다** 있어야 한다 — 기준 없이 재판정만 돌리면 비교할 것이 없어 신호가 안 되고,
 * 근거 없이 기준만 있으면 1차 프롬프트와 동일해져 2단계를 재현하는 것이 아니다. 공백뿐인 근거도
 * 제외한다: `judge`의 `buildUserMessage`가 trim 후 비면 섹션 자체를 생략하므로 1차와 같아진다.
 */
export function needsP2bReplay(c: Partial<GoldenCase>): boolean {
  return Boolean(c.evidenceContext && c.evidenceContext.trim() && c.expectedAfterEvidence);
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

/**
 * "이번 회차 캡처에 없으면 이전 캡처 값을 보존"할 선택 필드 목록(0.12.4 ST1) — 개별 조건 복붙이
 * 이 결함의 원인이었다(evidenceContext만 보존하고 형제 필드 appliedContext는 빠뜨림, 아래
 * upsertGolden docstring 참조). 새 보존 대상 필드가 생기면 여기에만 추가하면 된다.
 */
const STICKY_FIELDS = ["evidenceContext", "expectedAfterEvidence", "appliedContext"] as const;

/**
 * id 디둑 upsert — 같은 id면 교체(최신 expected), 없으면 추가.
 *
 * ⚠️ 단 위 STICKY_FIELDS는 새 캡처에 없으면 기존 것을 보존한다(`evidenceContext`/
 * `expectedAfterEvidence`=0.12.0 advisor 실측 지적, `appliedContext`=0.12.4 동형 재발 수정).
 * `goldenCaseId`는 `sha256(tool, edit, spec)`이라 근거가 키에 없다 — 같은 편집을 다시 캡처했는데
 * 그 회차엔 grep 매치가 0이거나(P2b 미발화) 원장이 비어있으면(P2a 무기록, 예: `gate reset` 후
 * 재수행·작업단위 전환), 새 케이스엔 해당 필드가 없고 통째 교체하면 드리프트 락이 **조용히
 * 사라진다**. 그러면 replay는 그 필드가 지키던 재현을 그만두고 무신호로 되돌아간다(F-13이 막으려던
 * 거짓안심이 읽기가 아니라 쓰기 경로에서 재현되는 패턴 — evidenceContext에서 한 번 고쳤는데
 * appliedContext에서 형제 필드로 재발했다).
 *
 * 보존이 옳은 이유: 각 필드는 "이 근거/이력을 실으면 judge가 X를 낸다"는 **자기완결적** 기준이라,
 * 이번 회차에 그 필드가 다시 채워졌는지와 무관하게 유효하다. 새 캡처가 필드를 가져오면 그때는
 * 최신으로 교체한다(아래 루프의 `merged[field] === undefined` 조건).
 */
export function upsertGolden(cases: GoldenCase[], c: GoldenCase): GoldenCase[] {
  const prev = cases.find((x) => x.id === c.id);
  let merged: GoldenCase = c;
  if (prev) {
    for (const field of STICKY_FIELDS) {
      if (merged[field] === undefined && prev[field] !== undefined) {
        merged = { ...merged, [field]: prev[field] } as GoldenCase;
      }
    }
  }
  return [...cases.filter((x) => x.id !== c.id), merged];
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
  return join(gbcDirPath(cwd), "golden.json");
}

export function loadGolden(cwd: string): GoldenCase[] {
  return readJsonArray<GoldenCase>(goldenPath(cwd)); // 비배열 JSON → [](R3)
}

export function addGoldenCase(cwd: string, c: GoldenCase): void {
  ensureGbcDir(cwd);
  writeJson(goldenPath(cwd), upsertGolden(loadGolden(cwd), c));
}

export function clearGolden(cwd: string): void {
  ensureGbcDir(cwd);
  writeJson(goldenPath(cwd), []);
}
