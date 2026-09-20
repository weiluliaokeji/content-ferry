"""
获取图像的精确像素尺寸
"""
from math import gcd, log
import argparse
import struct

SUPPORTED_RATIOS = ("1:1", "3:2", "2:3", "3:4", "4:3", "16:9", "9:16", "21:9", "9:21")

def _closest_ratio(ratio_value):
    """在支持的宽高比中找出与实际比值最接近的一个（对数距离）"""
    best = min(
        SUPPORTED_RATIOS,
        key=lambda s: abs(log(ratio_value / (int(s.split(":")[0]) / int(s.split(":")[1])))),
    )
    return best

def _iter_boxes(buf, start, end):
    off = start
    while off + 8 <= end:
        size = int.from_bytes(buf[off:off + 4], "big")
        btype = buf[off + 4:off + 8]
        header = 8
        if size == 1:
            size = int.from_bytes(buf[off + 8:off + 16], "big")
            header = 16
        elif size == 0:
            size = end - off
        if size < header or off + size > end:
            break
        yield btype, off + header, off + size
        off += size


def _parse_ipma(buf, s, e):
    ver, flags = buf[s], int.from_bytes(buf[s + 1:s + 4], "big")
    off = s + 4
    count = int.from_bytes(buf[off:off + 4], "big")
    off += 4
    out = {}
    for _ in range(count):
        step = 2 if ver < 1 else 4
        item = int.from_bytes(buf[off:off + step], "big")
        off += step
        n, off = buf[off], off + 1
        idxs = []
        for _ in range(n):
            if flags & 1:
                idxs.append(int.from_bytes(buf[off:off + 2], "big") & 0x7FFF)
                off += 2
            else:
                idxs.append(buf[off] & 0x7F)
                off += 1
        out[item] = idxs
        if off > e:
            break
    return out


def _parse_meta(meta):
    primary, props, ipma = None, [], {}
    for btype, s, e in _iter_boxes(meta, 4, len(meta)):   # meta 是 FullBox，跳过 4 字节
        if btype == b"pitm":
            step = 4 if meta[s] >= 1 else 2
            primary = int.from_bytes(meta[s + 4:s + 4 + step], "big")
        elif btype == b"iprp":
            for t2, s2, e2 in _iter_boxes(meta, s, e):
                if t2 == b"ipco":
                    props = [(t3, meta[s3:e3]) for t3, s3, e3 in _iter_boxes(meta, s2, e2)]
                elif t2 == b"ipma":
                    ipma = _parse_ipma(meta, s2, e2)

    def ispe(p):
        return int.from_bytes(p[4:8], "big"), int.from_bytes(p[8:12], "big")

    size, rotate = None, False
    for i in ipma.get(primary, []):
        if 1 <= i <= len(props):
            t, p = props[i - 1]
            if t == b"ispe" and size is None and len(p) >= 12:
                size = ispe(p)
            elif t == b"irot" and p and (p[0] & 3) in (1, 3):
                rotate = True
    if size is None:   # 没有 pitm/ipma 时退化为取面积最大的 ispe
        cands = [ispe(p) for t, p in props if t == b"ispe" and len(p) >= 12]
        if cands:
            size = max(cands, key=lambda wh: wh[0] * wh[1])
    if size and rotate:
        size = (size[1], size[0])
    return size


def _heif_size(f):
    f.seek(0)
    while True:
        hdr = f.read(8)
        if len(hdr) < 8:
            return None
        size, btype = int.from_bytes(hdr[:4], "big"), hdr[4:8]
        header = 8
        if size == 1:
            size = int.from_bytes(f.read(8), "big")
            header = 16
        elif size == 0:
            return _parse_meta(f.read()) if btype == b"meta" else None
        if btype == b"meta":
            return _parse_meta(f.read(size - header))
        if size <= header:
            return None
        f.seek(size - header, 1)


# ---------- TIFF ----------

def _tiff_size(f, byte_order):
    bo = "<" if byte_order == b"II" else ">"
    f.seek(4)
    f.seek(struct.unpack(bo + "I", f.read(4))[0])
    n = struct.unpack(bo + "H", f.read(2))[0]
    w = h = None
    for _ in range(n):
        entry = f.read(12)
        if len(entry) < 12:
            break
        tag, typ = struct.unpack(bo + "HH", entry[:4])
        if tag in (256, 257):
            val = (struct.unpack(bo + "H", entry[8:10])[0] if typ == 3
                   else struct.unpack(bo + "I", entry[8:12])[0])
            if tag == 256:
                w = val
            else:
                h = val
        if w and h:
            break
    return (w, h) if w and h else None



def _read_size(path):
    with open(path, "rb") as f:
        head = f.read(32)

        if head[:8] == b"\x89PNG\r\n\x1a\n":
            return struct.unpack(">II", head[16:24])

        if head[:6] in (b"GIF87a", b"GIF89a"):
            return struct.unpack("<HH", head[6:10])

        if head[:2] == b"BM":
            w, h = struct.unpack("<ii", head[18:26])
            return w, abs(h)

        if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
            fmt = head[12:16]
            if fmt == b"VP8 ":
                w, h = struct.unpack("<HH", head[26:30])
                return w & 0x3FFF, h & 0x3FFF
            if fmt == b"VP8L":
                b = struct.unpack("<I", head[21:25])[0]
                return (b & 0x3FFF) + 1, ((b >> 14) & 0x3FFF) + 1
            if fmt == b"VP8X":
                w = head[24] | head[25] << 8 | head[26] << 16
                h = head[27] | head[28] << 8 | head[29] << 16
                return w + 1, h + 1

        # TIFF / TIF：II*\0 或 MM\0*
        if head[:4] in (b"II\x2a\x00", b"MM\x00\x2a"):
            size = _tiff_size(f, head[:2])
            if size:
                return size
            raise ValueError(f"TIFF 头解析失败: {path}")

        # HEIC / HEIF / AVIF：第二个 box 类型为 ftyp
        if head[4:8] == b"ftyp":
            size = _heif_size(f)
            if size:
                return size
            raise ValueError(f"HEIF 头解析失败: {path}")

        # JPEG / JPG / JPE：遍历 marker 找 SOFn
        if head[:2] == b"\xff\xd8":
            f.seek(2)
            while True:
                b = f.read(1)
                if not b:
                    break
                if b != b"\xff":
                    continue
                marker = f.read(1)
                while marker == b"\xff":
                    marker = f.read(1)
                if not marker:
                    break
                m = marker[0]
                if m in (0xD8, 0x01) or 0xD0 <= m <= 0xD7:
                    continue
                seg = f.read(2)
                if len(seg) < 2:
                    break
                seg_len = struct.unpack(">H", seg)[0]
                if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
                    data = f.read(5)
                    h, w = struct.unpack(">HH", data[1:5])
                    return w, h
                f.seek(seg_len - 2, 1)

    raise ValueError(f"无法识别的图片格式或文件损坏: {path}")


def get_image_info(image_path):
    """
    输入图片的绝对路径，返回该图片的宽高比和分辨率。
    仅读取文件头。
    支持 png / jpg / jpeg / jpe / gif / bmp / webp / heic / tif / tiff
    """
    width, height = _read_size(image_path)
    divisor = gcd(width, height)
    ratio_value = round(width / height, 4)
    return {
        "resolution": (width, height),
        "aspect_ratio": f"{width // divisor}:{height // divisor}",
        "ratio_value": round(width / height, 4),
        "closest_ratio": _closest_ratio(ratio_value),
    }

def main():

    parser = argparse.ArgumentParser(description="检查输入图的尺寸大小")
    parser.add_argument("--image_path", action="append", default=[], help="本地参考图的绝对路径，可多次传入")
    args = parser.parse_args()

    if not args.image_path:
        raise RuntimeError(f"图像尺寸检查失败: 没有收到任何图像路径")
    image_num = len(args.image_path)
    for i, image in enumerate(args.image_path):
        image_info = get_image_info(image)
        image_closest = image_info.get("closest_ratio")
        image_width = image_info.get("resolution")[0]
        image_height = image_info.get("resolution")[1]
        image_ratio = image_info.get("aspect_ratio")
        image_decimal = image_info.get("ratio_value")
        print(f"第 {i+1}/{image_num} 张图像：width={image_width}, height={image_height}, 最简宽高比={image_ratio}, 精准宽高比={image_decimal}, 最接近的受支持宽高比={image_closest}")

if __name__ == "__main__":
    main()
