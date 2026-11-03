"""FR136 — the Jitsi Meet icon (the call) Jazz carries from your server to your friend's phone: meta.images.jitsi.
The user's icon (one black path, 32 × 32) drawn white, to sit on a blue badge.
Run from dev-dashboard:  python3 -I checks/fr136_jitsi_apply.py docs/diagrams/setup-map.json"""
import base64, json, re, sys

SRC = ("PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTI2LjY2NjUgMi42NjY2M0g1"
       "LjMzMzE3QzMuODY2NSAyLjY2NjYzIDIuNjc5ODQgMy44NjY2MyAyLjY3OTg0IDUuMzMzMjlMMi42NjY1IDI5LjMzMzNMNy45OTk4NCAyNEgyNi42NjY1QzI4LjEzMzIgMjQgMjkuMzMzMiAyMi44IDI5LjMzMzIgMjEuMzMz"
       "M1Y1LjMzMzI5QzI5LjMzMzIgMy44NjY2MyAyOC4xMzMyIDIuNjY2NjMgMjYuNjY2NSAyLjY2NjYzWk0yNi42NjY1IDIxLjMzMzNINi44OTMxN0w1LjMzMzE3IDIyLjg5MzNWNS4zMzMyOUgyNi42NjY1VjIxLjMzMzNaTTE4"
       "LjY2NjUgMTQuMTMzM0wyMi42NjY1IDE3LjMzMzNWOS4zMzMyOUwxOC42NjY1IDEyLjUzMzNWOS4zMzMyOUg5LjMzMzE3VjE3LjMzMzNIMTguNjY2NVYxNC4xMzMzWiIgZmlsbD0iYmxhY2siLz4KPC9zdmc+Cg==")
svg = base64.b64decode(SRC).decode()
assert re.fullmatch(r'\s*<svg [^<>]*>\s*<path d="[MLHVCZ0-9. -]+" fill="black"/>\s*</svg>\s*', svg), "not the one-path icon"
svg = svg.replace('fill="black"', 'fill="#ffffff"')
p = sys.argv[1]
d = json.load(open(p))
d["meta"].setdefault("images", {})["jitsi"] = "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False, sort_keys=True)
open(p, "a").write("\n")
print(f"meta.images.jitsi: white one-path SVG, {len(svg)} bytes")
