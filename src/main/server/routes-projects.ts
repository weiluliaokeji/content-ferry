import { z } from "zod";
import { ContentSourceError } from "../content/content-source-service";
import {
  contentBriefInput, contentDraftInput, contentOutlineInput, contentProjectInput,
  contentProjectTitleInput, contentReviewInput, contentRevisionInput,
  researchFollowUpInput, researchSelectionInput, titleSuggestionInput
} from "./schemas";
import {
  extractHistoricalSeries, initialArticleTitle, persistResearchConversation,
  streamMarkdownGeneration, streamResearchGeneration
} from "./helpers";
import type { ServerContext } from "./server-context";

export function registerProjectsRoutes(ctx: ServerContext): void {
  const { server, database, assetStore, accounts, contentSources, contentProjects, contentBriefs, contentOutlines, contentDrafts, contentResearch, contentReviews, aiContent, csdnChannels, cnblogsChannels, juejinChannels } = ctx;

  server.get("/api/content-projects", async () => {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    return { items: contentProjects.list(workspace.id) };
  });

  server.post("/api/content-projects", async (request, reply) => {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const input = contentProjectInput.parse(request.body);
    const articleTitle = initialArticleTitle(input.topic, input.title);
    const article = contentSources.createArticle(workspace.id, articleTitle);
    const project = database.connection.transaction(() => {
      const created = contentProjects.create({
        workspaceId: workspace.id,
        // The project title is the canonical article title used by the dashboard,
        // outline and VitePress front matter. The longer initial idea is stored in
        // the creation brief rather than competing with the displayed title.
        topic: articleTitle,
        targetAccountId: input.targetAccountId,
        sourceRelativePath: article.relativePath
      });
      if (input.objective !== undefined || input.audience !== undefined || input.angle !== undefined || input.sourceNotes !== undefined) {
        contentBriefs.save(created.id, {
          topic: input.topic,
          objective: input.objective ?? "",
          audience: input.audience ?? "",
          angle: input.angle ?? "",
          sourceNotes: input.sourceNotes ?? ""
        });
      }
      return created;
    })();
    return reply.code(201).send(project);
  });

  server.delete("/api/content-projects/:projectId", async (request, reply) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const project = contentProjects.require(params.projectId);
    if (!project.sourceRelativePath) throw new ContentSourceError("这篇旧草稿尚未迁移到 VitePress 文章库，请先打开正文完成迁移。");
    const staged = contentSources.stageArticleDeletion(project.workspaceId, project.sourceRelativePath);
    try {
      csdnChannels.deleteDraftsBySource(project.workspaceId, project.sourceRelativePath, assetStore);
      cnblogsChannels.deleteDraftsBySource(project.workspaceId, project.sourceRelativePath, assetStore);
      juejinChannels.deleteDraftsBySource(project.workspaceId, project.sourceRelativePath, assetStore);
      database.connection.transaction(() => {
        database.connection.prepare("UPDATE wechat_publish_jobs SET project_id = NULL WHERE project_id = ?").run(project.id);
        database.connection.prepare("DELETE FROM article_settings WHERE context_key IN (?, ?)")
          .run(`project:${project.id}`, `source:${project.sourceRelativePath}`);
        database.connection.prepare("DELETE FROM content_projects WHERE id = ?").run(project.id);
      })();
      staged.finalize();
      return reply.code(204).send();
    } catch (error) {
      staged.rollback();
      throw error;
    }
  });

  server.get("/api/content-projects/:projectId/brief", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    return contentBriefs.get(params.projectId);
  });

  server.put("/api/content-projects/:projectId/brief", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const input = contentBriefInput.parse(request.body);
    return contentBriefs.save(params.projectId, { ...input, topic: input.topic ?? contentBriefs.get(params.projectId).topic });
  });

  server.get("/api/content-projects/:projectId/research", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    contentProjects.require(params.projectId);
    return contentResearch.get(params.projectId);
  });

  server.post("/api/content-projects/:projectId/research/generate", async (request, reply) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    return streamResearchGeneration(request, reply, params.projectId,
      (onStatus) => aiContent.generateResearch(params.projectId, onStatus),
      (value) => contentResearch.save(params.projectId, value as never)
    );
  });

  server.post("/api/content-projects/:projectId/research/follow-up", async (request, reply) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const input = researchFollowUpInput.parse(request.body);
    const project = contentProjects.require(params.projectId);
    return streamResearchGeneration(request, reply, params.projectId,
      (onStatus) => aiContent.generateResearchFollowUp(params.projectId, input.message, onStatus),
      (value) => {
        const research = contentResearch.append(params.projectId, value as never);
        persistResearchConversation(database, project.sourceRelativePath ? `source:${project.sourceRelativePath}` : `project:${project.id}`, input.message, (value as { planMarkdown: string }).planMarkdown, (value as { sources: Array<{ title: string; url: string }> }).sources);
        return research;
      }
    );
  });

  server.patch("/api/content-projects/:projectId/research/sources/:sourceId", async (request) => {
    const params = z.object({ projectId: z.string().uuid(), sourceId: z.string().uuid() }).parse(request.params);
    const input = researchSelectionInput.parse(request.body);
    return contentResearch.updateSelection(params.projectId, params.sourceId, input.selected);
  });

  server.post("/api/content-projects/:projectId/title/suggest", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const brief = titleSuggestionInput.parse(request.body);
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const historicalSeries = extractHistoricalSeries(contentSources.preview(workspace.id).items.map((item) => item.title));
    const generated = await aiContent.suggestTitles(params.projectId, historicalSeries, { ...brief, creationTopic: brief.topic ?? contentBriefs.get(params.projectId).topic });
    return { projectId: params.projectId, titles: generated.value.titles, historicalSeries, provider: generated.provider, usage: generated.usage };
  });

  server.put("/api/content-projects/:projectId/title", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const { title } = contentProjectTitleInput.parse(request.body);
    const project = contentProjects.require(params.projectId);
    const article = contentSources.getArticle(project.workspaceId, project.sourceRelativePath!);
    const markdown = /^#\s+.+$/m.test(article.markdown)
      ? article.markdown.replace(/^#\s+.+$/m, `# ${title}`)
      : `# ${title}\n\n${article.markdown}`;
    const saved = contentSources.saveArticle(project.workspaceId, project.sourceRelativePath!, markdown);
    contentProjects.updateTopic(project.id, title);
    return { ...contentProjects.require(project.id), sourceRelativePath: saved.relativePath };
  });

  server.get("/api/content-projects/:projectId/outline", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    return contentOutlines.get(params.projectId);
  });

  server.post("/api/content-projects/:projectId/outline/generate", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const generated = await aiContent.generateOutline(params.projectId);
    return {
      projectId: params.projectId,
      markdown: generated.value.markdown,
      generatedFromBrief: true,
      provider: generated.provider,
      usage: generated.usage
    };
  });

  server.post("/api/content-projects/:projectId/outline/generate/stream", async (request, reply) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    return streamMarkdownGeneration(request, reply, (onDelta, onStatus, signal) => aiContent.generateOutlineStream(params.projectId, onDelta, onStatus, signal), params.projectId);
  });

  server.put("/api/content-projects/:projectId/outline", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    return contentOutlines.save(params.projectId, contentOutlineInput.parse(request.body).markdown);
  });

  server.get("/api/content-projects/:projectId/draft", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const project = ensureProjectArticle(params.projectId);
    const draft = contentDrafts.get(params.projectId);
    if (project.draftReady && project.sourceRelativePath) {
      const article = contentSources.getArticle(project.workspaceId, project.sourceRelativePath);
      if (article.markdown !== draft.markdown) return { ...contentDrafts.save(project.id, article.markdown), sourceRelativePath: project.sourceRelativePath };
    }
    return { ...draft, sourceRelativePath: project.sourceRelativePath };
  });

  server.post("/api/content-projects/:projectId/draft/generate", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const project = ensureProjectArticle(params.projectId);
    const generated = await aiContent.generateDraft(params.projectId);
    return {
      projectId: params.projectId,
      markdown: generated.value.markdown,
      generatedFromOutline: true,
      sourceRelativePath: project.sourceRelativePath,
      provider: generated.provider,
      usage: generated.usage
    };
  });

  server.post("/api/content-projects/:projectId/draft/generate/stream", async (request, reply) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const project = ensureProjectArticle(params.projectId);
    return streamMarkdownGeneration(request, reply, (onDelta, onStatus, signal) => aiContent.generateDraftStream(params.projectId, onDelta, onStatus, signal), params.projectId, project.sourceRelativePath);
  });

  server.put("/api/content-projects/:projectId/draft", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const markdown = contentDraftInput.parse(request.body).markdown;
    const project = ensureProjectArticle(params.projectId);
    const saved = contentDrafts.save(params.projectId, markdown);
    const article = contentSources.saveArticle(project.workspaceId, project.sourceRelativePath!, markdown);
    // VitePress uses the front-matter title / leading H1 as the article's source
    // of truth. Keep the workflow card in sync after a user or AI changes it.
    if (article.title && article.title !== project.topic) contentProjects.updateTopic(project.id, article.title);
    const updated = contentProjects.require(project.id);
    return { ...saved, sourceRelativePath: updated.sourceRelativePath };
  });

  server.post("/api/content-projects/:projectId/draft/revise", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const input = contentRevisionInput.parse(request.body);
    const generated = await aiContent.reviseDraft(params.projectId, input.aiCheckResult, input.guidance);
    return {
      projectId: params.projectId,
      markdown: generated.value.markdown,
      generatedFromOutline: false,
      provider: generated.provider,
      usage: generated.usage
    };
  });

  server.get("/api/content-projects/:projectId/review", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    return contentReviews.get(params.projectId);
  });

  server.put("/api/content-projects/:projectId/review", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    return contentReviews.save(params.projectId, contentReviewInput.parse(request.body));
  });

  function ensureProjectArticle(projectId: string) {
    let project = contentProjects.require(projectId);
    if (!project.sourceRelativePath) {
      const article = contentSources.createArticle(project.workspaceId, project.topic);
      contentProjects.attachSource(project.id, article.relativePath);
      project = contentProjects.require(projectId);
      const existing = database.connection.prepare("SELECT markdown FROM content_drafts WHERE project_id = ?")
        .get(projectId) as { markdown: string } | undefined;
      if (existing?.markdown) contentSources.saveArticle(project.workspaceId, article.relativePath, existing.markdown);
    }
    return project;
  }

}
