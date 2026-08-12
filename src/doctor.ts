// gbc doctor — stray(화석) .gbc 마커 탐지·격리(0.12.2 SubTask5).
// 근본원인은 SubTask2/3에서 이미 고쳤다(resolveProjectRoot가 stray를 건너뜀+gbcDir 읽기 무해화).
// 이 모듈은 사후 정리용 — 과거(0.12.2 이전) mkdir-on-read로 이미 생성된 화석을 찾아 사용자가
// 눈으로 확인할 수 있게 하고, 요청 시 삭제가 아니라 격리(이동)한다(유일한 포렌식 기록이라 보존).
import { readdirSync, lstatSync, mkdirSync, renameSync } from "node:fs";
import { join, relative } from "node:path";
import { isRealGateRoot } from "./store.js";

/** 순회 제외 디렉토리명(성능·오탐 방지) — .gbc-quarantine-*는 접두 매칭으로 별도 처리. */
const SKIP_DIR_NAMES = new Set(["node_modules", ".git"]);

const QUARANTINE_PREFIX = ".gbc-quarantine-";

export interface StrayMarker {
  /** stray .gbc의 부모 디렉토리(화석이 발견된 위치). */
  dir: string;
  /** .gbc 마커 자체의 절대경로. */
  markerPath: string;
}

/**
 * root 하위를 재귀 순회하며 stray .gbc(형제 .claude/skills/gate/ 없음 — store.ts isRealGateRoot와
 * 동일 술어)를 찾는다. read-only, 부작용 없음.
 * - node_modules·.git·이미 격리된 .gbc-quarantine-* 하위는 뒤지지 않는다(성능·재탐지 방지).
 * - 심링크 디렉토리는 따라가지 않는다(lstatSync — 워크스페이스 밖 탈출 방지).
 * - .gbc 마커를 찾으면 그 내부는 더 파지 않는다(자기 자신의 하위 파일과 무관).
 */
export function findStrayGbcMarkers(root: string, opts: { maxDepth?: number } = {}): StrayMarker[] {
  const maxDepth = opts.maxDepth ?? 12;
  const found: StrayMarker[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 접근 불가 — 조용히 건너뜀(doctor는 진단 도구, 크래시 금지)
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (SKIP_DIR_NAMES.has(e.name) || e.name.startsWith(QUARANTINE_PREFIX)) continue;
      const full = join(dir, e.name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue; // 심링크(디렉토리 대상이라도) 배제
      if (e.name === ".gbc") {
        if (!isRealGateRoot(dir)) found.push({ dir, markerPath: full });
        continue;
      }
      walk(full, depth + 1);
    }
  }

  walk(root, 0);
  return found;
}

export interface QuarantinedMarker extends StrayMarker {
  quarantinedPath: string;
}

export interface QuarantineFailure {
  marker: StrayMarker;
  reason: string;
}

export interface QuarantineResult {
  moved: QuarantinedMarker[];
  failed: QuarantineFailure[];
}

/**
 * stray 마커를 삭제가 아니라 root/.gbc-quarantine-<stamp>/ 아래로 이동(포렌식 보존).
 * 개별 이동 실패는 전체를 막지 않되(나머지 항목은 계속 격리), **조용히 삼키지 않는다**(scope-critic
 * 지적, 2026-08-12) — found와 moved의 차집합을 failed에 원인 문자열과 함께 담아 호출부가 "N건 중
 * 몇 건만 격리됐는지"·"왜"를 사용자에게 보여줄 수 있게 한다.
 * opts.stamp 생략 시 호출자가 넘겨야 한다(이 모듈은 Date.now()를 직접 쓰지 않음 — 결정론 유지).
 */
export function quarantineStrayMarkers(
  root: string,
  markers: StrayMarker[],
  opts: { stamp: string },
): QuarantineResult {
  if (markers.length === 0) return { moved: [], failed: [] };
  const qDir = join(root, `${QUARANTINE_PREFIX}${opts.stamp}`);
  mkdirSync(qDir, { recursive: true });
  const moved: QuarantinedMarker[] = [];
  const failed: QuarantineFailure[] = [];
  for (const m of markers) {
    try {
      const flat = relative(root, m.dir).split(/[\\/]/).join("_");
      const dest = join(qDir, `${flat}_.gbc`);
      renameSync(m.markerPath, dest);
      moved.push({ ...m, quarantinedPath: dest });
    } catch (e) {
      failed.push({ marker: m, reason: String(e) });
    }
  }
  return { moved, failed };
}
