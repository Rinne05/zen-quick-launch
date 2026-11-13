# Zen Quick Launch

Zen Quick Launch 是由 Sine 管理的 Zen Browser JS Mod。它在 Zen 左侧栏提供独立的入口网格，支持自定义入口和同步书签文件夹两种模式；入口不是 Pinned Tab 或 Essentials，每次点击都会创建一个新的普通标签页。

## 安装

需要先安装并启用 Sine。本项目发布在 `Rinne05/zen-quick-launch`，在 Zen 的设置页打开 Sine 即可安装和接收更新：

1. 在 Sine 设置中允许安装来自非官方来源的 JavaScript Mod。
2. 在 Sine 的自定义仓库输入框粘贴 `owner/repository` 或 GitHub 仓库地址并安装。
3. 如果 Sine 提示重启，按提示重启 Zen；否则按 Sine 的页面提示刷新 Mod。

安装、启用、禁用、卸载和更新都由 Sine 管理。设置页使用 `chrome.manifest` 注册 `chrome://zen-quick-launch/`，需要支持 `chromeManifest` 字段的 Sine 版本。

## 使用与设置

设置页是一个独立的 chrome 页面，可以在标签页中直接打开，也可以收藏：

```text
chrome://zen-quick-launch/content/settings.html
```

右键点击侧栏入口，选择“Quick Launch 设置…”或“编辑此入口…”也会打开该地址。该 Mod 不提供 Sine 偏好设置项，配置全部在设置页内完成。设置页支持两种入口来源：

- **自定义入口**：手动添加、删除、复制、启用/禁用、排序、填写名称、URL 和图标。
- **同步书签文件夹**：选择一个书签文件夹，侧栏直接显示该文件夹中的书签；在侧栏拖动入口会直接调整书签在文件夹中的顺序，书签管理器中的新增、删除、改名和排序也会实时同步。

书签模式只显示所选文件夹中的书签本身，不包含子文件夹和分隔符。两种模式都支持列数设置、Ctrl/Cmd 后台打开和 JSON 导入/导出。设置保存在 Zen preferences 中：

- `zen.quicklaunch.items`（自定义入口；切换模式后仍会保留）
- `zen.quicklaunch.mode`（`custom` 或 `bookmarks`）
- `zen.quicklaunch.bookmarkFolder`（书签文件夹 GUID）
- `zen.quicklaunch.columns`
- `zen.quicklaunch.ctrlBackground`

因此设置不会随 Mod 文件一起删除，重启后仍然保留；保存后侧栏实时刷新。

设置页通过 `theme.json` 的 `chromeManifest` 和仓库根目录的 `chrome.manifest` 注册为 `chrome://zen-quick-launch/` 内容包，因此不需要运行时注册 `about:` 模块。

- 左键：前台打开新的普通标签页。
- 中键：后台打开新的普通标签页。
- Ctrl/Cmd + 左键：按设置决定是否后台打开。
- 右键入口：打开与标签页风格一致的菜单，可打开、后台打开、在新窗口打开、复制链接、编辑此入口或进入设置页。书签模式下“编辑此入口…”会隐藏，入口本身在书签管理器中编辑。
- 拖动入口：按标签页拖动的方式显示插入线。自定义模式下新的顺序写入 preferences；书签模式下直接调用 Places 调整书签在文件夹中的顺序。
- 自动图标：侧栏优先采用已打开匹配标签页显示的 favicon，再尝试 Places 的 `page-icon:`；失败后重试并回退到通用图标。设置页预览采用相同的重试与回退策略。
- 自定义图标：在图标栏填写图标 URL。
- 位置：快捷启动网格位于 Essentials 常驻标签页上方，不会与常驻标签页重叠。
- 外观：侧栏入口复用 Zen 常驻标签页（Essentials）的 DOM 结构与样式钩子（`.zen-essentials-container .tabbrowser-tab[zen-essential]`、`.tab-background`、`.tab-icon-image`），尺寸、居中、可见性、背景、悬停、圆角和图标尺寸都由 Zen 及当前主题决定，因此切换主题时会和常驻标签页保持一致。
- URL 可填写完整地址，也可填写 `10.1.80.215:5244`、`localhost:3000` 等主机和端口；未写协议时会补成 `http://`。
- 设置页内 `Ctrl/Cmd + S` 保存。

禁用 Mod 时，Sine 会调用脚本卸载回调：侧栏节点、右键菜单、拖动指示器与观察器会清理，Sine 管理的样式也会停用。设置页由 `chrome.manifest` 提供，其注册状态会随 Mod 启用状态在重启后更新；重新启用即可恢复。

## 项目结构

```text
theme.json
chrome.manifest
chrome.css
settings.css
settings.html
settings.js
JS/
  zen-quick-launch.uc.js
README.md
```
