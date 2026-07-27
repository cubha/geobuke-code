// 0.11.0 ST1-1 — src/tui/queue.ts 순수 repoId별 제출 대기열 단정.
// 배경(0.10.4 결함1과 동일 결함 클래스 재발 방지): 활성탭 가정으로 배경탭 데이터를 잃는 버그가
// 있었다 — 이 큐도 반드시 repoId별로 격리되어야 하며, 어떤 연산도 다른 repoId 키를 건드리지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSubmitQueue, enqueue, dequeueNext, clearRepo, countFor } from "../dist/tui/queue.js";

test("createSubmitQueue: 빈 큐로 시작", () => {
  const q = createSubmitQueue();
  assert.equal(countFor(q, "/repo/a"), 0);
});

test("enqueue: repoId별로 순서대로 쌓인다(FIFO)", () => {
  let q = createSubmitQueue();
  q = enqueue(q, "/repo/a", "첫번째");
  q = enqueue(q, "/repo/a", "두번째");
  assert.equal(countFor(q, "/repo/a"), 2);
  const r1 = dequeueNext(q, "/repo/a");
  assert.equal(r1.next.text, "첫번째");
  const r2 = dequeueNext(r1.queue, "/repo/a");
  assert.equal(r2.next.text, "두번째");
});

test("enqueue: 다른 repoId는 서로 격리된다(교차오염 없음)", () => {
  let q = createSubmitQueue();
  q = enqueue(q, "/repo/a", "a용");
  q = enqueue(q, "/repo/b", "b용");
  assert.equal(countFor(q, "/repo/a"), 1);
  assert.equal(countFor(q, "/repo/b"), 1);
  const { next } = dequeueNext(q, "/repo/a");
  assert.equal(next.text, "a용", "a를 꺼내도 b 큐는 무관");
  assert.equal(countFor(q, "/repo/b"), 1, "b 큐는 그대로");
});

test("dequeueNext: 빈 큐면 next=null, queue는 동일 참조(불필요 갱신 없음)", () => {
  const q = createSubmitQueue();
  const r = dequeueNext(q, "/repo/a");
  assert.equal(r.next, null);
  assert.equal(r.queue, q);
});

test("dequeueNext: 마지막 항목을 꺼내면 해당 repoId 키가 제거된다(메모리 누적 방지)", () => {
  let q = createSubmitQueue();
  q = enqueue(q, "/repo/a", "유일");
  const r = dequeueNext(q, "/repo/a");
  assert.equal(Object.prototype.hasOwnProperty.call(r.queue, "/repo/a"), false);
  assert.equal(countFor(r.queue, "/repo/a"), 0);
});

test("clearRepo: 지정 repoId만 비우고 다른 repoId는 보존", () => {
  let q = createSubmitQueue();
  q = enqueue(q, "/repo/a", "a1");
  q = enqueue(q, "/repo/a", "a2");
  q = enqueue(q, "/repo/b", "b1");
  q = clearRepo(q, "/repo/a");
  assert.equal(countFor(q, "/repo/a"), 0);
  assert.equal(countFor(q, "/repo/b"), 1, "b는 무관하게 보존");
});

test("clearRepo: 없는 repoId면 no-op(동일 참조 반환)", () => {
  const q = createSubmitQueue();
  assert.equal(clearRepo(q, "/repo/z"), q);
});

test("불변성 계약 — enqueue/dequeueNext/clearRepo는 입력 큐를 변형하지 않는다", () => {
  let q = createSubmitQueue();
  q = enqueue(q, "/repo/a", "x");
  const frozen = JSON.stringify(q);
  enqueue(q, "/repo/a", "y");
  dequeueNext(q, "/repo/a");
  clearRepo(q, "/repo/a");
  assert.equal(JSON.stringify(q), frozen);
});
