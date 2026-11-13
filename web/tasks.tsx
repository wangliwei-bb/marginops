import { useEffect, useState } from "react";
import { taskStages } from "../shared/contracts.ts";
import type { ActionTask, CaseView, TaskStage } from "../shared/contracts.ts";
import { post, request } from "./api.ts";

const stageNames: Record<TaskStage, string> = { pending: "待处理", in_progress: "执行中", completed: "已完成" };
const date = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

function TaskDetail({ task, onUpdate, onReport }: {
  task: ActionTask; onUpdate: (task: ActionTask) => void; onReport: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const next = taskStages[taskStages.indexOf(task.stage) + 1];

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const updated = await post<ActionTask>(`/api/tasks/${task.runId}`, { stage: next, note });
      onUpdate(updated);
      setNote("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "更新任务失败，请重试。");
      const latest = await request<ActionTask[]>("/api/tasks").catch(() => []);
      const match = latest.find((item) => item.runId === task.runId);
      if (match) onUpdate(match);
    } finally { setBusy(false); }
  }

  return <section className="panel task-detail" aria-labelledby="task-title">
    <div className="panel-heading"><div><h2 id="task-title">{task.title}</h2>
      <p>批准于 {date.format(new Date(task.createdAt))}</p></div>
      <span className={`task-stage task-${task.stage}`} role="status">{stageNames[task.stage]}</span></div>
    <div className="next-action"><h3>建议处置</h3><p>{task.action}</p>
      <dl><div><dt>负责人</dt><dd>{task.owner}</dd></div><div><dt>验证指标</dt><dd>{task.measure}</dd></div></dl>
    </div>
    <button className="text-button" onClick={onReport}>查看原研判报告</button>
    {task.updates.length > 0 && <div className="task-updates">
      <h3>执行记录</h3>
      <ol>{task.updates.map((update) => <li key={update.stage}>
        <div><strong>{stageNames[update.stage]}</strong> <time dateTime={update.at}>{date.format(new Date(update.at))}</time></div>
        <p>{update.note}</p>
      </li>)}</ol>
    </div>}
    {error && <p className="error-box" role="alert">{error}</p>}
    {next && <form className="task-form" onSubmit={(event) => { event.preventDefault(); if (note.trim() && !busy) void submit(); }}>
      <label htmlFor="task-note">{next === "completed" ? "复盘结论" : "执行计划"}</label>
      <textarea id="task-note" required maxLength={240} rows={3} value={note}
        placeholder={next === "completed" ? "记录实际动作、验证指标结果或仍待确认的事项" : "记录将要执行的动作和时间安排"}
        onChange={(event) => setNote(event.target.value)} />
      <button className="button primary" disabled={busy || !note.trim()}>{next === "completed" ? "标记完成" : "开始执行"}</button>
    </form>}
  </section>;
}

export function TasksPage({ cases, focusId, openReport }: {
  cases: CaseView[]; focusId?: string; openReport: (id: string) => void;
}) {
  const [tasks, setTasks] = useState<ActionTask[] | null>(null);
  const [selected, setSelected] = useState(focusId);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void request<ActionTask[]>("/api/tasks", { signal: controller.signal }).then(setTasks)
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, []);

  if (error) return <p className="error-box" role="alert">处置任务加载失败，请刷新重试。</p>;
  if (!tasks) return <p role="status">正在读取处置任务…</p>;
  const active = tasks.find((task) => task.runId === selected) ?? tasks[0];

  return <div className="task-layout">
    <section className="panel" aria-labelledby="task-list">
      <div className="panel-heading"><div><h2 id="task-list">任务列表</h2>
        <p>待处理 {tasks.filter((task) => task.stage === "pending").length} · 执行中 {tasks.filter((task) => task.stage === "in_progress").length} · 已完成 {tasks.filter((task) => task.stage === "completed").length}</p></div></div>
      {tasks.length === 0 ? <p className="empty">审批通过的建议会出现在这里。</p> :
        <ul className="history-list task-list">{tasks.map((task) => <li key={task.runId}>
          <button aria-pressed={task.runId === active?.runId} onClick={() => setSelected(task.runId)}>
            <span><strong>{task.title}</strong><small>{cases.find((item) => item.id === task.caseId)?.name} · {task.owner}</small></span>
            <span className={`task-stage task-${task.stage}`}>{stageNames[task.stage]}</span>
          </button>
        </li>)}</ul>}
    </section>
    {active && <TaskDetail key={active.runId} task={active} onReport={() => openReport(active.runId)}
      onUpdate={(update) => setTasks((current) => current?.map((task) => task.runId === update.runId ? update : task) ?? null)} />}
  </div>;
}
