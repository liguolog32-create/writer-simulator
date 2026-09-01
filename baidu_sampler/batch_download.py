#!/usr/bin/env python3
"""
批量下载剩余 15 本抽样小说（分布在 10 个目录）
复用已验证的流程：导航 → JS勾选 → 点 button[title='下载'] → 可见dialog里点"普通下载" → 等 zip 落盘
"""
import time
import urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright

CDP = "http://127.0.0.1:9223"
DL = Path.home() / "Downloads" / "小说样本"

# (网盘目录, [文件名])
TARGETS = [
    ("/小说合集/5300本小说（二）/推理悬疑", [
        "谋杀现场3.txt",
        "大宋法证先锋.txt",
        "重生追缉令.txt",
        "穿越之鉴证女法医.txt",
    ]),
    ("/小说合集/5300本小说（二）/考古盗墓", [
        "盗墓之蛊墓杂记 作者：红狸.txt",
        "狼亲狈友（全民bl，盗墓）作者：恩顾",
    ]),
    ("/小说合集/5300本小说（一）/先婚后爱文", [
        "金玉为糖，拐个醋王 许乘月.txt",
        "《全世界都想要的他，属于我》作者：蒋牧童.txt",
    ]),
    ("/小说合集/5300本小说（一）/病娇深情男主文", [
        "《更爱美人纤阿》作者：伊人睽睽.txt",
    ]),
    ("/小说合集/5300本小说（一）/美艳心机女主文", [
        "人人都爱女主角.txt",
    ]),
    ("/小说合集/5300本小说（一）/破镜重圆甜宠文", [
        "《南北往事》作者：长宇宙",
    ]),
    ("/小说合集/5300本小说（一）/相爱相杀日久生情系列文", [
        "贵女撩夫攻略 by 漪光.txt",
    ]),
    ("/小说合集/5300本小说（一）/闷骚爱吃醋男主文", [
        "王府宠妾.txt",
    ]),
    ("/小说合集/5300本小说（一）/这碗粥", [
        "倾然自喜",
    ]),
    ("/小说合集/5300本小说（一）/高质量军旅文", [
        "若你爱我如初.txt",
    ]),
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

CLICK_NORMAL_DL_JS = """
() => {
  const dlgs = [...document.querySelectorAll('.u-dialog')].filter(d => d.offsetParent);
  if (!dlgs.length) return 'no visible dialog';
  const dlg = dlgs[dlgs.length - 1];
  const btn = [...dlg.querySelectorAll('button')].find(
    b => b.textContent.includes('普通下载') && !b.textContent.includes('客户端')
  );
  if (!btn) return 'no 普通下载 btn';
  btn.click();
  return 'ok';
}
"""


def url_for(path):
    return f"https://pan.baidu.com/disk/main#/index?category=all&path={urllib.parse.quote(path)}"


def zips_now():
    return set(DL.glob("*.zip"))


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
                print(f"\n{'='*64}")
                print(f"📁 {dir_path.split('/')[-1]}  ({len(files)} 本)")

                before = zips_now()
                try:
                    pg.goto(url_for(dir_path), wait_until="domcontentloaded", timeout=60000)
                    pg.wait_for_timeout(3500)

                    # 勾选（文件名去 .txt 后缀）
                    keys = [f.replace(".txt", "") for f in files]
                    res = pg.evaluate(SELECT_JS, keys)
                    okn = sum(1 for r in res if r.get("ok"))
                    for r in res:
                        if not r.get("ok"):
                            print(f"   ⚠️ 未勾选: {r['target']} ({r.get('why')})")
                    print(f"   勾选 {okn}/{len(files)}")

                    if okn == 0:
                        summary.append((dir_path.split('/')[-1], 0, "无文件被勾选"))
                        continue

                    pg.wait_for_timeout(1200)
                    sel = pg.evaluate(
                        "() => { const m=document.body.textContent.match(/已选中\\s*(\\d+)\\s*个/); return m?parseInt(m[1]):0; }"
                    )
                    print(f"   页面显示已选中 {sel} 个")

                    # 点下载
                    pg.click("button[title='下载']", timeout=8000)
                    pg.wait_for_timeout(2500)

                    # 点"普通下载"
                    r = pg.evaluate(CLICK_NORMAL_DL_JS)
                    print(f"   普通下载: {r}")
                    if r != "ok":
                        summary.append((dir_path.split('/')[-1], 0, f"对话框异常: {r}"))
                        continue

                    # 等 zip 落盘（最多 90s）
                    got = None
                    for i in range(90):
                        time.sleep(1)
                        new = zips_now() - before
                        # 排除正在下载的临时文件
                        complete = [z for z in new if z.stat().st_size > 0]
                        if complete:
                            got = complete[0]
                            print(f"   ✅ [{i+1}s] {got.name}  ({got.stat().st_size/1024/1024:.1f} MB)")
                            break
                        if i % 15 == 14:
                            print(f"   ⏳ 等待中… {i+1}s")
                    if not got:
                        print("   ⏱ 超时未落盘")
                        summary.append((dir_path.split('/')[-1], 0, "下载超时"))
                        continue

                    summary.append((dir_path.split('/')[-1], okn, "OK"))
                    pg.wait_for_timeout(1500)
                except Exception as e:
                    print(f"   ❌ 异常: {e}")
                    summary.append((dir_path.split('/')[-1], 0, f"异常: {str(e)[:60]}"))
        finally:
            b.close()

    print(f"\n{'='*64}")
    print("批量下载汇总：")
    for name, n, status in summary:
        print(f"  {n} 本  {name}  -> {status}")
    print(f"\nzip 文件：")
    for z in sorted(DL.glob("*.zip")):
        print(f"  {z.name}  ({z.stat().st_size/1024/1024:.1f} MB)")


if __name__ == "__main__":
    main()
