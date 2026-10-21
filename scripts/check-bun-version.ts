/**
 * Stop a local run on a Bun that `package.json#packageManager` does not
 * declare. Bun does not enforce that field, so `bun run test` would use any
 * Bun on PATH. `bun run test`, `bun run build`, and `bun run e2e:run` run this
 * first.
 *
 * Run it as `bun scripts/check-bun-version.ts` inside the script line, not
 * through `bun run`: the outer `bun run` does not put its own binary on PATH,
 * so the `bun` that this check sees is the one that runs the next command.
 *
 * Set CAPSHELF_ANY_BUN=1 to run on another Bun on purpose. The scheduled
 * canary does this to test the newest Bun.
 */
import { join } from "node:path";
import { z } from "zod";

const ESCAPE_VARIABLE = "CAPSHELF_ANY_BUN";

const manifestSchema = z.object({
  packageManager: z
    .string()
    .regex(/^bun@\d+\.\d+\.\d+$/, 'must look like "bun@1.2.3"'),
});

const manifestPath = join(process.cwd(), "package.json");
const parsed = manifestSchema.safeParse(await Bun.file(manifestPath).json());
if (!parsed.success) {
  const issues = parsed.error.issues.map(
    (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
  );
  console.error(
    `check-bun-version: cannot read the declared Bun from ${manifestPath}: ${issues.join("; ")}`,
  );
  process.exit(1);
}

const declared = parsed.data.packageManager.slice("bun@".length);
const running = Bun.version;

if (running !== declared) {
  if (process.env[ESCAPE_VARIABLE] === "1") {
    console.error(
      `check-bun-version: Bun ${running}, package.json declares ${declared}; continuing because ${ESCAPE_VARIABLE}=1`,
    );
    process.exit(0);
  }
  console.error(
    [
      `check-bun-version: this is Bun ${running}, and package.json declares Bun ${declared}.`,
      "",
      "Run the command with the declared Bun. Either of these works:",
      `  npx -y bun@${declared} run <script>`,
      `  curl -fsSL https://bun.sh/install | bash -s "bun-v${declared}"`,
      "",
      `To run on Bun ${running} on purpose, set ${ESCAPE_VARIABLE}=1.`,
    ].join("\n"),
  );
  process.exit(1);
}
