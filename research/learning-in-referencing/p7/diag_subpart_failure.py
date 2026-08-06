"""诊断：子区为何没修好？——先查而非猜（P5 §3 的做法）

假设 H1：子区只掩了【梯度】，没掩【检索】⟹ 推理时 w1 的探针路由进了 w2 的子区。
可证伪的观测量：写完 w2 之后，w1 探针的 top-k 里有多少落在 w2 的子区。
若 ≈ 0，H1 被否，另找原因（例如 w1 的槽虽未被改写，但 lm_head 上的整体偏移变了）。
"""
import os, sys, torch, torch.nn.functional as F, statistics as st, random
R = "/Users/oratis/Documents/LISA/.claude/worktrees/lisa-paper-feedback-4441d1/research/learning-in-referencing"
sys.path[:0] = [os.path.join(R, "p1"), os.path.join(R, "p5")]
import microworld as mw, lexicon
from memory_layer import PartitionedMemoryLayer
from transformers import AutoTokenizer, AutoModelForCausalLM

M = "Qwen/Qwen2.5-1.5B-Instruct"; dev = "mps"
torch.manual_seed(0); rng = random.Random(0)
tok = AutoTokenizer.from_pretrained(M, local_files_only=True)
m = AutoModelForCausalLM.from_pretrained(M, dtype=torch.float32, local_files_only=True).to(dev).eval()
for p in m.parameters(): p.requires_grad_(False)
W = m.lm_head.weight; D = m.config.hidden_size
Y = tok.encode(" Yes", add_special_tokens=False)[0]; N = tok.encode(" No", add_special_tokens=False)[0]
ENTS = list(mw.entities())

@torch.no_grad()
def hid(p):
    return m.model(tok(p, return_tensors="pt")["input_ids"].to(dev)).last_hidden_state[0, -1].detach()

def q(w, b): return f"{w} is a word in Tovi's language.\nQuestion: Is {b} {w}? Answer Yes or No.\nAnswer:"

words, _ = lexicon.make_lexicon(2, seed=7)
w1, w2 = words; col, mat = "red", "wooden"
def dec(attr, val, k=12):
    y = [e for e in ENTS if e[attr] == val]; n = [e for e in ENTS if e[attr] != val]
    rng.shuffle(y); rng.shuffle(n)
    return [(e, 1.0) for e in y[:k//2]] + [(e, 0.0) for e in n[:k-k//2]]
tr1, tr2 = dec("color", col), dec("material", mat)
def pack(w, items):
    return (torch.stack([hid(q(w, mw.describe(e))) for e, _ in items]),
            torch.tensor([t for _, t in items], device=dev))
h1, t1 = pack(w1, tr1); h2, t2 = pack(w2, tr2)

SP_ = 32
mem = PartitionedMemoryLayer(D, 1, SP_, 4).to(dev)
def train(hs, ts, lo, hi, ep=300):
    opt = torch.optim.Adam([mem.keys, mem.values], lr=5e-2)
    for _ in range(ep):
        opt.zero_grad()
        lg = (hs + mem(hs, 0)) @ W.T
        F.binary_cross_entropy_with_logits(lg[:, Y] - lg[:, N], ts).backward()
        with torch.no_grad():
            for pm in (mem.keys, mem.values):
                msk = torch.zeros_like(pm.grad); msk[lo:hi] = 1.0; pm.grad.mul_(msk)
        opt.step()

@torch.no_grad()
def routed(hs):
    """返回每个输入的 top-k 槽下标"""
    K = F.normalize(mem.keys[:SP_], dim=-1)
    out = []
    for i in range(hs.shape[0]):
        sim = K @ F.normalize(hs[i], dim=-1) * mem.temp
        out.append(torch.topk(sim, 4).indices.tolist())
    return out

MID = SP_ // 2
train(h1, t1, 0, MID)
r1_before = routed(h1)
v1_before = mem.values[:MID].clone()
train(h2, t2, MID, SP_)
r1_after = routed(h1)

frac_cross = st.mean(sum(s >= MID for s in r) / len(r) for r in r1_after)
frac_before = st.mean(sum(s >= MID for s in r) / len(r) for r in r1_before)
val_changed = (mem.values[:MID] - v1_before).abs().max().item()

print("=" * 74)
print("诊断：subpart 条件下，写完 w2 后 w1 探针的路由去了哪")
print("=" * 74)
print(f"  w1 的槽（0–{MID-1}）的 values 最大改动量 : {val_changed:.2e}  "
      f"← {'✅ 确实没被改写（梯度掩码有效）' if val_changed < 1e-6 else '🔴 被改写了，梯度掩码失效'}")
print(f"  写 w2 【前】w1 探针 top-4 落在 w2 子区的比例: {frac_before:.3f}")
print(f"  写 w2 【后】w1 探针 top-4 落在 w2 子区的比例: {frac_cross:.3f}")
print()
if frac_cross > 0.2:
    print(f"  ⟹ ✅ H1 成立：**检索跨越了子区**（{frac_cross:.1%} 的 top-4 落进 w2 的槽）。")
    print("     子区只掩了梯度、没掩检索 ⟹ w1 的槽虽完好，输出仍被 w2 的值污染。")
    print("     ★ 可行的修法：检索时也按【词】掩码（词就在提示里，推理时可观测，不算作弊）。")
else:
    print(f"  ⟹ ❌ H1 被否（仅 {frac_cross:.1%} 跨区）。退化另有原因，需继续查。")

# 附：两个概念的探针隐状态有多像（P5 教训里的那个量）
c = F.cosine_similarity(h1.unsqueeze(1), h2.unsqueeze(0), dim=-1)
print(f"\n  附：w1 与 w2 探针隐状态的平均余弦 = {c.mean().item():.4f} "
      f"（P5 记录过同类提示为 0.9937）")

# 结果见 ../p7/README.md §2.2。输出：values 改动量 0.00e+00 · 25% 的 top-4 落进对方子区
