import { useEffect, useMemo, useReducer, useState } from "react";

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

type StepId = "welcome" | "data-dir" | "ai-init" | "done";

type State = {
  step: StepId;
  settings: AppSettings | null;
  codexStatus: CodexStatus | null;
  codexDetecting: boolean;
  codexLoggingIn: boolean;
  completing: boolean;
  errorMessage: string;
  noticeMessage: string;
};

type Action =
  | { type: "load"; settings: AppSettings }
  | { type: "set-step"; step: StepId }
  | { type: "set-data-dir"; dataDir: string; settings: AppSettings }
  | { type: "codex-detecting" }
  | { type: "codex-detected"; status: CodexStatus; settings: AppSettings }
  | { type: "codex-login" }
  | { type: "codex-login-result"; ok: boolean; message?: string; settings: AppSettings }
  | { type: "completing" }
  | { type: "complete" }
  | { type: "error"; message: string };

const initialState: State = {
  step: "welcome",
  settings: null,
  codexStatus: null,
  codexDetecting: false,
  codexLoggingIn: false,
  completing: false,
  errorMessage: "",
  noticeMessage: ""
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "load":
      return { ...state, settings: action.settings };
    case "set-step":
      return { ...state, step: action.step, errorMessage: "" };
    case "set-data-dir":
      return { ...state, settings: action.settings };
    case "codex-detecting":
      return { ...state, codexDetecting: true, codexStatus: null, errorMessage: "", noticeMessage: "" };
    case "codex-detected":
      return {
        ...state,
        codexDetecting: false,
        codexStatus: action.status,
        settings: action.settings
      };
    case "codex-login":
      return { ...state, codexLoggingIn: true, errorMessage: "" };
    case "codex-login-result":
      return {
        ...state,
        codexLoggingIn: false,
        settings: action.settings,
        noticeMessage: action.message ?? "OAuth 授权窗口已启动。完成授权后请点击重新检测。"
      };
    case "completing":
      return { ...state, completing: true, errorMessage: "" };
    case "complete":
      return { ...state, completing: false };
    case "error":
      return { ...state, errorMessage: action.message, codexDetecting: false, codexLoggingIn: false, completing: false };
    default:
      return state;
  }
}

const STEP_ORDER: StepId[] = ["welcome", "data-dir", "ai-init", "done"];
const STEP_LABEL: Record<StepId, string> = {
  welcome: "欢迎",
  "data-dir": "数据目录",
  "ai-init": "AI 服务",
  done: "完成"
};

function defaultRecommendedDir(): string {
  // Mirrors src/main/config/first-run.ts defaultSettings(); the renderer's
  // `getSettings` call already returns this, so the value is only used as a
  // placeholder before settings have loaded.
  return "默认位置（应用数据目录下的 data 文件夹）";
}

type WizardProps = {
  onCompleted: (settings: AppSettings) => void;
};

export function FirstRunWizard({ onCompleted }: WizardProps) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [busy, setBusy] = useState(false);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    if (!window.contentFerry) {
      dispatch({ type: "error", message: "预加载脚本未加载，请重启文渡。" });
      return;
    }
    (async () => {
      try {
        const settings = (await window.contentFerry!.app.getSettings()) as AppSettings;
        if (cancelled) return;
        dispatch({ type: "load", settings });
      } catch (error) {
        if (cancelled) return;
        dispatch({
          type: "error",
          message: error instanceof Error ? error.message : "无法读取应用设置。"
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const stepIndex = STEP_ORDER.indexOf(state.step);
  const canGoBack = stepIndex > 0 && state.step !== "done" && !state.completing;

  const goBack = () => {
    if (!canGoBack) return;
    const previous = STEP_ORDER[stepIndex - 1];
    dispatch({ type: "set-step", step: previous });
  };

  const goNext = () => {
    if (stepIndex >= STEP_ORDER.length - 1) return;
    const next = STEP_ORDER[stepIndex + 1];
    if (next === "ai-init") {
      // Run codex detection the first time we land on this step.
      if (!state.codexStatus && !state.codexDetecting) void runCodexDetection();
    }
    dispatch({ type: "set-step", step: next });
  };

  const runCodexDetection = async () => {
    if (!window.contentFerry) return;
    dispatch({ type: "codex-detecting" });
    try {
      const status = (await window.contentFerry.app.detectCodex()) as CodexStatus;
      const refreshed = (await window.contentFerry.app.getSettings()) as AppSettings;
      dispatch({ type: "codex-detected", status, settings: refreshed });
    } catch (error) {
      dispatch({
        type: "error",
        message: error instanceof Error ? error.message : "无法检测 Codex 安装情况。"
      });
    }
  };

  const pickDataDir = async () => {
    if (!window.contentFerry) return;
    setBusy(true);
    try {
      const chosen = await window.contentFerry.app.chooseDataDir();
      if (!chosen) return;
      const updated = (await window.contentFerry.app.setDataDir(chosen)) as AppSettings;
      dispatch({ type: "set-data-dir", dataDir: updated.dataDir, settings: updated });
    } catch (error) {
      dispatch({
        type: "error",
        message: error instanceof Error ? error.message : "无法保存数据目录。"
      });
    } finally {
      setBusy(false);
    }
  };

  const triggerCodexLogin = async () => {
    if (!window.contentFerry) return;
    dispatch({ type: "codex-login" });
    try {
      const result = (await window.contentFerry.app.openCodexLogin()) as { ok: boolean; message?: string };
      const refreshed = (await window.contentFerry.app.getSettings()) as AppSettings;
      dispatch({ type: "codex-login-result", ok: result.ok, message: result.message, settings: refreshed });
    } catch (error) {
      dispatch({
        type: "error",
        message: error instanceof Error ? error.message : "无法启动 Codex 登录。"
      });
    }
  };

  const completeWizard = async () => {
    if (!window.contentFerry || !state.settings) return;
    dispatch({ type: "completing" });
    try {
      const updated = (await window.contentFerry.app.completeFirstRun(state.settings.dataDir)) as AppSettings;
      dispatch({ type: "set-step", step: "done" });
      dispatch({ type: "complete" });
      // The main process has already started the local service with the
      // selected data directory. Briefly confirm completion, then enter the
      // workspace in this window; portable builds no longer need to relaunch.
      setTimeout(() => {
        onCompleted(updated);
      }, 500);
    } catch (error) {
      dispatch({
        type: "error",
        message: error instanceof Error ? error.message : "无法完成首次启动。"
      });
    }
  };

  const settings = state.settings;
  const dataDirDisplay = settings?.dataDir ?? defaultRecommendedDir();

  const stepTitle = useMemo(() => STEP_LABEL[state.step], [state.step]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "grid",
        placeItems: "center",
        background: "linear-gradient(135deg, #f5f7fb 0%, #e8edf8 100%)",
        fontFamily: "Microsoft YaHei, system-ui, sans-serif",
        color: "#172033"
      }}
    >
      <div
        style={{
          width: "min(640px, 92vw)",
          maxHeight: "92vh",
          overflowY: "auto",
          background: "#fff",
          borderRadius: 18,
          boxShadow: "0 24px 64px rgb(24 39 75 / 14%)",
          padding: "2.5rem 2.75rem 2rem"
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            marginBottom: "1.25rem"
          }}
        >
          <div>
            <p className="eyebrow" style={{ margin: 0 }}>
              首次启动
            </p>
            <h1 style={{ margin: ".25rem 0 0" }}>{stepTitle}</h1>
          </div>
          <StepIndicator current={state.step} />
        </div>

        {state.errorMessage ? (
          <div
            style={{
              padding: ".85rem 1rem",
              borderRadius: 10,
              border: "1px solid #f3c7c0",
              background: "#fff4f2",
              color: "#a4262c",
              marginBottom: "1rem"
            }}
          >
            {state.errorMessage}
          </div>
        ) : null}
        {state.noticeMessage ? <div style={{ padding: ".75rem 1rem", borderRadius: 10, border: "1px solid #bdd2ff", background: "#f2f6ff", color: "#244b9b", marginBottom: "1rem" }}>{state.noticeMessage}</div> : null}

        {state.step === "welcome" ? (
          <WelcomeStep />
        ) : state.step === "data-dir" ? (
          <DataDirStep
            dataDir={dataDirDisplay}
            recommended={dataDirDisplay}
            onPick={pickDataDir}
            busy={busy}
          />
        ) : state.step === "ai-init" ? (
          <AiInitStep
            status={state.codexStatus}
            detecting={state.codexDetecting}
            loggingIn={state.codexLoggingIn}
            onDetect={runCodexDetection}
            onLogin={triggerCodexLogin}
          />
        ) : (
          <DoneStep dataDir={dataDirDisplay} settings={settings} />
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: "2rem",
            gap: "1rem"
          }}
        >
          <button
            type="button"
            className="secondary-button"
            onClick={goBack}
            disabled={!canGoBack}
            style={{ visibility: canGoBack ? "visible" : "hidden" }}
          >
            上一步
          </button>

          {state.step === "welcome" ? (
            <button type="button" onClick={goNext}>
              开始
            </button>
          ) : state.step === "data-dir" ? (
            <button type="button" onClick={goNext} disabled={!settings || busy}>
              下一步：AI 服务
            </button>
          ) : state.step === "ai-init" ? (
            <button
              type="button"
              onClick={completeWizard}
              disabled={!settings || state.codexDetecting || state.completing}
            >
              {state.completing ? "正在初始化工作台…" : "完成设置并进入文渡"}
            </button>
          ) : (
            <span className="muted" style={{ fontSize: ".85rem" }}>
              {state.completing ? "正在完成…" : "文渡即将重启…"}
            </span>
          )}
        </div>

        {state.step === "data-dir" ? (
          <p className="muted" style={{ marginTop: "1.5rem", borderTop: "1px dashed #e2e8f2", paddingTop: "1rem", fontSize: ".82rem" }}>
            当前选择会保存到 <code>app-settings.json</code>，卸载时不会被删除。
          </p>
        ) : null}
      </div>
    </div>
  );
}

function StepIndicator({ current }: { current: StepId }) {
  const index = STEP_ORDER.indexOf(current);
  return (
    <ol
      style={{
        display: "flex",
        gap: ".45rem",
        listStyle: "none",
        padding: 0,
        margin: 0,
        alignItems: "center"
      }}
    >
      {STEP_ORDER.map((step, idx) => {
        const active = idx === index;
        const completed = idx < index;
        return (
          <li
            key={step}
            style={{
              display: "flex",
              alignItems: "center",
              gap: ".35rem"
            }}
          >
            <span
              style={{
                display: "inline-flex",
                justifyContent: "center",
                alignItems: "center",
                width: 24,
                height: 24,
                borderRadius: 999,
                fontSize: ".75rem",
                fontWeight: 600,
                background: active || completed ? "#315bd8" : "#e2e8f2",
                color: active || completed ? "#fff" : "#64748b"
              }}
            >
              {idx + 1}
            </span>
            {idx < STEP_ORDER.length - 1 ? (
              <span
                style={{
                  width: 18,
                  height: 2,
                  background: completed ? "#315bd8" : "#e2e8f2"
                }}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function WelcomeStep() {
  return (
    <div>
      <p className="lead">
        欢迎使用文渡（ContentFerry）。在开始之前，文渡会做两件小事：
      </p>
      <ol style={{ paddingLeft: "1.4rem", lineHeight: 1.85, color: "#44516a" }}>
        <li>让你选择一个用来保存数据库、文章和素材的文件夹；</li>
        <li>可选地检查 OpenAI Codex；也可以跳过，进入应用后再选择其他模型提供商。</li>
      </ol>
      <p className="muted" style={{ fontSize: ".85rem" }}>
        整个过程约需要 1 分钟，AI 登录可以稍后再做。
      </p>
    </div>
  );
}

function DataDirStep({
  dataDir,
  recommended,
  onPick,
  busy
}: {
  dataDir: string;
  recommended: string;
  onPick: () => void;
  busy: boolean;
}) {
  return (
    <div>
      <p className="lead">
        文渡会把数据库、内部素材和运行日志放在一个专属文件夹里。建议保持默认位置，除非你希望把数据放到其他磁盘。
      </p>
      <div
        style={{
          marginTop: "1rem",
          padding: "1rem 1.1rem",
          borderRadius: 12,
          background: "#f8fafc",
          border: "1px solid #e2e8f2"
        }}
      >
        <p style={{ margin: 0, color: "#44516a", fontSize: ".85rem" }}>当前选择</p>
        <p
          style={{
            margin: ".35rem 0 0",
            fontFamily: "Consolas, monospace",
            fontSize: ".92rem",
            wordBreak: "break-all"
          }}
        >
          {dataDir}
        </p>
      </div>
      <div style={{ marginTop: "1rem", display: "flex", gap: ".75rem" }}>
        <button type="button" onClick={onPick} disabled={busy}>
          {busy ? "处理中…" : "选择其他位置…"}
        </button>
        <span className="muted" style={{ fontSize: ".82rem", alignSelf: "center" }}>
          推荐：{recommended === dataDir ? "当前已是默认位置" : recommended}
        </span>
      </div>
      <p className="muted" style={{ marginTop: "1rem", fontSize: ".8rem" }}>
        卸载文渡时这个文件夹不会被删除；以后可以在设置里迁移。
      </p>
    </div>
  );
}

function AiInitStep({
  status,
  detecting,
  loggingIn,
  onDetect,
  onLogin
}: {
  status: CodexStatus | null;
  detecting: boolean;
  loggingIn: boolean;
  onDetect: () => void;
  onLogin: () => void;
}) {
  return (
    <div>
      <p className="lead">
        AI 服务是可选能力，不影响你先进入文渡管理和编辑本地文章。OpenAI Codex 是预置选项之一，也可以稍后添加任意 OpenAI 兼容端点作为自定义连接（如 OpenAI API、OpenRouter、GitHub Copilot 等）。
      </p>

      {detecting ? (
        <p className="muted" style={{ marginTop: "1rem" }}>
          正在检查 Codex 运行文件…
        </p>
      ) : status?.ok && status.authenticated ? (
        <div
          style={{
            marginTop: "1rem",
            padding: "1rem 1.1rem",
            borderRadius: 12,
            background: "#e9f8ef",
            border: "1px solid #b8e6c8",
            color: "#18794e"
          }}
        >
          <p style={{ margin: 0, fontWeight: 600 }}>OpenAI Codex 已登录</p>
          <p
            style={{
              margin: ".35rem 0 0",
              fontFamily: "Consolas, monospace",
              fontSize: ".78rem",
              wordBreak: "break-all"
            }}
          >
            {status.binaryPath}
          </p>
          <p style={{ marginTop: ".75rem", fontSize: ".85rem" }}>认证方式：{status.authMethod || "ChatGPT OAuth"}</p>
          <button type="button" className="secondary-button" onClick={onDetect}>重新检测登录状态</button>
          <p style={{ marginTop: ".85rem", fontSize: ".82rem" }}>
            登录可以在设置 → 模型与技能里重新触发。如果暂时没有 ChatGPT 账号，可以先跳过，文渡仍能用于本地文章库。
          </p>
        </div>
      ) : status?.ok ? (
        <div style={{ marginTop: "1rem", padding: "1rem 1.1rem", borderRadius: 12, background: "#fff4e5", border: "1px solid #f3d59b", color: "#7a5310" }}>
          <p style={{ margin: 0, fontWeight: 600 }}>Codex 组件已找到，但尚未登录</p>
          <p style={{ margin: ".5rem 0", fontFamily: "Consolas, monospace", fontSize: ".76rem", wordBreak: "break-all" }}>{status.binaryPath}</p>
          <p style={{ margin: ".5rem 0 .85rem", fontSize: ".85rem" }}>点击授权会运行 <code>codex login --device-auth</code>，请在打开的授权窗口中按照提示完成 ChatGPT OAuth。也可以跳过。</p>
          <div style={{ display: "flex", gap: ".75rem" }}><button type="button" onClick={onLogin} disabled={loggingIn}>{loggingIn ? "正在启动 OAuth…" : "使用 ChatGPT OAuth 授权"}</button><button type="button" className="secondary-button" onClick={onDetect}>重新检测</button></div>
        </div>
      ) : (
        <div
          style={{
            marginTop: "1rem",
            padding: "1rem 1.1rem",
            borderRadius: 12,
            background: "#fff4e5",
            border: "1px solid #f3d59b",
            color: "#7a5310"
          }}
        >
          <p style={{ margin: 0, fontWeight: 600 }}>OpenAI Codex 暂未就绪（可跳过）</p>
          <p style={{ margin: ".35rem 0 .85rem", fontSize: ".85rem" }}>
            {status?.reason ?? "你可以继续完成首次启动，稍后在“技能与模型”中选择和配置模型提供商。"}
          </p>
          <button type="button" className="secondary-button" onClick={onDetect}>
            再次检测
          </button>
        </div>
      )}
    </div>
  );
}

function DoneStep({ dataDir, settings }: { dataDir: string; settings: AppSettings | null }) {
  return (
    <div>
      <p className="lead" style={{ color: "#18794e", fontWeight: 600 }}>
        准备工作完成，正在进入文渡工作台。
      </p>
      <ul style={{ paddingLeft: "1.2rem", lineHeight: 1.85, color: "#44516a" }}>
        <li>
          数据目录：<code>{dataDir}</code>
        </li>
        <li>AI 状态：{settings?.aiInitStatus ?? "not_initialized"}</li>
      </ul>
    </div>
  );
}
