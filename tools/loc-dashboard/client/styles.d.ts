// Ambient shim for the side-effect stylesheet import in `app.tsx`. Bun's
// bundler handles the file. The type checker must only know the module exists.
declare module "*.css";
