import type { CaseId, Driver, Period, Product, Transaction } from "../shared/contracts.ts";

type ChannelAmounts = [sales: number, refunds: number, cogs: number, ads: number, fees: number];
export type ChannelSeed = [name: string, previous: ChannelAmounts, current: ChannelAmounts];

const products: Product[] = [
  { sku: "AC-310", name: "变频空调套装" },
  { sku: "WD-620", name: "洗烘组合" },
  { sku: "RF-480", name: "冰箱冷柜套装" },
  { sku: "KT-270", name: "厨电三件套" },
];

const priorWeights = [142, 137, 151, 145, 150, 156, 119];
const starts: Record<Period, string> = { previous: "2026-10-26", current: "2026-11-02" };
const caseCodes: Record<CaseId, string> = { promotion: "PR", acquisition: "AD", returns: "RT" };
const refundReasons = ["价保补差", "商品售后", "物流延误", "配件补偿"];

export function periodDates(period: Period) {
  const start = Date.parse(starts[period]);
  return Array.from({ length: 7 }, (_, day) => new Date(start + day * 86_400_000).toISOString().slice(0, 10));
}

function distribute(total: number, weights: number[]) {
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  let cumulative = 0;
  let distributed = 0;
  return weights.map((weight) => {
    cumulative += weight;
    const nextTotal = Math.round(total * cumulative / weightSum);
    const part = nextTotal - distributed;
    distributed = nextTotal;
    return part;
  });
}

export function generateTransactions(caseId: CaseId, channels: ChannelSeed[], currentWeights: number[]): Transaction[] {
  return channels.flatMap(([channel, previous, current], channelIndex) =>
    (["previous", "current"] as const).flatMap((period) => {
      const amounts = period === "current" ? current : previous;
      const weights = period === "current" ? currentWeights : priorWeights;
      const [salesByDay, refundsByDay, cogsByDay, adsByDay, feesByDay] = amounts.map((value) => distribute(value, weights));
      return periodDates(period).flatMap((day, index) => {
        const batch = `${caseCodes[caseId]}-${day.replaceAll("-", "").slice(2)}-${channelIndex + 1}`;
        const count = 3 + (index + channelIndex) % 3 + Number(caseId === "promotion" && period === "current" && channelIndex === 0);
        const orderWeights = Array.from({ length: count }, (_, i) => (count - i) * 3 + 10);
        const sales = distribute(salesByDay[index], orderWeights);
        const cogs = distribute(cogsByDay[index], orderWeights);
        function transaction(metric: Driver, document: string, at: string, amount: number, description: string,
          orderId: string | null = null, product: Product | null = null): Transaction {
          return {
            id: `${metric}-${document}`, occurredAt: `${day}T${at}:00+08:00`,
            period, channel, metric, document, orderId, amount, description, product,
          };
        }
        const orders = sales.flatMap((amount, i) => {
          const orderId = `SO-${batch}-${i + 1}`;
          const item = products[(index + channelIndex + i) % products.length];
          const paidAt = `${String(9 + i).padStart(2, "0")}:${String(7 + i * 6).padStart(2, "0")}`;
          return [
            transaction("sales", `PAY-${batch}-${i + 1}`, paidAt, amount, item.name, orderId, item),
            transaction("cogs", `OUT-${batch}-${i + 1}`, `${14 + i}:20`, cogs[i], item.name, orderId, item),
          ];
        });
        return [
          ...orders,
          transaction("refunds", `RF-${batch}`, "20:35", refundsByDay[index],
            refundReasons[(index + channelIndex) % refundReasons.length], orders[0].orderId, orders[0].product),
          transaction("ads", `ADV-${batch}`, "22:10", adsByDay[index], `${channel}广告组 · 当日消耗`),
          transaction("fees", `SET-${batch}`, "23:05", feesByDay[index], "平台服务费 · 日结批次"),
        ];
      });
    })).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
}
