import {
  destinationKey,
  probeDestinationFolding,
  type DestinationFolding,
} from "./pin";

const NO_FOLDING: DestinationFolding = {
  caseFolding: false,
  normalizationFolding: false,
};

const ALL_FOLDING: DestinationFolding = {
  caseFolding: true,
  normalizationFolding: true,
};

export interface PathCollision {
  left: string;
  right: string;
}

export function pathsCollide(
  left: string,
  right: string,
  folding: DestinationFolding = NO_FOLDING,
): boolean {
  const leftKey = destinationKey(left, folding);
  const rightKey = destinationKey(right, folding);
  return (
    leftKey === rightKey ||
    leftKey.startsWith(`${rightKey}/`) ||
    rightKey.startsWith(`${leftKey}/`)
  );
}

export async function findDestinationPathCollision(
  destination: string,
  leftPaths: readonly string[],
  rightPaths: readonly string[],
): Promise<PathCollision | null> {
  const exact = findPathCollision(leftPaths, rightPaths, NO_FOLDING);
  if (exact) return exact;
  if (!findPathCollision(leftPaths, rightPaths, ALL_FOLDING)) return null;
  return findPathCollision(
    leftPaths,
    rightPaths,
    await probeDestinationFolding(destination),
  );
}

function findPathCollision(
  leftPaths: readonly string[],
  rightPaths: readonly string[],
  folding: DestinationFolding,
): PathCollision | null {
  for (const left of leftPaths) {
    const right = rightPaths.find((candidate) =>
      pathsCollide(left, candidate, folding),
    );
    if (right) return { left, right };
  }
  return null;
}
