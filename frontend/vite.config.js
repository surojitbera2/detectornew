import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: { "process.env.REACT_APP_BACKEND_URL": JSON.stringify(process.env.REACT_APP_BACKEND_URL || "") },
  server: { host: "0.0.0.0", port: 3000, allowedHosts: true, proxy: { "/api": "http://localhost:8001" } },
  preview: { host: "0.0.0.0", port: 3000, allowedHosts: true },
});
