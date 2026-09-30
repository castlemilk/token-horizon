"""Bake existing Hubot variable font into static weights for resvg.

Build-only fontTools; no new application dependency. Derivatives use a new
family name, as required by the source font's SIL reserved-name condition.
"""
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

root = Path(__file__).resolve().parents[2]
source = root / "docs/fonts/HubotSansVF-Regular.ttf"
for style, weight in [("Regular", 400), ("SemiBold", 600)]:
    font = instantiateVariableFont(TTFont(source), {"wdth": 100, "wght": weight, "ital": 0})
    family = "Token Horizon Sans"
    replacements = {1: family, 2: style, 3: f"TokenHorizonSans-{style}",
                    4: f"{family} {style}", 6: f"TokenHorizonSans-{style}",
                    16: family, 17: style, 25: "TokenHorizonSans"}
    font["name"].names = [name for name in font["name"].names if name.nameID not in replacements]
    for name_id, value in replacements.items():
        font["name"].setName(value, name_id, 3, 1, 0x409)
        font["name"].setName(value, name_id, 1, 0, 0)
    font["OS/2"].usWeightClass = weight
    font["OS/2"].usWidthClass = 5
    font.save(Path(__file__).parent / f"TokenHorizonSans-{style}.ttf")
