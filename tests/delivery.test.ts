import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { deliverySampleWeek } from "../shared/delivery.ts";
import { profileWorkbook } from "../server/analysis-data.ts";
import { reviewDelivery } from "../server/delivery.ts";
import { openStore } from "../server/store.ts";

const sample = await readFile(new URL("../server/samples/project-delivery.xlsx", import.meta.url));

test("delivery compares commitments and includes past-due items still open at cutoff", async () => {
  const book = await profileWorkbook(sample, "交付台账.xlsx", 1);
  const { review, snapshot, reports } = await reviewDelivery(book, deliverySampleWeek);
  assert.equal(review.cancelled, 1);
  assert.deepEqual(review.aging, { pastWeek: 2, highPriority: 3, sevenDays: 2 });
  assert.deepEqual(review.due?.groups.map(({ label, numerator, denominator }) => [label, numerator, denominator]),
    [["数据平台", 1, 1], ["运营支持", 3, 4], ["研发交付", 1, 4]]);
  assert.deepEqual(review.backlog?.groups.map(({ used }) => used), [3, 1, 1]);
  const table = snapshot.tables[0];
  const status = table.columns.findIndex(({ name }) => name === "期末交付状态");
  assert.equal(table.rows.find(({ values }) => values[0] === "D-010")?.values[status], "期末逾期未交");
  assert(!table.rows.some(({ values }) => values[0] === "D-013"));
  const store = openStore(":memory:");
  try {
    store.saveWorkbook(book);
    assert.equal(store.saveWeeklyReview("delivery", snapshot, reports, review), review);
    assert.equal(store.saveWeeklyReview("delivery", snapshot, reports, review).due?.id, review.due?.id);
    assert.deepEqual(store.listWorkbooks().map(({ id }) => id), [book.summary.id]);
    const backlog = store.readAnalysis(review.backlog!.id)!;
    assert.deepEqual(backlog.sources[review.backlog!.groups[0].id].map(({ row }) => row), [2, 3, 4]);
  } finally { store.close(); }
});

test("delivery reports the Excel row for conflicting completion data", async () => {
  const book = await profileWorkbook(sample, "交付台账.xlsx", 1);
  book.tables[0].rows[0].values[6] = "2026-11-03";
  book.tables[0].rows[0].values[7] = "2026-11-04";
  await assert.rejects(reviewDelivery(book, deliverySampleWeek), /第 2 行.*只填写实际交付日期或取消日期/);
});
