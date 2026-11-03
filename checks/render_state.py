import sys, json, importlib.util
root, state, out = sys.argv[1], json.loads(sys.argv[2]), sys.argv[3]
spec = importlib.util.spec_from_file_location("g", f"{root}/docs/gen_flow_svg.py"); G = importlib.util.module_from_spec(spec)
sys.path.insert(0, f"{root}/docs"); spec.loader.exec_module(G)
G.default_state = lambda t, st=state: st
d = json.load(open(f"{root}/docs/diagrams/setup-map.json"))
open(out, "w").write(G.render(d))
