import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { caseIds, productProfit } from "../shared/contracts.ts";
import type { ActionTask, BusinessLedger, ProductPerformance, Run } from "../shared/contracts.ts";
import { createApi } from "../server/api.ts";
import { businessLedger, caseView, evidenceFor } from "../server/data.ts";
import { replayModels } from "../server/models.ts";
import { openStore } from "../server/store.ts";
import { investigate } from "../server/workflow.ts";
import type { EventInput } from "../server/workflow.ts";

test("case charts and evidence reconcile with the accounting bridge", () => {
  for (const id of caseIds) {
    const scenario = caseView(id);
    const sum = (series: "previous" | "current") => scenario.daily.reduce((total, day) => total + day[series], 0);
    assert.equal(sum("current"), scenario.metrics.contribution);
    assert.equal(sum("previous"), scenario.baseline.contribution);
    assert.equal(evidenceFor(id).reduce((total, fact) => total + fact.impact, 0), sum("current") - sum("previous"));
  }
});

test("each evidence figure links to source transactions in both periods", () => {
  for (const id of caseIds) {
    const { transactions } = businessLedger(id);
    assert.equal(new Set(transactions.map((row) => row.id)).size, transactions.length);
    for (const fact of evidenceFor(id)) {
      const source = transactions.filter((row) => row.channel === fact.channel && row.metric === fact.metric);
      for (const period of ["current", "previous"] as const) {
        assert.equal(source.filter((row) => row.period === period).reduce((sum, row) => sum + row.amount, 0), fact[period]);
      }
    }
    const payments = new Map(transactions.filter((row) => row.metric === "sales").map((row) => [row.orderId, row]));
    for (const row of transactions.filter((entry) => entry.metric === "refunds" || entry.metric === "cogs")) {
      const payment = payments.get(row.orderId);
      assert(payment);
      assert.equal(row.channel, payment.channel);
      assert.equal(row.period, payment.period);
      assert.deepEqual(row.product, payment.product);
      assert(row.occurredAt > payment.occurredAt);
      if (row.metric === "refunds") assert(row.amount <= payment.amount);
    }
  }
});

test("specialists overlap and all report before synthesis starts", { timeout: 3000 }, async () => {
  const base = replayModels();
  const observed: EventInput[] = [];
  const gate = Promise.withResolvers<void>();
  let arrived = 0;
  const report = await investigate("promotion", {
    ...base,
    async investigate(input) {
      arrived += 1;
      if (arrived === 3) gate.resolve();
      await gate.promise;
      return base.investigate(input);
    },
  }, (event) => observed.push(event));
  assert.equal(report.findings.length, 3);
  const firstSynthesis = observed.findIndex((event) => event.step === "synthesis");
  assert.equal(observed.slice(0, firstSynthesis).filter((event) => event.phase === "tool").length, 3);
});

test("unsupported evidence triggers a bounded revision and repaired draft", async () => {
  const base = replayModels();
  let rounds = 0;
  const report = await investigate("promotion", {
    ...base,
    async synthesize(input) {
      const good = await base.synthesize(input);
      rounds += 1;
      if (rounds === 1) return { ...good, evidenceIds: ["invented-42"] };
      assert.match(input.feedback ?? "", /引用无效/);
      return good;
    },
  }, () => {});
  assert.equal(report.attempts, 2);
  assert.deepEqual(report.evidenceIds, ["cogs-1"]);
});

test("persistent reviewer rejection cannot produce a report", async () => {
  const observed: EventInput[] = [];
  await assert.rejects(investigate("returns", {
    ...replayModels(),
    async review() { return { approved: false, note: "修订" }; },
  }, (event) => observed.push(event)), /rejected all drafts/);
  assert.equal(observed.filter((event) => event.step === "synthesis" && event.phase === "started").length, 3);
});

test("an approval survives restart and an interrupted run becomes retryable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "marginops-test-"));
  const file = join(directory, "state.sqlite");
  try {
    const report = await investigate("promotion", replayModels(), () => {});
    const first = openStore(file);
    let runId: string;
    let pendingId: string;
    try {
      runId = first.create("promotion", "replay", evidenceFor("promotion")).id;
      const duplicate = first.create("promotion", "replay", evidenceFor("promotion"));
      assert.deepEqual(duplicate, { id: runId, created: false });
      assert.equal(first.decide(runId, "approved"), false);
      assert.equal(first.complete(runId, report), true);
      assert.equal(first.decide(runId, "approved"), true);
      assert.equal(first.decide(runId, "rejected"), false);
      assert.equal(first.listTasks().find((task) => task.runId === runId)?.stage, "pending");
      assert.equal(first.updateTask(runId, "in_progress", "核对出库批次").result, "updated");
      assert.equal(first.updateTask(runId, "completed", "复核商品成本率").result, "updated");
      pendingId = first.create("returns", "replay", evidenceFor("returns")).id;
      assert.equal(first.updateTask(pendingId, "in_progress", "不应开始").result, "missing");
    } finally { first.close(); }
    const next = openStore(file);
    try {
      next.recover();
      assert.equal(next.read(runId)?.decision?.value, "approved");
      const task = next.listTasks().find((item) => item.runId === runId);
      assert.equal(task?.stage, "completed");
      assert.deepEqual(task?.updates.map(({ note }) => note), ["核对出库批次", "复核商品成本率"]);
      assert.equal(next.read(pendingId)?.status, "failed");
      assert.equal(next.create("returns", "replay", evidenceFor("returns")).created, true);
    } finally { next.close(); }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("API streams the report and records exactly one concurrent decision", async (t) => {
  const api = createApi({ dbPath: ":memory:", models: replayModels() });
  const server = createServer((req, res) => { void api.handle(req, res); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await api.close();
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const send = (path: string, data: unknown) => fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  assert.equal((await send("/api/runs", { caseId: "missing" })).status, 400);
  assert.equal((await fetch(base + "/api/cases/missing/ledger")).status, 404);
  const ledger = await (await fetch(base + "/api/cases/acquisition/ledger")).json() as BusinessLedger;
  const channel = ledger.channels[0];
  const products = await (await fetch(base + "/api/cases/acquisition/products?channel=" + encodeURIComponent(channel.name)))
    .json() as { products: ProductPerformance[] };
  for (const period of ["current", "previous"] as const) {
    assert.equal(products.products.reduce((sum, product) => sum + productProfit(product.amounts[period]), 0),
      productProfit(channel.amounts[period]));
  }
  assert.equal((await fetch(base + "/api/cases/acquisition/products?channel=missing")).status, 404);
  const response = await send("/api/runs", { caseId: "acquisition" });
  assert.equal(response.status, 202);
  const created = await response.json() as Run;
  const path = `/api/runs/${created.id}`;
  const stream = await fetch(base + path + "/stream");
  assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.match(await stream.text(), /"status":"review_required"/);
  const decisions = await Promise.all([
    send(path + "/decision", { decision: "approved" }),
    send(path + "/decision", { decision: "approved" }),
  ]);
  assert.deepEqual(decisions.map(({ status }) => status).sort(), [200, 409]);
  const result = await (await fetch(base + path)).json() as Run;
  assert.equal(result.report?.driver, "ads");
  const fact = result.evidence.find((entry) => entry.id === result.report?.evidenceIds[0]);
  assert(fact);
  assert.equal(ledger.transactions.filter((row) => row.period === "current" && row.channel === fact.channel && row.metric === fact.metric)
    .reduce((sum, row) => sum + row.amount, 0), fact.current);
  assert.equal(result.events.filter((event) => event.phase === "decision").length, 1);
  const taskPath = `/api/tasks/${created.id}`;
  const pending = await (await fetch(base + "/api/tasks")).json() as ActionTask[];
  assert.deepEqual(pending.map((task) => [task.runId, task.stage]), [[created.id, "pending"]]);
  assert.equal((await send(taskPath, { stage: "completed", note: "不能跳过执行" })).status, 409);
  assert.equal((await send(taskPath, { stage: "in_progress", note: "  " })).status, 400);
  const updates = await Promise.all([
    send(taskPath, { stage: "in_progress", note: "  核查广告组  " }),
    send(taskPath, { stage: "in_progress", note: "  核查广告组  " }),
  ]);
  assert.deepEqual(updates.map(({ status }) => status).sort(), [200, 409]);
  const completed = await (await send(taskPath, { stage: "completed", note: "已记录验证结果" })).json() as ActionTask;
  assert.equal(completed.stage, "completed");
  assert.deepEqual(completed.updates.map(({ note }) => note), ["核查广告组", "已记录验证结果"]);
});
