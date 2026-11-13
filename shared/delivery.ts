import type { AnalysisReport } from "./analysis.ts";

export const deliveryHeaders = ["任务编号", "项目", "任务名称", "负责团队", "责任人", "承诺交付日期", "实际交付日期", "取消日期", "优先级"] as const;
export const deliverySampleWeek = "2026-11-02";
export const deliveryPriorities = ["高", "中", "低"] as const;

export interface DeliveryReview {
  workbookId: string;
  weekStart: string;
  weekEnd: string;
  due: AnalysisReport | null;
  backlog: AnalysisReport | null;
  cancelled: number;
  aging: { pastWeek: number; highPriority: number; sevenDays: number };
}
