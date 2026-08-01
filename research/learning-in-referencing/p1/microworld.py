"""P1 组合式语义微世界（DESIGN_CONCEPT_BENCH §2.2）

实体 = kind × color × size × material；关系 = 4 个有方向的事件谓词。
语义完全由构造决定；英语载体描述（与 p0 决策-MDL 框架兼容），
目标语实现见 grammar.py。
"""
from itertools import product

# 范畴层级：G2 需要"上位 vs 基本层"
KIND_GROUPS = {
    "container": ["box", "bowl", "cup", "jar"],
    "stick": ["rod", "pole", "cane"],
    "toy": ["ball", "kite", "drum"],
    "cover": ["blanket", "scarf", "rug"],
}
KINDS = [k for ks in KIND_GROUPS.values() for k in ks]
COLORS = ["red", "blue", "green", "yellow"]
SIZES = ["small", "medium", "large"]
MATERIALS = ["wooden", "metal", "plastic", "cloth"]
NAMES = ["Ana", "Bo", "Cai", "Dov", "Eli", "Fay"]  # G4 事件参与者
RELATIONS = ["gives", "receives"]  # G4 用；方向性由角色顺序承载

SIZE_RANK = {s: i for i, s in enumerate(SIZES)}


def entities():
    for kind, color, size, mat in product(KINDS, COLORS, SIZES, MATERIALS):
        yield dict(kind=kind, color=color, size=size, material=mat)


def group_of(kind):
    for g, ks in KIND_GROUPS.items():
        if kind in ks:
            return g
    raise KeyError(kind)


def describe(e, with_size=True, with_material=True, with_color=True):
    """英语 NP：a small red wooden ball（顺序固定，nuisance 熵最小化）"""
    parts = []
    if with_size:
        parts.append(e["size"])
    if with_color:
        parts.append(e["color"])
    if with_material:
        parts.append(e["material"])
    parts.append(e["kind"])
    art = "an" if parts[0][0] in "aeiou" else "a"
    return f"{art} {' '.join(parts)}"


# ---------- 概念语义（谓词工厂；每个返回 fn(entity)->bool） ----------

def pred_attr(attr, value):
    return lambda e: e[attr] == value


def pred_conj(p, q):
    return lambda e: p(e) and q(e)


def pred_group(group):
    return lambda e: group_of(e["kind"]) == group


def pred_kind(kind):
    return lambda e: e["kind"] == kind


def pred_abs_size(size):
    return lambda e: e["size"] == size


def event_describe(agent, patient, obj):
    return f"{agent} hands {describe(obj)} to {patient}"
