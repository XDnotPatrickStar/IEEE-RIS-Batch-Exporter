/**
 * IEEE RIS Batch Exporter — Content Script v2
 *
 * 注入到 IEEE Xplore 搜索结果页，负责全部 IEEE API 交互。
 *
 * 工作流程：
 * 1. 从页面 URL 提取 queryText
 * 2. 调用 /rest/search 分页收集全部文献的完整元数据
 * 3. 下载阶段：先试所有下载端点 → 都不行则用元数据自建 RIS
 * 4. 合并去重后发送给 background 保存
 */

(function() {
  'use strict';

  let abortController = null;
  let isRunning = false;  // ★ 防重入守卫

  // ================================================================
  // 消息监听
  // ================================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      try {
        switch (message.action) {
          case 'ping':
            sendResponse({ status: 'ok', url: window.location.href, isRunning });
            break;
          case 'getSearchInfo':
            sendResponse(await handleGetSearchInfo());
            break;
          case 'startCollection':
            if (isRunning) {
              sendResponse({ status: 'rejected', reason: '已有导出任务正在运行' });
              return;
            }
            sendResponse({ status: 'started' });
            await runFullExport(message.options);
            break;
          case 'cancelExport':
            handleCancel();
            sendResponse({ status: 'cancelled' });
            break;
          case 'runDiagnostics':
            try {
              const r = await IEEE_API.runDiagnostics();
              sendResponse(r);
            } catch(e) { sendResponse({ error: e.message }); }
            break;
          default:
            sendResponse({ error: 'Unknown: ' + message.action });
        }
      } catch (err) {
        console.error('[Content] 错误:', err);
        sendResponse({ error: err.message });
      }
    })();
    return true;
  });

  // ================================================================
  // 搜索信息
  // ================================================================

  async function handleGetSearchInfo() {
    const url = window.location.href;
    const { queryText, queryParams } = IEEE_API.parseSearchUrl(url);
    let totalRecords = null;
    try {
      if (window.xploreGlobal?.searchResult?.totalRecords) {
        totalRecords = window.xploreGlobal.searchResult.totalRecords;
      }
    } catch(e) {}
    if (!totalRecords && queryText) {
      try {
        const fp = await IEEE_API.fetchSearchPage({ queryText, pageNumber:1, rowsPerPage:25, queryParams });
        totalRecords = fp.totalRecords;
      } catch(e) {}
    }
    return { url, queryText, queryParams,
      totalRecords: totalRecords || IEEE_API.extractTotalCountFromDOM() || '未知',
      isSearchPage: true };
  }

  // ================================================================
  // 完整导出流程
  // ================================================================

  async function runFullExport(options = {}) {
    const {
      queryText: optQuery, queryParams = {}, rowsPerPage = 100,
      batchSize = 50, delayMs = 500,
      citationsFormat = 'citation-and-abstract',
      saveAs = true
    } = options;

    // ★ 标记运行中，防止重入
    isRunning = true;

    let queryText = optQuery;
    let qp = { ...queryParams };
    if (!queryText) {
      const info = await handleGetSearchInfo();
      queryText = info.queryText;
      Object.assign(qp, info.queryParams);
    }
    if (!queryText) {
      sendToBackground({ action: 'collectionError', error: '未检测到搜索查询。' });
      return;
    }

    abortController = new AbortController();
    const signal = abortController.signal;

    try {
      // ===== 阶段 1：收集完整元数据（不只是 ID） =====
      sendToBackground({ action: 'collectionProgress', phase: 'collecting', collected: 0, total: 0, page: 0 });

      const metadataRecords = await IEEE_API.collectAllMetadata(
        { queryText, rowsPerPage, queryParams: qp },
        (progress) => {
          sendToBackground({
            action: 'collectionProgress', phase: 'collecting',
            collected: progress.collected, total: progress.total,
            page: progress.page, totalPages: progress.totalPages
          });
        },
        signal
      );

      if (signal.aborted) return;
      if (metadataRecords.length === 0) {
        sendToBackground({ action: 'collectionError', error: '未找到任何文献。' });
        return;
      }

      const articleNumbers = metadataRecords
        .map(r => String(r.articleNumber))
        .filter(Boolean);

      sendToBackground({
        action: 'collectionComplete',
        articleNumbers, totalRecords: articleNumbers.length, queryText
      });

      // ===== 阶段 2：下载 RIS（端点优先 → 元数据构建兜底） =====
      const totalBatches = Math.ceil(articleNumbers.length / batchSize);
      sendToBackground({
        action: 'downloadProgress', phase: 'downloading',
        downloaded: 0, total: articleNumbers.length, batch: 0, totalBatches
      });

      // ★ 把全部元数据传给 downloadAllRIS 作为 fallback
      const { risText, stats } = await IEEE_API.downloadAllRIS(
        articleNumbers, {
          batchSize, delayMs,
          risFormat: 'download-ris', citationsFormat,
          onProgress: (prog) => {
            sendToBackground({
              action: 'downloadProgress', phase: 'downloading',
              downloaded: prog.downloaded, total: prog.total,
              batch: prog.batch, totalBatches: prog.totalBatches
            });
          },
          signal,
          metadataRecords  // ★ 关键：元数据作为 fallback
        }
      );

      if (signal.aborted) return;

      if (stats.totalDownloaded === 0) {
        sendToBackground({
          action: 'downloadError',
          error: '所有批次均失败。下载端点已 404，元数据构建也未成功。\n请尝试刷新 IEEE 页面后重试。'
        });
        return;
      }

      // ===== 阶段 3：合并去重 =====
      sendToBackground({ action: 'downloadProgress', phase: 'merging',
        downloaded: stats.totalDownloaded, total: stats.totalRequested });

      const mergeResult = RIS_MERGER.mergeFast([risText], { dedupField: 'AN', keepFirst: true });

      const finalRIS = RIS_MERGER.addMetaComment(mergeResult.text, {
        queryText, totalRecords: mergeResult.stats.totalUnique,
        format: 'RIS', citationsFormat
      });

      // ===== 阶段 4：保存 =====
      const saveResult = await sendToBackgroundAsync({
        action: 'saveRISFile', risText: finalRIS,
        meta: { queryText, totalRecords: mergeResult.stats.totalUnique,
          totalDownloaded: stats.totalDownloaded,
          totalDuplicates: mergeResult.stats.totalDuplicates, saveAs }
      });

      if (signal.aborted) return;

      if (!saveResult?.success) {
        sendToBackground({ action: 'downloadError', error: saveResult?.error || '文件保存失败' });
        return;
      }

      // 完成
      sendToBackground({
        action: 'downloadComplete',
        stats: {
          totalCollected: articleNumbers.length,
          totalDownloaded: stats.totalDownloaded,
          totalUnique: mergeResult.stats.totalUnique,
          totalDuplicates: mergeResult.stats.totalDuplicates,
          batchesCompleted: stats.batchesCompleted,
          batchesTotal: stats.batchesTotal,
          fallbackUsed: !stats.usedEndpoint  // 标记是否用了 fallback 方案
        }
      });

    } catch (err) {
      if (err.name === 'AbortError' || signal.aborted) {
        sendToBackground({ action: 'collectionCancelled' });
        return;
      }
      console.error('[Content] 导出错误:', err);
      sendToBackground({ action: 'downloadError', error: err.message || String(err) });
    } finally {
      abortController = null;
      isRunning = false;  // ★ 重置守卫
    }
  }

  function handleCancel() {
    if (abortController) { abortController.abort(); abortController = null; }
  }

  function sendToBackground(msg) {
    chrome.runtime.sendMessage(msg).catch(e => console.debug('[Content] sendMessage fail:', e.message));
  }

  function sendToBackgroundAsync(msg) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage(msg, (resp) => {
        resolve(chrome.runtime.lastError ? { success: false, error: chrome.runtime.lastError.message } : resp);
      });
    });
  }

  // ================================================================
  // 初始化
  // ================================================================

  chrome.runtime.sendMessage({ action: 'contentScriptLoaded', url: window.location.href }).catch(() => {});
  console.log('[IEEE RIS Exporter v2] Content script 已加载');
})();
