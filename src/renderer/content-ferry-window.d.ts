export {};

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
    };
  }
}
