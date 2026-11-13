// Quick Launch settings page.
//
// Opened as a normal privileged chrome page at
// chrome://zen-quick-launch/content/settings.html. Keeping the page in its own
// tab means it survives sidebar reloads and can be bookmarked like any other
// page.
(() => {
  "use strict";

  const PANEL_ID = "zen-quick-launch-settings";
  const TEMPLATE_ID = "zql-row-template";
  const OPEN_URL_TOPIC = "zen-quick-launch:open-url";
  const XHTML_NS = "http://www.w3.org/1999/xhtml";

  const PREF_ITEMS = "zen.quicklaunch.items";
  const PREF_CTRL_BG = "zen.quicklaunch.ctrlBackground";
  const PREF_MODE = "zen.quicklaunch.mode";
  const PREF_BOOKMARK_FOLDER = "zen.quicklaunch.bookmarkFolder";
  const DEFAULT_BOOKMARK_FOLDER = "toolbar_____";

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

  const state = {
    refs: null,
    rowTemplate: null,
    model: [],
    dirty: false,
    dragId: null,
    dragArmed: false,
    keyListener: null,
    bookmarkRefreshId: 0,
  };

  const warn = (...args) =>
    console.warn("[Zen Quick Launch]", ...args);

  let placesUtilsPromise = null;

  function getPlacesUtils() {
    if (!placesUtilsPromise) {
      placesUtilsPromise = Promise.resolve().then(() => {
        const { PlacesUtils } = ChromeUtils.importESModule(
          "resource://gre/modules/PlacesUtils.sys.mjs"
        );
        return PlacesUtils;
      });
    }
    return placesUtilsPromise;
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

  function iconFor(item) {
    const custom = String(item.icon || "").trim();
    if (custom && custom !== "auto") {
      return custom;
    }

    const url = normalizeUrl(item.url);
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

  function bindDom() {
    const root = document.getElementById(PANEL_ID);
    const template = document.getElementById(TEMPLATE_ID);
    if (!root || !template) {
      throw new Error("Settings markup is incomplete.");
    }

    state.refs = {
      status: root.querySelector(".zql-status"),
      items: root.querySelector(".zql-items"),
      empty: root.querySelector(".zql-empty"),
      ctrlBackground: root.querySelector(".zql-ctrl-background"),
      importInput: root.querySelector(".zql-import-input"),
      mode: root.querySelector(".zql-mode"),
      folderField: root.querySelector(".zql-folder-field"),
      bookmarkFolder: root.querySelector(".zql-bookmark-folder"),
      bookmarkInfo: root.querySelector(".zql-bookmark-info"),
      bookmarkList: root.querySelector(".zql-bookmark-list"),
      bookmarkEmpty: root.querySelector(".zql-bookmark-empty"),
      bookmarkError: root.querySelector(".zql-bookmark-error"),
      addButton: root.querySelector(".zql-add-button"),
    };
    state.rowTemplate = template.content.firstElementChild;

    root.addEventListener("click", onPanelClick);
    root.addEventListener("input", onPanelInput);
    root.addEventListener("change", onPanelChange);
    state.refs.importInput.addEventListener("change", onImportPicked);
  }

  function onPanelClick(event) {
    const actionEl = event.target.closest?.("[data-action]");
    if (!actionEl) {
      return;
    }

    const article = actionEl.closest(".zql-item");
    switch (actionEl.dataset.action) {
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
    if (event.target.classList.contains("zql-mode")) {
      updateModeVisibility();
      refreshBookmarkPreview();
      markDirty();
      return;
    }

    if (event.target.classList.contains("zql-bookmark-folder")) {
      refreshBookmarkPreview();
      markDirty();
      return;
    }

    if (event.target.classList.contains("zql-ctrl-background")) {
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
      state.dragId = null;
      state.dragArmed = false;
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
    updateModeVisibility();
  }

  function isBookmarksMode() {
    return state.refs.mode.value === "bookmarks";
  }

  function updateModeVisibility() {
    const bookmarksMode = isBookmarksMode();
    state.refs.folderField.hidden = !bookmarksMode;
    state.refs.bookmarkInfo.hidden = !bookmarksMode;
    state.refs.addButton.hidden = bookmarksMode;

    if (bookmarksMode) {
      state.refs.items.hidden = true;
      state.refs.empty.hidden = true;
    } else {
      state.refs.items.hidden = state.model.length === 0;
      state.refs.empty.hidden = state.model.length !== 0;
    }
  }

  async function listBookmarkFolders() {
    const PlacesUtils = await getPlacesUtils();
    const folders = [];
    const seen = new Set();

    const walk = async (guid, parents) => {
      if (!guid || seen.has(guid)) {
        return;
      }
      seen.add(guid);

      // fetch() returns only the first result; onResult visits every child.
      const children = [];
      await PlacesUtils.bookmarks.fetch(
        { parentGuid: guid },
        (node) => children.push(node)
      );
      for (const child of children) {
        if (child.type !== PlacesUtils.bookmarks.TYPE_FOLDER) {
          continue;
        }
        const title = String(child.title || "未命名文件夹");
        const path = [...parents, title];
        folders.push({ guid: child.guid, path: path.join(" / ") });
        await walk(child.guid, path);
      }
    };

    const roots = [
      [PlacesUtils.bookmarks.toolbarGuid, "书签工具栏"],
      [PlacesUtils.bookmarks.menuGuid, "书签菜单"],
      [PlacesUtils.bookmarks.unfiledGuid, "其他书签"],
      [PlacesUtils.bookmarks.mobileGuid, "移动设备书签"],
    ];

    for (const [guid, title] of roots) {
      folders.push({ guid, path: title });
      try {
        await walk(guid, [title]);
      } catch (error) {
        warn(`Could not list subfolders of ${title}.`, error);
      }
    }

    return folders;
  }

  async function populateFolderOptions() {
    const select = state.refs.bookmarkFolder;
    const saved = Services.prefs.getStringPref(
      PREF_BOOKMARK_FOLDER,
      DEFAULT_BOOKMARK_FOLDER
    );

    select.disabled = true;
    select.replaceChildren();

    try {
      const folders = await listBookmarkFolders();
      for (const folder of folders) {
        select.add(new Option(folder.path, folder.guid));
      }

      if (saved && !folders.some((folder) => folder.guid === saved)) {
        select.add(new Option("（已选文件夹不可用）", saved));
      }

      select.value = saved || folders[0]?.guid || "";
      state.refs.bookmarkError.hidden = true;
    } catch (error) {
      console.error("[Zen Quick Launch] Could not list bookmark folders:", error);
      select.add(new Option("无法读取书签文件夹", ""));
      select.value = "";
      state.refs.bookmarkError.textContent =
        "无法读取书签文件夹；请确认设置页是通过 chrome:// 地址打开的。";
      state.refs.bookmarkError.hidden = false;
    } finally {
      select.disabled = false;
    }
  }

  async function refreshBookmarkPreview() {
    if (!state.refs) {
      return;
    }

    const requestId = ++state.bookmarkRefreshId;
    const list = state.refs.bookmarkList;
    const empty = state.refs.bookmarkEmpty;
    const error = state.refs.bookmarkError;
    list.replaceChildren();
    empty.hidden = true;
    error.hidden = true;

    if (!isBookmarksMode()) {
      return;
    }

    const folder = state.refs.bookmarkFolder.value;
    if (!folder) {
      empty.hidden = false;
      return;
    }

    try {
      const PlacesUtils = await getPlacesUtils();
      const children = [];
      await PlacesUtils.bookmarks.fetch(
        { parentGuid: folder },
        (node) => children.push(node)
      );
      if (requestId !== state.bookmarkRefreshId || !isBookmarksMode()) {
        return;
      }

      const bookmarks = children.filter(
        (node) =>
          node.type === PlacesUtils.bookmarks.TYPE_BOOKMARK && node.url
      );

      for (const bookmark of bookmarks) {
        const li = document.createElement("li");
        li.textContent =
          bookmark.title ||
          bookmark.url?.href ||
          String(bookmark.url || "");
        list.appendChild(li);
      }

      empty.hidden = bookmarks.length !== 0;
    } catch (err) {
      if (requestId === state.bookmarkRefreshId) {
        error.textContent = "无法读取该书签文件夹。";
        error.hidden = false;
      }
    }
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

    state.refs.ctrlBackground.checked =
      Services.prefs.getBoolPref(PREF_CTRL_BG, true);

    const mode = Services.prefs.getStringPref(PREF_MODE, "custom");
    state.refs.mode.value = mode === "bookmarks" ? "bookmarks" : "custom";

    const folder = Services.prefs.getStringPref(
      PREF_BOOKMARK_FOLDER,
      DEFAULT_BOOKMARK_FOLDER
    );
    if (
      folder &&
      !Array.from(state.refs.bookmarkFolder.options).some(
        (option) => option.value === folder
      )
    ) {
      state.refs.bookmarkFolder.add(
        new Option("（已选文件夹不可用）", folder)
      );
    }
    state.refs.bookmarkFolder.value =
      folder || state.refs.bookmarkFolder.value;

    state.dirty = false;
    render();
    refreshBookmarkPreview();
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

  // Chrome documents usually run in the parent process, where the browser
  // window is directly reachable. Remote chrome pages use the message manager
  // as a fallback, and a plain window.open is the last resort.
  function openInTab(url) {
    try {
      const browserWindow = Services.wm.getMostRecentWindow(
        "navigator:browser"
      );
      if (typeof browserWindow?.openTrustedLinkIn === "function") {
        browserWindow.openTrustedLinkIn(url, "tab");
        return;
      }
    } catch (error) {
      warn("Direct browser window access failed.", error);
    }

    try {
      Services.cpmm.sendAsyncMessage(OPEN_URL_TOPIC, { url });
    } catch (error) {
      warn("Could not ask the browser window to open the URL.", error);
      window.open(url, "_blank");
    }
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
    openInTab(target);
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
    const mode = isBookmarksMode() ? "bookmarks" : "custom";
    const folder = state.refs.bookmarkFolder.value;

    if (mode === "custom" && !validate()) {
      setStatus("存在已启用但 URL 无效的入口，请先修正。", "error");
      return;
    }

    if (mode === "bookmarks" && !folder) {
      setStatus("请先选择一个书签文件夹。", "error");
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
    Services.prefs.setBoolPref(
      PREF_CTRL_BG,
      state.refs.ctrlBackground.checked
    );
    Services.prefs.setStringPref(PREF_MODE, mode);
    Services.prefs.setStringPref(PREF_BOOKMARK_FOLDER, folder);

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
    refreshBookmarkPreview();
    setStatus("已保存，并已实时应用到 Zen 侧栏。", "ok");
  }

  function exportConfig() {
    syncVisibleEditors();

    const payload = {
      format: "zen-quick-launch",
      mode: isBookmarksMode() ? "bookmarks" : "custom",
      bookmarkFolder: state.refs.bookmarkFolder.value,
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
    document.body.appendChild(link);
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

      if (typeof payload.ctrlBackground === "boolean") {
        state.refs.ctrlBackground.checked = payload.ctrlBackground;
      }

      state.refs.mode.value =
        payload.mode === "bookmarks" ? "bookmarks" : "custom";

      if (
        payload.mode === "bookmarks" &&
        typeof payload.bookmarkFolder === "string" &&
        payload.bookmarkFolder
      ) {
        const select = state.refs.bookmarkFolder;
        if (
          !Array.from(select.options).some(
            (option) => option.value === payload.bookmarkFolder
          )
        ) {
          select.add(
            new Option("（已导入文件夹）", payload.bookmarkFolder)
          );
        }
        select.value = payload.bookmarkFolder;
      }

      render();
      refreshBookmarkPreview();
      setStatus("已导入。检查内容后点击“保存并应用”。", "ok");
      state.dirty = true;
    } catch (error) {
      console.error("[Zen Quick Launch] Import failed:", error);
      setStatus(`导入失败：${error.message}`, "error");
    }
  }

  function resetDefaults() {
    const confirmed = Services.prompt.confirm(
      window,
      "Zen Quick Launch",
      "恢复默认的 4 个示例入口？当前未保存修改会丢失。"
    );
    if (!confirmed) {
      return;
    }

    state.model = cloneDefaults();
    state.refs.mode.value = "custom";
    state.refs.ctrlBackground.checked = true;
    if (
      Array.from(state.refs.bookmarkFolder.options).some(
        (option) => option.value === DEFAULT_BOOKMARK_FOLDER
      )
    ) {
      state.refs.bookmarkFolder.value = DEFAULT_BOOKMARK_FOLDER;
    }
    render();
    refreshBookmarkPreview();
    setStatus("已恢复默认预览。点击“保存并应用”后生效。");
    state.dirty = true;
  }

  function attachKeyListener() {
    if (state.keyListener) {
      return;
    }

    state.keyListener = (event) => {
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

  function highlightFromHash() {
    const raw = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (!raw) {
      return;
    }

    const id = raw.startsWith("entry=") ? raw.slice(6) : raw;
    const article = Array.from(state.refs.items.children).find(
      (entry) => entry.dataset.id === id
    );
    if (!article) {
      return;
    }

    article.scrollIntoView({ behavior: "smooth", block: "center" });
    article.classList.add("zql-highlight");
    setTimeout(() => {
      article.classList.remove("zql-highlight");
    }, 2500);
  }

  async function init() {
    try {
      bindDom();
    } catch (error) {
      console.error("[Zen Quick Launch] Settings page failed to load:", error);
      return;
    }

    await populateFolderOptions();
    loadPrefs();
    setStatus("设置已加载。Ctrl/Cmd + S 可保存。", "ok");
    attachKeyListener();
    highlightFromHash();
    window.addEventListener("hashchange", highlightFromHash);
  }

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
