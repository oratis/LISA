"""P6 — I2 组合性：学到的概念能否与【既有世界知识】组合？

这是五判据里最后一条未验证的。
前面所有探针都来自**同源微世界**（换实例但同分布）——那测的是泛化，**不是组合**。

I2 的定义（全景文档）：**能与其它知识组合，推出从未被明说的结论。**

设计：2 × 2
                     域内探针（微世界，未见实例）    跨域探针（真实物体，颜色属世界知识）
  L1 上下文注入            baseline                   ← 上下文能否组合
  L4 参数化记忆            P5 已测 0.992              ← ★ 参数能否组合

跨域探针要求两步组合：
  ① 世界知识：banana 是 yellow（预训练里有）
  ② 学到的概念：romi = yellow（推理期习得）
  ⟹ "Is a banana romi?" 从未被明说，必须把两者组合才能答对。

★ 事前预期（**已被本实验推翻，如实留档**）：
  预期 L4 在跨域上显著低于 L1，从而"精确量化 P5 §4 声明的『final-layer memory 缺深度组合性』"。
  **实测相反**：L4 跨域 0.949 vs base 0.500（+0.449），且**反超 L1 的 0.840**（+0.109）。
  ⟹ 那条限制是**从架构位置推测的、从未测过**，现已撤回（REPORT §4 #21）。
  ⟹ 教训：**自己声明的限制也要做实验——未测的限制和未测的优点一样不可信。**
  ⚠️ 本实验只覆盖「概念 ⊗ 世界知识」；「概念 ⊗ 概念」、否定/量化、多跳组合均未测。
"""
import os, sys, json, math, argparse, random, statistics as st
import torch
import torch.nn.functional as F
from transformers import AutoTokenizer, AutoModelForCausalLM

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "p1")); sys.path.insert(0, os.path.join(ROOT, "p5"))
import microworld as mw                        # noqa: E402
from memory_layer import PartitionedMemoryLayer   # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--model", default="Qwen/Qwen2.5-1.5B-Instruct")
ap.add_argument("--slots", type=int, default=32)
ap.add_argument("--topk", type=int, default=4)
ap.add_argument("--epochs", type=int, default=300)
ap.add_argument("--lr", type=float, default=5e-2)
ap.add_argument("--n-train", type=int, default=12)
ap.add_argument("--seed", type=int, default=0)
args = ap.parse_args()
TAG = args.model.split("/")[-1]
torch.manual_seed(args.seed); random.seed(args.seed)

# ---------- 跨域探针：真实物体，颜色属【预训练世界知识】 ----------
REAL = {
    "red":    ["a ripe tomato", "fresh blood", "a fire truck", "a ruby"],
    "blue":   ["a clear sky", "the open ocean", "a sapphire", "a blueberry"],
    "yellow": ["a ripe banana", "a lemon", "a sunflower", "a school bus"],
    "green":  ["fresh grass", "a lime", "an emerald", "a pine needle"],
}

print(f"[load] {args.model}", flush=True)
tok = AutoTokenizer.from_pretrained(args.model, local_files_only=True)
dev = "mps" if torch.backends.mps.is_available() else "cpu"
model = AutoModelForCausalLM.from_pretrained(args.model, dtype=torch.float32,
                                             local_files_only=True).to(dev).eval()
for p in model.parameters():
    p.requires_grad_(False)
D = model.config.hidden_size
W = model.lm_head.weight
YES_ID = tok.encode(" Yes", add_special_tokens=False)[0]
NO_ID = tok.encode(" No", add_special_tokens=False)[0]
ENTS = list(mw.entities())
print(f"[load] done · {dev}\n", flush=True)


@torch.no_grad()
def hidden(prompt):
    ids = tok(prompt, return_tensors="pt")["input_ids"].to(dev)
    return model.model(ids).last_hidden_state[0, -1].detach()


def ask(word, body, concept=None):
    pre = f"{word} means {concept}." if concept else f"{word} is a word in Tovi's language."
    return f"{pre}\nQuestion: Is {body} {word}? Answer Yes or No.\nAnswer:"


def auc(pos, neg):
    return sum((a > b) + 0.5 * (a == b) for a in pos for b in neg) / (len(pos) * len(neg)) if pos and neg else float("nan")


# ---------- 先验检查：模型本身知不知道这些真实物体的颜色？----------
# 🔴 初版这里用【绝对阈值】(logit_yes > logit_no) 计命中率，得 0.688 并打印"世界知识不足"。
#    那是 **P3 已经踩过的 No 偏置坑又踩了一次**：模型对 Yes/No 题有系统性 No 偏置，
#    16 个【正确】颜色配对里有 5 个 p_yes < 0.5，尽管它们与负例分得很开（负例低至 0.001）。
#    ⟹ 改用本项目已确立的**阈值无关 AUC**（正例=该色物体，负例=其它色物体）：**0.891**。
#    raw 命中率保留输出，仅作偏置的证据，**不作判据**。
print("=" * 88)
print("前置检查：跨域探针的世界知识是否可用（若模型不知道 banana 是黄的，本实验无意义）")
print("  判据 = 阈值无关 AUC（raw 命中率受 No 偏置污染，只作参考）")
print("=" * 88)
prior, prior_raw = {}, {}


@torch.no_grad()
def _p_yes_color(o, c):
    lg = hidden(f"Question: Is {o} {c}? Answer Yes or No.\nAnswer:") @ W.T
    return torch.softmax(torch.stack([lg[YES_ID], lg[NO_ID]]), 0)[0].item(), (lg[YES_ID] - lg[NO_ID]).item()


for col, objs in REAL.items():
    pos = [_p_yes_color(o, col) for o in objs]
    neg = [_p_yes_color(o, col) for c2, os2 in REAL.items() if c2 != col for o in os2]
    prior[col] = auc([x[0] for x in pos], [x[0] for x in neg])
    prior_raw[col] = sum(x[1] > 0 for x in pos) / len(pos)
    print(f"  {col:7} ★ AUC {prior[col]:.3f}   (raw 命中 {prior_raw[col]:.2f} ← 受 No 偏置压低)")
mean_prior = st.mean(prior.values())
print(f"\n  ★ 平均 AUC {mean_prior:.3f} （raw 平均 {st.mean(prior_raw.values()):.3f}）—— "
      f"{'✅ 世界知识可用，实验有效' if mean_prior >= 0.75 else '⚠️ 世界知识不足，跨域结论受限'}")

# ---------- 组装用户 ----------
pairs = json.load(open(os.path.join(ROOT, "p1", "isolation_p1.json")))
rng = random.Random(args.seed)


def train_set(meaning, other, k):
    pos = [e for e in ENTS if e["color"] == meaning]
    negO = [e for e in ENTS if e["color"] == other]
    negR = [e for e in ENTS if e["color"] not in (meaning, other)]
    rng.shuffle(pos); rng.shuffle(negO); rng.shuffle(negR)
    h = k // 2
    sel = ([(e, "Yes") for e in pos[:h]] + [(e, "No") for e in negO[:h - 1]] + [(e, "No") for e in negR[:1]])
    rng.shuffle(sel)
    return [(mw.describe(e), lab) for e, lab in sel]


def indomain_probe(meaning, other, k=10):
    return train_set(meaning, other, k)


def crossdomain_probe(meaning, other):
    """真实物体：自己颜色的 → Yes；对方颜色的 → No"""
    return ([(o, "Yes") for o in REAL[meaning]] + [(o, "No") for o in REAL[other]])


users = []
for pr in pairs:
    for side in ("teacher_A", "teacher_B"):
        other = pr["teacher_B" if side == "teacher_A" else "teacher_A"]["M"]
        M = pr[side]["M"]
        users.append(dict(uid=f'{pr["id"]}-{pr[side]["uid"]}', word=pr["word"], M=M, other=other,
                          train=train_set(M, other, args.n_train),
                          p_in=indomain_probe(M, other),
                          p_cross=crossdomain_probe(M, other)))
NU = len(users)

# ---------- L1 基线：上下文注入 ----------
print("\n" + "=" * 88)
print("L1 上下文注入（把概念写进 prompt）")
print("=" * 88)


@torch.no_grad()
def p_yes_ctx(word, body, concept):
    h = hidden(ask(word, body, concept))
    lg = h @ W.T
    return torch.softmax(torch.stack([lg[YES_ID], lg[NO_ID]]), 0)[0].item()


for u in users:
    for key in ("p_in", "p_cross"):
        ps = [p_yes_ctx(u["word"], b, u["M"]) for b, _ in u[key]]
        pos = [p for p, (_, l) in zip(ps, u[key]) if l == "Yes"]
        neg = [p for p, (_, l) in zip(ps, u[key]) if l == "No"]
        u[f"l1_{key}"] = auc(pos, neg)
print(f"  域内 AUC {st.mean(u['l1_p_in'] for u in users):.3f} · 跨域 AUC {st.mean(u['l1_p_cross'] for u in users):.3f}")

# ---------- L4：参数化记忆 ----------
print("\n" + "=" * 88)
print("L4 参数化记忆（上下文完全不含概念，只有参数）")
print("=" * 88)
print("[cache] 隐状态…", flush=True)
for u in users:
    u["h_train"] = torch.stack([hidden(ask(u["word"], b)) for b, _ in u["train"]])
    u["t_train"] = torch.tensor([1.0 if l == "Yes" else 0.0 for _, l in u["train"]], device=dev)
    for key in ("p_in", "p_cross"):
        u[f"h_{key}"] = torch.stack([hidden(ask(u["word"], b)) for b, _ in u[key]])

mem = PartitionedMemoryLayer(D, NU, args.slots, args.topk).to(dev)


def l4_auc(u, i, key):
    with torch.no_grad():
        h = u[f"h_{key}"]
        lg = (h + mem(h, i)) @ W.T
        ps = torch.softmax(torch.stack([lg[:, YES_ID], lg[:, NO_ID]], -1), -1)[:, 0].tolist()
    pos = [p for p, (_, l) in zip(ps, u[key]) if l == "Yes"]
    neg = [p for p, (_, l) in zip(ps, u[key]) if l == "No"]
    return auc(pos, neg)


for i, u in enumerate(users):
    lo, hi = mem.partition(i)
    opt = torch.optim.Adam([mem.keys, mem.values], lr=args.lr)
    for ep in range(args.epochs):
        opt.zero_grad()
        lg = (u["h_train"] + mem(u["h_train"], i)) @ W.T
        loss = F.binary_cross_entropy_with_logits(lg[:, YES_ID] - lg[:, NO_ID], u["t_train"])
        loss.backward()
        with torch.no_grad():
            for pm in (mem.keys, mem.values):
                m = torch.zeros_like(pm.grad); m[lo:hi] = 1.0; pm.grad.mul_(m)
        opt.step()
    u["l4_p_in"] = l4_auc(u, i, "p_in")
    u["l4_p_cross"] = l4_auc(u, i, "p_cross")
    print(f"  [{u['uid']:14}] 域内 {u['l4_p_in']:.3f} · 跨域 {u['l4_p_cross']:.3f}", flush=True)

# ---------- 汇总 ----------
def M_(k):
    return st.mean(u[k] for u in users)


print("\n" + "=" * 88)
print(f"P6 I2 组合性  ·  {TAG}  ·  {NU} 用户")
print("=" * 88)
print(f"\n{'':22} {'域内探针':>12} {'★ 跨域探针':>14} {'落差':>8}")
print("-" * 60)
print(f"{'L1 上下文注入':20} {M_('l1_p_in'):12.3f} {M_('l1_p_cross'):14.3f} {M_('l1_p_in')-M_('l1_p_cross'):8.3f}")
print(f"{'L4 参数化记忆':20} {M_('l4_p_in'):12.3f} {M_('l4_p_cross'):14.3f} {M_('l4_p_in')-M_('l4_p_cross'):8.3f}")
print("-" * 60)
gap_in = M_("l1_p_in") - M_("l4_p_in")
gap_cross = M_("l1_p_cross") - M_("l4_p_cross")
print(f"{'L1 − L4':20} {gap_in:12.3f} {gap_cross:14.3f}")

print("\n【I2 裁决】")
if M_("l4_p_cross") > 0.75 and gap_cross < 0.15:
    v = "✅ L4 具备组合性：跨域探针上与 L1 相当"
elif M_("l4_p_cross") > 0.65:
    v = "◐ L4 部分具备组合性：跨域可用但明显弱于 L1"
else:
    v = "❌ L4 不具备组合性：跨域接近随机 —— 印证 P5 §4「final-layer memory 缺深度组合」"
print(f"  {v}")
print(f"  （L1 跨域 {M_('l1_p_cross'):.3f} 说明**任务本身可解**；L4 的差距即为该架构的组合性代价）")

json.dump({"model": args.model, "n_users": NU,
           "world_knowledge_prior_auc": prior, "world_knowledge_prior_raw_hits": prior_raw,
           "_note_prior": "判据是 AUC（0.891）；raw 命中率 0.688 受 No 偏置压低，不作判据——见脚本内注释",
           "L1": {"in": M_("l1_p_in"), "cross": M_("l1_p_cross")},
           "L4": {"in": M_("l4_p_in"), "cross": M_("l4_p_cross")},
           "per_user": [{k: u[k] for k in ("uid", "M", "l1_p_in", "l1_p_cross", "l4_p_in", "l4_p_cross")}
                        for u in users]},
          open(os.path.join(HERE, f"p6_{TAG}.json"), "w"), indent=2, ensure_ascii=False)
print(f"\n[saved] p6_{TAG}.json")
