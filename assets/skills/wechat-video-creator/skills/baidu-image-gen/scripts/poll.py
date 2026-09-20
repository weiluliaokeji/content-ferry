"""
poll.py

轮询图像生成任务状态，内部每 15 秒查询一次，持续约 5 分钟。
如果在此期间任务完成，则下载图像，并输出图像的 url；否则返回最后一次查询的原始结果。

查询阶段触发 QPS 限流时，任务本身不受影响，脚本会等待 15 秒后自动重试，不会中断。

用法：
    python scripts/poll.py --task_id <图像生成任务 ID> --model <模型名称> --output <图像保存路径>

退出码：
    0 - 图像生成成功，已下载并保存到 --output 指定的路径
    1 - 任务失败，可切换 --model 重新提交
    2 - 任务仍在执行（轮询超时或查询出错）。必须用同一个 task_id 再次轮询，禁止重新提交生图任务
    3 - 参数错误
"""

import argparse
import json
import os
import sys
import time
import requests
from loguru import logger
import re
from utils import _download, get_proxy_parmas, build_default_output_path, classify_response, add_timestamp

# ── API 配置 ──────────────────────────────────────────────────────────────────
BASE_URL = {
    "dumate-image2.2": "https://qianfan.baidubce.com/v2/tools/dumate/image_generate_v3/async",
    "dumate-image2.1": "https://qianfan.baidubce.com/v2/tools/dumate/image_generate_v2/async",
    "dumate-image1.2": "https://qianfan.baidubce.com/v2/tools/dumate/image_generate/async",
    "dumate-image0.1": "https://qianfan.baidubce.com/beta/image/qianfan-image-v1"
}

POLL_INTERVAL = 15  # 查询间隔（秒）
POLL_DURATION = 300  # 单次调用最多轮询时长（秒），约 5 分钟


# ── 查询任务 ──────────────────────────────────────────────────────────────────
def query_task(task_id: str, model: str) -> tuple:
    """
    查询任务状态。

    返回 (state, body, detail)：
      ("ok", body, "")             正常响应，body 为千帆业务信封
      ("rate_limited", None, msg)  触发限流，任务未受影响，等待后重试
      ("error", None, msg)         其他查询错误，由调用方打印 msg
    """
    base_url = BASE_URL.get(model)
    if not base_url:
        print(f"[参数错误] 不支持的模型名称: {model}")
        sys.exit(3)

    query_url = f"{base_url}?task_id={task_id}"
    url, extra_headers = get_proxy_parmas(query_url)
    if not url:
        return "error", None, "无法解析请求地址，请检查 DUMATE_GATEWAY_URL / DUMATE_SCHEDULER_URL 环境变量"

    try:
        resp = requests.get(url, headers={**extra_headers}, timeout=60)
    except requests.RequestException as exc:
        return "error", None, f"查询请求异常: {exc}"

    return classify_response(resp)


def main():
    """主函数"""
    parser = argparse.ArgumentParser(description="轮询图像生成任务状态")
    parser.add_argument("--task_id", help="图像生成任务 ID")
    parser.add_argument("--model", default="dumate-image2.2", help="默认dumate-image2.2")
    parser.add_argument("--output", help="图片保存路径")
    parser.add_argument("--self-check", action="store_true", help="运行自检后退出")
    parser.add_argument("--dry-run", action="store_true", help="只打印参数，不联网")
    args = parser.parse_args()

    if args.self_check:
        print("=== baidu-image-gen (poll.py) 自检 ===")
        ok = True
        # 检查模型配置
        for model, url in BASE_URL.items():
            print(f"[✓] 模型 {model}: {url}")
        # 检查网络
        import socket
        socket.setdefaulttimeout(5)
        from urllib.parse import urlparse
        for model, url in BASE_URL.items():
            try:
                parsed = urlparse(url)
                host = parsed.hostname
                port = parsed.port or (443 if parsed.scheme == "https" else 80)
                sock = socket.create_connection((host, port), timeout=5)
                sock.close()
                print(f"[✓] {model} ({host}:{port}) 可达")
            except Exception as e:
                print(f"[✗] {model} ({url}) 不可达：{e}")
                ok = False
        if ok:
            print("\n=== 自检通过 ===")
            return 0
        else:
            print("\n=== 自检失败 ===")
            return 1

    if args.dry_run:
        print(json.dumps({
            "task_id": args.task_id,
            "model": args.model,
            "output": args.output,
        }, ensure_ascii=False, indent=2))
        return 0

    if not args.task_id:
        logger.error(f"没有 task_id，请先提交任务")
        sys.exit(3)

    if not re.fullmatch(r"[A-Za-z0-9_\-]+", args.task_id):
        logger.error(f"task_id: {args.task_id} 格式错误，task_id 只能包含字母、数字、连字符，请检查 task_id 是否包含多余符号")
        sys.exit(3)

    if os.path.isdir(args.output):
        print(f"{args.output} 是非法的图片保存路径")
        args.output = build_default_output_path()
        print(f"已生成默认的图片保存路径 {args.output}")
    args.output = add_timestamp(args.output)
    # ── 轮询查询（内部循环约 5 分钟） ─────────────────────
    start_time = time.time()
    last_body = None

    while True:
        state, body, detail = query_task(args.task_id, args.model)
        elapsed = time.time() - start_time

        # 限流：任务未受影响，等 15 秒后重试
        if state == "rate_limited":
            logger.warning(f"[限流] {detail}")
            print(f"[限流] 查询触发 QPS 限流，任务未受影响，{POLL_INTERVAL} 秒后自动重试")
            if elapsed >= POLL_DURATION:
                break
            time.sleep(POLL_INTERVAL)
            continue

        # 其他查询错误：直接打印错误信息，任务仍可能在执行
        if state == "error":
            print(f"[查询失败] {detail}，生图任务可能仍在执行，可重试轮询。")
            sys.exit(2)

        last_body = body
        if args.model == "dumate-image0.1":
            status = body.get("data", {}).get("task_status", "")
        else:
            status = body.get("status")
        logger.info(f"task_id={args.task_id}  status={status}  elapsed={elapsed:.0f}s")

        if status in ["success", "succeed"]:
            if args.model == "dumate-image2.2" or args.model == "dumate-image2.1":
                urls = body.get("imageUrls") or []
                image_url = urls[0] if urls else ""
            elif args.model == "dumate-image1.2":
                image_url = body.get("data", {}).get("imageUrl", "")
            else:
                images = body.get("data", {}).get("task_result", {}).get("images") or []
                image_url = images[0].get("url", "") if images else ""

            if not image_url:
                logger.error(f"任务成功但无图像结果: {body}")
                sys.exit(1)

            # 下载图像
            image_saved = None
            for attempt in range(1, 4):
                try:
                    image_saved = _download(image_url, args.output)
                    break
                except Exception as exc:
                    logger.warning(f"[下载] 第 {attempt}/3 次失败: {exc}")
                    if attempt < 3:
                        time.sleep(3)

            if not image_saved:
                print(f"[下载失败] 图像已生成成功，但本地保存失败，请勿重新生成")
                print(f"[图像 URL:] {image_url}")
                sys.exit(4)

            print(f"[完成] image_name={image_saved} 图像生成成功")
            print(f"[图像 URL:] {image_url}")
            print(f"[本地路径（文件名已添加时间戳信息）:] {image_saved}")
            sys.exit(0)

        elif status == "failed":
            logger.error(f"任务失败: task_id={args.task_id} status={status} data={body} 请尝试切换模型")
            sys.exit(1)

        # 仍在处理中，检查是否到达轮询时长
        if elapsed >= POLL_DURATION:
            break
        print(f"[运行中] task_id={args.task_id} 任务正在运行中，请等待")
        time.sleep(POLL_INTERVAL)

    # 超过 5 分钟仍未完成，输出最后一次成功查询的原始结果
    if last_body is not None:
        print(json.dumps(last_body, ensure_ascii=False))
    print(f"[任务还在执行中] 请用同一个 task_id 续查，不要重新提交生图任务")
    sys.exit(2)


if __name__ == "__main__":
    main()
