(() => {
  "use strict";

  const INSTANCE_KEY = "__zenQuickLaunch";
  const CONTAINER_ID = "zen-quick-launch-container";
  const GRID_CLASS = "zen-quick-launch-essentials";
  const XHTML_NS = "http://www.w3.org/1999/xhtml";

  const PREF_ITEMS = "zen.quicklaunch.items";
  const PREF_CTRL_BG = "zen.quicklaunch.ctrlBackground";
  const PREF_MODE = "zen.quicklaunch.mode";
  const PREF_BOOKMARK_FOLDER = "zen.quicklaunch.bookmarkFolder";
  const DEFAULT_BOOKMARK_FOLDER = "toolbar_____";

  const SETTINGS_URL =
    "chrome://zen-quick-launch/content/settings.html";
  const OPEN_URL_TOPIC = "zen-quick-launch:open-url";
  const CONTEXT_MENU_ID = "zen-quick-launch-context-menu";
  const DRAG_INDICATOR_ID = "zen-quick-launch-drag-indicator";
  const DIVIDER_ID = "zen-quick-launch-divider";
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
    bookmarkMenuState: null,
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
  let placesUIUtilsPromise = null;
  let placesTransactionsPromise = null;

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

  function getPlacesUtilsSync() {
    return ChromeUtils.importESModule(
      "resource://gre/modules/PlacesUtils.sys.mjs"
    ).PlacesUtils;
  }

  function getPlacesUIUtils() {
    if (!placesUIUtilsPromise) {
      placesUIUtilsPromise = Promise.resolve(
        ChromeUtils.importESModule(
          "moz-src:///browser/components/places/PlacesUIUtils.sys.mjs"
        ).PlacesUIUtils
      );
    }
    return placesUIUtilsPromise;
  }

  function getPlacesTransactions() {
    if (!placesTransactionsPromise) {
      placesTransactionsPromise = Promise.resolve(
        ChromeUtils.importESModule(
          "resource://gre/modules/PlacesTransactions.sys.mjs"
        ).PlacesTransactions
      );
    }
    return placesTransactionsPromise;
  }

  function getPrivateBrowsingUtils() {
    return ChromeUtils.importESModule(
      "resource://gre/modules/PrivateBrowsingUtils.sys.mjs"
    ).PrivateBrowsingUtils;
  }

  const log = (...args) => console.log("[Zen Quick Launch]", ...args);
  const warn = (...args) => console.warn("[Zen Quick Launch]", ...args);

  function ensureDefaults() {
    if (!Services.prefs.prefHasUserValue(PREF_ITEMS)) {
      Services.prefs.setStringPref(PREF_ITEMS, JSON.stringify(DEFAULT_ITEMS));
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

  function openInWindow(item, isPrivate = false) {
    try {
      window.openTrustedLinkIn(item.url, "window", {
        private: isPrivate,
        triggeringPrincipal:
          Services.scriptSecurityManager.getSystemPrincipal(),
      });
    } catch (error) {
      warn("Could not open a new window.", error);
    }
  }

  function openInContainer(item, userContextId) {
    try {
      window.openTrustedLinkIn(item.url, "tab", {
        userContextId,
        triggeringPrincipal:
          Services.scriptSecurityManager.getSystemPrincipal(),
      });
    } catch (error) {
      warn("Could not open a container tab.", error);
    }
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
        if (item) openInWindow(item, false);
        break;
      case "copy-url":
        if (item) copyUrl(item.url);
        break;
      case "edit":
        if (item) {
          openSettings(`entry=${encodeURIComponent(item.id)}`);
        }
        break;
      case "delete":
        if (item) removeCustomItem(item);
        break;
    }
  }

  function removeCustomItem(item) {
    const items = readRawItems().filter((entry) => entry.id !== item.id);
    Services.prefs.setStringPref(PREF_ITEMS, JSON.stringify(items));
    placeContainer();
  }

  function bookmarkMenuItem(menu, id) {
    return menu.querySelector(`#${CSS.escape(id)}`);
  }

  function setBookmarkMenuHidden(menu, id, hidden) {
    const node = bookmarkMenuItem(menu, id);
    if (node) {
      node.hidden = hidden;
    }
  }

  function hasBookmarkClipboardData() {
    const PlacesUtils = getPlacesUtilsSync();
    return Services.clipboard.hasDataMatchingFlavors(
      [
        PlacesUtils.TYPE_X_MOZ_PLACE,
        PlacesUtils.TYPE_X_MOZ_URL,
        PlacesUtils.TYPE_PLAINTEXT,
      ],
      Ci.nsIClipboard.kGlobalClipboard
    );
  }

  function copyBookmarkToClipboard(item, action) {
    if (!item.bookmarkGuid) {
      return;
    }

    const PlacesUtils = getPlacesUtilsSync();
    const xferable = Cc["@mozilla.org/widget/transferable;1"].createInstance(
      Ci.nsITransferable
    );
    xferable.init(null);

    const toSupports = (value) => {
      const string = Cc["@mozilla.org/supports-string;1"].createInstance(
        Ci.nsISupportsString
      );
      string.data = value;
      return string;
    };
    const addData = (type, value) => {
      xferable.addDataFlavor(type);
      xferable.setTransferData(type, toSupports(value));
    };

    addData(
      PlacesUtils.TYPE_X_MOZ_PLACE,
      JSON.stringify({
        type: PlacesUtils.TYPE_X_MOZ_PLACE,
        itemGuid: item.bookmarkGuid,
        instanceId: PlacesUtils.instanceId,
        title: item.name,
        uri: item.url,
      })
    );
    addData(
      PlacesUtils.TYPE_X_MOZ_URL,
      `${item.url}${PlacesUtils.endl}${item.name ?? ""}`
    );
    addData(PlacesUtils.TYPE_PLAINTEXT, item.url);
    addData(
      PlacesUtils.TYPE_X_MOZ_PLACE_ACTION,
      `${action},${Services.appinfo.name}`
    );

    Services.clipboard.setData(
      xferable,
      null,
      Ci.nsIClipboard.kGlobalClipboard
    );
  }

  async function pasteBookmark(item) {
    if (!item.bookmarkGuid) {
      return;
    }

    const PlacesUtils = await getPlacesUtils();
    const PlacesUIUtils = await getPlacesUIUtils();
    const info = await PlacesUtils.bookmarks.fetch({
      guid: item.bookmarkGuid,
    });
    if (!info) {
      return;
    }

    const xferable = Cc["@mozilla.org/widget/transferable;1"].createInstance(
      Ci.nsITransferable
    );
    xferable.init(null);
    for (const type of [
      PlacesUtils.TYPE_X_MOZ_PLACE,
      PlacesUtils.TYPE_X_MOZ_URL,
      PlacesUtils.TYPE_PLAINTEXT,
    ]) {
      xferable.addDataFlavor(type);
    }
    Services.clipboard.getData(xferable, Ci.nsIClipboard.kGlobalClipboard);

    let data = {};
    let type = {};
    try {
      xferable.getAnyTransferData(type, data);
    } catch (_error) {
      return;
    }

    let validNodes;
    try {
      ({ validNodes } = PlacesUtils.unwrapNodes(
        data.value.QueryInterface(Ci.nsISupportsString).data,
        type.value
      ));
    } catch (_error) {
      return;
    }

    let doCopy = true;
    try {
      const actionXferable = Cc[
        "@mozilla.org/widget/transferable;1"
      ].createInstance(Ci.nsITransferable);
      actionXferable.init(null);
      actionXferable.addDataFlavor(
        PlacesUtils.TYPE_X_MOZ_PLACE_ACTION
      );
      Services.clipboard.getData(
        actionXferable,
        Ci.nsIClipboard.kGlobalClipboard
      );
      const actionValue = {};
      actionXferable.getTransferData(
        PlacesUtils.TYPE_X_MOZ_PLACE_ACTION,
        actionValue
      );
      const [clipAction] = actionValue.value
        .QueryInterface(Ci.nsISupportsString)
        .data.split(",");
      doCopy = clipAction !== "cut";
    } catch (_error) {
      // Default to copy.
    }

    await PlacesUIUtils.handleTransferItems(
      validNodes,
      { guid: info.parentGuid, getIndex: () => info.index },
      doCopy,
      null
    );
  }

  async function editBookmark(item) {
    const PlacesUtils = await getPlacesUtils();
    const PlacesUIUtils = await getPlacesUIUtils();
    const info = await PlacesUtils.bookmarks.fetch({
      guid: item.bookmarkGuid,
    });
    if (!info) {
      return;
    }
    const node = await PlacesUIUtils.promiseNodeLikeFromFetchInfo(info);
    await PlacesUIUtils.showBookmarkDialog(
      { action: "edit", node },
      window
    );
  }

  async function deleteBookmark(item) {
    const PlacesTransactions = await getPlacesTransactions();
    await PlacesTransactions.Remove({
      guids: [item.bookmarkGuid],
    }).transact();
  }

  async function addBookmarkItem(item, type) {
    const PlacesUtils = await getPlacesUtils();
    const PlacesUIUtils = await getPlacesUIUtils();
    const info = await PlacesUtils.bookmarks.fetch({
      guid: item.bookmarkGuid,
    });
    if (!info) {
      return;
    }
    await PlacesUIUtils.showBookmarkDialog(
      {
        action: "add",
        type,
        defaultInsertionPoint: {
          guid: info.parentGuid,
          getIndex: () => info.index,
        },
        hiddenRows: ["folderPicker"],
      },
      window
    );
  }

  async function addBookmarkSeparator(item) {
    const PlacesUtils = await getPlacesUtils();
    const PlacesTransactions = await getPlacesTransactions();
    const info = await PlacesUtils.bookmarks.fetch({
      guid: item.bookmarkGuid,
    });
    if (!info) {
      return;
    }
    await PlacesTransactions.NewSeparator({
      parentGuid: info.parentGuid,
      index: info.index,
    }).transact();
  }

  function getBookmarksSidebarComponent(menu) {
    try {
      const browser = document.getElementById("sidebar");
      const component =
        browser?.contentDocument?.querySelector("sidebar-bookmarks");
      if (component?._contextMenu === menu) {
        return component;
      }
    } catch (_error) {}
    return null;
  }

  // Borrow the native sidebar menu instead of cloning it. Keeping the native
  // IDs means theme rules that target #sidebar-bookmarks-context-menu (for
  // example custom menu icons) apply automatically. The settings entry and
  // command listeners are temporary and restored on popuphidden.
  function restoreBookmarkContextMenu() {
    const borrowed = state.bookmarkMenuState;
    if (!borrowed) {
      return;
    }
    state.bookmarkMenuState = null;

    const {
      menu,
      saved,
      component,
      componentListenerRemoved,
      settingsSeparator,
      settings,
      onCommand,
      onContainerCommand,
      onHidden,
    } = borrowed;

    try {
      menu.removeEventListener("command", onCommand);
      menu.querySelector(
        "#sidebar-bookmarks-context-container-tab-popup"
      )?.removeEventListener("command", onContainerCommand);
      menu.removeEventListener("popuphidden", onHidden);
      settingsSeparator.remove();
      settings.remove();

      for (const [node, value] of saved) {
        node.hidden = value.hidden;
        node.disabled = value.disabled;
        if (value.label == null) {
          node.removeAttribute("label");
        } else {
          node.setAttribute("label", value.label);
        }
        if (value.l10n == null) {
          node.removeAttribute("data-l10n-id");
        } else {
          node.setAttribute("data-l10n-id", value.l10n);
        }
        if (value.l10nArgs == null) {
          node.removeAttribute("data-l10n-args");
        } else {
          node.setAttribute("data-l10n-args", value.l10nArgs);
        }
      }

      if (
        componentListenerRemoved &&
        component?.isConnected &&
        component._contextMenu === menu
      ) {
        menu.addEventListener("command", component);
      }
    } catch (error) {
      warn("Could not restore the native bookmark menu.", error);
    }

    state.contextItem = null;
  }

  function openBookmarkContextMenu(item, event) {
    const menu = document.getElementById(
      "sidebar-bookmarks-context-menu"
    );
    if (!menu) {
      warn("Native bookmark context menu is unavailable.");
      return false;
    }

    restoreBookmarkContextMenu();
    state.contextItem = item;

    const saved = new Map();
    for (const node of menu.querySelectorAll(
      "menuitem, menu, menuseparator"
    )) {
      saved.set(node, {
        hidden: node.hidden,
        disabled: node.disabled,
        label: node.getAttribute("label"),
        l10n: node.getAttribute("data-l10n-id"),
        l10nArgs: node.getAttribute("data-l10n-args"),
      });
    }

    const settingsSeparator = document.createXULElement("menuseparator");
    const settings = document.createXULElement("menuitem");
    settings.setAttribute("label", "Quick Launch 设置…");
    settings.setAttribute("data-action", "settings");
    menu.append(settingsSeparator, settings);

    const component = getBookmarksSidebarComponent(menu);
    const componentListenerRemoved = !!component;
    if (componentListenerRemoved) {
      menu.removeEventListener("command", component);
    }

    const onCommand = (commandEvent) =>
      onBookmarkContextMenuCommand(commandEvent);
    const onContainerCommand = (commandEvent) => {
      const userContextId =
        commandEvent.target.getAttribute?.("data-usercontextid");
      if (userContextId == null) {
        return;
      }
      commandEvent.stopPropagation();
      if (state.contextItem) {
        openInContainer(state.contextItem, Number(userContextId));
      }
    };
    const onHidden = (hiddenEvent) => {
      if (hiddenEvent.target === menu) {
        restoreBookmarkContextMenu();
      }
    };

    menu.addEventListener("command", onCommand);
    menu.querySelector(
      "#sidebar-bookmarks-context-container-tab-popup"
    )?.addEventListener("command", onContainerCommand);
    menu.addEventListener("popuphidden", onHidden);

    state.bookmarkMenuState = {
      menu,
      saved,
      component,
      componentListenerRemoved,
      settingsSeparator,
      settings,
      onCommand,
      onContainerCommand,
      onHidden,
    };

    configureBookmarkContextMenu(menu);

    const rect = event.currentTarget?.getBoundingClientRect?.();
    const x = event.screenX ||
      Math.round((window.mozInnerScreenX || 0) + (rect?.left || 0));
    const y = event.screenY ||
      Math.round((window.mozInnerScreenY || 0) + (rect?.bottom || 0));
    menu.openPopupAtScreen(x, y, true);
    return true;
  }

  function configureBookmarkContextMenu(menu) {
    for (const id of [
      "sidebar-bookmarks-context-open-all-bookmarks",
      "sidebar-bookmarks-context-sep-open-all",
      "sidebar-bookmarks-context-show-in-folder",
      "sidebar-bookmarks-context-sep-sort",
      "sidebar-bookmarks-context-sort-by-name",
    ]) {
      setBookmarkMenuHidden(menu, id, true);
    }

    for (const id of [
      "sidebar-bookmarks-context-open-in-tab",
      "sidebar-bookmarks-context-open-in-window",
      "sidebar-bookmarks-context-sep-open-options",
      "sidebar-bookmarks-context-edit-bookmark",
      "sidebar-bookmarks-context-delete-bookmark",
      "sidebar-bookmarks-context-sep-cut-copy",
      "sidebar-bookmarks-context-cut",
      "sidebar-bookmarks-context-copy",
      "sidebar-bookmarks-context-sep-edit-copy",
      "sidebar-bookmarks-context-copy-link",
      "sidebar-bookmarks-context-sep-add",
      "sidebar-bookmarks-context-add-bookmark",
      "sidebar-bookmarks-context-add-folder",
      "sidebar-bookmarks-context-add-separator",
    ]) {
      setBookmarkMenuHidden(menu, id, false);
    }

    const PrivateBrowsingUtils = getPrivateBrowsingUtils();
    const isPrivate = PrivateBrowsingUtils.isWindowPrivate(window);
    const containersEnabled =
      typeof window.createUserContextMenu === "function" &&
      Services.prefs.getBoolPref("privacy.userContext.enabled", false);
    const containerMenu = bookmarkMenuItem(
      menu,
      "sidebar-bookmarks-context-open-in-container-tab"
    );
    if (containerMenu) {
      containerMenu.hidden = isPrivate || !containersEnabled;
    }

    const privateWindow = bookmarkMenuItem(
      menu,
      "sidebar-bookmarks-context-open-in-private-window"
    );
    if (privateWindow) {
      privateWindow.hidden = !PrivateBrowsingUtils.enabled;
    }

    const paste = bookmarkMenuItem(
      menu,
      "sidebar-bookmarks-context-paste"
    );
    if (paste) {
      paste.hidden = !hasBookmarkClipboardData();
    }

    const edit = bookmarkMenuItem(
      menu,
      "sidebar-bookmarks-context-edit-bookmark"
    );
    if (edit) {
      edit.setAttribute(
        "data-l10n-id",
        "sidebar-bookmarks-context-menu-edit-bookmark"
      );
    }

    const remove = bookmarkMenuItem(
      menu,
      "sidebar-bookmarks-context-delete-bookmark"
    );
    if (remove) {
      remove.setAttribute(
        "data-l10n-id",
        "sidebar-bookmarks-context-menu-delete-bookmark"
      );
      remove.removeAttribute("data-l10n-args");
    }
  }

  function onBookmarkContextMenuCommand(event) {
    const action = event.target.getAttribute?.("data-action");
    if (action === "settings") {
      openSettings();
      return;
    }

    const nativeId = event.target.id;
    const item = state.contextItem;
    if (!nativeId || !item) {
      return;
    }

    switch (nativeId) {
      case "sidebar-bookmarks-context-open-in-tab":
        openFreshTab(item, false);
        break;
      case "sidebar-bookmarks-context-open-in-window":
        openInWindow(item, false);
        break;
      case "sidebar-bookmarks-context-open-in-private-window":
        openInWindow(item, true);
        break;
      case "sidebar-bookmarks-context-edit-bookmark":
        editBookmark(item).catch((error) =>
          warn("Could not edit bookmark.", error)
        );
        break;
      case "sidebar-bookmarks-context-delete-bookmark":
        deleteBookmark(item).catch((error) =>
          warn("Could not delete bookmark.", error)
        );
        break;
      case "sidebar-bookmarks-context-cut":
        copyBookmarkToClipboard(item, "cut");
        break;
      case "sidebar-bookmarks-context-copy":
        copyBookmarkToClipboard(item, "copy");
        break;
      case "sidebar-bookmarks-context-paste":
        pasteBookmark(item).catch((error) =>
          warn("Could not paste bookmark.", error)
        );
        break;
      case "sidebar-bookmarks-context-copy-link":
        copyUrl(item.url);
        break;
      case "sidebar-bookmarks-context-add-bookmark":
        addBookmarkItem(item, "bookmark").catch((error) =>
          warn("Could not add bookmark.", error)
        );
        break;
      case "sidebar-bookmarks-context-add-folder":
        addBookmarkItem(item, "folder").catch((error) =>
          warn("Could not add folder.", error)
        );
        break;
      case "sidebar-bookmarks-context-add-separator":
        addBookmarkSeparator(item).catch((error) =>
          warn("Could not add separator.", error)
        );
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
      ["delete", "删除此入口…"],
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
    menu.addEventListener("popuphidden", (event) => {
      if (event.target === menu) {
        state.contextItem = null;
      }
    });

    const host =
      document.getElementById("mainPopupSet") || document.documentElement;
    host.appendChild(menu);
    return menu;
  }

  function openItemContextMenu(item, event) {
    const isBookmark = !!item.bookmarkGuid;
    state.contextItem = item;

    if (isBookmark && openBookmarkContextMenu(item, event)) {
      return;
    }

    // Custom entries, or the fallback when the native menu is unavailable,
    // keep the Quick Launch menu and edit through the settings page.
    state.contextItem = item;
    const menu = ensureContextMenu();
    const editItem = menu.querySelector('[data-action="edit"]');
    const deleteItem = menu.querySelector('[data-action="delete"]');
    if (editItem) {
      editItem.hidden = isBookmark;
    }
    if (deleteItem) {
      deleteItem.hidden = isBookmark;
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
      // fetch() returns only the first result; onResult visits every child.
      const children = [];
      await PlacesUtils.bookmarks.fetch(
        { parentGuid: folder },
        (node) => children.push(node)
      );

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

  function ensureDivider() {
    let divider = document.getElementById(DIVIDER_ID);
    if (!divider) {
      divider = document.createElementNS(XHTML_NS, "div");
      divider.id = DIVIDER_ID;
      divider.setAttribute("aria-hidden", "true");
    }
    return divider;
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

    let hackType = 0;
    if (items.length === 6 || items.length === 9) {
      hackType = 1;
    } else if (items.length > 0 && items.length % 2 === 0 && items.length < 8) {
      hackType = 2;
    } else if (items.length === 5) {
      hackType = 3;
    }
    if (hackType) {
      container.dataset.hackType = String(hackType);
    } else {
      delete container.dataset.hackType;
    }

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
      const divider = ensureDivider();
      if (essentialsHost.previousSibling !== divider) {
        essentialsHost.before(divider);
      }
      if (divider.previousSibling !== container) {
        divider.before(container);
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
      state.bookmarkMenuState?.menu?.hidePopup?.();
      restoreBookmarkContextMenu();
      document.getElementById(CONTAINER_ID)?.remove();
      document.getElementById(DIVIDER_ID)?.remove();
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
