export type AnalysisCell = string | number | boolean | null;
export type ColumnKind = "number" | "date" | "category" | "text" | "identifier" | "mixed";
export interface AnalysisColumn {
  id: string;
  name: string;
  kind: ColumnKind;
  filled: number;
  distinct: number;
}
export interface AnalysisSheet {
  name: string;
  columns: AnalysisColumn[];
  rowCount: number;
}
export interface WorkbookSummary {
  id: string;
  name: string;
  headerRow: number;
  sheets: AnalysisSheet[];
  skipped: string[];
  kind?: "sla-snapshot";
}
export type AnalysisMethod = "count" | "sum" | "average" | "min" | "max" | "distinct" | "share" | "ratio";
export type TimeBucket = "day" | "month" | "year";
export type FilterOperator = "eq" | "neq" | "contains" | "gt" | "lt" | "gte" | "lte";
export interface AnalysisFilter { column: string; operator: FilterOperator; value: string }
export interface AnalysisPlan {
  method: AnalysisMethod;
  metric: string | null;
  denominator: string | null;
  group: string | null;
  timeBucket: TimeBucket | null;
  filters: AnalysisFilter[];
  match: AnalysisFilter | null;
  shareBase?: "nonblank" | "all";
  order: "high" | "low" | "time";
}
export interface BusinessMetric { name: string; sheet: string; plan: AnalysisPlan }
export interface BusinessProfile { context: string; metrics: BusinessMetric[] }
export const methodNames: Record<AnalysisMethod, string> = {
  count: "记录数", sum: "合计", average: "平均值", min: "最小值", max: "最大值",
  distinct: "去重计数", share: "条件占比", ratio: "两列合计之比",
};
export const columnNames: Record<ColumnKind, string> = {
  number: "数值", date: "日期", category: "类别", text: "文本", identifier: "标识符", mixed: "混合",
};
export interface AnalysisGroup {
  id: number;
  label: string;
  value: number | null;
  used: number;
  excluded: number;
  numerator: number | null;
  denominator: number | null;
}
export interface AnalysisReport {
  id: string;
  workbookId: string;
  question: string;
  createdAt: string;
  mode: "local" | "live" | "manual";
  sheet: string;
  plan: AnalysisPlan;
  summary: string;
  notes: string[];
  groups: AnalysisGroup[];
  totalGroups: number;
  matchedRows: number;
}
export interface AnalysisSource {
  sheet: string;
  columns: AnalysisColumn[];
  total: number;
  rows: { row: number; values: AnalysisCell[]; use: "included" | "numerator" | "denominator" | "excluded" }[];
}
export type AnalysisOutcome =
  | { report: AnalysisReport }
  | { clarification: string };
