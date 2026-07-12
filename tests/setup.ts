// Test preload (see bunfig.toml). Isolate every git invocation — both the `$`
// calls in tests and the CLI spawns, which inherit process.env — from the
// contributor's machine config. Without this, a global `url.<x>.insteadOf`
// rewrite (corporate HTTPS proxies, SSH-rewrite setups, sandboxed CI) rewrites
// a seeded clone's origin, and capshelf correctly reports a mismatched upstream
// — reddening the bootstrap tests through no fault of the contributor.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
