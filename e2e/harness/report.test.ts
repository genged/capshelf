import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPORT_ENV, declareEvidence } from "../support/report";

const original = process.env[REPORT_ENV];
let created: string | null = null;

afterEach(async () => {
  if (original === undefined) delete process.env[REPORT_ENV];
  else process.env[REPORT_ENV] = original;
  if (created) await rm(created, { recursive: true, force: true });
  created = null;
});

test("a declared record is appended to the run report", async () => {
  created = await mkdtemp(join(tmpdir(), "capshelf-e2e-report-"));
  const path = join(created, "report.jsonl");
  process.env[REPORT_ENV] = path;

  declareEvidence({
    scenario: "self-test",
    property: "a record is written",
    labels: ["reproduced-user-workflow"],
  });
  declareEvidence({
    scenario: "self-test",
    property: "a second record is appended, not overwritten",
    labels: ["modeled-external-step"],
    modeledSteps: ["a squash merge on a local bare remote"],
  });

  const lines = (await readFile(path, "utf-8")).trim().split("\n");
  expect(lines.length).toBe(2);
  expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ scenario: "self-test" });
  expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({
    labels: ["modeled-external-step"],
  });
});

/**
 * The labels are a claim about what a test proved, so the two that admit a
 * substitute have to say what the substitute leaves unproved.
 */
test("a label that admits a substitute must name it", () => {
  expect(() =>
    declareEvidence({ scenario: "s", property: "p", labels: [] }),
  ).toThrow("evidence label");
  expect(() =>
    declareEvidence({
      scenario: "s",
      property: "p",
      labels: ["modeled-external-step"],
    }),
  ).toThrow("modeled steps");
  expect(() =>
    declareEvidence({
      scenario: "s",
      property: "p",
      labels: ["constructed-recovery-state"],
    }),
  ).toThrow("remains unproved");
});
