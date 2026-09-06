import { describe, expect, test } from "bun:test";
import { classify, groupDirectory } from "./rules";

describe("classify", () => {
  test("source code under src is prod", () => {
    expect(classify("src/cli.ts")).toBe("prod");
    expect(classify("src/ui/client/app.tsx")).toBe("prod");
    expect(classify("src/ui/client/styles.css")).toBe("prod");
  });

  test("bundled skill text and configuration under src do not count", () => {
    expect(classify("src/bundled/skills/capshelf/SKILL.md")).toBeNull();
    expect(classify("src/ui/client/tsconfig.json")).toBeNull();
    expect(classify("src/ui/generated/app.js")).toBeNull();
  });

  test("unit, e2e, and smoke files are test", () => {
    expect(classify("tests/lock.test.ts")).toBe("test");
    expect(classify("tests/cli-fixtures.ts")).toBe("test");
    expect(classify("e2e/scenarios/ui.test.ts")).toBe("test");
    expect(classify("e2e/support/pty-driver.py")).toBe("test");
    expect(classify("scripts/smoke-ui.sh")).toBe("test");
    expect(classify("scripts/smoke-lib.sh")).toBe("test");
  });

  test("other scripts and documents do not count", () => {
    expect(classify("scripts/e2e.sh")).toBeNull();
    expect(classify("scripts/build-ui.ts")).toBeNull();
    expect(classify("docs/cli.md")).toBeNull();
    expect(classify("package.json")).toBeNull();
    expect(classify("srcfoo/a.ts")).toBeNull();
  });
});

describe("groupDirectory", () => {
  test("groups by the first two segments", () => {
    expect(groupDirectory("src/commands/status.ts")).toBe("src/commands");
    expect(groupDirectory("e2e/scenarios/ui.test.ts")).toBe("e2e/scenarios");
  });

  test("a top-level file groups under its root", () => {
    expect(groupDirectory("src/cli.ts")).toBe("src");
    expect(groupDirectory("scripts/smoke-ui.sh")).toBe("scripts");
  });
});
