import { describe, expect, it } from "vitest";
import { FILL_CSDN_EDITOR_SCRIPT, FILL_CSDN_PUBLISH_DIALOG_SCRIPT, HAS_CSDN_PUBLISH_DIALOG_SCRIPT, fillCsdnEditor, fillCsdnPublishDialog, hasCsdnPublishDialog, missingCsdnRequiredPublishFields } from "./csdn-editor-filler";

describe("csdn-editor-filler", () => {
  it("exports the page-context function source", () => {
    expect(typeof FILL_CSDN_EDITOR_SCRIPT).toBe("string");
    expect(FILL_CSDN_EDITOR_SCRIPT.length).toBeGreaterThan(500);
  });

  it("switches to markdown mode before filling", () => {
    expect(FILL_CSDN_EDITOR_SCRIPT).toContain("switched-to-markdown");
    expect(FILL_CSDN_EDITOR_SCRIPT).toContain("markdown-already-active");
  });

  it("uses the visible CodeMirror instance with refresh/focus", () => {
    expect(FILL_CSDN_EDITOR_SCRIPT).toContain(".CodeMirror");
    expect(FILL_CSDN_EDITOR_SCRIPT).toContain("CodeMirror.setValue");
    expect(FILL_CSDN_EDITOR_SCRIPT).toContain("CodeMirror.refresh");
    expect(FILL_CSDN_EDITOR_SCRIPT).toContain("CodeMirror.focus");
  });

  it("normalizes CRLF/CR line endings to LF", () => {
 expect(FILL_CSDN_EDITOR_SCRIPT).toContain("\\r\\n");
    expect(FILL_CSDN_EDITOR_SCRIPT).toContain("replace(/\\r/g");
  });

  it("falls back to contenteditable preserving line breaks", () => {
    expect(FILL_CSDN_EDITOR_SCRIPT).toContain("fallback-contenteditable");
    expect(FILL_CSDN_EDITOR_SCRIPT).toContain("<br>");
    expect(FILL_CSDN_EDITOR_SCRIPT).toContain("insertHTML");
  });

  it("returns diagnostics about mode and editor detection", () => {
    expect(FILL_CSDN_EDITOR_SCRIPT).toContain("editorFound");
    expect(FILL_CSDN_EDITOR_SCRIPT).toContain("contentLength");
  });

  it("keeps the typed function available for direct inspection", () => {
    expect(typeof fillCsdnEditor).toBe("function");
  });

  describe("fillCsdnPublishDialog", () => {
    it("detects an already-open publish dialog before opening it again", () => {
      expect(typeof HAS_CSDN_PUBLISH_DIALOG_SCRIPT).toBe("string");
      expect(HAS_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("hasCsdnPublishDialog");
      expect(HAS_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("[role='dialog']");
      expect(HAS_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("文章摘要");
      expect(typeof hasCsdnPublishDialog).toBe("function");
    });

    it("returns true for an open publish modal and false when its final action is missing", () => {
      const originalDocument = globalThis.document;
      const originalWindow = globalThis.window;
      const button = {
        textContent: "发布文章",
        getBoundingClientRect: () => ({ width: 120, height: 36 })
      };
      const dialog = {
        textContent: "文章摘要发布文章",
        getBoundingClientRect: () => ({ width: 640, height: 480 }),
        querySelectorAll: () => [button]
      };
      globalThis.document = { querySelectorAll: () => [dialog] } as unknown as Document;
      globalThis.window = { getComputedStyle: () => ({ visibility: "visible" }) } as unknown as Window & typeof globalThis;
      try {
        expect(hasCsdnPublishDialog()).toBe(true);
        dialog.querySelectorAll = () => [];
        expect(hasCsdnPublishDialog()).toBe(false);
      } finally {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
      }
    });

    it("exports the page-context dialog fill function source", () => {
      expect(typeof FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toBe("string");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT.length).toBeGreaterThan(500);
    });

    it("detects the publish settings dialog by section labels", () => {
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("文章摘要");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("[role='dialog']");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("分类专栏");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("tagsSelected");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("可见范围");
    });

    it("locates each field by its label and climbs to the form group", () => {
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("fieldGroup");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("directText");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("exactFieldGroup");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("文章封面");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("添加封面");
    });

    it("fills the abstract from the draft digest", () => {
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("abstractFilled");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("args.digest");
    });

    it("uses source article tags with CSDN's autocomplete picker", () => {
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("args.tags");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("mark_selection[typename='tags']");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain('key: { value: "Enter" }');
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("selected.length >= 5");
    });

    it("attaches the cover and confirms CSDN's crop-upload step", () => {
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("coverHandled");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("findCoverFileInput");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("coverFileFromDataUrl");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("网络图片");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("本地上传");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("coverImgPresent");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("confirmCropUpload");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("file-input-crop-confirmed");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("file-input-crop-unconfirmed");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("file-input-crop-error");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("smart-cover-crop-error");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("cropUploadPending");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("all-failed");
      const cropPendingGuard = FILL_CSDN_PUBLISH_DIALOG_SCRIPT.indexOf('file-input-crop-unconfirmed');
      const previewShortcut = FILL_CSDN_PUBLISH_DIALOG_SCRIPT.indexOf('file-input-verified');
      expect(cropPendingGuard).toBeGreaterThanOrEqual(0);
      expect(previewShortcut).toBeGreaterThan(cropPendingGuard);
      const smartCropGuard = FILL_CSDN_PUBLISH_DIALOG_SCRIPT.indexOf('smart-cover-crop-unconfirmed');
      const smartPreviewShortcut = FILL_CSDN_PUBLISH_DIALOG_SCRIPT.indexOf('method: "smart-cover-fallback"');
      expect(smartPreviewShortcut).toBeGreaterThan(smartCropGuard);
      const fileCropError = FILL_CSDN_PUBLISH_DIALOG_SCRIPT.indexOf('file-input-crop-error');
      const smartCoverFallback = FILL_CSDN_PUBLISH_DIALOG_SCRIPT.indexOf('const smartCovers =');
      expect(smartCoverFallback).toBeGreaterThan(fileCropError);
      // We do NOT rely on a non-existent "smart cover" button.
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).not.toContain("智能封面");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("coverDataUrl");
    });

    it("selects 原创, 全部可见 and 多平台发布-否", () => {
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("原创");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("全部可见");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("多平台发布");
    });

    it("treats the category column as optional when CSDN does not mark it required", () => {
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("categorySelected");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("selectCategory");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("el-select-dropdown__item");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).not.toContain("默认专栏");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("optional-fields-unavailable");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).not.toContain('...(\n    !result.categorySelected ? ["分类专栏"] : []\n  )');
    });

    it("clicks the final publish button inside the dialog", () => {
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("publishButtonFound");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("submitClicked");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("发布文章");
    });

    it("blocks submission when the required cover is unavailable", () => {
      const missing = missingCsdnRequiredPublishFields(
        { digest: "摘要", coverDataUrl: "data:image/png;base64,AA==" },
        {
          abstractFilled: true,
          typeSelected: true,
          visibilitySelected: true,
          crossPublishSelected: true,
          tagsSelected: true,
          coverHandled: false
        }
      );
      expect(missing).toEqual(["文章封面"]);
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT.indexOf("if (missingRequired.length > 0)")).toBeLessThan(
        FILL_CSDN_PUBLISH_DIALOG_SCRIPT.lastIndexOf("target.click()")
      );
    });

    it("prevents duplicate handling via a window flag", () => {
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("__contentFerryCsdnDialogHandled");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("already-handled");
    });

    it("keeps the typed function available for direct inspection", () => {
      expect(typeof fillCsdnPublishDialog).toBe("function");
    });
  });
});
