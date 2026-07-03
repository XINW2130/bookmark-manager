/* ============================================================
   sync-settings.js - Git 同步设置页面逻辑
   ============================================================ */

const $ = (sel) => document.querySelector(sel);

const els = {
  platform: $('#platform'),
  token: $('#token'),
  repoUrl: $('#repoUrl'),
  filePath: $('#filePath'),
  password: $('#password'),
  passwordConfirm: $('#passwordConfirm'),
  autoSync: $('#autoSync'),
  autoPush: $('#autoPush'),
  btnTest: $('#btnTest'),
  btnSave: $('#btnSave'),
  btnPull: $('#btnPull'),
  btnPush: $('#btnPush'),
  syncPasswordDialog: $('#syncPasswordDialog'),
  syncPasswordInput: $('#syncPasswordInput'),
  dialogTitle: $('#dialogTitle'),
  dialogDesc: $('#dialogDesc'),
  btnCancelSync: $('#btnCancelSync'),
  btnConfirmSync: $('#btnConfirmSync'),
  syncHint: $('#syncHint'),
  statusRepo: $('#statusRepo'),
  statusConnection: $('#statusConnection'),
  statusLastSync: $('#statusLastSync'),
  statusChromeCount: $('#statusChromeCount'),
  statusImportedCount: $('#statusImportedCount'),
  syncLog: $('#syncLog'),
  logContent: $('#logContent'),
  tokenHelp: $('#tokenHelp'),
  pagesUrlGroup: $('#pagesUrlGroup'),
  pagesUrl: $('#pagesUrl'),
  btnCopyPagesUrl: $('#btnCopyPagesUrl')
};

let syncState = {
  hasConfig: false,
  hasPassword: false
};
let pendingSyncAction = null; // 'pull' | 'push'

// ========== 初始化 ==========
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await loadStatus();
  bindEvents();
});

async function loadSettings() {
  const config = await GitSync.getConfig();
  const password = await GitSync.getPassword();

  // 平台
  els.platform.value = config.platform || 'github';

  if (config.repoOwner && config.repoName) {
    els.repoUrl.value = `${config.repoOwner}/${config.repoName}`;
  }
  els.filePath.value = config.filePath || 'bookmarks.enc';
  els.autoSync.checked = config.autoSync !== false;
  els.autoPush.checked = config.autoPush === true;

  if (config.token) {
    els.token.value = config.token;
  }
  if (password) {
    els.password.value = password;
    els.passwordConfirm.value = password;
  }

  // 初始化 Pages 地址显示
  updatePagesUrl();
}

async function loadStatus() {
  const status = await GitSync.getSyncStatus();

  syncState.hasConfig = status.configured;
  syncState.hasPassword = status.hasPassword;

  if (status.configured) {
    els.statusRepo.textContent = status.repo;
  } else {
    els.statusRepo.textContent = '未配置';
  }

  // Chrome 书签统计
  try {
    const tree = await chrome.bookmarks.getTree();
    let count = 0;
    function countBM(nodes) {
      for (const n of nodes) {
        if (n.url) count++;
        if (n.children) countBM(n.children);
      }
    }
    countBM(tree);
    els.statusChromeCount.textContent = `${count} 条`;
  } catch {
    els.statusChromeCount.textContent = '-';
  }

  // 导入书签
  try {
    const result = await chrome.storage.local.get(['importedBookmarks']);
    const imported = result.importedBookmarks || [];
    els.statusImportedCount.textContent = `${imported.length} 条`;
  } catch {
    els.statusImportedCount.textContent = '-';
  }

  // 上次同步
  if (status.lastSync) {
    els.statusLastSync.textContent = new Date(status.lastSync).toLocaleString('zh-CN');
  }

  // 按钮状态
  const ready = status.configured && status.hasPassword;
  els.btnPull.disabled = !ready;
  els.btnPush.disabled = !ready;
  els.syncHint.textContent = ready
    ? '点击按钮后需要输入密码确认操作'
    : '请先保存配置和密码后，再点击同步按钮';
}

// ========== 事件绑定 ==========
function bindEvents() {
  // 平台切换
  els.platform.addEventListener('change', () => {
    updateTokenHelp();
  });

  // 切换密码可见性
  document.querySelectorAll('.toggle-pwd').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      if (input) {
        input.type = input.type === 'password' ? 'text' : 'password';
        btn.textContent = input.type === 'password' ? '👁' : '🙈';
      }
    });
  });

  // 测试连接
  els.btnTest.addEventListener('click', async () => {
    const { owner, repo } = parseRepoUrl();
    const token = els.token.value.trim();
    const platformId = els.platform.value;

    if (!owner || !repo) {
      showToast('请输入有效的仓库地址', 'error');
      return;
    }
    if (!token) {
      showToast('请输入 Access Token', 'error');
      return;
    }

    els.btnTest.disabled = true;
    els.btnTest.textContent = '测试中...';
    els.statusConnection.textContent = '测试中...';

    try {
      const result = await GitSync.testConnection(owner, repo, token, platformId);
      if (result.success) {
        els.statusConnection.textContent = '✅ 已连接';
        els.statusConnection.className = 'status-value success';
        addLog(`连接成功: ${result.repoInfo.name}`, 'success');
        showToast(result.message, 'success');
      } else {
        els.statusConnection.textContent = '❌ 连接失败';
        els.statusConnection.className = 'status-value error';
        addLog(`连接失败: ${result.message}`, 'error');
        showToast(result.message, 'error');
      }
    } catch (err) {
      els.statusConnection.textContent = '❌ 连接失败';
      els.statusConnection.className = 'status-value error';
      addLog(`错误: ${err.message}`, 'error');
      showToast(`连接失败: ${err.message}`, 'error');
    } finally {
      els.btnTest.disabled = false;
      els.btnTest.textContent = '🔍 测试连接';
    }
  });

  // 保存设置
  els.btnSave.addEventListener('click', async () => {
    const { owner, repo } = parseRepoUrl();
    const token = els.token.value.trim();
    const filePath = els.filePath.value.trim() || 'bookmarks.enc';
    const password = els.password.value;
    const passwordConfirm = els.passwordConfirm.value;
    const platformId = els.platform.value;

    // 验证
    if (!owner || !repo) {
      showToast('请输入有效的仓库地址（格式：用户名/仓库名）', 'error');
      return;
    }
    if (!token) {
      showToast('请输入 Access Token', 'error');
      return;
    }
    if (!password) {
      showToast('请设置加密密码', 'error');
      return;
    }
    if (password !== passwordConfirm) {
      showToast('两次密码输入不一致', 'error');
      return;
    }
    if (password.length < 6) {
      showToast('密码至少需要 6 位', 'error');
      return;
    }

    els.btnSave.disabled = true;
    els.btnSave.textContent = '保存中...';

    try {
      // 先测试连接
      const testResult = await GitSync.testConnection(owner, repo, token, platformId);
      if (!testResult.success) {
        showToast('仓库访问失败，请检查 Token 和仓库地址', 'error');
        els.btnSave.disabled = false;
        els.btnSave.textContent = '💾 保存设置';
        return;
      }

      // 保存配置
      const config = {
        platform: platformId,
        repoOwner: owner,
        repoName: repo,
        token,
        filePath,
        autoSync: els.autoSync.checked,
        autoPush: els.autoPush.checked
      };

      await GitSync.saveConfig(config);
      await GitSync.savePassword(password);

      els.statusConnection.textContent = '✅ 已连接';
      els.statusConnection.className = 'status-value success';
      els.statusRepo.textContent = `${owner}/${repo}`;

      await loadStatus();
      showToast('设置已保存！✅', 'success');
      addLog('配置保存成功', 'success');
    } catch (err) {
      showToast(`保存失败: ${err.message}`, 'error');
      addLog(`保存失败: ${err.message}`, 'error');
    } finally {
      els.btnSave.disabled = false;
      els.btnSave.textContent = '💾 保存设置';
    }
  });

  // 拉取 - 弹出密码确认窗
  els.btnPull.addEventListener('click', () => {
    if (els.btnPull.disabled) {
      showToast('请先保存配置和密码', 'error');
      return;
    }
    pendingSyncAction = 'pull';
    els.dialogTitle.textContent = '⬇ 拉取书签';
    els.dialogDesc.textContent = '将从远端仓库下载并解密书签数据';
    els.syncPasswordInput.value = '';
    els.syncPasswordDialog.style.display = 'flex';
    els.syncPasswordInput.focus();
  });

  // 推送 - 弹出密码确认窗
  els.btnPush.addEventListener('click', () => {
    if (els.btnPush.disabled) {
      showToast('请先保存配置和密码', 'error');
      return;
    }
    pendingSyncAction = 'push';
    els.dialogTitle.textContent = '⬆ 推送书签';
    els.dialogDesc.textContent = '将加密当前所有书签并上传到远端仓库';
    els.syncPasswordInput.value = '';
    els.syncPasswordDialog.style.display = 'flex';
    els.syncPasswordInput.focus();
  });

  // 取消弹窗
  els.btnCancelSync.addEventListener('click', closeSyncDialog);

  // 点击遮罩层取消
  els.syncPasswordDialog.querySelector('.dialog-mask').addEventListener('click', closeSyncDialog);

  // 确认按钮
  els.btnConfirmSync.addEventListener('click', async () => {
    const pwd = els.syncPasswordInput.value.trim();
    if (!pwd) {
      showToast('请输入密码', 'error');
      els.syncPasswordInput.focus();
      return;
    }
    // 先保存 action，closeSyncDialog 会清空 pendingSyncAction
    const action = pendingSyncAction;
    closeSyncDialog();
    if (action === 'pull') await doPull(pwd);
    else if (action === 'push') await doPush(pwd);
  });

  // 密码输入框按 Enter 确认
  els.syncPasswordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      els.btnConfirmSync.click();
    }
  });

  // 自动同步复选框联动
  els.autoSync.addEventListener('change', async () => {
    const config = await GitSync.getConfig();
    config.autoSync = els.autoSync.checked;
    await GitSync.saveConfig(config);
  });

  els.autoPush.addEventListener('change', async () => {
    const config = await GitSync.getConfig();
    config.autoPush = els.autoPush.checked;
    await GitSync.saveConfig(config);
  });

  // 仓库地址输入 → 自动生成 Pages 访问地址
  els.repoUrl.addEventListener('input', updatePagesUrl);

  // 复制 Pages 地址
  els.btnCopyPagesUrl.addEventListener('click', async () => {
    const url = els.pagesUrl.value;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      els.btnCopyPagesUrl.textContent = '✅';
      setTimeout(() => { els.btnCopyPagesUrl.textContent = '📋'; }, 1500);
    } catch {
      els.pagesUrl.select();
      document.execCommand('copy');
      els.btnCopyPagesUrl.textContent = '✅';
      setTimeout(() => { els.btnCopyPagesUrl.textContent = '📋'; }, 1500);
    }
  });
}

// ========== 同步操作 ==========
async function doPush(password) {
  els.btnPush.disabled = true;
  els.btnPush.textContent = '⏳ 加密上传中...';
  addLog('开始推送书签...', 'info');
  console.log('[SyncSettings] 开始推送...');

  try {
    const result = await GitSync.pushBookmarks(password);
    console.log('[SyncSettings] 推送结果:', result);
    await loadStatus();
    showToast(`推送成功！共 ${result.bookmarksCount} 条书签`, 'success');
    addLog(`✅ 推送成功: ${result.bookmarksCount} 条书签`, 'success');
    if (result.commitUrl) {
      addLog(`📎 提交: ${result.commitUrl}`, 'info');
    }
  } catch (err) {
    console.error('[SyncSettings] 推送失败:', err);
    showToast(`推送失败: ${err.message}`, 'error');
    addLog(`❌ 推送失败: ${err.message}`, 'error');
  } finally {
    els.btnPush.disabled = false;
    els.btnPush.textContent = '⬆ 推送（加密上传）';
  }
}

async function doPull(password) {
  els.btnPull.disabled = true;
  els.btnPull.textContent = '⏳ 下载解密中...';
  addLog('开始拉取书签...', 'info');
  console.log('[SyncSettings] 开始拉取...');

  try {
    const result = await GitSync.pullBookmarks(password);
    console.log('[SyncSettings] 拉取结果:', result);
    await loadStatus();
    showToast(`拉取成功！新增 ${result.newCount} 条书签`, 'success');
    addLog(`✅ 拉取成功: 远程 ${result.importedCount} 条，新增 ${result.newCount} 条`, 'success');
    addLog(`远程书签时间: ${result.remoteTime}`, 'info');
  } catch (err) {
    console.error('[SyncSettings] 拉取失败:', err);
    showToast(`拉取失败: ${err.message}`, 'error');
    addLog(`❌ 拉取失败: ${err.message}`, 'error');
  } finally {
    els.btnPull.disabled = false;
    els.btnPull.textContent = '⬇ 拉取（下载解密）';
  }
}

// ========== 工具函数 ==========
function closeSyncDialog() {
  els.syncPasswordDialog.style.display = 'none';
  els.syncPasswordInput.value = '';
  pendingSyncAction = null;
}

function updateTokenHelp() {
  const tips = {
    github: '需要仓库读写权限。在 GitHub: Settings → Developer settings → Tokens (classic) 中创建，勾选 repo 权限',
    gitee: '需要仓库权限。在 Gitee: 设置 → 私人令牌 中创建',
  };
  els.tokenHelp.textContent = tips[els.platform.value] || '';
}

function parseRepoUrl() {
  const value = els.repoUrl.value.trim();
  let owner = '', repo = '';

  // 支持完整 URL: https://github.com/owner/repo, https://gitlab.com/owner/repo, https://gitee.com/owner/repo
  const urlMatch = value.match(/(?:github|gitlab|gitee)\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?$/);
  if (urlMatch) {
    owner = urlMatch[1];
    repo = urlMatch[2];
  } else {
    // 也支持自定义域名 URL: https://git.example.com/owner/repo
    const customMatch = value.match(/https?:\/\/[^\/]+\/([^\/]+)\/([^\/]+?)(?:\.git)?$/);
    if (customMatch) {
      owner = customMatch[1];
      repo = customMatch[2];
    } else {
      const parts = value.split('/');
      if (parts.length === 2) {
        owner = parts[0].trim();
        repo = parts[1].trim().replace(/\.git$/, '');
      }
    }
  }

  return { owner, repo };
}

function addLog(message, type = 'info') {
  els.syncLog.style.display = '';
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  const time = new Date().toLocaleTimeString('zh-CN');
  entry.textContent = `[${time}] ${message}`;
  els.logContent.appendChild(entry);
  els.logContent.scrollTop = els.logContent.scrollHeight;
}

function updatePagesUrl() {
  const { owner, repo } = parseRepoUrl();
  if (owner && repo) {
    const pagesUrl = `https://${owner.toLowerCase()}.github.io/${repo}/bookmark-viewer.html`;
    els.pagesUrl.value = pagesUrl;
    els.pagesUrlGroup.style.display = '';
  } else {
    els.pagesUrl.value = '';
    els.pagesUrlGroup.style.display = 'none';
  }
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
  }, 3000);
}
