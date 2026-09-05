// Ambient shim so `import md from "./foo.md"` type-checks as a string. The CLI
// inlines its bootstrap skill text this way (see src/bundled.ts importing
// SKILL.md), which Bun's bundler resolves to the file's contents at build time.
declare module "*.md" {
  const content: string;
  export default content;
}

// The web UI's compiled bundle, produced by `bun run build:ui` into
// `src/ui/generated/` and inlined into the binary with `with { type: "text" }`.
declare module "*/generated/app.js" {
  const content: string;
  export default content;
}
declare module "*/generated/app.css" {
  const content: string;
  export default content;
}

// A file import (`with { type: "file" }`) resolves to a path. In the compiled
// binary the file is embedded and the path reads through `Bun.file`.
declare module "*.png" {
  const path: string;
  export default path;
}
