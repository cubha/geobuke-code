import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const MAX_SPEC = 12000; // 명세 텍스트 절단 (프롬프트 비대화 방지)

/**
 * 계획 명세를 디스크에서 로드한다. (advisor④: durable 소스만 — 라이브 SubTask는 영속 X)
 * 우선순위: GBC_SPEC_FILE > .gbc/spec.md > scratch.md > "" (빈 명세 = 시나리오 미지정 → 통증#2 차단)
 *
 * 느슨 매칭은 게이트 LLM이 담당한다(체크리스트 라인/SubTask 항목). 로더는 텍스트만 제공.
 */
export function loadPlanSpec(cwd: string): { text: string; source: string } {
  const candidates: string[] = [];
  if (process.env.GBC_SPEC_FILE) candidates.push(process.env.GBC_SPEC_FILE);
  candidates.push(join(cwd, ".gbc", "spec.md"));
  candidates.push(join(cwd, "scratch.md"));

  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf8");
        const text = raw.length > MAX_SPEC ? raw.slice(0, MAX_SPEC) + "\n…(절단됨)" : raw;
        return { text, source: path };
      } catch {
        // 읽기 실패는 다음 후보로
      }
    }
  }
  return { text: "", source: "(없음)" };
}

/** 명세 해시 — 작업단위 식별용. 명세가 바뀌면 새 작업단위로 간주해 재게이트. */
export function computeSpecHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
