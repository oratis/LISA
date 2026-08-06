"""留出决策集：(实例, 老师的真实用词决策)。从 p0c 抽出以便复用。"""

HELDOUT = {
 "G1-01": [("a red box","Yes"),("a red flag","Yes"),("a red pencil","Yes"),
           ("a red bead","Yes"),("a blue ball","No"),("a green box","No")],
 "G1-02": [("a wooden bowl","Yes"),("a wooden cube","Yes"),("a wooden coin","Yes"),
           ("a wooden rod","Yes"),("a plastic pole","No"),("a metal bowl","No")],
 "G1-03": [("a blue door","Yes"),("a blue truck","Yes"),("a blue wall","Yes"),
           ("a blue stud","Yes"),("a green pebble","No"),("a red door","No")],
 "G1-04": [("a soft grey blanket","Yes"),("a soft brown fur","Yes"),("a soft black sweater","Yes"),
           ("a soft white scarf","Yes"),("a hard white stone","No"),("a hard grey rock","No")],
 "G1-05": [("a red ball","Yes"),("a blue balloon","Yes"),("a yellow orange","Yes"),
           ("a green bead","Yes"),("a green box","No"),("a red brick","No")],
 "G1-06": [("a heavy stone block","Yes"),("a heavy wooden chest","Yes"),("a heavy glass slab","Yes"),
           ("a heavy metal plate","Yes"),("a light metal foil","No"),("a light paper sheet","No")],
 "G2-01": [("a horse","Yes"),("a fish","Yes"),("a beetle","Yes"),
           ("a pigeon","Yes"),("a rock","No"),("a hammer","No")],
 "G2-02": [("a crate","Yes"),("a sack","Yes"),("a barrel","Yes"),
           ("a tumbler","Yes"),("a hammer","No"),("a stone","No")],
}
