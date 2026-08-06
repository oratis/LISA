"""扩大的零分布池：每个 item ~12 个"看似合理但错误"的候选假设。

设计原则（决定 z 分数是否有意义）：
  零分布必须代表【模型可能生成的、看似合理的错误假设】。
  因此必须包含 M′ 那一类"过窄的合取"——这样 M′ 自身就会成为零分布的典型成员（z≈0 → 拒绝），
  而真概念 M 应当是显著离群点（z 高 → 接受）。

标签：
  wrong_single  同类型的错误单属性
  wrong_conj    错误的合取
  overspec      M ∧ 额外条件（与 M′ 同构 —— 关键对照）
  overbroad     过宽
  unrelated     不相关属性
"""

NULL = {
 "G1-01": [  # kirel = red   (M′ = red and round)
   ("blue","wrong_single"),("green","wrong_single"),("square","wrong_single"),("round","wrong_single"),
   ("blue and round","wrong_conj"),("green and square","wrong_conj"),
   ("red and heavy","overspec"),("red and smooth","overspec"),("red and small","overspec"),
   ("a thing","overbroad"),("an object","overbroad"),("metal","unrelated"),
 ],
 "G1-02": [  # votan = wooden  (M′ = wooden and long)
   ("plastic","wrong_single"),("metal","wrong_single"),("short","wrong_single"),("long","wrong_single"),
   ("plastic and short","wrong_conj"),("metal and long","wrong_conj"),
   ("wooden and heavy","overspec"),("wooden and smooth","overspec"),("wooden and thin","overspec"),
   ("a thing","overbroad"),("an object","overbroad"),("red","unrelated"),
 ],
 "G1-03": [  # nulpa = blue  (M′ = blue and small)
   ("green","wrong_single"),("red","wrong_single"),("large","wrong_single"),("small","wrong_single"),
   ("green and large","wrong_conj"),("red and small","wrong_conj"),
   ("blue and round","overspec"),("blue and heavy","overspec"),("blue and smooth","overspec"),
   ("a thing","overbroad"),("an object","overbroad"),("wooden","unrelated"),
 ],
 "G1-04": [  # tarel = soft  (M′ = soft and white)
   ("hard","wrong_single"),("black","wrong_single"),("white","wrong_single"),("rough","wrong_single"),
   ("hard and black","wrong_conj"),("rough and white","wrong_conj"),
   ("soft and warm","overspec"),("soft and light","overspec"),("soft and thick","overspec"),
   ("a thing","overbroad"),("an object","overbroad"),("metal","unrelated"),
 ],
 "G1-05": [  # mibok = round  (M′ = round and green)
   ("square","wrong_single"),("green","wrong_single"),("red","wrong_single"),("flat","wrong_single"),
   ("square and red","wrong_conj"),("flat and green","wrong_conj"),
   ("round and small","overspec"),("round and smooth","overspec"),("round and hard","overspec"),
   ("a thing","overbroad"),("an object","overbroad"),("wooden","unrelated"),
 ],
 "G1-06": [  # semdu = heavy  (M′ = heavy and metal)
   ("light","wrong_single"),("metal","wrong_single"),("wooden","wrong_single"),("cold","wrong_single"),
   ("light and metal","wrong_conj"),("wooden and light","wrong_conj"),
   ("heavy and large","overspec"),("heavy and hard","overspec"),("heavy and dark","overspec"),
   ("a thing","overbroad"),("an object","overbroad"),("red","unrelated"),
 ],
 "G2-01": [  # fenlo = an animal  (M′ = a bird)
   ("a plant","wrong_single"),("a tool","wrong_single"),("a machine","wrong_single"),("a stone","wrong_single"),
   ("a bird or a plant","wrong_conj"),("a small machine","wrong_conj"),
   ("a mammal","overspec"),("a flying animal","overspec"),("a wild animal","overspec"),
   ("a thing","overbroad"),("an object","overbroad"),("a color","unrelated"),
 ],
 "G2-02": [  # dorvek = a container  (M′ = a cup)
   ("a vehicle","wrong_single"),("a garment","wrong_single"),("a weapon","wrong_single"),("a book","wrong_single"),
   ("a cup or a book","wrong_conj"),("a small weapon","wrong_conj"),
   ("a drinking vessel","overspec"),("a glass container","overspec"),("a small container","overspec"),
   ("a thing","overbroad"),("an object","overbroad"),("a color","unrelated"),
 ],
}
