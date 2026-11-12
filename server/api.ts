import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { caseIds } from "../shared/contracts.ts";
import { caseView, evidenceFor } from "./data.ts";
import { configuredModels } from "./models.ts";
import type { AgentModels } from "./models.ts";
import { openStore } from "./store.ts";
import { investigate } from "./workflow.ts";

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return null;
  let content = "";
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    content += String(chunk);
    if (content.length > 2048) return null;
  }
  try { return JSON.parse(content); } catch { return null; }
}

const createSchema = z.object({ caseId: z.enum(caseIds) });
const decisionSchema = z.object({ decision: z.enum(["approved", "rejected"]) });

export function createApi({
  dbPath = resolve(process.env.MARGINOPS_DB_PATH ?? ".marginops/runs.sqlite"),
  models = configuredModels(),
} : { dbPath?: string; models?: AgentModels } = {}) {
  const store = openStore(dbPath);
  store.recover();
  const events = new EventEmitter().setMaxListeners(0);
  const jobs = new Set<Promise<void>>();

  function runJob(id: string, caseId: (typeof caseIds)[number]) {
    const job = investigate(caseId, models, (event) => {
      if (store.append(id, event)) events.emit(id);
    }).then((report) => {
      if (store.complete(id, report)) events.emit(id);
    }).catch((error: unknown) => {
      const message = models.mode === "live"
        ? "模型调用或证据审阅未完成。请检查模型配置后重新研判。"
        : "本次研判未能通过证据审阅。请重新研判。";
      console.error("Investigation failed", id, error instanceof Error ? error.name : "Unknown error");
      if (store.fail(id, message)) events.emit(id);
    }).finally(() => jobs.delete(job));
    jobs.add(job);
  }

  function stream(res: ServerResponse, id: string) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const push = () => {
      const snapshot = store.read(id);
      if (!snapshot || res.writableEnded) return;
      res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      if (snapshot.status !== "running") res.end();
    };
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
    res.on("close", () => {
      clearInterval(heartbeat);
      events.off(id, push);
    });
    events.on(id, push);
    push();
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (!path.startsWith("/api/")) return false;
    try {
      if (req.method === "POST" &&
          (req.headers["sec-fetch-site"] === "cross-site" ||
            (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`))) {
        json(res, 403, { error: "只允许从研判台同源提交操作。" });
      } else if (req.method === "GET" && path === "/api/bootstrap") {
        json(res, 200, { mode: models.mode, cases: caseIds.map(caseView), runs: store.list() });
      } else if (req.method === "POST" && path === "/api/runs") {
        const input = createSchema.safeParse(await body(req));
        if (!input.success) {
          json(res, 400, { error: "请选择有效案例。" });
        } else {
          const { caseId } = input.data;
          const { id, created } = store.create(caseId, models.mode, evidenceFor(caseId));
          json(res, created ? 202 : 200, store.read(id));
          if (created) runJob(id, caseId);
        }
      } else {
        const route = /^\/api\/runs\/([a-f0-9-]{36})(?:\/(stream|decision))?$/.exec(path);
        const run = route && store.read(route[1]);
        if (!route || !run) {
          json(res, 404, { error: "未找到研判记录。" });
        } else if (req.method === "GET" && route[2] === "stream") {
          stream(res, run.id);
        } else if (req.method === "GET" && !route[2]) {
          json(res, 200, run);
        } else if (req.method === "POST" && route[2] === "decision") {
          const input = decisionSchema.safeParse(await body(req));
          if (!input.success) {
            json(res, 400, { error: "请选择批准或驳回。" });
          } else if (!store.decide(run.id, input.data.decision)) {
            json(res, 409, { error: "当前记录已经处理，或尚未进入人工审批。" });
          } else {
            events.emit(run.id);
            json(res, 200, store.read(run.id));
          }
        } else {
          json(res, 405, { error: "该操作不受支持。" });
        }
      }
    } catch (error) {
      console.error("API error", error instanceof Error ? error.name : "Unknown error");
      if (!res.headersSent) json(res, 500, { error: "操作失败，请重试。" });
      else res.end();
    }
    return true;
  }

  return { handle, async close() { await Promise.allSettled([...jobs]); store.close(); } };
}
