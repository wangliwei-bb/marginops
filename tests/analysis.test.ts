import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import type { AnalysisOutcome, AnalysisPlan, AnalysisSource, BusinessProfile, WorkbookSummary } from "../shared/analysis.ts";
import { profileWorkbook } from "../server/analysis-data.ts";
import { analyzeWorkbook } from "../server/analysis-workflow.ts";
import { createApi } from "../server/api.ts";
import { replayModels } from "../server/models.ts";

const fixture = await readFile(new URL("./fixtures/service-tickets.xlsx", import.meta.url));
const question = "按部门比较平均处理时长";

test("chooses the relevant worksheet and preserves actual Excel rows", async () => {
  const book = await profileWorkbook(fixture, "服务工单.xlsx", 3);
  const { report, sources } = await analyzeWorkbook(book, question);
  assert.equal(report.sheet, "服务工单");
  assert.equal(report.plan.method, "average");
  assert.deepEqual(report.groups.map(({ label, value, used, excluded }) => [label, value, used, excluded]),
    [["运维", 6, 2, 1], ["支持", 2, 3, 0]]);
  assert.deepEqual(sources[report.groups[0].id], [
    { row: 4, use: "included" }, { row: 7, use: "included" }, { row: 9, use: "excluded" },
  ]);
  assert.equal(book.tables[0].columns[0].kind, "identifier");
  assert.equal(book.tables[0].columns[2].kind, "date");
});

test("calculates a monthly trend, a ratio, and a share with explicit denominators", async () => {
  const book = await profileWorkbook(fixture, "服务工单.xlsx", 3);
  const trend = (await analyzeWorkbook(book, "按月统计记录数")).report;
  assert.deepEqual(trend.groups.map(({ label, value }) => [label, value]), [["2026-11", 3], ["2026-12", 3]]);
  const ratio = (await analyzeWorkbook(book, "总处理费用除以总处理时长")).report;
  assert.deepEqual([ratio.groups[0].numerator, ratio.groups[0].denominator, ratio.groups[0].excluded], [490, 18, 1]);
  const share = (await analyzeWorkbook(book, "按部门统计状态等于“延期”的记录占比")).report;
  assert.deepEqual(share.groups.map(({ label, numerator, denominator, excluded }) => [label, numerator, denominator, excluded]),
    [["运维", 1, 2, 1], ["支持", 1, 3, 0]]);
  const zero = (await analyzeWorkbook(book, "按部门统计状态等于“未发生”的记录占比")).report;
  assert.deepEqual(zero.groups.map(({ numerator, denominator }) => [numerator, denominator]), [[0, 2], [0, 3]]);
});

test("requests clarification for causal and ambiguous questions and validates live plans", async () => {
  const book = await profileWorkbook(fixture, "服务工单.xlsx", 3);
  await assert.rejects(analyzeWorkbook(book, "为什么运维延期？"), /不能证明原因/);
  await assert.rejects(analyzeWorkbook(book, "每个部门有多少条记录？"), /指定要分析的工作表/);
  await assert.rejects(analyzeWorkbook(book, "按月按部门统计记录数", "服务工单"), /一个维度/);
  await assert.rejects(analyzeWorkbook(book, question, undefined, async (sheets) => {
    assert(sheets.every((sheet) => !("rows" in sheet)));
    return { sheet: "服务工单", clarification: null, plan: {
      method: "average", metric: "Z", denominator: null, group: "B", timeBucket: null, filters: [], match: null, order: "high",
    } };
  }), /不存在的字段/);
});

test("uploads a generic workbook, saves reports, and exposes cited cells by row", async (t) => {
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
  const upload = await fetch(`${base}/workbooks?name=service-tickets.xlsx&headerRow=3`, {
    method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: Uint8Array.from(fixture),
  });
  assert.equal(upload.status, 200);
  const book = await upload.json() as WorkbookSummary;
  const response = await fetch(base + "/reports", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workbookId: book.id, question, sheet: "服务工单" }) });
  const result = await response.json() as AnalysisOutcome;
  assert("report" in result);
  const { report } = result;
  const records = await (await fetch(`${base}/reports/${report.id}/source?group=${report.groups[0].id}`)).json() as AnalysisSource;
  assert.equal(records.total, 3);
  assert.deepEqual(records.rows.map(({ row, values, use }) => [row, values[3], use]),
    [[4, 4, "included"], [7, 8, "included"], [9, null, "excluded"]]);
  const history = await (await fetch(`${base}/reports?workbookId=${book.id}`)).json();
  assert.equal(history[0].id, report.id);

  const plan: AnalysisPlan = {
    method: "share", metric: null, denominator: null, group: "B", timeBucket: null, filters: [],
    match: { column: "E", operator: "eq", value: "延期" }, shareBase: "all", order: "high",
  };
  const profileUrl = `${base}/workbooks/${book.id}/profile`;
  const save = (path: string, body: unknown) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body) });
  const profile: BusinessProfile = { context: "一行是一张工单", metrics: [{ name: "延期率", sheet: "服务工单", plan }] };
  const invalid = { ...profile, metrics: [{ ...profile.metrics[0], plan: { ...plan, group: "Z" } }] };
  assert.equal((await save(profileUrl, invalid)).status, 422);
  assert.equal((await save(profileUrl, profile)).status, 200);
  assert.deepEqual(await (await fetch(profileUrl)).json(), profile);
  const named = await (await save(base + "/reports", { workbookId: book.id, question: "延期率", allowLive: true })).json() as AnalysisOutcome;
  assert("report" in named);
  assert.equal(named.report.mode, "manual");
  assert.deepEqual(named.report.groups.map(({ numerator, denominator }) => [numerator, denominator]), [[1, 3], [1, 3]]);
  const manual = await (await save(base + "/reports", { workbookId: book.id, question, sheet: "服务工单",
    manual: { ...plan, filters: [{ column: "B", operator: "neq", value: "支持" }] } })).json() as AnalysisOutcome;
  assert("report" in manual);
  assert.deepEqual(manual.report.groups.map(({ label, denominator }) => [label, denominator]), [["运维", 3]]);
});
