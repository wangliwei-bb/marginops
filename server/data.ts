import { drivers } from "../shared/contracts.ts";
import type { CaseId, CaseView, Driver, Evidence, Role } from "../shared/contracts.ts";

type Ledger = Record<Driver, number>;
type Channel = [name: string, previous: number[], current: number[]];
interface Scenario {
  name: string;
  headline: string;
  description: string;
  channels: Channel[];
  shape: number[];
}

// Synthetic, fixed snapshots. Tuple order follows the accounting bridge in contracts.ts.
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

function totals(channels: Channel[], period: 1 | 2): Ledger {
  return Object.fromEntries(drivers.map((metric, index) => [
    metric, channels.reduce((sum, channel) => sum + channel[period][index], 0),
  ])) as Ledger;
}

function metrics(ledger: Ledger) {
  const { sales, refunds, cogs, ads, fees } = ledger;
  const contribution = sales - refunds - cogs - ads - fees;
  return { sales, contribution, margin: contribution / sales, refundRate: refunds / sales };
}

function impact(metric: Driver, previous: number, current: number) {
  return (current - previous) * (metric === "sales" ? 1 : -1);
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

export function caseView(id: CaseId): CaseView {
  const { name, headline, description, channels, shape } = scenarios[id];
  const previous = totals(channels, 1);
  const current = totals(channels, 2);
  const baseline = metrics(previous);
  const actual = metrics(current);
  const previousDays = distribute(baseline.contribution, [142, 137, 151, 145, 150, 156, 119]);
  const currentDays = distribute(actual.contribution, shape);
  return {
    id, name, headline, description, metrics: actual, baseline,
    range: "2026.11.02 – 11.08",
    previousRange: "2026.10.26 – 11.01",
    daily: currentDays.map((value, index) => ({
      day: `11/${String(index + 2).padStart(2, "0")}`, current: value, previous: previousDays[index],
    })),
    bridge: drivers.map((metric) => ({
      metric, label: labels[metric], impact: impact(metric, previous[metric], current[metric]),
    })),
  };
}

export function evidenceFor(id: CaseId): Evidence[] {
  return scenarios[id].channels.flatMap(([channel, previous, current], channelIndex) =>
    drivers.map((metric, index) => ({
      id: `${metric}-${channelIndex + 1}`,
      label: labels[metric],
      channel,
      metric,
      previous: previous[index],
      current: current[index],
      impact: impact(metric, previous[index], current[index]),
    })),
  );
}
