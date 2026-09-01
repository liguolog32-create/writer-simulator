#!/usr/bin/env python3
"""百度网盘抽样下载 v3 —— 精准点顶部工具栏的主下载按钮"""
import sys
import time
import urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright

CDP = "http://127.0.0.1:9223"
DOWNLOAD_DIR = Path.home() / "Downloads" / "小说样本"
TARGET_DIR = "/小说合集/5300本小说（一）/高质量仙侠文"
FILES = ["《上膳书》作者：三水小草.txt", "《本王在此》-九鹭非香.txt", "奈何by君子以泽.txt"]


def url_for(path):
    return f"https://pan.baidu.com/disk/main#/index?category=all&path={urllib.parse.quote(path)}"


with sync_playwright() as p:
    b = p.chromium.connect_over_cdp(CDP)
    ctx = b.contexts[0]
    pg = ctx.pages[0] if ctx.pages else ctx.new_page()
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    client = ctx.new_cdp_session(pg)
    client.send("Page.setDownloadBehavior", {"behavior": "allow", "downloadPath": str(DOWNLOAD_DIR)})

    try:
        pg.goto(url_for(TARGET_DIR), wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_selector("text=上膳书", timeout=25000)
        pg.wait_for_timeout(2500)

        # 勾选
        for fn in FILES:
            target = fn.replace(".txt", "")
            ok = pg.evaluate("""(target) => {
              const all = [...document.querySelectorAll('*')];
              const cands = all.filter(e => {
                const t = (e.textContent || '').trim();
                return t === target && e.querySelectorAll('*').length < 30;
              });
              if (!cands.length) return false;
              let node = cands[0];
              for (let i = 0; i < 5 && node; i++) {
                const cb = node.querySelector('input.u-checkbox__original, input[type=checkbox]');
                if (cb) { cb.click(); return true; }
                node = node.parentElement;
              }
              return false;
            }""", target)
            print(f"  {'☑️' if ok else '❌'} {target}")
        pg.wait_for_timeout(1500)
        pg.screenshot(path="/tmp/pan_v3_selected.png")

        # 找顶部工具栏的主下载按钮（不点 footer/侧边栏的）
        toolbar_info = pg.evaluate("""() => {
          // 顶部工具栏的选择器（百度网盘 2024+ 用 .gtile-toolbar 或 .toolbar）
          const tbs = [...document.querySelectorAll('.gtile-toolbar, .toolbar, [class*="toolbar"][class*="bar"], [class*="action-bar"], [class*="ActionBar"]')];
          const out = [];
          for (const tb of tbs) {
            const items = [...tb.querySelectorAll('*')].filter(e => (e.textContent || '').trim() === '下载' && e.offsetParent);
            if (items.length) {
              // 找最深层（最具体）的元素
              const deepest = items.sort((a,b) => b.querySelectorAll('*').length - a.querySelectorAll('*').length)[0];
              const box = deepest.getBoundingClientRect();
              out.push({
                toolbar: tb.className.slice(0, 50),
                btn: deepest.tagName + '.' + deepest.className.slice(0, 50),
                box: {x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height)},
                depth: deepest.querySelectorAll('*').length,
              });
            }
          }
          // 兜底：找 y 最小（最靠上）的"下载"元素
          if (out.length === 0) {
            const all = [...document.querySelectorAll('*')].filter(e => (e.textContent || '').trim() === '下载' && e.offsetParent);
            const sorted = all.sort((a,b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y);
            const top = sorted[0];
            if (top) {
              const box = top.getBoundingClientRect();
              out.push({
                toolbar: '(fallback topmost)',
                btn: top.tagName + '.' + top.className.slice(0, 50),
                box: {x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height)},
              });
            }
          }
          return out;
        }""")
        print(f"\n下载按钮位置:")
        for t in toolbar_info:
            print(f"  {t}")

        if not toolbar_info:
            print("❌ 没找到任何下载按钮")
            sys.exit(1)

        # 取第一个（最顶部），用真实坐标点击
        target_btn = toolbar_info[0]
        x = target_btn["box"]["x"] + target_btn["box"]["w"] // 2
        y = target_btn["box"]["y"] + target_btn["box"]["h"] // 2
        print(f"\n点击: ({x},{y})")
        pg.mouse.click(x, y)
        pg.wait_for_timeout(2000)
        pg.screenshot(path="/tmp/pan_v3_after.png")

        # 检查是否弹了对话框
        dlg = pg.evaluate("""() => {
          const dlg = document.querySelector('.dialog, .modal, .u-dialog, [role="dialog"]');
          if (!dlg) return null;
          const txt = (dlg.textContent || '').slice(0, 300);
          const btns = [...dlg.querySelectorAll('button, a')].map(b => b.textContent.trim()).filter(Boolean);
          return {txt, btns};
        }""")
        print(f"对话框: {dlg}")

        if dlg:
            # 找"继续"/"普通下载"/"不使用客户端"等按钮
            for word in ["继续下载", "普通下载", "不使用", "仅本次", "知道了", "确定", "继续"]:
                clicked = pg.evaluate(f"""() => {{
                  const dlg = document.querySelector('.dialog, .modal, .u-dialog, [role="dialog"]');
                  if (!dlg) return false;
                  const btns = [...dlg.querySelectorAll('button, a')];
                  const target = btns.find(b => b.textContent.trim().includes('{word}'));
                  if (target) {{ target.click(); return true; }}
                  return false;
                }}""")
                if clicked:
                    print(f"  ✅ 点了对话框『{word}』")
                    break

        # 等下载
        print("\n等待下载（最多 60s）…")
        for i in range(60):
            time.sleep(1)
            got = [f for f in DOWNLOAD_DIR.iterdir() if f.is_file() and not f.name.startswith('.')]
            cr = [f for f in DOWNLOAD_DIR.glob('*.crdownload')]
            if got or cr:
                names = [f.name for f in got]
                cnames = [f.name for f in cr]
                print(f"  [{i+1}s] 已落盘 {len(got)} | 下载中 {len(cr)} -> {names} {cnames}")
            if got:
                break
        pg.wait_for_timeout(3000)
    finally:
        b.close()

print("\n=== 下载目录最终内容 ===")
for f in sorted(DOWNLOAD_DIR.iterdir()):
    print(f"  {f.name}  ({f.stat().st_size/1024:.0f} KB)")