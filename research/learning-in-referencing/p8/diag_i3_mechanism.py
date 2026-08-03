"""诊断 I3 为何零迁移 —— 两个互斥假设，先查而非猜

H_route  : 新句式的隐状态落到了**别的槽** ⟹ 检索都没取到概念
H_readout: 槽取对了，但学到的 value 只沿 **W_yes − W_no** 方向推，
           而行动题要的是 **W_A − W_B** 方向；两者近乎正交 ⟹ 取到了也没用

可区分的观测量：
  ① 行动题的 top-k 与训练提示的 top-k 的重合率      → 低则 H_route
  ② m(h) 与 (W_yes−W_no) / (W_A−W_B) 的余弦          → 只对齐前者则 H_readout
  ③ 训练提示与行动提示的隐状态余弦
"""
import os, sys, json, random, statistics as st
import torch, torch.nn.functional as F
R = "/Users/oratis/Documents/LISA/.claude/worktrees/lisa-paper-feedback-4441d1/research/learning-in-referencing"
sys.path[:0] = [os.path.join(R, "p1"), os.path.join(R, "p5")]
import microworld as mw
from memory_layer import PartitionedMemoryLayer
from transformers import AutoTokenizer, AutoModelForCausalLM

M_ = "Qwen/Qwen2.5-1.5B-Instruct"; dev = "mps"
torch.manual_seed(0); rng = random.Random(0)
tok = AutoTokenizer.from_pretrained(M_, local_files_only=True)
m = AutoModelForCausalLM.from_pretrained(M_, dtype=torch.float32, local_files_only=True).to(dev).eval()
for p in m.parameters(): p.requires_grad_(False)
W = m.lm_head.weight; D = m.config.hidden_size
Y = tok.encode(" Yes", add_special_tokens=False)[0]; N = tok.encode(" No", add_special_tokens=False)[0]
A = tok.encode(" A", add_special_tokens=False)[0];  B = tok.encode(" B", add_special_tokens=False)[0]
ENTS = list(mw.entities())

@torch.no_grad()
def hid(p): return m.model(tok(p, return_tensors="pt")["input_ids"].to(dev)).last_hidden_state[0,-1].detach()
def q_yn(w,b): return f"{w} is a word in Tovi's language.\nQuestion: Is {b} {w}? Answer Yes or No.\nAnswer:"
def q_act(w,a,b_):
    return (f"{w} is a word in Tovi's language.\nTovi wants a {w} object.\n"
            f"(A) {a}\n(B) {b_}\nWhich one do you hand over? Answer A or B.\nAnswer:")

w, col, other = "komalor", "blue", "red"
pos = [e for e in ENTS if e["color"]==col]; neg=[e for e in ENTS if e["color"]==other]
rng.shuffle(pos); rng.shuffle(neg)
tr = [(mw.describe(e),1.0) for e in pos[:6]] + [(mw.describe(e),0.0) for e in neg[:6]]
h_tr = torch.stack([hid(q_yn(w,b)) for b,_ in tr]); t_tr = torch.tensor([t for _,t in tr], device=dev)
h_act = torch.stack([hid(q_act(w, mw.describe(g), mw.describe(b_))) for g,b_ in zip(pos[6:12], neg[6:12])])

SP_=32; mem = PartitionedMemoryLayer(D,1,SP_,4).to(dev)
opt = torch.optim.Adam([mem.keys, mem.values], lr=5e-2)
for _ in range(300):
    opt.zero_grad()
    lg = (h_tr + mem(h_tr,0)) @ W.T
    F.binary_cross_entropy_with_logits(lg[:,Y]-lg[:,N], t_tr).backward(); opt.step()

@torch.no_grad()
def topk(hs):
    K = F.normalize(mem.keys[:SP_], dim=-1)
    return [set(torch.topk(K @ F.normalize(hs[i],dim=-1) * mem.temp, 4).indices.tolist())
            for i in range(hs.shape[0])]

tk_tr, tk_act = topk(h_tr), topk(h_act)
train_slots = set().union(*tk_tr)
overlap = st.mean(len(s & train_slots)/len(s) for s in tk_act)

with torch.no_grad():
    m_tr = mem(h_tr,0).mean(0); m_act = mem(h_act,0).mean(0)
    d_yn = W[Y]-W[N]; d_ab = W[A]-W[B]
    cos = lambda a,b: F.cosine_similarity(a.unsqueeze(0), b.unsqueeze(0)).item()
    hs_cos = F.cosine_similarity(h_tr.unsqueeze(1), h_act.unsqueeze(0), dim=-1).mean().item()

print("="*80); print("诊断：I3 零迁移的机制"); print("="*80)
print(f"① 行动题 top-4 落在【训练时用过的槽】的比例 : {overlap:.3f}   "
      f"({'✅ 检索取到了概念' if overlap>0.5 else '🔴 检索没取到 ⟹ H_route'})")
print(f"   训练提示用到的不同槽数: {len(train_slots)}/{SP_}")
print(f"\n② 记忆输出 m(h) 与两个读出方向的余弦")
print(f"   训练提示 m(h) · (W_yes−W_no) : {cos(m_tr,d_yn):+.4f}")
print(f"   训练提示 m(h) · (W_A −W_B )  : {cos(m_tr,d_ab):+.4f}")
print(f"   行动提示 m(h) · (W_yes−W_no) : {cos(m_act,d_yn):+.4f}")
print(f"   行动提示 m(h) · (W_A −W_B )  : {cos(m_act,d_ab):+.4f}")
print(f"   两读出方向本身的余弦          : {cos(d_yn,d_ab):+.4f}   ← 接近 0 即近乎正交")
print(f"\n③ 训练提示 vs 行动提示 隐状态平均余弦 : {hs_cos:.4f}")
print(f"   ‖m(h_act)‖ = {m_act.norm():.3f} · ‖m(h_tr)‖ = {m_tr.norm():.3f}")
print(f"   ‖W_A−W_B‖ = {d_ab.norm():.3f} · ‖W_yes−W_no‖ = {d_yn.norm():.3f}")
print("\n⟹ " + ("H_route：新句式检索不到概念（重合率低）" if overlap<=0.5 else
      "H_readout：检索取到了，但值只沿 Yes−No 方向推，对 A−B 无效"
      if abs(cos(m_act,d_ab)) < 0.1 else "两者皆非，需继续查"))

# 结果见 ../p8/README.md §3。输出：重合率 0.750 · m·(W_yes−W_no)=+0.7926 · m·(W_A−W_B)=+0.0027
