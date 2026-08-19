import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev-server proxy: /api and /ws go to the control plane (27 §2).
// Mode B default is localhost; Mode A overrides via ACOS_API_PROXY_TARGET.
const apiTarget = process.env.ACOS_API_PROXY_TARGET ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    host: true,
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
      "/ws": { target: apiTarget, changeOrigin: true, ws: true },
    },
  },
});
