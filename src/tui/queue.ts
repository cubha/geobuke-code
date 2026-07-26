// 0.11.0 ST1-1 — repoId별 순수 제출 대기열(순수, 렌더-비의존). streaming 중 새 제출을 잃지 않고
// (in-flight 소실 결함 근본수정) 순차 drain하기 위한 자료구조. 0.10.4 결함1(활성탭 가정으로 배경탭
// 데이터를 잃던 버그)과 동일 결함 클래스 재발을 막기 위해 모든 연산이 repoId로 격리된다 — 다른
// repoId 키는 물리적으로 손대지 않는다(tabs.ts updateTabStatus와 동일한 격리 규약).

export interface PendingSubmission {
  text: string;
}

export type SubmitQueue = Record<string, readonly PendingSubmission[]>;

export function createSubmitQueue(): SubmitQueue {
  return {};
}

export function enqueue(queue: SubmitQueue, repoId: string, text: string): SubmitQueue {
  const existing = queue[repoId] ?? [];
  return { ...queue, [repoId]: [...existing, { text }] };
}

/** 큐가 비어있으면 next=null·queue는 입력과 동일 참조(불필요 리렌더 방지, tabs.ts 관례). */
export function dequeueNext(queue: SubmitQueue, repoId: string): { next: PendingSubmission | null; queue: SubmitQueue } {
  const existing = queue[repoId];
  if (!existing || existing.length === 0) return { next: null, queue };
  const [next, ...rest] = existing;
  const nextQueue = { ...queue };
  if (rest.length === 0) delete nextQueue[repoId];
  else nextQueue[repoId] = rest;
  return { next, queue: nextQueue };
}

/** 지정 repoId만 비운다(Esc 취소). 없는 repoId면 no-op(동일 참조 반환). */
export function clearRepo(queue: SubmitQueue, repoId: string): SubmitQueue {
  if (!queue[repoId]) return queue;
  const next = { ...queue };
  delete next[repoId];
  return next;
}

export function countFor(queue: SubmitQueue, repoId: string): number {
  return queue[repoId]?.length ?? 0;
}
