import { createHash } from "node:crypto";
import type { AnalysisCell, AnalysisPlan, AnalysisReport, WorkbookSummary } from "../shared/analysis.ts";
import { hasValue } from "./analysis-data.ts";
import type { AnalysisWorkbook, Table } from "./analysis-data.ts";
import { analyzeWorkbook } from "./analysis-workflow.ts";
import type { SourceIndex } from "./analysis-workflow.ts";

export const reviewKey = (version: string, workbookId: string, weekStart: string) =>
  createHash("sha256").update(`${version}:${workbookId}:${weekStart}`).digest("hex");

export function createReviewSnapshot(book: AnalysisWorkbook, table: Table, id: string, kind: NonNullable<WorkbookSummary["kind"]>,
  names: string[], rows: Table["rows"]) {
  const describe = (index: number) => {
    const values: AnalysisCell[] = rows.map((row) => row.values[index] ?? null).filter(hasValue);
    return { filled: values.length, distinct: new Set(values).size };
  };
  const columns = [
    ...table.columns.map((column, index) => ({ ...column, ...describe(index) })),
    ...names.map((name, index) => ({
      id: `derived-${index + 1}`, name, kind: "category" as const, ...describe(table.columns.length + index),
    })),
  ];
  const summary = { name: table.name, columns, rowCount: rows.length };
  const snapshot: AnalysisWorkbook = {
    summary: { ...book.summary, id, kind, sheets: [summary], skipped: [] }, tables: [{ ...summary, rows }],
  };
  const reports: { report: AnalysisReport; sources: SourceIndex }[] = [];
  return {
    snapshot, reports, derived: columns.slice(table.columns.length).map((column) => column.id),
    async run(question: string, manual: AnalysisPlan, available: boolean) {
      if (!available) return null;
      const result = await analyzeWorkbook(snapshot, question, table.name, undefined, { manual });
      reports.push(result);
      return result.report;
    },
  };
}
