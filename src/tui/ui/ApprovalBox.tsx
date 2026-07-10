// 0.9.0 A3a ST5 — A-② BLOCK 승인 프롬프트(y/n/e/d). 시안 A 목업 문구·레이아웃 그대로.
import React from "react";
import { Box, Text } from "ink";
import type { ApprovalState, ApprovalChoice } from "../model.js";
import { APPROVAL_CHOICES } from "../model.js";

const LABEL: Record<ApprovalChoice, string> = {
  y: "승인 (y)",
  n: "거부 (n)",
  e: "수정 후 승인 (e)",
  d: "defer (d)",
};

// generic(spec-add 아닌 일반 도구 승인)엔 편집·defer 대상(derivedCase)이 없어 bridge.ts
// resolveApproval이 e/d를 n과 동일 처리한다(2026-07-10 자체검토 확정) — 라벨에도 그 사실을 드러낸다.
const GENERIC_LABEL: Record<ApprovalChoice, string> = {
  y: "승인 (y)",
  n: "거부 (n)",
  e: "거부 (e=n)",
  d: "거부 (d=n)",
};

export function ApprovalBox({
  approval,
  editing,
  editText,
}: {
  approval: ApprovalState;
  editing: boolean;
  editText: string;
}) {
  const labels = approval.kind === "spec-add" ? LABEL : GENERIC_LABEL;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>
        🐢 승인 대기
      </Text>
      {approval.kind === "generic" ? (
        <Text color="gray">도구 실행 승인 요청{approval.reason ? ` — ${approval.reason}` : ""}</Text>
      ) : approval.derivedCase === null ? (
        <Text color="gray">엔진이 차단 사유 수신 → 시나리오 도출 중…</Text>
      ) : editing ? (
        <>
          <Text>수정 중: {editText}█</Text>
          <Text color="gray">Enter로 편집 확정</Text>
        </>
      ) : (
        <>
          <Text>
            gbc spec add <Text color="cyan">&quot;{approval.derivedCase}&quot;</Text>
          </Text>
          <Text color="gray">근거: gate BLOCK 해소용 도출 시나리오 — 승인 시 재시도</Text>
        </>
      )}
      {!editing && (
        <Box marginTop={1}>
          {APPROVAL_CHOICES.map((choice, i) => (
            <Text key={choice}>
              {i > 0 ? "    " : ""}
              {choice === approval.selection ? (
                <Text backgroundColor="black" color="green">
                  ❯ {labels[choice]}
                </Text>
              ) : (
                <Text color="gray">{labels[choice]}</Text>
              )}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
