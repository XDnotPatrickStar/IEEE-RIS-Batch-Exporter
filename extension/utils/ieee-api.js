/**
 * IEEE Xplore API 封装层 v2
 *
 * 核心改动：downloadCitations 端点 (xpl/downloadCitations) 已经 404 不可用。
 * 主策略改为：从搜索 API JSON 数据直接构建 RIS 文件。
 * 备用策略：尝试其他可能的下载端点。
 */

const IEEE_API = (() => {
  'use strict';

  const SEARCH_URL = 'https://ieeexplore.ieee.org/rest/search';
  const DOC_URL = 'https://ieeexplore.ieee.org/rest/document/';

  // 尝试多个可能的下载端点（IEEE 可能改了路径）
  const DOWNLOAD_CANDIDATES = [
    'https://ieeexplore.ieee.org/xpl/downloadCitations',
    'https://ieeexplore.ieee.org/rest/downloadCitations',
    'https://ieeexplore.ieee.org/api/v1/downloadCitations',
    'https://ieeexplore.ieee.org/xpl/downloadCitations?reload=true',
    'https://ieeexplore.ieee.org/gateway/ips/export.jsp',
  ];

  const DEFAULT_HEADERS = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*'
  };

  // ──────────────────────────────────────────────────────────
  // 搜索（不变，已验证可用）
  // ──────────────────────────────────────────────────────────

  function parseSearchUrl(url) {
    const urlObj = new URL(url);
    const params = urlObj.searchParams;
    const queryText = params.get('queryText') || '';
    const queryParams = {};
    const relevantKeys = ['queryText','highlight','returnType','matchPubs',
      'ranges','returnFacets','rowsPerPage','sortType','searchWithin','refinements'];
    for (const key of relevantKeys) {
      const val = params.get(key);
      if (val !== null && val !== undefined) queryParams[key] = val;
    }
    return { queryText, queryParams };
  }

  async function fetchSearchPage({ queryText, pageNumber = 1, rowsPerPage = 100, queryParams = {} }) {
    const payload = {
      newsearch: true, queryText,
      highlight: true,
      returnFacets: ['ALL'],
      returnType: queryParams.returnType || 'SEARCH',
      pageNumber, rowsPerPage
    };

    const resp = await fetch(SEARCH_URL, {
      method: 'POST', headers: DEFAULT_HEADERS,
      credentials: 'include', body: JSON.stringify(payload)
    });
    if (!resp.ok) throw new Error(`搜索请求失败 (HTTP ${resp.status})`);
    const data = await resp.json();
    return {
      records: data.records || [],
      totalRecords: data.totalRecords || 0,
      totalPages: data.totalPages || 1
    };
  }

  async function collectAllArticleNumbers(options, onProgress, signal) {
    const { queryText, rowsPerPage = 100, queryParams = {} } = options;
    const firstPage = await fetchSearchPage({ queryText, pageNumber: 1, rowsPerPage, queryParams });
    const totalRecords = firstPage.totalRecords;
    const totalPages = firstPage.totalPages;
    const articleNumbers = new Set();
    for (const r of firstPage.records) {
      if (r.articleNumber) articleNumbers.add(String(r.articleNumber));
    }
    if (onProgress) onProgress({ collected: articleNumbers.size, total: totalRecords, page: 1, totalPages });
    if (signal?.aborted) throw new DOMException('用户取消', 'AbortError');

    for (let page = 2; page <= totalPages; page++) {
      if (page > 2) await sleep(300);
      try {
        const pageData = await fetchSearchPage({ queryText, pageNumber: page, rowsPerPage, queryParams });
        for (const r of pageData.records) {
          if (r.articleNumber) articleNumbers.add(String(r.articleNumber));
        }
        if (onProgress) onProgress({ collected: articleNumbers.size, total: totalRecords, page, totalPages });
      } catch (err) {
        console.warn(`[IEEE API] 第 ${page} 页获取失败:`, err.message);
        if (err.message.includes('403') || err.message.includes('401')) throw err;
      }
      if (signal?.aborted) throw new DOMException('用户取消', 'AbortError');
    }
    return Array.from(articleNumbers);
  }

  // ──────────────────────────────────────────────────────────
  // 收集完整元数据（用于手动构建 RIS）
  // ──────────────────────────────────────────────────────────

  async function collectAllMetadata(options, onProgress, signal) {
    const { queryText, rowsPerPage = 100, queryParams = {} } = options;
    const firstPage = await fetchSearchPage({ queryText, pageNumber: 1, rowsPerPage, queryParams });
    const totalPages = firstPage.totalPages;
    const allRecords = [...firstPage.records];

    if (onProgress) onProgress({ collected: allRecords.length, total: firstPage.totalRecords, page: 1, totalPages });
    if (signal?.aborted) throw new DOMException('用户取消', 'AbortError');

    for (let page = 2; page <= totalPages; page++) {
      if (page > 2) await sleep(300);
      try {
        const pageData = await fetchSearchPage({ queryText, pageNumber: page, rowsPerPage, queryParams });
        allRecords.push(...(pageData.records || []));
        if (onProgress) onProgress({ collected: allRecords.length, total: firstPage.totalRecords, page, totalPages });
      } catch (err) {
        console.warn(`[IEEE API] 第 ${page} 页元数据获取失败:`, err.message);
      }
      if (signal?.aborted) throw new DOMException('用户取消', 'AbortError');
    }
    return allRecords;
  }

  // ──────────────────────────────────────────────────────────
  // RIS 构造器：从搜索 API 的 JSON 数据直接构建 RIS
  // ──────────────────────────────────────────────────────────

  /**
   * 将搜索 API 返回的单条 record 转换为 RIS 格式
   */
  function recordToRIS(record, includeAbstract = true) {
    const lines = [];
    const a = (val) => val || '';

    // TY - Type of reference
    const ct = a(record.contentType || record.publicationType).toUpperCase();
    if (ct.includes('JOURNAL') || ct.includes('PERIODICAL') || ct.includes('MAGAZINE') || ct.includes('EARLY_ACCESS')) {
      lines.push('TY  - JOUR');
    } else if (ct.includes('CONFERENCE') || ct.includes('PROCEEDING')) {
      lines.push('TY  - CONF');
    } else if (ct.includes('BOOK')) {
      lines.push('TY  - BOOK');
    } else if (ct.includes('STANDARD')) {
      lines.push('TY  - STAND');
    } else {
      lines.push('TY  - JOUR'); // 默认期刊
    }

    // TI - Title
    lines.push(`TI  - ${a(record.articleTitle || record.title)}`);

    // AU - Authors
    const authors = record.authors?.authors || record.authors || [];
    if (Array.isArray(authors)) {
      for (const au of authors) {
        const name = au.preferredName || au.name || au.authorName || '';
        lines.push(`AU  - ${name || a(au.fullName) || a(au.lastName) + (au.firstName ? ', ' + au.firstName : '')}`);
      }
    }

    // PY - Year, DA - Date
    const year = record.publicationYear || record.publication_date || '';
    const pubDate = record.publicationDate || record.publisherDate || '';
    if (year) lines.push(`PY  - ${year}`);
    if (pubDate) lines.push(`DA  - ${pubDate}`);

    // SP/EP - Pages
    if (record.startPage) lines.push(`SP  - ${record.startPage}`);
    if (record.endPage) lines.push(`EP  - ${record.endPage}`);

    // VL/IS - Volume/Issue
    if (record.volume) lines.push(`VL  - ${record.volume}`);
    if (record.issue || record.number) lines.push(`IS  - ${a(record.issue || record.number)}`);

    // JO/JF - Journal/Publication name
    const pubTitle = a(record.publicationTitle || record.publicationName);
    if (pubTitle) {
      lines.push(`JO  - ${pubTitle}`);
      lines.push(`JF  - ${pubTitle}`);
    }

    // PB - Publisher
    if (record.publisher) lines.push(`PB  - ${record.publisher}`);
    else lines.push(`PB  - IEEE`);

    // SN - ISSN/ISBN
    if (record.issn) lines.push(`SN  - ${record.issn}`);
    else if (record.isbn) lines.push(`SN  - ${record.isbn}`);

    // DO - DOI
    if (record.doi) lines.push(`DO  - ${record.doi}`);

    // UR - URL
    if (record.documentLink) {
      lines.push(`UR  - https://ieeexplore.ieee.org${record.documentLink}`);
    } else if (record.articleNumber) {
      lines.push(`UR  - https://ieeexplore.ieee.org/document/${record.articleNumber}`);
    }

    // N2 - Abstract
    if (includeAbstract && record.abstract) {
      // RIS 中的多行内容需要续行以空格开头
      const abs = record.abstract.replace(/\r?\n/g, '\n   ');
      lines.push(`N2  - ${abs}`);
    } else if (includeAbstract && record.abstractText) {
      const abs = record.abstractText.replace(/\r?\n/g, '\n   ');
      lines.push(`N2  - ${abs}`);
    }

    // KW - Keywords
    const ieeeTerms = record.ieeeTerms || record.indexTerms?.ieeeTerms || [];
    const authorTerms = record.authorTerms || record.indexTerms?.authorTerms || [];
    const keywords = [...(Array.isArray(ieeeTerms) ? ieeeTerms : []), ...(Array.isArray(authorTerms) ? authorTerms : [])];
    for (const kw of keywords) {
      if (kw) lines.push(`KW  - ${kw}`);
    }

    // AN - Accession Number (用 articleNumber)
    if (record.articleNumber) lines.push(`AN  - ${record.articleNumber}`);

    // ER - End of Record
    lines.push('ER  - ');
    lines.push(''); // 空行分隔

    return lines.join('\n');
  }

  /**
   * 主方法：从搜索元数据构建完整 RIS 文件
   */
  function buildRISFromMetadata(records, citationsFormat = 'citation-and-abstract') {
    const includeAbstract = citationsFormat === 'citation-and-abstract';
    const risBlocks = [];
    for (const record of records) {
      try {
        const ris = recordToRIS(record, includeAbstract);
        if (ris.trim()) risBlocks.push(ris);
      } catch (e) {
        console.warn('[IEEE API] 单条记录 RIS 构建失败:', e.message);
      }
    }
    return risBlocks.join('\n');
  }

  // ──────────────────────────────────────────────────────────
  // 备用：尝试寻找可用的下载端点
  // ──────────────────────────────────────────────────────────

  function extractCSRFToken() {
    const metaCsrf = document.querySelector('meta[name="csrf-token"], meta[name="_csrf"]');
    if (metaCsrf) return metaCsrf.getAttribute('content');

    const cookies = document.cookie.split(';');
    for (const c of cookies) {
      const [name, value] = c.trim().split('=');
      if (name === '_csrf' || name === 'XSRF-TOKEN' || name === 'csrfToken') {
        return decodeURIComponent(value);
      }
    }

    if (typeof window._csrf !== 'undefined') return window._csrf;
    if (window.csrfToken) return window.csrfToken;

    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const match = script.textContent?.match(/(?:_csrf|csrfToken|csrf_token)\s*[:=]\s*["']([^"']+)["']/);
      if (match) return match[1];
    }
    return null;
  }

  async function tryAllDownloadEndpoints(articleNumbers, citationsFormat, format, signal) {
    const csrfToken = extractCSRFToken();

    const strategies = [];

    // 每个候选端点两种方法：fetch 和 XHR
    for (const baseUrl of DOWNLOAD_CANDIDATES) {
      strategies.push({
        name: `fetch -> ${baseUrl.split('/').pop()}`,
        fn: async () => {
          const formBody = new URLSearchParams();
          formBody.append('recordIds', articleNumbers.join(','));
          formBody.append('citations-format', citationsFormat);
          formBody.append('download-format', format);
          if (csrfToken) formBody.append('_csrf', csrfToken);

          const headers = {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'text/plain, */*',
            'Referer': window.location.href
          };
          if (csrfToken) {
            headers['X-CSRF-Token'] = csrfToken;
            headers['X-XSRF-TOKEN'] = csrfToken;
          }

          const resp = await fetch(baseUrl, {
            method: 'POST', headers, credentials: 'include',
            body: formBody.toString(), signal
          });

          const text = await resp.text();
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          if (text.includes('<!DOCTYPE') || text.includes('<html') || text.includes('<script>')) {
            throw new Error(`返回了 HTML (${text.slice(0, 80)})`);
          }
          return text;
        }
      });

      strategies.push({
        name: `XHR -> ${baseUrl.split('/').pop()}`,
        fn: () => new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', baseUrl, true);
          xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
          xhr.setRequestHeader('Accept', 'text/plain, */*');
          xhr.setRequestHeader('Referer', window.location.href);
          if (csrfToken) xhr.setRequestHeader('X-CSRF-Token', csrfToken);
          xhr.withCredentials = true;
          if (signal) signal.addEventListener('abort', () => xhr.abort());
          xhr.timeout = 15000;

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              const t = xhr.responseText;
              if (t.includes('<!DOCTYPE') || t.includes('<html') || t.includes('<script>')) {
                reject(new Error(`返回了 HTML (${t.slice(0,80)})`));
              } else resolve(t);
            } else reject(new Error(`HTTP ${xhr.status}`));
          };
          xhr.onerror = () => reject(new Error('XHR 网络错误'));
          xhr.ontimeout = () => reject(new Error('XHR 超时'));

          const formBody = new URLSearchParams();
          formBody.append('recordIds', articleNumbers.join(','));
          formBody.append('citations-format', citationsFormat);
          formBody.append('download-format', format);
          if (csrfToken) formBody.append('_csrf', csrfToken);
          xhr.send(formBody.toString());
        })
      });
    }

    // 逐个尝试
    for (const s of strategies) {
      try {
        console.log(`[IEEE API] 尝试: ${s.name}`);
        const text = await s.fn();
        if (text && text.trim()) {
          console.log(`[IEEE API] 成功: ${s.name} (${text.length} 字符)`);
          return text;
        }
      } catch (e) {
        console.warn(`[IEEE API] 失败: ${s.name} - ${e.message}`);
      }
    }
    return null;
  }

  // ──────────────────────────────────────────────────────────
  // 主下载入口：先尝试端点，失败则从元数据构建
  // ──────────────────────────────────────────────────────────

  async function downloadRISBatch(articleNumbers, options = {}) {
    const {
      format = 'download-ris',
      citationsFormat = 'citation-and-abstract',
      signal,
      metadataRecords = null  // 可选：传入已收集的元数据用于 fallback
    } = options;

    if (!articleNumbers || articleNumbers.length === 0) return '';

    // 步骤1：尝试所有下载端点
    console.log(`[IEEE API] 尝试下载 ${articleNumbers.length} 篇文献...`);
    const endpointResult = await tryAllDownloadEndpoints(articleNumbers, citationsFormat, format, signal);
    if (endpointResult) {
      console.log('[IEEE API] 下载端点可用，获得 RIS 数据');
      return endpointResult;
    }

    // 步骤2：从元数据构建 RIS
    if (metadataRecords && metadataRecords.length > 0) {
      console.log('[IEEE API] 下载端点不可用，从搜索元数据构建 RIS...');
      return buildRISFromMetadata(metadataRecords, citationsFormat);
    }

    throw new Error('所有下载端点不可用，且没有可用的元数据');
  }

  async function downloadAllRIS(allArticleNumbers, options = {}) {
    const {
      batchSize = 50, delayMs = 500,
      risFormat = 'download-ris', citationsFormat = 'citation-and-abstract',
      onProgress, signal,
      metadataRecords = null  // ★ 全部已收集的元数据
    } = options;

    const total = allArticleNumbers.length;
    const batches = [];
    const risPieces = [];
    let downloaded = 0;
    let failedBatches = 0;

    for (let i = 0; i < total; i += batchSize) {
      batches.push(allArticleNumbers.slice(i, i + batchSize));
    }

    console.log(`[IEEE API] 将分 ${batches.length} 批处理 ${total} 篇文献`);

    for (let i = 0; i < batches.length; i++) {
      if (signal?.aborted) throw new DOMException('用户取消', 'AbortError');

      const batch = batches[i];

      // 找出这批对应的元数据
      const batchIds = new Set(batch);
      const batchMetadata = metadataRecords
        ? metadataRecords.filter(r => batchIds.has(String(r.articleNumber)))
        : null;

      let retryCount = 0;
      const maxRetries = 2;

      while (retryCount <= maxRetries) {
        try {
          const risText = await downloadRISBatch(batch, {
            format: risFormat, citationsFormat, signal,
            metadataRecords: batchMetadata
          });

          if (risText && risText.trim()) {
            risPieces.push(risText);
            downloaded += batch.length;
            if (onProgress) {
              onProgress({ downloaded, total, batch: i + 1, totalBatches: batches.length });
            }
            console.log(`[IEEE API] 第 ${i + 1}/${batches.length} 批完成`);
            break;
          }
        } catch (err) {
          retryCount++;
          console.warn(`[IEEE API] 第 ${i + 1} 批失败 (${retryCount}/${maxRetries + 1}):`, err.message);
          if (retryCount > maxRetries) {
            failedBatches++;
            break;
          }
          await sleep(Math.min(delayMs * Math.pow(2, retryCount), 10000));
        }
      }

      if (i < batches.length - 1) await sleep(delayMs);
    }

    if (downloaded === 0) {
      throw new Error(
        `所有 ${batches.length} 批处理均失败。\n\n` +
        `下载端点 (/xpl/downloadCitations) 已 404 不可用。\n` +
        `元数据构建 RIS 也未成功。\n\n` +
        `请尝试：1) 刷新 IEEE 页面后重试 2) 确认已登录`
      );
    }

    return {
      risText: risPieces.join('\n'),
      stats: {
        totalRequested: total,
        totalDownloaded: downloaded,
        batchesCompleted: risPieces.length,
        batchesTotal: batches.length,
        failedBatches,
        usedEndpoint: false  // 标记是否用了端点
      }
    };
  }

  /**
   * 从文章详情 API 获取单篇文章的完整摘要
   * /rest/document/{articleNumber}/abstract 返回 JSON: { title, abstract, ... }
   */
  async function fetchFullAbstract(articleNumber, signal) {
    const url = `${DOC_URL}${articleNumber}/abstract`;
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json, text/plain, */*', 'Referer': window.location.href },
        credentials: 'include',
        signal
      });
      if (!resp.ok) return null;  // 404/403 等静默跳过
      const data = await resp.json();
      // 返回完整摘要文本（取最长的可选字段）
      return data.abstract || data.text || data.content || null;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      return null;  // 网络错误，静默跳过
    }
  }

  /**
   * 批量获取完整摘要，用文档 API 的完整摘要替换搜索 API 的截断摘要
   * @param {Array} records - 搜索 API 收集的元数据记录
   * @param {Object} options
   * @param {number} options.delayMs - 请求间隔
   * @param {number} options.batchSize - 并发数（1-5，太大容易限流）
   * @param {Function} options.onProgress - 进度回调 ({ enriched, total, current })
   * @param {AbortSignal} options.signal
   * @returns {Promise<{records: Array, stats: Object}>}
   */
  async function enrichWithFullAbstracts(records, options = {}) {
    const {
      delayMs = 250,
      batchSize = 3,   // 并发 3 个请求
      onProgress,
      signal
    } = options;

    if (!records || records.length === 0) return { records, stats: { enriched: 0, total: 0, failed: 0 } };

    const total = records.length;
    let enriched = 0;
    let failed = 0;
    let skipped = 0;

    console.log(`[IEEE API] 开始获取 ${total} 篇文章的完整摘要 (并发=${batchSize}, 间隔=${delayMs}ms)...`);

    // 处理多个并发批次
    for (let i = 0; i < total; i += batchSize) {
      if (signal?.aborted) throw new DOMException('用户取消', 'AbortError');

      const batch = records.slice(i, i + batchSize);
      const promises = batch.map(async (record) => {
        const an = record.articleNumber;
        if (!an) { skipped++; return; }

        // 先检查搜索 API 的摘要是否已完整（超过 500 字符通常完整）
        const currentAbstract = record.abstract || record.abstractText || '';
        if (currentAbstract.length > 500) {
          // 已经很完整了，跳过
          return;
        }

        const fullAbs = await fetchFullAbstract(an, signal);
        if (fullAbs && fullAbs.length > currentAbstract.length) {
          record.abstract = fullAbs;
          enriched++;
        } else if (fullAbs) {
          // API 返回了但更短，保留原来的
          failed++;
        } else {
          failed++;
        }
      });

      await Promise.all(promises);

      if (onProgress) {
        onProgress({ enriched, total, failed, current: Math.min(i + batchSize, total) });
      }

      if (i + batchSize < total) {
        await sleep(delayMs);
      }
    }

    console.log(`[IEEE API] 完整摘要获取完成: ${enriched} 篇已增强, ${failed} 篇无变化, ${skipped} 篇跳过`);
    return {
      records,
      stats: { enriched, total, failed, skipped }
    };
  }
  // ──────────────────────────────────────────────────────────

  function extractArticleNumbersFromDOM() {
    window.scrollTo(0, document.body.scrollHeight);
    const elements = document.querySelectorAll('a.icon-pdf[data-artnum]');
    const numbers = new Set();
    for (const el of elements) {
      const num = el.getAttribute('data-artnum');
      if (num) numbers.add(num);
    }
    return Array.from(numbers);
  }

  function extractTotalCountFromDOM() {
    const countEl = document.querySelector('.Dashboard-header-count, .results-stats, [data-total-records]');
    if (countEl) {
      const match = countEl.textContent.match(/([\d,]+)/);
      if (match) return parseInt(match[1].replace(/,/g, ''), 10);
    }
    if (window.xploreGlobal?.searchResult?.totalRecords) {
      return window.xploreGlobal.searchResult.totalRecords;
    }
    return null;
  }

  // ──────────────────────────────────────────────────────────
  // 诊断
  // ──────────────────────────────────────────────────────────

  async function runDiagnostics() {
    const results = [];
    results.push({ check: '页面 URL', value: window.location.href });
    results.push({ check: 'Cookie', value: document.cookie ? document.cookie.split(';').filter(c => c.trim()).length + ' 个' : '无' });
    results.push({ check: 'CSRF Token', value: extractCSRFToken() || '未找到' });

    // 测试每个下载端点
    for (const url of DOWNLOAD_CANDIDATES) {
      try {
        const formBody = new URLSearchParams();
        formBody.append('recordIds', '1');
        formBody.append('citations-format', 'citation-only');
        formBody.append('download-format', 'download-ris');

        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'text/plain, */*', 'Referer': window.location.href },
          credentials: 'include',
          body: formBody.toString()
        });
        const preview = await resp.text().catch(() => '无法读取');
        results.push({
          check: `端点 ${url.split('/').pop()}`,
          value: `HTTP ${resp.status}, ${preview.slice(0, 60)}`
        });
      } catch (e) {
        results.push({ check: `端点 ${url.split('/').pop()}`, value: `失败: ${e.message}` });
      }
    }

    // 测试搜索 API（必过）
    try {
      const tr = await fetch(SEARCH_URL, {
        method: 'POST', headers: DEFAULT_HEADERS, credentials: 'include',
        body: JSON.stringify({ newsearch: true, queryText: 'test', pageNumber: 1, rowsPerPage: 1 })
      });
      const j = await tr.json();
      const sample = j.records?.[0];
      results.push({ check: '搜索 API', value: `HTTP ${tr.status}, ${j.totalRecords || 0} 条结果` });
      if (sample) {
        results.push({ check: '示例字段', value: `title=${(sample.articleTitle||'').slice(0,30)}, doi=${sample.doi||'N/A'}, authors=${Array.isArray(sample.authors?.authors)?'Y':'N'}` });
      }
    } catch (e) {
      results.push({ check: '搜索 API', value: `失败: ${e.message}` });
    }

    return results;
  }

  // ──────────────────────────────────────────────────────────
  // 工具
  // ──────────────────────────────────────────────────────────

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  return {
    parseSearchUrl,
    fetchSearchPage,
    collectAllArticleNumbers,
    collectAllMetadata,
    recordToRIS,
    buildRISFromMetadata,
    downloadRISBatch,
    downloadAllRIS,
    tryAllDownloadEndpoints,
    fetchFullAbstract,
    enrichWithFullAbstracts,
    extractArticleNumbersFromDOM,
    extractTotalCountFromDOM,
    extractCSRFToken,
    runDiagnostics,
    sleep
  };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = IEEE_API; }
