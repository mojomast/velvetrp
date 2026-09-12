import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Optional comma-separated extra hostnames for reverse-proxy or tailnet access.
const allowedHosts = (process.env.VELVET_ALLOWED_HOSTS ?? "").split(",").map((host) => host.trim()).filter(Boolean);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    ...(allowedHosts.length ? { allowedHosts } : {}),
    proxy: {
      "/api": {
        target: process.env.VELVET_API_URL ?? "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
