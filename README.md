# Zen Quick Launch

Zen Quick Launch 是由 Sine 管理的 Zen Browser JS Mod。它在 Zen 左侧栏提供独立的入口网格；入口不是书签、Pinned Tab 或 Essentials，每次点击都会创建一个新的普通标签页。

## 安装

需要先安装并启用 Sine。本项目发布在 `Rinne05/zen-quick-launch`，在 Zen 的设置页打开 Sine 即可安装和接收更新：

1. 在 Sine 设置中允许安装来自非官方来源的 JavaScript Mod。
2. 在 Sine 的自定义仓库输入框粘贴 `owner/repository` 或 GitHub 仓库地址并安装。
3. 如果 Sine 提示重启，按提示重启 Zen；否则按 Sine 的页面提示刷新 Mod。

安装、启用、禁用、卸载和更新都由 Sine 管理。

## 使用与设置

右键点击侧栏中的 Quick Launch 图标即可打开设置面板。该 Mod 不提供 Sine 偏好设置项，配置全部在面板内完成。面板支持添加、删除、复制、启用/禁用、排序、名称、URL、图标、列数以及 JSON 导入/导出。设置保存在 Zen preferences 中：

- `zen.quicklaunch.items`
- `zen.quicklaunch.columns`
- `zen.quicklaunch.ctrlBackground`

因此设置不会随 Mod 文件一起删除，重启后仍然保留；保存后侧栏实时刷新。

设置面板直接注入浏览器窗口（`JS/zen-quick-launch-settings.uc.js` + `chrome.css` 中的样式），与侧栏共享同一套 preferences。之所以不做成独立页面，是因为当前 Zen/Firefox 不再支持由 JS 在运行时注册的 `about:` 模块，这类页面无法作为标签页加载。

- 左键：前台打开新的普通标签页。
- 中键：后台打开新的普通标签页。
- Ctrl/Cmd + 左键：按设置决定是否后台打开。
- 右键入口：打开 Quick Launch 设置面板。
- 自动图标：优先采用已打开匹配标签页显示的 favicon，再尝试 Places 的 `page-icon:`；失败后重试并回退到通用图标。设置预览与侧栏采用相同的加载、重试和回退策略。
- 自定义图标：在图标栏填写图标 URL。
- URL 可填写完整地址，也可填写 `10.1.80.215:5244`、`localhost:3000` 等主机和端口；未写协议时会补成 `http://`。
- 设置面板内 `Ctrl/Cmd + S` 保存，`Esc` 关闭。

禁用 Mod 时，Sine 会调用脚本卸载回调：侧栏节点与观察器会清理，设置面板会被移除，Sine 管理的样式也会停用。重新启用即可恢复。

## 项目结构

```text
theme.json
chrome.css
JS/
  zen-quick-launch.uc.js
  zen-quick-launch-settings.uc.js
README.md
```
