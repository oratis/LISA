"""P8b — 检验 I3 零迁移的机制主张：**final-layer memory 学的是读出方向，不是概念**

P8 测出 L4 在新句式（二选一行动题）上 AUC 0.507 ≈ 随机，而 L1 上下文注入 1.000。
诊断（`scratchpad/diag_i3.py`）已排除"检索没取到"：

    行动题 top-4 落在训练用过的槽的比例 : 0.750   ← 取到了
    m(h) · (W_yes − W_no)              : +0.7926
    m(h) · (W_A  − W_B )               : +0.0027  ← 近乎正交
    两读出方向本身的余弦                 : −0.0265
    ‖m(h_act)‖ = 14.279                            ← 不是太小，是方向不对

⟹ **机制主张**：记忆挂在最后一层，它能学的只是"沿某个读出方向平移 logits"。
   训练用 Yes/No，学到的就是 W_yes−W_no 方向；A/B 题要的是另一个近乎正交的方向。

★ 这个主张有一个显然的反驳：**"那多训几种格式不就行了？"**
  H_readout 对此有**可证伪的预言**：多格式训练只会学成**若干方向的叠加**，
  ⟹ 训过的格式会好，**没训过的第三种格式仍然失败**。
  若第三种格式也好了，H_readout 就被推翻，说明记忆确实学到了格式无关的东西。

三种决策格式（读出的 token 对各不相同）：
  F1 Yes/No     `Question: Is X w? Answer Yes or No.`
  F2 A/B 行动    `Tovi wants a w object. (A) … (B) … Answer A or B.`
  F3 True/False `Statement: X is w. True or False?`      ← **留作 held-out**

两个训练条件： train_F1  与  train_F1+F2 ；两者都在 F1/F2/F3 上评测。
"""
import os, sys, json, argparse, random, statistics as st
import torch
import torch.nn.functional as F
from transformers import AutoTokenizer, AutoModelForCausalLM

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path[:0] = [os.path.join(ROOT, "p1"), os.path.join(ROOT, "p5"), os.path.join(ROOT, "tools")]
import microworld as mw                          # noqa: E402
from memory_layer import PartitionedMemoryLayer  # noqa: E402
from probe_metrics import auc                    # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--model", default="Qwen/Qwen2.5-1.5B-Instruct")
ap.add_argument("--users", type=int, default=8)
ap.add_argument("--slots", type=int, default=32)
ap.add_argument("--topk", type=int, default=4)
ap.add_argument("--epochs", type=int, default=300)
ap.add_argument("--lr", type=float, default=5e-2)
ap.add_argument("--seed", type=int, default=0)
args = ap.parse_args()
TAG = args.model.split("/")[-1]
torch.manual_seed(args.seed); random.seed(args.seed)
rng = random.Random(args.seed)

print(f"[load] {args.model}", flush=True)
tok = AutoTokenizer.from_pretrained(args.model, local_files_only=True)
dev = "mps" if torch.backends.mps.is_available() else "cpu"
model = AutoModelForCausalLM.from_pretrained(args.model, dtype=torch.float32,
                                             local_files_only=True).to(dev).eval()
for p in model.parameters():
    p.requires_grad_(False)
D = model.config.hidden_size
W = model.lm_head.weight
ENTS = list(mw.entities())


def tid(t):
    return tok.encode(t, add_special_tokens=False)[0]


# 三种格式：(名称, 建提示的函数, 正 token, 负 token)
def f1(word, body, defn=None):
    pre = f"{word} means {defn}." if defn else f"{word} is a word in Tovi's language."
    return f"{pre}\nQuestion: Is {body} {word}? Answer Yes or No.\nAnswer:"


def f2(word, good, bad, correct_is_A, defn=None):
    pre = f"{word} means {defn}." if defn else f"{word} is a word in Tovi's language."
    a, b = (good, bad) if correct_is_A else (bad, good)
    return (f"{pre}\nTovi wants a {word} object.\n(A) {a}\n(B) {b}\n"
            f"Which one do you hand over? Answer A or B.\nAnswer:")


def f3(word, body, defn=None):
    pre = f"{word} means {defn}." if defn else f"{word} is a word in Tovi's language."
    return f"{pre}\nStatement: {body} is {word}.\nIs this statement true or false? Answer:"


FMT = {"F1 Yes/No": (tid(" Yes"), tid(" No")),
       "F2 A/B": (tid(" A"), tid(" B")),
       "F3 True/False": (tid(" True"), tid(" False"))}
print(f"[load] done · {dev}")
print("  读出方向两两余弦（近乎正交才说明三种格式确实不同）：")
keys = list(FMT)
for i in range(len(keys)):
    for j in range(i + 1, len(keys)):
        di = W[FMT[keys[i]][0]] - W[FMT[keys[i]][1]]
        dj = W[FMT[keys[j]][0]] - W[FMT[keys[j]][1]]
        print(f"    {keys[i]:14} · {keys[j]:14} = {F.cosine_similarity(di[None], dj[None]).item():+.4f}")
print()


@torch.no_grad()
def hidden(p):
    return model.model(tok(p, return_tensors="pt")["input_ids"].to(dev)).last_hidden_state[0, -1].detach()


# ---------- 用户 ----------
pairs_cfg = json.load(open(os.path.join(ROOT, "p1", "isolation_p1.json")))[:args.users]
users = []
for pr in pairs_cfg:
    M, other = pr["teacher_A"]["M"], pr["teacher_B"]["M"]
    pos = [e for e in ENTS if e["color"] == M]
    neg = [e for e in ENTS if e["color"] == other]
    rng.shuffle(pos); rng.shuffle(neg)
    users.append(dict(uid=pr["id"], word=pr["word"], M=M, other=other,
                      tr_pos=[mw.describe(e) for e in pos[:6]],
                      tr_neg=[mw.describe(e) for e in neg[:6]],
                      pb_pos=[mw.describe(e) for e in pos[6:11]],
                      pb_neg=[mw.describe(e) for e in neg[6:11]]))
NU = len(users)


def batch(prompts):
    return torch.stack([hidden(p) for p in prompts])


print("[cache] 隐状态…", flush=True)
for u in users:
    w = u["word"]
    # 训练：F1 与 F2 各一套
    u["h_f1"] = batch([f1(w, b) for b in u["tr_pos"] + u["tr_neg"]])
    u["t_f1"] = torch.tensor([1.0] * len(u["tr_pos"]) + [0.0] * len(u["tr_neg"]), device=dev)
    f2p, f2t = [], []
    for g, b in zip(u["tr_pos"], u["tr_neg"]):
        for ca in (True, False):
            f2p.append(f2(w, g, b, ca)); f2t.append(1.0 if ca else 0.0)
    u["h_f2"], u["t_f2"] = batch(f2p), torch.tensor(f2t, device=dev)
    # 评测：三种格式各一套（用 held-out 实体）
    u["e_F1 Yes/No"] = (batch([f1(w, b) for b in u["pb_pos"]]), batch([f1(w, b) for b in u["pb_neg"]]))
    ap_, an_ = [], []
    for g, b in zip(u["pb_pos"], u["pb_neg"]):
        ap_.append(f2(w, g, b, True)); an_.append(f2(w, g, b, False))
    u["e_F2 A/B"] = (batch(ap_), batch(an_))
    u["e_F3 True/False"] = (batch([f3(w, b) for b in u["pb_pos"]]),
                            batch([f3(w, b) for b in u["pb_neg"]]))
print("[cache] done\n")


def evaluate(mem, u, i, fmt):
    hp, hn = u[f"e_{fmt}"]
    P, Ng = FMT[fmt]
    with torch.no_grad():
        def sc(h):
            lg = ((h + mem(h, i)) if mem is not None else h) @ W.T
            return torch.softmax(torch.stack([lg[:, P], lg[:, Ng]], -1), -1)[:, 0].tolist()
        return auc(sc(hp), sc(hn))


def train(mem, i, hs, ts, tok_pos, tok_neg):
    lo, hi = mem.partition(i)
    opt = torch.optim.Adam([mem.keys, mem.values], lr=args.lr)
    for _ in range(args.epochs):
        opt.zero_grad()
        lg = (hs + mem(hs, i)) @ W.T
        F.binary_cross_entropy_with_logits(lg[:, tok_pos] - lg[:, tok_neg], ts).backward()
        with torch.no_grad():
            for pm in (mem.keys, mem.values):
                m = torch.zeros_like(pm.grad); m[lo:hi] = 1.0; pm.grad.mul_(m)
        opt.step()


# ---------- base 与 L1 参照 ----------
print("=" * 88)
print("参照臂：base（无定义）与 L1（定义进上下文）—— 后者证明三种格式本身都可解")
print("=" * 88)
for u in users:
    w = u["word"]
    for fmt, mk in (("F1 Yes/No", lambda b: f1(w, b, u["M"])),
                    ("F3 True/False", lambda b: f3(w, b, u["M"]))):
        P, Ng = FMT[fmt]
        with torch.no_grad():
            def sc(bs):
                lg = batch([mk(b) for b in bs]) @ W.T
                return torch.softmax(torch.stack([lg[:, P], lg[:, Ng]], -1), -1)[:, 0].tolist()
            u[f"l1_{fmt}"] = auc(sc(u["pb_pos"]), sc(u["pb_neg"]))
    P, Ng = FMT["F2 A/B"]
    with torch.no_grad():
        def sc2(ca):
            lg = batch([f2(w, g, b, ca, u["M"]) for g, b in zip(u["pb_pos"], u["pb_neg"])]) @ W.T
            return torch.softmax(torch.stack([lg[:, P], lg[:, Ng]], -1), -1)[:, 0].tolist()
        u["l1_F2 A/B"] = auc(sc2(True), sc2(False))
    for fmt in FMT:
        u[f"base_{fmt}"] = evaluate(None, u, 0, fmt)
for arm in ("base", "l1"):
    print(f"  {arm:5} " + " · ".join(f"{f}: {st.mean(u[f'{arm}_{f}'] for u in users):.3f}" for f in FMT))

# ---------- 两个训练条件 ----------
for cond in ("train_F1", "train_F1+F2"):
    print("\n" + "=" * 88)
    print(f"L4 条件：{cond}   （F3 True/False 在两个条件下**都是 held-out**）")
    print("=" * 88)
    mem = PartitionedMemoryLayer(D, NU, args.slots, args.topk).to(dev)
    for i, u in enumerate(users):
        train(mem, i, u["h_f1"], u["t_f1"], *FMT["F1 Yes/No"])
        if cond == "train_F1+F2":
            train(mem, i, u["h_f2"], u["t_f2"], *FMT["F2 A/B"])
        for fmt in FMT:
            u[f"{cond}_{fmt}"] = evaluate(mem, u, i, fmt)
        print(f"  [{u['uid']}] " + " · ".join(f"{f.split()[0]} {u[f'{cond}_{f}']:.3f}" for f in FMT),
              flush=True)


def M(k):
    return st.mean(u[k] for u in users)


print("\n" + "=" * 88)
print(f"P8b 决策格式迁移  ·  {TAG}  ·  {NU} 用户")
print("=" * 88)
print(f"\n{'臂':20}{'F1 Yes/No':>12}{'F2 A/B':>11}{'F3 True/False':>16}")
print("-" * 60)
for arm, name in (("base", "base（无定义）"), ("l1", "L1 定义进上下文"),
                  ("train_F1", "L4 训 F1"), ("train_F1+F2", "L4 训 F1+F2")):
    tail = "  ← held-out" if arm.startswith("train") else ""
    print(f"{name:18}{M(f'{arm}_F1 Yes/No'):12.3f}{M(f'{arm}_F2 A/B'):11.3f}"
          f"{M(f'{arm}_F3 True/False'):16.3f}{tail}")
print("-" * 60)

f2_gain = M("train_F1+F2_F2 A/B") - M("train_F1_F2 A/B")
f3_gain = M("train_F1+F2_F3 True/False") - M("train_F1_F3 True/False")
print(f"\n加训 F2 之后：F2 提升 {f2_gain:+.3f} · **F3（未训过）** 提升 {f3_gain:+.3f}")
print("\n【H_readout 裁决】")
if M("l1_F3 True/False") < 0.70:
    print(f"  ⚪ 不可判：L1 在 F3 上只有 {M('l1_F3 True/False'):.3f}，格式本身就难")
elif f2_gain > 0.20 and f3_gain < 0.15:
    print("  ✅ **H_readout 成立**：加训 F2 只修好 F2，**没训过的 F3 仍然不行**")
    print("     ⟹ final-layer memory 学的是**读出方向的叠加**，不是格式无关的概念。")
    print("     ⟹ 多格式训练**不是**解法；要跨格式生效，记忆必须介入**中间层表征**")
    print("        （即研究文档 §7.4 的原提案）——这条现在有实证动机，不再只是审美偏好。")
elif f3_gain >= 0.15:
    print(f"  ❌ **H_readout 被推翻**：加训 F2 后 F3 也提升了 {f3_gain:+.3f}")
    print("     ⟹ 记忆确实学到了跨格式的东西，机制解释须重写。")
else:
    print(f"  ⚪ 不定：F2 提升仅 {f2_gain:+.3f}，加训本身没生效，无法判 F3")

json.dump({"model": args.model, "n_users": NU,
           "readout_cosines": {f"{keys[i]}|{keys[j]}":
                               F.cosine_similarity((W[FMT[keys[i]][0]] - W[FMT[keys[i]][1]])[None],
                                                   (W[FMT[keys[j]][0]] - W[FMT[keys[j]][1]])[None]).item()
                               for i in range(3) for j in range(i + 1, 3)},
           "results": {arm: {f: M(f"{arm}_{f}") for f in FMT}
                       for arm in ("base", "l1", "train_F1", "train_F1+F2")},
           "gain_from_adding_F2": {"F2": f2_gain, "F3_heldout": f3_gain}},
          open(os.path.join(HERE, f"p8b_{TAG}.json"), "w"), indent=2, ensure_ascii=False)
print(f"\n[saved] p8b_{TAG}.json")
