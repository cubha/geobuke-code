// D-2(잔여 근본수정, 승인 오귀속) — repoId별 순수 승인 큐. queue.ts(SubmitQueue)와 동일한 격리
// 규약: 어떤 연산도 다른 repoId 키를 손대지 않는다. submit 큐와 다른 점은 "머리를 제거하지 않고
// 조회"하는 peekApproval이 필요하다는 것 — QueuedApproval은 사용자가 답하기 전까지 계속 큐에
// 남아있는 채로 화면에 표시된다(app.tsx makeInkCanUseTool의 기존 push→즉시 활성화, shift→응답
// 계약을 그대로 옮긴다). 타입 파라미터화한 이유: 이 모듈은 app.tsx의 QueuedApproval(canUseTool
// resolver 클로저 포함) 구체 타입을 몰라도 되는 순수 자료구조 계층이다.

export type ApprovalQueueState<T> = Record<string, readonly T[]>;

export function createApprovalQueue<T>(): ApprovalQueueState<T> {
  return {};
}

export function pushApproval<T>(queue: ApprovalQueueState<T>, repoId: string, item: T): ApprovalQueueState<T> {
  const existing = queue[repoId] ?? [];
  return { ...queue, [repoId]: [...existing, item] };
}

/** 제거 없이 머리만 조회(없으면 null). 큐를 변형하지 않는다. */
export function peekApproval<T>(queue: ApprovalQueueState<T>, repoId: string): T | null {
  const existing = queue[repoId];
  return existing && existing.length > 0 ? existing[0] : null;
}

/** 큐가 비어있으면 removed=null·queue는 입력과 동일 참조(불필요 리렌더 방지, queue.ts 관례). */
export function shiftApproval<T>(queue: ApprovalQueueState<T>, repoId: string): { removed: T | null; queue: ApprovalQueueState<T> } {
  const existing = queue[repoId];
  if (!existing || existing.length === 0) return { removed: null, queue };
  const [removed, ...rest] = existing;
  const nextQueue = { ...queue };
  if (rest.length === 0) delete nextQueue[repoId];
  else nextQueue[repoId] = rest;
  return { removed, queue: nextQueue };
}

export function countApprovalsFor<T>(queue: ApprovalQueueState<T>, repoId: string): number {
  return queue[repoId]?.length ?? 0;
}
