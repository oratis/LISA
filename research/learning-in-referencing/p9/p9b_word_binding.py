"""P9b — 堵住 P9 主结论的一个大漏洞：中间层记忆到底绑没绑定到【那个词】？

P9 的结论：记忆插在中间层、**作用于所有位置**时，概念能跨读出方向（0.940 vs post-norm 0.663）；
且控制条件表明增益来自**位置覆盖**（只改最后位置仅 0.583），即它改写了**描述物体的 token** 的表征。

★ 但这正好打开一个漏洞：
  既然它能改写物体描述的表征，它完全可能只学会了「**给蓝色物体打个标**」，
  **根本没绑定到 komalor 这个词**。三种格式全过也解释得通——
  只要"被打标的物体"这个信号存在，模型自己会在任何格式下把它读出来。

  若真如此，那就**不是**"学会了一个词的含义"，而是"给一类物体加了个偏置"——
  按对话者隔离仍成立，但**「概念」这个说法必须撤回**。

★ 判据（无需重训，纯换词评测）
  把提示里的伪词换成**另一位用户的伪词**（含义与本用户无关），其余一字不改。
      词绑定  ⟹ 换词后 AUC 应掉到 ≈ 0.5
      物体打标 ⟹ 换词后 AUC 应**基本不变**
  两个插入位置都测（L7 全位置 / post-norm），因为这个漏洞对两者都成立。

⚠️ 本轮**顺便把训练好的记忆存盘**——P9 没存，导致这个控制不得不整个重训（99 分钟）。
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
ap.add_argument("--layers", default="7,post-norm")
ap.add_argument("--seed", type=int, default=0)
args = ap.parse_args()
TAG = args.model.split("/")[-1]
torch.manual_seed(args.seed); random.seed(args.seed)
rng = random.Random(args.seed)

print(f"[load] {args.model}", flush=True)
tok = AutoTokenizer.from_pretrained(args.model, local_files_only=True)
if tok.pad_token is None:
    tok.pad_token = tok.eos_token
tok.padding_side = "left"
dev = "mps" if torch.backends.mps.is_available() else "cpu"
model = AutoModelForCausalLM.from_pretrained(args.model, dtype=torch.float32,
                                             local_files_only=True).to(dev).eval()
for p in model.parameters():
    p.requires_grad_(False)
D = model.config.hidden_size
NL = len(model.model.layers)
ENTS = list(mw.entities())
print(f"[load] done · {dev} · {NL} 层\n", flush=True)


def tid(t):
    return tok.encode(t, add_special_tokens=False)[0]


FMT = {"F1 Yes/No": (tid(" Yes"), tid(" No")),
       "F2 A/B": (tid(" A"), tid(" B")),
       "F3 True/False": (tid(" True"), tid(" False"))}


def f1(w, body):
    return (f"{w} is a word in Tovi's language.\n"
            f"Question: Is {body} {w}? Answer Yes or No.\nAnswer:")


def f2(w, good, bad, ca):
    a, b = (good, bad) if ca else (bad, good)
    return (f"{w} is a word in Tovi's language.\nTovi wants a {w} object.\n(A) {a}\n(B) {b}\n"
            f"Which one do you hand over? Answer A or B.\nAnswer:")


def f3(w, body):
    return (f"{w} is a word in Tovi's language.\n"
            f"Statement: {body} is {w}.\nIs this statement true or false? Answer:")


def encode(prompts):
    e = tok(prompts, return_tensors="pt", padding=True).to(dev)
    e["position_ids"] = (e["attention_mask"].cumsum(-1) - 1).clamp(min=0)
    return e


class SlotMemory(nn.Module):
    def __init__(self, d, n_slots=32, topk=4, temp=10.0, init=0.01):
        super().__init__()
        self.topk, self.temp = min(topk, n_slots), temp
        self.keys = nn.Parameter(torch.randn(n_slots, d) * init)
        self.values = nn.Parameter(torch.zeros(n_slots, d))

    def forward(self, h):
        sim = F.normalize(h, dim=-1) @ F.normalize(self.keys, dim=-1).T * self.temp
        w, idx = torch.topk(sim, self.topk, dim=-1)
        return (torch.softmax(w, dim=-1).unsqueeze(-1) * self.values[idx]).sum(-2)


def attach(mem, where):
    def hook(_m, _i, out):
        h = out[0] if isinstance(out, tuple) else out
        h2 = h + mem(h)
        return ((h2,) + out[1:]) if isinstance(out, tuple) else h2
    target = model.model.norm if where == "post-norm" else model.model.layers[where]
    return target.register_forward_hook(hook)


# ---------- 数据（与 P9 同构造、同 seed）----------
cfg = json.load(open(os.path.join(ROOT, "p1", "isolation_p1.json")))[:args.users]
users = []
for pr in cfg:
    M_, other = pr["teacher_A"]["M"], pr["teacher_B"]["M"]
    pos = [e for e in ENTS if e["color"] == M_]
    neg = [e for e in ENTS if e["color"] == other]
    rng.shuffle(pos); rng.shuffle(neg)
    users.append(dict(uid=pr["id"], word=pr["word"], M=M_, other=other,
                      tr_pos=[mw.describe(e) for e in pos[:6]],
                      tr_neg=[mw.describe(e) for e in neg[:6]],
                      pb_pos=[mw.describe(e) for e in pos[6:11]],
                      pb_neg=[mw.describe(e) for e in neg[6:11]]))
NU = len(users)
# ★ 换词控制：每人换成**下一位**用户的伪词（含义与本人无关）
for i, u in enumerate(users):
    u["swap_word"] = users[(i + 1) % NU]["word"]
print("换词映射：" + " · ".join(f"{u['word']}→{u['swap_word']}" for u in users[:3]) + " …\n")


def probes(u, w):
    return {"F1 Yes/No": (encode([f1(w, b) for b in u["pb_pos"]]),
                          encode([f1(w, b) for b in u["pb_neg"]])),
            "F2 A/B": (encode([f2(w, g, b, True) for g, b in zip(u["pb_pos"], u["pb_neg"])]),
                       encode([f2(w, g, b, False) for g, b in zip(u["pb_pos"], u["pb_neg"])])),
            "F3 True/False": (encode([f3(w, b) for b in u["pb_pos"]]),
                              encode([f3(w, b) for b in u["pb_neg"]]))}


for u in users:
    u["enc_tr"] = encode([f1(u["word"], b) for b in u["tr_pos"] + u["tr_neg"]])
    u["t_tr"] = torch.tensor([1.0] * 6 + [0.0] * 6, device=dev)
    u["pr_own"] = probes(u, u["word"])
    u["pr_swap"] = probes(u, u["swap_word"])       # ← 唯一的差别就是那个词


def ev(u, key, fmt):
    P, N_ = FMT[fmt]
    a, b = u[key][fmt]
    with torch.no_grad():
        def sc(enc):
            lg = model(**enc).logits[:, -1]
            return torch.softmax(torch.stack([lg[:, P], lg[:, N_]], -1), -1)[:, 0].tolist()
        return auc(sc(a), sc(b))


RES = {}
CKPT = os.path.join(HERE, "memories")
os.makedirs(CKPT, exist_ok=True)
for wspec in args.layers.split(","):
    where = wspec if wspec == "post-norm" else int(wspec)
    label = wspec if wspec == "post-norm" else f"L{wspec}"
    print("=" * 88); print(f"插入位置 {label}"); print("=" * 88)
    t0 = time.time()
    for u in users:
        mem = SlotMemory(D, args.slots, args.topk).to(dev)
        hd = attach(mem, where)
        opt = torch.optim.Adam(mem.parameters(), lr=args.lr)
        P, N_ = FMT["F1 Yes/No"]
        for _ in range(args.epochs):
            opt.zero_grad()
            lg = model(**u["enc_tr"]).logits[:, -1]
            F.binary_cross_entropy_with_logits(lg[:, P] - lg[:, N_], u["t_tr"]).backward()
            opt.step()
        for key in ("pr_own", "pr_swap"):
            for fmt in FMT:
                u[f"{label}_{key}_{fmt}"] = ev(u, key, fmt)
        hd.remove()
        torch.save(mem.state_dict(), os.path.join(CKPT, f"{label}_{u['uid']}.pt"))  # ★ 存盘
        print(f"  [{u['uid']}] 本词 " +
              "/".join(f"{u[f'{label}_pr_own_{f}']:.3f}" for f in FMT) + "   ·  ★换词 " +
              "/".join(f"{u[f'{label}_pr_swap_{f}']:.3f}" for f in FMT), flush=True)
    RES[label] = {k: {f: st.mean(u[f"{label}_{k}_{f}"] for u in users) for f in FMT}
                  for k in ("pr_own", "pr_swap")}
    json.dump({"model": args.model, "n_users": NU, "results": RES},
              open(os.path.join(HERE, f"p9b_{TAG}.json"), "w"), indent=2, ensure_ascii=False)
    print(f"  ({(time.time() - t0) / 60:.1f} min) · 已落盘")

print("\n" + "=" * 88)
print(f"P9b 词绑定控制  ·  {TAG}  ·  {NU} 用户  ·  只改提示里的那一个词")
print("=" * 88)
print(f"\n{'插入位置':16}{'':10}" + "".join(f"{f:>16}" for f in FMT))
print("-" * 74)
for label, d in RES.items():
    for k, nm in (("pr_own", "本词"), ("pr_swap", "★ 换成别人的词")):
        print(f"{label if k == 'pr_own' else '':16}{nm:10}" +
              "".join(f"{d[k][f]:16.3f}" for f in FMT))
    drop = st.mean([d["pr_own"][f] - d["pr_swap"][f] for f in FMT])
    print(f"{'':16}{'落差':10}" +
          "".join(f"{d['pr_own'][f] - d['pr_swap'][f]:16.3f}" for f in FMT) + f"   均值 {drop:.3f}")
    print("-" * 74)

print("\n【裁决：中间层记忆是【绑定到词】还是【给物体打标】】")
for label, d in RES.items():
    sw = st.mean(d["pr_swap"].values())
    ow = st.mean(d["pr_own"].values())
    if sw < 0.60:
        v = f"✅ **绑定到词**：换词后掉到 {sw:.3f} ≈ 随机（本词 {ow:.3f}）"
    elif sw > ow - 0.10:
        v = (f"🔴 **不是词，是给物体打标**：换词后仍有 {sw:.3f}（本词 {ow:.3f}）"
             f" ⟹ 「学到了一个概念」必须撤回，只能说「给一类物体加了偏置」")
    else:
        v = f"◐ 部分绑定：换词 {sw:.3f} vs 本词 {ow:.3f}"
    print(f"  {label:12} {v}")
print(f"\n[saved] p9b_{TAG}.json · 记忆权重存于 {os.path.relpath(CKPT, ROOT)}/")
