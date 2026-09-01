#!/usr/bin/env python3
"""百度网盘抽样下载 v4 —— 完整闭环 + 强健匹配"""
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
        # 强制刷新（防止脏状态）
        pg.goto(url_for(TARGET_DIR), wait_until="domcontentloaded", timeout=60000)
        try:
            pg.wait_for_selector("text=上膳书", timeout=25000)
            print("✅ 文件已渲染")
        except Exception:
            print("⚠️ 等文件失败")
        pg.wait_for_timeout(3000)

        # 用 page.evaluate 一次勾选所有目标（用 includes 匹配 + input.u-checkbox__original）
        result = pg.evaluate("""(targets) => {
          const out = [];
          for (const target of targets) {
            // 找叶子节点：textContent 包含目标文件名（去 .txt），且本身不嵌套太深
            const all = [...document.querySelectorAll('span, div, p, a, label')];
            const cands = all.filter(e => {
              const t = (e.textContent || '').trim();
              if (!t.includes(target) || t.length > target.length + 20) return false;
              if (e.children.length > 3) return false;  // 必须是叶子或近叶
              return true;
            });
            if (!cands.length) {
              out.push({target, found: false});
              continue;
            }
            // 向上 5 层找 checkbox
            let cb = null;
            let node = cands[0];
            for (let i = 0; i < 5 && node; i++) {
              cb = node.querySelector('input.u-checkbox__original, input[type="checkbox"]');
              if (cb) break;
              node = node.parentElement;
            }
            if (!cb) {
              out.push({target, found: true, clicked: false, reason: 'no checkbox'});
              continue;
            }
            cb.click();
            out.push({target, found: true, clicked: true, tag: cb.tagName});
          }
          return out;
        }""", [f.replace(".txt", "") for f in FILES])
        print("\n=== 勾选 ===")
        for r in result:
            print("  ", r)
        pg.wait_for_timeout(1500)
        pg.screenshot(path="/tmp/pan_v4_selected.png")
        print("截图: /tmp/pan_v4_selected.png")

        # 找顶部工具栏的主下载按钮
        btn_info = pg.evaluate("""() => {
          // 工具栏容器
          const tb = document.querySelector('.gtile-toolbar, .wp-s-agile-tool-bar, [class*="tool-bar"], [class*="ActionBar"]');
          if (!tb) return null;
          const items = [...tb.querySelectorAll('*')].filter(e => (e.textContent || '').trim() === '下载' && e.offsetParent);
          if (!items.length) return null;
          // 取最深层（最具体）的元素
          const deepest = items.sort((a,b) => b.querySelectorAll('*').length - a.querySelectorAll('*').length)[0];
          const box = deepest.getBoundingClientRect();
          return {x: Math.round(box.x + box.width/2), y: Math.round(box.y + box.height/2), label: deepest.tagName + '.' + deepest.className.slice(0, 60)};
        }""")
        print(f"\n下载按钮: {btn_info}")
        if not btn_info:
            print("❌ 没找到下载按钮")
            import sys; sys.exit(1)

        # 点击
        pg.mouse.click(btn_info["x"], btn_info["y"])
        pg.wait_for_timeout(2500)
        pg.screenshot(path="/tmp/pan_v4_dialog.png")

        # 处理可能的对话框（"继续下载"/"普通下载"）
        handled = pg.evaluate("""() => {
          const dlg = document.querySelector('.u-dialog, .dialog, [role="dialog"]');
          if (!dlg) return null;
          const btns = [...dlg.querySelectorAll('button, a')];
          const target = btns.find(b => /继续下载|普通下载|不使用|仅本次/.test(b.textContent.trim()));
          if (target) { target.click(); return target.textContent.trim(); }
          return null;
        }""")
        print(f"对话框处理: {handled}")
        pg.wait_for_timeout(2000)

        # 等下载
        print("\n等待下载（最多 60s）…")
        for i in range(60):
            time.sleep(1)
            done = [f for f in DOWNLOAD_DIR.iterdir() if f.is_file()]
            cr = [f for f in DOWNLOAD_DIR.glob('*.crdownload')]
            if done or cr:
                print(f"  [{i+1}s] ✅{len(done)} ⏳{len(cr)} | {[f.name for f in done]} {['!' + f.name for f in cr]}")
                if done and not cr and i > 3:
                    break
    finally:
        b.close()

print("\n=== 最终目录 ===")
for f in sorted(DOWNLOAD_DIR.iterdir()):
    print(f"  {f.name}  ({f.stat().st_size/1024:.0f} KB)")