import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      input: { blackboard: "index.html", collective: "collective.html" },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4508,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:4510", "/j": "http://127.0.0.1:4510" },
  },
  preview: { host: "127.0.0.1", port: 4509, strictPort: true },
});
