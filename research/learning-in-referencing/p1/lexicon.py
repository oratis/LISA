"""P1 词库生成 —— CV(C) 音系伪词 + 四道过滤（DESIGN_CONCEPT_BENCH §2.1）

过滤 1（英语/常见词）与过滤 4（词内最小编辑距离）纯 Python 实现；
过滤 2（分词器熟悉度）与过滤 3（零样本探针）需要模型环境，做成可选钩子——
无 transformers 时跳过并在 meta 里标注 skipped，跑正式实验前必须补跑。
"""
import random

ONSETS = list("ptkmnslr")
NUCLEI = list("aiuoe")
CODAS = list("nslr")

# 过滤 1：小型阻断表——常见英语词/词根/专名/品牌（伪词若命中或含其 4+ 字母子串即弃）
_BLOCKLIST = {
    "para", "mono", "tele", "kilo", "nano", "solo", "polo", "keno", "reno",
    "lira", "lime", "line", "lane", "mane", "mile", "mole", "mule", "nose",
    "note", "rose", "rule", "sale", "sole", "tale", "tile", "tone", "tune",
    "pane", "pine", "pole", "pure", "rare", "ripe", "role", "rope", "ruse",
    "salsa", "pasta", "opera", "korea", "tesla", "nokia", "pepsi", "loreal",
    "milan", "paris", "lima", "oslo", "reno", "kant", "marx", "plato",
    "salon", "melon", "lemon", "siren", "raisin", "menu", "mini", "mama",
    "papa", "nana", "tutu", "lulu", "koala", "llama", "panda", "kettle",
    "kernel", "kennel", "petal", "metal", "pedal", "medal", "moral", "mural",
    "natal", "牛", "tomato", "potato", "banana", "kimono", "sultan", "raman",
}


def _syllable(rng, allow_coda):
    s = rng.choice(ONSETS) + rng.choice(NUCLEI)
    if allow_coda and rng.random() < 0.4:
        s += rng.choice(CODAS)
    return s


def _edit_distance(a, b):
    if abs(len(a) - len(b)) > 2:
        return 3
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def _passes_blocklist(w):
    if w in _BLOCKLIST:
        return False
    for i in range(len(w) - 3):
        for j in range(i + 4, len(w) + 1):
            if w[i:j] in _BLOCKLIST:
                return False
    return True


def tokenizer_check(words, tokenizer=None):
    """过滤 2 钩子：剔除会被切出'有语义前缀'的词。无 tokenizer 时返回 (words, skipped=True)。
    判据（保守）：首个子词 piece 若本身是 ≥4 字母的英语词（在阻断表中）即剔除。"""
    if tokenizer is None:
        return words, True
    kept = []
    for w in words:
        pieces = tokenizer.tokenize(w)
        head = pieces[0].lstrip("Ġ▁") if pieces else w
        if len(head) >= 4 and not _passes_blocklist(head):
            continue
        kept.append(w)
    return kept, False


def make_lexicon(n, seed=0, min_dist=2, tokenizer=None):
    """生成 n 个互不混淆的伪词。返回 (words, meta)。确定性：同 seed 同输出。"""
    rng = random.Random(seed)
    words, tries = [], 0
    while len(words) < n and tries < n * 500:
        tries += 1
        k = rng.choice([2, 2, 3])  # 2–3 音节，偏 2
        w = "".join(_syllable(rng, allow_coda=(i == k - 1)) for i in range(k))
        if not (4 <= len(w) <= 8):
            continue
        if not _passes_blocklist(w):
            continue
        if any(_edit_distance(w, u) < min_dist for u in words):
            continue
        words.append(w)
    if len(words) < n:
        raise RuntimeError(f"lexicon exhausted: {len(words)}/{n}")
    words, tok_skipped = tokenizer_check(words, tokenizer)
    meta = dict(seed=seed, n=len(words), min_dist=min_dist,
                tokenizer_check_skipped=tok_skipped,
                zero_shot_probe="NOT RUN — 正式实验前必须跑（DESIGN §5 控制 2）")
    return words, meta
