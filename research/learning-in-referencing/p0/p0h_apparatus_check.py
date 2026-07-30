"""P0h — 仪器有效性检查：3B 上的 yes/no 测量到底还成不成立？

触发原因：3B 探针出现 p(yes)=0.000 —— 连「kirel means red」+「Is a red box kirel?」
这种答案显然为 Yes 的题也是 0.000。这有两种互斥解释：

  (A) 真实的条件化失败（E5）  —— 模型不按给定定义行动
  (B) 提示格式失效           —— raw-text 格式对 chat-tuned 3B 无效，
                                模型在 {Yes,No} 上被某种偏置压死

若是 (B)，则「缩放推翻预测 / 发现 E5」这个结论是**仪器假象**，必须撤回。

三组检查：
  1. 平凡常识题（不涉及任何伪词/定义）—— 仪器基线
  2. 同一题在 raw-text vs chat template 两种格式下的对比
  3. Yes/No 先验偏置：把问题换成显然为 No 的，看是否也塌到同一侧
"""
import sys, math, json, os
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM

MODEL = sys.argv[1] if len(sys.argv) > 1 else "Qwen/Qwen2.5-3B-Instruct"
HERE = os.path.dirname(os.path.abspath(__file__))
tok = AutoTokenizer.from_pretrained(MODEL, local_files_only=True)
dev = "mps" if torch.backends.mps.is_available() else "cpu"
model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.bfloat16, local_files_only=True).to(dev).eval()
print(f"[load] {MODEL} · {dev}\n", flush=True)

YES = [" Yes", " yes", "Yes", "yes"]; NO = [" No", " no", "No", "no"]


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


@torch.no_grad()
def top_tokens(prompt, k=6):
    ids = tok(prompt, return_tensors="pt")["input_ids"].to(dev)
    lp = torch.log_softmax(model(ids).logits[0, -1].float(), -1)
    v, i = lp.topk(k)
    return [(repr(tok.decode([j])), round(math.exp(x), 3)) for x, j in zip(v.tolist(), i.tolist())]


RAW = "{ctx}\nQuestion: {q} Answer Yes or No.\nAnswer:"


def chat(ctx, q):
    msgs = [{"role": "user", "content": f"{ctx}\nQuestion: {q} Answer Yes or No."}]
    return tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)


# ---------- 1. 平凡常识题（无伪词、无定义）：仪器基线 ----------
SANITY = [
    ("", "Is a red apple red?", "Yes"),
    ("", "Is a red apple blue?", "No"),
    ("", "Is water wet?", "Yes"),
    ("", "Is fire cold?", "No"),
    ("", "Is a box a container?", "Yes"),
    ("", "Is a horse a bird?", "No"),
]
print("=" * 78)
print("检查 1 — 平凡常识题（仪器基线）")
print("=" * 78)
print(f"{'问题':38} {'期望':>5} {'raw p(yes)':>11} {'chat p(yes)':>12}")
print("-" * 78)
ok_raw = ok_chat = 0
for ctx, q, exp in SANITY:
    pr = p_yes(RAW.format(ctx=ctx, q=q).lstrip())
    pc = p_yes(chat(ctx, q))
    ok_raw += (pr > .5) == (exp == "Yes")
    ok_chat += (pc > .5) == (exp == "Yes")
    print(f"{q:38} {exp:>5} {pr:11.3f} {pc:12.3f}")
print("-" * 78)
print(f"raw 格式正确 {ok_raw}/{len(SANITY)}   ·   chat 格式正确 {ok_chat}/{len(SANITY)}")

# ---------- 2. 伪词 + 定义：平凡应用 ----------
TRIV = [
    ("kirel means red.", "Is a red box kirel?", "Yes"),
    ("kirel means red.", "Is a blue box kirel?", "No"),
    ("kirel means red and round.", "Is a red round ball kirel?", "Yes"),
    ("kirel means red and round.", "Is a blue square box kirel?", "No"),
    ("fenlo means an animal.", "Is a horse fenlo?", "Yes"),
    ("fenlo means an animal.", "Is a rock fenlo?", "No"),
]
print("\n" + "=" * 78)
print("检查 2 — 伪词 + 定义的【平凡】应用（定义直接给出答案，无需世界知识推理）")
print("=" * 78)
print(f"{'定义 / 问题':52} {'期望':>4} {'raw':>7} {'chat':>7}")
print("-" * 78)
t_raw = t_chat = 0
for ctx, q, exp in TRIV:
    pr = p_yes(RAW.format(ctx=ctx, q=q))
    pc = p_yes(chat(ctx, q))
    t_raw += (pr > .5) == (exp == "Yes")
    t_chat += (pc > .5) == (exp == "Yes")
    print(f"{(ctx+' | '+q)[:52]:52} {exp:>4} {pr:7.3f} {pc:7.3f}")
print("-" * 78)
print(f"raw 正确 {t_raw}/{len(TRIV)}   ·   chat 正确 {t_chat}/{len(TRIV)}")

# ---------- 3. 下一 token 到底想输出什么 ----------
print("\n" + "=" * 78)
print("检查 3 — 模型在该位置真正想输出的 top tokens")
print("=" * 78)
for ctx, q in [("kirel means red.", "Is a red box kirel?"), ("", "Is a red apple red?")]:
    print(f"\n[raw ] {ctx} | {q}")
    print("   ", top_tokens(RAW.format(ctx=ctx, q=q).lstrip()))
    print(f"[chat] {ctx} | {q}")
    print("   ", top_tokens(chat(ctx, q)))

verdict = ("(B) 提示格式失效 —— raw 格式在该模型上不可用，3B 结论须重跑"
           if ok_raw < len(SANITY) * 0.8 else
           "(A) 仪器基线正常 —— raw 格式可用，3B 的 E5 结论站得住")
print("\n" + "=" * 78)
print(f"裁决：{verdict}")
json.dump({"model": MODEL, "sanity_raw_ok": ok_raw, "sanity_chat_ok": ok_chat,
           "trivial_raw_ok": t_raw, "trivial_chat_ok": t_chat, "n_sanity": len(SANITY),
           "n_trivial": len(TRIV), "verdict": verdict},
          open(os.path.join(HERE, f"p0h_{MODEL.split('/')[-1]}.json"), "w"), indent=2, ensure_ascii=False)
