import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import readWorkbook from "read-excel-file/node";
import { fromBuffer } from "yauzl";
import type { ZipFile } from "yauzl";
import { z } from "zod";
import { maxComparisonDays, maxWorkbookBytes, maxWorkbookRows, workbookColumns } from "../shared/contracts.ts";
import type { CaseId, Driver, ImportIssue, ImportResult, Period, Transaction, WorkbookSheet } from "../shared/contracts.ts";
import type { CaseData } from "./data.ts";
import { dateRange } from "./transactions.ts";

export const workbookMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const sheets = Object.keys(workbookColumns) as WorkbookSheet[];
const maxExpandedBytes = 40 * 1024 * 1024;
const maxErrors = 40;

const optionsSchema = z.object({
  name: z.string().trim().min(1).max(60),
  currentStart: z.iso.date(),
  previousStart: z.iso.date(),
  days: z.coerce.number().int().min(1).max(maxComparisonDays),
});

export class WorkbookError extends Error {
  readonly issues: ImportIssue[];
  readonly status: number;
  constructor(issues: ImportIssue[], status = 422) {
    super(issues[0]?.message ?? "Excel 导入校验失败。");
    this.issues = issues;
    this.status = status;
  }
}

export async function workbookBody(req: IncomingMessage) {
  const mime = req.headers["content-type"]?.split(";")[0].trim();
  if (mime !== workbookMime && mime !== "application/octet-stream") {
    throw new WorkbookError([{ message: "请选择 .xlsx 工作簿。" }], 415);
  }
  const tooLarge = () => new WorkbookError([{ message: "工作簿超过 5 MB，请缩小范围后重新上传。" }], 413);
  if (Number(req.headers["content-length"]) > maxWorkbookBytes) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxWorkbookBytes) throw tooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Check the expanded ZIP size before reading sheets and bound sparse cell coordinates.
async function checkArchive(bytes: Buffer) {
  const zip = await new Promise<ZipFile>((resolve, reject) =>
    fromBuffer(bytes, { lazyEntries: true }, (error, file) => error ? reject(error) : resolve(file)));
  await new Promise<void>((resolve, reject) => {
    let expanded = 0;
    zip.on("error", reject);
    zip.once("end", resolve);
    zip.on("entry", (entry) => {
      expanded += entry.uncompressedSize;
      if (zip.entryCount > 256 || expanded > maxExpandedBytes) {
        zip.close();
        reject(new WorkbookError([{ message: "工作簿解压后过大，请精简后重新上传。" }], 413));
        return;
      }
      if (!/^xl\/worksheets\/[^/]+\.xml$/i.test(entry.fileName)) {
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error) { zip.close(); reject(error); return; }
        const chunks: Buffer[] = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.once("error", (error) => { zip.close(); reject(error); });
        stream.once("end", () => {
          const xml = Buffer.concat(chunks).toString("utf8");
          if (/<(?:[\w-]+:)?f(?:\s|\/?>)/i.test(xml)) {
            zip.close();
            reject(new WorkbookError([{ message: "工作簿包含公式。请先将公式列粘贴为值。" }]));
            return;
          }
          for (const match of xml.matchAll(/<(?:[\w-]+:)?c\s[^>]*?\br=["']([A-Z]+)(\d+)["']/gi)) {
            if (match[1].length > 2 || Number(match[2]) > maxWorkbookRows + 1) {
              zip.close();
              reject(new WorkbookError([{ message: "工作表范围过大，请删除多余行列或拆分文件。" }], 413));
              return;
            }
          }
          for (const match of xml.matchAll(/<(?:[\w-]+:)?row\s[^>]*?\br=["'](\d+)["']/gi)) {
            if (Number(match[1]) > maxWorkbookRows + 1) {
              zip.close();
              reject(new WorkbookError([{ message: "工作表范围过大，请删除多余行列或拆分文件。" }], 413));
              return;
            }
          }
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
}

function identifier(value: unknown) {
  if (typeof value === "string") return value.trim().length <= 100 ? value.trim() : "";
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < 1e15) return String(value);
  return "";
}

function date(value: unknown) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 19) + "+08:00";
  if (typeof value !== "string") return null;
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?$/.exec(value.trim());
  if (!match) return null;
  const day = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  const clock = match[4] ?? "00:00";
  const time = clock.length === 5 ? `${clock}:00` : clock;
  if (!z.iso.date().safeParse(day).success || !z.iso.time({ precision: 0 }).safeParse(time).success) return null;
  return `${day}T${time}+08:00`;
}

function cents(value: unknown) {
  const input = typeof value === "number" || typeof value === "string" ? String(value).trim() : "";
  if (!/^(?:\d{1,9}|\d{1,3}(?:,\d{3}){1,2})(?:\.\d{1,2})?$/.test(input)) return null;
  return Math.round(Number(input.replaceAll(",", "")) * 100);
}

export async function readUploadedWorkbook(bytes: Buffer, options?: { trim?: boolean }) {
  try {
    await checkArchive(bytes);
    return await readWorkbook(bytes, options);
  } catch (error) {
    if (error instanceof WorkbookError) throw error;
    throw new WorkbookError([{ message: "无法读取此工作簿，请在 Excel 中另存为未加密的 .xlsx 后重试。" }]);
  }
}

export async function importWorkbook(bytes: Buffer, rawOptions: Record<string, string>) {
  const parsed = optionsSchema.safeParse(rawOptions);
  if (!parsed.success) throw new WorkbookError([{ message: "请填写案例名称、两个有效的开始日期和 1–31 天的比较周期。" }], 400);
  const options = parsed.data;
  const dates = { current: dateRange(options.currentStart, options.days), previous: dateRange(options.previousStart, options.days) };
  if (dates.previous.at(-1)! >= dates.current[0] || dates.current.some((day) => !z.iso.date().safeParse(day).success)) {
    throw new WorkbookError([{ message: "上期必须在本期之前，且两个统计周期不能重叠。" }], 400);
  }
  const workbook = await readUploadedWorkbook(bytes);

  const issues: ImportIssue[] = [];
  const found = new Map(workbook.map(({ sheet, data }) => [sheet.trim(), data]));
  const required = sheets.filter((sheet) => sheet !== "渠道费用");
  for (const sheet of required) if (!found.has(sheet)) issues.push({ sheet, message: "缺少此工作表。" });
  const bodyCount = sheets.reduce((sum, sheet) => sum + Math.max(0, (found.get(sheet)?.length ?? 0) - 1), 0);
  if (bodyCount > maxWorkbookRows) throw new WorkbookError([{ message: "各流水表合计最多支持 20,000 行（不含表头）。" }], 413);
  if (issues.length) throw new WorkbookError(issues);

  const orders = new Map<string, { row: number; transaction: Transaction; refunded: number; hasCost: boolean }>();
  const rows: Transaction[] = [];
  const counts: Record<Period, number> = { current: 0, previous: 0 };
  let outside = 0;

  function read(sheet: WorkbookSheet, visit: (row: number, fields: Record<string, unknown>) => string | void) {
    const data = found.get(sheet);
    if (!data || issues.length >= maxErrors) return;
    const headers = (data[0] ?? []).map((value) => typeof value === "string" ? value.trim() : "");
    const missing = workbookColumns[sheet].filter((name) => headers.filter((header) => header === name).length !== 1);
    if (missing.length) { issues.push({ sheet, row: 1, message: `缺少列或列名重复：${missing.join("、")}。` }); return; }
    const columns = workbookColumns[sheet].map((name) => [name, headers.indexOf(name)] as const);
    for (const [index, row] of data.entries()) {
      if (!index || row.every((value) => value === null || value === "")) continue;
      const message = visit(index + 1, Object.fromEntries(columns.map(([name, offset]) => [name, row[offset]])));
      if (message) issues.push({ sheet, row: index + 1, message });
      if (issues.length >= maxErrors) break;
    }
  }

  function add(row: Transaction) {
    const day = row.occurredAt.slice(0, 10);
    const period = dates.current.includes(day) ? "current" : dates.previous.includes(day) ? "previous" : null;
    if (!period) { outside += 1; return; }
    rows.push({ ...row, period });
    counts[period] += 1;
  }

  read("订单", (row, fields) => {
    const line = identifier(fields["订单行号"]);
    const orderId = identifier(fields["订单号"]);
    const occurredAt = date(fields["日期"]);
    const channel = identifier(fields["渠道"]);
    const sku = identifier(fields["SKU"]);
    const name = identifier(fields["商品名称"]);
    const amount = cents(fields["成交金额"]);
    if (!line || !orderId || !channel || !sku || !name) return "请填写订单行号、订单号、渠道、SKU 和商品名称。";
    if (!occurredAt || !amount) return "请填写有效日期和大于 0、最多两位小数的成交金额。";
    if (orders.has(line)) return "订单行号重复。多商品订单请为每个商品行设置独立行号。";
    const transaction: Transaction = { id: `sales-${line}`, document: line, orderId, channel, occurredAt, metric: "sales",
      period: "current", description: name, product: { sku, name }, amount: amount / 100 };
    orders.set(line, { row, transaction, refunded: 0, hasCost: false });
    add(transaction);
  });

  for (const [sheet, key, amountKey, metric] of [
    ["退款", "退款流水号", "退款金额", "refunds"], ["成本", "成本流水号", "成本金额", "cogs"],
  ] as const) {
    const seen = new Set<string>();
    read(sheet, (_row, fields) => {
      const document = identifier(fields[key]);
      const order = orders.get(identifier(fields["订单行号"]));
      const occurredAt = date(fields["日期"]);
      const amount = cents(fields[amountKey]);
      if (!document || seen.has(document)) return `${key}缺失或重复。`;
      if (!order) return "订单行号在订单表中找不到，请补齐对应订单行。";
      if (!occurredAt || amount === null || (metric === "refunds" && amount === 0)) return "请填写有效日期和金额（最多两位小数）。";
      if (metric === "refunds") {
        if (occurredAt.slice(0, 10) < order.transaction.occurredAt.slice(0, 10)) return "退款日期早于订单日期。";
        if (order.refunded + amount > Math.round(order.transaction.amount * 100)) return "同一订单行累计退款超过成交金额。";
        order.refunded += amount;
      } else {
        order.hasCost = true;
      }
      seen.add(document);
      add({ ...order.transaction, id: `${metric}-${document}`, document, occurredAt, metric, amount: amount / 100,
        description: metric === "refunds" ? "订单退款" : order.transaction.description });
    });
  }

  let hasFees = false;
  const feeIds = new Set<string>();
  read("渠道费用", (_row, fields) => {
    const document = identifier(fields["费用流水号"]);
    const occurredAt = date(fields["日期"]);
    const channel = identifier(fields["渠道"]);
    const type = fields["费用类型"];
    const metric: Driver | null = type === "广告费" ? "ads" : type === "平台费" ? "fees" : null;
    const amount = cents(fields["费用金额"]);
    if (!document || feeIds.has(document)) return "费用流水号缺失或重复。";
    if (!channel || !occurredAt || !metric || amount === null) return "请填写有效渠道、日期、金额；费用类型填“广告费”或“平台费”。";
    feeIds.add(document);
    const before = rows.length;
    add({ id: `${metric}-${document}`, document, occurredAt, channel, metric, amount: amount / 100, period: "current",
      product: null, orderId: null, description: String(type) });
    hasFees ||= rows.length > before;
  });

  for (const order of orders.values()) {
    if (issues.length >= maxErrors) break;
    const day = order.transaction.occurredAt.slice(0, 10);
    if (!order.hasCost && (dates.current.includes(day) || dates.previous.includes(day))) {
      issues.push({ sheet: "订单", row: order.row, message: "订单行没有成本流水。无成本时也请填写一笔金额为 0 的成本记录。" });
    }
  }
  if (issues.length) throw new WorkbookError(issues);
  for (const period of ["current", "previous"] as const) {
    if (!rows.some((row) => row.period === period && row.metric === "sales")) {
      issues.push({ sheet: "订单", message: `${period === "current" ? "本期" : "上期"}没有成交行，请检查日期或调整比较期间。` });
    }
  }
  const channels = [...new Set(rows.map((row) => row.channel))].sort();
  if (channels.length > 30) issues.push({ message: "所选期间最多支持 30 个渠道，请合并或拆分渠道后导入。" });
  if (issues.length) throw new WorkbookError(issues);

  const fingerprint = createHash("sha256").update(bytes).update(JSON.stringify(options)).digest("hex");
  const id: CaseId = `import-${fingerprint}`;
  const data: CaseData = { id, name: options.name, source: "excel", hasFees, headline: options.name,
    description: "对比两期订单、退款和成本流水，核对利润变动及渠道证据。", dates, channels,
    transactions: rows.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id)) };
  const result: ImportResult = { caseId: id, rows: counts, outside, hasFees };
  return { data, result };
}
