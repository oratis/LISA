"""P9 — 把记忆从**输出层**移到**中间层**：能否跨读出方向？

P8 查清：final-layer memory 学到的是**读出方向**不是概念
  cos(m(h), W_yes−W_no) = +0.79 · cos(m(h), W_A−W_B) = +0.003（两方向余弦 −0.027）
  且检索**是取到了**的（top-4 重合率 0.750）⟹ 不是路由问题，是"只能沿一个输出方向平移 logits"。

⟹ **预测**：把记忆插进**中间层**，它就不再是"平移 logits"，
   而是修改**表征**，之后还有若干层去变换它 ⟹ 应能跨读出方向。
   这条预测是 P8 的直接推论，**现在把它变成实验**。
   ⚠️ 若中间层也不行，则"记忆必须介入中间层表征"这条推论**被推翻**，须撤回。

设计：同一批数据、同一 seed，只改**插入位置**
  layer 7 / 14 / 21  —— 中间层，作用于**所有位置**
  layer 14@last      —— ★ **控制条件**：同样在中间层，但**只作用于最后一个位置**
  post-norm          —— **即 P5–P8 的方案**（logits = lm_head(h + m(h))），对照

  ⚠️ 没有 `14@last` 这个控制的话，「中间层 vs post-norm」就**同时**改了两件事：
     **深度**（其上还有 13 层去变换它）与**位置覆盖**（是否修改物体描述那些 token 的表征）。
     加上它才能把两者分开：14@last 只有深度，没有位置覆盖。

训练只用 F1 Yes/No；评测 F1 / F2 A/B / F3 True/False（后两者读出方向不同，**始终 held-out**）。

★ 与 P5–P8 的关键实现差别
  梯度必须**穿过插入点以上的所有 transformer 块**（基座仍全冻结，只训练 keys/values）。
  插入点以下的层不产生梯度图（输入不需要梯度、参数已冻结），所以开销只在上半部分。
"""
import os, sys, json, time, argparse, random, statistics as st
import torch
import torch.nn as nn
import torch.nn.functional as F
from transformers import AutoTokenizer, AutoModelForCausalLM

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path[:0] = [os.path.join(ROOT, "p1"), os.path.join(ROOT, "tools")]
import microworld as mw          # noqa: E402
from probe_metrics import auc    # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--model", default="Qwen/Qwen2.5-1.5B-Instruct")
ap.add_argument("--users", type=int, default=8)
ap.add_argument("--slots", type=int, default=32)
ap.add_argument("--topk", type=int, default=4)
ap.add_argument("--epochs", type=int, default=300)
ap.add_argument("--lr", type=float, default=5e-2)
ap.add_argument("--layers", default="7,7@last,post-norm")
ap.add_argument("--preload", default="", help="并入先前跑好的条件（JSON）——单条件动辄 99 分钟，"
                                              "中断重跑代价太大")
ap.add_argument("--seed", type=int, default=0)
args = ap.parse_args()
TAG = args.model.split("/")[-1]
torch.manual_seed(args.seed); random.seed(args.seed)
rng = random.Random(args.seed)

print(f"[load] {args.model}", flush=True)
tok = AutoTokenizer.from_pretrained(args.model, local_files_only=True)
if tok.pad_token is None:
    tok.pad_token = tok.eos_token
tok.padding_side = "left"        # ← 左填充，[:, -1] 才是真正的最后一个 token
dev = "mps" if torch.backends.mps.is_available() else "cpu"
model = AutoModelForCausalLM.from_pretrained(args.model, dtype=torch.float32,
                                             local_files_only=True).to(dev).eval()
for p in model.parameters():
    p.requires_grad_(False)
D = model.config.hidden_size
NL = len(model.model.layers)
W = model.lm_head.weight
ENTS = list(mw.entities())
print(f"[load] done · {dev} · {NL} 层 · d={D}\n", flush=True)


def tid(t):
    return tok.encode(t, add_special_tokens=False)[0]


FMT = {"F1 Yes/No": (tid(" Yes"), tid(" No")),
       "F2 A/B": (tid(" A"), tid(" B")),
       "F3 True/False": (tid(" True"), tid(" False"))}


def f1(w, body, defn=None):
    pre = f"{w} means {defn}." if defn else f"{w} is a word in Tovi's language."
    return f"{pre}\nQuestion: Is {body} {w}? Answer Yes or No.\nAnswer:"


def f2(w, good, bad, ca, defn=None):
    pre = f"{w} means {defn}." if defn else f"{w} is a word in Tovi's language."
    a, b = (good, bad) if ca else (bad, good)
    return (f"{pre}\nTovi wants a {w} object.\n(A) {a}\n(B) {b}\n"
            f"Which one do you hand over? Answer A or B.\nAnswer:")


def f3(w, body, defn=None):
    pre = f"{w} means {defn}." if defn else f"{w} is a word in Tovi's language."
    return f"{pre}\nStatement: {body} is {w}.\nIs this statement true or false? Answer:"


def encode(prompts):
    """左填充 + **显式 position_ids**（否则左填充会把 rotary 位置整体移位）"""
    e = tok(prompts, return_tensors="pt", padding=True).to(dev)
    e["position_ids"] = (e["attention_mask"].cumsum(-1) - 1).clamp(min=0)
    return e


@torch.no_grad()
def last_logits(enc):
    return model(**enc).logits[:, -1]


# ============================================================================
# ★ 正确性闸门：批处理+左填充 必须与逐条前向结果一致（否则后面全部作废）
# ============================================================================
print("=" * 88)
print("正确性闸门：批处理（左填充 + 显式 position_ids） vs 逐条前向")
print("=" * 88)
_p = [f1("komalor", mw.describe(e)) for e in ENTS[:4]] + [f2("komalor", "a red ball", "a blue cup", True)]
_batched = last_logits(encode(_p))
_single = torch.stack([last_logits(encode([p]))[0] for p in _p])
_dev_max = (_batched - _single).abs().max().item()
_agree = sum((_batched[i].argmax() == _single[i].argmax()).item() for i in range(len(_p)))
print(f"  最大 logit 偏差 {_dev_max:.2e} · argmax 一致 {_agree}/{len(_p)}")
if _dev_max > 1e-2 or _agree < len(_p):
    sys.exit("🔴 批处理与逐条不一致 —— 拒绝继续（位置编码/掩码有问题）")
print("  ✅ 一致，可批处理\n")


# ============================================================================
class SlotMemory(nn.Module):
    """product-key 稀疏槽，**向量化**（P5 的逐样本 Python 循环在这里会慢到不可用）。

    余弦路由 + 温度 —— P5 §3.2 的教训：原始点积在相近提示上会塌缩成常量偏置。
    """

    def __init__(self, d, n_slots=32, topk=4, temp=10.0, init=0.01):
        super().__init__()
        self.topk, self.temp = min(topk, n_slots), temp
        self.keys = nn.Parameter(torch.randn(n_slots, d) * init)
        self.values = nn.Parameter(torch.zeros(n_slots, d))   # 零初始化 ⟹ 初始为恒等

    def forward(self, h):                       # h: [..., d]
        sim = F.normalize(h, dim=-1) @ F.normalize(self.keys, dim=-1).T * self.temp
        w, idx = torch.topk(sim, self.topk, dim=-1)
        return (torch.softmax(w, dim=-1).unsqueeze(-1) * self.values[idx]).sum(-2)


def attach(mem, where, last_only=False):
    """where = int（第几个 decoder layer 的输出）或 'post-norm'（= P5–P8 的方案）

    last_only=True ⟹ 只修改最后一个位置的表征（分离"深度"与"位置覆盖"两个因素）。
    """
    def hook(_mod, _inp, out):
        h = out[0] if isinstance(out, tuple) else out
        if last_only:
            h2 = h.clone()
            h2[:, -1] = h[:, -1] + mem(h[:, -1])
        else:
            h2 = h + mem(h)
        return ((h2,) + out[1:]) if isinstance(out, tuple) else h2
    target = model.model.norm if where == "post-norm" else model.model.layers[where]
    return target.register_forward_hook(hook)


# ============================================================================
# 数据
# ============================================================================
cfg = json.load(open(os.path.join(ROOT, "p1", "isolation_p1.json")))[:args.users]
users = []
for pr in cfg:
    M_, other = pr["teacher_A"]["M"], pr["teacher_B"]["M"]
    pos = [e for e in ENTS if e["color"] == M_]
    neg = [e for e in ENTS if e["color"] == other]
    rng.shuffle(pos); rng.shuffle(neg)
    w = pr["word"]
    tr = [f1(w, mw.describe(e)) for e in pos[:6]] + [f1(w, mw.describe(e)) for e in neg[:6]]
    pb_p = [mw.describe(e) for e in pos[6:11]]
    pb_n = [mw.describe(e) for e in neg[6:11]]
    ev = {"F1 Yes/No": ([f1(w, b) for b in pb_p], [f1(w, b) for b in pb_n]),
          "F2 A/B": ([f2(w, g, b, True) for g, b in zip(pb_p, pb_n)],
                     [f2(w, g, b, False) for g, b in zip(pb_p, pb_n)]),
          "F3 True/False": ([f3(w, b) for b in pb_p], [f3(w, b) for b in pb_n])}
    l1 = {"F1 Yes/No": ([f1(w, b, M_) for b in pb_p], [f1(w, b, M_) for b in pb_n]),
          "F2 A/B": ([f2(w, g, b, True, M_) for g, b in zip(pb_p, pb_n)],
                     [f2(w, g, b, False, M_) for g, b in zip(pb_p, pb_n)]),
          "F3 True/False": ([f3(w, b, M_) for b in pb_p], [f3(w, b, M_) for b in pb_n])}
    users.append(dict(uid=pr["id"], word=w, M=M_, other=other,
                      enc_tr=encode(tr),
                      t_tr=torch.tensor([1.0] * 6 + [0.0] * 6, device=dev),
                      enc_ev={k: (encode(a), encode(b)) for k, (a, b) in ev.items()},
                      enc_l1={k: (encode(a), encode(b)) for k, (a, b) in l1.items()}))
NU = len(users)
print(f"用户 {NU} · 训练 12 条（只用 F1）· 每格式探针 5 正 / 5 负（held-out 实体）\n")


def eval_auc(u, fmt, key="enc_ev"):
    P, N_ = FMT[fmt]
    with torch.no_grad():
        def sc(enc):
            lg = model(**enc).logits[:, -1]
            return torch.softmax(torch.stack([lg[:, P], lg[:, N_]], -1), -1)[:, 0].tolist()
        a, b = u[key][fmt]
        return auc(sc(a), sc(b))


RESULTS, PRELOAD = {}, {}
if args.preload and os.path.exists(args.preload):
    PRELOAD = json.load(open(args.preload)).get("results", {})
    print(f"[preload] 并入先前条件：{', '.join(PRELOAD)}\n")


def dump():
    """★ 每跑完一个条件就落盘 —— 中断一次白跑 99 分钟的教训"""
    json.dump({"model": args.model, "n_users": NU, "n_layers": NL, "trained_on": "F1 Yes/No",
               "preloaded_from": args.preload or None,
               "results": {**PRELOAD, **RESULTS}},
              open(os.path.join(HERE, f"p9_{TAG}.json"), "w"), indent=2, ensure_ascii=False)


# ---------- 参照臂 ----------
print("=" * 88)
print("参照臂：base（无定义）· L1（定义进上下文，证明三种格式都可解）")
print("=" * 88)
for u in users:
    for fmt in FMT:
        u[f"base_{fmt}"] = eval_auc(u, fmt)
        u[f"l1_{fmt}"] = eval_auc(u, fmt, "enc_l1")
for arm in ("base", "l1"):
    RESULTS[arm] = {f: st.mean(u[f"{arm}_{f}"] for u in users) for f in FMT}
    print(f"  {arm:5} " + " · ".join(f"{f}: {RESULTS[arm][f]:.3f}" for f in FMT))
    if arm in PRELOAD:                       # ← 与先前条件同数据同 seed 的核验
        d = max(abs(RESULTS[arm][f] - PRELOAD[arm][f]) for f in FMT)
        print(f"        与 preload 的 {arm} 最大差 {d:.4f} "
              + ("✅ 数据一致" if d < 1e-6 else "🔴 数据不一致，preload 不可并用"))
        if d >= 1e-6:
            sys.exit("🔴 参照臂与 preload 不一致 —— 拒绝合并")
dump()

# ---------- 各插入深度 ----------
def parse_where(w):
    """'14' → (14, False, 'L14') · '14@last' → (14, True, 'L14@last') · 'post-norm' → …"""
    if w == "post-norm":
        return ("post-norm", True, "post-norm")     # post-norm 天然只用最后位置的 logits
    last = w.endswith("@last")
    n = int(w[:-5] if last else w)
    return (n, last, f"L{n}@last" if last else f"L{n}")


WHERES = [parse_where(w) for w in args.layers.split(",")]
for where, last_only, label in WHERES:
    print("\n" + "=" * 88)
    print(f"插入位置 {label}" +
          ("   ← 即 P5–P8 的方案（对照）" if where == "post-norm" else
           f"   （其上还有 {NL - where - 1} 层去变换它" +
           ("；★ 只改最后位置 = 分离深度与位置覆盖的控制）" if last_only else "；作用于所有位置）")))
    print("=" * 88)
    t0 = time.time()
    for u in users:
        mem = SlotMemory(D, args.slots, args.topk).to(dev)
        hd = attach(mem, where, last_only)
        opt = torch.optim.Adam(mem.parameters(), lr=args.lr)
        P, N_ = FMT["F1 Yes/No"]
        for _ in range(args.epochs):
            opt.zero_grad()
            lg = model(**u["enc_tr"]).logits[:, -1]
            F.binary_cross_entropy_with_logits(lg[:, P] - lg[:, N_], u["t_tr"]).backward()
            opt.step()
        with torch.no_grad():
            lg = model(**u["enc_tr"]).logits[:, -1]
            tr_acc = (((lg[:, P] - lg[:, N_]) > 0).float() == u["t_tr"]).float().mean().item()
        for fmt in FMT:
            u[f"{label}_{fmt}"] = eval_auc(u, fmt)
        hd.remove()
        print(f"  [{u['uid']}] 训练 acc {tr_acc:.2f} · " +
              " · ".join(f"{f.split()[0]} {u[f'{label}_{f}']:.3f}" for f in FMT), flush=True)
    RESULTS[label] = {f: st.mean(u[f"{label}_{f}"] for u in users) for f in FMT}
    dump()                                   # ← 每条件即时落盘
    print(f"  ({(time.time() - t0) / 60:.1f} min) · 已落盘")


ALL = {**PRELOAD, **RESULTS}


def M(k):
    arm, fmt = k.split("_", 1)
    return ALL[arm][fmt]


print("\n" + "=" * 88)
print(f"P9 插入深度 × 跨读出方向迁移  ·  {TAG}  ·  {NU} 用户  ·  只训 F1")
print("=" * 88)
NAMES = {"post-norm": "post-norm（=P5–P8）"}
print(f"\n{'插入位置':22}{'F1 Yes/No':>12}{'F2 A/B':>11}{'F3 True/False':>15}   跨方向均值")
print("-" * 76)
ORDER = [("base", "base（无定义）"), ("l1", "L1 定义进上下文")] + \
        [(lb, NAMES.get(lb, ("★ " if "@" not in lb else "◇ ") + f"中间层 {lb}/{NL}"))
         for lb in ALL if lb not in ("base", "l1")]
for arm, name in ORDER:
    x = M(f"{arm}_F2 A/B"), M(f"{arm}_F3 True/False")
    print(f"{name:20}{M(f'{arm}_F1 Yes/No'):12.3f}{x[0]:11.3f}{x[1]:15.3f}   {st.mean(x):8.3f}")
print("-" * 76)

LABELS = [lb for lb in ALL if lb not in ("base", "l1")]


def cross(lb):
    return st.mean([M(f"{lb}_F2 A/B"), M(f"{lb}_F3 True/False")])


pn = cross("post-norm") if "post-norm" in LABELS else None
mids = [(lb, cross(lb)) for lb in LABELS if lb != "post-norm"]
base_x = st.mean([M("base_F2 A/B"), M("base_F3 True/False")])
print("\n【裁决：P8 推论「记忆必须介入中间层表征」是否成立】")
if not mids or pn is None:
    print("  ⚪ 需同时跑中间层与 post-norm 才能判")
else:
    best, bv = max(mids, key=lambda x: x[1])
    print(f"  跨方向均值：base {base_x:.3f} · post-norm {pn:.3f} · 最好的中间层 {best} {bv:.3f}")
    if bv > pn + 0.10:
        print(f"  ✅ **推论成立**：中间层比 post-norm 高 {bv - pn:+.3f} —— "
              f"记忆介入表征后，概念能跨读出方向")
    elif bv > pn + 0.03:
        print(f"  ◐ 弱支持：只高 {bv - pn:+.3f}，不足以支撑强主张")
    else:
        print(f"  ❌ **推论被推翻**：中间层并不更好（{bv - pn:+.3f}）—— "
              f"「记忆必须介入中间层表征」这条推论须撤回，跨方向失败另有原因")
    # ★ 深度 vs 位置覆盖：把两个因素分开
    pairs = [(lb, lb + "@last") for lb in LABELS if "@" not in lb and lb + "@last" in LABELS]
    for base_lb, last_lb in pairs:
        allpos, lastpos = cross(base_lb), cross(last_lb)
        print(f"\n【深度 vs 位置覆盖】同为 {base_lb}：作用于所有位置 {allpos:.3f} · "
              f"只作用于最后位置 {lastpos:.3f}")
        if lastpos > pn + 0.10:
            print(f"  ⟹ **深度本身就够**（只改最后位置也比 post-norm 高 {lastpos - pn:+.3f}）；"
                  f"位置覆盖再贡献 {allpos - lastpos:+.3f}")
        else:
            print(f"  ⟹ **深度本身不够**（只改最后位置仅 {lastpos - pn:+.3f}）——"
                  f"增益主要来自**修改物体描述 token 的表征**（位置覆盖），须如实写清")

dump()
print(f"\n[saved] p9_{TAG}.json")
