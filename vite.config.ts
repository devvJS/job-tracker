import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // The API server listens on PORT (from the environment or .env); in dev, Vite proxies the API to it.
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = `http://localhost:${env.PORT || 3000}`;

  return {
    base: "/job-tracker/",
    plugins: [react()],
    build: { outDir: "dist" },
    server: {
      proxy: {
        "/job-tracker/api": { target: apiTarget },
        "/job-tracker/healthz": { target: apiTarget },
      },
    },
  };
});
