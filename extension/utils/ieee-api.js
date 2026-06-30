/**
 * IEEE Xplore API 封装层 v3 — 极简版
 *
 * 核心理念：
 *   搜索元数据 → CrossRef 完整摘要 → 自建 RIS
 *   不依赖任何 IEEE 下载端点（均已 404 下线）
 */

const IEEE_API = (() => {
  'use strict';

  const SEARCH_URL = 'https://ieeexplore.ieee.org/rest/search';

  const DEFAULT_HEADERS = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*'
  };

  // ── 搜索 ─────────────────────────────────────────────────

  function parseSearchUrl(url) {
    const urlObj = new URL(url);
    const params = urlObj.searchParams;
    const queryText = params.get('queryText') || '';
    const queryParams = {};
    for (const k of ['queryText','highlight','returnType','matchPubs',
      'ranges','returnFacets','rowsPerPage','sortType','searchWithin','refinements']) {
      const v = params.get(k);
      if (v !== null && v !== undefined) queryParams[k] = v;
    }
    return { queryText, queryParams };
  }

  async function fetchSearchPage({ queryText, pageNumber = 1, rowsPerPage = 100, queryParams = {} }) {
    const payload = {
      newsearch: true, queryText,
      highlight: true, returnFacets: ['ALL'],
      returnType: queryParams.returnType || 'SEARCH',
      pageNumber, rowsPerPage
    };
    const resp = await fetch(SEARCH_URL, {
      method: 'POST', headers: DEFAULT_HEADERS,
      credentials: 'include', body: JSON.stringify(payload)
    });
    if (!resp.ok) throw new Error(`搜索请求失败 (HTTP ${resp.status})`);
    const data = await resp.json();
    return { records: data.records || [], totalRecords: data.totalRecords || 0, totalPages: data.totalPages || 1 };
  }

  // ── 元数据收集 ───────────────────────────────────────────

  async function collectAllMetadata(options, onProgress, signal) {
    const { queryText, rowsPerPage = 100, queryParams = {} } = options;
    const firstPage = await fetchSearchPage({ queryText, pageNumber: 1, rowsPerPage, queryParams });
    const allRecords = [...firstPage.records];

    if (onProgress) onProgress({ collected: allRecords.length, total: firstPage.totalRecords, page: 1, totalPages: firstPage.totalPages });
    if (signal?.aborted) throw new DOMException('用户取消', 'AbortError');

    for (let page = 2; page <= firstPage.totalPages; page++) {
      if (page > 2) await sleep(300);
      try {
        const pageData = await fetchSearchPage({ queryText, pageNumber: page, rowsPerPage, queryParams });
        allRecords.push(...(pageData.records || []));
        if (onProgress) onProgress({ collected: allRecords.length, total: firstPage.totalRecords, page, totalPages: firstPage.totalPages });
      } catch (err) {
        console.warn(`[IEEE] 第 ${page} 页失败:`, err.message);
      }
      if (signal?.aborted) throw new DOMException('用户取消', 'AbortError');
    }
    return allRecords;
  }

  // ── RIS 构造器 ───────────────────────────────────────────

  function recordToRIS(record, includeAbstract = true) {
    const lines = [];
    const a = v => v || '';

    const ct = a(record.contentType || record.publicationType).toUpperCase();
    if (ct.includes('CONFERENCE') || ct.includes('PROCEEDING')) lines.push('TY  - CONF');
    else if (ct.includes('BOOK')) lines.push('TY  - BOOK');
    else if (ct.includes('STANDARD')) lines.push('TY  - STAND');
    else lines.push('TY  - JOUR');

    lines.push(`TI  - ${a(record.articleTitle || record.title)}`);

    const authors = record.authors?.authors || record.authors || [];
    if (Array.isArray(authors)) {
      for (const au of authors) {
        const name = au.preferredName || au.name || au.authorName || a(au.fullName) || a(au.lastName);
        lines.push(`AU  - ${name}`);
      }
    }

    if (record.publicationYear) lines.push(`PY  - ${record.publicationYear}`);
    if (record.publicationDate) lines.push(`DA  - ${record.publicationDate}`);
    if (record.startPage) lines.push(`SP  - ${record.startPage}`);
    if (record.endPage) lines.push(`EP  - ${record.endPage}`);
    if (record.volume) lines.push(`VL  - ${record.volume}`);
    if (record.issue || record.number) lines.push(`IS  - ${a(record.issue || record.number)}`);

    const pubTitle = a(record.publicationTitle || record.publicationName);
    if (pubTitle) { lines.push(`JO  - ${pubTitle}`); lines.push(`JF  - ${pubTitle}`); }

    lines.push(`PB  - ${record.publisher || 'IEEE'}`);
    if (record.issn) lines.push(`SN  - ${record.issn}`);
    else if (record.isbn) lines.push(`SN  - ${record.isbn}`);
    if (record.doi) lines.push(`DO  - ${record.doi}`);

    if (record.documentLink) lines.push(`UR  - https://ieeexplore.ieee.org${record.documentLink}`);
    else if (record.articleNumber) lines.push(`UR  - https://ieeexplore.ieee.org/document/${record.articleNumber}`);

    if (includeAbstract && (record.abstract || record.abstractText)) {
      const abs = (record.abstract || record.abstractText).replace(/\r?\n/g, '\n   ');
      lines.push(`N2  - ${abs}`);
    }

    const ieeeTerms = record.ieeeTerms || record.indexTerms?.ieeeTerms || [];
    const authorTerms = record.authorTerms || record.indexTerms?.authorTerms || [];
    for (const kw of [...(Array.isArray(ieeeTerms)?ieeeTerms:[]), ...(Array.isArray(authorTerms)?authorTerms:[])]) {
      if (kw) lines.push(`KW  - ${kw}`);
    }

    if (record.articleNumber) lines.push(`AN  - ${record.articleNumber}`);
    lines.push('ER  - ');
    lines.push('');
    return lines.join('\n');
  }

  function buildRISFromMetadata(records, citationsFormat) {
    const includeAbstract = citationsFormat === 'citation-and-abstract';
    return records.map(r => { try { return recordToRIS(r, includeAbstract); } catch(e) { return ''; } })
      .filter(Boolean).join('\n');
  }

  // ── 完整摘要（三层后备）─────────────────────────────────

  function stripHtmlTags(raw) {
    try {
      const doc = new DOMParser().parseFromString(raw, 'text/html');
      return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
    } catch(e) {
      return raw.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    }
  }

  /**
   * 尝试多个免费 API，取最长的摘要
   */
  async function fetchFullAbstract(doi, signal) {
    if (!doi) return null;

    // ★ 三个源并行请求（host_permissions 已加，CORS已解决）
    const sources = [
      {
        name: 'CrossRef',
        fn: async () => {
          const resp = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
            headers: { 'Accept': 'application/json' }, signal
          });
          if (!resp.ok) return null;
          const data = await resp.json();
          return stripHtmlTags(data?.message?.abstract || '');
        }
      },
      {
        name: 'Semantic Scholar',
        fn: async () => {
          const resp = await fetch(
            `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=abstract`,
            { headers: { 'Accept': 'application/json' }, signal }
          );
          if (!resp.ok) return null;
          const data = await resp.json();
          return (data?.abstract || '').trim();
        }
      },
      {
        name: 'OpenAlex',
        fn: async () => {
          const resp = await fetch(
            `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?select=abstract_inverted_index`,
            { headers: { 'Accept': 'application/json' }, signal }
          );
          if (!resp.ok) return null;
          const data = await resp.json();
          const inv = data?.abstract_inverted_index;
          if (!inv) return null;
          const words = [];
          for (const [word, positions] of Object.entries(inv)) {
            for (const pos of positions) words[pos] = word;
          }
          return words.filter(Boolean).join(' ');
        }
      }
    ];

    const results = await Promise.allSettled(sources.map(s => s.fn()));
    let best = '', bestName = '';

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled' && r.value && r.value.length > best.length) {
        best = r.value;
        bestName = sources[i].name;
      }
    }

    if (best && bestName) {
      console.log(`[摘要] ${doi.slice(0,20)}... → ${bestName}:${best.length}字符`);
    }
    return best || null;
  }

  async function enrichWithFullAbstracts(records, options = {}) {
    // ★ 降低并发避免 429：2并发、500ms间隔
    const { delayMs = 100, batchSize = 6, onProgress, signal } = options;
    if (!records || records.length === 0) return { records, stats: { enriched: 0, total: 0 } };

    const total = records.length;
    let enriched = 0, noBetter = 0, skipped = 0;

    if (total > 0) {
      const first = records[0];
      console.log(`[摘要] 开始 ${total}篇 | 样例DOI=${first.doi} | 搜索=${(first.abstract||'').length}字符 | 尾部="${(first.abstract||'').slice(-40)}"`);
    }

    for (let i = 0; i < total; i += batchSize) {
      if (signal?.aborted) throw new DOMException('用户取消', 'AbortError');
      const batch = records.slice(i, i + batchSize);

      // ★ 并行处理每个 batch（2 DOI × 3 API = 6 并发，安全）
      await Promise.all(batch.map(async (record) => {
        if (!record.doi) { skipped++; return; }
        const currentAbs = record.abstract || record.abstractText || '';
        const fullAbs = await fetchFullAbstract(record.doi, signal);

        if (fullAbs && fullAbs.length > currentAbs.length) {
          record.abstract = fullAbs;
          enriched++;
        } else {
          noBetter++;
        }
      }));

      if (onProgress) onProgress({ enriched, noChange: noBetter, total, current: Math.min(i + batchSize, total) });
      if (i + batchSize < total) await sleep(delayMs);
    }

    console.log(`[摘要] 完成: ${enriched}增强 ${noBetter}不变 ${skipped}跳过 | 尾部="${(records[0].abstract||'').slice(-40)}"`);
    return { records, stats: { enriched, noBetter, total, skipped } };
  }

  // ── 诊断 ─────────────────────────────────────────────────

  async function runDiagnostics() {
    const results = [];
    results.push({ check: '页面 URL', value: window.location.href });
    results.push({ check: 'Cookie', value: document.cookie ? document.cookie.split(';').filter(c => c.trim()).length + ' 个' : '无' });

    // 搜索 API
    try {
      const tr = await fetch(SEARCH_URL, {
        method: 'POST', headers: DEFAULT_HEADERS, credentials: 'include',
        body: JSON.stringify({ newsearch: true, queryText: 'test', pageNumber: 1, rowsPerPage: 1 })
      });
      const j = await tr.json();
      const s = j.records?.[0];
      results.push({ check: '搜索 API', value: `HTTP ${tr.status}, ${j.totalRecords || 0} 条` });
      if (s) results.push({ check: 'DOI 样例', value: `${s.doi || 'N/A'} (title: ${(s.articleTitle||'').slice(0,30)})` });
    } catch (e) {
      results.push({ check: '搜索 API', value: `失败: ${e.message}` });
    }

    // CrossRef
    try {
      const cr = await fetch('https://api.crossref.org/works/10.1109/FASTA61401.2024.10595184', {
        headers: { 'Accept': 'application/json' }
      });
      const cd = await cr.json();
      const abs = cd?.message?.abstract || '';
      results.push({ check: 'CrossRef API', value: `HTTP ${cr.status}, 摘要${abs.length}字符, 尾部="${abs.slice(-30)}"` });
    } catch (e) {
      results.push({ check: 'CrossRef API', value: `失败: ${e.message}` });
    }

    return results;
  }

  // ── 工具 ─────────────────────────────────────────────────

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  return {
    parseSearchUrl, fetchSearchPage, collectAllMetadata,
    recordToRIS, buildRISFromMetadata,
    fetchFullAbstract, enrichWithFullAbstracts,
    runDiagnostics, sleep
  };
})();
