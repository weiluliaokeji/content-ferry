#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""渲染前快速目检：用 Edge CDP 在指定时间点截图，避免全量渲染后才发现文案问题。

用法:
    python3 snapshot_frames.py <index.html> <out_dir> <t1,t2,...>

示例:
    python3 snapshot_frames.py composition/index.html _snap 3,26,70,92

时间点取"每个场景中段"即可（可从 segments.json 的 start/duration 推算）。
依赖：pip install websockets；Edge/Chromium 无头已启动（--remote-debugging-port=19222）。
"""

import asyncio, base64, json, os, sys, urllib.request
from pathlib import Path

CDP = "http://127.0.0.1:19222"
CDP_TIMEOUT = 30.0  # 单次 CDP 调用上限；超时说明页面/连接异常，避免无限等待


async def get_page_ws():
    data = json.loads(urllib.request.urlopen(CDP + "/json", timeout=5).read().decode())
    # 优先非 edge:// / chrome:// 的页面目标
    for t in data:
        if t.get("type") == "page":
            u = t.get("url", "")
            if not u.startswith("edge://") and not u.startswith("chrome://"):
                return t["webSocketDebuggerUrl"]
    for t in data:
        if t.get("type") == "page":
            return t["webSocketDebuggerUrl"]
    return None


async def main():
    import websockets

    html = sys.argv[1]
    outdir = sys.argv[2]
    times = [float(x) for x in sys.argv[3].split(",")]
    os.makedirs(outdir, exist_ok=True)

    if html.startswith("http://") or html.startswith("https://"):
        file_url = html
    else:
        # 与 render_frames.py 同口径：用 pathlib 生成 file:// URL，
        # 旧实现的 /d/→D:/ 硬编码在非 D 盘会拼出错误 URL。
        file_url = Path(os.path.abspath(html)).as_uri()

    ws = await websockets.connect(await get_page_ws(), max_size=50 * 1024 * 1024)
    pending, seq = {}, 0

    async def send(method, params=None, timeout=CDP_TIMEOUT):
        nonlocal seq
        seq += 1
        mid = seq
        fut = asyncio.get_event_loop().create_future()
        pending[mid] = fut
        await ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            pending.pop(mid, None)
            raise

    async def recv_loop():
        async for msg in ws:
            m = json.loads(msg)
            if "id" in m and m["id"] in pending:
                pending[m["id"]].set_result(m)

    asyncio.get_event_loop().create_task(recv_loop())
    await send("Emulation.setDeviceMetricsOverride",
               {"width": 1080, "height": 1920, "deviceScaleFactor": 1, "mobile": False})
    await send("Page.enable")
    await send("Page.navigate", {"url": file_url})

    def norm(u):
        # 归一化 file:// 形式用于比较：file://D:/... vs file:///D:/...，并解码百分号
        return urllib.parse.unquote(u).replace("file:///", "file://").rstrip("/").lower()

    target_norm = norm(file_url)
    for _ in range(60):
        r = await send("Runtime.evaluate", {
            "expression": "document.readyState==='complete' && !!window.__timelines && !!window.__timelines.main && document.URL",
            "returnByValue": True})
        v = r.get("result", {}).get("result", {}).get("value")
        if v and norm(v) == target_norm:
            break
        await asyncio.sleep(0.5)
    print("final page URL:", (await send("Runtime.evaluate", {
        "expression": "document.URL", "returnByValue": True})).get("result", {}).get("result", {}).get("value", "?"))

    for _ in range(20):
        r = await send("Runtime.evaluate", {
            "expression": "(document.fonts.status==='loaded') && Array.from(document.images).every(i=>i.complete)",
            "returnByValue": True})
        if r.get("result", {}).get("result", {}).get("value"):
            break
        await asyncio.sleep(0.5)
    await asyncio.sleep(1.0)

    r = await send("Runtime.evaluate", {
        "expression": "String(window.__timelines.main.duration())", "returnByValue": True})
    dur = float(r.get("result", {}).get("result", {}).get("value") or 0)
    if dur <= 0:
        print("ERROR: timeline duration probe failed (dur=%s), check page load." % dur, file=sys.stderr)
        return
    print("timeline duration", dur)

    for tsec in times:
        p = min(tsec / dur, 1.0)
        await send("Runtime.evaluate",
                   {"expression": "(() => { window.__timelines.main.pause().progress(%f); return 0; })()" % p})
        await asyncio.sleep(0.2)
        r = await send("Page.captureScreenshot", {"format": "jpeg", "quality": 90})
        if "result" not in r or "data" not in r.get("result", {}):
            print("ERROR: screenshot failed at %ss: %s" % (tsec, r.get("error")), file=sys.stderr)
            continue
        fp = os.path.join(outdir, "snap_%05.1fs.jpg" % tsec)
        with open(fp, "wb") as f:
            f.write(base64.b64decode(r["result"]["data"]))
        print("saved", fp)


asyncio.run(main())
