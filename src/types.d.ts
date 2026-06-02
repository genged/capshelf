// Ambient shim so `import md from "./foo.md"` type-checks as a string. The CLI
// inlines its bootstrap skill text this way (see src/bundled.ts importing
// SKILL.md), which Bun's bundler resolves to the file's contents at build time.
declare module "*.md" {
  const content: string;
  export default content;
}
