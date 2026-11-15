/**
 * Also runs on postinstall so a source run (`bun run src/cli.ts`) always finds
 * the generated files.
 */
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const entry = join(root, "src", "ui", "client", "app.tsx");
const outdir = join(root, "src", "ui", "generated");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: [entry],
  outdir,
  target: "browser",
  format: "esm",
  minify: true,
  sourcemap: "none",
  naming: "[name].[ext]",
});

if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  process.exit(1);
}

const produced = (await readdir(outdir)).sort();
for (const required of ["app.css", "app.js"]) {
  if (!produced.includes(required)) {
    console.error(
      `build-ui: expected ${required} in ${outdir}, got ${produced.join(", ") || "nothing"}`,
    );
    process.exit(1);
  }
}
console.log(`built web UI: ${produced.join(", ")}`);
