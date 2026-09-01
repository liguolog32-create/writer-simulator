#!/usr/bin/env python3
"""列出百度网盘 /小说合集/5300本小说（一）/ 下所有子目录及其文件。
用于找出尚未下载到本地的书。"""
import sys, json, time
import urllib.parse
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
        pg.goto("https://pan.baidu.com/disk/home", wait_until="domcontentloaded", timeout=45000)
        pg.wait_for_timeout(4000)
        url = pg.url
        logged_in = "passport" not in url.lower() and "login" not in url.lower()
        print("登录状态:", "✅ 已登录" if logged_in else "❌ 未登录", "|", url)
        if not logged_in:
            print("请先手动登录后再运行"); return

        # 进入根目录
        pg.goto(url_for(BASE), wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(4000)

        # 抓取子目录（文件名行）
        def grab_rows():
            return pg.evaluate("""() => {
              const rows = [...document.querySelectorAll('[class*="file-name"], [class*="item-name"], tr')];
              const out = [];
              for (const r of rows) {
                const t = (r.textContent||'').trim();
                if (!t) continue;
                out.push(t.slice(0,80));
              }
              return out.slice(0, 60);
            }""")

        rows = grab_rows()
        print("\n=== 根目录前 60 行文本（含子目录名）===")
        for r in rows:
            print("  ", r)

        # 尝试抓取可点击的目录（含图标）列表
        pg.wait_for_timeout(1500)
        dirs = pg.evaluate("""() => {
          const links = [...document.querySelectorAll('a, div, span, li')];
          const out = [];
          for (const e of links) {
            const t = (e.textContent||'').trim();
            if (t.length > 1 && t.length < 40 && /[文合集本小说]/.test(t)) {
              out.push(t);
            }
          }
          return [...new Set(out)].slice(0, 80);
        }""")
        print("\n=== 推测子目录名（去重）===")
        for d in dirs:
            print("  ", d)
        b.close()

if __name__ == "__main__":
    main()
