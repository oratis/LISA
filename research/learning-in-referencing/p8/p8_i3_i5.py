"""P8 — 五判据仅存的两格：I3 隐式触发 / I5 抗干扰

I3「隐式触发」：概念**不被问及**也能生效 —— 不是"X 是 romi 吗"，而是**去用它**。
I5「抗干扰」：上下文里塞进无关或**冲突**信息后，概念是否还成立。

★ 为什么 I3 必须换任务形态
  训练与 P5–P7 的探针全是 `Is X w? Yes/No`。若 I3 还用这个句式，测的仍是同形泛化。
  本实验改成**二选一的行动题**：
      "Tovi wants a romi object. (A) a large red wooden ball  (B) a small blue metal cup.
       Answer A or B."
  模型从未在这个句式下见过该词，也没被要求定义它，**必须自发把概念用上**。
  记忆是按**最后位置隐状态**路由的，而这个句式的隐状态与训练时差别很大
  ⟹ 这同时也是对**路由能否泛化到新句式**的直接检验。

  ⚠️ 二选一有**位置偏置**（模型偏好 A 或 B）。每道题**两种顺序各出一次**取平均，
     并单独报告位置偏置本身，否则 accuracy 不可信。

★ I5 的三档干扰（第三档最有信息量）
  none     —— 无干扰（= P5 的 0.992，作参照）
  filler   —— 一段无关长文本（测纯粹的上下文稀释）
  conflict —— **"Note: in some dialects, {word} means {对方的含义}."**
              即**另一位老师的含义以文本形式出现在上下文里**。
              参数里的概念扛不扛得住上下文注入的矛盾？
              ⚠️ 这一格**两种结果都可发表**：扛住 ⟹ 内化是真的；被压过 ⟹ 就是 E5 条件化失败
                 在新位置的复现。**不得只在扛住时才报。**

★ 三道前置检查
  ① base 在**真英语词**上会不会做这个二选一（不会 ⟹ I3 失败不能归因于记忆）
  ② base 在伪词上的 I3（应 ≈ 随机）
  ③ L1 上下文注入臂（它做不到 ⟹ 是任务问题，不是参数化记忆的问题）
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
from probe_metrics import auc                    # noqa: E402  ← 判据只用 AUC（见该文件抬头）

ap = argparse.ArgumentParser()
ap.add_argument("--model", default="Qwen/Qwen2.5-1.5B-Instruct")
ap.add_argument("--slots", type=int, default=32)
ap.add_argument("--topk", type=int, default=4)
ap.add_argument("--epochs", type=int, default=300)
ap.add_argument("--lr", type=float, default=5e-2)
ap.add_argument("--n-train", type=int, default=12)
ap.add_argument("--n-i3", type=int, default=8, help="每人的 I3 行动题数（每题两种顺序各跑一次）")
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
A_ID = tok.encode(" A", add_special_tokens=False)[0]
B_ID = tok.encode(" B", add_special_tokens=False)[0]
ENTS = list(mw.entities())
print(f"[load] done · {dev}\n", flush=True)


@torch.no_grad()
def hidden(prompt):
    ids = tok(prompt, return_tensors="pt")["input_ids"].to(dev)
    return model.model(ids).last_hidden_state[0, -1].detach()


# ---------- 句式 ----------
def q_yesno(word, body, defn=None, distract=""):
    pre = f"{word} means {defn}." if defn else f"{word} is a word in Tovi's language."
    return f"{pre}{distract}\nQuestion: Is {body} {word}? Answer Yes or No.\nAnswer:"


def q_action(word, optA, optB, defn=None, pre=None):
    """★ I3：不问定义，直接要求【用】这个词行动。训练中从未出现过这个句式。

    pre="" 时完全不给前缀（前置检查用真英语词时用，避免套上伪语言框架）。
    """
    if pre is None:
        pre = f"{word} means {defn}." if defn else f"{word} is a word in Tovi's language."
    pre = (pre + "\n") if pre else ""
    return (f"{pre}Tovi wants a {word} object.\n"
            f"(A) {optA}\n(B) {optB}\nWhich one do you hand over? Answer A or B.\nAnswer:")


FILLER = (" The weather has been unusually mild this season, and the local library "
          "extended its opening hours through the end of the month. Several residents "
          "noted that the bus timetable changed again on Tuesday.")


def conflict_note(word, other):
    return f" Note: in some dialects, {word} means {other}."


# ============================================================================
# 前置检查 ①：base 会不会做这个二选一（用真英语词）
# ============================================================================
print("=" * 90)
print("前置检查 ①  base 在【真英语词】上的行动题 —— 不会 ⟹ I3 失败不能归因于记忆")
print("=" * 90)


@torch.no_grad()
def p_A(prompt):
    lg = hidden(prompt) @ W.T
    return torch.softmax(torch.stack([lg[A_ID], lg[B_ID]]), 0)[0].item()


def action_acc(pairs, word=None, defn=None, mem=None, uid=None, pre=None):
    """pairs = [(正确项, 错误项)]；每题**两种顺序各跑一次**（消位置偏置）。

    ★ 判据 = AUC（阈值无关）：正确答案是 A 的题 vs 正确答案是 B 的题，比较 p(A)。
      accuracy 与"选 A 比例"只作**位置偏置的证据**，不作判据（见抬头 🔴）。
    返回 (AUC, 准确率, 选 A 的比例)。
    """
    ok, chose_A, pA_when_A, pA_when_B = [], [], [], []
    for good, bad in pairs:
        for correct_is_A in (True, False):
            oa, ob = (good, bad) if correct_is_A else (bad, good)
            prompt = q_action(word, oa, ob, defn, pre)
            if mem is None:
                pa = p_A(prompt)
            else:
                with torch.no_grad():
                    h = hidden(prompt).unsqueeze(0)
                    lg = (h + mem(h, uid)) @ W.T
                    pa = torch.softmax(torch.stack([lg[0, A_ID], lg[0, B_ID]]), 0)[0].item()
            ok.append((pa > 0.5) == correct_is_A)
            chose_A.append(pa > 0.5)
            (pA_when_A if correct_is_A else pA_when_B).append(pa)
    return auc(pA_when_A, pA_when_B), st.mean(ok), st.mean(chose_A)


prior_auc, prior_acc, prior_bias = [], [], []
for col in mw.COLORS:
    other = [c for c in mw.COLORS if c != col]
    pairs = []
    for _ in range(6):
        g = rng.choice([e for e in ENTS if e["color"] == col])
        b = rng.choice([e for e in ENTS if e["color"] == rng.choice(other)])
        pairs.append((mw.describe(g), mw.describe(b)))
    au, a, bs = action_acc(pairs, word=col, pre="")   # pre="" ⟹ 真英语词不套伪语言框架
    prior_auc.append(au); prior_acc.append(a); prior_bias.append(bs)
    print(f"  '{col}' 行动题 ★AUC {au:.3f} · 准确率 {a:.3f}  (选 A 的比例 {bs:.3f})")
PRIOR = st.mean(prior_auc)
print(f"\n  ★ 平均 AUC {PRIOR:.3f} · 准确率 {st.mean(prior_acc):.3f} · 选 A 比例 {st.mean(prior_bias):.3f} —— "
      + ("✅ base 会做这个句式，I3 可解释" if PRIOR >= 0.75
         else "🔴 base 本身做不了这个句式 —— I3 只能报为不可判"))

# ============================================================================
# 组装：沿用 P5/P6 的 16 用户（8 对冲突词 × 2）
# ============================================================================
pairs_cfg = json.load(open(os.path.join(ROOT, "p1", "isolation_p1.json")))


def train_set(meaning, other, k):
    pos = [e for e in ENTS if e["color"] == meaning]
    negO = [e for e in ENTS if e["color"] == other]
    negR = [e for e in ENTS if e["color"] not in (meaning, other)]
    rng.shuffle(pos); rng.shuffle(negO); rng.shuffle(negR)
    h = k // 2
    sel = [(e, "Yes") for e in pos[:h]] + [(e, "No") for e in negO[:h - 1]] + [(e, "No") for e in negR[:1]]
    rng.shuffle(sel)
    return [(mw.describe(e), lab) for e, lab in sel]


users = []
for pr in pairs_cfg:
    for side in ("teacher_A", "teacher_B"):
        other = pr["teacher_B" if side == "teacher_A" else "teacher_A"]["M"]
        M = pr[side]["M"]
        tr = train_set(M, other, args.n_train)
        seen = {b for b, _ in tr}
        # 探针直接从**未见实体**里平衡取（不靠过滤后碰运气剩多少）
        pv = [e for e in ENTS if e["color"] == M and mw.describe(e) not in seen]
        nv = [e for e in ENTS if e["color"] == other and mw.describe(e) not in seen]
        rng.shuffle(pv); rng.shuffle(nv)
        probe = ([(mw.describe(e), "Yes") for e in pv[:5]] +
                 [(mw.describe(e), "No") for e in nv[:5]])
        # ★ I3 行动题：正确项=自己含义的物体，错误项=**对方含义**的物体（最难的干扰项）
        gp = [e for e in ENTS if e["color"] == M and mw.describe(e) not in seen]
        bp = [e for e in ENTS if e["color"] == other and mw.describe(e) not in seen]
        rng.shuffle(gp); rng.shuffle(bp)
        i3 = [(mw.describe(g), mw.describe(b)) for g, b in zip(gp[:args.n_i3], bp[:args.n_i3])]
        users.append(dict(uid=f'{pr["id"]}-{pr[side]["uid"]}', word=pr["word"], M=M, other=other,
                          train=tr, probe=probe, i3=i3))
NU = len(users)
print(f"\n用户 {NU} · 训练 {args.n_train} 条 · I5 探针 {len(users[0]['probe'])} 条 · "
      f"I3 行动题 {len(users[0]['i3'])} 道（每道两种顺序）")

# ============================================================================
# 训练 L4 记忆（与 P5 相同）
# ============================================================================
print("\n[cache] 训练用隐状态…", flush=True)
for u in users:
    u["h_train"] = torch.stack([hidden(q_yesno(u["word"], b)) for b, _ in u["train"]])
    u["t_train"] = torch.tensor([1.0 if l == "Yes" else 0.0 for _, l in u["train"]], device=dev)

mem = PartitionedMemoryLayer(D, NU, args.slots, args.topk).to(dev)
print("[train] 只训练记忆 keys/values，基座全冻结…", flush=True)
for i, u in enumerate(users):
    lo, hi = mem.partition(i)
    opt = torch.optim.Adam([mem.keys, mem.values], lr=args.lr)
    for _ in range(args.epochs):
        opt.zero_grad()
        lg = (u["h_train"] + mem(u["h_train"], i)) @ W.T
        F.binary_cross_entropy_with_logits(lg[:, YES_ID] - lg[:, NO_ID], u["t_train"]).backward()
        with torch.no_grad():
            for pm in (mem.keys, mem.values):
                m = torch.zeros_like(pm.grad); m[lo:hi] = 1.0; pm.grad.mul_(m)
        opt.step()
print("[train] done")

# ============================================================================
# I3：隐式触发（行动题）
# ============================================================================
print("\n" + "=" * 90)
print("I3 隐式触发 —— 不问定义，要求【用】这个词行动（训练中从未出现的句式）")
print("=" * 90)
for i, u in enumerate(users):
    u["i3_base"], u["i3_base_acc"], u["i3_base_bias"] = action_acc(u["i3"], word=u["word"])
    u["i3_l1"], u["i3_l1_acc"], u["i3_l1_bias"] = action_acc(u["i3"], word=u["word"], defn=u["M"])
    u["i3_l4"], u["i3_l4_acc"], u["i3_l4_bias"] = action_acc(u["i3"], word=u["word"], mem=mem, uid=i)
    print(f"  [{u['uid']:14}] AUC base {u['i3_base']:.3f} · L1 {u['i3_l1']:.3f} · ★L4 {u['i3_l4']:.3f}"
          f"   (L4 acc {u['i3_l4_acc']:.3f}, 选A {u['i3_l4_bias']:.3f})", flush=True)

# ============================================================================
# I5：抗干扰（Yes/No 探针 + 三档干扰）
# ============================================================================
print("\n" + "=" * 90)
print("I5 抗干扰 —— 同一批探针，上下文加三档干扰")
print("=" * 90)


def probe_auc(u, i, defn=None, distract="", use_mem=False):
    ps = []
    for b, _ in u["probe"]:
        h = hidden(q_yesno(u["word"], b, defn, distract))
        with torch.no_grad():
            hh = h.unsqueeze(0)
            lg = ((hh + mem(hh, i)) if use_mem else hh) @ W.T
            ps.append(torch.softmax(torch.stack([lg[0, YES_ID], lg[0, NO_ID]]), 0)[0].item())
    return auc([p for p, (_, l) in zip(ps, u["probe"]) if l == "Yes"],
               [p for p, (_, l) in zip(ps, u["probe"]) if l == "No"])


for i, u in enumerate(users):
    for tagd, dis in (("none", ""), ("filler", FILLER),
                      ("conflict", conflict_note(u["word"], u["other"]))):
        u[f"i5_base_{tagd}"] = probe_auc(u, i, None, dis, False)
        u[f"i5_l1_{tagd}"] = probe_auc(u, i, u["M"], dis, False)
        u[f"i5_l4_{tagd}"] = probe_auc(u, i, None, dis, True)
    print(f"  [{u['uid']:14}] L4  none {u['i5_l4_none']:.3f} · filler {u['i5_l4_filler']:.3f} "
          f"· ★conflict {u['i5_l4_conflict']:.3f}", flush=True)

# ============================================================================
def M(k):
    return st.mean(u[k] for u in users)


print("\n" + "=" * 90)
print(f"P8 I3 / I5  ·  {TAG}  ·  {NU} 用户")
print("=" * 90)

print(f"\n【I3 隐式触发】行动题（判据 = AUC；accuracy 与选 A 比例只作偏置证据）")
print(f"{'臂':22}{'★ AUC':>9}{'accuracy':>11}{'选 A 比例':>12}")
print("-" * 56)
for arm, name in (("base", "base（伪词无定义）"), ("l1", "L1 定义进上下文"), ("l4", "★ L4 参数化记忆")):
    print(f"{name:20}{M('i3_'+arm):9.3f}{M('i3_'+arm+'_acc'):11.3f}{M('i3_'+arm+'_bias'):12.3f}")
print("-" * 56)
print(f"{'（真英语词的先验）':20}{PRIOR:9.3f}{st.mean(prior_acc):11.3f}{st.mean(prior_bias):12.3f}")
if M("i3_l4_bias") > 0.7 or M("i3_l4_bias") < 0.3:
    print(f"  ⚠️ 伪词条件下位置偏置极强（选 A {M('i3_l4_bias'):.3f}）—— "
          f"**accuracy 在这种分布上不可信**，只看 AUC")

print(f"\n【I5 抗干扰】探针 AUC")
print(f"{'臂':22}{'无干扰':>10}{'无关长文':>11}{'★ 冲突定义':>13}{'冲突降幅':>11}")
print("-" * 68)
for arm, name in (("base", "base"), ("l1", "L1 上下文"), ("l4", "★ L4 参数")):
    n, f_, c = M(f"i5_{arm}_none"), M(f"i5_{arm}_filler"), M(f"i5_{arm}_conflict")
    print(f"{name:20}{n:10.3f}{f_:11.3f}{c:13.3f}{c-n:11.3f}")

print("\n【裁决】")
if PRIOR < 0.75:
    print(f"  I3 ⚪ 不可判：base 对真词的行动题 AUC 仅 {PRIOR:.3f}")
elif M("i3_l1") < 0.70:
    print(f"  I3 ⚪ 不可判：L1 上下文注入自己也只有 {M('i3_l1'):.3f} ⟹ 是任务问题")
elif M("i3_l4") > 0.75 and M("i3_base") < 0.62:
    print(f"  I3 ✅ 成立：L4 AUC {M('i3_l4'):.3f} vs base {M('i3_base'):.3f}，"
          f"且该句式训练中从未出现 ⟹ 概念被隐式触发")
elif M("i3_l4") > 0.62:
    print(f"  I3 ◐ 弱成立：L4 AUC {M('i3_l4'):.3f}（base {M('i3_base'):.3f}）—— "
          f"有信号但远弱于 L1 的 {M('i3_l1'):.3f}")
else:
    print(f"  I3 ❌ 不成立：L4 AUC {M('i3_l4'):.3f} ≈ 随机 —— 概念只在训练同形句式下生效，"
          f"**不是隐式触发**。对照 L1 {M('i3_l1'):.3f}（说明任务本身可解）")

dc_l4 = M("i5_l4_conflict") - M("i5_l4_none")
dc_l1 = M("i5_l1_conflict") - M("i5_l1_none")
print(f"  I5 冲突定义：L4 降 {dc_l4:+.3f}（{M('i5_l4_none'):.3f} → {M('i5_l4_conflict'):.3f}）· "
      f"L1 降 {dc_l1:+.3f}")
if dc_l4 > -0.05:
    print("     ✅ 参数里的概念**扛住了**上下文注入的矛盾定义")
elif dc_l4 > -0.20:
    print("     ◐ 部分受影响")
else:
    print("     🔴 被上下文压过 —— 这是 **E5 条件化失败在新位置的复现**，须如实报告，"
          "并说明它对「按对话者隔离」的威胁")

json.dump({"model": args.model, "n_users": NU,
           "prior_action_real_words": {"auc": PRIOR, "acc": st.mean(prior_acc),
                                      "chose_A": st.mean(prior_bias)},
           "_note_I3_metric": "判据是 AUC；accuracy 在选A比例 0.91 的分布上不可信（同 P3/P6 的偏置坑）",
           "I3": {a: {"auc": M(f"i3_{a}"), "acc": M(f"i3_{a}_acc"), "chose_A": M(f"i3_{a}_bias")}
                  for a in ("base", "l1", "l4")},
           "I5": {a: {d: M(f"i5_{a}_{d}") for d in ("none", "filler", "conflict")}
                  for a in ("base", "l1", "l4")},
           "per_user": [{k: u[k] for k in u if isinstance(u[k], (str, float))} for u in users]},
          open(os.path.join(HERE, f"p8_{TAG}.json"), "w"), indent=2, ensure_ascii=False)
print(f"\n[saved] p8_{TAG}.json")
