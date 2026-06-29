/**
 * IEEE RIS Batch Exporter — Content Script v3
 *
 * 注入到 IEEE Xplore 搜索结果页，负责全部 IEEE API 交互。
 *
 * ★ v3 架构变更：进度直接写入 chrome.storage.local，不经过 background
 *   原因：Manifest V3 Service Worker 会在30秒后休眠，port全部断开
 */

(function() {
  'use strict';

  let abortController = null;
  let isRunning = false;

  // ================================================================
  // 消息监听（只处理 popup 发来的命令 + 最终保存）
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
            try { const r = await IEEE_API.runDiagnostics(); sendResponse(r); }
            catch(e) { sendResponse({ error: e.message }); }
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
  // ★ 进度写入 storage（绕过 background，MV3 兼容）
  // ================================================================

  function updateStorageState(partial) {
    chrome.storage.local.get(['taskState'], (result) => {
      const current = result.taskState || {};
      Object.assign(current, partial);
      chrome.storage.local.set({ taskState: current }).catch(() => {});
    });
  }

  function setErrorAndStop(errorMsg) {
    updateStorageState({ status: 'error', error: errorMsg });
  }

  // ================================================================
  // 完整导出流程
  // ================================================================

  async function runFullExport(options = {}) {
    const {
      queryText: optQuery, queryParams = {}, rowsPerPage = 100,
      batchSize = 50, delayMs = 500,
      citationsFormat = 'citation-and-abstract',
      saveAs = true,
      fullAbstracts = true
    } = options;

    isRunning = true;

    let queryText = optQuery;
    let qp = { ...queryParams };
    if (!queryText) {
      const info = await handleGetSearchInfo();
      queryText = info.queryText;
      Object.assign(qp, info.queryParams);
    }
    if (!queryText) {
      setErrorAndStop('未检测到搜索查询。');
      isRunning = false;
      return;
    }

    abortController = new AbortController();
    const signal = abortController.signal;

    try {
      // ===== 阶段 1：收集元数据 =====
      updateStorageState({
        status: 'collecting',
        startTime: Date.now(),
        queryText: queryText,
        progress: { phase: 'collecting', collected: 0, total: 0, page: 0 }
      });

      const metadataRecords = await IEEE_API.collectAllMetadata(
        { queryText, rowsPerPage, queryParams: qp },
        (progress) => {
          updateStorageState({
            status: 'collecting',
            progress: {
              phase: 'collecting',
              collected: progress.collected,
              total: progress.total,
              page: progress.page,
              totalPages: progress.totalPages
            }
          });
        },
        signal
      );

      if (signal.aborted) { isRunning = false; return; }
      if (metadataRecords.length === 0) {
        setErrorAndStop('未找到任何文献。');
        isRunning = false;
        return;
      }

      const articleNumbers = metadataRecords.map(r => String(r.articleNumber)).filter(Boolean);

      // ===== 阶段 2：完整摘要 =====
      if (fullAbstracts && citationsFormat === 'citation-and-abstract') {
        updateStorageState({
          status: 'abstracts',
          progress: {
            phase: 'abstracts',
            downloaded: 0,   // 已处理篇数
            total: articleNumbers.length,
            enriched: 0,      // 成功补全数
            failed: 0         // 失败数
          }
        });

        const enrichResult = await IEEE_API.enrichWithFullAbstracts(
          metadataRecords, {
            delayMs: Math.max(delayMs, 800),
            batchSize: 2,
            onProgress: (prog) => {
              updateStorageState({
                status: 'abstracts',
                progress: {
                  phase: 'abstracts',
                  downloaded: prog.current,
                  total: prog.total,
                  enriched: prog.enriched,
                  failed: prog.failed
                }
              });
            },
            signal
          }
        );

        if (signal.aborted) { isRunning = false; return; }
        console.log(`[Content] 摘要增强: ${enrichResult.stats.enriched} 篇已补全, ${enrichResult.stats.failed} 篇无变化`);
      }

      // ===== 阶段 3：构建 RIS =====
      updateStorageState({
        status: 'downloading',
        progress: {
          phase: 'downloading',
          downloaded: 0,
          total: articleNumbers.length,
          batch: 0,
          totalBatches: Math.ceil(articleNumbers.length / batchSize)
        }
      });

      const { risText, stats } = await IEEE_API.downloadAllRIS(
        articleNumbers, {
          batchSize, delayMs,
          risFormat: 'download-ris', citationsFormat,
          onProgress: (prog) => {
            updateStorageState({
              status: 'downloading',
              progress: {
                phase: 'downloading',
                downloaded: prog.downloaded,
                total: prog.total,
                batch: prog.batch,
                totalBatches: prog.totalBatches
              }
            });
          },
          signal,
          metadataRecords
        }
      );

      if (signal.aborted) { isRunning = false; return; }

      if (stats.totalDownloaded === 0) {
        setErrorAndStop('所有批次均失败。');
        isRunning = false;
        return;
      }

      // ===== 阶段 4：合并去重 =====
      updateStorageState({
        status: 'merging',
        progress: { phase: 'merging', downloaded: stats.totalDownloaded, total: stats.totalRequested }
      });

      const mergeResult = RIS_MERGER.mergeFast([risText], { dedupField: 'AN', keepFirst: true });

      const finalRIS = RIS_MERGER.addMetaComment(mergeResult.text, {
        queryText, totalRecords: mergeResult.stats.totalUnique,
        format: 'RIS', citationsFormat
      });

      // ===== 阶段 5：保存文件（唯一需要 background 的步骤）=====
      const saveResult = await sendToBackgroundAsync({
        action: 'saveRISFile', risText: finalRIS,
        meta: { queryText, totalRecords: mergeResult.stats.totalUnique,
          totalDownloaded: stats.totalDownloaded,
          totalDuplicates: mergeResult.stats.totalDuplicates, saveAs }
      });

      if (signal.aborted) { isRunning = false; return; }

      if (!saveResult?.success) {
        setErrorAndStop(saveResult?.error || '文件保存失败');
        isRunning = false;
        return;
      }

      // 完成
      updateStorageState({
        status: 'complete',
        progress: { phase: 'complete', total: mergeResult.stats.totalUnique },
        lastFilename: saveResult.filename,
        lastDownloadId: saveResult.downloadId
      });

      console.log(`[Content] 导出完成: ${mergeResult.stats.totalUnique} 篇`);

    } catch (err) {
      if (err.name === 'AbortError' || signal.aborted) {
        updateStorageState({ status: 'cancelled' });
      } else {
        console.error('[Content] 导出错误:', err);
        setErrorAndStop(err.message || String(err));
      }
    } finally {
      abortController = null;
      isRunning = false;
    }
  }

  function handleCancel() {
    if (abortController) { abortController.abort(); abortController = null; }
  }

  function sendToBackground(msg) {
    chrome.runtime.sendMessage(msg).catch(() => {});
  }

  function sendToBackgroundAsync(msg) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage(msg, (resp) => {
        resolve(chrome.runtime.lastError ? { success: false, error: chrome.runtime.lastError.message } : resp);
      });
    });
  }

  chrome.runtime.sendMessage({ action: 'contentScriptLoaded', url: window.location.href }).catch(() => {});
  console.log('[IEEE RIS Exporter v3] Content script 已加载 (storage直写模式)');
})();
