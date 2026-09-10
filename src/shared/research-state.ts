export const RESEARCH_DEPTHS = ["quick", "balanced", "deep"] as const;
export type ResearchDepth = typeof RESEARCH_DEPTHS[number];

export interface ResearchExecution {
  rounds: number | null;
  maxRounds: number | null;
  budgetExhausted: boolean;
}

export interface ResearchPlan {
  depth: ResearchDepth;
  questions: string[];
  evidenceDimensions: string[];
  freshnessRisks: string[];
  pendingConflicts: string[];
  covered: string[];
  gaps: string[];
  partial: boolean;
  execution: ResearchExecution | null;
  updatedAt: string;
}
