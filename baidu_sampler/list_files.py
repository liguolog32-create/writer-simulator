#!/usr/bin/env python3
"""列出指定子目录内的文件。用法: python3 list_files.py <子目录名1> [子目录名2] ...
路径基准: /小说合集/5300本小说（一）/"""
import sys, json, urllib.parse, time
from pathlib import Path
from playwright.sync_api import sync_playwright

CDP = "http://127.0.0.1:9223"
BASE = "/小说合集/5300本小说（一）"

def url_for(path):
    return f"https://pan.baidu.com/disk/main#/index?category=all&path={urllib.parse.quote(path)}"

def list_one(pg, name):
    pg.goto(url_for(f"{BASE}/{name}"), wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_timeout(4000)
    files = pg.evaluate("""() => {
      const out = [];
      const rows = [...document.querySelectorAll('[class*="row"], [class*="item"], li, tr')];
      for (const r of rows) {
        const t = (r.textContent||'').replace(/\\s+/g,' ').trim();
        if (!t) continue;
        const m = t.match(/^(.+?\\.(txt|zip|epub|rar|pdf))\\s+([\\d.]+\\s*(KB|MB|GB))?\\s*(.+)?$/i);
        if (m) out.push(m[1].trim());
      }
      return [...new Set(out)];
    }""")
    # 兜底：抓文件名单元
    if not files:
        files = pg.evaluate("""() => {
          const out = [];
          const els = [...document.querySelectorAll('[class*="name"], a[title]')];
          for (const e of els) {
            const t = (e.getAttribute('title')||e.textContent||'').trim();
            if (t && /\\.(txt|zip|epub|rar|pdf)$/i.test(t)) out.push(t);
          }
          return [...new Set(out)];
        }""")
    return files

def main():
    names = sys.argv[1:]
    result = {}
    with sync_playwright() as p:
        b = p.chromium.connect_over_cdp(CDP)
        ctx = b.contexts[0]
        pg = ctx.pages[0] if ctx.pages else ctx.new_page()
        for name in names:
            try:
                fs = list_one(pg, name)
                result[name] = fs
                print(f"\n### {name} ({len(fs)} 文件)")
                for f in fs[:60]:
                    print("   ", f)
            except Exception as e:
                result[name] = f"ERR:{e}"
                print(f"\n### {name} 错误: {e}")
        b.close()
    # 写一份 json 备份
    Path("/Users/apple/Downloads/writer-simulator 2/baidu_sampler/_folder_files.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

if __name__ == "__main__":
    main()
