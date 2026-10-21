/* eslint-disable @typescript-eslint/no-explicit-any */
// This file describes a function that runs inside the CSDN editor page, so it
// references browser globals (`document`, `window`). We declare them as `any`
// here (module-scoped) rather than pulling in the DOM lib, which would collide
// with undici's fetch types used elsewhere in the main process.
declare const document: any;
declare const window: any;

/**
 * Page-context script for filling the CSDN editor with a title and Markdown body.
 *
 * The function is serialized to a string and executed inside the CSDN editor page
 * via `webContents.executeJavaScript`. It is intentionally self-contained and
 * references only browser globals (`document`, `window`) so that `.toString()`
 * produces valid page code and the TypeScript main-process build never sees DOM
 * types.
 *
 * Problem it fixes: CSDN's editor defaults to rich-text mode. If we paste raw
 * Markdown into the rich-text area, block syntax (`###`, `*`, `>`) is treated as
 * plain text and collapses into paragraphs. We therefore:
 * 1. Switch to the Markdown tab if it exists and is not active.
 * 2. Find the *visible* CodeMirror instance (CSDN may have hidden placeholders).
 * 3. Normalize line endings to LF and use `setValue` + `refresh` + `focus`.
 * 4. Fall back to a contenteditable, preserving line breaks as `<br>`.
 */
export function fillCsdnEditor(args: { title: string; markdown: string }): {
  title: boolean;
  content: boolean;
  mode: string | null;
  editorFound: boolean;
  contentLength: number;
} {
  const title = args.title;
  let markdown = args.markdown;
  // CSDN's markdown parser treats CRLF/CR inconsistently; normalize to LF so
  // headings and list markers stay at the start of a line.
  markdown = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const result = {
    title: false,
    content: false,
    mode: null as string | null,
    editorFound: false,
    contentLength: 0
  };

  function setValue(el: any, value: string) {
    try {
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) {
        desc.set.call(el, value);
      } else {
        el.value = value;
      }
    } catch {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // 1. Title field.
  const titleEl =
    document.querySelector("input.title") ||
    document.querySelector('input[placeholder*="标题"]') ||
    document.querySelector("#title");
  if (titleEl) {
    setValue(titleEl, title);
    result.title = (titleEl.value || "").length > 0;
  }

  // 2. Ensure Markdown mode. CSDN may start in rich-text mode, in which case
  //    raw Markdown pasted into the contenteditable is rendered as plain text.
  const allTabs = Array.prototype.slice.call(
    document.querySelectorAll("button, a, .btn, .tab-item, [role='tab']")
  ) as any[];
  const markdownTab = allTabs.find((el) => /Markdown|markdown|MD/i.test((el.textContent || "").trim()));
  if (markdownTab) {
    const isActive =
      markdownTab.classList.contains("active") ||
      markdownTab.getAttribute("aria-selected") === "true" ||
      markdownTab.classList.contains("selected") ||
      (window.getComputedStyle && window.getComputedStyle(markdownTab).fontWeight === "700");
    if (!isActive) {
      markdownTab.click();
      result.mode = "switched-to-markdown";
    } else {
      result.mode = "markdown-already-active";
    }
  } else {
    result.mode = "no-markdown-tab";
  }

  // 3. Find the visible CodeMirror instance and fill it. Retry a few times if
  //    we just switched tabs and the instance is not yet mounted.
  function tryFillCodeMirror(): boolean {
    const cms = Array.prototype.slice.call(document.querySelectorAll(".CodeMirror")) as any[];
    const visibleCms = cms
      .filter((cm) => {
        const rect = cm.getBoundingClientRect();
        return rect.width > 80 && rect.height > 80;
      })
      .sort((a, b) => {
        const areaA = a.getBoundingClientRect().width * a.getBoundingClientRect().height;
        const areaB = b.getBoundingClientRect().width * b.getBoundingClientRect().height;
        return areaB - areaA;
      });
    const cm = visibleCms[0] as any;
    if (cm && cm.CodeMirror) {
      cm.CodeMirror.setValue(markdown);
      cm.CodeMirror.refresh();
      cm.CodeMirror.focus();
      const value = cm.CodeMirror.getValue() || "";
      result.content = value.length > 0;
      result.contentLength = value.length;
      result.editorFound = true;
      return true;
    }
    return false;
  }

  return new Promise((resolve) => {
    let attempts = 0;
    const maxAttempts = result.mode === "switched-to-markdown" ? 8 : 1;
    function attempt() {
      attempts++;
      if (tryFillCodeMirror()) {
        resolve(result);
        return;
      }
      if (attempts < maxAttempts) {
        setTimeout(attempt, 150);
        return;
      }

      // 4. Fallback for rich-text contenteditable. Convert LF to <br> so block
      //    Markdown does not collapse into a single paragraph.
      const ed =
        document.querySelector("[contenteditable='true']") ||
        document.querySelector(".editor");
      if (ed) {
        ed.focus();
        const html = markdown
          .split("\n")
          .map((line) => line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"))
          .join("<br>");
        try {
          document.execCommand("selectAll", false, undefined);
          document.execCommand("insertHTML", false, html);
        } catch {
          ed.innerHTML = html;
        }
        result.mode = (result.mode || "") + "-fallback-contenteditable";
        result.content = (ed.innerText || "").length > 0;
        result.contentLength = ed.innerText.length;
        result.editorFound = true;
      }
      resolve(result);
    }
    attempt();
  }) as unknown as {
    title: boolean;
    content: boolean;
    mode: string | null;
    editorFound: boolean;
    contentLength: number;
  };
}

/**
 * Raw source of the page-context fill function, suitable for injecting via
 * `executeJavaScript`. We export it as a string so the main process never needs
 * DOM types, while still keeping the logic in one testable place.
 */
export const FILL_CSDN_EDITOR_SCRIPT = fillCsdnEditor.toString();

/** Page-context probe used before opening the publish settings modal on retries. */
export function hasCsdnPublishDialog(): boolean {
  function visible(el: any) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const computed = window.getComputedStyle ? window.getComputedStyle(el) : null;
    return rect.width > 6 && rect.height > 6 && (!computed || computed.visibility !== "hidden");
  }
  function textOf(el: any) {
    return (el.textContent || "").replace(/\s+/g, "").trim();
  }
  return Array.prototype.slice.call(
    document.querySelectorAll("[role='dialog'], .el-dialog, .modal__publish-article, .publish-dialog")
  ).some((dialog: any) => {
    if (!visible(dialog) || textOf(dialog).indexOf("文章摘要") < 0) return false;
    return Array.prototype.slice.call(
      dialog.querySelectorAll("button, a, [role='button'], input[type='submit']")
    ).some((button: any) => visible(button) && /^(发布文章|发布)$/.test(textOf(button)));
  });
}

export const HAS_CSDN_PUBLISH_DIALOG_SCRIPT = hasCsdnPublishDialog.toString();

export function missingCsdnRequiredPublishFields(
  args: { digest: string; coverDataUrl?: string },
  result: {
    abstractFilled: boolean;
    typeSelected: boolean;
    visibilitySelected: boolean;
    crossPublishSelected: boolean;
    tagsSelected: boolean;
    coverHandled: boolean;
  }
): string[] {
  return [
    ...(args.digest.trim() && !result.abstractFilled ? ["文章摘要"] : []),
    ...(!result.typeSelected ? ["文章类型"] : []),
    ...(!result.visibilitySelected ? ["可见范围"] : []),
    ...(!result.crossPublishSelected ? ["多平台发布"] : []),
    ...(!result.tagsSelected ? ["文章标签"] : []),
    ...(args.coverDataUrl && !result.coverHandled ? ["文章封面"] : [])
  ];
}

/**
 * Page-context script for filling the CSDN "publish article" settings dialog
 * that appears after the user clicks the main "发布文章" button in the editor.
 *
 * The user explicitly wants to keep the manual click on the main publish button,
 * so this function is polled from the main process: once the dialog appears we
 * fill the abstract from the draft digest, ensure the required options are
 * selected, and click the final "发布文章" button inside the dialog.
 */
export async function fillCsdnPublishDialog(args: { digest: string; coverDataUrl?: string; tags?: string[] }) {
  const result: Record<string, unknown> = {
    dialogFound: false,
    abstractFilled: false,
    typeSelected: false,
    visibilitySelected: false,
    crossPublishSelected: false,
    categorySelected: false,
    tagsSelected: false,
    coverHandled: false,
    coverMethod: null as string | null,
    publishButtonFound: false,
    submitClicked: false,
    alreadyHandled: false,
    reason: null as string | null,
    probe: null as string | null
  };

  if (window.__contentFerryCsdnDialogHandled) {
    result.alreadyHandled = true;
    result.reason = "already-handled";
    return result;
  }

  function visible(el: any) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = el.style || {};
    const computed = window.getComputedStyle ? window.getComputedStyle(el) : null;
    return (
      rect.width > 6 &&
      rect.height > 6 &&
      style.display !== "none" &&
      (!computed || computed.visibility !== "hidden")
    );
  }

  // Text including all descendant text.
  function textOf(el: any) {
    return (el.textContent || "").replace(/\s+/g, "").trim();
  }

  // Direct text only (excludes children) — used to pinpoint the label element.
  function directText(el: any) {
    let s = "";
    const nodes = el.childNodes || [];
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].nodeType === 3) s += nodes[i].nodeValue || "";
    }
    return s.replace(/\s+/g, "").trim();
  }

  function countDescendants(el: any) {
    return el.querySelectorAll ? el.querySelectorAll("*").length : 0;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  function setValue(el: any, value: string) {
    try {
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) {
        desc.set.call(el, value);
      } else {
        el.value = value;
      }
    } catch {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Find the smallest element whose own text is one of the labels, then climb up
  // to the form group that actually contains a control. Supports aliases because
  // CSDN renames labels across builds (e.g. "添加封面" vs "文章封面").
  function fieldGroup(marker: string | string[]): any {
    const markers = Array.isArray(marker) ? marker : [marker];
    const candidates = Array.prototype.slice.call(
      document.querySelectorAll("label, span, div, p, h1, h2, h3, h4, h5, h6, dt, th, b, strong, em, i, a, li")
    );
    let markerEl: any = null;
    for (const el of candidates) {
      const dt = directText(el);
      const tt = textOf(el);
      for (const m of markers) {
        if (dt === m || dt.indexOf(m) === 0 || tt === m) {
          if (!markerEl || countDescendants(el) < countDescendants(markerEl)) markerEl = el;
        }
      }
    }
    if (!markerEl) {
      // Looser match: any element whose direct text includes any marker.
      for (const el of candidates) {
        const dt = directText(el);
        for (const m of markers) {
          if (dt.indexOf(m) >= 0) {
            if (!markerEl || countDescendants(el) < countDescendants(markerEl)) markerEl = el;
          }
        }
      }
    }
    if (!markerEl) return null;
    let node: any = markerEl;
    for (let i = 0; i < 6; i++) {
      if (!node.parentElement) break;
      node = node.parentElement;
      if (node.querySelector && node.querySelector("textarea, input, select, [contenteditable='true'], button, a")) {
        return node;
      }
    }
    return node;
  }

  // Click the visible element within a container whose text matches keywords.
  // When `preferAncestor` is set, if the matched node is a plain text wrapper
  // (e.g. a <span> inside an <el-tabs__item>), we climb to the nearest
  // clickable ancestor so the framework's tab/button handler actually fires.
  function clickByText(container: any, keywords: string[], antiKeywords?: string[], preferAncestor?: boolean) {
    const els = Array.prototype.slice.call(
      container.querySelectorAll("label, span, div, a, li, button, p, td, th")
    );
    for (const el of els) {
      if (!visible(el)) continue;
      const t = textOf(el);
      if (keywords.some((k) => t.indexOf(k) >= 0)) {
        if (antiKeywords && antiKeywords.some((k) => t.indexOf(k) >= 0)) continue;
        let target: any = el;
        if (preferAncestor) {
          let n: any = el;
          while (n && n !== container && n.parentElement) {
            const tag = (n.tagName || "").toUpperCase();
            const role = n.getAttribute && n.getAttribute("role");
            const cls = (n.className || "").toString();
            if (
              tag === "BUTTON" ||
              tag === "A" ||
              role === "tab" ||
              role === "button" ||
              /(^|\s)(tab|item|btn|button)(\s|$)/i.test(cls)
            ) {
              target = n;
              break;
            }
            n = n.parentElement;
          }
        }
        target.click();
        return true;
      }
    }
    return false;
  }

  // 1. Locate the actual publish modal as the common container holding its
  //    fields and final action. The field groups themselves are too narrow to
  //    contain the submit button; never fall back to an editor-level button.
  const dialog = (function () {
    const candidates = Array.prototype.slice.call(
      document.querySelectorAll("[role='dialog'], .el-dialog, .modal__publish-article, .publish-dialog")
    ).filter((el: any) => visible(el));
    const matching = candidates.filter((el: any) => {
      const labelText = textOf(el);
      const hasSummary = labelText.indexOf("文章摘要") >= 0;
      const hasPublishAction = Array.prototype.slice.call(
        el.querySelectorAll("button, a, [role='button'], input[type='submit']")
      ).some((button: any) => visible(button) && /^(发布文章|发布)$/.test(textOf(button)));
      return hasSummary && hasPublishAction;
    });
    return matching.sort((a: any, b: any) => countDescendants(a) - countDescendants(b))[0] || null;
  })();
  if (!dialog) {
    result.reason = "dialog-not-found";
    return result;
  }
  result.dialogFound = true;

  // 2. Fill the article abstract (the textarea inside the abstract form group).
  function fillAbstract() {
    const group = fieldGroup("文章摘要");
    if (!group) return false;
    const textarea = group.querySelector("textarea") || group.querySelector("[contenteditable='true']");
    if (!textarea) return false;
    setValue(textarea, args.digest || "");
    return (textarea.value || textarea.innerText || "").length > 0;
  }
  result.abstractFilled = fillAbstract();

  // 3. Select required options by clicking the associated label text.
  function selectOption(marker: string, keywords: string[], antiKeywords?: string[]) {
    const group = fieldGroup(marker);
    if (!group) return false;
    return clickByText(group, keywords, antiKeywords);
  }
  result.typeSelected = selectOption("文章类型", ["原创"]);
  result.visibilitySelected = selectOption("可见范围", ["全部可见"]);
  result.crossPublishSelected = selectOption("多平台发布", ["否"], ["是"]);

  // 3b. Category (分类专栏) — select an existing column when available. CSDN
  //     accounts may have no columns, and the current publish form does not
  //     mark this field as required, so absence must not block publishing.
  async function selectCategory(): Promise<boolean> {
    const group = fieldGroup("分类专栏");
    if (!group) return false;

    // Try to open an existing el-select first.
    const trigger =
      group.querySelector(".el-select__wrapper") ||
      group.querySelector(".el-select") ||
      group.querySelector("input");
    if (trigger) {
      trigger.click();
      await sleep(600);
      const items = Array.prototype.slice
        .call(document.querySelectorAll(".el-select-dropdown__item, .el-select-dropdown__option, .el-dropdown-menu__item"))
        .filter((e: any) => visible(e) && !/请选择|创建新专栏|暂无数据/.test(textOf(e)));
      if (items.length) {
        items[0].click();
        await sleep(250);
        return true;
      }
    }

    return false;
  }
  result.categorySelected = await selectCategory();

  // CSDN requires at least one article tag. The source article's front matter is
  // the existing user-authored source of truth; use CSDN's own tag picker and
  // allow unmatched source labels as custom tags. Re-query after every Enter
  // because the Vue picker replaces its input when a tag is accepted.
  async function fillTags(): Promise<boolean> {
    const tagGroup = dialog.querySelector(".mark_selection[typename='tags']");
    if (!tagGroup) return false;
    const openButton = tagGroup.querySelector("button.tag__btn-tag");
    if (openButton && !tagGroup.querySelector(".mark_selection_box")) {
      openButton.click();
      await sleep(250);
    }

    const selectedTags = () => Array.prototype.slice
      .call(tagGroup.querySelectorAll(".mark_selection_title_el_tag .el-tag"))
      .map((el: any) => textOf(el).replace(/×$/, ""))
      .filter((text: string) => text && text !== "添加文章标签");
    let selected = selectedTags();
    for (const rawTag of args.tags ?? []) {
      const tag = typeof rawTag === "string" ? rawTag.trim() : "";
      if (!tag || selected.some((current: string) => current.toLowerCase() === tag.toLowerCase())) continue;
      if (selected.length >= 5) break;
      const input = tagGroup.querySelector("input[placeholder*='搜索']");
      if (!input) break;
      setValue(input, tag);
      // CSDN's autocomplete debounces for 300ms; wait for its suggestion list
      // before pressing Enter so both official and custom tags are committed.
      await sleep(400);
      const enter = new Event("keydown", { bubbles: true });
      Object.defineProperties(enter, {
        key: { value: "Enter" }, code: { value: "Enter" }, keyCode: { value: 13 }, which: { value: 13 }
      });
      input.dispatchEvent(enter);
      await sleep(250);
      selected = selectedTags();
    }
    const close = tagGroup.querySelector(".mark_selection_box button[title='关闭']");
    if (close && visible(close)) close.click();
    return selectedTags().length > 0;
  }
  result.tagsSelected = await fillTags();

  // 4. Cover image. CSDN's publish dialog labels this section "添加封面" (not
  //    "文章封面"). We therefore use aliases to locate it. We must NEVER operate
  //    on the abstract textarea, so urlInput selection is strictly scoped to the
  //    cover group and excludes textarea.
  function coverFileFromDataUrl(dataUrl: string): any {
    const meta = dataUrl.split(",")[0] || "";
    const mimeMatch = /:(.*?);/.exec(meta);
    const mime = (mimeMatch && mimeMatch[1]) || "image/png";
    const b64 = dataUrl.split(",")[1] || "";
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], "cover.png", { type: mime });
  }

  function setFileInput(input: any, file: any) {
    try {
      const dt: any = new (window as any).DataTransfer();
      dt.items.add(file);
      try {
        input.files = dt.files;
      } catch {
        try {
          Object.defineProperty(input, "files", { value: dt.files, configurable: true });
        } catch {
          /* read-only input; change dispatch below may still trigger upload */
        }
      }
    } catch {
      /* ignore */
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function firstHttpUrl(v: any): string | null {
    if (typeof v === "string") return v.indexOf("http") === 0 ? v : null;
    if (v && typeof v === "object") {
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          const u = firstHttpUrl(v[i]);
          if (u) return u;
        }
      } else {
        const cand =
          v.imageUrl ||
          v.url ||
          (v.hostname && v.targetObjectKey ? v.hostname + v.targetObjectKey : null) ||
          (v.data ? firstHttpUrl(v.data) : null);
        return cand;
      }
    }
    return null;
  }

  async function fillCover(): Promise<{ handled: boolean; method: string }> {
    const cover = args.coverDataUrl;
    if (!cover) return { handled: false, method: "no-cover-data" };

    // The cover section label varies across CSDN builds ("添加封面" / "文章封面" / "封面").
    // Match the label exactly: substring matching "封面" also catches the crop
    // dialog's "封面图预览", which is not the upload control group.
    function exactFieldGroup(markers: string[]): any {
      const candidates = Array.prototype.slice.call(
        document.querySelectorAll("label, span, div, p, h1, h2, h3, h4, h5, h6, dt, th, b, strong, em, i, a, li")
      );
      let markerEl: any = null;
      for (const el of candidates) {
        const dt = directText(el);
        const tt = textOf(el);
        if (!markers.some((marker) => dt === marker || tt === marker)) continue;
        if (!markerEl || countDescendants(el) < countDescendants(markerEl)) markerEl = el;
      }
      if (!markerEl) return null;
      let node: any = markerEl;
      for (let i = 0; i < 8; i++) {
        if (!node.parentElement) break;
        node = node.parentElement;
        if (node.querySelector && node.querySelector("input[type='file'], input[type='url'], input[type='text'], button, a")) {
          return node;
        }
      }
      return node;
    }
    const cg = exactFieldGroup(["添加封面", "文章封面", "封面"]);
    if (!cg) {
      return { handled: false, method: "no-cover-group" };
    }
    const scope = cg;

    // Ground-truth signal that CSDN actually accepted the cover.
    function coverImgPresent(): boolean {
      if (!scope || !scope.querySelectorAll) return false;
      const preview = scope.querySelector(".preview-box.hasImg img.preview, .preview-box img.preview");
      const src = preview && (preview.getAttribute("src") || preview.src || "");
      return Boolean(src && /^https?:\/\//i.test(src));
    }

    async function confirmCropUpload(): Promise<boolean> {
      const crop = scope.querySelector(".vue-image-crop-upload");
      if (!crop || !visible(crop)) return false;
      const cropImage = crop.querySelector(".vicp-img");
      const cropSource = cropImage && (cropImage.getAttribute("src") || cropImage.src || "");
      if (!cropSource || cropSource === window.location.href) return false;
      const confirm = Array.prototype.slice.call(crop.querySelectorAll(".vicp-operate-btn, button"))
        .find((button: any) => visible(button) && textOf(button) === "确认上传");
      if (!confirm) return false;
      confirm.click();
      await sleep(1600);
      return coverImgPresent();
    }

    function cropUploadPending(): boolean {
      const crop = scope.querySelector(".vue-image-crop-upload");
      return Boolean(crop && visible(crop));
    }

    const uploadApi =
      (window as any).csdn &&
      (window as any).csdn.upload &&
      typeof (window as any).csdn.upload.uploadImg === "function";

    // Diagnostics: every visible clickable label inside the cover area.
    const coverTabTexts = Array.prototype.slice
      .call(scope.querySelectorAll("button, a, [role='tab'], .tab, .el-tabs__item, span, div, label"))
      .filter((e: any) => visible(e))
      .map((e: any) => textOf(e))
      .filter((t: string) => t.length > 0 && t.length < 24);
    result.coverTabTexts = coverTabTexts;

    // --- Path 1: network image URL ---
    // Try to activate a "网络图片" tab directly. If the tab is not visible by
    // default, try clicking "添加封面/从本地上传" first to expand the upload
    // widget, then re-scan for the network-image tab.
    const netKeywords = ["网络图片", "外链图片", "网络图", "图片链接", "网络地址", "图片URL", "链接图片"];
    let netTabClicked = false;
    for (const kw of netKeywords) {
      if (clickByText(scope, [kw], undefined, true)) {
        netTabClicked = true;
        await sleep(250);
        break;
      }
    }
    if (!netTabClicked) {
      const activateKeywords = ["添加封面", "从本地上传", "上传封面", "点击上传"];
      for (const kw of activateKeywords) {
        if (clickByText(scope, [kw], undefined, true)) {
          await sleep(450);
          for (const kw2 of netKeywords) {
            if (clickByText(scope, [kw2], undefined, true)) {
              netTabClicked = true;
              await sleep(250);
              break;
            }
          }
          break;
        }
      }
    }

    if (netTabClicked) {
      // STRICT: only inputs inside the cover group, and never a textarea.
      let urlInput: any = scope.querySelector("input[type='url']");
      if (!urlInput) {
        const textInputs = Array.prototype.slice.call(
          scope.querySelectorAll("input[type='text']:not([type='file'])")
        );
        urlInput = textInputs.find((inp: any) => {
          const ph = (inp.getAttribute("placeholder") || "").toLowerCase();
          return ph.indexOf("链接") >= 0 || ph.indexOf("url") >= 0 || ph.indexOf("地址") >= 0;
        });
      }
      result.probe = (result.probe ? result.probe + " || " : "") + "COVER_URL_INPUT:" + (urlInput ? (urlInput.outerHTML || "").slice(0, 200) : "null");
      if (urlInput && uploadApi) {
        try {
          const file = coverFileFromDataUrl(cover);
          const res = await (window as any).csdn.upload.uploadImg({
            appName: "direct_blog",
            type: "blog",
            imageTemplate: "",
            file
          });
          const uploadedUrl = firstHttpUrl(res);
          if (uploadedUrl) {
            setValue(urlInput, uploadedUrl);
            await sleep(200);
            clickByText(scope, ["确认", "确定", "使用", "应用", "保存"], undefined, true);
            await sleep(700);
            if (coverImgPresent()) return { handled: true, method: "network-image-verified" };
            return { handled: false, method: "network-image-no-preview" };
          }
        } catch {
          /* fall through to file-input */
        }
      }
    }

    // --- Path 2: native file input (local upload) ---
    const localKeywords = ["本地上传", "上传封面", "选择图片", "上传图片", "点击上传", "添加封面"];
    for (const kw of localKeywords) {
      if (clickByText(scope, [kw], undefined, true)) {
        await sleep(350);
        break;
      }
    }
    await sleep(400);
    function findCoverFileInput(): any {
      const inGroup = cg.querySelector("input[type='file']");
      if (inGroup) return inGroup;
      const inScope = scope.querySelector("input[type='file']");
      if (inScope) return inScope;
      const all = document.querySelectorAll("input[type='file']");
      for (let i = 0; i < all.length; i++) if (visible(all[i])) return all[i];
      return null;
    }
    const fileInput = findCoverFileInput();
    if (fileInput) {
      try {
        setFileInput(fileInput, coverFileFromDataUrl(cover));
        await sleep(1200);
        if (cropUploadPending()) {
          if (await confirmCropUpload()) {
            return { handled: true, method: "file-input-crop-confirmed" };
          }
          // A visible crop dialog means CSDN has not committed the image yet.
          // A preview URL alone can be a pending crop, so do not treat it as saved.
          return { handled: false, method: "file-input-crop-unconfirmed" };
        }
        if (coverImgPresent()) return { handled: true, method: "file-input-verified" };
      } catch {
        if (cropUploadPending()) {
          return { handled: false, method: "file-input-crop-error" };
        }
        /* fall through */
      }
    }

    // --- Path 3: smart-recommended cover fallback ---
    // If neither custom upload path works, pick the first CSDN-recommended cover
    // so the submission can at least proceed. This is a last resort.
    const smartCovers = Array.prototype.slice
      .call(cg.querySelectorAll("img"))
      .filter((img: any) => visible(img) && (img.src || "").indexOf("http") === 0);
    if (smartCovers.length) {
      smartCovers[0].click();
      await sleep(700);
      if (cropUploadPending()) {
        try {
          if (await confirmCropUpload()) return { handled: true, method: "smart-cover-crop-confirmed" };
        } catch {
          return { handled: false, method: "smart-cover-crop-error" };
        }
        return { handled: false, method: "smart-cover-crop-unconfirmed" };
      }
      if (coverImgPresent()) return { handled: true, method: "smart-cover-fallback" };
    }

    result.probe =
      (result.probe ? result.probe + " || " : "") +
      "COVER_NO_PATH:" + (cg.outerHTML || "").slice(0, 1200);
    const cropWidget = cg.querySelector(".vue-image-crop-upload");
    const cropImage = cropWidget && cropWidget.querySelector(".vicp-img") as unknown as {
      getAttribute(name: string): string | null;
      currentSrc?: string;
      complete?: boolean;
      naturalWidth?: number;
      naturalHeight?: number;
    };
    const coverInput = cg.querySelector("input[type='file']") as unknown as {
      outerHTML?: string;
      files?: ArrayLike<{ size: number; type: string }> | null;
    } | null;
    const cropVm = cropWidget && (cropWidget as any).__vue__;
    const cropData = cropVm && cropVm.$data;
    const imageDataKeys = cropData
      ? Object.keys(cropData).filter((key: string) => /img|file|src|url/i.test(key)).slice(0, 20)
      : [];
    const inputFile = coverInput && coverInput.files && coverInput.files[0];
    result.probe += " || COVER_UPLOAD_STATE:" + JSON.stringify({
      input: coverInput ? {
        html: (coverInput.outerHTML || "").slice(0, 240),
        fileCount: coverInput.files ? coverInput.files.length : null,
        fileSize: inputFile ? inputFile.size : null,
        fileType: inputFile ? inputFile.type : null
      } : null,
      cropImage: cropImage ? {
        src: cropImage.getAttribute("src") || "",
        currentSrc: cropImage.currentSrc || "",
        complete: cropImage.complete,
        naturalWidth: cropImage.naturalWidth,
        naturalHeight: cropImage.naturalHeight,
        style: cropImage.getAttribute("style") || ""
      } : null,
      cropDataKeys: imageDataKeys,
      cropData: cropData ? imageDataKeys.reduce((memo: Record<string, unknown>, key: string) => {
        const value = cropData[key];
        memo[key] = typeof value === "string" ? value.slice(0, 160) : value == null ? value : typeof value;
        return memo;
      }, {}) : null
    });
    return { handled: false, method: "all-failed" };
  }
  const cover = await fillCover();
  result.coverHandled = cover.handled;
  result.coverMethod = cover.method;

  const missingRequired = missingCsdnRequiredPublishFields(args, result as {
    abstractFilled: boolean;
    typeSelected: boolean;
    visibilitySelected: boolean;
    crossPublishSelected: boolean;
    tagsSelected: boolean;
    coverHandled: boolean;
  });
  const optionalFieldsMissing = [
    ...(!result.categorySelected ? ["分类专栏"] : [])
  ];
  if (optionalFieldsMissing.length > 0) {
    result.reason = `optional-fields-unavailable:${optionalFieldsMissing.join(",")}`;
  }
  if (missingRequired.length > 0) {
    result.reason = `required-fields-unavailable:${missingRequired.join(",")}`;
    return result;
  }

  // 5. Click the final publish button inside the dialog (scope to the dialog).
  function findPublishButton() {
    const buttons = Array.prototype.slice.call(
      dialog.querySelectorAll("button, a, [role='button'], input[type='submit']")
    );
    return buttons.find((b: any) => {
      if (!visible(b)) return false;
      const label = textOf(b);
      return label === "发布文章" || label === "发布";
    });
  }
  const target = findPublishButton();
  if (target) {
    result.publishButtonFound = true;
    target.click();
    result.submitClicked = true;
    window.__contentFerryCsdnDialogHandled = true;
  } else {
    result.reason = "publish-button-not-found";
  }

  // Diagnostics probe: capture compact DOM around fields that failed, so a
  // future mismatch can be fixed with exact selectors. Also note what cover
  // inputs were discovered so the upload-vs-file-input fallback can be tuned.
  if (!result.abstractFilled || !result.coverHandled || !result.categorySelected) {
    const parts: string[] = [];
    const ag = fieldGroup("文章摘要");
    if (ag) {
      parts.push("ABSTRACT_GROUP:" + (ag.outerHTML || "").slice(0, 600));
      const ta = ag.querySelector("textarea");
      parts.push("ABSTRACT_VALUE_LEN:" + (ta ? (ta.value || ta.innerText || "").length : 0));
    }
    const cg = fieldGroup("文章封面");
    if (cg) parts.push("COVER_GROUP:" + (cg.outerHTML || "").slice(0, 1200));
    const catg = fieldGroup("分类专栏");
    if (catg) parts.push("CATEGORY_GROUP:" + (catg.outerHTML || "").slice(0, 900));
    // Every file input on the page (visibility + outerHTML) so the local-upload
    // wiring can be diagnosed precisely on the next run.
    const allFile = Array.prototype.slice.call(document.querySelectorAll("input[type='file']"));
    parts.push("PAGE_FILE_INPUTS:" + allFile.length);
    for (let i = 0; i < Math.min(allFile.length, 6); i++) {
      parts.push(
        "FILE_" + i + (visible(allFile[i]) ? "_VISIBLE" : "_HIDDEN") + ":" +
        (allFile[i].outerHTML || "").slice(0, 200)
      );
    }
    if (parts.length) {
      result.probe = (result.probe ? result.probe + " || " : "") + parts.join(" || ");
    }
  }

  return result;
}

/**
 * Raw source of the page-context publish-dialog fill function.
 */
export const FILL_CSDN_PUBLISH_DIALOG_SCRIPT = `${missingCsdnRequiredPublishFields.toString()}\n${fillCsdnPublishDialog.toString()}`;
