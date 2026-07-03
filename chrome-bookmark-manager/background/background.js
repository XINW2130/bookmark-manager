/* ============================================================
   background.js - 后台服务
   负责：Chrome 书签变更监听、首次初始化、浏览器书签路径扫描、Git 同步
   ============================================================ */

importScripts('../sync/git-sync.js');

// 已知浏览器书签文件路径（用于提示用户）
const BROWSER_BOOKMARK_PATHS = {
  'Chrome': {
    win32: '%LOCALAPPDATA%\\Google\\Chrome\\User Data\\Default\\Bookmarks',
    darwin: '~/Library/Application Support/Google/Chrome/Default/Bookmarks',
    linux: '~/.config/google-chrome/Default/Bookmarks'
  },
  'Microsoft Edge': {
    win32: '%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\Default\\Bookmarks',
    darwin: '~/Library/Application Support/Microsoft Edge/Default/Bookmarks',
    linux: '~/.config/microsoft-edge/Default/Bookmarks'
  },
  'Brave': {
    win32: '%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\User Data\\Default\\Bookmarks',
    darwin: '~/Library/Application Support/BraveSoftware/Brave-Browser/Default/Bookmarks',
    linux: '~/.config/BraveSoftware/Brave-Browser/Default/Bookmarks'
  },
  'Opera': {
    win32: '%APPDATA%\\Opera Software\\Opera Stable\\Bookmarks',
    darwin: '~/Library/Application Support/com.operasoftware.Opera/Bookmarks',
    linux: '~/.config/opera/Bookmarks'
  },
  'Vivaldi': {
    win32: '%LOCALAPPDATA%\\Vivaldi\\User Data\\Default\\Bookmarks',
    darwin: '~/Library/Application Support/Vivaldi/Default/Bookmarks',
    linux: '~/.config/vivaldi/Default/Bookmarks'
  },
  'Firefox': {
    win32: '%APPDATA%\\Mozilla\\Firefox\\Profiles\\',
    darwin: '~/Library/Application Support/Firefox/Profiles/',
    linux: '~/.mozilla/firefox/'
  },
  '360浏览器': {
    win32: '%APPDATA%\\360se6\\User Data\\Default\\Bookmarks',
    darwin: null,
    linux: null
  },
  'QQ浏览器': {
    win32: '%LOCALAPPDATA%\\Tencent\\QQBrowser\\User Data\\Default\\Bookmarks',
    darwin: null,
    linux: null
  }
};

// ---------- 安装/更新时初始化 ----------
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[书签管理器] 插件已安装/更新:', details.reason);
  
  // 初始化存储
  const result = await chrome.storage.local.get(['importedBookmarks', 'settings']);
  
  if (!result.importedBookmarks) {
    await chrome.storage.local.set({ importedBookmarks: [] });
  }
  
  if (!result.settings) {
    await chrome.storage.local.set({
      settings: {
        autoScanOnStart: false,
        scanInterval: 0,
        lastScanTime: null,
        detectedBrowsers: []
      }
    });
  }
  
  // 首次安装时扫描 Chrome 书签统计
  if (details.reason === 'install') {
    const tree = await chrome.bookmarks.getTree();
    const count = countAllBookmarks(tree);
    console.log(`[书签管理器] 检测到 Chrome 中 ${count} 条书签`);
  }
});

// ---------- 监听书签变更 ----------
chrome.bookmarks.onCreated.addListener((id, bookmark) => {
  console.log('[书签管理器] 新增书签:', bookmark.title);
});

chrome.bookmarks.onRemoved.addListener((id, removeInfo) => {
  console.log('[书签管理器] 删除书签:', removeInfo.node.title);
});

chrome.bookmarks.onChanged.addListener((id, changeInfo) => {
  console.log('[书签管理器] 书签变更:', changeInfo);
});

// ---------- 来自 popup 的消息处理 ----------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'getBookmarkStats':
      handleGetBookmarkStats(sendResponse);
      return true; // 异步响应
      
    case 'getBrowserPaths':
      sendResponse({
        paths: BROWSER_BOOKMARK_PATHS,
        platform: getPlatform()
      });
      break;
      
    case 'getChromeBookmarks':
      handleGetChromeBookmarks(sendResponse);
      return true;
      
    case 'autoPull':
      handleAutoPull(message.password, sendResponse);
      return true;
      
    default:
      sendResponse({ error: 'Unknown action' });
  }
});

async function handleGetBookmarkStats(sendResponse) {
  try {
    const tree = await chrome.bookmarks.getTree();
    const total = countAllBookmarks(tree);
    const folders = countAllFolders(tree);
    const result = await chrome.storage.local.get(['importedBookmarks']);
    const imported = result.importedBookmarks || [];
    
    sendResponse({
      chromeTotal: total,
      chromeFolders: folders,
      importedTotal: imported.length,
      grandTotal: total + imported.length
    });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

async function handleGetChromeBookmarks(sendResponse) {
  try {
    const tree = await chrome.bookmarks.getTree();
    const bookmarks = flattenTree(tree);
    sendResponse({ bookmarks, count: bookmarks.length });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

async function handleAutoPull(password, sendResponse) {
  try {
    const result = await GitSync.pullBookmarks(password);
    sendResponse(result);
  } catch (err) {
    sendResponse({ error: err.message, newCount: 0 });
  }
}

// ---------- 工具函数 ----------
function countAllBookmarks(nodes) {
  let count = 0;
  for (const node of nodes) {
    if (node.url) count++;
    if (node.children) count += countAllBookmarks(node.children);
  }
  return count;
}

function countAllFolders(nodes) {
  let count = 0;
  for (const node of nodes) {
    if (node.children && !node.url) {
      if (node.title && node.id !== '0' && node.id !== '1' && node.id !== '2') {
        count++;
      }
      count += countAllFolders(node.children);
    }
  }
  return count;
}

function flattenTree(nodes, parentPath = '', result = []) {
  for (const node of nodes) {
    if (node.url) {
      result.push({
        id: node.id,
        title: node.title,
        url: node.url,
        folder: parentPath,
        dateAdded: node.dateAdded
      });
    }
    if (node.children) {
      const path = parentPath
        ? `${parentPath} / ${node.title}`
        : node.title;
      flattenTree(node.children, path, result);
    }
  }
  return result;
}

function getPlatform() {
  const ua = navigator.userAgent;
  if (ua.includes('Windows')) return 'win32';
  if (ua.includes('Mac')) return 'darwin';
  if (ua.includes('Linux')) return 'linux';
  return 'unknown';
}

console.log('[书签管理器] Background Service Worker 已启动');
