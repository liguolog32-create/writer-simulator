#!/usr/bin/env python3
"""
补下剩余 7 本（都是单文件目录）
关键修复：单文件下载时百度网盘**不弹**"文件下载"对话框，直接触发下载。
逻辑改成：点下载 → 看有没有可见对话框 → 有就点"普通下载"，没有就直接等落盘。
"""
import time
import urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright

CDP = "http://127.0.0.1:9223"
DL = Path.home() / "Downloads" / "小说样本"

TARGETS = [
    ("/小说合集/5300本小说（一）/病娇深情男主文", ["《更爱美人纤阿》作者：伊人睽睽.txt"]),
    ("/小说合集/5300本小说（一）/美艳心机女主文", ["人人都爱女主角.txt"]),
    ("/小说合集/5300本小说（一）/破镜重圆甜宠文", ["《南北往事》作者：长宇宙"]),
    ("/小说合集/5300本小说（一）/相爱相杀日久生情系列文", ["贵女撩夫攻略 by 漪光.txt"]),
    ("/小说合集/5300本小说（一）/闷骚爱吃醋男主文", ["王府宠妾.txt"]),
    ("/小说合集/5300本小说（一）/这碗粥", ["倾然自喜"]),
    ("/小说合集/5300本小说（一）/高质量军旅文", ["若你爱我如初.txt"]),
]

SELECT_JS = """
(targets) => {
  const out = [];
  for (const target of targets) {
    const all = [...document.querySelectorAll('span,div,p,a,label')];
    const cands = all.filter(e => {
      const t = (e.textContent || '').trim();
      return t.includes(target) && t.length <= target.length + 30 && e.children.length <= 5;
    });
    if (!cands.length) { out.push({target, ok: false, why: 'no leaf'}); continue; }
    let cb = null, n = cands[0];
    for (let i = 0; i < 8 && n; i++) {
      cb = n.querySelector('input.u-checkbox__original, input[type="checkbox"]');
      if (cb) break;
      n = n.parentElement;
    }
    if (!cb) { out.push({target, ok: false, why: 'no cb'}); continue; }
    cb.click();
    out.push({target, ok: true});
  }
  return out;
}
"""

# 找可见对话框里的"普通下载"；没有就返回 null（表示单文件直接下）
CLICK_NORMAL_DL_JS = """
() => {
  const dlgs = [...document.querySelectorAll('.u-dialog')].filter(d => d.offsetParent);
  if (!dlgs.length) return null;                 // 单文件：无对话框
  const dlg = dlgs[dlgs.length - 1];
  if (!/下载/.test(dlg.textContent)) return null; // 不是下载对话框
  const btn = [...dlg.querySelectorAll('button')].find(
    b => b.textContent.includes('普通下载') && !b.textContent.includes('客户端')
  );
  if (!btn) return 'NO_BTN';
  btn.click();
  return 'ok';
}
"""


def url_for(path):
    return f"https://pan.baidu.com/disk/main#/index?category=all&path={urllib.parse.quote(path)}"


def snapshot():
    """当前所有已完成的 txt/zip（排除正在下载的 crdownload）"""
    return {
        p.name
        for p in DL.iterdir()
        if p.is_file() and (p.suffix.lower() in (".txt", ".zip")) and not p.name.startswith(".")
    }


def main():
    DL.mkdir(parents=True, exist_ok=True)
    summary = []

    with sync_playwright() as p:
        b = p.chromium.connect_over_cdp(CDP)
        ctx = b.contexts[0]
        pg = ctx.pages[0] if ctx.pages else ctx.new_page()
        client = ctx.new_cdp_session(pg)
        client.send("Page.setDownloadBehavior", {"behavior": "allow", "downloadPath": str(DL)})

        try:
            for dir_path, files in TARGETS:
                short = dir_path.split("/")[-1]
                print(f"\n{'='*64}\n📁 {short}")
                before = snapshot()

                try:
                    pg.goto(url_for(dir_path), wait_until="domcontentloaded", timeout=60000)
                    pg.wait_for_timeout(3500)

                    keys = [f.replace(".txt", "") for f in files]
                    res = pg.evaluate(SELECT_JS, keys)
                    okn = sum(1 for r in res if r.get("ok"))
                    for r in res:
                        if not r.get("ok"):
                            print(f"   ⚠️ 未勾选: {r['target']} ({r.get('why')})")
                    print(f"   勾选 {okn}/{len(files)}")
                    if okn == 0:
                        summary.append((short, "无勾选"))
                        continue

                    pg.wait_for_timeout(1000)
                    pg.click("button[title='下载']", timeout=8000)
                    pg.wait_for_timeout(2000)

                    # 有对话框就点"普通下载"；没有（单文件）就直接等
                    r = pg.evaluate(CLICK_NORMAL_DL_JS)
                    print(f"   对话框: {r if r else '无（单文件直接下载）'}")

                    got = None
                    for i in range(90):
                        time.sleep(1)
                        new = snapshot() - before
                        if new:
                            got = sorted(new)[0]
                            fp = DL / got
                            print(f"   ✅ [{i+1}s] {got}  ({fp.stat().st_size/1024/1024:.2f} MB)")
                            break
                        if i % 20 == 19:
                            print(f"   ⏳ {i+1}s…")
                    summary.append((short, got or "超时"))
                    pg.wait_for_timeout(1200)
                except Exception as e:
                    print(f"   ❌ {e}")
                    summary.append((short, f"异常:{str(e)[:40]}"))
        finally:
            b.close()

    print(f"\n{'='*64}\n补下汇总：")
    for name, r in summary:
        print(f"  {name} -> {r}")
    print(f"\n目录现有文件（{len(list(DL.glob('*.txt')))} txt / {len(list(DL.glob('*.zip')))} zip）：")
    for f in sorted(DL.iterdir()):
        if f.is_file() and f.suffix.lower() in (".txt", ".zip"):
            print(f"  {f.name}  ({f.stat().st_size/1024:.0f} KB)")


if __name__ == "__main__":
    main()
