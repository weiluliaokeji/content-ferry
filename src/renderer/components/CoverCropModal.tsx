import { useRef, useState } from "react";
import type { SelectedImage } from "../types";
import { clamp } from "../utils";

// 16:9 封面裁剪弹窗（自 main.tsx 拆分）
export function CoverCropModal({ image, onCancel, onConfirm }: {
  image: SelectedImage;
  onCancel: () => void;
  onConfirm: (image: SelectedImage) => void;
}) {
  const [sourceAspect, setSourceAspect] = useState(16 / 9);
  const [selection, setSelection] = useState({ x: 10, y: 10, width: 80 });
  const [working, setWorking] = useState(false);
  const interaction = useRef<{ kind: "move" | "resize"; startX: number; startY: number; selection: typeof selection } | undefined>(undefined);
  const source = `data:${image.mimeType};base64,${image.base64}`;
  const selectionHeight = selection.width * sourceAspect / (16 / 9);
  const startInteraction = (event: React.PointerEvent<HTMLDivElement>, kind: "move" | "resize") => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    interaction.current = { kind, startX: event.clientX, startY: event.clientY, selection };
  };
  const moveInteraction = (event: React.PointerEvent<HTMLDivElement>) => {
    const active = interaction.current;
    const stage = event.currentTarget.closest(".crop-stage") as HTMLElement | null;
    if (!active || !stage) return;
    const bounds = stage.getBoundingClientRect();
    const dx = (event.clientX - active.startX) / bounds.width * 100;
    const dy = (event.clientY - active.startY) / bounds.height * 100;
    if (active.kind === "move") {
      const height = active.selection.width * sourceAspect / (16 / 9);
      setSelection({ ...active.selection,
        x: clamp(active.selection.x + dx, 0, 100 - active.selection.width),
        y: clamp(active.selection.y + dy, 0, 100 - height)
      });
    } else {
      const maxByX = 100 - active.selection.x;
      const maxByY = (100 - active.selection.y) * (16 / 9) / sourceAspect;
      const width = clamp(active.selection.width + dx, 20, Math.min(maxByX, maxByY));
      setSelection({ ...active.selection, width });
    }
  };
  const confirm = async () => {
    setWorking(true);
    try {
      onConfirm(await cropImageTo16x9(image, selection.x, selection.y, selection.width, selectionHeight));
    } finally {
      setWorking(false);
    }
  };
  return <div className="modal-backdrop crop-backdrop" role="presentation"><section className="modal-card crop-modal" role="dialog" aria-modal="true" aria-label="裁剪文章封面"><div className="section-heading"><div><p className="eyebrow">16:9 微信封面</p><h2>拖动方框选择封面区域</h2></div></div><div className="crop-stage" style={{ aspectRatio: String(sourceAspect) }}><img src={source} alt="待裁剪封面" onLoad={(event) => {
    const aspect = event.currentTarget.naturalWidth / event.currentTarget.naturalHeight;
    setSourceAspect(aspect);
    const width = Math.min(80, 80 * (16 / 9) / aspect);
    const height = width * aspect / (16 / 9);
    setSelection({ x: (100 - width) / 2, y: (100 - height) / 2, width });
  }} /><div className="crop-shade" /><div className="crop-selection" style={{ left: `${selection.x}%`, top: `${selection.y}%`, width: `${selection.width}%`, height: `${selectionHeight}%` }} onPointerDown={(event) => startInteraction(event, "move")} onPointerMove={moveInteraction} onPointerUp={() => { interaction.current = undefined; }}><span>拖动调整位置</span><div className="crop-resize-handle" onPointerDown={(event) => startInteraction(event, "resize")} onPointerMove={moveInteraction} onPointerUp={() => { interaction.current = undefined; }} /></div></div><p className="hint">拖动蓝色方框调整位置，拖动右下角控制点改变取景范围。确认后生成 1280×720 封面，不修改原图。</p><div className="modal-actions"><button className="secondary-button" onClick={onCancel} disabled={working}>取消</button><button onClick={() => void confirm()} disabled={working}>{working ? "正在裁剪…" : "确认使用此区域"}</button></div></section></div>;
}

export async function cropImageTo16x9(image: SelectedImage, x: number, y: number, width: number, height: number): Promise<SelectedImage> {
  const element = new Image();
  element.src = `data:${image.mimeType};base64,${image.base64}`;
  await element.decode();
  const cropWidth = element.naturalWidth * width / 100;
  const cropHeight = element.naturalHeight * height / 100;
  const sourceX = element.naturalWidth * x / 100;
  const sourceY = element.naturalHeight * y / 100;
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前环境无法裁剪图片。");
  context.drawImage(element, sourceX, sourceY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
  return {
    fileName: image.fileName.replace(/\.[^.]+$/, "") + "-cover.jpg",
    mimeType: "image/jpeg",
    base64: canvas.toDataURL("image/jpeg", .9).split(",", 2)[1]
  };
}

