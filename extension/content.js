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
      totalRecords: totalRecords || '未知',
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
            delayMs: Math.max(delayMs, 100),   // 快速模式
            batchSize: 6,                          // 6 DOI 并发
            onProgress: (prog) => {
              updateStorageState({
                status: 'abstracts',
                progress: {
                  phase: 'abstracts',
                  downloaded: prog.current,
                  total: prog.total,
                  enriched: prog.enriched,
                  failed: prog.noChange || 0
                }
              });
            },
            signal
          }
        );

        if (signal.aborted) { isRunning = false; return; }
        console.log(`[Content] 摘要增强: ${enrichResult.stats.enriched} 篇已补全, ${enrichResult.stats.failed} 篇无变化`);
      }

      // ===== 阶段 3：构建 RIS（直接从元数据，不再尝试任何端点）=====
      updateStorageState({
        status: 'downloading',
        progress: { phase: 'downloading', downloaded: 0, total: articleNumbers.length }
      });

      // ★ 直接用增强过的元数据构建 RIS，不再调用 downloadAllRIS
      const risText = IEEE_API.buildRISFromMetadata(metadataRecords, citationsFormat);

      if (signal.aborted) { isRunning = false; return; }

      updateStorageState({
        status: 'merging',
        progress: { phase: 'merging', downloaded: articleNumbers.length, total: articleNumbers.length }
      });

      // ★ 输出第一个摘要的尾部用于诊断
      if (metadataRecords.length > 0) {
        const firstAbs = metadataRecords[0].abstract || '';
        console.log(`[Content] RIS 已构建, 样例摘要: ${firstAbs.length}字符, 尾部="${firstAbs.slice(-60)}"`);
      }

      // ===== 阶段 4：合并去重 =====
      const mergeResult = RIS_MERGER.mergeFast([risText], { dedupField: 'AN', keepFirst: true });

      const finalRIS = RIS_MERGER.addMetaComment(mergeResult.text, {
        queryText, totalRecords: mergeResult.stats.totalUnique,
        format: 'RIS', citationsFormat
      });

      // ===== 阶段 5：保存文件 =====
      const filename = buildFilename(queryText);
      try {
        // content script 没有 chrome.downloads API，用 <a> 标签触发下载
        const blob = new Blob([finalRIS], { type: 'application/x-research-info-systems' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 3000);

        console.log('[Content] 文件已触发下载:', filename);
      } catch (err) {
        setErrorAndStop('下载失败: ' + err.message);
        isRunning = false;
        return;
      }

      // 完成
      updateStorageState({
        status: 'complete',
        progress: { phase: 'complete', total: mergeResult.stats.totalUnique },
        lastFilename: filename
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

  /**
   * 直接在页面中触发文件下载（不依赖 Service Worker）
   */
  function downloadFile(text, filename) {
    const blob = new Blob([text], { type: 'application/x-research-info-systems' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    // 延迟清理
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function buildFilename(queryText) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const snippet = (queryText || 'export')
      .replace(/[^a-zA-Z0-9一-鿿\s-]/g, '').slice(0, 50).trim().replace(/\s+/g, '_');
    return `IEEE_${snippet}_${timestamp}.ris`;
  }

  chrome.runtime.sendMessage({ action: 'contentScriptLoaded', url: window.location.href }).catch(() => {});
  console.log('[IEEE RIS Exporter v3] Content script 已加载 (storage直写 + 本地下载)');
})();
