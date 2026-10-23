import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("./dev/experience-v2", import.meta.url)),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4529,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL(".", import.meta.url))] },
  },
  build: { outDir: "../../var/experience-v2", emptyOutDir: true },
});
