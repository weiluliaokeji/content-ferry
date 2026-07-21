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

contextBridge.exposeInMainWorld("contentFerry", {
  apiBaseUrl: "http://127.0.0.1:4317",
  selectDirectory: (): Promise<string | undefined> => ipcRenderer.invoke("contentferry:select-directory") as Promise<string | undefined>,
  selectImage: (): Promise<{ fileName: string; mimeType: string; base64: string } | undefined> =>
    ipcRenderer.invoke("contentferry:select-image") as Promise<{ fileName: string; mimeType: string; base64: string } | undefined>,
  openZhuque: (): Promise<void> => ipcRenderer.invoke("contentferry:open-zhuque") as Promise<void>,
  openWechatBackend: (): Promise<void> => ipcRenderer.invoke("contentferry:open-wechat-backend") as Promise<void>,
  openContentAny: (): Promise<void> => ipcRenderer.invoke("contentferry:open-contentany") as Promise<void>,
  showLogFile: (date?: string): Promise<void> => ipcRenderer.invoke("contentferry:show-log-file", date) as Promise<void>,
  runZhuqueDetection: (markdown: string): Promise<ZhuqueDetectionResponse> =>
    ipcRenderer.invoke("contentferry:run-zhuque", markdown) as Promise<ZhuqueDetectionResponse>,
  runContentAnyDetection: (markdown: string): Promise<{ status: "completed" | "needs_user"; result?: string; message?: string }> =>
    ipcRenderer.invoke("contentferry:run-contentany", markdown) as Promise<{ status: "completed" | "needs_user"; result?: string; message?: string }>
});
