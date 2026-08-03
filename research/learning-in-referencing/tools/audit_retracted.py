"""投稿前一致性审计：扫描所有文档，找出【已被推翻/已改正的主张】是否还以肯定语气残留。

背景：本项目有 21 处自我推翻，散落在 14 份文档里。正文改了而附录表格没跟着改，
是最容易漏的一类错误（实测抓到过：附录 J 仍写「LMLM NeurIPS 2025 主会」+「损失掩码即准入门」）。

用法：python research/learning-in-referencing/tools/audit_retracted.py
判定：命中行若处在「撤回/改正/禁令/⚠️/~~删除线~~」等否定语境中即放行；否则报为需处理。
⚠️ 本工具是提醒器不是判官——放行不等于正确，仍需人工复核语境。
"""
import re, glob, os, sys
# ★ 路径锚到仓库根，不依赖 cwd —— 否则在子目录下跑会扫到 0 份文档、然后打印 ✅（假放行）
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
DOCS = sorted(glob.glob(os.path.join(ROOT, "docs/RESEARCH_*.md"))
              + glob.glob(os.path.join(ROOT, "docs/DESIGN_*.md"))
              + glob.glob(os.path.join(ROOT, "research/learning-in-referencing/**/*.md"),
                          recursive=True))
if len(DOCS) < 10:
    sys.exit(f"🔴 只找到 {len(DOCS)} 份文档（预期 ≥10）——路径解析出错，**拒绝给出放行结论**。ROOT={ROOT}")
# (模式, 说明, 是否允许出现在"已撤回/禁令"语境)
RULES = [
 (r"尚无\s*GT-free|无\s*GT-free\s*的写入准入门控", "禁令1: 已被 GATES/LMSI 证伪的措辞"),
 (r"三族均无写入准入门控(?!」（绝对表述）|」（绝对）)", "禁令: 绝对表述已被 2606.03979 证伪"),
 (r"语义熵[^。\n]{0,12}[≈约]\s*随机", "禁令6: 应写「反向或随机，从不正向」"),
 (r"(?<!只有)(?<!实际只有)三\s*个?独立(对照|臂)|three\s+independent\s+arms", "禁令7: 实际只有 2 个独立臂"),
 (r"推理期写入[^。\n]{0,10}跨会话持久[^。\n]{0,10}从未同时", "已撤回: 被上下文蒸馏族填上"),
 (r"睡眠期落到\*{0,2}权重", "已撤回: 2605.26099 的 fast weights 非持久参数"),
 (r"LMLM[^。\n]{0,20}NeurIPS 2025(?!\s*CCFM)", "已改正: 实为 CCFM workshop Oral"),
 (r"Sharpening[^。\n]{0,10}证明了", "已改正: 是动机性前提，非该文定理"),
 (r"损失掩码(即|就是)准入门", "已改正: 范畴错置"),
 (r"多文档[^。\n]{0,6}LoRA[^。\n]{0,6}平均[^。\n]{0,6}(互相)?干扰", "已改正(#17): 说反了"),
 (r"σ_null\s*(是)?盲的|接不住\s*E5", "已自纠(#6): 不是盲区是校准问题"),
 # ★ #21：我方自设的限制被 P6 推翻——「缺组合性」不得再以肯定语气出现
 (r"缺(少)?深度组合性|缺(少)?组合性|lacks?\s+(the\s+)?depth\s+composition", "已撤回(#21): P6 实测 +0.449 且反超 L1"),
 (r"(do\s+not|don't|未|不)\s*verif(y|ied)?[^。\n]{0,20}I2|I2\s*(组合性)?未验证", "已撤回(#21): I2 与世界知识的组合已验证；只有「概念⊗概念」未测"),
 # ★ #24：P8 证伪 I3，并给所有内化主张加了作用域
 (r"I3[^。\n]{0,12}(成立|达成|✅)(?!的)|I3\s*(隐式触发)?\s*(已)?(验证|满足)", "已证伪(#24): I3 不成立（P8: 0.507 ≈ base 0.500）"),
 (r"五判据[^。\n]{0,20}(全部|均)(成立|达成|满足)", "已证伪(#24): I3 不成立，五判据不全"),
]
ALLOW = re.compile(r"(❌|🚫|⚠️|~~|撤回|改正|自纠|推翻|被证伪|反驳|曾写|一测就反|不成立|不得|禁令|勿|"
                   r"不可写|不要用|错的说法|过强|归因错误|我方原主张|不写|被推翻的表述)")
hits=[]
for f in DOCS:
    rel = os.path.relpath(f, ROOT)
    for i,line in enumerate(open(f, encoding="utf-8"),1):
        for pat,why in RULES:
            if re.search(pat,line):
                ctx_ok = bool(ALLOW.search(line))
                hits.append((rel,i,why,ctx_ok,line.strip()[:120]))
bad=[h for h in hits if not h[3]]
print(f"扫描 {len(DOCS)} 份文档 · 命中 {len(hits)} 处 · 其中 **无撤回标记** {len(bad)} 处\n")
if bad:
    print("🔴 需处理：")
    for f,i,why,_,t in bad: print(f"  {f}:{i}\n     [{why}]\n     {t}\n")
else:
    print("✅ 所有命中都处在「已撤回/禁令/不得」等否定语境中——无残留的过时主张")
print("\n⚠️ 提醒：本工具只查语境标记，放行 ≠ 正确。新增/改写主张后应重跑并人工复核。")
print("--- 文档清单 ---")
for f in DOCS: print(f"  {os.path.relpath(f, ROOT)}")
