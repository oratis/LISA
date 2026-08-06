"""P0f — G4（论元顺序）失败归因：能力缺失 vs 变量绑定 vs 提示格式

P0e 发现：G4 上 |ΔNLL| 仅 0.90（其他类 4.74），AUC 0.562 ≈ 随机 —— 定义完全不改变模型预测。

三种互斥解释，本脚本分开它们：
  (A) 关系本身无能力        —— 模型判断不了"谁给谁"
  (B) 变量绑定失败          —— 定义用 X/Y 抽象变量，问题用具体人名，模型接不上
  (C) 提示格式             —— 角色映射说得不够显式

对应三种定义呈现方式（任务完全相同，只改定义的写法）：
  a_abstract   '"X zelka Y" means X gives something to Y.'              ← P0e 原版
  b_explicit   同上 + 'The first name is the giver; the second is the receiver.'
  c_grounded   '"Ann zelka Ben" would mean Ann gives something to Ben.'  ← 用真实人名实例化，去掉变量绑定

若 c ≫ a → (B) 变量绑定是瓶颈
若 b ≫ a → (C) 格式问题
若三者都低 → (A) 能力缺失，作用域边界坐实
"""
import os, sys, json, math, statistics as st
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from items_v2 import ITEMS2

MODEL = sys.argv[1] if len(sys.argv) > 1 else "Qwen/Qwen2.5-1.5B-Instruct"
HERE = os.path.dirname(os.path.abspath(__file__))
tok = AutoTokenizer.from_pretrained(MODEL, local_files_only=True)
dev = "mps" if torch.backends.mps.is_available() else "cpu"
model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.bfloat16, local_files_only=True).to(dev).eval()
print(f"[load] {MODEL} · {dev}\n", flush=True)
YES = [" Yes"," yes","Yes","yes"]; NO = [" No"," no","No","no"]


@torch.no_grad()
def yn(p):
    ids = tok(p, return_tensors="pt")["input_ids"].to(dev)
    lp = torch.log_softmax(model(ids).logits[0, -1].float(), -1)
    def b(cs):
        v = -1e9
        for c in cs:
            t = tok.encode(c, add_special_tokens=False)
            if t: v = max(v, lp[t[0]].item())
        return v
    return b(YES), b(NO)


def nll(prefix, qbody, label):
    y, n = yn(f"{prefix}\nQuestion: {qbody} Answer Yes or No.\nAnswer:")
    m = max(y, n); tot = m + math.log(math.exp(y-m)+math.exp(n-m))
    return -((y if label == "Yes" else n) - tot)


# G4 的角色语义（用于生成三种定义呈现）
ROLES = {
 "G4-01": ("gives something to", "receives something from", "giver", "receiver"),
 "G4-02": ("is above", "is below", "higher one", "lower one"),
 "G4-03": ("teaches", "learns from", "teacher", "student"),
 "G4-04": ("owns", "belongs to", "owner", "owned thing"),
}

G4 = [it for it in ITEMS2 if it["type"] == "G4"]
out = []
for it in G4:
    w, iid = it["word"], it["id"]
    relM, relP, roleA, roleB = ROLES[iid]
    # 从留出题干里取出首个场景的两个论元名，用于 c_grounded 实例化
    first = it["heldout"][0][0]                       # '... Is "A w B" correct?'
    inner = first.split('"')[1].split()
    A, B = inner[0], inner[-1]

    def variants(rel, other_role_a, other_role_b):
        return {
          "a_abstract": f'"X {w} Y" means X {rel} Y.',
          "b_explicit": f'"X {w} Y" means X {rel} Y. The first name is the {other_role_a}; the second is the {other_role_b}.',
          "c_grounded": f'"{A} {w} {B}" would mean {A} {rel} {B}.',
        }
    vM = variants(relM, roleA, roleB)
    vP = variants(relP, roleB, roleA)
    base = sum(nll(f"{w} is a word in Tovi's language.", q, y) for q, y in it["heldout"])

    row = {"id": iid, "base": base}
    for k in ("a_abstract", "b_explicit", "c_grounded"):
        nM = sum(nll(vM[k], q, y) for q, y in it["heldout"])
        nP = sum(nll(vP[k], q, y) for q, y in it["heldout"])
        row[k] = {"dM": base-nM, "dP": base-nP, "margin": nP-nM}
    out.append(row)
    print(f"[{iid}] " + "  ".join(f"{k[0]}:margin={row[k]['margin']:+.2f}" for k in ("a_abstract","b_explicit","c_grounded")), flush=True)

print("\n" + "="*76)
print(f"P0f — G4 失败归因  ·  {MODEL.split('/')[-1]}  ·  {len(G4)} 个关系类 item")
print("="*76)
print(f"\n{'定义呈现方式':26} {'margin 均值':>12} {'M 胜':>7} {'平均|ΔNLL(M)|':>14}")
print("-"*76)
res = {}
for k, name in (("a_abstract","a 抽象变量 X/Y（P0e 原版）"),
                ("b_explicit","b + 显式角色说明"),
                ("c_grounded","c 用真实人名实例化")):
    m = [r[k]["margin"] for r in out]
    d = [abs(r[k]["dM"]) for r in out]
    res[k] = dict(margin=st.mean(m), wins=sum(x>0 for x in m), absd=st.mean(d))
    print(f"{name:26} {st.mean(m):12.2f} {sum(x>0 for x in m):4d}/{len(m)} {st.mean(d):14.2f}")

print("-"*76)
a, b, c = res["a_abstract"]["margin"], res["b_explicit"]["margin"], res["c_grounded"]["margin"]
print(f"参照：其他 4 类歧义的 margin ≈ +4.9，平均 |ΔNLL| ≈ 4.74\n")
if c > a + 1.5 and c > b:
    v = "(B) 变量绑定是瓶颈 —— 去掉 X/Y 抽象后信号恢复"
elif b > a + 1.5:
    v = "(C) 提示格式问题 —— 显式角色说明即可恢复"
elif max(a, b, c) < 2.0:
    v = "(A) 能力缺失 —— 三种呈现都无信号，关系类是真实的作用域边界"
else:
    v = "混合：部分恢复，需更大样本判定"
print(f"裁决：{v}")

json.dump({"model": MODEL, "rows": out, "summary": res},
          open(os.path.join(HERE, "p0f_results.json"), "w"), indent=2, ensure_ascii=False)
print("\n[saved] p0f_results.json")
