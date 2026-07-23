// 0.10.4 ST4 — src/tui/slash.ts 순수 슬래시(/) 자동완성 판정·필터·완성·프롬프트 합성 단정.
// 개선1(입력창 '/' 드롭다운)의 코어. 스킬 실발동은 settingSources:[] 불변식(engine.ts) 때문에
// SDK 네이티브 로드가 아니라 클라이언트측 SKILL.md 본문 주입으로 이뤄진다 — composeSkillPrompt가
// 그 합성을 담당한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSlashQuery, filterSkills, completeSlashText, composeSkillPrompt } from "../dist/tui/slash.js";

test("computeSlashQuery: 빈 입력은 닫힘(null)", () => {
  assert.equal(computeSlashQuery(""), null);
});

test("computeSlashQuery: 슬래시 없는 일반 텍스트는 닫힘(null)", () => {
  assert.equal(computeSlashQuery("hello"), null);
});

test("computeSlashQuery: '/' 단독은 빈 쿼리('')— 전체 목록 표시", () => {
  assert.equal(computeSlashQuery("/"), "");
});

test("computeSlashQuery: '/gat'는 쿼리 'gat'", () => {
  assert.equal(computeSlashQuery("/gat"), "gat");
});

test("computeSlashQuery: 하이픈 포함 스킬명(gbc-mute류) 판정", () => {
  assert.equal(computeSlashQuery("/gbc-mo"), "gbc-mo");
});

test("computeSlashQuery: 공백이 뒤따르면 인자 입력 단계 — 닫힘(null)", () => {
  assert.equal(computeSlashQuery("/gate "), null);
  assert.equal(computeSlashQuery("/gate review"), null);
});

test("computeSlashQuery: 슬래시가 첫 글자가 아니면 닫힘(null)", () => {
  assert.equal(computeSlashQuery("say /hi"), null);
});

const SKILLS = [
  { name: "gate", description: "게이트 관리", origin: "project", path: "/p/gate/SKILL.md" },
  { name: "gbc-monitor", description: "현황 조회", origin: "project", path: "/p/gbc-monitor/SKILL.md" },
  { name: "gbc-mute", description: "리마인드 on/off", origin: "project", path: "/p/gbc-mute/SKILL.md" },
  { name: "braintrust", description: "적대검토", origin: "global", path: "/g/braintrust/SKILL.md" },
];

test("filterSkills: 빈 쿼리는 전체 반환", () => {
  assert.equal(filterSkills(SKILLS, "").length, 4);
});

test("filterSkills: prefix 매칭만 남긴다(대소문자 무시)", () => {
  const out = filterSkills(SKILLS, "GBC");
  assert.deepEqual(out.map((s) => s.name), ["gbc-monitor", "gbc-mute"]);
});

test("filterSkills: 매칭 없으면 빈 배열", () => {
  assert.deepEqual(filterSkills(SKILLS, "zzz"), []);
});

test("completeSlashText: 이름 뒤 공백 포함 완성 텍스트", () => {
  assert.equal(completeSlashText("gate"), "/gate ");
});

test("composeSkillPrompt: 스킬 본문과 사용자 텍스트를 명확한 구분자로 합성", () => {
  const composed = composeSkillPrompt("# /gate\n게이트 스킬 본문", "spec 케이스 하나 추가해줘");
  assert.match(composed, /게이트 스킬 본문/);
  assert.match(composed, /spec 케이스 하나 추가해줘/);
  // 본문이 먼저, 사용자 텍스트가 뒤(모델이 지시문을 먼저 읽도록) — 순서 계약.
  assert.ok(composed.indexOf("게이트 스킬 본문") < composed.indexOf("spec 케이스 하나 추가해줘"));
});
