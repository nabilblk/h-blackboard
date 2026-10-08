import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("./dev/ui", import.meta.url)),
  server: {
    host: "127.0.0.1",
    port: 4518,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL(".", import.meta.url))] },
  },
  build: { outDir: "../../var/ui-catalog", emptyOutDir: true },
});
