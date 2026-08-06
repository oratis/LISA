"""P3 记忆层（非参数第一阶段）+ uid 硬分区

DESIGN §9.3.3 的 L1/L2 两层与 uid 分区，在**非参数载体**上先做出来：
参数化载体（product-key 稀疏槽）留到 P4；本阶段要先把**隔离是架构保证而非约定**
这件事做成可测的（DESIGN_CONCEPT_BENCH §6 冲突词测试）。

设计要点（论文可引用的三条）：
1. **key 空间硬分区**：所有条目的键是 `(uid, word)` 元组，检索**只能**用调用者的 uid
   构键 —— 跨用户命中在数据结构层面不可表达（不是"过滤掉了"，是"构不出那个键"）。
2. **三态门就是唯一写入路径**：graduate() 是 L2 的唯一入口；DEFER 项留在 L1 且
   会过期淘汰（写入前可逆性，KNOWLEDGE §5.3 的卖点）。
3. **上下文装配按 uid**：assemble() 只取本 uid 的已毕业条目，因此"泄漏"必须
   由外部（模型先验/提示串味）造成，不可能由记忆层造成 —— 这让隔离测试
   测的是**系统**而不是**实现 bug**。
"""
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

ACCEPT, REJECT, ASK, DEFER = "ACCEPT", "REJECT", "ASK", "DEFER"


@dataclass
class Entry:
    uid: str
    word: str
    meaning: str
    score: float = 0.0          # 门给的分（rank 或 z）
    hits: int = 0               # 命中次数
    age: int = 0                # 未毕业存活轮数
    state: str = DEFER


class PartitionedMemory:
    """L1 待定区 + L2 持久区，两层都按 uid 硬分区。

    键空间是 dict[uid][word]；**没有任何 API 接受跨 uid 的键**——
    get/assemble/graduate 全部以调用者 uid 为第一参数，
    要读别人的条目只能显式传别人的 uid（测试里用来证明泄漏不是记忆层造成的）。
    """

    def __init__(self, max_age: int = 3):
        self._l1: Dict[str, Dict[str, Entry]] = {}
        self._l2: Dict[str, Dict[str, Entry]] = {}
        self.max_age = max_age
        self.log: List[Tuple[str, str, str, str]] = []   # (uid, word, action, meaning)

    # ---------- L1：候选提交 ----------
    def propose(self, uid: str, word: str, meaning: str, score: float = 0.0) -> Entry:
        slot = self._l1.setdefault(uid, {})
        e = slot.get(word)
        if e is None or e.meaning != meaning:
            e = Entry(uid=uid, word=word, meaning=meaning, score=score)
            slot[word] = e
        else:
            e.score = score
        e.hits += 1
        self.log.append((uid, word, "propose", meaning))
        return e

    # ---------- 门：唯一写入 L2 的路径 ----------
    def apply_gate(self, uid: str, word: str, verdict: str) -> str:
        """verdict ∈ {ACCEPT, REJECT, ASK, DEFER}。返回实际发生的动作。"""
        e = self._l1.get(uid, {}).get(word)
        if e is None:
            return "noop"
        if verdict == ACCEPT:
            e.state = ACCEPT
            self._l2.setdefault(uid, {})[word] = e
            del self._l1[uid][word]
            self.log.append((uid, word, "graduate", e.meaning))
            return "graduate"
        if verdict == REJECT:
            del self._l1[uid][word]
            self.log.append((uid, word, "evict", e.meaning))
            return "evict"
        # ASK / DEFER：留在 L1，计龄；超龄淘汰（写入前可逆性）
        e.state = verdict
        e.age += 1
        if e.age > self.max_age:
            del self._l1[uid][word]
            self.log.append((uid, word, "expire", e.meaning))
            return "expire"
        self.log.append((uid, word, verdict.lower(), e.meaning))
        return verdict.lower()

    # ---------- 读：只能用自己的 uid 构键 ----------
    def get(self, uid: str, word: str) -> Optional[Entry]:
        return self._l2.get(uid, {}).get(word)

    def assemble(self, uid: str, words: Optional[List[str]] = None) -> str:
        """把本 uid 的已毕业条目装配成上下文前缀。"""
        slot = self._l2.get(uid, {})
        keys = [w for w in (words or sorted(slot)) if w in slot]
        return "\n".join(f"{slot[w].word} means {slot[w].meaning}." for w in keys)

    # ---------- 审计 ----------
    def graduated(self, uid: str) -> Dict[str, str]:
        return {w: e.meaning for w, e in self._l2.get(uid, {}).items()}

    def pending(self, uid: str) -> Dict[str, str]:
        return {w: e.meaning for w, e in self._l1.get(uid, {}).items()}

    def key_space_disjoint(self, uid_a: str, uid_b: str) -> bool:
        """架构性不相交断言：两 uid 的 L2 条目对象互不共享（无别名）。"""
        a = self._l2.get(uid_a, {})
        b = self._l2.get(uid_b, {})
        return all(a[w] is not b.get(w) for w in a)

    def stats(self) -> Dict[str, int]:
        return dict(uids=len(set(self._l1) | set(self._l2)),
                    l1=sum(len(v) for v in self._l1.values()),
                    l2=sum(len(v) for v in self._l2.values()))
