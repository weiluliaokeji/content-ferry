export type ResearchEvidenceKind = "official" | "review" | "experience" | "counterexample" | "manual";

export interface ResearchEvidenceSnapshot {
  url: string;
  excerpt: string;
  capturedAt: string;
  sha256: string;
}

export interface ResearchEvidence {
  claim: string;
  recommendation: string;
  qualityReason: string;
  freshness: string;
  boundary: string;
  kind: ResearchEvidenceKind;
  sourceUrls: string[];
  snapshots: ResearchEvidenceSnapshot[];
}
