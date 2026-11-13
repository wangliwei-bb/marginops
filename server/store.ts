import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { taskStages } from "../shared/contracts.ts";
import type { ActionTask, CaseId, CaseView, Decision, Evidence, Mode, Recommendation, Run, RunEvent, RunSummary, Status, TaskStage } from "../shared/contracts.ts";
import type { EventInput } from "./workflow.ts";
import type { CaseData } from "./data.ts";
import type { AnalysisReport, BusinessProfile, WorkbookSummary } from "../shared/analysis.ts";
import type { AnalysisWorkbook } from "./analysis-data.ts";
import type { SourceIndex } from "./analysis-workflow.ts";
import type { SlaReview } from "../shared/sla.ts";

interface RunRow {
  id: string;
  case_id: CaseId;
  status: Status;
  mode: Mode;
  created_at: string;
  report: string | null;
  evidence: string;
  error: string | null;
  decided_at: string | null;
}

function summary(row: RunRow): RunSummary {
  return { id: row.id, caseId: row.case_id, status: row.status, mode: row.mode, createdAt: row.created_at };
}

export function openStore(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 3000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      status TEXT NOT NULL,
      mode TEXT NOT NULL,
      created_at TEXT NOT NULL,
      report TEXT,
      evidence TEXT NOT NULL,
      error TEXT,
      decided_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_running_case ON runs(case_id) WHERE status = 'running';
    CREATE TABLE IF NOT EXISTS events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id),
      step TEXT NOT NULL,
      phase TEXT NOT NULL,
      message TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_by_run ON events(run_id, sequence);
    CREATE TABLE IF NOT EXISTS task_updates (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id),
      stage TEXT NOT NULL CHECK (stage IN ('in_progress', 'completed')),
      note TEXT NOT NULL,
      at TEXT NOT NULL,
      UNIQUE (run_id, stage)
    );
    CREATE TABLE IF NOT EXISTS imported_cases (
      id TEXT PRIMARY KEY,
      overview TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analysis_workbooks (
      id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      tables TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS business_analyses (
      id TEXT PRIMARY KEY,
      workbook_id TEXT NOT NULL REFERENCES analysis_workbooks(id),
      report TEXT NOT NULL,
      sources TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analysis_business_profiles (
      workbook_id TEXT PRIMARY KEY REFERENCES analysis_workbooks(id),
      profile TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analysis_sla_reviews (
      snapshot_id TEXT PRIMARY KEY REFERENCES analysis_workbooks(id),
      review TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS business_analyses_by_workbook ON business_analyses(workbook_id);
  `);
  const insertEvent = db.prepare("INSERT INTO events (run_id, step, phase, message, at) VALUES (?, ?, ?, ?, ?)");
  const getRow = db.prepare("SELECT * FROM runs WHERE id = ?");
  const getUpdates = db.prepare("SELECT stage, note, at FROM task_updates WHERE run_id = ? ORDER BY sequence");

  function taskFor(row: RunRow): ActionTask | null {
    if (row.status !== "approved" || !row.report || !row.decided_at) return null;
    const report: Recommendation = JSON.parse(row.report);
    const updates = getUpdates.all(row.id) as unknown as ActionTask["updates"];
    return {
      runId: row.id, caseId: row.case_id, title: report.headline, action: report.action,
      owner: report.owner, measure: report.measure, createdAt: row.decided_at,
      stage: updates.at(-1)?.stage ?? "pending", updates,
    };
  }

  function transaction<T>(operation: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function record(id: string, event: EventInput, at = new Date().toISOString()) {
    insertEvent.run(id, event.step, event.phase, event.message, at);
  }

  function transition(id: string, from: Status, to: Status, event: EventInput, fields: {
    report?: Recommendation; error?: string; decidedAt?: string;
  } = {}) {
    return transaction(() => {
      const result = db.prepare(`
        UPDATE runs SET status = ?, report = COALESCE(?, report), error = ?, decided_at = ?
        WHERE id = ? AND status = ?
      `).run(to, fields.report ? JSON.stringify(fields.report) : null, fields.error ?? null, fields.decidedAt ?? null, id, from);
      if (!result.changes) return false;
      record(id, event, fields.decidedAt);
      return true;
    });
  }

  return {
    close: () => db.close(),
    saveWorkbook({ summary, tables }: AnalysisWorkbook) {
      db.prepare("INSERT INTO analysis_workbooks (id, summary, tables) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING")
        .run(summary.id, JSON.stringify(summary), JSON.stringify(tables));
    },
    listWorkbooks(): WorkbookSummary[] {
      return db.prepare("SELECT summary FROM analysis_workbooks WHERE json_extract(summary, '$.kind') IS NOT 'sla-snapshot' ORDER BY rowid DESC").all()
        .map(({ summary }) => JSON.parse(String(summary)));
    },
    readWorkbook(id: string): AnalysisWorkbook | null {
      const row = db.prepare("SELECT summary, tables FROM analysis_workbooks WHERE id = ?").get(id);
      return row ? { summary: JSON.parse(String(row.summary)), tables: JSON.parse(String(row.tables)) } : null;
    },
    readBusinessProfile(id: string): BusinessProfile {
      const row = db.prepare("SELECT profile FROM analysis_business_profiles WHERE workbook_id = ?").get(id);
      return row ? JSON.parse(String(row.profile)) : { context: "", metrics: [] };
    },
    saveBusinessProfile(id: string, profile: BusinessProfile) {
      db.prepare(`INSERT INTO analysis_business_profiles (workbook_id, profile) VALUES (?, ?)
        ON CONFLICT(workbook_id) DO UPDATE SET profile = excluded.profile`).run(id, JSON.stringify(profile));
    },
    saveAnalysis(report: AnalysisReport, sources: SourceIndex) {
      db.prepare("INSERT INTO business_analyses (id, workbook_id, report, sources) VALUES (?, ?, ?, ?)")
        .run(report.id, report.workbookId, JSON.stringify(report), JSON.stringify(sources));
    },
    readSlaReview(id: string): SlaReview | undefined {
      const row = db.prepare("SELECT review FROM analysis_sla_reviews WHERE snapshot_id = ?").get(id);
      return row ? JSON.parse(String(row.review)) : undefined;
    },
    saveSlaReview(snapshot: AnalysisWorkbook, reports: { report: AnalysisReport; sources: SourceIndex }[], review: SlaReview): SlaReview {
      return transaction(() => {
        const existing = db.prepare("SELECT review FROM analysis_sla_reviews WHERE snapshot_id = ?").get(snapshot.summary.id);
        if (existing) return JSON.parse(String(existing.review));
        db.prepare("INSERT INTO analysis_workbooks (id, summary, tables) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING")
          .run(snapshot.summary.id, JSON.stringify(snapshot.summary), JSON.stringify(snapshot.tables));
        const insert = db.prepare("INSERT INTO business_analyses (id, workbook_id, report, sources) VALUES (?, ?, ?, ?)");
        for (const { report, sources } of reports) insert.run(report.id, report.workbookId, JSON.stringify(report), JSON.stringify(sources));
        db.prepare("INSERT INTO analysis_sla_reviews (snapshot_id, review) VALUES (?, ?)").run(snapshot.summary.id, JSON.stringify(review));
        return review;
      });
    },
    listAnalyses(workbookId: string): AnalysisReport[] {
      return db.prepare("SELECT report FROM business_analyses WHERE workbook_id = ? ORDER BY rowid DESC LIMIT 20")
        .all(workbookId).map(({ report }) => JSON.parse(String(report)));
    },
    readAnalysis(id: string): { report: AnalysisReport; sources: SourceIndex } | null {
      const row = db.prepare("SELECT report, sources FROM business_analyses WHERE id = ?").get(id);
      return row ? { report: JSON.parse(String(row.report)), sources: JSON.parse(String(row.sources)) } : null;
    },
    saveCase(data: CaseData, overview: CaseView) {
      db.prepare("INSERT INTO imported_cases (id, overview, data) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING")
        .run(data.id, JSON.stringify(overview), JSON.stringify(data));
    },
    readCase(id: CaseId): CaseData | undefined {
      const row = db.prepare("SELECT data FROM imported_cases WHERE id = ?").get(id);
      return row ? JSON.parse(String(row.data)) as CaseData : undefined;
    },
    listCases(): CaseView[] {
      return db.prepare("SELECT overview FROM imported_cases ORDER BY rowid DESC").all()
        .map((row) => JSON.parse(String(row.overview)) as CaseView);
    },
    recover() {
      const rows = db.prepare("SELECT id FROM runs WHERE status = 'running'").all() as { id: string }[];
      for (const { id } of rows) {
        const error = "上次进程在研判完成前退出，请重新发起研判。";
        transition(id, "running", "failed", { step: "prepare", phase: "failed", message: error }, { error });
      }
    },
    create(caseId: CaseId, mode: Mode, evidence: Evidence[]) {
      return transaction(() => {
        const active = db.prepare("SELECT id FROM runs WHERE case_id = ? AND status = 'running'").get(caseId) as { id: string } | undefined;
        if (active) return { id: active.id, created: false };
        const id = randomUUID();
        db.prepare("INSERT INTO runs (id, case_id, status, mode, created_at, evidence) VALUES (?, ?, 'running', ?, ?, ?)")
          .run(id, caseId, mode, new Date().toISOString(), JSON.stringify(evidence));
        return { id, created: true };
      });
    },
    list() {
      return (db.prepare("SELECT * FROM runs ORDER BY created_at DESC, rowid DESC LIMIT 40").all() as unknown as RunRow[]).map(summary);
    },
    listTasks() {
      const rows = db.prepare("SELECT * FROM runs WHERE status = 'approved' ORDER BY decided_at DESC, rowid DESC")
        .all() as unknown as RunRow[];
      return rows.flatMap((row) => {
        const task = taskFor(row);
        return task ? [task] : [];
      });
    },
    updateTask(id: string, stage: TaskStage, note: string) {
      return transaction(() => {
        const row = getRow.get(id) as unknown as RunRow | undefined;
        const task = row && taskFor(row);
        if (!task) return { result: "missing" } as const;
        if (taskStages[taskStages.indexOf(task.stage) + 1] !== stage) return { result: "conflict" } as const;
        db.prepare("INSERT INTO task_updates (run_id, stage, note, at) VALUES (?, ?, ?, ?)")
          .run(id, stage, note, new Date().toISOString());
        return { result: "updated", task: taskFor(row) } as const;
      });
    },
    read(id: string): Run | null {
      const row = getRow.get(id) as unknown as RunRow | undefined;
      if (!row) return null;
      const events = db.prepare("SELECT sequence, step, phase, message, at FROM events WHERE run_id = ? ORDER BY sequence")
        .all(id) as unknown as RunEvent[];
      const decision = row.decided_at && (row.status === "approved" || row.status === "rejected")
        ? { value: row.status, at: row.decided_at }
        : null;
      return {
        ...summary(row), events, decision, error: row.error,
        evidence: JSON.parse(row.evidence),
        report: row.report ? JSON.parse(row.report) : null,
      };
    },
    append(id: string, event: EventInput) {
      return transaction(() => {
        const row = getRow.get(id);
        if (row?.status !== "running") return false;
        record(id, event);
        return true;
      });
    },
    complete(id: string, report: Recommendation) {
      return transition(id, "running", "review_required", {
        step: "approval", phase: "waiting", message: "建议已就绪，等待运营负责人决定",
      }, { report });
    },
    fail(id: string, error: string) {
      return transition(id, "running", "failed", { step: "prepare", phase: "failed", message: error }, { error });
    },
    decide(id: string, value: Decision) {
      return transition(id, "review_required", value, {
        step: "approval", phase: "decision", message: value === "approved" ? "运营负责人批准处置建议" : "运营负责人驳回处置建议",
      }, { decidedAt: new Date().toISOString() });
    },
  };
}
