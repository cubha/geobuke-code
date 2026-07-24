// 펜딩-검토 레이어 — 게이트 block이 도출한 침묵-누락 케이스(missing[])를 사람-승인 체크리스트로
// 회수한다. judge의 {verdict, missing[]}가 buildBlockReason prose 평탄화로 버려지던 seam을 구조 보존:
//   block 시 hook이 missing[]를 .gbc/pending-review.json에 기록 → `gbc gate review`가 번호 체크리스트로
//   제시 → 사용자 분류(--spec refs / --defer refs)를 일괄 addSpecCase/addDefer로 적용 후 clear.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gbcDir, readJson, writeJson } from "./store.js";
import { selectByRef } from "./text.js";
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
 * 펜딩 케이스(1-base 표시) 중 ref에 해당하는 케이스 텍스트를 고른다 — text.ts selectByRef(defer.ts
 * selectTargets와 공용, R1 리팩토링 2026-07-24)의 얇은 래퍼. 상태 적격 개념이 없으므로 eligible은
 * 기본값(전부 적격) 그대로 쓴다.
 */
export function selectCases(cases: string[], ref: string): string[] {
  return selectByRef(cases, ref, (c) => c);
}

/**
 * 펜딩 케이스를 spec-추가 / defer-등록 / ack(이미완료)로 분류한다(0.9.3 ST4 — 3분류 확장).
 * specRefs·deferRefs·ackRefs는 각각 selectCases ref. 우선순위 spec > defer > ack — 한 케이스가
 * 여럿에 걸리면 더 확정적인 사람 의도가 이긴다: spec 등록(승인)이 defer(미룸)를 이기고(기존 규칙),
 * defer(사람이 의도적으로 미룸을 선언)가 ack(모델이 "이미 됐다"고 판단)보다 우선한다 — 사람이 명시
 * 미루기로 답했는데 조용히 ack로 흡수되면 안 된다.
 */
export function resolveRefs(
  missing: string[],
  specRefs: string,
  deferRefs: string,
  ackRefs = "",
): { toSpec: string[]; toDefer: string[]; toAck: string[] } {
  const toSpec = selectCases(missing, specRefs);
  const toDefer = selectCases(missing, deferRefs).filter((c) => !toSpec.includes(c));
  const toAck = selectCases(missing, ackRefs).filter((c) => !toSpec.includes(c) && !toDefer.includes(c));
  return { toSpec, toDefer, toAck };
}
