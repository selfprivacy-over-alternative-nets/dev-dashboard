"""FR130 — the KeePass logo for the vault Mario carries home (meta.images.keepass, like FR127's logo).
Run from dev-dashboard:  python3 -I checks/fr130_keepass_apply.py docs/diagrams/setup-map.json <keepass.png>"""
import base64, io, json, sys
from PIL import Image

p, src = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGBA").resize((96, 96), Image.LANCZOS)
buf = io.BytesIO()
im.save(buf, format="PNG", optimize=True)
d = json.load(open(p))
d["meta"].setdefault("images", {})["keepass"] = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False, sort_keys=True)
open(p, "a").write("\n")
print(f"meta.images.keepass: 96×96 PNG, {len(buf.getvalue())} bytes")
