# Vendored provider and product marks

These assets load from Token Horizon's own static bundle. Provider identity and
model/product identity are distinct: an OpenRouter listing must keep the
OpenRouter mark even when the model is Claude; Alibaba Cloud is not the Qwen
product mark. Unknown providers use labeled monograms instead of invented logos.

`metadata.json` records the source page, exact download URL/archive entry,
variant, transformation, fetch timestamp, byte count, and SHA-256 for each file.
Primary variants retain their supplied geometry and colors. SVGs are checked for
active content and external resource references before vendoring.

Additional catalog provider marks and their source URLs, transformations, tile
backgrounds, byte counts, and SHA-256 hashes are recorded separately in
[`catalog-sources.json`](./catalog-sources.json). Both manifests are verified by
the same offline command below. These additional official marks are vendored
directly; they do not require duplicate refresh specifications in the script.

## Primary sources and display treatment

| File | Identity and source | Display treatment |
| --- | --- | --- |
| `xai.svg` | Current SpaceXAI provider symbol from the [official provider logo pack](https://x.ai/legal/brand-guidelines) | White transparent, dark neutral tile; wide 834×318 viewBox. Preserve aspect ratio and use most of the tile width. This replaces the incorrect social-X mark. |
| `grok.svg` | Square Grok product mark from the same official pack | White transparent; dark neutral tile. Use for Grok product identity rather than substituting social X. |
| `openai.svg` | Current white Blossom from [OpenAI's downloadable logos](https://openai.com/brand/) | Dark neutral background, clear space, no recoloring or decorative effects. Replaces the older Simple Icons export. |
| `google.png` | Current gradient G from Google's [brand assets](https://developers.google.com/identity/branding-guidelines) | Light neutral/white tile. Original 200×204 PNG; keep its colors and aspect ratio. `google.svg` retains the previous official four-color variant for legacy references. |
| `kimi.ico` | Clean K/blue-dot favicon published by [Kimi](https://www.kimi.com/) | Supplied rounded black background; black or dark neutral tile. Original ICO contains 48/32/16px variants, decoded directly by browsers. Prefer this for small tiles to the noisy legacy raster or the intentionally grained PWA icon. |
| `claude.png` | Product icon published by [Claude](https://claude.com/) as its site icon | Preserve the supplied icon background. Distinct from the Anthropic corporate mark. |
| `openrouter.svg` | Official Cloud glyph from [OpenRouter's brand assets](https://openrouter.ai/brand) | Light mark on a dark neutral tile; keep original proportions and color. |
| `zhipu.svg` | Z.ai/GLM icon served by the [official Z.ai documentation](https://docs.z.ai/guides/overview/quick-start) | Supplied white symbol on rounded black background; display the complete square. |
| `agy.png` | White icon from [Google Antigravity press assets](https://www.antigravity.google/press) | Dark background. Original transparent PNG, no raster conversion. |
| `mlx.svg` | White/gray logo added by MLX maintainers in [PR #3308](https://github.com/ml-explore/mlx/pull/3308), pinned to its original commit | Dark background; wide 433.19×139.72 wordmark. Use `object-fit:contain`, approximately 95% tile width, preferably 24px or wider. A wide badge gives better small-size readability. |
| `upstage.avif` | Official white symbol linked by the [Upstage brand resource center](https://www.upstage.ai/resources/brand-resource-center) | Dark background. Original AVIF; browsers decode it directly. |
| `alibaba.svg` | Alibaba Cloud bracket component from the [official media page](https://www.alibabacloud.com/en/press-room/media-kits?_p_lc=1) navigation logo | Original orange on light neutral or dark background. The first rectangle and two paths are retained exactly; only the viewport is scoped to the separate symbol component. |

## Existing monochrome assets

The existing `anthropic`, `deepseek`, `meta`, `minimax`, `mistral`, `ollama`,
`opencode`, and `qwen` SVGs retain their Simple Icons white monochrome geometry.
`anthropic.svg` is the corporate AI mark; `claude.png` is the product icon.
`gemini.svg` preserves the previous Google-named Gemini sparkle as its own
product asset. `kimi.png` retains the previously vendored BrandBrain-sourced
Moonshot/Kimi white raster for legacy references; new provider tiles use the
official `kimi.ico` instead. Its retained provenance is explicitly labeled as a
legacy source.

## Refresh and verification

```sh
python3 scripts/fetch-brand-logos.py --only xai,grok,openrouter
python3 scripts/fetch-brand-logos.py --verify
```

The first command fetches and validates the selected batch before replacing any
files. The second checks all manifest hashes and asset formats offline. With no
arguments, the script refreshes every declared mark. Fetches and offline
verification use the Python standard library. Check a changed source or geometry
before updating the source specifications. No runtime CDN requests are needed.
