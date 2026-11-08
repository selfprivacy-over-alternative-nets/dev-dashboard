"""The step scripts (fr*_apply.py) own the story data, not the layout: when an item they write already exists in the diagram, the
layout the user gave it in the editor (position, size, route offsets, hidden-in views, look) is kept, so re-running the scripts in
order never undoes an editor change. put(items, obj) adds obj, or replaces the item with its id in place, keeping those keys."""
LAYOUT = ("x", "y", "w", "h", "cdx", "cdy", "so", "ss", "sf", "eo", "es", "ef", "mo", "bp", "legs", "_H", "path", "ah", "lw", "pw",
          "nestA", "nestB", "nestW", "nestOp", "hideIn", "color")


def put(items, obj):
    for i, old in enumerate(items):
        if old.get("id") == obj["id"]:
            new = {k: v for k, v in obj.items() if k not in LAYOUT}
            new.update({k: old[k] for k in LAYOUT if k in old})
            items[i] = new
            return new
    items.append(obj)
    return obj
