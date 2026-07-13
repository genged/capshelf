export const PRODUCT_NAME = "capshelf";

export const HOME_ENV = "CAPSHELF_HOME";

export const MANIFEST_FILE = "capshelf.json";
export const METADATA_DIR = ".capshelf";
export const LOCAL_CONFIG_FILE = "local.json";

// The per-item catalog sidecar. Lives here (a leaf) rather than in metadata.ts
// so master.ts can reference it without importing metadata.ts, which imports
// back from master.ts — that pair was a module cycle.
export const METADATA_SIDECAR = ".capshelf.yml";

export const LOCK_FILE = "capshelf.lock.json";
export const LOCAL_LOCK_FILE = "local.lock.json";

export const SYSTEM_SKILL_NAME = "capshelf";
