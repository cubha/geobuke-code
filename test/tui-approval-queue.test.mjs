// D-2(잔여 근본수정) — src/tui/approval-queue.ts 순수 repoId별 승인 큐 단정.
// 배경: 기존 approvalQueue(app.tsx 로컬)는 전체 세션 공유 단일 배열이라, 배경 탭에서 발생한 승인이
// 화면(activeTabId)과 무관하게 큐에 쌓이고 순서대로 활성화됐다 — repoId 필드는 태깅만 됐을 뿐 큐
// 자체가 repoId로 격리되지 않아 "이 탭엔 원래 이 승인이 안 보여야 한다"는 계약을 큐 구조가 강제하지
// 못했다. queue.ts(SubmitQueue)와 동일하게 repoId별 격리를 자료구조 수준에서 강제한다.
//
// submit 큐(dequeueNext)와 달리 승인 큐는 "머리를 아직 안 지운 채로 화면에 표시"하는 상태가 있어야
// 한다(응답 전까지 QueuedApproval은 큐에 남아있고, 응답 시점에야 shift된다 — app.tsx 기존 계약).
// 그래서 peekApproval(제거 없이 조회)과 shiftApproval(제거)을 분리한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApprovalQueue, pushApproval, peekApproval, shiftApproval, countApprovalsFor } from "../dist/tui/approval-queue.js";

test("createApprovalQueue: 빈 큐로 시작", () => {
  const q = createApprovalQueue();
  assert.equal(countApprovalsFor(q, "/repo/a"), 0);
  assert.equal(peekApproval(q, "/repo/a"), null);
});

test("pushApproval: repoId별로 FIFO로 쌓인다", () => {
  let q = createApprovalQueue();
  q = pushApproval(q, "/repo/a", { id: 1 });
  q = pushApproval(q, "/repo/a", { id: 2 });
  assert.equal(countApprovalsFor(q, "/repo/a"), 2);
  assert.deepEqual(peekApproval(q, "/repo/a"), { id: 1 }, "머리는 첫 push");
});

test("pushApproval: 다른 repoId는 서로 격리된다(교차오염 없음)", () => {
  let q = createApprovalQueue();
  q = pushApproval(q, "/repo/a", { id: "a" });
  q = pushApproval(q, "/repo/b", { id: "b" });
  assert.equal(countApprovalsFor(q, "/repo/a"), 1);
  assert.equal(countApprovalsFor(q, "/repo/b"), 1);
  const { removed } = shiftApproval(q, "/repo/a");
  assert.deepEqual(removed, { id: "a" }, "a를 shift해도 b 큐는 무관");
  assert.equal(countApprovalsFor(q, "/repo/b"), 1, "b 큐는 그대로");
});

test("peekApproval: 조회만 하고 큐를 변형하지 않는다(응답 전까지 화면에 계속 표시되는 계약)", () => {
  let q = createApprovalQueue();
  q = pushApproval(q, "/repo/a", { id: 1 });
  const before = countApprovalsFor(q, "/repo/a");
  peekApproval(q, "/repo/a");
  assert.equal(countApprovalsFor(q, "/repo/a"), before, "peek은 제거하지 않는다");
});

test("shiftApproval: 머리를 제거하고 다음 항목을 새 머리로 승격한다", () => {
  let q = createApprovalQueue();
  q = pushApproval(q, "/repo/a", { id: 1 });
  q = pushApproval(q, "/repo/a", { id: 2 });
  const r1 = shiftApproval(q, "/repo/a");
  assert.deepEqual(r1.removed, { id: 1 });
  assert.deepEqual(peekApproval(r1.queue, "/repo/a"), { id: 2 }, "다음 항목이 새 머리");
});

test("shiftApproval: 마지막 항목을 제거하면 해당 repoId 키가 사라진다(메모리 누적 방지)", () => {
  let q = createApprovalQueue();
  q = pushApproval(q, "/repo/a", { id: 1 });
  const { queue } = shiftApproval(q, "/repo/a");
  assert.equal(Object.prototype.hasOwnProperty.call(queue, "/repo/a"), false);
  assert.equal(countApprovalsFor(queue, "/repo/a"), 0);
});

test("shiftApproval: 빈 큐면 removed=null, queue는 동일 참조(불필요 갱신 없음)", () => {
  const q = createApprovalQueue();
  const r = shiftApproval(q, "/repo/a");
  assert.equal(r.removed, null);
  assert.equal(r.queue, q);
});

test("불변성 계약 — pushApproval/shiftApproval은 입력 큐를 변형하지 않는다", () => {
  let q = createApprovalQueue();
  q = pushApproval(q, "/repo/a", { id: "x" });
  const frozen = JSON.stringify(q);
  pushApproval(q, "/repo/a", { id: "y" });
  shiftApproval(q, "/repo/a");
  assert.equal(JSON.stringify(q), frozen);
});
