"""P3 记忆层不变量测试（纯 CPU，无模型）。python3 test_memory.py"""
import sys

from memory import ACCEPT, ASK, DEFER, REJECT, PartitionedMemory

F = []


def chk(name, cond, detail=""):
    print(("  ok  " if cond else "FAIL  ") + name + ("" if cond else f"  {detail}"))
    if not cond:
        F.append(name)


m = PartitionedMemory(max_age=2)

# T1 门是唯一写入路径
m.propose("uA", "tuma", "red")
chk("T1a propose 不进 L2", m.get("uA", "tuma") is None)
m.apply_gate("uA", "tuma", ACCEPT)
chk("T1b ACCEPT 后进 L2", m.get("uA", "tuma") is not None)

# T2 REJECT 即淘汰，且不留痕于 L2
m.propose("uA", "vosk", "blue")
m.apply_gate("uA", "vosk", REJECT)
chk("T2 REJECT 不进 L2 也不留 L1",
    m.get("uA", "vosk") is None and "vosk" not in m.pending("uA"))

# T3 DEFER 留 L1、超龄自动淘汰（写入前可逆性）
m.propose("uA", "korm", "green")
for i in range(2):
    m.apply_gate("uA", "korm", DEFER)
chk("T3a DEFER 期间留在 L1", "korm" in m.pending("uA"))
act = m.apply_gate("uA", "korm", DEFER)          # 第 3 次 → age 3 > max_age 2
chk("T3b 超龄 expire", act == "expire" and "korm" not in m.pending("uA"))
chk("T3c expire 不进 L2", m.get("uA", "korm") is None)

# T4 uid 硬分区：同词不同义互不影响
m.propose("uB", "tuma", "blue")
m.apply_gate("uB", "tuma", ACCEPT)
chk("T4a uA 的 tuma 仍是 red", m.get("uA", "tuma").meaning == "red")
chk("T4b uB 的 tuma 是 blue", m.get("uB", "tuma").meaning == "blue")
chk("T4c 键空间不相交（无对象别名）", m.key_space_disjoint("uA", "uB"))
chk("T4d assemble 只出本 uid", m.assemble("uA") == "tuma means red." and
    m.assemble("uB") == "tuma means blue.", f"{m.assemble('uA')!r}/{m.assemble('uB')!r}")

# T5 未知 uid 读到空，而不是别人的
chk("T5 未知 uid 读空", m.get("uC", "tuma") is None and m.assemble("uC") == "")

# T6 ASK 不写入
m.propose("uA", "shen", "soft")
m.apply_gate("uA", "shen", ASK)
chk("T6 ASK 不进 L2", m.get("uA", "shen") is None and "shen" in m.pending("uA"))

# T7 重新提案不同义会覆盖候选（同 uid 同词）
m.propose("uA", "shen", "smooth")
chk("T7 候选被新义覆盖", m.pending("uA")["shen"] == "smooth")

# T8 审计日志含毕业/淘汰记录
acts = {a for _, _, a, _ in m.log}
chk("T8 日志覆盖四类动作", {"propose", "graduate", "evict", "expire"} <= acts, acts)

print("\n" + "=" * 40)
if F:
    print(f"❌ {len(F)} 项失败: {F}")
    sys.exit(1)
print(f"✅ 全部不变量通过 · {m.stats()}")
