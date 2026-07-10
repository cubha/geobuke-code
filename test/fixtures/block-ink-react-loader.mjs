// tui-isolation 회귀락 전용 ESM 로더 — "ink"/"react" 스펙시파이어를 즉시 차단해
// 실제로 로드가 시도됐는지를 GBC_ISOLATION_VIOLATION 에러로 관측 가능하게 만든다.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "ink" || specifier === "react" || specifier.startsWith("ink/") || specifier.startsWith("react/")) {
    throw new Error(`GBC_ISOLATION_VIOLATION: blocked import of "${specifier}"`);
  }
  return nextResolve(specifier, context);
}
