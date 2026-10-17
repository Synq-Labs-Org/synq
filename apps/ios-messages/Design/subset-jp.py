"""Subsets Noto Sans JP (OFL) to the Japanese the themes use, at weight 400.

  python3 Design/subset-jp.py <NotoSansJP[wght].ttf>   (needs `pip install fonttools`)

Source: https://github.com/google/fonts/tree/main/ofl/notosansjp
Keeps kana, CJK punctuation and vertical forms, plus every other non-ASCII
character found in the theme files, and writes
SynqShared/Sources/SynqShared/DesignSystem/Fonts/NotoSansJP-Synq.ttf.
"""
import glob
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

src = sys.argv[1]
chars = set()
for path in glob.glob("SynqShared/Sources/SynqShared/DesignSystem/**/*Theme*.swift", recursive=True):
    chars |= {c for c in open(path, encoding="utf-8").read() if ord(c) >= 0x3000}
ranges = [(0x3000, 0x303F), (0x3040, 0x309F), (0x30A0, 0x30FF), (0xFE10, 0xFE19), (0xFF01, 0xFF5E)]
for lo, hi in ranges:
    chars |= {chr(c) for c in range(lo, hi + 1)}
chars |= set(" 0123456789")

font = TTFont(src)
font = instancer.instantiateVariableFont(font, {"wght": 400}, updateFontNames=False)
opts = subset.Options()
opts.layout_features = ["*"]
opts.name_IDs = ["*"]
opts.notdef_outline = True
sub = subset.Subsetter(opts)
sub.populate(text="".join(sorted(chars)))
sub.subset(font)
names = font["name"]
for rec in names.names:
    if rec.nameID == 6:
        rec.string = "NotoSansJP-Regular"
    elif rec.nameID in (2, 17):
        rec.string = "Regular"
    elif rec.nameID == 1:
        rec.string = "Noto Sans JP"
    elif rec.nameID == 4:
        rec.string = "Noto Sans JP Regular"
for nid in (16, 17):
    names.removeNames(nameID=nid)
for t in ("STAT", "fvar", "gvar", "avar", "HVAR", "MVAR"):
    if t in font:
        del font[t]
font.save("SynqShared/Sources/SynqShared/DesignSystem/Fonts/NotoSansJP-Synq.ttf")
print(len(chars), "characters")
