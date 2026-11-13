import { z } from "zod";
import { deliveryHeaders, deliveryPriorities } from "../shared/delivery.ts";
import type { DeliveryReview } from "../shared/delivery.ts";
import type { AnalysisCell, AnalysisPlan } from "../shared/analysis.ts";
import { dayValue, hasValue } from "./analysis-data.ts";
import type { AnalysisWorkbook, Table } from "./analysis-data.ts";
import { AnalysisClarification } from "./analysis-engine.ts";
import { createReviewSnapshot, reviewKey } from "./review-snapshot.ts";

const day = 86_400_000;
const header = (value: string) => value.replace(/\s/g, "");
const dueMarker = "本周应交";
const overdueMarker = "期末逾期未交";
const columnNames = ["交付周期", "按期判定", "期末交付状态", "期末逾期天数"];
const emptyPlan: AnalysisPlan = {
  method: "count", metric: null, denominator: null, group: null, timeBucket: null, filters: [], match: null, order: "high",
};

function dateValue(value: AnalysisCell) {
  const date = dayValue(value);
  return date?.length === 10 ? Date.parse(date) : null;
}

export const deliveryReviewKey = (workbookId: string, weekStart: string) => reviewKey("delivery-v1", workbookId, weekStart);

export async function reviewDelivery(book: AnalysisWorkbook, weekStart: string) {
  if (!z.iso.date().safeParse(weekStart).success) throw new AnalysisClarification("请选择有效的本周开始日期。");
  const start = Date.parse(weekStart);
  const cutoff = start + 7 * day;
  const weekEnd = new Date(cutoff - day).toISOString().slice(0, 10);
  if (cutoff > Date.now() + 8 * 3_600_000) throw new AnalysisClarification("本周还未结束，请选择已结束的连续七天。");
  const table = book.tables.find(({ name }) => name === "项目交付");
  if (!table) throw new AnalysisClarification("找不到「项目交付」工作表，请使用项目交付模板，表头选第 1 行。");
  const indexes = deliveryHeaders.map((name) => {
    const matches = table.columns.flatMap((column, index) => header(column.name) === name ? [index] : []);
    return matches.length === 1 ? matches[0] : -1;
  });
  const missing = deliveryHeaders.filter((_, index) => indexes[index] === -1);
  if (missing.length) throw new AnalysisClarification(`「项目交付」缺少字段或列名重复：${missing.join("、")}。`);

  const ids = new Set<string>();
  const errors: string[] = [];
  const rows: Table["rows"] = [];
  let cancelled = 0;
  let dueCount = 0;
  let outstanding = 0;
  const aging: DeliveryReview["aging"] = { pastWeek: 0, highPriority: 0, sevenDays: 0 };
  for (const row of table.rows) {
    const [id, project, task, team, owner, committed, delivered, cancelledOn, priority] = indexes.map((index) => row.values[index] ?? null);
    const fail = (message: string) => { if (errors.length < 6) errors.push(`第 ${row.row} 行：${message}`); };
    const dueDate = dateValue(committed);
    if (dueDate === null) { fail("承诺交付日期须填写完整日期。"); continue; }
    const key = String(id ?? "").trim();
    if (!key || ids.has(key)) { fail("任务编号为空或重复。"); continue; }
    ids.add(key);
    if (dueDate >= cutoff) continue;
    const finishDate = dateValue(delivered);
    const cancelDate = dateValue(cancelledOn);
    if ((hasValue(delivered) && finishDate === null) || (hasValue(cancelledOn) && cancelDate === null)) {
      fail("实际交付日期、取消日期须填写完整日期或留空。"); continue;
    }
    if (finishDate !== null && cancelDate !== null) { fail("同一任务请只填写实际交付日期或取消日期。"); continue; }
    if (![project, task, team, owner].every(hasValue) || !deliveryPriorities.some((item) => item === String(priority).trim())) {
      fail("项目、任务名称、负责团队、责任人为必填，优先级填高、中或低。"); continue;
    }
    const inWeek = dueDate >= start;
    const wasCancelled = cancelDate !== null && cancelDate < cutoff;
    const finished = finishDate !== null && finishDate < cutoff;
    const isOutstanding = !wasCancelled && !finished;
    if (!inWeek && !isOutstanding) continue;
    if (inWeek && wasCancelled) cancelled++;
    if (inWeek && !wasCancelled) dueCount++;
    const onTime = finished && finishDate <= dueDate;
    const delay = isOutstanding ? (cutoff - day - dueDate) / day : null;
    if (isOutstanding) {
      outstanding++;
      if (!inWeek) aging.pastWeek++;
      if (String(priority).trim() === "高") aging.highPriority++;
      if (delay !== null && delay >= 7) aging.sevenDays++;
    }
    rows.push({ row: row.row, values: [...row.values, inWeek ? dueMarker : "往期遗留",
      wasCancelled ? null : onTime ? "按期" : "未按期",
      wasCancelled ? "已取消" : isOutstanding ? overdueMarker : onTime ? "按期交付" : "逾期已交", delay] });
  }
  if (errors.length) throw new AnalysisClarification(`请修正「项目交付」：${errors.join("；")}`);
  if (!rows.length) throw new AnalysisClarification("所选周没有应交任务或往期逾期积压，请核对承诺日期。");
  const { snapshot, reports, run, derived: [period, verdict, status] } = createReviewSnapshot(book, table,
    deliveryReviewKey(book.summary.id, weekStart), "delivery-snapshot", columnNames, rows);
  const team = table.columns[indexes[3]].id;
  const due = await run("本周各团队按期交付率", {
    ...emptyPlan, method: "share", group: team, filters: [{ column: period, operator: "eq", value: dueMarker }],
    match: { column: verdict, operator: "eq", value: "按期" },
  }, dueCount > 0);
  const backlog = await run("期末各团队逾期未交任务", {
    ...emptyPlan, group: team, filters: [{ column: status, operator: "eq", value: overdueMarker }],
  }, outstanding > 0);
  const review: DeliveryReview = { workbookId: book.summary.id, weekStart, weekEnd, due, backlog, cancelled, aging };
  return { snapshot, reports, review };
}
