"""P0 刺激材料：gavagai 对（G1 合取歧义 / G2 范畴层级）

构造原则（DESIGN_CONCEPT_BENCH.md §3）：
  教学集中 M 与 M' 外延一致（都完美解释所有教学样例）；只有留出集能分开它们。

每个 item：
  teach     — 教学轮次（P∧Q，对 M 和 M' 都成立）→ 本实验中被"蒸馏"掉，不进上下文
  disamb    — 留出·消歧轮次（P∧¬Q）→ 只有 M 预测得了
  control   — 留出·对照轮次（P∧Q）→ M 与 M' 都预测得了
  negative  — 留出·否定轮次（¬P）→ 两者都预测得了
"""

ITEMS = [
    # ---------- G1：合取歧义 ----------
    dict(
        id="G1-01", type="G1", word="kirel",
        M="red", Mprime="red and round",
        teach=["The red ball is kirel.", "The red apple is kirel.",
               "The red marble is kirel.", "The red button is kirel."],
        disamb=["The red box is kirel.", "The red flag is kirel.", "The red pencil is kirel."],
        control=["The red bead is kirel."],
        negative=["The blue ball is not kirel."],
        placebos=["blue", "square", "blue and square", "metal"],
    ),
    dict(
        id="G1-02", type="G1", word="votan",
        M="wooden", Mprime="wooden and long",
        teach=["The wooden pole is votan.", "The wooden stick is votan.",
               "The wooden plank is votan.", "The wooden beam is votan."],
        disamb=["The wooden bowl is votan.", "The wooden cube is votan.", "The wooden coin is votan."],
        control=["The wooden rod is votan."],
        negative=["The plastic pole is not votan."],
        placebos=["plastic", "short", "plastic and short", "heavy"],
    ),
    dict(
        id="G1-03", type="G1", word="nulpa",
        M="blue", Mprime="blue and small",
        teach=["The blue pebble is nulpa.", "The blue bead is nulpa.",
               "The blue chip is nulpa.", "The blue pin is nulpa."],
        disamb=["The blue door is nulpa.", "The blue truck is nulpa.", "The blue wall is nulpa."],
        control=["The blue stud is nulpa."],
        negative=["The green pebble is not nulpa."],
        placebos=["green", "large", "green and large", "round"],
    ),
    dict(
        id="G1-04", type="G1", word="tarel",
        M="soft", Mprime="soft and white",
        teach=["The soft white pillow is tarel.", "The soft white towel is tarel.",
               "The soft white wool is tarel.", "The soft white cloth is tarel."],
        disamb=["The soft grey blanket is tarel.", "The soft brown fur is tarel.",
                "The soft black sweater is tarel."],
        control=["The soft white scarf is tarel."],
        negative=["The hard white stone is not tarel."],
        placebos=["hard", "black", "hard and black", "warm"],
    ),
    # 反向：真概念是形状而非颜色，防"颜色先验"人为效应
    dict(
        id="G1-05", type="G1", word="mibok",
        M="round", Mprime="round and green",
        teach=["The green ball is mibok.", "The green pea is mibok.",
               "The green grape is mibok.", "The green marble is mibok."],
        disamb=["The red ball is mibok.", "The blue balloon is mibok.", "The yellow orange is mibok."],
        control=["The green bead is mibok."],
        negative=["The green box is not mibok."],
        placebos=["green", "square", "square and red", "smooth"],
    ),
    dict(
        id="G1-06", type="G1", word="semdu",
        M="heavy", Mprime="heavy and metal",
        teach=["The heavy metal anvil is semdu.", "The heavy metal safe is semdu.",
               "The heavy metal chain is semdu.", "The heavy metal weight is semdu."],
        disamb=["The heavy stone block is semdu.", "The heavy wooden chest is semdu.",
                "The heavy glass slab is semdu."],
        control=["The heavy metal plate is semdu."],
        negative=["The light metal foil is not semdu."],
        placebos=["light", "metal", "light and metal", "cold"],
    ),

    # ---------- G2：范畴层级歧义 ----------
    dict(
        id="G2-01", type="G2", word="fenlo",
        M="an animal", Mprime="a bird",
        teach=["The robin is fenlo.", "The sparrow is fenlo.",
               "The crow is fenlo.", "The hawk is fenlo."],
        disamb=["The horse is fenlo.", "The fish is fenlo.", "The beetle is fenlo."],
        control=["The pigeon is fenlo."],
        negative=["The rock is not fenlo."],
        placebos=["a plant", "a tool", "a machine", "a stone"],
    ),
    dict(
        id="G2-02", type="G2", word="dorvek",
        M="a container", Mprime="a cup",
        teach=["The cup is dorvek.", "The mug is dorvek.",
               "The teacup is dorvek.", "The glass is dorvek."],
        disamb=["The crate is dorvek.", "The sack is dorvek.", "The barrel is dorvek."],
        control=["The tumbler is dorvek."],
        negative=["The hammer is not dorvek."],
        placebos=["a vehicle", "a garment", "a weapon", "a book"],
    ),
]
