import { appendFileSync } from "node:fs";

export type EvidenceLabel =
  | "reproduced-user-workflow"
  | "modeled-external-step"
  | "constructed-recovery-state"
  | "real-provider-compatibility";

export interface EvidenceRecord {
  scenario: string;
  property: string;
  labels: readonly EvidenceLabel[];
  modeledSteps?: readonly string[];
  proofLimits?: readonly string[];
}

export const REPORT_ENV = "CAPSHELF_E2E_REPORT";

export function declareEvidence(record: EvidenceRecord): EvidenceRecord {
  if (record.labels.length === 0) {
    throw new Error(
      `${record.scenario}: a test must declare an evidence label`,
    );
  }
  if (
    record.labels.includes("modeled-external-step") &&
    (record.modeledSteps ?? []).length === 0
  ) {
    throw new Error(
      `${record.scenario}: a modeled-external-step test must name the modeled steps`,
    );
  }
  if (
    record.labels.includes("constructed-recovery-state") &&
    (record.proofLimits ?? []).length === 0
  ) {
    throw new Error(
      `${record.scenario}: a constructed-recovery-state test must state what remains unproved`,
    );
  }
  process.stdout.write(
    `evidence: ${record.scenario} [${record.labels.join(", ")}] ${record.property}\n`,
  );
  const path = process.env[REPORT_ENV];
  if (path) appendFileSync(path, `${JSON.stringify(record)}\n`);
  return record;
}
