import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expectExit, expectOutputContains } from "../support/assertions";
import { runInPty } from "../support/pty";
import { declareEvidence } from "../support/report";
import { E2E_TEST_TIMEOUT_MS, withWorld } from "../support/world";

const SCENARIO = "environment-cells";

/**
 * The picker is terminal behavior, so this is the only layer that can prove it.
 * Every other cell runs through pipes, where `add` with no argument refuses and
 * `init` prints its skip note — proving the offer is absent, never that it
 * works.
 *
 * The query is deliberately `pgh`. It is not a substring of any item on the
 * shelf, only a subsequence of `postgres-helper`, so an item appearing on disk
 * afterwards proves the whole chain end to end in the packaged binary: raw-mode
 * input, the ported fzf match, the mark, and the install.
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
        "the keystrokes are written in one burst before the program enters raw mode, so this does not prove behavior under per-keystroke timing",
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
      // `--no-pick` here: this cell is about the `add` offer, and an init that
      // also prompted would consume the keystrokes meant for it.
      expectExit(
        await world.capshelf(project, ["init", "--no-pick", "--data", shelf]),
        0,
      );

      const picked = await runInPty(world, project, [world.binary, "add"], {
        // The world defaults to TERM=dumb, which the picker refuses because a
        // dumb terminal cannot run a full-screen prompt. These cells are about
        // the prompt, so they ask for a terminal that has capabilities.
        env: { TERM: "xterm-256color" },
        answer: "pgh\t\r",
      });

      expectExit(picked, 0);
      expectOutputContains(picked, "skills/postgres-helper");
      expect(
        existsSync(
          join(project, ".claude", "skills", "postgres-helper", "SKILL.md"),
        ),
      ).toBe(true);
      // Precision, not just recall: the other item was on the shelf, was never
      // marked, and must not have been installed.
      expect(
        existsSync(join(project, ".claude", "skills", "code-review")),
      ).toBe(false);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

/**
 * Typing must move the cursor to the best match, not just reorder the rows
 * beneath a cursor that stays where it was.
 *
 * The two names are chosen so the distinction is observable. With no query the
 * list is in browse order and the cursor sits on `architecture-review`. Typing
 * `rev` ranks `review-diff` above it, but `architecture-review` still matches,
 * so a cursor that tracks the previously focused row follows it down to second
 * place and `Tab` marks the wrong item. Asserting on what lands on disk, not
 * on what the screen drew, is what makes this a real assertion.
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
          // Sorts first, so it is what the cursor starts on, and it still
          // matches `rev`, so it stays in the filtered list.
          "skills/architecture-review/SKILL.md": "# architecture review\n",
          // Ranks first for `rev`: the match is at a word start right after
          // the delimiter, and the ref is shorter.
          "skills/review-diff/SKILL.md": "# review diff\n",
        },
      });
      const project = await world.git.createProject("platform");
      expectExit(
        await world.capshelf(project, ["init", "--no-pick", "--data", shelf]),
        0,
      );

      const picked = await runInPty(world, project, [world.binary, "add"], {
        // The world defaults to TERM=dumb, which the picker refuses because a
        // dumb terminal cannot run a full-screen prompt. These cells are about
        // the prompt, so they ask for a terminal that has capabilities.
        env: { TERM: "xterm-256color" },
        answer: "rev\t\r",
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
 * `←` switches type *and* leaves the query intact.
 *
 * Node's readline owns the text insertion point and still moves it on `←`, and
 * clack's clear only deletes what is left of that point. Restoring the query
 * without first moving to the end therefore left the suffix behind and typed
 * into the middle of it: `ab`, `←`, `x` produced `abxb`. Typing `re`, `←`,
 * `v` here must still search for `rev` and install the item that ranks first
 * for it.
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

      // "re", ←, "v" — the query must end up as `rev`.
      const picked = await runInPty(world, project, [world.binary, "add"], {
        // The world defaults to TERM=dumb, which the picker refuses because a
        // dumb terminal cannot run a full-screen prompt. These cells are about
        // the prompt, so they ask for a terminal that has capabilities.
        env: { TERM: "xterm-256color" },
        answer: "re\u001b[Dv\t\r",
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
 * The type menu. `←/→` switch which kind the list shows, so a query typed
 * afterwards can only match rows of that kind.
 *
 * The shelf holds one skill and one MCP item whose names both match `git`.
 * From `All`, one `→` selects `bundles`... except the shelf has no bundles, so
 * that tab does not exist, and the first `→` lands on `skills`. Marking there
 * must install the skill and never the MCP item, which proves the tab actually
 * scoped the list rather than only relabelling it.
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

      // → moves off All to the first kind tab (skills), then `git` matches
      // only within it.
      const picked = await runInPty(world, project, [world.binary, "add"], {
        // The world defaults to TERM=dumb, which the picker refuses because a
        // dumb terminal cannot run a full-screen prompt. These cells are about
        // the prompt, so they ask for a terminal that has capabilities.
        env: { TERM: "xterm-256color" },
        answer: "\u001b[Cgit\t\r",
      });

      expectExit(picked, 0);
      expect(
        existsSync(
          join(project, ".claude", "skills", "git-helper", "SKILL.md"),
        ),
      ).toBe(true);
      // The MCP item matches `git` just as well and sits on another tab, so
      // its absence is what shows the tab scoped the list.
      const manifest = JSON.parse(
        await Bun.file(join(project, ".capshelf", "capshelf.json")).text(),
      ) as { mcp: string[]; skills: string[] };
      expect(manifest.skills).toEqual(["git-helper"]);
      expect(manifest.mcp).toEqual([]);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

/**
 * Space stays a query separator after arrow navigation.
 *
 * `AutocompletePrompt` treats Space as "mark the focused row" while its
 * navigation flag is set, and `↑`/`↓` set it. Typing `sec`, pressing `↓`, then
 * Space and `rev` swallowed the separator — leaving `secrev` — and marked
 * whichever row was focused, which `Enter` then installed. Nothing on screen
 * said so. The shelf below is arranged so the wrongly marked row is a
 * different item than the query selects, which is what makes the silent
 * install visible on disk.
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

      // "sec", ↓, " ", "rev", Tab, Enter. The query must be the two terms
      // `sec rev`, and the only install must be the row Tab marked.
      const picked = await runInPty(world, project, [world.binary, "add"], {
        env: { TERM: "xterm-256color" },
        answer: "sec\u001b[B rev\t\r",
      });

      expectExit(picked, 0);
      expect(
        existsSync(
          join(project, ".claude", "skills", "secure-review", "SKILL.md"),
        ),
      ).toBe(true);
      // The decoy is what a stray Space-mark would have caught.
      expect(existsSync(join(project, ".claude", "skills", "aaa-decoy"))).toBe(
        false,
      );
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

/**
 * A terminal that declares no capabilities is refused, not drawn on.
 *
 * This cell keeps the world's default `TERM=dumb`, which is why every cell
 * above has to ask for a real one. On a dumb terminal `readline` ignores the
 * key argument to its own `write`: the clear that restores the query never
 * runs, so `re`, `←`, `v` left `rerev`, and `Tab` arrived as a literal tab
 * instead of marking a row. It installed the wrong item without any sign that
 * something had gone wrong, which is the outcome the refusal replaces.
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

      // No TERM override here: the world's default is `dumb`.
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

/**
 * The other half. Without a terminal the offer must be absent and say so,
 * rather than hanging on a prompt nothing can answer — which is what a CI job
 * running `capshelf init` depends on.
 */
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
