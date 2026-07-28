export interface AiUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface GenerateStructuredRequest<T> {
  task: "research" | "outline" | "draft" | "revision" | "summary" | "selection" | "cover_prompt" | "assistant";
  skillId?: string;
  /** Optional provider-specific model override selected in 模型连接. */
  modelId?: string;
  prompt: string;
  outputSchema: object;
  timeoutMs?: number;
  parse(value: unknown): T;
  /** Provider lifecycle feedback. Only some providers emit this during structured calls. */
  onStatus?: (message: string) => void;
}

export interface GenerateStructuredResult<T> {
  value: T;
  provider: string;
  model: string | null;
  usage: AiUsage | null;
}

export interface GenerateMarkdownStreamRequest {
  task: "outline" | "draft";
  skillId?: string;
  modelId?: string;
  prompt: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onDelta: (markdown: string) => void;
  /** Provider lifecycle feedback. Text deltas are not available from every provider at every stage. */
  onStatus?: (message: string) => void;
}

export interface ModelProvider {
  readonly id: string;
  generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<GenerateStructuredResult<T>>;
  generateMarkdownStream?(request: GenerateMarkdownStreamRequest): Promise<GenerateStructuredResult<{ markdown: string }>>;
}

export class ModelProviderUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelProviderUnavailableError";
  }
}

export class UnavailableModelProvider implements ModelProvider {
  readonly id = "unavailable";

  async generateStructured<T>(_request: GenerateStructuredRequest<T>): Promise<GenerateStructuredResult<T>> {
    throw new ModelProviderUnavailableError("AI 模型尚未在当前运行环境中启用。");
  }
}
