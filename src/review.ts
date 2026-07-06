// 펜딩-검토 레이어 — 게이트 block이 도출한 침묵-누락 케이스(missing[])를 사람-승인 체크리스트로
// 회수한다. judge의 {verdict, missing[]}가 buildBlockReason prose 평탄화로 버려지던 seam을 구조 보존:
//   block 시 hook이 missing[]를 .gbc/pending-review.json에 기록 → `gbc gate review`가 번호 체크리스트로
//   제시 → 사용자 분류(--spec refs / --defer refs)를 일괄 addSpecCase/addDefer로 적용 후 clear.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gbcDir, readJson, writeJson } from "./store.js";
import type { PendingReview } from "./types.js";

function pendingPath(cwd: string): string {
  return join(gbcDir(cwd), "pending-review.json");
}

/** 펜딩-검토 레코드 기록(block 시점). 기존 펜딩을 덮어쓴다(가장 최근 block만 유효). */
export function writePendingReview(cwd: string, p: PendingReview): void {
  writeJson(pendingPath(cwd), p);
}

/**
 * 펜딩-검토 레코드 읽기. 없으면 null. 형상 가드(0.6.1 R3): valid-JSON이라도 객체가 아니거나
 * missing이 배열이 아니면 null — cmdGateReview의 missing.length 접근이 throw로 새지 않게.
 */
export function readPendingReview(cwd: string): PendingReview | null {
  const raw = readJson<unknown>(pendingPath(cwd), null);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  if (!Array.isArray((raw as { missing?: unknown }).missing)) return null;
  return raw as PendingReview;
}

/** 펜딩-검토 레코드 제거(분류 완료 후). 파일 부재면 무동작(idempotent). */
export function clearPendingReview(cwd: string): void {
  const path = pendingPath(cwd);
  if (existsSync(path)) rmSync(path);
}

/**
 * 펜딩 케이스(1-base 표시) 중 ref에 해당하는 케이스 텍스트를 고른다. defer selectTargets와 동형:
 * - "all" → 전부
 * - 공백구분 토큰이 전부 정수 → 복수 인덱스(1-base, 범위 밖·중복 무시)
 * - 그 외 → 부분 텍스트 1건 매칭(공백 포함 문구 하위호환)
 * 빈 ref → [](includes("") 오매칭 방어).
 */
export function selectCases(cases: string[], ref: string): string[] {
  const trimmed = ref.trim();
  if (trimmed === "") return [];
  if (trimmed === "all") return [...cases];

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const allInts = tokens.length > 0 && tokens.every((t) => /^\d+$/.test(t));
  if (allInts) {
    const out: string[] = [];
    for (const t of tokens) {
      const idx = Number.parseInt(t, 10);
      if (idx >= 1 && idx <= cases.length && !out.includes(cases[idx - 1])) {
        out.push(cases[idx - 1]);
      }
    }
    return out;
  }
  const found = cases.find((c) => c.includes(trimmed));
  return found ? [found] : [];
}

/**
 * 펜딩 케이스를 spec-추가 / defer-등록으로 분류한다. specRefs·deferRefs는 각각 selectCases ref.
 * 한 케이스가 양쪽에 걸리면 **spec 우선**(승인이 미룸을 이긴다) — toDefer에서 toSpec 항목을 제외해
 * 같은 케이스가 spec.md와 defers.json에 이중 등록되는 것을 막는다.
 */
export function resolveRefs(
  missing: string[],
  specRefs: string,
  deferRefs: string,
): { toSpec: string[]; toDefer: string[] } {
  const toSpec = selectCases(missing, specRefs);
  const toDefer = selectCases(missing, deferRefs).filter((c) => !toSpec.includes(c));
  return { toSpec, toDefer };
}
