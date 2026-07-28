import { contextBridge, ipcRenderer } from "electron";

type ZhuqueDetectionResponse = {
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
};

type AppSettingsContract = {
  schemaVersion: 1;
  dataDir: string;
  firstRunCompleted: boolean;
  aiInitStatus: "not_initialized" | "ready" | "login_required" | "binary_missing";
  codexBinaryPath: string | null;
  createdAt: string;
  updatedAt: string;
};

type CodexStatusContract = { ok: boolean; binaryPath: string | null; authenticated: boolean; authMethod?: string; reason?: string };

contextBridge.exposeInMainWorld("contentFerry", {
  apiBaseUrl: "http://127.0.0.1:4317",
  selectDirectory: (): Promise<string | undefined> => ipcRenderer.invoke("contentferry:select-directory") as Promise<string | undefined>,
  selectImage: (): Promise<{ fileName: string; mimeType: string; base64: string } | undefined> =>
    ipcRenderer.invoke("contentferry:select-image") as Promise<{ fileName: string; mimeType: string; base64: string } | undefined>,
  openZhuque: (): Promise<void> => ipcRenderer.invoke("contentferry:open-zhuque") as Promise<void>,
  openWechatBackend: (target?: { accountId?: string; title: string; declareOriginal?: boolean; enableReward?: boolean; collectionName?: string }): Promise<void> => ipcRenderer.invoke("contentferry:open-wechat-backend", target) as Promise<void>,
  openContentAny: (): Promise<void> => ipcRenderer.invoke("contentferry:open-contentany") as Promise<void>,
  openUserGuide: (): Promise<void> => ipcRenderer.invoke("contentferry:open-user-guide") as Promise<void>,
  showLogFile: (date?: string): Promise<void> => ipcRenderer.invoke("contentferry:show-log-file", date) as Promise<void>,
  runZhuqueDetection: (markdown: string): Promise<ZhuqueDetectionResponse> =>
    ipcRenderer.invoke("contentferry:run-zhuque", markdown) as Promise<ZhuqueDetectionResponse>,
  runContentAnyDetection: (markdown: string): Promise<{ status: "completed" | "needs_user"; result?: string; reference?: { label: string; score: string | null; summary: string; detail: string }; message?: string }> =>
    ipcRenderer.invoke("contentferry:run-contentany", markdown) as Promise<{ status: "completed" | "needs_user"; result?: string; reference?: { label: string; score: string | null; summary: string; detail: string }; message?: string }>,
  app: {
    getSettings: (): Promise<AppSettingsContract> =>
      ipcRenderer.invoke("app:get-settings") as Promise<AppSettingsContract>,
    chooseDataDir: (): Promise<string | undefined> =>
      ipcRenderer.invoke("app:choose-data-dir") as Promise<string | undefined>,
    setDataDir: (target: string): Promise<AppSettingsContract> =>
      ipcRenderer.invoke("app:set-data-dir", target) as Promise<AppSettingsContract>,
    detectCodex: (): Promise<CodexStatusContract> =>
      ipcRenderer.invoke("app:detect-codex") as Promise<CodexStatusContract>,
    openCodexLogin: (): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke("app:open-codex-login") as Promise<{ ok: boolean; message?: string }>,
    completeFirstRun: (dataDir: string): Promise<AppSettingsContract> =>
      ipcRenderer.invoke("app:complete-first-run", dataDir) as Promise<AppSettingsContract>,
    updateSettings: (patch: Partial<AppSettingsContract>): Promise<AppSettingsContract> =>
      ipcRenderer.invoke("app:update-settings", patch) as Promise<AppSettingsContract>,
    relaunch: (): Promise<void> => ipcRenderer.invoke("app:relaunch") as Promise<void>
  }
});
