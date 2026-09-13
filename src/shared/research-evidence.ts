export type ResearchEvidenceKind = "official" | "review" | "experience" | "counterexample" | "manual";
export type ResearchAdoptionStatus = "recommended" | "adopted" | "rejected" | "pending_verification";

export interface ResearchAdoptionDecision {
  sourceId: string;
  title: string;
  adoptionStatus: ResearchAdoptionStatus;
}

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
  mergedDecisions?: ResearchAdoptionDecision[];
}
