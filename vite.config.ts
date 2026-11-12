import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { createApi } from "./server/api.ts";

export default defineConfig(({ mode }) => ({
  plugins: [react(), {
    name: "marginops-local-api",
    configureServer(server) {
      Object.assign(process.env, { ...loadEnv(mode, process.cwd(), ["MARGINOPS_", "OPENAI_"]), ...process.env });
      const api = createApi();
      server.middlewares.use((req, res, next) => {
        void api.handle(req, res).then((handled) => { if (!handled) next(); }, next);
      });
      server.httpServer?.once("close", () => { void api.close(); });
    },
  }],
}));
