import { useEffect, useState } from "react";
import { productProfit } from "../shared/contracts.ts";
import type { CaseId, ProductPerformance } from "../shared/contracts.ts";
import { request } from "./api.ts";
import type { LedgerFocus } from "./business.tsx";
import { money, signedMoney } from "./format.ts";

type ProductData = { channels: string[]; products: ProductPerformance[] };
type Sort = "profit" | "sales" | "refunds";
const sortValues: Record<Sort, (row: ProductPerformance) => number> = {
  profit: ({ amounts }) => productProfit(amounts.current) - productProfit(amounts.previous),
  sales: ({ amounts }) => -amounts.current.sales,
  refunds: ({ amounts }) => -amounts.current.refunds,
};

export function ProductsPage({ caseId, channel, selectChannel, inspect }: {
  caseId: CaseId; channel: string; selectChannel: (channel: string) => void; inspect: (focus: LedgerFocus) => void;
}) {
  const [result, setResult] = useState<{ channel: string; data: ProductData | null } | null>(null);
  const [channels, setChannels] = useState<string[]>([]);
  const [sort, setSort] = useState<Sort>("profit");
  const settled = result?.channel === channel;
  const data = settled ? result.data : null;
  useEffect(() => {
    const controller = new AbortController();
    const params = channel ? `?channel=${encodeURIComponent(channel)}` : "";
    void request<ProductData>(`/api/cases/${caseId}/products${params}`, { signal: controller.signal })
      .then((data) => { setChannels(data.channels); setResult({ channel, data }); })
      .catch(() => { if (!controller.signal.aborted) setResult({ channel, data: null }); });
    return () => controller.abort();
  }, [caseId, channel]);
  const rows = (data?.products ?? []).toSorted((a, b) => sortValues[sort](a) - sortValues[sort](b));

  return <section className="panel" aria-labelledby="product-title">
    <div className="panel-heading">
      <div><h2 id="product-title">SKU 利润对比</h2><p>商品利润 = 成交额 − 退款额 − 出库成本。渠道日结的广告费和平台费单独核算。</p></div>
    </div>
    <div className="ledger-filters">
      <div className="ledger-field"><label htmlFor="product-channel">渠道</label>
        <select id="product-channel" value={channel} disabled={channels.length === 0} onChange={(event) => selectChannel(event.target.value)}>
          <option value="">所有渠道</option>{channels.map((name) => <option key={name}>{name}</option>)}
        </select></div>
      <div className="ledger-field"><label htmlFor="product-sort">排序</label>
        <select id="product-sort" value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
          <option value="profit">利润降幅优先（按金额）</option><option value="sales">本期成交额最高</option><option value="refunds">本期退款额最高</option>
        </select></div>
    </div>
    {settled && !data && <p className="error-box" role="alert">商品分析加载失败。请刷新页面，或选择另一个渠道。</p>}
    {!settled && <p className="empty" role="status">正在计算商品利润…</p>}
    {data && <div className="table-scroll" tabIndex={0} aria-label="商品利润对比明细">
      <table className="product-table">
        <thead><tr>{["商品 / SKU", "本期成交", "本期退款", "本期出库成本", "上期商品利润", "本期商品利润", "利润变化", "来源"].map((label) =>
          <th key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody>{rows.map(({ sku, name, amounts: { current, previous } }) => {
          const lastProfit = productProfit(previous);
          const currentProfit = productProfit(current);
          return <tr key={sku}>
            <th scope="row">{name}<code className="row-period">{sku}</code></th>
            <td>{money(current.sales)}</td><td>{money(current.refunds)}</td><td>{money(current.cogs)}</td>
            <td>{money(lastProfit)}</td><td>{money(currentProfit)}</td>
            <td className={currentProfit < lastProfit ? "negative" : "positive"}>{signedMoney(currentProfit - lastProfit)}</td>
            <td><button className="text-button" aria-label={`查看 ${sku} 的流水`} onClick={() => inspect({ channel, sku })}>查看流水</button></td>
          </tr>;
        })}</tbody>
      </table>
    </div>}
  </section>;
}
