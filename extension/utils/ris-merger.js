/**
 * RIS 文件解析与合并工具
 *
 * RIS (Research Information Systems) 格式是学术文献管理的标准交换格式。
 * 每条记录以 "TY  - " 开头，以 "ER  - " 结尾，中间包含多个标签字段。
 *
 * 参考规范: https://en.wikipedia.org/wiki/RIS_(file_format)
 */

const RIS_MERGER = (() => {
  'use strict';

  const RECORD_END = 'ER  - ';
  const RECORD_START = 'TY  - ';

  // ================================================================
  // 解析
  // ================================================================

  /**
   * 将 RIS 文本解析为记录数组
   * @param {string} risText - 原始 RIS 文本
   * @returns {Array<{fields: Map<string, string[]>, raw: string}>}
   */
  function parseRecords(risText) {
    if (!risText || !risText.trim()) {
      return [];
    }

    const records = [];
    const lines = risText.split(/\r?\n/);

    let currentRecord = null;
    let currentFields = new Map();
    let currentRaw = [];
    let currentTag = null;
    let currentValue = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 检测记录开始
      if (line.startsWith(RECORD_START) && !currentRecord) {
        currentRecord = true;
        currentFields = new Map();
        currentRaw = [];
      }

      if (currentRecord) {
        currentRaw.push(line);

        // 检测是否为标签行（"XX  - value" 格式）
        const tagMatch = line.match(/^([A-Z0-9]{2})\s{2}-\s(.*)/);

        if (tagMatch) {
          // 有新的标签，保存上一个标签的值
          if (currentTag) {
            addFieldValue(currentFields, currentTag, currentValue);
          }
          currentTag = tagMatch[1];
          currentValue = tagMatch[2];
        } else if (line.trim() === '' || line.startsWith(' ')) {
          // 续行（以空格开头）或空行 —— 追加到当前标签值
          if (currentTag) {
            currentValue += '\n' + line;
          }
        }

        // 检测记录结束
        if (line.startsWith(RECORD_END)) {
          // 保存最后一个标签
          if (currentTag) {
            addFieldValue(currentFields, currentTag, currentValue);
          }

          records.push({
            fields: currentFields,
            raw: currentRaw.join('\n')
          });

          currentRecord = null;
          currentFields = new Map();
          currentRaw = [];
          currentTag = null;
          currentValue = '';
        }
      }
    }

    return records;
  }

  function addFieldValue(fields, tag, value) {
    if (!fields.has(tag)) {
      fields.set(tag, []);
    }
    // 去掉首尾空白，但保留内部空格
    const cleaned = value.replace(/^\s+|\s+$/g, '');
    if (cleaned) {
      fields.get(tag).push(cleaned);
    }
  }

  // ================================================================
  // 去重与合并
  // ================================================================

  /**
   * 合并多段 RIS 文本，基于 AN (Accession Number) 字段去重
   * @param {string[]} risTexts - 多个 RIS 文本片段
   * @param {Object} options
   * @param {string} options.dedupField - 用于去重的字段（默认 "AN"）
   * @param {boolean} options.keepFirst - 重复时保留第一条还是最后一条（默认 true=第一条）
   * @returns {{ text: string, stats: Object }}
   */
  function merge(risTexts, options = {}) {
    const {
      dedupField = 'AN',
      keepFirst = true
    } = options;

    const seen = new Set();
    const uniqueRecords = [];
    let totalParsed = 0;
    let totalDuplicates = 0;

    for (const risText of risTexts) {
      if (!risText || !risText.trim()) continue;

      const records = parseRecords(risText);
      totalParsed += records.length;

      for (const record of records) {
        // 获取去重字段的值
        const dedupValues = record.fields.get(dedupField);
        const dedupKey = dedupValues ? dedupValues[0] : null;

        if (dedupKey && seen.has(dedupKey)) {
          totalDuplicates++;
          if (!keepFirst) {
            // 保留最后一条：移除旧的，添加新的
            const idx = uniqueRecords.findIndex(r => {
              const vals = r.fields.get(dedupField);
              return vals && vals[0] === dedupKey;
            });
            if (idx >= 0) {
              uniqueRecords.splice(idx, 1);
              uniqueRecords.push(record);
            }
          }
          // keepFirst = true: 跳过重复
          continue;
        }

        if (dedupKey) {
          seen.add(dedupKey);
        }
        uniqueRecords.push(record);
      }
    }

    // 重新组装为 RIS 文本
    const text = uniqueRecords.map(r => r.raw).join('\n\n') + '\n';

    return {
      text,
      stats: {
        totalParsed,
        totalDuplicates,
        totalUnique: uniqueRecords.length,
        dedupField
      }
    };
  }

  /**
   * 快速合并（不做解析，仅做文本拼接 + 简单去重）
   * 适用于大量数据时的性能优化路径
   * @param {string[]} risTexts
   * @returns {{ text: string, stats: Object }}
   */
  function mergeFast(risTexts, options = {}) {
    const {
      dedupField = 'AN',
      keepFirst = true
    } = options;

    const seen = new Set();
    const allBlocks = [];
    let totalBlocks = 0;
    let totalDuplicates = 0;

    for (const risText of risTexts) {
      if (!risText || !risText.trim()) continue;

      // 按 "ER  - " 分割每条记录
      const blocks = risText.split(/(?<=ER\s{2}-\s?\r?\n)/);
      for (const block of blocks) {
        const trimmed = block.trim();
        if (!trimmed) continue;
        totalBlocks++;

        // 提取去重字段的值（正则匹配 "AN  - value"）
        const dedupRegex = new RegExp(`^${dedupField}\\s{2}-\\s(.+)$`, 'm');
        const match = trimmed.match(dedupRegex);

        if (match) {
          const dedupKey = match[1].trim();
          if (seen.has(dedupKey)) {
            totalDuplicates++;
            if (!keepFirst) {
              // 保留最后一条
              const idx = allBlocks.findIndex(b => {
                const m = b.match(dedupRegex);
                return m && m[1].trim() === dedupKey;
              });
              if (idx >= 0) {
                allBlocks[idx] = trimmed;
              }
            }
            continue;
          }
          seen.add(dedupKey);
        }

        allBlocks.push(trimmed);
      }
    }

    const text = allBlocks.join('\n\n') + '\n';

    return {
      text,
      stats: {
        totalParsed: totalBlocks,
        totalDuplicates,
        totalUnique: allBlocks.length,
        dedupField
      }
    };
  }

  // ================================================================
  // 添加元信息
  // ================================================================

  /**
   * 在 RIS 文本头部添加注释元信息
   * @param {string} risText - RIS 文本
   * @param {Object} meta - 元信息对象
   * @returns {string}
   */
  function addMetaComment(risText, meta = {}) {
    const now = new Date().toISOString();
    const lines = [
      `# IEEE RIS Batch Export`,
      `# 导出时间: ${now}`,
      `# 搜索查询: ${meta.queryText || 'N/A'}`,
      `# 总记录数: ${meta.totalRecords || 'N/A'}`,
      `# 导出格式: ${meta.format || 'RIS'}`,
      `# 内容类型: ${meta.citationsFormat || 'citation-and-abstract'}`,
      `# 生成工具: IEEE RIS Batch Exporter v1.0`,
      `# ==========================================`,
      ``
    ];
    return lines.join('\n') + risText;
  }

  // ================================================================
  // 统计
  // ================================================================

  /**
   * 统计 RIS 文本中的记录数
   * @param {string} risText
   * @returns {number}
   */
  function countRecords(risText) {
    if (!risText) return 0;
    const matches = risText.match(/^ER\s{2}-\s/gm);
    return matches ? matches.length : 0;
  }

  // ================================================================
  // 公开 API
  // ================================================================

  return {
    parseRecords,
    merge,
    mergeFast,
    addMetaComment,
    countRecords,
    RECORD_END,
    RECORD_START
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RIS_MERGER;
}
