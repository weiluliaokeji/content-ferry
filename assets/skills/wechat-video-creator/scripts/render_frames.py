#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Edge CDP 逐帧截图渲染脚本（微信视频号竖屏 9:16）。

用法:
    python3 render_frames.py <index.html_path> <frames_dir> <fps> [start_frame]

示例:
    python3 render_frames.py ./composition/index.html ./frames 25
    python3 render_frames.py ./composition/index.html ./frames 25 1000  # 从第1000帧续传

依赖:
    pip install websockets
    Edge/Chromium 无头模式已启动（--remote-debugging-port=19222）
"""

import asyncio, base64, json, os, sys, time, urllib.request
from pathlib import Path

CDP = "http://127.0.0.1:19222"
CDP_PORT = 19222
DEFAULT_DURATION = 98.9
CDP_TIMEOUT = 30.0  # 单次 CDP 调用上限；超时说明页面/连接异常，避免无限等待


def resolve_duration(args):
    """Duration priority: CLI arg > segments.json in html_dir > global default."""
    # arg index: 5 (0-based: sys.argv[5])
    if len(args) > 5:
        return float(args[5])
    # 契约落点是 composition/segments.json（与 index.html 同目录），因此先查同目录；
    # 上级目录仅作为旧布局的兼容兜底，不能优先——否则 video-assets/ 下的陈旧
    # segments.json 会被静默采用。
    html_path = args[1] if len(args) > 1 else ""
    if html_path:
        html_dir = os.path.dirname(os.path.abspath(html_path))
        for seg_path in (
            os.path.join(html_dir, "segments.json"),
            os.path.join(html_dir, "..", "segments.json"),
        ):
            if os.path.exists(seg_path):
                try:
                    with open(seg_path, "r", encoding="utf-8") as f:
                        return json.load(f).get("total_duration", DEFAULT_DURATION)
                except Exception:
                    pass
    return DEFAULT_DURATION


async def get_page_ws():
    data = json.loads(urllib.request.urlopen(CDP + "/json", timeout=5).read().decode())
    # First pass: prefer non-edge:// URLs (avoid internal Edge pages)
    for t in data:
        if t.get("type") == "page":
            url = t.get("url", "")
            if not url.startswith("edge://") and not url.startswith("chrome://"):
                return t["webSocketDebuggerUrl"]
    # Second pass: fall back to any page target
    for t in data:
        if t.get("type") == "page":
            return t["webSocketDebuggerUrl"]
    return None


def cdp_reachable():
    """Return True if a responsive CDP endpoint is already on the port."""
    try:
        urllib.request.urlopen(CDP + "/json", timeout=2).read()
        return True
    except Exception:
        return False


def kill_cdp_port_holders():
    """Kill only the process bound to the CDP port (127.0.0.1:19222),
    not every Edge/WebView2 on the machine. Avoids nuking the user's
    open browser sessions."""
    import subprocess

    try:
        out = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "Get-NetTCPConnection -LocalPort %d -ErrorAction SilentlyContinue "
                "| Select-Object -ExpandProperty OwningProcess" % CDP_PORT,
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        pids = {p.strip() for p in out.stdout.splitlines() if p.strip()}
    except Exception:
        return 0

    killed = 0
    for pid in pids:
        try:
            subprocess.run(
                ["taskkill", "/F", "/PID", pid],
                capture_output=True,
                check=False,
            )
            killed += 1
        except Exception:
            pass
    return killed


def cleanup_environment():
    """Health-check cleanup: reuse a live CDP instance, kill only a dead one.

    The render connects to an externally-launched Edge CDP instance on
    127.0.0.1:19222 (see SKILL.md Step 6). We must NOT kill a working
    instance or we'd break our own connection. So:
      - port reachable -> reuse, do not kill (满足「续渲不杀」)
      - port occupied but CDP unresponsive -> stale/broken instance, kill by PID
      - port free -> nothing to do
    """
    if cdp_reachable():
        print(
            "[cleanup] CDP already live on port %d — reusing existing instance (no kill)."
            % CDP_PORT,
            flush=True,
        )
        return

    killed = kill_cdp_port_holders()
    if killed:
        print(
            "[cleanup] killed %d stale CDP port holder(s) on port %d"
            % (killed, CDP_PORT),
            flush=True,
        )
    else:
        print("[cleanup] port %d free — no Edge to clean" % CDP_PORT, flush=True)


async def main():
    import websockets

    # Pre-flight cleanup
    cleanup_environment()

    html_path = sys.argv[1]
    frames_dir = sys.argv[2]
    fps = float(sys.argv[3]) if len(sys.argv) > 3 else 25.0
    start_frame = int(sys.argv[4]) if len(sys.argv) > 4 else 0
    DURATION = resolve_duration(sys.argv)

    # 清理旧帧（避免残留帧混入新渲染）
    if start_frame == 0 and os.path.exists(frames_dir):
        for f in os.listdir(frames_dir):
            if f.startswith("frame_") and f.endswith(".jpg"):
                os.remove(os.path.join(frames_dir, f))
        print("[cleanup] old frames cleared", flush=True)

    os.makedirs(frames_dir, exist_ok=True)

    if html_path.startswith("http://") or html_path.startswith("https://"):
        file_url = html_path
    else:
        # 用 pathlib 生成 file:// URL：旧实现把 /d/ 硬编码替换成 D:/，
        # 文章放在其它盘符时会拼出错误 URL 导致渲染失败。
        file_url = Path(os.path.abspath(html_path)).as_uri()

    ws_url = await get_page_ws()
    if not ws_url:
        print("NO PAGE TARGET")
        return

    ws = await websockets.connect(ws_url, max_size=50 * 1024 * 1024)
    pending = {}
    seq = 0

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

    # 设置视口
    await send(
        "Emulation.setDeviceMetricsOverride",
        {"width": 1080, "height": 1920, "deviceScaleFactor": 1, "mobile": False},
    )

    await send("Page.enable")
    await send("Page.navigate", {"url": file_url})

# 等待页面就绪
    print("waiting for page ready...", flush=True)
    ready = False
    t0 = time.time()

    def _norm(u):
        from urllib.parse import unquote

        return unquote(u).replace("file:///", "file://").rstrip("/").lower()

    target_norm = _norm(file_url)
    for _ in range(60):
        r = await send(
            "Runtime.evaluate",
            {
                "expression": "document.readyState === 'complete' && !!window.__timelines && !!window.__timelines.main && document.URL",
                "returnByValue": True,
            },
        )
        v = r.get("result", {}).get("result", {}).get("value")
        if v and _norm(v) == target_norm:
            ready = True
            break
        await asyncio.sleep(0.5)

    print("page ready:", ready, "after %.1fs" % (time.time() - t0), flush=True)
    if not ready:
        print("FATAL: page not ready")
        return

    # 等待字体和图片
    for _ in range(20):
        r = await send(
            "Runtime.evaluate",
            {
                "expression": "(document.fonts.status === 'loaded') && Array.from(document.images).every(i => i.complete)",
                "returnByValue": True,
            },
        )
        if r.get("result", {}).get("result", {}).get("value"):
            break
        await asyncio.sleep(0.5)

    await asyncio.sleep(1.0)

    # 探针
    r = await send(
        "Runtime.evaluate",
        {
            "expression": "document.URL + ' | tl:' + (!!window.__timelines.main) + ' | clips:' + document.querySelectorAll('.clip').length + ' | caps:' + document.querySelectorAll('.caption').length",
            "returnByValue": True,
        },
    )
    print("probe:", r.get("result", {}).get("result", {}).get("value", ""), flush=True)

    # ── 关键修正（P2）：以页面实时 GSAP timeline 时长为基准 ──
    # segments.json 的 total_duration 是配音/口播时长口径，而 GSAP 时间轴
    # 实际时长（含片尾 CTA 段）可能略长。若直接用它做 progress 分母，会让
    # 场景整体提前约 0.4s。这里渲染前读取 window.__timelines.main.duration()
    # 覆盖 DURATION，使第 i 帧严格落在 i/fps 秒，消除累计偏移。
    try:
        r = await send(
            "Runtime.evaluate",
            {
                "expression": "String(window.__timelines && window.__timelines.main ? window.__timelines.main.duration() : '')",
                "returnByValue": True,
            },
        )
        live = float(r.get("result", {}).get("result", {}).get("value", "") or 0)
        if live > 0 and abs(live - DURATION) > 0.05:
            print(
                "duration override: segments=%.3f -> timeline=%.3f" % (DURATION, live),
                flush=True,
            )
            DURATION = live
        elif live > 0:
            DURATION = live
    except Exception as e:
        print(
            "live duration probe failed, fall back to %s: %s" % (DURATION, e),
            flush=True,
        )

    total = int(round(DURATION * fps))
    t0 = time.time()

    for i in range(start_frame, total + 1):
        fp = os.path.join(frames_dir, "frame_%05d.jpg" % i)
        if os.path.exists(fp) and os.path.getsize(fp) > 1000:
            continue

        t = (i / total) * DURATION
        ok = False
        for attempt in range(3):
            try:
                await send(
                    "Runtime.evaluate",
                    {"expression": "(() => { window.__timelines.main.pause().time(%f); return 0; })()" % t},
                )
                await asyncio.sleep(0.02)
                r = await send(
                    "Page.captureScreenshot", {"format": "jpeg", "quality": 88}
                )
                if "result" not in r or "data" not in r.get("result", {}):
                    raise RuntimeError("empty screenshot: %s" % r.get("error"))
                with open(fp, "wb") as f:
                    f.write(base64.b64decode(r["result"]["data"]))
                ok = True
                break
            except Exception as e:
                print(
                    "frame %d attempt %d failed: %r" % (i, attempt + 1, e), flush=True
                )
                await asyncio.sleep(1.0)
        if not ok:
            # 不跳过（跳帧会留空号，ffmpeg 图像序列会在此处断掉）；干净退出以便断点续跑
            print(
                "STOPPED at frame %d after retries. Resume with:\n"
                "  python render_frames.py %s %s %s %d"
                % (i, html_path, frames_dir, fps, i),
                flush=True,
            )
            return

        if i % (fps * 10) == 0:
            el = time.time() - t0
            print("frame", i, "/", total, "%.0fs" % el, flush=True)

    print("DONE", total + 1 - start_frame, "frames in %.0fs" % (time.time() - t0))


if __name__ == "__main__":
    asyncio.run(main())
