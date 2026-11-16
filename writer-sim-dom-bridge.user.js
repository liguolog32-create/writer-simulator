// ==UserScript==
// @name         Writer-Sim DOM Bridge
// @namespace    writersim
// @version      0.1.0
// @description  把当前页面的结构化 DOM 区块（article/main/h1/h2…的矩形 + 截断文本）
//               中转给作家模拟器的「观澜」观察管道，供其做版面区域感知切片。
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// ==/UserScript==

/* ============================ 隐私边界（务必阅读） ============================
 * 1. 本脚本**零网络请求**：抽到的结构数据只写入浏览器本地的 GM 存储
 *    （GM_setValue），不上传到任何服务器；
 * 2. 数据只在本机窗口之间流转：抽取模式（普通网页）→ GM 存储 →
 *    接收模式（作家模拟器应用页）→ window.postMessage → 应用内的 domBridge 模块；
 * 3. 每块文本截断到 500 字、最多 30 块，只含矩形坐标与可见文字片段，
 *    不含截图、不含原始 HTML、不含输入框/密码框内容；
 * 4. 应用侧（src/bot/domBridge.ts）同样承诺：不进 AppState、不进 localStorage、
 *    不上云，payload 超过 10 秒即作废。
 * ========================================================================== */

(function () {
  'use strict'

  var STORE_KEY = 'wsDomBridgeLatest'
  var APP_HOSTS = { 'writer-simulator.pages.dev': true }
  var host = location.hostname
  var isAppPage =
    APP_HOSTS[host] ||
    ((host === 'localhost' || host === '127.0.0.1') && location.port === '4173')

  if (isAppPage) {
    /* ---------------- 接收模式：GM 存储 → postMessage → 应用 ---------------- */
    if (typeof GM_addValueChangeListener === 'function') {
      GM_addValueChangeListener(STORE_KEY, function (key, oldValue, newValue) {
        try {
          var payload = JSON.parse(newValue)
          if (payload && payload.__writerSimDom === true && Array.isArray(payload.blocks)) {
            window.postMessage(payload, window.location.origin)
          }
        } catch (e) {
          /* 非 JSON / 结构不对：忽略 */
        }
      })
    }
    return
  }

  /* ---------------- 抽取模式：普通网页 → GM 存储 ----------------
   * 每 4s 采一次；document.hidden 时跳过（后台标签页不值得打扰）。
   */
  function rectVisible(rect) {
    return (
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      rect.right > 0 &&
      rect.left < window.innerWidth
    )
  }

  function extract() {
    if (document.hidden) return
    var nodes = document.querySelectorAll('article, main, [role="main"], h1, h2')
    var blocks = []
    for (var i = 0; i < nodes.length && blocks.length < 30; i++) {
      var el = nodes[i]
      var isHeading = el.tagName === 'H1' || el.tagName === 'H2'
      var text = (el.innerText || '').trim()
      // 正文类元素：视口内 + 尺寸门槛 + 文本 >60 字；标题（h1/h2）：有文本即可
      if (!text) continue
      var rect = el.getBoundingClientRect()
      if (isHeading) {
        if (rect.w <= 0 || rect.h <= 0 || !rectVisible(rect)) continue
      } else {
        if (rect.w <= 200 || rect.h <= 30 || !rectVisible(rect)) continue
        if (text.length <= 60) continue
      }
      blocks.push({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        text: text.slice(0, 500),
      })
    }
    if (!blocks.length) return
    var payload = {
      __writerSimDom: true,
      at: Date.now(),
      url: location.href,
      title: document.title,
      blocks: blocks,
    }
    try {
      GM_setValue(STORE_KEY, JSON.stringify(payload))
    } catch (e) {
      /* GM 存储不可用：静默放弃 */
    }
  }

  setInterval(extract, 4000)
})()
