// 0.10.4 ST1 — repo(탭)별로 격리된 대화 스크롤백 순수 버퍼. 결함1(repo 전환 시 대화 소실 +
// 백그라운드 탭 도착 메시지 영구 유실) 근본수정의 코어. 기존엔 app.tsx의 단일 useState<ScrollEntry[]>
// 하나를 모든 repo가 공유해, switchToTab이 매 전환마다 통째로 비웠다 — 이 모듈은 Record<repoId,
// ScrollEntry[]>로 격리해 "다른 탭 append가 이 탭 버퍼를 절대 건드리지 않는다"를 자료구조로 보장한다
// (tabs.ts가 TabRegistry에 대해 이미 확립한 것과 동일한 원칙 — 여기서는 스크롤백 데이터에 적용).
import type { TextSegment, Tone } from "./format.js";

export type ScrollEntry =
  | { id: number; kind: "text"; text: string; tone: Tone }
  // formatWelcomeCard처럼 한 줄에 여러 톤이 섞이는 세그먼트 배열 보존용(app.tsx 기존 ScrollEntry
  // "segments" variant와 동일 계약 — 단일 tone "text" variant로는 톤별 정보가 손실된다).
  | { id: number; kind: "segments"; segments: TextSegment[] };

export type ScrollBuffers = Record<string, ScrollEntry[]>;

/** repoId의 버퍼를 조회한다. 미등록 repo는 빈 배열(크래시 없음 — 아직 한 번도 append 안 된 탭). */
export function getBuffer(buffers: ScrollBuffers, repoId: string): ScrollEntry[] {
  return buffers[repoId] ?? [];
}

function appendEntry(buffers: ScrollBuffers, repoId: string, entry: ScrollEntry, maxEntries: number): ScrollBuffers {
  const next = [...(buffers[repoId] ?? []), entry];
  const trimmed = maxEntries <= 0 ? [] : next.length > maxEntries ? next.slice(next.length - maxEntries) : next;
  return { ...buffers, [repoId]: trimmed };
}

/** 단일-톤 텍스트 엔트리 추가(불변 갱신) — maxEntries는 이 repoId 버퍼에만 독립 적용된다(다른
 * repo의 트림 여부에 영향 없음). */
export function appendText(
  buffers: ScrollBuffers,
  repoId: string,
  id: number,
  text: string,
  tone: Tone,
  maxEntries: number,
): ScrollBuffers {
  return appendEntry(buffers, repoId, { id, kind: "text", text, tone }, maxEntries);
}

/** 세그먼트(다중 톤) 엔트리 추가 — API는 appendText와 대칭. */
export function appendSegments(
  buffers: ScrollBuffers,
  repoId: string,
  id: number,
  segments: TextSegment[],
  maxEntries: number,
): ScrollBuffers {
  return appendEntry(buffers, repoId, { id, kind: "segments", segments }, maxEntries);
}
