import type { AnalysisReport } from "./analysis.ts";

export const slaHeaders = ["工单编号", "受理时间", "首次响应时间", "取消时间", "渠道", "负责团队", "优先级", "SLA分钟", "问题类型"] as const;
export const slaSampleWeek = "2026-11-02";

export interface SlaReview {
  workbookId: string;
  weekStart: string;
  currentCutoff: string;
  previousStart: string;
  current: AnalysisReport | null;
  previous: AnalysisReport | null;
  backlog: AnalysisReport | null;
  counts: {
    current: { received: number; cancelled: number; pending: number };
    previous: { received: number; cancelled: number; pending: number };
  };
}
