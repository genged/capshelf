/**
 * Temp-name counter is module state, so a fresh process starts at 0 and the
 * planted symlink names are predictable.
 */
import { symlink } from "node:fs/promises";
import { atomicWriteFile } from "../src/fs-utils";

const [root, target, victim, count, content] = process.argv.slice(2);
if (!root || !target || !victim || !count || content === undefined) {
  throw new Error("usage: atomic-write-child root target victim count content");
}
for (let index = 0; index < Number(count); index++) {
  await symlink(victim, `${target}.${process.pid}.${index}.tmp`);
}
await atomicWriteFile(target, content, { root });
