import { useEffect, useState } from "react";
import { columnNames, methodNames } from "../shared/analysis.ts";
import type { AnalysisOutcome, AnalysisReport, AnalysisSource, WorkbookSummary } from "../shared/analysis.ts";
import { maxWorkbookBytes } from "../shared/contracts.ts";
import { post, request } from "./api.ts";

const examples = ["按部门比较平均处理时长", "按月统计记录数", "按部门统计状态等于“延期”的记录占比"];
const labels = { included: "参与计算", numerator: "计入分子及分母", denominator: "仅计入分母", excluded: "未参与（缺值）" };
const numbers = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 });
const valueText = (value: number | null, share: boolean) =>
  value === null ? "—" : share ? `${numbers.format(value * 100)}%` : numbers.format(value);

function SourceRows({ report, group }: { report: AnalysisReport; group: number }) {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<{ page: number; data?: AnalysisSource }>();
  useEffect(() => {
    const controller = new AbortController();
    void request<AnalysisSource>(`/api/analysis/reports/${report.id}/source?group=${group}&page=${page}`, { signal: controller.signal })
      .then((data) => setResult({ page, data }))
      .catch(() => { if (!controller.signal.aborted) setResult({ page }); });
    return () => controller.abort();
  }, [report.id, group, page]);
  const selected = report.groups.find((row) => row.id === group)!;
  if (result?.page !== page) return <p className="empty" role="status">正在读取原始行…</p>;
  const source = result.data;
  if (!source) return <p className="error-box" role="alert">无法读取该组的原始行。</p>;
  const pages = Math.max(1, Math.ceil(source.total / 20));
  const used = new Set([report.plan.metric, report.plan.group, report.plan.denominator, report.plan.match?.column,
    ...report.plan.filters.map(({ column }) => column)]);
  return <div className="analysis-source">
    <h3>{selected.label} · 原始行</h3>
    <p>工作表「{source.sheet}」 · 共 {source.total} 行。绿色列参与了本次统计。</p>
    <div className="table-scroll" tabIndex={0} aria-label="原始 Excel 数据">
      <table><thead><tr><th scope="col">Excel 行号</th><th scope="col">计入口径</th>
        {source.columns.map((column) => <th key={column.id} className={used.has(column.id) ? "analysis-source-column" : undefined}
          scope="col">{column.id} · {column.name}</th>)}</tr></thead>
        <tbody>{source.rows.map(({ row, values, use }) => <tr key={row}>
          <th scope="row">{row}</th><td>{labels[use]}</td>
          {source.columns.map(({ id }, index) => <td key={id} className={used.has(id) ? "analysis-source-column" : undefined}>
            {values[index] === null ? "—" : String(values[index])}</td>)}
        </tr>)}</tbody>
      </table>
    </div>
    <div className="ledger-pages"><span>第 {page} / {pages} 页</span>
      <div><button className="button secondary" onClick={() => setPage(page - 1)} disabled={page === 1}>上一页</button>
        <button className="button secondary" onClick={() => setPage(page + 1)} disabled={page >= pages}>下一页</button></div>
    </div>
  </div>;
}

function Report({ report }: { report: AnalysisReport }) {
  const [group, setGroup] = useState<number>();
  const [page, setPage] = useState(1);
  const pages = Math.ceil(report.groups.length / 10);
  const share = report.plan.method === "share";
  const fractional = share || report.plan.method === "ratio";
  return <section className="panel general-report" aria-labelledby="general-report-title">
    <div className="panel-heading"><div><h2 id="general-report-title">分析报告</h2>
      <p>{report.mode === "live" ? "实时模型规划" : "本地规则规划"} · 工作表「{report.sheet}」 · {report.matchedRows} 条匹配记录</p></div></div>
    <h3 className="report-headline">{report.summary}</h3>
    <p className="report-summary">{report.question}</p>
    <ul className="analysis-notes">{report.notes.map((note) => <li key={note}>{note}</li>)}</ul>
    <div className="table-scroll" tabIndex={0} aria-label="分析结果和证据">
      <table><thead><tr><th scope="col">分组</th><th scope="col">{methodNames[report.plan.method]}</th>
        {fractional && <th scope="col">分子 / 分母</th>}<th scope="col">有效行</th><th scope="col">排除行</th><th scope="col">证据</th></tr></thead>
        <tbody>{report.groups.slice((page - 1) * 10, page * 10).map((item) => <tr key={item.id}>
          <th scope="row">{item.label}</th><td>{valueText(item.value, share)}</td>
          {fractional && <td>{valueText(item.numerator, false)} / {valueText(item.denominator, false)}</td>}
          <td>{item.used}</td><td>{item.excluded}</td>
          <td><button className="text-button" aria-pressed={group === item.id}
            onClick={() => setGroup(group === item.id ? undefined : item.id)}>查看原始行<span className="sr-only"> · {item.label}</span></button></td>
        </tr>)}</tbody>
      </table>
    </div>
    {pages > 1 && <div className="ledger-pages"><span>第 {page} / {pages} 页 · {report.totalGroups} 组</span>
      <div><button className="button secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</button>
        <button className="button secondary" disabled={page === pages} onClick={() => setPage(page + 1)}>下一页</button></div>
    </div>}
    {group !== undefined && <SourceRows key={group} report={report} group={group} />}
  </section>;
}

export function AnalysisPage() {
  const [workbooks, setWorkbooks] = useState<WorkbookSummary[]>([]);
  const [live, setLive] = useState(false);
  const [allowLive, setAllowLive] = useState(false);
  const [workbookId, setWorkbookId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [headerRow, setHeaderRow] = useState(1);
  const [sheet, setSheet] = useState("");
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<AnalysisReport[]>([]);
  const [report, setReport] = useState<AnalysisReport>();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"upload" | "analyze">();
  const book = workbooks.find(({ id }) => id === workbookId);
  const table = book?.sheets.find(({ name }) => name === sheet) ?? (book?.sheets.length === 1 ? book.sheets[0] : undefined);

  useEffect(() => {
    void request<{ workbooks: WorkbookSummary[]; live: boolean }>("/api/analysis/workbooks").then((data) => {
      setWorkbooks(data.workbooks);
      setLive(data.live);
      setWorkbookId((id) => id || data.workbooks[0]?.id || "");
    }).catch(() => setError("无法读取本地工作簿，请刷新重试。"));
  }, []);
  useEffect(() => {
    if (!workbookId) return;
    const controller = new AbortController();
    void request<AnalysisReport[]>(`/api/analysis/reports?workbookId=${workbookId}`, { signal: controller.signal })
      .then(setHistory).catch(() => { if (!controller.signal.aborted) setError("无法读取历史分析。"); });
    return () => controller.abort();
  }, [workbookId]);

  function selectWorkbook(id: string) {
    setWorkbookId(id);
    setSheet("");
    setReport(undefined);
    setNotice("");
    setError("");
    setAllowLive(false);
  }

  async function upload() {
    if (!file) return;
    setError("");
    if (!/\.xlsx$/i.test(file.name) || file.size > maxWorkbookBytes) {
      setError("请选择不超过 5 MB 的 .xlsx 工作簿。");
      return;
    }
    setBusy("upload");
    try {
      const params = new URLSearchParams({ name: file.name.slice(0, 120), headerRow: String(headerRow) });
      const uploaded = await request<WorkbookSummary>(`/api/analysis/workbooks?${params}`, {
        method: "POST", body: file, headers: { "Content-Type": "application/octet-stream" },
      });
      setWorkbooks((current) => [uploaded, ...current.filter(({ id }) => id !== uploaded.id)]);
      selectWorkbook(uploaded.id);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "上传失败。"); }
    finally { setBusy(undefined); }
  }

  async function analyze() {
    setBusy("analyze");
    setReport(undefined);
    setNotice("");
    setError("");
    try {
      const result = await post<AnalysisOutcome>("/api/analysis/reports", { workbookId, question, sheet: sheet || undefined, allowLive });
      if ("report" in result) {
        setReport(result.report);
        setHistory((current) => [result.report, ...current].slice(0, 20));
      } else setNotice(result.clarification);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "分析失败。"); }
    finally { setBusy(undefined); setAllowLive(false); }
  }

  return <div className="general-analysis">
    <div className="import-layout">
      <section className="panel" aria-labelledby="analysis-question-title">
        <div className="panel-heading"><div><h2 id="analysis-question-title">用一句话提问</h2>
          <p>选择或上传工作簿。系统会按问题选字段、计算指标并校验原始行引用。</p></div></div>
        <form className="import-form" onSubmit={(event) => { event.preventDefault(); if (!busy && workbookId) void analyze(); }}>
          <fieldset disabled={!!busy}>
            <label htmlFor="analysis-workbook">工作簿</label>
            <select id="analysis-workbook" value={workbookId} required onChange={(event) => selectWorkbook(event.target.value)}>
              <option value="">请先上传工作簿</option>
              {workbooks.map(({ id, name, headerRow }) => <option key={id} value={id}>{name} · 表头第 {headerRow} 行</option>)}
            </select>
            {book && <>
              <label htmlFor="analysis-sheet">工作表</label>
              <select id="analysis-sheet" value={sheet} onChange={(event) => setSheet(event.target.value)}>
                <option value="">按问题自动选择</option>
                {book.sheets.map(({ name, rowCount }) => <option key={name} value={name}>{name} · {rowCount} 行</option>)}
              </select>
            </>}
            <label htmlFor="analysis-question">你想弄清楚什么？</label>
            <textarea id="analysis-question" rows={3} minLength={3} maxLength={240} required value={question}
              onChange={(event) => setQuestion(event.target.value)} placeholder="例如：按部门比较平均处理时长，哪个部门最慢？" />
            <div className="analysis-examples">{examples.map((example) =>
              <button className="text-button" key={example} type="button" onClick={() => setQuestion(example)}>{example}</button>)}</div>
            {live && <label className="live-choice"><input type="checkbox" checked={allowLive} onChange={(event) => setAllowLive(event.target.checked)} />
              允许本次将问题、表名、列名和字段概况发送到 OpenAI 制定分析方案</label>}
            <button className="button primary" disabled={!book || question.trim().length < 3 || !!busy}>
              {busy === "analyze" ? "分析中…" : "开始分析"}</button>
          </fieldset>
        </form>
      </section>
      <section className="panel" aria-labelledby="analysis-upload-title">
        <div className="panel-heading"><div><h2 id="analysis-upload-title">上传业务 Excel</h2>
          <p>支持 .xlsx，5 MB 以内、合计 20,000 行。先将公式粘贴为值。</p></div>
          <a className="button secondary" href="/api/analysis/template" download>下载模板</a></div>
        <form className="import-form" onSubmit={(event) => { event.preventDefault(); if (!busy) void upload(); }}>
          <fieldset disabled={!!busy}>
            <label htmlFor="analysis-file">Excel 文件</label>
            <input id="analysis-file" type="file" accept=".xlsx" required onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
            <label htmlFor="analysis-header">表头所在行</label>
            <input id="analysis-header" type="number" min={1} max={30} required value={Number.isNaN(headerRow) ? "" : headerRow}
              onChange={(event) => setHeaderRow(event.target.valueAsNumber)} />
            <button className="button secondary" disabled={!file || !!busy}>{busy === "upload" ? "读取中…" : "读取工作簿"}</button>
          </fieldset>
        </form>
        {table && <details className="analysis-fields"><summary>字段预览 · {table.name}</summary>
          <ul>{table.columns.map(({ id, name, kind, filled }) => <li key={id}><strong>{id} · {name}</strong> · {columnNames[kind]} · {filled} 行有值</li>)}</ul>
        </details>}
        {!!book?.skipped.length && <p className="analysis-skipped">未识别为数据表：{book.skipped.join("、")}</p>}
        <p className="analysis-skipped">工作簿数据保存在本机，默认使用本地规则分析。</p>
      </section>
    </div>
    {error && <p className="error-box" role="alert">{error}</p>}
    {notice && <div className="panel analysis-clarification" role="status"><h2>还需要明确一个条件</h2><p>{notice}</p></div>}
    {report && <Report key={report.id} report={report} />}
    {history.some((item) => item.workbookId === workbookId) && <details className="panel general-history">
      <summary>此工作簿的历史分析</summary>
      <ul className="history-list">{history.filter((item) => item.workbookId === workbookId).map((item) => <li key={item.id}>
        <button onClick={() => { setReport(item); setQuestion(item.question); setNotice(""); setError(""); }} disabled={!!busy}>
          <span>{item.question}<small>{item.sheet} · {new Date(item.createdAt).toLocaleString("zh-CN")}</small></span>
        </button>
      </li>)}</ul>
    </details>}
  </div>;
}
