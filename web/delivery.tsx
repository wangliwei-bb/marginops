import { useState } from "react";
import type { ReactNode } from "react";
import type { AnalysisReport, WorkbookSummary } from "../shared/analysis.ts";
import type { DeliveryReview } from "../shared/delivery.ts";
import { post } from "./api.ts";

const percent = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 });
const sum = (report: AnalysisReport | null) => report?.groups.reduce((total, group) => total + group.used, 0) ?? 0;

export function DeliveryScenario({ book, disabled, renderSource }: {
  book?: WorkbookSummary; disabled: boolean; renderSource: (report: AnalysisReport, group: number) => ReactNode;
}) {
  const [date, setDate] = useState("");
  const [result, setResult] = useState<{ review: DeliveryReview; sample: boolean }>();
  const [source, setSource] = useState<{ report: AnalysisReport; group: number }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const review = result && (result.sample || result.review.workbookId === book?.id) ? result.review : undefined;
  const canReview = book?.sheets.some(({ name }) => name === "项目交付");

  async function start(sample: boolean) {
    setBusy(true);
    setError("");
    setResult(undefined);
    setSource(undefined);
    try {
      const review = await post<DeliveryReview>("/api/analysis/delivery", sample ? { sample: true }
        : { sample: false, workbookId: book?.id, weekStart: date });
      setResult({ review, sample });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "复盘失败，请重试。"); }
    finally { setBusy(false); }
  }

  function inspect(report: AnalysisReport, group: number) {
    setSource({ report, group });
    requestAnimationFrame(() => document.getElementById("delivery-evidence")?.focus());
  }

  return <section className="panel sla-scenario" aria-labelledby="delivery-title">
    <div className="panel-heading"><div><h2 id="delivery-title">项目交付周复盘</h2>
      <p>项目周会核对本周承诺兑现率，识别需要协调的逾期任务和责任团队。</p></div></div>
    <div className="sla-controls">
      <button className="button primary" disabled={disabled || busy} onClick={() => void start(true)}>试跑交付示例</button>
      <a className="button secondary" href="/api/analysis/delivery/template" download>下载项目交付模板</a>
      {canReview && <form onSubmit={(event) => { event.preventDefault(); if (!disabled && !busy) void start(false); }}>
        <label htmlFor="delivery-start">本周开始</label>
        <input id="delivery-start" type="date" required value={date} onChange={(event) => setDate(event.target.value)} />
        <button className="button secondary" disabled={disabled || busy || !date}>复盘当前项目台账</button>
      </form>}
    </div>
    {!canReview && <p className="analysis-skipped">使用自己的数据时，上传填好的项目交付模板，表头选第 1 行。</p>}
    {busy && <p className="empty" role="status">正在核对任务承诺与实际交付…</p>}
    {error && <p className="error-box" role="alert">{error}</p>}
    {review && <>
      <DeliveryResult review={review} sample={!!result?.sample} inspect={inspect} />
      {source && <div className="sla-evidence">
        <div className="panel-heading"><div><h3 id="delivery-evidence" tabIndex={-1}>任务证据</h3><p>{source.report.question}</p></div>
          <button className="text-button" onClick={() => setSource(undefined)}>收起证据</button></div>
        {renderSource(source.report, source.group)}
      </div>}
    </>}
  </section>;
}

function DeliveryResult({ review, sample, inspect }: {
  review: DeliveryReview; sample: boolean; inspect: (report: AnalysisReport, group: number) => void;
}) {
  const { due, backlog, aging } = review;
  const eligible = sum(due);
  const onTime = due?.groups.reduce((total, group) => total + (group.numerator ?? 0), 0) ?? 0;
  const outstanding = sum(backlog);
  const dueTeams = new Map(due?.groups.map((group) => [group.label, group]));
  const overdueTeams = new Map(backlog?.groups.map((group) => [group.label, group]));
  const teams = [...new Set([...dueTeams.keys(), ...overdueTeams.keys()])].sort((a, b) =>
    (overdueTeams.get(b)?.used ?? 0) - (overdueTeams.get(a)?.used ?? 0) || a.localeCompare(b, "zh-CN"));
  const leader = backlog?.groups[0];
  return <div className="sla-result">
    <p className="analysis-skipped">{sample ? "合成示例 · " : ""}{review.weekStart} 至 {review.weekEnd}</p>
    <div className="sla-kpis">
      <div><span>本周有效应交</span><strong>{eligible}</strong></div>
      <div><span>按期交付率</span><strong>{eligible ? percent.format(onTime / eligible) : "—"}</strong><small>{onTime} / {eligible} 项</small></div>
      <div><span>周末逾期未交</span><strong>{outstanding}</strong><small>往期遗留 {aging.pastWeek} 项</small></div>
    </div>
    {leader && <p className="sla-finding"><strong>{leader.label}</strong>有 {leader.used} 项逾期未交。全盘有 {aging.highPriority} 项高优先级积压、{aging.sevenDays} 项已逾期至少七天。周会上先确认责任人、阻塞原因和新的承诺日期。</p>}
    {teams.length > 0 && <div className="table-scroll" tabIndex={0} aria-label="各团队交付与积压">
      <table><thead><tr><th scope="col">负责团队</th><th scope="col">按期 / 应交</th><th scope="col">按期率</th><th scope="col">期末逾期未交</th><th scope="col">任务明细</th></tr></thead>
        <tbody>{teams.map((team) => {
          const current = dueTeams.get(team);
          const queued = overdueTeams.get(team);
          return <tr key={team}><th scope="row">{team}</th>
            <td>{current?.value == null ? "—" : `${current.numerator} / ${current.used}`}</td>
            <td>{current?.value == null ? "—" : percent.format(current.value)}</td><td>{queued?.used ?? 0}</td>
            <td className="sla-links">
              {due && current && <button className="text-button" onClick={() => inspect(due, current.id)}>应交 · {team}</button>}
              {backlog && queued && <button className="text-button" onClick={() => inspect(backlog, queued.id)}>逾期 · {team}</button>}
            </td></tr>;
        })}</tbody></table>
    </div>}
    <p className="analysis-skipped">按承诺交付日归期。实际交付日期不晚于承诺日期即按期。本周应交中有 {review.cancelled} 项在周末前取消，已排除。积压包含往期遗留及本周末应交未交的任务。</p>
  </div>;
}
