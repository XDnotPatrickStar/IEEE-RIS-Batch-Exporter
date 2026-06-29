/**
 * IEEE RIS Batch Exporter — Popup UI 逻辑
 *
 * 弹出窗口：状态显示、进度条、设置管理、用户交互
 */

(function() {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const els = {
    queryText: $('#queryText'),
    totalRecords: $('#totalRecords'),
    searchInfo: $('#searchInfo'),
    notSearchPage: $('#notSearchPage'),
    notSearchHint: $('#notSearchHint'),

    progressSection: $('#progressSection'),
    progressBar: $('#progressBar'),
    phaseLabel: $('#phaseLabel'),
    collectStats: $('#collectStats'),
    collectCount: $('#collectCount'),
    downloadStats: $('#downloadStats'),
    downloadCount: $('#downloadCount'),
    statusMessage: $('#statusMessage'),

    completeSection: $('#completeSection'),
    completeFilename: $('#completeFilename'),
    completeRecords: $('#completeRecords'),
    btnOpenFolder: $('#btnOpenFolder'),
    btnNewExport: $('#btnNewExport'),

    settingsSection: $('#settingsSection'),
    citationsFormat: $('#citationsFormat'),
    batchSize: $('#batchSize'),
    delayMs: $('#delayMs'),
    saveAs: $('#saveAs'),
    fullAbstracts: $('#fullAbstracts'),

    btnStart: $('#btnStart'),
    btnCancel: $('#btnCancel'),
    btnDiagnostics: $('#btnDiagnostics'),
    diagnosticsSection: $('#diagnosticsSection'),
    diagnosticsContent: $('#diagnosticsContent'),
  };

  // ================================================================
  // 状态
  // ================================================================

  let port = null;
  let isExporting = false;
  let lastTaskState = null;

  // ================================================================
  // 初始化
  // ================================================================

  async function init() {
    await loadSettings();
    connectPort();
    bindEvents();
    await detectCurrentTab();     // ★ 先检测标签页
    await restoreTaskState();     // ★ 再恢复进度
    chrome.storage.onChanged.addListener(onStorageChanged);
  }

  function connectPort() {
    if (port) { try { port.disconnect(); } catch (e) { /* ignore */ } }
    port = chrome.runtime.connect({ name: 'popup' });

    port.onMessage.addListener((message) => {
      if (message.action === 'stateUpdate') onTaskStateUpdate(message.state);
    });

    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(() => { if (!port) connectPort(); }, 3000);
    });
  }

  function bindEvents() {
    els.btnStart.addEventListener('click', onStartExport);
    els.btnCancel.addEventListener('click', onCancelExport);
    els.btnOpenFolder.addEventListener('click', onOpenFolder);
    els.btnNewExport.addEventListener('click', onNewExport);
    els.citationsFormat.addEventListener('change', saveSettings);
    els.batchSize.addEventListener('change', saveSettings);
    els.delayMs.addEventListener('change', saveSettings);
    els.saveAs.addEventListener('change', saveSettings);
    els.fullAbstracts.addEventListener('change', saveSettings);
    els.btnDiagnostics.addEventListener('click', onDiagnostics);
  }

  // ================================================================
  // 恢复任务状态
  // ================================================================

  async function restoreTaskState() {
    try {
      const result = await chrome.storage.local.get(['taskState']);
      if (!result.taskState) return;
      const state = result.taskState;

      if (state.startTime && (Date.now() - state.startTime > 10 * 60 * 1000)) {
        chrome.storage.local.remove('taskState').catch(() => {});
        return;
      }

      if (['collecting', 'downloading', 'abstracts', 'merging', 'complete', 'error'].includes(state.status)) {
        onTaskStateUpdate(state);
      }
    } catch (err) {
      console.warn('[Popup] 恢复状态失败:', err.message);
    }
  }

  function onStorageChanged(changes, area) {
    if (area === 'local' && changes.taskState) {
      const state = changes.taskState.newValue;
      if (state) onTaskStateUpdate(state);
    }
  }

  // ================================================================
  // 状态更新
  // ================================================================

  function onTaskStateUpdate(state) {
    if (!state) return;
    lastTaskState = state;

    switch (state.status) {
      case 'idle':
        showIdle();
        break;

      case 'collecting':
        if (!isExporting) showExporting();
        els.phaseLabel.textContent = '📡 正在搜索...';
        els.collectStats.style.display = 'flex';
        els.collectCount.textContent = `${state.progress?.collected || 0} / ${state.progress?.total || 0}`;
        els.downloadStats.style.display = 'none';
        if (state.progress?.total > 0) {
          els.progressBar.style.width = Math.min(Math.round(state.progress.collected / state.progress.total * 100), 95) + '%';
        }
        els.statusMessage.textContent =
          `正在翻页收集文献 ID... 第 ${state.progress?.page || 0} / ${state.progress?.totalPages || '?'} 页`;
        break;

      case 'downloading':
        if (!isExporting) showExporting();
        els.phaseLabel.textContent = '⬇️ 正在下载 RIS...';
        els.collectStats.style.display = 'none';
        els.downloadStats.style.display = 'flex';
        els.downloadCount.textContent = `${state.progress?.downloaded || 0} / ${state.progress?.total || 0}`;
        if (state.progress?.total > 0) {
          els.progressBar.style.width = Math.min(Math.round((state.progress.downloaded || 0) / state.progress.total * 100), 98) + '%';
        }
        els.statusMessage.textContent =
          `批量下载中... 第 ${state.progress?.batch || 0} / ${state.progress?.totalBatches || '?'} 批`;
        break;

      case 'abstracts':
        // 获取完整摘要阶段
        els.phaseLabel.textContent = '📝 正在获取完整摘要...';
        els.collectStats.style.display = 'none';
        els.downloadStats.style.display = 'flex';
        els.downloadCount.textContent = `${state.progress?.downloaded || 0} / ${state.progress?.total || 0}`;
        if (state.progress?.total > 0) {
          els.progressBar.style.width = Math.min(Math.round((state.progress.downloaded || 0) / state.progress.total * 100), 98) + '%';
        }
        els.statusMessage.textContent =
          `已处理 ${state.progress?.downloaded || 0} 篇` +
          (state.progress?.enriched > 0 ? `（${state.progress.enriched} 篇摘要已补全）` : '');
        break;

      case 'merging':
        els.phaseLabel.textContent = '🔧 正在合并去重...';
        els.progressBar.style.width = '99%';
        els.statusMessage.textContent = '正在合并 RIS 文件并去除重复项...';
        break;

      case 'complete':
        showComplete(state);
        break;

      case 'error':
        els.progressSection.style.display = 'block';
        els.completeSection.style.display = 'none';
        els.progressBar.classList.add('error');
        els.progressBar.style.width = '100%';
        els.statusMessage.textContent = '❌ ' + (state.error || '未知错误');
        els.btnCancel.style.display = 'none';
        els.btnStart.style.display = 'block';
        els.btnStart.textContent = '🔄 重试';
        els.btnStart.disabled = false;
        isExporting = false;
        break;

      case 'cancelled':
        showIdle();
        els.statusMessage.textContent = '⏹️ 已取消';
        break;
    }
  }

  // ================================================================
  // 标签页检测
  // ================================================================

  async function detectCurrentTab() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab || !tab.url) { showNotSearchPage(); return; }

      const url = tab.url;
      const isIEEESearch = url.includes('ieeexplore.ieee.org') &&
                           (url.includes('/search/') || url.includes('searchresult.jsp'));
      if (!isIEEESearch) { showNotSearchPage(); return; }

      const pingResult = await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
      if (!pingResult || pingResult.status !== 'ok') {
        showNotSearchPage();
        return;
      }

      const searchInfo = await chrome.tabs.sendMessage(tab.id, { action: 'getSearchInfo' });
      if (searchInfo && searchInfo.queryText) {
        showSearchInfo(searchInfo);
        els.btnStart.disabled = false;
        els.btnStart.textContent = '🚀 开始导出全部';
      } else {
        showNotSearchPage();
      }
    } catch (err) {
      console.warn('[Popup] 标签页检测失败:', err.message);
      showNotSearchPage();
    }
  }

  // ================================================================
  // UI 切换
  // ================================================================

  function showSearchInfo(info) {
    if (isExporting) return;
    els.searchInfo.style.display = 'block';
    els.notSearchPage.style.display = 'none';
    els.queryText.textContent = info.queryText || '--';
    els.totalRecords.textContent = info.totalRecords ? `${info.totalRecords} 篇` : '正在获取...';
  }

  function showNotSearchPage() {
    if (isExporting) return;
    els.searchInfo.style.display = 'none';
    els.notSearchPage.style.display = 'block';
    els.settingsSection.style.display = 'none';
    els.progressSection.style.display = 'none';
    els.completeSection.style.display = 'none';
    els.btnStart.disabled = true;
  }

  function showExporting() {
    isExporting = true;
    els.searchInfo.style.display = 'block';
    els.notSearchPage.style.display = 'none';
    els.btnStart.style.display = 'none';
    els.btnCancel.style.display = 'block';
    els.progressSection.style.display = 'block';
    els.completeSection.style.display = 'none';
    els.settingsSection.style.display = 'none';
    els.progressBar.classList.remove('complete', 'error');
  }

  function showIdle() {
    isExporting = false;
    els.btnStart.style.display = 'block';
    els.btnStart.textContent = '🚀 开始导出全部';
    els.btnCancel.style.display = 'none';
    els.settingsSection.style.display = 'block';
    els.progressSection.style.display = 'none';
    els.completeSection.style.display = 'none';
    els.progressBar.classList.remove('complete', 'error');
    els.progressBar.style.width = '0%';
  }

  function showComplete(state) {
    isExporting = false;
    els.btnCancel.style.display = 'none';
    els.btnStart.style.display = 'none';
    els.progressSection.style.display = 'none';
    els.settingsSection.style.display = 'block';
    els.completeSection.style.display = 'block';
    els.progressBar.classList.add('complete');
    els.progressBar.style.width = '100%';

    els.completeFilename.textContent = state.lastFilename || lastTaskState?.lastFilename || '—';
    els.completeRecords.textContent = state.progress?.total || state.progress?.downloaded || '—';
  }

  // ================================================================
  // 事件
  // ================================================================

  async function onStartExport() {
    if (isExporting) return;

    showExporting();
    els.progressBar.style.width = '0%';
    els.statusMessage.textContent = '正在初始化...';

    const options = {
      batchSize: parseInt(els.batchSize.value, 10),
      delayMs: parseInt(els.delayMs.value, 10),
      citationsFormat: els.citationsFormat.value,
      risFormat: 'download-ris',
      rowsPerPage: 100,
      fullAbstracts: els.fullAbstracts.checked,  // ★ 完整摘要开关
      saveAs: els.saveAs.checked   // ★ 传给 background
    };

    if (port) {
      port.postMessage({ action: 'startExport', options });
    } else {
      connectPort();
      setTimeout(() => {
        if (port) port.postMessage({ action: 'startExport', options });
        else {
          showIdle();
          els.statusMessage.textContent = '❌ 无法连接到后台服务';
        }
      }, 500);
    }
  }

  async function onCancelExport() {
    if (port) port.postMessage({ action: 'cancelExport' });
    showIdle();
    els.statusMessage.textContent = '⏹️ 已取消';
  }

  function onOpenFolder() {
    if (port) port.postMessage({ action: 'openFolder' });
  }

  function onNewExport() {
    showIdle();
    detectCurrentTab();
  }

  async function onDiagnostics() {
    els.diagnosticsSection.style.display = 'block';
    els.diagnosticsContent.innerHTML = '<div class="diag-row"><span class="diag-check">状态</span><span class="diag-value">正在检测...</span></div>';

    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs.length) throw new Error('找不到活动标签页');

      const results = await chrome.tabs.sendMessage(tabs[0].id, { action: 'runDiagnostics' });
      if (!results || results.error) {
        els.diagnosticsContent.innerHTML = `<div class="diag-row fail"><span class="diag-value">${results?.error || '无响应'}</span></div>`;
        return;
      }

      let html = '';
      for (const r of results) {
        const val = String(r.value || '—');
        let rowClass = '';
        if (val.includes('失败') || val.includes('HTTP 4') || val.includes('HTTP 5')) rowClass = 'fail';
        else if (val.includes('未找到') || val.includes('未检测到')) rowClass = 'warn';
        else rowClass = 'pass';
        html += `<div class="diag-row ${rowClass}"><span class="diag-check">${r.check}</span><span class="diag-value">${escapeHtml(val)}</span></div>`;
      }
      els.diagnosticsContent.innerHTML = html;

    } catch (err) {
      els.diagnosticsContent.innerHTML = `<div class="diag-row fail"><span class="diag-value">诊断失败: ${escapeHtml(err.message)}</span></div>`;
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ================================================================
  // 设置持久化
  // ================================================================

  async function loadSettings() {
    try {
      const result = await chrome.storage.local.get(['settings']);
      if (result.settings) {
        const s = result.settings;
        if (s.citationsFormat) els.citationsFormat.value = s.citationsFormat;
        if (s.batchSize) els.batchSize.value = String(s.batchSize);
        if (s.delayMs) els.delayMs.value = String(s.delayMs);
        if (s.saveAs !== undefined) els.saveAs.checked = s.saveAs;
        if (s.fullAbstracts !== undefined) els.fullAbstracts.checked = s.fullAbstracts;
      }
    } catch (err) {
      console.warn('[Popup] 加载设置失败:', err.message);
    }
  }

  async function saveSettings() {
    try {
      await chrome.storage.local.set({
        settings: {
          citationsFormat: els.citationsFormat.value,
          batchSize: parseInt(els.batchSize.value, 10),
          delayMs: parseInt(els.delayMs.value, 10),
          saveAs: els.saveAs.checked,
          fullAbstracts: els.fullAbstracts.checked,
          risFormat: 'download-ris',
          rowsPerPage: 100
        }
      });
    } catch (err) {
      console.warn('[Popup] 保存设置失败:', err.message);
    }
  }

  // ================================================================
  // 启动
  // ================================================================

  document.addEventListener('DOMContentLoaded', init);
})();
