/* ============================================================
   importer.js - 外部书签文件导入与解析
   支持格式：HTML (Netscape Bookmark File Format), JSON
   ============================================================ */

// ---------- 状态管理 ----------
const state = {
  parsedFiles: [],       // [{ name, bookmarks: [], folders: Set, raw: ... }]
  selectedMap: {},       // { bookmarkId: true/false }
  expandedFiles: new Set(),
  expandedFolders: new Set(),
  isImporting: false
};

// ---------- 书签合并映射（生成唯一 ID） ----------
let idCounter = Date.now();
function generateId() {
  return `imported_${++idCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------- DOM 引用 ----------
const $ = (sel) => document.querySelector(sel);

const els = {
  dropZone: $('#dropZone'),
  fileInput: $('#fileInput'),
  previewList: $('#previewList'),
  previewStats: $('#previewStats'),
  previewActions: $('#previewActions'),
  previewFileCount: $('#previewFileCount'),
  previewBookmarkCount: $('#previewBookmarkCount'),
  previewFolderCount: $('#previewFolderCount'),
  btnSelectAll: $('#btnSelectAll'),
  btnDeselectAll: $('#btnDeselectAll'),
  btnImportSelected: $('#btnImportSelected'),
  btnOpenPopup: $('#btnOpenPopup'),
  progressBar: $('#progressBar'),
  progressFill: $('#progressFill'),
  progressText: $('#progressText'),
  importLog: $('#importLog'),
  logEntries: $('#logEntries')
};

// ---------- 初始化 ----------
document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
});

function bindEvents() {
  // 拖拽区域点击（排除 label 和 input 自身，避免 label for 属性触发的二次弹窗）
  els.dropZone.addEventListener('click', (e) => {
    if (e.target.closest('label[for="fileInput"]') || e.target === els.fileInput) return;
    els.fileInput.click();
  });
  
  // 文件选择
  els.fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
  
  // 拖拽事件
  els.dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.dropZone.classList.add('drag-over');
  });
  
  els.dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.dropZone.classList.remove('drag-over');
  });
  
  els.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  });
  
  // 全选/取消全选
  els.btnSelectAll.addEventListener('click', selectAll);
  els.btnDeselectAll.addEventListener('click', deselectAll);
  
  // 导入选中
  els.btnImportSelected.addEventListener('click', importSelected);
  
  // 返回
  els.btnOpenPopup.addEventListener('click', () => {
    window.close();
  });
}

// ---------- 文件处理 ----------
async function handleFiles(fileList) {
  const files = Array.from(fileList);
  const validFiles = files.filter(f => {
    const ext = f.name.toLowerCase().split('.').pop();
    return ext === 'html' || ext === 'htm' || ext === 'json';
  });
  
  if (validFiles.length === 0) {
    showToast('请选择 HTML 或 JSON 格式的书签文件', 'error');
    return;
  }
  
  els.dropZone.classList.add('has-files');
  
  for (const file of validFiles) {
    await parseFile(file);
  }
  
  renderPreview();
}

async function parseFile(file) {
  try {
    const text = await file.text();
    const ext = file.name.toLowerCase().split('.').pop();
    
    let bookmarks = [];
    let folders = new Set();
    
    if (ext === 'json') {
      const result = parseJSONBookmarks(text);
      bookmarks = result.bookmarks;
      folders = result.folders;
    } else {
      const result = parseHTMLBookmarks(text, file.name);
      bookmarks = result.bookmarks;
      folders = result.folders;
    }
    
    if (bookmarks.length === 0) {
      showToast(`文件「${file.name}」未解析到有效书签`, 'warning');
      return;
    }
    
    // 检查重复（基于 URL）：既比对本次解析的文件，也比对已存储的书签
    const duplicateUrls = new Set();

    // 1. 已存储的导入书签
    try {
      const stored = await chrome.storage.local.get(['importedBookmarks']);
      const imported = stored.importedBookmarks || [];
      for (const bm of imported) {
        if (bm.url) duplicateUrls.add(bm.url);
      }
    } catch (e) { /* ignore */ }

    // 2. 本次已解析的文件中的书签
    for (const pf of state.parsedFiles) {
      for (const bm of pf.bookmarks) {
        duplicateUrls.add(bm.url);
      }
    }
    
    for (const bm of bookmarks) {
      bm.duplicate = duplicateUrls.has(bm.url);
    }
    
    state.parsedFiles.push({
      name: file.name,
      bookmarks,
      folders: Array.from(folders),
      raw: text
    });
    
    // 默认全选
    for (const bm of bookmarks) {
      state.selectedMap[bm.id] = !bm.duplicate;
    }
    
    // 默认展开新文件
    state.expandedFiles.add(file.name);
    
    addLog(`✅ 解析「${file.name}」: ${bookmarks.length} 条书签，${folders.size} 个文件夹`, 'success');
    
  } catch (err) {
    console.error('解析文件失败:', err);
    addLog(`❌ 解析「${file.name}」失败: ${err.message}`, 'error');
    showToast(`解析「${file.name}」失败`, 'error');
  }
}

// ================================================================
//  HTML 书签解析器 (Netscape Bookmark File Format)
//  这是所有主流浏览器通用的书签导出格式
// ================================================================
function parseHTMLBookmarks(html, sourceName) {
  const bookmarks = [];
  const folders = new Set();
  const folderStack = [];
  
  // 移除注释
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  
  // 匹配所有 <DT> 开头的行
  // 结构：<DT><H3 ...> 文件夹名</H3>  或  <DT><A HREF="url" ...>标题</A>
  const dtRegex = /<DT>([\s\S]*?)(?=<DT>|<\/DL>|$)/g;
  
  // 追踪 DL 层级
  let depth = 0;
  const lines = html.replace(/\r\n/g, '\n').split('\n');
  
  let currentH3 = null;
  let folderDepth = -1;
  
  // 更好的解析方式：逐行扫描
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // 追踪 <DL> 和 </DL> 的层级
    const openDL = (line.match(/<DL/gi) || []).length;
    const closeDL = (line.match(/<\/DL>/gi) || []).length;
    depth += openDL - closeDL;
    
    // 解析 <H3>
    const h3Match = line.match(/<DT><H3[^>]*>(.*?)<\/H3>/i);
    if (h3Match) {
      const folderName = decodeHtmlEntities(h3Match[1].trim());
      if (folderName && !/^bookmark/i.test(folderName)) {
        // 回退栈中比当前深度大的文件夹
        while (folderStack.length > 0 && folderStack[folderStack.length - 1].depth >= depth) {
          folderStack.pop();
        }
        folderStack.push({ name: folderName, depth });
        folders.add(folderName);
        currentH3 = folderStack.map(f => f.name).join(' / ');
      }
    }
    
    // 解析 <A> 标签
    const aMatch = line.match(/<DT><A\s+([^>]+)>(.*?)<\/A>/i);
    if (aMatch) {
      const attrs = aMatch[1];
      const title = decodeHtmlEntities(aMatch[2].trim());
      
      if (!title || title.length === 0 || title.length > 500) continue;
      
      // 提取 HREF
      const hrefMatch = attrs.match(/HREF="([^"]*)"/i);
      if (!hrefMatch || !hrefMatch[1]) continue;
      
      const url = hrefMatch[1].trim();
      if (!url || url.startsWith('javascript:') || url === 'about:blank') continue;
      
      // 提取 ADD_DATE
      const dateMatch = attrs.match(/ADD_DATE="(\d+)"/i);
      const dateAdded = dateMatch ? parseInt(dateMatch[1]) * 1000 : Date.now();
      
      // 提取 ICON
      const iconMatch = attrs.match(/ICON="([^"]*)"/i);
      const icon = iconMatch ? iconMatch[1] : null;
      
      // 确定文件夹路径
      const folderPath = folderStack.map(f => f.name).join(' / ') || '';
      if (folderPath) folders.add(folderPath);
      
      bookmarks.push({
        id: generateId(),
        title: title || '无标题',
        url: url,
        dateAdded: dateAdded,
        folder: folderPath,
        icon: icon,
        sourceName: sourceName.replace(/\.(html?|json)$/i, ''),
        source: 'imported'
      });
    }
  }
  
  return { bookmarks, folders };
}

// ================================================================
//  JSON 书签解析器
//  支持常见 JSON 书签格式
// ================================================================
function parseJSONBookmarks(jsonStr) {
  let data;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    throw new Error('无效的 JSON 格式');
  }
  
  const bookmarks = [];
  const folders = new Set();
  
  function extractBookmarks(nodes, parentPath = '') {
    if (Array.isArray(nodes)) {
      for (const node of nodes) {
        extractBookmarks(node, parentPath);
      }
    } else if (nodes && typeof nodes === 'object') {
      // 兼容 Chrome bookmark JSON 格式
      if (nodes.url && nodes.type !== 'folder') {
        const path = nodes.parentPath || parentPath || '';
        if (path) folders.add(path);
        bookmarks.push({
          id: generateId(),
          title: nodes.title || nodes.name || '无标题',
          url: nodes.url,
          dateAdded: nodes.dateAdded || nodes.date_added || Date.now(),
          folder: path,
          sourceName: 'JSON导入',
          source: 'imported'
        });
      }
      
      // 递归子节点
      if (nodes.children || nodes.bookmarks || nodes.items) {
        const children = nodes.children || nodes.bookmarks || nodes.items || [];
        const newPath = nodes.title || nodes.name
          ? (parentPath ? `${parentPath} / ${nodes.title || nodes.name}` : (nodes.title || nodes.name))
          : parentPath;
        extractBookmarks(children, newPath);
      }
    }
  }
  
  // 尝试多种根结构
  const roots = data.roots || data.bookmarks || data;
  if (roots.bookmark_bar || roots.other || roots.synced) {
    // Chrome 格式
    for (const [key, value] of Object.entries(roots)) {
      extractBookmarks(value, key);
    }
  } else if (Array.isArray(roots)) {
    extractBookmarks(roots);
  } else if (typeof roots === 'object') {
    extractBookmarks([roots]);
  }
  
  return { bookmarks, folders };
}

// ---------- 渲染预览 ----------
function renderPreview() {
  if (state.parsedFiles.length === 0) {
    els.previewList.innerHTML = `
      <div class="preview-empty">
        <div class="preview-empty-icon">📭</div>
        <p>尚未解析任何书签文件</p>
        <p class="sub">上传或拖拽书签文件到左侧区域开始解析</p>
      </div>`;
    els.previewStats.style.display = 'none';
    els.previewActions.style.display = 'none';
    return;
  }
  
  // 统计
  const totalBookmarks = state.parsedFiles.reduce((s, f) => s + f.bookmarks.length, 0);
  const totalFolders = state.parsedFiles.reduce((s, f) => s + f.folders.length, 0);
  
  els.previewFileCount.textContent = state.parsedFiles.length;
  els.previewBookmarkCount.textContent = totalBookmarks;
  els.previewFolderCount.textContent = totalFolders;
  els.previewStats.style.display = '';
  els.previewActions.style.display = '';
  
  // 渲染列表
  let html = '';
  for (const file of state.parsedFiles) {
    const isExpanded = state.expandedFiles.has(file.name);
    const selectedCount = file.bookmarks.filter(b => state.selectedMap[b.id]).length;
    
    html += `<div class="file-group">
      <div class="file-group-header" data-file="${escapeAttr(file.name)}">
        <span class="file-group-toggle ${isExpanded ? 'expanded' : ''}">▶</span>
        <span class="file-group-icon">📄</span>
        <span class="file-group-name">${escapeHtml(file.name)}</span>
        <span class="file-group-count">${selectedCount}/${file.bookmarks.length} 选中</span>
        <input type="checkbox" class="file-group-checkbox" 
               ${selectedCount === file.bookmarks.length ? 'checked' : ''}
               data-file="${escapeAttr(file.name)}">
      </div>
      <div class="file-group-children ${isExpanded ? 'expanded' : ''}">
        ${renderFileContent(file)}
      </div>
    </div>`;
  }
  
  els.previewList.innerHTML = html;
  bindPreviewEvents();
}

function renderFileContent(file) {
  // 按文件夹分组
  const byFolder = {};
  const noFolder = [];
  
  for (const bm of file.bookmarks) {
    if (bm.folder) {
      if (!byFolder[bm.folder]) byFolder[bm.folder] = [];
      byFolder[bm.folder].push(bm);
    } else {
      noFolder.push(bm);
    }
  }
  
  let html = '';
  
  // 有文件夹的书签
  for (const [folder, bms] of Object.entries(byFolder)) {
    const folderId = `${file.name}::${folder}`;
    const isExpanded = state.expandedFolders.has(folderId);
    const selectedInFolder = bms.filter(b => state.selectedMap[b.id]).length;
    
    html += `<div class="import-folder">
      <div class="import-folder-header" data-folder="${escapeAttr(folderId)}">
        <span class="import-folder-toggle ${isExpanded ? 'expanded' : ''}">▶</span>
        📁 ${escapeHtml(folder)} (${selectedInFolder}/${bms.length})
      </div>
      <div class="import-folder-children ${isExpanded ? 'expanded' : ''}">
        ${renderBookmarkRows(bms)}
      </div>
    </div>`;
  }
  
  // 无文件夹的书签
  if (noFolder.length > 0) {
    html += renderBookmarkRows(noFolder);
  }
  
  return html;
}

function renderBookmarkRows(bookmarks) {
  return bookmarks.map(bm => {
    const isSelected = state.selectedMap[bm.id] !== false;
    return `
      <div class="import-bookmark ${isSelected ? '' : 'unselected'}">
        <input type="checkbox" 
               ${isSelected ? 'checked' : ''} 
               data-id="${bm.id}" 
               class="bm-checkbox">
        <div class="import-bookmark-info">
          <div class="import-bookmark-title">${escapeHtml(bm.title)}</div>
          <div class="import-bookmark-url">${escapeHtml(bm.url)}</div>
        </div>
        ${bm.duplicate ? '<span class="import-bookmark-duplicate">重复</span>' : ''}
      </div>`;
  }).join('');
}

// ---------- 预览事件绑定 ----------
function bindPreviewEvents() {
  // 文件组展开/折叠
  els.previewList.querySelectorAll('.file-group-header').forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.classList.contains('file-group-checkbox')) return;
      const fileName = header.dataset.file;
      if (state.expandedFiles.has(fileName)) {
        state.expandedFiles.delete(fileName);
      } else {
        state.expandedFiles.add(fileName);
      }
      renderPreview();
    });
  });
  
  // 文件组全选 checkbox
  els.previewList.querySelectorAll('.file-group-checkbox').forEach(cb => {
    cb.addEventListener('click', (e) => {
      e.stopPropagation();
      const fileName = cb.dataset.file;
      const file = state.parsedFiles.find(f => f.name === fileName);
      if (!file) return;
      const checked = cb.checked;
      for (const bm of file.bookmarks) {
        state.selectedMap[bm.id] = checked;
      }
      renderPreview();
    });
  });
  
  // 文件夹展开/折叠
  els.previewList.querySelectorAll('.import-folder-header').forEach(header => {
    header.addEventListener('click', () => {
      const folderId = header.dataset.folder;
      if (state.expandedFolders.has(folderId)) {
        state.expandedFolders.delete(folderId);
      } else {
        state.expandedFolders.add(folderId);
      }
      renderPreview();
    });
  });
  
  // 单个书签 checkbox
  els.previewList.querySelectorAll('.bm-checkbox').forEach(cb => {
    cb.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = cb.dataset.id;
      state.selectedMap[id] = cb.checked;
      renderPreview();
    });
  });
  
  // 书签行点击（切换选中）
  els.previewList.querySelectorAll('.import-bookmark').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT') return;
      const cb = row.querySelector('.bm-checkbox');
      if (cb) {
        cb.checked = !cb.checked;
        const id = cb.dataset.id;
        state.selectedMap[id] = cb.checked;
        renderPreview();
      }
    });
  });
  
  // 双击打开 URL
  els.previewList.querySelectorAll('.import-bookmark').forEach(row => {
    row.addEventListener('dblclick', () => {
      const cb = row.querySelector('.bm-checkbox');
      if (cb) {
        const bm = findBookmarkById(cb.dataset.id);
        if (bm) {
          chrome.tabs.create({ url: bm.url });
        }
      }
    });
  });
}

function findBookmarkById(id) {
  for (const file of state.parsedFiles) {
    const bm = file.bookmarks.find(b => b.id === id);
    if (bm) return bm;
  }
  return null;
}

// ---------- 全选/取消全选 ----------
function selectAll() {
  for (const file of state.parsedFiles) {
    for (const bm of file.bookmarks) {
      state.selectedMap[bm.id] = true;
    }
  }
  renderPreview();
}

function deselectAll() {
  for (const file of state.parsedFiles) {
    for (const bm of file.bookmarks) {
      state.selectedMap[bm.id] = false;
    }
  }
  renderPreview();
}

// ---------- 导入选中书签 ----------
async function importSelected() {
  if (state.isImporting) return;
  
  const selectedBookmarks = [];
  for (const file of state.parsedFiles) {
    for (const bm of file.bookmarks) {
      if (state.selectedMap[bm.id] !== false) {
        selectedBookmarks.push(bm);
      }
    }
  }
  
  if (selectedBookmarks.length === 0) {
    showToast('请至少选择一条书签', 'error');
    return;
  }
  
  state.isImporting = true;
  els.btnImportSelected.disabled = true;
  els.btnImportSelected.textContent = '导入中...';
  
  // 显示进度条
  els.progressBar.style.display = '';
  els.importLog.style.display = '';
  
  try {
    // 获取当前已导入的书签
    const result = await chrome.storage.local.get(['importedBookmarks']);
    const existing = result.importedBookmarks || [];
    
    // URL 去重
    const existingUrls = new Set(existing.map(b => b.url));
    const newBookmarks = [];
    const duplicates = [];
    
    for (const bm of selectedBookmarks) {
      if (existingUrls.has(bm.url)) {
        duplicates.push(bm);
      } else {
        newBookmarks.push(bm);
        existingUrls.add(bm.url);
      }
    }
    
    // 更新进度
    updateProgress(30, `正在导入 ${newBookmarks.length} 条新书签...`);
    addLog(`📊 待导入: ${selectedBookmarks.length} 条, 新增: ${newBookmarks.length}, 跳过重复: ${duplicates.length}`, 'info');
    
    // 分批保存（避免大数据卡顿）
    const batchSize = 100;
    const merged = [...existing, ...newBookmarks];
    
    updateProgress(60, '正在保存...');
    await chrome.storage.local.set({ importedBookmarks: merged });
    
    updateProgress(100, '导入完成！');
    addLog(`✅ 成功导入 ${newBookmarks.length} 条书签`, 'success');
    
    if (duplicates.length > 0) {
      addLog(`⚠️ 跳过 ${duplicates.length} 条重复书签`, 'warning');
    }
    
    // 清空已解析的
    setTimeout(() => {
      state.parsedFiles = [];
      state.selectedMap = {};
      renderPreview();
      els.progressBar.style.display = 'none';
      els.dropZone.classList.remove('has-files');
      showToast(`成功导入 ${newBookmarks.length} 条书签！`, 'success');
    }, 1000);
    
  } catch (err) {
    console.error('导入失败:', err);
    addLog(`❌ 导入失败: ${err.message}`, 'error');
    showToast('导入失败，请重试', 'error');
  } finally {
    state.isImporting = false;
    els.btnImportSelected.disabled = false;
    els.btnImportSelected.textContent = '导入选中书签';
  }
}

// ---------- 进度条 ----------
function updateProgress(percent, text) {
  els.progressFill.style.width = `${percent}%`;
  els.progressText.textContent = text;
}

// ---------- 日志 ----------
function addLog(msg, type = '') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  els.logEntries.appendChild(entry);
  els.logEntries.scrollTop = els.logEntries.scrollHeight;
}

// ---------- 工具函数 ----------
function decodeHtmlEntities(str) {
  const txt = document.createElement('textarea');
  txt.innerHTML = str;
  return txt.value;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

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
  }, 2500);
}
