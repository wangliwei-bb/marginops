import { methodNames } from "../shared/analysis.ts";
import type { AnalysisColumn, AnalysisFilter, AnalysisMethod, AnalysisPlan, AnalysisSheet } from "../shared/analysis.ts";

export const emptyPlan: AnalysisPlan = {
  method: "count", metric: null, denominator: null, group: null, timeBucket: null,
  filters: [], match: null, order: "high",
};
const emptyFilter: AnalysisFilter = { column: "", operator: "eq", value: "" };
const operators = { eq: "等于", neq: "不等于", contains: "包含", gt: "大于", gte: "大于等于", lt: "小于", lte: "小于等于" } as const;

function ColumnOptions({ columns, placeholder = "请选择字段" }: { columns: AnalysisColumn[]; placeholder?: string }) {
  return <><option value="">{placeholder}</option>{columns.map(({ id, name }) => <option key={id} value={id}>{id} · {name}</option>)}</>;
}

function Condition({ columns, value, label, onChange, remove }: {
  columns: AnalysisColumn[]; value: AnalysisFilter; label: string; onChange: (next: AnalysisFilter) => void; remove?: () => void;
}) {
  const isNumeric = columns.some(({ id, kind }) => id === value.column && kind === "number");
  return <div className="analysis-condition">
    <select aria-label={`${label}字段`} value={value.column} onChange={(event) => onChange({ ...value, column: event.target.value, operator: "eq" })}>
      <ColumnOptions columns={columns} />
    </select>
    <select aria-label={`${label}比较方式`} value={value.operator}
      onChange={(event) => onChange({ ...value, operator: event.target.value as AnalysisFilter["operator"] })}>
      {Object.entries(operators).filter(([key]) => isNumeric || ["eq", "neq", "contains"].includes(key))
        .map(([key, name]) => <option key={key} value={key}>{name}</option>)}
    </select>
    <input aria-label={`${label}值`} placeholder="例如 已完成" maxLength={160} value={value.value}
      onChange={(event) => onChange({ ...value, value: event.target.value })} />
    {remove && <button type="button" className="text-button" aria-label={`移除${label}`} onClick={remove}>移除</button>}
  </div>;
}

export function planReady(plan: AnalysisPlan, table?: AnalysisSheet) {
  if (!table) return false;
  if (plan.method === "share" && !plan.match) return false;
  if (plan.method !== "count" && plan.method !== "share" && !plan.metric) return false;
  if (plan.method === "ratio" && (!plan.denominator || plan.metric === plan.denominator)) return false;
  return [...plan.filters, ...(plan.match ? [plan.match] : [])].every((filter) => filter.column && filter.value.trim());
}

export function PlanEditor({ table, plan, onChange }: {
  table: AnalysisSheet; plan: AnalysisPlan; onChange: (plan: AnalysisPlan) => void;
}) {
  const columns = table.columns;
  const numeric = columns.filter(({ kind }) => kind === "number");
  const needsMetric = !["count", "share"].includes(plan.method);
  const update = (values: Partial<AnalysisPlan>) => onChange({ ...plan, ...values });
  return <div className="analysis-plan">
    <div className="analysis-plan-fields">
      <label>统计方法
        <select value={plan.method} onChange={(event) => {
          const method = event.target.value as AnalysisMethod;
          update({ method, metric: null, denominator: null, match: method === "share" ? emptyFilter : null, shareBase: undefined });
        }}>{Object.entries(methodNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
      </label>
      {needsMetric && <label>{plan.method === "ratio" ? "分子字段" : "指标字段"}
        <select value={plan.metric ?? ""} onChange={(event) => update({ metric: event.target.value || null })}>
          <ColumnOptions columns={plan.method === "distinct" ? columns : numeric} />
        </select>
      </label>}
      {plan.method === "ratio" && <label>分母字段
        <select value={plan.denominator ?? ""} onChange={(event) => update({ denominator: event.target.value || null })}>
          <ColumnOptions columns={numeric.filter(({ id }) => id !== plan.metric)} />
        </select>
      </label>}
      <label>分组字段
        <select value={plan.group ?? ""} onChange={(event) => update({
          group: event.target.value || null, timeBucket: null, order: plan.order === "time" ? "high" : plan.order,
        })}><ColumnOptions columns={columns} placeholder="不分组" /></select>
      </label>
      {columns.some(({ id, kind }) => id === plan.group && kind === "date") && <label>日期粒度
        <select value={plan.timeBucket ?? ""} onChange={(event) => {
          const timeBucket = (event.target.value || null) as AnalysisPlan["timeBucket"];
          update({ timeBucket, order: timeBucket ? "time" : "high" });
        }}><option value="">原值</option><option value="day">按日</option><option value="month">按月</option><option value="year">按年</option></select>
      </label>}
      {plan.group && !plan.timeBucket && <label>结果排序
        <select value={plan.order} onChange={(event) => update({ order: event.target.value as AnalysisPlan["order"] })}>
          <option value="high">从高到低</option><option value="low">从低到高</option>
        </select>
      </label>}
    </div>
    {plan.method === "share" && <div className="analysis-plan-section">
      <strong>分子条件</strong>
      <Condition columns={columns} label="分子" value={plan.match ?? emptyFilter} onChange={(match) => update({ match })} />
      <label>占比分母
        <select value={plan.shareBase ?? "nonblank"} onChange={(event) => update({ shareBase: event.target.value as AnalysisPlan["shareBase"] })}>
          <option value="nonblank">筛选后，分子条件字段有值的记录</option>
          <option value="all">筛选后的全部记录（含空值）</option>
        </select>
      </label>
    </div>}
    <div className="analysis-plan-section">
      <strong>筛选范围</strong>
      {plan.filters.map((filter, index) => <Condition key={index} columns={columns} label={`筛选 ${index + 1}`} value={filter}
        onChange={(next) => update({ filters: plan.filters.map((item, i) => i === index ? next : item) })}
        remove={() => update({ filters: plan.filters.filter((_, i) => i !== index) })} />)}
      {plan.filters.length < 4 && <button type="button" className="text-button"
        onClick={() => update({ filters: [...plan.filters, emptyFilter] })}>＋ 添加筛选条件</button>}
    </div>
  </div>;
}
