import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { createApi } from "./api.ts";

const port = Number(process.env.PORT ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535.");
const dist = resolve("dist");
const index = await readFile(resolve(dist, "index.html"));
const api = createApi();
const mime: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
};

const server = createServer((req, res) => {
  void (async () => {
    if (await api.handle(req, res)) return;
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(index);
      return;
    }
    if (req.method === "GET" && /^\/assets\/[\w.-]+\.(?:css|js|woff2)$/.test(path)) {
      try {
        const asset = await readFile(resolve(dist, path.slice(1)));
        res.writeHead(200, { "Content-Type": mime[extname(path)], "Cache-Control": "public, max-age=31536000, immutable" });
        res.end(asset);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    res.writeHead(404).end("Not found");
  })().catch(() => res.writeHead(500).end("Unexpected error"));
});
server.once("close", () => { void api.close(); });
server.listen(port, "127.0.0.1", () => console.log(`MarginOps → http://127.0.0.1:${port}`));
