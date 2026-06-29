/**
 * IEEE RIS Batch Exporter — Popup UI v3
 *
 * ★ 进度直接从 chrome.storage.local 读取（content script 直写，不经过 background）
 * ★ Port 仅用于向 background 发送命令（start/cancel/openFolder）
 */

(function() {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const els = {
    queryText: $('#queryText'), totalRecords: $('#totalRecords'),
    searchInfo: $('#searchInfo'), notSearchPage: $('#notSearchPage'),
    progressSection: $('#progressSection'), progressBar: $('#progressBar'),
    phaseLabel: $('#phaseLabel'), collectStats: $('#collectStats'),
    collectCount: $('#collectCount'), downloadStats: $('#downloadStats'),
    downloadCount: $('#downloadCount'), statusMessage: $('#statusMessage'),
    completeSection: $('#completeSection'), completeFilename: $('#completeFilename'),
    completeRecords: $('#completeRecords'),
    btnOpenFolder: $('#btnOpenFolder'), btnNewExport: $('#btnNewExport'),
    settingsSection: $('#settingsSection'), citationsFormat: $('#citationsFormat'),
    batchSize: $('#batchSize'), delayMs: $('#delayMs'),
    saveAs: $('#saveAs'), fullAbstracts: $('#fullAbstracts'),
    btnStart: $('#btnStart'), btnCancel: $('#btnCancel'),
    btnDiagnostics: $('#btnDiagnostics'),
    diagnosticsSection: $('#diagnosticsSection'), diagnosticsContent: $('#diagnosticsContent'),
  };

  let port = null;
  let isExporting = false;

  // ================================================================
  // 初始化
  // ================================================================

  async function init() {
    await loadSettings();
    connectPort();
    bindEvents();
    await detectCurrentTab();
    await restoreTaskState();

    // ★ 监听 storage 变化（核心：content script 写 storage，popup 实时响应）
    chrome.storage.onChanged.addListener(onStorageChanged);
  }

  function connectPort() {
    if (port) { try { port.disconnect(); } catch(e) {} }
    port = chrome.runtime.connect({ name: 'popup' });
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
    els.btnDiagnostics.addEventListener('click', onDiagnostics);
    [els.citationsFormat, els.batchSize, els.delayMs, els.saveAs, els.fullAbstracts]
      .forEach(el => el.addEventListener('change', saveSettings));
  }

  // ================================================================
  // Storage 变化处理 ★ 核心
  // ================================================================

  function onStorageChanged(changes, area) {
    if (area === 'local' && changes.taskState) {
      const state = changes.taskState.newValue;
      if (state) render(state);
    }
  }

  async function restoreTaskState() {
    try {
      const result = await chrome.storage.local.get(['taskState']);
      if (result.taskState) {
        const state = result.taskState;
        if (state.startTime && (Date.now() - state.startTime > 10 * 60 * 1000)) {
          chrome.storage.local.remove('taskState').catch(() => {});
          return;
        }
        if (['collecting', 'downloading', 'abstracts', 'merging', 'complete', 'error']
             .includes(state.status)) {
          render(state);
        }
      }
    } catch (err) { /* ignore */ }
  }

  // ================================================================
  // 统一渲染
  // ================================================================

  function render(state) {
    if (!state) return;
    const p = state.progress || {};

    switch (state.status) {
      case 'idle':
        showIdle();
        break;

      case 'collecting':
        if (!isExporting) showExporting();
        els.phaseLabel.textContent = '📡 正在搜索...';
        els.collectStats.style.display = 'flex';
        els.collectCount.textContent = `${p.collected || 0} / ${p.total || 0}`;
        els.downloadStats.style.display = 'none';
        if (p.total > 0) els.progressBar.style.width = Math.min(Math.round(p.collected / p.total * 100), 95) + '%';
        els.statusMessage.textContent = `正在翻页收集文献 ID... 第 ${p.page || 0} / ${p.totalPages || '?'} 页`;
        break;

      case 'abstracts':
        if (!isExporting) showExporting();
        els.phaseLabel.textContent = '📝 正在获取完整摘要...';
        els.collectStats.style.display = 'none';
        els.downloadStats.style.display = 'flex';
        els.downloadCount.textContent = `${p.downloaded || 0} / ${p.total || 0}`;
        if (p.total > 0) els.progressBar.style.width = Math.min(Math.round((p.downloaded || 0) / p.total * 100), 98) + '%';
        els.statusMessage.textContent = `通过 CrossRef 获取完整摘要中... 已处理 ${p.downloaded || 0} 篇` +
          (p.enriched > 0 ? `（${p.enriched} 篇已补全）` : '');
        break;

      case 'downloading':
        if (!isExporting) showExporting();
        els.phaseLabel.textContent = '⬇️ 正在下载 RIS...';
        els.collectStats.style.display = 'none';
        els.downloadStats.style.display = 'flex';
        els.downloadCount.textContent = `${p.downloaded || 0} / ${p.total || 0}`;
        if (p.total > 0) els.progressBar.style.width = Math.min(Math.round((p.downloaded || 0) / p.total * 100), 98) + '%';
        els.statusMessage.textContent = `构建中... 第 ${p.batch || 0} / ${p.totalBatches || '?'} 批`;
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
      if (!url.includes('ieeexplore.ieee.org') || !(url.includes('/search/') || url.includes('searchresult.jsp'))) {
        showNotSearchPage(); return;
      }
      const pingResult = await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
      if (!pingResult || pingResult.status !== 'ok') { showNotSearchPage(); return; }
      const info = await chrome.tabs.sendMessage(tab.id, { action: 'getSearchInfo' });
      if (info && info.queryText) {
        showSearchInfo(info);
        els.btnStart.disabled = false;
        els.btnStart.textContent = '🚀 开始导出全部';
      } else {
        showNotSearchPage();
      }
    } catch (err) {
      console.warn('[Popup] 标签页检测失败:', err.message);
      if (!isExporting) showNotSearchPage();
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
    els.btnStart.disabled = false;
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
    els.completeFilename.textContent = state.lastFilename || '—';
    els.completeRecords.textContent = state.progress?.total || '—';
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
      fullAbstracts: els.fullAbstracts.checked,
      saveAs: els.saveAs.checked
    };

    if (port) {
      port.postMessage({ action: 'startExport', options });
    } else {
      connectPort();
      setTimeout(() => {
        if (port) port.postMessage({ action: 'startExport', options });
        else { showIdle(); els.statusMessage.textContent = '❌ 无法连接后台服务'; }
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
    els.diagnosticsContent.innerHTML = '<div class="diag-row"><span class="diag-value">正在检测...</span></div>';
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs.length) throw new Error('找不到活动标签页');
      const results = await chrome.tabs.sendMessage(tabs[0].id, { action: 'runDiagnostics' });
      if (!results || results.error) {
        els.diagnosticsContent.innerHTML = `<div class="diag-row fail">${escapeHtml(results?.error || '无响应')}</div>`;
        return;
      }
      let html = '';
      for (const r of results) {
        const val = String(r.value || '—');
        let cls = '';
        if (/失败|HTTP [45]/.test(val)) cls = 'fail';
        else if (/未找到|未检测到/.test(val)) cls = 'warn';
        else cls = 'pass';
        html += `<div class="diag-row ${cls}"><span class="diag-check">${r.check}</span><span class="diag-value">${escapeHtml(val)}</span></div>`;
      }
      els.diagnosticsContent.innerHTML = html;
    } catch (err) {
      els.diagnosticsContent.innerHTML = `<div class="diag-row fail">${escapeHtml(err.message)}</div>`;
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ================================================================
  // 设置
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
    } catch (err) { console.warn('[Popup] 加载设置失败:', err.message); }
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
          risFormat: 'download-ris', rowsPerPage: 100
        }
      });
    } catch (err) { console.warn('[Popup] 保存设置失败:', err.message); }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
