"""P0i — 忠实性探针 F(c)：补上 σ_null 的盲区，检出 E5「条件化失败」

背景：
  σ_null 检出「不可判定」（定义完全不影响预测）；
  但 E5 是「模型自信地不按定义行动」——σ_null 读作「可判定」，弃权门接不住（P0 §6c）。

思路：构造**答案由候选定义单独蕴含**的平凡实例，看模型是否遵循。
  · GT-free：不需要知道 c 是否为「正确」定义，只需 "若 c 成立则答案必为 X" 这一蕴含关系
  · 与 σ_null 正交：σ_null 测「定义有没有进入决策」，F 测「进入后是否被正确应用」

模板（按类型）：
  属性/范畴/材料类 (G1,G2,G3,G5):
      蕴含 Yes: "Is a thing that is {c} {word}?"
      蕴含 No : "Is a thing that is not {c} {word}?"
  关系类 (G4):
      蕴含 Yes: "{A} {rel} {B}. Is \"{A} {word} {B}\" correct?"
      蕴含 No : "{A} {rel} {B}. Is \"{B} {word} {A}\" correct?"

F(c) = p_yes(蕴含Yes) − p_yes(蕴含No)   ∈ [−1, 1]，越高越忠实

预测：F 应在 3B 的 G5（以及 P0h 发现的单属性平凡失败）上偏低，
      从而把 σ_null 接不住的 E5 项挑出来。
"""
import sys, os, json, math, statistics as st
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from items_v2 import ITEMS2

MODEL = sys.argv[1] if len(sys.argv) > 1 else "Qwen/Qwen2.5-1.5B-Instruct"
HERE = os.path.dirname(os.path.abspath(__file__))
TAG = MODEL.split("/")[-1]
tok = AutoTokenizer.from_pretrained(MODEL, local_files_only=True)
dev = "mps" if torch.backends.mps.is_available() else "cpu"
model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.bfloat16, local_files_only=True).to(dev).eval()
print(f"[load] {MODEL} · {dev}\n", flush=True)
YES = [" Yes", " yes", "Yes", "yes"]; NO = [" No", " no", "No", "no"]

# G4 的关系语义（用于生成蕴含实例）
G4REL = {"G4-01": ("gives something to", "Ann", "Ben"),
         "G4-02": ("is above", "the lamp", "the table"),
         "G4-03": ("teaches", "Mia", "Noel"),
         "G4-04": ("owns", "the farmer", "the field")}
G4REL_P = {"G4-01": "receives something from", "G4-02": "is below",
           "G4-03": "learns from", "G4-04": "belongs to"}


@torch.no_grad()
def p_yes(prompt):
    ids = tok(prompt, return_tensors="pt")["input_ids"].to(dev)
    lp = torch.log_softmax(model(ids).logits[0, -1].float(), -1)
    def b(cs):
        v = -1e9
        for c in cs:
            t = tok.encode(c, add_special_tokens=False)
            if t: v = max(v, lp[t[0]].item())
        return v
    y, n = b(YES), b(NO)
    return math.exp(y) / (math.exp(y) + math.exp(n))


def stmt(word, meaning):
    return (meaning + ".") if meaning.startswith('"') else f"{word} means {meaning}."


def ask(ctx, q):
    return f"{ctx}\nQuestion: {q} Answer Yes or No.\nAnswer:"


def faithfulness(it, meaning, is_M):
    """返回 (F, p_yes_entailed_yes, p_yes_entailed_no)"""
    w, iid = it["word"], it["id"]
    ctx = stmt(w, meaning)
    if it["type"] == "G4":
        rel = G4REL[iid][0] if is_M else G4REL_P[iid]
        A, B = G4REL[iid][1], G4REL[iid][2]
        qy = f'{A} {rel} {B}. Is "{A} {w} {B}" correct?'
        qn = f'{A} {rel} {B}. Is "{B} {w} {A}" correct?'
    else:
        m = meaning
        qy = f"Is a thing that is {m} {w}?"
        qn = f"Is a thing that is not {m} {w}?"
    py, pn = p_yes(ask(ctx, qy)), p_yes(ask(ctx, qn))
    return py - pn, py, pn


rows = []
for it in ITEMS2:
    fM, yM, nM = faithfulness(it, it["M"], True)
    fP, yP, nP = faithfulness(it, it["Mprime"], False)
    rows.append(dict(id=it["id"], type=it["type"], F_M=fM, F_Mprime=fP,
                     F_min=min(fM, fP), pyes_M=yM, pno_M=nM, pyes_P=yP, pno_P=nP))
    print(f"[{it['id']}] F(M)={fM:+.3f}  F(M′)={fP:+.3f}  min={min(fM,fP):+.3f}", flush=True)

# 合并 p0e 的判别结果，检验 F 能否预测「门判得对不对」
src = os.path.join(HERE, f"p0e_{TAG}.json")
merged = False
if os.path.exists(src):
    E = {r["id"]: r for r in json.load(open(src))["rows"]}
    for r in rows:
        e = E.get(r["id"])
        if e:
            r["margin"] = e["dM"] - e["dP"]
            r["correct"] = (e["zM"] > e["zP"])
            r["sigma_null"] = e["sd"]
    merged = all("correct" in r for r in rows)

n = len(rows)
print("\n" + "=" * 84)
print(f"P0i 忠实性探针  ·  {TAG}  ·  {n} items")
print("=" * 84)
print(f"\n{'类型':6} {'n':>3} {'F(M)':>8} {'F(M′)':>8} {'F_min':>8}" + ("  判对率" if merged else ""))
print("-" * 84)
for t in ("G1", "G2", "G3", "G4", "G5"):
    S = [r for r in rows if r["type"] == t]
    acc = f"  {sum(r['correct'] for r in S)}/{len(S)}" if merged else ""
    print(f"{t:6} {len(S):3d} {st.mean([r['F_M'] for r in S]):8.3f} "
          f"{st.mean([r['F_Mprime'] for r in S]):8.3f} {st.mean([r['F_min'] for r in S]):8.3f}{acc}")

if merged:
    good = [r for r in rows if r["correct"]]
    bad = [r for r in rows if not r["correct"]]
    print("-" * 84)
    print(f"判对的 {len(good)} 项：F_min 均值 {st.mean([r['F_min'] for r in good]):+.3f} | "
          f"σ_null 均值 {st.mean([r['sigma_null'] for r in good]):.2f}")
    print(f"判错的 {len(bad):2d} 项：F_min 均值 {st.mean([r['F_min'] for r in bad]):+.3f} | "
          f"σ_null 均值 {st.mean([r['sigma_null'] for r in bad]):.2f}")
    print(f"          ↑ 若 F 有效，判错组的 F_min 应显著更低")

    def auc(p, nn):
        return sum((a > b) + 0.5 * (a == b) for a in p for b in nn) / (len(p) * len(nn)) if p and nn else float("nan")
    fa = auc([r["F_min"] for r in good], [r["F_min"] for r in bad])
    sa = auc([r["sigma_null"] for r in good], [r["sigma_null"] for r in bad])
    print(f"\n【关键】用于预测「门会不会判错」的 AUC：")
    print(f"   忠实性 F_min : {fa:.3f}   ← 本实验新增")
    print(f"   可判定 σ_null: {sa:.3f}   ← 已有（P0g）")
    print(f"   → {'✅ F 优于 σ_null，补上了盲区' if fa > sa + 0.05 else ('⚠️ F 与 σ_null 相当' if abs(fa-sa)<=0.05 else '❌ F 不如 σ_null')}")

    print(f"\n=== 两段式弃权（先 F 后 σ）：扫描 F 阈值 ===")
    print(f"{'τ_F':>6} {'覆盖':>8} {'保留项判对率':>12}")
    print("-" * 34)
    for th in (-1.0, 0.0, 0.2, 0.4, 0.6, 0.8):
        keep = [r for r in rows if r["F_min"] >= th]
        if len(keep) < 3: continue
        print(f"{th:6.1f} {len(keep):3d}/{n:<4} {sum(r['correct'] for r in keep)/len(keep):12.1%}")

json.dump({"model": MODEL, "rows": rows}, open(os.path.join(HERE, f"p0i_{TAG}.json"), "w"),
          indent=2, ensure_ascii=False)
print(f"\n[saved] p0i_{TAG}.json")
