# 📚 IEEE RIS Batch Exporter

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

一键批量导出 IEEE Xplore 搜索结果的全部 RIS 引文（含摘要），支持 **1000+ 篇文献**。

> 写系统性文献综述 (Systematic Literature Review) 的救星 ✨

## 🎯 解决的问题

IEEE Xplore 网页端一次只能导出当前页面显示的 10-25 篇文献。对于需要处理数百至上千篇文献的研究者来说，手动逐页导出是不可接受的重复劳动。

本扩展在搜索结果页一键完成：自动翻页 → 收集元数据 → 获取完整摘要 → 导出标准 RIS 文件。

## 🚀 安装

### Chrome / Edge

1. 打开扩展管理页面：
   - Chrome: `chrome://extensions/`
   - Edge: `edge://extensions/`
2. 开启右上角 **「开发者模式」**
3. 点击 **「加载已解压的扩展程序」**
4. 选择本项目的 `extension/` 文件夹

### 前提

- 注册 IEEE 个人账号（免费），在 IEEE Xplore 保持登录
- 无需机构订阅

## 📖 使用

1. 在 [IEEE Xplore](https://ieeexplore.ieee.org/) 完成搜索（**Advanced Search 全功能支持**）
2. 点击浏览器工具栏的扩展图标 📚
3. 确认搜索信息 → 点击 **「开始导出全部」**
4. 等待进度完成 → `.ris` 文件自动下载
5. 导入 Zotero / EndNote / Mendeley

## ⚙️ 设置

| 设置 | 说明 |
|------|------|
| 内容 | 引文 + 摘要 / 仅引文 |
| 批量大小 | 25 / 50 / 100 篇/批 |
| 批次间隔 | 300ms ~ 2000ms |
| 获取完整摘要 | 默认开启，通过 CrossRef / Semantic Scholar / OpenAlex 补全 |
| 保存位置 | 自动保存到浏览器下载目录 |

## 🔧 工作原理

```
IEEE 搜索页 URL → 提取 queryText
    ↓
POST /rest/search (IEEE 内部 API，100% 搜索一致性)
    ↓
分页收集全部元数据 (JSON: 标题、作者、DOI、摘要…)
    ↓
多源摘要补全: CrossRef → Semantic Scholar → OpenAlex → IEEE 页面
    ↓
从完整元数据直接构建标准 RIS → 去重合并 → 下载 .ris
```

- **搜索结果 100% 一致**：直接从 URL 提取 `queryText`，调用 IEEE 内部 API
- **不依赖已下线的端点**：`downloadCitations` 已 404，从元数据自建 RIS
- **完整摘要**：IEEE 搜索 API 返回的摘要是截断的，自动通过第三方 API 补全
- **进度持久化**：popup 关闭后重开也能看到实时进度

## ⚠️ 注意事项

- 登录 IEEE 个人账号（免费即可）
- 717 篇文献约 1.5-2 分钟完成（含摘要补全）
- 少数文献的摘要可能因第三方 API 未收录而无法补全（属于正常现象）

## 🐍 备选：Python CLI

```bash
cd cli/
pip install -r requirements.txt
python ieee_ris_export.py --url "IEEE搜索URL" --cookie "浏览器Cookie"
```

## 📄 许可证

MIT License

---

> 为科研工作者省下每一分钟的重复劳动 ✨
