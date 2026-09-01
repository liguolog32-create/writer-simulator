#!/usr/bin/env python3
"""
大规模下载：全选目录里的文件（不指定书名），一次拿几十本
用法: python mass_download.py [每目录最多几本，默认 10]
"""
import sys
import time
import urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright

CDP = "http://127.0.0.1:9223"
DL = Path.home() / "Downloads" / "小说样本"
MAX_PER_DIR = int(sys.argv[1]) if len(sys.argv) > 1 else 10

BASE1 = "/小说合集/5300本小说（一）"
BASE2 = "/小说合集/5300本小说（二）"

DIRS = [
    f"{BASE2}/推理悬疑",
    f"{BASE2}/网游小说",
    f"{BASE2}/恐怖",
    f"{BASE2}/历史架空小说",
    f"{BASE2}/考古盗墓",
    f"{BASE2}/五代十国",
    f"{BASE2}/龙族文",
    f"{BASE2}/暮光同人",
    f"{BASE2}/乐小米完整合集183本",
    f"{BASE2}/唐七公子15本",
    f"{BASE1}/高质量仙侠文",
    f"{BASE1}/先婚后爱文",
    f"{BASE1}/先婚后爱甜文",
    f"{BASE1}/偏执病娇男主文",
    f"{BASE1}/男主超会撩系列文",
    f"{BASE1}/破镜重圆甜宠文",
    f"{BASE1}/美艳心机女主文",
    f"{BASE1}/这碗粥",
]

# 全选当前目录的文件行（跳过表头全选框）
SELECT_ALL_JS = """
(max) => {
  // 文件行的 checkbox：找 input.u-checkbox__original，取后面的（表头全选通常排最前）
  const cbs = [...document.querySelectorAll('input.u-checkbox__original')];
  if (!cbs.length) return {n: 0, why: 'no checkbox'};
  // 从后往前选，避开第一个（多为表头全选）
  const list = cbs.slice(-Math.min(max, cbs.length));
  let n = 0;
  for (const cb of list) { cb.click(); n++; }
  return {n, total: cbs.length};
}
"""

CLICK_NORMAL_DL_JS = """
() => {
  const dlgs = [...document.querySelectorAll('.u-dialog')].filter(d => d.offsetParent);
  if (!dlgs.length) return null;
  const dlg = dlgs[dlgs.length - 1];
  if (!/下载/.test(dlg.textContent)) return null;
  const btn = [...dlg.querySelectorAll('button')].find(
    b => b.textContent.includes('普通下载') && !b.textContent.includes('客户端'));
  if (!btn) return 'NO_BTN';
  btn.click();
  return 'ok';
}
"""


def url_for(path):
    return f"https://pan.baidu.com/disk/main#/index?category=all&path={urllib.parse.quote(path)}"


def zips():
    return set(DL.glob("*.zip"))


def main():
    DL.mkdir(parents=True, exist_ok=True)
    total_got = 0
    report = []

    with sync_playwright() as p:
        b = p.chromium.connect_over_cdp(CDP)
        ctx = b.contexts[0]
        pg = ctx.pages[0] if ctx.pages else ctx.new_page()
        client = ctx.new_cdp_session(pg)
        client.send("Page.setDownloadBehavior", {"behavior": "allow", "downloadPath": str(DL)})

        try:
            for i, d in enumerate(DIRS, 1):
                short = d.split("/")[-1]
                print(f"\n[{i}/{len(DIRS)}] 📁 {short}")
                before = zips()
                try:
                    pg.goto(url_for(d), wait_until="domcontentloaded", timeout=60000)
                    pg.wait_for_timeout(3500)

                    r = pg.evaluate(SELECT_ALL_JS, MAX_PER_DIR)
                    print(f"   勾选 {r.get('n', 0)} 个（目录共 {r.get('total', '?')} 项）")
                    if not r.get("n"):
                        report.append((short, 0, r.get("why", "无勾选")))
                        continue

                    pg.wait_for_timeout(1200)
                    sel = pg.evaluate(
                        "() => { const m=document.body.textContent.match(/已选中\\s*(\\d+)\\s*个/); return m?parseInt(m[1]):0; }")
                    print(f"   页面确认已选中 {sel}")

                    pg.click("button[title='下载']", timeout=8000)
                    pg.wait_for_timeout(2500)
                    dr = pg.evaluate(CLICK_NORMAL_DL_JS)
                    print(f"   对话框: {dr if dr else '无（直接下载）'}")

                    got = None
                    for t in range(120):
                        time.sleep(1)
                        new = zips() - before
                        complete = [z for z in new if z.stat().st_size > 0]
                        if complete:
                            got = complete[0]
                            mb = got.stat().st_size / 1024 / 1024
                            print(f"   ✅ [{t+1}s] {got.name[:40]}  ({mb:.1f} MB)")
                            break
                        if t % 25 == 24:
                            print(f"   ⏳ {t+1}s…")

                    if got:
                        total_got += 1
                        report.append((short, sel, "OK"))
                    else:
                        report.append((short, sel, "超时"))
                    pg.wait_for_timeout(1200)
                except Exception as e:
                    print(f"   ❌ {e}")
                    report.append((short, 0, f"异常:{str(e)[:40]}"))
        finally:
            b.close()

    print(f"\n{'='*60}")
    print(f"完成 {total_got}/{len(DIRS)} 个目录")
    for n, c, s in report:
        print(f"  {c:>3} 本  {n}  -> {s}")
    print(f"\nzip 总数: {len(list(DL.glob('*.zip')))}")


if __name__ == "__main__":
    main()
