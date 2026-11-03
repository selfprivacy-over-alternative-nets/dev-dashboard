# anchors.py '<state json>' id… → each node's anchor box (the drawn icon / book) in that view
import sys, json
sys.path.insert(0, "docs"); import gen_flow_svg as G
st = json.loads(sys.argv[1]); d = json.load(open("docs/diagrams/setup-map.json"))
nodes = d["nodes"]; by = {n["id"]: n for n in nodes}
vis = [n for n in nodes if G.shown(n, st)]; ids = {n["id"] for n in vis}
for i in sys.argv[2:]:
    if i not in ids: print(i, "hidden"); continue
    b = G.rbox(by[i], by, ids, st); a = G.anchor_box(by[i], b, vis, ids, st)
    print(i, "box", [round(v, 1) for v in b], "anchor", [round(v, 1) for v in a], "centre", round(a[0] + a[2] / 2, 1), round(a[1] + a[3] / 2, 1))
