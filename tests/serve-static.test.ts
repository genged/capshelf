import { describe, expect, test } from "bun:test";
import { staticTarget } from "../src/commands/serve";

// staticTarget confines a request path to the web dir or returns null. These
// guard the path-traversal fix (a bare startsWith let "<dir>-evil" through).
describe("staticTarget path confinement", () => {
  const DIR = "/srv/app/web/dist";

  test("maps / to index.html inside the dir", () => {
    expect(staticTarget(DIR, "/")).toBe(`${DIR}/index.html`);
  });

  test("resolves a normal nested asset", () => {
    expect(staticTarget(DIR, "/assets/app.js")).toBe(`${DIR}/assets/app.js`);
  });

  test("collapses . segments but stays inside", () => {
    expect(staticTarget(DIR, "/./assets/./app.js")).toBe(
      `${DIR}/assets/app.js`,
    );
  });

  test("rejects parent traversal", () => {
    expect(staticTarget(DIR, "/../package.json")).toBeNull();
    expect(staticTarget(DIR, "/../../etc/passwd")).toBeNull();
  });

  test("rejects a sibling-directory prefix bypass", () => {
    // "/srv/app/web/dist-evil/x" must NOT pass: it shares the dist prefix but
    // is a different directory. This is the bug the trailing-sep check fixes.
    expect(staticTarget(DIR, "/../dist-evil/secret")).toBeNull();
  });

  test("rejects a path that normalizes to the parent itself", () => {
    expect(staticTarget(DIR, "/..")).toBeNull();
  });
});
