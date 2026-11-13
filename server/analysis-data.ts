import { createHash } from "node:crypto";
import { z } from "zod";
import type { AnalysisCell, AnalysisColumn, AnalysisSheet, ColumnKind, WorkbookSummary } from "../shared/analysis.ts";
import { maxWorkbookRows } from "../shared/contracts.ts";
import { readUploadedWorkbook, WorkbookError } from "./import.ts";

export interface Table extends AnalysisSheet {
  rows: { row: number; values: AnalysisCell[] }[];
}
export interface AnalysisWorkbook {
  summary: WorkbookSummary;
  tables: Table[];
}

const numericText = /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/;
export function numberValue(cell: AnalysisCell): number | null {
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : null;
  if (typeof cell !== "string" || !numericText.test(cell.trim())) return null;
  const value = Number(cell.trim().replaceAll(",", ""));
  return Number.isFinite(value) ? value : null;
}

export function dayValue(cell: AnalysisCell): string | null {
  if (typeof cell !== "string") return null;
  const match = /^(\d{4})[-/年](\d{1,2})(?:[-/月](\d{1,2})日?)?(?:月)?(?:[ T].*)?$/.exec(cell.trim());
  if (!match) return null;
  const month = `${match[1]}-${match[2].padStart(2, "0")}`;
  const day = `${month}-${(match[3] ?? "1").padStart(2, "0")}`;
  return z.iso.date().safeParse(day).success ? match[3] ? day : month : null;
}

export const hasValue = (cell: AnalysisCell) => cell !== null && (typeof cell !== "string" || !!cell.trim());
const normalizeCell = (cell: unknown): AnalysisCell => cell instanceof Date ? cell.toISOString().slice(0, 19)
  : typeof cell === "number" ? Number.isFinite(cell) ? cell : null
  : typeof cell === "string" || typeof cell === "boolean" ? cell : null;

function excelColumn(index: number) {
  return index < 26 ? String.fromCharCode(65 + index)
    : String.fromCharCode(64 + Math.floor(index / 26), 65 + index % 26);
}

function classify(name: string, values: AnalysisCell[], distinct: number): ColumnKind {
  if (/^(id|sku|.+id)$|编号|单号|编码|工号|手机号|身份证|序号|代码|邮编/i.test(name)) return "identifier";
  if (!values.length) return "mixed";
  if (values.every((value) => dayValue(value) !== null)) return "date";
  const numeric = values.filter((value) => numberValue(value) !== null).length;
  if (numeric === values.length) return "number";
  if (numeric > 0) return "mixed";
  if (distinct <= 100 && values.every((value) => String(value).length <= 60)) return "category";
  return "text";
}

export async function profileWorkbook(bytes: Buffer, name: string, headerRow: number): Promise<AnalysisWorkbook> {
  const parsed = await readUploadedWorkbook(bytes, { trim: false });
  const tables: Table[] = [];
  const skipped: string[] = [];
  let totalRows = 0;
  for (const { sheet, data } of parsed) {
    const header = data[headerRow - 1] ?? [];
    const rows = data.slice(headerRow).flatMap((values, index) => {
      const cells = values.map(normalizeCell);
      return cells.some(hasValue) ? [{ row: headerRow + index + 1, values: cells }] : [];
    });
    if (!rows.length) { skipped.push(sheet); continue; }
    if (header.filter((cell) => typeof cell === "string" && cell.trim()).length === 0) {
      skipped.push(sheet);
      continue;
    }
    totalRows += rows.length;
    if (totalRows > maxWorkbookRows) throw new WorkbookError([{ message: "工作簿中的有效记录合计最多支持 20,000 行。" }], 413);
    const width = rows.reduce((max, row) => Math.max(max, row.values.length), header.length);
    const columns: AnalysisColumn[] = [];
    const positions: number[] = [];
    for (let index = 0; index < width; index++) {
      const id = excelColumn(index);
      const label = String(header[index] ?? "").trim() || `${id} 列（无表头）`;
      const values = rows.map((row) => row.values[index] ?? null).filter(hasValue);
      if (!values.length && !hasValue(normalizeCell(header[index]))) continue;
      const distinct = new Set(values.map((value) => String(value).trim())).size;
      columns.push({ id, name: label, kind: classify(label, values, distinct), distinct, filled: values.length });
      positions.push(index);
    }
    tables.push({ name: sheet, columns, rowCount: rows.length, rows: rows.map(({ row, values }) => ({
      row, values: positions.map((index) => values[index] ?? null),
    })) });
  }
  if (!tables.length) throw new WorkbookError([{ message: "没有找到带列名的数据表。请确认表头所在行，且表头下面有记录。" }]);
  const id = createHash("sha256").update(bytes).update(JSON.stringify([name, headerRow])).digest("hex");
  return { tables, summary: { id, name, headerRow, skipped, sheets: tables.map(({ name, columns, rowCount }) => ({ name, columns, rowCount })) } };
}
