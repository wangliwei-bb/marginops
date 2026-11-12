import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CaseId, Decision, Evidence, Mode, Recommendation, Run, RunEvent, RunSummary, Status } from "../shared/contracts.ts";
import type { EventInput } from "./workflow.ts";

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
  `);
  const insertEvent = db.prepare("INSERT INTO events (run_id, step, phase, message, at) VALUES (?, ?, ?, ?, ?)");
  const getRow = db.prepare("SELECT * FROM runs WHERE id = ?");

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
