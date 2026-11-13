export const caseIds = ["promotion", "acquisition", "returns"] as const;
export type SampleCaseId = (typeof caseIds)[number];
export type CaseId = SampleCaseId | `import-${string}`;
export const roles = ["growth", "margin", "quality"] as const;
export type Role = (typeof roles)[number];
export const drivers = ["sales", "refunds", "cogs", "ads", "fees"] as const;
export type Driver = (typeof drivers)[number];
export type Period = "current" | "previous";
export type LedgerAmounts = Record<Driver, number>;

export const transactionNames: Record<Driver, string> = {
  sales: "订单收款", refunds: "售后退款", cogs: "出库成本", ads: "广告扣费", fees: "平台结算扣费",
};

export function contribution({ sales, refunds, cogs, ads, fees }: LedgerAmounts) {
  return roundMoney(sales - refunds - cogs - ads - fees);
}

export const roundMoney = (value: number) => Math.round(value * 100) / 100;

export interface Transaction {
  id: string;
  occurredAt: string;
  period: Period;
  channel: string;
  metric: Driver;
  document: string;
  orderId: string | null;
  product: Product | null;
  description: string;
  amount: number;
}

export interface Product { sku: string; name: string }
export type ProductAmounts = Pick<LedgerAmounts, "sales" | "refunds" | "cogs">;
export interface ProductPerformance extends Product {
  amounts: Record<Period, ProductAmounts>;
}

export function productProfit({ sales, refunds, cogs }: ProductAmounts) {
  return roundMoney(sales - refunds - cogs);
}

export const maxWorkbookBytes = 5 * 1024 * 1024;
export const maxWorkbookRows = 20_000;
export const maxComparisonDays = 31;
export const workbookColumns = {
  订单: ["订单行号", "订单号", "日期", "渠道", "SKU", "商品名称", "成交金额"],
  退款: ["退款流水号", "订单行号", "日期", "退款金额"],
  成本: ["成本流水号", "订单行号", "日期", "成本金额"],
  渠道费用: ["费用流水号", "日期", "渠道", "费用类型", "费用金额"],
} as const;
export type WorkbookSheet = keyof typeof workbookColumns;
export interface ImportIssue { sheet?: WorkbookSheet; row?: number; message: string }
export interface ImportOptions { name: string; currentStart: string; previousStart: string; days: number }
export interface ImportResult {
  caseId: CaseId;
  rows: Record<Period, number>;
  outside: number;
  hasFees: boolean;
}

export interface BusinessLedger {
  transactions: Transaction[];
  channels: { name: string; amounts: Record<Period, LedgerAmounts> }[];
}
export type Step = Role | "prepare" | "synthesis" | "review" | "approval";
export type Mode = "replay" | "live";
export type Status = "running" | "review_required" | "approved" | "rejected" | "failed";

export const roleNames: Record<Role, string> = {
  growth: "增长 Agent",
  margin: "利润 Agent",
  quality: "售后 Agent",
};

export interface Evidence {
  id: string;
  label: string;
  channel: string;
  metric: Driver;
  previous: number;
  current: number;
  impact: number;
}

export interface CaseView {
  id: CaseId;
  name: string;
  headline: string;
  description: string;
  range: string;
  previousRange: string;
  source: "sample" | "excel";
  hasFees?: boolean;
  metrics: { sales: number; contribution: number; margin: number; refundRate: number };
  baseline: CaseView["metrics"];
  amounts: Record<Period, LedgerAmounts>;
  daily: { day: string; previousDay: string; current: number; previous: number }[];
  bridge: { metric: Driver; label: string; impact: number }[];
}

export interface Finding { summary: string; evidenceIds: string[] }
export interface Proposal extends Finding { headline: string; driver: Driver }
export interface Review { approved: boolean; note: string }
export type Decision = "approved" | "rejected";

export interface Recommendation extends Proposal {
  action: string;
  owner: string;
  measure: string;
  reviewNote: string;
  attempts: number;
  findings: (Finding & { role: Role })[];
}

export interface RunEvent {
  sequence: number;
  step: Step;
  phase: "started" | "tool" | "completed" | "retry" | "waiting" | "failed" | "decision";
  message: string;
  at: string;
}

export interface RunSummary {
  id: string;
  caseId: CaseId;
  status: Status;
  mode: Mode;
  createdAt: string;
}

export interface Run extends RunSummary {
  report: Recommendation | null;
  evidence: Evidence[];
  events: RunEvent[];
  error: string | null;
  decision: { value: Decision; at: string } | null;
}

export const taskStages = ["pending", "in_progress", "completed"] as const;
export type TaskStage = (typeof taskStages)[number];

export interface ActionTask {
  runId: string;
  caseId: CaseId;
  title: string;
  action: string;
  owner: string;
  measure: string;
  stage: TaskStage;
  createdAt: string;
  updates: { stage: TaskStage; note: string; at: string }[];
}
