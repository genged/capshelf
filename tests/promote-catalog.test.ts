import { describe, expect, test } from "bun:test";
import { promoteRowDisposition } from "../src/promote-catalog";
import type { State } from "../src/status-core";

/**
 * Every member of `State`, written out so a new state fails this test until
 * the disposition decides it. The type alone cannot force that: a `default`
 * branch would silently classify a new state.
 */
const ALL_STATES: State[] = [
  "ok",
  "source_filtered",
  "missing_source_commit",
  "update_available",
  "drifted_local",
  "drifted_and_update",
  "missing_installed",
  "missing_output",
  "missing_upstream",
  "upstream_dirty",
  "source_dirty",
  "drifted_and_upstream_dirty",
  "output_drift",
  "source_dirty_and_output_drift",
  "kept-local",
];

describe("promoteRowDisposition", () => {
  test("offers exactly the four states promote can publish", () => {
    const offered = ALL_STATES.filter(
      (state) => promoteRowDisposition(state).offered,
    );
    const expected: State[] = [
      "drifted_local",
      "drifted_and_update",
      "source_dirty",
      "source_dirty_and_output_drift",
    ];
    expect(offered.sort()).toEqual(expected.sort());
  });

  test("every disabled state carries a reason; no offered state does", () => {
    for (const state of ALL_STATES) {
      const disposition = promoteRowDisposition(state);
      if (disposition.offered) {
        expect(disposition.reason).toBeUndefined();
      } else {
        expect(disposition.reason).toBeString();
        expect(disposition.reason?.length).toBeGreaterThan(0);
      }
    }
  });

  test("the states promote refuses point at the command that acts on them", () => {
    expect(promoteRowDisposition("ok").reason).toBe("nothing to promote");
    expect(promoteRowDisposition("output_drift").reason).toContain("apply");
    expect(promoteRowDisposition("update_available").reason).toContain(
      "update",
    );
    expect(promoteRowDisposition("kept-local").reason).toContain("keep-local");
  });
});
