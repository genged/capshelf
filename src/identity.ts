export const PRODUCT_NAME = "capshelf";

export const HOME_ENV = "CAPSHELF_HOME";

export const MANIFEST_FILE = "capshelf.json";
export const METADATA_DIR = ".capshelf";
export const LOCAL_CONFIG_FILE = "local.json";

// Lives here so master.ts can use it without importing metadata.ts, which
// imports master.ts (cycle).
export const METADATA_SIDECAR = ".capshelf.yml";

export const LOCK_FILE = "capshelf.lock.json";
export const LOCAL_LOCK_FILE = "local.lock.json";
export const REMOTES_LOCK_FILE = "remotes.lock.json";

export const SYSTEM_SKILL_NAME = "capshelf";
