"""P10 — 逼出词绑定：**两个词在同一物体上给出相反标签**

P9b/P9c 证伪了参数化记忆的词绑定（换词落差 0.017–0.018；两词设置 own−within = −0.005）。
P9c 的两词设置**方向对但强度不够**：w1 问颜色、w2 问材质，一个"红或木"的**分级标**
就能同时糊弄过去——物体级信号仍然够用。

★ 本实验把这个后门焊死：
  w1 = 颜色 A、w2 = 颜色 B，且**训练物体只取 A/B 两色**。
  于是**每一个训练物体在两个词下的标签严格相反**：
      蓝球：  Is 蓝球 w1? → Yes      Is 蓝球 w2? → No
      红球：  Is 红球 w1? → No       Is 红球 w2? → Yes
  ⟹ 任何**只看物体、不看词**的策略，训练准确率在数学上**恰好 0.5**（每个物体两个相反标签）。

  ⟹ **训练准确率本身就是判据**：
      收敛到 ~1.0  ⟹ 记忆**确实条件化于词**了 —— 那 P9c 的失败就是**设置太弱**，不是架构不能
      卡在 ~0.5    ⟹ 架构**无法**以整段末位隐状态为键去条件化于词 —— 这是硬限制，
                     直接支持"键应取在**词的 token 位置**"这条修法

★ 三项评测（只在训练收敛时才有意义）
  ① w1 探针（held-out 物体）AUC
  ② ★ 换词：把 w1 探针里的词换成 w2 —— **真绑定则应崩到 ≈0 或 ≤0.5**（因为含义相反）
  ③ 跨读出方向 F2/F3（训练只用 F1）—— **在真的绑定下，P9 的迁移结论还成不成立？**

两个插入位置都跑：post-norm（= P5–P8）与 L7 全位置（= P9 最好的那个）。
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
ap.add_argument("--epochs", type=int, default=900,
                help="比 P5–P9 的 300 更长——本任务更难，须先排除【优化不够】才能说【架构不能】")
ap.add_argument("--lr", type=float, default=5e-2)
ap.add_argument("--layers", default="post-norm,7")
ap.add_argument("--seed", type=int, default=0)
ap.add_argument("--merge", action="store_true",
                help="把新条件并入已存在的 p10_*.json（而不是覆盖）")
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
ENTS = list(mw.entities())
print(f"[load] done · {dev}\n", flush=True)


def tid(t):
    return tok.encode(t, add_special_tokens=False)[0]


FMT = {"F1 Yes/No": (tid(" Yes"), tid(" No")),
       "F2 A/B": (tid(" A"), tid(" B")),
       "F3 True/False": (tid(" True"), tid(" False"))}


def pre_of(u):
    return f"{u['w1']} and {u['w2']} are words in Tovi's language."


def f1(w, body, pre):
    return f"{pre}\nQuestion: Is {body} {w}? Answer Yes or No.\nAnswer:"


def f2(w, good, bad, ca, pre):
    a, b = (good, bad) if ca else (bad, good)
    return (f"{pre}\nTovi wants a {w} object.\n(A) {a}\n(B) {b}\n"
            f"Which one do you hand over? Answer A or B.\nAnswer:")


def f3(w, body, pre):
    return f"{pre}\nStatement: {body} is {w}.\nIs this statement true or false? Answer:"


def enc(ps):
    e = tok(ps, return_tensors="pt", padding=True).to(dev)
    e["position_ids"] = (e["attention_mask"].cumsum(-1) - 1).clamp(min=0)
    return e


class SlotMemory(nn.Module):
    def __init__(self, d, n=32, k=4, temp=10.0, init=0.01):
        super().__init__()
        self.topk, self.temp = min(k, n), temp
        self.keys = nn.Parameter(torch.randn(n, d) * init)
        self.values = nn.Parameter(torch.zeros(n, d))

    def forward(self, h):
        sim = F.normalize(h, dim=-1) @ F.normalize(self.keys, dim=-1).T * self.temp
        w, idx = torch.topk(sim, self.topk, dim=-1)
        return (torch.softmax(w, dim=-1).unsqueeze(-1) * self.values[idx]).sum(-2)


def attach(mem, where):
    def hook(_m, _i, out):
        h = out[0] if isinstance(out, tuple) else out
        h2 = h + mem(h)
        return ((h2,) + out[1:]) if isinstance(out, tuple) else h2
    t = model.model.norm if where == "post-norm" else model.model.layers[where]
    return t.register_forward_hook(hook)


# ---------- 用户 ----------
cfg = json.load(open(os.path.join(ROOT, "p1", "isolation_p1.json")))[:args.users]
words = [c["word"] for c in cfg]
users = []
for i, c in enumerate(cfg):
    A, B = c["teacher_A"]["M"], c["teacher_B"]["M"]      # 两种互斥颜色
    w1, w2 = c["word"], words[(i + 1) % len(words)]      # 两个伪词
    oa = [mw.describe(e) for e in ENTS if e["color"] == A]
    ob = [mw.describe(e) for e in ENTS if e["color"] == B]
    rng.shuffle(oa); rng.shuffle(ob)
    users.append(dict(uid=c["id"], w1=w1, w2=w2, cA=A, cB=B,
                      tr_a=oa[:6], tr_b=ob[:6], pb_a=oa[6:11], pb_b=ob[6:11],
                      other=words[(i + 3) % len(words)]))
NU = len(users)
print(f"每人两个词，含义**互斥**且训练物体只取这两色，例：")
for u in users[:3]:
    print(f"  {u['uid']}: {u['w1']}={u['cA']} · {u['w2']}={u['cB']}   ⟹ 同一物体两词标签相反")
print()

for u in users:
    p = pre_of(u)
    # ★ 同一批 12 个物体，在 w1 与 w2 下标签严格相反
    objs = u["tr_a"] + u["tr_b"]
    lab_w1 = [1.0] * 6 + [0.0] * 6
    lab_w2 = [0.0] * 6 + [1.0] * 6
    u["enc_tr"] = enc([f1(u["w1"], b, p) for b in objs] + [f1(u["w2"], b, p) for b in objs])
    u["t_tr"] = torch.tensor(lab_w1 + lab_w2, device=dev)
    u["probe"] = {}
    for cond, w in (("own", u["w1"]), ("within", u["w2"]), ("across", u["other"])):
        u["probe"][cond] = {
            "F1 Yes/No": (enc([f1(w, b, p) for b in u["pb_a"]]), enc([f1(w, b, p) for b in u["pb_b"]])),
            "F2 A/B": (enc([f2(w, g, b, True, p) for g, b in zip(u["pb_a"], u["pb_b"])]),
                       enc([f2(w, g, b, False, p) for g, b in zip(u["pb_a"], u["pb_b"])])),
            "F3 True/False": (enc([f3(w, b, p) for b in u["pb_a"]]), enc([f3(w, b, p) for b in u["pb_b"]]))}


def sc(e, fmt):
    P, N_ = FMT[fmt]
    with torch.no_grad():
        lg = model(**e, logits_to_keep=1).logits[:, -1]
        return torch.softmax(torch.stack([lg[:, P], lg[:, N_]], -1), -1)[:, 0].tolist()


OUT = os.path.join(HERE, f"p10_{TAG}.json")
RES = {}
if args.merge and os.path.exists(OUT):
    RES = json.load(open(OUT)).get("results", {})
    print(f"[merge] 并入已有条件：{', '.join(RES)}\n")


def dump(partial=None):
    """★ 每个**用户**跑完就落盘 —— P9 丢过 99 分钟、P10 又整条臂丢掉，第三次了"""
    json.dump({"model": args.model, "n_users": NU,
               "design": "两个词含义互斥 + 训练物体只取这两色 ⟹ 同一物体两词标签相反",
               "object_only_ceiling_train_acc": 0.5,
               "results": RES, **({"in_progress": partial} if partial else {})},
              open(OUT, "w"), indent=2, ensure_ascii=False)


for wspec in args.layers.split(","):
    where = wspec if wspec == "post-norm" else int(wspec)
    label = wspec if wspec == "post-norm" else f"L{wspec}"
    print("=" * 92)
    print(f"插入位置 {label}   ——  ★ 只看物体的策略在此训练集上**必然只有 0.500**")
    print("=" * 92)
    t0 = time.time()
    for u in users:
        mem = SlotMemory(D, args.slots, args.topk).to(dev)
        hd = attach(mem, where)
        opt = torch.optim.Adam(mem.parameters(), lr=args.lr)
        P, N_ = FMT["F1 Yes/No"]
        # ★ 记训练曲线：卡住 vs 还在爬，是"架构不能"与"优化不够"的分界
        ckpts = sorted({args.epochs // 6, args.epochs // 3, args.epochs * 2 // 3, args.epochs})
        curve = []
        for ep in range(1, args.epochs + 1):
            opt.zero_grad()
            lg = model(**u["enc_tr"], logits_to_keep=1).logits[:, -1]
            loss = F.binary_cross_entropy_with_logits(lg[:, P] - lg[:, N_], u["t_tr"])
            loss.backward(); opt.step()
            if ep in ckpts:
                with torch.no_grad():
                    a = ((((lg[:, P] - lg[:, N_]) > 0).float()) == u["t_tr"]).float().mean().item()
                curve.append((ep, round(a, 3), round(loss.item(), 4)))
        u[f"{label}_curve"] = curve
        with torch.no_grad():
            lg = model(**u["enc_tr"], logits_to_keep=1).logits[:, -1]
            u[f"{label}_tracc"] = ((((lg[:, P] - lg[:, N_]) > 0).float()) == u["t_tr"]).float().mean().item()
        for cond in ("own", "within", "across"):
            for fmt in FMT:
                a, b = u["probe"][cond][fmt]
                u[f"{label}_{cond}_{fmt}"] = auc(sc(a, fmt), sc(b, fmt))
        hd.remove()
        print(f"    曲线 " + " → ".join(f"ep{e}:acc {a:.2f}/loss {l:.3f}" for e, a, l in u[f"{label}_curve"]))
        print(f"  [{u['uid']}] ★训练 acc {u[f'{label}_tracc']:.3f}  ·  w1 探针 "
              f"{u[f'{label}_own_F1 Yes/No']:.3f} · 换成 w2 {u[f'{label}_within_F1 Yes/No']:.3f}"
              f" · 换成别人 {u[f'{label}_across_F1 Yes/No']:.3f}", flush=True)
        dump({label: [{"uid": x["uid"], "train_acc": x[f"{label}_tracc"],
                       **{f"{c}_{f}": x[f"{label}_{c}_{f}"] for c in ("own", "within", "across")
                          for f in FMT}}
                      for x in users if f"{label}_tracc" in x]})
    RES[label] = {"train_acc": st.mean(u[f"{label}_tracc"] for u in users),
                  "train_curve_mean": [[c[0], round(st.mean(u[f"{label}_curve"][i][1] for u in users), 3),
                                        round(st.mean(u[f"{label}_curve"][i][2] for u in users), 4)]
                                       for i, c in enumerate(users[0][f"{label}_curve"])],
                  **{c: {f: st.mean(u[f"{label}_{c}_{f}"] for u in users) for f in FMT}
                     for c in ("own", "within", "across")}}
    dump()
    print(f"  ({(time.time() - t0) / 60:.1f} min) · 条件完成，已落盘")

print("\n" + "=" * 92)
print(f"P10 强制词绑定  ·  {TAG}  ·  {NU} 用户  ·  训练只用 F1，F2/F3 始终 held-out")
print("=" * 92)
for label, d in RES.items():
    print(f"\n{label}   ★ 训练 acc {d['train_acc']:.3f}   （只看物体的策略上限 = 0.500）")
    print(f"  {'提示里用的词':22}" + "".join(f"{f:>16}" for f in FMT))
    print("  " + "-" * 70)
    for c, nm in (("own", "w1（本词）"), ("within", "★ 换成 w2（含义相反）"), ("across", "换成别人的词")):
        print(f"  {nm:20}" + "".join(f"{d[c][f]:16.3f}" for f in FMT))

print("\n【裁决 1：架构能否条件化于词】")
for label, d in RES.items():
    ta = d["train_acc"]
    cur = d["train_curve_mean"]
    print(f"  {label:12} 训练曲线 " + " → ".join(f"ep{e}:{a:.2f}" for e, a, _ in cur))
    if ta > 0.85:
        v = (f"✅ **能**：训练 acc {ta:.3f} ≫ 只看物体的 0.500 ⟹ "
             f"P9c 的失败是**设置太弱**（两词问不同属性），不是架构不能")
    elif ta < 0.65 and cur[-1][1] - cur[-2][1] > 0.03:
        v = (f"⚪ **不可判**：训练 acc {ta:.3f} 低，但曲线**还在爬**"
             f"（{cur[-2][1]:.2f} → {cur[-1][1]:.2f}）—— 是优化不够，须加长再判")
    elif ta < 0.65:
        v = (f"🔴 **不能**：训练 acc {ta:.3f} ≈ 0.500 —— 以**整段末位隐状态**为键，"
             f"架构**无法**条件化于词。⟹ 直接支持「键取在词的 token 位置」这条修法")
    else:
        v = f"◐ 部分：训练 acc {ta:.3f}"
    print(f"  {label:12} {v}")

print("\n【裁决 2：绑定成立时，换词是否真的翻转】")
for label, d in RES.items():
    ow, wi = d["own"]["F1 Yes/No"], d["within"]["F1 Yes/No"]
    if d["train_acc"] < 0.65:
        print(f"  {label:12} ⚪ 训练未收敛，本项不可判")
    elif wi < 0.35:
        print(f"  {label:12} ✅ **真绑定**：换成含义相反的 w2 后 AUC {wi:.3f}（本词 {ow:.3f}）—— 答案跟着词翻转")
    elif wi < ow - 0.25:
        print(f"  {label:12} ◐ 部分绑定：{ow:.3f} → {wi:.3f}")
    else:
        print(f"  {label:12} 🔴 仍未绑定：{ow:.3f} → {wi:.3f}")

print("\n【裁决 3：真绑定下，P9 的跨读出方向迁移还在不在】")
for label, d in RES.items():
    x = st.mean([d["own"]["F2 A/B"], d["own"]["F3 True/False"]])
    print(f"  {label:12} 跨方向均值 {x:.3f}"
          f"（F2 {d['own']['F2 A/B']:.3f} · F3 {d['own']['F3 True/False']:.3f}）"
          + ("   ← 对照 P9 的 L7 0.940 / post-norm 0.663" if label in ("L7", "post-norm") else ""))
dump()
print(f"\n[saved] p10_{TAG}.json")
