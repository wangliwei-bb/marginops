import { caseIds, contribution, drivers } from "../shared/contracts.ts";
import type { BusinessLedger, CaseId, CaseView, Driver, Evidence, LedgerAmounts, Period, Role, Transaction } from "../shared/contracts.ts";
import { generateTransactions, periodDates } from "./transactions.ts";
import type { ChannelSeed } from "./transactions.ts";

interface Scenario {
  name: string;
  headline: string;
  description: string;
  channels: ChannelSeed[];
  shape: number[];
}

// Seed budgets generate source transactions. Dashboards and evidence aggregate those transactions.
const scenarios: Record<CaseId, Scenario> = {
  promotion: {
    name: "大促利润下滑",
    headline: "GMV 上涨，贡献利润为何下滑？",
    description: "大促周成交额走高，利润却逆势下降。排查直播间货品成本、流量投入和退款变化，定位最值得优先处理的渠道。",
    channels: [
      ["直播间", [180000, 8400, 84000, 22000, 7600], [250000, 13800, 173000, 32000, 10600]],
      ["搜索", [158000, 8400, 70000, 18000, 6900], [168000, 9100, 76000, 21200, 7200]],
      ["会员复购", [115000, 5600, 49000, 9200, 4400], [120000, 5800, 53000, 10100, 4700]],
    ],
    shape: [125, 130, 146, 157, 144, 138, 160],
  },
  acquisition: {
    name: "投放成本攀升",
    headline: "成交增长能覆盖新增投放吗？",
    description: "本周付费渠道扩大预算，成交额增长有限。检查新增支出是否侵蚀了整店贡献利润。",
    channels: [
      ["信息流", [130000, 6600, 57000, 23000, 5100], [151000, 7600, 65000, 62000, 6000]],
      ["搜索", [92000, 4300, 40000, 10000, 3500], [96000, 4500, 42000, 10900, 3700]],
      ["会员复购", [80000, 3700, 33000, 5000, 3000], [81000, 3800, 33500, 5100, 3100]],
    ],
    shape: [174, 157, 151, 139, 134, 125, 120],
  },
  returns: {
    name: "退款率异常",
    headline: "店铺退款额集中在哪个渠道？",
    description: "订单规模基本稳定，但退款金额明显上升。先定位利润损失集中在哪个渠道，再决定核查范围。",
    channels: [
      ["平台旗舰店", [160000, 7500, 71000, 15000, 5500], [164000, 29000, 72000, 15100, 5700]],
      ["搜索", [110000, 5500, 48000, 10000, 4100], [113000, 6500, 49000, 10200, 4200]],
      ["会员复购", [62000, 2900, 27000, 4500, 2500], [63000, 3500, 27500, 4600, 2600]],
    ],
    shape: [173, 165, 151, 135, 130, 127, 119],
  },
};

const labels: Record<Driver, string> = {
  sales: "成交额", refunds: "退款额", cogs: "商品成本", ads: "投放成本", fees: "平台费用",
};

export const scopes: Record<Role, Driver[]> = {
  growth: ["sales", "ads"],
  margin: ["sales", "cogs", "fees"],
  quality: ["sales", "refunds"],
};

const transactions = new Map(caseIds.map((id) => [id, generateTransactions(id, scenarios[id].channels, scenarios[id].shape)]));

function totals(rows: Transaction[]): LedgerAmounts {
  const amounts: LedgerAmounts = { sales: 0, refunds: 0, cogs: 0, ads: 0, fees: 0 };
  for (const row of rows) amounts[row.metric] += row.amount;
  return amounts;
}

function byPeriod(rows: Transaction[]): Record<Period, LedgerAmounts> {
  return {
    previous: totals(rows.filter((row) => row.period === "previous")),
    current: totals(rows.filter((row) => row.period === "current")),
  };
}

function metrics(ledger: LedgerAmounts) {
  const { sales, refunds } = ledger;
  const profit = contribution(ledger);
  return { sales, contribution: profit, margin: profit / sales, refundRate: refunds / sales };
}

function impact(metric: Driver, previous: number, current: number) {
  return (current - previous) * (metric === "sales" ? 1 : -1);
}

export function businessLedger(id: CaseId): BusinessLedger {
  const rows = transactions.get(id)!;
  return {
    transactions: rows,
    channels: scenarios[id].channels.map(([name]) => ({
      name, amounts: byPeriod(rows.filter((row) => row.channel === name)),
    })),
  };
}

export function caseView(id: CaseId): CaseView {
  const { name, headline, description } = scenarios[id];
  const rows = transactions.get(id)!;
  const amounts = byPeriod(rows);
  const { previous, current } = amounts;
  const baseline = metrics(previous);
  const actual = metrics(current);
  const dayProfit = (day: string) => contribution(totals(rows.filter((row) => row.occurredAt.startsWith(day))));
  const previousDays = periodDates("previous");
  return {
    id, name, headline, description, metrics: actual, baseline, amounts,
    range: "2026.11.02 – 11.08",
    previousRange: "2026.10.26 – 11.01",
    daily: periodDates("current").map((day, index) => ({
      day: day.slice(5).replace("-", "/"), current: dayProfit(day), previous: dayProfit(previousDays[index]),
    })),
    bridge: drivers.map((metric) => ({
      metric, label: labels[metric], impact: impact(metric, previous[metric], current[metric]),
    })),
  };
}

export function evidenceFor(id: CaseId): Evidence[] {
  return businessLedger(id).channels.flatMap(({ name: channel, amounts: { previous, current } }, channelIndex) =>
    drivers.map((metric) => ({
      id: `${metric}-${channelIndex + 1}`,
      label: labels[metric],
      channel,
      metric,
      previous: previous[metric],
      current: current[metric],
      impact: impact(metric, previous[metric], current[metric]),
    })),
  );
}
