import { describe, expect, it } from "vitest";
import { FILL_CSDN_EDITOR_SCRIPT, FILL_CSDN_PUBLISH_DIALOG_SCRIPT, fillCsdnEditor, fillCsdnPublishDialog } from "./csdn-editor-filler";

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
    it("exports the page-context dialog fill function source", () => {
      expect(typeof FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toBe("string");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT.length).toBeGreaterThan(500);
    });

    it("detects the publish settings dialog by section labels", () => {
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("文章摘要");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("文章标签");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("分类专栏");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("可见范围");
    });

    it("locates each field by its label and climbs to the form group", () => {
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("fieldGroup");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("directText");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("文章封面");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("添加封面");
    });

    it("fills the abstract from the draft digest", () => {
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("abstractFilled");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("args.digest");
    });

    it("attaches the cover via network-image URL first, then file-input fallback", () => {
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("coverHandled");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("findCoverFileInput");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("coverFileFromDataUrl");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("网络图片");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("本地上传");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("coverImgPresent");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("all-failed");
      // We do NOT rely on a non-existent "smart cover" button.
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).not.toContain("智能封面");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("coverDataUrl");
    });

    it("selects 原创, 全部可见 and 多平台发布-否", () => {
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("原创");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("全部可见");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("多平台发布");
    });

    it("auto-selects a category column (required field, missing it causes CSDN rejection)", () => {
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("categorySelected");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("selectCategory");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("el-select-dropdown__item");
    });

    it("clicks the final publish button inside the dialog", () => {
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("publishButtonFound");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("submitClicked");
      expect(FILL_CSDN_PUBLISH_DIALOG_SCRIPT).toContain("发布文章");
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
