import { useEffect, useRef, useState } from "react";
import { contribution, drivers, transactionNames } from "../shared/contracts.ts";
import type { BusinessLedger, CaseView, Driver, LedgerAmounts, Period } from "../shared/contracts.ts";
import { request } from "./api.ts";
import { money, signedMoney } from "./format.ts";

export interface LedgerFocus {
  channel?: string;
  metric?: Driver;
  sku?: string;
}

const operatingCosts = ({ cogs, ads, fees }: LedgerAmounts) => cogs + ads + fees;
const costs = [{ metric: "cogs", label: "商品成本" }, { metric: "ads", label: "投放成本" }, { metric: "fees", label: "平台费用" }] as const;
const steps = [
  { label: "成交收款", amount: (ledger: LedgerAmounts) => ledger.sales, tone: "sales", metric: "sales" },
  { label: "退款冲减", amount: (ledger: LedgerAmounts) => -ledger.refunds, tone: "cost", metric: "refunds" },
  { label: "净成交额", amount: (ledger: LedgerAmounts) => ledger.sales - ledger.refunds, tone: "subtotal" },
  { label: "经营成本", amount: (ledger: LedgerAmounts) => -operatingCosts(ledger), tone: "cost" },
  { label: "贡献利润", amount: contribution, tone: "total" },
] as const;

export function BusinessFlow({ scenario, open }: { scenario: CaseView; open: (focus?: LedgerFocus) => void }) {
  const { current, previous } = scenario.amounts;
  return <section className="panel business-flow" aria-labelledby="business-flow-title">
    <div className="panel-heading">
      <div><h2 id="business-flow-title">经营全链路</h2><p>本期成交如何转化为贡献利润</p></div>
      <button className="button secondary" onClick={() => open()}>查看业务流水 <span aria-hidden="true">→</span></button>
    </div>
    <ol className="flow-steps">
      {steps.map((step) => <li key={step.label} className={`flow-step flow-${step.tone}`}>
        {"metric" in step
          ? <button className="text-button flow-label" onClick={() => open({ metric: step.metric })}>{step.label}</button>
          : <span className="flow-label">{step.label}</span>}
        <strong>{money(step.amount(current))}</strong>
        <span className="flow-previous">上期 {money(step.amount(previous))}</span>
      </li>)}
    </ol>
    <div className="flow-breakdown">
      {costs.map(({ metric, label }) => <button className="text-button" key={metric} onClick={() => open({ metric })}>
        {label} <strong>{money(current[metric])}</strong>
      </button>)}
    </div>
  </section>;
}

interface Filter {
  period: Period | "all";
  channel: string;
  metric: Driver | "";
  query: string;
}

function initialFilter(focus?: LedgerFocus): Filter {
  return { period: focus ? "all" : "current", channel: focus?.channel ?? "", metric: focus?.metric ?? "", query: focus?.sku ?? "" };
}

const pageSize = 12;
const periodLabels: Record<Period, string> = { current: "本期", previous: "上期" };

function ChannelTable({ channels, select }: { channels: BusinessLedger["channels"]; select: (focus: LedgerFocus) => void }) {
  return <section className="panel channel-ledger" aria-labelledby="channel-ledger-title">
    <div className="panel-heading"><div><h2 id="channel-ledger-title">渠道经营对比</h2><p>按渠道核对成交、退款和利润变化</p></div></div>
    <div className="table-scroll" tabIndex={0} aria-label="渠道经营对比">
      <table>
        <thead><tr>{["渠道", "本期成交", "本期退款", "本期经营成本", "上期贡献利润", "本期贡献利润", "利润变化"].map((label) =>
          <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{channels.map(({ name, amounts: { current, previous } }) => {
          const change = contribution(current) - contribution(previous);
          return <tr key={name}>
            <th scope="row"><button className="text-button" onClick={() => select({ channel: name })}>{name}</button></th>
            <td>{money(current.sales)}</td><td>{money(current.refunds)}</td><td>{money(operatingCosts(current))}</td>
            <td>{money(contribution(previous))}</td><td>{money(contribution(current))}</td>
            <td className={change < 0 ? "negative" : "positive"}>{signedMoney(change)}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  </section>;
}

export function BusinessPage({ scenario, focus, back }: {
  scenario: CaseView; focus?: LedgerFocus; back?: { label: string; open: () => void };
}) {
  const [filter, setFilter] = useState(() => initialFilter(focus));
  const [page, setPage] = useState(1);
  const [data, setData] = useState<BusinessLedger | null>(null);
  const [error, setError] = useState(false);
  const ledgerHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void request<BusinessLedger>(`/api/cases/${scenario.id}/ledger`, { signal: controller.signal })
      .then(setData).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [scenario.id]);

  function change(update: Partial<Filter>) {
    setFilter((current) => ({ ...current, ...update }));
    setPage(1);
  }

  function inspect(selection?: LedgerFocus) {
    setFilter(initialFilter(selection));
    setPage(1);
    ledgerHeading.current?.focus();
  }

  const query = filter.query.trim().toLowerCase();
  const matches = (data?.transactions ?? []).filter((row) =>
    (filter.period === "all" || row.period === filter.period) &&
    (!filter.channel || row.channel === filter.channel) &&
    (!filter.metric || row.metric === filter.metric) &&
    (!query || [row.document, row.orderId, row.description, row.product?.name, row.product?.sku]
      .some((part) => part?.toLowerCase().includes(query))));
  const orderId = matches[0]?.orderId;
  const showOrder = orderId?.toLowerCase() === query && matches.every((row) => row.orderId === orderId);
  const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
  const ordered = showOrder ? matches.toReversed() : matches;
  const rows = ordered.slice((page - 1) * pageSize, page * pageSize);
  const total = (period: Period) => matches.reduce((sum, row) => {
    if (row.period !== period) return sum;
    return sum + (filter.metric || row.metric === "sales" ? row.amount : -row.amount);
  }, 0);

  return <>
    {back && <button className="text-button report-back" onClick={back.open}>← {back.label}</button>}
    {!focus && <BusinessFlow scenario={scenario} open={inspect} />}
    {!focus && data && <ChannelTable channels={data.channels} select={inspect} />}
    <section className="panel transaction-ledger" aria-labelledby="ledger-title">
      <div className="panel-heading">
        <div><h2 id="ledger-title" tabIndex={-1} ref={ledgerHeading}>{showOrder ? `订单链路 · ${orderId}` : "交易明细"}</h2>
          <p>点击订单号可联查收款、出库和售后；广告与平台扣费按渠道日结。</p></div>
      </div>
      {error && <p className="error-box" role="alert">业务流水加载失败，请刷新页面重试。</p>}
      {!data && !error && <p className="empty" role="status">正在读取业务流水…</p>}
      {data && <>
        <div className="ledger-filters">
          <div className="ledger-field"><label htmlFor="ledger-period">期间</label>
            <select id="ledger-period" value={filter.period} onChange={(event) => change({ period: event.target.value as Filter["period"] })}>
            <option value="all">本期与上期</option><option value="current">本期</option><option value="previous">上期</option>
          </select></div>
          <div className="ledger-field"><label htmlFor="ledger-channel">渠道</label>
            <select id="ledger-channel" value={filter.channel} onChange={(event) => change({ channel: event.target.value })}>
            <option value="">所有渠道</option>{data.channels.map(({ name }) => <option key={name}>{name}</option>)}
          </select></div>
          <div className="ledger-field"><label htmlFor="ledger-metric">流水类型</label>
            <select id="ledger-metric" value={filter.metric} onChange={(event) => change({ metric: event.target.value as Filter["metric"] })}>
            <option value="">所有类型</option>{drivers.map((metric) => <option value={metric} key={metric}>{transactionNames[metric]}</option>)}
          </select></div>
          <div className="ledger-field ledger-search"><label htmlFor="ledger-query">搜索订单或业务单据</label>
            <input id="ledger-query" type="search" value={filter.query} placeholder="订单号、单据号、商品" onChange={(event) => change({ query: event.target.value })} />
          </div>
          <button className="button secondary" onClick={() => { setFilter(initialFilter()); setPage(1); }}>重置筛选</button>
        </div>
        <div className="ledger-summary" aria-live="polite">
          <strong>{matches.length} 笔匹配流水</strong>
          {(["current", "previous"] as const).filter((period) => filter.period === "all" || filter.period === period)
            .map((period) => <span key={period}>{periodLabels[period]}{filter.metric ? "金额" : "净贡献"} <strong>{money(total(period))}</strong></span>)}
        </div>
        {rows.length === 0 ? <p className="empty">没有符合筛选条件的流水。</p> : <>
          <div className="table-scroll" tabIndex={0} aria-label="可横向滚动的业务流水">
            <table className="transaction-table">
              <thead><tr>{["发生时间", "渠道", "业务动作", "单据号 / 关联订单", "商品或摘要", "金额"].map((label) =>
                <th scope="col" key={label}>{label}</th>)}</tr></thead>
              <tbody>{rows.map((row) => <tr key={row.id}>
                <td><time dateTime={row.occurredAt}>{row.occurredAt.slice(5, 16).replace("T", " ")}</time>
                  <span className="row-period">{periodLabels[row.period]}</span></td>
                <td>{row.channel}</td><td>{transactionNames[row.metric]}</td>
                <td><code>{row.document}</code>{row.orderId && <button className="text-button order-link" onClick={() => {
                  change({ period: "all", channel: "", metric: "", query: row.orderId ?? "" });
                  ledgerHeading.current?.focus();
                }} aria-label={`查看订单 ${row.orderId} 的全部流水`}>{row.orderId}</button>}</td>
                <td>{row.description}{row.product && <span className="row-period">{row.metric === "refunds" && `${row.product.name} · `}{row.product.sku}</span>}</td>
                <td className={row.metric === "sales" ? "positive" : "negative"}>{signedMoney(row.metric === "sales" ? row.amount : -row.amount)}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <div className="ledger-pages">
            <span>第 {page} / {pageCount} 页</span>
            <div><button className="button secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</button>
              <button className="button secondary" disabled={page === pageCount} onClick={() => setPage(page + 1)}>下一页</button></div>
          </div>
        </>}
      </>}
    </section>
  </>;
}
