import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { caseIds } from "../shared/contracts.ts";
import type { CaseId, CaseView, Evidence } from "../shared/contracts.ts";
import { businessLedger, caseView, evidenceFor, productPerformance, sampleCase } from "./data.ts";
import { importWorkbook, WorkbookError, workbookBody, workbookMime } from "./import.ts";
import { configuredModels, replayModels } from "./models.ts";
import type { AgentModels } from "./models.ts";
import { openStore } from "./store.ts";
import { investigateCase } from "./workflow.ts";
import { profileWorkbook } from "./analysis-data.ts";
import { AnalysisClarification } from "./analysis-engine.ts";
import { analyzeWorkbook, configuredPlanner } from "./analysis-workflow.ts";
import type { AnalysisSource } from "../shared/analysis.ts";

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 2048) return null;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
}

const caseSchema = z.union([z.enum(caseIds), z.templateLiteral(["import-", z.string().regex(/^[a-f0-9]{64}$/)])]);
const createSchema = z.object({ caseId: caseSchema, allowLive: z.boolean().optional() });
const decisionSchema = z.object({ decision: z.enum(["approved", "rejected"]) });
const taskUpdateSchema = z.object({ stage: z.enum(["in_progress", "completed"]), note: z.string().trim().min(1).max(240) });
const workbookId = z.string().regex(/^[a-f0-9]{64}$/);
const analysisUpload = z.object({
  name: z.string().trim().min(1).max(120), headerRow: z.coerce.number().int().min(1).max(30).default(1),
});
const analysisRequest = z.object({
  workbookId, question: z.string().trim().min(3).max(240), sheet: z.string().min(1).max(31).optional(),
  allowLive: z.boolean().optional(),
});
const sourceRequest = z.object({ group: z.coerce.number().int().min(1), page: z.coerce.number().int().min(1).max(1000).default(1) });

export function createApi({
  dbPath = process.env.MARGINOPS_DB_PATH ?? resolve(".marginops", "runs.sqlite"),
  models = configuredModels(),
} : { dbPath?: string; models?: AgentModels } = {}) {
  const store = openStore(dbPath);
  store.recover();
  const events = new EventEmitter().setMaxListeners(0);
  const jobs = new Set<Promise<void>>();
  const local = replayModels();
  const planner = configuredPlanner();
  let pendingAnalyses = 0;

  function lookup(raw: string) {
    const id = caseSchema.safeParse(raw);
    if (!id.success) return undefined;
    return sampleCase(id.data) ?? store.readCase(id.data as CaseId);
  }

  function runJob(id: string, scenario: CaseView, evidence: Evidence[], engine: AgentModels) {
    const job = investigateCase(scenario, evidence, engine, (event) => {
      if (store.append(id, event)) events.emit(id);
    }).then((report) => {
      if (store.complete(id, report)) events.emit(id);
    }).catch((error: unknown) => {
      const message = engine.mode === "live"
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
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (!path.startsWith("/api/")) return false;
    try {
      if (req.method === "POST" &&
          (req.headers["sec-fetch-site"] === "cross-site" ||
            (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`))) {
        json(res, 403, { error: "只允许从研判台同源提交操作。" });
      } else if (req.method === "GET" && path === "/api/bootstrap") {
        json(res, 200, { mode: models.mode, cases: [
          ...caseIds.map((id) => caseView(id)), ...store.listCases(),
        ], runs: store.list() });
      } else if (req.method === "GET" && path === "/api/import/template") {
        const template = await readFile(resolve("public", "marginops-import.xlsx"));
        res.writeHead(200, { "Content-Type": workbookMime, "Content-Disposition": 'attachment; filename="marginops-import.xlsx"' });
        res.end(template);
      } else if (req.method === "POST" && path === "/api/import") {
        const { data, result } = await importWorkbook(await workbookBody(req), Object.fromEntries(url.searchParams));
        store.saveCase(data, caseView(data.id, data));
        json(res, 200, result);
      } else if (req.method === "GET" && path === "/api/analysis/workbooks") {
        json(res, 200, { workbooks: store.listWorkbooks(), live: !!planner });
      } else if (req.method === "POST" && path === "/api/analysis/workbooks") {
        const options = analysisUpload.safeParse(Object.fromEntries(url.searchParams));
        if (!options.success) throw new WorkbookError([{ message: "请填写工作簿名称和有效表头行（1–30）。" }], 400);
        const book = await profileWorkbook(await workbookBody(req), options.data.name, options.data.headerRow);
        store.saveWorkbook(book);
        json(res, 200, book.summary);
      } else if (req.method === "GET" && path === "/api/analysis/reports") {
        const id = workbookId.safeParse(url.searchParams.get("workbookId"));
        if (!id.success) json(res, 400, { error: "请选择工作簿。" });
        else json(res, 200, store.listAnalyses(id.data));
      } else if (req.method === "POST" && path === "/api/analysis/reports") {
        const input = analysisRequest.safeParse(await body(req));
        if (!input.success) {
          json(res, 400, { error: "请选择工作簿，并用 3–240 字写出业务问题。" });
        } else if (pendingAnalyses >= 3) {
          json(res, 429, { error: "已有分析正在运行，请稍后再试。" });
        } else {
          const { workbookId, question, sheet, allowLive } = input.data;
          const book = store.readWorkbook(workbookId);
          if (!book) json(res, 404, { error: "未找到工作簿。" });
          else if (allowLive && !planner) json(res, 400, { error: "本机尚未配置实时模型。" });
          else {
            pendingAnalyses += 1;
            const job = (async () => {
              try {
                const { report, sources } = await analyzeWorkbook(book, question, sheet, allowLive ? planner : undefined);
                store.saveAnalysis(report, sources);
                json(res, 200, { report });
              } catch (error) {
                if (error instanceof AnalysisClarification) json(res, 200, { clarification: error.message });
                else throw error;
              } finally { pendingAnalyses -= 1; }
            })();
            const settled = job.then(() => {}, () => {});
            jobs.add(settled);
            try { await job; } finally { jobs.delete(settled); }
          }
        }
      } else if (req.method === "GET" && /^\/api\/analysis\/reports\/[a-f0-9-]{36}\/source$/.test(path)) {
        const params = sourceRequest.safeParse(Object.fromEntries(url.searchParams));
        const analysis = params.success && store.readAnalysis(path.split("/")[4]);
        const table = analysis && store.readWorkbook(analysis.report.workbookId)?.tables.find(({ name }) => name === analysis.report.sheet);
        const citations = params.success && analysis && analysis.sources[params.data.group];
        if (!params.success) json(res, 400, { error: "请选择有效的证据分组。" });
        else if (!table || !citations) json(res, 404, { error: "未找到此分组的源数据。" });
        else {
          const index = new Map(table.rows.map(({ row, values }) => [row, values]));
          const start = (params.data.page - 1) * 20;
          const source: AnalysisSource = { sheet: table.name, columns: table.columns, total: citations.length,
            rows: citations.slice(start, start + 20).map(({ row, use }) => ({ row, use, values: index.get(row)! })) };
          json(res, 200, source);
        }
      } else if (req.method === "GET" && /^\/api\/cases\/[^/]+\/(ledger|products)$/.test(path)) {
        const [, , , id, type] = path.split("/");
        const data = lookup(id);
        const output = data && (type === "ledger" ? businessLedger(data.id, data)
          : productPerformance(data.id, url.searchParams.get("channel"), data));
        if (output) json(res, 200, output);
        else json(res, 404, { error: "未找到该案例或渠道的数据。" });
      } else if (req.method === "GET" && path === "/api/tasks") {
        json(res, 200, store.listTasks());
      } else if (req.method === "POST" && /^\/api\/tasks\/[a-f0-9-]{36}$/.test(path)) {
        const input = taskUpdateSchema.safeParse(await body(req));
        if (!input.success) {
          json(res, 400, { error: "请填写 1–240 字的执行记录或复盘结论。" });
        } else {
          const outcome = store.updateTask(path.split("/")[3], input.data.stage, input.data.note);
          if (outcome.result === "missing") json(res, 404, { error: "未找到已批准的处置任务。" });
          else if (outcome.result === "conflict") json(res, 409, { error: "任务状态已更新，请查看最新进展。" });
          else json(res, 200, outcome.task);
        }
      } else if (req.method === "POST" && path === "/api/runs") {
        const input = createSchema.safeParse(await body(req));
        if (!input.success) {
          json(res, 400, { error: "请选择有效案例。" });
        } else {
          const { caseId } = input.data;
          const data = lookup(caseId);
          if (!data) {
            json(res, 404, { error: "未找到该研判案例。" });
          } else {
            const engine = data.source === "excel" && !input.data.allowLive ? local : models;
            const evidence = evidenceFor(data.id, data);
            const { id, created } = store.create(data.id, engine.mode, evidence);
            json(res, created ? 202 : 200, store.read(id));
            if (created) runJob(id, caseView(data.id, data), evidence, engine);
          }
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
      if (error instanceof WorkbookError) {
        json(res, error.status, { error: error.message, issues: error.issues });
        return true;
      }
      console.error("API error", error instanceof Error ? error.name : "Unknown error");
      if (!res.headersSent) json(res, 500, { error: "操作失败，请重试。" });
      else res.end();
    }
    return true;
  }

  return { handle, async close() { await Promise.allSettled([...jobs]); store.close(); } };
}
