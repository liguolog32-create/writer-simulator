#!/usr/bin/env python3
"""抓取 /小说合集/5300本小说（一）/ 全部子目录名（去重），输出 JSON 到 stdout。"""
import json, urllib.parse
from playwright.sync_api import sync_playwright

CDP = "http://127.0.0.1:9223"
BASE = "/小说合集/5300本小说（一）"

def url_for(path):
    return f"https://pan.baidu.com/disk/main#/index?category=all&path={urllib.parse.quote(path)}"

def main():
    with sync_playwright() as p:
        b = p.chromium.connect_over_cdp(CDP)
        ctx = b.contexts[0]
        pg = ctx.pages[0] if ctx.pages else ctx.new_page()
        pg.goto(url_for(BASE), wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(4500)
        # 抓目录行：每行是文件夹（类型列显示"-"且无大小）
        folders = pg.evaluate("""() => {
          const out = [];
          const rows = [...document.querySelectorAll('[class*="row"], [class*="item"], li, tr')];
          for (const r of rows) {
            const t = (r.textContent||'').replace(/\\s+/g,' ').trim();
            if (!t) continue;
            // 目录行特征：含"文件名 大小 类型"表头或仅一个名字
            const m = t.match(/^([\\u4e00-\\u9fa5A-Za-z0-9·（）()【】\\-]+?)\\s+-\\s+文件夹$/);
            if (m) out.push(m[1]);
          }
          return [...new Set(out)];
        }""")
        pg.wait_for_timeout(1000)
        # 兜底：直接抓文件名单元
        if not folders:
            folders = pg.evaluate("""() => {
              const out = [];
              const els = [...document.querySelectorAll('[class*="name"], a[title]')];
              for (const e of els) {
                const t = (e.getAttribute('title')||e.textContent||'').trim();
                if (t && t.length < 40 && !/\\.txt$|\\.zip$|\\.epub$/.test(t)) out.push(t);
              }
              return [...new Set(out)];
            }""")
        print(json.dumps(folders, ensure_ascii=False))
        b.close()

if __name__ == "__main__":
    main()
