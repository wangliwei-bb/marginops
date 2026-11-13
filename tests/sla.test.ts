import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import type { AnalysisSource } from "../shared/analysis.ts";
import { slaSampleWeek } from "../shared/sla.ts";
import type { SlaReview } from "../shared/sla.ts";
import { profileWorkbook } from "../server/analysis-data.ts";
import { createApi } from "../server/api.ts";
import { replayModels } from "../server/models.ts";
import { reviewSla } from "../server/sla.ts";

const sample = await readFile(new URL("../server/samples/service-sla.xlsx", import.meta.url));

test("SLA uses each cohort's cutoff and retains cancellation and late-reply evidence", async () => {
  const book = await profileWorkbook(sample, "工单.xlsx", 1);
  const sheet = book.tables.find(({ name }) => name === "客服工单")!;
  const ticket = sheet.rows.find(({ values }) => values[0] === "SLA-P-1-01")!;
  ticket.values[2] = "2026-11-02 08:01";
  const { review, snapshot } = await reviewSla(book, slaSampleWeek);
  const data = snapshot.tables[0];
  const detail = data.columns.findIndex(({ name }) => name === "超时明细");
  assert.equal(data.rows.find(({ row }) => row === ticket.row)?.values[detail], "未响应超时");
  assert.deepEqual(review.counts.current, { received: 39, cancelled: 1, pending: 1 });
  assert.deepEqual(review.counts.previous, { received: 32, cancelled: 1, pending: 1 });
  assert.equal(review.current?.groups[0].value, 7 / 16);
  assert.equal(review.previous?.groups.find(({ label }) => label === "在线聊天")?.value, 2 / 12);
  assert.deepEqual(review.backlog?.groups.map(({ label, value }) => [label, value]), [["一线支持", 4], ["客户运营", 1]]);
  ticket.values[2] = "2026-10-25 08:01";
  await assert.rejects(reviewSla(book, slaSampleWeek), /第 2 行.*早于受理时间/);
});

test("SLA sample and imported workbooks provide reusable row citations", async (t) => {
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
  const base = `http://127.0.0.1:${address.port}/api/analysis`;
  const review = (body: unknown) => fetch(base + "/sla", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body) });
  assert.equal((await fetch(base + "/sla/template")).status, 200);
  const result = await (await review({ sample: true })).json() as SlaReview;
  assert(result.current);
  const rerun = await (await review({ sample: true })).json() as SlaReview;
  assert.equal(rerun.current?.id, result.current.id);
  const sources = await (await fetch(`${base}/reports/${result.current.id}/source?group=${result.current.groups[0].id}`)).json() as AnalysisSource;
  assert.equal(sources.sheet, "客服工单");
  assert.equal(sources.rows.filter(({ use }) => use === "numerator").length, 7);
  assert.equal(sources.rows.filter(({ use }) => use === "excluded").length, 2);
  assert(sources.rows.some(({ row, values }) => row === 34 && values[0] === "SLA-C-1-01"));
  const upload = await fetch(base + "/workbooks?name=custom.xlsx&headerRow=1", {
    method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: Uint8Array.from(sample),
  });
  assert.equal(upload.status, 200);
  const book = await upload.json();
  const custom = await (await review({ sample: false, workbookId: book.id, weekStart: slaSampleWeek })).json() as SlaReview;
  assert.equal(custom.workbookId, book.id);
  assert.equal(custom.backlog?.groups[0].value, 4);
  const list = await (await fetch(base + "/workbooks")).json();
  assert.deepEqual(list.workbooks.map(({ id }: { id: string }) => id), [book.id]);
});
