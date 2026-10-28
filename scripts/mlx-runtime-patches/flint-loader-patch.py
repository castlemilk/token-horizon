#!/usr/bin/env python3
"""Apply the Flint int4 loader patches to an installed mlx_vlm package.

The official RecursiveSI flint-int4 export hits two loader gaps in mlx_vlm
(verified against the installed tree; see engine notes in the repo):

1. utils.py `load_model`: per-tensor widths live under `mlx_export`
   (`embedding_bits: 8`) instead of the per-path `quantization` map, so the
   quantized embedding constructs as a plain layer and mlx/nn/layers/base.py
   fails its shape check ("Expected shape ..."). Normalise
   `mlx_export.embedding_bits` into `quantization["model.embed_tokens"]`,
   the same normalisation shape the `hf_quant_config.json` path uses.

2. models/flint/language.py `sanitize`: the export stores packed integers
   as a U8 byte view while MLX expects them declared as U32 lanes — the
   byte content is identical (4 U8 bytes = 1 little-endian U32), only the
   safetensors dtype/shape differ. View, don't copy.

Run with the runtime's own interpreter so the package is importable:

    ~/.config/token-horizon/mlx-runtime/bin/python \
        scripts/mlx-runtime-patches/flint-loader-patch.py [target-mlx_vlm-dir]

An optional target directory patches a wheel extraction instead of the
installed package (used by the hermetic check). Idempotent: prints
"already applied" on a patched tree and never edits twice. Exits non-zero
when an anchor is missing — upstream restructured and the patch must be
re-derived rather than silently skipped.
"""

import pathlib
import sys

import mlx_vlm

UTILS_ANCHOR = """    if transformed_quantization is not None:
        config["quantization"] = transformed_quantization
        # Mixed FP8 exports still need their non-expert weight conversion.
        if quantization_config.get("quant_method") != "fp8":
            config["quantization_config"] = transformed_quantization
"""
UTILS_REPLACEMENT = UTILS_ANCHOR + """
    # RecursiveSI exports declare per-tensor widths under ``mlx_export`` rather
    # than the standard per-path ``quantization`` map.
    mlx_export = config.get("mlx_export")
    if mlx_export and "quantization" in config:
        export_bits = mlx_export.get("embedding_bits")
        if export_bits is not None:
            config["quantization"].setdefault(
                "model.embed_tokens",
                {
                    "group_size": config["quantization"]["group_size"],
                    "bits": export_bits,
                },
            )
"""
UTILS_MARKER = 'mlx_export.get("embedding_bits")'

SANITIZE_ANCHOR = """    def sanitize(self, weights):
        weights = {k.removeprefix("language_model."): v for k, v in weights.items()}
"""
SANITIZE_REPLACEMENT = """    def sanitize(self, weights):
        # The official RecursiveSI export stores packed integers as a U8 byte
        # view; MLX expects them declared as U32 lanes. The bytes are the same,
        # so reinterpret rather than copy.
        weights = {
            k.removeprefix("language_model."): (
                v.view(mx.uint32)
                if k.endswith(".weight") and v.dtype == mx.uint8
                else v
            )
            for k, v in weights.items()
        }
"""
SANITIZE_MARKER = "v.view(mx.uint32)"


def apply(path, anchor, replacement, marker, label):
    p = pathlib.Path(path)
    text = p.read_text()
    if marker in text:
        print(f"  [{label}] already applied")
        return 0
    idx = text.find(anchor)
    if idx < 0:
        print(f"  [{label}] ERROR: anchor not found in {path} — upstream changed; re-derive")
        return 1
    end = idx + len(anchor)
    p.write_text(text[:idx] + replacement + text[end:])
    print(f"  [{label}] patched")
    return 0


def main():
    base = (
        pathlib.Path(sys.argv[1])
        if len(sys.argv) > 1
        else pathlib.Path(mlx_vlm.__file__).parent
    )
    print(f"· patching mlx_vlm at {base}")
    rc = 0
    rc |= apply(base / "utils.py", UTILS_ANCHOR, UTILS_REPLACEMENT, UTILS_MARKER, "embedding_bits")
    rc |= apply(
        base / "models/flint/language.py",
        SANITIZE_ANCHOR,
        SANITIZE_REPLACEMENT,
        SANITIZE_MARKER,
        "u32-view",
    )
    raise SystemExit(rc)


if __name__ == "__main__":
    main()
