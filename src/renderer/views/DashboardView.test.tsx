import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardView } from "./DashboardView";
import type { ContentProject } from "../types";

describe("dashboard actions for a brief without research", () => {
  it("offers outline generation and optional research as separate next steps", () => {
    const project = {
      id: "project-1",
      topic: "先写再补资料",
      createdAt: "2026-09-29T00:00:00.000Z",
      briefReady: true,
      researchReady: false,
      outlineReady: false,
      outlineDraftReady: false,
      draftReady: false,
      sourceRelativePath: "posts/先写再补资料/index.md"
    } as ContentProject;
    const markup = renderToStaticMarkup(<DashboardView
      items={[{ kind: "project", id: project.id, title: project.topic, createdAt: project.createdAt, relativePath: project.sourceRelativePath ?? null, project }]}
      totalItems={1}
      accounts={[]}
      wechatJobs={[]}
      saving={false}
      openProjectCreator={() => undefined}
      openBrief={() => undefined}
      openResearch={() => undefined}
      openOutline={() => undefined}
      openDraft={() => undefined}
      openDraftDirectly={() => undefined}
      openPublishPreparation={() => undefined}
      deleteProjectDraft={() => undefined}
      openSourceArticle={() => undefined}
      channelRowsFor={() => []}
      page={1}
      totalPages={1}
      pageSize={5}
      setPage={() => undefined}
      setPageSize={() => undefined}
      PAGE_SIZE_OPTIONS={[5]}
    />);

    expect(markup).toContain(">生成提纲</button>");
    expect(markup).toContain(">联网补研</button>");
    expect(markup).toContain(">直接编辑正文</button>");
  });
});
