import type { FastifyBaseLogger } from "fastify";
import type { AiContentService } from "../ai/ai-content-service";
import type { AppDatabase } from "../db/database";
import type { ContentProjectRepository } from "./content-project-repository";
import type { ContentResearchRepository } from "./content-research-repository";
import { persistResearchConversation } from "../server/helpers";
import { ResearchTaskRepository } from "./research-task-repository";

/** Resumes queued research after a desktop restart; active requests remain user-cancellable. */
export class ResearchTaskRunner {
  private static readonly MAX_RECOVERED_CONCURRENCY = 2;
  private readonly active = new Set<string>();
  private recoveryQueue: string[] = [];
  private stopping = false;

  constructor(
    private readonly database: AppDatabase,
    private readonly tasks: ResearchTaskRepository,
    private readonly projects: ContentProjectRepository,
    private readonly research: ContentResearchRepository,
    private readonly aiContent: AiContentService,
    private readonly log: FastifyBaseLogger
  ) {}

  start(): void {
    if (this.stopping) return;
    const recovered = this.tasks.recoverInterrupted();
    if (recovered > 0) this.log.info({ recovered }, "Research tasks requeued after restart");
    this.recoveryQueue.push(...this.tasks.listRecoverable().map((task) => task.id));
    void this.drainRecoveryQueue();
  }

  /** Stop launching work during application shutdown. An in-flight provider
   * request may finish outside the server lifetime, so every callback below
   * checks this flag before touching SQLite. */
  stop(): void {
    this.stopping = true;
    this.recoveryQueue = [];
  }

  /** Reserve a task while its HTTP stream owns the provider request. */
  registerActive(taskId: string): void {
    this.active.add(taskId);
  }

  releaseActive(taskId: string): void {
    this.active.delete(taskId);
    void this.drainRecoveryQueue();
  }

  isActive(taskId: string): boolean {
    return this.active.has(taskId);
  }

  private async drainRecoveryQueue(): Promise<void> {
    while (!this.stopping && this.active.size < ResearchTaskRunner.MAX_RECOVERED_CONCURRENCY) {
      const taskId = this.recoveryQueue.shift();
      if (!taskId) return;
      void this.run(taskId).finally(() => void this.drainRecoveryQueue());
    }
  }

  private async run(taskId: string): Promise<void> {
    if (this.stopping) return;
    if (this.active.has(taskId) || !this.tasks.claim(taskId)) return;
    this.active.add(taskId);
    try {
      const task = this.tasks.require(taskId);
      const request = task.request && typeof task.request === "object" ? task.request as { message?: unknown } : {};
      const instruction = typeof request.message === "string" ? request.message.trim() : "";
      if (task.kind === "follow_up" && !instruction) throw new Error("补充资料任务缺少补充说明，无法恢复。 ");
      const onStatus = (message: string) => {
        if (this.stopping) return;
        // Pause stops persistence, not an already-running provider request.
        // Let it finish so the result can become a durable checkpoint instead
        // of forcing a full network/model rerun after resume.
        if (!this.tasks.isPaused(taskId) && !this.tasks.isCancelRequested(taskId)) this.tasks.heartbeat(taskId, message);
      };
      const checkpoint = this.tasks.getCheckpoint<{ planMarkdown: string; sources: Array<{ title: string; url: string; excerpt: string; keyClaims: string[]; sourceType: "official" | "public" }> }>(taskId, "generated");
      const generatedValue = checkpoint ?? (task.kind === "follow_up"
        ? (await this.aiContent.generateResearchFollowUp(task.projectId, instruction, onStatus)).value
        : (await this.aiContent.generateResearch(task.projectId, onStatus)).value);
      if (!checkpoint) {
        try { this.tasks.saveCheckpoint(taskId, "generated", generatedValue); }
        catch (checkpointError) {
          if (!this.stopping) throw checkpointError;
          this.log.warn({ taskId, err: checkpointError }, "Research checkpoint could not be saved during shutdown");
        }
      }
      if (this.stopping) return;
      if (this.tasks.isCancelRequested(taskId)) {
        this.tasks.transition(taskId, "cancelled", { checkpoint: "任务已取消，未写入本轮未完成结果。" });
        return;
      }
      if (this.tasks.isPaused(taskId)) {
        this.tasks.transition(taskId, "paused", { checkpoint: "已保存生成结果，等待用户继续写入资料卡。" });
        return;
      }
      const value = generatedValue;
      const saved = task.kind === "follow_up"
        ? this.research.append(task.projectId, value)
        : this.research.save(task.projectId, value);
      if (task.kind === "follow_up") {
        const project = this.projects.require(task.projectId);
        persistResearchConversation(
          this.database,
          project.sourceRelativePath ? `source:${project.sourceRelativePath}` : `project:${project.id}`,
          instruction,
          value.planMarkdown,
          value.sources
        );
      }
      this.tasks.transition(taskId, "completed", { checkpoint: "后台补研已完成。" });
      this.log.info({ taskId, projectId: task.projectId, sourceCount: saved.sources.length }, "Recovered research task completed");
    } catch (error) {
      if (this.stopping) return;
      const cancelled = this.tasks.isCancelRequested(taskId);
      if (this.tasks.isPaused(taskId)) {
        this.tasks.transition(taskId, "paused", { checkpoint: "已暂停，等待用户继续。" });
        return;
      }
      this.tasks.transition(taskId, cancelled ? "cancelled" : "failed", {
        error: error instanceof Error ? error.message : "资料补研失败。"
      });
      this.log.warn({ taskId, err: error }, "Recovered research task failed");
    } finally {
      this.active.delete(taskId);
    }
  }
}
