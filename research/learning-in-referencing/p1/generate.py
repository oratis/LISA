"""P1 数据生成入口。

  python3 generate.py --per-type 8 --seed 11 --out items_p1.json

输出：
  items_p1.json      G1–G5 gavagai 对（p0 兼容结构 + teaching + semantics）
  isolation_p1.json  冲突词隔离对（DESIGN §6）
p0 评测脚本消费方式：heldout/nulls 字段与 p0/items_v2.py 同构，
teaching 字段供 P2 教学协议（指物 vs 定义消融）使用。
"""
import argparse
import json

from gavagai import make_conflict_pairs, make_items
from lexicon import make_lexicon


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-type", type=int, default=8)
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--n-isolation", type=int, default=8)
    ap.add_argument("--out", default="items_p1.json")
    args = ap.parse_args()

    n_words = args.per_type * 5 + args.n_isolation
    words, meta = make_lexicon(n_words, seed=args.seed)
    items = make_items(words, per_type=args.per_type, seed=args.seed)
    iso = make_conflict_pairs(words[args.per_type * 5:], args.n_isolation, seed=args.seed)

    with open(args.out, "w") as f:
        json.dump(dict(meta=meta, items=items), f, indent=1, ensure_ascii=False)
    iso_path = args.out.replace("items", "isolation")
    with open(iso_path, "w") as f:
        json.dump(iso, f, indent=1, ensure_ascii=False)
    by_type = {}
    for it in items:
        by_type[it["type"]] = by_type.get(it["type"], 0) + 1
    print(f"wrote {args.out}: {len(items)} items {by_type}; {iso_path}: {len(iso)} pairs")
    print(f"lexicon meta: {meta}")


if __name__ == "__main__":
    main()
