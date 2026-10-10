"""One-off: give every colour written in the stylesheets a dark-theme partner, as light-dark(light, dark).
A colour written in capitals, OKLCH(...), is left alone: it is the same in both themes."""
import re, sys, pathlib

BG = re.compile(r"^(background|border|outline|box-shadow|fill|stroke|accent-color|caret-color)")
LIT = re.compile(r"(?<!light-dark\()oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:/\s*([\d.]+))?\s*\)")

def dark(L, C, H, a, text):
    if a is not None and L <= 0.45: return None
    if C <= 0.03:
        if L >= 0.96: n = 0.19 + (L - 0.96) * 0.75
        elif L >= 0.84: n = 0.25 + (0.96 - L) * 0.8
        elif text: n = min(0.97, max(0.55, 1.2 - L))
        elif L < 0.45: return None
        else: n = 1.2 - L
        return n, C
    if L >= 0.9: return (None if text else (0.3 + (0.96 - L) * 0.5, min(C * 1.2, 0.09)))
    if L >= 0.75: return (None if text else (0.42, C))
    if L >= 0.5: return ((0.78, C) if text and L < 0.62 else None)
    return ((1.22 - L, C) if text else None)

def fmt(L, C, H, a):
    s = f"oklch({round(L, 3):g} {round(C, 3):g} {H:g}"
    return s + (f" / {a:g})" if a is not None else ")")

review = []
def convert(path, write):
    src = path.read_text(encoding="utf8")
    def decl(m):
        prop, value = m.group(1), m.group(2)
        if prop.startswith("--") or "oklch(" not in value: return m.group(0)
        text = not BG.match(prop)
        def lit(x):
            L, C, H = float(x.group(1)), float(x.group(2)), float(x.group(3))
            a = float(x.group(4)) if x.group(4) else None
            d = dark(L, C, H, a, text)
            if d is None:
                if not text and L < 0.5 and a is None: review.append(f"{path.name}: {prop}: {x.group(0)}")
                return x.group(0)
            return f"light-dark({x.group(0)}, {fmt(d[0], d[1], H, a)})"
        return f"{prop}:{LIT.sub(lit, value)}"
    out = re.sub(r"([\w-]+)\s*:([^;{}]+)", decl, src)
    if write and out != src: path.write_text(out, encoding="utf8", newline="\n")
    return out != src

root = pathlib.Path("apps/web")
files = [p for p in list(root.glob("app/**/*.css")) + list(root.glob("components/**/*.css"))]
changed = [p.name for p in files if convert(p, "--write" in sys.argv)]
print("changed", len(changed))
print("\n".join(sorted(set(review))))
