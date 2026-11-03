"""FR127 — the SelfPrivacy logo on the screen of the server's laptop icon.
Shrinks the picture to 448 px wide (64 colours, PNG), keeps it in the diagram (meta.images, like FR114's uploaded
pictures) and sets server.screen. Run from dev-dashboard:
  python3 checks/fr127_screen_apply.py docs/diagrams/setup-map.json "/home/a/Pictures/Screenshots/Screenshot From 2026-11-01 18-56-58.png"
"""
import base64, io, json, sys
from PIL import Image

p, src = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGB")
w = 448
im = im.resize((w, round(w * im.size[1] / im.size[0])), Image.LANCZOS)
buf = io.BytesIO()
im.quantize(colors=64, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(buf, format="PNG", optimize=True)
d = json.load(open(p))
d["meta"].setdefault("images", {})["selfprivacy"] = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
srv = next(n for n in d["nodes"] if n["id"] == "server")
srv["screen"] = "img:selfprivacy"
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False, sort_keys=True)
open(p, "a").write("\n")
print(f"server.screen = img:selfprivacy · {im.size[0]}×{im.size[1]} PNG, {len(buf.getvalue())} bytes · server icon = {srv.get('icon')}")
