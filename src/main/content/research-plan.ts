import type { ResearchDepth, ResearchPlan } from "../../shared/research-state";

export interface ResearchPlanInput {
  topic: string;
  objective: string;
  angle: string;
  sourceNotes: string;
  instruction?: string;
  depth: ResearchDepth;
}

const FRESHNESS_PATTERN = /当前|最新|近期|今天|现在|版本|价格|费用|限额|政策|规则|202\d|20\d\d/i;
const COUNTERPOINT_PATTERN = /反例|风险|限制|边界|缺点|踩坑|争议|对比/i;
const EXPERIENCE_PATTERN = /经验|实测|案例|评论|博主|评价|踩坑|实践/i;

export function buildResearchPlan(input: ResearchPlanInput): ResearchPlan {
  const freshnessSensitive = FRESHNESS_PATTERN.test(`${input.topic}\n${input.objective}\n${input.angle}\n${input.instruction ?? ""}`);
  const needsCounterpoints = COUNTERPOINT_PATTERN.test(`${input.topic}\n${input.objective}\n${input.angle}\n${input.instruction ?? ""}`);
  const needsExperience = EXPERIENCE_PATTERN.test(`${input.topic}\n${input.objective}\n${input.angle}\n${input.sourceNotes}\n${input.instruction ?? ""}`);
  const questions = [
    `围绕「${input.topic}」有哪些可核验的关键事实、定义或使用条件？`,
    input.objective ? `哪些证据能帮助读者实现「${input.objective}」？` : "哪些证据最能支撑文章的核心判断？",
    input.angle ? `「${input.angle}」这一角度有哪些证据、限制或不同观点？` : "哪些限制、适用边界或反例需要与主张一起说明？",
    input.instruction ? `定向补研：${input.instruction}` : ""
  ].filter(Boolean);
  const evidenceDimensions = [
    "官方原始资料",
    needsExperience ? "独立实践、评论或案例" : "",
    needsCounterpoints ? "限制、反例或适用边界" : "",
    freshnessSensitive ? "当前版本、价格、限额或规则" : ""
  ].filter(Boolean);
  const freshnessRisks = [freshnessSensitive
    ? "选题包含明显时效项；写作前需要核对资料的发布日期、适用版本和地区。"
    : "未发现明确时效词；发布前仍应核对资料的版本与发布日期。"
  ];
  const pendingConflicts = [needsCounterpoints
    ? "需对比支持观点与限制/反例，避免只保留单一立场。"
    : "若不同来源对关键事实或适用条件表述不一致，需保留为待核验冲突。"
  ];
  return {
    depth: input.depth,
    questions,
    evidenceDimensions,
    freshnessRisks,
    pendingConflicts,
    covered: [],
    gaps: evidenceDimensions.map((dimension) => `待补充：${dimension}`),
    partial: false,
    execution: null,
    updatedAt: new Date().toISOString()
  };
}

export function mergeResearchPlan(current: ResearchPlan | null, next: ResearchPlan): ResearchPlan {
  if (!current) return next;
  return {
    ...next,
    questions: unique([...current.questions, ...next.questions]),
    evidenceDimensions: unique([...current.evidenceDimensions, ...next.evidenceDimensions]),
    freshnessRisks: unique([...current.freshnessRisks, ...next.freshnessRisks]),
    pendingConflicts: unique([...current.pendingConflicts, ...next.pendingConflicts]),
    covered: current.covered,
    gaps: unique([...current.gaps, ...next.gaps]),
    updatedAt: new Date().toISOString()
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
