interface OperationCounts {
  successful: number;
  failed: number;
  distinct: Set<string>;
}

const operations = new Map<string, OperationCounts>();
const spawns = new Map<string, number>();
let registered = false;

export function recordGitRead(
  operation: string,
  repository: string,
  args: string[],
  success: boolean,
  subprocess: boolean,
): void {
  if (process.env.CAPSHELF_GIT_MEASURE !== "1") return;
  if (!registered) {
    registered = true;
    process.once("exit", () => {
      console.error(
        JSON.stringify({
          type: "git-summary",
          spawns: Object.fromEntries(spawns),
          totalSpawns: [...spawns.values()].reduce(
            (sum, count) => sum + count,
            0,
          ),
          operations: Object.fromEntries(
            [...operations].map(([name, count]) => [
              name,
              {
                successful: count.successful,
                distinct: count.distinct.size,
                failed: count.failed,
              },
            ]),
          ),
        }),
      );
    });
  }
  if (subprocess) spawns.set(operation, (spawns.get(operation) ?? 0) + 1);
  const count = operations.get(operation) ?? {
    successful: 0,
    failed: 0,
    distinct: new Set<string>(),
  };
  if (success) {
    count.successful += 1;
    count.distinct.add(JSON.stringify([repository, args]));
  } else {
    count.failed += 1;
  }
  operations.set(operation, count);
  console.error(
    JSON.stringify({
      type: "git-read",
      operation,
      repository,
      arguments: args,
      outcome: success ? "success" : "failure",
      subprocess,
    }),
  );
}
