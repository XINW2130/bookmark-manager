/* ============================================================
   popup.js - 书签管理器弹窗主逻辑
   ============================================================ */

// ---------- 状态管理 ----------
const state = {
  chromeBookmarks: [],      // Chrome 原生书签（展平）
  importedBookmarks: [],    // 外部导入书签
  treeData: [],             // Chrome 书签树结构
  currentTab: 'all',        // 'all' | 'imported'
  searchQuery: '',
  expandedFolders: new Set(),
  stats: { total: 0, folders: 0, imported: 0 }
};

// ---------- DOM 引用 ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
  searchInput: $('#searchInput'),
  btnClearSearch: $('#btnClearSearch'),
  bookmarkArea: $('#bookmarkArea'),
  emptyState: $('#emptyState'),
  statsBar: $('#statsBar'),
  statTotal: $('#statTotal'),
  statFolders: $('#statFolders'),
  statImported: $('#statImported'),
  btnRefresh: $('#btnRefresh'),
  btnExport: $('#btnExport'),
  btnOpenImporter: $('#btnOpenImporter'),
  btnScanAll: $('#btnScanAll'),
  btnSyncSettings: $('#btnSyncSettings'),
  detailModal: $('#detailModal'),
  modalBody: $('#modalBody'),
  btnCloseModal: $('#btnCloseModal'),
  tabBtns: $$('.tab-btn')
};

// ---------- 初始化 ----------
document.addEventListener('DOMContentLoaded', async () => {
  await loadAllBookmarks();
  renderBookmarks();
  bindEvents();
  tryAutoSync(); // 自动拉取 Git 同步
});

async function loadAllBookmarks() {
  els.bookmarkArea.innerHTML = '<div class="loading">正在加载书签...</div>';
  
  try {
    // 获取 Chrome 原生书签
    const chromeTree = await chrome.bookmarks.getTree();
    state.treeData = chromeTree;
    state.chromeBookmarks = flattenBookmarks(chromeTree);
    
    // 获取外部导入书签
    const result = await chrome.storage.local.get(['importedBookmarks']);
    state.importedBookmarks = result.importedBookmarks || [];
    
    // 统计
    updateStats();
  } catch (err) {
    console.error('加载书签失败:', err);
    showToast('加载书签失败，请重试', 'error');
  }
}

// ---------- 书签树展平 ----------
function flattenBookmarks(tree, parentPath = '', result = []) {
  for (const node of tree) {
    if (node.url) {
      // 是书签链接
      result.push({
        id: node.id,
        title: node.title || '无标题',
        url: node.url,
        folder: parentPath || '未分类',
        dateAdded: node.dateAdded,
        source: 'chrome'
      });
    }
    if (node.children) {
      let path = parentPath;
      if (node.title && node.title !== '') {
        path = parentPath ? `${parentPath} / ${node.title}` : node.title;
      }
      flattenBookmarks(node.children, path, result);
    }
  }
  return result;
}

// ---------- 统计文件夹数量 ----------
function countFolders(tree) {
  let count = 0;
  for (const node of tree) {
    if (node.children && !node.url) {
      if (node.title) count++;
      count += countFolders(node.children);
    }
  }
  return count;
}

function getVisibleFolders(tree) {
  let count = 0;
  function countVisible(nodes) {
    for (const node of nodes) {
      if (node.children && !node.url) {
        count++;
        countVisible(node.children);
      }
    }
  }
  countVisible(tree);
  return count;
}

function updateStats() {
  const chromeFolderCount = countFolders(state.treeData);
  state.stats = {
    total: state.chromeBookmarks.length + state.importedBookmarks.length,
    folders: chromeFolderCount,
    imported: state.importedBookmarks.length
  };
  
  els.statTotal.textContent = state.stats.total;
  els.statFolders.textContent = state.stats.folders;
  els.statImported.textContent = state.stats.imported;
}

// ---------- 渲染书签 ----------
function renderBookmarks() {
  const query = state.searchQuery.toLowerCase().trim();
  
  if (state.stats.total === 0 && state.stats.imported === 0) {
    els.emptyState.style.display = '';
    els.bookmarkArea.innerHTML = '';
    els.statsBar.style.display = 'none';
    return;
  }
  
  els.emptyState.style.display = 'none';
  els.statsBar.style.display = '';
  
  if (state.currentTab === 'all') {
    renderAllBookmarks(query);
  } else {
    renderImportedBookmarks(query);
  }
}

// ---------- 渲染全部书签 ----------
function renderAllBookmarks(query) {
  let html = '';
  
  // 过滤
  const filteredChrome = query
    ? state.chromeBookmarks.filter(b => 
        b.title.toLowerCase().includes(query) || 
        b.url.toLowerCase().includes(query) ||
        b.folder.toLowerCase().includes(query))
    : state.chromeBookmarks;
  
  const filteredImported = query
    ? state.importedBookmarks.filter(b =>
        b.title.toLowerCase().includes(query) ||
        b.url.toLowerCase().includes(query) ||
        (b.sourceName && b.sourceName.toLowerCase().includes(query)))
    : [];
  
  const hasChrome = filteredChrome.length > 0;
  const hasImported = filteredImported.length > 0 || 
    (!query && state.importedBookmarks.length > 0);
  
  if (query) {
    // 搜索模式：平铺显示
    html += '<div class="source-section">';
    html += '<div class="source-section-header"><span class="source-dot chrome"></span>Chrome 书签</div>';
    
    if (filteredChrome.length === 0) {
      html += '<div class="no-results"><div class="icon">🔍</div>Chrome 中无匹配书签</div>';
    } else {
      for (const bm of filteredChrome) {
        html += renderBookmarkItem(bm, 'chrome');
      }
    }
    
    html += '</div>';
    
    html += '<div class="source-section">';
    html += '<div class="source-section-header"><span class="source-dot imported"></span>外部导入书签</div>';
    
    if (filteredImported.length === 0) {
      html += '<div class="no-results"><div class="icon">🔍</div>外部导入中无匹配书签</div>';
    } else {
      for (const bm of filteredImported) {
        html += renderBookmarkItem(bm, 'imported');
      }
    }
    html += '</div>';
    
  } else {
    // 浏览模式：树形显示 Chrome + 导入书签
    html += renderTreeView(state.treeData);
    
    if (state.importedBookmarks.length > 0) {
      html += '<div class="source-section">';
      html += '<div class="source-section-header"><span class="source-dot imported"></span>外部导入书签</div>';
      html += '<div class="folder-children" style="display:block">';
      html += renderImportedGroup(state.importedBookmarks);
      html += '</div>';
      html += '</div>';
    }
  }
  
  els.bookmarkArea.innerHTML = html || '<div class="loading">暂无书签数据</div>';
  bindBookmarkEvents();
}

// ---------- 渲染外部导入书签 ----------
function renderImportedBookmarks(query) {
  const filtered = query
    ? state.importedBookmarks.filter(b =>
        b.title.toLowerCase().includes(query) ||
        b.url.toLowerCase().includes(query) ||
        (b.sourceName && b.sourceName.toLowerCase().includes(query)))
    : state.importedBookmarks;
  
  let html = '';
  
  if (filtered.length === 0) {
    html += `<div class="empty-state">
      <div class="empty-icon">📭</div>
      <p>${query ? '无匹配的外部书签' : '暂无外部导入书签'}</p>
      <p class="sub-text">点击底部按钮导入书签文件</p>
    </div>`;
  } else {
    html += renderImportedGroup(filtered);
  }
  
  els.bookmarkArea.innerHTML = html;
  bindBookmarkEvents();
}

// ---------- 导入书签分组 ----------
function renderImportedGroup(bookmarks) {
  // 按来源分组
  const groups = {};
  for (const bm of bookmarks) {
    const source = bm.sourceName || '未知来源';
    if (!groups[source]) groups[source] = [];
    groups[source].push(bm);
  }
  
  let html = '';
  for (const [source, bms] of Object.entries(groups)) {
    if (Object.keys(groups).length > 1) {
      html += `<div style="padding: 6px 16px; font-size: 11px; color: var(--text-muted); font-weight: 600;">
        📂 ${escapeHtml(source)} (${bms.length})
      </div>`;
    }
    for (const bm of bms) {
      html += renderBookmarkItem(bm, 'imported');
    }
  }
  return html;
}

// ---------- 树形视图渲染 ----------
function renderTreeView(nodes, depth = 0) {
  let html = '';
  for (const node of nodes) {
    if (node.children && !node.url) {
      // 文件夹
      const folderId = node.id;
      const isExpanded = state.expandedFolders.has(folderId);
      const childCount = countBookmarksInFolder(node);
      const displayTitle = node.title || (depth === 0 ? '书签栏' : '未命名文件夹');
      
      html += `<div class="folder-group" data-folder-id="${folderId}">
        <div class="folder-header">
          <span class="folder-toggle ${isExpanded ? 'expanded' : ''}">▶</span>
          <span class="folder-icon">${isExpanded ? '📂' : '📁'}</span>
          <span class="folder-name">${escapeHtml(displayTitle)}</span>
          <span class="folder-count">${childCount}</span>
        </div>
        <div class="folder-children" style="display:${isExpanded ? 'block' : 'none'}">
          ${renderTreeView(node.children, depth + 1)}
        </div>
      </div>`;
    } else if (node.url) {
      // 书签
      html += renderBookmarkItem({
        id: node.id,
        title: node.title || '无标题',
        url: node.url,
        dateAdded: node.dateAdded,
        folder: '',
        source: 'chrome'
      }, 'chrome', depth);
    }
  }
  return html;
}

function countBookmarksInFolder(node) {
  let count = 0;
  function countIt(n) {
    if (n.url) { count++; return; }
    if (n.children) n.children.forEach(countIt);
  }
  countIt(node);
  return count;
}

// ---------- 单个书签项 HTML ----------
function renderBookmarkItem(bm, sourceType, depth = 0) {
  const domain = extractDomain(bm.url);
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
  const paddingLeft = sourceType === 'chrome' ? 40 + (depth - 1) * 0 : 40;
  const importClass = sourceType === 'imported' ? ' imported' : '';
  const sourceLabel = sourceType === 'imported' 
    ? `<span class="bookmark-source source-imported">导入</span>`
    : '';
  
  return `
    <div class="bookmark-item${importClass}" 
         data-id="${escapeAttr(bm.id)}"
         data-url="${escapeAttr(bm.url)}"
         data-title="${escapeAttr(bm.title)}"
         style="padding-left:${paddingLeft}px">
      <img class="bookmark-favicon" src="${faviconUrl}" 
           onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" 
           alt="">
      <span class="bookmark-favicon-placeholder" style="display:none;">🔗</span>
      <div class="bookmark-info">
        <div class="bookmark-title">${highlightMatch(escapeHtml(bm.title), state.searchQuery)}</div>
        <div class="bookmark-url">${highlightMatch(escapeHtml(truncateUrl(bm.url)), state.searchQuery)}</div>
      </div>
      ${sourceLabel}
      <div class="bookmark-actions">
        <button class="mini-btn" data-action="open" title="打开">↗</button>
        <button class="mini-btn" data-action="copy" title="复制链接">📋</button>
        <button class="mini-btn delete" data-action="delete" title="删除">🗑</button>
      </div>
    </div>
  `;
}

// ---------- 事件绑定 ----------
function bindEvents() {
  // Tab 切换
  els.tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      els.tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.currentTab = btn.dataset.tab;
      renderBookmarks();
    });
  });
  
  // 搜索
  els.searchInput.addEventListener('input', debounce((e) => {
    state.searchQuery = e.target.value;
    els.btnClearSearch.style.display = state.searchQuery ? '' : 'none';
    renderBookmarks();
  }, 200));
  
  els.btnClearSearch.addEventListener('click', () => {
    els.searchInput.value = '';
    state.searchQuery = '';
    els.btnClearSearch.style.display = 'none';
    renderBookmarks();
  });
  
  // 刷新
  els.btnRefresh.addEventListener('click', async () => {
    state.expandedFolders.clear();
    await loadAllBookmarks();
    renderBookmarks();
    showToast('书签已刷新', 'success');
  });
  
  // 导出
  els.btnExport.addEventListener('click', exportAllBookmarks);
  
  // 打开导入页面
  els.btnOpenImporter.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('importer/importer.html') });
  });
  
  // 扫描 Chrome 书签
  els.btnScanAll.addEventListener('click', async () => {
    state.expandedFolders.clear();
    await loadAllBookmarks();
    renderBookmarks();
    showToast(`已扫描 ${state.stats.total} 条书签`, 'info');
  });
  
  // 关闭弹窗
  els.btnCloseModal.addEventListener('click', () => {
    els.detailModal.classList.remove('show');
  });
  
  els.detailModal.addEventListener('click', (e) => {
    if (e.target === els.detailModal) {
      els.detailModal.classList.remove('show');
    }
  });
  
  // 打开 Git 同步设置
  els.btnSyncSettings.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('sync/sync-settings.html') });
  });
}

// ---------- Git 自动同步 ----------
async function tryAutoSync() {
  try {
    const result = await chrome.storage.local.get(['gitSyncConfig', 'gitSyncPassword']);
    const config = result.gitSyncConfig || {};
    const password = result.gitSyncPassword;
    
    if (!config.repoOwner || !config.repoName || !config.token || !password) return;
    if (!config.autoSync) return;
    
    // 在后台静默拉取
    const syncResult = await chrome.runtime.sendMessage({ action: 'autoPull', password });
    if (syncResult && syncResult.newCount > 0) {
      // 有新数据，重新加载
      await loadAllBookmarks();
      renderBookmarks();
      showToast(`Git 同步: 新增 ${syncResult.newCount} 条书签`, 'info');
    }
  } catch {
    // 静默失败，不影响正常使用
  }
}

function bindBookmarkEvents() {
  // 文件夹展开/折叠
  els.bookmarkArea.querySelectorAll('.folder-header').forEach(header => {
    header.addEventListener('click', (e) => {
      const group = header.closest('.folder-group');
      const folderId = group.dataset.folderId;
      const children = group.querySelector('.folder-children');
      const toggle = header.querySelector('.folder-toggle');
      const icon = header.querySelector('.folder-icon');
      
      if (state.expandedFolders.has(folderId)) {
        state.expandedFolders.delete(folderId);
        children.style.display = 'none';
        toggle.classList.remove('expanded');
        icon.textContent = '📁';
      } else {
        state.expandedFolders.add(folderId);
        children.style.display = 'block';
        toggle.classList.add('expanded');
        icon.textContent = '📂';
      }
    });
  });
  
  // 书签项点击事件
  els.bookmarkArea.querySelectorAll('.bookmark-item').forEach(item => {
    item.addEventListener('click', (e) => {
      const actionBtn = e.target.closest('[data-action]');
      if (actionBtn) return; // 由按钮事件处理
      
      const url = item.dataset.url;
      if (url) {
        chrome.tabs.create({ url });
      }
    });
  });
  
  // 操作按钮
  els.bookmarkArea.querySelectorAll('[data-action="open"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = btn.closest('.bookmark-item');
      chrome.tabs.create({ url: item.dataset.url });
    });
  });
  
  els.bookmarkArea.querySelectorAll('[data-action="copy"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const item = btn.closest('.bookmark-item');
      try {
        await navigator.clipboard.writeText(item.dataset.url);
        showToast('链接已复制', 'success');
      } catch {
        showToast('复制失败', 'error');
      }
    });
  });
  
  els.bookmarkArea.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const item = btn.closest('.bookmark-item');
      const id = item.dataset.id;
      const title = item.dataset.title;
      
      if (confirm(`确定删除书签「${title}」吗？`)) {
        await deleteBookmark(id, item);
      }
    });
  });
}

// ---------- 删除书签 ----------
async function deleteBookmark(id, element) {
  try {
    // 先尝试从 Chrome 原生删除
    try {
      await chrome.bookmarks.remove(id);
    } catch {
      // 不是 Chrome 书签，从导入列表中删除
    }
    
    // 从导入列表中查找并删除
    const idx = state.importedBookmarks.findIndex(b => b.id === id);
    if (idx !== -1) {
      state.importedBookmarks.splice(idx, 1);
      await chrome.storage.local.set({ importedBookmarks: state.importedBookmarks });
    }
    
    // 动画移除
    element.style.opacity = '0';
    element.style.transform = 'translateX(20px)';
    element.style.transition = '0.3s ease';
    setTimeout(() => {
      updateStats();
      renderBookmarks();
    }, 300);
    
    showToast('书签已删除', 'success');
  } catch (err) {
    console.error('删除失败:', err);
    showToast('删除失败', 'error');
  }
}

// ---------- 导出书签 ----------
function exportAllBookmarks() {
  // 导出为 Netscape Bookmark 格式 HTML
  const allBookmarks = [
    ...state.chromeBookmarks.map(b => ({ ...b, source: 'chrome' })),
    ...state.importedBookmarks
  ];
  
  let html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
`;

  // 按文件夹分组
  const byFolder = {};
  for (const bm of allBookmarks) {
    const folder = bm.folder || bm.sourceName || '未分类';
    if (!byFolder[folder]) byFolder[folder] = [];
    byFolder[folder].push(bm);
  }
  
  for (const [folder, bms] of Object.entries(byFolder)) {
    html += `  <DT><H3>${escapeHtml(folder)}</H3>\n  <DL><p>\n`;
    for (const bm of bms) {
      const addDate = bm.dateAdded ? Math.floor(bm.dateAdded / 1000) : '';
      html += `    <DT><A HREF="${escapeHtml(bm.url)}" ADD_DATE="${addDate}">${escapeHtml(bm.title)}</A>\n`;
    }
    html += `  </DL><p>\n`;
  }
  
  html += `</DL><p>\n`;
  
  // 下载文件
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bookmarks_export_${new Date().toISOString().slice(0, 10)}.html`;
  a.click();
  URL.revokeObjectURL(url);
  
  showToast('书签已导出', 'success');
}

// ---------- 工具函数 ----------
function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  if (!str) return '';
  return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncateUrl(url) {
  if (!url) return '';
  return url.length > 50 ? url.slice(0, 47) + '...' : url;
}

function highlightMatch(text, query) {
  if (!query || !text) return text;
  const regex = new RegExp(`(${escapeRegex(query)})`, 'gi');
  return text.replace(regex, '<span class="highlight">$1</span>');
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function debounce(fn, delay) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// ---------- Toast 提示 ----------
function showToast(message, type = 'info') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}
