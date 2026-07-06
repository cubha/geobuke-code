import { join } from "node:path";
import { gbcDir, readJson, writeJson } from "./store.js";
import { nowIso } from "./time.js";
import type { GateState } from "./types.js";

function statePath(cwd: string): string {
  return join(gbcDir(cwd), "state.json");
}

export function loadState(cwd: string): GateState | null {
  return readJson<GateState | null>(statePath(cwd), null);
}

/**
 * 이 작업단위(specHash)가 이미 게이트를 통과했는가?
 * 명세가 바뀌면(specHash 불일치) 새 작업단위 → 미게이트로 간주.
 */
export function isGated(cwd: string, specHash: string): boolean {
  const s = loadState(cwd);
  return !!s && s.specHash === specHash && s.gated;
}

/** 이 작업단위를 게이트 통과로 표시 (작업단위 1회 캐시) */
export function markGated(cwd: string, specHash: string, reason: string): void {
  const state: GateState = { specHash, gated: true, lastReason: reason, at: nowIso() };
  writeJson(statePath(cwd), state);
}

/** 작업단위 리셋 — 다음 편집에서 다시 게이트 발동 */
export function resetGate(cwd: string): void {
  const s = loadState(cwd);
  const state: GateState = {
    specHash: s?.specHash ?? "",
    gated: false,
    lastReason: "수동 리셋",
    at: nowIso(),
  };
  writeJson(statePath(cwd), state);
}
