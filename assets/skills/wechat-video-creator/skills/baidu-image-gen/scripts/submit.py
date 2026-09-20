"""
异步图像生成（提交任务）
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path
import sys
from loguru import logger
import os
import requests
import templates
import time
import json
from utils import get_proxy_parmas, build_default_output_path, normalize_reference_inputs, DEFAULT_UPLOAD_API_URL, is_valid_image_size, fit_image_size, classify_response, filter_prompt, add_timestamp


DEFAULT_MODEL = "dumate-image2.2"
DEFAULT_ASPECT_RATIO = "1:1"
DEFAULT_RESOLUTION = "2K"

# 提交阶段撞上限流时，先原地等待重试同一个模型，避免无谓的画质降级
RATE_LIMIT_RETRY_INTERVAL = 1  # 限流后的等待间隔（秒）
RATE_LIMIT_MAX_RETRIES = 2      # 限流后最多重试次数

DEFAULT_API_V3_URL = os.getenv(
    "DUMATE_API_V3_URL",
    "https://qianfan.baidubce.com/v2/tools/dumate/image_generate_v3/async",
)

DEFAULT_API_V2_URL = os.getenv(
    "DUMATE_API_V2_URL",
    "https://qianfan.baidubce.com/v2/tools/dumate/image_generate_v2/async",
)

DEFAULT_API_V1_URL = os.getenv(
    "DUMATE_API_V1_URL",
    "https://qianfan.baidubce.com/v2/tools/dumate/image_generate/async",
)

DEFAULT_API_V0_URL = os.getenv(
    "DUMATE_IMAGE_V0_API_URL",
    "https://qianfan.baidubce.com/beta/image/qianfan-image-v1",
)

DEFAULT_TIMEOUT = 300


SUPPORTED_MODELS = ["dumate-image2.2", "dumate-image2.1", "dumate-image1.2", "dumate-image0.1"]
FALLBACK_CHAIN = ["dumate-image2.2", "dumate-image2.1", "dumate-image1.2", "dumate-image0.1"]

V3_SUPPORTED_RESOLUTIONS = ["1K", "2K", "4K"]
V3_SUPPORTED_ASPECT_RATIOS = ["1:1", "3:2", "2:3", "3:4", "4:3", "16:9", "9:16", "21:9", "9:21"]


def self_check() -> int:
    """自检：验证环境变量、代理可达性、模型列表、参数合法性"""
    print("=== baidu-image-gen (submit.py) 自检 ===")
    ok = True

    # 1. 检查环境变量或配置文件中的 AK/SK
    ak = os.getenv("BAIDU_AK") or os.getenv("QIANFAN_AK")
    sk = os.getenv("BAIDU_SK") or os.getenv("QIANFAN_SK")
    if ak and sk:
        print(f"[✓] 百度 AK/SK 已设置（AK长度 {len(ak)}，SK长度 {len(sk)}）")
    else:
        print("[!] BAIDU_AK/BAIDU_SK 或 QIANFAN_AK/QIANFAN_SK 未设置（可能通过代理注入）")

    # 2. 网络可达性
    import socket
    socket.setdefaulttimeout(5)
    for name, url in [
        ("千帆V3", DEFAULT_API_V3_URL),
        ("千帆V2", DEFAULT_API_V2_URL),
        ("千帆V1", DEFAULT_API_V1_URL),
        ("千帆V0", DEFAULT_API_V0_URL),
        ("上传BOS", DEFAULT_UPLOAD_API_URL),
    ]:
        try:
            from urllib.parse import urlparse
            parsed = urlparse(url)
            host = parsed.hostname
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
            sock = socket.create_connection((host, port), timeout=5)
            sock.close()
            print(f"[✓] {name} ({host}:{port}) 可达")
        except Exception as e:
            print(f"[✗] {name} ({url}) 不可达：{e}")
            ok = False

    # 3. 模型列表一致性
    if SUPPORTED_MODELS == FALLBACK_CHAIN:
        print(f"[✓] 模型列表一致：{SUPPORTED_MODELS}")
    else:
        print(f"[✗] SUPPORTED_MODELS 与 FALLBACK_CHAIN 不一致")
        ok = False

    # 4. 参数表完整性
    for ar, res_map in V2_SUPPORTED_PARAMETERS.items():
        for res in V3_SUPPORTED_RESOLUTIONS:
            if res not in res_map:
                print(f"[✗] V2 缺少映射: aspect_ratio={ar} resolution={res}")
                ok = False
    if ok:
        print(f"[✓] V2 参数表完整（{len(V2_SUPPORTED_PARAMETERS)} 宽高比 × {len(V3_SUPPORTED_RESOLUTIONS)} 分辨率）")

    if ok:
        print("\n=== 自检通过：所有检查项正常 ===")
        return 0
    else:
        print("\n=== 自检失败：存在上述问题，请修正后重试 ===")
        return 1


V2_SUPPORTED_PARAMETERS = {
    "1:1": {
        "1K": "1024x1024",
        "2K": "2048x2048",
        "4K": "2880x2880"
    },
    "2:3": {
        "1K": "832x1248",
        "2K": "1664x2496",
        "4K": "2336x3504"
    },
    "3:2": {
        "1K": "1248x832",
        "2K": "2496x1664",
        "4K": "3504x2336"
    },
    "3:4": {
        "1K": "864x1152",
        "2K": "1776x2368",
        "4K": "2448x3264"
    },
    "4:3": {
        "1K": "1152x864",
        "2K": "2368x1776",
        "4K": "3264x2448"
    },
    "4:5": {
        "1K": "896x1120",
        "2K": "1856x2320",
        "4K": "2560x3200"
    },
    "5:4": {
        "1K": "1120x896",
        "2K": "2320x1856",
        "4K": "3200x2560"
    },
    "9:16": {
        "1K": "720x1280",
        "2K": "1584x2816",
        "4K": "2160x3840"
    },
    "16:9": {
        "1K": "1280x720",
        "2K": "2816x1584",
        "4K": "3840x2160"
    },
    "21:9": {
        "1K": "1568x672",
        "2K": "3136x1344",
        "4K": "3808x1632"
    },
    "9:21": {
        "1K": "672x1568",
        "2K": "1344x3136",
        "4K": "1632x3808"
    },
}

V1_SUPPORTED_RESOLUTIONS = ["1K", "2K", "4K"]
V1_SUPPORTED_ASPECT_RATIOS = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"]

V0_SUPPORTED_RESOLUTIONS = {
    "1K": "1k",
    "2K": "2k"
}

V0_SUPPORTED_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"]


def resolve_template_urls(template_id: str, pages: list) -> list:
    """按模板 id 和页码直接从模板库读取参考图 URL，避免人工转抄签名串。"""
    categories = templates.parse_categories(templates.read_lines())
    library = templates.parse_templates(categories)
    if template_id not in library:
        raise ValueError(
            f"模板不存在: {template_id}，请先执行 templates.py category 获取候选模板 id"
        )

    _, block = library[template_id]
    urls = templates.extract_urls(template_id, block)

    resolved = []
    for page in pages:
        if not 1 <= page <= len(urls):
            raise ValueError(
                f"模板 {template_id} 只有 {len(urls)} 页，无法读取第 {page} 页"
            )
        resolved.append(urls[page - 1])
    return resolved


def verify_template_urls(urls: list, timeout: int) -> None:
    """只校验模板参考图是否可访问；本地取不到响应时放行，不阻塞提交。

    仅用于 --template_id 解析出的模板参考图。用户自行传入的 --image_url
    与 --image_path 不做校验：它们可能需要鉴权或不支持 Range 请求，本地
    探测失败并不代表上游模型取不到图。
    """
    for index, url in enumerate(urls, 1):
        try:
            response = requests.get(
                url, headers={"Range": "bytes=0-0"}, timeout=(10, min(timeout, 30))
            )
        except requests.RequestException as exc:
            # 拿不到响应说明本地网络不通，与图片本身是否有效无关；
            # 上游模型从自己的服务端取图，此处放行避免误杀。
            logger.info(f"[提示] 第 {index} 张模板参考图无法探测({exc})，已跳过校验直接提交")
            continue

        if response.status_code not in (200, 206):
            raise RuntimeError(
                f"第 {index} 张模板参考图不可访问 HTTP {response.status_code}: {url}\n"
                f"响应: {response.text[:200]}\n"
                f"该模板参考图可能已失效或被替换。请重新执行 "
                f"templates.py urls <template_id> 确认模板库内容；"
                f"这不是模型问题，切换 --model 无法解决。"
            )
        logger.info(f"[校验] 第 {index} 张模板参考图可访问 HTTP {response.status_code}")


class SubmitRateLimited(RuntimeError):
    """重试后仍然被限流。任务未创建，可切换模型重试。"""


class SubmitFailed(RuntimeError):
    """提交失败且与模型无关，切换模型解决不了。"""


def post_submit(url: str, headers: dict, payload: dict, timeout: int, model: str) -> dict:
    """提交生图请求，返回千帆业务信封。

    只有在明确识别为限流时才重试：限流意味着任务没有创建成功，重试是安全的。
    其他错误一律不重试——例如读超时可能是服务端已建好任务、只是响应没回来，
    重试会重复创建任务并重复计费。
    """
    for attempt in range(RATE_LIMIT_MAX_RETRIES + 1):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=(10, min(timeout, 60)))
        except requests.RequestException as exc:
            raise SubmitFailed(f"提交请求异常: {exc}") from exc

        state, body, detail = classify_response(resp)

        if state == "ok":
            return body

        if state == "rate_limited":
            logger.warning(f"[限流] {detail}")
            if attempt < RATE_LIMIT_MAX_RETRIES:
                print(f"[限流] {model} 超出 QPS 限制，任务未创建，"
                      f"{RATE_LIMIT_RETRY_INTERVAL} 秒后重试同一模型"
                      f"（第 {attempt + 1}/{RATE_LIMIT_MAX_RETRIES} 次）")
                time.sleep(RATE_LIMIT_RETRY_INTERVAL)
                continue
            raise SubmitRateLimited(
                f"{model} 连续 {RATE_LIMIT_MAX_RETRIES + 1} 次超出 QPS 限制，任务未创建。{detail}"
            )

        raise SubmitFailed(f"千帆图像提交失败: {detail}")


def submit_task(
        prompt: str,
        model: str,
        resolution: str,
        aspect_ratio: str,
        pixel: str,
        image_url: list,
        image_path: list,
        api_base_url: str,
        upload_api_url: str,
        timeout: int,
        output: str,
        template_id: str = None,
        page: list = None
    ) -> str:
    """
    提交图像生成任务，立即返回 task_id。
      - image_url/image_path=None  → text2image（文生图像）
      - image_url/image_path 有值  → image2image（参考生图）
      - template_id/page 有值      → 由脚本从模板库解析参考图 URL（仅小红书模板）
    """

    template_urls = []
    if template_id:
        template_urls = resolve_template_urls(template_id, page or [])
        verify_template_urls(template_urls, timeout)

    reference_urls = normalize_reference_inputs(
        image_urls=template_urls + list(image_url or []),
        image_paths=image_path,
        upload_api_url=upload_api_url,
    )

    # 首选 V3 模型
    if model == "dumate-image2.2":

        url = DEFAULT_API_V3_URL.rstrip("/")
        url, extra_headers = get_proxy_parmas(url)

        headers = {
            "Content-Type": "application/json",
            **extra_headers,
        }

        if not pixel:
            if aspect_ratio not in V3_SUPPORTED_ASPECT_RATIOS:
                print(f"[提示] {aspect_ratio}是不支持的宽高比，已自动使用 1:1 宽高比提交任务")
                aspect_ratio = "1:1"

            if resolution not in V3_SUPPORTED_RESOLUTIONS:
                print(f"[提示] {resolution}是不支持的分辨率，已自动使用 2K 分辨率提交任务")
                resolution = "2K"

            payload = {
                "query": prompt,
                "model": model,
                "quality": "low",
                "resolution": resolution,
                "aspectRatio": aspect_ratio,
                "maxImagesNum": 1,
            }
        else:
            payload = {
                "query": prompt,
                "model": model,
                "quality": "low",
                "maxImagesNum": 1,
                "size":pixel
            }
        if reference_urls:
            payload["imageUrls"] = reference_urls

        result = post_submit(url, headers, payload, timeout, model)
        task_id = result.get("task_id")
        if not task_id:
            raise SubmitFailed(f"响应中缺少 task_id: {result}")
        logger.info(f"[千帆] 任务已提交 task_id={task_id}  requestId={result.get('requestId')}")
        return task_id


    # V2 是 V3 的兜底
    if model == "dumate-image2.1":

        url = DEFAULT_API_V2_URL.rstrip("/")
        url, extra_headers = get_proxy_parmas(url)

        headers = {
            "Content-Type": "application/json",
            **extra_headers,
        }

        if not pixel:
            if aspect_ratio not in V2_SUPPORTED_PARAMETERS.keys():
                print(f"[提示] {aspect_ratio}是不支持的宽高比，已自动使用 1:1 宽高比提交任务")
                aspect_ratio = "1:1"
            ratio_map = V2_SUPPORTED_PARAMETERS.get(aspect_ratio)

            if resolution not in ratio_map.keys():
                print(f"[提示] {resolution}是不支持的分辨率，已自动使用 2K 分辨率提交任务")
                resolution = "2K"
            v2_resolution = ratio_map.get(resolution)

            payload = {
                "query": prompt,
                "model": model,
                "resolution": "low",
                "aspectRatio": v2_resolution,
                "maxImagesNum": 1,
            }
        else:
            payload = {
                "query": prompt,
                "model": model,
                "resolution": "low",
                "aspectRatio": pixel,
                "maxImagesNum": 1,
            }

        if reference_urls:
            payload["imageUrls"] = reference_urls

        result = post_submit(url, headers, payload, timeout, model)
        task_id = result.get("task_id")
        if not task_id:
            raise SubmitFailed(f"响应中缺少 task_id: {result}")
        logger.info(f"[千帆] 任务已提交 task_id={task_id}  requestId={result.get('requestId')}")
        return task_id

    # V1 是 V2 的兜底
    elif model == "dumate-image1.2":
        if resolution not in V1_SUPPORTED_RESOLUTIONS:
            print(f"[提示] {resolution}是不支持的分辨率，已自动使用 2K 分辨率提交任务")
            resolution = "2K"
        v1_resolution = resolution

        if aspect_ratio not in V1_SUPPORTED_ASPECT_RATIOS:
            print(f"[提示] {aspect_ratio}是不支持的宽高比，已自动使用 1:1 宽高比提交任务")
            aspect_ratio = "1:1"
        v1_aspect_ratio = aspect_ratio

        if pixel:
            print(f"当前 {model} 模型不支持指定像素大小，将使用分辨率：{resolution} 和宽高比：{aspect_ratio} 执行任务。")

        url = DEFAULT_API_V1_URL.rstrip("/")
        url, extra_headers = get_proxy_parmas(url)

        headers = {
            "Content-Type": "application/json",
            **extra_headers,
        }
        payload = {
            "query": prompt,
            "model": model,
            "resolution": v1_resolution,
            "aspectRatio": v1_aspect_ratio,
        }
        if reference_urls:
            payload["imageUrls"] = reference_urls

        result = post_submit(url, headers, payload, timeout, model)
        task_id = result.get("task_id")
        if not task_id:
            raise SubmitFailed(f"响应中缺少 task_id: {result}")
        logger.info(f"[千帆] 任务已提交 task_id={task_id}  requestId={result.get('requestId')}")
        return task_id

    # V0 是 V1 的兜底
    elif model == "dumate-image0.1":
        if resolution not in V0_SUPPORTED_RESOLUTIONS.keys():
            print(f"[提示] {resolution}是不支持的分辨率，已自动使用 2K 分辨率提交任务")
            resolution = "2K"

        valid_resolution = V0_SUPPORTED_RESOLUTIONS.get(resolution)

        if aspect_ratio not in V0_SUPPORTED_ASPECT_RATIOS:
            print(f"[提示] {aspect_ratio}是不支持的宽高比，已自动使用 1:1 宽高比提交任务")
            aspect_ratio = "1:1"

        valid_aspect_ratio = aspect_ratio

        if pixel:
            print(f"当前 {model} 模型不支持指定像素大小，将使用分辨率：{resolution} 和宽高比：{aspect_ratio} 执行任务。")

        url = DEFAULT_API_V0_URL.rstrip("/")
        url, extra_headers = get_proxy_parmas(url)

        headers = {
            "Content-Type": "application/json",
            **extra_headers,
        }
        payload = {
            "model": model,
            "type": "omni",
        }
        model_parameters = {
            "prompt": prompt,
            "resolution": valid_resolution,
            "aspect_ratio": valid_aspect_ratio,
            "n": 1
        }
        if reference_urls:
            image_list = []
            for u in reference_urls:
                image_list.append({"image": u})
            model_parameters["image_list"] = image_list

        payload["model_parameters"] = model_parameters

        result = post_submit(url, headers, payload, timeout, model)
        task_id = (result.get("data") or {}).get("task_id")
        if not task_id:
            raise SubmitFailed(f"响应中缺少 task_id: {result}")
        logger.info(f"[千帆] 任务已提交 task_id={task_id}  requestId={result.get('requestId')}")
        return task_id

    else:
        raise SubmitFailed(f"不支持的模型名称：{model}")

def main():
    """主函数"""
    parser = argparse.ArgumentParser(description="根据提示词和一些可选参数提交图像生成任务，并返回一个字符串类型的任务 ID")
    parser.add_argument("--prompt", help="图像生成或图像编辑提示词")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"模型名称，默认 {DEFAULT_MODEL}")
    parser.add_argument("--resolution", default=DEFAULT_RESOLUTION, help=f"分辨率，默认 {DEFAULT_RESOLUTION}")
    parser.add_argument("--aspect_ratio", default=DEFAULT_ASPECT_RATIO, help=f"宽高比，默认 {DEFAULT_ASPECT_RATIO}")
    parser.add_argument("--pixel", help="生成图的像素值，例如 1024x1024")
    parser.add_argument("--image_url", action="append", default=[], help="参考图的 URL，可多次传入")
    parser.add_argument("--image_path", action="append", default=[], help="本地参考图的绝对路径，可多次传入")
    parser.add_argument("--template_id", help="小红书模板库中的模板 id，与 --page 配合使用，由脚本自行解析参考图 URL")
    parser.add_argument("--page", action="append", type=int, default=[], help="模板参考页页码，从 1 开始，可多次传入")
    parser.add_argument("--api_base_url", default=DEFAULT_API_V3_URL, help="模型请求接口，默认使用 dumate-image2.2 的请求接口")
    parser.add_argument("--upload_api_url", default=DEFAULT_UPLOAD_API_URL, help="请求上传 BOS 地址的接口")
    parser.add_argument("--timeout", type=int, default=300, help="请求超时（秒）时间")
    parser.add_argument("--output", help="生成的图像要保存的位置")
    parser.add_argument("--self-check", action="store_true", help="运行自检后退出")
    parser.add_argument("--dry-run", action="store_true", help="只打印参数，不联网")
    args = parser.parse_args()

    if args.self_check:
        return self_check()

    # 非自检模式下校验必填参数
    if not args.prompt:
        print("错误：--prompt 为必填参数")
        sys.exit(3)
    if not args.output:
        print("错误：--output 为必填参数")
        sys.exit(3)

    if args.dry_run:
        # dry-run 时 prompt 可为空
        if not args.prompt.strip():
            args.prompt = "<dry-run: 无提示词>"
        print(json.dumps({
            "model": args.model,
            "prompt": args.prompt,
            "resolution": args.resolution,
            "aspect_ratio": args.aspect_ratio,
            "pixel": args.pixel,
            "image_url": args.image_url,
            "image_path": args.image_path,
            "template_id": args.template_id,
            "page": args.page,
            "api_base_url": args.api_base_url,
            "upload_api_url": args.upload_api_url,
            "timeout": args.timeout,
            "output": args.output,
        }, ensure_ascii=False, indent=2))
        return 0

    result = filter_prompt(args.prompt)
    print(f"[提示词检查] {json.dumps(result, ensure_ascii=False)}")

    if result["action"] == "BLOCK":
        sys.exit(2)

    args.prompt = result["prompt"]

    if (args.template_id is None) != (not args.page):
        print("[参数错误] --template_id 与 --page 必须同时传入")
        sys.exit(3)

    bad_paths = [p for p in args.image_path if not Path(p).is_absolute()]
    if bad_paths:
        print(f"[参数错误] image_path 必须使用绝对路径: {bad_paths}")
        sys.exit(3)

    if os.path.isdir(args.output):
        print(f"{args.output} 是非法的图片保存路径")
        args.output = build_default_output_path()
        print(f"已生成默认的图片保存路径 {args.output}")

    output_path = args.output if args.output else build_default_output_path()

    # ── 提交任务 ──────────────────────────────────────────
    if not args.image_url and not args.image_path and not args.template_id:
        print(f"生图模式: 文生图像")

    else:
        print(f"生图模式: 参考生图")


    if args.model not in SUPPORTED_MODELS:
        print(f"[提示] {args.model}不在可支持的模型列表中，已自动使用 dumate-image2.2 模型提交任务")
        args.model = "dumate-image2.2"

    if args.pixel:
        m = re.fullmatch(r"(\d+)x(\d+)", args.pixel.strip().lower())
        if not m:
            print("--pixel 格式应为 宽x高，例如 1024x1024")
            sys.exit(3)
        width, height = int(m.group(1)), int(m.group(2))
        if width <= 0 or height <= 0:
            print("--pixel 宽高必须为正整数")
            sys.exit(3)
        if not is_valid_image_size(f"{width}x{height}"):
            try:
                width, height = fit_image_size(width, height)
            except ValueError as exc:
                print(f"--pixel 无法调整为合规尺寸: {exc}")
                sys.exit(3)
            print(f"[用户提示] {args.pixel} 不是合规尺寸（长短边之比不超过 3，宽高均能被 16 整除，且总像素数在 [655360, 8294400] 区间内），已自动调整为 {width}x{height}")
        args.pixel = f"{width}x{height}"

    try:
        task_id = submit_task(
            args.prompt,
            args.model,
            args.resolution,
            args.aspect_ratio,
            args.pixel,
            args.image_url,
            args.image_path,
            args.api_base_url,
            args.upload_api_url,
            args.timeout,
            output_path,
            args.template_id,
            args.page
        )
    except SubmitRateLimited as exc:
        print(f"[超出QPS限制] {exc}，任务未创建，可切换 --model 后重新提交")
        sys.exit(1)
    except SubmitFailed as exc:
        print(f"[提交失败] {exc}，非 --model 问题，请修正图片参数或环境后重试")
        sys.exit(3)
    except (ValueError, RuntimeError) as exc:
        # 模板解析失败、参考图上传失败、模板参考图不可访问等
        print(f"[提交失败] {exc}，非 --model 问题，请修正图片参数或环境后重试")
        sys.exit(3)

    print(f"[完成] 图像生成任务已提交")
    print(f"[生成模型] {args.model}")
    print(f"[task_id: ] {task_id}")
    sys.exit(0)

if __name__ == "__main__":
    main()
