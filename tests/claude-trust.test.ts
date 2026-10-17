import { describe, expect, test } from "bun:test";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeTrustFor } from "../src/claude-trust";
import { tempDir } from "./cli-fixtures";

describe("claudeTrustFor", () => {
  test("a missing file is unknown", async () => {
    expect(await claudeTrustFor("/p", await tempDir("h-"))).toBe("unknown");
  });
  test("an unreadable file is unknown", async () => {
    const home = await tempDir("h-");
    await writeFile(join(home, ".claude.json"), "{bad");
    expect(await claudeTrustFor("/p", home)).toBe("unknown");
  });
  test("an accepted project is trusted, a missing key is untrusted", async () => {
    const home = await tempDir("h-");
    const project = await tempDir("p-");
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        projects: { [project]: { hasTrustDialogAccepted: true } },
      }),
    );
    expect(await claudeTrustFor(project, home)).toBe("trusted");
    expect(await claudeTrustFor(await tempDir("q-"), home)).toBe("untrusted");
  });
  test("a false value is untrusted", async () => {
    const home = await tempDir("h-");
    const project = await tempDir("p-");
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        projects: { [project]: { hasTrustDialogAccepted: false } },
      }),
    );
    expect(await claudeTrustFor(project, home)).toBe("untrusted");
  });
  test("a project reached through a symlink matches its real path", async () => {
    const home = await tempDir("h-");
    const project = await tempDir("p-");
    const linkDir = await tempDir("l-");
    const link = join(linkDir, "link");
    await symlink(project, link);
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        projects: { [project]: { hasTrustDialogAccepted: true } },
      }),
    );
    expect(await claudeTrustFor(link, home)).toBe("trusted");
  });
});
