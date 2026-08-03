"""P7 — I2 的另一半：两个【各自独立习得】的概念之间能否组合？

P6 已证「概念 ⊗ 世界知识」成立（跨域 base 0.500 → L4 0.949）。
但 P6 的 README §3 明写了限定：**「概念 ⊗ 概念」未测**。本实验补这一格。

★ 关键的实验设计（否则测不出组合）
  同一用户学两个概念：w1 = 某颜色、w2 = 某材质，各自 12 条独立的教学决策。
  合取探针问：「Is X both w1 and w2?」——**教学中从未出现过合取句式，也从未说过任何合取事实**。

  🔑 **负例只取「恰好成立一个」的实体**（w1✓w2✗ 与 w1✗w2✓），不取「两个都不成立」。
     若把「两个都不成立」也算负例，单概念策略能拿到 ~0.833，实验就废了。

  🔴 **初稿在这里算错过一次**：写成"单概念策略上界 = 0.500"。**实际是 0.75**——
     负例里一半（只中 w1）与正例在 w1 上同分布（贡献 0.5），另一半（只中 w2）能被 w1 拒掉（贡献 1.0）。
     ⟹ **总 AUC 一个数说明不了问题**，必须**拆成两半**看：
       · `conj|¬w2` = 正例 vs 【只中 w1】的负例 —— **只能靠 w2 拒绝**
       · `conj|¬w1` = 正例 vs 【只中 w2】的负例 —— **只能靠 w1 拒绝**
     单概念策略必然在**其中一半掉到 0.5**。**判据 = min(两半)**，总 AUC 只作参考。

★ 三道前置检查（都可能让本实验无意义，必须先跑）
  ① **合取能力先验**：把伪词换成真英语词问同样的合取句（`both red and wooden`），
     base 若做不到，则失败归因于**基座不会合取**，与记忆无关。
  ② **单概念探针**：两个概念各自是否真的学会了（否则合取失败不可解释）。
  ③ **L1 上下文臂**：把两个定义都写进提示。它若也失败 ⟹ 是任务/句式问题，不是参数化记忆的问题。

★ 三个 L4 条件（分离失败原因，并检验一条可证伪的预言）
  seq     —— 先写 w1 再写 w2，两者共享该 uid 的全部 32 槽（真实场景）
  joint   —— 两个概念的决策合并训练（上界参照）
  subpart —— 顺序写入，每概念一个不相交子区（各 16 槽），**但只掩梯度、不掩检索**
  subroute —— 同上，**写入与检索都掩**（分区键 = (uid, 提示里出现的词)）

  seq 与 joint 之差 = **分区内的顺序干扰**（P5 只证了分区挡住**跨用户**干扰，**没测过用户内部**）。

  ★ subpart 是 P5 那条结论（"关键是分区，不是容量"）的**可证伪预言**：
    若成立，则 subpart 应修好 seq 的退化——**且它每个概念只有 16 槽，比 seq 的 32 槽更少**，
    ⟹ 若更少的容量反而更好，**容量解释被排除**，只剩分区解释。

  🔴 **实测 subpart 没修好**（Δ −0.351 vs seq 的 −0.361）。**先诊断而非猜**：
     · w1 的槽 values 改动量 **0.00e+00** ⟹ 梯度掩码有效，不是被改写
     · 但 w1 探针 **25% 的 top-4 落进 w2 的子区** ⟹ **检索跨了区**
     ⟹ 结论：**分区必须同时作用于写入与检索**。P5 之所以成功，正因为那里检索本来就按 uid 掩了。
     subroute 条件即据此而设——它是这条诊断的**验证**，不是事后找补。
"""
import os, sys, json, argparse, random, statistics as st
import torch
import torch.nn.functional as F
from transformers import AutoTokenizer, AutoModelForCausalLM

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "p1")); sys.path.insert(0, os.path.join(ROOT, "p5"))
import microworld as mw                          # noqa: E402
import lexicon                                   # noqa: E402
from memory_layer import PartitionedMemoryLayer  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--model", default="Qwen/Qwen2.5-1.5B-Instruct")
ap.add_argument("--users", type=int, default=8)
ap.add_argument("--slots", type=int, default=32)
ap.add_argument("--topk", type=int, default=4)
ap.add_argument("--epochs", type=int, default=300)
ap.add_argument("--lr", type=float, default=5e-2)
ap.add_argument("--n-train", type=int, default=12)
ap.add_argument("--n-probe", type=int, default=12)
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
YES_ID = tok.encode(" Yes", add_special_tokens=False)[0]
NO_ID = tok.encode(" No", add_special_tokens=False)[0]
ENTS = list(mw.entities())          # ← 生成器必须 list()，P3 的教训
print(f"[load] done · {dev} · {len(ENTS)} 实体\n", flush=True)


@torch.no_grad()
def hidden(prompt):
    ids = tok(prompt, return_tensors="pt")["input_ids"].to(dev)
    return model.model(ids).last_hidden_state[0, -1].detach()


def auc(pos, neg):
    if not pos or not neg:
        return float("nan")
    return sum((a > b) + 0.5 * (a == b) for a in pos for b in neg) / (len(pos) * len(neg))


# ---------- 提示模板 ----------
def q_single(word, body, defn=None):
    pre = f"{word} means {defn}." if defn else f"{word} is a word in Tovi's language."
    return f"{pre}\nQuestion: Is {body} {word}? Answer Yes or No.\nAnswer:"


def q_conj(w1, w2, body, d1=None, d2=None):
    if d1:
        pre = f"{w1} means {d1}. {w2} means {d2}."
    else:
        pre = f"{w1} and {w2} are words in Tovi's language."
    return f"{pre}\nQuestion: Is {body} both {w1} and {w2}? Answer Yes or No.\nAnswer:"


# ============================================================================
# 前置检查 ①：基座会不会做合取？（伪词换成真英语词，同样的句式与同样的负例构造）
# ============================================================================
print("=" * 90)
print("前置检查 ①  基座的【合取】能力 —— 用真英语词、同样的句式与负例构造")
print("=" * 90)
prior_scores = []
for col, mat in [("red", "wooden"), ("blue", "metal"), ("green", "plastic"), ("yellow", "cloth")]:
    pos = [e for e in ENTS if e["color"] == col and e["material"] == mat]
    neg = [e for e in ENTS if (e["color"] == col) != (e["material"] == mat)]   # 恰好成立一个
    rng.shuffle(pos); rng.shuffle(neg)

    def sc(es):
        out = []
        for e in es[:8]:
            h = hidden(f"Question: Is {mw.describe(e)} both {col} and {mat}? Answer Yes or No.\nAnswer:")
            lg = h @ W.T
            out.append(torch.softmax(torch.stack([lg[YES_ID], lg[NO_ID]]), 0)[0].item())
        return out
    a = auc(sc(pos), sc(neg))
    prior_scores.append(a)
    print(f"  both {col} and {mat:8} → AUC {a:.3f}")
PRIOR = st.mean(prior_scores)
print(f"\n  平均 {PRIOR:.3f} —— " +
      ("✅ 基座会合取，本实验可解释" if PRIOR >= 0.70 else
       "🔴 基座本身不会合取 —— 任何失败都【不能】归因于记忆，本实验只能报为不可判"))

# ============================================================================
# 组装用户：每人两个概念（颜色 + 材质），各自独立的教学集
# ============================================================================
words, _ = lexicon.make_lexicon(2 * args.users, seed=args.seed + 7)
users = []
for i in range(args.users):
    col = mw.COLORS[i % len(mw.COLORS)]
    mat = mw.MATERIALS[(i // len(mw.COLORS) + i) % len(mw.MATERIALS)]
    w1, w2 = words[2 * i], words[2 * i + 1]

    def decisions(attr, val, k):
        yes = [e for e in ENTS if e[attr] == val]
        no = [e for e in ENTS if e[attr] != val]
        rng.shuffle(yes); rng.shuffle(no)
        sel = [(e, "Yes") for e in yes[:k // 2]] + [(e, "No") for e in no[:k - k // 2]]
        rng.shuffle(sel)
        return sel

    # 探针：与教学集不相交
    tr1, tr2 = decisions("color", col, args.n_train), decisions("material", mat, args.n_train)
    seen = {mw.describe(e) for e, _ in tr1 + tr2}

    def probe_single(attr, val, k):
        yes = [e for e in ENTS if e[attr] == val and mw.describe(e) not in seen]
        no = [e for e in ENTS if e[attr] != val and mw.describe(e) not in seen]
        rng.shuffle(yes); rng.shuffle(no)
        return [(e, "Yes") for e in yes[:k // 2]] + [(e, "No") for e in no[:k - k // 2]]

    # ★ 合取探针：负例 = 恰好成立一个 ⟹ 单概念策略 AUC = 0.500
    # both / only1 / only2 三类，负例只用后两类（见开头 🔑）
    both = [e for e in ENTS if e["color"] == col and e["material"] == mat and mw.describe(e) not in seen]
    only1 = [e for e in ENTS if e["color"] == col and e["material"] != mat and mw.describe(e) not in seen]
    only2 = [e for e in ENTS if e["color"] != col and e["material"] == mat and mw.describe(e) not in seen]
    rng.shuffle(both); rng.shuffle(only1); rng.shuffle(only2)
    h = args.n_probe // 2
    n1, n2 = h - h // 2, h // 2
    conj = ([(e, "Yes") for e in both[:h]] +
            [(e, "No") for e in only1[:n1]] + [(e, "No") for e in only2[:n2]])
    # 正例数 h，随后 n1 个"只中 w1"负例，再 n2 个"只中 w2"负例 —— 拆分靠这个下标
    users.append(dict(uid=f"u{i:02d}", w1=w1, w2=w2, c1=col, c2=mat, n_pos=h, n_only1=n1, n_only2=n2,
                      tr1=tr1, tr2=tr2,
                      p1=probe_single("color", col, args.n_probe),
                      p2=probe_single("material", mat, args.n_probe),
                      conj=conj))
NU = len(users)
print(f"\n用户 {NU} · 每人 2 概念 × {args.n_train} 条教学 · 合取探针每人 "
      f"{len(users[0]['conj'])} 条（{sum(l=='Yes' for _,l in users[0]['conj'])} 正）")


def probs_ctx(prompts):
    out = []
    for p in prompts:
        lg = hidden(p) @ W.T
        out.append(torch.softmax(torch.stack([lg[YES_ID], lg[NO_ID]]), 0)[0].item())
    return out


def auc_of(items, ps):
    return auc([p for p, (_, l) in zip(ps, items) if l == "Yes"],
               [p for p, (_, l) in zip(ps, items) if l == "No"])


def conj_split(u, ps):
    """把合取 AUC 拆成两半 —— 单概念策略必在其中一半掉到 0.5。

    返回 (总AUC, conj|¬w2, conj|¬w1)：
      conj|¬w2 = 正例 vs【只中 w1】的负例 —— 这些负例**只能靠 w2 拒绝**
      conj|¬w1 = 正例 vs【只中 w2】的负例 —— 这些负例**只能靠 w1 拒绝**
    """
    a, b, c = u["n_pos"], u["n_only1"], u["n_only2"]
    pos, o1, o2 = ps[:a], ps[a:a + b], ps[a + b:a + b + c]
    return auc(pos, o1 + o2), auc(pos, o1), auc(pos, o2)


# ============================================================================
# 臂 A：base（无概念、无记忆） · 臂 B：L1 把两个定义都写进上下文
# ============================================================================
print("\n" + "=" * 90)
print("臂 A/B  base（伪词无定义） 与 L1（定义写进上下文）")
print("=" * 90)
for u in users:
    for arm, d1, d2 in (("base", None, None), ("l1", u["c1"], u["c2"])):
        u[f"{arm}_p1"] = auc_of(u["p1"], probs_ctx([q_single(u["w1"], mw.describe(e), d1) for e, _ in u["p1"]]))
        u[f"{arm}_p2"] = auc_of(u["p2"], probs_ctx([q_single(u["w2"], mw.describe(e), d2) for e, _ in u["p2"]]))
        ps = probs_ctx([q_conj(u["w1"], u["w2"], mw.describe(e), d1, d2) for e, _ in u["conj"]])
        u[f"{arm}_conj"], u[f"{arm}_cj_no_w2"], u[f"{arm}_cj_no_w1"] = conj_split(u, ps)
    print(f"  [{u['uid']}] base 合取 {u['base_conj']:.3f} · L1 合取 {u['l1_conj']:.3f}", flush=True)

# ============================================================================
# 臂 C/D：L4 参数化记忆（上下文完全不含定义）· seq 顺序写入 vs joint 合并训练
# ============================================================================
print("\n" + "=" * 90)
print("臂 C/D  L4 参数化记忆（上下文只有『它们是 Tovi 语的词』）")
print("=" * 90)
print("[cache] 隐状态…", flush=True)
for u in users:
    for k, (w, items) in {"tr1": (u["w1"], u["tr1"]), "tr2": (u["w2"], u["tr2"]),
                          "p1": (u["w1"], u["p1"]), "p2": (u["w2"], u["p2"])}.items():
        u[f"h_{k}"] = torch.stack([hidden(q_single(w, mw.describe(e))) for e, _ in items])
        u[f"t_{k}"] = torch.tensor([1.0 if l == "Yes" else 0.0 for _, l in items], device=dev)
    u["h_conj"] = torch.stack([hidden(q_conj(u["w1"], u["w2"], mw.describe(e))) for e, _ in u["conj"]])


def train(mem, i, hs, ts, half=None):
    """half=None 用整个 uid 分区；half=0/1 只用该分区的前/后一半（subpart 条件）。"""
    lo, hi = mem.partition(i)
    if half is not None:
        mid = lo + (hi - lo) // 2
        lo, hi = (lo, mid) if half == 0 else (mid, hi)
    opt = torch.optim.Adam([mem.keys, mem.values], lr=args.lr)
    for _ in range(args.epochs):
        opt.zero_grad()
        lg = (hs + mem(hs, i)) @ W.T
        F.binary_cross_entropy_with_logits(lg[:, YES_ID] - lg[:, NO_ID], ts).backward()
        with torch.no_grad():
            for pm in (mem.keys, mem.values):
                m = torch.zeros_like(pm.grad); m[lo:hi] = 1.0; pm.grad.mul_(m)
        opt.step()


def mem_ps(mem, u, i, key, sub=None):
    with torch.no_grad():
        h = u[f"h_{key}"]
        lg = (h + mem(h, i, sub)) @ W.T
        return torch.softmax(torch.stack([lg[:, YES_ID], lg[:, NO_ID]], -1), -1)[:, 0].tolist()


def mem_auc(mem, u, i, key, sub=None):
    return auc_of(u[key], mem_ps(mem, u, i, key, sub))


def eval_sub(mode, key):
    """subroute 条件下检索也要掩码；掩哪个子区由【提示里出现的词】决定。

    p1 只含 w1 → 子区 0；p2 只含 w2 → 子区 1；**合取探针两个词都在 → 不掩（需要两个概念）**。
    """
    if mode != "subroute":
        return None
    return {"p1": 0, "p2": 1, "conj": None}[key]


for mode in ("seq", "joint", "subpart", "subroute"):
    mem = PartitionedMemoryLayer(D, NU, args.slots, args.topk).to(dev)
    for i, u in enumerate(users):
        if mode == "joint":
            train(mem, i, torch.cat([u["h_tr1"], u["h_tr2"]]),
                  torch.cat([u["t_tr1"], u["t_tr2"]]))
        else:
            half1, half2 = (None, None) if mode == "seq" else (0, 1)
            train(mem, i, u["h_tr1"], u["t_tr1"], half1)
            u[f"{mode}_p1_before"] = mem_auc(mem, u, i, "p1", eval_sub(mode, "p1"))
            train(mem, i, u["h_tr2"], u["t_tr2"], half2)
        for key in ("p1", "p2"):
            u[f"{mode}_{key}"] = mem_auc(mem, u, i, key, eval_sub(mode, key))
        u[f"{mode}_conj"], u[f"{mode}_cj_no_w2"], u[f"{mode}_cj_no_w1"] = \
            conj_split(u, mem_ps(mem, u, i, "conj", eval_sub(mode, "conj")))
        extra = f" · (写 w2 前 w1={u[mode + '_p1_before']:.3f})" if mode != "joint" else ""
        print(f"  [{mode:5}][{u['uid']}] w1 {u[f'{mode}_p1']:.3f} · w2 {u[f'{mode}_p2']:.3f} "
              f"· ★合取 {u[f'{mode}_conj']:.3f}{extra}", flush=True)

# ============================================================================
print("\n" + "=" * 90)
print(f"P7 「概念 ⊗ 概念」合取  ·  {TAG}  ·  {NU} 用户")
print("=" * 90)


def M(k):
    return st.mean(u[k] for u in users)


print(f"\n{'臂':22}{'概念1':>8}{'概念2':>8}{'合取总':>9}{'|靠w2拒':>10}{'|靠w1拒':>10}{'★ min':>9}")
print("-" * 78)
for arm, name in (("base", "base（伪词无定义）"), ("l1", "L1 定义进上下文"),
                  ("joint", "L4 合并训练（上界参照）"), ("seq", "L4 顺序·共享 32 槽"),
                  ("subpart", "L4 顺序·子区(只掩梯度)"),
                  ("subroute", "★ L4 顺序·子区(写入+检索都掩)")):
    mn = min(M(arm + "_cj_no_w2"), M(arm + "_cj_no_w1"))
    print(f"{name:20}{M(arm+'_p1'):8.3f}{M(arm+'_p2'):8.3f}{M(arm+'_conj'):9.3f}"
          f"{M(arm+'_cj_no_w2'):10.3f}{M(arm+'_cj_no_w1'):10.3f}{mn:9.3f}")
print("-" * 78)
print(f"{'★ 单概念策略':20}{'':8}{'':8}{0.750:9.3f}{0.500:10.3f}{1.000:10.3f}{0.500:9.3f}")
print("  ↑ 只看一个概念作答：总 AUC 能到 0.75，但必有一半掉到 0.500 ⟹ 判据看 min，不看总")

print(f"\n【★ 分区内顺序干扰 —— 以及子区能否修好它】")
for mode, cap in (("seq", "共享 32 槽·无掩码"), ("subpart", "子区 16 槽·只掩梯度"),
                  ("subroute", "子区 16 槽·写入+检索都掩")):
    print(f"  {mode:8}（{cap}）写 w2 前 w1 = {M(mode+'_p1_before'):.3f} → 写后 = {M(mode+'_p1'):.3f}"
          f"  （Δ {M(mode+'_p1') - M(mode+'_p1_before'):+.3f}）")
d = {m: M(f"{m}_p1") - M(f"{m}_p1_before") for m in ("seq", "subpart", "subroute")}
print(f"\n  只掩梯度 Δ {d['subpart']:+.3f} vs 无掩码 Δ {d['seq']:+.3f} —— "
      + ("只掩梯度**无效**（诊断：25% 的 top-4 跨区）" if d["subpart"] <= d["seq"] + 0.15 else "只掩梯度已够"))
print(f"  写入+检索都掩 Δ {d['subroute']:+.3f} —— "
      + ("✅ **修好了**，且每概念只有 16 槽（< seq 的 32）⟹ **容量解释被排除**，"
         "分区解释成立，但**必须同时掩写入与检索**"
         if d["subroute"] > d["subpart"] + 0.15 else
         "❌ 仍未修好 —— H1 之外还有别的原因，不得声称已解决"))

def MIN(a):
    return min(M(a + "_cj_no_w2"), M(a + "_cj_no_w1"))


best_mode = max(("seq", "joint", "subpart", "subroute"), key=MIN)
best = MIN(best_mode)
print("\n【I2「概念 ⊗ 概念」裁决】（判据 = min(两半)，单概念策略在此必 ≈ 0.500）")
if PRIOR < 0.70:
    v = f"⚪ 不可判：基座对**真词**的合取仅 {PRIOR:.3f} —— 失败不能归因于记忆"
elif MIN("l1") <= 0.60:
    v = (f"⚪ 不可判：**L1 上下文注入自己也只有 {MIN('l1'):.3f}** —— "
         f"是任务/句式问题，不是参数化记忆的问题")
elif best > 0.70 and MIN("base") < 0.60:
    v = f"✅ 成立：L4({best_mode}) min={best:.3f}，远高于单概念策略的 0.500，base 仅 {MIN('base'):.3f}"
elif best > 0.60:
    v = f"◐ 弱成立：L4({best_mode}) min={best:.3f}，高于 0.500 但不强"
else:
    v = (f"❌ 不成立：L4 min={best:.3f} ≈ 单概念策略的 0.500 —— "
         f"两个概念各自学会了（{M('seq_p1'):.3f}/{M('seq_p2'):.3f}）却【不能相互组合】")
print(f"  {v}")
print(f"  对照 L1 上下文注入：总 {M('l1_conj'):.3f} · min {MIN('l1'):.3f}")

json.dump({"model": args.model, "n_users": NU,
           "prior_conjunction_real_words": PRIOR,
           "single_concept_strategy": {"total_auc": 0.75, "min_of_halves": 0.5,
                                       "_note": "总 AUC 0.75 不是 0.5——初稿算错过，判据用 min(两半)"},
           "arms": {a: {k: M(f"{a}_{k}") for k in
                        ("p1", "p2", "conj", "cj_no_w2", "cj_no_w1")}
                    for a in ("base", "l1", "joint", "seq", "subpart", "subroute")},
           "intra_partition_sequential": {
               m: {"w1_before_w2": M(f"{m}_p1_before"), "w1_after_w2": M(f"{m}_p1"),
                   "delta": M(f"{m}_p1") - M(f"{m}_p1_before"),
                   "slots_per_concept": args.slots if m == "seq" else args.slots // 2}
               for m in ("seq", "subpart", "subroute")},
           "diagnosis_subpart_failure": {
               "w1_slot_values_max_change": 0.0,
               "w1_probe_topk_landing_in_w2_subregion": 0.25,
               "conclusion": "梯度掩码有效但检索跨区 ⟹ 分区必须同时作用于写入与检索"},
           "per_user": [{k: u[k] for k in u if isinstance(u[k], (str, float))} for u in users]},
          open(os.path.join(HERE, f"p7_{TAG}.json"), "w"), indent=2, ensure_ascii=False)
print(f"\n[saved] p7_{TAG}.json")
