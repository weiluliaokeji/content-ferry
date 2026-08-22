import { BrowserWindow } from "electron";
import { state, type WechatBackendTarget } from "./state";
import { createWenduWindowIcon } from "./windows";
import { delay } from "./delay";

export function logWechatBrowserAssist(step: string, details: Record<string, unknown> = {}): void {
  state.runtimeInfoLogger?.({ scope: "wechat-browser-assist", step, ...details }, "微信浏览器辅助");
}

export function saveObservedWechatCollections(accountId: string, names: unknown): void {
  if (!state.runtimeDatabase || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(accountId) || !Array.isArray(names)) return;
  const uniqueNames = [...new Set(names
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.replace(/\s+/g, " ").trim())
    .filter((name) => name.length > 0 && name.length <= 80))];
  if (uniqueNames.length === 0) return;
  try {
    const accountExists = state.runtimeDatabase.connection.prepare("SELECT 1 FROM media_accounts WHERE id = ? AND deleted_at IS NULL")
      .get(accountId);
    if (!accountExists) return;
    const now = new Date().toISOString();
    const insert = state.runtimeDatabase.connection.prepare(`INSERT INTO wechat_collections
      (account_id, name, wechat_collection_id, observed_at) VALUES (?, ?, NULL, ?)
      ON CONFLICT(account_id, name) DO UPDATE SET observed_at = excluded.observed_at`);
    const save = state.runtimeDatabase.connection.transaction((items: string[]) => {
      for (const name of items) insert.run(accountId, name, now);
    });
    save(uniqueNames);
    logWechatBrowserAssist("collections-observed", { accountId, count: uniqueNames.length });
  } catch (error) {
    logWechatBrowserAssist("collections-observation-save-failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function driveWechatEditorSettings(window: BrowserWindow, target?: WechatBackendTarget): Promise<void> {
  if (window.isDestroyed() || !target) {
    logWechatBrowserAssist("editor-driver-skipped", {
      windowDestroyed: window.isDestroyed(),
      hasTarget: Boolean(target)
    });
    return;
  }
  logWechatBrowserAssist("editor-driver-started", {
    url: window.webContents.getURL(),
    declareOriginal: target.declareOriginal,
    enableReward: target.enableReward,
    hasCollection: Boolean(target.collectionName)
  });
  const editorTarget = {
    ...target,
    title: "",
    draftOpened: true,
    settingsScrolled: false
  };
  try {
    await window.webContents.executeJavaScript(`(() => {
      const incomingTarget = ${JSON.stringify(editorTarget)};
      window.__contentFerryWechatDraftTarget = incomingTarget;
      try {
        sessionStorage.setItem("contentferry-wechat-draft-target", JSON.stringify(incomingTarget));
      } catch {}
      if (window.__contentFerryWechatEditorDriver) return;
      window.__contentFerryWechatEditorDriver = true;

      const visible = (element) => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 4 && rect.height > 4 && style.display !== "none" && style.visibility !== "hidden";
      };
      const normalizedText = (element) => (element?.textContent || "").replace(/\\s+/g, "").trim();
      const clickableNodes = () => [...document.querySelectorAll("a, button, [role='button'], [role='link'], li, span")]
        .filter(visible);
      const clickVisibleDialogConfirm = (keywords) => {
        const candidates = clickableNodes()
          .filter((node) => normalizedText(node) === "确定")
          .map((node) => node.closest("a, button, [role='button']") || node)
          .filter((node) => {
            if (node instanceof HTMLButtonElement && node.disabled) return false;
            if (node.getAttribute("aria-disabled") === "true") return false;
            const dialog = node.closest(
              ".weui-desktop-dialog, .weui-desktop-dialog__wrp, .weui-desktop-popover, [role='dialog'], [class*='dialog' i], [class*='modal' i]"
            );
            if (!dialog || !visible(dialog)) return false;
            const dialogText = normalizedText(dialog);
            return keywords.some((keyword) => dialogText.includes(keyword));
          });
        const uniqueCandidates = [...new Set(candidates)];
        if (uniqueCandidates.length !== 1) return false;
        const confirm = uniqueCandidates[0];
        confirm.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        confirm.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        confirm.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        return true;
      };
      const prepareOriginalDialog = () => {
        // The dialog title also contains a nested help popover. Its textContent
        // therefore includes the hidden help copy and is not exactly “原创”.
        // The editor box is a stable, unique anchor in the actual in-page modal.
        const originalEditor = document.getElementById("js_original_edit_box");
        const dialog = originalEditor?.closest(".weui-desktop-dialog");
        if (!dialog || !visible(dialog)) return { status: "missing" };
        const textOriginal = dialog.querySelector(
          "#js_original_edit_box input.js_original_type_radio[value='0']"
        );
        if (textOriginal instanceof HTMLInputElement && !textOriginal.checked) {
          textOriginal.click();
        }
        const authorInput = [...dialog.querySelectorAll("#js_original_edit_box input.js_author")]
          .find((input) => visible(input));
        const author = authorInput instanceof HTMLInputElement ? authorInput.value.trim() : "";
        const agreement = dialog.querySelector(".original_agreement input.weui-desktop-form__checkbox");
        if (agreement instanceof HTMLInputElement && !agreement.checked) {
          agreement.click();
        }
        const ready = textOriginal instanceof HTMLInputElement
          && textOriginal.checked
          && author.length > 0
          && author.length <= 8
          && agreement instanceof HTMLInputElement
          && agreement.checked;
        return {
          status: ready ? "ready" : "incomplete",
          authorLength: author.length,
          typeSelected: textOriginal instanceof HTMLInputElement && textOriginal.checked,
          agreementChecked: agreement instanceof HTMLInputElement && agreement.checked
        };
      };
      const prepareRewardDialog = () => {
        // Keep the anchor inside the in-page modal. Unlike a title lookup, this
        // survives WeChat adding icon/help nodes around the dialog heading.
        const rewardBody = document.querySelector(".reward-setting-dialog__body");
        const dialog = rewardBody?.closest(".weui-desktop-dialog");
        if (!dialog || !visible(dialog)) return { status: "missing" };

        const rewardAuthor = dialog.querySelector("input.weui-desktop-form__radio[value='1']");
        if (rewardAuthor instanceof HTMLInputElement && !rewardAuthor.checked) rewardAuthor.click();

        const accountInput = dialog.querySelector("input.weui-desktop-form__input[placeholder*='赞赏账户']");
        const recentAccounts = [...dialog.querySelectorAll(".recent-select > div")].filter(visible);
        if (accountInput instanceof HTMLInputElement && !accountInput.value.trim() && recentAccounts.length === 1) {
          recentAccounts[0].click();
        }

        const agreement = dialog.querySelector(".agreement-check-btn__wrp input.weui-desktop-form__checkbox");
        if (agreement instanceof HTMLInputElement && !agreement.checked) agreement.click();

        const accountSelected = accountInput instanceof HTMLInputElement && accountInput.value.trim().length > 0;
        const ready = rewardAuthor instanceof HTMLInputElement
          && rewardAuthor.checked
          && accountSelected
          && agreement instanceof HTMLInputElement
          && agreement.checked;
        return {
          status: ready ? "ready" : "incomplete",
          accountSelected,
          recentAccountCount: recentAccounts.length,
          agreementChecked: agreement instanceof HTMLInputElement && agreement.checked
        };
      };
      const prepareCollectionDialog = (collectionName, queryStage) => {
        const setting = document.querySelector(".weui-desktop-dialog .setting-con");
        const dialog = setting?.closest(".weui-desktop-dialog");
        if (!dialog || !visible(dialog)) return { status: "missing" };
        const input = dialog.querySelector(".setting-select input.weui-desktop-form__input");
        if (!(input instanceof HTMLInputElement)) return { status: "missing-input" };
        const reportOptions = () => {
          const optionsContainer = dialog.querySelector(".select-opts-con");
          // WeChat renders collection records into select-opt-li nodes before
          // the menu opens. Its parent may still be display:none, so DOM
          // visibility is not a validity test for those data records.
          const optionNodes = optionsContainer?.querySelectorAll("li.select-opt-li") || [];
          const names = [...optionNodes]
            .map((node) => (node.textContent || "").replace(/\\s+/g, " ").trim())
            .filter((name) => name.length > 0 && name.length <= 80);
          const uniqueNames = [...new Set(names)];
          if (incomingTarget.accountId && uniqueNames.length > 0) {
            console.info("__contentferry_wechat_collections__:" + JSON.stringify({
              accountId: incomingTarget.accountId,
              names: uniqueNames
            }));
          }
          return uniqueNames;
        };
        if (queryStage !== "options-opened") {
          input.focus();
          input.click();
          // Do not type the requested name until the picker has had a chance
          // to render its unfiltered list. Otherwise WeChat only exposes the
          // one filtered result and the per-account cache can never become a
          // useful list of existing collections.
          window.setTimeout(reportOptions, 350);
          return { status: "options-opening" };
        }
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, collectionName);
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: collectionName }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
        const wanted = String(collectionName).replace(/\\s+/g, "");
        const optionCandidates = [...dialog.querySelectorAll(".select-opts-con li.select-opt-li")]
          .filter((node) => normalizedText(node) === wanted);
        const options = [...new Set(optionCandidates.map((node) =>
          node.closest("[role='option'], li, button, a, [class*='select-opt'], [class*='select-item']") || node
        ))];
        if (options.length === 1) {
          options[0].click();
          return { status: "selected" };
        }
        return { status: options.length > 1 ? "ambiguous" : "waiting-option" };
      };
      const clickCollectionConfirm = () => {
        const setting = document.querySelector(".weui-desktop-dialog .setting-con");
        const dialog = setting?.closest(".weui-desktop-dialog");
        if (!dialog || !visible(dialog)) return false;
        const confirms = [...dialog.querySelectorAll("button.weui-desktop-btn_primary")]
          .filter(visible)
          .filter((button) => normalizedText(button) === "确认")
          .filter((button) => !(button instanceof HTMLButtonElement) || !button.disabled);
        if (confirms.length !== 1) return false;
        confirms[0].click();
        return true;
      };
      const persist = (value) => {
        window.__contentFerryWechatDraftTarget = value;
        try {
          sessionStorage.setItem("contentferry-wechat-draft-target", JSON.stringify(value));
        } catch {}
      };
      const showAssistStatus = (lines) => {
        let panel = document.getElementById("contentferry-wechat-assist-status");
        if (!panel) {
          panel = document.createElement("div");
          panel.id = "contentferry-wechat-assist-status";
          panel.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;max-width:360px;padding:12px 14px;background:rgba(23,32,51,.82);color:#fff;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.28);font-size:13px;line-height:1.6;white-space:pre-line;cursor:move;user-select:none;";
          document.body.appendChild(panel);
          let dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
          panel.addEventListener("mousedown", (e) => {
            dragging = true;
            const r = panel.getBoundingClientRect();
            sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
            panel.style.left = sl + "px"; panel.style.top = st + "px";
            panel.style.right = "auto"; panel.style.bottom = "auto";
            e.preventDefault();
          });
          document.addEventListener("mousemove", (e) => {
            if (!dragging) return;
            const nl = Math.max(0, Math.min(sl + e.clientX - sx, window.innerWidth - panel.offsetWidth));
            const nt = Math.max(0, Math.min(st + e.clientY - sy, window.innerHeight - panel.offsetHeight));
            panel.style.left = nl + "px"; panel.style.top = nt + "px";
          });
          document.addEventListener("mouseup", () => { dragging = false; });
        }
        panel.textContent = lines.join("\\n");
      };
      const scrollToSettings = () => {
        const target = window.__contentFerryWechatDraftTarget;
        const settingsShortcut = [...document.querySelectorAll(
          ".js_fold.fold_tips_scrolltop .tool_bar__fold-btn, .fold_tips_scrolltop a[data-type='1']"
        )].find((element) => normalizedText(element) === "文章设置");
        if (settingsShortcut && !target?.settingsShortcutClicked) {
          settingsShortcut.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
          settingsShortcut.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
          settingsShortcut.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          target.settingsShortcutClicked = true;
          persist(target);
          return "shortcut";
        }

        const editor = document.querySelector(".appmsg_editor, .appmsg_editor_inner, #appmsg_content");
        const settingsArea = document.querySelector("#article_setting_area");
        const settingsAnchor = document.querySelector("#js_original_box")
          || document.querySelector("#article_setting_area2")
          || document.querySelector("#js_article_tags_area");
        if (!editor || !settingsArea || !settingsAnchor) return "waiting";

        const scrollContainers = [];
        let parent = settingsAnchor.parentElement;
        while (parent) {
          const style = getComputedStyle(parent);
          const canScroll = parent.scrollHeight > parent.clientHeight + 8
            && /(auto|scroll|overlay)/i.test(style.overflowY + style.overflow);
          if (canScroll) scrollContainers.push(parent);
          parent = parent.parentElement;
        }
        const rootScroller = document.scrollingElement;
        if (rootScroller && !scrollContainers.includes(rootScroller)) scrollContainers.push(rootScroller);

        settingsAnchor.scrollIntoView({ block: "start", inline: "nearest", behavior: "auto" });
        for (const container of scrollContainers) {
          const anchorRect = settingsAnchor.getBoundingClientRect();
          const containerRect = container === rootScroller
            ? { top: 0, height: window.innerHeight }
            : container.getBoundingClientRect();
          const topPadding = container === rootScroller ? 72 : 24;
          const desiredTop = container.scrollTop + anchorRect.top - containerRect.top - topPadding;
          container.scrollTop = Math.max(0, Math.min(
            container.scrollHeight - container.clientHeight,
            desiredTop
          ));
          container.dispatchEvent(new Event("scroll", { bubbles: true }));
        }
        window.scrollTo({
          top: Math.max(0, window.scrollY + settingsAnchor.getBoundingClientRect().top - 72),
          behavior: "auto"
        });
        settingsAnchor.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
        return "ready";
      };
      const applyRequestedSettings = () => {
        const target = window.__contentFerryWechatDraftTarget;
        if (!target?.draftOpened) return;
        const requested = target.declareOriginal || target.enableReward || Boolean(target.collectionName);
        if (!requested) {
          showAssistStatus([
            "已打开目标草稿，但这条草稿任务没有保存原创、赞赏或合集设置。",
            "文渡不会在未获得明确设置时自动操作。请重新设置并同步草稿后再试。"
          ]);
          return;
        }
        if (!target.settingsScrolled) {
          const navigationResult = scrollToSettings();
          if (navigationResult === "waiting") {
            showAssistStatus(["已打开目标草稿，正在等待微信编辑器设置区加载……"]);
            return;
          }
          if (navigationResult === "shortcut") {
            showAssistStatus(["已点击微信编辑器的“文章设置”。", "正在等待页面定位到原创、赞赏和合集区域……"]);
            window.setTimeout(applyRequestedSettings, 500);
            return;
          }
          target.settingsScrolled = true;
          persist(target);
          showAssistStatus(["已定位到文章设置区域。", "正在处理原创、赞赏和合集设置……"]);
          window.setTimeout(applyRequestedSettings, 500);
          return;
        }

        const notes = ["文渡已打开目标草稿。"];
        if (target.declareOriginal) {
          const originalOpen = document.querySelector("#js_original_open");
          if (originalOpen && visible(originalOpen)) {
            target.originalResult = "already";
            notes.push("原创：微信页面已显示为已声明。");
          } else if (!target.originalDialogOpened) {
            const originalEntry = document.querySelector("#js_original .js_original_apply.js_edit_ori");
            if (originalEntry) {
              originalEntry.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
              originalEntry.click();
              target.originalDialogOpened = true;
              notes.push("原创：已打开声明设置，请确认微信要求的信息。");
            } else {
              notes.push("原创：尚未找到声明入口，请在微信页面确认。");
            }
          } else if (!target.originalConfirmClicked) {
            const originalDialog = prepareOriginalDialog();
            if (originalDialog.status === "ready" && clickVisibleDialogConfirm(["原创"])) {
              target.originalConfirmClicked = true;
              notes.push("原创：已选择文字原创、勾选协议并自动确认，正在等待微信保存结果。");
            } else if (originalDialog.status === "incomplete") {
              notes.push(originalDialog.authorLength === 0
                ? "原创：请填写作者，文渡已选择文字原创并勾选协议。"
                : originalDialog.authorLength > 8
                  ? "原创：作者超过微信要求的 8 个字，请修改后继续。"
                  : "原创：正在等待微信更新表单状态……");
            } else {
              notes.push("原创：正在等待原创设置弹窗加载……");
            }
          } else {
            notes.push("原创：声明设置已打开；如“确定”不可用，请补充微信要求的信息。");
          }
        }
        if (target.declareOriginal && target.originalResult !== "already") {
          persist(target);
          showAssistStatus(notes);
          return;
        }

        if (target.enableReward) {
          const rewardArea = document.querySelector("#js_reward_setting_area");
          const rewardCheckbox = rewardArea?.querySelector(".js_reward_setting_checkbox");
          if (rewardCheckbox instanceof HTMLInputElement && rewardCheckbox.checked) {
            target.rewardResult = "already";
            notes.push("赞赏：微信页面已显示为开启。");
          } else if (rewardArea && visible(rewardArea) && !target.rewardDialogOpened) {
            const rewardEntry = rewardArea.querySelector(".js_reward_open");
            if (rewardEntry) {
              rewardEntry.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
              rewardEntry.click();
              target.rewardDialogOpened = true;
              notes.push("赞赏：已打开设置，请选择赞赏账户。");
            }
          } else if (target.rewardDialogOpened && !target.rewardConfirmClicked) {
            const rewardDialog = prepareRewardDialog();
            if (rewardDialog.status === "ready" && clickVisibleDialogConfirm(["赞赏"])) {
              target.rewardConfirmClicked = true;
              notes.push("赞赏：已选择赞赏作者、账户并勾选协议，正在自动确认。");
            } else if (rewardDialog.status === "incomplete") {
              notes.push(rewardDialog.recentAccountCount === 0
                ? "赞赏：请先选择或搜索赞赏账户，文渡已选择赞赏作者并勾选协议。"
                : rewardDialog.recentAccountCount > 1
                  ? "赞赏：有多个最近使用账户，请手工选择后继续。"
                  : "赞赏：正在等待微信更新账户选择状态……");
            } else {
              notes.push("赞赏：正在等待赞赏设置弹窗加载……");
            }
          } else {
            notes.push("赞赏：需先完成原创声明，或等待微信开放入口。");
          }
        }
        if (target.enableReward && target.rewardResult !== "already") {
          persist(target);
          showAssistStatus(notes);
          return;
        }

        if (target.collectionName) {
          if (!target.collectionDialogOpened) {
            const collectionEntry = document.querySelector("#js_article_tags_area .js_article_tags_label");
            if (collectionEntry) {
              collectionEntry.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
              collectionEntry.click();
              target.collectionDialogOpened = true;
            }
          }
          if (!target.collectionSelectionClicked) {
            const collection = prepareCollectionDialog(target.collectionName, target.collectionQueryStage);
            if (collection.status === "options-opening") {
              target.collectionQueryStage = "options-opened";
              notes.push("鍚堥泦锛氭鍦ㄨ鍙栧井淇″悎闆嗗垪琛紝绋嶅悗灏嗚嚜鍔ㄥ尮閰嶅悕绉般€?");
            } else if (collection.status === "filtering") {
              target.collectionQueryApplied = true;
              notes.push("合集：已输入名称，正在等待微信筛选结果。");
            } else if (collection.status === "selected") {
              target.collectionSelectionClicked = true;
            } else if (collection.status === "ambiguous") {
              notes.push("合集：匹配到多个同名项，请在微信弹窗中手工选择。");
            } else if (collection.status === "waiting-option") {
              notes.push("合集：微信尚未返回匹配项，请稍候或手工选择。");
            } else {
              notes.push("合集：正在等待合集选择弹窗加载。");
            }
          }
          if (target.collectionSelectionClicked && !target.collectionConfirmClicked
            && clickCollectionConfirm()) {
            target.collectionConfirmClicked = true;
            target.collectionResult = "selected";
          }
          notes.push(target.collectionResult === "selected"
            ? "合集：已选择「" + target.collectionName + "」。"
            : "合集：请确认选择「" + target.collectionName + "」。");
        }
        notes.push("请最后预览内容，并由你在微信后台点击发布。");
        persist(target);
        showAssistStatus(notes);
      };
      const tick = () => applyRequestedSettings();
      window.setTimeout(tick, 400);
      window.setInterval(tick, 1000);
      new MutationObserver(() => window.setTimeout(tick, 80))
        .observe(document.documentElement, { childList: true, subtree: true });
    })()`, true);
    const diagnostics = await window.webContents.executeJavaScript(`(() => {
      const target = window.__contentFerryWechatDraftTarget;
      const shortcut = document.querySelector(".js_fold.fold_tips_scrolltop .tool_bar__fold-btn, .fold_tips_scrolltop a[data-type='1']");
      const settingsArea = document.querySelector("#article_setting_area");
      const originalArea = document.querySelector("#js_original_box");
      return {
        url: location.href,
        title: document.title,
        requestedSettings: Boolean(target?.declareOriginal || target?.enableReward || target?.collectionName),
        declareOriginal: target?.declareOriginal === true,
        enableReward: target?.enableReward === true,
        hasCollection: Boolean(target?.collectionName),
        shortcutFound: Boolean(shortcut),
        shortcutText: (shortcut?.textContent || "").replace(/\\s+/g, "").slice(0, 80),
        settingsAreaFound: Boolean(settingsArea),
        originalAreaFound: Boolean(originalArea),
        scrollY: Math.round(window.scrollY),
        documentScrollTop: Math.round(document.scrollingElement?.scrollTop || 0)
      };
    })()`, true) as Record<string, unknown>;
    logWechatBrowserAssist("editor-dom-diagnostics", diagnostics);
  } catch (error) {
    // 微信编辑页可能仍处于导航中；dom-ready / did-finish-load 会再次触发。
    logWechatBrowserAssist("editor-driver-injection-failed", {
      url: window.isDestroyed() ? "" : window.webContents.getURL(),
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function driveWechatBackendToDrafts(window: BrowserWindow, target?: WechatBackendTarget): Promise<void> {
  if (window.isDestroyed()) return;
  if (target !== undefined) {
    await window.webContents.executeJavaScript(`(() => {
      const fallback = ${JSON.stringify(target)};
      try {
        const saved = sessionStorage.getItem("contentferry-wechat-draft-target");
        window.__contentFerryWechatDraftTarget = saved ? JSON.parse(saved) : fallback;
      } catch { window.__contentFerryWechatDraftTarget = fallback; }
    })()`, true);
  }
  await window.webContents.executeJavaScript(`(() => {
    if (window.__contentFerryWechatDraftDriver) return;
    window.__contentFerryWechatDraftDriver = true;
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 4 && rect.height > 4 && style.display !== "none" && style.visibility !== "hidden";
    };
    const normalizedText = (element) => (element.textContent || "").replace(/\\s+/g, "").trim();
    const clickableNodes = () => [...document.querySelectorAll("a, button, [role='button'], [role='link'], li, span")].filter(visible);
    const findText = (patterns) => clickableNodes().find((item) => patterns.some((pattern) => pattern.test(normalizedText(item))));
    const clickText = (patterns) => {
      const node = findText(patterns);
      if (!node) return false;
      // 微信后台的侧栏在不同版本中可能把可点击行为绑定在 span、div、a 或 li 上。
      // 优先选择真实可交互祖先；没有时直接触发当前文字节点，避免只点到无行为的容器。
      const target = node.closest("a, button, [role='button'], [role='link']") || node;
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    };
    let contentManagementOpened = false;
    const isDraftsPage = () => {
      if (/\\/cgi-bin\\/appmsg|action=(?:list|list_ex).*appmsg/i.test(location.href)) return true;
      return [...document.querySelectorAll("h1, h2, h3, [class*='page_title' i], [class*='main_hd' i]")]
        .filter(visible)
        .some((node) => /^草稿箱(?:\\(\\d+\\))?$/.test(normalizedText(node)));
    };
    const isExpanded = (node) => {
      const target = node.closest("a, button, [role='button'], [role='link'], li") || node;
      const classes = String(target.className || "") + " " + String(target.parentElement?.className || "");
      return target.getAttribute("aria-expanded") === "true" || /active|selected|current|open|expanded/i.test(classes);
    };
    const openDrafts = () => {
      // 已展开的微信菜单通常带有草稿箱的真实链接。直接使用该链接能避开不同
      // 后台版本对二级菜单 click 事件和数量徽标的差异。
      const directLink = [...document.querySelectorAll("a[href]")].find((item) => {
        const href = item.getAttribute("href") || "";
        return /草稿箱/.test(normalizedText(item)) && href && !/^javascript:/i.test(href);
      });
      if (directLink) {
        location.assign(directLink.href);
        return true;
      }
      return clickText([/^草稿箱.*$/, /^草稿.*$/]);
    };
    const openTargetDraft = () => {
      const draftTarget = window.__contentFerryWechatDraftTarget;
      const title = String(draftTarget?.title || "").replace(/\\s+/g, "").trim();
      if (!title) return false;
      const shortenedTitle = (value) => value.replace(/(?:…|\.\.\.)$/, "");
      const titleMatches = (value) => value === title || (shortenedTitle(value).length >= 12 && title.startsWith(shortenedTitle(value))) || (value.includes(title) && value.length <= title.length + 32);
      const exactTitleLinks = [...document.querySelectorAll("a.weui-desktop-publish__cover__title")]
        .filter(visible).filter((item) => titleMatches(normalizedText(item)) || titleMatches(String(item.getAttribute("title") || "").replace(/\s+/g, "").trim()));
      const titleNodes = exactTitleLinks.length > 0 ? exactTitleLinks : [...document.querySelectorAll("a, button, [role='button'], [role='link'], li, span, div, p, h1, h2, h3")]
        .filter(visible).filter((item) => {
          const value = normalizedText(item);
          return titleMatches(value) || titleMatches(String(item.getAttribute("title") || "").replace(/\s+/g, "").trim());
        });
      const findDraftCard = (item) => {
        const titleLink = item.closest("a.weui-desktop-publish__cover__title") || item.closest("a") || item;
        const exactCard = titleLink.closest(".weui-desktop-card__inner");
        if (exactCard) return exactCard;
        const ancestors = [];
        let current = titleLink.parentElement;
        for (let depth = 0; current && current !== document.body && depth < 10; depth += 1) {
          ancestors.push(current);
          current = current.parentElement;
        }
        const withActions = ancestors.find((node) => node.querySelector(
          "[class*='action' i], [class*='operate' i], [class*='toolbar' i], [class*='tool_bar' i], button, [role='button']"
        ));
        if (withActions) return withActions;
        return ancestors.find((node) => /(?:^|\\s)weui-desktop-(?:card|publish)(?:\\s|$)|publish__(?:item|card)/i.test(String(node.className || "")))
          || ancestors.find((node) => {
            const rect = node.getBoundingClientRect();
            return rect.width > 280 && rect.height > 100;
          })
          || titleLink.parentElement;
      };
      const cards = [...new Set(titleNodes.map(findDraftCard).filter(Boolean))];
      if (cards.length !== 1) {
        showAssistStatus(["已进入微信草稿箱，但未能唯一识别目标草稿。", "请确认标题没有重复，或手动打开目标草稿后继续。"]);
        return false;
      }
      const card = cards[0];
      card.scrollIntoView({ block: "center", inline: "nearest" });
      const exactEditWrapper = [...card.querySelectorAll(".weui-desktop-card__action .weui-desktop-tooltip__wrp")]
        .find((wrapper) => normalizedText(wrapper.querySelector(".weui-desktop-tooltip") || wrapper) === "编辑");
      const exactEdit = exactEditWrapper?.querySelector("a.weui-desktop-icon-btn");
      if (exactEdit) {
        exactEdit.click();
        window.__contentFerryWechatDraftTarget = { ...draftTarget, title: "", draftOpened: true };
        sessionStorage.setItem("contentferry-wechat-draft-target", JSON.stringify(window.__contentFerryWechatDraftTarget));
        return true;
      }
      card.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, cancelable: true, view: window }));
      card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
      card.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, view: window }));
      const editCandidates = [...card.querySelectorAll("button, a, [role='button'], [role='link'], [title], [aria-label], i, span, div")]
        .filter(visible)
        .filter((item) => {
          const description = [item.textContent, item.getAttribute("title"), item.getAttribute("aria-label"), item.getAttribute("data-tooltip"), item.getAttribute("data-title"), item.className]
            .filter((value) => typeof value === "string").join(" ");
          return /编辑/.test(description) || /(?:^|[-_])edit(?:[-_]|$)/i.test(String(item.className || ""));
        })
        .map((item) => item.closest("a, button, [role='button'], [role='link']") || item);
      const editButtons = [...new Set(editCandidates)];
      if (editButtons.length !== 1) {
        showAssistStatus(["已定位目标草稿并展开操作按钮。", "未能可靠识别“编辑”按钮，请点击该草稿卡片右上方的编辑图标后继续。"]);
        return false;
      }
      const edit = editButtons[0];
      edit.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      edit.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      edit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      window.__contentFerryWechatDraftTarget = { ...draftTarget, title: "", draftOpened: true };
      sessionStorage.setItem("contentferry-wechat-draft-target", JSON.stringify(window.__contentFerryWechatDraftTarget));
      return true;
    };
    const showAssistStatus = (lines) => {
      let panel = document.getElementById("contentferry-wechat-assist-status");
      if (!panel) {
        panel = document.createElement("div");
        panel.id = "contentferry-wechat-assist-status";
        panel.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;max-width:360px;padding:12px 14px;background:rgba(23,32,51,.82);color:#fff;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.28);font-size:13px;line-height:1.6;cursor:move;user-select:none;";
        document.body.appendChild(panel);
        let dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
        panel.addEventListener("mousedown", (e) => {
          dragging = true;
          const r = panel.getBoundingClientRect();
          sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
          panel.style.left = sl + "px"; panel.style.top = st + "px";
          panel.style.right = "auto"; panel.style.bottom = "auto";
          e.preventDefault();
        });
        document.addEventListener("mousemove", (e) => {
          if (!dragging) return;
          const nl = Math.max(0, Math.min(sl + e.clientX - sx, window.innerWidth - panel.offsetWidth));
          const nt = Math.max(0, Math.min(st + e.clientY - sy, window.innerHeight - panel.offsetHeight));
          panel.style.left = nl + "px"; panel.style.top = nt + "px";
        });
        document.addEventListener("mouseup", () => { dragging = false; });
      }
      panel.textContent = lines.join("\\n");
    };
    const applyRequestedSettings = () => {
      const target = window.__contentFerryWechatDraftTarget;
      if (!target?.draftOpened) return;
      const requestedWechatSettings = target.declareOriginal || target.enableReward || Boolean(target.collectionName);
      if (requestedWechatSettings && !target.settingsScrolled) {
        const settingsShortcut = [...document.querySelectorAll(
          ".js_fold.fold_tips_scrolltop .tool_bar__fold-btn, .fold_tips_scrolltop a[data-type='1']"
        )].find((element) => normalizedText(element) === "文章设置");
        if (settingsShortcut && !target.settingsShortcutClicked) {
          settingsShortcut.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
          settingsShortcut.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
          settingsShortcut.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          target.settingsShortcutClicked = true;
          sessionStorage.setItem("contentferry-wechat-draft-target", JSON.stringify(target));
          showAssistStatus(["已点击微信编辑器的“文章设置”。", "正在等待页面定位到原创、赞赏和合集区域……"]);
          window.setTimeout(applyRequestedSettings, 500);
          return;
        }
        const settingsAnchor = document.querySelector("#js_original_box, #article_setting_area2, #js_article_tags_area");
        const editor = document.querySelector(".appmsg_editor");
        if (!settingsAnchor || !editor) {
          showAssistStatus(["已打开目标草稿，正在等待微信编辑器设置区加载……"]);
          return;
        }
        const scrollParents = [];
        let parent = settingsAnchor.parentElement;
        while (parent && parent !== document.body) {
          if (parent.scrollHeight > parent.clientHeight + 24) scrollParents.push(parent);
          parent = parent.parentElement;
        }
        settingsAnchor.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
        for (const scrollParent of scrollParents) {
          const anchorRect = settingsAnchor.getBoundingClientRect();
          const parentRect = scrollParent.getBoundingClientRect();
          const nextTop = scrollParent.scrollTop + anchorRect.top - parentRect.top - Math.max(24, scrollParent.clientHeight / 3);
          scrollParent.scrollTop = Math.max(0, Math.min(scrollParent.scrollHeight - scrollParent.clientHeight, nextTop));
          scrollParent.dispatchEvent(new Event("scroll", { bubbles: true }));
        }
        if (document.scrollingElement) {
          settingsAnchor.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
        }
        target.settingsScrolled = true;
        sessionStorage.setItem("contentferry-wechat-draft-target", JSON.stringify(target));
        showAssistStatus(["已打开目标草稿并定位到发布设置区。", "正在处理原创、赞赏和合集设置……"]);
        window.setTimeout(applyRequestedSettings, 500);
        return;
      }
      const notes = ["文渡已定位到目标草稿。"];
      if (target.declareOriginal) {
        const originalOpen = document.querySelector("#js_original_open");
        if (originalOpen && visible(originalOpen)) {
          target.originalResult = "already";
          notes.push("原创：微信页面已显示为已声明。");
        } else if (!target.originalDialogOpened) {
          const originalEntry = document.querySelector("#js_original .js_original_apply.js_edit_ori");
          if (originalEntry) {
            originalEntry.click();
            target.originalDialogOpened = true;
            notes.push("原创：已打开声明设置，正在等待微信确认窗口。");
          } else {
            notes.push("原创：尚未找到声明入口，请在微信页面确认。");
          }
        } else {
          notes.push("原创：声明设置已打开，请确认微信要求的原创信息。");
        }
      }
      if (target.declareOriginal && target.originalResult !== "already") {
        sessionStorage.setItem("contentferry-wechat-draft-target", JSON.stringify(target));
        showAssistStatus(notes);
        return;
      }
      if (target.enableReward) {
        const rewardArea = document.querySelector("#js_reward_setting_area");
        const rewardCheckbox = rewardArea?.querySelector(".js_reward_setting_checkbox");
        if (rewardCheckbox instanceof HTMLInputElement && rewardCheckbox.checked) {
          target.rewardResult = "already";
          notes.push("赞赏：微信页面已显示为开启。");
        } else if (rewardArea && visible(rewardArea) && !target.rewardDialogOpened) {
          const rewardEntry = rewardArea.querySelector(".js_reward_open");
          if (rewardEntry) {
            rewardEntry.click();
            target.rewardDialogOpened = true;
            notes.push("赞赏：已打开设置，正在等待选择赞赏账户。");
          }
        } else {
          notes.push("赞赏：需要先完成原创声明，或由微信开放赞赏入口。");
        }
      }
      if (target.enableReward && target.rewardResult !== "already") {
        sessionStorage.setItem("contentferry-wechat-draft-target", JSON.stringify(target));
        showAssistStatus(notes);
        return;
      }
      if (target.collectionName) {
        if (!target.collectionDialogOpened) {
          const collectionEntry = document.querySelector("#js_article_tags_area .js_article_tags_label");
          if (collectionEntry) {
            collectionEntry.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
            collectionEntry.click();
            target.collectionDialogOpened = true;
          }
        }
        const collectionMatches = [...new Set(clickableNodes()
          .filter((node) => normalizedText(node) === String(target.collectionName).replace(/\\s+/g, ""))
          .map((node) => node.closest("a, button, [role='button'], [role='link']") || node))];
        if (collectionMatches.length === 1) {
          const node = collectionMatches[0];
          node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          target.collectionResult = "selected";
        }
        notes.push(target.collectionResult === "selected" ? "合集：已选择「" + target.collectionName + "」。" : "合集：请确认选择「" + target.collectionName + "」。");
      }
      notes.push("请最后预览内容，并由你在微信后台点击发布。");
      sessionStorage.setItem("contentferry-wechat-draft-target", JSON.stringify(target));
      showAssistStatus(notes);
    };
    const tick = () => {
      if (isDraftsPage()) {
        if (!window.__contentFerryWechatDraftTarget?.draftOpened) openTargetDraft();
        else applyRequestedSettings();
        return;
      }
      applyRequestedSettings();
      // Prefer the concrete draft-box link whenever it is already present in
      // the DOM. This avoids toggling an expanded menu back to the collapsed
      // state when WeChat changes the active/expanded class names.
      if (openDrafts()) return;
      const contentManagement = findText([/^内容管理$/, /^内容管理(?:[▶▾▼])?$/]);
      if (!contentManagement) return;
      if (!contentManagementOpened && contentManagement && !isExpanded(contentManagement)) {
        contentManagementOpened = clickText([/^内容管理$/, /^内容管理(?:[▶▾▼])?$/]);
        window.setTimeout(tick, 500);
        return;
      }
      contentManagementOpened = true;
      if (openDrafts()) return;
    };
    // 微信登录成功后可能不触发完整页面刷新，因此同时监听 DOM 变化。
    window.setTimeout(tick, 1200);
    window.setInterval(tick, 1200);
    new MutationObserver(() => window.setTimeout(tick, 80)).observe(document.documentElement, { childList: true, subtree: true });
  })()`, true);
  if (target) void advanceWechatDraftEditing(window);
}

export async function advanceWechatDraftEditing(window: BrowserWindow): Promise<void> {
  if (state.wechatBackendAdvanceTask) {
    void state.wechatBackendAdvanceTask.finally(() => {
      if (state.wechatBackendTarget && !window.isDestroyed()) void advanceWechatDraftEditing(window);
    });
    return state.wechatBackendAdvanceTask;
  }
  state.wechatBackendAdvanceTask = (async () => {
    try {
      for (let attempt = 0; attempt < 40 && !window.isDestroyed(); attempt += 1) {
        const action = await window.webContents.executeJavaScript(`(() => {
          const visible = (element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 4 && rect.height > 4 && style.display !== "none" && style.visibility !== "hidden";
          };
          const target = (() => {
            try { return JSON.parse(sessionStorage.getItem("contentferry-wechat-draft-target") || "null"); }
            catch { return window.__contentFerryWechatDraftTarget || null; }
          })();
          if (!target?.title || target.draftOpened) return { kind: "done" };
          const title = String(target.title).replace(/\\s+/g, "").trim();
          const text = (element) => (element.textContent || "").replace(/\\s+/g, "").trim();
          const shortenedTitle = (value) => value.replace(/(?:…|\.\.\.)$/, "");
          const titleMatches = (value) => value === title || (shortenedTitle(value).length >= 12 && title.startsWith(shortenedTitle(value))) || (value.includes(title) && value.length <= title.length + 32);
          const exactTitleLinks = [...document.querySelectorAll("a.weui-desktop-publish__cover__title")]
            .filter(visible).filter((node) => titleMatches(text(node)) || titleMatches(String(node.getAttribute("title") || "").replace(/\s+/g, "").trim()));
          const titleNodes = exactTitleLinks.length > 0 ? exactTitleLinks : [...document.querySelectorAll("a, button, [role='button'], [role='link'], li, span, div, p, h1, h2, h3")]
            .filter(visible).filter((node) => {
              const value = text(node);
              return titleMatches(value) || titleMatches(String(node.getAttribute("title") || "").replace(/\s+/g, "").trim());
            });
          const findDraftCard = (node) => {
            const titleLink = node.closest("a.weui-desktop-publish__cover__title") || node.closest("a") || node;
            const exactCard = titleLink.closest(".weui-desktop-card__inner");
            if (exactCard) return exactCard;
            const ancestors = [];
            let current = titleLink.parentElement;
            for (let depth = 0; current && current !== document.body && depth < 10; depth += 1) {
              ancestors.push(current);
              current = current.parentElement;
            }
            const withActions = ancestors.find((ancestor) => ancestor.querySelector(
              "[class*='action' i], [class*='operate' i], [class*='toolbar' i], [class*='tool_bar' i], button, [role='button']"
            ));
            if (withActions) return withActions;
            return ancestors.find((ancestor) => /(?:^|\\s)weui-desktop-(?:card|publish)(?:\\s|$)|publish__(?:item|card)/i.test(String(ancestor.className || "")))
              || ancestors.find((ancestor) => {
                const rect = ancestor.getBoundingClientRect();
                return rect.width > 280 && rect.height > 100;
              })
              || titleLink.parentElement;
          };
          const cards = [...new Set(titleNodes.map(findDraftCard).filter(Boolean))];
          if (cards.length !== 1) return { kind: "waiting" };
          const card = cards[0];
          card.scrollIntoView({ block: "center", inline: "nearest" });
          const exactEditWrapper = [...card.querySelectorAll(".weui-desktop-card__action .weui-desktop-tooltip__wrp")]
            .find((wrapper) => text(wrapper.querySelector(".weui-desktop-tooltip") || wrapper) === "编辑");
          const exactEdit = exactEditWrapper?.querySelector("a.weui-desktop-icon-btn");
          if (exactEdit) {
            exactEdit.click();
            const nextTarget = { ...target, title: "", draftOpened: true };
            window.__contentFerryWechatDraftTarget = nextTarget;
            sessionStorage.setItem("contentferry-wechat-draft-target", JSON.stringify(nextTarget));
            return { kind: "done" };
          }
          const cardRect = card.getBoundingClientRect();
          const editButtons = [...new Set([...card.querySelectorAll("button, a, [role='button'], [role='link'], [title], [aria-label], [data-tooltip], [data-title], i, span, div")]
            .filter(visible)
            .filter((node) => {
              const description = [node.textContent, node.getAttribute("title"), node.getAttribute("aria-label"), node.getAttribute("data-tooltip"), node.getAttribute("data-title"), node.className]
                .filter((value) => typeof value === "string").join(" ");
              return /编辑/.test(description) || /(?:^|[-_])edit(?:[-_]|$)/i.test(String(node.className || ""));
            })
            .map((node) => node.closest("a, button, [role='button'], [role='link']") || node))];
          if (editButtons.length !== 1) return { kind: "hover", x: cardRect.left + cardRect.width / 2, y: cardRect.top + cardRect.height / 2 };
          const editRect = editButtons[0].getBoundingClientRect();
          return { kind: "edit", x: editRect.left + editRect.width / 2, y: editRect.top + editRect.height / 2 };
        })()`, true) as { kind: "done" | "waiting" | "hover" | "edit"; x?: number; y?: number };
        if (action.kind === "done") return;
        if ((action.kind === "hover" || action.kind === "edit") && action.x != null && action.y != null) {
          const x = Math.round(action.x);
          const y = Math.round(action.y);
          window.webContents.sendInputEvent({ type: "mouseMove", x, y });
          if (action.kind === "edit") {
            await delay(180);
            window.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
            window.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
            return;
          }
        }
        await delay(500);
      }
    } catch (error) {
      console.warn("Wechat draft editor navigation warning", error);
    } finally {
      state.wechatBackendAdvanceTask = undefined;
    }
  })();
  return state.wechatBackendAdvanceTask;
}

export async function getOrCreateWechatBackendWindow(): Promise<BrowserWindow> {
  if (state.wechatBackendWindow && !state.wechatBackendWindow.isDestroyed()) return state.wechatBackendWindow;
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    show: true,
    title: "文渡 · 微信公众号后台",
    icon: createWenduWindowIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: "persist:contentferry-wechat"
    }
  });
  state.wechatBackendWindow = window;
  window.on("closed", () => { if (state.wechatBackendWindow === window) { state.wechatBackendWindow = undefined; state.wechatBackendTarget = undefined; } });
  window.webContents.on("did-create-window", (childWindow) => {
    state.wechatEditorWindow = childWindow;
    logWechatBrowserAssist("editor-window-created", {
      url: childWindow.webContents.getURL(),
      hasTarget: Boolean(state.wechatBackendTarget)
    });
    childWindow.setMenuBarVisibility(false);
    childWindow.setMinimumSize(1100, 720);
    childWindow.maximize();
    childWindow.once("ready-to-show", () => {
      if (!childWindow.isDestroyed()) {
        childWindow.maximize();
        childWindow.show();
        childWindow.focus();
      }
    });
    childWindow.on("closed", () => {
      if (state.wechatEditorWindow === childWindow) state.wechatEditorWindow = undefined;
    });
    childWindow.webContents.on("did-finish-load", () => {
      logWechatBrowserAssist("editor-window-loaded", { url: childWindow.webContents.getURL() });
      void driveWechatEditorSettings(childWindow, state.wechatBackendTarget);
    });
    childWindow.webContents.on("dom-ready", () => {
      logWechatBrowserAssist("editor-window-dom-ready", { url: childWindow.webContents.getURL() });
      void driveWechatEditorSettings(childWindow, state.wechatBackendTarget);
    });
    childWindow.webContents.on("console-message", (_event, _level, message) => {
      const prefix = "__contentferry_wechat_collections__:";
      if (!message.startsWith(prefix)) return;
      try {
        const payload = JSON.parse(message.slice(prefix.length)) as { accountId?: unknown; names?: unknown };
        if (typeof payload.accountId === "string") saveObservedWechatCollections(payload.accountId, payload.names);
      } catch (error) {
        logWechatBrowserAssist("collections-observation-invalid", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });
    childWindow.show();
    childWindow.focus();
  });
  window.webContents.on("did-finish-load", () => { void driveWechatBackendToDrafts(window, state.wechatBackendTarget); });
  await window.loadURL("https://mp.weixin.qq.com/");
  return window;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSDN 受控浏览器发布（FR-15.3）：登录预检、表单填充、用户最终确认后单次提交、远端回读。
// 与微信一致，状态落库全部在 create-server 路由；这里只驱动可见浏览器并回写结果。
// ─────────────────────────────────────────────────────────────────────────────
