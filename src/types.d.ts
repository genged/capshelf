// Ambient shim so `.md` imports type as strings; Bun's bundler inlines the file
// contents at build time.
declare module "*.md" {
  const content: string;
  export default content;
}

declare module "*/generated/app.js" {
  const content: string;
  export default content;
}
declare module "*/generated/app.css" {
  const content: string;
  export default content;
}

// In the compiled binary the file is embedded, so the path reads through
// `Bun.file`.
declare module "*.png" {
  const path: string;
  export default path;
}
