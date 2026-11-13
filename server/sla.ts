import { z } from "zod";
import type { AnalysisCell, AnalysisPlan } from "../shared/analysis.ts";
import { slaHeaders } from "../shared/sla.ts";
import type { SlaReview } from "../shared/sla.ts";
import { hasValue, numberValue } from "./analysis-data.ts";
import type { AnalysisWorkbook, Table } from "./analysis-data.ts";
import { AnalysisClarification } from "./analysis-engine.ts";
import { createReviewSnapshot, reviewKey } from "./review-snapshot.ts";

const day = 86_400_000;
const offset = "+08:00";
const header = (value: string) => value.replace(/[\s（）()]/g, "").toLowerCase();
const derivedNames = ["复盘周期", "SLA判定", "超时明细"];

function timestamp(value: AnalysisCell): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\+08:00)?$/.exec(value.trim());
  if (!match) return null;
  const date = [match[1], match[2].padStart(2, "0"), match[3].padStart(2, "0")].join("-");
  const time = `${match[4].padStart(2, "0")}:${match[5]}:${match[6] ?? "00"}`;
  if (!z.iso.date().safeParse(date).success || !z.iso.time({ precision: 0 }).safeParse(time).success) return null;
  return Date.parse(`${date}T${time}${offset}`);
}

function dayLabel(time: number) { return new Date(time + 8 * 3_600_000).toISOString().slice(0, 10); }

export async function reviewSla(book: AnalysisWorkbook, weekStart: string) {
  if (!z.iso.date().safeParse(weekStart).success) throw new AnalysisClarification("请选择有效的本期开始日期。");
  const table = book.tables.find(({ name }) => name === "客服工单");
  if (!table) throw new AnalysisClarification("找不到「客服工单」工作表。请使用 SLA 专用模板，表头选第 1 行。");
  const indexes = slaHeaders.map((name) => {
    const matches = table.columns.flatMap((column, index) => header(column.name) === header(name) ? [index] : []);
    return matches.length === 1 ? matches[0] : -1;
  });
  const missing = slaHeaders.filter((_, index) => indexes[index] < 0);
  if (missing.length) throw new AnalysisClarification(`「客服工单」缺少字段或列名重复：${missing.join("、")}。`);
  const start = Date.parse(`${weekStart}T00:00:00${offset}`);
  const currentCutoff = start + 7 * day;
  const previousStart = start - 7 * day;
  if (currentCutoff > Date.now()) throw new AnalysisClarification("本期还未结束，请选择已经结束的连续七天。");
  const counts: SlaReview["counts"] = {
    current: { received: 0, cancelled: 0, pending: 0 },
    previous: { received: 0, cancelled: 0, pending: 0 },
  };
  const ids = new Set<string>();
  const errors: string[] = [];
  const rows: Table["rows"] = [];
  const [periodIndex, verdictIndex, detailIndex] = derivedNames.map((_, index) => table.columns.length + index);

  for (const row of table.rows) {
    const values = indexes.map((index) => row.values[index] ?? null);
    const [id, opened, first, cancelled, channel, team, , target] = values;
    const fail = (message: string) => { if (errors.length < 6) errors.push(`第 ${row.row} 行：${message}`); };
    const received = timestamp(opened);
    if (received === null) { fail("受理时间须填写日期和时分。"); continue; }
    const key = String(id ?? "").trim();
    if (!key || ids.has(key)) { fail("工单编号为空或重复。"); continue; }
    ids.add(key);
    if (received < previousStart || received >= currentCutoff) continue;
    const period = received < start ? "previous" : "current";
    const cutoff = period === "previous" ? start : currentCutoff;
    const reply = timestamp(first);
    const cancel = timestamp(cancelled);
    const minutes = numberValue(target);
    if ((hasValue(first) && (reply === null || reply < received)) || (hasValue(cancelled) && (cancel === null || cancel < received))) {
      fail("响应或取消时间格式不正确，或早于受理时间。"); continue;
    }
    if (!hasValue(channel) || !hasValue(team) || minutes === null || !Number.isInteger(minutes) || minutes <= 0 || minutes > 43_200) {
      fail("渠道、负责团队和 SLA分钟为必填，SLA分钟填 1–43200 的整数。"); continue;
    }
    counts[period].received++;
    let result: AnalysisCell = null;
    let detail = "未到期未响应";
    const deadline = received + minutes * 60_000;
    if (cancel !== null && cancel < cutoff) {
      detail = "已取消";
      counts[period].cancelled++;
    } else if (reply !== null && reply < cutoff) {
      result = reply > deadline ? "超时" : "按时";
      detail = reply > deadline ? "已响应超时" : "已响应按时";
    } else if (deadline < cutoff) {
      result = "超时";
      detail = "未响应超时";
    } else {
      counts[period].pending++;
    }
    rows.push({ row: row.row, values: [...row.values, period === "current" ? "本期" : "上期", result, detail] });
  }
  if (errors.length) throw new AnalysisClarification(`请修正「客服工单」：${errors.join("；")}`);
  if (!counts.current.received) throw new AnalysisClarification("本期七天内没有工单，请核对受理时间或选择其他开始日期。");

  const { snapshot, reports, run, derived: [period, verdict, detail] } = createReviewSnapshot(book, table,
    slaReviewKey(book.summary.id, weekStart), "sla-snapshot", derivedNames, rows);
  const plan = (label: string): AnalysisPlan => ({
    method: "share", metric: null, denominator: null, group: table.columns[indexes[4]].id, timeBucket: null, order: "high",
    filters: [{ column: period, operator: "eq", value: label }],
    match: { column: verdict, operator: "eq", value: "超时" },
  });
  const current = await run("本期各渠道首次响应超时率", plan("本期"),
    rows.some(({ values }) => values[periodIndex] === "本期" && values[verdictIndex] !== null));
  const previous = await run("上期各渠道首次响应超时率", plan("上期"),
    rows.some(({ values }) => values[periodIndex] === "上期" && values[verdictIndex] !== null));
  const backlog = await run("本期结束时各团队未响应超时工单", {
    ...plan("本期"), method: "count", group: table.columns[indexes[5]].id, match: null,
    filters: [{ column: period, operator: "eq", value: "本期" }, { column: detail, operator: "eq", value: "未响应超时" }],
  }, rows.some(({ values }) => values[periodIndex] === "本期" && values[detailIndex] === "未响应超时"));
  const review: SlaReview = { workbookId: book.summary.id, weekStart, currentCutoff: dayLabel(currentCutoff),
    previousStart: dayLabel(previousStart), current, previous, backlog, counts };
  return { snapshot, reports, review };
}

export const slaReviewKey = (workbookId: string, weekStart: string) =>
  reviewKey("sla-v1", workbookId, weekStart);
