// 工作区加载占位（自 main.tsx 拆分）
export function WorkspaceLoading({ title, message, onBack }: { title: string; message: string; onBack: () => void }) {
  return <div className="editor-workspace"><header className="editor-topbar"><button className="secondary-button" onClick={onBack}>← 返回内容库</button><div className="editor-document-title"><strong>{title}</strong><small>文渡创作工作台</small></div><span /></header><div className="workspace-loading"><div className="loading-dot" /><p>{message}</p></div></div>;
}

