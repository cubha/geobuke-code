// detect→scaffold (0.6.0 ST-B+C) — 테스트 러너를 감지해 JUnit 리포터를 .gbc/verify-results.xml로
// 배선하는 안내/템플릿을 제공한다. 핵심 불변식 보존: gbc는 테스트를 *실행하지 않는다* — 여기서 하는
// 일은 ①러너 감지(package.json 판독) ②배선 명령/설정 *안내 출력* ③gbc 소유 디렉토리(.gbc/)에만
// 리포터 템플릿 기록. 사용자 파일(package.json·설정)은 절대 수정하지 않는다(비파괴).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gbcDir } from "./store.js";
import { JUNIT_DEFAULT_REL } from "./junit.js";

/** 감지 가능한 러너. node-test=스크립트에 node --test 존재, none=미감지(제로설치 폴백 대상). */
export type Runner = "vitest" | "jest" | "mocha" | "node-test" | "none";

/** package.json에서 감지에 쓰는 최소 형상. */
export interface PkgLike {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

/** 스캐폴딩 계획 — 순수 데이터(파일 기록은 scaffoldVerify가). rel은 .gbc/ 하위 고정 상수만. */
export interface ScaffoldPlan {
  runner: Runner;
  files: Array<{ rel: string; content: string }>;
  instructions: string[];
}

/** 리포터 템플릿 경로(.gbc 하위 고정 — 사용자 입력 유래 경로 없음). */
export const REPORTER_REL = join(".gbc", "junit-reporter.mjs");

/**
 * node:test 커스텀 리포터 템플릿 — 의존성 0(제로설치), Node 20+.
 * Node 21+ 내장 `--test-reporter=junit`이 있어도 이 템플릿은 버전 분기 없이 동작한다(단순 유지).
 * suite(describe) 완료 이벤트는 testcase가 아니므로 제외. 이름/메시지는 XML 이스케이프.
 */
export const JUNIT_REPORTER_TEMPLATE = `// .gbc/junit-reporter.mjs — gbc 제로설치 JUnit 리포터 (node:test 커스텀 리포터, 의존성 0)
// 사용: node --test --test-reporter=./.gbc/junit-reporter.mjs --test-reporter-destination=${JUNIT_DEFAULT_REL.replace(/\\/g, "/")}
// (gbc가 'gbc verify --init'으로 생성 — 재실행 시 덮어씀. 직접 수정하지 마세요.)
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
export default async function* junitReporter(source) {
  const cases = [];
  for await (const ev of source) {
    if (ev.type !== "test:pass" && ev.type !== "test:fail") continue;
    const d = ev.data ?? {};
    if (d.details && d.details.type === "suite") continue; // describe 블록은 testcase 아님
    const name = esc(d.name ?? "");
    if (ev.type === "test:fail") {
      const msg = esc((d.details && d.details.error && d.details.error.message) || "failed");
      cases.push('<testcase name="' + name + '"><failure message="' + msg + '"/></testcase>');
    } else if (d.skip) {
      cases.push('<testcase name="' + name + '"><skipped/></testcase>');
    } else {
      cases.push('<testcase name="' + name + '"/>');
    }
  }
  yield '<?xml version="1.0" encoding="utf-8"?>\\n<testsuite name="node:test">' + cases.join("") + "</testsuite>\\n";
}
`;

/**
 * package.json 형상에서 러너 감지. 우선순위 vitest>jest>mocha(전용 러너가 스크립트 관용구보다 강한
 * 신호) → scripts에 "node --test" → none. null(파일 부재)=none.
 */
export function detectRunner(pkg: PkgLike | null): Runner {
  if (!pkg) return "none";
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  if (deps["vitest"]) return "vitest";
  if (deps["jest"]) return "jest";
  if (deps["mocha"]) return "mocha";
  const scripts = Object.values(pkg.scripts ?? {}).join("\n");
  if (scripts.includes("node --test") || scripts.includes("node:test")) return "node-test";
  return "none";
}

/** 표준 결과 경로(안내문용, 슬래시 통일). */
const OUT = JUNIT_DEFAULT_REL.replace(/\\/g, "/");

/**
 * 러너별 배선 계획(순수) — files는 .gbc/ 하위 고정 상수 경로만, instructions는 사용자가 실행/추가할
 * 명령·설정 안내. jest/mocha는 JUnit 리포터가 내장이 아니라서 패키지 필요를 *정직하게* 안내한다
 * (조용히 npm install 하지 않음 — 사용자 의존성 트리를 gbc가 건드리지 않는다).
 */
export function buildScaffoldPlan(runner: Runner): ScaffoldPlan {
  switch (runner) {
    case "vitest":
      return {
        runner,
        files: [],
        instructions: [
          `vitest 감지 — JUnit 리포터 내장. 러너 실행을 다음으로 배선하세요:`,
          `  npx vitest run --reporter=default --reporter=junit --outputFile=${OUT}`,
          `  (또는 vitest.config의 test.reporters에 ['default', 'junit'] + outputFile 지정)`,
        ],
      };
    case "jest":
      return {
        runner,
        files: [],
        instructions: [
          `jest 감지 — jest는 JUnit 리포터가 내장이 아닙니다(jest-junit 설치 필요):`,
          `  npm i -D jest-junit`,
          `  JEST_JUNIT_OUTPUT_FILE=${OUT} npx jest --reporters=default --reporters=jest-junit`,
        ],
      };
    case "mocha":
      return {
        runner,
        files: [],
        instructions: [
          `mocha 감지 — mocha는 JUnit 리포터가 내장이 아닙니다(mocha-junit-reporter 설치 필요):`,
          `  npm i -D mocha-junit-reporter`,
          `  npx mocha --reporter mocha-junit-reporter --reporter-options mochaFile=${OUT}`,
        ],
      };
    case "node-test":
    case "none": {
      const head =
        runner === "node-test"
          ? `node:test 감지 — 제로설치 리포터 템플릿(${REPORTER_REL})을 생성했습니다. 실행 배선:`
          : `러너 미감지 — node:test 제로설치 폴백. 리포터 템플릿(${REPORTER_REL})을 생성했습니다. 실행 배선:`;
      const lines = [
        head,
        `  node --test --test-reporter=spec --test-reporter-destination=stdout \\`,
        `    --test-reporter=./.gbc/junit-reporter.mjs --test-reporter-destination=${OUT}`,
      ];
      if (runner === "none") {
        lines.push(`  (테스트가 아직 없다면 node:test로 시작 — test/*.test.mjs에 node:test 케이스 작성, 의존성 0)`);
      }
      return { runner, files: [{ rel: REPORTER_REL, content: JUNIT_REPORTER_TEMPLATE }], instructions: lines };
    }
  }
}

/**
 * cwd의 package.json을 판독해 계획을 수립하고, 계획된 파일을 기록한다.
 * 기록은 .gbc/ 하위 고정 경로만(gbc 소유 — 덮어쓰기 안전·idempotent). 사용자 파일 무수정.
 */
export function scaffoldVerify(cwd: string): ScaffoldPlan {
  let pkg: PkgLike | null = null;
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PkgLike;
    } catch {
      pkg = null; /* 깨진 package.json → 미감지와 동일 취급 */
    }
  }
  const plan = buildScaffoldPlan(detectRunner(pkg));
  gbcDir(cwd); // .gbc 보장
  for (const f of plan.files) {
    writeFileSync(join(cwd, f.rel), f.content, "utf8");
  }
  return plan;
}
