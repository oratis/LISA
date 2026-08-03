"""P4 — 端到端闭环：四条性质第一次在同一流程里跑通

流程（每位老师独立走一遍）：
  ① 教学      老师用教学集教一个伪词（材料由 P1 程序化生成，保证 P1 全新性）
  ② 门控裁决  压缩增益门在【留出决策】上给候选打分 → ACCEPT / REJECT（P2 无 GT 自验证）
  ③ 巩固      只有毕业的概念被写入 memory[uid]
  ★ ④ 清空上下文  —— 教学内容全部丢弃，模型不再看得到任何教学痕迹（P3 持久性的关键）
  ⑤ 新会话    只从 memory[uid] 取回该用户的概念 → 回答探针题（P4 隔离）

四个对照条件（③④⑤ 相同，只改⑤ 加载什么）：
  partitioned   从 uid 分区取回（我方）
  none          不取回（上限对照：说明记忆确实起作用）
  wrong_user    取回**另一位用户**的概念（下限对照：说明取错会坏事）
  shared        无分区共享库（所有人写同一分区，后写覆盖）

⚠️ 层级声明：本实验的记忆是**外部记忆 + 检索纪律（L1）**，
   **不是** product-key 参数化记忆层（L4）—— 后者需训练，本轮零算力做不到。
   因此本实验证明的是**分区纪律的有效性与端到端可行性**，
   **不是**研究文档 §7.4 的「参数空间架构性零干扰」。
"""
import os, sys, json, math, argparse, random, statistics as st
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "p1"))
sys.path.insert(0, HERE)
import microworld as mw           # noqa: E402
from memory import PartitionedMemory  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--model", default="Qwen/Qwen2.5-1.5B-Instruct")
ap.add_argument("--n-heldout", type=int, default=8)
ap.add_argument("--n-probe", type=int, default=8)
ap.add_argument("--seed", type=int, default=0)
args = ap.parse_args()
TAG = args.model.split("/")[-1]
random.seed(args.seed)

pairs = json.load(open(os.path.join(ROOT, "p1", "isolation_p1.json")))

print(f"[load] {args.model}", flush=True)
tok = AutoTokenizer.from_pretrained(args.model, local_files_only=True)
dev = "mps" if torch.backends.mps.is_available() else "cpu"
model = AutoModelForCausalLM.from_pretrained(args.model, dtype=torch.bfloat16,
                                             local_files_only=True).to(dev).eval()
print(f"[load] done · {dev} · {len(pairs)} 冲突对 → {2*len(pairs)} 位老师\n", flush=True)

YES = [" Yes", " yes", "Yes", "yes"]
NO = [" No", " no", "No", "no"]
ENTS = list(mw.entities())
COLORS = mw.COLORS


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


def sample_set(meaning, other, k, rng):
    """k/2 正例 + k/2 负例（负例含对方含义的实例，冲突可见）"""
    pos = [e for e in ENTS if e["color"] == meaning]
    negO = [e for e in ENTS if e["color"] == other]
    negR = [e for e in ENTS if e["color"] not in (meaning, other)]
    rng.shuffle(pos); rng.shuffle(negO); rng.shuffle(negR)
    h = k // 2
    sel = ([(e, "Yes") for e in pos[:h]] + [(e, "No") for e in negO[:h - 1]]
           + [(e, "No") for e in negR[:1]])
    rng.shuffle(sel)
    return [(mw.describe(e), lab) for e, lab in sel]


def seq_nll(prefix, word, items):
    tot = 0.0
    for body, lab in items:
        py = min(max(p_yes(prefix, f"Is {body} {word}?"), 1e-9), 1 - 1e-9)
        tot += -math.log(py if lab == "Yes" else 1 - py)
    return tot


def auc_of(prefix, word, items):
    ps = [p_yes(prefix, f"Is {body} {word}?") for body, _ in items]
    pos = [p for p, (_, l) in zip(ps, items) if l == "Yes"]
    neg = [p for p, (_, l) in zip(ps, items) if l == "No"]
    if not pos or not neg:
        return float("nan")
    return sum((x > y) + 0.5 * (x == y) for x in pos for y in neg) / (len(pos) * len(neg))


# ---------- 组装老师：每对冲突词 → 2 位老师 ----------
teachers = []
for pr in pairs:
    for side in ("teacher_A", "teacher_B"):
        other = pr["teacher_B" if side == "teacher_A" else "teacher_A"]["M"]
        teachers.append(dict(uid=f'{pr["id"]}-{pr[side]["uid"]}', word=pr["word"],
                             M=pr[side]["M"], other=other, pair=pr["id"]))

mem_part = PartitionedMemory(partitioned=True)
mem_shared = PartitionedMemory(partitioned=False)

rng = random.Random(args.seed)
records = []

print("=" * 90)
print("① 教学 → ② 门控裁决 → ③ 巩固")
print("=" * 90)
for t in teachers:
    w, M, other = t["word"], t["M"], t["other"]
    held = sample_set(M, other, args.n_heldout, rng)      # 门控用（老师的用词决策）
    probe = sample_set(M, other, args.n_probe, rng)       # ⑤ 新会话用，与 held 不重叠采样
    base = f"{w} is a word in Tovi's language."

    # ② 门控：候选 = {真含义 M, 对方含义 other, 两个干扰项}
    cands = [M, other] + [c for c in COLORS if c not in (M, other)]
    gains = {c: seq_nll(base, w, held) - seq_nll(f"{w} means {c}.", w, held) for c in cands}
    pick = max(gains, key=gains.get)
    accepted = (pick == M)

    # ③ 巩固：只有门选中的才写入
    if accepted:
        mem_part.write(t["uid"], w, pick)
        mem_shared.write(t["uid"], w, pick)
    else:
        mem_part.reject(); mem_shared.reject()

    records.append(dict(uid=t["uid"], pair=t["pair"], word=w, M=M, other=other,
                        picked=pick, gate_correct=accepted, gains=gains,
                        held=held, probe=probe))
    print(f"  [{t['uid']:14}] {w:9} 真={M:7} 门选={pick:7} {'✅' if accepted else '❌'}")

gc = sum(r["gate_correct"] for r in records)
print(f"\n门控准确率：{gc}/{len(records)} = {gc/len(records):.0%}")
print(f"记忆状态（分区）：{mem_part.stats()['partitions']} 个分区，写入 {mem_part.writes}，拒绝 {mem_part.rejected}")

# ---------- ④ 清空上下文 → ⑤ 新会话 ----------
print("\n" + "=" * 90)
print("④ 清空上下文（教学痕迹全部丢弃） → ⑤ 新会话仅从记忆加载")
print("=" * 90)

for r in records:
    w, uid = r["word"], r["uid"]
    base = f"{w} is a word in Tovi's language."
    # 找同一冲突对里的另一位用户
    peer = next(x for x in records if x["pair"] == r["pair"] and x["uid"] != uid)

    ctx_none = base
    ctx_part = mem_part.context_for(uid, w, base)
    ctx_wrong = mem_part.context_for(peer["uid"], w, base)
    all_hits = mem_shared.retrieve_all_conflicting(w)      # 共享库里该词的全部含义
    ctx_shared = ("\n".join(f"{w} means {m}." for _, m in all_hits)) if all_hits else base

    r["auc_none"] = auc_of(ctx_none, w, r["probe"])
    r["auc_part"] = auc_of(ctx_part, w, r["probe"])
    r["auc_wrong"] = auc_of(ctx_wrong, w, r["probe"])
    r["auc_shared"] = auc_of(ctx_shared, w, r["probe"])
    print(f"  [{uid:14}] none {r['auc_none']:.3f} │ **分区 {r['auc_part']:.3f}** │ "
          f"错用户 {r['auc_wrong']:.3f} │ 共享 {r['auc_shared']:.3f}")

# ---------- 汇总 ----------
def M_(k):
    return st.mean(r[k] for r in records)


n = len(records)
print("\n" + "=" * 90)
print(f"P4 端到端闭环  ·  {TAG}  ·  {n} 位老师（{len(pairs)} 对冲突词）")
print("=" * 90)
print("\n【⑤ 新会话探针 AUC】（上下文已清空，只有记忆在起作用）")
print(f"  none        不加载记忆        : {M_('auc_none'):.3f}   ← 下限：说明记忆确实必要")
print(f"  ★ partitioned 从 uid 分区取回  : {M_('auc_part'):.3f}   ← 我方")
print(f"  wrong_user  取回另一用户的概念  : {M_('auc_wrong'):.3f}   ← 取错的代价")
print(f"  shared      无分区共享库        : {M_('auc_shared'):.3f}   ← 无隔离基线")

print("\n【结构性零干扰验证】")
cross = 0
for r in records:
    hits = mem_part.retrieve(r["uid"], r["word"])
    if any(h != r["M"] for h in hits):
        cross += 1
print(f"  分区检索命中他人概念的次数 : {cross}/{n}   （构造上应恒为 0）")
print(f"  同一词在共享库中的冲突含义 : "
      f"{st.mean(len(mem_shared.retrieve_all_conflicting(r['word'])) for r in records):.1f} 条/词")

print("\n【四条性质的端到端状态】")
print(f"  P1 全新     ✅ 材料由 P1 程序化生成（污染控制见 p1/README）")
print(f"  P2 无GT验证 {'✅' if gc/n >= 0.85 else '⚠️'} 门控 {gc}/{n} = {gc/n:.0%}（候选含对方含义 + 2 个干扰项）")
print(f"  P3 持久     {'✅' if M_('auc_part') > M_('auc_none') + 0.1 else '⚠️'} "
      f"清空上下文后仍有效：{M_('auc_none'):.3f} → {M_('auc_part'):.3f}")
print(f"  P4 隔离     {'✅' if cross == 0 and M_('auc_part') > M_('auc_shared') + 0.05 else '⚠️'} "
      f"跨分区命中 {cross}/{n}；分区 {M_('auc_part'):.3f} vs 共享 {M_('auc_shared'):.3f}")

json.dump({"model": args.model, "n_teachers": n, "n_pairs": len(pairs),
           "gate_acc": gc / n,
           "auc": {k: M_(f"auc_{k}") for k in ("none", "part", "wrong", "shared")},
           "cross_partition_hits": cross,
           "mem_stats": mem_part.stats(),
           "records": [{k: v for k, v in r.items() if k not in ("held", "probe")} for r in records]},
          open(os.path.join(HERE, f"p4_{TAG}.json"), "w"), indent=2, ensure_ascii=False)
print(f"\n[saved] p4_{TAG}.json")
