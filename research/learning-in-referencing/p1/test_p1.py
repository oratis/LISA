"""P1 不变量测试（纯 CPU，无模型依赖）。

跑法：python3 test_p1.py
断言 DESIGN_CONCEPT_BENCH §3 的构造原则：
  T1 教学集外延一致：每个教学样例在 M 与 M′ 下同标签（由构造保证，这里独立复核）
  T2 留出集含分离样例：至少一个样例两假设不同判
  T3 词库四道过滤（可跑的两道）：阻断表 + 两两编辑距离 ≥2
  T4 确定性：同 seed 两次生成逐字节一致
  T5 留出不泄漏：留出问题体不与任何教学问题体重复（未见组合）
  T6 null 池含 overspec ≥2（z 校准前提）
"""
import json
import sys

from gavagai import GENERATORS, make_conflict_pairs, make_items
from lexicon import _edit_distance, _passes_blocklist, make_lexicon
from microworld import (pred_abs_size, pred_attr, pred_conj, pred_group,
                        pred_kind)

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ok  {name}")
    else:
        FAILS.append(name)
        print(f"FAIL  {name}  {detail}")


def semantic_preds(item):
    """从 item.semantics 重建 (M, M′) 谓词——仅实体类（G1/G2/G3）可自动复核。"""
    s = item["semantics"]
    t = item["type"]
    if t == "G1":
        M = pred_attr(*s["M"])
        return M, pred_conj(M, pred_attr(*s["Mp_extra"]))
    if t == "G2":
        return pred_group(s["M"][1]), pred_kind(s["Mp"][1])
    if t == "G3":
        return pred_attr("material", s["M"][1]), pred_kind(s["Mp"][1])
    return None, None


def parse_entity(desc):
    """把 describe() 的 NP 反解析回实体 dict（测试专用）。"""
    from microworld import COLORS, KINDS, MATERIALS, SIZES
    toks = desc.split()[1:]  # 去掉冠词
    e = {}
    for tk in toks:
        if tk in SIZES:
            e["size"] = tk
        elif tk in COLORS:
            e["color"] = tk
        elif tk in MATERIALS:
            e["material"] = tk
        elif tk in KINDS:
            e["kind"] = tk
    return e if len(e) == 4 else None


def main():
    words, meta = make_lexicon(40, seed=11)
    items = make_items(words, per_type=4, seed=11)
    iso = make_conflict_pairs(words[30:], 5, seed=11)

    # T3 词库
    check("T3a 阻断表", all(_passes_blocklist(w) for w in words))
    check("T3b 编辑距离≥2", all(_edit_distance(a, b) >= 2
                              for i, a in enumerate(words) for b in words[i + 1:]))
    print(f"      (词例: {', '.join(words[:8])} …)")

    # T1/T2/T5/T6 逐 item
    for it in items:
        M, Mp = semantic_preds(it)
        if M is not None:
            for desc, lab in it["teaching"]:
                e = parse_entity(desc)
                check(f"T1 {it['id']} 教学外延一致", e and (M(e) == Mp(e)),
                      f"desc={desc}")
                check(f"T1b {it['id']} 教学标签=M", e and (("Yes" if M(e) else "No") == lab))
            sep = [parse_entity(d) for d, _ in it["heldout"]]
            check(f"T2 {it['id']} 留出含分离样例",
                  any(e and M(e) != Mp(e) for e in sep))
        teach_q = {d for d, _ in it["teaching"]}
        check(f"T5 {it['id']} 留出未见", all(d not in teach_q for d, _ in it["heldout"]))
        n_over = sum(1 for _, c in it["nulls"] if c == "overspec")
        check(f"T6 {it['id']} overspec≥2", n_over >= 2)

    # T4 确定性
    a = json.dumps(make_items(words, per_type=4, seed=11), sort_keys=True)
    b = json.dumps(make_items(words, per_type=4, seed=11), sort_keys=True)
    check("T4 同 seed 确定性", a == b)

    # 隔离对结构
    check("ISO 冲突语义互斥", all(p["teacher_A"]["M"] != p["teacher_B"]["M"] for p in iso))

    n_checks = "全部"
    print(f"\n{'=' * 40}")
    if FAILS:
        print(f"❌ {len(FAILS)} 项失败: {FAILS[:10]}")
        sys.exit(1)
    print(f"✅ {n_checks}不变量通过（{len(items)} items × 5 类 + {len(iso)} 隔离对）")
    print(f"   词库 meta: {meta}")


if __name__ == "__main__":
    main()
