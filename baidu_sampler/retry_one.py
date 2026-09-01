#!/usr/bin/env python3
"""单本重试：蓬莱客《春江花月》。用宽松子串匹配。"""
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

CDP = "http://127.0.0.1:9223"
BASE = "/小说合集/5300本小说（一）"
DL = Path.home() / "Downloads" / "小说样本"
DL.mkdir(parents=True, exist_ok=True)

SELECT_JS = """
(target) => {
  const all = [...document.querySelectorAll('span,div,p,a,label')];
  const cands = all.filter(e => {
    const t = (e.textContent || '').trim();
    return t.includes(target) && t.length <= target.length + 30 && e.children.length <= 5;
  });
  if (!cands.length) return {ok:false, why:'no leaf'};
  let cb=null, n=cands[0];
  for (let i=0;i<8 && n;i++){ cb = n.querySelector('input.u-checkbox__original, input[type=\"checkbox\"]'); if(cb) break; n=n.parentElement; }
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
    with sync_playwright() as p:
        b = p.chromium.connect_over_cdp(CDP)
        ctx = b.contexts[0]
        pg = ctx.pages[0] if ctx.pages else ctx.new_page()
        client = ctx.new_cdp_session(pg)
        client.send("Page.setDownloadBehavior", {"behavior":"allow","downloadPath":str(DL)})
        before = snapshot()
        pg.goto(url_for(f"{BASE}/蓬莱客作品集"), wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(4000)
        # 宽松匹配：只传"春江花月"
        res = pg.evaluate(SELECT_JS, "春江花月")
        print("勾选结果:", res)
        if res.get("ok"):
            pg.wait_for_timeout(800)
            pg.click("button[title='下载']", timeout=8000)
            pg.wait_for_timeout(2000)
            r = pg.evaluate(CLICK_NORMAL_DL_JS)
            print("对话框:", r if r else "无")
            for i in range(120):
                time.sleep(1)
                new = snapshot()-before
                if new:
                    print(f"✅ [{i+1}s] {sorted(new)[0]}")
                    break
                if i%20==19: print(f"⏳ {i+1}s…")
        else:
            print("❌ 仍无法勾选")
        b.close()

if __name__ == "__main__":
    main()
