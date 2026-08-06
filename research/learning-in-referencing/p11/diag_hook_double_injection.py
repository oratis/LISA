"""隔离 P11 复述控制的 hook 重复注册 bug：1× 注入 vs 2× 注入，w1-only，同一批学到的 v。

p11_lexical_entry.py:346 注册主 hook，:392 在**同一 module** 上又注册一次，392–407 间两个并存。
PyTorch 语义：前一 hook 的返回值作为后一 hook 的 output ⟹ h + v 再 + v = h + 2v。
本脚本对**同一个学到的 v** 分别测 1× 与 2×，w1-only，与 P11 口径一致。
"""
import os, sys, json, statistics as st, random
import torch, torch.nn as nn, torch.nn.functional as F
from transformers import AutoTokenizer, AutoModelForCausalLM
R = "/Users/oratis/Documents/LISA/.claude/worktrees/lisa-paper-feedback-4441d1/research/learning-in-referencing"
sys.path[:0] = [os.path.join(R, "p1"), os.path.join(R, "tools")]
import microworld as mw
M = "Qwen/Qwen2.5-1.5B-Instruct"; torch.manual_seed(0); random.seed(0); rng = random.Random(0)
tok = AutoTokenizer.from_pretrained(M, local_files_only=True); tok.pad_token = tok.pad_token or tok.eos_token
tok.padding_side = "left"; dev = "mps"
m = AutoModelForCausalLM.from_pretrained(M, dtype=torch.float32, local_files_only=True).to(dev).eval()
for p in m.parameters(): p.requires_grad_(False)
D = m.config.hidden_size; ENTS = list(mw.entities())
YES, NO = tok.encode(" Yes", add_special_tokens=False)[0], tok.encode(" No", add_special_tokens=False)[0]
def wseqs(w):
    s=[]
    for t in (w," "+w):
        i=tok.encode(t,add_special_tokens=False)
        if i and i not in s: s.append(i)
    return s
def wmask(ids,w):
    z=torch.zeros(ids.shape,dtype=torch.float32,device=ids.device)
    for b,r in enumerate(ids.tolist()):
        for s in wseqs(w):
            n=len(s)
            for i in range(len(r)-n+1):
                if r[i:i+n]==s: z[b,i:i+n]=1.
    return z
def enc(ps):
    e=tok(ps,return_tensors="pt",padding=True).to(dev)
    e["position_ids"]=(e["attention_mask"].cumsum(-1)-1).clamp(min=0); return e
V=[nn.Parameter(torch.zeros(D,device=dev)),nn.Parameter(torch.zeros(D,device=dev))]
hold={"masks":None}
def hook(_m,_i,out):
    h=out[0] if isinstance(out,tuple) else out
    ms=hold["masks"]
    if not ms or ms[0].shape[:2]!=h.shape[:2]: return out
    h2=h+sum(x.unsqueeze(-1)*v for x,v in zip(ms,V))
    return ((h2,)+out[1:]) if isinstance(out,tuple) else h2
L=7
cfg=json.load(open(os.path.join(R,"p1","isolation_p1.json")))[:4]
words=[c["word"] for c in cfg]; users=[]
for i,c in enumerate(cfg):
    A,B=c["teacher_A"]["M"],c["teacher_B"]["M"]
    oa=[mw.describe(e) for e in ENTS if e["color"]==A]; ob=[mw.describe(e) for e in ENTS if e["color"]==B]
    rng.shuffle(oa); rng.shuffle(ob)
    users.append(dict(uid=c["id"],w1=c["word"],w2=words[(i+1)%len(words)],tr_a=oa[:6],tr_b=ob[:6]))
def echo(u,w,nhooks):
    hs=[m.model.layers[L].register_forward_hook(hook) for _ in range(nhooks)]
    ids=tok(f"Repeat exactly: {w}\nAnswer:",return_tensors="pt")["input_ids"].to(dev); n0=ids.shape[1]
    with torch.no_grad():
        for _ in range(8):
            hold["masks"]=[wmask(ids,u["w1"]),wmask(ids,u["w2"])]
            lg=m(input_ids=ids,attention_mask=torch.ones_like(ids),
                 position_ids=(torch.ones_like(ids).cumsum(-1)-1)).logits[:,-1]
            ids=torch.cat([ids,lg.argmax(-1,keepdim=True)],-1)
    for h_ in hs: h_.remove()
    g=tok.decode(ids[0,n0:],skip_special_tokens=True)
    return float(w.lower() in g.lower().replace(" ","")), g.strip()[:32]
r1,r2=[],[]
for u in users:
    for v in V: v.data.zero_()
    pre=f"{u['w1']} and {u['w2']} are words in Tovi's language."
    objs=u["tr_a"]+u["tr_b"]
    tr=[f"{pre}\nQuestion: Is {b} {u['w1']}? Answer Yes or No.\nAnswer:" for b in objs]+\
       [f"{pre}\nQuestion: Is {b} {u['w2']}? Answer Yes or No.\nAnswer:" for b in objs]
    y=torch.tensor([1.]*6+[0.]*6+[0.]*6+[1.]*6,device=dev)
    e=enc(tr); ms=[wmask(e["input_ids"],u["w1"]),wmask(e["input_ids"],u["w2"])]
    hd=m.model.layers[L].register_forward_hook(hook)
    with torch.no_grad():
        pr={}; hp=m.model.layers[L].register_forward_hook(
            lambda _m,_i,o,_p=pr: _p.__setitem__("h",(o[0] if isinstance(o,tuple) else o).detach()))
        hold["masks"]=ms; m(**e,logits_to_keep=1); hp.remove()
        cap=pr["h"][(ms[0]+ms[1])>0].norm(dim=-1).mean().item()
    opt=torch.optim.Adam(V,lr=5e-2)
    for _ in range(300):
        opt.zero_grad(); hold["masks"]=ms
        lg=m(**e,logits_to_keep=1).logits[:,-1]
        F.binary_cross_entropy_with_logits(lg[:,YES]-lg[:,NO],y).backward(); opt.step()
        with torch.no_grad():
            for v in V:
                n=v.norm()
                if n>cap: v.mul_(cap/n)
    hd.remove()
    a,ga=echo(u,u["w1"],1); b,gb=echo(u,u["w1"],2)
    r1.append(a); r2.append(b)
    print(f"  [{u['uid']}] w1={u['w1']:9} 1×注入 {'✅' if a else '❌'} «{ga}»  |  2×注入 {'✅' if b else '❌'} «{gb}»",flush=True)
print(f"\n  w1-only 复述成功率：**1× 注入 {st.mean(r1):.2f}** vs **2× 注入 {st.mean(r2):.2f}**")
print("  P11 报的是 0.50（8 用户，2× 注入，w1-only）")
print("  ⟹ " + ("**bug 坐实**：1× 明显高于 2×，P11 的复述结论是 hook 重复注册造成的"
        if st.mean(r1)-st.mean(r2)>0.2 else
        "1× 与 2× 差别不大 ⟹ P11 的复述失败**另有原因**，不能归给这个 bug"))

# 实测结果（n=4，L7，w1-only）：1× 注入 复述 0.75 · 2× 注入 0.25
# ⟹ P11 初版报的 0.50 是在 2× 下测的 ⟹「主结果不可解读」的裁决作废。见 p11/README.md §3。
