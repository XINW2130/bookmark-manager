# chrome-bookmark-manager · 全浏览器书签管理器

> Chrome 浏览器扩展 — 加密同步书签到 GitHub，支持多设备安全查看

---

## 项目类型

Chrome 扩展 (Manifest V3) · 纯原生 HTML/CSS/JS · 无构建工具 · 无 npm 依赖

---

## 核心架构

```
popup/                    ➜ 扩展弹窗（书签浏览 + 搜索 + 导出）
importer/                 ➜ 外部书签导入（HTML/JSON 解析）
sync/                     ➜ Git 同步引擎 + 设置页面
  git-sync.js            ➜ 核心模块（AES-GCM 加密 + Git API + PBKDF2 密钥派生）
  sync-settings.html/js   ➜ 同步设置 UI（GitHub 配置 + Pages 地址）
background/               ➜ Service Worker（bookmarks 事件 + 消息路由）
bookmark-viewer.html      ➜ GitHub Pages 独立查看器（自包含 HTML）
```

```
chrome.bookmarks API → popup 渲染 / background 统计
                            ↓
                    git-sync.js (AES-256-GCM 加密)
                            ↓
               GitHub REST API (PUT/GET docs/bookmarks.enc)
                            ↓
              bookmark-viewer.html (GitHub Pages 解密展示)
```

---

## 关键文件职责

| 文件 | 职责 |
|------|------|
| `manifest.json` | 扩展清单，权限: `bookmarks, storage, tabs, favicon` |
| `popup/popup.html` + `.js` + `.css` | 弹窗主界面，420×500px，树形/平铺书签展示 |
| `importer/importer.html` + `.js` + `.css` | 解析外部书签 HTML/JSON 文件，导入 `chrome.storage.local` |
| `sync/git-sync.js` | IIFE 模块，导出 `GitSync` 对象，加密 • Git API • 推拉同步 |
| `sync/sync-settings.html` + `.js` + `.css` | 配置 GitHub Token/仓库/密码，手动推拉，Pages 地址生成 |
| `background/background.js` | Service Worker，`chrome.runtime.onMessage` 路由 |
| `bookmark-viewer.html` | 纯前端解密查看器，部署于 GitHub Pages，`__ENCRYPTED_FILE__` 占位符替换 |

---

## 技术要点

### 加密体系 (`git-sync.js`)
- **PBKDF2** · 100,000 次迭代 · SHA-256 · 派生 256-bit AES-GCM 密钥
- **AES-256-GCM** · 随机 12-byte IV · 打包格式: `{salt, iv, data, version, timestamp}`
- 最终写入仓库的是 Base64 编码的加密 JSON

### Git 同步 (`git-sync.js`)
- 平台映射: `github` / `gitee`（都定义在 `PLATFORMS` 常量中）
- GitHub 统一推送到 `docs/` 目录（适配 GitHub Pages 部署要求）
- `pushBookmarks`: 收集书签 → 加密 → PUT API
- `pullBookmarks`: GET API → 解密 → merge 到 `chrome.storage.local`
- `pushViewerHtml`: 从扩展资源读取 `bookmark-viewer.html` 模板，替换 `__ENCRYPTED_FILE__` 占位符后推送到仓库

### 书签来源
- **Chrome 原生**: `chrome.bookmarks.getTree()` → 树形结构
- **外部导入**: 解析 Netscape HTML 书签文件 / Chrome JSON 导出 → `chrome.storage.local.importedBookmarks`

### GitHub Pages 查看器
- `bookmark-viewer.html` 完全自包含（CSS/JS 内联，零外部依赖）
- 密码弹窗解密 → 搜索 + 按来源筛选 → 卡片网格展示
- `__ENCRYPTED_FILE__` 在推送时替换为实际文件名（如 `bookmarks.enc`）

---

## 当前限制

1. **平台仅支持 GitHub** — Gitee Pages 已下线，设置页中置灰禁用
2. **移动端只读** — 移动浏览器不支持扩展，仅能通过 Pages 查看
3. **单文件同步** — 所有设备共用同一个加密文件，同时推送会覆盖

---

## 代码风格

- 全项目 ES6+，async/await
- CSS 统一变量体系: `--bg-primary`, `--accent`, `--text-*`
- DOM 选择器快捷函数: `$(selector)`, `$$(selector)` = `querySelector/querySelectorAll`
- 无框架，无 TypeScript，代码即源码
