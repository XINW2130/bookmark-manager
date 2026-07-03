/* ============================================================
   git-sync.js - Git 同步核心模块
   功能：
   - AES-GCM 加密/解密（Web Crypto API）
   - PBKDF2 密钥派生
   - 多平台 Git REST API 文件上传/下载（GitHub / GitLab / Gitee / 自定义）
   - 书签数据的序列化与合并
   ============================================================ */

const GitSync = (() => {

  // ========== 平台 API 映射 ==========
  const PLATFORMS = {
    github: {
      name: 'GitHub',
      apiBase: 'https://api.github.com',
      webBase: 'https://github.com',
      contentPath: (owner, repo, file) => `repos/${owner}/${repo}/contents/${file}`,
      repoCheckPath: (owner, repo) => `repos/${owner}/${repo}`,
      authHeader: (token) => ({ 'Authorization': `token ${token}` }),
      accepts: 'application/vnd.github.v3+json',
      // GitHub 额外需要 sha 参数来更新文件
      needsShaForUpdate: true
    },
    gitlab: {
      name: 'GitLab',
      apiBase: 'https://gitlab.com/api/v4',
      webBase: 'https://gitlab.com',
      contentPath: (owner, repo, file) => `projects/${encodeURIComponent(owner + '/' + repo)}/repository/files/${encodeURIComponent(file)}`,
      repoCheckPath: (owner, repo) => `projects/${encodeURIComponent(owner + '/' + repo)}`,
      authHeader: (token) => ({ 'PRIVATE-TOKEN': token }),
      accepts: 'application/json',
      needsShaForUpdate: false
    },
    gitee: {
      name: 'Gitee（码云）',
      apiBase: 'https://gitee.com/api/v5',
      webBase: 'https://gitee.com',
      contentPath: (owner, repo, file) => `repos/${owner}/${repo}/contents/${file}`,
      repoCheckPath: (owner, repo) => `repos/${owner}/${repo}`,
      authHeader: () => ({}),
      authQueryParam: 'access_token',  // Gitee 通过 URL 参数认证
      accepts: 'application/json',
      needsShaForUpdate: true
    },
    custom: {
      name: '自定义',
      apiBase: '',
      webBase: '',
      contentPath: (owner, repo, file) => `repos/${owner}/${repo}/contents/${file}`,
      repoCheckPath: (owner, repo) => `repos/${owner}/${repo}`,
      authHeader: (token) => ({ 'Authorization': `token ${token}` }),
      accepts: 'application/json',
      needsShaForUpdate: true
    }
  };

  // ========== 默认配置 ==========
  const DEFAULT_CONFIG = {
    platform: 'github',   // Git 平台: github | gitlab | gitee | custom
    customApiBase: '',    // 自定义 API 地址
    repoOwner: '',        // 仓库所有者（用户名或组织名）
    repoName: '',         // 仓库名
    filePath: 'bookmarks.enc',  // 仓库中存储的文件路径
    token: '',            // Access Token
    password: '',         // 加密密码（不存储明文，只存哈希盐）
    autoSync: true,       // 是否自动同步
    lastSyncTime: null    // 上次同步时间
  };

  // ========== 配置读写 ==========
  async function getConfig() {
    const result = await chrome.storage.local.get(['gitSyncConfig']);
    return { ...DEFAULT_CONFIG, ...(result.gitSyncConfig || {}) };
  }

  async function saveConfig(config) {
    // 先读取现有配置，在此基础上合并，防止覆盖丢失字段
    const existing = (await chrome.storage.local.get(['gitSyncConfig'])).gitSyncConfig || {};
    const toStore = { ...existing, ...config };
    // 确保 password 不会存到本地（密码单独存取）
    delete toStore.password;
    await chrome.storage.local.set({ gitSyncConfig: toStore });
    console.log('[GitSync] 配置已保存:', { ...toStore, token: toStore.token ? '***' : '' });
  }

  async function updateLastSyncTime() {
    const existing = (await chrome.storage.local.get(['gitSyncConfig'])).gitSyncConfig || {};
    existing.lastSyncTime = Date.now();
    await chrome.storage.local.set({ gitSyncConfig: existing });
  }

  async function getPassword() {
    // 密码需要用户每次会话输入，或安全存储
    const result = await chrome.storage.local.get(['gitSyncPassword']);
    return result.gitSyncPassword || '';
  }

  async function savePassword(password) {
    await chrome.storage.local.set({ gitSyncPassword: password });
  }

  // ========== 密钥派生 (PBKDF2) ==========
  async function deriveKey(password, salt) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: encoder.encode(salt || 'chrome-bookmark-sync-default-salt'),
        iterations: 100000,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  // ========== AES-GCM 加密 ==========
  async function encrypt(plaintext, password) {
    const config = await getConfig();
    let salt = config.salt;
    if (!salt) {
      salt = generateSalt();
      // 持久化新生成的 salt，避免每次加密用不同盐
      await saveConfig({ salt });
      console.log('[GitSync] 生成新 salt 并保存:', salt);
    }

    const key = await deriveKey(password, salt);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoder.encode(plaintext)
    );

    console.log('[GitSync] 加密成功，明文大小:', plaintext.length, 'bytes');

    // 打包: salt + iv + ciphertext，全部 base64 编码
    const packed = {
      salt,
      iv: arrayBufferToBase64(iv),
      data: arrayBufferToBase64(ciphertext),
      version: 1,
      timestamp: Date.now()
    };

    return JSON.stringify(packed);
  }

  // ========== AES-GCM 解密 ==========
  async function decrypt(packedStr, password) {
    const packed = JSON.parse(packedStr);
    const salt = packed.salt;

    const key = await deriveKey(password, salt);
    const iv = base64ToArrayBuffer(packed.iv);
    const ciphertext = base64ToArrayBuffer(packed.data);

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );

    const decoder = new TextDecoder();
    return decoder.decode(plaintext);
  }

  // ========== 获取平台配置 ==========
  function getPlatformConfig(cfg) {
    const platform = PLATFORMS[cfg.platform] || PLATFORMS.github;
    const apiBase = cfg.platform === 'custom' ? (cfg.customApiBase || cfg.apiBase || '') : platform.apiBase;
    return { ...platform, apiBase };
  }

  // ========== Git API 操作（多平台） ==========
  async function gitAPI(endpoint, config, options = {}) {
    const platform = getPlatformConfig(config);

    let url;
    if (endpoint.startsWith('http')) {
      url = endpoint;
    } else {
      url = `${platform.apiBase}/${endpoint}`;
    }

    // Gitee 通过 URL 查询参数认证
    if (platform.authQueryParam && config.token) {
      const sep = url.includes('?') ? '&' : '?';
      url = `${url}${sep}${platform.authQueryParam}=${encodeURIComponent(config.token)}`;
    }

    const authHeaders = platform.authHeader(config.token);
    const headers = {
      ...authHeaders,
      'Content-Type': 'application/json'
    };
    if (platform.accepts) {
      headers['Accept'] = platform.accepts;
    }

    console.log('[GitSync] API 请求:', options.method || 'GET', url);

    const response = await fetch(url, {
      headers,
      ...options
    });

    if (!response.ok) {
      let errorMsg;
      try {
        const errorData = await response.json();
        errorMsg = errorData.message || errorData.error_description || errorData.error || JSON.stringify(errorData);
      } catch {
        const text = await response.text().catch(() => '');
        errorMsg = text || `HTTP ${response.status}`;
      }
      console.error('[GitSync] API 错误响应:', response.status, errorMsg);
      throw new Error(`${platform.name} API 错误(${response.status}): ${errorMsg}`);
    }

    return response.json();
  }

  // ========== 路径辅助：GitHub Pages 需要 docs/ 前缀 ==========
  function getStoragePath(config) {
    // GitHub Pages 只能从根目录或 docs/ 部署，统一用 docs/
    if (config.platform === 'github') {
      return 'docs/' + config.filePath;
    }
    return config.filePath;
  }

  function getViewerPath(config) {
    if (config.platform === 'github') {
      return 'docs/bookmark-viewer.html';
    }
    return 'bookmark-viewer.html';
  }

  // ========== 推送者 HTML 到仓库 ==========
  async function pushViewerHtml(config, commitMsg) {
    const platform = getPlatformConfig(config);
    const viewerPath = getViewerPath(config);
    const viewerEndpoint = platform.contentPath(config.repoOwner, config.repoName, viewerPath);

    // 从插件资源中读取模板 HTML（本地文件始终在根目录）
    let templateHtml;
    try {
      const templateUrl = chrome.runtime.getURL('bookmark-viewer.html');
      const resp = await fetch(templateUrl);
      if (!resp.ok) throw new Error(`读取模板失败 HTTP ${resp.status}`);
      templateHtml = await resp.text();
    } catch (e) {
      console.warn('[GitSync] 无法读取 bookmark-viewer.html 模板，跳过推送:', e.message);
      return;
    }

    // 替换占位符为实际的文件路径（GitHub Pages 下 viewer 和加密文件同目录，只需文件名）
    const fetchPath = config.platform === 'github'
      ? config.filePath.replace(/^.*[\\/]/, '')  // 只取文件名
      : config.filePath;
    const finalHtml = templateHtml.replace(/__ENCRYPTED_FILE__/g, fetchPath);
    console.log('[GitSync] 已注入文件路径:', fetchPath, '到', viewerPath);

    // 检查远程 viewer HTML 是否已存在
    let viewerSha = null;
    if (platform.needsShaForUpdate) {
      try {
        const existing = await gitAPI(viewerEndpoint, config);
        viewerSha = existing.sha;
        console.log('[GitSync] 远程 bookmark-viewer.html 已存在, sha:', viewerSha);
      } catch (e) {
        console.log('[GitSync] 远程 bookmark-viewer.html 不存在，将新建');
      }
    }

    const viewerBody = {
      message: commitMsg,
      content: stringToBase64(finalHtml)
    };
    if (viewerSha) viewerBody.sha = viewerSha;

    const isGiteeNew = (config.platform === 'gitee' || config.platform === 'custom') && !viewerSha;
    const method = isGiteeNew ? 'POST' : 'PUT';

    console.log('[GitSync] 推送 bookmark-viewer.html...', { method, hasSha: !!viewerSha });

    await gitAPI(viewerEndpoint, config, {
      method,
      body: JSON.stringify(viewerBody)
    });

    console.log('[GitSync] bookmark-viewer.html 推送成功!');
  }

  // ========== 推送：加密并上传书签到 Git ==========
  async function pushBookmarks(password) {
    console.log('[GitSync] 开始推送书签...');
    const config = await getConfig();

    if (!config.repoOwner || !config.repoName || !config.token) {
      throw new Error('请先在设置中配置 Git 仓库信息');
    }
    if (!password) throw new Error('请输入加密密码');

    // 收集所有书签
    const chromeTree = await chrome.bookmarks.getTree();
    const chromeBookmarks = flattenAll(chromeTree);
    const result = await chrome.storage.local.get(['importedBookmarks']);
    const importedBookmarks = result.importedBookmarks || [];

    console.log('[GitSync] Chrome 书签:', chromeBookmarks.length, '条, 导入书签:', importedBookmarks.length, '条');

    const data = {
      chrome: chromeBookmarks,
      imported: importedBookmarks,
      exportedAt: new Date().toISOString(),
      pluginVersion: '1.0.0'
    };

    const jsonStr = JSON.stringify(data, null, 2);
    console.log('[GitSync] 书签 JSON 大小:', jsonStr.length, 'bytes');

    const encrypted = await encrypt(jsonStr, password);
    console.log('[GitSync] 加密后大小:', encrypted.length, 'bytes');

    // 检查远程文件是否已存在（需要获取 SHA）
    const platform = getPlatformConfig(config);
    const storagePath = getStoragePath(config);
    const contentEndpoint = platform.contentPath(config.repoOwner, config.repoName, storagePath);

    let sha = null;
    if (platform.needsShaForUpdate) {
      try {
        const existing = await gitAPI(contentEndpoint, config);
        sha = existing.sha;
        console.log('[GitSync] 远程文件已存在, sha:', sha);
      } catch (e) {
        console.log('[GitSync] 远程文件不存在，将新建');
      }
    }

    // 构建 base64 内容（GitHub/Gitee 的 content API 需要 base64）
    const base64Content = stringToBase64(encrypted);

    // 上传文件 - 不同平台需要不同参数
    const body = {
      message: `📑 同步书签 - ${new Date().toLocaleString('zh-CN')}`,
      content: base64Content
    };
    if (sha) body.sha = sha;

    // Gitee 新建文件用 POST，更新用 PUT；GitHub 统一用 PUT
    const isGiteeNew = (config.platform === 'gitee' || config.platform === 'custom') && !sha;
    const method = isGiteeNew ? 'POST' : 'PUT';

    console.log('[GitSync] 发起推送请求...', {
      endpoint: contentEndpoint,
      platform: config.platform,
      method,
      hasSha: !!sha,
      bodySize: JSON.stringify(body).length
    });

    const response = await gitAPI(contentEndpoint, config, {
      method,
      body: JSON.stringify(body)
    });

    console.log('[GitSync] 推送成功!', response);

    // 同步推送 bookmark-viewer.html（使用同一个 commit message）
    try {
      await pushViewerHtml(config, body.message);
    } catch (e) {
      console.warn('[GitSync] bookmark-viewer.html 推送失败（书签已成功）:', e.message);
    }

    // 仅更新最后同步时间
    await updateLastSyncTime();

    return {
      success: true,
      bookmarksCount: chromeBookmarks.length + importedBookmarks.length,
      commitUrl: response.content?.html_url || ''
    };
  }

  // ========== 拉取：从 Git 下载并解密书签 ==========
  async function pullBookmarks(password) {
    console.log('[GitSync] 开始拉取书签...');
    const config = await getConfig();

    if (!config.repoOwner || !config.repoName || !config.token) {
      throw new Error('请先在设置中配置 Git 仓库信息');
    }
    if (!password) throw new Error('请输入加密密码');

    // 下载文件
    const platform = getPlatformConfig(config);
    const storagePath = getStoragePath(config);
    const contentEndpoint = platform.contentPath(config.repoOwner, config.repoName, storagePath);
    console.log('[GitSync] 拉取端点:', contentEndpoint);

    let fileData;
    try {
      fileData = await gitAPI(contentEndpoint, config);
    } catch (e) {
      console.error('[GitSync] 拉取请求失败:', e);
      throw new Error(`拉取失败: ${e.message}\n请确认仓库中已存在书签文件`);
    }

    console.log('[GitSync] 获取到远程文件, 大小:', JSON.stringify(fileData).length, 'bytes');

    // 解码 Base64 内容（去除可能的换行符）
    const rawContent = (fileData.content || '').replace(/\s/g, '');
    const encrypted = base64ToString(rawContent);
    console.log('[GitSync] 解码后密文大小:', encrypted.length, 'bytes');

    let data;
    try {
      const decrypted = await decrypt(encrypted, password);
      console.log('[GitSync] 解密成功');
      data = JSON.parse(decrypted);
      console.log('[GitSync] 远程书签: Chrome', (data.chrome || []).length, '条, 导入', (data.imported || []).length, '条');
    } catch (e) {
      console.error('[GitSync] 解密失败:', e);
      throw new Error('解密失败，密码可能不正确');
    }

    // 合并导入的书签
    const result = await chrome.storage.local.get(['importedBookmarks']);
    const existingImported = result.importedBookmarks || [];
    const existingUrls = new Set(existingImported.map(b => b.url));

    const newImported = (data.imported || []).filter(b => !existingUrls.has(b.url));
    const merged = [...existingImported, ...newImported];

    await chrome.storage.local.set({ importedBookmarks: merged });

    // 仅更新最后同步时间
    await updateLastSyncTime();

    return {
      success: true,
      chromeCount: (data.chrome || []).length,
      importedCount: merged.length,
      newCount: newImported.length,
      remoteTime: data.exportedAt
    };
  }

  // ========== 测试连接 ==========
  async function testConnection(owner, repo, token, platformId, customApiBase) {
    const config = { ...DEFAULT_CONFIG, repoOwner: owner, repoName: repo, token, platform: platformId, customApiBase };
    const platform = getPlatformConfig(config);

    console.log('[GitSync] 测试连接:', { platform: platformId, owner, repo });

    try {
      const endpoint = platform.repoCheckPath(owner, repo);
      let url = `${platform.apiBase}/${endpoint}`;

      // Gitee 通过 URL 查询参数认证
      if (platform.authQueryParam && token) {
        url = `${url}?${platform.authQueryParam}=${encodeURIComponent(token)}`;
      }

      const authHeaders = platform.authHeader(token);
      const response = await fetch(url, {
        headers: {
          ...authHeaders,
          'Accept': platform.accepts || 'application/json'
        }
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        console.error('[GitSync] 连接测试失败, HTTP', response.status, err);
        return { success: false, message: err.message || err.error || '仓库访问失败' };
      }

      const data = await response.json();
      console.log('[GitSync] 连接测试成功:', data.full_name || data.path_with_namespace || data.name);
      return {
        success: true,
        message: `✅ 连接成功: ${data.full_name || data.path_with_namespace || data.name}`,
        repoInfo: {
          name: data.full_name || data.path_with_namespace || data.name,
          description: data.description,
          private: data.private || (data.visibility === 'private')
        }
      };
    } catch (e) {
      console.error('[GitSync] 连接测试异常:', e);
      return { success: false, message: `连接失败: ${e.message}` };
    }
  }

  // ========== 获取同步状态 ==========
  async function getSyncStatus() {
    const config = await getConfig();
    const hasConfig = !!(config.repoOwner && config.repoName && config.token);
    const hasPassword = !!(await getPassword());

    return {
      configured: hasConfig,
      hasPassword,
      repo: hasConfig ? `${config.repoOwner}/${config.repoName}` : '',
      filePath: config.filePath,
      lastSync: config.lastSyncTime,
      autoSync: config.autoSync
    };
  }

  // ========== 辅助函数 ==========
  function flattenAll(nodes, result = []) {
    for (const node of nodes) {
      if (node.url) {
        result.push({
          title: node.title,
          url: node.url,
          dateAdded: node.dateAdded
        });
      }
      if (node.children) flattenAll(node.children, result);
    }
    return result;
  }

  function generateSalt() {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  function stringToBase64(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  function base64ToString(base64) {
    return decodeURIComponent(escape(atob(base64)));
  }

  // ========== 公开 API ==========
  return {
    getConfig,
    saveConfig,
    getPassword,
    savePassword,
    pushBookmarks,
    pullBookmarks,
    testConnection,
    getSyncStatus,
    updateLastSyncTime
  };
})();
