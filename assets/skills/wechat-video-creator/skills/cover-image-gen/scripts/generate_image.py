#!/usr/bin/env python3
"""文生图脚本：调用 ModelScope（异步任务）或 Agnes（同步 b64）生成图片并保存。

用法：
  python3 generate_image.py --provider modelscope --prompt "..." --output cover.png
  python3 generate_image.py --provider agnes --prompt "..." --output cover.png

API Key 优先取 --api-key，否则读环境变量 MODELSCOPE_API_KEY / AGNES_API_KEY。

统一参数：
  --resolution 1K|2K|4K      分辨率等级（默认 2K）
  --aspect_ratio 9:16|16:9|1:1|...  宽高比（默认 16:9）
  --size WxH                 ModelScope 尺寸（别名，向后兼容；自动反解为 resolution/aspect_ratio）
  --ratio W:H                Agnes 宽高比（别名，向后兼容；须为合法宽高比）

自检模式：
  python3 generate_image.py --self-check
"""
import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

DEFAULT_MODELSCOPE_BASE = "https://api-inference.modelscope.cn"
DEFAULT_MODELSCOPE_MODEL = "Qwen/Qwen-Image-2512"
DEFAULT_AGNES_BASE = "https://apihub.agnes-ai.com/v1"
DEFAULT_AGNES_MODEL = "agnes-image-2.1-flash"

POLL_INTERVAL_SECONDS = 3

# 统一的分辨率与宽高比映射
RESOLUTION_MAP = {
    "1K": "1K",
    "2K": "2K",
    "4K": "4K",
}

ASPECT_RATIO_MAP = {
    "1:1": "1:1",
    "9:16": "9:16",
    "16:9": "16:9",
    "2:3": "2:3",
    "3:2": "3:2",
    "3:4": "3:4",
    "4:3": "4:3",
    "21:9": "21:9",
    "9:21": "9:21",
}

# ModelScope 尺寸映射（resolution x aspect_ratio -> size）
MODELSCOPE_SIZE_MAP = {
    ("1K", "1:1"): "1024x1024",
    ("2K", "1:1"): "2048x2048",
    ("4K", "1:1"): "2880x2880",
    ("1K", "9:16"): "720x1280",
    ("2K", "9:16"): "1584x2816",
    ("4K", "9:16"): "2160x3840",
    ("1K", "16:9"): "1280x720",
    ("2K", "16:9"): "2816x1584",
    ("4K", "16:9"): "3840x2160",
    ("1K", "2:3"): "832x1248",
    ("2K", "2:3"): "1664x2496",
    ("4K", "2:3"): "2336x3504",
    ("1K", "3:2"): "1248x832",
    ("2K", "3:2"): "2496x1664",
    ("4K", "3:2"): "3504x2336",
    ("1K", "3:4"): "864x1152",
    ("2K", "3:4"): "1776x2368",
    ("4K", "3:4"): "2448x3264",
    ("1K", "4:3"): "1152x864",
    ("2K", "4:3"): "2368x1776",
    ("4K", "4:3"): "3264x2448",
    ("1K", "21:9"): "1568x672",
    ("2K", "21:9"): "3136x1344",
    ("4K", "21:9"): "3808x1632",
    ("1K", "9:21"): "672x1568",
    ("2K", "9:21"): "1344x3136",
    ("4K", "9:21"): "1632x3808",
}

# 反查表：size -> (resolution, aspect_ratio)，用于 --size 向后兼容
SIZE_TO_PARAMS = {v: k for k, v in MODELSCOPE_SIZE_MAP.items()}
# 旧版本脚本的默认 size（1024x576）不在映射表中，单独保留兼容
LEGACY_SIZES = {"1024x576": ("1K", "16:9"), "576x1024": ("1K", "9:16")}


def http_json(req: urllib.request.Request, timeout: int):
    """返回 (status, body_text)。HTTPError 也读出响应体用于报错。"""
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8", "replace")


def download_image(url: str, timeout: int):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.headers.get("content-type", ""), resp.read()


def extension_for(content_type: str) -> str:
    # 按响应 content-type 决定扩展名，缺失时默认 png
    if "jpeg" in content_type:
        return ".jpg"
    if "webp" in content_type:
        return ".webp"
    return ".png"


def resolve_size(resolution: str, aspect_ratio: str) -> str:
    """将统一的 resolution + aspect_ratio 映射为 ModelScope size 参数"""
    key = (resolution, aspect_ratio)
    if key in MODELSCOPE_SIZE_MAP:
        return MODELSCOPE_SIZE_MAP[key]
    # 回退：尝试反推
    print(f"[警告] 未知组合 resolution={resolution} aspect_ratio={aspect_ratio}，使用 1024x576", file=sys.stderr)
    return "1024x576"


def gen_modelscope(prompt: str, size: str, api_key: str, base_url: str, model: str, timeout: int) -> str:
    base = (base_url or DEFAULT_MODELSCOPE_BASE).rstrip("/")
    submit = urllib.request.Request(
        f"{base}/v1/images/generations",
        data=json.dumps({"model": model or DEFAULT_MODELSCOPE_MODEL, "prompt": prompt, "n": 1, "size": size}).encode("utf-8"),
        headers={
            "authorization": f"Bearer {api_key}",
            "content-type": "application/json",
            # 必须声明异步模式，服务端才会返回 task_id
            "x-modelscope-async-mode": "true",
        },
        method="POST",
    )
    status, text = http_json(submit, timeout)
    if status == 429:
        # ModelScope 会把突发限流误报为 insufficient balance，退避重试一次
        time.sleep(2)
        status, text = http_json(submit, timeout)
    if status != 200:
        raise RuntimeError(f"ModelScope 提交失败（HTTP {status}）：{text[:200]}")
    task_id = json.loads(text).get("task_id")
    if not task_id:
        raise RuntimeError("ModelScope 没有返回生图任务 ID。")

    deadline = time.monotonic() + timeout
    while True:
        time.sleep(POLL_INTERVAL_SECONDS)
        poll = urllib.request.Request(
            f"{base}/v1/tasks/{task_id}",
            headers={
                "authorization": f"Bearer {api_key}",
                "x-modelscope-task-type": "image_generation",
            },
        )
        status, text = http_json(poll, timeout)
        if status != 200:
            raise RuntimeError(f"ModelScope 轮询失败（HTTP {status}）：{text[:200]}")
        task = json.loads(text)
        if task.get("task_status") == "SUCCEED":
            images = task.get("output_images") or []
            if not images:
                raise RuntimeError("ModelScope 任务成功但没有返回图片地址。")
            return images[0]
        if task.get("task_status") == "FAILED":
            raise RuntimeError(f"ModelScope 生图失败：{json.dumps(task.get('errors') or task, ensure_ascii=False)[:300]}")
        if time.monotonic() > deadline:
            raise RuntimeError(f"ModelScope 轮询超过 {timeout} 秒仍未完成（task_id={task_id}）。任务不会丢失，可重新轮询。")


def gen_agnes(prompt: str, ratio: str, size: str, api_key: str, base_url: str, model: str, timeout: int) -> tuple[str, bytes]:
    base = (base_url or DEFAULT_AGNES_BASE).rstrip("/")
    req = urllib.request.Request(
        f"{base}/images/generations",
        data=json.dumps({
            "model": model or DEFAULT_AGNES_MODEL,
            "prompt": prompt,
            "size": size,
            "ratio": ratio,
            "n": 1,
            "response_format": "b64_json",
        }).encode("utf-8"),
        headers={"authorization": f"Bearer {api_key}", "content-type": "application/json"},
        method="POST",
    )
    status, text = http_json(req, timeout)
    if status != 200:
        raise RuntimeError(f"Agnes 生图请求失败（HTTP {status}）：{text[:300]}")
    payload = json.loads(text)
    first = (payload.get("data") or [None])[0]
    if not first:
        raise RuntimeError("Agnes 已返回结果，但没有可用的图片数据。请调整提示词后重试。")
    if first.get("b64_json"):
        # b64_json 返回固定为 png
        return "image/png", base64.b64decode(first["b64_json"])
    if first.get("url"):
        return download_image(first["url"], timeout)
    raise RuntimeError("Agnes 返回了无法解析的图片结果。")


def self_check() -> int:
    """自检：验证扩展名映射、参数映射、网络可达性、环境变量"""
    print("=== cover-image-gen 自检 ===")
    ok = True

    # 1. 扩展名映射
    assert extension_for("image/jpeg") == ".jpg"
    assert extension_for("image/webp") == ".webp"
    assert extension_for("") == ".png"
    assert extension_for("image/png") == ".png"
    print("[✓] extension_for 映射正确")

    # 2. 尺寸映射表完整性
    for res in RESOLUTION_MAP:
        for ar in ASPECT_RATIO_MAP:
            try:
                resolve_size(res, ar)
            except KeyError:
                print(f"[✗] 缺少映射: resolution={res} aspect_ratio={ar}")
                ok = False
    if ok:
        print(f"[✓] 尺寸映射表完整（{len(RESOLUTION_MAP)}×{len(ASPECT_RATIO_MAP)}={len(RESOLUTION_MAP)*len(ASPECT_RATIO_MAP)} 组合）")

    # 3. 环境变量
    ms_key = os.environ.get("MODELSCOPE_API_KEY")
    ag_key = os.environ.get("AGNES_API_KEY")
    if ms_key:
        print(f"[✓] MODELSCOPE_API_KEY 已设置（长度 {len(ms_key)}）")
    else:
        print("[!] MODELSCOPE_API_KEY 未设置")
    if ag_key:
        print(f"[✓] AGNES_API_KEY 已设置（长度 {len(ag_key)}）")
    else:
        print("[!] AGNES_API_KEY 未设置")

    # 4. 网络可达性（HEAD 请求，不下载）
    import socket
    socket.setdefaulttimeout(5)
    for name, url in [("ModelScope", DEFAULT_MODELSCOPE_BASE + "/v1/images/generations"),
                       ("Agnes", DEFAULT_AGNES_BASE + "/images/generations")]:
        try:
            req = urllib.request.Request(url, method="HEAD")
            with urllib.request.urlopen(req, timeout=5) as resp:
                print(f"[✓] {name} 可达（HTTP {resp.status}）")
        except urllib.error.HTTPError as e:
            # POST-only 端点 HEAD/GET 可能 404/405，只要能连上 TCP 就算通
            if e.code in (404, 405):
                print(f"[✓] {name} 可达（HTTP {e.code}，POST-only 端点属正常）")
            else:
                print(f"[✗] {name} 不可达：HTTP {e.code}")
                ok = False
        except Exception as e:
            print(f"[✗] {name} 不可达：{e}")
            ok = False

    if ok:
        print("\n=== 自检通过：所有检查项正常 ===")
        return 0
    else:
        print("\n=== 自检失败：存在上述问题，请修正后重试 ===")
        return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="文生图：ModelScope（异步）/ Agnes（同步 b64）")
    parser.add_argument("--provider", choices=["modelscope", "agnes"], default="modelscope")
    parser.add_argument("--prompt", default="", help="用户确认后的生图提示词")
    parser.add_argument("--api-key", default=None)
    parser.add_argument("--base-url", default=None)
    parser.add_argument("--model", default=None)
    # 统一参数
    parser.add_argument("--resolution", choices=["1K", "2K", "4K"], default="2K", help="分辨率等级（默认 2K）")
    parser.add_argument("--aspect_ratio", choices=list(ASPECT_RATIO_MAP.keys()), default="16:9", help="宽高比（默认 16:9）")
    # 向后兼容别名
    parser.add_argument("--size", default=None, help="ModelScope 图片尺寸（别名，向后兼容）")
    parser.add_argument("--ratio", default=None, help="Agnes 宽高比（别名，向后兼容）")
    parser.add_argument("--output", default="", help="图片保存路径")
    parser.add_argument("--timeout", type=int, default=300, help="轮询/请求超时秒数")
    parser.add_argument("--dry-run", action="store_true", help="只打印参数，不联网")
    parser.add_argument("--self-check", action="store_true", help="运行自检后退出")
    args = parser.parse_args()

    if args.self_check:
        return self_check()

    if not args.prompt.strip():
        print("错误：prompt 不能为空。请先完成提示词生成阶段并经用户确认。", file=sys.stderr)
        return 1
    if not args.output:
        print("错误：缺少 --output 图片保存路径。", file=sys.stderr)
        return 1

    # 解析统一参数 -> 实际传给 API 的参数
    resolution = args.resolution
    aspect_ratio = args.aspect_ratio
    if args.size:
        # 向后兼容：--size "WxH" 反查 resolution/aspect_ratio，查不到则显式报错
        params = SIZE_TO_PARAMS.get(args.size.strip().lower()) or LEGACY_SIZES.get(args.size.strip().lower())
        if not params:
            valid = ", ".join(sorted(SIZE_TO_PARAMS))
            print(f"错误：--size {args.size} 无法映射到 --resolution/--aspect_ratio 组合。合法取值：{valid}", file=sys.stderr)
            return 1
        resolution, aspect_ratio = params
        print(f"[提示] --size {args.size} 已反解为 --resolution {resolution} --aspect_ratio {aspect_ratio}，建议改用统一参数", file=sys.stderr)
    if args.ratio:
        if args.ratio not in ASPECT_RATIO_MAP:
            print(f"错误：--ratio {args.ratio} 不在合法宽高比列表：{', '.join(ASPECT_RATIO_MAP)}", file=sys.stderr)
            return 1
        aspect_ratio = args.ratio
        print(f"[提示] 检测到 --ratio 参数，建议改用 --aspect_ratio", file=sys.stderr)

    # 计算 ModelScope 的 size
    size = resolve_size(resolution, aspect_ratio)

    env_key = "MODELSCOPE_API_KEY" if args.provider == "modelscope" else "AGNES_API_KEY"
    api_key = args.api_key or os.environ.get(env_key)

    if args.dry_run:
        print(json.dumps({
            "provider": args.provider,
            "prompt": args.prompt,
            "resolution": resolution,
            "aspect_ratio": aspect_ratio,
            "size": size if args.provider == "modelscope" else None,
            "ratio": aspect_ratio if args.provider == "agnes" else None,
            "model": args.model,
            "output": args.output,
            "timeout": args.timeout,
        }, ensure_ascii=False, indent=2))
        return 0

    if not api_key:
        print(f"错误：缺少 API Key，请传 --api-key 或设置环境变量 {env_key}。", file=sys.stderr)
        return 1

    try:
        if args.provider == "modelscope":
            image_url = gen_modelscope(args.prompt, size, api_key, args.base_url, args.model, args.timeout)
            content_type, data = download_image(image_url, args.timeout)
        else:
            content_type, data = gen_agnes(args.prompt, aspect_ratio, resolution, api_key, args.base_url, args.model, args.timeout)
    except (RuntimeError, urllib.error.URLError) as err:
        print(f"生图失败：{err}", file=sys.stderr)
        return 2

    output = args.output
    stem, ext = os.path.splitext(output)
    if not ext:
        output = stem + extension_for(content_type)
    elif ext.lower() != extension_for(content_type):
        print(
            "警告：--output 扩展名 %s 与响应 content-type %s 推导的 %s 不一致，按原路径保存。"
            % (ext, content_type or "unknown", extension_for(content_type)),
            file=sys.stderr,
        )
    with open(output, "wb") as fh:
        fh.write(data)
    if len(data) > 15 * 1024 * 1024:
        print(f"警告：图片 {len(data) // 1024 // 1024} MB，超过 15 MB 上限，请检查用途。", file=sys.stderr)
    print(f"已保存：{output}（{content_type or 'unknown'}，{len(data)} 字节）")
    return 0


if __name__ == "__main__":
    sys.exit(main())