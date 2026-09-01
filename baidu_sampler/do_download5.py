#!/usr/bin/env python3
"""百度网盘抽样下载 v5 —— 终极版，精准定位 button[title="下载"]"""
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
        # 干净状态（强制 reload）
        pg.goto(url_for(TARGET_DIR), wait_until="domcontentloaded", timeout=60000)
        pg.reload(wait_until="domcontentloaded")
        pg.wait_for_selector("text=上膳书", timeout=25000)
        pg.wait_for_timeout(2500)

        # 用 page.evaluate 一次勾选所有目标（用 v4 的 includes 逻辑，但放宽层数）
        result = pg.evaluate("""(targets) => {
          const out = [];
          for (const target of targets) {
            const all = [...document.querySelectorAll('span, div, p, a, label')];
            const cands = all.filter(e => {
              const t = (e.textContent || '').trim();
              if (!t.includes(target) || t.length > target.length + 30) return false;
              if (e.children.length > 5) return false;
              return true;
            });
            if (!cands.length) { out.push({target, ok: false, why: 'no leaf'}); continue; }
            // 找最近 8 层祖先里的 checkbox
            let cb = null;
            let node = cands[0];
            for (let i = 0; i < 8 && node; i++) {
              cb = node.querySelector('input.u-checkbox__original, input[type="checkbox"]');
              if (cb) break;
              node = node.parentElement;
            }
            if (!cb) { out.push({target, ok: false, why: 'no cb in 8 levels'}); continue; }
            cb.click();
            out.push({target, ok: true});
          }
          return out;
        }""", [f.replace(".txt", "") for f in FILES])
        print("=== 勾选 ===")
        for r in result:
            print("  ", r)
        pg.wait_for_timeout(1200)

        # 验证是否真的勾上了（看工具栏"已选中 N 个文件/文件夹"）
        selection = pg.evaluate("""() => {
          const m = document.body.textContent.match(/已选中\s*(\d+)\s*个/);
          return m ? parseInt(m[1]) : 0;
        }""")
        print(f"已选中: {selection} 个")
        if selection == 0:
            print("❌ 没勾上任何文件，停止")
            raise SystemExit(2)
        pg.screenshot(path="/tmp/pan_v5_selected.png")

        # 点真正的下载按钮（<button title="下载">）
        print("\n点击顶部『下载』按钮…")
        try:
            pg.click("button[title='下载']", timeout=8000)
            print("  ✅ Playwright click() 成功")
        except Exception as e:
            print(f"  ❌ Playwright click 失败: {e}")
            raise
        pg.wait_for_timeout(2500)
        pg.screenshot(path="/tmp/pan_v5_dialog.png")

        # 等对话框出现
        print("等对话框…")
        try:
            pg.wait_for_selector(".u-dialog__ok, .u-dialog__content, .u-dialog, [role='dialog']", timeout=8000)
        except Exception:
            print("  ⚠️ 未等对话框，截图看状态")
            pg.screenshot(path="/tmp/pan_v5_nodialog.png")
            raise

        # 列对话框里的所有按钮
        btns = pg.evaluate("""() => {
          const dlg = document.querySelector('.u-dialog__ok, .u-dialog__content, .u-dialog, [role="dialog"]');
          if (!dlg) return [];
          // 注意：选择 dialog 内部的 button/a，不只是带 on-click 的
          const all = [...dlg.querySelectorAll('button, a, [role="button"]')];
          return all.map(b => ({tag: b.tagName, text: (b.textContent||'').trim().slice(0, 30), cls: (b.className||'').toString().slice(0,60)})).filter(x => x.text);
        }""")
        print(f"对话框按钮: {btns}")

        # 点"普通下载"
        clicked = pg.evaluate("""() => {
          // 精确找 "普通下载"
          const dlg = document.querySelector('.u-dialog, [role="dialog"]');
          if (!dlg) return null;
          const btns = [...dlg.querySelectorAll('button, a, [role="button"]')];
          // 优先匹配 "普通下载"
          let target = btns.find(b => b.textContent.trim() === '普通下载');
          if (!target) target = btns.find(b => /普通下载|不使用|仅本次/.test(b.textContent.trim()));
          if (target) { target.click(); return target.textContent.trim(); }
          return null;
        }""")
        print(f"点了对话框按钮: {clicked}")
        pg.wait_for_timeout(3000)

        # 等下载完成
        print("\n等待下载（最多 60s）…")
        for i in range(60):
            time.sleep(1)
            done = [f for f in DOWNLOAD_DIR.iterdir() if f.is_file() and not f.name.startswith('.')]
            cr = [f for f in DOWNLOAD_DIR.glob('*.crdownload')]
            if done or cr:
                print(f"  [{i+1}s] ✅{len(done)} ⏳{len(cr)} | done={[f.name for f in done]} cr={[f.name for f in cr]}")
                if done and len(done) >= 3:
                    break
    finally:
        b.close()

print("\n=== 最终目录 ===")
for f in sorted(DOWNLOAD_DIR.iterdir()):
    print(f"  {f.name}  ({f.stat().st_size/1024:.0f} KB)")