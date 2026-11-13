import { useState } from "react";
import type { AnalysisReport, WorkbookSummary } from "../shared/analysis.ts";
import type { SlaReview } from "../shared/sla.ts";
import { post } from "./api.ts";

const percent = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 });
const decimal = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1, signDisplay: "exceptZero" });
const dateBefore = (date: string) => new Date(Date.parse(date) - 86_400_000).toISOString().slice(0, 10);
const percentage = (value: number | null | undefined) => value == null ? "—" : percent.format(value);

type OpenSource = (report: AnalysisReport, group: number) => void;

function EvidenceLink({ report, id, label, inspect }: { report: AnalysisReport | null; id?: number; label: string; inspect: OpenSource }) {
  return report && id !== undefined ? <button type="button" className="text-button" onClick={() => inspect(report, id)}>{label}</button> : <span>—</span>;
}

export function SlaScenario({ book, disabled, renderSource }: {
  book?: WorkbookSummary; disabled: boolean; renderSource: (report: AnalysisReport, group: number) => React.ReactNode;
}) {
  const [date, setDate] = useState("");
  const [review, setReview] = useState<SlaReview>();
  const [source, setSource] = useState<{ report: AnalysisReport; group: number }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sample, setSample] = useState(false);
  const showReview = review && (sample || review.workbookId === book?.id) ? review : undefined;
  const canReview = book?.sheets.some(({ name }) => name === "客服工单");

  async function start(useSample: boolean) {
    setBusy(true);
    setError("");
    setSource(undefined);
    try {
      const result = await post<SlaReview>("/api/analysis/sla", useSample ? { sample: true }
        : { sample: false, workbookId: book?.id, weekStart: date });
      setReview(result);
      setSample(useSample);
    } catch (failure) {
      setReview(undefined);
      setError(failure instanceof Error ? failure.message : "复盘失败，请重试。");
    } finally { setBusy(false); }
  }

  function inspect(report: AnalysisReport, group: number) {
    setSource({ report, group });
    requestAnimationFrame(() => document.getElementById("sla-evidence-title")?.focus());
  }

  return <section className="panel sla-scenario" aria-labelledby="sla-title">
    <div className="panel-heading"><div>
      <h2 id="sla-title">客服 SLA 周复盘</h2>
      <p>周会上判断哪条渠道的首次响应超时在恶化，以及哪些团队要先清积压。</p>
    </div><span className="sla-label">业务场景</span></div>
    <div className="sla-controls">
      <button type="button" className="button primary" disabled={disabled || busy} onClick={() => void start(true)}>试跑客服示例</button>
      <a className="button secondary" href="/api/analysis/sla/template" download>下载客服工单模板</a>
      {canReview && <form onSubmit={(event) => { event.preventDefault(); if (!busy && !disabled) void start(false); }}>
        <label htmlFor="sla-start">本期开始</label>
        <input id="sla-start" type="date" required value={date} onChange={(event) => setDate(event.target.value)} />
        <button className="button secondary" disabled={disabled || busy || !date}>复盘当前工作簿</button>
      </form>}
    </div>
    {!canReview && <p className="analysis-skipped">使用自己的数据时，填好模板并在下方上传，表头选第 1 行。</p>}
    {busy && <p className="empty" role="status">正在核对工单和两期统计口径…</p>}
    {error && <p className="error-box" role="alert">{error}</p>}
    {showReview && <>
      <ReviewResult review={showReview} sample={sample} inspect={inspect} />
      {source && <div className="sla-evidence">
        <div className="panel-heading"><div><h3 id="sla-evidence-title" tabIndex={-1}>工单证据</h3><p>{source.report.question} · 派生字段标注为「计算」</p></div>
          <button type="button" className="text-button" onClick={() => setSource(undefined)}>收起证据</button></div>
        {renderSource(source.report, source.group)}
      </div>}
    </>}
  </section>;
}

function ReviewResult({ review, sample, inspect }: { review: SlaReview; sample: boolean; inspect: OpenSource }) {
  const { current, previous, backlog, counts } = review;
  const prior = new Map(previous?.groups.map((row) => [row.label, row]));
  const actual = new Map(current?.groups.map((row) => [row.label, row]));
  const channels = [...new Set([...actual.keys(), ...prior.keys()])];
  const rows = channels.map((channel) => {
    const now = actual.get(channel);
    const then = prior.get(channel);
    const delta = now?.value != null && then?.value != null ? (now.value - then.value) * 100 : null;
    return { channel, now, then, delta };
  }).sort((a, b) => (b.delta ?? -Infinity) - (a.delta ?? -Infinity) || (b.now?.value ?? -1) - (a.now?.value ?? -1));
  const eligible = current?.groups.reduce((sum, group) => sum + group.used, 0) ?? 0;
  const breached = current?.groups.reduce((sum, group) => sum + (group.numerator ?? 0), 0) ?? 0;
  const outstanding = backlog?.groups.reduce((sum, group) => sum + (group.value ?? 0), 0) ?? 0;
  const leader = rows[0]?.delta != null && rows[0].delta > 0 ? rows[0] : null;
  const hasComparison = rows.some(({ delta }) => delta !== null);
  const team = backlog?.groups[0];
  return <div className="sla-result">
    <p className="analysis-skipped">{sample ? "合成示例 · " : ""}本期 {review.weekStart} 至 {dateBefore(review.currentCutoff)} · 上期 {review.previousStart} 至 {dateBefore(review.weekStart)}</p>
    <div className="sla-kpis">
      <div><span>本期受理</span><strong>{counts.current.received}</strong></div>
      <div><span>首次响应超时率</span><strong>{percentage(eligible ? breached / eligible : null)}</strong><small>{breached} / {eligible} 张</small></div>
      <div><span>本期工单期末未响应且超时</span><strong>{outstanding}</strong></div>
    </div>
    {leader && <p className="sla-finding"><strong>{leader.channel}</strong>超时率较上期上升 <strong>{decimal.format(leader.delta!)} 个百分点</strong>
      （{leader.then?.numerator}/{leader.then?.used} → {leader.now?.numerator}/{leader.now?.used} 张），建议先核对该渠道的工单和班次覆盖。</p>}
    {!leader && <p className="sla-finding">{hasComparison ? "有两期有效数据的渠道中，超时率均未上升。"
      : "暂无两期均有有效工单的渠道，渠道变化留空。"}</p>}
    {team && <p className="sla-finding">本期受理、期末未响应且已超时的工单中，<strong>{team.label}</strong>有 <strong>{team.value} 张</strong>。先核对这批工单的负责人和当前进展。</p>}
    {rows.length > 0 && <div className="table-scroll" tabIndex={0} aria-label="客服渠道超时率对比">
      <table><thead><tr><th scope="col">渠道</th><th scope="col">本期超时 / 有效</th><th scope="col">本期超时率</th>
        <th scope="col">上期超时率</th><th scope="col">变化（百分点）</th><th scope="col">工单明细</th></tr></thead>
        <tbody>{rows.map(({ channel, now, then, delta }) => <tr key={channel}>
          <th scope="row">{channel}</th><td>{now?.value == null ? "—" : `${now.numerator} / ${now.used}`}</td>
          <td>{percentage(now?.value)}</td><td>{percentage(then?.value)}</td>
          <td className={delta !== null && delta > 0 ? "negative" : undefined}>{delta === null ? "—" : decimal.format(delta)}</td>
          <td className="sla-links"><EvidenceLink report={current} id={now?.id} label={`本期 · ${channel}`} inspect={inspect} />
            <EvidenceLink report={previous} id={then?.id} label={`上期 · ${channel}`} inspect={inspect} /></td>
        </tr>)}</tbody></table>
    </div>}
    {backlog && <div className="sla-backlog">
      <h3>本期工单的期末超时队列</h3>
      <ul>{backlog.groups.map((group) => <li key={group.id}>
        <button type="button" className="text-button" onClick={() => inspect(backlog, group.id)}>{group.label} · {group.used} 张</button>
      </li>)}</ul>
    </div>}
    <p className="analysis-skipped">按受理日期归期，两期使用各自期末截点（北京时间）。本期取消 {counts.current.cancelled} 张、未到期且未响应 {counts.current.pending} 张，均未计入超时率分母。SLA 按自然分钟计算。</p>
  </div>;
}
