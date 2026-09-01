#!/usr/bin/env python3
"""批量下载指定书籍（逐本单文件下载，避开 zip 编码坑）。
SELECTION: list of (subfolder_name, filename)。路径基准 /小说合集/5300本小说（一）/。
"""
import time, json
from pathlib import Path
from playwright.sync_api import sync_playwright

CDP = "http://127.0.0.1:9223"
BASE = "/小说合集/5300本小说（一）"
DL = Path.home() / "Downloads" / "小说样本"
DL.mkdir(parents=True, exist_ok=True)

SELECTION = [
    ("北倾作品集", "徐徐诱之.txt"),
    ("北倾作品集", "谁说我，不爱你_派派后花园.txt"),
    ("北倾作品集", "竹马镶青梅 作者：北倾.txt"),
    ("耳东兔子", "《他从火光中走来》作者：耳东兔子.txt"),
    ("耳东兔子", "《招惹计》作者：耳东兔子.txt"),
    ("六盲星作品集", "《韫色过浓》作者：六盲星.txt"),
    ("六盲星作品集", "《只为他折腰》作者：六盲星.txt"),
    ("六盲星作品集", "《如果月亮不抱你》作者：六盲星.txt"),
    ("墨宝非宝", "一生一世，美人骨.txt"),
    ("墨宝非宝", "至此终年.txt"),
    ("蓬莱客作品集", "春江花月 作者：蓬莱客.txt"),
    ("蓬莱客作品集", "《海上华亭》作者：蓬莱客.txt"),
]

SELECT_JS = """
(target) => {
  const all = [...document.querySelectorAll('span,div,p,a,label')];
  const cands = all.filter(e => {
    const t = (e.textContent || '').trim();
    return t.includes(target) && t.length <= target.length + 30 && e.children.length <= 5;
  });
  if (!cands.length) return {ok:false, why:'no leaf'};
  let cb=null, n=cands[0];
  for (let i=0;i<8 && n;i++){ cb = n.querySelector('input.u-checkbox__original, input[type="checkbox"]'); if(cb) break; n=n.parentElement; }
  if(!cb) return {ok:false, why:'no cb'};
  cb.click();
  return {ok:true};
}
"""

CLICK_NORMAL_DL_JS = """
() => {
  const dlgs = [...document.querySelectorAll('.u-dialog')].filter(d => d.offsetParent);
  if (!dlgs.length) return null;
  const dlg = dlgs[dlgs.length - 1];
  if (!/下载/.test(dlg.textContent)) return null;
  const btn = [...dlg.querySelectorAll('button')].find(b => b.textContent.includes('普通下载') && !b.textContent.includes('客户端'));
  if (!btn) return 'NO_BTN';
  btn.click();
  return 'ok';
}
"""

def url_for(path):
    from urllib.parse import quote
    return f"https://pan.baidu.com/disk/main#/index?category=all&path={quote(path)}"

def snapshot():
    return {p.name for p in DL.iterdir() if p.is_file() and p.suffix.lower() in (".txt",".zip") and not p.name.startswith(".")}

def main():
    summary=[]
    with sync_playwright() as p:
        b = p.chromium.connect_over_cdp(CDP)
        ctx = b.contexts[0]
        pg = ctx.pages[0] if ctx.pages else ctx.new_page()
        client = ctx.new_cdp_session(pg)
        client.send("Page.setDownloadBehavior", {"behavior":"allow","downloadPath":str(DL)})
        for dir_name, fname in SELECTION:
            print(f"\n{'='*60}\n📥 {fname}  (来自 {dir_name})")
            before = snapshot()
            try:
                pg.goto(url_for(f"{BASE}/{dir_name}"), wait_until="domcontentloaded", timeout=60000)
                pg.wait_for_timeout(3500)
                res = pg.evaluate(SELECT_JS, fname)
                if not res.get("ok"):
                    print(f"   ⚠️ 未勾选: {res.get('why')}")
                    summary.append((fname,"未勾选")); continue
                pg.wait_for_timeout(800)
                pg.click("button[title='下载']", timeout=8000)
                pg.wait_for_timeout(2000)
                r = pg.evaluate(CLICK_NORMAL_DL_JS)
                print(f"   对话框: {r if r else '无（单文件直接下载）'}")
                got=None
                for i in range(120):
                    time.sleep(1)
                    new = snapshot()-before
                    if new:
                        got=sorted(new)[0]
                        fp=DL/got
                        print(f"   ✅ [{i+1}s] {got} ({fp.stat().st_size/1024:.0f} KB)")
                        break
                    if i%20==19: print(f"   ⏳ {i+1}s…")
                summary.append((fname, got or "超时"))
                pg.wait_for_timeout(1000)
            except Exception as e:
                print(f"   ❌ {e}")
                summary.append((fname, f"异常:{str(e)[:50]}"))
        b.close()
    print(f"\n{'='*60}\n下载汇总：")
    for f,r in summary: print(f"  {f} -> {r}")
    print(f"\n本地样本现有 {len(list(DL.glob('*.txt')))} 个 txt")

if __name__ == "__main__":
    main()
