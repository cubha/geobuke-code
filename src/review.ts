// 펜딩-검토 레이어 — 게이트 block이 도출한 침묵-누락 케이스(missing[])를 사람-승인 체크리스트로
// 회수한다. judge의 {verdict, missing[]}가 buildBlockReason prose 평탄화로 버려지던 seam을 구조 보존:
//   block 시 hook이 missing[]를 .gbc/pending-review.json에 기록 → `gbc gate review`가 번호 체크리스트로
//   제시 → 사용자 분류(--spec refs / --defer refs)를 일괄 addSpecCase/addDefer로 적용 후 clear.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gbcDirPath, ensureGbcDir, readJson, writeJson } from "./store.js";
import { selectByRef, normalizeCase } from "./text.js";
import type { PendingReview } from "./types.js";

function pendingPath(cwd: string): string {
  return join(gbcDirPath(cwd), "pending-review.json");
}

/** 펜딩-검토 레코드 기록(block 시점). 기존 펜딩을 덮어쓴다(가장 최근 block만 유효). */
export function writePendingReview(cwd: string, p: PendingReview): void {
  ensureGbcDir(cwd);
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

/** mergeAnnounced가 유지하는 누적 이력 상한 — 같은 작업단위에서 무한 증식하지 않도록 최근 N건만 보존. */
export const MAX_ANNOUNCED_SEEN = 50;

/**
 * 0.13.0 P4-2 — 같은 작업단위(specHash) 안에서 누적된 missing 문구 이력을 계산한다(순수함수,
 * 부수효과 없음). 다음 SubTask(gate-core.ts)의 block-repeat 근사매칭 판정 대조군이 될 배열을
 * 만들 뿐, pendingReview.seen에 실제로 써넣는 것은 이 함수의 책임 밖이다.
 *
 * - prior가 없거나 specHash가 바뀌었으면(새 작업단위) missing만 정규화해 초기화.
 * - specHash가 같으면 (prior.seen ?? prior.missing, 구버전 레코드 호환)에 새 missing을 이어붙여
 *   정규화 기준으로 중복을 제거한다(먼저 나온 순서 보존).
 * - 결과가 MAX_ANNOUNCED_SEEN을 넘으면 오래된 것부터 잘라 최근 것만 남긴다.
 */
export function mergeAnnounced(prior: PendingReview | null, specHash: string, missing: string[]): string[] {
  const normalized = missing.map(normalizeCase);
  if (prior === null || prior.specHash !== specHash) {
    return normalized;
  }
  const base = prior.seen ?? prior.missing;
  const merged: string[] = [];
  for (const item of [...base, ...normalized]) {
    if (!merged.includes(item)) merged.push(item);
  }
  return merged.length > MAX_ANNOUNCED_SEEN ? merged.slice(merged.length - MAX_ANNOUNCED_SEEN) : merged;
}
