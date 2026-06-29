# 📚 IEEE RIS Batch Exporter

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Chrome](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome)](https://www.google.com/chrome/)
[![Edge](https://img.shields.io/badge/Edge-Extension-0078D7?logo=microsoftedge)](https://www.microsoft.com/edge/)

一键批量导出 IEEE Xplore 搜索结果的全部 RIS 引文（含摘要），支持 **1000+ 篇文献** 的全自动导出。

> 写系统性文献综述 (Systematic Literature Review) 的救星 ✨

## 🎯 解决的问题

IEEE Xplore 网页端一次只能导出当前页面显示的 10-25 篇文献，且旧的 `downloadCitations` 端点已经 404 下线。对于需要处理 100-1000+ 篇文献的研究者来说，手动逐页导出是不可接受的重复劳动。

本扩展从 IEEE 内部搜索 API 获取完整元数据，**不依赖已经下线的下载端点**，直接从 JSON 构建标准 RIS 文件。

- 🔍 自动翻页收集所有文献的完整元数据（标题、作者、DOI、摘要、关键词等）
- 📥 自建标准 RIS 格式，含完整摘要
- 🔗 自动合并、去重、保存为单个 `.ris` 文件

## 🚀 安装

### Chrome / Edge

1. 打开扩展管理页面：
   - Chrome: `chrome://extensions/`
   - Edge: `edge://extensions/`
2. 开启右上角 **「开发者模式」**
3. 点击 **「加载已解压的扩展程序」**
4. 选择本项目的 `extension/` 文件夹
5. 扩展图标会出现在浏览器工具栏

### 前提条件

- 需要 **IEEE 个人账号**（免费注册即可，无需机构订阅）
- 在 IEEE Xplore 中保持登录状态

## 📖 使用方法

1. 在 [IEEE Xplore](https://ieeexplore.ieee.org/) 中完成搜索（支持 **Advanced Search** 全部功能）
2. 点击浏览器工具栏的扩展图标 📚
3. 确认搜索查询和文献总数
4. （可选）调整导出设置
5. 点击 **「开始导出全部」**
6. 等待进度完成 → 选择保存位置 → `.ris` 文件保存到本地
7. 点击「打开所在文件夹」快速定位文件
8. 导入 Zotero / EndNote / Mendeley 等文献管理工具

## ⚙️ 设置

| 设置 | 选项 | 说明 |
|------|------|------|
| 内容 | 引文 + 摘要 / 仅引文 | 推荐带摘要，便于文献筛选 |
| 批量大小 | 25 / 50 / 100 篇/批 | 不影响最终结果，仅影响处理速度 |
| 批次间隔 | 300ms ~ 2000ms | 间隔越长越稳定，推荐默认 500ms |
| 保存位置 | 每次询问 / 自动保存 | 开启则每次弹窗选位置 |

## 🔧 技术架构

```
extension/
├── manifest.json          # Manifest V3
├── background.js          # Service Worker（消息中枢 + 文件保存）
├── content.js             # 内容脚本（API 调用 + 导出流程）
├── popup/                 # 弹出窗口 UI
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── utils/
│   ├── ieee-api.js        # IEEE 内部 API 封装 + RIS 构建器
│   └── ris-merger.js      # RIS 解析与去重合并
└── icons/                 # 扩展图标
```

### 工作原理

```
搜索页 URL → 提取 queryText
    │
    ▼
POST /rest/search (IEEE 内部 API，100% 搜索结果一致性)
    │
    ▼
收集全部页面的完整元数据 (JSON)
    │
    ▼
-- 尝试 5 个下载端点（均 404 下线）--
    │  全部失败
    ▼
从 JSON 元数据直接构建标准 RIS 文件 ← 完全不依赖外部端点
    │
    ▼
AN 字段去重 → 合并 → 保存 .ris
```

### 为什么搜索结果 100% 一致？

- 直接从搜索结果 URL 提取 `queryText` 参数
- 调用 IEEE 网页自身的内部 `/rest/search` API
- 搜索参数完全复用，零转换

## 🐍 备选：Python CLI

`cli/` 目录提供了 Python 命令行工具：

```bash
cd cli/
pip install -r requirements.txt
python ieee_ris_export.py --url "IEEE搜索URL" --cookie "浏览器Cookie"
```

CLI 需要手动从浏览器复制 Cookie，使用体验不如扩展。

## ⚠️ 注意事项

- **登录**：确保在 IEEE Xplore 中已登录个人账号
- **网络稳定**：大规模导出（1000+ 篇）需要几分钟
- **文件大小**：含摘要的 1000 篇文献 RIS 文件约 2-5 MB

## 📄 许可证

MIT License — 自由使用、修改、分发。

---

> 为科研工作者省下每一分钟的重复劳动 ✨
