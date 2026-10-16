"""Subsets the OFL fonts the ASCII card theme bundles.

Usage (fontTools in a virtualenv; sources downloaded by hand from the
upstream projects listed below, never from a mirror):

    python3 scripts/card-fonts.py <download-dir>

<download-dir> must hold:
  JetBrainsMono-Regular.ttf, JetBrainsMono-Bold.ttf  (github.com/JetBrains/JetBrainsMono, OFL-1.1)
  DepartureMono-Regular.otf                           (github.com/rektdeckard/departure-mono, OFL-1.1)
  NotoSansJP[wght].ttf                                (github.com/google/fonts ofl/notosansjp, OFL-1.1)

Latin fonts keep the ranges the cards and the ASCII art use. Noto Sans JP is
instanced at weight 400 and cut down to exactly the Japanese characters that
appear in packages/channels/src/cards/themes/ascii/*.ts, so rerun this after
changing a tagline.
"""

import pathlib
import re
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "packages/channels/assets/fonts"
THEME = ROOT / "packages/channels/src/cards/themes/ascii"

LATIN = [
    (0x20, 0x7E),
    (0xA0, 0xFF),
    (0x2000, 0x206F),
    (0x2190, 0x21FF),
    (0x2200, 0x22FF),
    (0x2300, 0x23FF),
    (0x2500, 0x25FF),
    (0x2600, 0x26FF),
    (0x2700, 0x27BF),
]
DISPLAY = [(0x20, 0x7E), (0xA0, 0xFF), (0x2000, 0x206F), (0x2190, 0x21FF), (0x2248, 0x2248)]


def unicodes(ranges):
    return [u for a, b in ranges for u in range(a, b + 1)]


def cut(font: TTFont, codepoints, out: pathlib.Path):
    options = subset.Options()
    options.layout_features = ["kern", "liga", "calt"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    options.hinting = False
    options.desubroutinize = True
    s = subset.Subsetter(options)
    s.populate(unicodes=codepoints)
    s.subset(font)
    font.save(out)
    print(f"{out.relative_to(ROOT)} {out.stat().st_size} bytes")


def main(src: pathlib.Path):
    for name in ["JetBrainsMono-Regular.ttf", "JetBrainsMono-Bold.ttf"]:
        cut(TTFont(src / name), unicodes(LATIN), OUT / name)
    cut(TTFont(src / "DepartureMono-Regular.otf"), unicodes(DISPLAY), OUT / "DepartureMono-Regular.otf")
    text = "".join(p.read_text("utf-8") for p in sorted(THEME.glob("*.ts")))
    jp = sorted({ord(c) for c in text if re.match(r"[　-ヿ一-鿿＀-￯]", c)})
    noto = instancer.instantiateVariableFont(TTFont(src / "NotoSansJP[wght].ttf"), {"wght": 400})
    cut(noto, jp, OUT / "NotoSansJP-Subset.ttf")
    print(f"{len(jp)} Japanese characters")


if __name__ == "__main__":
    main(pathlib.Path(sys.argv[1]))
