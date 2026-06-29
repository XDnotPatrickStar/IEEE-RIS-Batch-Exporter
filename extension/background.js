/**
 * IEEE RIS Batch Exporter — Background Service Worker
 *
 * 职责：消息中枢 + 进度持久化 + 文件下载
 */

'use strict';

const TaskState = {
  IDLE: 'idle',
  COLLECTING: 'collecting',
  DOWNLOADING: 'downloading',
  MERGING: 'merging',
  COMPLETE: 'complete',
  ERROR: 'error',
  CANCELLED: 'cancelled'
};

function createInitialState() {
  return {
    status: TaskState.IDLE,
    progress: { phase: 'idle', collected: 0, total: 0, downloaded: 0, page: 0, totalPages: 0, batch: 0, totalBatches: 0 },
    articleNumbers: [],
    queryText: '',
    error: null,
    startTime: null,
    lastDownloadId: null,
    lastFilename: null
  };
}

let taskState = createInitialState();

// ================================================================
// Storage 持久化
// ================================================================

function persistState() {
  const snapshot = JSON.parse(JSON.stringify(taskState));
  chrome.storage.local.set({ taskState: snapshot }).catch(() => {});
}

function clearPersistedState() {
  chrome.storage.local.remove('taskState').catch(() => {});
}

// ================================================================
// Popup Port 管理
// ================================================================

const connectedPorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;

  connectedPorts.add(port);
  console.log('[BG] Popup 已连接 (' + connectedPorts.size + ' 个活跃)');

  // 立即发送当前状态
  port.postMessage({ action: 'stateUpdate', state: taskState });

  port.onDisconnect.addListener(() => {
    connectedPorts.delete(port);
    console.log('[BG] Popup 已断开');
  });

  port.onMessage.addListener(async (msg) => {
    try {
      switch (msg.action) {
        case 'startExport':
          await handleStartExport(msg.options);
          break;
        case 'cancelExport':
          await handleCancelExport();
          break;
        case 'openFolder':
          await handleOpenFolder();
          break;
        case 'getState':
          port.postMessage({ action: 'stateUpdate', state: taskState });
          break;
      }
    } catch (err) {
      console.error('[BG] Port 消息错误:', err);
      setError(err.message);
    }
  });
});

function broadcastState() {
  const payload = { action: 'stateUpdate', state: taskState };
  for (const port of connectedPorts) {
    try { port.postMessage(payload); } catch (e) { /* ignore */ }
  }
}

function updateState(partial) {
  Object.assign(taskState, partial);
  persistState();
  broadcastState();
}

function setError(message) {
  taskState.status = TaskState.ERROR;
  taskState.error = message;
  persistState();
  broadcastState();
}

// ================================================================
// 来自 content script 的消息
// ================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.action) {

        case 'contentScriptLoaded':
          taskState.status = TaskState.IDLE;
          taskState.error = null;
          persistState();
          broadcastState();
          break;

        case 'collectionProgress':
          taskState.status = TaskState.COLLECTING;
          taskState.progress = {
            ...taskState.progress,
            phase: message.phase || 'collecting',
            collected: message.collected,
            total: message.total,
            page: message.page,
            totalPages: message.totalPages
          };
          persistState();
          broadcastState();
          break;

        case 'collectionComplete':
          taskState.articleNumbers = message.articleNumbers;
          taskState.queryText = message.queryText;
          taskState.progress.total = message.totalRecords;
          taskState.progress.collected = message.totalRecords;
          persistState();
          broadcastState();
          break;

        case 'collectionError':
          setError(message.error);
          break;

        case 'collectionCancelled':
          taskState.status = TaskState.CANCELLED;
          persistState();
          broadcastState();
          break;

        case 'downloadProgress':
          taskState.status = message.phase === 'merging' ? TaskState.MERGING : TaskState.DOWNLOADING;
          taskState.progress = {
            ...taskState.progress,
            phase: message.phase || 'downloading',
            downloaded: message.downloaded,
            total: message.total,
            batch: message.batch || 0,
            totalBatches: message.totalBatches || 0
          };
          persistState();
          broadcastState();
          break;

        case 'downloadComplete':
          taskState.status = TaskState.COMPLETE;
          taskState.progress.phase = 'complete';
          taskState.progress.downloaded = taskState.progress.total;
          persistState();
          broadcastState();
          break;

        case 'downloadError':
          setError(message.error);
          break;

        // ---- 保存 RIS 文件（content script 等待响应） ----
        case 'saveRISFile':
          try {
            const result = await handleSaveRISFile(message.risText, message.meta);
            sendResponse(result);
          } catch (err) {
            sendResponse({ success: false, error: err.message });
          }
          break;

        default:
          console.log('[BG] 未知消息:', message.action);
      }
    } catch (err) {
      console.error('[BG] 消息处理错误:', err);
      setError(err.message);
    }
  })();

  return true; // 异步响应
});

// ================================================================
// 导出任务控制
// ================================================================

async function handleStartExport(options = {}) {
  // 重置
  taskState = createInitialState();
  taskState.startTime = Date.now();
  persistState();
  broadcastState();

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0) throw new Error('找不到活动标签页');

    const tab = tabs[0];

    const searchInfo = await chrome.tabs.sendMessage(tab.id, { action: 'getSearchInfo' });
    if (!searchInfo || !searchInfo.queryText) {
      throw new Error('当前页面不是 IEEE 搜索结果页，或无法提取搜索查询。');
    }

    taskState.queryText = searchInfo.queryText;

    // ★ 将 saveAs 传给 content script
    const finalOptions = {
      queryText: searchInfo.queryText,
      queryParams: searchInfo.queryParams,
      rowsPerPage: options.rowsPerPage || 100,
      batchSize: options.batchSize || 50,
      delayMs: options.delayMs || 500,
      risFormat: options.risFormat || 'download-ris',
      citationsFormat: options.citationsFormat || 'citation-and-abstract',
      saveAs: options.saveAs !== undefined ? options.saveAs : true  // ★
    };

    await chrome.tabs.sendMessage(tab.id, {
      action: 'startCollection',
      options: finalOptions
    });

    console.log('[BG] 导出已启动:', finalOptions.queryText.slice(0, 60));

  } catch (err) {
    setError('启动失败: ' + (err.message || String(err)));
  }
}

async function handleCancelExport() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0) {
      await chrome.tabs.sendMessage(tabs[0].id, { action: 'cancelExport' });
    }
  } catch (err) {
    console.warn('[BG] 取消失败:', err.message);
  }

  taskState.status = TaskState.CANCELLED;
  persistState();
  broadcastState();
}

async function handleOpenFolder() {
  let downloadId = taskState.lastDownloadId;

  if (downloadId == null) {
    try {
      const downloads = await chrome.downloads.search({
        limit: 1,
        orderBy: ['-startTime'],
        filenameRegex: 'IEEE_.*\\.ris$'
      });
      if (downloads.length > 0) downloadId = downloads[0].id;
    } catch (err) {
      console.warn('[BG] 搜索下载记录失败:', err.message);
    }
  }

  if (downloadId != null) {
    try {
      await chrome.downloads.show(downloadId);
    } catch (err) {
      console.warn('[BG] chrome.downloads.show 失败:', err.message);
    }
  } else {
    console.warn('[BG] 没有可显示的下载记录');
  }
}

// ================================================================
// RIS 文件保存
// ================================================================

async function handleSaveRISFile(risText, meta = {}) {
  if (!risText || !risText.trim()) {
    return { success: false, error: 'RIS 内容为空，无法保存' };
  }

  const saveAs = meta.saveAs !== undefined ? meta.saveAs : true;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const querySnippet = (meta.queryText || taskState.queryText || 'export')
    .replace(/[^a-zA-Z0-9一-鿿\s-]/g, '')
    .slice(0, 50).trim().replace(/\s+/g, '_');
  const filename = `IEEE_${querySnippet}_${timestamp}.ris`;

  // ★ Manifest V3 Service Worker 没有 URL.createObjectURL
  // 使用 data: URL（base64 编码，安全且无长度限制问题）
  const dataUrl = buildDataUrl(risText);

  try {
    const downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      saveAs: saveAs,
      conflictAction: 'uniquify'
    });

    console.log('[BG] RIS 已保存:', filename, 'downloadId:', downloadId);

    taskState.lastDownloadId = downloadId;
    taskState.lastFilename = filename;
    persistState();
    broadcastState();

    taskState.articleNumbers = [];
    persistState();

    return { success: true, downloadId, filename };

  } catch (err) {
    console.error('[BG] 文件保存失败:', err);
    return { success: false, error: '下载失败: ' + err.message };
  }
}

/**
 * 构建 data: URL（Service Worker 兼容）
 */
function buildDataUrl(text) {
  // 使用 base64 编码避免 encodeURIComponent 对超长字符串出问题
  try {
    const bytes = new TextEncoder().encode(text);
    const binary = Array.from(bytes, b => String.fromCharCode(b)).join('');
    const base64 = btoa(binary);
    return 'data:application/x-research-info-systems;charset=utf-8;base64,' + base64;
  } catch (err) {
    // 备用：直接 URI 编码
    console.warn('[BG] base64 编码失败，使用 URI 编码:', err.message);
    return 'data:application/x-research-info-systems;charset=utf-8,' + encodeURIComponent(text);
  }
}

// ================================================================
// 启动与清理
// ================================================================

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[BG] 已安装, 原因:', details.reason);
  chrome.storage.local.get(['settings'], (result) => {
    if (!result.settings) {
      chrome.storage.local.set({
        settings: {
          citationsFormat: 'citation-and-abstract',
          batchSize: 50,
          delayMs: 500,
          rowsPerPage: 100,
          saveAs: true
        }
      });
    }
  });
});

// 清理 stale 状态
(async function startupCleanup() {
  try {
    const result = await chrome.storage.local.get(['taskState']);
    if (result.taskState) {
      const age = Date.now() - (result.taskState.startTime || 0);
      if (age > 10 * 60 * 1000) {
        await chrome.storage.local.remove('taskState');
        console.log('[BG] 已清理 stale 状态');
      }
    }
  } catch (err) { /* ignore */ }
})();

console.log('[BG] Service Worker 已启动');
