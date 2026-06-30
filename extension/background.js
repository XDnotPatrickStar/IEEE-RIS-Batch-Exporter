/**
 * IEEE RIS Batch Exporter — Background Service Worker v3
 *
 * 职责（精简版）：
 * 1. 接收 popup 命令 → 转发给 content script
 * 2. 处理 saveRISFile（文件下载）
 * 3. 处理 openFolder
 *
 * ★ 进度不再经过这里——content script 直接写 chrome.storage.local
 */

'use strict';

// ================================================================
// Popup Port（用于接收 start/cancel/openFolder 命令）
// ================================================================

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  console.log('[BG] Popup 已连接');

  port.onDisconnect.addListener(() => console.log('[BG] Popup 已断开'));

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
          // Popup 可能还想读状态（但现在已经从 storage 读了）
          port.postMessage({ action: 'pong' });
          break;
      }
    } catch (err) {
      console.error('[BG] Port 消息错误:', err);
    }
  });
});

// ================================================================
// 来自 content script 的消息（当前无实际处理，目录已移到 content）

// ================================================================
// 命令处理
// ================================================================

async function handleStartExport(options = {}) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0) throw new Error('找不到活动标签页');

    const tab = tabs[0];

    const searchInfo = await chrome.tabs.sendMessage(tab.id, { action: 'getSearchInfo' });
    if (!searchInfo || !searchInfo.queryText) {
      throw new Error('当前页面不是 IEEE 搜索结果页。');
    }

    const finalOptions = {
      queryText: searchInfo.queryText,
      queryParams: searchInfo.queryParams,
      rowsPerPage: options.rowsPerPage || 100,
      batchSize: options.batchSize || 50,
      delayMs: options.delayMs || 500,
      risFormat: 'download-ris',
      citationsFormat: options.citationsFormat || 'citation-and-abstract',
      saveAs: options.saveAs !== undefined ? options.saveAs : true,
      fullAbstracts: options.fullAbstracts !== undefined ? options.fullAbstracts : true
    };

    await chrome.tabs.sendMessage(tab.id, {
      action: 'startCollection',
      options: finalOptions
    });

    console.log('[BG] 导出已启动:', finalOptions.queryText.slice(0, 60));

  } catch (err) {
    console.error('[BG] 启动失败:', err.message);
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
}

async function handleOpenFolder() {
  try {
    const downloads = await chrome.downloads.search({
      limit: 1, orderBy: ['-startTime'],
      filenameRegex: 'IEEE_.*\\.ris$'
    });
    if (downloads.length > 0) {
      await chrome.downloads.show(downloads[0].id);
    }
  } catch (err) {
    console.warn('[BG] 打开文件夹失败:', err.message);
  }
}

// ================================================================
// 启动清理
// ================================================================

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[BG] 已安装, 原因:', details.reason);
  chrome.storage.local.get(['settings'], (result) => {
    if (!result.settings) {
      chrome.storage.local.set({
        settings: {
          citationsFormat: 'citation-and-abstract', batchSize: 50,
          delayMs: 500, rowsPerPage: 100, saveAs: true, fullAbstracts: true
        }
      });
    }
  });
});

(async function startupCleanup() {
  try {
    const result = await chrome.storage.local.get(['taskState']);
    if (result.taskState) {
      const age = Date.now() - (result.taskState.startTime || 0);
      if (age > 10 * 60 * 1000) {
        await chrome.storage.local.remove('taskState');
      }
    }
  } catch (err) { /* ignore */ }
})();

console.log('[BG v3] Service Worker 已启动');
