import { useRef, useState } from "react";
import type { SelectedImage } from "../types";
import { clamp } from "../utils";

// 文章封面与正文图片裁剪弹窗（自 main.tsx 拆分）
export function CoverCropModal({ image, onCancel, onConfirm, purpose = "cover" }: {
  image: SelectedImage;
  onCancel: () => void;
  onConfirm: (image: SelectedImage) => void | Promise<void>;
  purpose?: "cover" | "body";
}) {
  const [sourceAspect, setSourceAspect] = useState(16 / 9);
  const [targetAspect, setTargetAspect] = useState(purpose === "cover" ? 16 / 9 : undefined);
  const [selection, setSelection] = useState({ x: 10, y: 10, width: 80 });
  const [working, setWorking] = useState(false);
  const interaction = useRef<{ kind: "move" | "resize"; startX: number; startY: number; selection: typeof selection } | undefined>(undefined);
  const source = `data:${image.mimeType};base64,${image.base64}`;
  const outputAspect = targetAspect ?? sourceAspect;
  const selectionHeight = selection.width * sourceAspect / outputAspect;
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
      const height = active.selection.width * sourceAspect / outputAspect;
      setSelection({ ...active.selection,
        x: clamp(active.selection.x + dx, 0, 100 - active.selection.width),
        y: clamp(active.selection.y + dy, 0, 100 - height)
      });
    } else {
      const maxByX = 100 - active.selection.x;
      const maxByY = (100 - active.selection.y) * outputAspect / sourceAspect;
      const width = clamp(active.selection.width + dx, 20, Math.min(maxByX, maxByY));
      setSelection({ ...active.selection, width });
    }
  };
  const confirm = async () => {
    setWorking(true);
    try {
      await onConfirm(await cropImage(image, selection.x, selection.y, selection.width, selectionHeight, outputAspect, purpose));
    } finally {
      setWorking(false);
    }
  };
  const heading = purpose === "cover" ? "裁剪文章封面" : "裁剪正文图片";
  return <div className="modal-backdrop crop-backdrop" role="presentation"><section className="modal-card crop-modal" role="dialog" aria-modal="true" aria-label={heading}><div className="section-heading"><div><p className="eyebrow">{purpose === "cover" ? "16:9 微信封面" : "保持原图比例"}</p><h2>拖动方框选择{purpose === "cover" ? "封面" : "正文图片"}区域</h2></div></div><div className="crop-stage" style={{ aspectRatio: String(sourceAspect) }}><img src={source} alt="待裁剪图片" onLoad={(event) => {
    const aspect = event.currentTarget.naturalWidth / event.currentTarget.naturalHeight;
    setSourceAspect(aspect);
    const nextAspect = targetAspect ?? aspect;
    setTargetAspect(nextAspect);
    const width = Math.min(80, 80 * nextAspect / aspect);
    const height = width * aspect / nextAspect;
    setSelection({ x: (100 - width) / 2, y: (100 - height) / 2, width });
  }} /><div className="crop-shade" /><div className="crop-selection" style={{ left: `${selection.x}%`, top: `${selection.y}%`, width: `${selection.width}%`, height: `${selectionHeight}%` }} onPointerDown={(event) => startInteraction(event, "move")} onPointerMove={moveInteraction} onPointerUp={() => { interaction.current = undefined; }}><span>拖动调整位置</span><div className="crop-resize-handle" onPointerDown={(event) => startInteraction(event, "resize")} onPointerMove={moveInteraction} onPointerUp={() => { interaction.current = undefined; }} /></div></div><p className="hint">拖动蓝色方框调整位置，拖动右下角控制点改变取景范围。{purpose === "cover" ? "封面会生成 1280×720 图片，原图保留。" : "正文图片保持原图比例，生成新版本并保留原图与来源关系。"}</p><div className="modal-actions"><button className="secondary-button" onClick={onCancel} disabled={working}>取消</button><button onClick={() => void confirm()} disabled={working}>{working ? "正在裁剪…" : purpose === "cover" ? "确认使用此区域" : "裁剪并替换正文图片"}</button></div></section></div>;
}

export async function cropImageTo16x9(image: SelectedImage, x: number, y: number, width: number, height: number): Promise<SelectedImage> {
  return cropImage(image, x, y, width, height, 16 / 9, "cover");
}

async function cropImage(image: SelectedImage, x: number, y: number, width: number, height: number, aspect: number, purpose: "cover" | "body"): Promise<SelectedImage> {
  const element = new Image();
  element.src = `data:${image.mimeType};base64,${image.base64}`;
  await element.decode();
  const cropWidth = element.naturalWidth * width / 100;
  const cropHeight = element.naturalHeight * height / 100;
  const sourceX = element.naturalWidth * x / 100;
  const sourceY = element.naturalHeight * y / 100;
  const canvas = document.createElement("canvas");
  const maxDimension = purpose === "cover" ? 1280 : 1600;
  canvas.width = aspect >= 1 ? maxDimension : Math.round(maxDimension * aspect);
  canvas.height = aspect >= 1 ? Math.round(maxDimension / aspect) : maxDimension;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前环境无法裁剪图片。");
  context.drawImage(element, sourceX, sourceY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
  return {
    fileName: image.fileName.replace(/\.[^.]+$/, "") + (purpose === "cover" ? "-cover.jpg" : "-crop.jpg"),
    mimeType: "image/jpeg",
    base64: canvas.toDataURL("image/jpeg", .9).split(",", 2)[1]
  };
}
