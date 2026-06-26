import { join } from "node:path";
import { gbcDir, readJson, writeJson } from "./store.js";
import { normalizeCase } from "./text.js";
import type { DeferEntry, DeferStatus, RawDeferEntry } from "./types.js";

function deferPath(cwd: string): string {
  return join(gbcDir(cwd), "defers.json");
}

function nowIso(): string {
  try {
    return new Date().toISOString();
  } catch {
    return "";
  }
}

/**
 * 원시 엔트리를 status 단일 소스로 정규화한다(마이그레이션).
 * 옛 0.2.4 이하 포맷 {resolved:boolean}을 읽을 때 status로 승격:
 * resolved:true→"resolved", false/부재→"open". 이미 status가 있으면 그대로.
 */
function promote(raw: RawDeferEntry): DeferEntry {
  const status: DeferEntry["status"] =
    raw.status ?? (raw.resolved === true ? "resolved" : "open");
  return { item: raw.item, at: raw.at, status };
}

/** 디스크에서 defer 엔트리를 읽어 status 포맷으로 정규화 반환(읽기 시 자동 승격) */
export function loadDefers(cwd: string): DeferEntry[] {
  return readJson<RawDeferEntry[]>(deferPath(cwd), []).map(promote);
}

/** 저장은 항상 status 포맷으로 통일 — promote가 옛 resolved 필드를 떨궈 단일 소스 보장(drift 방지) */
function save(cwd: string, defers: DeferEntry[]): void {
  writeJson(deferPath(cwd), defers);
}

/**
 * 명시적으로 항목을 미룬다 (침묵 누락 차단의 유일한 정당 경로).
 * 중복 감지(ST2): 정규화 텍스트가 **미해결(open+in_progress)** 항목과 동일하면 새로 추가하지 않고
 * 기존 엔트리를 added:false로 반환한다 — 같은 '무관' defer가 시점만 달리 누적되던 증상(2026-06-26 진단) 차단.
 * resolved된 동일 텍스트는 막지 않는다(완료 후 같은 케이스가 정당히 재발할 수 있음 → 재-defer 허용).
 * @returns { entry, added } — added=false면 entry는 기존(미해결) 항목.
 */
export function addDefer(cwd: string, item: string): { entry: DeferEntry; added: boolean } {
  const defers = loadDefers(cwd);
  const normalized = normalizeCase(item);
  const dup = defers.find((d) => d.status !== "resolved" && d.item === normalized);
  if (dup) return { entry: dup, added: false };
  const entry: DeferEntry = { item: normalized, at: nowIso(), status: "open" };
  defers.push(entry);
  save(cwd, defers);
  return { entry, added: true };
}

/**
 * 미해결(=resolved 아님) defer 항목 텍스트만 (게이트 판정 입력용).
 * gate-neutral: open + in_progress 모두 '아직 안 끝난 의도적 미룸'으로 judge에 전달 → 차단 로직 무변경.
 */
export function activeDeferItems(cwd: string): string[] {
  return loadDefers(cwd)
    .filter((d) => d.status !== "resolved")
    .map((d) => d.item);
}

/** 미해결(open+in_progress) defer 엔트리 (Stop hook·SessionStart 리마인드용) */
export function unresolvedDefers(cwd: string): DeferEntry[] {
  return loadDefers(cwd).filter((d) => d.status !== "resolved");
}

/**
 * 완료(resolved) defer 항목 텍스트만 (게이트 judge에 [이미 완료된 항목]으로 전달).
 * activeDeferItems가 resolved를 제외해 judge에 안 보이던 갭을 메운다 — judge가 완료 케이스를
 * "계획됨+미defer 형제"로 오인해 며칠 지난 케이스를 침묵누락 차단하던 드리프트(2026-06-26 진단) 완화.
 */
export function resolvedDeferItems(cwd: string): string[] {
  return loadDefers(cwd)
    .filter((d) => d.status === "resolved")
    .map((d) => d.item);
}

/**
 * ref 문자열로 전환 대상 엔트리를 고른다. 세 형태 지원:
 * - "all": eligibleFrom 상태에 해당하는 전부
 * - 공백구분 토큰이 전부 정수: 복수 인덱스(1-base). 인덱스는 명시 지정이라 적격 무시(사용자가 번호를 안다)
 * - 그 외: 통째로 부분 텍스트 1건 매칭(적격 항목 중) — 공백 포함 문구 하위호환
 */
function selectTargets(
  defers: DeferEntry[],
  ref: string,
  eligibleFrom: DeferStatus[],
): DeferEntry[] {
  const trimmed = ref.trim();
  // 빈 ref 가드: includes("")는 항상 첫 항목을 매칭하므로 빈 문자열이 엉뚱한 항목을 고른다.
  // CLI(cli.ts)는 이미 빈 ref를 사전 차단하지만, selectTargets가 라이브러리로 직접 호출될 때를 위한 방어.
  if (trimmed === "") return [];
  const eligible = (d: DeferEntry) => eligibleFrom.includes(d.status);
  if (trimmed === "all") return defers.filter(eligible);

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const allInts = tokens.length > 0 && tokens.every((t) => /^\d+$/.test(t));
  if (allInts) {
    const out: DeferEntry[] = [];
    for (const t of tokens) {
      const idx = Number.parseInt(t, 10);
      if (idx >= 1 && idx <= defers.length && !out.includes(defers[idx - 1])) {
        out.push(defers[idx - 1]);
      }
    }
    return out;
  }
  const t = defers.find((d) => eligible(d) && d.item.includes(trimmed));
  return t ? [t] : [];
}

/** 선택된 대상을 toStatus로 전환하고 저장. 전환된 엔트리 배열 반환(매칭 0건이면 빈 배열). */
function transition(
  cwd: string,
  ref: string,
  toStatus: DeferStatus,
  eligibleFrom: DeferStatus[],
): DeferEntry[] {
  const defers = loadDefers(cwd);
  const targets = selectTargets(defers, ref, eligibleFrom);
  for (const t of targets) t.status = toStatus;
  if (targets.length > 0) save(cwd, defers);
  return targets;
}

/** open → in_progress (착수). 텍스트/all 적격 = open. 인덱스는 명시 지정. */
export function startDefer(cwd: string, ref: string): DeferEntry[] {
  return transition(cwd, ref, "in_progress", ["open"]);
}

/** → resolved (종결, 항상 사람 선언). 텍스트/all 적격 = open + in_progress. */
export function resolveDefer(cwd: string, ref: string): DeferEntry[] {
  return transition(cwd, ref, "resolved", ["open", "in_progress"]);
}

/** → open (백로그로 되돌리기: 보류/이월 또는 잘못된 resolve 취소). 텍스트/all 적격 = in_progress + resolved. */
export function reopenDefer(cwd: string, ref: string): DeferEntry[] {
  return transition(cwd, ref, "open", ["in_progress", "resolved"]);
}
