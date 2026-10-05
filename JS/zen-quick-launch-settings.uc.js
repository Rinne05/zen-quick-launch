// Quick Launch settings panel.
//
// The panel is injected into the browser window instead of living on its own
// about: page: recent Firefox/Zen builds no longer run about: modules that
// were registered at runtime from JS, so a privileged settings page cannot be
// opened as a tab anymore. A panel in browser.xhtml has the same privileges
// and does not depend on any registry.
(() => {
  "use strict";

  const INSTANCE_KEY = "__zenQuickLaunchSettings";
  const GLOBAL_API_KEY = "__zenQuickLaunchSettingsAPI";
  const PANEL_ID = "zen-quick-launch-settings";
  const XHTML_NS = "http://www.w3.org/1999/xhtml";

  const PREF_ITEMS = "zen.quicklaunch.items";
  const PREF_COLUMNS = "zen.quicklaunch.columns";
  const PREF_CTRL_BG = "zen.quicklaunch.ctrlBackground";

  const DEFAULT_ICON =
    "chrome://global/skin/icons/defaultFavicon.svg";
  const ICON_MAX_ATTEMPTS = 3;
  const ICON_RETRY_DELAY = 1500;

  const DEFAULT_ITEMS = [
    { id: "default-3000", name: "3000", url: "http://192.168.1.100:3000", icon: "auto", enabled: true },
    { id: "default-5000", name: "5000", url: "http://192.168.1.100:5000", icon: "auto", enabled: true },
    { id: "default-8080", name: "8080", url: "http://192.168.1.100:8080", icon: "auto", enabled: true },
    { id: "default-9000", name: "9000", url: "http://192.168.1.100:9000", icon: "auto", enabled: true },
  ];

  const PANEL_HTML = `
    <div class="zql-backdrop" data-action="close"></div>
    <div class="zql-dialog" role="dialog" aria-modal="true" aria-labelledby="zql-title">
      <header class="zql-header">
        <div class="zql-titles">
          <p class="zql-eyebrow">ZEN QUICK LAUNCH</p>
          <h1 id="zql-title">Quick Launch 设置</h1>
          <p class="zql-subtitle">
            这些入口不是书签，也不是标签页。点击入口始终创建一个新的标签页。
            只填 IP 和端口时会自动补成 http://。
          </p>
        </div>
        <div class="zql-header-actions">
          <button type="button" class="zql-button" data-action="export">导出 JSON</button>
          <label class="zql-button zql-file-button">
            导入 JSON
            <input class="zql-import-input" type="file"
                   accept="application/json,.json" />
          </label>
          <button type="button" class="zql-button zql-icon-button"
                  data-action="close" aria-label="关闭设置" title="关闭">×</button>
        </div>
      </header>

      <div class="zql-toolbar">
        <div class="zql-toolbar-left">
          <label class="zql-field">
            <span>每行图标数量</span>
            <select class="zql-columns">
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
              <option value="4">4</option>
              <option value="5">5</option>
              <option value="6">6</option>
            </select>
          </label>
          <label class="zql-toggle">
            <input class="zql-ctrl-background" type="checkbox" />
            <span>
              <strong>Ctrl / Cmd + 左键在后台打开</strong>
              <small>中键始终在后台打开。</small>
            </span>
          </label>
        </div>
        <button type="button" class="zql-button zql-primary"
                data-action="add">＋ 添加入口</button>
      </div>

      <div class="zql-items" aria-label="Quick Launch 入口"></div>

      <div class="zql-empty" hidden="hidden">
        <h3>还没有快捷入口</h3>
        <p>添加一个 URL 后，它会立即显示在 Zen 左侧栏。</p>
        <button type="button" class="zql-button zql-primary"
                data-action="add">添加第一个入口</button>
      </div>

      <footer class="zql-footer">
        <div class="zql-status" role="status" aria-live="polite">正在加载设置…</div>
        <div class="zql-footer-actions">
          <button type="button" class="zql-button zql-danger"
                  data-action="reset">恢复默认</button>
          <button type="button" class="zql-button zql-primary"
                  data-action="save">保存并应用</button>
        </div>
      </footer>
    </div>`;

  const ROW_HTML = `
    <article class="zql-item">
      <div class="zql-drag" title="拖动排序" aria-label="拖动排序">⋮⋮</div>
      <label class="zql-enabled-wrap" title="启用">
        <input class="zql-enabled" type="checkbox" />
      </label>
      <div class="zql-preview" aria-hidden="true">
        <img class="zql-preview-image" alt="" draggable="false" />
      </div>
      <div class="zql-fields">
        <label>
          <span>名称</span>
          <input class="zql-name" type="text" placeholder="例如 PVE" />
        </label>
        <label>
          <span>URL / IP / 端口</span>
          <input class="zql-url" type="text"
                 placeholder="https://192.168.1.10:8006 或 10.1.80.215:5244" />
        </label>
        <label>
          <span>图标</span>
          <input class="zql-icon" type="text" placeholder="auto 或图标 URL" />
        </label>
      </div>
      <div class="zql-item-actions">
        <button type="button" class="zql-button" data-action="test"
                title="在新标签页打开">打开</button>
        <button type="button" class="zql-button" data-action="duplicate"
                title="复制此入口">复制</button>
        <button type="button" class="zql-button zql-danger" data-action="delete"
                title="删除">删除</button>
      </div>
    </article>`;

  if (window[INSTANCE_KEY]) {
    return;
  }

  const state = {
    loaded: true,
    panel: null,
    refs: null,
    rowTemplate: null,
    model: [],
    dirty: false,
    dragId: null,
    dragArmed: false,
    tabObserver: null,
    keyListener: null,
  };
  window[INSTANCE_KEY] = state;

  const warn = (...args) =>
    console.warn("[Zen Quick Launch]", ...args);

  // browser.xhtml is an XML document whose fragment parser drops form
  // controls, so innerHTML cannot be used to build the panel. DOMParser keeps
  // the markup intact and importNode adopts it into this document.
  function parseMarkup(source) {
    const doc = new DOMParser().parseFromString(
      `<root xmlns="${XHTML_NS}">${source}</root>`,
      "application/xhtml+xml"
    );

    const error = doc.querySelector("parsererror");
    if (error) {
      warn("Invalid settings markup:", error.textContent);
      return null;
    }

    return document.importNode(doc.documentElement, true);
  }

  function makeId() {
    return `ql-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  }

  function cloneDefaults() {
    return DEFAULT_ITEMS.map((item) => ({ ...item }));
  }

  // Ids come from prefs / imported JSON, so they can collide. Keep the first
  // occurrence and regenerate the rest: the editor uses ids to update, delete
  // and reorder rows, so duplicates would edit the wrong entry.
  function ensureUniqueIds(entries) {
    const seen = new Set();
    return entries.map((entry) => {
      let id = String(entry.id || makeId());
      if (seen.has(id)) {
        id = makeId();
      }
      seen.add(id);
      return { ...entry, id };
    });
  }

  function isValidUrl(value) {
    try {
      const uri = Services.io.newURI(value);
      return ["http", "https", "about", "file"].includes(uri.scheme);
    } catch (_error) {
      return false;
    }
  }

  // "10.1.80.215:5244", "localhost:3000" and "example.com" are all valid
  // things to type here, so give them an http:// prefix.
  function normalizeUrl(value) {
    const clean = String(value || "").trim();
    if (!clean) {
      return "";
    }
    if (isValidUrl(clean)) {
      return clean;
    }
    if (!clean.includes("://")) {
      const withScheme = `http://${clean}`;
      if (isValidUrl(withScheme)) {
        return withScheme;
      }
    }
    return clean;
  }

  function stripFragment(url) {
    const value = String(url || "");
    const index = value.indexOf("#");
    return index === -1 ? value : value.slice(0, index);
  }

  // Mirrors the sidebar: when the URL is open in a tab, show the same favicon
  // the tab strip shows instead of the icon stored in Places.
  function currentTabIcon(url) {
    const wanted = stripFragment(url);
    let looseMatch = "";

    for (const tab of window.gBrowser?.tabs || []) {
      let spec = "";
      try {
        spec = tab.linkedBrowser?.currentURI?.spec || "";
      } catch (_error) {
        spec = "";
      }

      const image = spec ? tab.getAttribute("image") || "" : "";
      if (!image) {
        continue;
      }

      if (spec === url) {
        return image;
      }

      if (!looseMatch && stripFragment(spec) === wanted) {
        looseMatch = image;
      }
    }

    return looseMatch;
  }

  function iconFor(item) {
    const custom = String(item.icon || "").trim();
    if (custom && custom !== "auto") {
      return custom;
    }

    const url = normalizeUrl(item.url);
    const live = currentTabIcon(url);
    if (live) {
      return live;
    }

    try {
      const uri = Services.io.newURI(url);
      if (uri.scheme === "http" || uri.scheme === "https") {
        return `page-icon:${url}`;
      }
    } catch (_error) {}
    return DEFAULT_ICON;
  }

  // page-icon: fails while the favicon is still unknown, so retry a few times
  // before falling back to the generic icon. Same policy as the sidebar.
  function loadIcon(image, src, attempt = 0) {
    const target = src || DEFAULT_ICON;
    image.dataset.iconSrc = target;

    image.onload = () => {
      image.onerror = null;
    };

    image.onerror = () => {
      if (target !== DEFAULT_ICON && attempt < ICON_MAX_ATTEMPTS) {
        setTimeout(() => {
          if (image.isConnected) {
            loadIcon(image, target, attempt + 1);
          }
        }, ICON_RETRY_DELAY * (attempt + 1));
        return;
      }

      image.onerror = null;
      if (target !== DEFAULT_ICON) {
        loadIcon(image, DEFAULT_ICON, 0);
      }
    };

    image.src = target;
  }

  function previewFor(item, article) {
    const image = article.querySelector(".zql-preview-image");
    const src = iconFor(item);
    if (image.dataset.iconSrc === src) {
      return;
    }
    loadIcon(image, src);
  }

  function refreshPreviews() {
    if (!state.panel || state.panel.hidden || !state.refs) {
      return;
    }

    for (const article of state.refs.items.children) {
      const item = state.model.find(
        (entry) => entry.id === article.dataset.id
      );
      if (item) {
        previewFor(item, article);
      }
    }
  }

  function onTabChange(event) {
    if (
      event.type === "TabAttrModified" &&
      !event.detail?.changed?.includes("image")
    ) {
      return;
    }
    requestAnimationFrame(refreshPreviews);
  }

  function attachTabObservers() {
    if (state.tabObserver) {
      return;
    }

    state.tabObserver = onTabChange;
    window.addEventListener("TabAttrModified", state.tabObserver);
    window.addEventListener("TabClose", state.tabObserver);
    window.addEventListener("TabBrowserDiscarded", state.tabObserver);
  }

  function detachTabObservers() {
    if (!state.tabObserver) {
      return;
    }

    window.removeEventListener("TabAttrModified", state.tabObserver);
    window.removeEventListener("TabClose", state.tabObserver);
    window.removeEventListener("TabBrowserDiscarded", state.tabObserver);
    state.tabObserver = null;
  }

  function setStatus(message = "", type = "") {
    if (!state.refs) {
      return;
    }
    state.refs.status.textContent = message;
    state.refs.status.className = `zql-status${type ? ` zql-${type}` : ""}`;
  }

  function markDirty() {
    state.dirty = true;
    setStatus("有尚未保存的修改");
  }

  function ensurePanel() {
    if (state.panel?.isConnected) {
      return state.panel;
    }

    const panelMarkup = parseMarkup(PANEL_HTML);
    const rowMarkup = parseMarkup(ROW_HTML);
    if (!panelMarkup || !rowMarkup) {
      return null;
    }

    const panel = document.createElementNS(XHTML_NS, "div");
    panel.id = PANEL_ID;
    panel.hidden = true;
    while (panelMarkup.firstChild) {
      panel.appendChild(panelMarkup.firstChild);
    }

    document.documentElement.appendChild(panel);

    state.panel = panel;
    state.rowTemplate = rowMarkup.firstElementChild;
    state.refs = {
      status: panel.querySelector(".zql-status"),
      items: panel.querySelector(".zql-items"),
      empty: panel.querySelector(".zql-empty"),
      columns: panel.querySelector(".zql-columns"),
      ctrlBackground: panel.querySelector(".zql-ctrl-background"),
      importInput: panel.querySelector(".zql-import-input"),
    };

    panel.addEventListener("click", onPanelClick);
    panel.addEventListener("input", onPanelInput);
    panel.addEventListener("change", onPanelChange);
    state.refs.importInput.addEventListener("change", onImportPicked);

    return panel;
  }

  function onPanelClick(event) {
    const actionEl = event.target.closest?.("[data-action]");
    if (!actionEl) {
      return;
    }

    const article = actionEl.closest(".zql-item");
    switch (actionEl.dataset.action) {
      case "close":
        close();
        break;
      case "add":
        addItem();
        break;
      case "save":
        save();
        break;
      case "reset":
        resetDefaults();
        break;
      case "export":
        exportConfig();
        break;
      case "test":
        testItem(article);
        break;
      case "duplicate":
        duplicateItem(article);
        break;
      case "delete":
        deleteItem(article);
        break;
    }
  }

  function onPanelInput(event) {
    const article = event.target.closest?.(".zql-item");
    if (!article) {
      return;
    }
    updateModelFromArticle(article);
    markDirty();
  }

  function onPanelChange(event) {
    if (
      event.target.classList.contains("zql-columns") ||
      event.target.classList.contains("zql-ctrl-background")
    ) {
      markDirty();
      return;
    }

    const article = event.target.closest?.(".zql-item");
    if (article) {
      updateModelFromArticle(article);
      markDirty();
    }
  }

  function onImportPicked(event) {
    const [file] = event.target.files;
    if (file) {
      importConfig(file);
    }
    event.target.value = "";
  }

  function updateModelFromArticle(article) {
    const item = state.model.find(
      (entry) => entry.id === article.dataset.id
    );
    if (!item) {
      return;
    }

    item.enabled = article.querySelector(".zql-enabled").checked;
    item.name = article.querySelector(".zql-name").value;
    item.url = article.querySelector(".zql-url").value;
    item.icon = article.querySelector(".zql-icon").value || "auto";

    previewFor(item, article);
  }

  function syncVisibleEditors() {
    if (!state.refs) {
      return;
    }
    for (const article of state.refs.items.children) {
      updateModelFromArticle(article);
    }
  }

  function createArticle(item) {
    const article = state.rowTemplate.cloneNode(true);
    article.dataset.id = item.id;

    article.querySelector(".zql-enabled").checked = item.enabled;
    article.querySelector(".zql-name").value = item.name;
    article.querySelector(".zql-url").value = item.url;
    article.querySelector(".zql-icon").value = item.icon;

    // Only the handle arms dragging: the row also contains a checkbox and text
    // inputs, which must stay usable (text selection, etc.).
    const handle = article.querySelector(".zql-drag");
    handle.addEventListener("mousedown", () => {
      state.dragArmed = true;
      article.draggable = true;
    });

    article.addEventListener("mouseup", () => {
      if (!state.dragId) {
        state.dragArmed = false;
        article.draggable = false;
      }
    });

    article.addEventListener("dragstart", (event) => {
      if (!state.dragArmed) {
        event.preventDefault();
        return;
      }
      updateModelFromArticle(article);
      state.dragId = item.id;
      article.classList.add("zql-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", item.id);
    });

    article.addEventListener("dragend", () => {
      state.dragArmed = false;
      article.draggable = false;
      state.dragId = null;
      article.classList.remove("zql-dragging");
      for (const el of state.refs.items.children) {
        el.classList.remove("zql-drop-target");
      }
    });

    article.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (state.dragId && state.dragId !== item.id) {
        article.classList.add("zql-drop-target");
      }
    });

    article.addEventListener("dragleave", () => {
      article.classList.remove("zql-drop-target");
    });

    article.addEventListener("drop", (event) => {
      event.preventDefault();
      article.classList.remove("zql-drop-target");

      const sourceId =
        state.dragId || event.dataTransfer.getData("text/plain");
      if (!sourceId || sourceId === item.id) {
        return;
      }

      syncVisibleEditors();

      const from = state.model.findIndex(
        (entry) => entry.id === sourceId
      );
      const to = state.model.findIndex(
        (entry) => entry.id === item.id
      );
      if (from < 0 || to < 0) {
        return;
      }

      const [moved] = state.model.splice(from, 1);
      state.model.splice(to, 0, moved);
      render();
      setStatus("顺序已修改，点击“保存并应用”后生效");
      state.dirty = true;
    });

    previewFor(item, article);
    return article;
  }

  function render() {
    const { items, empty } = state.refs;
    items.replaceChildren();

    for (const item of state.model) {
      items.appendChild(createArticle(item));
    }

    empty.hidden = state.model.length !== 0;
    items.hidden = state.model.length === 0;
  }

  function loadPrefs() {
    let parsed;
    try {
      parsed = JSON.parse(
        Services.prefs.getStringPref(
          PREF_ITEMS,
          JSON.stringify(DEFAULT_ITEMS)
        )
      );
      if (!Array.isArray(parsed)) {
        throw new Error("items is not an array");
      }
    } catch (error) {
      warn("Invalid zen.quicklaunch.items JSON. Using defaults.", error);
      parsed = cloneDefaults();
    }

    state.model = ensureUniqueIds(
      parsed.map((item) => ({
        id: String(item?.id || makeId()),
        name: String(item?.name || ""),
        url: String(item?.url || ""),
        icon: String(item?.icon || "auto"),
        enabled: item?.enabled !== false,
      }))
    );

    state.refs.columns.value = String(
      Math.max(1, Math.min(6, Services.prefs.getIntPref(PREF_COLUMNS, 3)))
    );
    state.refs.ctrlBackground.checked =
      Services.prefs.getBoolPref(PREF_CTRL_BG, true);

    state.dirty = false;
    render();
  }

  function addItem() {
    syncVisibleEditors();

    state.model.push({
      id: makeId(),
      name: "",
      url: "",
      icon: "auto",
      enabled: true,
    });
    render();

    const last = state.refs.items.lastElementChild;
    last?.querySelector(".zql-name")?.focus();
    last?.scrollIntoView({ behavior: "smooth", block: "center" });

    setStatus("已添加，填写后点击“保存并应用”");
    state.dirty = true;
  }

  function duplicateItem(article) {
    updateModelFromArticle(article);
    const index = state.model.findIndex(
      (entry) => entry.id === article.dataset.id
    );
    if (index < 0) {
      return;
    }

    state.model.splice(index + 1, 0, {
      ...state.model[index],
      id: makeId(),
      name: `${state.model[index].name || "入口"} 副本`,
    });
    render();
    setStatus("已复制，点击“保存并应用”后生效");
    state.dirty = true;
  }

  function deleteItem(article) {
    updateModelFromArticle(article);
    state.model = state.model.filter(
      (entry) => entry.id !== article.dataset.id
    );
    render();
    setStatus("已删除，点击“保存并应用”后生效");
    state.dirty = true;
  }

  function testItem(article) {
    if (!article) {
      return;
    }

    updateModelFromArticle(article);
    const input = article.querySelector(".zql-url");
    const target = normalizeUrl(
      state.model.find((entry) => entry.id === article.dataset.id)?.url
    );

    if (!isValidUrl(target)) {
      input.classList.add("zql-invalid");
      setStatus("URL 无效，无法打开", "error");
      return;
    }
    input.classList.remove("zql-invalid");

    try {
      window.openTrustedLinkIn(target, "tab");
    } catch (error) {
      console.error("[Zen Quick Launch] Failed to open URL:", error);
      setStatus("打开失败，请检查 URL。", "error");
    }
  }

  function validate() {
    syncVisibleEditors();

    let valid = true;
    for (const article of state.refs.items.children) {
      const item = state.model.find(
        (entry) => entry.id === article.dataset.id
      );
      const input = article.querySelector(".zql-url");

      if (item.enabled && !isValidUrl(normalizeUrl(item.url))) {
        input.classList.add("zql-invalid");
        valid = false;
      } else {
        input.classList.remove("zql-invalid");
      }
    }

    return valid;
  }

  function save() {
    if (!validate()) {
      setStatus("存在已启用但 URL 无效的入口，请先修正。", "error");
      return;
    }

    const clean = ensureUniqueIds(
      state.model.map((item) => {
        const target = normalizeUrl(item.url);
        return {
          id: item.id || makeId(),
          name:
            item.name.trim() ||
            item.url.trim() ||
            target ||
            "Quick Launch",
          url: target,
          icon: String(item.icon || "").trim() || "auto",
          enabled: item.enabled !== false,
        };
      })
    );

    Services.prefs.setStringPref(PREF_ITEMS, JSON.stringify(clean));
    Services.prefs.setIntPref(
      PREF_COLUMNS,
      Number(state.refs.columns.value) || 3
    );
    Services.prefs.setBoolPref(
      PREF_CTRL_BG,
      state.refs.ctrlBackground.checked
    );

    try {
      // set*Pref only lives in memory until Firefox flushes, so write the file
      // now: a crash or a "kill" would otherwise lose the configuration.
      Services.prefs.savePrefFile(null);
    } catch (error) {
      warn("Could not flush prefs to disk:", error);
    }

    state.model = clean;
    state.dirty = false;
    render();
    setStatus("已保存，并已实时应用到 Zen 侧栏。", "ok");
  }

  function exportConfig() {
    syncVisibleEditors();

    const payload = {
      format: "zen-quick-launch",
      columns: Number(state.refs.columns.value) || 3,
      ctrlBackground: state.refs.ctrlBackground.checked,
      items: state.model,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElementNS(XHTML_NS, "a");
    link.href = url;
    link.download = "zen-quick-launch.json";
    document.documentElement.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);

    setStatus("配置已导出。", "ok");
  }

  async function importConfig(file) {
    try {
      const payload = JSON.parse(await file.text());

      if (!payload || !Array.isArray(payload.items)) {
        throw new Error("JSON 中缺少 items 数组");
      }

      state.model = ensureUniqueIds(
        payload.items.map((item) => ({
          id: String(item?.id || makeId()),
          name: String(item?.name || ""),
          url: String(item?.url || ""),
          icon: String(item?.icon || "auto"),
          enabled: item?.enabled !== false,
        }))
      );

      if (payload.columns) {
        state.refs.columns.value = String(
          Math.max(1, Math.min(6, Number(payload.columns) || 3))
        );
      }

      if (typeof payload.ctrlBackground === "boolean") {
        state.refs.ctrlBackground.checked = payload.ctrlBackground;
      }

      render();
      setStatus("已导入。检查内容后点击“保存并应用”。", "ok");
      state.dirty = true;
    } catch (error) {
      console.error("[Zen Quick Launch] Import failed:", error);
      setStatus(`导入失败：${error.message}`, "error");
    }
  }

  function resetDefaults() {
    if (
      !window.confirm(
        "恢复默认的 4 个示例入口？当前未保存修改会丢失。"
      )
    ) {
      return;
    }

    state.model = cloneDefaults();
    state.refs.columns.value = "3";
    state.refs.ctrlBackground.checked = true;
    render();
    setStatus("已恢复默认预览。点击“保存并应用”后生效。");
    state.dirty = true;
  }

  function attachKeyListener() {
    if (state.keyListener) {
      return;
    }

    state.keyListener = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }

      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "s"
      ) {
        event.preventDefault();
        event.stopPropagation();
        save();
      }
    };

    window.addEventListener("keydown", state.keyListener, true);
  }

  function detachKeyListener() {
    if (!state.keyListener) {
      return;
    }
    window.removeEventListener("keydown", state.keyListener, true);
    state.keyListener = null;
  }

  function open() {
    if (!state.loaded) {
      return;
    }

    const panel = ensurePanel();
    if (!panel) {
      return;
    }

    if (!panel.hidden) {
      panel.querySelector(".zql-item input, .zql-item button")?.focus();
      return;
    }

    // Re-read the prefs only when there is nothing to lose, so a panel that was
    // closed by accident keeps the edits the user has not saved yet.
    if (!state.dirty) {
      loadPrefs();
      setStatus("设置已加载。", "ok");
    }

    panel.hidden = false;
    attachTabObservers();
    attachKeyListener();

    panel
      .querySelector(".zql-name, .zql-columns, [data-action='add']")
      ?.focus();
    refreshPreviews();
  }

  function close() {
    if (!state.panel || state.panel.hidden) {
      return;
    }

    state.panel.hidden = true;
    detachTabObservers();
    detachKeyListener();
  }

  function cleanup() {
    if (!state.loaded) {
      return;
    }
    state.loaded = false;

    detachTabObservers();
    detachKeyListener();

    try {
      state.panel?.remove();
    } catch (_error) {}
    state.panel = null;
    state.refs = null;
    state.rowTemplate = null;

    try {
      delete window[INSTANCE_KEY];
      delete window[GLOBAL_API_KEY];
    } catch (_error) {}
  }

  window[GLOBAL_API_KEY] = {
    open,
    close,
    get isOpen() {
      return !!state.panel && !state.panel.hidden;
    },
  };

  window.addEventListener("unload", cleanup, { once: true });
  if (typeof window.addUnloadListener === "function") {
    window.addUnloadListener(cleanup);
  }

  console.log("[Zen Quick Launch] Settings panel ready");
})();
