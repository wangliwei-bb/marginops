import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BusinessLedger, CaseView, ImportResult, Run } from "../shared/contracts.ts";
import { createApi } from "../server/api.ts";
import { importWorkbook, WorkbookError, workbookMime } from "../server/import.ts";
import { replayModels } from "../server/models.ts";
import { openStore } from "../server/store.ts";

const template = await readFile(new URL("../public/marginops-import.xlsx", import.meta.url));
const options = { name: "导入测试", currentStart: "2026-11-02", previousStart: "2026-10-26", days: "7" };

test("Excel validation rejects bad formats, overlapping and empty windows", async () => {
  await assert.rejects(importWorkbook(Buffer.from("not a workbook"), options), WorkbookError);
  await assert.rejects(importWorkbook(template, { ...options, previousStart: "2026-10-30" }), /不能重叠/);
  await assert.rejects(importWorkbook(template, { ...options, currentStart: "2026-11-09" }),
    (error: WorkbookError) => error.issues.some((issue) => issue.sheet === "订单" && /本期没有成交/.test(issue.message)));
});

test("Excel import persists its own ledger and runs the local approval workflow", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "marginops-import-"));
  const dbPath = join(directory, "state.sqlite");
  const models = {
    ...replayModels(), mode: "live" as const,
    async investigate() { assert.fail("Imported data must not use live mode by default."); },
  };
  const api = createApi({ dbPath, models });
  const server = createServer((req, res) => { void api.handle(req, res); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await api.close();
    try {
      const reopened = openStore(dbPath);
      try { assert.equal(reopened.listCases()[0]?.metrics.contribution, 426.8); }
      finally { reopened.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const download = await fetch(base + "/api/import/template");
  assert.equal(download.headers.get("content-type"), workbookMime);
  const bytes = await download.arrayBuffer();
  const upload = () => fetch(base + "/api/import?" + new URLSearchParams(options), {
    method: "POST", headers: { "Content-Type": workbookMime }, body: bytes,
  });
  const response = await upload();
  assert.equal(response.status, 200);
  const { caseId, rows, outside, hasFees } = await response.json() as ImportResult;
  assert.deepEqual(rows, { current: 7, previous: 4 });
  assert.equal(outside, 0);
  assert.equal(hasFees, true);
  assert.equal((await (await upload()).json() as ImportResult).caseId, caseId);
  const { cases } = await (await fetch(base + "/api/bootstrap")).json() as { cases: CaseView[] };
  assert.equal(cases.length, 4);
  const imported = cases.find((entry) => entry.id === caseId);
  assert.equal(imported?.source, "excel");
  assert.equal(imported?.metrics.contribution, 426.8);
  assert.equal(imported?.baseline.contribution, 374.7);
  const ledger = await (await fetch(base + `/api/cases/${caseId}/ledger`)).json() as BusinessLedger;
  assert.equal(ledger.transactions.find((row) => row.document === "RF-201")?.orderId, "SO-201");
  const products = await (await fetch(base + `/api/cases/${caseId}/products`)).json();
  assert.equal(products.products.length, 2);
  const post = (path: string, body: unknown) => fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const created = await (await post("/api/runs", { caseId })).json() as Run;
  const path = `/api/runs/${created.id}`;
  const stream = await fetch(base + path + "/stream");
  assert.match(await stream.text(), /"status":"review_required"/);
  const report = await (await fetch(base + path)).json() as Run;
  assert.equal(report.mode, "replay");
  assert.equal(report.report?.driver, "cogs");
  assert(report.evidence.some((fact) => fact.channel === "示例直播间" && fact.impact === -429.9));
  assert.equal((await post(path + "/decision", { decision: "approved" })).status, 200);
});
