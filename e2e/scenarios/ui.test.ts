import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expectExit } from "../support/assertions";
import { declareEvidence } from "../support/report";
import { E2E_TEST_TIMEOUT_MS, withWorld } from "../support/world";
import type { World } from "../support/world";

const SCENARIO = "ui";

interface UiInfo {
  url: string;
  port: number;
  registry: string;
  project: string | null;
  registered: boolean;
}

interface RunningUi {
  info: UiInfo;
  stop(): Promise<number | null>;
  stderr(): string;
}

/**
 * Start `capshelf ui` from the compiled binary and wait for the JSON line it
 * prints. The process runs in its own group so `stop` ends every child.
 */
async function startUi(world: World, cwd: string): Promise<RunningUi> {
  const child = spawn(world.binary, ["ui", "--no-open", "--json"], {
    cwd,
    env: { ...world.env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const info = await new Promise<UiInfo>((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`capshelf ui printed no JSON line\n${stderr}`)),
      30_000,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const line = stdout.split("\n").find((entry) => entry.startsWith("{"));
      if (!line) return;
      clearTimeout(deadline);
      resolve(JSON.parse(line) as UiInfo);
    });
    child.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(deadline);
      reject(new Error(`capshelf ui exited early with ${code}\n${stderr}`));
    });
  });
  return {
    info,
    stderr: () => stderr,
    stop: () =>
      new Promise<number | null>((resolve) => {
        child.removeAllListeners("exit");
        child.once("exit", (code) => resolve(code));
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
        }
      }),
  };
}

test(
  "the compiled binary serves the dashboard shell, its embedded assets, and the status API",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "capshelf ui registers the project, serves the embedded web UI on 127.0.0.1 behind a URL token, and answers with the rows status reports",
      labels: ["reproduced-user-workflow"],
      proofLimits: [
        "a headless fetch stands in for the browser: it proves the served bytes and the API, not the rendering",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const dataRepo = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        skills: { hello: "# hello\n\nfirst line\nsecond line\n" },
      });
      const project = await world.git.createProject("app");
      const init = await world.capshelf(project, ["init", "--data", dataRepo]);
      expectExit(init, 0);
      expect(init.stdout).toContain("registered for capshelf ui");
      expectExit(await world.capshelf(project, ["add", "skills/hello"]), 0);
      await writeFile(
        join(project, ".agents", "skills", "hello", "SKILL.md"),
        "# hello\n\nfirst line\nedited line\n",
      );

      const ui = await startUi(world, project);
      try {
        const url = new URL(ui.info.url);
        expect(url.hostname).toBe("127.0.0.1");
        const token = url.searchParams.get("t");
        expect(token).toMatch(/^[0-9a-f]{32}$/);
        expect(ui.info.registry).toBe(
          join(world.env.XDG_CONFIG_HOME ?? "", "capshelf", "projects.json"),
        );
        const base = url.origin;
        const auth = { Authorization: `Bearer ${token}` };

        // Independent observation: the shell and every asset ship inside the
        // executable, so the compiled program serves them from memory.
        const shell = await fetch(`${base}/`);
        expect(shell.status).toBe(200);
        expect(await shell.text()).toContain(
          '<script type="module" src="/app.js">',
        );
        const script = await fetch(`${base}/app.js`);
        expect(script.status).toBe(200);
        expect((await script.text()).length).toBeGreaterThan(10_000);
        const css = await fetch(`${base}/app.css`);
        expect(css.status).toBe(200);
        expect(await css.text()).toContain("--green");
        const logo = await fetch(`${base}/logo.png`);
        expect(logo.status).toBe(200);
        const png = new Uint8Array(await logo.arrayBuffer());
        expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

        // The API refuses without the token and answers with it.
        expect((await fetch(`${base}/api/overview`)).status).toBe(401);
        const overview = (await (
          await fetch(`${base}/api/overview`, { headers: auth })
        ).json()) as {
          projects: Array<{ path: string; exists: boolean }>;
          currentProject: string | null;
        };
        expect(overview.projects).toHaveLength(1);
        expect(overview.projects[0]?.exists).toBe(true);
        expect(overview.currentProject).toBe(
          overview.projects[0]?.path ?? null,
        );

        const statusUrl = new URL(`${base}/api/project/status`);
        statusUrl.searchParams.set("project", overview.projects[0]?.path ?? "");
        const status = (await (
          await fetch(statusUrl, { headers: auth })
        ).json()) as {
          items: Array<{
            id: string;
            ref: string;
            attention: boolean;
            row: { state: string };
            actions: Array<{ command: string }>;
          }>;
        };
        const hello = status.items.find((item) => item.ref === "skills/hello");
        expect(hello?.row.state).toBe("drifted_local");
        expect(hello?.attention).toBe(true);
        expect(hello?.actions.map((action) => action.command)).toEqual([
          "capshelf promote skills/hello",
          "capshelf keep-local skills/hello",
          "capshelf revert skills/hello",
        ]);

        // The same state the CLI reports, from the same executable.
        const cli = await world.capshelf(project, ["status", "--json"]);
        expectExit(cli, 0);
        const parsed = JSON.parse(cli.stdout) as {
          items: Array<{ kind: string; name: string; state: string }>;
        };
        expect(
          parsed.items.find(
            (item) => item.kind === "skills" && item.name === "hello",
          )?.state,
        ).toBe("drifted_local");

        const diffUrl = new URL(`${base}/api/project/diff`);
        diffUrl.searchParams.set("project", overview.projects[0]?.path ?? "");
        diffUrl.searchParams.set("item", hello?.id ?? "");
        diffUrl.searchParams.set("view", "installed");
        const diff = (await (
          await fetch(diffUrl, { headers: auth })
        ).json()) as {
          diff: { text: string | null } | null;
        };
        expect(diff.diff?.text).toContain("+edited line");
      } finally {
        const code = await ui.stop();
        expect(code).toBe(0);
      }
    });
  },
  E2E_TEST_TIMEOUT_MS,
);
