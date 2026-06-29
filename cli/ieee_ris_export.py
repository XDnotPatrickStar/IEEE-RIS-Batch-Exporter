#!/usr/bin/env python3
"""
IEEE Xplore RIS 批量下载器 — Python CLI 备选方案

使用方法:
    python ieee_ris_export.py --url "<IEEE搜索URL>" --cookie "<浏览器Cookie字符串>"

获取 Cookie 的方法:
    1. 在 Chrome 中登录 IEEE Xplore
    2. 按 F12 打开开发者工具 → Application → Cookies → ieeexplore.ieee.org
    3. 复制所有 Cookie 的 name=value 对，用 "; " 连接
    或者直接复制请求头中的 Cookie 字段值
"""

import argparse
import re
import sys
import time
import json
from urllib.parse import urlparse, parse_qs, urlencode
from typing import Optional

import requests


class IEEERISExporter:
    """IEEE Xplore RIS 批量导出器"""

    SEARCH_URL = "https://ieeexplore.ieee.org/rest/search"
    DOWNLOAD_URL = "https://ieeexplore.ieee.org/xpl/downloadCitations"

    def __init__(self, cookie_string: str, delay_ms: int = 500, batch_size: int = 50):
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Referer": "https://ieeexplore.ieee.org/",
        })

        # 解析并设置 Cookie
        if cookie_string:
            for item in cookie_string.split(";"):
                item = item.strip()
                if "=" in item:
                    name, value = item.split("=", 1)
                    self.session.cookies.set(name.strip(), value.strip())

        self.delay_ms = delay_ms
        self.batch_size = batch_size

    def _parse_search_url(self, url: str) -> dict:
        """从 IEEE 搜索 URL 中提取查询参数"""
        parsed = urlparse(url)
        params = parse_qs(parsed.query)

        result = {}
        for key in ["queryText", "highlight", "returnType", "matchPubs",
                     "ranges", "returnFacets", "sortType", "searchWithin"]:
            if key in params:
                result[key] = params[key][0]

        return result

    def fetch_search_page(self, query_text: str, page_number: int = 1,
                          rows_per_page: int = 100, **kwargs) -> dict:
        """获取单页搜索结果"""
        payload = {
            "newsearch": True,
            "queryText": query_text,
            "highlight": True,
            "returnFacets": ["ALL"],
            "returnType": "SEARCH",
            "pageNumber": page_number,
            "rowsPerPage": rows_per_page,
        }

        resp = self.session.post(self.SEARCH_URL, json=payload, timeout=30)
        resp.raise_for_status()
        return resp.json()

    def collect_all_article_numbers(self, query_text: str,
                                     rows_per_page: int = 100) -> list[str]:
        """收集全部搜索结果的文章编号"""
        print(f"[1/3] 正在获取第 1 页搜索结果...")

        first_page = self.fetch_search_page(query_text, 1, rows_per_page)
        total_records = first_page.get("totalRecords", 0)
        total_pages = first_page.get("totalPages", 1)

        print(f"  总文献数: {total_records}")
        print(f"  总页数: {total_pages}")

        article_numbers = []
        for record in first_page.get("records", []):
            if record.get("articleNumber"):
                article_numbers.append(str(record["articleNumber"]))

        for page in range(2, total_pages + 1):
            print(f"  正在获取第 {page}/{total_pages} 页...", end=" ")
            try:
                data = self.fetch_search_page(query_text, page, rows_per_page)
                count = 0
                for record in data.get("records", []):
                    if record.get("articleNumber"):
                        article_numbers.append(str(record["articleNumber"]))
                        count += 1
                print(f"✓ ({count} 篇)")
            except Exception as e:
                print(f"✗ ({e})")

            time.sleep(self.delay_ms / 1000)

        # 去重
        unique = list(dict.fromkeys(article_numbers))
        print(f"  收集完成: {len(unique)} 篇唯一文献")
        return unique

    def download_ris_batch(self, article_numbers: list[str],
                            citations_format: str = "citation-and-abstract",
                            ris_format: str = "download-ris") -> str:
        """下载一批文献的 RIS 格式"""
        form_data = {
            "recordIds": ",".join(article_numbers),
            "citations-format": citations_format,
            "download-format": ris_format,
            "x": "0",
            "y": "0",
        }

        headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "text/plain, application/x-research-info-systems, */*",
        }

        resp = self.session.post(
            self.DOWNLOAD_URL,
            data=form_data,
            headers=headers,
            timeout=60
        )
        resp.raise_for_status()

        text = resp.text
        if text.strip().startswith("<!DOCTYPE") or text.strip().startswith("<html"):
            raise RuntimeError(
                "下载端点返回了 HTML 而非 RIS。请确认 Cookie 中包含有效的登录会话。"
            )
        return text

    def download_all_ris(self, article_numbers: list[str],
                          citations_format: str = "citation-and-abstract",
                          ris_format: str = "download-ris") -> str:
        """分批下载全部文献的 RIS"""
        total = len(article_numbers)
        batches = []
        for i in range(0, total, self.batch_size):
            batches.append(article_numbers[i:i + self.batch_size])

        print(f"\n[2/3] 正在下载 RIS（共 {len(batches)} 批，每批 {self.batch_size} 篇）...")

        all_ris = []
        for i, batch in enumerate(batches):
            retries = 0
            while retries <= 3:
                try:
                    ris_text = self.download_ris_batch(batch, citations_format, ris_format)
                    all_ris.append(ris_text)
                    downloaded = min((i + 1) * self.batch_size, total)
                    print(f"  第 {i+1}/{len(batches)} 批完成 "
                          f"({downloaded}/{total}, {len(batch)} 篇)")
                    break
                except Exception as e:
                    retries += 1
                    if retries > 3:
                        print(f"  第 {i+1}/{len(batches)} 批失败 (已重试 3 次): {e}")
                        break
                    wait = min(self.delay_ms * (2 ** (retries - 1)), 10000) / 1000
                    print(f"  第 {i+1}/{len(batches)} 批失败，{wait}s 后重试...")
                    time.sleep(wait)

            time.sleep(self.delay_ms / 1000)

        return "\n".join(all_ris)

    @staticmethod
    def merge_ris(ris_texts: list[str], dedup_field: str = "AN") -> str:
        """合并 RIS 文本并去重"""
        seen = set()
        unique_blocks = []

        for text in ris_texts:
            if not text.strip():
                continue
            blocks = re.split(r'(?<=ER\s{2}-\s?\n)', text)
            for block in blocks:
                block = block.strip()
                if not block:
                    continue
                match = re.search(
                    rf'^{re.escape(dedup_field)}\s{{2}}-\s(.+)$',
                    block, re.MULTILINE
                )
                if match:
                    key = match.group(1).strip()
                    if key in seen:
                        continue
                    seen.add(key)
                unique_blocks.append(block)

        result = "\n\n".join(unique_blocks) + "\n"
        return result

    @staticmethod
    def add_meta_comment(ris_text: str, meta: dict) -> str:
        """添加元信息注释"""
        lines = [
            f"# IEEE RIS Batch Export",
            f"# 导出时间: {time.strftime('%Y-%m-%d %H:%M:%S')}",
            f"# 搜索查询: {meta.get('queryText', 'N/A')}",
            f"# 总记录数: {meta.get('totalRecords', 'N/A')}",
            f"# 生成工具: IEEE RIS Batch Exporter CLI v1.0",
            f"# ==========================================",
            f"",
        ]
        return "\n".join(lines) + ris_text

    def export(self, search_url: str, output_path: str = None,
               citations_format: str = "citation-and-abstract") -> str:
        """完整导出流程"""
        # 1. 解析 URL
        params = self._parse_search_url(search_url)
        query_text = params.get("queryText", "")
        if not query_text:
            raise ValueError("无法从 URL 中提取 queryText 参数，请检查 URL 是否正确。")

        print(f"查询: {query_text}")
        print(f"输出: {output_path or '自动生成'}")
        print()

        # 2. 收集文章编号
        article_numbers = self.collect_all_article_numbers(query_text)
        if not article_numbers:
            print("错误: 未找到任何文献。")
            sys.exit(1)

        # 3. 下载 RIS
        ris_texts_raw = self.download_all_ris(article_numbers, citations_format)

        # 4. 合并去重
        print(f"\n[3/3] 正在合并去重...")
        merged = self.merge_ris([ris_texts_raw])
        record_count = len(re.findall(r'^ER\s{2}-\s', merged, re.MULTILINE))
        print(f"  唯一记录数: {record_count}")

        # 5. 添加元信息
        final = self.add_meta_comment(merged, {
            "queryText": query_text,
            "totalRecords": record_count,
        })

        # 6. 保存文件
        if not output_path:
            query_snippet = re.sub(r'[^a-zA-Z0-9一-鿿\s-]', '',
                                   query_text)[:50].strip().replace(" ", "_")
            timestamp = time.strftime("%Y%m%d_%H%M%S")
            output_path = f"IEEE_{query_snippet}_{timestamp}.ris"

        with open(output_path, "w", encoding="utf-8") as f:
            f.write(final)

        print(f"\n✅ 导出完成: {output_path}")
        print(f"   共 {record_count} 篇文献（已去重）")
        return output_path


def main():
    parser = argparse.ArgumentParser(
        description="IEEE Xplore RIS 批量下载器",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python ieee_ris_export.py --url "https://ieeexplore.ieee.org/search/searchresult.jsp?queryText=machine+learning" --cookie "SessionID=xxx; Token=yyy"

获取 Cookie 的方法:
  1. Chrome → F12 → Application → Cookies → ieeexplore.ieee.org
  2. 复制所有 Cookie → 用 "; " 连接
        """
    )

    parser.add_argument("--url", "-u", required=True,
                        help="IEEE Xplore 搜索结果页的完整 URL")
    parser.add_argument("--cookie", "-c", required=True,
                        help="浏览器 Cookie 字符串 (name1=value1; name2=value2)")
    parser.add_argument("--output", "-o", default=None,
                        help="输出文件路径（默认自动生成）")
    parser.add_argument("--batch-size", "-b", type=int, default=50,
                        help="每批下载的文献数量（默认 50）")
    parser.add_argument("--delay", "-d", type=int, default=500,
                        help="批次间延迟毫秒数（默认 500）")
    parser.add_argument("--abstract-only", action="store_true",
                        help="仅导出引文，不含摘要")
    parser.add_argument("--bibtex", action="store_true",
                        help="导出 BibTeX 格式（默认 RIS）")

    args = parser.parse_args()

    # 验证 URL
    if "ieeexplore.ieee.org" not in args.url:
        print("错误: URL 必须是 ieeexplore.ieee.org 的搜索页面。")
        sys.exit(1)

    citations_format = "citation-only" if args.abstract_only else "citation-and-abstract"
    ris_format = "download-bibtex" if args.bibtex else "download-ris"

    exporter = IEEERISExporter(
        cookie_string=args.cookie,
        delay_ms=args.delay,
        batch_size=args.batch_size,
    )

    try:
        exporter.export(
            search_url=args.url,
            output_path=args.output,
            citations_format=citations_format,
        )
    except KeyboardInterrupt:
        print("\n已取消。")
        sys.exit(130)
    except Exception as e:
        print(f"\n❌ 错误: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
