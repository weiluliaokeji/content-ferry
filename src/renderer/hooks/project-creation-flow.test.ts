import { describe, expect, it, vi } from "vitest";
import type { ContentProject, ResearchDepth } from "../types";
import { continueAfterProjectCreation, resolveInitialResearchDepth } from "./project-creation-flow";

describe("article creation follow-up", () => {
  const project = { id: "project-1" } as ContentProject;

  it("does not start model-backed research when the author chooses to create a draft only", async () => {
    const loadProjects = vi.fn(async () => undefined);
    const openResearch = vi.fn(async () => undefined);

    await continueAfterProjectCreation(project, "draft", "balanced", loadProjects, openResearch);

    expect(loadProjects).toHaveBeenCalledOnce();
    expect(openResearch).not.toHaveBeenCalled();
  });

  it("starts the default research flow after project creation", async () => {
    const loadProjects = vi.fn(async () => undefined);
    const openResearch = vi.fn(async () => undefined);

    await continueAfterProjectCreation(project, "research", "deep" satisfies ResearchDepth, loadProjects, openResearch);

    expect(openResearch).toHaveBeenCalledExactlyOnceWith(project, true, "deep");
  });

  it("uses the depth selected before deferred research when one was saved with the project", () => {
    expect(resolveInitialResearchDepth(undefined, "deep")).toBe("deep");
    expect(resolveInitialResearchDepth("quick", "deep")).toBe("quick");
    expect(resolveInitialResearchDepth(undefined, undefined)).toBe("balanced");
  });
});
