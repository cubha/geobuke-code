// 0.9.0 A3a ST0 — import 누수 회귀락: "dist/cli.js 로드/일반 커맨드 실행 시 ink·react 미로드"를
// 기계적으로 단정한다. TUI는 dynamic import 경계 뒤(예: `./tui/app.js`)에 격리되어야 하며,
// cli.ts가 실수로 ink/react를 top-level(또는 다른 static import 체인)로 끌어오면 이 테스트가 깨진다.
//
// 기법: 커스텀 ESM 로더(block-ink-react-loader.mjs)가 "ink"/"react" 스펙시파이어 resolve를
// 즉시 에러로 차단한다. 이 로더 아래에서 일반 gbc 커맨드가 정상 종료하면 격리가 유지된 것.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const loader = fileURLToPath(new URL("./fixtures/block-ink-react-loader.mjs", import.meta.url));

function runUnderLoader(args) {
  return execFileSync(process.execPath, ["--experimental-loader", loader, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("포지티브 컨트롤: 로더가 ink 직접 import를 실제로 차단한다(테스트 무효화 방지)", () => {
  assert.throws(
    () => runUnderLoader(["-e", 'await import("ink")']),
    /GBC_ISOLATION_VIOLATION/,
    "로더 아래 ink import는 반드시 실패해야 이후 부정 검증이 유효함",
  );
});

test("포지티브 컨트롤: 로더가 react 직접 import를 실제로 차단한다", () => {
  assert.throws(
    () => runUnderLoader(["-e", 'await import("react")']),
    /GBC_ISOLATION_VIOLATION/,
  );
});

test("dist/cli.js help — ink/react 미로드로 정상 종료", () => {
  const out = runUnderLoader([cli, "help"]);
  assert.match(out, /gbc — 거북이코드/);
});

test("dist/cli.js tui(스텁) — ink/react 미로드로 정상 종료(ST0은 플레이스홀더, 아직 동적 import 없음)", () => {
  const out = runUnderLoader([cli, "tui"]);
  assert.match(out, /gbc tui/);
});
