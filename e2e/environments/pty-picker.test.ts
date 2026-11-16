import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expectExit, expectOutputContains } from "../support/assertions";
import { runInPty } from "../support/pty";
import { declareEvidence } from "../support/report";
import { asObject, parseJsonText } from "../support/json";
import { E2E_TEST_TIMEOUT_MS, withWorld } from "../support/world";

const SCENARIO = "environment-cells";

/**
 * The query `pgh` is only a subsequence of `postgres-helper`, so a successful
 * install proves raw-mode input, fuzzy match, mark and install end to end.
 */
test(
  "with a terminal, add with no item offers the shelf and installs what was marked",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "on a TTY, `capshelf add` with no argument filters the shelf by fuzzy subsequence, marks with Tab, installs on Enter, and exits 0",
      labels: ["reproduced-user-workflow"],
      proofLimits: [
        "the terminal is opened by a helper rather than by a real terminal emulator, so line-discipline details such as echo and CR endings differ from an interactive shell",
        "the keystrokes are written in one burst once the program enters raw mode, so this does not prove behavior under per-keystroke timing",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        files: {
          "skills/postgres-helper/SKILL.md": "# postgres helper\n",
          "skills/code-review/SKILL.md": "# code review\n",
        },
      });
      const project = await world.git.createProject("platform");
      // `--no-pick` keeps init from prompting and consuming the keystrokes
      // meant for `add`.
      expectExit(
        await world.capshelf(project, ["init", "--no-pick", "--data", shelf]),
        0,
      );

      const picked = await runInPty(world, project, [world.binary, "add"], {
        // The world defaults to TERM=dumb, which the picker refuses, so ask for
        // a capable terminal.
        env: { TERM: "xterm-256color" },
        answer: "pgh\t\r",
        answerAfterRawMode: true,
      });

      expectExit(picked, 0);
      expectOutputContains(picked, "skills/postgres-helper");
      expect(
        existsSync(
          join(project, ".claude", "skills", "postgres-helper", "SKILL.md"),
        ),
      ).toBe(true);
      expect(
        existsSync(join(project, ".claude", "skills", "code-review")),
      ).toBe(false);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

/**
 * `review-diff` ranks above `architecture-review` for `rev`, so a cursor that
 * follows the previously focused row would mark the wrong item.
 */
test(
  "with a terminal, typing moves the cursor to the best match",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "after a query, Tab marks the top-ranked row rather than the row focused before the query was typed",
      labels: ["reproduced-user-workflow"],
      proofLimits: [
        "the terminal is opened by a helper rather than by a real terminal emulator, so line-discipline details such as echo and CR line endings differ from an interactive shell",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        files: {
          "skills/architecture-review/SKILL.md": "# architecture review\n",
          "skills/review-diff/SKILL.md": "# review diff\n",
        },
      });
      const project = await world.git.createProject("platform");
      expectExit(
        await world.capshelf(project, ["init", "--no-pick", "--data", shelf]),
        0,
      );

      const picked = await runInPty(world, project, [world.binary, "add"], {
        // The world defaults to TERM=dumb, which the picker refuses, so these
        // cells set a capable terminal.
        env: { TERM: "xterm-256color" },
        answer: "rev\t\r",
        answerAfterRawMode: true,
      });

      expectExit(picked, 0);
      expect(
        existsSync(
          join(project, ".claude", "skills", "review-diff", "SKILL.md"),
        ),
      ).toBe(true);
      expect(
        existsSync(join(project, ".claude", "skills", "architecture-review")),
      ).toBe(false);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

/**
 * readline moves its insertion point on `←` but clack's clear only deletes left
 * of it, so the query must be restored from the end.
 */
test(
  "with a terminal, switching type mid-query leaves the query intact",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "after ← switches type, further typing appends to the query rather than inserting into a stale readline buffer",
      labels: ["reproduced-user-workflow"],
      proofLimits: [
        "the terminal is opened by a helper rather than by a real terminal emulator, so line-discipline details such as echo and CR line endings differ from an interactive shell",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        files: {
          "skills/architecture-review/SKILL.md": "# architecture review\n",
          "skills/review-diff/SKILL.md": "# review diff\n",
        },
      });
      const project = await world.git.createProject("platform");
      expectExit(
        await world.capshelf(project, ["init", "--no-pick", "--data", shelf]),
        0,
      );

      const picked = await runInPty(world, project, [world.binary, "add"], {
        // The world defaults to TERM=dumb, which the picker refuses, so these
        // cells set a capable terminal.
        env: { TERM: "xterm-256color" },
        answer: "re\u001b[Dv\t\r",
        answerAfterRawMode: true,
      });

      expectExit(picked, 0);
      expect(
        existsSync(
          join(project, ".claude", "skills", "review-diff", "SKILL.md"),
        ),
      ).toBe(true);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

/**
 * The shelf has no bundles, so the first `→` lands on `skills`; the MCP item's
 * absence proves the tab scoped the list.
 */
test(
  "with a terminal, the type menu scopes the list to one kind",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "arrow keys switch the picker's type tab, and a query then matches only rows of the selected kind",
      labels: ["reproduced-user-workflow"],
      proofLimits: [
        "the terminal is opened by a helper rather than by a real terminal emulator, so line-discipline details such as echo and CR line endings differ from an interactive shell",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        files: {
          "skills/git-helper/SKILL.md": "# git helper\n",
          "mcp/git-server/claude.json":
            '{"mcpServers":{"git-server":{"command":"git-mcp"}}}\n',
        },
      });
      const project = await world.git.createProject("platform");
      expectExit(
        await world.capshelf(project, ["init", "--no-pick", "--data", shelf]),
        0,
      );

      const picked = await runInPty(world, project, [world.binary, "add"], {
        // The world defaults to TERM=dumb, which the picker refuses, so these
        // cells set a capable terminal.
        env: { TERM: "xterm-256color" },
        answer: "\u001b[Cgit\t\r",
        answerAfterRawMode: true,
      });

      expectExit(picked, 0);
      expect(
        existsSync(
          join(project, ".claude", "skills", "git-helper", "SKILL.md"),
        ),
      ).toBe(true);
      const manifest = asObject(
        parseJsonText(
          await Bun.file(join(project, ".capshelf", "capshelf.json")).text(),
          "capshelf.json",
        ),
        "capshelf.json",
      );
      expect(manifest.skills).toEqual(["git-helper"]);
      expect(manifest.mcp).toEqual([]);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

/**
 * AutocompletePrompt treats Space as mark-the-row while its navigation flag is
 * set, which `↑`/`↓` set, so Space after arrows would swallow the separator.
 */
test(
  "with a terminal, space after navigation separates terms and marks nothing",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "after ↑/↓, Space is query text rather than a mark, so only rows marked with Tab are installed",
      labels: ["reproduced-user-workflow"],
      proofLimits: [
        "the terminal is opened by a helper rather than by a real terminal emulator, so line-discipline details such as echo and CR line endings differ from an interactive shell",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        files: {
          "skills/secure-review/SKILL.md": "# secure review\n",
          "skills/aaa-decoy/SKILL.md": "# decoy\n",
        },
      });
      const project = await world.git.createProject("platform");
      expectExit(
        await world.capshelf(project, ["init", "--no-pick", "--data", shelf]),
        0,
      );

      const picked = await runInPty(world, project, [world.binary, "add"], {
        env: { TERM: "xterm-256color" },
        answer: "sec\u001b[B rev\t\r",
        answerAfterRawMode: true,
      });

      expectExit(picked, 0);
      expect(
        existsSync(
          join(project, ".claude", "skills", "secure-review", "SKILL.md"),
        ),
      ).toBe(true);
      expect(existsSync(join(project, ".claude", "skills", "aaa-decoy"))).toBe(
        false,
      );
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

/**
 * The marked row is an mcp server because the pty driver writes all keys in one
 * burst and the raw-mode reader drops whatever remains after Enter, so no later
 * readline prompt can be answered.
 */
test(
  "with a terminal, share with no item offers unmanaged values and commits the marked one",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "on a TTY, `capshelf share` with no item lists unmanaged config values, filters by fuzzy subsequence, marks with Tab, shares on Enter, commits the fragment, and prints the equivalent non-interactive command",
      labels: ["reproduced-user-workflow"],
      proofLimits: [
        "the terminal is opened by a helper rather than by a real terminal emulator, so line-discipline details such as echo and CR line endings differ from an interactive shell",
        "the keystrokes are written in one burst once the program enters raw mode, so this does not prove behavior under per-keystroke timing",
        "the settings name prompt is not driven here, because the one-burst input cannot feed a canonical prompt after a raw-mode one; the CLI layer covers it through the injectable prompt seam",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        files: { "README.md": "shelf\n" },
      });
      const project = await world.git.createProject("platform");
      expectExit(
        await world.capshelf(project, ["init", "--no-pick", "--data", shelf]),
        0,
      );
      await writeFile(
        join(project, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            github: { command: "github-mcp" },
            "aaa-decoy": { command: "decoy-mcp" },
          },
        }),
      );

      const picked = await runInPty(world, project, [world.binary, "share"], {
        env: { TERM: "xterm-256color" },
        answer: "ghb\t\r",
        answerAfterRawMode: true,
      });

      expectExit(picked, 0);
      expectOutputContains(picked, "capshelf share mcp/github --target claude");
      const fragment = parseJsonText(
        await readFile(join(shelf, "mcp", "github", "claude.json"), "utf-8"),
        "claude.json",
      );
      expect(fragment).toEqual({
        mcpServers: { github: { command: "github-mcp" } },
      });
      expect(existsSync(join(shelf, "mcp", "aaa-decoy"))).toBe(false);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test(
  "with a terminal, promote with no item offers the dirty item and commits it",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "on a TTY, `capshelf promote` opens the focused diff with Ctrl-V, closes it with q or Ctrl-V, and promotes the reviewed row into a data-repo commit",
      labels: ["reproduced-user-workflow"],
      proofLimits: [
        "the terminal is opened by a helper rather than by a real terminal emulator, so line-discipline details such as echo and CR line endings differ from an interactive shell",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        files: { "README.md": "shelf\n" },
      });
      const project = await world.git.createProject("platform");
      expectExit(
        await world.capshelf(project, ["init", "--no-pick", "--data", shelf]),
        0,
      );
      await mkdir(join(project, ".claude"), { recursive: true });
      await writeFile(
        join(project, ".claude", "settings.json"),
        JSON.stringify({ env: { FOO: "bar" } }),
      );
      expectExit(
        await world.capshelf(project, [
          "share",
          "settings/theme",
          "--pick",
          "env",
        ]),
        0,
      );
      await writeFile(
        join(shelf, "settings", "theme", "settings.json"),
        JSON.stringify({ env: { FOO: "baz" } }),
      );

      // `sth` is a fuzzy subsequence of `settings/theme`, and the preview
      // renders asynchronously, so wait for its text before sending the next
      // key.
      const picked = await runInPty(world, project, [world.binary, "promote"], {
        env: { TERM: "xterm-256color" },
        interactions: [
          { send: "sth\u0016" },
          {
            waitFor: "+++ b/settings.json",
            send: "q\u0016\u0016\t\r",
          },
        ],
      });

      expectExit(picked, 0);
      expectOutputContains(picked, "Diff: settings/theme");
      expectOutputContains(picked, "+++ b/settings.json");
      expectOutputContains(picked, '"baz"');
      expectOutputContains(picked, "promoted data/settings/theme");
      const log = await world.run(shelf, ["git", "log", "--oneline"]);
      expect(log.stdout).toContain("capshelf: settings/theme");
      const status = await world.run(shelf, ["git", "status", "--porcelain"]);
      expect(status.stdout.trim()).toBe("");
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

/**
 * The prompt library's cursor walk skips disabled options, so disabled rows are
 * rendered as ordinary rows to stay focusable and show their reason.
 */
test(
  "with a terminal, the cursor reaches a disabled promote row and Tab on it marks nothing",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "in the promote picker, ↓ moves the cursor onto a disabled row in another kind group, the row's reason renders, and Tab there marks nothing so Enter promotes nothing",
      labels: ["reproduced-user-workflow"],
      proofLimits: [
        "the terminal is opened by a helper rather than by a real terminal emulator, so line-discipline details such as echo and CR line endings differ from an interactive shell",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        files: { "skills/hello/SKILL.md": "# hello\n" },
      });
      const project = await world.git.createProject("platform");
      expectExit(
        await world.capshelf(project, ["init", "--no-pick", "--data", shelf]),
        0,
      );
      expectExit(await world.capshelf(project, ["add", "skills/hello"]), 0);
      await mkdir(join(project, ".claude"), { recursive: true });
      await writeFile(
        join(project, ".claude", "settings.json"),
        JSON.stringify({ env: { FOO: "bar" } }),
      );
      expectExit(
        await world.capshelf(project, [
          "share",
          "settings/theme",
          "--pick",
          "env",
        ]),
        0,
      );
      await writeFile(
        join(project, ".agents", "skills", "hello", "SKILL.md"),
        "# hello v2\n",
      );
      const before = await world.run(shelf, ["git", "rev-parse", "HEAD"]);

      const picked = await runInPty(world, project, [world.binary, "promote"], {
        env: { TERM: "xterm-256color" },
        answer: "\u001b[B\t\r",
        answerAfterRawMode: true,
      });

      expectExit(picked, 0);
      // Only the focused row draws its detail, so seeing the reason proves
      // focus reached the disabled row.
      expectOutputContains(picked, "nothing to promote");
      expect(picked.stdout + picked.stderr).not.toContain("✓ promoted");
      const after = await world.run(shelf, ["git", "rev-parse", "HEAD"]);
      expect(after.stdout.trim()).toBe(before.stdout.trim());
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

/**
 * On TERM=dumb, readline ignores the key argument to `write`, so the
 * query-restoring clear never runs and Tab arrives as a literal tab; the picker
 * refuses instead.
 */
test(
  "on a terminal without capabilities, the picker refuses instead of misbehaving",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "with TERM=dumb the picker refuses with exit 3 and a stated reason, rather than drawing a prompt whose keys do not work",
      labels: ["reproduced-user-workflow"],
      proofLimits: [
        "the terminal is opened by a helper rather than by a real terminal emulator, so line-discipline details such as echo and CR line endings differ from an interactive shell",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        files: { "skills/review-diff/SKILL.md": "# review diff\n" },
      });
      const project = await world.git.createProject("platform");
      expectExit(
        await world.capshelf(project, ["init", "--no-pick", "--data", shelf]),
        0,
      );

      const refused = await runInPty(world, project, [world.binary, "add"], {
        answer: "rev\t\r",
      });

      expectExit(refused, 3);
      expectOutputContains(refused, "cannot pick interactively");
      expectOutputContains(refused, "TERM=dumb");
      expect(
        existsSync(join(project, ".claude", "skills", "review-diff")),
      ).toBe(false);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test(
  "without a terminal, init reports the skipped picker and still succeeds",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "through pipes, `init` skips the picker with a stated reason, exits 0, and `add` with no argument refuses with exit 3 instead of prompting",
      labels: ["reproduced-user-workflow"],
      proofLimits: [],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        files: { "skills/postgres-helper/SKILL.md": "# postgres helper\n" },
      });
      const project = await world.git.createProject("platform");

      const initialized = await world.capshelf(project, [
        "init",
        "--data",
        shelf,
      ]);
      expectExit(initialized, 0);
      expectOutputContains(initialized, "no interactive terminal");

      const refused = await world.capshelf(project, ["add"]);
      expectExit(refused, 3);
      expectOutputContains(refused, "cannot pick interactively");
    });
  },
  E2E_TEST_TIMEOUT_MS,
);
