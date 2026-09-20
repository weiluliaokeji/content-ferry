#!/usr/bin/env python3
"""Read the XHS template library in three progressive-loading stages."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


TEMPLATE_FILE = Path(__file__).resolve().parent.parent / "references" / "xhs-templates.yaml"
CATEGORY_RE = re.compile(r"^  ([a-z0-9-]+):(?: \[\])?\s*$")
TEMPLATE_RE = re.compile(r"^    - id:\s*(.+?)\s*$")
FIELD_RE = re.compile(r"^      ([a-zA-Z0-9_-]+):")
URL_ITEM_RE = re.compile(r"^        -\s+(.+?)\s*$")
PAGE_ITEM_RE = re.compile(r"^        - ")
TEXT_SECTION_KEYS = ("模板规则", "可选色板")
IMAGE_SECTION_KEYS = (
    "参考图",
    "用途",
    "布局",
    "字体",
    "组件与填写要求",
    "数量与编号",
    "内容清理",
)


class TemplateReadError(ValueError):
    pass


def read_lines() -> list[str]:
    try:
        lines = TEMPLATE_FILE.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise TemplateReadError(f"无法读取模板文件：{TEMPLATE_FILE}: {exc}") from exc

    if not lines or lines[0].strip() != "templates:":
        raise TemplateReadError("模板文件必须以 templates: 作为根节点")
    return lines


def parse_categories(lines: list[str]) -> dict[str, list[str]]:
    starts: list[tuple[str, int]] = []
    for index, line in enumerate(lines):
        match = CATEGORY_RE.match(line)
        if match:
            starts.append((match.group(1), index))

    if not starts:
        raise TemplateReadError("templates 下没有一级分类")

    categories: dict[str, list[str]] = {}
    for position, (name, start) in enumerate(starts):
        if name in categories:
            raise TemplateReadError(f"一级分类重复：{name}")
        end = starts[position + 1][1] if position + 1 < len(starts) else len(lines)
        categories[name] = lines[start:end]
    return categories


def decode_scalar(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] == '"':
        try:
            return json.loads(value)
        except json.JSONDecodeError as exc:
            raise TemplateReadError(f"无法解析双引号标量：{value}") from exc
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1].replace("''", "'")
    return value


def parse_templates(
    categories: dict[str, list[str]]
) -> dict[str, tuple[str, list[str]]]:
    templates: dict[str, tuple[str, list[str]]] = {}

    for category, block in categories.items():
        starts: list[tuple[str, int]] = []
        for index, line in enumerate(block):
            match = TEMPLATE_RE.match(line)
            if match:
                starts.append((decode_scalar(match.group(1)), index))

        for position, (template_id, start) in enumerate(starts):
            if template_id in templates:
                raise TemplateReadError(f"模板 id 重复：{template_id}")
            end = starts[position + 1][1] if position + 1 < len(starts) else len(block)
            templates[template_id] = (category, block[start:end])

    return templates


def extract_urls(template_id: str, block: list[str]) -> list[str]:
    urls: list[str] = []
    in_urls = False

    for line in block:
        field = FIELD_RE.match(line)
        if field:
            in_urls = field.group(1) == "image_urls"
            continue
        if not in_urls:
            continue

        indent = len(line) - len(line.lstrip(" "))
        if line.strip() and indent <= 6:
            break

        item = URL_ITEM_RE.match(line)
        if item:
            urls.append(decode_scalar(item.group(1)))

    if any(not url for url in urls):
        raise TemplateReadError(f"模板 {template_id} 包含空 image_url")
    return urls


def field_lines(block: list[str], name: str) -> list[str]:
    """返回模板某个顶层字段的原始行（含字段行本身）。"""
    output: list[str] = []
    collecting = False

    for line in block:
        field = FIELD_RE.match(line)
        if field:
            if collecting:
                break
            if field.group(1) == name:
                collecting = True
                output.append(line)
            continue
        if collecting:
            indent = len(line) - len(line.lstrip(" "))
            if line.strip() and indent <= 6:
                break
            output.append(line)

    return output


def scalar_text(lines: list[str]) -> str:
    """把 `key: >-` 折叠标量或行内标量还原成纯文本。"""
    if not lines:
        return ""

    head = lines[0].split(":", 1)[1].strip()
    if head not in {">", ">-", ">+", "|", "|-", "|+"}:
        return decode_scalar(" ".join([head, *(line.strip() for line in lines[1:] if line.strip())]))

    body = [line.strip() for line in lines[1:] if line.strip()]
    return " ".join(body)


def labeled_sections(value: str, keys: tuple[str, ...]) -> list[str]:
    """Split folded `- key: value` text without treating it as YAML structure."""
    key_pattern = "|".join(re.escape(key) for key in keys)
    parts = re.split(rf"(?:^|\s)-\s+(?=(?:{key_pattern})：)", value.strip())
    return [part.strip() for part in parts if part.strip()]


def extract_pages_meta(template_id: str, block: list[str]) -> list[dict[str, object]]:
    """按参考图顺序返回每页的 description 文本。"""
    raw = field_lines(block, "image_descriptions")
    pages: list[dict[str, object]] = []

    for line in raw[1:]:
        if PAGE_ITEM_RE.match(line):
            inline = line.split("- ", 1)[1]
            pages.append({"lines": ["      " + inline]})
            continue
        if not pages:
            if line.strip():
                raise TemplateReadError(
                    f"模板 {template_id} 的 image_descriptions 结构异常：{line.strip()}"
                )
            continue

        pages[-1]["lines"].append(line)  # type: ignore[union-attr]

    for page_number, meta in enumerate(pages, start=1):
        text = scalar_text(meta["lines"])  # type: ignore[arg-type]
        if not text:
            raise TemplateReadError(
                f"模板 {template_id} 第 {page_number} 页缺少 description"
            )
        meta["description"] = text
        del meta["lines"]

    return pages


def validate_library(categories: dict[str, list[str]]) -> None:
    """Fail fast when the checked-in template library violates its runtime schema."""
    templates = parse_templates(categories)
    if not templates:
        raise TemplateReadError("模板库中没有可用模板")

    for template_id, (_, block) in templates.items():
        for field_name in ("description", "text"):
            if not scalar_text(field_lines(block, field_name)):
                raise TemplateReadError(f"模板 {template_id} 缺少 {field_name}")

        text_lines = field_lines(block, "text")
        if text_lines[0].strip() != "text: >-":
            raise TemplateReadError(f"模板 {template_id} 的 text 必须使用 >- 块格式")

        text = scalar_text(text_lines)
        if "连续性规则：" in text:
            raise TemplateReadError(f"模板 {template_id} 的 text 不得包含连续性规则")
        text_sections = labeled_sections(text, TEXT_SECTION_KEYS)
        if len(text_sections) != 2 or any(
            not section.startswith(f"{key}：")
            for section, key in zip(text_sections, TEXT_SECTION_KEYS)
        ):
            raise TemplateReadError(
                f"模板 {template_id} 的 text 必须依次包含模板规则和可选色板"
            )

        image_description_lines = field_lines(block, "image_descriptions")
        page_headers = [
            line.strip() for line in image_description_lines[1:] if PAGE_ITEM_RE.match(line)
        ]
        if any(header != "- description: >-" for header in page_headers):
            raise TemplateReadError(
                f"模板 {template_id} 的 image_descriptions 必须使用 >- 块格式"
            )

        urls = extract_urls(template_id, block)
        pages = extract_pages_meta(template_id, block)
        required_image_keys = IMAGE_SECTION_KEYS
        for page_number, page in enumerate(pages, start=1):
            sections = labeled_sections(str(page["description"]), IMAGE_SECTION_KEYS)
            present_keys = {
                key
                for key in IMAGE_SECTION_KEYS
                if any(section.startswith(f"{key}：") for section in sections)
            }
            missing_keys = [key for key in required_image_keys if key not in present_keys]
            if missing_keys:
                raise TemplateReadError(
                    f"模板 {template_id} 第 {page_number} 页缺少描述分组："
                    f"{', '.join(missing_keys)}"
                )
        if len(urls) != len(pages):
            raise TemplateReadError(
                f"模板 {template_id} 的 image_urls({len(urls)}) 与 "
                f"image_descriptions({len(pages)}) 数量不一致"
            )
        invalid_urls = [url for url in urls if not url.startswith(("http://", "https://"))]
        if invalid_urls:
            raise TemplateReadError(f"模板 {template_id} 包含非 HTTP(S) image_url")


def parse_pages(raw_pages: str | None) -> list[int] | None:
    if raw_pages is None or not raw_pages.strip():
        return None

    pages: list[int] = []
    for value in raw_pages.split(","):
        value = value.strip()
        if not value.isdigit() or int(value) < 1:
            raise TemplateReadError("--pages 必须是从 1 开始的页码，以逗号分隔")
        page = int(value)
        if page in pages:
            raise TemplateReadError(f"--pages 包含重复页码：{page}")
        pages.append(page)
    return pages


def command_categories(categories: dict[str, list[str]]) -> None:
    print("CATEGORY_INDEX_BEGIN")
    for name in categories:
        print(name)
    print(f"category_count: {len(categories)}")
    print("CATEGORY_INDEX_END")


def command_category(categories: dict[str, list[str]], names: list[str]) -> None:
    if len(names) != 3:
        raise TemplateReadError("第二级必须一次读取 3 个一级分类")
    if len(set(names)) != 3:
        raise TemplateReadError("第二级的 3 个一级分类必须互不重复")
    if "general" not in names:
        raise TemplateReadError("第二级的 3 个一级分类必须包含 general")

    missing = [name for name in names if name not in categories]
    if missing:
        raise TemplateReadError(f"一级分类不存在：{', '.join(missing)}")

    selected = {name: categories[name] for name in names}
    templates = parse_templates(selected)

    print("CATEGORY_TEMPLATES_BEGIN")
    for template_id, (category, block) in templates.items():
        description = scalar_text(field_lines(block, "description"))
        print(f"- category: {json.dumps(category, ensure_ascii=False)}")
        print(f"  id: {json.dumps(template_id, ensure_ascii=False)}")
        print(f"  description: {json.dumps(description, ensure_ascii=False)}")
    print(f"category_count: {len(names)}")
    print(f"template_count: {len(templates)}")
    print("CATEGORY_TEMPLATES_END")


def command_urls(
    categories: dict[str, list[str]], template_id: str, raw_pages: str | None
) -> None:
    templates = parse_templates(categories)
    if template_id not in templates:
        raise TemplateReadError(f"模板不存在：{template_id}")

    category, block = templates[template_id]
    urls = extract_urls(template_id, block)
    pages_meta = extract_pages_meta(template_id, block)

    if len(pages_meta) != len(urls):
        raise TemplateReadError(
            f"模板 {template_id} 的 image_urls({len(urls)}) 与 "
            f"image_descriptions({len(pages_meta)}) 数量不一致"
        )

    pages = parse_pages(raw_pages)
    if pages is None:
        selected_pages = list(range(1, len(urls) + 1))
    else:
        invalid = [page for page in pages if page > len(urls)]
        if invalid:
            raise TemplateReadError(
                f"模板 {template_id} 只有 {len(urls)} 页，无法读取：{', '.join(map(str, invalid))}"
            )
        selected_pages = pages

    print("TEMPLATE_DETAIL_BEGIN")
    print(f"id: {template_id}")
    print(f"category: {category}")
    print(f"total_pages: {len(urls)}")
    print(f"selected_pages: {','.join(map(str, selected_pages))}")
    print(f"description: {scalar_text(field_lines(block, 'description'))}")
    print("text:")
    for section in labeled_sections(
        scalar_text(field_lines(block, "text")), TEXT_SECTION_KEYS
    ):
        print(f"  - {section}")
    print("pages:")

    for page in selected_pages:
        meta = pages_meta[page - 1]
        print(f"  - page: {page}")
        print("    description:")
        for section in labeled_sections(str(meta["description"]), IMAGE_SECTION_KEYS):
            print(f"      - {section}")
        print(f"    image_ref: {template_id}#{page}")

    print(f"url_count: {len(selected_pages)}")
    print("TEMPLATE_DETAIL_END")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="渐进读取小红书模板库")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("categories", help="读取全部一级分类")

    category_parser = subparsers.add_parser(
        "category", help="读取 3 个分类下模板的 category、id 和 description"
    )
    category_parser.add_argument("categories", nargs="+")

    urls_parser = subparsers.add_parser(
        "urls", help="读取一个模板的完整生成信息，可用 --pages 限定参考图"
    )
    urls_parser.add_argument("template_id")
    urls_parser.add_argument("--pages", help="从 1 开始的页码，以逗号分隔；省略时读取全部")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        categories = parse_categories(read_lines())
        validate_library(categories)
        if args.command == "categories":
            command_categories(categories)
        elif args.command == "category":
            command_category(categories, args.categories)
        else:
            command_urls(categories, args.template_id, args.pages)
    except TemplateReadError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
