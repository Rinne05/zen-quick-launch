(() => {
  "use strict";

  const INSTANCE_KEY = "__zenQuickLaunch";
  const CONTAINER_ID = "zen-quick-launch-container";

  const PREF_ITEMS = "zen.quicklaunch.items";
  const PREF_COLUMNS = "zen.quicklaunch.columns";
  const PREF_CTRL_BG = "zen.quicklaunch.ctrlBackground";

  const SETTINGS_API_KEY = "__zenQuickLaunchSettingsAPI";
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
  };
  window[INSTANCE_KEY] = state;

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

    return {
      items,
      columns: Math.max(1, Math.min(6, Services.prefs.getIntPref(PREF_COLUMNS, 3))),
      ctrlBackground: Services.prefs.getBoolPref(PREF_CTRL_BG, true),
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
    const container = state.container;
    if (!container) {
      return;
    }

    for (const button of container.children) {
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

  function openFreshTab(item, inBackground) {
    try {
      const browser = getBrowser();
      if (!browser) {
        warn("gBrowser is not ready yet.");
        return null;
      }

      const principal = Services.scriptSecurityManager.getSystemPrincipal();
      const tab = browser.addTab(item.url, {
        triggeringPrincipal: principal,
        relatedToCurrent: false,
        skipAnimation: false,
      });

      if (!inBackground) {
        browser.selectedTab = tab;
      }
      return tab;
    } catch (error) {
      console.error(`[Zen Quick Launch] Failed to open ${item.url}:`, error);
      return null;
    }
  }

  function openSettings() {
    const settings = window[SETTINGS_API_KEY];
    if (!settings) {
      warn("Settings panel script is not loaded.");
      return null;
    }

    settings.open();
    return settings;
  }

  function createButton(item, index, ctrlBackground) {
    const button = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "button"
    );
    button.id = `zen-quick-launch-item-${index}`;
    button.classList.add("zen-quick-launch-item");
    button.type = "button";
    button.title =
      `${item.name}
${item.url}
右键：打开 Quick Launch 设置`;
    button.setAttribute(
      "aria-label",
      `${item.name}: ${item.url}`
    );
    button.dataset.url = item.url;
    button.dataset.autoIcon =
      item.icon && item.icon !== "auto" ? "false" : "true";

    const icon = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "img"
    );
    icon.className = "zen-quick-launch-icon";
    icon.alt = "";
    icon.draggable = false;
    loadIcon(icon, iconFor(item));

    button.appendChild(icon);

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
      openSettings();
    });

    return button;
  }

  function buildContainer() {
    let container = document.getElementById(CONTAINER_ID);
    if (!container) {
      container = document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "div"
      );
      container.id = CONTAINER_ID;
      container.className = "zen-quick-launch-container";
      container.setAttribute("role", "group");
      container.setAttribute("aria-label", "Quick Launch");
    }

    state.container = container;
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

    container.style.setProperty(
      "--zen-quick-launch-columns",
      String(config.columns)
    );
    syncItemSize(container);
    container.replaceChildren();

    for (const [index, item] of config.items.entries()) {
      container.appendChild(
        createButton(item, index, config.ctrlBackground)
      );
    }

    if (!config.items.length) {
      container.hidden = true;
    } else {
      container.hidden = false;
    }

    return config.items.length;
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

    const essentialsHost = document.getElementById("zen-essentials");
    if (essentialsHost?.parentNode) {
      if (essentialsHost.nextSibling !== container) {
        essentialsHost.after(container);
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
          data === PREF_CTRL_BG
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

    try {
      document.getElementById(CONTAINER_ID)?.remove();
      document.documentElement.removeAttribute(
        "zen-quick-launch-loaded"
      );
    } catch (_error) {}

    state.container = null;
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
    document.documentElement.setAttribute(
      "zen-quick-launch-loaded",
      "true"
    );
    log("Loaded. Right-click an entry to open the settings panel.");
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
