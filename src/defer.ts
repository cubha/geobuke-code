import { join } from "node:path";
import { gbcDir, readJson, writeJson } from "./store.js";
import { normalizeCase } from "./text.js";
import type { DeferEntry } from "./types.js";

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

export function loadDefers(cwd: string): DeferEntry[] {
  return readJson<DeferEntry[]>(deferPath(cwd), []);
}

function save(cwd: string, defers: DeferEntry[]): void {
  writeJson(deferPath(cwd), defers);
}

/** 명시적으로 항목을 미룬다 (침묵 누락 차단의 유일한 정당 경로) */
export function addDefer(cwd: string, item: string): DeferEntry {
  const defers = loadDefers(cwd);
  const entry: DeferEntry = { item: normalizeCase(item), at: nowIso(), resolved: false };
  defers.push(entry);
  save(cwd, defers);
  return entry;
}

/** 미해결 defer 항목 텍스트만 (게이트 판정 입력용) */
export function activeDeferItems(cwd: string): string[] {
  return loadDefers(cwd)
    .filter((d) => !d.resolved)
    .map((d) => d.item);
}

/** 미해결 defer 엔트리 (Stop hook 리마인드용) */
export function unresolvedDefers(cwd: string): DeferEntry[] {
  return loadDefers(cwd).filter((d) => !d.resolved);
}

/** 인덱스(1-base) 또는 부분 텍스트 매칭으로 defer 해결 표시 */
export function resolveDefer(cwd: string, ref: string): DeferEntry | null {
  const defers = loadDefers(cwd);
  let target: DeferEntry | undefined;
  const idx = Number.parseInt(ref, 10);
  if (!Number.isNaN(idx) && idx >= 1 && idx <= defers.length) {
    target = defers[idx - 1];
  } else {
    target = defers.find((d) => !d.resolved && d.item.includes(ref));
  }
  if (!target) return null;
  target.resolved = true;
  save(cwd, defers);
  return target;
}
