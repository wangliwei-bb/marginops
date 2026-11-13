import { methodNames } from "../shared/analysis.ts";
import type { AnalysisCell, AnalysisFilter, AnalysisGroup, AnalysisPlan, AnalysisSource } from "../shared/analysis.ts";
import { dayValue, hasValue, numberValue } from "./analysis-data.ts";
import type { Table } from "./analysis-data.ts";

export class AnalysisClarification extends Error {}
type Row = Table["rows"][number];
type SourceRow = AnalysisSource["rows"][number];
type Group = AnalysisGroup & { rows: SourceRow[] };

const words: Record<AnalysisFilter["operator"], string> = {
  eq: "等于", contains: "包含", gt: "大于", lt: "小于", gte: "大于等于", lte: "小于等于",
};
const formatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 });
export const formatAnalysisValue = (value: number, method: AnalysisPlan["method"]) =>
  method === "share" ? `${formatter.format(value * 100)}%` : formatter.format(value);

function stableSum(values: number[]) {
  let sum = 0;
  let correction = 0;
  for (const value of values) {
    const next = sum + value;
    correction += Math.abs(sum) >= Math.abs(value) ? (sum - next) + value : (value - next) + sum;
    sum = next;
  }
  const result = sum + correction;
  if (!Number.isFinite(result)) throw new AnalysisClarification("计算结果超出支持的数值范围。请缩小数据范围或统一单位。");
  return result;
}

export function calculate(table: Table, plan: AnalysisPlan) {
  function index(id: string | null) {
    if (id === null) return -1;
    const position = table.columns.findIndex((column) => column.id === id);
    if (position === -1) throw new AnalysisClarification("分析方案引用了不存在的字段，请在问题中写出完整列名。");
    return position;
  }
  const metric = index(plan.metric);
  const denominator = index(plan.denominator);
  const group = index(plan.group);
  const numericMethod = ["sum", "average", "min", "max", "ratio"].includes(plan.method);
  if (numericMethod && (metric === -1 || table.columns[metric].kind !== "number")) {
    throw new AnalysisClarification("这个指标需要一个格式一致的数值列。请核对数值列或明确列名。");
  }
  if (plan.method === "distinct" && metric === -1) throw new AnalysisClarification("请指定要去重计数的列。");
  if (plan.method === "ratio" && (denominator < 0 || denominator === metric || table.columns[denominator].kind !== "number")) {
    throw new AnalysisClarification("比值需要两个不同的数值列。");
  }
  if (plan.timeBucket && (group < 0 || table.columns[group].kind !== "date")) {
    throw new AnalysisClarification("趋势需要可识别的日期列。");
  }
  if (plan.filters.length > 4) throw new AnalysisClarification("一次最多使用四个筛选条件，请缩小问题范围。");

  function predicate(filter: AnalysisFilter) {
    const position = index(filter.column);
    const text = filter.value.trim().toLowerCase();
    if (!text || text.length > 160) throw new AnalysisClarification("筛选条件为空或过长。");
    const numeric = !["eq", "contains"].includes(filter.operator);
    const target = numberValue(text);
    if (numeric && (target === null || table.columns[position].kind !== "number")) {
      throw new AnalysisClarification("大小比较需要数值列和一个有效的数字。");
    }
    const groupField = table.columns[position].kind === "date";
    const dateTarget = groupField ? dayValue(text) : null;
    return (row: Row): boolean | null => {
      const cell = row.values[position];
      if (!hasValue(cell)) return null;
      if (numeric && target !== null) {
        const actual = numberValue(cell);
        if (actual === null) return null;
        switch (filter.operator) {
          case "gt": return actual > target;
          case "gte": return actual >= target;
          case "lt": return actual < target;
          case "lte": return actual <= target;
        }
      }
      const actual = String(cell).trim().toLowerCase();
      if (filter.operator === "contains") return actual.includes(text);
      if (dateTarget) return dayValue(cell) === dateTarget;
      if (table.columns[position].kind === "number" && target !== null) return numberValue(cell) === target;
      return actual === text;
    };
  }

  const filters = plan.filters.map(predicate);
  const match = plan.method === "share" && plan.match ? predicate(plan.match) : null;
  if (plan.method === "share" && !match) throw new AnalysisClarification("请指定占比的分子条件。");
  const bucketed = new Map<string | null, Row[]>();
  let filteredOut = 0;
  let invalidDate = 0;
  for (const row of table.rows) {
    if (filters.some((test) => test(row) !== true)) { filteredOut += 1; continue; }
    let key = group < 0 ? "全部记录" : hasValue(row.values[group]) ? String(row.values[group]).trim() : null;
    if (plan.timeBucket) {
      const date = dayValue(row.values[group]);
      const width = plan.timeBucket === "year" ? 4 : plan.timeBucket === "month" ? 7 : 10;
      if (!date || date.length < width) { invalidDate += 1; continue; }
      key = date.slice(0, width);
    }
    if (!bucketed.has(key)) bucketed.set(key, []);
    bucketed.get(key)!.push(row);
  }
  if (!bucketed.size) throw new AnalysisClarification("筛选后没有可分析的记录，请核对条件和值。");
  if (bucketed.size > 200) throw new AnalysisClarification("分组超过 200 个。请改用较粗的分类，或按月、按年统计。");

  const groups: Group[] = [...bucketed].map(([key, records], index) => {
    let numerator: number | null = null;
    let divisor: number | null = null;
    const values: number[] = [];
    const other: number[] = [];
    const unique = new Set<string>();
    const rows: SourceRow[] = records.map((row) => {
      const source = { row: row.row, values: row.values };
      const cell = row.values[metric];
      if (match) {
        const result = match(row);
        return { ...source, use: result === null ? "excluded" : result ? "numerator" : "denominator" };
      }
      if (numericMethod) {
        const number = numberValue(cell);
        const comparison = plan.method === "ratio" ? numberValue(row.values[denominator]) : null;
        if (number === null || (plan.method === "ratio" && comparison === null)) return { ...source, use: "excluded" };
        values.push(number);
        if (comparison !== null) other.push(comparison);
      } else if (plan.method === "distinct") {
        if (!hasValue(cell)) return { ...source, use: "excluded" };
        unique.add(String(cell).trim());
      }
      return { ...source, use: "included" };
    });
    const used = rows.filter(({ use }) => use !== "excluded").length;
    let value: number | null = null;
    if (used) {
      switch (plan.method) {
        case "count": value = used; break;
        case "distinct": value = unique.size; break;
        case "sum": value = stableSum(values); break;
        case "average": value = stableSum(values) / used; break;
        case "min": value = Math.min(...values); break;
        case "max": value = Math.max(...values); break;
        case "share":
          numerator = rows.filter(({ use }) => use === "numerator").length;
          divisor = used;
          value = numerator / divisor;
          break;
        case "ratio":
          numerator = stableSum(values);
          divisor = stableSum(other);
          value = divisor === 0 ? null : numerator / divisor;
          break;
      }
    }
    if (value !== null && !Number.isFinite(value)) throw new AnalysisClarification("计算结果超出支持的数值范围。");
    return { id: index + 1, label: key ?? "（分组字段为空）", value, used, excluded: rows.length - used,
      numerator, denominator: divisor, rows };
  });
  const valid = groups.filter(({ value }) => value !== null);
  if (!valid.length) throw new AnalysisClarification("没有可计算的结果。请检查指标是否为空，或分母是否为零。");
  groups.sort((a, b) => {
    if (plan.order === "time" || a.value === b.value) return a.label.localeCompare(b.label, "zh-CN");
    if (a.value === null) return 1;
    if (b.value === null) return -1;
    return plan.order === "low" ? a.value - b.value : b.value - a.value;
  });
  const field = (id: string) => table.columns[index(id)].name;
  const method = methodNames[plan.method];
  const metricLabel = plan.method === "ratio" ? `「${field(plan.metric!)}」与「${field(plan.denominator!)}」的合计之比`
    : plan.metric ? `${field(plan.metric)}的${method}` : method;
  const display = (value: number) => formatAnalysisValue(value, plan.method);
  const available = groups.filter((item): item is Group & { value: number } => item.value !== null);
  const first = available[0];
  const last = available.at(-1)!;
  const summary = plan.order === "time" && available.length > 1
    ? `${metricLabel}从 ${first.label} 的 ${display(first.value)} 变为 ${last.label} 的 ${display(last.value)}，差值 ${plan.method === "share"
      ? `${formatter.format((last.value - first.value) * 100)} 个百分点` : display(last.value - first.value)}。`
    : `${first.label}的${metricLabel}为 ${display(first.value)}（${first.used} 条有效记录）${available.length > 1
      ? `，在可计算的 ${available.length} 组中${plan.order === "low" ? "最低" : "最高"}${available[1].value === first.value ? "（有并列）" : ""}` : ""}。`;
  const describe = (filter: AnalysisFilter) => `${field(filter.column)} ${words[filter.operator]}「${filter.value}」`;
  const notes = [`口径：${metricLabel}${plan.group ? `，按${field(plan.group)}分组` : ""}。`];
  if (plan.filters.length) notes.push(`筛选：${plan.filters.map(describe).join("，")}；排除 ${filteredOut} 条。`);
  if (plan.method === "share" && plan.match) notes.push(`分子：${describe(plan.match)}的记录数；分母：该字段有值的记录数。`);
  if (plan.method === "ratio") notes.push(`分子为「${field(plan.metric!)}」合计，分母为「${field(plan.denominator!)}」合计；只计两列均有数值的行。`);
  if (invalidDate) notes.push(`${invalidDate} 条记录缺少相应日期精度，未进入趋势。`);
  const excluded = groups.reduce((total, item) => total + item.excluded, 0);
  if (excluded) notes.push(`${excluded} 条记录的指标或条件字段为空，已从计算分母中排除。`);
  if (valid.length < groups.length) notes.push("部分组没有有效值或分母为 0，结果留空。");
  if (plan.order === "time") notes.push("趋势仅列出有记录的期间，缺少记录的期间不会补为 0。");
  return { groups, summary, notes, matchedRows: table.rows.length - filteredOut - invalidDate };
}
