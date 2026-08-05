"""P11c — 加身份保持项：**身份与含义是不是直接冲突？**

P11 的处境：词条**绑定拿到了**（换词 0.080），但
  · 跨格式没拿到（F3 0.775 < 及格线 0.85）
  · **复述控制未过**（L7 0.50 / emb 0.00）⟹ 按预注册规则，主结果"不可解读"

诊断已排除范数：L7 上 ‖v‖ 只用了隐状态的 **2%**，复述仍崩。
⟹ 问题在**目标函数**：梯度只优化决策，**没有任何一项在保护 token 的身份**。

★ 本实验加一项，并**跑前写死预期**（设计文档 §6 第 5 条）：

    L = BCE(决策)  +  λ · L_id
    L_id = −log P(w 的 token | "Repeat exactly: {w}\\nAnswer:")   ← 注入生效下

  **本实验不是为了过 0.85 那条线**（加正则不会把 F3 抬上去），而是回答：

    · 复述恢复 ✅ 且 F3 仍 ~0.775  ⟹ 原结果从「不可解读」变成**可解读的负面结果**
    · 复述恢复但 F3 塌掉          ⟹ **身份与含义直接冲突**——比原结果更强：
                                    「词条只能靠覆盖身份来携带含义」
    · 复述恢复不了                ⟹ 正则太弱或位置不对，须报为**不可判**

⚠️ λ 扫 {0, 0.5, 2.0}；λ=0 应复现 P11 的 L7（F1 0.835 / F3 0.775 / 复述 0.50），
   **对不上就说明本脚本与 P11 不同源，结果作废**。
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
ap.add_argument("--epochs", type=int, default=300)
ap.add_argument("--lr", type=float, default=5e-2)
ap.add_argument("--layer", type=int, default=7)
ap.add_argument("--lams", default="0,0.5,2.0")
ap.add_argument("--vmax", type=float, default=1.0)
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
ENTS = list(mw.entities())
print(f"[load] done · {dev} · 注入层 L{args.layer}\n", flush=True)

tid = lambda t: tok.encode(t, add_special_tokens=False)[0]           # noqa: E731
FMT = {"F1 Yes/No": (tid(" Yes"), tid(" No")),
       "F2 A/B": (tid(" A"), tid(" B")),
       "F3 True/False": (tid(" True"), tid(" False"))}

pre_of = lambda u: f"{u['w1']} and {u['w2']} are words in Tovi's language."   # noqa: E731
def f1(w, b, pre): return f"{pre}\nQuestion: Is {b} {w}? Answer Yes or No.\nAnswer:"
def f2(w, g, b, ca, pre):
    x, y = (g, b) if ca else (b, g)
    return (f"{pre}\nTovi wants a {w} object.\n(A) {x}\n(B) {y}\n"
            f"Which one do you hand over? Answer A or B.\nAnswer:")
def f3(w, b, pre): return f"{pre}\nStatement: {b} is {w}.\nIs this statement true or false? Answer:"
ECHO = lambda w: f"Repeat exactly: {w}\nAnswer:"                     # noqa: E731


def wseqs(w):
    s = []
    for t in (w, " " + w):
        i = tok.encode(t, add_special_tokens=False)
        if i and i not in s:
            s.append(i)
    return s


def wmask(ids, w):
    m = torch.zeros(ids.shape, dtype=torch.float32, device=ids.device)
    for b, r in enumerate(ids.tolist()):
        for s in wseqs(w):
            n = len(s)
            for i in range(len(r) - n + 1):
                if r[i:i + n] == s:
                    m[b, i:i + n] = 1.0
    return m


def enc(ps):
    e = tok(ps, return_tensors="pt", padding=True).to(dev)
    e["position_ids"] = (e["attention_mask"].cumsum(-1) - 1).clamp(min=0)
    return e


V = [nn.Parameter(torch.zeros(D, device=dev)), nn.Parameter(torch.zeros(D, device=dev))]
hold = {"masks": None}


def hook(_m, _i, out):
    h = out[0] if isinstance(out, tuple) else out
    ms = hold["masks"]
    if not ms or ms[0].shape[:2] != h.shape[:2]:
        return out
    h2 = h + sum(m.unsqueeze(-1) * v for m, v in zip(ms, V))
    return ((h2,) + out[1:]) if isinstance(out, tuple) else h2


model.model.layers[args.layer].register_forward_hook(hook)

cfg = json.load(open(os.path.join(ROOT, "p1", "isolation_p1.json")))[:args.users]
words = [c["word"] for c in cfg]
users = []
for i, c in enumerate(cfg):
    A, B = c["teacher_A"]["M"], c["teacher_B"]["M"]
    oa = [mw.describe(e) for e in ENTS if e["color"] == A]
    ob = [mw.describe(e) for e in ENTS if e["color"] == B]
    rng.shuffle(oa); rng.shuffle(ob)
    users.append(dict(uid=c["id"], w1=c["word"], w2=words[(i + 1) % len(words)], cA=A, cB=B,
                      tr_a=oa[:6], tr_b=ob[:6], pb_a=oa[6:11], pb_b=ob[6:11],
                      other=words[(i + 3) % len(words)]))
NU = len(users)


def masks_for(e, u):
    return [wmask(e["input_ids"], u["w1"]), wmask(e["input_ids"], u["w2"])]


def id_loss_batch(u):
    """teacher-forced：−log P(w 的 token | 复述提示)，两个词各一条"""
    seqs, starts = [], []
    for w in (u["w1"], u["w2"]):
        p_ids = tok(ECHO(w), return_tensors="pt")["input_ids"][0]
        w_ids = torch.tensor(tok.encode(" " + w, add_special_tokens=False))
        seqs.append(torch.cat([p_ids, w_ids]))
        starts.append((len(p_ids), len(w_ids)))
    T = max(len(s) for s in seqs)
    ids = torch.full((len(seqs), T), tok.pad_token_id, dtype=torch.long)
    att = torch.zeros((len(seqs), T), dtype=torch.long)
    for i, s in enumerate(seqs):                       # 左填充，与全局一致
        ids[i, T - len(s):] = s; att[i, T - len(s):] = 1
    ids, att = ids.to(dev), att.to(dev)
    e = {"input_ids": ids, "attention_mask": att,
         "position_ids": (att.cumsum(-1) - 1).clamp(min=0)}
    tgt = torch.full((len(seqs), T), -100, dtype=torch.long, device=dev)
    for i, (np_, nw) in enumerate(starts):
        off = T - len(seqs[i])
        tgt[i, off + np_: off + np_ + nw] = ids[i, off + np_: off + np_ + nw]
    return e, tgt


@torch.no_grad()
def echo_ok(u, w, greedy=8):
    ids = tok(ECHO(w), return_tensors="pt")["input_ids"].to(dev)
    n0 = ids.shape[1]
    for _ in range(greedy):
        hold["masks"] = [wmask(ids, u["w1"]), wmask(ids, u["w2"])]
        lg = model(input_ids=ids, attention_mask=torch.ones_like(ids),
                   position_ids=(torch.ones_like(ids).cumsum(-1) - 1)).logits[:, -1]
        ids = torch.cat([ids, lg.argmax(-1, keepdim=True)], -1)
    g = tok.decode(ids[0, n0:], skip_special_tokens=True)
    return float(w.lower() in g.lower().replace(" ", ""))


def probe_auc(u, w, fmt):
    P, N_ = FMT[fmt]
    mk = {"F1 Yes/No": lambda ws: ([f1(w, b, pre_of(u)) for b in u["pb_a"]],
                                   [f1(w, b, pre_of(u)) for b in u["pb_b"]]),
          "F2 A/B": lambda ws: ([f2(w, g, b, True, pre_of(u)) for g, b in zip(u["pb_a"], u["pb_b"])],
                                [f2(w, g, b, False, pre_of(u)) for g, b in zip(u["pb_a"], u["pb_b"])]),
          "F3 True/False": lambda ws: ([f3(w, b, pre_of(u)) for b in u["pb_a"]],
                                       [f3(w, b, pre_of(u)) for b in u["pb_b"]])}[fmt](None)

    def sc(ps):
        e = enc(ps); hold["masks"] = masks_for(e, u)
        with torch.no_grad():
            lg = model(**e, logits_to_keep=1).logits[:, -1]
            return torch.softmax(torch.stack([lg[:, P], lg[:, N_]], -1), -1)[:, 0].tolist()
    return auc(sc(mk[0]), sc(mk[1]))


RES = {}
OUT = os.path.join(HERE, f"p11c_{TAG}.json")
for lam in [float(x) for x in args.lams.split(",")]:
    print("=" * 92); print(f"λ = {lam}   （λ=0 应复现 P11 的 L7：F1 0.835 / F3 0.775 / 复述 0.50）")
    print("=" * 92)
    t0 = time.time()
    for u in users:
        for v in V:
            v.data.zero_()
        p = pre_of(u); objs = u["tr_a"] + u["tr_b"]
        tr = [f1(u["w1"], b, p) for b in objs] + [f1(u["w2"], b, p) for b in objs]
        y = torch.tensor([1.] * 6 + [0.] * 6 + [0.] * 6 + [1.] * 6, device=dev)
        e_tr = enc(tr); m_tr = masks_for(e_tr, u)
        e_id, t_id = id_loss_batch(u)
        m_id = masks_for(e_id, u)
        with torch.no_grad():                       # 范数上限在**注入层**上量
            probe = {}
            hd = model.model.layers[args.layer].register_forward_hook(
                lambda _m, _i, o, _p=probe: _p.__setitem__("h", (o[0] if isinstance(o, tuple) else o).detach()))
            hold["masks"] = m_tr; model(**e_tr, logits_to_keep=1); hd.remove()
            sel = (m_tr[0] + m_tr[1]) > 0
            cap = args.vmax * probe["h"][sel].norm(dim=-1).mean().item()
        opt = torch.optim.Adam(V, lr=args.lr)
        P, N_ = FMT["F1 Yes/No"]
        for _ in range(args.epochs):
            opt.zero_grad()
            hold["masks"] = m_tr
            lg = model(**e_tr, logits_to_keep=1).logits[:, -1]
            loss = F.binary_cross_entropy_with_logits(lg[:, P] - lg[:, N_], y)
            if lam > 0:
                hold["masks"] = m_id
                out = model(**e_id).logits[:, :-1]
                loss = loss + lam * F.cross_entropy(
                    out.reshape(-1, out.shape[-1]), t_id[:, 1:].reshape(-1), ignore_index=-100)
            loss.backward(); opt.step()
            with torch.no_grad():
                for v in V:
                    n = v.norm()
                    if n > cap:
                        v.mul_(cap / n)
        hold["masks"] = m_tr
        with torch.no_grad():
            lg = model(**e_tr, logits_to_keep=1).logits[:, -1]
            u["tracc"] = ((((lg[:, P] - lg[:, N_]) > 0).float()) == y).float().mean().item()
        for f in FMT:
            u[f"own_{f}"] = probe_auc(u, u["w1"], f)
        u["within_F1"] = probe_auc(u, u["w2"], "F1 Yes/No")
        u["echo"] = st.mean(echo_ok(u, w) for w in (u["w1"], u["w2"]))
        u["vn"] = st.mean(v.norm().item() for v in V) / (cap / args.vmax)
        print(f"  [{u['uid']}] acc {u['tracc']:.2f} ‖v‖/‖h‖ {u['vn']:.3f} 复述 {u['echo']:.2f} · "
              f"own {u['own_F1 Yes/No']:.3f}/{u['own_F2 A/B']:.3f}/{u['own_F3 True/False']:.3f} · "
              f"换词 {u['within_F1']:.3f}", flush=True)
    RES[str(lam)] = {"train_acc": st.mean(u["tracc"] for u in users),
                     "echo": st.mean(u["echo"] for u in users),
                     "v_over_h": st.mean(u["vn"] for u in users),
                     "within_F1": st.mean(u["within_F1"] for u in users),
                     **{f: st.mean(u[f"own_{f}"] for u in users) for f in FMT}}
    json.dump({"model": args.model, "n_users": NU, "layer": args.layer, "results": RES},
              open(OUT, "w"), indent=2, ensure_ascii=False)
    print(f"  ({(time.time() - t0) / 60:.1f} min) · 已落盘")

print("\n" + "=" * 92)
print(f"P11c 身份保持项  ·  {TAG}  ·  L{args.layer}  ·  {NU} 用户")
print("=" * 92)
print(f"\n{'λ':>6}{'训练acc':>9}{'★复述':>8}{'‖v‖/‖h‖':>10}"
      + "".join(f"{f:>15}" for f in FMT) + f"{'换词F1':>9}")
print("-" * 88)
for k, d in RES.items():
    print(f"{k:>6}{d['train_acc']:9.3f}{d['echo']:8.2f}{d['v_over_h']:10.3f}"
          + "".join(f"{d[f]:15.3f}" for f in FMT) + f"{d['within_F1']:9.3f}")

# ⚠️ 同源闸门只在**全量配置**下有意义（P11 的基准是 8 用户 / 300 步）
FULL = (args.users == 8 and args.epochs == 300 and args.layer == 7)
print("\n【同源核验】λ=0 应复现 P11 的 L7（F1 0.835 / F3 0.775 / 复述 0.50）"
      + ("" if FULL else "  —— ⚠️ 当前非全量配置，本闸门不适用，跳过"))
if "0.0" in RES and FULL:
    d = RES["0.0"]
    ok = abs(d["F1 Yes/No"] - 0.835) < 0.08 and abs(d["F3 True/False"] - 0.775) < 0.08
    print(f"  实测 F1 {d['F1 Yes/No']:.3f} · F3 {d['F3 True/False']:.3f} · 复述 {d['echo']:.2f} —— "
          + ("✅ 同源" if ok else "🔴 **与 P11 对不上 ⟹ 本脚本结果作废**"))

print("\n【裁决 —— 预期已在设计文档 §6 第 5 条跑前写死】")
best = max((k for k in RES if float(k) > 0), key=lambda k: RES[k]["echo"], default=None)
if best is None:
    print("  ⚪ 未跑 λ>0")
else:
    d0, db = RES.get("0.0"), RES[best]
    print(f"  最好的 λ={best}：复述 {db['echo']:.2f}（λ=0 时 {d0['echo']:.2f}）· "
          f"F3 {db['F3 True/False']:.3f}（λ=0 时 {d0['F3 True/False']:.3f}）")
    if db["echo"] < 0.75:
        print("  ⚪ **不可判**：正则没能把复述救回来（<0.75）⟹ 太弱或位置不对，不得下结论。")
    elif db["F3 True/False"] > d0["F3 True/False"] - 0.10:
        print("  ✅ **身份与含义不冲突**：复述恢复而 F3 基本保住")
        print("     ⟹ P11 的主结果从「不可解读」升级为**可解读的负面结果**（F3 仍 < 0.85）。")
    else:
        print("  🔴 **身份与含义直接冲突**：复述一恢复，F3 就塌")
        print("     ⟹ 比原结果更强的结论：**词条只能靠覆盖该词的身份来携带含义**。")
print(f"\n[saved] {os.path.basename(OUT)}")
