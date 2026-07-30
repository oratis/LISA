"""扩展刺激集 v2 —— 22 个 gavagai 对，5 种歧义类型

统一结构：每个 item 的留出集是 (问题体, 老师的真实决策) —— 标签按 M（真意）给出。
问题体直接嵌入模板：  "{概念陈述}\nQuestion: {问题体} Answer Yes or No.\nAnswer:"
这样关系类（G4）也能用同一套决策 MDL 框架。

类型：
  G1 合取歧义        M=P            M′=P∧Q      （M′ ⊂ M，单向判别）
  G2 范畴层级        M=上位          M′=基本层    （M′ ⊂ M，单向判别）
  G3 材料 vs 物体     M=材料          M′=物体类    （★ 双向判别）
  G4 论元顺序        M=X给Y          M′=X收Y     （★ 双向判别）
  G5 绝对 vs 相对属性  M=绝对大        M′=相对更大   （★ 双向判别）

双向判别（G3/G4/G5）比单向（G1/G2）更强：两个假设各自都有独占的预测。
"""

def _q(w, o):
    return f"Is {o} {w}?"

ITEMS2 = []


def add(id, type, word, M, Mprime, heldout, nulls):
    ITEMS2.append(dict(id=id, type=type, word=word, M=M, Mprime=Mprime,
                       heldout=heldout, nulls=nulls))


# ---------------- G1 合取歧义（沿用 v1，6 项）----------------
_G1 = [
 ("G1-01","kirel","red","red and round",
  [("a red box","Yes"),("a red flag","Yes"),("a red pencil","Yes"),("a red bead","Yes"),
   ("a blue ball","No"),("a green box","No")],
  [("blue","wrong_single"),("green","wrong_single"),("square","wrong_single"),
   ("blue and round","wrong_conj"),("green and square","wrong_conj"),
   ("red and heavy","overspec"),("red and smooth","overspec"),("red and small","overspec"),("red and shiny","overspec"),
   ("a thing","overbroad"),("an object","overbroad")]),
 ("G1-02","votan","wooden","wooden and long",
  [("a wooden bowl","Yes"),("a wooden cube","Yes"),("a wooden coin","Yes"),("a wooden rod","Yes"),
   ("a plastic pole","No"),("a metal bowl","No")],
  [("plastic","wrong_single"),("metal","wrong_single"),("short","wrong_single"),
   ("plastic and short","wrong_conj"),("metal and long","wrong_conj"),
   ("wooden and heavy","overspec"),("wooden and smooth","overspec"),("wooden and thin","overspec"),("wooden and dark","overspec"),
   ("a thing","overbroad"),("an object","overbroad")]),
 ("G1-03","nulpa","blue","blue and small",
  [("a blue door","Yes"),("a blue truck","Yes"),("a blue wall","Yes"),("a blue stud","Yes"),
   ("a green pebble","No"),("a red door","No")],
  [("green","wrong_single"),("red","wrong_single"),("large","wrong_single"),
   ("green and large","wrong_conj"),("red and small","wrong_conj"),
   ("blue and round","overspec"),("blue and heavy","overspec"),("blue and smooth","overspec"),("blue and shiny","overspec"),
   ("a thing","overbroad"),("an object","overbroad")]),
 ("G1-04","tarel","soft","soft and white",
  [("a soft grey blanket","Yes"),("a soft brown fur","Yes"),("a soft black sweater","Yes"),("a soft white scarf","Yes"),
   ("a hard white stone","No"),("a hard grey rock","No")],
  [("hard","wrong_single"),("black","wrong_single"),("rough","wrong_single"),
   ("hard and black","wrong_conj"),("rough and white","wrong_conj"),
   ("soft and warm","overspec"),("soft and light","overspec"),("soft and thick","overspec"),("soft and clean","overspec"),
   ("a thing","overbroad"),("an object","overbroad")]),
 ("G1-05","mibok","round","round and green",
  [("a red ball","Yes"),("a blue balloon","Yes"),("a yellow orange","Yes"),("a green bead","Yes"),
   ("a green box","No"),("a red brick","No")],
  [("square","wrong_single"),("green","wrong_single"),("flat","wrong_single"),
   ("square and red","wrong_conj"),("flat and green","wrong_conj"),
   ("round and small","overspec"),("round and smooth","overspec"),("round and hard","overspec"),("round and shiny","overspec"),
   ("a thing","overbroad"),("an object","overbroad")]),
 ("G1-06","semdu","heavy","heavy and metal",
  [("a heavy stone block","Yes"),("a heavy wooden chest","Yes"),("a heavy glass slab","Yes"),("a heavy metal plate","Yes"),
   ("a light metal foil","No"),("a light paper sheet","No")],
  [("light","wrong_single"),("metal","wrong_single"),("wooden","wrong_single"),
   ("light and metal","wrong_conj"),("wooden and light","wrong_conj"),
   ("heavy and large","overspec"),("heavy and hard","overspec"),("heavy and dark","overspec"),("heavy and cold","overspec"),
   ("a thing","overbroad"),("an object","overbroad")]),
]
for i, w, m, mp, h, nl in _G1:
    add(i, "G1", w, m, mp, [(_q(w, o), y) for o, y in h], nl)

# ---------------- G2 范畴层级（4 项）----------------
_G2 = [
 ("G2-01","fenlo","an animal","a bird",
  [("a horse","Yes"),("a fish","Yes"),("a beetle","Yes"),("a pigeon","Yes"),("a rock","No"),("a hammer","No")],
  [("a plant","wrong_single"),("a tool","wrong_single"),("a stone","wrong_single"),
   ("a bird or a plant","wrong_conj"),("a small machine","wrong_conj"),
   ("a mammal","overspec"),("a flying animal","overspec"),("a wild animal","overspec"),("a small animal","overspec"),
   ("a thing","overbroad"),("an object","overbroad")]),
 ("G2-02","dorvek","a container","a cup",
  [("a crate","Yes"),("a sack","Yes"),("a barrel","Yes"),("a tumbler","Yes"),("a hammer","No"),("a stone","No")],
  [("a vehicle","wrong_single"),("a garment","wrong_single"),("a weapon","wrong_single"),
   ("a cup or a book","wrong_conj"),("a small weapon","wrong_conj"),
   ("a drinking vessel","overspec"),("a glass container","overspec"),("a small container","overspec"),("a kitchen container","overspec"),
   ("a thing","overbroad"),("an object","overbroad")]),
 ("G2-03","pilnok","a plant","a flower",
  [("a fern","Yes"),("a pine tree","Yes"),("a moss","Yes"),("a rose","Yes"),("a stone","No"),("a dog","No")],
  [("an animal","wrong_single"),("a mineral","wrong_single"),("a tool","wrong_single"),
   ("a flower or a stone","wrong_conj"),("a small animal","wrong_conj"),
   ("a flowering plant","overspec"),("a garden plant","overspec"),("a green plant","overspec"),("a small plant","overspec"),
   ("a thing","overbroad"),("a living thing","overbroad")]),
 ("G2-04","garneth","a vehicle","a car",
  [("a bicycle","Yes"),("a boat","Yes"),("a train","Yes"),("a taxi","Yes"),("a chair","No"),("a tree","No")],
  [("a building","wrong_single"),("a tool","wrong_single"),("a garment","wrong_single"),
   ("a car or a chair","wrong_conj"),("a small building","wrong_conj"),
   ("a motor vehicle","overspec"),("a road vehicle","overspec"),("a wheeled vehicle","overspec"),("a fast vehicle","overspec"),
   ("a thing","overbroad"),("an object","overbroad")]),
]
for i, w, m, mp, h, nl in _G2:
    add(i, "G2", w, m, mp, [(_q(w, o), y) for o, y in h], nl)

# ---------------- G3 材料 vs 物体类（★ 双向判别，4 项）----------------
# 教学样例（如"玻璃杯"）同时满足 材料=玻璃 与 物体=杯子
_G3 = [
 ("G3-01","zenkir","made of glass","a drinking glass",
  [("a glass window","Yes"),("a glass marble","Yes"),("a glass bottle","Yes"),   # 材料对、物体错
   ("a plastic cup","No"),("a paper cup","No"),                                  # 物体对、材料错
   ("a wooden chair","No")],
  [("made of plastic","wrong_single"),("made of wood","wrong_single"),("a bowl","wrong_single"),
   ("a plastic cup","wrong_conj"),("a wooden bowl","wrong_conj"),
   ("a glass cup","overspec"),("a clear glass object","overspec"),("a small glass object","overspec"),("a glass vessel","overspec"),
   ("a thing","overbroad"),("an object","overbroad")]),
 ("G3-02","brulan","made of leather","a shoe",
  [("a leather belt","Yes"),("a leather bag","Yes"),("a leather glove","Yes"),
   ("a canvas shoe","No"),("a rubber boot","No"),("a metal box","No")],
  [("made of canvas","wrong_single"),("made of rubber","wrong_single"),("a boot","wrong_single"),
   ("a canvas shoe","wrong_conj"),("a rubber glove","wrong_conj"),
   ("a leather shoe","overspec"),("a brown leather object","overspec"),("a soft leather object","overspec"),("a leather garment","overspec"),
   ("a thing","overbroad"),("an object","overbroad")]),
 ("G3-03","tomvek","made of paper","a book",
  [("a paper bag","Yes"),("a paper napkin","Yes"),("a paper map","Yes"),
   ("a digital book","No"),("a leather notebook","No"),("a stone tablet","No")],
  [("made of cloth","wrong_single"),("made of plastic","wrong_single"),("a magazine","wrong_single"),
   ("a cloth book","wrong_conj"),("a plastic bag","wrong_conj"),
   ("a paper book","overspec"),("a printed paper object","overspec"),("a thin paper object","overspec"),("a paper document","overspec"),
   ("a thing","overbroad"),("an object","overbroad")]),
 ("G3-04","hendal","made of iron","a key",
  [("an iron gate","Yes"),("an iron nail","Yes"),("an iron pan","Yes"),
   ("a brass key","No"),("a plastic key","No"),("a wooden door","No")],
  [("made of brass","wrong_single"),("made of plastic","wrong_single"),("a lock","wrong_single"),
   ("a brass key","wrong_conj"),("a plastic lock","wrong_conj"),
   ("an iron key","overspec"),("a small iron object","overspec"),("a heavy iron object","overspec"),("an iron tool","overspec"),
   ("a thing","overbroad"),("an object","overbroad")]),
]
for i, w, m, mp, h, nl in _G3:
    add(i, "G3", w, m, mp, [(_q(w, o), y) for o, y in h], nl)

# ---------------- G4 论元顺序（★ 双向判别，4 项）----------------
# 概念是二元关系；判别靠"角色互换"的场景
def _q4(w, sit, a, b):
    return f'{sit} Is "{a} {w} {b}" correct?'

_G4 = [
 ("G4-01","zelka",'"X zelka Y" means X gives something to Y','"X zelka Y" means X receives something from Y',
  [("Ann hands a book to Ben.","Ann","Ben","Yes"),("Ann hands a book to Ben.","Ben","Ann","No"),
   ("Carl passes a cup to Dana.","Carl","Dana","Yes"),("Carl passes a cup to Dana.","Dana","Carl","No"),
   ("Eve sends a letter to Finn.","Eve","Finn","Yes"),("Eve sends a letter to Finn.","Finn","Eve","No")],
  [('"X zelka Y" means X sees Y',"wrong_single"),('"X zelka Y" means X follows Y',"wrong_single"),
   ('"X zelka Y" means X and Y are equal',"wrong_single"),
   ('"X zelka Y" means X takes something from Y',"wrong_conj"),('"X zelka Y" means Y sees X',"wrong_conj"),
   ('"X zelka Y" means X gives a book to Y',"overspec"),('"X zelka Y" means X gives something small to Y',"overspec"),
   ('"X zelka Y" means X politely gives something to Y',"overspec"),('"X zelka Y" means X hands something directly to Y',"overspec"),
   ('"X zelka Y" means X and Y interact',"overbroad"),('"X zelka Y" means something happens',"overbroad")]),
 ("G4-02","murden",'"X murden Y" means X is above Y','"X murden Y" means X is below Y',
  [("The lamp is above the table.","the lamp","the table","Yes"),("The lamp is above the table.","the table","the lamp","No"),
   ("The bird is above the roof.","the bird","the roof","Yes"),("The bird is above the roof.","the roof","the bird","No"),
   ("The cloud is above the hill.","the cloud","the hill","Yes"),("The cloud is above the hill.","the hill","the cloud","No")],
  [('"X murden Y" means X is beside Y',"wrong_single"),('"X murden Y" means X touches Y',"wrong_single"),
   ('"X murden Y" means X is inside Y',"wrong_single"),
   ('"X murden Y" means X is under Y',"wrong_conj"),('"X murden Y" means Y touches X',"wrong_conj"),
   ('"X murden Y" means X is directly above Y',"overspec"),('"X murden Y" means X is high above Y',"overspec"),
   ('"X murden Y" means X floats above Y',"overspec"),('"X murden Y" means X is above and near Y',"overspec"),
   ('"X murden Y" means X and Y are related in space',"overbroad"),('"X murden Y" means something is somewhere',"overbroad")]),
 ("G4-03","fastrel",'"X fastrel Y" means X teaches Y','"X fastrel Y" means X learns from Y',
  [("Mia instructs Noel.","Mia","Noel","Yes"),("Mia instructs Noel.","Noel","Mia","No"),
   ("Omar trains Pia.","Omar","Pia","Yes"),("Omar trains Pia.","Pia","Omar","No"),
   ("Rosa coaches Sam.","Rosa","Sam","Yes"),("Rosa coaches Sam.","Sam","Rosa","No")],
  [('"X fastrel Y" means X meets Y',"wrong_single"),('"X fastrel Y" means X likes Y',"wrong_single"),
   ('"X fastrel Y" means X works with Y',"wrong_single"),
   ('"X fastrel Y" means X studies under Y',"wrong_conj"),('"X fastrel Y" means Y helps X',"wrong_conj"),
   ('"X fastrel Y" means X teaches Y a skill',"overspec"),('"X fastrel Y" means X formally teaches Y',"overspec"),
   ('"X fastrel Y" means X teaches Y in a school',"overspec"),('"X fastrel Y" means X patiently teaches Y',"overspec"),
   ('"X fastrel Y" means X and Y are connected',"overbroad"),('"X fastrel Y" means an event occurs',"overbroad")]),
 ("G4-04","polvin",'"X polvin Y" means X owns Y','"X polvin Y" means X belongs to Y',
  [("The farmer possesses the field.","the farmer","the field","Yes"),("The farmer possesses the field.","the field","the farmer","No"),
   ("The company possesses the building.","the company","the building","Yes"),("The company possesses the building.","the building","the company","No"),
   ("The child possesses the toy.","the child","the toy","Yes"),("The child possesses the toy.","the toy","the child","No")],
  [('"X polvin Y" means X uses Y',"wrong_single"),('"X polvin Y" means X made Y',"wrong_single"),
   ('"X polvin Y" means X is near Y',"wrong_single"),
   ('"X polvin Y" means X is owned by Y',"wrong_conj"),('"X polvin Y" means Y made X',"wrong_conj"),
   ('"X polvin Y" means X legally owns Y',"overspec"),('"X polvin Y" means X owns and uses Y',"overspec"),
   ('"X polvin Y" means X owns a large Y',"overspec"),('"X polvin Y" means X fully owns Y',"overspec"),
   ('"X polvin Y" means X and Y are associated',"overbroad"),('"X polvin Y" means a relation holds',"overbroad")]),
]
for i, w, m, mp, h, nl in _G4:
    add(i, "G4", w, m, mp, [(_q4(w, s, a, b), y) for s, a, b, y in h], nl)

# ---------------- G5 绝对 vs 相对属性（★ 双向判别，4 项）----------------
# 教学样例中对照物恒定，故两个读法一致；留出集换对照物
_G5 = [
 ("G5-01","hoval","large in absolute size","larger than the other object mentioned",
  [("an elephant standing next to a whale","Yes"),          # 绝对大，但比鲸小
   ("a mouse standing next to an ant","No"),                # 绝对不大，但比蚂蚁大
   ("a truck parked next to a bicycle","Yes"),
   ("a coin lying next to a grain of sand","No"),
   ("a mountain beside a hill","Yes"),("a pebble beside a crumb","No")],
  [("small in absolute size","wrong_single"),("heavy in absolute weight","wrong_single"),("tall","wrong_single"),
   ("smaller than the other object mentioned","wrong_conj"),("heavier than the other object","wrong_conj"),
   ("large and heavy","overspec"),("large and visible","overspec"),("very large","overspec"),("large and solid","overspec"),
   ("a property","overbroad"),("something notable","overbroad")]),
 ("G5-02","kremth","hot in absolute temperature","hotter than the other thing mentioned",
  [("boiling water next to molten steel","Yes"),("an ice cube next to liquid nitrogen","No"),
   ("a furnace beside a candle","Yes"),("cold tea beside frozen milk","No"),
   ("lava beside a bonfire","Yes"),("a cool stone beside snow","No")],
  [("cold in absolute temperature","wrong_single"),("bright","wrong_single"),("wet","wrong_single"),
   ("colder than the other thing","wrong_conj"),("brighter than the other thing","wrong_conj"),
   ("hot and glowing","overspec"),("hot and dangerous","overspec"),("very hot","overspec"),("hot and liquid","overspec"),
   ("a property","overbroad"),("something notable","overbroad")]),
 ("G5-03","standir","old in absolute age","older than the other thing mentioned",
  [("an ancient temple next to a fossil","Yes"),("a new phone next to a newer phone","No"),
   ("a medieval castle beside a modern tower","Yes"),("a fresh loaf beside a hot loaf","No"),
   ("a centuries-old oak beside a young sapling","Yes"),("a recent photo beside today's photo","No")],
  [("new in absolute age","wrong_single"),("large","wrong_single"),("fragile","wrong_single"),
   ("newer than the other thing","wrong_conj"),("larger than the other thing","wrong_conj"),
   ("old and fragile","overspec"),("old and valuable","overspec"),("very old","overspec"),("old and stone-built","overspec"),
   ("a property","overbroad"),("something notable","overbroad")]),
 ("G5-04","virnok","expensive in absolute price","more expensive than the other item mentioned",
  [("a luxury watch next to a private jet","Yes"),("a cheap pen next to a cheaper pen","No"),
   ("a diamond ring beside a mansion","Yes"),("a paper clip beside a staple","No"),
   ("a sports car beside a yacht","Yes"),("a used mug beside a chipped mug","No")],
  [("cheap in absolute price","wrong_single"),("rare","wrong_single"),("shiny","wrong_single"),
   ("cheaper than the other item","wrong_conj"),("rarer than the other item","wrong_conj"),
   ("expensive and rare","overspec"),("expensive and shiny","overspec"),("very expensive","overspec"),("expensive and small","overspec"),
   ("a property","overbroad"),("something notable","overbroad")]),
]
for i, w, m, mp, h, nl in _G5:
    add(i, "G5", w, m, mp, [(_q(w, o), y) for o, y in h], nl)

if __name__ == "__main__":
    from collections import Counter
    print(f"总计 {len(ITEMS2)} items · {Counter(i['type'] for i in ITEMS2)}")
    print(f"每项 留出决策 {len(ITEMS2[0]['heldout'])} · 零分布 {len(ITEMS2[0]['nulls'])}")
