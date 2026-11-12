export const caseIds = ["promotion", "acquisition", "returns"] as const;
export type CaseId = (typeof caseIds)[number];
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
  return sales - refunds - cogs - ads - fees;
}

export interface Transaction {
  id: string;
  occurredAt: string;
  period: Period;
  channel: string;
  metric: Driver;
  document: string;
  orderId: string | null;
  description: string;
  amount: number;
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
  metrics: { sales: number; contribution: number; margin: number; refundRate: number };
  baseline: CaseView["metrics"];
  amounts: Record<Period, LedgerAmounts>;
  daily: { day: string; current: number; previous: number }[];
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
