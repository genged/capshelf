import { appendFileSync } from "node:fs";

/**
 * What a test proved, in the vocabulary the suite uses everywhere. A local
 * substitute for a hosted service is honest only if it says so, so every test
 * labels itself and names what it leaves unproved.
 */
export type EvidenceLabel =
  | "reproduced-user-workflow"
  | "modeled-external-step"
  | "constructed-recovery-state"
  | "real-provider-compatibility";

export interface EvidenceRecord {
  /** Public scenario family, for example "fresh-clone". */
  scenario: string;
  /** The behavior under test, in product terms. */
  property: string;
  labels: readonly EvidenceLabel[];
  /** External steps this test models locally, if any. */
  modeledSteps?: readonly string[];
  /** Claims that stay unproved after this test passes. */
  proofLimits?: readonly string[];
}

export const REPORT_ENV = "CAPSHELF_E2E_REPORT";

/**
 * Print one line so a CI log carries the labels, and append the full record to
 * `CAPSHELF_E2E_REPORT` when a run collects one.
 */
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
