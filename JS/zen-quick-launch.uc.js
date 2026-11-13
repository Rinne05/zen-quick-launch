(() => {
  "use strict";

  const INSTANCE_KEY = "__zenQuickLaunch";
  const CONTAINER_ID = "zen-quick-launch-container";
  const GRID_CLASS = "zen-quick-launch-essentials";
  const XHTML_NS = "http://www.w3.org/1999/xhtml";

  const PREF_ITEMS = "zen.quicklaunch.items";
  const PREF_COLUMNS = "zen.quicklaunch.columns";
  const PREF_CTRL_BG = "zen.quicklaunch.ctrlBackground";
  const PREF_MODE = "zen.quicklaunch.mode";
  const PREF_BOOKMARK_FOLDER = "zen.quicklaunch.bookmarkFolder";
  const DEFAULT_BOOKMARK_FOLDER = "toolbar_____";

  const SETTINGS_URL =
    "chrome://zen-quick-launch/content/settings.html";
  const OPEN_URL_TOPIC = "zen-quick-launch:open-url";
  const CONTEXT_MENU_ID = "zen-quick-launch-context-menu";
  const DRAG_INDICATOR_ID = "zen-quick-launch-drag-indicator";
  const DRAG_MIME = "application/x-zen-quick-launch-item";

  const DEFAULT_ICON = "chrome://global/skin/icons/defaultFavicon.svg";
  const DEFAULT_ITEMS = [
    { id: "default-3000", name: "3000", url: "http://192.168.1.100:3000", icon: "auto", enabled: true },
    { id: "default-5000", name: "5000", url: "http://192.168.1.100:5000", icon: "auto", enabled: true },
    { id: "default-8080", name: "8080", url: "http://192.168.1.100:8080", icon: "auto", enabled: true },
    { id: "default-9000", name: "9000", url: "http://192.168.1.100:9000", icon: "auto", enabled: true },
  ];

  if (window[INSTANCE_KEY]?.loaded) {
    return;
  }

  const state = {
    loaded: true,
    observer: null,
    prefObserver: null,
    tabObserver: null,
    domReadyListener: null,
    container: null,
    grid: null,
    contextItem: null,
    dragIndicator: null,
    dragSourceId: null,
    dropTarget: null,
    ppmmListener: null,
    mode: "custom",
    bookmarkFolder: "",
    bookmarkItems: [],
    bookmarkChildren: [],
    bookmarksLoaded: false,
    bookmarkLoading: false,
    bookmarkLoadingFolder: "",
    bookmarkRequestId: 0,
    bookmarkObserver: null,
    bookmarkObserverTypes: null,
  };
  window[INSTANCE_KEY] = state;

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

  const log = (...args) => console.log("[Zen Quick Launch]", ...args);
  const warn = (...args) => console.warn("[Zen Quick Launch]", ...args);

  function ensureDefaults() {
    if (!Services.prefs.prefHasUserValue(PREF_ITEMS)) {
      Services.prefs.setStringPref(PREF_ITEMS, JSON.stringify(DEFAULT_ITEMS));
    }
    if (!Services.prefs.prefHasUserValue(PREF_COLUMNS)) {
      Services.prefs.setIntPref(PREF_COLUMNS, 3);
    }
    if (!Services.prefs.prefHasUserValue(PREF_CTRL_BG)) {
      Services.prefs.setBoolPref(PREF_CTRL_BG, true);
    }
    if (!Services.prefs.prefHasUserValue(PREF_MODE)) {
      Services.prefs.setStringPref(PREF_MODE, "custom");
    }
    if (!Services.prefs.prefHasUserValue(PREF_BOOKMARK_FOLDER)) {
      Services.prefs.setStringPref(
        PREF_BOOKMARK_FOLDER,
        DEFAULT_BOOKMARK_FOLDER
      );
    }
  }

  function isAllowedUrl(url) {
    try {
      const uri = Services.io.newURI(url);
      return ["http", "https", "about", "file"].includes(uri.scheme);
    } catch (_error) {
      return false;
    }
  }

  // Accept "host:port", "10.0.0.1:8080" and "example.com" as well, so entries
  // do not silently disappear just because the scheme was left out.
  function normalizeUrl(value) {
    const clean = String(value || "").trim();
    if (!clean) {
      return "";
    }
    if (isAllowedUrl(clean)) {
      return clean;
    }
    if (!clean.includes("://")) {
      const withScheme = `http://${clean}`;
      if (isAllowedUrl(withScheme)) {
        return withScheme;
      }
    }
    return clean;
  }

  function readConfig() {
    ensureDefaults();

    let parsed;
    try {
      parsed = JSON.parse(Services.prefs.getStringPref(PREF_ITEMS, "[]"));
      if (!Array.isArray(parsed)) parsed = [];
    } catch (error) {
      warn("Invalid zen.quicklaunch.items JSON. Using defaults.", error);
      parsed = DEFAULT_ITEMS.map((item) => ({ ...item }));
    }

    const items = parsed
      .map((item, index) => ({
        id: String(item?.id || `item-${index}`),
        name: String(item?.name || `Launch ${index + 1}`).trim(),
        url: normalizeUrl(item?.url),
        icon: item?.icon == null ? "auto" : String(item.icon).trim(),
        enabled: item?.enabled !== false,
      }))
      .filter((item) => item.enabled && item.url && isAllowedUrl(item.url));

    const mode =
      Services.prefs.getStringPref(PREF_MODE, "custom") === "bookmarks"
        ? "bookmarks"
        : "custom";

    return {
      items,
      columns: Math.max(1, Math.min(6, Services.prefs.getIntPref(PREF_COLUMNS, 3))),
      ctrlBackground: Services.prefs.getBoolPref(PREF_CTRL_BG, true),
      mode,
      bookmarkFolder: Services.prefs.getStringPref(
        PREF_BOOKMARK_FOLDER,
        DEFAULT_BOOKMARK_FOLDER
      ),
    };
  }

  function iconFor(item) {
    if (item.icon && item.icon !== "auto") {
      return item.icon;
    }

    const live = currentTabIcon(item.url);
    if (live) {
      return live;
    }

    try {
      const uri = Services.io.newURI(item.url);
      if (uri.scheme === "http" || uri.scheme === "https") {
        return `page-icon:${item.url}`;
      }
    } catch (_error) {}
    return DEFAULT_ICON;
  }

  const ICON_MAX_ATTEMPTS = 3;
  const ICON_RETRY_DELAY = 1500;

  // page-icon: fails while the favicon is still unknown, so retry a few times
  // before falling back to the generic icon.
  function loadIcon(icon, src, attempt = 0) {
    const target = src || DEFAULT_ICON;
    icon.dataset.iconSrc = target;

    icon.onload = () => {
      icon.onerror = null;
    };

    icon.onerror = () => {
      if (target !== DEFAULT_ICON && attempt < ICON_MAX_ATTEMPTS) {
        setTimeout(() => {
          if (icon.isConnected) {
            loadIcon(icon, target, attempt + 1);
          }
        }, ICON_RETRY_DELAY * (attempt + 1));
        return;
      }

      icon.onerror = null;
      if (target !== DEFAULT_ICON) {
        loadIcon(icon, DEFAULT_ICON, 0);
      }
    };

    icon.src = target;
  }

  function refreshIcon(icon, src) {
    if (!icon || icon.dataset.iconSrc === src) {
      return;
    }
    loadIcon(icon, src);
  }

  // Re-resolve the icons of items that use "auto", so the sidebar follows the
  // favicon of the matching tab instead of keeping a stale one forever.
  function refreshIcons() {
    const grid = state.grid;
    if (!grid) {
      return;
    }

    for (const button of grid.children) {
      if (button.dataset.autoIcon !== "true") {
        continue;
      }

      const url = button.dataset.url;
      if (!url) {
        continue;
      }

      refreshIcon(
        button.querySelector(".zen-quick-launch-icon"),
        iconFor({ url, icon: "auto" })
      );
    }
  }

  function getBrowser() {
    return window.gBrowser || null;
  }

  function stripFragment(url) {
    const value = String(url || "");
    const index = value.indexOf("#");
    return index === -1 ? value : value.slice(0, index);
  }

  // The favicon of the page that is currently open is what the tab strip shows,
  // so prefer it over the icon stored in Places. Zen does the same for its
  // essentials (tab.getAttribute("image")).
  function currentTabIcon(url) {
    const browser = getBrowser();
    // Zen's tab list also includes the essentials, pinned and split tabs.
    const tabs = browser?.tabs;
    if (!tabs) {
      return "";
    }

    const wanted = stripFragment(url);
    let looseMatch = "";

    for (const tab of tabs) {
      let spec = "";
      try {
        spec = tab.linkedBrowser?.currentURI?.spec || "";
      } catch (_error) {
        spec = "";
      }

      if (!spec) {
        continue;
      }

      const image = tab.getAttribute("image") || "";
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

  function openUrlInNewTab(url, inBackground) {
    try {
      const browser = getBrowser();
      if (!browser) {
        warn("gBrowser is not ready yet.");
        return null;
      }

      const principal = Services.scriptSecurityManager.getSystemPrincipal();
      const tab = browser.addTab(url, {
        triggeringPrincipal: principal,
        relatedToCurrent: false,
        skipAnimation: false,
      });

      if (!inBackground) {
        browser.selectedTab = tab;
      }
      return tab;
    } catch (error) {
      console.error(`[Zen Quick Launch] Failed to open ${url}:`, error);
      return null;
    }
  }

  function openFreshTab(item, inBackground) {
    return openUrlInNewTab(item.url, inBackground);
  }

  function openSettings(hash = "") {
    const browser = getBrowser();
    if (!browser) {
      warn("gBrowser is not ready yet.");
      return null;
    }

    const principal = Services.scriptSecurityManager.getSystemPrincipal();
    const url = hash ? `${SETTINGS_URL}#${hash}` : SETTINGS_URL;

    for (const tab of browser.tabs) {
      let spec = "";
      try {
        spec = tab.linkedBrowser?.currentURI?.spec || "";
      } catch (_error) {
        spec = "";
      }

      if (spec.split("#")[0] !== SETTINGS_URL) {
        continue;
      }

      browser.selectedTab = tab;
      if (hash) {
        try {
          tab.linkedBrowser.loadURI(url, {
            triggeringPrincipal: principal,
          });
        } catch (error) {
          warn("Could not navigate to the settings entry.", error);
        }
      }
      return tab;
    }

    const tab = browser.addTab(url, { triggeringPrincipal: principal });
    browser.selectedTab = tab;
    return tab;
  }

  function copyUrl(url) {
    try {
      const helper = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(
        Ci.nsIClipboardHelper
      );
      helper.copyString(url);
    } catch (error) {
      warn("Could not copy the URL.", error);
    }
  }

  function onContextMenuCommand(event) {
    const action = event.target.getAttribute?.("data-action");
    const item = state.contextItem;
    if (!action) {
      return;
    }

    switch (action) {
      case "settings":
        openSettings();
        break;
      case "open":
        if (item) openFreshTab(item, false);
        break;
      case "open-background":
        if (item) openFreshTab(item, true);
        break;
      case "open-window":
        if (item) {
          try {
            window.openTrustedLinkIn(item.url, "window");
          } catch (error) {
            warn("Could not open a new window.", error);
          }
        }
        break;
      case "copy-url":
        if (item) copyUrl(item.url);
        break;
      case "edit":
        if (item) {
          openSettings(`entry=${encodeURIComponent(item.id)}`);
        }
        break;
    }
  }

  // Use a real XUL menupopup so the context menu inherits Zen's regular menu
  // styling (the same styling used by the tab context menu).
  function ensureContextMenu() {
    let menu = document.getElementById(CONTEXT_MENU_ID);
    if (menu) {
      return menu;
    }

    menu = document.createXULElement("menupopup");
    menu.id = CONTEXT_MENU_ID;

    const entries = [
      ["open", "打开"],
      ["open-background", "在后台标签页中打开"],
      ["open-window", "在新窗口中打开"],
      null,
      ["copy-url", "复制链接"],
      ["edit", "编辑此入口…"],
      ["settings", "Quick Launch 设置…"],
    ];

    for (const entry of entries) {
      if (!entry) {
        menu.appendChild(document.createXULElement("menuseparator"));
        continue;
      }

      const [action, label] = entry;
      const menuitem = document.createXULElement("menuitem");
      menuitem.setAttribute("label", label);
      menuitem.setAttribute("data-action", action);
      menu.appendChild(menuitem);
    }

    menu.addEventListener("command", onContextMenuCommand);
    menu.addEventListener("popuphidden", () => {
      state.contextItem = null;
    });

    const host =
      document.getElementById("mainPopupSet") || document.documentElement;
    host.appendChild(menu);
    return menu;
  }

  function openItemContextMenu(item, event) {
    const menu = ensureContextMenu();
    state.contextItem = item;

    // Bookmark-backed entries are edited in the bookmarks manager, not as a
    // Quick Launch item. Keep the rest of the menu identical.
    const editItem = menu.querySelector('[data-action="edit"]');
    if (editItem) {
      if (item.bookmarkGuid) {
        editItem.setAttribute("hidden", "true");
      } else {
        editItem.removeAttribute("hidden");
      }
    }

    const rect = event.currentTarget?.getBoundingClientRect?.();
    const x = event.screenX ||
      Math.round((window.mozInnerScreenX || 0) + (rect?.left || 0));
    const y = event.screenY ||
      Math.round((window.mozInnerScreenY || 0) + (rect?.bottom || 0));
    menu.openPopupAtScreen(x, y, true);
  }

  function ensureDragIndicator() {
    let indicator = document.getElementById(DRAG_INDICATOR_ID);
    if (indicator) {
      return indicator;
    }

    indicator = document.createElementNS(XHTML_NS, "div");
    indicator.id = DRAG_INDICATOR_ID;
    indicator.hidden = true;
    document.documentElement.appendChild(indicator);
    state.dragIndicator = indicator;
    return indicator;
  }

  function showDragIndicator(button, after) {
    const indicator = ensureDragIndicator();
    const rect = button.getBoundingClientRect();

    // Mirror the thin accent-coloured insertion line used while dragging tabs.
    indicator.style.left = `${after ? rect.right + 1 : rect.left - 3}px`;
    indicator.style.top = `${rect.top}px`;
    indicator.style.height = `${rect.height}px`;
    indicator.hidden = false;
  }

  function hideDragIndicator() {
    if (state.dragIndicator) {
      state.dragIndicator.hidden = true;
    }
  }

  function resetDragState() {
    state.dragSourceId = null;
    state.dropTarget = null;
    hideDragIndicator();

    for (const button of state.grid?.children || []) {
      button.classList.remove("zen-quick-launch-dragging");
    }
  }

  // Read the raw pref instead of the rendered config: disabled entries are
  // filtered out of the sidebar but must keep their position when an enabled
  // entry is dragged around them.
  function readRawItems() {
    try {
      const parsed = JSON.parse(
        Services.prefs.getStringPref(PREF_ITEMS, "[]")
      );
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      warn("Could not read entries for reordering.", error);
      return [];
    }
  }

  function reorderItem(sourceId, targetId, after) {
    if (!sourceId || !targetId || sourceId === targetId) {
      return false;
    }

    const items = readRawItems();
    const from = items.findIndex(
      (item) => String(item?.id) === sourceId
    );
    if (from < 0) {
      return false;
    }

    const [moved] = items.splice(from, 1);
    let to = items.findIndex((item) => String(item?.id) === targetId);
    if (to < 0) {
      items.splice(from, 0, moved);
      return false;
    }
    if (after) {
      to += 1;
    }

    items.splice(to, 0, moved);
    Services.prefs.setStringPref(PREF_ITEMS, JSON.stringify(items));
    placeContainer();
    return true;
  }

  function bookmarkItemFromNode(node) {
    const url = node.url?.href || String(node.url || "");
    return {
      id: node.guid,
      bookmarkGuid: node.guid,
      name: String(node.title || url || "书签").trim(),
      url,
      icon: "auto",
      enabled: true,
    };
  }

  async function loadBookmarks() {
    if (state.mode !== "bookmarks" || !state.bookmarkFolder) {
      state.bookmarkItems = [];
      state.bookmarkChildren = [];
      state.bookmarksLoaded = true;
      return;
    }

    const folder = state.bookmarkFolder;
    const requestId = ++state.bookmarkRequestId;
    state.bookmarkLoading = true;
    state.bookmarkLoadingFolder = folder;

    try {
      const PlacesUtils = await getPlacesUtils();
      const children =
        (await PlacesUtils.bookmarks.fetch({ parentGuid: folder })) || [];

      if (requestId !== state.bookmarkRequestId || !state.loaded) {
        return;
      }

      state.bookmarkChildren = children;
      state.bookmarkItems = children
        .filter(
          (node) =>
            node.type === PlacesUtils.bookmarks.TYPE_BOOKMARK && node.url
        )
        .map((node) => bookmarkItemFromNode(node));
      state.bookmarksLoaded = true;
      placeContainer();
    } catch (error) {
      warn(`Could not load bookmarks folder ${folder}.`, error);
      if (requestId === state.bookmarkRequestId) {
        state.bookmarkChildren = [];
        state.bookmarkItems = [];
        state.bookmarksLoaded = true;
        placeContainer();
      }
    } finally {
      if (requestId === state.bookmarkRequestId) {
        state.bookmarkLoading = false;
        state.bookmarkLoadingFolder = "";
      }
    }
  }

  async function reorderBookmark(sourceGuid, targetGuid, after) {
    const children = [...state.bookmarkChildren];
    const from = children.findIndex((node) => node.guid === sourceGuid);
    if (from < 0) {
      return false;
    }

    const [moved] = children.splice(from, 1);
    let to = children.findIndex((node) => node.guid === targetGuid);
    if (to < 0) {
      children.splice(from, 0, moved);
      return false;
    }
    if (after) {
      to += 1;
    }
    children.splice(to, 0, moved);

    try {
      const PlacesUtils = await getPlacesUtils();
      await PlacesUtils.bookmarks.reorder(
        state.bookmarkFolder,
        children.map((node) => node.guid)
      );
      state.bookmarksLoaded = false;
      await loadBookmarks();
      return true;
    } catch (error) {
      warn("Could not reorder bookmarks.", error);
      state.bookmarksLoaded = false;
      await loadBookmarks();
      return false;
    }
  }

  function attachDragHandlers(button, item) {
    button.draggable = true;

    button.addEventListener("dragstart", (event) => {
      event.stopPropagation();

      state.dragSourceId = item.id;
      state.dropTarget = null;
      button.classList.add("zen-quick-launch-dragging");

      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", item.id);
      event.dataTransfer.setData(DRAG_MIME, item.id);
    });

    button.addEventListener("dragover", (event) => {
      if (!state.dragSourceId) {
        return;
      }

      const types = Array.from(event.dataTransfer?.types || []);
      if (!types.includes(DRAG_MIME)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const rect = button.getBoundingClientRect();
      const after = event.clientX >= rect.left + rect.width / 2;
      state.dropTarget = { id: item.id, after };
      showDragIndicator(button, after);
    });

    button.addEventListener("drop", (event) => {
      if (!state.dragSourceId) {
        return;
      }

      const types = Array.from(event.dataTransfer?.types || []);
      if (!types.includes(DRAG_MIME)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const target =
        state.dropTarget?.id === item.id
          ? state.dropTarget
          : { id: item.id, after: true };
      const sourceId = state.dragSourceId;

      resetDragState();
      if (state.mode === "bookmarks") {
        reorderBookmark(sourceId, target.id, target.after);
      } else {
        reorderItem(sourceId, target.id, target.after);
      }
    });

    button.addEventListener("dragend", () => {
      resetDragState();
    });
  }

  function createSpan(className) {
    const span = document.createElementNS(XHTML_NS, "span");
    span.className = className;
    return span;
  }

  // Rebuild the inside of an essentials tab:
  //   .tab-stack > .tab-background + .tab-content > .tab-icon-stack > img
  // Zen and themes style `.tabbrowser-tab[zen-essential] .tab-background` and
  // `.tab-icon-image`, so using the same shape makes the launchers inherit the
  // exact essentials look (including theme overrides).
  function createButton(item, index, ctrlBackground) {
    const button = document.createElementNS(XHTML_NS, "button");
    button.id = `zen-quick-launch-item-${index}`;
    button.classList.add("zen-quick-launch-item", "tabbrowser-tab");
    button.setAttribute("zen-essential", "true");
    button.type = "button";
    button.title =
      `${item.name}
${item.url}
右键：更多操作`;
    button.setAttribute(
      "aria-label",
      `${item.name}: ${item.url}`
    );
    button.dataset.url = item.url;
    button.dataset.id = item.id;
    button.dataset.autoIcon =
      item.icon && item.icon !== "auto" ? "false" : "true";

    const stack = createSpan("tab-stack");

    const background = createSpan("tab-background");
    // Firefox hides .tab-background/.tab-icon-image until the tabbrowser adds
    // this attribute; ours never goes through that code path.
    background.setAttribute("fadein", "true");
    background.setAttribute("aria-hidden", "true");

    const content = createSpan("tab-content");
    const iconStack = createSpan("tab-icon-stack");

    const icon = document.createElementNS(XHTML_NS, "img");
    icon.className = "tab-icon-image zen-quick-launch-icon";
    icon.setAttribute("fadein", "true");
    icon.alt = "";
    icon.draggable = false;
    loadIcon(icon, iconFor(item));

    iconStack.appendChild(icon);
    content.appendChild(iconStack);
    stack.append(background, content);
    button.appendChild(stack);

    button.addEventListener("click", (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const modified = event.ctrlKey || event.metaKey;
      openFreshTab(item, ctrlBackground && modified);
    });

    button.addEventListener("auxclick", (event) => {
      if (event.button !== 1) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      openFreshTab(item, true);
    });

    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openItemContextMenu(item, event);
    });

    // The launcher carries the .tabbrowser-tab class for styling only. Keep
    // Zen's tab event handlers from treating it as a real tab.
    button.addEventListener("dblclick", (event) => {
      event.stopPropagation();
    });

    attachDragHandlers(button, item);

    return button;
  }

  function buildContainer() {
    let container = document.getElementById(CONTAINER_ID);
    if (!container) {
      container = document.createElementNS(XHTML_NS, "div");
      container.id = CONTAINER_ID;
      container.setAttribute("role", "group");
      container.setAttribute("aria-label", "Quick Launch");
    }

    let grid = container.querySelector(`:scope > .${GRID_CLASS}`);
    if (!grid) {
      grid = document.createElementNS(XHTML_NS, "div");
      grid.className =
        `${GRID_CLASS} zen-workspace-tabs-section zen-essentials-container`;
      container.appendChild(grid);
    }

    // The spoofed .zen-essentials-container hook is for styling only. Without
    // this guard, dragging a tab over the launchers makes Zen think it is over
    // the essentials section and moves that tab into Essentials on drop.
    if (!container.dataset.zqlDragGuard) {
      container.dataset.zqlDragGuard = "true";
      for (const type of ["dragenter", "dragover", "drop"]) {
        container.addEventListener(type, (event) => {
          event.stopPropagation();
        });
      }
    }

    state.container = container;
    state.grid = grid;
    return container;
  }

  // Match the essentials row height instead of hard-coding it: Zen sets
  // --tab-min-height on #zen-essentials, but that value is not inheritable by
  // our sibling container, so copy it over.
  function syncItemSize(container) {
    const essentials = document.getElementById("zen-essentials");
    if (!essentials) {
      container.style.removeProperty("--zen-quick-launch-item-size");
      return;
    }

    let size = "";
    try {
      size = getComputedStyle(essentials)
        .getPropertyValue("--tab-min-height")
        .trim();
    } catch (error) {
      size = "";
    }

    if (/^\d+(\.\d+)?(px|em|rem)$/.test(size)) {
      container.style.setProperty("--zen-quick-launch-item-size", size);
    } else {
      container.style.removeProperty("--zen-quick-launch-item-size");
    }
  }

  function render() {
    if (!state.loaded) {
      return 0;
    }

    const config = readConfig();
    const container = buildContainer();
    const grid = state.grid;

    if (
      state.mode !== config.mode ||
      state.bookmarkFolder !== config.bookmarkFolder
    ) {
      state.bookmarkRequestId++;
      state.bookmarkLoading = false;
      state.bookmarkLoadingFolder = "";
      state.bookmarkItems = [];
      state.bookmarkChildren = [];
      state.bookmarksLoaded = false;
    }
    state.mode = config.mode;
    state.bookmarkFolder = config.bookmarkFolder;

    const items =
      config.mode === "bookmarks" ? state.bookmarkItems : config.items;

    container.style.setProperty(
      "--zen-quick-launch-columns",
      String(config.columns)
    );
    syncItemSize(container);
    grid.replaceChildren();

    for (const [index, item] of items.entries()) {
      grid.appendChild(
        createButton(item, index, config.ctrlBackground)
      );
    }

    if (!items.length) {
      container.hidden = true;
    } else {
      container.hidden = false;
    }

    if (
      config.mode === "bookmarks" &&
      !state.bookmarksLoaded &&
      (!state.bookmarkLoading ||
        state.bookmarkLoadingFolder !== config.bookmarkFolder)
    ) {
      loadBookmarks();
    }

    return items.length;
  }

  function placeContainer() {
    if (!state.loaded) {
      return false;
    }

    const count = render();
    const container = state.container;

    if (!container) {
      return false;
    }

    // Essentials are absolutely positioned at the top of the tab strip and the
    // workspace reserves their height with padding-top. Inserting after
    // #zen-essentials would put the launchers at the same y position as the
    // absolutely positioned Essentials grid and overlap it. Being the previous
    // sibling puts the launchers in normal flow above Essentials instead.
    const essentialsHost = document.getElementById("zen-essentials");
    if (essentialsHost?.parentNode) {
      if (essentialsHost.previousSibling !== container) {
        essentialsHost.before(container);
      }
      return true;
    }

    const tabsWrapper = document.getElementById("zen-tabs-wrapper");
    if (tabsWrapper?.parentNode) {
      if (tabsWrapper.previousSibling !== container) {
        tabsWrapper.before(container);
      }
      return true;
    }

    const pinned =
      window.gZenWorkspaces?.pinnedTabsContainer ||
      document.getElementById("pinned-tabs-container");
    if (pinned?.parentNode) {
      pinned.before(container);
      return true;
    }

    const tabsRoot = document.getElementById("tabbrowser-tabs");
    if (tabsRoot) {
      tabsRoot.prepend(container);
      return true;
    }

    if (count) {
      warn("Could not find a Zen sidebar insertion point.");
    }
    return false;
  }

  function installDOMObserver() {
    if (state.observer) {
      return;
    }

    let scheduled = false;
    state.observer = new MutationObserver(() => {
      if (scheduled) {
        return;
      }

      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        if (!state.container?.isConnected) {
          placeContainer();
        }
      });
    });

    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function installPrefObserver() {
    if (state.prefObserver) {
      return;
    }

    state.prefObserver = {
      observe(_subject, topic, data) {
        if (topic !== "nsPref:changed") {
          return;
        }
        if (
          data === PREF_ITEMS ||
          data === PREF_COLUMNS ||
          data === PREF_CTRL_BG ||
          data === PREF_MODE ||
          data === PREF_BOOKMARK_FOLDER
        ) {
          requestAnimationFrame(() => {
            placeContainer();
          });
        }
      },
    };

    Services.prefs.addObserver("zen.quicklaunch.", state.prefObserver);
  }

  // Follow the tab strip: when a tab reports a new favicon (or one is closed),
  // re-resolve the icons of our items that use "auto".
  function installTabObserver() {
    if (state.tabObserver) {
      return;
    }

    state.tabObserver = (event) => {
      if (
        event.type === "TabAttrModified" &&
        !event.detail?.changed?.includes("image")
      ) {
        return;
      }

      requestAnimationFrame(refreshIcons);
    };

    window.addEventListener("TabAttrModified", state.tabObserver);
    window.addEventListener("TabClose", state.tabObserver);
    window.addEventListener("TabBrowserDiscarded", state.tabObserver);
  }

  function installBookmarkObserver() {
    if (state.bookmarkObserver) {
      return;
    }

    getPlacesUtils()
      .then((PlacesUtils) => {
        if (!state.loaded || state.bookmarkObserver) {
          return;
        }

        state.bookmarkObserverTypes = [
          "bookmark-added",
          "bookmark-removed",
          "bookmark-moved",
          "bookmark-title-changed",
          "bookmark-url-changed",
        ];
        state.bookmarkObserver = () => {
          if (state.mode !== "bookmarks") {
            return;
          }
          requestAnimationFrame(() => loadBookmarks());
        };

        PlacesUtils.observers.addListener(
          state.bookmarkObserverTypes,
          state.bookmarkObserver
        );
      })
      .catch((error) => {
        warn("Could not observe bookmarks.", error);
      });
  }

  // The settings page lives in its own tab/process, so it asks the browser
  // window to open preview URLs instead of touching gBrowser directly.
  function installMessageListener() {
    if (state.ppmmListener) {
      return;
    }

    state.ppmmListener = (message) => {
      if (window !== Services.wm.getMostRecentWindow("navigator:browser")) {
        return;
      }

      const url = message.data?.url;
      if (typeof url === "string" && url) {
        openUrlInNewTab(url, false);
      }
    };

    Services.ppmm.addMessageListener(OPEN_URL_TOPIC, state.ppmmListener);
  }

  function cleanup() {
    if (!state.loaded) {
      return;
    }
    state.loaded = false;

    if (state.domReadyListener) {
      window.removeEventListener(
        "DOMContentLoaded",
        state.domReadyListener
      );
      state.domReadyListener = null;
    }

    try {
      state.observer?.disconnect();
    } catch (_error) {}
    state.observer = null;

    if (state.tabObserver) {
      try {
        window.removeEventListener("TabAttrModified", state.tabObserver);
        window.removeEventListener("TabClose", state.tabObserver);
        window.removeEventListener(
          "TabBrowserDiscarded",
          state.tabObserver
        );
      } catch (_error) {}
      state.tabObserver = null;
    }

    if (state.prefObserver) {
      try {
        Services.prefs.removeObserver(
          "zen.quicklaunch.",
          state.prefObserver
        );
      } catch (_error) {}
      state.prefObserver = null;
    }

    if (state.bookmarkObserver) {
      const types = state.bookmarkObserverTypes;
      const callback = state.bookmarkObserver;
      getPlacesUtils()
        .then((PlacesUtils) => {
          PlacesUtils.observers.removeListener(types, callback);
        })
        .catch((_error) => {});
      state.bookmarkObserver = null;
      state.bookmarkObserverTypes = null;
    }

    state.bookmarkRequestId++;
    state.bookmarkItems = [];
    state.bookmarkChildren = [];
    state.bookmarksLoaded = false;

    if (state.ppmmListener) {
      try {
        Services.ppmm.removeMessageListener(
          OPEN_URL_TOPIC,
          state.ppmmListener
        );
      } catch (_error) {}
      state.ppmmListener = null;
    }

    try {
      document.getElementById(CONTAINER_ID)?.remove();
      document.getElementById(CONTEXT_MENU_ID)?.remove();
      document.getElementById(DRAG_INDICATOR_ID)?.remove();
      document.documentElement.removeAttribute(
        "zen-quick-launch-loaded"
      );
    } catch (_error) {}

    state.contextItem = null;
    state.dragIndicator = null;
    state.dragSourceId = null;
    state.dropTarget = null;
    state.container = null;
    state.grid = null;
    try {
      delete window[INSTANCE_KEY];
    } catch (_error) {}
  }

  function start() {
    if (!state.loaded) {
      return;
    }
    state.domReadyListener = null;
    ensureDefaults();
    placeContainer();
    installDOMObserver();
    installPrefObserver();
    installTabObserver();
    installBookmarkObserver();
    installMessageListener();
    document.documentElement.setAttribute(
      "zen-quick-launch-loaded",
      "true"
    );
    log("Loaded. Right-click an entry for its menu.");
  }

  window.addEventListener("unload", cleanup, { once: true });
  if (typeof window.addUnloadListener === "function") {
    window.addUnloadListener(cleanup);
  } else {
    warn("Sine unload API is unavailable; disabling may require a restart.");
  }

  if (document.readyState === "loading") {
    state.domReadyListener = start;
    window.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
