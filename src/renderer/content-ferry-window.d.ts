export {};

type AppSettings = {
  schemaVersion: 1;
  dataDir: string;
  firstRunCompleted: boolean;
  aiInitStatus: "not_initialized" | "ready" | "login_required" | "binary_missing";
  codexBinaryPath: string | null;
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
      openWechatBackend: () => Promise<void>;
      openContentAny: () => Promise<void>;
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
        message?: string;
      }>;
      app: {
        getSettings: () => Promise<AppSettings>;
        chooseDataDir: () => Promise<string | undefined>;
        setDataDir: (target: string) => Promise<AppSettings>;
        detectCodex: () => Promise<CodexStatus>;
        openCodexLogin: () => Promise<{ ok: boolean; message?: string }>;
        completeFirstRun: (dataDir: string) => Promise<AppSettings>;
        relaunch: () => Promise<void>;
      };
    };
  }
}
