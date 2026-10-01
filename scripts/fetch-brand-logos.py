#!/usr/bin/env python3
"""Vendor provider marks at build time; the UI never fetches remote logos.

Sources:
  - Simple Icons (CC0) for accurate monochrome brand marks.
  - Official brand packs, press assets and maintainer repositories for primary
    marks, copied without recoloring. See docs/assets/brands/README.md.

Usage: --only xai,grok,openrouter refreshes selected marks; --verify validates
vendored file hashes offline. A metadata.json manifest records provenance.
"""
import argparse
import datetime
import hashlib
import io
import json
import os
import re
import struct
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "docs", "assets", "brands")

SIMPLE_ICONS = {
    "anthropic": "anthropic",
    "gemini": "googlegemini",
    "meta": "meta",
    "deepseek": "deepseek",
    "mistral": "mistralai",
    "minimax": "minimax",
    "opencode": "opencode",
    "qwen": "qwen",
    "ollama": "ollama",
}
MAX_SOURCE_BYTES = 10 * 1024 * 1024
MAX_ASSET_BYTES = 1024 * 1024
XAI_PACK = "https://data.x.ai/logos/SpaceXAI_Grok_Assets.zip"
OPENAI_PACK = "https://cdn.openai.com/brand/openai-logos.zip"
PRIMARY_SOURCES = {
    "xai": {"filename": "xai.svg", "url": XAI_PACK,
        "archivePath": "SpaceXAI_Grok_Assets/spacexai - symbol - white - transparent.svg",
        "sourcePage": "https://x.ai/legal/brand-guidelines",
        "variant": "Current SpaceXAI provider symbol, white transparent", "background": "dark", "aspect": "wide"},
    "grok": {"filename": "grok.svg", "url": XAI_PACK,
        "archivePath": "SpaceXAI_Grok_Assets/Grok_Logomark_Light.svg",
        "sourcePage": "https://x.ai/legal/brand-guidelines",
        "variant": "Grok product logomark, white transparent", "background": "dark"},
    "openai": {"filename": "openai.svg", "url": OPENAI_PACK,
        "archivePath": "OpenAI-logos/SVGs/OAI_OpenAI-Blossom_White.svg",
        "sourcePage": "https://openai.com/brand/",
        "variant": "Current OpenAI Blossom, white transparent", "background": "dark"},
    "google": {"filename": "google.png", "url": "https://developers.google.com/static/identity/images/g-logo.png",
        "sourcePage": "https://developers.google.com/identity/branding-guidelines",
        "variant": "Current official gradient Google G, original PNG", "background": "light-neutral"},
    "google-legacy": {"filename": "google.svg", "url": "https://fonts.gstatic.com/s/i/productlogos/googleg/v6/24px.svg",
        "sourcePage": "https://developers.google.com/identity/branding-guidelines",
        "variant": "Previous official four-color Google G", "background": "light-neutral"},
    "kimi": {"filename": "kimi.ico", "url": "https://www.kimi.com/favicon-light.ico",
        "sourcePage": "https://www.kimi.com/", "variant": "Official Kimi K and blue dot site icon, original 48/32/16px ICO", "background": "original black icon background"},
    "claude": {"filename": "claude.png", "url": "https://assets.claude.com/95a868946ac8a31e5ff832e2899f294aa368b836.png",
        "sourcePage": "https://claude.com/", "variant": "Official Claude product icon from site favicon", "background": "original icon background"},
    "openrouter": {"filename": "openrouter.svg", "url": "https://openrouter.ai/brand/logos/transparent/glyph/svg/glyph-cloud.svg",
        "sourcePage": "https://openrouter.ai/brand", "variant": "OpenRouter Cloud glyph, transparent", "background": "dark"},
    "zhipu": {"filename": "zhipu.svg", "url": "https://mintcdn.com/zhipu-32152247/B_E8wI-eiNa1QlPV/logo/dark.svg",
        "sourcePage": "https://docs.z.ai/guides/overview/quick-start", "variant": "Z.ai / GLM official documentation icon, white on black", "background": "original black icon background"},
    "agy": {"filename": "agy.png", "url": "https://www.antigravity.google/assets/image/brand/antigravity-icon__white.png",
        "sourcePage": "https://www.antigravity.google/press", "variant": "Antigravity official white press icon", "background": "dark"},
    "mlx": {"filename": "mlx.svg", "url": "https://raw.githubusercontent.com/ml-explore/mlx/62626de15002232272cbc4b1df32eee453a3dc02/docs/logo/mlx_logo_dark.svg",
        "sourcePage": "https://github.com/ml-explore/mlx/pull/3308", "variant": "Maintainer-published MLX logo for dark surfaces", "background": "dark", "aspect": "wide"},
    "upstage": {"filename": "upstage.avif", "url": "https://cdn.prod.website-files.com/6743d5190bb2b52f38e99e37/6743f495db2f0b0f43c196ae_Symbol_White.avif",
        "sourcePage": "https://www.upstage.ai/resources/brand-resource-center", "variant": "Official Upstage white symbol, original AVIF", "background": "dark"},
    "alibaba": {"filename": "alibaba.svg", "url": "https://www.alibabacloud.com/en/press-room/media-kits?_p_lc=1",
        "sourcePage": "https://www.alibabacloud.com/en/press-room/media-kits?_p_lc=1", "variant": "Alibaba Cloud bracket symbol, original orange", "background": "light-neutral or dark", "transform": "official-alibaba-symbol"},
}


def source_specs():
    sources = {key: {"filename": key + ".svg", "url": "https://cdn.simpleicons.org/" + slug,
        "sourcePage": "https://github.com/simple-icons/simple-icons", "variant": "White monochrome brand mark",
        "background": "dark", "transform": "legacy-white-svg"} for key, slug in SIMPLE_ICONS.items()}
    sources.update({key: {"transform": "none", **spec} for key, spec in PRIMARY_SOURCES.items()})
    return sources


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "token-horizon-brand-fetch/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        length = resp.headers.get("Content-Length")
        if length and int(length) > MAX_SOURCE_BYTES:
            raise ValueError("Oversized brand source: " + url)
        data = resp.read(MAX_SOURCE_BYTES + 1)
    if len(data) > MAX_SOURCE_BYTES:
        raise ValueError("Oversized brand source: " + url)
    return data


def white_svg(source: bytes) -> bytes:
    text = source.decode("utf-8", "ignore")
    text = re.sub(r"<title>.*?</title>", "", text, flags=re.S)
    text = re.sub(r'\s(fill|role|class)="[^"]*"', "", text)
    # Force a single white fill on the root so the mark reads on dark tiles.
    text = text.replace("<svg ", '<svg fill="#FFFFFF" ', 1)
    if "<svg fill=\"#FFFFFF\"" not in text:
        text = text.replace("<svg", '<svg fill="#FFFFFF"', 1)
    return text.encode("utf-8")


def alibaba_symbol(source):
    # Official bracket component precedes the wordmark. Preserve its original
    # geometry/color; normalize only the viewport to this published component.
    match = re.search(r'<svg[^>]*viewbox="0 0 295\.93 37\.28"[^>]*>(.*?)</svg>', source.decode("utf-8"), re.S)
    if not match:
        raise ValueError("Alibaba Cloud navigation logo changed; review source")
    elements = re.findall(r"<(?:rect|path)\b[^>]*>(?:</(?:rect|path)>)?", match.group(1))
    if len(elements) < 3 or not elements[0].startswith('<rect x="19.94"') or 'M49.84,0H36.66' not in elements[1] or 'M10,0H23.14' not in elements[2]:
        raise ValueError("Alibaba Cloud symbol geometry changed; review source")
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 59.8 37.28" fill="#ff6a00">' + "".join(elements[:3]) + "</svg>\n").encode("utf-8")


def validate_asset(filename, data):
    if not data or len(data) > MAX_ASSET_BYTES:
        raise ValueError("Empty or oversized logo: " + filename)
    if filename.endswith(".svg"):
        root = ET.fromstring(data)
        if root.tag != "{http://www.w3.org/2000/svg}svg":
            raise ValueError("Not an SVG: " + filename)
        for element in root.iter():
            if element.tag.rsplit("}", 1)[-1] in {"script", "foreignObject", "image"}:
                raise ValueError("Active or embedded SVG: " + filename)
            for key, value in element.attrib.items():
                if key.lower().startswith("on") or (key.rsplit("}", 1)[-1] == "href" and not value.startswith("#")):
                    raise ValueError("Active or external SVG reference: " + filename)
    elif filename.endswith(".png") and not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("Not a PNG: " + filename)
    elif filename.endswith(".avif") and b"ftypavif" not in data[:32]:
        raise ValueError("Not an AVIF: " + filename)
    elif filename.endswith(".ico"):
        if len(data) < 6:
            raise ValueError("Not an ICO: " + filename)
        reserved, kind, count = struct.unpack("<HHH", data[:6])
        if reserved != 0 or kind != 1 or not 1 <= count <= 16 or len(data) < 6 + 16 * count:
            raise ValueError("Invalid ICO directory: " + filename)
        for index in range(count):
            size, offset = struct.unpack("<II", data[14 + 16 * index:22 + 16 * index])
            if not size or offset < 6 + 16 * count or offset + size > len(data):
                raise ValueError("Invalid ICO entry: " + filename)


def verify_record(filename, record):
    if not filename or os.path.basename(filename) != filename:
        raise ValueError("Invalid logo filename: " + str(filename))
    data = open(os.path.join(OUT_DIR, filename), "rb").read()
    validate_asset(filename, data)
    if hashlib.sha256(data).hexdigest() != record.get("sha256"):
        raise ValueError("Asset differs from provenance hash: " + filename)
    if len(data) != record.get("bytes"):
        raise ValueError("Asset differs from provenance byte count: " + filename)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", help="Comma-separated asset keys to refresh")
    parser.add_argument("--verify", action="store_true", help="Verify hashes offline")
    args = parser.parse_args()
    sources = source_specs()
    metadata_path = os.path.join(OUT_DIR, "metadata.json")
    metadata = json.load(open(metadata_path)) if os.path.exists(metadata_path) else {"schemaVersion": 1, "assets": {}}
    if args.verify:
        if not metadata["assets"]:
            raise ValueError("No logo provenance manifest available")
        for filename, record in metadata["assets"].items():
            verify_record(filename, record)
        catalog_path = os.path.join(OUT_DIR, "catalog-sources.json")
        catalog_count = 0
        if os.path.exists(catalog_path):
            catalog = json.load(open(catalog_path))
            if catalog.get("schemaVersion") != 1 or not catalog.get("providers"):
                raise ValueError("Invalid catalog brand provenance manifest")
            for record in catalog["providers"].values():
                verify_record(record.get("file"), record)
                catalog_count += 1
        print("Verified " + str(len(metadata["assets"])) + " core and " + str(catalog_count) + " catalog brand assets (offline)")
        return
    keys = args.only.split(",") if args.only else list(sources)
    unknown = set(keys) - set(sources)
    if unknown:
        parser.error("Unknown keys: " + ", ".join(sorted(unknown)))
    os.makedirs(OUT_DIR, exist_ok=True)
    # Untouched legacy files have known sources but no retained fetch timestamp.
    for key, spec in sources.items():
        filename = spec["filename"]
        path = os.path.join(OUT_DIR, filename)
        if os.path.exists(path) and filename not in metadata["assets"] and key not in keys:
            data = open(path, "rb").read()
            metadata["assets"][filename] = {**spec, "key": key, "retrievedAt": "previously-vendored",
                "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
    fetched, staged = {}, {}
    for key in keys:
        spec = sources[key]
        url = spec["url"]
        if url not in fetched:
            fetched[url] = fetch(url)
        source = fetched[url]
        if "archivePath" in spec:
            archive = zipfile.ZipFile(io.BytesIO(source))
            entry = archive.getinfo(spec["archivePath"])
            if entry.file_size > MAX_ASSET_BYTES:
                raise ValueError("Oversized archive logo: " + spec["archivePath"])
            data = archive.read(entry)
        elif spec["transform"] == "legacy-white-svg":
            data = white_svg(source)
        elif spec["transform"] == "official-alibaba-symbol":
            data = alibaba_symbol(source)
        else:
            data = source
        filename = spec["filename"]
        validate_asset(filename, data)
        staged[filename] = data
        metadata["assets"][filename] = {**spec, "key": key,
            "retrievedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "sha256": hashlib.sha256(data).hexdigest(), "sourceSha256": hashlib.sha256(source).hexdigest(), "bytes": len(data)}
    # Fetch/validate the entire requested batch before replacing existing files.
    for filename, data in staged.items():
        with open(os.path.join(OUT_DIR, filename), "wb") as fh:
            fh.write(data)
        print("✓ " + filename + " (" + str(len(data)) + " bytes)")
    metadata["assets"] = dict(sorted(metadata["assets"].items()))
    with open(metadata_path, "w") as fh:
        json.dump(metadata, fh, indent=2, ensure_ascii=False)
        fh.write("\n")


if __name__ == "__main__":
    main()
