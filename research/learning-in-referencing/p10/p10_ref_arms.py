"""P10 参照臂：base（无记忆）与 L1（定义进上下文）—— **P10 主脚本漏了这两条**

没有它们，P10 里像「F3 = 0.080」这样的数字**无法解释**：
是记忆把方向学反了，还是**基座在这个格式上本来就反**？
本脚本用**与 P10 完全相同的用户/物体/提示**，只是不挂记忆（base）或把含义写进提示（L1）。
"""
import os, sys, json, random, statistics as st
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path[:0] = [os.path.join(ROOT, "p1"), os.path.join(ROOT, "tools")]
import microworld as mw          # noqa: E402
from probe_metrics import auc    # noqa: E402

M = "Qwen/Qwen2.5-1.5B-Instruct"
TAG = M.split("/")[-1]
random.seed(0); torch.manual_seed(0); rng = random.Random(0)
tok = AutoTokenizer.from_pretrained(M, local_files_only=True)
if tok.pad_token is None:
    tok.pad_token = tok.eos_token
tok.padding_side = "left"
dev = "mps" if torch.backends.mps.is_available() else "cpu"
model = AutoModelForCausalLM.from_pretrained(M, dtype=torch.float32, local_files_only=True).to(dev).eval()
for p in model.parameters():
    p.requires_grad_(False)
ENTS = list(mw.entities())
tid = lambda t: tok.encode(t, add_special_tokens=False)[0]        # noqa: E731
FMT = {"F1 Yes/No": (tid(" Yes"), tid(" No")), "F2 A/B": (tid(" A"), tid(" B")),
       "F3 True/False": (tid(" True"), tid(" False"))}


def enc(ps):
    e = tok(ps, return_tensors="pt", padding=True).to(dev)
    e["position_ids"] = (e["attention_mask"].cumsum(-1) - 1).clamp(min=0)
    return e


def sc(ps, fmt):
    P, N = FMT[fmt]
    with torch.no_grad():
        lg = model(**enc(ps), logits_to_keep=1).logits[:, -1]
        return torch.softmax(torch.stack([lg[:, P], lg[:, N]], -1), -1)[:, 0].tolist()


# ---- 与 p10_forced_binding.py 逐字一致的用户构造（同 seed、同消耗顺序）----
cfg = json.load(open(os.path.join(ROOT, "p1", "isolation_p1.json")))[:8]
words = [c["word"] for c in cfg]
users = []
for i, c in enumerate(cfg):
    A, B = c["teacher_A"]["M"], c["teacher_B"]["M"]
    oa = [mw.describe(e) for e in ENTS if e["color"] == A]
    ob = [mw.describe(e) for e in ENTS if e["color"] == B]
    rng.shuffle(oa); rng.shuffle(ob)
    users.append(dict(uid=c["id"], w1=c["word"], w2=words[(i + 1) % len(words)], cA=A, cB=B,
                      pb_a=oa[6:11], pb_b=ob[6:11]))

res = {}
for arm in ("base", "l1"):
    acc = {f: [] for f in FMT}
    for u in users:
        pre = (f"{u['w1']} means {u['cA']}. {u['w2']} means {u['cB']}." if arm == "l1"
               else f"{u['w1']} and {u['w2']} are words in Tovi's language.")
        w = u["w1"]
        P_, N_ = u["pb_a"], u["pb_b"]
        acc["F1 Yes/No"].append(auc(
            sc([f"{pre}\nQuestion: Is {b} {w}? Answer Yes or No.\nAnswer:" for b in P_], "F1 Yes/No"),
            sc([f"{pre}\nQuestion: Is {b} {w}? Answer Yes or No.\nAnswer:" for b in N_], "F1 Yes/No")))
        mk = lambda g, b: (f"{pre}\nTovi wants a {w} object.\n(A) {g}\n(B) {b}\n"   # noqa: E731
                           f"Which one do you hand over? Answer A or B.\nAnswer:")
        acc["F2 A/B"].append(auc(sc([mk(g, b) for g, b in zip(P_, N_)], "F2 A/B"),
                                 sc([mk(b, g) for g, b in zip(P_, N_)], "F2 A/B")))
        acc["F3 True/False"].append(auc(
            sc([f"{pre}\nStatement: {b} is {w}.\nIs this statement true or false? Answer:" for b in P_], "F3 True/False"),
            sc([f"{pre}\nStatement: {b} is {w}.\nIs this statement true or false? Answer:" for b in N_], "F3 True/False")))
    res[arm] = {f: st.mean(v) for f, v in acc.items()}
    res[arm + "_per_user"] = {u["uid"]: {f: round(acc[f][j], 3) for f in FMT}
                              for j, u in enumerate(users)}
    print(f"{arm:5} " + " · ".join(f"{f}: {res[arm][f]:.3f}" for f in FMT))

print("\n★ 逐用户 base（用来判断某个用户的极端值是记忆学反了、还是基座本来就反）")
print(f"  {'uid':10}" + "".join(f"{f:>16}" for f in FMT))
for uid, d in res["base_per_user"].items():
    print(f"  {uid:10}" + "".join(f"{d[f]:16.3f}" for f in FMT))

json.dump({"model": M, "n_users": len(users),
           "_note": "与 p10_forced_binding.py 同用户同物体同提示；base=不挂记忆，l1=含义写进提示",
           "results": res}, open(os.path.join(HERE, f"p10_ref_{TAG}.json"), "w"),
          indent=2, ensure_ascii=False)
print(f"\n[saved] p10_ref_{TAG}.json")
