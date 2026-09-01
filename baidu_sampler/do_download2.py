#!/usr/bin/env python3
"""
百度网盘抽样下载 v2 —— 用 JS 注入精确定位 checkbox

策略：
1) 正确导航到目标目录
2) 用 page.evaluate 找含目标文件名的行 + 它的 checkbox
3) 程序化点击（不用鼠标坐标，避坑侧边栏）
4) 找"下载"按钮并点
5) 等下载完成
"""
import sys
import time
import urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright

CDP = "http://127.0.0.1:9223"
DOWNLOAD_DIR = Path.home() / "Downloads" / "小说样本"
TARGET_DIR = "/小说合集/5300本小说（一）/高质量仙侠文"
FILES = [
    "《上膳书》作者：三水小草.txt",
    "《本王在此》-九鹭非香.txt",
    "奈何by君子以泽.txt",
]


def url_for(path):
    return f"https://pan.baidu.com/disk/main#/index?category=all&path={urllib.parse.quote(path)}"


with sync_playwright() as p:
    b = p.chromium.connect_over_cdp(CDP)
    ctx = b.contexts[0]
    pg = ctx.pages[0] if ctx.pages else ctx.new_page()
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    client = ctx.new_cdp_session(pg)
    client.send("Page.setDownloadBehavior", {"behavior": "allow", "downloadPath": str(DOWNLOAD_DIR)})
    print(f"下载目录: {DOWNLOAD_DIR}")

    try:
        # 1) 正确导航
        u = url_for(TARGET_DIR)
        print(f"导航: {u}")
        pg.goto(u, wait_until="domcontentloaded", timeout=60000)
        try:
            pg.wait_for_selector("text=上膳书", timeout=25000)
            print("✅ 目标文件已渲染")
        except Exception:
            print("⚠️ 未等到文件，可能路径错或网络慢")
        pg.wait_for_timeout(3000)

        # 2) 用 JS 找含目标文件名的元素及其 checkbox
        #    找的是行容器 + 它内部的 checkbox
        script = """
        (targets) => {
          const out = [];
          for (const target of targets) {
            // 1) 找到包含目标文件名的最小元素
            const all = [...document.querySelectorAll('*')];
            const cands = all.filter(e => {
              const t = (e.textContent || '').trim();
              if (t !== target) return false;
              if (e.querySelectorAll('*').length > 30) return false;  // 太大说明不是叶子
              return true;
            });
            if (cands.length === 0) {
              out.push({target, found: false, reason: 'no exact-text match'});
              continue;
            }
            // 2) 找到 checkbox：先在自身 + 5 层祖先内找
            let checkbox = null;
            let node = cands[0];
            for (let i = 0; i < 5 && node; i++) {
              checkbox = node.querySelector('input[type=checkbox]') ||
                         node.querySelector('[role=checkbox]') ||
                         node.querySelector('span.checkbox, label.checkbox') ||
                         node.querySelector('.checkboxFn-node, .checkbox') ||
                         node.querySelector('i.ico-checkbox');
              if (checkbox) break;
              node = node.parentElement;
            }
            if (!checkbox) {
              out.push({target, found: true, clicked: false, reason: 'no checkbox in 5 levels'});
              continue;
            }
            // 3) 点击
            checkbox.scrollIntoView();
            checkbox.click();
            out.push({
              target,
              found: true,
              clicked: true,
              tag: checkbox.tagName,
              cls: (checkbox.className || '').toString().slice(0, 50),
            });
          }
          return out;
        }
        """
        results = pg.evaluate(script, FILES)
        print("\n=== JS 勾选结果 ===")
        for r in results:
            print("  ", r)
        pg.wait_for_timeout(1500)
        pg.screenshot(path="/tmp/pan_v2.png")
        print("截图: /tmp/pan_v2.png")

        # 3) 找并点"下载"按钮
        dl = pg.evaluate("""() => {
          // 找"下载"按钮：可能是 a 标签、button、或带 [data-key] 的元素
          const sels = [
            'a:has-text("下载")',
            'button:has-text("下载")',
            '[data-key="download"]',
            '.g-button:has-text("下载")',
            'span:has-text("下载")',
          ];
          for (const sel of sels) {
            try {
              const els = [...document.querySelectorAll(sel)];
              const visible = els.filter(e => e.offsetParent && e.textContent.trim() === '下载');
              if (visible.length) {
                return {found: true, sel, count: visible.length, text: visible[0].textContent.trim()};
              }
            } catch (e) {}
          }
          // 兜底：找含"下载"两字且 visible 的任何元素
          const all = [...document.querySelectorAll('*')].filter(e => {
            const t = (e.textContent || '').trim();
            return t === '下载' && e.offsetParent;
          });
          return {found: all.length > 0, sel: 'fallback', count: all.length};
        }""")
        print(f"\n下载按钮探测: {dl}")
        if dl.get("found"):
            pg.evaluate("""() => {
              const all = [...document.querySelectorAll('*')].filter(e => {
                const t = (e.textContent || '').trim();
                return t === '下载' && e.offsetParent;
              });
              if (all[0]) all[0].click();
              return all.length;
            }""")
            print("  ✅ 已点击下载按钮")
        else:
            print("  ❌ 未找到下载按钮")

        # 4) 等下载
        print("\n等待下载（30s）…")
        for i in range(30):
            time.sleep(1)
            files_now = [f for f in DOWNLOAD_DIR.iterdir() if f.is_file()]
            if files_now:
                print(f"  [{i+1}s] 当前 {len(files_now)} 个文件: {[f.name for f in files_now]}")
        pg.wait_for_timeout(5000)
    finally:
        b.close()

print("\n=== 下载目录 ===")
for f in sorted(DOWNLOAD_DIR.iterdir()):
    print(f"  {f.name}  ({f.stat().st_size/1024:.0f} KB)")
