import { useState } from "react";
import { maxComparisonDays, maxWorkbookBytes, workbookColumns } from "../shared/contracts.ts";
import type { ImportIssue, ImportOptions, ImportResult } from "../shared/contracts.ts";

const initial: ImportOptions = { name: "", previousStart: "2026-10-26", currentStart: "2026-11-02", days: 7 };

export function ImportPage({ openCase }: { openCase: (result: ImportResult) => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [options, setOptions] = useState(initial);
  const [issues, setIssues] = useState<ImportIssue[]>([]);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  function update<K extends keyof ImportOptions>(key: K, value: ImportOptions[K]) {
    setOptions((current) => ({ ...current, [key]: value }));
    setResult(null);
    setIssues([]);
  }

  async function submit() {
    if (!file) return;
    if (!/\.xlsx$/i.test(file.name) || file.size > maxWorkbookBytes) {
      setIssues([{ message: "请选择不超过 5 MB 的 .xlsx 工作簿。" }]);
      return;
    }
    setBusy(true);
    setIssues([]);
    setResult(null);
    try {
      const params = new URLSearchParams({ ...options, days: String(options.days) });
      const response = await fetch(`/api/import?${params}`, {
        method: "POST", body: file, headers: { "Content-Type": "application/octet-stream" },
      });
      const payload = await response.json();
      if (response.ok) setResult(payload);
      else setIssues(payload.issues ?? [{ message: payload.error ?? "导入失败，请重试。" }]);
    } catch {
      setIssues([{ message: "无法连接本地服务，请重试。" }]);
    } finally { setBusy(false); }
  }

  async function open() {
    if (!result) return;
    setBusy(true);
    try { await openCase(result); }
    catch { setIssues([{ message: "数据已保存，打开案例失败。请重试。" }]); }
    finally { setBusy(false); }
  }

  return <div className="import-layout">
    <section className="panel" aria-labelledby="import-title">
      <div className="panel-heading"><div><h2 id="import-title">上传 Excel 流水</h2>
        <p>导入为独立案例，使用同一批流水核对利润、查看商品分析和发起研判。</p></div>
        <a className="button secondary" href="/api/import/template" download>下载模板</a></div>
      <form className="import-form" onSubmit={(event) => { event.preventDefault(); if (!busy) void submit(); }}>
        <fieldset disabled={busy}>
          <label htmlFor="import-file">Excel 工作簿</label>
          <input id="import-file" type="file" accept=".xlsx" required aria-describedby="import-limits" onChange={(event) => {
            const selected = event.target.files?.[0] ?? null;
            setFile(selected);
            setResult(null);
            setIssues([]);
            if (selected && !options.name.trim()) update("name", selected.name.replace(/\.xlsx$/i, "").slice(0, 60));
          }} />
          <p id="import-limits">.xlsx · 5 MB 以内 · 流水表合计最多 20,000 行</p>
          <label htmlFor="import-name">案例名称</label>
          <input id="import-name" value={options.name} required maxLength={60}
            onChange={(event) => update("name", event.target.value)} placeholder="例如：双十一直播复盘" />
          <div className="import-dates">
            <div><label htmlFor="import-previous">上期开始</label><input id="import-previous" type="date" required
              value={options.previousStart} onChange={(event) => update("previousStart", event.target.value)} /></div>
            <div><label htmlFor="import-current">本期开始</label><input id="import-current" type="date" required
              value={options.currentStart} onChange={(event) => update("currentStart", event.target.value)} /></div>
            <div><label htmlFor="import-days">每期天数</label><input id="import-days" type="number" required min={1} max={maxComparisonDays}
              value={Number.isNaN(options.days) ? "" : options.days} onChange={(event) => update("days", event.target.valueAsNumber)} /></div>
          </div>
          <button className="button primary" disabled={busy || !file || !options.name.trim()}>{busy && !result ? "正在导入…" : "校验并导入"}</button>
        </fieldset>
      </form>
      {issues.length > 0 && <div className="error-box import-feedback" role="alert">
        <strong>{result ? "打开案例失败" : "导入未完成"}</strong>
        <ul>{issues.map(({ sheet, row, message }, index) => <li key={index}>{[sheet && `「${sheet}」`, row && `第 ${row} 行`, message].filter(Boolean).join(" ")}</li>)}</ul>
      </div>}
      {result && <div className="import-feedback import-success">
        <div role="status"><strong>导入成功</strong>
          <p>本期 {result.rows.current} 笔 · 上期 {result.rows.previous} 笔{result.outside > 0 && ` · ${result.outside} 笔在比较期间之外`}</p>
          {!result.hasFees && <p>所选期间未导入渠道费用，利润分析只扣除已导入的退款与成本。</p>}
        </div>
        <button className="button primary" disabled={busy} onClick={() => void open()}>查看利润分析</button>
      </div>}
    </section>
    <section className="panel import-guide" aria-labelledby="import-guide-title">
      <div className="panel-heading"><div><h2 id="import-guide-title">工作表格式</h2><p>首行使用以下列名，表格粘贴为值后上传。</p></div></div>
      <dl>{Object.entries(workbookColumns).map(([name, columns]) => <div key={name}>
        <dt>{name}{name === "渠道费用" && <small>（可选）</small>}</dt><dd>{columns.join(" · ")}</dd>
      </div>)}</dl>
      <p>退款和成本通过订单行号关联。涉及跨期退款时，把对应的历史订单行也放入订单表。</p>
      <p>金额单位为人民币元。订单行没有成本时，填一笔金额为 0 的成本。模板中的示例行可直接用默认日期试跑。</p>
      <p>上传的流水保存在本地。导入案例默认使用本地规则研判。</p>
    </section>
  </div>;
}
