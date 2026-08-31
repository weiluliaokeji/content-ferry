export {};

type AppSettings = {
  schemaVersion: 1;
  dataDir: string;
  firstRunCompleted: boolean;
  aiInitStatus: "not_initialized" | "ready" | "login_required" | "binary_missing";
  codexBinaryPath: string | null;
  auditAiCalls: boolean;
  createdAt: string;
  updatedAt: string;
};

type CodexStatus = { ok: boolean; binaryPath: string | null; authenticated: boolean; authMethod?: string; reason?: string };

declare global {
  interface Window {
    contentFerry?: {
      apiBaseUrl: string;
      selectDirectory: () => Promise<string | undefined>;
      selectImage: () => Promise<{ fileName: string; mimeType: string; base64: string } | undefined>;
      openZhuque: () => Promise<void>;
      openWechatBackend: (target?: { accountId?: string; title: string; declareOriginal?: boolean; enableReward?: boolean; collectionName?: string }) => Promise<void>;
      openContentAny: () => Promise<void>;
      openCsdnPublisher: (jobId: string) => Promise<void>;
      readCnblogsPersonalOptions: (accountId: string) => Promise<{ categories: string[]; tags: string[] }>;
      openUserGuide: () => Promise<void>;
      showLogFile: (date?: string) => Promise<void>;
      runZhuqueDetection: (markdown: string) => Promise<{
        status: "completed" | "needs_user";
        result?: string;
        report?: {
          verdict: string;
          humanPercent: number | null;
          uncertainPercent: number | null;
          aiPercent: number | null;
          ratioSource: "official" | "segments";
          segments: Array<{ text: string; kind: "human" | "uncertain" | "ai" }>;
        };
        message?: string;
      }>;
      runContentAnyDetection: (markdown: string) => Promise<{
        status: "completed" | "needs_user";
        result?: string;
        reference?: { label: string; score: string | null; summary: string; detail: string };
        message?: string;
      }>;
      app: {
        getSettings: () => Promise<AppSettings>;
        chooseDataDir: () => Promise<string | undefined>;
        setDataDir: (target: string) => Promise<AppSettings>;
        detectCodex: () => Promise<CodexStatus>;
        openCodexLogin: () => Promise<{ ok: boolean; message?: string }>;
        completeFirstRun: (dataDir: string) => Promise<AppSettings>;
        updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
        relaunch: () => Promise<void>;
      };
    };
  }
}
