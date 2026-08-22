import { lazy, StrictMode, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { loadSettings } from "./api";
import type { AppSettingsContract, RootState } from "./types";
import { App } from "./App";

// 对外保持原有导出签名不变
export { apiBase, platformName, request } from "./api";
export { extractMarkdownImages, renderPhonePreview, resolveArticleImageUrl } from "./markdown-preview";

const FirstRunWizard = lazy(() =>
  import("./components/FirstRunWizard").then((module) => ({ default: module.FirstRunWizard }))
);

function Root() {
  const [state, setState] = useState<RootState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void loadSettings().then((settings) => {
      if (cancelled) return;
      if (settings.firstRunCompleted) {
        setState({ status: "ready", settings });
      } else {
        setState({ status: "wizard", settings });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          color: "#64748b",
          fontSize: ".9rem"
        }}
      >
        正在加载文渡…
      </div>
    );
  }

  if (state.status === "wizard") {
    return (
      <Suspense fallback={<div style={{ padding: "3rem" }}>正在准备首次启动…</div>}>
        <FirstRunWizard
          onCompleted={(settings) => {
            setState({ status: "ready", settings });
          }}
        />
      </Suspense>
    );
  }

  return <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
