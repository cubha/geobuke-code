// extractCaseSymbols(2026-08-07, 게이트 오탐 RCA — P2b 근거주입 ST10). 한국어 명세 케이스 텍스트에서
// grep 가능한 ASCII 식별자/파일명 토큰을 추출한다. scope.ts의 extractSymbols는 *코드 본문*용
// 정규식이라 한국어 산문 명세 라인엔 무력(코드 정의 패턴 `function foo(`가 안 나옴) — 별도 함수.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCaseSymbols, collectCaseEvidence, formatEvidenceContext, computeDeletionScope, MAX_EVIDENCE_CONTEXT_CHARS } from "../dist/evidence.js";
import { GREP_INCLUDE_EXTS, GREP_TIMEOUT_MS } from "../dist/scope.js";
import { resolve } from "node:path";
import { EVIDENCE_TIME_BUDGET_MS } from "../dist/evidence.js";

// 드리프트 락(0.12.0 F-4, gbc Stop 훅 scope 판정 rung2 "중복 존재" 반영) — 근거수집기가 심볼로
// 내보내는 확장자 집합과 realGrep이 실제로 스캔하는 --include 목록은 **같은 소스**여야 한다.
// 두 곳에 각자 하드코딩하면 어긋나는 순간 "뽑았는데 절대 안 맞는 심볼"이 예산만 먹는다.
test("드리프트 락: realGrep --include 확장자는 전부 파일명 심볼로 추출된다", () => {
  for (const ext of GREP_INCLUDE_EXTS) {
    const syms = extractCaseSymbols(`sample.${ext} 파일을 수정`);
    assert.ok(syms.includes(`sample.${ext}`), `.${ext}가 추출되지 않음: ${JSON.stringify(syms)}`);
  }
});

test("드리프트 락: --include 밖 확장자는 하나도 추출되지 않는다", () => {
  const outside = ["py", "go", "rs", "java", "rb", "php", "cpp", "cs", "kt", "swift", "json", "css", "html", "md", "mjs", "cjs"]
    .filter((e) => !GREP_INCLUDE_EXTS.includes(e));
  for (const ext of outside) {
    const syms = extractCaseSymbols(`sample.${ext} 파일을 수정`);
    assert.deepEqual(syms, [], `.${ext}가 새어나옴: ${JSON.stringify(syms)}`);
  }
});

test("실측 RCA 사례 1: 파일명 토큰 추출 — '기존 설치에 이미 평문 저장된 API 키를 DB 마이그레이션으로 제거한다'류에서 metaCrypto.ts", () => {
  const syms = extractCaseSymbols("metaCrypto.ts 구현을 전제하지만 해당 핵심 구현 파일과 동기화 시점 처리가 안 됨");
  assert.ok(syms.includes("metaCrypto.ts"), `추출: ${JSON.stringify(syms)}`);
});

test("실측 RCA 사례 2: 식별자 토큰 추출 — 'ensureFolderPath 비교 로직'에서 ensureFolderPath", () => {
  const syms = extractCaseSymbols("ensureFolderPath 비교 로직은 이 편집에서 다뤄지지 않음");
  assert.ok(syms.includes("ensureFolderPath"), `추출: ${JSON.stringify(syms)}`);
});

test("한국어 조사가 붙은 식별자도 토큰 경계에서 올바르게 분리(validateLogin이지 validateLogin은/를 아님)", () => {
  const syms = extractCaseSymbols("validateLogin을 호출하는 곳에서 에러메시지 표시");
  assert.ok(syms.includes("validateLogin"));
  assert.ok(!syms.some((s) => s.includes("을")), "조사가 토큰에 섞이면 grep 매치가 실패한다");
});

test("3자 미만 식별자는 제외(노이즈 억제, scope.ts extractSymbols와 동일 규율)", () => {
  const syms = extractCaseSymbols("ID 값과 pw 필드를 검증");
  assert.ok(!syms.includes("ID"));
  assert.ok(!syms.includes("pw"));
});

test("scope.ts IDENT_KEYWORDS 예약어는 제외(공용 불용어 집합 재사용)", () => {
  const syms = extractCaseSymbols("이 함수는 return 문과 export 키워드를 포함한 함수를 정의한다");
  assert.ok(!syms.includes("return"));
  assert.ok(!syms.includes("export"));
});

test("순수 한국어 텍스트만 있으면 빈 배열(ASCII 토큰 없음)", () => {
  const syms = extractCaseSymbols("빈 이메일이면 에러를 반환한다");
  assert.deepEqual(syms, []);
});

test("중복 토큰은 한 번만(dedup)", () => {
  const syms = extractCaseSymbols("validateLogin 함수와 validateLogin 호출부");
  assert.equal(syms.filter((s) => s === "validateLogin").length, 1);
});

test("케이스당 상한 적용 — 과다 심볼로 grep 폭주 방지", () => {
  const many = Array.from({ length: 20 }, (_, i) => `symbolName${i}`).join(" 그리고 ");
  const syms = extractCaseSymbols(many);
  assert.ok(syms.length <= 5, `상한 초과: ${syms.length}건`);
});

test("같은 파일명이 텍스트에 두 번 나와도 둘 다 마스킹돼 부분매치가 새지 않는다(scope-critic 실측 지적 회귀락)", () => {
  const syms = extractCaseSymbols("metaCrypto.ts 구현을 전제하지만 metaCrypto.ts 테스트가 없음");
  assert.ok(syms.includes("metaCrypto.ts"));
  assert.ok(!syms.includes("metaCrypto"), `파일명 부분매치가 새면 안 됨: ${JSON.stringify(syms)}`);
  assert.equal(syms.filter((s) => s === "metaCrypto.ts").length, 1, "dedup도 유지");
});

// ⚠️ 계약 변경(0.12.0 F-4, 2026-08-09) — 이전 판: "auth.py·config.json도 심볼로 추출한다".
// 그런데 scope.ts realGrep의 --include는 *.ts/*.js/*.tsx/*.jsx 4종뿐이라(scope.ts:193) 그 밖의
// 확장자 토큰은 **어떤 경우에도 매치가 나올 수 없고** grep 예산(MAX_GREP_SYMBOLS=8)만 소모했다.
// 예산이 정작 매치 가능한 심볼에 닿기 전에 소진되는 문제(ANALYSIS F-4·F-14). 마스킹은 그대로
// 유지한다 — basename("auth"·"config")이 일반 식별자로 새어나가면 무관한 매치를 근거로 올린다.
test("파일명 토큰: grep 대상 확장자(ts/tsx/js/jsx)만 심볼로 추출한다", () => {
  const syms = extractCaseSymbols("auth.py와 Header.tsx, config.json을 함께 수정");
  assert.ok(syms.includes("Header.tsx"), `추출: ${JSON.stringify(syms)}`);
  assert.ok(!syms.includes("auth.py"), "grep --include 밖 확장자는 예산을 쓰지 않는다");
  assert.ok(!syms.includes("config.json"), "grep --include 밖 확장자는 예산을 쓰지 않는다");
});

test("파일명 토큰: grep 대상 밖 확장자도 마스킹은 유지 — basename이 일반 식별자로 새지 않는다", () => {
  const syms = extractCaseSymbols("auth.py와 config.json을 함께 수정");
  assert.ok(!syms.includes("auth"), `basename 누수: ${JSON.stringify(syms)}`);
  assert.ok(!syms.includes("config"), `basename 누수: ${JSON.stringify(syms)}`);
  assert.deepEqual(syms, [], "매치 불가능한 파일명뿐이면 심볼 0건");
});

test("파일명 토큰: mjs/cjs도 realGrep --include 밖이므로 제외", () => {
  const syms = extractCaseSymbols("server.mjs와 legacy.cjs 처리");
  assert.deepEqual(syms, [], `추출: ${JSON.stringify(syms)}`);
});

test("입력 순서를 보존한다(먼저 등장한 토큰이 앞에 옴 — 관련성 높은 앞쪽 문맥 우선)", () => {
  const syms = extractCaseSymbols("firstSymbol 다음 secondSymbol");
  const i1 = syms.indexOf("firstSymbol");
  const i2 = syms.indexOf("secondSymbol");
  assert.ok(i1 !== -1 && i2 !== -1 && i1 < i2);
});

// ===== collectCaseEvidence (ST11 — self-file 포함 근거수집기) =====

function fakeGrep(table) {
  const calls = [];
  const fn = async (symbol, cwd) => {
    calls.push({ symbol, cwd });
    return table[symbol] ?? "";
  };
  return { fn, calls };
}

test("매치가 있으면 context에 포맷돼 담기고 matched=true", async () => {
  const g = fakeGrep({ metaCrypto: "src/auth.ts:42: function metaCrypto() { /* impl */ }" });
  const [ev] = await collectCaseEvidence("/repo", ["metaCrypto 구현"], { grep: g.fn });
  assert.equal(ev.case, "metaCrypto 구현");
  assert.equal(ev.matched, true);
  assert.match(ev.context, /src\/auth\.ts:42/);
});

test("매치가 없으면 context=''·matched=false — ST12가 이걸로 재판정 생략을 결정한다", async () => {
  const g = fakeGrep({});
  const [ev] = await collectCaseEvidence("/repo", ["존재하지않는케이스"], { grep: g.fn });
  assert.equal(ev.context, "");
  assert.equal(ev.matched, false);
});

test("self-file 포함 — scope.ts collectGrepContext와 달리 자기 파일 매치도 결과에 남는다(필터 없음)", async () => {
  // grep 실행자는 파일 구분 없이 raw 텍스트만 준다 — 이 함수가 자기파일을 걸러내지 *않는다*는 것은
  // "필터링 코드가 아예 없다"는 것으로 증명된다(scope.ts처럼 canonicalPath 비교로 제외하는 로직 부재).
  const g = fakeGrep({ ensureFolderPath: "src/target.ts:99: function ensureFolderPath() {}" });
  const [ev] = await collectCaseEvidence("/repo", ["ensureFolderPath 비교"], { grep: g.fn });
  assert.match(ev.context, /src\/target\.ts:99/, "자기 파일이어도 매치가 그대로 남아야 함");
});

test("grep 총 예산(MAX_GREP_SYMBOLS=8)을 여러 missing 케이스에 걸쳐 공유한다 — 무한정 커지지 않음", async () => {
  const g = fakeGrep(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`symbolName${i}`, `f.ts:1: ${i}`])));
  // 케이스 20개, 각 케이스가 서로 다른 심볼 1개씩 요구 → 실제 grep 호출은 8회를 넘지 않아야 함.
  const missing = Array.from({ length: 20 }, (_, i) => `symbolName${i} 관련 케이스`);
  await collectCaseEvidence("/repo", missing, { grep: g.fn });
  assert.ok(g.calls.length <= 8, `grep 호출 ${g.calls.length}회 — 예산(8) 초과`);
});

test("같은 심볼이 여러 케이스에 걸쳐 나오면 grep은 한 번만 돌고 캐시가 양쪽에 기여한다(예산 절약+정확성)", async () => {
  const g = fakeGrep({ sharedSymbol: "f.ts:1: shared impl" });
  const [ev1, ev2] = await collectCaseEvidence(
    "/repo",
    ["sharedSymbol 케이스1", "sharedSymbol 케이스2"],
    { grep: g.fn },
  );
  assert.equal(g.calls.length, 1, "같은 심볼은 grep 1회만");
  assert.equal(ev1.matched, true);
  assert.equal(ev2.matched, true, "캐시된 결과가 두 번째 케이스에도 기여해야 함");
});

// ── F-14(0.12.0): 예산 소진과 "근거 없음"을 구분한다 ──
// 예산이 떨어져 조회조차 못 한 케이스도 matched=false로 마감되어, 기록상 "grep했는데 매치 없음"과
// 완전히 동일했다. 소진 순서는 missing[] 배열 순서(= 모델의 자유서술 출력 순서)에 좌우돼
// 결정론적이지 않으므로, 사후에 "근거가 진짜 없어서 block 유지"와 "못 봤다"를 구분할 수 없었다.

test("예산 소진으로 조회 못 한 케이스는 budgetSkipped=true로 표시된다", async () => {
  const g = fakeGrep(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`symbolName${i}`, `f.ts:1: ${i}`])));
  const missing = Array.from({ length: 20 }, (_, i) => `symbolName${i} 관련 케이스`);
  const evs = await collectCaseEvidence("/repo", missing, { grep: g.fn });
  assert.ok(g.calls.length <= 8, "예산 자체는 여전히 지켜져야 함");
  assert.ok(evs.some((e) => e.budgetSkipped), "뒤쪽 케이스는 예산 소진으로 스킵됐어야 함");
  assert.equal(evs[0].budgetSkipped, false, "앞쪽 케이스는 예산 내에서 정상 조회");
});

test("예산 내에서 전부 조회했으면 budgetSkipped=false — 매치가 없어도 '근거 없음'이지 '못 봄'이 아니다", async () => {
  const g = fakeGrep({});
  const evs = await collectCaseEvidence("/repo", ["alphaSymbol 케이스", "betaSymbol 케이스"], { grep: g.fn });
  assert.deepEqual(evs.map((e) => e.matched), [false, false]);
  assert.deepEqual(evs.map((e) => e.budgetSkipped), [false, false]);
});

// ── F-9(0.12.0): evidenceContext 총량 상한 ──
// formatGrepContext는 **케이스 1건당** MAX_SCOPE_CONTEXT_CHARS(4000)로 캡하지만, 케이스별 결과를
// 이어붙이는 지점에는 총량 캡이 없었다. missing에는 개수 제한이 없고(judge parseVerdict), 심볼
// 캐시 때문에 여러 케이스가 같은 매치 목록을 **복제**해 갖는다 — 10건이면 최대 40KB가 2차
// 프롬프트에 실린다([현재 파일 상태] 예산 8000자의 5배). 이 릴리스가 다루는 RCA 주제가 정확히
// "프롬프트 예산과 절단"인데 그 문제를 신설 경로에서 재도입한 셈이었다.

const ev = (name, body) => ({ case: name, context: body, matched: true, budgetSkipped: false });

test("총량 상한 이내면 전부 담고 케이스 구분을 유지한다", () => {
  const { text, dropped } = formatEvidenceContext([ev("케이스 A", "a.ts:1: alpha"), ev("케이스 B", "b.ts:2: beta")]);
  assert.match(text, /케이스: 케이스 A\na\.ts:1: alpha/);
  assert.match(text, /케이스: 케이스 B\nb\.ts:2: beta/);
  assert.ok(text.length <= MAX_EVIDENCE_CONTEXT_CHARS);
  assert.equal(dropped, 0);
});

test("총량 상한을 넘으면 앞쪽 케이스만 담고 생략 건수를 반환·표기한다", () => {
  const big = "x.ts:1: " + "가".repeat(3000);
  const many = Array.from({ length: 10 }, (_, i) => ev(`케이스 ${i}`, big));
  const { text, dropped } = formatEvidenceContext(many);
  assert.ok(text.length <= MAX_EVIDENCE_CONTEXT_CHARS + big.length, `상한 초과: ${text.length}자`);
  assert.match(text, /케이스: 케이스 0/, "앞쪽은 보존");
  assert.ok(!text.includes("케이스: 케이스 9"), "뒤쪽은 버려져야 함");
  assert.match(text, /생략/, "모델이 '근거 없음'과 '근거 잘림'을 구분할 수 있어야 한다");
  assert.ok(dropped > 0, "생략 건수는 이벤트 계측용으로도 반환돼야 한다(marker 텍스트에만 두지 않음)");
});

test("첫 케이스 하나만으로 상한을 넘겨도 최소 1건은 담는다(근거 0이면 재판정이 무의미)", () => {
  const huge = "x.ts:1: " + "나".repeat(MAX_EVIDENCE_CONTEXT_CHARS + 500);
  const { text } = formatEvidenceContext([ev("거대 케이스", huge)]);
  assert.match(text, /케이스: 거대 케이스/);
});

// judge parseVerdict는 `j.missing.map(String)`으로 길이 제한 없이 문자열화한다 — 모델이 장문을
// 반환하면 케이스 라벨만으로 상한을 넘길 수 있고, 위 "첫 1건은 무조건" 예외와 결합하면 선언한
// 상한이 무의미해진다(scope-critic 실측 지적, 2026-08-09).
test("케이스 라벨이 길면 잘라낸다 — '첫 1건 예외'가 상한 돌파 통로가 되지 않게", () => {
  const longLabel = "가".repeat(5000);
  const { text } = formatEvidenceContext([ev(longLabel, "x.ts:1: impl")]);
  assert.ok(text.length < 1000, `라벨이 안 잘림: ${text.length}자`);
  assert.match(text, /…/, "잘렸다는 표시가 있어야 한다");
  assert.match(text, /x\.ts:1: impl/, "근거 본문은 보존");
});

test("빈 배열이면 빈 문자열 + dropped 0(재판정 자체가 생략되는 경로와 정합)", () => {
  assert.deepEqual(formatEvidenceContext([]), { text: "", dropped: 0 });
});

test("missing 빈 배열이면 빈 결과", async () => {
  const g = fakeGrep({});
  const evs = await collectCaseEvidence("/repo", [], { grep: g.fn });
  assert.deepEqual(evs, []);
  assert.equal(g.calls.length, 0);
});

// ── F-8(0.12.0): 이번 편집이 *삭제하는* 코드를 근거로 올리지 않는다 ──
// P2b는 편집이 적용되기 *전*의 파일을 grep한다. Write(전체 덮어쓰기)는 gate-core가 아예 억제하지만
// (isOverwriteEdit), Edit/MultiEdit이 케이스 구현 코드를 **지우는** 편집일 때는 그 코드가 여전히
// 디스크에 있어 "이미 구현됨"으로 근거에 실린다 — GATE_SYSTEM ★★(덮어쓰기로 삭제되는 회귀는 여전히
// missing)와 정면 충돌하며, 정답인 block을 근거로 pass 논증하게 만든다. Write 억제와 대칭인 가드.

test("computeDeletionScope: Edit이 지우는 줄은 삭제 범위에 들어간다", () => {
  const content = ["const a = 1;", "function ensureFolderPath() {", "  return 1;", "}", "const b = 2;"].join("\n");
  const scope = computeDeletionScope("/repo", "/repo/src/target.ts", content, [
    { old_string: "function ensureFolderPath() {\n  return 1;\n}", new_string: "" },
  ]);
  assert.ok(scope, "삭제 범위가 산출돼야 함");
  // 키는 canonicalPath 기준(심링크 해소된 절대경로) — 존재하지 않는 경로면 resolve 결과로 폴백.
  assert.equal(scope.file, resolve("/repo", "src/target.ts"));
  assert.deepEqual([...scope.lines].sort((x, y) => x - y), [2, 3, 4]);
});

test("computeDeletionScope: new_string에 그대로 살아남는 줄은 삭제로 치지 않는다(수정·삽입은 근거 유지)", () => {
  const content = ["function ensureFolderPath() {", "  return 1;", "}"].join("\n");
  const scope = computeDeletionScope("/repo", "/repo/src/target.ts", content, [
    { old_string: "function ensureFolderPath() {\n  return 1;\n}", new_string: "function ensureFolderPath() {\n  log();\n  return 1;\n}" },
  ]);
  assert.deepEqual([...scope.lines], [], "본문이 보존되는 편집은 삭제 범위 0");
});

test("computeDeletionScope: old_string이 없으면(신규 Write류) null — Write 억제가 이미 담당", () => {
  assert.equal(computeDeletionScope("/repo", "/repo/src/target.ts", "x", []), null);
});

test("computeDeletionScope: MultiEdit은 모든 편집의 삭제 범위를 합친다", () => {
  const content = ["alpha();", "beta();", "gamma();", "delta();"].join("\n");
  const scope = computeDeletionScope("/repo", "/repo/src/target.ts", content, [
    { old_string: "alpha();", new_string: "" },
    { old_string: "gamma();", new_string: "" },
  ]);
  assert.deepEqual([...scope.lines].sort((x, y) => x - y), [1, 3]);
});

test("collectCaseEvidence: 이번 편집이 지우는 self-file 매치는 근거에서 제외된다(정당한 block 유지)", async () => {
  const content = ["const a = 1;", "function ensureFolderPath() {}", "const b = 2;"].join("\n");
  const deletion = computeDeletionScope("/repo", "/repo/src/target.ts", content, [
    { old_string: "function ensureFolderPath() {}", new_string: "" },
  ]);
  const g = fakeGrep({ ensureFolderPath: "./src/target.ts:2: function ensureFolderPath() {}" });
  const [ev] = await collectCaseEvidence("/repo", ["ensureFolderPath 비교 로직"], { grep: g.fn, deletion });
  assert.equal(ev.matched, false, "삭제될 코드가 '이미 구현됨' 근거로 남으면 안 됨");
  assert.equal(ev.context, "");
});

test("collectCaseEvidence: 같은 파일이라도 삭제 범위 밖 매치는 근거로 남는다(과잉 억제 금지)", async () => {
  const content = ["function ensureFolderPath() {}", "helperCall();"].join("\n");
  const deletion = computeDeletionScope("/repo", "/repo/src/target.ts", content, [
    { old_string: "helperCall();", new_string: "" },
  ]);
  const g = fakeGrep({ ensureFolderPath: "./src/target.ts:1: function ensureFolderPath() {}" });
  const [ev] = await collectCaseEvidence("/repo", ["ensureFolderPath 비교 로직"], { grep: g.fn, deletion });
  assert.equal(ev.matched, true);
  assert.match(ev.context, /src\/target\.ts:1/);
});

test("collectCaseEvidence: 타 파일 매치는 줄번호가 겹쳐도 제외되지 않는다(self-file 한정 가드)", async () => {
  const content = ["function ensureFolderPath() {}"].join("\n");
  const deletion = computeDeletionScope("/repo", "/repo/src/target.ts", content, [
    { old_string: "function ensureFolderPath() {}", new_string: "" },
  ]);
  const g = fakeGrep({ ensureFolderPath: "./src/other.ts:1: function ensureFolderPath() {}" });
  const [ev] = await collectCaseEvidence("/repo", ["ensureFolderPath 비교 로직"], { grep: g.fn, deletion });
  assert.equal(ev.matched, true, "타 파일의 기구현은 여전히 정당한 근거");
});

test("collectCaseEvidence: deletion 미지정이면 기존 동작 그대로(전부 근거로 남음)", async () => {
  const g = fakeGrep({ ensureFolderPath: "./src/target.ts:2: function ensureFolderPath() {}" });
  const [ev] = await collectCaseEvidence("/repo", ["ensureFolderPath 비교"], { grep: g.fn });
  assert.equal(ev.matched, true);
});

// ── F-5(0.12.0): 근거수집은 벽시계 예산 안에서 끝난다 ──
// 심볼 개수 예산(MAX_GREP_SYMBOLS=8)만으로는 지연이 유계가 아니다: realGrep 1회가
// GREP_TIMEOUT_MS(4000) 가까이 걸릴 수 있어 최악 8회 = 32초, 그 뒤에 2차 judge 호출까지 붙는다.
// PreToolUse는 사용자의 편집을 붙잡고 있는 hot path다 — 개수가 아니라 **시간**을 캡해야 한다.

test("시간 예산을 넘기면 남은 심볼은 조회하지 않고 budgetSkipped로 마감한다", async () => {
  const g = fakeGrep(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`symbolName${i}`, `f.ts:1: ${i}`])));
  let clock = 0;
  const missing = Array.from({ length: 8 }, (_, i) => `symbolName${i} 관련 케이스`);
  const evs = await collectCaseEvidence("/repo", missing, {
    grep: async (...a) => {
      clock += 3000; // grep 1회가 3초씩 걸리는 상황
      return g.fn(...a);
    },
    now: () => clock,
  });
  assert.ok(g.calls.length < 8, `시간 예산 무시하고 ${g.calls.length}회 grep — 유계가 아님`);
  assert.ok(evs.some((e) => e.budgetSkipped), "시간 소진으로 못 본 케이스가 표시돼야 함");
});

test("시간 예산 내에서는 개수 예산까지 정상 조회한다(과잉 억제 금지)", async () => {
  const g = fakeGrep(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`symbolName${i}`, `f.ts:1: ${i}`])));
  const missing = Array.from({ length: 8 }, (_, i) => `symbolName${i} 관련 케이스`);
  const evs = await collectCaseEvidence("/repo", missing, { grep: g.fn, now: () => 0 });
  assert.equal(g.calls.length, 8, "빠른 grep은 개수 예산(8)까지 다 써야 함");
  assert.ok(evs.every((e) => e.budgetSkipped === false));
});

test("첫 조회는 예산 검사보다 앞선다 — 한 번도 못 보고 끝나면 재판정 자체가 무의미해진다", async () => {
  const g = fakeGrep({ alphaSymbol: "f.ts:1: impl", betaSymbol: "f.ts:2: impl" });
  let clock = 0;
  const evs = await collectCaseEvidence("/repo", ["alphaSymbol 케이스", "betaSymbol 케이스"], {
    grep: async (...a) => {
      clock += 99_999; // 첫 grep 한 번으로 예산을 통째로 소진
      return g.fn(...a);
    },
    now: () => clock,
  });
  assert.equal(g.calls.length, 1, "첫 조회는 반드시 수행");
  assert.equal(evs[0].matched, true, "첫 케이스는 근거를 얻는다");
  assert.equal(evs[1].budgetSkipped, true, "예산 소진 후는 조회 없이 표시만");
});

// ── ST5 critic 실측 지적(2026-08-09): 선언한 예산과 실제 상한이 달랐다 ──
// 검사는 grep 호출 *전*에만 있어, 경계 직전에 시작한 grep이 GREP_TIMEOUT_MS(4000)만큼 더 돌 수
// 있었다 → 실제 하드 상한 = 8000+4000 = 12초. critic의 제안(검사를 호출 *직후*로 이동)은 이미
// 시작된 grep을 못 멈추므로 상한을 그대로 둔다 — 실제 해법은 "남은 예산이 grep 1회 최악값보다
// 작으면 아예 시작하지 않는" 것이다. 그래야 선언값이 진짜 상한이 된다.

test("남은 예산이 grep 1회 최악값보다 작으면 새 grep을 시작하지 않는다(선언값=진짜 상한)", async () => {
  const g = fakeGrep(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`symbolName${i}`, `f.ts:1: ${i}`])));
  let clock = 0;
  const missing = Array.from({ length: 8 }, (_, i) => `symbolName${i} 관련 케이스`);
  await collectCaseEvidence("/repo", missing, {
    grep: async (...a) => {
      clock += 3000;
      return g.fn(...a);
    },
    now: () => clock,
  });
  // 시작 허용창 = 8000-4000 = 4000ms → 0ms·3000ms 두 번만 시작 가능(6000ms에선 초과).
  assert.equal(g.calls.length, 2, `시작 ${g.calls.length}회 — 남은 예산 검사가 없다`);
  assert.ok(clock + GREP_TIMEOUT_MS <= EVIDENCE_TIME_BUDGET_MS + 3000, "최악값이 선언 예산을 넘지 않아야 함");
});

test("예산 소진 사유를 개수/시간으로 구분해 기록한다(개수 소진 → count)", async () => {
  const g = fakeGrep(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`symbolName${i}`, `f.ts:1: ${i}`])));
  const missing = Array.from({ length: 20 }, (_, i) => `symbolName${i} 관련 케이스`);
  const evs = await collectCaseEvidence("/repo", missing, { grep: g.fn, now: () => 0 });
  const skipped = evs.find((e) => e.budgetSkipped);
  assert.ok(skipped, "개수 예산으로 스킵된 케이스가 있어야 함");
  assert.equal(skipped.budgetSkipReason, "count");
});

test("예산 소진 사유를 개수/시간으로 구분해 기록한다(시간 소진 → time)", async () => {
  const g = fakeGrep(Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`symbolName${i}`, `f.ts:1: ${i}`])));
  let clock = 0;
  const missing = Array.from({ length: 4 }, (_, i) => `symbolName${i} 관련 케이스`);
  const evs = await collectCaseEvidence("/repo", missing, {
    grep: async (...a) => {
      clock += 5000;
      return g.fn(...a);
    },
    now: () => clock,
  });
  const skipped = evs.find((e) => e.budgetSkipped);
  assert.ok(skipped, "시간 예산으로 스킵된 케이스가 있어야 함");
  assert.equal(skipped.budgetSkipReason, "time", "개수(8)는 아직 안 썼으므로 시간 사유여야 함");
});

test("예산 안에서 정상 조회한 케이스는 사유가 없다", async () => {
  const g = fakeGrep({ alphaSymbol: "f.ts:1: impl" });
  const [ev] = await collectCaseEvidence("/repo", ["alphaSymbol 케이스"], { grep: g.fn, now: () => 0 });
  assert.equal(ev.budgetSkipped, false);
  assert.equal(ev.budgetSkipReason, undefined);
});

// ── security-auditor 실측 지적(2026-08-09): relKey가 canonicalPath의 심링크 방어를 안 물려받았다 ──
// scope.ts의 canonicalPath는 0.6.1 R2에서 realpathSync를 넣어 자기파일 비교 오분류를 막았는데,
// 같은 목적(편집 대상 vs grep 매치 대조)의 relKey는 순수 lexical 비교였다. grep(`-r`)은 디렉터리
// 심링크를 따라가지 않아 **실경로**를 보고하므로, 편집 경로가 심링크를 경유하면 키가 어긋나
// "이번 편집이 지우는 줄"이 안 걸러지고 근거로 남는다 → block→pass 오판. 이 함수 자신의 설계
// 원칙("경계선에서는 억제 쪽으로 기운다")과 반대 방향의 실패라 반드시 막아야 한다.

test("심링크 경유 편집 경로도 grep 실경로와 같은 키로 대조된다(F-8 가드 fail-open 방지)", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gbc-evidence-")));
  try {
    mkdirSync(join(root, "real"));
    const content = "function login() { /* 케이스 A */ }\n";
    writeFileSync(join(root, "real", "target.ts"), content);
    symlinkSync(join(root, "real"), join(root, "linked"), "dir");
    // 편집 경로는 심링크 경유, grep 출력은 실경로 — 예전 lexical 비교면 서로 다른 키가 된다.
    const deletion = computeDeletionScope(root, join(root, "linked", "target.ts"), content, [
      { old_string: "function login() { /* 케이스 A */ }", new_string: "" },
    ]);
    const g = fakeGrep({ login: "./real/target.ts:1: function login() { /* 케이스 A */ }" });
    const [ev] = await collectCaseEvidence(root, ["login 케이스 A 검증"], { grep: g.fn, deletion });
    assert.equal(ev.matched, false, "심링크 경유라고 삭제될 코드가 근거로 새면 안 된다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("근거 조립 시 시크릿을 마스킹한다 — grep 범위가 저장소 전역이라 노출면이 넓다", () => {
  const { text } = formatEvidenceContext([
    { case: "apiKey 저장", context: 'src/config.ts:3: const apiKey = "sk-ant-abcdefgh12345678";', matched: true, budgetSkipped: false },
  ]);
  assert.ok(!text.includes("sk-ant-abcdefgh12345678"), `시크릿이 프롬프트·골든에 그대로 실림: ${text}`);
  assert.match(text, /src\/config\.ts:3/, "근거 자체는 보존");
});
