"""
异步图像生成（公共组件）
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from loguru import logger
import os
from urllib.parse import urlparse
from typing import Iterable, Tuple, Dict
import requests
import re
import json
import unicodedata


DEFAULT_UPLOAD_API_URL = os.getenv(
    "UPLOAD_API_URL",
    "https://appbuilder.baidu.com/v2/tools/bos/upload",
)

MIN_PIXELS = 655_360
MAX_PIXELS = 8_294_400
ALIGN = 16

# 限流可能出现在多层：网关会把后端 429 包成 502，限流语义只在响应体里
RATE_LIMIT_MARKERS = (
    "RATE_LIMIT_QPS",
    "超出QPS限制",
    "status code[429]",
)

MAX_RATIO = 3  # 长边 / 短边 ≤ 3

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
KEYWORDS_PATH = os.path.join(SCRIPT_DIR, "..", "adult_filter_keywords_v1.0.json")

# Zero-width characters to strip
ZERO_WIDTH_RE = re.compile(r"[\u200b\u200c\u200d\ufeff\u00ad]")

# Punctuation/separators commonly used to break up words
SEPARATOR_RE = re.compile(r"[.\-_*@$€!#&~|/\\]+")

# REVIEW 词的安全替换建议映射
# key: 敏感词(小写), value: 推荐的安全替代词列表
SAFE_REPLACEMENTS = {
    # suggestive_appearance
    "sexy": ["elegant", "stylish", "fashionable", "优雅的"],
    "seductive": ["charming", "graceful", "迷人的"],
    "sensual": ["artistic", "graceful", "柔美的"],
    "alluring": ["attractive", "elegant", "动人的"],
    "sultry": ["warm", "confident", "自信的"],
    "provocative": ["bold", "striking", "大胆的"],
    "性感": ["优雅", "时尚", "自信"],
    "诱惑": ["迷人", "优雅", "吸引人"],
    "撩人": ["动人", "优美"],
    "风情": ["风采", "气质"],
    "妩媚": ["柔美", "优雅"],
    "勾魂": ["迷人", "动人"],
    "erotic": ["artistic", "aesthetic", "艺术感的"],
    "titillating": ["intriguing", "captivating"],
    "arousing": ["inspiring", "captivating"],
    "挑逗": ["活泼", "灵动"],
    "勾引": ["吸引", "迷人"],
    "撩拨": ["灵动", "优美"],
    "撩骚": ["活泼", "灵动"],
    # clothing_underwear
    "lingerie": ["elegant dress", "evening gown", "晚礼服"],
    "bra": ["top", "camisole", "吊带衫"],
    "panties": ["shorts", "短裤"],
    "thong": ["swimwear", "泳装"],
    "g-string": ["swimwear", "泳装"],
    "bikini": ["swimsuit", "summer outfit", "夏日装扮"],
    "underwear": ["casual wear", "休闲装"],
    "see-through": ["sheer fabric", "layered", "薄纱层叠"],
    "sheer": ["light fabric", "轻薄面料"],
    "内衣": ["吊带上衣", "休闲装"],
    "内裤": ["短裤", "运动装"],
    "丁字裤": ["泳装", "运动装"],
    "比基尼": ["泳装", "夏日装扮"],
    "透视装": ["薄纱礼服", "层叠穿搭"],
    "暴露装": ["时尚穿搭", "潮流装扮"],
    "情趣内衣": ["晚礼服", "时尚睡衣"],
    "low cut": ["v-neck", "V领"],
    "low-cut": ["v-neck", "V领"],
    "cleavage": ["neckline", "领口设计"],
    "低胸": ["V领", "优雅领口"],
    "深v": ["V领", "优雅领口"],
    "事业线": ["领口", "优雅穿搭"],
    "胸沟": ["V领设计", "领口"],
    "miniskirt": ["skirt", "dress", "裙装"],
    "micro skirt": ["short skirt", "短裙"],
    "超短裙": ["短裙", "裙装"],
    "超短裤": ["短裤", "运动裤"],
    "stockings": ["tights", "leggings", "打底裤"],
    "fishnet": ["patterned tights", "花纹打底"],
    "丝袜": ["打底裤", "长袜"],
    "网袜": ["花纹长袜", "打底裤"],
    "黑丝": ["黑色打底裤", "黑色长袜"],
    "白丝": ["白色长袜", "白色打底"],
    # body_focus
    "big breasts": ["curvy figure", "丰满身材"],
    "large breasts": ["full figure", "丰满身材"],
    "busty": ["curvy", "full-figured", "丰满的"],
    "huge boobs": ["full figure", "丰满身材"],
    "大胸": ["丰满身材", "匀称体型"],
    "巨乳": ["丰满身材", "匀称体型"],
    "丰满": ["匀称", "健康体态"],
    "爆乳": ["丰满身材", "健康体态"],
    "big butt": ["curvy figure", "曲线身材"],
    "big ass": ["curvy figure", "曲线身材"],
    "curvy": ["graceful", "elegant figure", "优美身姿"],
    "voluptuous": ["full-figured", "elegant", "优雅丰满"],
    "大臀": ["曲线身材", "健康体态"],
    "翘臀": ["健美身材", "运动体态"],
    "丰臀": ["曲线身材", "健康体态"],
    "sexy body": ["beautiful figure", "优美身姿"],
    "sexy curves": ["elegant silhouette", "优美轮廓"],
    # photography_style
    "boudoir": ["portrait", "indoor portrait", "室内人像"],
    "boudoir photography": ["portrait photography", "人像摄影"],
    "pin-up": ["retro style", "vintage", "复古风格"],
    "pin up": ["retro style", "vintage", "复古风格"],
    "glamour photography": ["fashion photography", "时尚摄影"],
    "erotic photography": ["art photography", "artistic portrait", "艺术人像"],
    "adult photography": ["portrait photography", "人像摄影"],
    "intimate photography": ["close-up portrait", "特写人像"],
    "私房照": ["室内人像", "生活写真"],
    "写真": ["人像摄影", "艺术照"],
    "大尺度写真": ["艺术人像", "时尚摄影"],
    "人体摄影": ["艺术摄影", "人像摄影"],
    "卧室写真": ["室内人像", "生活照"],
    # mild_bdsm
    "bondage": ["costume", "装扮"],
    "tied up": ["posed", "造型"],
    "handcuffed": ["accessorized", "配饰"],
    "restrained": ["posed", "静态造型"],
    "捆绑": ["造型", "装扮"],
    "束缚": ["装饰", "设计感"],
    "手铐": ["配饰", "手链"],
    "绳缚": ["绳饰", "编织装饰"],
    "whip": ["accessory", "prop", "道具"],
    "spanking": ["action pose", "动态姿态"],
    "鞭打": ["动态姿势", "力量感"],
    # scenario_hints
    "strip": ["dance", "performance", "表演"],
    "stripping": ["dancing", "performing", "舞蹈表演"],
    "striptease": ["dance performance", "舞蹈秀"],
    "脱衣": ["换装", "舞蹈"],
    "脱衣舞": ["舞蹈表演", "舞台秀"],
    "shower scene": ["water scene", "rain scene", "雨中场景"],
    "bath scene": ["spa scene", "water scene", "水景"],
    "浴室场景": ["水景场景", "spa场景"],
    "换衣场景": ["时装展示", "穿搭展示"],
    "更衣室": ["休息室", "准备间"],
    # age_ambiguity
    "jk": ["student style", "学院风"],
    "jc": ["school style", "校园风"],
    "女高中生": ["学院风女生", "青春少女"],
    "萌妹": ["可爱女生", "甜美风格"],
    "嫩模": ["年轻模特", "新人模特"],
    "小妹妹": ["年轻女性", "青年女子"],
}

def _ratio_ok(width, height):
    return max(width, height) <= MAX_RATIO * min(width, height)

def is_valid_image_size(pixel):
    """
    校验图片尺寸是否合规：长短边之比不超过 3，宽高均能被 16 整除，
    且总像素数在 [655360, 8294400] 区间内。
    """
    try:
        width, height = (int(v) for v in pixel.split("x"))
    except (ValueError, TypeError):
        return False
    if not _ratio_ok(width, height):
        return False
    if width % ALIGN != 0 or height % ALIGN != 0:
        return False
    return MIN_PIXELS <= width * height <= MAX_PIXELS


def is_rate_limited(status_code: int, raw_text: str) -> bool:
    """判断响应是否为限流。限流不代表任务失败，等待后重试即可。"""
    if status_code == 429:
        return True
    if status_code < 400:
        # 2xx 正常响应不做文本匹配，避免提示词回显造成误判
        return False
    return any(marker in raw_text for marker in RATE_LIMIT_MARKERS)


def classify_response(resp) -> Tuple[str, dict | None, str]:
    """把一次 HTTP 响应归类为 (state, body, detail)。

      ("ok", body, "")             业务码为 0 的正常响应
      ("rate_limited", None, msg)  触发限流，可等待后重试
      ("error", None, msg)         其他错误，由调用方决定如何处理

    不使用 resp.raise_for_status()：限流语义只存在于响应体里
    （形如 {"error_code": 336100, "error_message": "... RATE_LIMIT_QPS ..."}），
    而 HTTPError 的消息里只有状态码和 URL，一旦抛出就再也读不到限流语义。
    """
    raw = resp.text or ""

    if is_rate_limited(resp.status_code, raw):
        return "rate_limited", None, f"HTTP {resp.status_code}: {raw[:300]}"

    if resp.status_code >= 400:
        # 网关信封: {"error_code": ..., "error_message": ...}
        return "error", None, f"HTTP {resp.status_code}: {raw[:500]}"

    try:
        body = resp.json()
    except ValueError:
        return "error", None, f"响应不是合法 JSON: {raw[:500]}"

    # dumate-image0.1 的 code 是 int 0，其余模型是字符串 "0"，统一转字符串比较
    if str(body.get("code")) != "0":
        return "error", None, f"千帆业务码非 0: {body}"

    return "ok", body, ""


def build_default_output_path() -> str:
    """生成默认的输出路径：当前工作目录/文件名"""
    filename = f"generated_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"
    return str((Path.cwd() / filename).resolve())

def get_proxy_parmas(original_url: str) -> Tuple[str, Dict[str, str]]:
    session_id = os.environ.get("DUMATE_SESSION_ID")
    if not session_id:
        return original_url, {}

    sandbox_mode = os.environ.get("DUMATE_SANDBOX_MODE")
    url = original_url
    parsed = urlparse(original_url)
    extra_headers = {
        "X-Dumate-Session-Id": session_id,
    }
    request_id = os.environ.get("DUMATE_REQUEST_ID", "")
    if request_id:
        extra_headers["X-Dumate-Request-Id"] = request_id
    # web端
    if sandbox_mode and sandbox_mode == "server":
        gateway_url = os.environ.get("DUMATE_GATEWAY_URL")
        if not gateway_url:
            return "", {}

        url = gateway_url.rstrip("/") + parsed.path

        dtoken = os.environ.get("DUMATE_DTOKEN")
        if dtoken:
            extra_headers["Authorization"] = f"Bearer {dtoken}"
    else:    # 桌面端
        scheduler_url = os.environ.get("DUMATE_SCHEDULER_URL")
        if not scheduler_url:
            return original_url, {}

        url = f"{scheduler_url}/api/qianfanproxy{parsed.path}"
    if parsed.query:
        url += f"?{parsed.query}"
    return url, extra_headers


def _download(url: str, dest_path: str) -> None:
    """下载图像到目标路径，根据URL中的扩展名自动调整保存格式"""
    logger.info(f"下载图像: {url} -> {dest_path}")

    # 1. 从 URL 中提取文件扩展名
    parsed_url = urlparse(url)
    path = parsed_url.path  # 获取路径部分，如 "/dumate-image2.1/2026-05-11/xxx.png"

    # 获取扩展名（包含点号）
    url_ext = Path(path).suffix.lower()

    # 2. 映射扩展名（处理特殊情况）
    ext_map = {
        '.jpg': '.jpg',
        '.jpeg': '.jpeg',
        '.png': '.png',
        '.gif': '.gif',
        '.webp': '.webp',
        '.bmp': '.bmp'
    }

    # 如果URL中没有有效扩展名，默认使用 ".png"
    if url_ext not in ext_map:
        # URL中没有识别到文件扩展名，使用默认格式.png
        correct_ext = '.png'
    else:
        correct_ext = ext_map[url_ext]

    # 3. 调整目标路径的扩展名
    dest_path_obj = Path(dest_path)
    final_path = str(dest_path_obj.with_suffix(correct_ext))

    # 4. 下载并保存
    resp = requests.get(url, timeout=(30, 1800))
    resp.raise_for_status()

    with open(final_path, "wb") as f:
        f.write(resp.content)

    logger.info(f"图像下载完成: {final_path}")
    return final_path


def upload_file(file_path: str, upload_api_url: str | None = None) -> str:
    """获取 BOS 地址"""
    upload_url = upload_api_url or DEFAULT_UPLOAD_API_URL
    upload_url, extra_headers = get_proxy_parmas(upload_url)
    path = Path(file_path)
    if not path.is_file():
        raise FileNotFoundError(f"本地文件不存在: {file_path}")

    with path.open("rb") as fh:
        files = {"file": (path.name, fh, "application/octet-stream")}
        resp = requests.post(upload_url, files=files, headers=extra_headers or None, timeout=(10, None))

    try:
        payload = resp.json()
    except ValueError as exc:
        raise ValueError(f"上传服务返回的不是合法 JSON: {resp.text}") from exc

    if resp.status_code != 200:
        raise RuntimeError(
            f"上传失败，HTTP状态码={resp.status_code}，返回内容={payload}"
        )
    if str(payload.get("code")) != "0":
        raise RuntimeError(
            f"上传失败，code={payload.get('code')}，message={payload.get('message')}，返回内容={payload}"
        )

    download_url = payload.get("data", {}).get("downloadUrl")
    if not download_url:
        raise RuntimeError(f"上传成功但未返回 downloadUrl，返回内容={payload}")
    return download_url

def normalize_reference_inputs(
        image_urls: Iterable[str] | None = None,
        image_paths: Iterable[str] | None = None,
        upload_api_url: str | None = None,
    ) -> list[str]:
    """预处理参考图"""
    urls: list[str] = []
    if image_urls:
        urls.extend([u for u in image_urls if u])
    if image_paths:
        for path in image_paths:
            if path:
                try:
                    urls.append(upload_file(path, upload_api_url=upload_api_url))
                except Exception as exc:
                    raise RuntimeError(f"参考图上传失败 {path}: {exc}") from exc
    return urls


def fit_image_size(width, height):
    """
    将输入的宽高调整为最接近的合规尺寸：宽高均被 16 整除，
    且总像素数落在 [655360, 8294400] 区间内，
    且长边除以短边小于等于3

    调整策略：先按原宽高比整体缩放使总像素进入合法区间，
    再在 16 对齐的网格上局部搜索，取与缩放目标欧氏距离最小的合规解。

    :return: (width, height) 元组；输入本身合规时原样返回
    """
    if width <= 0 or height <= 0:
        raise ValueError("宽高必须为正整数")

    total = width * height
    if width % ALIGN == 0 and height % ALIGN == 0 and _ratio_ok(width, height) \
            and MIN_PIXELS <= total <= MAX_PIXELS:
        return (width, height)

    # 0. 先把长短边之比压到 3 以内：长边取短边的 3 倍
    if width > MAX_RATIO * height:
        width = MAX_RATIO * height
    elif height > MAX_RATIO * width:
        height = MAX_RATIO * width
    total = width * height

    # 1. 保持宽高比，把总像素缩放到合法区间内
    if total < MIN_PIXELS:
        scale = (MIN_PIXELS / total) ** 0.5
    elif total > MAX_PIXELS:
        scale = (MAX_PIXELS / total) ** 0.5
    else:
        scale = 1.0
    target_w, target_h = width * scale, height * scale

    # 2. 在 16 对齐网格上局部搜索最近的合规解
    base_w = max(ALIGN, round(target_w / ALIGN) * ALIGN)
    base_h = max(ALIGN, round(target_h / ALIGN) * ALIGN)

    best, best_cost = None, None
    for dw in range(-4, 5):
        for dh in range(-4, 5):
            w = base_w + dw * ALIGN
            h = base_h + dh * ALIGN
            if w < ALIGN or h < ALIGN:
                continue
            if not (MIN_PIXELS <= w * h <= MAX_PIXELS):
                continue
            if not _ratio_ok(w, h):
                continue
            cost = (w - target_w) ** 2 + (h - target_h) ** 2
            if best_cost is None or cost < best_cost:
                best, best_cost = (w, h), cost

    if best is None:
        raise ValueError(f"无法为 {width}x{height} 找到合规尺寸（长短边之比不超过 3，宽高均能被 16 整除，且总像素数在 [655360, 8294400] 区间内）")

    return best

def load_keywords() -> dict:
    """Load the keyword library JSON."""
    with open(KEYWORDS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def normalize(text: str) -> str:
    """
    Normalize prompt text for matching:
    1. NFKC unicode normalization (fullwidth -> halfwidth, compatibility forms)
    2. Strip zero-width characters
    3. Lowercase
    4. Collapse whitespace
    """
    text = unicodedata.normalize("NFKC", text)
    text = ZERO_WIDTH_RE.sub("", text)
    text = text.lower()
    text = re.sub(r"\s+", " ", text).strip()
    return text


def build_bypass_variants(bypass_patterns: dict) -> dict:
    """
    Build a mapping: original_word -> [variant1, variant2, ...] from bypass_patterns.
    Includes leet_speak and pinyin_variants rules.
    """
    variants_map = {}

    for section_key in ("leet_speak", "pinyin_variants"):
        section = bypass_patterns.get(section_key, {})
        for rule in section.get("rules", []):
            original = rule["original"].lower()
            variants = [v.lower() for v in rule.get("variants", [])]
            if original in variants_map:
                variants_map[original].extend(variants)
            else:
                variants_map[original] = variants

    return variants_map


def collapse_separators(text: str) -> str:
    """Remove common separator characters used to break up words (e.g., n.u.d.e -> nude)."""
    return SEPARATOR_RE.sub("", text)


def word_boundary_match(word: str, text: str) -> bool:
    """Match word with boundary awareness to avoid substring false positives."""
    # For CJK characters, direct substring match is fine (no word boundaries)
    if re.search(r"[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]", word):
        return word in text
    # For latin/ascii words, use word boundary regex
    pattern = r"(?<!\w)" + re.escape(word) + r"(?!\w)"
    return bool(re.search(pattern, text))


def check_word_in_text(word: str, text: str, text_collapsed: str) -> bool:
    """Check if a keyword appears in the normalized text or its collapsed form."""
    word_lower = word.lower()
    if word_boundary_match(word_lower, text):
        return True
    # Also check collapsed form for separated variants like n.u.d.e
    word_collapsed = collapse_separators(word_lower)
    if word_collapsed and word_boundary_match(word_collapsed, text_collapsed):
        return True
    return False


def check_block(keywords_data: dict, text: str, text_collapsed: str,
                bypass_variants: dict) -> dict | None:
    """
    Check BLOCK categories. Returns the first match or None.
    """
    adult = keywords_data.get("adult", {})
    block_categories = adult.get("BLOCK", {})

    for cat_key, cat_data in block_categories.items():
        desc = cat_data.get("desc", cat_key)

        # Collect all words across all languages
        all_words = []
        for lang_key, lang_words in cat_data.items():
            if lang_key in ("desc", "note"):
                continue
            if isinstance(lang_words, list):
                all_words.extend(lang_words)

        for word in all_words:
            if check_word_in_text(word, text, text_collapsed):
                return {"action": "BLOCK"}
            # Check bypass variants of this word
            word_lower = word.lower()
            if word_lower in bypass_variants:
                for variant in bypass_variants[word_lower]:
                    if check_word_in_text(variant, text, text_collapsed):
                        return {"action": "BLOCK"}

    return None


def check_combinations(keywords_data: dict, text: str) -> dict | None:
    """
    Check high_risk_combinations rules. All words in a rule must be present.
    Returns the first match or None.
    """
    combos = keywords_data.get("high_risk_combinations", {})
    rules = combos.get("rules", [])

    for rule in rules:
        words = rule.get("words", [])
        if all(w.lower() in text for w in words):
            return {"action": "BLOCK"}

    return None


def check_review(keywords_data: dict, text: str, text_collapsed: str) -> list:
    """
    Check REVIEW categories. Returns all matches.
    """
    adult = keywords_data.get("adult", {})
    review_categories = adult.get("REVIEW", {})
    hits = []

    for cat_key, words in review_categories.items():
        if not isinstance(words, list):
            continue
        for word in words:
            if check_word_in_text(word, text, text_collapsed):
                hits.append({"word": word, "category": cat_key})

    return hits


def check_style_amplifiers(keywords_data: dict, text: str) -> list:
    """
    Check style_risk_amplifiers. Returns matched amplifier words.
    """
    amplifiers = keywords_data.get("style_risk_amplifiers", {})
    words = amplifiers.get("words", [])
    return [w for w in words if w.lower() in text]


def check_safe_overrides(keywords_data: dict, text: str) -> list:
    """
    Check safe_overrides patterns. Returns matched safe patterns.
    """
    overrides = keywords_data.get("safe_overrides", {})
    patterns = overrides.get("patterns", [])
    return [p for p in patterns if p.lower() in text]


def filter_prompt(prompt: str) -> dict:
    """
    Main filter logic. Returns a JSON-serializable verdict dict.

    Priority order:
      1. BLOCK keywords (direct reject)
      2. High-risk combinations (direct reject)
      3. REVIEW keywords (needs LLM to rephrase)
      4. PASS (safe)
    """
    keywords_data = load_keywords()
    bypass_patterns = keywords_data.get("bypass_patterns", {})
    bypass_variants = build_bypass_variants(bypass_patterns)

    text = normalize(prompt)
    text_collapsed = collapse_separators(text)

    # 1. Check BLOCK (highest priority)
    block_result = check_block(keywords_data, text, text_collapsed, bypass_variants)
    if block_result:
        return block_result

    # 2. Check high-risk combinations
    combo_result = check_combinations(keywords_data, text)
    if combo_result:
        return combo_result

    # 3. Check REVIEW — perform silent replacement, return as PASS
    review_hits = check_review(keywords_data, text, text_collapsed)
    if review_hits:
        # Perform replacement directly in-script, never expose sensitive words to LLM
        revised_prompt = prompt
        for hit in review_hits:
            word = hit["word"]
            word_lower = word.lower()
            if word_lower in SAFE_REPLACEMENTS:
                replacement = SAFE_REPLACEMENTS[word_lower][0]
            else:
                replacement = ""
            # Case-insensitive replacement in the original prompt
            revised_prompt = re.sub(
                re.escape(word), replacement, revised_prompt, flags=re.IGNORECASE
            )

        return {
            "action": "PASS",
            "prompt": revised_prompt,
        }

    # 4. PASS
    return {"action": "PASS", "prompt": prompt}

def add_timestamp(path):
    root, ext = os.path.splitext(path)
    ts = datetime.now().strftime("%Y%m%d%H%M%S%f")[:-3]
    return f"{root}-{ts}{ext}"
