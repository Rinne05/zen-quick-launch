# 开发

Zen Quick Launch 从本仓库开发。`<profile>/chrome/sine-mods/zen-quick-launch`
只是运行时目标，不是源码树；仓库是唯一事实来源。

本文档记录开发环境、日常循环、检查方法、开发约定和发布步骤。当前功能范围以
[README.md](README.md) 的“使用与设置”一节为准。

## 开发约定

- **仓库是唯一事实来源。** `<profile>/chrome/sine-mods/zen-quick-launch`
  只是运行时目标；不要在安装目录里做唯一一份修改。
- **保持普通标签页语义。** 入口不是 Pinned Tab、Essentials 或 workspace
  标签；不要复用真实标签页的打开、关闭或拖动逻辑。
- **只影响自己的区域。** 侧栏选择器以 `#zen-quick-launch-*` 为边界，设置页
  以 `.zql-*` 为边界；不要新增 `:root`、`*`、`#navigator-toolbox`、
  `#tabbrowser-tabs` 这类全局覆盖。
- **复用原生钩子。** 优先使用 Essentials 的 DOM 形状、CSS 变量和状态类，
  让尺寸、背景、圆角、图标和主题切换跟随 Zen。
- **配置向后兼容。** 不重命名 `zen.quicklaunch.*`，不随意改变
  `zen.quicklaunch.items` 的字段含义；必须改变时提供迁移。
- **卸载要干净。** 新增节点、观察器、菜单、拖动指示器和消息监听都要在
  `cleanup()` 中清理。
- **一次提交只做一件事。** 中文提交信息写清动机和结果；新增功能的代码、
  注册和文档放在同一个提交里。
- **不要编辑运行时文件。** dev profile 的 `chrome/JS`、`chrome/utils`、
  `sine-mods/chrome.css`、`content.css` 都是 Sine 的运行时文件。
- **文档用中文。** 代码、选择器、命令、pref 名和 UI 标签保持原样。
- **AI 协作要如实报告验证范围。** 不要声称做过未执行的浏览器验证；明确区分
  语法检查、dev profile 手工检查和未验证的视觉细节。

## 为什么用 dev profile

专用 profile 可以保持日常浏览器稳定：

- 修改主脚本需要重启浏览器；重启干净的 profile 成本很低。
- 调试用 prefs（`sine.enable-dev`、Browser Toolbox）不会进入日常使用。
- 损坏的 userscript 或设置页不会卡死日常浏览器。
- 书签模式会读写 Places；独立 profile 的书签库可以随便建测试数据。
- 删除 dev profile 并重新执行搭建步骤即可重置。
- 用 `--new-instance` 可以让第二个实例与日常浏览器同时运行。

不要在 dev profile 登录账号或保留重要标签页。把它当作一次性环境。

## 目录结构

```text
<repo>/                              # git 根目录；这里就是 Mod 源码
  theme.json
  chrome.manifest
  chrome.css
  settings.html
  settings.css
  settings.js
  JS/
    zen-quick-launch.uc.js
  README.md
  DEVELOPMENT.md

<dev-profile>/chrome/
  JS/                                # Sine 引擎（从可用 profile 复制）
  utils/                             # Sine 引导 + chrome.manifest
  sine-mods/
    mods.json                        # Sine 的已安装 Mod 元数据
    chrome.css                       # 由 Sine 生成
    content.css                      # 由 Sine 生成
    zen-quick-launch -> <repo>       # symlink；仓库就是 Mod
```

`sine-mods/chrome.css` 和 `content.css` 每次 Sine 刷新都会重新生成，不要直接
编辑。仓库根目录的 `chrome.css` 是本 Mod 的源码样式表，和它不是一个文件。

## 选择 profile 名

所有命令通过变量定位开发环境，不写死某个 profile：

```bash
PROFILE_NAME="${PROFILE_NAME:-zen-dev}"
DEV="$HOME/.config/zen/$PROFILE_NAME"
REPO="$HOME/code/browser/zen-quick-launch"
SOURCE="$HOME/.config/zen/<existing-profile>"   # 已安装 Sine 的 profile
```

- 默认 `PROFILE_NAME=zen-dev`。这个 profile 可以同时承载多个 Zen Mod；
  每个 Mod 在 `sine-mods/` 下有独立目录或 symlink。
- `PROFILE_NAME` 可以改成任意目录名；脚本会保留该 profile 里已有的其他
  Mod 条目。
- 下面的命令默认在同一个 shell 会话中执行；如果分开执行，先重新设置这些
  变量。
- 不要把日常 profile 当作 dev profile。

## 一次性搭建

以下命令假设 Linux，其他系统请自行调整路径。重复执行是安全的：已存在的
profile、Sine 引擎和 symlink 会跳过或保留。

### 1. 创建 profile（如果不存在）

```bash
if [ ! -d "$DEV" ]; then
  zen-browser --no-remote -CreateProfile "$PROFILE_NAME $DEV"
fi
```

`-CreateProfile` 只负责注册新 profile；已有 profile 不会被改动。

### 2. 复制 Sine 引擎（如果缺失）

```bash
mkdir -p "$DEV/chrome"
if [ ! -d "$DEV/chrome/JS" ]; then
  cp -a "$SOURCE/chrome/JS" "$DEV/chrome/JS"
  cp -a "$SOURCE/chrome/utils" "$DEV/chrome/utils"
fi
```

`SOURCE` 必须是已经安装并启用 Sine 的 profile。`/opt/zen-browser-bin/config.js`
只从 profile 的 `chrome/` 目录引导 Sine，所以每个 profile 都需要自己的一份
引擎。

### 3. 写入或更新 `mods.json`

```bash
mkdir -p "$DEV/chrome/sine-mods"
node - "$SOURCE/chrome/sine-mods/mods.json" \
        "$DEV/chrome/sine-mods/mods.json" \
        "$REPO/theme.json" <<'NODE'
const fs = require("fs");
const [srcPath, dstPath, themePath] = process.argv.slice(2);
const readJson = (path) =>
  fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
const src = readJson(srcPath);
const dst = readJson(dstPath);
const mod = dst["zen-quick-launch"] || src["zen-quick-launch"];
if (!mod) {
  throw new Error("找不到 zen-quick-launch 元数据，请先安装一次本项目");
}
if (fs.existsSync(themePath)) {
  mod.version = JSON.parse(fs.readFileSync(themePath, "utf8")).version;
}
mod.enabled = true;
mod["no-updates"] = true;
dst["zen-quick-launch"] = mod;
fs.writeFileSync(dstPath, JSON.stringify(dst));
NODE
```

脚本优先使用 dev profile 已有的 `zen-quick-launch` 条目；没有时从 `SOURCE`
的 `mods.json` 提取。写入时把 `no-updates` 设为 `true`，并把 `version` 同步
为仓库 `theme.json` 的版本。复用的 profile 中其他 Mod 条目会保留。

如果两个来源都没有 `zen-quick-launch`，先在任意 profile 的 Sine 设置里安装
一次本项目，再重新执行这一步；不要手写不完整的条目。

### 4. 把安装副本替换成 symlink

```bash
if [ -e "$DEV/chrome/sine-mods/zen-quick-launch" ] &&
   [ ! -L "$DEV/chrome/sine-mods/zen-quick-launch" ]; then
  mv "$DEV/chrome/sine-mods/zen-quick-launch" \
    "${TMPDIR:-/tmp}/zen-quick-launch-backup-$(date +%s)"
fi
ln -sfn "$REPO" "$DEV/chrome/sine-mods/zen-quick-launch"
readlink -f "$DEV/chrome/sine-mods/zen-quick-launch"
```

期望输出 `$REPO`。

### 5. 确认 `user.js`

`<dev-profile>/user.js` 会在每次启动时重新应用并覆盖 `prefs.js`，因此这些
值会一直保持。文件不存在时写入以下内容；已存在时确认这些 pref 都在：

```bash
if [ ! -f "$DEV/user.js" ]; then
  cat > "$DEV/user.js" <<'EOF'
// Sine：加载 .uc.js Mod，启用 dev 调色板（Ctrl+Shift+Y），并在测试期间
// 避开引擎/Mod 更新。
user_pref("sine.allow-unsafe-js", true);
user_pref("sine.enable-dev", true);
user_pref("sine.auto-updates", false);
user_pref("sine.engine.auto-update", false);

// 快速、空白启动。
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.page", 0);
user_pref("browser.startup.homepage", "about:blank");
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.tabs.warnOnClose", false);
user_pref("zen.welcome-screen.seen", true);
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);

// Browser Toolbox，用于检查侧栏和设置页。
user_pref("devtools.chrome.enabled", true);
user_pref("devtools.debugger.remote-enabled", true);
user_pref("devtools.debugger.prompt-connection", false);
EOF
fi
```

`sine.allow-unsafe-js` 是必需的。没有它，Sine 会静默跳过所有 `.uc.js`
脚本，侧栏不会出现入口。

### 6. 启动

先关闭已有的同名 dev 实例，然后：

```bash
zen-browser --new-instance --profile "$DEV"
```

`--new-instance` 会在日常浏览器运行时启动一个独立进程，并避免把陈旧的
profile lock 误判为已有实例。

### 7. 验证

- `about:config` 中 `sine.allow-unsafe-js = true`、`sine.enable-dev = true`。
- `Ctrl+Shift+Y` 打开一个小调色板，包含 **Refresh mod styles** 和
  **Open mod folder**。
- 启动后 `ls -l "$DEV/chrome/sine-mods/zen-quick-launch"` 仍然是 symlink。
- `"$DEV/chrome/sine-mods/chrome.css"` 包含指向仓库 `chrome.css` 的
  `@import`。
- 侧栏出现 Quick Launch 入口网格；首次运行是 4 个默认入口。
- `chrome://zen-quick-launch/content/settings.html` 能加载设置页。

## 日常循环

| 改动 | 操作 | 原因 |
| --- | --- | --- |
| `chrome.css` | 保存 → `Ctrl+Shift+Y` → **Refresh mod styles** | Sine 重新生成 `sine-mods/chrome.css` 并重新应用 user sheet；`@import` 会重新读取仓库文件。 |
| `JS/zen-quick-launch.uc.js` | 保存 → 重启 dev profile | Sine 不会热重载已经加载的 `.uc.js`；`supportsUnload` 只保证显式卸载时能清理。 |
| `settings.html` / `settings.css` / `settings.js` | 保存 → 刷新设置页标签 | 设置页是独立 chrome 文档，重新加载即可读到新文件。 |
| `chrome.manifest` | 保存 → 重启 dev profile | 内容包在启动时由 Sine 注册；刷新样式不会重新注册 manifest。 |
| `theme.json` | 改脚本/样式/Manifest 注册时同步 dev 的 `mods.json`，再重启 | `theme.json` 只在安装时读取；运行状态以 `mods.json` 为准。 |
| `README.md` / `DEVELOPMENT.md` | 不需要浏览器操作 | 文档不参与运行时。 |

新增模块沿用同一规则：改 CSS 用 **Refresh mod styles**，改主脚本重启，改设置页
刷新标签。

**为什么 CSS 能重载。** 执行 **Refresh mod styles** 时，Sine 会重新生成
`sine-mods/chrome.css`，其中包含
`@import "file:///.../sine-mods/zen-quick-launch/chrome.css"`；重新应用
user sheet 后，已经打开的界面会读到新值。

**为什么主脚本不能。** Sine 的 **Refresh mod styles** 只重建样式，不会重载
已经加载的 `.uc.js`。当前脚本虽然有 `cleanup()` 和 `supportsUnload`，它们
保证的是显式卸载时能清理，而不是热重载；重启 dev profile 才是可靠的循环。

## 检查

### Browser Toolbox

打开 **Tools → Browser Tools → Browser Toolbox**。用 Inspector 查看侧栏节点，
用 Style Editor 查看导入的样式表，用 Console 查看 `[Zen Quick Launch]` 日志。

在 Browser Toolbox 的 chrome 控制台检查侧栏：

```js
const container = document.getElementById("zen-quick-launch-container");
const essentials = document.getElementById("zen-essentials");
const divider = document.getElementById("zen-quick-launch-divider");

({
  loaded: document.documentElement.getAttribute("zen-quick-launch-loaded"),
  items: container?.querySelectorAll(".zen-quick-launch-item").length,
  hidden: container?.hidden,
  divider: !!divider,
  order:
    container?.nextElementSibling === divider &&
    divider?.nextElementSibling === essentials,
  overlap:
    container && essentials
      ? container.getBoundingClientRect().bottom >
        essentials.getBoundingClientRect().top
      : null,
  columns: container
    ? getComputedStyle(container).gridTemplateColumns
    : null,
});
```

期望：`loaded` 为 `"true"`，`items` 与当前模式下的入口数量一致，`order` 为
`true`，`overlap` 为 `false`。

设置页检查（在设置页标签打开控制台）：

```js
({
  title: document.title,
  rows: document.querySelectorAll(".zql-item").length,
  mode: document.querySelector(".zql-mode")?.value,
});
```

期望：标题为 `Zen Quick Launch 设置`，`rows` 与入口数量一致，`mode` 为
`custom` 或 `bookmarks`。

右键菜单检查：

- 自定义模式：打开、后台打开、新窗口、复制链接、编辑、删除和设置入口都
  可用；删除后侧栏数量立即减少。
- 书签模式：菜单项与 Zen 书签侧栏一致；编辑/删除书签、剪切/复制/粘贴、
  新建书签/文件夹/分隔条和末尾的 Quick Launch 设置可用。编辑书签会打开
  原生书签对话框，不会跳到 Quick Launch 设置页。

### 重置测试状态

`about:config` → 搜索 `zen.quicklaunch.` → 重置所有项。侧栏会通过 pref 观察器
实时刷新；如果入口没有恢复，重启 dev profile。

### Headless / Marionette（可选）

需要脚本化检查时，可以用一次性 profile：

```bash
MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 \
  zen-browser --headless --marionette --new-instance \
  --profile /tmp/zql-test about:blank
```

连接后在 chrome 上下文读取 `#zen-quick-launch-container` 的位置、数量，以及
`chrome://zen-quick-launch/content/settings.html` 的 DOM。当前仓库没有内置
Marionette 客户端；日常仍以 Browser Toolbox 手工检查为准。

## 常见坑

1. **没有 symlink 就没有实时编辑。** 如果 `sine-mods/zen-quick-launch` 是真实
   文件夹，改仓库不会生效，除非手动复制。用 `readlink` 检查。
2. **Sine 更新会替换 symlink。** 不要对 symlink 的 Mod 点更新。在 dev
   profile 里保持 `no-updates` 开启、`sine.auto-updates` 关闭。
3. **`mods.json` 才是运行状态。** 仓库里的 `theme.json` 只在安装时读取。
   新增脚本、改样式路径或改 `chromeManifest` 后，如果 dev 的 `mods.json`
   没同步，运行时不会看到变化。
4. **`sine.allow-unsafe-js` 必须为 true**，否则 userscript 会被静默跳过，
   而且没有明显报错。
5. **`chrome.manifest` 改动要重启。** 设置页的 `chrome://zen-quick-launch/`
   注册发生在启动阶段；只刷新样式不会重新注册。
6. **CSS 刷新不会重载主脚本。** 改 `JS/zen-quick-launch.uc.js` 必须重启。
7. **卸载 Mod 不会清空配置。** `zen.quicklaunch.*` 会保留；需要干净测试时
   手动重置。
8. **书签测试要留在 dev profile。** 书签模式的拖动排序会直接改 Places 顺序；
   不要在日常 profile 里试。
9. **Zen 的样式钩子会变。** 侧栏复用了 `.zen-essentials-container`、
   `.tabbrowser-tab[zen-essential]`、`.tab-background`、`.tab-icon-image`
   等结构；Zen 更新后先检查这些钩子是否仍然存在。
10. **共用 profile 可能加载其他 Mod。** `zen-dev` 里的其他 Mod 会一起启动；
    如果侧栏出现无法解释的布局问题，先临时禁用其他 Mod，或换一个独立
    `PROFILE_NAME` 再判断。
11. **设置页 URL 依赖 `chrome.manifest`。** 修改 content 包名或路径时，要同步
    `JS/zen-quick-launch.uc.js` 中的 `SETTINGS_URL`、README 和设置页链接。
12. **不要编辑生成的 `sine-mods/chrome.css`。** 它每次刷新都会重写；要改样式
    请改仓库根目录的 `chrome.css`。
13. **书签右键菜单依赖 Zen 原生菜单模板。** 它从
    `#sidebar-bookmarks-context-menu` 克隆结构和文案，并调用 Places API；
    Zen 更新后先检查菜单项 ID、`PlacesUIUtils` 和 `PlacesTransactions` 接口
    是否仍然存在。

## 发布检查清单

1. 在 dev profile 中验证目标功能和相邻 UI 回归；如果行为范围有变化，同步
   更新 [README.md](README.md) 和本文档。
2. 运行 `node --check JS/zen-quick-launch.uc.js` 和
   `node --check settings.js`；检查 `git diff --check`。
3. 更新 `theme.json` 的 `version`，以及 README 中的测试版本行。
4. 检查 `git diff`；从仓库提交并推送。
5. 在日常 profile 中通过 Sine 从 GitHub 安装或更新（不要用 symlink），
   然后重启。
6. 检查安装文件夹是否有旧文件，并确认侧栏、设置页和书签模式按预期工作。
