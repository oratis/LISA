"""P5 — L4 参数化记忆：把 P4 的外部记忆升级为参数，检验 I1 免检索

核心问题：概念写进**参数**后，能否在**上下文里完全不提该概念**的情况下生效？
（这是 P4 的 L1 方案不满足的判据 I1；满足它才谈得上"学会了"而非"知道有这回事"）

设计（详见 memory_layer.py 的诚实定位）：
  · 冻结 Qwen2.5-1.5B 全部权重
  · 缓存每条训练/评测提示的 **post-norm 最后位置隐状态** h（一次前向，无梯度）
  · 记忆层：logits = lm_head(h + m(h))，m 为 uid 分区的 product-key 稀疏槽
  · **只训练 keys/values**，梯度不经过任何 transformer block → 单机可训

⚠️ 训练数据 = 老师的**用词决策**（P4 中门控放行的那些），**不是关于概念对错的答案**。

四个评测：
  E1 ★ I1 免检索  ：上下文**不含**任何概念陈述 → 记忆能否让模型答对？
  E2   泛化       ：训练用留出集，评测用**独立采样**的探针集
  E3 ★ P4 隔离    ：用错分区 / 分区互斥性（构造性 + 实证）
  E4 ★ 顺序写入    ：逐个用户写入，每写一个测**全部先前用户**的保持率
                    —— 这是研究文档 §7.3.4 点名的空白实验（vs ROME/MEMIT 10–40 次崩溃）
"""
import os, sys, json, math, argparse, random, statistics as st
import torch
import torch.nn.functional as F
from transformers import AutoTokenizer, AutoModelForCausalLM

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "p1")); sys.path.insert(0, HERE)
import microworld as mw                       # noqa: E402
from memory_layer import PartitionedMemoryLayer  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--model", default="Qwen/Qwen2.5-1.5B-Instruct")
ap.add_argument("--slots", type=int, default=32)
ap.add_argument("--topk", type=int, default=4)
ap.add_argument("--epochs", type=int, default=300)
ap.add_argument("--lr", type=float, default=5e-2)
ap.add_argument("--n-train", type=int, default=12)
ap.add_argument("--n-probe", type=int, default=10)
ap.add_argument("--seed", type=int, default=0)
ap.add_argument("--shared", action="store_true",
                help="消融：所有用户共用同一槽池（总容量相同、不分区、梯度不掩码）。"
                     "这才是「顺序写入是否崩塌」的有意义对照——分区版的零退化是构造性的。")
args = ap.parse_args()
TAG = args.model.split("/")[-1]
torch.manual_seed(args.seed); random.seed(args.seed)

pairs = json.load(open(os.path.join(ROOT, "p1", "isolation_p1.json")))
print(f"[load] {args.model}", flush=True)
tok = AutoTokenizer.from_pretrained(args.model, local_files_only=True)
dev = "mps" if torch.backends.mps.is_available() else "cpu"
model = AutoModelForCausalLM.from_pretrained(args.model, dtype=torch.float32,
                                             local_files_only=True).to(dev).eval()
for p in model.parameters():
    p.requires_grad_(False)
D = model.config.hidden_size
ENTS = list(mw.entities())
print(f"[load] done · {dev} · d_model={D}\n", flush=True)

YES_ID = tok.encode(" Yes", add_special_tokens=False)[0]
NO_ID = tok.encode(" No", add_special_tokens=False)[0]


@torch.no_grad()
def hidden(prompt):
    """post-norm 最后位置隐状态（lm_head 的直接输入）"""
    ids = tok(prompt, return_tensors="pt")["input_ids"].to(dev)
    out = model.model(ids)                      # 不过 lm_head
    h = out.last_hidden_state[0, -1]            # Qwen 的 model.model 已含 final norm
    return h.detach()


def ask(word, body, concept=None):
    pre = f"{word} means {concept}." if concept else f"{word} is a word in Tovi's language."
    return f"{pre}\nQuestion: Is {body} {word}? Answer Yes or No.\nAnswer:"


def sample_set(meaning, other, k, rng):
    pos = [e for e in ENTS if e["color"] == meaning]
    negO = [e for e in ENTS if e["color"] == other]
    negR = [e for e in ENTS if e["color"] not in (meaning, other)]
    rng.shuffle(pos); rng.shuffle(negO); rng.shuffle(negR)
    h = k // 2
    sel = ([(e, "Yes") for e in pos[:h]] + [(e, "No") for e in negO[:h - 1]]
           + [(e, "No") for e in negR[:1]])
    rng.shuffle(sel)
    return [(mw.describe(e), lab) for e, lab in sel]


# ---------- 组装 16 位用户 ----------
rng = random.Random(args.seed)
users = []
for pr in pairs:
    for side in ("teacher_A", "teacher_B"):
        other = pr["teacher_B" if side == "teacher_A" else "teacher_A"]["M"]
        M = pr[side]["M"]
        users.append(dict(uid=f'{pr["id"]}-{pr[side]["uid"]}', word=pr["word"], M=M, other=other,
                          train=sample_set(M, other, args.n_train, rng),
                          probe=sample_set(M, other, args.n_probe, rng)))
NU = len(users)
print(f"用户数 {NU} · 每人训练 {args.n_train} 条 / 探针 {args.n_probe} 条")

# ---------- 缓存隐状态（★ 全部在【无概念上下文】下缓存 → 检验 I1）----------
print("[cache] 计算隐状态（一次前向，无梯度）…", flush=True)
for u in users:
    u["h_train"] = torch.stack([hidden(ask(u["word"], b)) for b, _ in u["train"]])
    u["y_train"] = torch.tensor([YES_ID if l == "Yes" else NO_ID for _, l in u["train"]], device=dev)
    u["h_probe"] = torch.stack([hidden(ask(u["word"], b)) for b, _ in u["probe"]])
    u["y_probe"] = [l for _, l in u["probe"]]
print("[cache] done\n", flush=True)

W = model.lm_head.weight            # [V, d] 冻结
if args.shared:
    # 同等总容量（NU*slots），但只有 1 个分区 → 所有用户共用、梯度不掩码
    mem = PartitionedMemoryLayer(D, 1, NU * args.slots, args.topk).to(dev)
    def part_of(i): return 0
else:
    mem = PartitionedMemoryLayer(D, NU, args.slots, args.topk).to(dev)
    def part_of(i): return i
    assert mem.partitions_disjoint(), "分区必须互不相交"
MODE = "共享槽（消融）" if args.shared else "uid 分区"


def logits_of(h, uid_idx, use_mem=True):
    hh = h + mem(h, uid_idx) if use_mem else h
    return hh @ W.T


def acc_auc(u, uid_idx, use_mem=True):
    """探针集上的 AUC（p_yes 对 Yes/No 项）—— 阈值无关，同 P3/P4 口径"""
    with torch.no_grad():
        lg = logits_of(u["h_probe"], uid_idx, use_mem)
        p = torch.softmax(torch.stack([lg[:, YES_ID], lg[:, NO_ID]], -1), -1)[:, 0].tolist()
    pos = [x for x, l in zip(p, u["y_probe"]) if l == "Yes"]
    neg = [x for x, l in zip(p, u["y_probe"]) if l == "No"]
    if not pos or not neg:
        return float("nan")
    return sum((a > b) + 0.5 * (a == b) for a in pos for b in neg) / (len(pos) * len(neg))


# ---------- E4：顺序写入（逐个用户），每写一个测全部先前用户 ----------
print("=" * 88)
print("★ 顺序写入：逐用户训练，每写完一个测【全部先前用户】的保持率")
print("=" * 88)
base_auc = [acc_auc(u, part_of(i), use_mem=False) for i, u in enumerate(users)]
print(f"写入前基线（无记忆）平均 AUC = {st.mean(base_auc):.3f}\n")

retention, curve = [], []
for i, u in enumerate(users):
    lo, hi = mem.partition(part_of(i))
    # ★ 只优化该 uid 分区的槽（其它分区的梯度被 mask 掉 → 结构性不互相干扰）
    opt = torch.optim.Adam([mem.keys, mem.values], lr=args.lr)
    tgt = (u["y_train"] == YES_ID).float()
    for ep in range(args.epochs):
        opt.zero_grad()
        lg = logits_of(u["h_train"], part_of(i))
        # ★ 二元损失：只看 Yes/No 两个 logit 之差。
        # 第一版用全词表 CE 完全无效（见 README §3 失败记录）——151k 词表把二元信号稀释了。
        loss = F.binary_cross_entropy_with_logits(lg[:, YES_ID] - lg[:, NO_ID], tgt)
        loss.backward()
        if not args.shared:                        # 分区版：只让本分区的槽更新
            with torch.no_grad():
                for pmt in (mem.keys, mem.values):
                    g = pmt.grad
                    m = torch.zeros_like(g); m[lo:hi] = 1.0
                    g.mul_(m)
        opt.step()
    with torch.no_grad():
        lgt = logits_of(u["h_train"], part_of(i))
        tr_acc = (((lgt[:, YES_ID] - lgt[:, NO_ID]) > 0).float() == tgt).float().mean().item()
    seen = [acc_auc(users[j], part_of(j)) for j in range(i + 1)]
    curve.append(dict(n_written=i + 1, train_acc=tr_acc, mean_auc_seen=st.mean(seen),
                      min_auc_seen=min(seen), self_auc=seen[-1]))
    print(f"  写入 {i+1:2d}/{NU} [{u['uid']:14}] loss {loss.item():.4f} 训练acc {tr_acc:.2f} │ "
          f"自身 AUC {seen[-1]:.3f} │ 已写入用户均值 {st.mean(seen):.3f} (最低 {min(seen):.3f})")

final = [acc_auc(u, part_of(i)) for i, u in enumerate(users)]

# ---------- E3：隔离 ----------
wrong = []
for i, u in enumerate(users):
    j = (i + 1) % NU                      # 用别人的分区回答我的探针
    wrong.append(acc_auc(u, part_of(j)))

# ---------- 汇总 ----------
print("\n" + "=" * 88)
print(f"P5 L4 参数化记忆  ·  {TAG}  ·  【{MODE}】 {NU} 用户 × {args.slots} 槽/人 · top-{args.topk}")
print("=" * 88)
print("\n【★ E1 免检索（I1）】上下文**完全不含**概念陈述，只有参数在起作用")
print(f"  无记忆（冻结基座）        : {st.mean(base_auc):.3f}   ← 下限")
print(f"  ★ 参数化记忆（自己的分区） : {st.mean(final):.3f}")
print(f"  提升                      : {st.mean(final) - st.mean(base_auc):+.3f}")

print("\n【E3 隔离】")
print(f"  用**他人分区**回答自己的探针 : {st.mean(wrong):.3f}")
print(f"  键空间分区互不相交（构造性） : {mem.partitions_disjoint()}")

print("\n【★ E4 顺序写入的保持率】（研究文档 §7.3.4 点名的空白实验）")
print(f"  {'已写入':>6} {'先前用户均值 AUC':>16} {'最低':>8}")
for c in curve:
    print(f"  {c['n_written']:6d} {c['mean_auc_seen']:16.3f} {c['min_auc_seen']:8.3f}")
first, last = curve[0]["mean_auc_seen"], curve[-1]["mean_auc_seen"]
print(f"\n  写 1 个 → 写 {NU} 个：{first:.3f} → {last:.3f}（Δ {last-first:+.3f}）")
print(f"  对照：ROME/MEND 报告 10–20 次顺序编辑即退化/collapse，MEMIT 约 40 次")
print(f"  ⚠️ **非同基准对比**（判分口径与编辑粒度均不同），仅作量级参照")

json.dump({"model": args.model, "mode": MODE, "shared": args.shared, "n_users": NU, "slots_per_uid": args.slots, "topk": args.topk,
           "epochs": args.epochs, "lr": args.lr,
           "auc_base": st.mean(base_auc), "auc_mem": st.mean(final),
           "auc_wrong_partition": st.mean(wrong),
           "partitions_disjoint": mem.partitions_disjoint(),
           "retention_curve": curve,
           "per_user": [{"uid": u["uid"], "base": base_auc[i], "mem": final[i], "wrong": wrong[i]}
                        for i, u in enumerate(users)]},
          open(os.path.join(HERE, f"p5_{'shared' if args.shared else 'part'}_{TAG}.json"), "w"),
          indent=2, ensure_ascii=False)
print(f"\n[saved] p5_{'shared' if args.shared else 'part'}_{TAG}.json")
