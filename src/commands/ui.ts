import type { Command } from "commander";
import { randomBytes } from "node:crypto";
import { PreconditionError } from "../errors";
import { globalOpts } from "../global-options";
import { findProjectRoot, homeRelative } from "../paths";
import { projectRegistryPath, registerProject } from "../project-registry";
import { startUiServer } from "../ui/server";

interface UiOptions {
  port?: string;
  open?: boolean;
  json?: boolean;
}

export function registerUi(program: Command): void {
  program
    .command("ui")
    .description(
      "serve the read-only status dashboard for every registered project on localhost",
    )
    .option("--port <number>", "listen on this port instead of a free one")
    .option("--no-open", "print the URL without opening a browser")
    .option("--json", "print the server details as one JSON line, then serve")
    .action(async (opts: UiOptions, cmd: Command) => {
      const port = parsePort(opts.port);
      const registryPath = projectRegistryPath();
      const currentProject = findProjectRoot();
      const registered =
        currentProject === null
          ? false
          : await registerProject(currentProject, registryPath);
      const token = randomBytes(16).toString("hex");
      const server = startUiServer({
        registryPath,
        port,
        token,
        dataOverride: globalOpts(cmd).data,
        currentProject,
      });
      const url = `${server.url}/?t=${token}`;

      if (opts.json) {
        console.log(
          JSON.stringify({
            url,
            port: server.port,
            registry: registryPath,
            project: currentProject,
            registered,
          }),
        );
      } else {
        console.log(`capshelf ui is serving at ${url}`);
        console.log(`  registry: ${homeRelative(registryPath)}`);
        if (currentProject !== null) {
          console.log(
            registered
              ? `  registered this project: ${homeRelative(currentProject)}`
              : `  this project: ${homeRelative(currentProject)}`,
          );
        }
        console.log("  press Ctrl-C to stop");
      }
      if (opts.open !== false) openBrowser(url);

      await new Promise<void>((resolve) => {
        const stop = (): void => {
          server.stop().then(resolve, resolve);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
    });
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PreconditionError(
      `invalid --port ${value}; expected an integer from 1 to 65535`,
    );
  }
  return port;
}

/**
 * Best effort. The URL is already printed, so a machine with no opener, or
 * a headless session, loses nothing when this fails.
 */
function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  } catch {
    // No opener on this machine.
  }
}
