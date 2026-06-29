import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "" keeps asset URLs relative so the build works when served from the
// capshelf binary at any host/port. /api is proxied to a running `capshelf
// serve` during `vite dev`.
export default defineConfig({
  plugins: [react()],
  base: "",
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5181,
    proxy: { "/api": "http://127.0.0.1:4717" },
  },
});
