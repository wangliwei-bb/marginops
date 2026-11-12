import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { roles } from "../shared/contracts.ts";
import type { CaseId, CaseView, Driver, Evidence, Finding, Proposal, Recommendation, Review, Role, RunEvent } from "../shared/contracts.ts";
import { caseView, evidenceFor, scopes } from "./data.ts";
import { findingSchema, proposalSchema, reviewSchema, worstImpact } from "./models.ts";
import type { AgentModels } from "./models.ts";

export type EventInput = Pick<RunEvent, "step" | "phase" | "message">;
type ReportFinding = Finding & { role: Role };

const state = Annotation.Root({
  scenario: Annotation<CaseView>(),
  evidence: Annotation<Evidence[]>(),
  findings: Annotation<ReportFinding[]>({
    reducer: (prior, next) => [...prior, ...next],
    default: () => [],
  }),
  proposal: Annotation<Proposal>(),
  reviewResult: Annotation<Review>(),
  attempts: Annotation<number>(),
});

const playbook: Record<Driver, { action: string; owner: string; measure: string }> = {
  sales: { action: "按商品和入口拆分成交下滑，复核库存与流量变化。", owner: "商品运营", measure: "次周成交额与贡献利润" },
  refunds: { action: "抽样核查退款订单，按商品、履约批次和退款原因聚类。", owner: "售后运营", measure: "该渠道退款额占成交额比重" },
  cogs: { action: "复核该渠道的高销量商品成本与商品组合，拟定下一场直播的选品调整。", owner: "直播运营 · 财务", measure: "该渠道商品成本率与单场贡献利润" },
  ads: { action: "按广告组核查边际产出，拟定低效组的预算收缩方案。", owner: "投放运营", measure: "该渠道投放成本率与贡献利润" },
  fees: { action: "比对平台账单与活动费率规则，核实费用归类和异常结算。", owner: "财务运营", measure: "该渠道平台费用率" },
};

const maxDrafts = 3;

function checkReferences(ids: string[], allowed: Evidence[], max: number) {
  return ids.length > 0 && ids.length <= max && new Set(ids).size === ids.length &&
    ids.every((id) => allowed.some((fact) => fact.id === id));
}

function checkProposal(proposal: Proposal, evidence: Evidence[]): string | null {
  if (!checkReferences(proposal.evidenceIds, evidence, 3)) return "引用无效。请从输入选择真实且唯一的证据 ID。";
  const cited = evidence.find((fact) => fact.id === proposal.evidenceIds[0]);
  if (!cited || cited.metric !== proposal.driver || cited.impact !== worstImpact(evidence).impact) {
    return "首个引用必须与主要指标匹配，且对应单个渠道最大的负向贡献。";
  }
  if (!proposal.headline.trim() || !proposal.summary.trim() || proposal.headline.length > 100 || proposal.summary.length > 350) {
    return "请补充标题和说明，并保持简洁。";
  }
  return null;
}

export async function investigate(caseId: CaseId, models: AgentModels, emit: (event: EventInput) => void): Promise<Recommendation> {
  const scenario = caseView(caseId);
  const evidence = evidenceFor(caseId);

  function specialist(role: Role) {
    return async () => {
      emit({ step: role, phase: "started", message: "开始独立调查" });
      const scoped = evidence.filter((fact) => scopes[role].includes(fact.metric));
      let evidenceWasRead = false;
      const finding = findingSchema.parse(await models.investigate({
        role, scenario,
        readEvidence() {
          evidenceWasRead = true;
          emit({ step: role, phase: "tool", message: `读取 ${scoped.length} 条权限内的渠道证据` });
          return scoped;
        },
      }));
      if (!evidenceWasRead || !checkReferences(finding.evidenceIds, scoped, 2) ||
          !finding.summary.trim() || finding.summary.length > 300) {
        throw new Error(`Invalid specialist finding for ${role}.`);
      }
      emit({ step: role, phase: "completed", message: finding.summary });
      return { findings: [{ ...finding, role }] };
    };
  }

  function context(current: typeof state.State) {
    return {
      scenario: current.scenario, evidence: current.evidence, findings: current.findings,
      feedback: current.reviewResult?.approved === false ? current.reviewResult.note : null,
    };
  }

  const workflow = new StateGraph(state)
    .addNode("prepare", () => {
      const change = scenario.metrics.contribution - scenario.baseline.contribution;
      if (evidence.reduce((sum, fact) => sum + fact.impact, 0) !== change) {
        throw new Error("Contribution bridge did not reconcile.");
      }
      emit({ step: "prepare", phase: "completed", message: `已对齐两个周期，${evidence.length} 条渠道证据通过金额核对` });
      return { scenario, evidence };
    })
    .addNode("growth", specialist("growth"))
    .addNode("margin", specialist("margin"))
    .addNode("quality", specialist("quality"))
    .addNode("synthesis", async (current) => {
      const attempts = current.attempts + 1;
      emit({ step: "synthesis", phase: "started", message: `汇总三方发现，生成第 ${attempts} 版建议` });
      const proposal = proposalSchema.parse(await models.synthesize(context(current)));
      emit({ step: "synthesis", phase: "completed", message: "处置草案已提交审阅" });
      return { proposal, attempts };
    })
    .addNode("review", async (current) => {
      emit({ step: "review", phase: "started", message: "检查首要归因与证据引用" });
      const issue = checkProposal(current.proposal, evidence);
      const review = issue
        ? { approved: false, note: issue }
        : reviewSchema.parse(await models.review(context(current), current.proposal));
      emit({ step: "review", phase: review.approved ? "completed" : "retry", message: review.note });
      return { reviewResult: review };
    })
    .addEdge(START, "prepare")
    .addEdge("prepare", "growth")
    .addEdge("prepare", "margin")
    .addEdge("prepare", "quality")
    .addEdge([...roles], "synthesis")
    .addEdge("synthesis", "review")
    .addConditionalEdges("review", (current) =>
      current.reviewResult.approved || current.attempts >= maxDrafts ? END : "synthesis", [END, "synthesis"])
    .compile();

  const result = await workflow.invoke({ attempts: 0 });
  if (!result.reviewResult.approved) throw new Error("Review rejected all drafts.");
  return {
    ...result.proposal, ...playbook[result.proposal.driver],
    reviewNote: result.reviewResult.note, attempts: result.attempts, findings: result.findings,
  };
}
