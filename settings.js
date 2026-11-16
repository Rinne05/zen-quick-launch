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
    folderRoots: [],
    folderNodes: new Map(),
    expandedFolders: new Set(),
    bookmarkChildren: [],
    bookmarkDragGuid: null,
    bookmarkDrop: null,
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
      folderPicker: root.querySelector(".zql-folder-picker"),
      folderButton: root.querySelector(".zql-folder-button"),
      folderPopover: root.querySelector(".zql-folder-popover"),
      folderTree: root.querySelector(".zql-folder-tree"),
      folderCurrent: root.querySelector(".zql-folder-current"),
      bookmarkInfo: root.querySelector(".zql-bookmark-info"),
      bookmarkEditor: root.querySelector(".zql-bookmark-editor"),
      bookmarkAdd: root.querySelector(".zql-bookmark-add"),
      bookmarkNewName: root.querySelector(".zql-bookmark-new-name"),
      bookmarkNewUrl: root.querySelector(".zql-bookmark-new-url"),
      bookmarkEmpty: root.querySelector(".zql-bookmark-empty"),
      bookmarkError: root.querySelector(".zql-bookmark-error"),
      addButton: root.querySelector(".zql-add-button"),
    };
    state.rowTemplate = template.content.firstElementChild;

    root.addEventListener("click", onPanelClick);
    root.addEventListener("input", onPanelInput);
    root.addEventListener("change", onPanelChange);
    root.addEventListener("keydown", onPanelKeydown);
    state.refs.importInput.addEventListener("change", onImportPicked);
    state.refs.folderButton.addEventListener("click", () =>
      toggleFolderPopover()
    );
    state.refs.folderTree.addEventListener("click", onFolderTreeClick);
    document.addEventListener("pointerdown", onDocumentPointerDown);
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
      case "bookmark-add-toggle":
        toggleBookmarkAdd();
        break;
      case "bookmark-add":
        addBookmark();
        break;
      case "bookmark-delete":
        deleteBookmark(actionEl.closest(".zql-bookmark-item"));
        break;
      case "bookmark-open":
        openBookmark(actionEl.closest(".zql-bookmark-item"));
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

    if (event.target.classList.contains("zql-ctrl-background")) {
      markDirty();
      return;
    }

    const bookmarkRow = event.target.closest?.(".zql-bookmark-item");
    if (
      bookmarkRow &&
      (event.target.classList.contains("zql-bookmark-name") ||
        event.target.classList.contains("zql-bookmark-url"))
    ) {
      updateBookmarkRow(bookmarkRow);
      return;
    }

    const article = event.target.closest?.(".zql-item");
    if (article) {
      updateModelFromArticle(article);
      markDirty();
    }
  }

  function onPanelKeydown(event) {
    if (event.key !== "Enter") {
      return;
    }

    if (
      event.target.classList.contains("zql-bookmark-name") ||
      event.target.classList.contains("zql-bookmark-url")
    ) {
      event.preventDefault();
      updateBookmarkRow(event.target.closest(".zql-bookmark-item"));
      return;
    }

    if (
      event.target.classList.contains("zql-bookmark-new-name") ||
      event.target.classList.contains("zql-bookmark-new-url")
    ) {
      event.preventDefault();
      addBookmark();
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
    if (!bookmarksMode) {
      closeFolderPopover();
    }

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
    const seen = new Set();

    const buildNode = async (guid, title, parents, parent = null) => {
      const safeTitle = String(title || "未命名文件夹");
      const node = {
        guid,
        title: safeTitle,
        path: [...parents, safeTitle].join(" / "),
        parent,
        children: [],
      };

      if (seen.has(guid)) {
        return node;
      }
      seen.add(guid);

      const children = [];
      try {
        await PlacesUtils.bookmarks.fetch(
          { parentGuid: guid },
          (child) => children.push(child)
        );
      } catch (error) {
        warn(`Could not list subfolders of ${safeTitle}.`, error);
        return node;
      }

      for (const child of children) {
        if (child.type !== PlacesUtils.bookmarks.TYPE_FOLDER) {
          continue;
        }
        node.children.push(
          await buildNode(
            child.guid,
            child.title,
            [...parents, safeTitle],
            node
          )
        );
      }

      return node;
    };

    const roots = [
      [PlacesUtils.bookmarks.toolbarGuid, "书签工具栏"],
      [PlacesUtils.bookmarks.menuGuid, "书签菜单"],
      [PlacesUtils.bookmarks.unfiledGuid, "其他书签"],
      [PlacesUtils.bookmarks.mobileGuid, "移动设备书签"],
    ];

    const tree = [];
    for (const [guid, title] of roots) {
      try {
        tree.push(await buildNode(guid, title, []));
      } catch (error) {
        warn(`Could not list folder ${title}.`, error);
        tree.push({
          guid,
          title,
          path: title,
          parent: null,
          children: [],
        });
      }
    }

    return tree;
  }

  function indexFolderNodes(nodes) {
    state.folderNodes = new Map();
    const visit = (node, parent) => {
      node.parent = parent;
      state.folderNodes.set(node.guid, node);
      for (const child of node.children) {
        visit(child, node);
      }
    };
    for (const node of nodes) {
      visit(node, null);
    }
  }

  function setSelectedFolder(guid, { dirty = false, close = false } = {}) {
    state.refs.bookmarkFolder.value = guid || "";
    updateFolderSelectionUI();
    if (close) {
      closeFolderPopover();
      state.refs.folderButton.focus({ preventScroll: true });
    }
    if (dirty) {
      markDirty();
      refreshBookmarkPreview();
    }
  }

  function updateFolderSelectionUI() {
    const guid = state.refs.bookmarkFolder.value;
    const node = state.folderNodes.get(guid);
    state.refs.folderCurrent.textContent = node?.path || "选择文件夹…";
    state.refs.folderButton.title = node?.path || "";

    for (const row of state.refs.folderTree.querySelectorAll(
      ".zql-tree-row"
    )) {
      const selected = row.dataset.guid === guid;
      row.classList.toggle("zql-selected", selected);
      row.setAttribute("aria-selected", String(selected));
    }
  }

  function renderFolderTree() {
    const tree = state.refs.folderTree;
    tree.replaceChildren();

    if (!state.folderRoots.length) {
      const empty = document.createElement("p");
      empty.className = "zql-tree-empty";
      empty.textContent = "没有可用的书签文件夹。";
      tree.appendChild(empty);
      return;
    }

    const buildList = (nodes, level) => {
      const list = document.createElement("ul");
      list.className = "zql-tree-list";
      list.setAttribute("role", "group");

      for (const node of nodes) {
        const item = document.createElement("li");
        item.className = "zql-tree-node";
        item.setAttribute("role", "none");

        const hasChildren = node.children.length > 0;
        const expanded = state.expandedFolders.has(node.guid);

        const row = document.createElement("div");
        row.className = "zql-tree-row";
        row.dataset.guid = node.guid;
        row.setAttribute("role", "treeitem");
        row.setAttribute("aria-level", String(level + 1));
        if (hasChildren) {
          row.setAttribute("aria-expanded", String(expanded));
        }

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "zql-tree-toggle";
        toggle.dataset.action = "toggle";
        toggle.dataset.guid = node.guid;
        if (hasChildren) {
          toggle.textContent = expanded ? "▾" : "▸";
          toggle.setAttribute("aria-label", expanded ? "收起" : "展开");
        } else {
          toggle.tabIndex = -1;
          toggle.setAttribute("aria-hidden", "true");
          toggle.classList.add("zql-tree-toggle-empty");
        }
        row.appendChild(toggle);

        const label = document.createElement("button");
        label.type = "button";
        label.className = "zql-tree-label";
        label.dataset.action = "select";
        label.dataset.guid = node.guid;
        label.textContent = node.title;
        label.title = node.path;
        row.appendChild(label);

        item.appendChild(row);

        if (hasChildren) {
          const children = buildList(node.children, level + 1);
          children.hidden = !expanded;
          item.appendChild(children);
        }

        list.appendChild(item);
      }

      return list;
    };

    tree.appendChild(buildList(state.folderRoots, 0));
    updateFolderSelectionUI();
  }

  function toggleFolderPopover(force) {
    const popover = state.refs.folderPopover;
    const open = typeof force === "boolean" ? force : popover.hidden;
    popover.hidden = !open;
    state.refs.folderButton.setAttribute("aria-expanded", String(open));

    if (open) {
      const selected = state.refs.folderTree.querySelector(
        ".zql-tree-row.zql-selected"
      );
      requestAnimationFrame(() => {
        selected?.scrollIntoView({ block: "nearest" });
      });
    }
  }

  function closeFolderPopover() {
    if (!state.refs.folderPopover.hidden) {
      toggleFolderPopover(false);
    }
  }

  function onDocumentPointerDown(event) {
    if (
      state.refs.folderPopover.hidden ||
      state.refs.folderField.contains(event.target)
    ) {
      return;
    }
    closeFolderPopover();
  }

  function onFolderTreeClick(event) {
    const action = event.target.closest?.("[data-action]");
    if (!action) {
      return;
    }

    const guid = action.dataset.guid;
    if (!guid) {
      return;
    }

    if (action.dataset.action === "select") {
      setSelectedFolder(guid, { dirty: true, close: true });
      return;
    }

    if (action.dataset.action !== "toggle") {
      return;
    }

    const wasExpanded = state.expandedFolders.has(guid);
    if (wasExpanded) {
      state.expandedFolders.delete(guid);
    } else {
      state.expandedFolders.add(guid);
    }

    const item = action.closest(".zql-tree-node");
    const group = item?.querySelector(":scope > .zql-tree-list");
    if (group) {
      group.hidden = wasExpanded;
    }
    action.textContent = wasExpanded ? "▸" : "▾";
    action.setAttribute("aria-label", wasExpanded ? "展开" : "收起");
    action
      .closest(".zql-tree-row")
      ?.setAttribute("aria-expanded", String(!wasExpanded));
  }

  async function populateFolderPicker() {
    const saved = Services.prefs.getStringPref(
      PREF_BOOKMARK_FOLDER,
      DEFAULT_BOOKMARK_FOLDER
    );
    const button = state.refs.folderButton;

    button.disabled = true;
    state.refs.folderTree.replaceChildren();
    state.refs.bookmarkError.hidden = true;

    try {
      state.folderRoots = await listBookmarkFolders();
      indexFolderNodes(state.folderRoots);

      let selected = saved;
      let warning = "";
      if (!selected || !state.folderNodes.has(selected)) {
        if (saved) {
          warning =
            "之前选择的书签文件夹已不存在，请重新选择。";
        }
        selected = state.folderRoots[0]?.guid || "";
      }

      state.expandedFolders.clear();
      let node = state.folderNodes.get(selected);
      while (node) {
        state.expandedFolders.add(node.guid);
        node = node.parent;
      }
      if (selected) {
        state.expandedFolders.add(selected);
      }

      state.refs.bookmarkFolder.value = selected;
      renderFolderTree();

      if (warning) {
        state.refs.bookmarkError.textContent = warning;
        state.refs.bookmarkError.hidden = false;
      }
    } catch (error) {
      console.error(
        "[Zen Quick Launch] Could not list bookmark folders:",
        error
      );
      state.folderRoots = [];
      state.folderNodes = new Map();
      state.refs.bookmarkFolder.value = "";
      renderFolderTree();
      state.refs.bookmarkError.textContent =
        "无法读取书签文件夹；请确认设置页是通过 chrome:// 地址打开的。";
      state.refs.bookmarkError.hidden = false;
    } finally {
      button.disabled = state.folderRoots.length === 0;
    }
  }

  function bookmarkUrl(node) {
    return node.url?.href || String(node.url || "");
  }

  function createBookmarkAction(label, action, extraClass = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `zql-button ${extraClass}`.trim();
    button.dataset.action = action;
    button.textContent = label;
    return button;
  }

  function createBookmarkRow(bookmark) {
    const row = document.createElement("div");
    row.className = "zql-bookmark-item";
    row.dataset.guid = bookmark.guid;
    row.draggable = false;

    const drag = document.createElement("div");
    drag.className = "zql-bookmark-drag";
    drag.textContent = "⋮⋮";
    drag.title = "拖动排序";
    drag.setAttribute("aria-hidden", "true");
    row.appendChild(drag);

    const icon = document.createElement("img");
    icon.className = "zql-bookmark-icon";
    icon.alt = "";
    icon.draggable = false;
    loadIcon(icon, iconFor({ url: bookmarkUrl(bookmark), icon: "auto" }));
    row.appendChild(icon);

    const name = document.createElement("input");
    name.className = "zql-bookmark-name";
    name.type = "text";
    name.value = bookmark.title || "";
    name.placeholder = "书签名称";
    name.setAttribute("aria-label", "书签名称");
    row.appendChild(name);

    const url = document.createElement("input");
    url.className = "zql-bookmark-url";
    url.type = "text";
    url.value = bookmarkUrl(bookmark);
    url.placeholder = "https://example.com";
    url.spellcheck = false;
    url.setAttribute("aria-label", "书签网址");
    row.appendChild(url);

    const actions = document.createElement("div");
    actions.className = "zql-bookmark-actions";
    actions.append(
      createBookmarkAction("打开", "bookmark-open"),
      createBookmarkAction("删除", "bookmark-delete", "zql-danger")
    );
    row.appendChild(actions);

    drag.addEventListener("mousedown", () => {
      row.draggable = true;
    });

    row.addEventListener("mouseup", () => {
      if (!state.bookmarkDragGuid) {
        row.draggable = false;
      }
    });

    row.addEventListener("dragstart", (event) => {
      if (!row.draggable) {
        event.preventDefault();
        return;
      }
      state.bookmarkDragGuid = bookmark.guid;
      state.bookmarkDrop = null;
      row.classList.add("zql-bookmark-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", bookmark.guid);
    });

    row.addEventListener("dragend", () => {
      resetBookmarkDrag();
    });

    row.addEventListener("dragover", (event) => {
      if (
        !state.bookmarkDragGuid ||
        state.bookmarkDragGuid === bookmark.guid
      ) {
        return;
      }
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      const after = event.clientY >= rect.top + rect.height / 2;
      row.classList.toggle("zql-bookmark-drop-before", !after);
      row.classList.toggle("zql-bookmark-drop-after", after);
      state.bookmarkDrop = { guid: bookmark.guid, after };
    });

    row.addEventListener("dragleave", () => {
      row.classList.remove(
        "zql-bookmark-drop-before",
        "zql-bookmark-drop-after"
      );
    });

    row.addEventListener("drop", (event) => {
      if (!state.bookmarkDragGuid) {
        return;
      }
      event.preventDefault();
      const target =
        state.bookmarkDrop?.guid === bookmark.guid
          ? state.bookmarkDrop
          : { guid: bookmark.guid, after: true };
      const sourceGuid = state.bookmarkDragGuid;
      resetBookmarkDrag();
      reorderBookmark(sourceGuid, target.guid, target.after);
    });

    return row;
  }

  function resetBookmarkDrag() {
    state.bookmarkDragGuid = null;
    state.bookmarkDrop = null;
    for (const row of state.refs.bookmarkEditor?.children || []) {
      row.classList.remove(
        "zql-bookmark-dragging",
        "zql-bookmark-drop-before",
        "zql-bookmark-drop-after"
      );
      row.draggable = false;
    }
  }

  async function updateBookmarkRow(row) {
    if (!row) {
      return;
    }

    const guid = row.dataset.guid;
    const nameInput = row.querySelector(".zql-bookmark-name");
    const urlInput = row.querySelector(".zql-bookmark-url");
    if (!guid || !nameInput || !urlInput) {
      return;
    }

    const title = nameInput.value.trim();
    const target = normalizeUrl(urlInput.value);
    if (!isValidUrl(target)) {
      urlInput.classList.add("zql-invalid");
      setStatus("书签网址无效，未保存。", "error");
      return;
    }
    urlInput.classList.remove("zql-invalid");

    try {
      const PlacesUtils = await getPlacesUtils();
      await PlacesUtils.bookmarks.update({
        guid,
        title,
        url: target,
      });
      urlInput.value = target;
      loadIcon(
        row.querySelector(".zql-bookmark-icon"),
        iconFor({ url: target, icon: "auto" })
      );
      const node = state.bookmarkChildren.find(
        (entry) => entry.guid === guid
      );
      if (node) {
        node.title = title;
        node.url = new URL(target);
      }
      setStatus("书签已更新。", "ok");
    } catch (error) {
      console.error("[Zen Quick Launch] Could not update bookmark:", error);
      setStatus("书签更新失败，请重试。", "error");
    }
  }

  function openBookmark(row) {
    if (!row) {
      return;
    }
    const urlInput = row.querySelector(".zql-bookmark-url");
    const target = normalizeUrl(urlInput?.value || "");
    if (!isValidUrl(target)) {
      urlInput?.classList.add("zql-invalid");
      setStatus("书签网址无效，无法打开。", "error");
      return;
    }
    urlInput?.classList.remove("zql-invalid");
    openInTab(target);
  }

  async function deleteBookmark(row) {
    if (!row) {
      return;
    }
    const guid = row.dataset.guid;
    const name =
      row.querySelector(".zql-bookmark-name")?.value.trim() ||
      row.querySelector(".zql-bookmark-url")?.value.trim() ||
      "这个书签";
    const confirmed = Services.prompt.confirm(
      window,
      "删除书签",
      `确定删除“${name}”？此操作会同时修改书签管理器。`
    );
    if (!confirmed) {
      return;
    }

    try {
      const PlacesUtils = await getPlacesUtils();
      await PlacesUtils.bookmarks.remove(guid);
      await refreshBookmarkPreview();
      setStatus("书签已删除。", "ok");
    } catch (error) {
      console.error("[Zen Quick Launch] Could not delete bookmark:", error);
      setStatus("书签删除失败，请重试。", "error");
    }
  }

  function toggleBookmarkAdd(force) {
    const add = state.refs.bookmarkAdd;
    const open =
      typeof force === "boolean" ? force : add.hidden;
    add.hidden = !open;
    if (open) {
      state.refs.bookmarkNewName.focus();
    }
  }

  async function addBookmark() {
    const folder = state.refs.bookmarkFolder.value;
    if (!folder) {
      setStatus("请先选择一个书签文件夹。", "error");
      return;
    }

    const name = state.refs.bookmarkNewName.value.trim();
    const urlInput = state.refs.bookmarkNewUrl;
    const target = normalizeUrl(urlInput.value);
    if (!isValidUrl(target)) {
      urlInput.classList.add("zql-invalid");
      setStatus("书签网址无效，未添加。", "error");
      return;
    }
    urlInput.classList.remove("zql-invalid");

    try {
      const PlacesUtils = await getPlacesUtils();
      await PlacesUtils.bookmarks.insert({
        parentGuid: folder,
        type: PlacesUtils.bookmarks.TYPE_BOOKMARK,
        title: name || target,
        url: target,
      });
      state.refs.bookmarkNewName.value = "";
      urlInput.value = "";
      await refreshBookmarkPreview();
      setStatus("书签已添加。", "ok");
      state.refs.bookmarkNewName.focus();
    } catch (error) {
      console.error("[Zen Quick Launch] Could not add bookmark:", error);
      setStatus("书签添加失败，请重试。", "error");
    }
  }

  async function reorderBookmark(sourceGuid, targetGuid, after) {
    const children = [...state.bookmarkChildren];
    const from = children.findIndex((node) => node.guid === sourceGuid);
    if (from < 0) {
      return;
    }

    const [moved] = children.splice(from, 1);
    let to = children.findIndex((node) => node.guid === targetGuid);
    if (to < 0) {
      return;
    }
    if (after) {
      to += 1;
    }
    children.splice(to, 0, moved);

    try {
      const PlacesUtils = await getPlacesUtils();
      await PlacesUtils.bookmarks.reorder(
        state.refs.bookmarkFolder.value,
        children.map((node) => node.guid)
      );
      await refreshBookmarkPreview();
      setStatus("书签顺序已更新。", "ok");
    } catch (error) {
      console.error("[Zen Quick Launch] Could not reorder bookmarks:", error);
      setStatus("书签排序失败，请重试。", "error");
    }
  }

  async function refreshBookmarkPreview() {
    if (!state.refs) {
      return;
    }

    const requestId = ++state.bookmarkRefreshId;
    const editor = state.refs.bookmarkEditor;
    const empty = state.refs.bookmarkEmpty;
    const error = state.refs.bookmarkError;
    editor.replaceChildren();
    empty.hidden = true;
    error.hidden = true;
    state.bookmarkChildren = [];

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

      state.bookmarkChildren = children;
      const bookmarks = children.filter(
        (node) =>
          node.type === PlacesUtils.bookmarks.TYPE_BOOKMARK && node.url
      );

      for (const bookmark of bookmarks) {
        editor.appendChild(createBookmarkRow(bookmark));
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

      if (payload.mode === "bookmarks") {
        if (
          typeof payload.bookmarkFolder === "string" &&
          state.folderNodes.has(payload.bookmarkFolder)
        ) {
          setSelectedFolder(payload.bookmarkFolder, { close: true });
        } else {
          setSelectedFolder("", { close: true });
        }
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
    setSelectedFolder(
      state.folderNodes.has(DEFAULT_BOOKMARK_FOLDER)
        ? DEFAULT_BOOKMARK_FOLDER
        : state.folderRoots[0]?.guid || "",
      { close: true }
    );
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
      if (event.key === "Escape") {
        if (!state.refs.folderPopover.hidden) {
          event.preventDefault();
          event.stopPropagation();
          closeFolderPopover();
        }
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

    await populateFolderPicker();
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
