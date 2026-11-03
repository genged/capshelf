import { describe, expect, test } from "bun:test";
import {
  capshelfCommand,
  capshelfCommandPrefix,
  commandDataOverride,
  shellArg,
} from "../src/command-text";
import * as paths from "../src/paths";

describe("command text", () => {
  test("a ref with shell syntax is quoted, a plain ref stays bare", () => {
    expect(capshelfCommand(undefined, ["add", "skills/quick-review"])).toBe(
      "capshelf add skills/quick-review",
    );
    expect(capshelfCommand(undefined, ["add", "skills/x; touch pwn"])).toBe(
      "capshelf add 'skills/x; touch pwn'",
    );
    expect(capshelfCommand(undefined, ["update", "settings/$(whoami)"])).toBe(
      "capshelf update 'settings/$(whoami)'",
    );
  });

  test("the --data override is repeated, quoted, before the verb", () => {
    expect(
      capshelfCommand("/srv/team shelf", ["update", "skills/a", "--local"]),
    ).toBe("capshelf --data '/srv/team shelf' update skills/a --local");
    expect(capshelfCommandPrefix(undefined)).toBe("capshelf");
  });

  test("a dashboard command names the resolved repository, not the spelling", () => {
    expect(commandDataOverride(undefined, "/srv/shelf")).toBeUndefined();
    expect(commandDataOverride(null, "/srv/shelf")).toBeUndefined();
    expect(commandDataOverride("../shelf", "/srv/shelf")).toBe("/srv/shelf");
    expect(commandDataOverride("../shelf", null)).toBe("../shelf");
  });

  test("paths.ts re-exports the same functions the web UI uses", () => {
    expect(paths.shellArg).toBe(shellArg);
    expect(paths.capshelfCommandPrefix).toBe(capshelfCommandPrefix);
  });
});
