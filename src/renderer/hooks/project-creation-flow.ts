import type { ContentProject, ResearchDepth } from "../types";

export type ProjectCreationMode = "research" | "draft";

export function resolveInitialResearchDepth(
  requestedDepth: ResearchDepth | undefined,
  savedPlanDepth: ResearchDepth | undefined
): ResearchDepth {
  return requestedDepth ?? savedPlanDepth ?? "balanced";
}

export async function continueAfterProjectCreation(
  project: ContentProject,
  mode: ProjectCreationMode,
  depth: ResearchDepth,
  loadProjects: () => Promise<void>,
  openResearch: (project: ContentProject, generate: boolean, depth: ResearchDepth) => Promise<void>
): Promise<void> {
  await loadProjects();
  if (mode === "research") await openResearch(project, true, depth);
}
