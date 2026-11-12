import { caseIds } from "../shared/contracts.ts";
import type { CaseId, Driver } from "../shared/contracts.ts";
import { evidenceFor } from "../server/data.ts";
import { configuredModels, replayModels } from "../server/models.ts";
import { investigate } from "../server/workflow.ts";

const expected: Record<CaseId, { driver: Driver; evidence: string }> = {
  promotion: { driver: "cogs", evidence: "cogs-1" },
  acquisition: { driver: "ads", evidence: "ads-1" },
  returns: { driver: "refunds", evidence: "refunds-1" },
};

const models = process.argv.includes("--live") ? configuredModels() : replayModels();
if (process.argv.includes("--live") && models.mode !== "live") {
  throw new Error("Set MARGINOPS_MODE=live before running a live evaluation.");
}
const results = [];
for (const id of caseIds) {
  let toolCalls = 0;
  const start = performance.now();
  try {
    const report = await investigate(id, models, (event) => { if (event.phase === "tool") toolCalls += 1; });
    const valid = new Set(evidenceFor(id).map((fact) => fact.id));
    const citations = report.evidenceIds.every((ref) => valid.has(ref));
    const match = report.driver === expected[id].driver && report.evidenceIds[0] === expected[id].evidence;
    results.push({ case: id, driver: report.driver, leadCitation: report.evidenceIds[0], toolCalls,
      drafts: report.attempts, ms: Math.round(performance.now() - start), passed: citations && match && toolCalls === 3 });
  } catch (error) {
    results.push({ case: id, driver: "error", leadCitation: "", toolCalls,
      drafts: null, ms: Math.round(performance.now() - start), passed: false,
      error: error instanceof Error ? error.name : "Unknown error" });
  }
}
const passed = results.filter((result) => result.passed).length;
console.table(results);
console.log(`${models.mode}: ${passed}/${results.length} scenarios passed`);
if (passed !== results.length) process.exitCode = 1;
