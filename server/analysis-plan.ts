import { z } from "zod";
import type { AnalysisColumn, AnalysisFilter, AnalysisMethod, AnalysisPlan } from "../shared/analysis.ts";
import { hasValue } from "./analysis-data.ts";
import type { Table } from "./analysis-data.ts";

const filterSchema = z.object({
  column: z.string(), operator: z.enum(["eq", "contains", "gt", "lt", "gte", "lte"]), value: z.string(),
});
export const planSchema = z.object({
  method: z.enum(["count", "sum", "average", "min", "max", "distinct", "share", "ratio"]),
  metric: z.string().nullable(), denominator: z.string().nullable(), group: z.string().nullable(),
  timeBucket: z.enum(["day", "month", "year"]).nullable(), filters: z.array(filterSchema),
  match: filterSchema.nullable(), order: z.enum(["high", "low", "time"]),
});
export const choiceSchema = z.object({ sheet: z.string().nullable(), plan: planSchema.nullable(), clarification: z.string().nullable() });
export type PlanChoice = z.infer<typeof choiceSchema>;

const normalized = (text: string) => text.toLowerCase().replace(/[\s_\-（）()：:]/g, "");
const aliases = [
  ["部门", "团队", "department", "team"],
  ["渠道", "来源", "channel", "source"],
  ["地区", "区域", "城市", "region", "city"],
  ["分类", "类别", "类型", "category", "type"],
  ["时长", "耗时", "用时", "周期", "duration", "time spent", "handling time"],
  ["金额", "费用", "支出", "成本", "amount", "cost", "expense", "spend"],
  ["营收", "收入", "revenue"],
  ["评分", "得分", "score", "rating"],
  ["日期", "月份", "时间", "date", "month"],
  ["状态", "进度", "status", "stage"],
];

function matching(question: string, column: AnalysisColumn) {
  const full = normalized(question);
  const name = normalized(column.name);
  if (name.length > 1 && full.includes(name)) return 100 + name.length;
  const stem = name.replace(/(?:分钟|小时|天数?|万元?|千元|人民币|百分比|%|minutes?|hours?|days?)$/i, "");
  if (stem.length > 1 && full.includes(stem)) return 80 + stem.length;
  if (aliases.some((family) => family.some((word) => name.includes(normalized(word))) &&
      family.some((word) => full.includes(normalized(word))))) return 20;
  return 0;
}

function best(columns: AnalysisColumn[], question: string) {
  const ranked = columns.map((column) => ({ column, score: matching(question, column) })).filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.score > (ranked[1]?.score ?? 0) ? ranked[0].column : undefined;
}

function condition(table: Table, question: string): AnalysisFilter | null {
  const quote = /(?:包含|含有|contains)\s*[「“"']([^」”"']+)[」”"']/i.exec(question)?.[1];
  if (quote) {
    const column = best(table.columns.filter(({ kind }) => kind === "text" || kind === "category"), question);
    return column ? { column: column.id, operator: "contains", value: quote } : null;
  }
  const threshold = /(大于等于|不低于|至少|小于等于|不高于|至多|超过|大于|高于|低于|小于|>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)/.exec(question);
  if (threshold) {
    const column = best(table.columns.filter(({ kind }) => kind === "number"), question);
    const operators: Record<string, AnalysisFilter["operator"]> = {
      大于等于: "gte", 不低于: "gte", 至少: "gte", 小于等于: "lte", 不高于: "lte", 至多: "lte",
      超过: "gt", 大于: "gt", 高于: "gt", 低于: "lt", 小于: "lt", ">=": "gte", "<=": "lte", ">": "gt", "<": "lt",
    };
    return column ? { column: column.id, operator: operators[threshold[1]], value: threshold[2] } : null;
  }
  const quoted = /(?:等于|为|是|=)\s*[「“"']([^」”"']+)[」”"']/.exec(question);
  const explicit = quoted?.[1];
  if (quoted) {
    const before = normalized(question.slice(0, quoted.index));
    const target = table.columns.filter(({ name }) => before.endsWith(normalized(name)));
    if (target.length === 1) return { column: target[0].id, operator: "eq", value: quoted[1] };
  }
  const matches: AnalysisFilter[] = [];
  for (const [index, column] of table.columns.entries()) {
    if (column.kind !== "category") continue;
    const values = new Set(table.rows.map((row) => row.values[index]).filter(hasValue).map((value) => String(value).trim()));
    for (const value of values) {
      const named = /^(延期|已延期|逾期|超期|超时|已超时|通过|不通过|投诉|已关闭|已完成|进行中|失败|成功|离职|留存|续约|转化)$/.test(value);
      if (explicit === value || (!explicit && named && question.includes(value) &&
          !question.includes(`未${value}`) && !question.includes(`不${value}`))) {
        matches.push({ column: column.id, operator: "eq", value });
      }
    }
  }
  if (matches.length === 1) return matches[0];
  if (quoted && !matches.length) {
    const field = best(table.columns, question.slice(0, quoted.index).split(/统计|计算|比较|筛选|仅看|只看/).at(-1)!);
    if (field) return { column: field.id, operator: "eq", value: quoted[1] };
  }
  return null;
}

const unsupported = /为什么|原因|导致|因果|预测|预估|回归|相关性|中位数|标准差|分位|同比|环比|跨表|联表|关联.*工作表|对比.{0,8}和.{0,8}两列|\bwhy\b|\bforecast\b|\bmedian\b/i;

function planTable(table: Table, question: string): AnalysisPlan | string {
  const numeric = table.columns.filter(({ kind }) => kind === "number");
  const dimensions = table.columns.filter(({ kind }) => kind === "category");
  const dates = table.columns.filter(({ kind }) => kind === "date");
  const trend = /趋势|走势|变化|按日|按月|按年|每天|每月|每年|逐日|逐月|逐年|over time|trend|monthly|daily|yearly/i.test(question);
  const grouped = /分组|各|每个|哪个|哪些|按[^日月年]|by\s|which\s/i.test(question);
  const groupCue = /(?:按|各个?|每个|哪个|哪些|\bby\s+|\bwhich\s+)([^，。？！,?!]+)/i.exec(question)?.[1];
  const groupHint = groupCue?.split(/比较|对比|统计|计算|的|\b(?:compare|calculate)\b/i)[0];
  const share = /占比|比例|百分比|[率]|\brate\b|\bshare\b|\bpercent/i.test(question);
  const average = /平均|均值|\bavg\b|\baverage\b|\bmean\b/i.test(question);
  const distinct = /去重|独立|不重复|distinct|unique/i.test(question);
  const count = /数量|次数|笔数|件数|人数|记录数|项目数|工单数|有多少|几条|条数|最多|最少|最常|频次|\bcount\b|\bhow many\b/i.test(question);
  const min = /最小|最低|最短|最少|\bmin(?:imum)?\b|lowest/i.test(question);
  const max = /最大|最高|最长|最多|\bmax(?:imum)?\b|highest/i.test(question);
  const sum = /合计|总计|总额|总量|总成本|总支出|总收入|累计|\btotal\b|\bsum\b/i.test(question);
  const groupColumn = groupHint ? best(dimensions, groupHint) : undefined;
  if (trend && groupColumn) return "当前一次只能按一个维度分组。请选择按时间看趋势，或按类别比较。";
  const group = trend ? best(dates, question) ?? (dates.length === 1 ? dates[0] : undefined)
    : grouped ? groupColumn ?? best(dimensions, question) : undefined;
  if ((trend || grouped) && !group) return `请明确要按哪个${trend ? "日期" : "类别"}字段分析，例如使用表里的完整列名。`;

  const matched = condition(table, question);
  const quoted = question.match(/[「“"']([^」”"']+)[」”"']/g) ?? [];
  if (quoted.length > 1 && /等于|包含|筛选|只看/.test(question)) return "请先使用一个明确的筛选条件；复杂条件可在启用实时模型后尝试。";
  if (!matched && /包含|含有|等于|超过\s*\d|(?:>=|<=|>|<)\s*\d|仅看|只看|只统计|筛选|其中/.test(question)) {
    return "请用准确的列名和一个条件，例如「统计状态等于“已完成”的记录数」。";
  }
  if (/\d{4}[-/]\d|\d{4}\s*年|最近\s*\d|过去\s*\d|上个月|本月|今年|去年/.test(question) && !matched) {
    return "请先明确时间筛选条件，例如「统计日期等于“2026-11-02”的记录数」。本地规划目前支持单个日期等值筛选。";
  }
  const metric = best(numeric, question);
  const ratio = /(.+?)(?:除以|\s\/\s)(.+)/.exec(question);
  const denominator = ratio ? best(numeric, ratio[2]) : undefined;
  const numerator = ratio ? best(numeric, ratio[1]) : undefined;
  let method: AnalysisMethod;
  if (ratio) {
    if (!numerator || !denominator || numerator === denominator) return "请明确要相除的两个数值列，例如「总费用除以总工时」。";
    method = "ratio";
  } else if (share && (!average || matched)) {
    if (!matched) return "请说明占比的分子条件和分母，例如「按部门统计状态等于“延期”的记录占比」。";
    method = "share";
  } else if (distinct) method = "distinct";
  else if (average) method = "average";
  else if (sum) method = "sum";
  else if ((min || max) && metric && !group) method = min ? "min" : "max";
  else if (group && metric) {
    if (/时长|耗时|用时|评分|得分|duration|score|rating/i.test(metric.name)) method = "average";
    else if (/金额|费用|支出|成本|收入|营收|amount|cost|revenue/i.test(metric.name)) method = "sum";
    else return "请明确要比较该列的合计、平均值或极值。";
  }
  else if ((min || max) && metric) method = min ? "min" : "max";
  else if (count || matched || (trend && !metric)) method = "count";
  else return "请补充想统计的字段和口径，例如「按部门比较平均处理时长」或「按月统计记录数」。";
  const target = method === "ratio" ? numerator : method === "distinct"
    ? best(table.columns.filter(({ kind }) => kind !== "mixed"), question) : metric;
  if (!target && ["sum", "average", "min", "max", "distinct"].includes(method)) {
    return "找不到可用于该指标的唯一列，请在问题中写出完整列名，并确认该列的数据格式一致。";
  }
  const timeBucket = trend ? /按日|每天|逐日|daily/i.test(question) ? "day"
    : /按年|每年|逐年|yearly/i.test(question) ? "year" : "month" : null;
  return {
    method, metric: ["count", "share"].includes(method) ? null : target?.id ?? null, denominator: denominator?.id ?? null,
    group: group?.id ?? null, timeBucket, order: trend ? "time" : min ? "low" : "high",
    filters: matched && method !== "share" ? [matched] : [], match: method === "share" ? matched : null,
  };
}

export function localPlan(tables: Table[], question: string): PlanChoice {
  if (unsupported.test(question)) return {
    sheet: null, plan: null,
    clarification: "这类问题超出当前可核算的方法。可以改问某项指标在不同分组或时间段的差异；差异本身不能证明原因。",
  };
  if (tables.length === 1) {
    const plan = planTable(tables[0], question);
    return typeof plan === "string" ? { sheet: null, plan: null, clarification: plan }
      : { sheet: tables[0].name, plan, clarification: null };
  }
  const named = tables.filter(({ name }) => normalized(name).length > 1 && normalized(question).includes(normalized(name)));
  if (named.length === 1) return localPlan(named, question);
  const viable = tables.flatMap((table) => {
    const plan = planTable(table, question);
    if (typeof plan === "string") return [];
    const used = [plan.metric, plan.group, plan.denominator, plan.match?.column, ...plan.filters.map(({ column }) => column)];
    const score = table.columns.filter(({ id }) => used.includes(id)).reduce((sum, column) => sum + matching(question, column), 0);
    return [{ sheet: table.name, plan, score }];
  }).sort((a, b) => b.score - a.score);
  if (viable[0] && (!viable[1] || viable[0].score > viable[1].score)) {
    return { sheet: viable[0].sheet, plan: viable[0].plan, clarification: null };
  }
  return { sheet: null, plan: null, clarification: "请指定要分析的工作表，或在问题中写出工作表名和相关列名。" };
}
