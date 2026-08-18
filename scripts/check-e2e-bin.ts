/**
 * Fail once, before the suite starts, when the executable under test is
 * missing or unusable. The harness validates it again per test — this only
 * turns one setup mistake into one message instead of one per scenario.
 */
import { resolveCapshelfBinary } from "../e2e/support/binary";

try {
  const binary = await resolveCapshelfBinary();
  process.stdout.write(`e2e binary: ${binary}\n`);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
