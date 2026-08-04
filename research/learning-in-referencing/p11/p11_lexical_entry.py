"""P11 — 词条记忆：键是【词的 token】，值进入【表征】

设计与八轮正反方辩论见 ../../../docs/DESIGN_LEXICAL_ENTRY.md。
**及格线在跑之前已写死**（该文档 §4.1），本脚本原样复述并自动判定。

★ 与 P5–P10 的结构差别
  P5–P10 : 键 = 整段末位隐状态（换词后余弦 0.994 ⟹ 看不见词）；值 → logits（绑死读出方向）
  P11    : 键 = **词的 token 位置**（精确匹配，O(1)，无相似度路由）；值 → **残差流**（早层）
  ⟹ 换词则**触发器不点火**（绑定由构造保证）；值经全网络处理（跨格式由通路保证）

★ 四个条件（后两个是**双向控制**，各故意破坏一条约束）
  emb           ℓ=0（输入嵌入），只在词的位置注入      ← 主条件，最简单的变体
  L7            ℓ=7，只在词的位置注入                 ← 只在 emb 不达标时才跑
  postnorm_word 词触发，但值加在 post-norm 的**末位**   ← 破坏"值须进表征"
                ⚠️ 常量加在末位 = 纯 logit 平移，**构造上必然 AUC 0.5**（排序不变）。
                   它不是实证发现，而是**解释为什么 P5–P8 必须用输入依赖的路由**：
                   词条可以是常量，前提是后面的网络替它干活。
  emb_allpos    ℓ=0，但在**所有位置**注入              ← 破坏"键须是词"
                预测：换词落差回到 ~0.02（复现 P9b 的行为）

⚠️ 若两个控制**不按预测失败**，说明我方对失败原因的归因本身是错的。
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
ap.add_argument("--conds", default="emb,emb_allpos,postnorm_word")
ap.add_argument("--seed", type=int, default=0)
ap.add_argument("--echo-only", action="store_true", help="只跑复述控制（实施顺序第 1 步）")
ap.add_argument("--vmax", type=float, default=1.0,
                help="‖v‖ 上限 = vmax × 该位置隐状态的平均范数（设计文档辩论反 3）。"
                     "0 = 不约束。⚠️ 不约束时训练会把 ‖v‖ 推到隐状态的 11 倍，"
                     "**跑出复述控制验证过的范围**，结果不可解读。")
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
print(f"[load] done · {dev} · d={D}\n", flush=True)

tid = lambda t: tok.encode(t, add_special_tokens=False)[0]     # noqa: E731
FMT = {"F1 Yes/No": (tid(" Yes"), tid(" No")),
       "F2 A/B": (tid(" A"), tid(" B")),
       "F3 True/False": (tid(" True"), tid(" False"))}


# ---------- 提示（与 P10 逐字一致，便于直接对照） ----------
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


# ---------- ★ 词的 token 位置：精确匹配，无相似度 ----------
def word_variants(w):
    """同一个词在句首/句中的 token 序列不同，两种都要匹配"""
    seqs = []
    for s in (w, " " + w):
        ids = tok.encode(s, add_special_tokens=False)
        if ids and ids not in seqs:
            seqs.append(ids)
    return seqs


def word_mask(input_ids, w):
    """[B,T] 的 0/1 掩码，标出 w 的 token 落在哪些位置"""
    seqs = word_variants(w)
    m = torch.zeros(input_ids.shape, dtype=torch.float32, device=input_ids.device)
    ids = input_ids.tolist()
    for b, row in enumerate(ids):
        for s in seqs:
            n = len(s)
            for i in range(len(row) - n + 1):
                if row[i:i + n] == s:
                    m[b, i:i + n] = 1.0
    return m


def enc(prompts, w=None, all_pos=False):
    e = tok(prompts, return_tensors="pt", padding=True).to(dev)
    e["position_ids"] = (e["attention_mask"].cumsum(-1) - 1).clamp(min=0)
    if all_pos:
        mask = e["attention_mask"].float()                 # 所有真实 token
    elif w is not None:
        mask = word_mask(e["input_ids"], w)
    else:
        mask = torch.zeros_like(e["attention_mask"], dtype=torch.float32)
    return e, mask


# ---------- 注入 ----------
class Entry(nn.Module):
    """一个 (u, w) 一个向量。**无 keys、无路由、无 top-k。**"""

    def __init__(self, d):
        super().__init__()
        self.v = nn.Parameter(torch.zeros(d))               # 零初始化 ⟹ 初始为恒等

    def forward(self, h, mask):                             # h:[B,T,d] mask:[B,T]
        return h + mask.unsqueeze(-1) * self.v


def attach(entry, holder, where):
    """where: 'emb' | int（decoder layer 序号）| 'postnorm_last'"""
    def hook(_m, _i, out):
        h = out[0] if isinstance(out, tuple) else out
        mask = holder["mask"]
        if mask is None or mask.shape[:2] != h.shape[:2]:
            return out
        h2 = entry(h, mask)
        return ((h2,) + out[1:]) if isinstance(out, tuple) else h2

    def hook_last(_m, _i, out):
        """post-norm 只有**末位**进 lm_head ⟹ 常量加在末位 = 纯 logit 平移"""
        h = out[0] if isinstance(out, tuple) else out
        if holder["fire"]:
            h = h.clone(); h[:, -1] = h[:, -1] + entry.v
        return ((h,) + out[1:]) if isinstance(out, tuple) else h

    if where == "emb":
        return model.model.embed_tokens.register_forward_hook(hook)
    if where == "postnorm_last":
        return model.model.norm.register_forward_hook(hook_last)
    return model.model.layers[int(where)].register_forward_hook(hook)


CONDS = {  # name -> (where, all_pos)
    "emb":           ("emb", False),
    "L7":            (7, False),
    "emb_allpos":    ("emb", True),
    "postnorm_word": ("postnorm_last", False),
}

# ---------- 用户（与 P10 同构造、同 seed）----------
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

# ============================================================================
# 实施顺序第 1 步：★ 复述控制（辩论反 3）—— 不过就停
# ============================================================================
print("=" * 92)
print("★ 复述控制（辩论反 3）：早层注入会不会破坏该词的身份？")
print("   注入一个**随机方向、范数与该位置隐状态同量级**的向量，看模型还能不能复述那个词。")
print("   若不能 ⟹ 注入把该位置变成了语义标记，'绑定'是假的 ⟹ **停，不解读主结果**。")
print("=" * 92)


@torch.no_grad()
def echo_ok(w, entry=None, holder=None, greedy=8):
    p = f"Repeat exactly: {w}\nAnswer:"
    e, m = enc([p], w=w)
    if holder is not None:
        holder["mask"], holder["fire"] = m, True
    ids = e["input_ids"]
    for _ in range(greedy):
        out = model(input_ids=ids,
                    attention_mask=torch.ones_like(ids),
                    position_ids=(torch.ones_like(ids).cumsum(-1) - 1))
        nxt = out.logits[:, -1].argmax(-1, keepdim=True)
        ids = torch.cat([ids, nxt], dim=-1)
        if holder is not None:                    # 序列变长，掩码需重算
            holder["mask"] = word_mask(ids, w)
    gen = tok.decode(ids[0, e["input_ids"].shape[1]:], skip_special_tokens=True)
    return w.lower() in gen.lower().replace(" ", ""), gen.strip()[:40]


base_ok, inj_ok, norms = [], [], []
holder = {"mask": None, "fire": True}
for u in users:
    w = u["w1"]
    ok0, g0 = echo_ok(w)
    # 注入一个与该位置隐状态同量级的随机向量（最坏情况：方向完全无关）
    with torch.no_grad():
        e, m = enc([f"Repeat exactly: {w}\nAnswer:"], w=w)
        h = model.model.embed_tokens(e["input_ids"])
        scale = (h[0][m[0] > 0].norm(dim=-1).mean() if m.sum() > 0 else h.norm(dim=-1).mean()).item()
    ent = Entry(D).to(dev)
    with torch.no_grad():
        r = torch.randn(D, device=dev); ent.v.copy_(r / r.norm() * scale)
    norms.append(scale)
    hd = attach(ent, holder, "emb")
    ok1, g1 = echo_ok(w, ent, holder)
    hd.remove()
    base_ok.append(ok0); inj_ok.append(ok1)
    print(f"  [{u['uid']}] {w:10} 无注入 {'✅' if ok0 else '❌'} «{g0}»   "
          f"注入后 {'✅' if ok1 else '❌'} «{g1}»", flush=True)

b, iok = st.mean(base_ok), st.mean(inj_ok)
print(f"\n  无注入复述成功率 {b:.2f} · 同量级随机注入后 {iok:.2f} · "
      f"该位置隐状态平均范数 {st.mean(norms):.2f}")
if b < 0.75:
    print("  ⚪ **不可判**：模型本身就复述不出这些伪词（无注入 <0.75）——本控制无效，"
          "须换更简单的复述任务。")
elif iok >= b - 0.25:
    print("  ✅ **通过**：同量级随机注入未破坏词的身份 ⟹ 可以解读主结果。")
else:
    print("  🔴 **未通过**：注入破坏了该词的身份 ⟹ 按设计文档 §6，**停**。")
    print("     须先降低 ‖v‖ 或改注入位置，再重跑本控制。")

json.dump({"echo_control": {"base": b, "injected_random_same_norm": iok,
                            "mean_hidden_norm": st.mean(norms), "n": NU}},
          open(os.path.join(HERE, f"p11_echo_{TAG}.json"), "w"), indent=2, ensure_ascii=False)
print(f"\n[saved] p11_echo_{TAG}.json")
if args.echo_only:
    sys.exit(0)

# ============================================================================
# 实施顺序第 2 步：主实验
#   每个用户**两个词条**（w1, w2），在 P10 那 24 条【同一物体、两词标签相反】的
#   决策上联合训练。换词时 w2 的条目会在问句位置点火 ⟹ 答案应当跟着翻转。
# ============================================================================
def build(u, cond):
    """返回该用户的训练批与三档换词的评测批；每批附带两个词条各自的掩码"""
    where, all_pos = CONDS[cond]
    p = pre_of(u)
    objs = u["tr_a"] + u["tr_b"]
    tr_prompts = [f1(u["w1"], b, p) for b in objs] + [f1(u["w2"], b, p) for b in objs]
    tr_lab = [1.0] * 6 + [0.0] * 6 + [0.0] * 6 + [1.0] * 6      # 同一物体，两词标签相反

    def pack(prompts):
        e, _ = enc(prompts)                                     # 只要 encoding
        m1 = (e["attention_mask"].float() if all_pos else word_mask(e["input_ids"], u["w1"]))
        m2 = (torch.zeros_like(m1) if all_pos else word_mask(e["input_ids"], u["w2"]))
        return e, [m1, m2]

    out = {"train": (*pack(tr_prompts), torch.tensor(tr_lab, device=dev))}
    for cond_w, w in (("own", u["w1"]), ("within", u["w2"]), ("across", u["other"])):
        d = {}
        d["F1 Yes/No"] = (pack([f1(w, b, p) for b in u["pb_a"]]),
                          pack([f1(w, b, p) for b in u["pb_b"]]))
        d["F2 A/B"] = (pack([f2(w, g, b, True, p) for g, b in zip(u["pb_a"], u["pb_b"])]),
                       pack([f2(w, g, b, False, p) for g, b in zip(u["pb_a"], u["pb_b"])]))
        d["F3 True/False"] = (pack([f3(w, b, p) for b in u["pb_a"]]),
                              pack([f3(w, b, p) for b in u["pb_b"]]))
        out[cond_w] = d
    return out


def run_batch(e, masks, holder):
    holder["masks"] = masks
    holder["fire"] = True
    return model(**e, logits_to_keep=1).logits[:, -1]


def scores(pk, fmt, holder):
    e, masks = pk
    P, N_ = FMT[fmt]
    with torch.no_grad():
        lg = run_batch(e, masks, holder)
        return torch.softmax(torch.stack([lg[:, P], lg[:, N_]], -1), -1)[:, 0].tolist()


REF = {}
_ref = os.path.join(ROOT, "p10", f"p10_ref_{TAG}.json")
if os.path.exists(_ref):
    REF = json.load(open(_ref))["results"]
    print("\n[ref] 复用 P10 参照臂（同数据同 seed）：base " +
          " / ".join(f"{REF['base'][f]:.3f}" for f in FMT) +
          "  ·  L1 上下文 " + " / ".join(f"{REF['l1'][f]:.3f}" for f in FMT))

# 及格线（设计文档 §4.1，跑前写死）
PASS = {"own_F1": 0.85, "within_F1_max": 0.30, "F2": 0.85, "F3": 0.85}

RES = {}
OUT = os.path.join(HERE, f"p11_{TAG}.json")
for cond in args.conds.split(","):
    where, all_pos = CONDS[cond]
    print("\n" + "=" * 92)
    print(f"条件 {cond}   注入位置={where}  ·  " +
          ("**所有位置**（破坏『键须是词』的控制）" if all_pos else "只在词的 token 位置"))
    print("=" * 92)
    t0 = time.time()
    for u in users:
        data = build(u, cond)
        ents = [Entry(D).to(dev), Entry(D).to(dev)]
        holder = {"masks": None, "fire": True}

        def hook(_m, _i, out, _ents=ents, _h=holder):
            h = out[0] if isinstance(out, tuple) else out
            ms = _h["masks"]
            if not ms or ms[0].shape[:2] != h.shape[:2]:
                return out
            add = sum(m.unsqueeze(-1) * e.v for m, e in zip(ms, _ents))
            h2 = h + add
            return ((h2,) + out[1:]) if isinstance(out, tuple) else h2

        def hook_last(_m, _i, out, _ents=ents, _h=holder):
            h = out[0] if isinstance(out, tuple) else out
            ms = _h["masks"]
            if not ms:
                return out
            # 词是否出现 → 决定点不点火；值加在**末位**（纯 logit 平移）
            fire = sum(float(m.sum() > 0) * e.v for m, e in zip(ms, _ents))
            h = h.clone(); h[:, -1] = h[:, -1] + fire
            return ((h,) + out[1:]) if isinstance(out, tuple) else h

        tgt = (model.model.embed_tokens if where == "emb" else
               model.model.norm if where == "postnorm_last" else model.model.layers[int(where)])
        hd = tgt.register_forward_hook(hook_last if where == "postnorm_last" else hook)

        opt = torch.optim.Adam([e.v for e in ents], lr=args.lr)
        P, N_ = FMT["F1 Yes/No"]
        e_tr, m_tr, y_tr = data["train"]
        # ★ 范数上限（辩论反 3）：把 v 约束在**注入层**隐状态的量级内
        # 🔴 初版 bug：无论注入在哪一层，都用**嵌入层**的 ‖h‖（1.09）做上限。
        #    但残差范数随深度增长（P5 实测末层 ‖h‖≈172），于是 L7 上的上限小了两个量级，
        #    等于几乎没注入 —— 训练 acc 卡在 0.500（= 只看物体的上限），看着像"架构不能"。
        #    ⟹ 上限必须在**注入层**上量。
        with torch.no_grad():
            probe = {}

            def _grab(_m, _i, out, _p=probe):
                h = out[0] if isinstance(out, tuple) else out
                _p["h"] = h.detach()
            hd_p = tgt.register_forward_hook(_grab)
            holder["masks"] = m_tr
            model(**e_tr, logits_to_keep=1)
            hd_p.remove()
            hh = probe["h"]
            sel = (m_tr[0] + m_tr[1]) > 0
            hn = (hh[sel].norm(dim=-1).mean() if sel.any() else hh.norm(dim=-1).mean()).item()
        cap = args.vmax * hn if args.vmax > 0 else None
        curve = []
        for ep in range(1, args.epochs + 1):
            opt.zero_grad()
            lg = run_batch(e_tr, m_tr, holder)
            loss = F.binary_cross_entropy_with_logits(lg[:, P] - lg[:, N_], y_tr)
            loss.backward(); opt.step()
            if cap is not None:                      # 投影回范数球
                with torch.no_grad():
                    for e_ in ents:
                        n = e_.v.norm()
                        if n > cap:
                            e_.v.mul_(cap / n)
            if ep in (args.epochs // 3, args.epochs * 2 // 3, args.epochs):
                with torch.no_grad():
                    a = ((((lg[:, P] - lg[:, N_]) > 0).float()) == y_tr).float().mean().item()
                curve.append((ep, round(a, 3), round(loss.item(), 4)))
        u[f"{cond}_curve"] = curve
        u[f"{cond}_tracc"] = curve[-1][1]
        u[f"{cond}_vnorm"] = st.mean(e.v.norm().item() for e in ents)
        u[f"{cond}_hnorm"] = hn
        # ★ 用**学出来的真实 v** 重跑复述控制（不是同量级随机向量搪塞）
        holder["masks"] = None
        hd_e = tgt.register_forward_hook(hook_last if where == "postnorm_last" else hook)

        @torch.no_grad()
        def _echo(w, _ents=ents, _h=holder):
            ids = tok(f"Repeat exactly: {w}\nAnswer:", return_tensors="pt")["input_ids"].to(dev)
            n0 = ids.shape[1]
            for _ in range(8):
                _h["masks"] = [word_mask(ids, u["w1"]), word_mask(ids, u["w2"])]
                lg = model(input_ids=ids, attention_mask=torch.ones_like(ids),
                           position_ids=(torch.ones_like(ids).cumsum(-1) - 1)).logits[:, -1]
                ids = torch.cat([ids, lg.argmax(-1, keepdim=True)], -1)
            g = tok.decode(ids[0, n0:], skip_special_tokens=True)
            return w.lower() in g.lower().replace(" ", "")

        u[f"{cond}_echo"] = float(_echo(u["w1"]))
        hd_e.remove()
        for cw in ("own", "within", "across"):
            for fmt in FMT:
                pos, neg = data[cw][fmt]
                u[f"{cond}_{cw}_{fmt}"] = auc(scores(pos, fmt, holder), scores(neg, fmt, holder))
        hd.remove()
        print(f"  [{u['uid']}] 训练 acc {u[f'{cond}_tracc']:.3f} "
              f"‖v‖/‖h‖={u[f'{cond}_vnorm']/u[f'{cond}_hnorm']:.2f} "
              f"复述{'✅' if u[f'{cond}_echo'] else '❌'} · "
              f"own {u[f'{cond}_own_F1 Yes/No']:.3f}/{u[f'{cond}_own_F2 A/B']:.3f}/"
              f"{u[f'{cond}_own_F3 True/False']:.3f} · 换成w2 {u[f'{cond}_within_F1 Yes/No']:.3f} · "
              f"换成别人 {u[f'{cond}_across_F1 Yes/No']:.3f}", flush=True)
    RES[cond] = {"train_acc": st.mean(u[f"{cond}_tracc"] for u in users),
                 "v_norm": st.mean(u[f"{cond}_vnorm"] for u in users),
                 "hidden_norm_at_word": st.mean(u[f"{cond}_hnorm"] for u in users),
                 "v_over_h": st.mean(u[f"{cond}_vnorm"] / u[f"{cond}_hnorm"] for u in users),
                 "echo_ok_with_learned_v": st.mean(u[f"{cond}_echo"] for u in users),
                 "train_curve": [[c[0], round(st.mean(u[f"{cond}_curve"][i][1] for u in users), 3)]
                                 for i, c in enumerate(users[0][f"{cond}_curve"])],
                 **{cw: {f: st.mean(u[f"{cond}_{cw}_{f}"] for u in users) for f in FMT}
                    for cw in ("own", "within", "across")}}
    json.dump({"model": args.model, "n_users": NU, "pass_line": PASS,
               "reference_from_p10": REF, "results": RES},
              open(OUT, "w"), indent=2, ensure_ascii=False)
    print(f"  ({(time.time()-t0)/60:.1f} min) · 已落盘")

# ---------------------------------------------------------------- 汇总与判定
print("\n" + "=" * 92)
print(f"P11 词条记忆  ·  {TAG}  ·  {NU} 用户  ·  训练只用 F1，F2/F3 始终 held-out")
print("=" * 92)
hdr = f"\n{'条件':24}{'训练acc':>8}" + "".join(f"{f:>15}" for f in FMT)
print(hdr); print("-" * 80)
if REF:
    for k, nm in (("base", "base（无词条）"), ("l1", "L1 定义进上下文")):
        print(f"{nm:22}{'—':>8}" + "".join(f"{REF[k][f]:15.3f}" for f in FMT))
    print("-" * 80)
for cond, d in RES.items():
    print(f"{cond+' · own':22}{d['train_acc']:8.3f}" + "".join(f"{d['own'][f]:15.3f}" for f in FMT))
    print(f"{'   ★换成含义相反的w2':22}{'':>8}" + "".join(f"{d['within'][f]:15.3f}" for f in FMT))
    print(f"{'   换成别人的词':22}{'':>8}" + "".join(f"{d['across'][f]:15.3f}" for f in FMT))
    print("-" * 80)

print("\n【前置：学出来的 v 是否仍在复述控制验证过的范围内】")
for cond, d in RES.items():
    e_ok, ratio = d["echo_ok_with_learned_v"], d["v_over_h"]
    print(f"  {cond:14} ‖v‖/‖h‖ = {ratio:.2f} · 用学到的 v 复述成功率 {e_ok:.2f} —— "
          + ("✅ 可解读" if e_ok >= 0.75 else
             "🔴 **词的身份已被破坏 ⟹ 该条件的主结果不可解读**（辩论反 3）"))

print("\n【判定 —— 及格线在设计文档 §4.1 跑前已写死】")
for cond, d in RES.items():
    o1, w1_, f2_, f3_ = (d["own"]["F1 Yes/No"], d["within"]["F1 Yes/No"],
                         d["own"]["F2 A/B"], d["own"]["F3 True/False"])
    chk = [("own F1 ≥0.85", o1 >= PASS["own_F1"], o1),
           ("换词 ≤0.30", w1_ <= PASS["within_F1_max"], w1_),
           ("★F2 ≥0.85", f2_ >= PASS["F2"], f2_),
           ("★F3 ≥0.85", f3_ >= PASS["F3"], f3_)]
    print(f"  {cond}: " + " · ".join(f"{n} {'✅' if ok else '❌'}({v:.3f})" for n, ok, v in chk))
    if cond == "emb":
        if all(ok for _, ok, _ in chk):
            print("     ✅✅ **主条件达标** ⟹ 论文 §6「最多只拿到其一」那条负面结论被推翻。")
        elif chk[2][1] or chk[3][1]:
            print("     ◐ 部分达标——须按未过项逐条说明，不得整体报成成功。")
        else:
            print("     🔴 **未达标** ⟹ 记为负面结果，「早层+词位置」的机制推理须撤回。")
print("\n【双向控制是否按预测失败】")
if "postnorm_word" in RES:
    d = RES["postnorm_word"]
    print(f"  postnorm_word（值进 logits）: F1 {d['own']['F1 Yes/No']:.3f} —— "
          + ("✅ 按预测塌到 ~0.5（常量末位平移不改排序，**构造性**）"
             if abs(d['own']['F1 Yes/No'] - 0.5) < 0.12 else
             "🔴 **未按预测失败** ⟹ 我方对『值须进表征』的归因有误"))
if "emb_allpos" in RES:
    d = RES["emb_allpos"]
    gap = d["own"]["F1 Yes/No"] - d["within"]["F1 Yes/No"]
    print(f"  emb_allpos（键不是词）: 换词落差 {gap:+.3f} —— "
          + ("✅ 按预测≈0（复现 P9b 的 0.017）" if abs(gap) < 0.15 else
             "🔴 **未按预测失败** ⟹ 我方对『键须是词』的归因有误"))
print(f"\n[saved] {os.path.basename(OUT)}")
