/**
 * A child process for the `atomicWriteFile` planted-temp-name test. The temp
 * name counter is module state, so a fresh process starts it at 0. This script
 * plants symlinks at the first `count` temp names for its own pid, then writes
 * `target` inside `root`. The parent process checks the disk afterwards.
 *
 * Arguments: root, target, victim, count, content.
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
