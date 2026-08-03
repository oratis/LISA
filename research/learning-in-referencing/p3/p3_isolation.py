"""P3 — 冲突词隔离测试：P4 性质（按对话者隔离）的实证

材料：p1/isolation_p1.json 的 8 对**冲突词**——同一个伪词，两位老师教**互斥**的含义
（如 komalor：老师 A 说 = blue，老师 B 说 = red）。
冲突设计的好处：泄漏**必然可见**，无需统计推断（DESIGN_CONCEPT_BENCH §6）。

本脚本回答两个问题（Q2 才是重点）：

  Q1 泄漏：共享上下文时，对用户 A 的回答是否被 B 的教学污染？
     · 分区条件 (partitioned)：上下文只含 A 的概念
     · 共享条件 (shared)     ：上下文同时含 A 与 B 的概念
     · 泄漏率 = 共享条件下决策翻转的比例（对标 PersistBench cross-domain 中位 53%）

  ★ Q2 门控在冲突下是否仍准：压缩增益门本身会不会被冲突带偏？
     · 用 A 的留出决策给候选 {M_A, M_B} 打分
     · 分区：上下文只含 A 的概念 → 门应选 M_A
     · 共享：上下文含 A+B → 门还选 M_A 吗？
     这测的是**机制**在冲突下的稳健性，而非只测模型。

留出集由微世界程序化生成（每位老师 8 条：4 正 4 负），不复用单条 probe。
"""
import os, sys, json, math, argparse, random, statistics as st
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM

HERE = os.path.dirname(os.path.abspath(__file__))
P1 = os.path.join(os.path.dirname(HERE), "p1")
sys.path.insert(0, P1)
import microworld as mw  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--model", default="Qwen/Qwen2.5-1.5B-Instruct")
ap.add_argument("--n-heldout", type=int, default=8)
ap.add_argument("--seed", type=int, default=0)
args = ap.parse_args()
TAG = args.model.split("/")[-1]
random.seed(args.seed)

pairs = json.load(open(os.path.join(P1, "isolation_p1.json")))

print(f"[load] {args.model}", flush=True)
tok = AutoTokenizer.from_pretrained(args.model, local_files_only=True)
dev = "mps" if torch.backends.mps.is_available() else "cpu"
model = AutoModelForCausalLM.from_pretrained(args.model, dtype=torch.bfloat16,
                                             local_files_only=True).to(dev).eval()
print(f"[load] done · {dev} · {len(pairs)} 冲突对\n", flush=True)

YES = [" Yes", " yes", "Yes", "yes"]
NO = [" No", " no", "No", "no"]
ENTS = list(mw.entities())   # ⚠️ entities() 是生成器，必须固化，否则第二个 item 起为空


@torch.no_grad()
def p_yes(prefix, qbody):
    p = f"{prefix}\nQuestion: {qbody} Answer Yes or No.\nAnswer:"
    ids = tok(p, return_tensors="pt")["input_ids"].to(dev)
    lp = torch.log_softmax(model(ids).logits[0, -1].float(), -1)

    def best(cs):
        v = -1e9
        for c in cs:
            t = tok.encode(c, add_special_tokens=False)
            if t:
                v = max(v, lp[t[0]].item())
        return v
    y, n = best(YES), best(NO)
    m = max(y, n)
    tot = m + math.log(math.exp(y - m) + math.exp(n - m))
    return math.exp(y - tot)


def heldout_for(meaning, other_meaning, k):
    """按 meaning（颜色词）生成留出决策：k/2 条正例 + k/2 条负例。
    负例刻意包含【对方老师含义】的实例——这正是冲突可见的地方。"""
    pos = [e for e in ENTS if e["color"] == meaning]
    neg_other = [e for e in ENTS if e["color"] == other_meaning]      # 对方为真、我方为假
    neg_rest = [e for e in ENTS if e["color"] not in (meaning, other_meaning)]
    random.shuffle(pos); random.shuffle(neg_other); random.shuffle(neg_rest)
    half = k // 2
    sel = ([(e, "Yes") for e in pos[:half]]
           + [(e, "No") for e in neg_other[:half - 1]]
           + [(e, "No") for e in neg_rest[:1]])
    return [(mw.describe(e), lab) for e, lab in sel]


def ctx_partitioned(word, meaning):
    return f"{word} means {meaning}."


def ctx_shared(word, mine, theirs):
    """共享条件：两位老师的教学都在上下文里（模拟无隔离的共享记忆）"""
    return f"{word} means {mine}.\n{word} means {theirs}."


def seq_nll(prefix, word, held):
    tot = 0.0
    for body, lab in held:
        py = min(max(p_yes(prefix, f"Is {body} {word}?"), 1e-9), 1 - 1e-9)
        tot += -math.log(py if lab == "Yes" else 1 - py)
    return tot


def discriminability(prefix, word, held):
    """阈值无关的判别力：p_yes 对 Yes 项 vs No 项的 AUC。

    ⚠️ 为何不用 0.5 阈值（实测教训）：模型对陌生伪词谓词有系统性 **No 偏置**
    ——「komalor means blue.」下蓝色项 p_yes 仅 0.245–0.349、红色项 0.020–0.023。
    判别信号强（约 14×）但绝对值全在 0.5 以下，用固定阈值会得到准确率 0.00 的假象。
    压缩门用连续 NLL 而非阈值化决策，故不受该偏置影响——这也是 AUC 才是正确度量的原因。"""
    ps = [p_yes(prefix, f"Is {body} {word}?") for body, _ in held]
    pos = [p for p, (_, lab) in zip(ps, held) if lab == "Yes"]
    neg = [p for p, (_, lab) in zip(ps, held) if lab == "No"]
    if not pos or not neg:
        return float("nan"), ps
    a = sum((x > y) + 0.5 * (x == y) for x in pos for y in neg) / (len(pos) * len(neg))
    return a, ps


rows = []
for pr in pairs:
    w = pr["word"]
    mA, mB = pr["teacher_A"]["M"], pr["teacher_B"]["M"]
    heldA = heldout_for(mA, mB, args.n_heldout)

    part = ctx_partitioned(w, mA)
    shar = ctx_shared(w, mA, mB)
    base = f"{w} is a word in Tovi's language."

    # ---- Q1 泄漏：对 A 的留出决策，分区 vs 共享 ----
    auc_part, ps_part = discriminability(part, w, heldA)
    auc_shar, ps_shar = discriminability(shar, w, heldA)

    # ---- Q2 门控在冲突下是否仍准 ----
    def gain(ctx_fn, cand):
        """压缩增益：以 A 的留出决策为观测量，比较候选 cand"""
        return seq_nll(base, w, heldA) - seq_nll(ctx_fn(cand), w, heldA)

    g_part_A = gain(lambda c: ctx_partitioned(w, c), mA)
    g_part_B = gain(lambda c: ctx_partitioned(w, c), mB)
    # 共享条件下：候选仍是 mA / mB，但上下文里两者都在（污染基线）
    g_shar_A = seq_nll(base, w, heldA) - seq_nll(ctx_shared(w, mA, mB), w, heldA)
    g_shar_B = seq_nll(base, w, heldA) - seq_nll(ctx_shared(w, mB, mA), w, heldA)

    rows.append(dict(
        id=pr["id"], word=w, mA=mA, mB=mB,
        auc_part=auc_part, auc_shar=auc_shar, n_held=len(heldA),
        gate_part_correct=g_part_A > g_part_B,
        gate_shar_correct=g_shar_A > g_shar_B,
        g_part_A=g_part_A, g_part_B=g_part_B,
        g_shar_A=g_shar_A, g_shar_B=g_shar_B,
    ))
    r = rows[-1]
    print(f"[{pr['id']}] {w}: A={mA} B={mB} │ 判别AUC 分区 {r['auc_part']:.3f} → 共享 {r['auc_shar']:.3f} "
          f"│ 门 分区 {'✅' if r['gate_part_correct'] else '❌'} "
          f"共享 {'✅' if r['gate_shar_correct'] else '❌'}", flush=True)

n = len(rows)
tot_held = sum(r["n_held"] for r in rows)
acc_p = st.mean(r["auc_part"] for r in rows)
acc_s = st.mean(r["auc_shar"] for r in rows)
gp = sum(r["gate_part_correct"] for r in rows)
gs = sum(r["gate_shar_correct"] for r in rows)

print("\n" + "=" * 84)
print(f"P3 冲突词隔离测试  ·  {TAG}  ·  {n} 对 × {args.n_heldout} 条留出")
print("=" * 84)
print("\n【Q1 泄漏】对用户 A 留出集的判别 AUC（阈值无关）")
print(f"  分区（只含 A 的概念）    : {acc_p:.3f}")
print(f"  共享（A+B 都在上下文）   : {acc_s:.3f}")
print(f"  ⟹ 泄漏导致的判别力下降    : {acc_p - acc_s:+.3f}")
degr = sum(1 for r in rows if r["auc_shar"] < r["auc_part"] - 1e-9)
print(f"  判别力下降的对数          : {degr}/{n}")
print(f"  （对标 PersistBench cross-domain 泄漏中位 53%，但度量不同，勿直接比数值）")

print("\n【★ Q2 门控在冲突下是否仍准】压缩门能否选出 A 的真实含义")
print(f"  分区条件 : {gp}/{n} = {gp/n:.0%}")
print(f"  共享条件 : {gs}/{n} = {gs/n:.0%}")

print("\n" + "=" * 84)
if gp / n >= 0.875 and (acc_p - acc_s) > 0.03:
    v = "✅ 隔离必要性成立：共享上下文确实污染决策，分区后门控准确"
elif gp / n >= 0.875:
    v = "◐ 门控在分区下准确，但共享条件未显著劣化——泄漏未复现，须如实报告"
else:
    v = "❌ 门控在分区条件下就不准 —— 隔离主张受损，须如实报告"
print(f"裁决：{v}")

json.dump({"model": args.model, "n_pairs": n, "n_heldout": args.n_heldout,
           "auc_partitioned": acc_p, "auc_shared": acc_s, "n_degraded": degr,
           "gate_partitioned": gp / n, "gate_shared": gs / n, "rows": rows},
          open(os.path.join(HERE, f"p3_{TAG}.json"), "w"), indent=2, ensure_ascii=False)
print(f"\n[saved] p3_{TAG}.json")
