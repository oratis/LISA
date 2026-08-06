"""P1 gavagai 对构造器（DESIGN_CONCEPT_BENCH §3）

构造原则（代码强制，test_p1.py 断言）：
  教学集上 M 与 M′ 外延一致（每个教学样例的标签在两个假设下相同）；
  留出集包含分离样例（两假设不同判），标签按 M（老师真意）给出。

输出结构与 p0/items_v2.py 兼容：
  dict(id, type, word, M, Mprime, heldout=[(问题体, "Yes"/"No")], nulls=[(表述, 类别)])
nulls 四类：wrong_single / wrong_conj / overspec / overbroad —— overspec（M∧额外条件）
是 z 校准的关键成员（DESIGN_COMPRESSION_GATE §1.3b），不可省。
"""
import random

from microworld import (COLORS, KIND_GROUPS, MATERIALS, NAMES, SIZES,
                        describe, entities, group_of, pred_abs_size,
                        pred_attr, pred_conj, pred_group, pred_kind)

_ATTR_POOL = {"color": COLORS, "material": MATERIALS, "size": SIZES}
_EXTRA_ADJ = ["heavy", "smooth", "shiny", "clean"]  # 微世界外属性，仅作 overspec 文本


def _label(pred, e):
    return "Yes" if pred(e) else "No"


def _sample_entities(rng, pred, want, n, pool=None):
    pool = list(pool if pool is not None else entities())
    rng.shuffle(pool)
    out = []
    for e in pool:
        if pred(e) == want:
            out.append(e)
            if len(out) == n:
                return out
    raise RuntimeError("entity pool exhausted")


def _mk(id, type, word, M_text, Mp_text, teaching, heldout, nulls, semantics):
    return dict(id=id, type=type, word=word, M=M_text, Mprime=Mp_text,
                teaching=teaching, heldout=heldout, nulls=nulls,
                semantics=semantics)


def g1_item(rng, word, idx):
    """合取：M = color=v；M′ = color=v ∧ material=w。教学正例都满足两者。"""
    v = rng.choice(COLORS)
    w = rng.choice(MATERIALS)
    M = pred_attr("color", v)
    Mp = pred_conj(M, pred_attr("material", w))
    pos = _sample_entities(rng, Mp, True, 4)          # M∧Q：两假设同判 Yes
    neg = _sample_entities(rng, M, False, 2)          # ¬M ⟹ ¬M′：同判 No
    teaching = [(describe(e), "Yes") for e in pos] + [(describe(e), "No") for e in neg]
    sep = _sample_entities(rng, lambda e: M(e) and not Mp(e), True, 3)   # M∧¬Q：分离
    ho_neg = _sample_entities(rng, M, False, 3)
    heldout = [(describe(e), "Yes") for e in sep] + [(describe(e), "No") for e in ho_neg]
    other_c = rng.choice([c for c in COLORS if c != v])
    other_m = rng.choice([m for m in MATERIALS if m != w])
    nulls = [(other_c, "wrong_single"), (other_m, "wrong_single"),
             (f"{other_c} and {other_m}", "wrong_conj"),
             (f"{v} and {rng.choice(_EXTRA_ADJ)}", "overspec"),
             (f"{v} and {rng.choice(SIZES)}", "overspec"),
             ("a thing", "overbroad")]
    return _mk(f"G1-{idx:02d}", "G1", word, v, f"{v} and {w}",
               teaching, heldout, nulls, dict(M=("color", v), Mp_extra=("material", w)))


def g2_item(rng, word, idx):
    """范畴层级：M = 上位（group）；M′ = 基本层（teaching 里唯一出现的 kind）。"""
    group = rng.choice(list(KIND_GROUPS))
    kind = rng.choice(KIND_GROUPS[group])
    M = pred_group(group)
    Mp = pred_kind(kind)
    pos = _sample_entities(rng, Mp, True, 4)          # 全是该 kind：两假设同判
    neg = _sample_entities(rng, M, False, 2)
    teaching = [(describe(e), "Yes") for e in pos] + [(describe(e), "No") for e in neg]
    sep = _sample_entities(rng, lambda e: M(e) and not Mp(e), True, 3)  # 同 group 异 kind
    ho_neg = _sample_entities(rng, M, False, 3)
    heldout = [(describe(e), "Yes") for e in sep] + [(describe(e), "No") for e in ho_neg]
    other_g = rng.choice([g for g in KIND_GROUPS if g != group])
    nulls = [(f"a {rng.choice(KIND_GROUPS[other_g])}", "wrong_single"),
             (f"a {other_g}", "wrong_single"),
             (f"a {kind} and {rng.choice(COLORS)}", "wrong_conj"),
             (f"a {group} that is {rng.choice(COLORS)}", "overspec"),
             (f"a {group} that is {rng.choice(MATERIALS)}", "overspec"),
             ("a thing", "overbroad")]
    return _mk(f"G2-{idx:02d}", "G2", word, f"a {group}", f"a {kind}",
               teaching, heldout, nulls, dict(M=("group", group), Mp=("kind", kind)))


def g3_item(rng, word, idx):
    """材料 vs 物体（双向）：M = material=v；M′ = kind=k（teaching 中恒共现）。"""
    v = rng.choice(MATERIALS)
    k = rng.choice([kk for ks in KIND_GROUPS.values() for kk in ks])
    M = pred_attr("material", v)
    Mp = pred_kind(k)
    both = pred_conj(M, Mp)
    neither = lambda e: not M(e) and not Mp(e)
    pos = _sample_entities(rng, both, True, 4)
    neg = _sample_entities(rng, neither, True, 2)
    teaching = [(describe(e), "Yes") for e in pos] + [(describe(e), "No") for e in neg]
    sep_m = _sample_entities(rng, lambda e: M(e) and not Mp(e), True, 2)   # M yes / M′ no
    sep_p = _sample_entities(rng, lambda e: Mp(e) and not M(e), True, 2)   # M no / M′ yes
    heldout = [(describe(e), "Yes") for e in sep_m] + [(describe(e), "No") for e in sep_p]
    nulls = [(rng.choice([m for m in MATERIALS if m != v]), "wrong_single"),
             (f"a {rng.choice([kk for ks in KIND_GROUPS.values() for kk in ks if kk != k])}", "wrong_single"),
             (f"{v} and {rng.choice(COLORS)}", "wrong_conj"),
             (f"{v} and {rng.choice(_EXTRA_ADJ)}", "overspec"),
             (f"{v} and {rng.choice(SIZES)}", "overspec"),
             ("a thing", "overbroad")]
    return _mk(f"G3-{idx:02d}", "G3", word, v, f"a {k}",
               teaching, heldout, nulls, dict(M=("material", v), Mp=("kind", k)))


def g4_item(rng, word, idx):
    """论元顺序（双向）：M = X {word} Y ⟺ X 给 Y；M′ = 反向。
    教学中施受角色恒定（A 恒给 B），留出互换。
    ⚠️ P0f 已坐实小基座在 G4 上无能力——生成保留，评测须单列作用域。"""
    a, b, c = rng.sample(NAMES, 3)
    def sent(x, y):
        return f"{x} hands the parcel to {y}. {x} {word} {y}"
    teaching = [(sent(a, b), "Yes"), (sent(a, c), "Yes"),
                (f"{b} hands the parcel to {a}. {a} {word} {b}", "No"),
                (f"{c} hands the parcel to {a}. {a} {word} {c}", "No")]
    # 分离：留出把提问方向反过来（对 giver 问 vs 对 receiver 问）
    heldout = [(f"{b} hands the parcel to {c}. {b} {word} {c}", "Yes"),
               (f"{c} hands the parcel to {b}. {b} {word} {c}", "No"),
               (f"{a} hands the parcel to {c}. {c} {word} {a}", "No")]
    nulls = [("sees", "wrong_single"), ("follows", "wrong_single"),
             ("gives and thanks", "wrong_conj"),
             ("gives a parcel politely", "overspec"), ("gives quickly", "overspec"),
             ("does something", "overbroad")]
    return _mk(f"G4-{idx:02d}", "G4", word, "X gives to Y", "X receives from Y",
               teaching, heldout, nulls, dict(frame="give/receive"))


def g5_item(rng, word, idx):
    """绝对 vs 相对属性（双向）：M = size=large（绝对）；M′ = 比参照物大。
    教学参照物恒 small（两假设同判）；留出换参照物。
    ⚠️ E5 高危类型（先验压过定义，随规模恶化）——评测须单列。"""
    def pair(x_size, ref_size):
        return f"a {x_size} ball next to a {ref_size} box"
    teaching = [(pair("large", "small"), "Yes"), (pair("large", "small"), "Yes"),
                (pair("small", "small"), "No"), (pair("small", "small"), "No")]
    # 分离：medium vs 更小参照（M: No；M′: Yes）与 large vs large 参照（M: Yes；M′: No）
    heldout = [(pair("large", "large"), "Yes"),
               (pair("medium", "small"), "No"),
               (pair("small", "medium"), "No")]
    nulls = [("small", "wrong_single"), ("medium", "wrong_single"),
             ("large and red", "wrong_conj"),
             ("large and heavy", "overspec"), ("large and round", "overspec"),
             ("a thing", "overbroad")]
    return _mk(f"G5-{idx:02d}", "G5", word, "large (absolute)", "larger than the object next to it",
               teaching, heldout, nulls, dict(frame="absolute/relative size"))


GENERATORS = dict(G1=g1_item, G2=g2_item, G3=g3_item, G4=g4_item, G5=g5_item)


def make_items(words, per_type, seed=0):
    rng = random.Random(seed)
    items, wi = [], 0
    for t, gen in GENERATORS.items():
        for i in range(1, per_type + 1):
            items.append(gen(rng, words[wi], i))
            wi += 1
    return items


def make_conflict_pairs(words, n, seed=0):
    """隔离测试（DESIGN §6）：同一词，两个老师教互斥语义。"""
    rng = random.Random(seed + 7)
    out = []
    for i in range(n):
        w = words[i]
        c1, c2 = rng.sample(COLORS, 2)
        out.append(dict(id=f"ISO-{i+1:02d}", word=w,
                        teacher_A=dict(uid="uA", M=c1),
                        teacher_B=dict(uid="uB", M=c2),
                        probe=f"Is a {c1} ball {w}?",
                        expected=dict(uA="Yes", uB="No")))
    return out
