import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { roleNames } from "../shared/contracts.ts";
import type { CaseId, CaseView, Decision, Evidence, Mode, Run, RunSummary, Status, Step } from "../shared/contracts.ts";
import { post, request } from "./api.ts";
import { BusinessFlow, BusinessPage } from "./business.tsx";
import type { LedgerFocus } from "./business.tsx";
import { money, signedMoney } from "./format.ts";
import { ProductsPage } from "./products.tsx";
import { TasksPage } from "./tasks.tsx";
import "./styles.css";

const signed = (value: number, digits = 1) => `${value < 0 ? "−" : value > 0 ? "+" : ""}${Math.abs(value).toFixed(digits)}`;
const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const stamp = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const statusNames: Record<Status, string> = {
  running: "研判中", review_required: "待审批", approved: "已批准", rejected: "已驳回", failed: "研判失败",
};
const stepNames: Record<Step, string> = {
  ...roleNames, prepare: "数据准备", synthesis: "汇总 Agent", review: "审阅 Agent", approval: "人工审批",
};

interface Bootstrap { mode: Mode; cases: CaseView[]; runs: RunSummary[] }

type IconName = "grid" | "ledger" | "product" | "tasks" | "history" | "arrow" | "play" | "calendar" | "activity" | "check" | "shield";
function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, string> = {
    grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
    ledger: "M5 3h14v18H5z M8 7h8 M8 11h8 M8 15h3 m2 2h3",
    product: "m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3z m0 9 8-4.5M12 12 4 7.5M12 12v9",
    tasks: "M9 5h11m-11 7h11m-11 7h11M3 5l1 1 2-2m-3 8 1 1 2-2m-3 8 1 1 2-2",
    history: "M3 12a9 9 0 1 1 2.7 6.4 M3 5v7h7 M12 7v5l3 2",
    arrow: "M5 12h14m-6-6 6 6-6 6",
    play: "m9 5 11 7-11 7z",
    calendar: "M4 6h16v15H4z M4 10h16 M8 3v5m8-5v5",
    activity: "M2 12h5l3-7 4 14 3-7h5",
    check: "m5 12 4 4L19 6",
    shield: "m12 22 2-1c4-2 6-5 6-9V5l-8-3-8 3v7c0 4 2 7 6 9z m-4-10 3 3 5-5",
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}

function Mark() {
  return <div className="mark" aria-hidden="true"><Icon name="activity" size={24} /></div>;
}

function StatusPill({ status }: { status: Status }) {
  return <span className={`status status-${status}`}><span aria-hidden="true" />{statusNames[status]}</span>;
}

function MetricCards({ scenario }: { scenario: CaseView }) {
  const { metrics, baseline } = scenario;
  const metricsList = [
    { name: "成交额", value: money(metrics.sales), delta: (metrics.sales / baseline.sales - 1) * 100, unit: "%" },
    { name: "贡献利润", value: money(metrics.contribution), delta: (metrics.contribution / baseline.contribution - 1) * 100, unit: "%" },
    { name: "贡献利润率", value: `${(metrics.margin * 100).toFixed(1)}%`, delta: (metrics.margin - baseline.margin) * 100, unit: " pp" },
    { name: "退款额占比", value: `${(metrics.refundRate * 100).toFixed(1)}%`, delta: (metrics.refundRate - baseline.refundRate) * 100, unit: " pp", inverse: true },
  ];
  return <section className="metrics" aria-label="经营指标">
    {metricsList.map(({ name, value, delta, unit, inverse }) => <div className="metric" key={name}>
      <div className="metric-label">{name}</div>
      <strong className="metric-value">{value}</strong>
      <div className="metric-change"><span className={(inverse ? -delta : delta) >= 0 ? "positive" : "negative"}>
        {signed(delta)}{unit}</span><span>较上期</span></div>
    </div>)}
  </section>;
}

function Trend({ scenario }: { scenario: CaseView }) {
  const chart = { left: 48, right: 590, top: 16, bottom: 171 };
  const { daily } = scenario;
  const cap = Math.ceil(Math.max(...daily.flatMap((day) => [day.current, day.previous])) / 5000) * 5000;
  const x = (index: number) => chart.left + (chart.right - chart.left) * index / (daily.length - 1);
  const y = (value: number) => chart.bottom - (chart.bottom - chart.top) * value / cap;
  const points = (series: "current" | "previous") => daily.map((day, index) => `${x(index)},${y(day[series])}`).join(" ");
  return <section className="panel trend" aria-labelledby="trend-title">
    <div className="panel-heading">
      <div><h2 id="trend-title">贡献利润走势</h2><p>日度对照 · 人民币</p></div>
      <div className="legend"><span>本期</span><span>上期同期</span></div>
    </div>
    <svg className="trend-chart" viewBox="0 0 610 202" role="img" aria-label={`本期总贡献利润 ${money(scenario.metrics.contribution)}，上期 ${money(scenario.baseline.contribution)}`}>
      {[0, 1, 2, 3].map((tick) => {
        const value = cap * tick / 3;
        return <g key={tick}>
          <line x1={chart.left} x2={chart.right} y1={y(value)} y2={y(value)} stroke="#e6e9e3" />
          <text x={0} y={y(value) + 4}>{value ? `${(value / 1000).toFixed(1)}k` : "0"}</text>
        </g>;
      })}
      <polygon points={`${chart.left},${chart.bottom} ${points("current")} ${chart.right},${chart.bottom}`} fill="#eaf3e8" />
      <polyline points={points("previous")} stroke="#818d83" strokeWidth="2" strokeDasharray="6 5" fill="none" />
      <polyline points={points("current")} stroke="#337347" strokeWidth="2.7" strokeLinejoin="round" fill="none" />
      {daily.map((day, i) => <g key={day.day}>
        <circle cx={x(i)} cy={y(day.current)} r="3.6" fill="#fff" stroke="#337347" strokeWidth="2">
          <title>{day.day} · 本期 {money(day.current)} · 上期 {money(day.previous)}</title>
        </circle>
        <text x={x(i)} y={195} textAnchor="middle">{day.day}</text>
      </g>)}
    </svg>
    <details className="chart-data">
      <summary>查看日度数据</summary>
      <table><thead><tr><th>本期日期</th><th>本期贡献利润</th><th>上期同期</th></tr></thead>
        <tbody>{daily.map((row) => <tr key={row.day}><td>{row.day}</td><td>{money(row.current)}</td><td>{money(row.previous)}</td></tr>)}</tbody>
      </table>
    </details>
  </section>;
}

function Bridge({ scenario }: { scenario: CaseView }) {
  const max = Math.max(...scenario.bridge.map((item) => Math.abs(item.impact)));
  const net = scenario.metrics.contribution - scenario.baseline.contribution;
  return <section className="panel bridge" aria-labelledby="bridge-title">
    <div className="panel-heading"><div><h2 id="bridge-title">利润变动分解</h2><p>各科目对本期利润的影响</p></div><Icon name="activity" /></div>
    <div className="bridge-lines">
      {scenario.bridge.map((row) => <div className="bridge-line" key={row.metric}>
        <span>{row.label}</span>
        <div className="bridge-track" aria-hidden="true"><span className={row.impact < 0 ? "loss" : "gain"}
          style={{ width: `${Math.abs(row.impact) / max * 50}%` }} /></div>
        <strong className={row.impact < 0 ? "negative" : "positive"}>{signedMoney(row.impact)}</strong>
      </div>)}
    </div>
    <div className="bridge-total"><span>贡献利润净变化</span><strong className={net < 0 ? "negative" : "positive"}>{signedMoney(net)}</strong></div>
  </section>;
}

function EvidenceTable({ evidence, inspect }: { evidence: Evidence[]; inspect: (fact: Evidence) => void }) {
  return <div className="table-scroll" tabIndex={0} aria-label="证据明细">
    <table>
      <thead><tr><th scope="col">编号</th><th scope="col">渠道 / 指标</th><th scope="col">上期</th><th scope="col">本期</th><th scope="col">利润影响</th><th scope="col">来源</th></tr></thead>
      <tbody>{evidence.map((fact) => <tr key={fact.id}>
        <td><code>{fact.id}</code></td><td>{fact.channel} · {fact.label}</td><td>{money(fact.previous)}</td><td>{money(fact.current)}</td>
        <td className={fact.impact < 0 ? "negative" : "positive"}>{signedMoney(fact.impact)}</td>
        <td><button className="text-button" onClick={() => inspect(fact)} aria-label={`查看${fact.channel}${fact.label}流水`}>查看流水</button></td>
      </tr>)}</tbody>
    </table>
  </div>;
}

function Investigation({ run, busy, decide, inspect, inspectProducts, openTask }: {
  run: Run; busy: boolean; decide: (decision: Decision) => void; inspect: (fact: Evidence) => void;
  inspectProducts: (channel: string) => void; openTask: () => void;
}) {
  const report = run.report;
  const lead = run.evidence.find((fact) => fact.id === report?.evidenceIds[0]);
  return <div className="analysis-grid">
    <section className="panel analysis" aria-labelledby="report-title">
      <div className="panel-heading"><div><h2 id="report-title" tabIndex={-1}>研判报告</h2><p>{run.mode === "live" ? "实时模型" : "合成案例回放"} · {stamp.format(new Date(run.createdAt))}</p></div><StatusPill status={run.status} /></div>
      {run.error && <p className="error-box" role="alert">{run.error}</p>}
      {run.status === "running" && <p className="report-wait"><span className="spinner" /> 正在调查渠道证据并交叉审阅。</p>}
      {report && <>
        <h3 className="report-headline">{report.headline}</h3>
        <p className="report-summary">{report.summary}</p>
        <div className="next-action"><h4>建议处置</h4><p>{report.action}</p>
          <dl><div><dt>负责人</dt><dd>{report.owner}</dd></div><div><dt>验证指标</dt><dd>{report.measure}</dd></div></dl>
        </div>
        <h4 className="subhead">报告引用</h4>
        <EvidenceTable evidence={report.evidenceIds.flatMap((id) => run.evidence.filter((fact) => fact.id === id))} inspect={inspect} />
        {lead && (lead.metric === "sales" || lead.metric === "refunds" || lead.metric === "cogs") &&
          <button className="text-button report-product" onClick={() => inspectProducts(lead.channel)}>查看{lead.channel}的商品利润 →</button>}
        <details><summary>查看各 Agent 的发现</summary>
          <ul className="findings">{report.findings.map((finding) => <li key={finding.role}><strong>{roleNames[finding.role]}</strong>
            <p>{finding.summary}</p><div className="finding-sources">{run.evidence.filter((fact) => finding.evidenceIds.includes(fact.id))
              .map((fact) => <button key={fact.id} className="text-button" onClick={() => inspect(fact)}>{fact.channel} · {fact.label}</button>)}</div></li>)}</ul>
        </details>
        <details><summary>查看完整证据账本（{run.evidence.length} 条）</summary><EvidenceTable evidence={run.evidence} inspect={inspect} /></details>
        <div className="approval">
          <div><h4><Icon name="shield" /> 人工审批</h4><p>{run.decision
            ? `${statusNames[run.decision.value]} · ${stamp.format(new Date(run.decision.at))} · 已记入审计轨迹`
            : "批准后进入处置跟踪，由负责人执行并填写复盘。"}</p></div>
          {run.status === "review_required" && <div className="approval-buttons">
            <button className="button secondary" disabled={busy} onClick={() => decide("rejected")}>驳回</button>
            <button className="button primary" disabled={busy} onClick={() => decide("approved")}><Icon name="check" size={16} />批准建议</button>
          </div>}
          {run.status === "approved" && <button className="button secondary" onClick={openTask}>查看处置任务 <Icon name="arrow" size={15} /></button>}
        </div>
      </>}
    </section>
    <section className="panel trace" aria-labelledby="trace-title">
      <div className="panel-heading"><div><h2 id="trace-title">运行轨迹</h2><p>{run.events.length} 条审计事件</p></div><Icon name="history" /></div>
      <ol className="timeline" tabIndex={0} aria-label="按时间排列的审计事件">
        {run.events.map((event) => <li key={event.sequence} className={`phase-${event.phase}`}>
          <div><strong>{stepNames[event.step]}</strong><time dateTime={event.at}>{time.format(new Date(event.at))}</time></div>
          <p>{event.message}</p>
        </li>)}
      </ol>
    </section>
  </div>;
}

const viewTitles = { dashboard: "异动研判", business: "业务流水", products: "商品分析", tasks: "处置跟踪", history: "研判记录" } as const;
type View = keyof typeof viewTitles;

function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [caseId, setCaseId] = useState<CaseId>("promotion");
  const [run, setRun] = useState<Run | null>(null);
  const [view, setView] = useState<View>("dashboard");
  const [ledgerFocus, setLedgerFocus] = useState<(LedgerFocus & { from?: "report" | "products" }) | undefined>();
  const [productFocus, setProductFocus] = useState({ channel: "", fromReport: false });
  const [taskId, setTaskId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const scenario = boot?.cases.find((item) => item.id === caseId);

  async function bootstrap() {
    try { setBoot(await request<Bootstrap>("/api/bootstrap")); }
    catch { setError("无法连接研判服务，请重试。"); }
  }

  useEffect(() => { void bootstrap(); }, []);

  const activeRunId = run?.status === "running" ? run.id : null;
  useEffect(() => {
    if (!activeRunId) return;
    const stream = new EventSource(`/api/runs/${activeRunId}/stream`);
    stream.onmessage = (event: MessageEvent<string>) => {
      const update: Run = JSON.parse(event.data);
      setRun((current) => current?.id === update.id ? update : current);
      if (update.status !== "running") {
        stream.close();
        void bootstrap();
      }
    };
    return () => stream.close();
  }, [activeRunId]);

  function navigate(next: typeof view) {
    setView(next);
    setError("");
    if (next === "history") void bootstrap();
    requestAnimationFrame(() => heading.current?.focus());
  }

  function openLedger(focus?: LedgerFocus & { from?: "report" | "products" }) {
    setLedgerFocus(focus);
    navigate("business");
  }

  function openProducts(channel = "", fromReport = false) {
    setProductFocus({ channel, fromReport });
    navigate("products");
  }

  function openTask(id?: string) {
    setTaskId(id);
    navigate("tasks");
  }

  function selectCase(next: CaseId) {
    setCaseId(next);
    setRun(null);
    setLedgerFocus(undefined);
    setProductFocus({ channel: "", fromReport: false });
    setError("");
  }

  function focusReport() {
    requestAnimationFrame(() => document.getElementById("report-title")?.focus());
  }

  function returnToReport() {
    navigate("dashboard");
    focusReport();
  }

  async function start() {
    setBusy(true);
    setError("");
    try {
      setRun(await post<Run>("/api/runs", { caseId }));
      focusReport();
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : "发起研判失败。"); }
    finally { setBusy(false); }
  }

  async function openRun(id: string) {
    setBusy(true);
    try {
      const item = await request<Run>(`/api/runs/${id}`);
      setCaseId(item.caseId);
      setRun(item);
      returnToReport();
    } catch { setError("无法打开该研判记录。"); }
    finally { setBusy(false); }
  }

  async function decide(decision: Decision) {
    if (!run) return;
    setBusy(true);
    setError("");
    try { setRun(await post<Run>(`/api/runs/${run.id}/decision`, { decision })); }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : "提交审批失败。");
      await request<Run>(`/api/runs/${run.id}`).then(setRun).catch(() => {});
    } finally { setBusy(false); }
  }

  return <div className="shell">
    <a className="skip" href="#main">跳到内容</a>
    <aside className="sidebar">
      <div className="brand"><Mark /><div><strong>MarginOps</strong><span>电商经营分析</span></div></div>
      <nav aria-label="主导航">
        <button onClick={() => navigate("dashboard")} aria-current={view === "dashboard" ? "page" : undefined}><Icon name="grid" />异动研判</button>
        <button onClick={() => openLedger()} aria-current={view === "business" ? "page" : undefined}><Icon name="ledger" />业务流水</button>
        <button onClick={() => openProducts()} aria-current={view === "products" ? "page" : undefined}><Icon name="product" />商品分析</button>
        <button onClick={() => openTask()} aria-current={view === "tasks" ? "page" : undefined}><Icon name="tasks" />处置跟踪</button>
        <button onClick={() => navigate("history")} aria-current={view === "history" ? "page" : undefined}><Icon name="history" />研判记录</button>
      </nav>
      <div className="sidebar-foot"><span aria-hidden="true" />{boot?.mode === "live" ? "实时模型模式" : "合成案例回放"}</div>
    </aside>
    <main id="main" tabIndex={-1}>
      <header className="topbar">
        <h1 ref={heading} tabIndex={-1}>{viewTitles[view]}</h1>
        {view === "dashboard" && scenario && <div className="date"><Icon name="calendar" size={16} />{scenario.range}</div>}
        {(view === "business" || view === "products") && scenario && <div className="case-select">
          <select aria-label="所属案例" value={caseId} disabled={busy}
            onChange={(event) => selectCase(event.target.value as CaseId)}>
            {boot?.cases.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </div>}
      </header>
      <div className="content">
        {error && <div className="error-box" role="alert">{error} {!boot && <button className="button secondary" onClick={() => void bootstrap()}>重试</button>}</div>}
        {!boot && !error && <p role="status">正在加载经营数据…</p>}
        {view === "dashboard" && scenario && <>
          <section className="hero" aria-labelledby="case-title">
            <div className="hero-body">
              <div className="case-select">
                <label htmlFor="case">研判案例</label>
                <select id="case" value={caseId} disabled={busy} onChange={(event) => selectCase(event.target.value as CaseId)}>
                  {boot?.cases.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </div>
              <h2 id="case-title">{scenario.headline}</h2>
              <p>{scenario.description}</p>
            </div>
            <button className="button primary launch" disabled={busy || run?.status === "running"}
              onClick={() => void start()}><Icon name="play" size={18} />{run?.status === "running" ? "研判运行中" : run ? "重新研判" : "发起多 Agent 研判"}</button>
          </section>
          <MetricCards scenario={scenario} />
          <BusinessFlow scenario={scenario} open={openLedger} />
          {run && <p className="sr-only" role="status">{statusNames[run.status]}</p>}
          {run && <Investigation run={run} busy={busy} decide={(decision) => void decide(decision)}
            inspect={({ channel, metric }) => openLedger({ channel, metric, from: "report" })}
            inspectProducts={(channel) => openProducts(channel, true)} openTask={() => openTask(run.id)} />}
          <div className="chart-grid"><Trend scenario={scenario} /><Bridge scenario={scenario} /></div>
          <footer>数据周期 {scenario.range} <span>·</span> 对比周期 {scenario.previousRange} <span>·</span> 合成账本</footer>
        </>}
        {view === "business" && scenario && <>
          <BusinessPage key={`${caseId}:${ledgerFocus?.channel ?? ""}:${ledgerFocus?.metric ?? ""}:${ledgerFocus?.sku ?? ""}`}
            scenario={scenario} focus={ledgerFocus} back={ledgerFocus?.from === "products"
              ? { label: "返回商品分析", open: () => navigate("products") }
              : ledgerFocus?.from === "report" && run ? { label: "返回研判报告", open: returnToReport } : undefined} />
          <footer>数据周期 {scenario.range} <span>·</span> 对比周期 {scenario.previousRange} <span>·</span> 合成业务流水</footer>
        </>}
        {view === "products" && scenario && <>
          {productFocus.fromReport && run && <button className="text-button report-back" onClick={returnToReport}>← 返回研判报告</button>}
          <ProductsPage key={caseId} caseId={caseId} channel={productFocus.channel}
            selectChannel={(channel) => setProductFocus((current) => ({ ...current, channel }))}
            inspect={(focus) => openLedger({ ...focus, from: "products" })} />
          <footer>数据周期 {scenario.range} <span>·</span> 对比周期 {scenario.previousRange} <span>·</span> 合成业务流水</footer>
        </>}
        {view === "tasks" && boot && <TasksPage key={taskId ?? "all"} cases={boot.cases} focusId={taskId}
          openReport={(id) => void openRun(id)} />}
        {view === "history" && boot && <section className="panel history" aria-labelledby="history-title">
          <div className="panel-heading"><div><h2 id="history-title">近期研判</h2><p>查看报告、决策和审计事件</p></div><Icon name="history" /></div>
          {boot.runs.length === 0 ? <p className="empty">还没有研判记录。</p> :
            <ul className="history-list">{boot.runs.map((item) => <li key={item.id}>
              <button disabled={busy} onClick={() => void openRun(item.id)}>
                <span><strong>{boot.cases.find((entry) => entry.id === item.caseId)?.name}</strong>
                  <small>{stamp.format(new Date(item.createdAt))} · {item.mode === "live" ? "实时模型" : "案例回放"}</small></span>
                <StatusPill status={item.status} /><Icon name="arrow" />
              </button>
            </li>)}</ul>}
        </section>}
      </div>
    </main>
  </div>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
