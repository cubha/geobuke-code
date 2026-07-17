// 0.10.0 A3b ST1 — repoId 키 탭 레지스트리(순수, 렌더-비의존).
// TuiState(model.ts)는 "현재 포커스된 탭의 라이브 뷰"(approval/streaming/gateStatus)를 그대로
// 표현하고 무변경으로 둔다 — 이 모듈은 그 위에 얹히는 별도 상태로, "탭이 몇 개 있고 각각 지금
// 뭘 하고 있나"만 추적한다. 두 상태를 하나로 합치지 않는 이유: TuiState를 탭별로 쪼개면(R1이
// 우려한 "핵심 리팩터") approval 큐·워치독 등 기존 검증된 흐름 전체를 다시 검증해야 한다 —
// 레지스트리를 분리하면 기존 reducer는 그대로 두고 "다른 탭 상태를 안 보고 안 건드린다"는
// 오염 차단 요구를 구조적으로 만족시킨다(각 탭 갱신이 다른 탭 키에 물리적으로 닿지 않음).

export type TabStatus = "streaming" | "awaiting-approval" | "alive" | "no-session" | "dead";

export interface TabState {
  repoId: string;
  status: TabStatus;
  sessionId: string | null;
  lastActivityAt: number;
}

export interface TabRegistry {
  activeTabId: string;
  tabs: Record<string, TabState>;
}

function makeTab(repoId: string): TabState {
  return { repoId, status: "no-session", sessionId: null, lastActivityAt: 0 };
}

/**
 * 상태 다이어그램(scope-critic 지적, ST1 확장) — no-session은 lazy spawn으로만 시작하고,
 * streaming↔awaiting-approval은 승인 왕복, alive는 턴 종료 후 세션 유휴, dead는 언제든 도달
 * 가능하되(onEnded는 어느 상태에서든 올 수 있음) 오직 streaming으로만 재진입(respawn)한다 —
 * "죽은 탭이 승인대기 상태로 곧장 부활"하는 등 앱 레벨에서 판단 불가능한 전이를 여기서 차단.
 */
const TRANSITIONS: Record<TabStatus, readonly TabStatus[]> = {
  "no-session": ["streaming"],
  streaming: ["awaiting-approval", "alive", "dead"],
  "awaiting-approval": ["streaming", "dead"],
  alive: ["streaming", "dead"],
  dead: ["streaming"],
};

export function isValidTransition(from: TabStatus, to: TabStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function createTabRegistry(initialRepoId: string): TabRegistry {
  return { activeTabId: initialRepoId, tabs: { [initialRepoId]: makeTab(initialRepoId) } };
}

/** 탭 opt-in(존재하면 no-op, 동일 참조 반환 — 불필요한 리렌더 방지). 포커스는 이동하지 않는다. */
export function ensureTab(registry: TabRegistry, repoId: string): TabRegistry {
  if (registry.tabs[repoId]) return registry;
  return { ...registry, tabs: { ...registry.tabs, [repoId]: makeTab(repoId) } };
}

/** 탭 opt-out. 유일 탭이면 no-op(항상 최소 1탭 유지 — 사이드바가 빈 상태가 되지 않도록). */
export function removeTab(registry: TabRegistry, repoId: string): TabRegistry {
  const ids = Object.keys(registry.tabs);
  if (ids.length <= 1 || !registry.tabs[repoId]) return registry;
  const tabs = { ...registry.tabs };
  delete tabs[repoId];
  const activeTabId = registry.activeTabId === repoId ? Object.keys(tabs)[0] : registry.activeTabId;
  return { activeTabId, tabs };
}

/** 포커스 전환. 미등록 repoId로의 전환은 no-op(존재하지 않는 탭으로 렌더 시도 방지). */
export function setActiveTab(registry: TabRegistry, repoId: string): TabRegistry {
  if (!registry.tabs[repoId] || registry.activeTabId === repoId) return registry;
  return { ...registry, activeTabId: repoId };
}

/**
 * 지정 탭만 부분 갱신 — 다른 탭 키는 물리적으로 손대지 않는다(교차오염 차단의 자료구조적 근거).
 * patch.status가 있으면 TRANSITIONS를 벗어난 전이는 no-op으로 거부한다(방어). dead·no-session으로
 * 전이하는 patch는 sessionId를 무조건 null로 강제 정리한다 — 호출측이 sessionId를 깜빡 남겨도
 * "죽었는데 세션ID는 살아있다"는 모호한 상태가 구조적으로 생기지 않는다(scope-critic 지적).
 */
export function updateTabStatus(registry: TabRegistry, repoId: string, patch: Partial<TabState>): TabRegistry {
  const existing = registry.tabs[repoId];
  if (!existing) return registry;
  if (patch.status && !isValidTransition(existing.status, patch.status)) return registry;
  const next = { ...existing, ...patch };
  if (next.status === "dead" || next.status === "no-session") next.sessionId = null;
  return { ...registry, tabs: { ...registry.tabs, [repoId]: next } };
}

export function getActiveTab(registry: TabRegistry): TabState {
  return registry.tabs[registry.activeTabId];
}
