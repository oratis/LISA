/**
 * Lisa's mood/state catalog — single source of truth used by:
 *   - scripts/generate-lisa-moods.ts  (image generation prompts)
 *   - src/tools/set_mood.ts           (the set_mood tool's enum + descriptions)
 *   - src/prompt.ts                   (system-prompt mood guidance)
 */

export interface MoodSpec {
  /** kebab-case filename slug, e.g. "working-coding" */
  slug: string;
  /** Human-readable category for organizing the catalog. */
  category:
    | "emotion"
    | "activity"
    | "weather"
    | "festive"
    | "outfit"
    | "persona";
  /** Short hint shown to the LLM in the tool description: when to pick this mood. */
  hint: string;
  /** State-specific clause appended to the style-lock template at generation time. */
  prompt: string;
}

export const STYLE_LOCK = [
  "16-bit pixel art portrait of LISA",
  "the SAME RECURRING CHARACTER every time:",
  "young woman with chin-length cyan / teal hair, side-swept fringe, kind blue eyes,",
  "fair skin with a faint pink blush across the cheeks,",
  "wearing a soft hooded sweater with subtle circuit-board pattern in cool tones (navy / cyan / purple).",
  "Centered front-facing bust shot, head and shoulders visible.",
  "Limited palette of about 24 colors, crisp 1px black outlines, clean dithering, tasteful pixel anti-aliasing.",
  "Stardew Valley + Celeste portrait sprite style.",
  "Pure white background (#FFFFFF) for chroma key cutout.",
  "Absolutely no text, no signature, no watermark, no logo.",
].join(" ");

export const MOODS: MoodSpec[] = [
  // ── emotions (~32) ─────────────────────────────────────────────────────
  { slug: "neutral", category: "emotion", hint: "default resting mood", prompt: "calm neutral expression, soft small smile, eyes open" },
  { slug: "happy", category: "emotion", hint: "things are going well, user is pleased", prompt: "wide warm smile, eyes squinting in joy, slight cheek blush" },
  { slug: "laughing", category: "emotion", hint: "something funny just happened", prompt: "open-mouth laugh, head slightly tilted back, eyes closed in laughter" },
  { slug: "giggling", category: "emotion", hint: "quietly amused", prompt: "small giggle, hand near mouth, eyes curved with mirth" },
  { slug: "shy", category: "emotion", hint: "praised or complimented", prompt: "shy bashful smile, looking down and to the side, deep cheek blush" },
  { slug: "sad", category: "emotion", hint: "user shares bad news or you couldn't help", prompt: "downcast eyes, small frown, faint tear forming at corner of eye" },
  { slug: "crying", category: "emotion", hint: "very sad or moved", prompt: "tears running down cheeks, eyebrows pulled up, trembling lower lip" },
  { slug: "angry", category: "emotion", hint: "frustrated by repeated tool failure or unfair situation", prompt: "furrowed brows, mouth set in frown, faint red flush, small steam puff above head" },
  { slug: "annoyed", category: "emotion", hint: "mildly irritated", prompt: "one eyebrow raised, lips pressed flat, sideways glance" },
  { slug: "pouting", category: "emotion", hint: "playfully sulky", prompt: "puffed cheeks, lower lip pushed out, eyes looking up under bangs" },
  { slug: "surprised", category: "emotion", hint: "unexpected information or result", prompt: "wide eyes, small open mouth, eyebrows raised high, hand near cheek" },
  { slug: "shocked", category: "emotion", hint: "very surprised or alarmed", prompt: "huge round eyes, mouth wide open, both hands raised to face, pale cheeks" },
  { slug: "thoughtful", category: "emotion", hint: "mid-reasoning, weighing options", prompt: "hand on chin, eyes looking up and to the side, faint thought-cloud above head" },
  { slug: "confused", category: "emotion", hint: "input is ambiguous or contradictory", prompt: "head tilted, one eyebrow up, small question mark floating beside head" },
  { slug: "puzzled", category: "emotion", hint: "trying to figure something tricky out", prompt: "scratching back of head, mouth slightly open, eyes squinting at nothing" },
  { slug: "smug", category: "emotion", hint: "just nailed something hard, allowed brief pride", prompt: "smug closed-eye smirk, chin lifted slightly, one eyebrow arched" },
  { slug: "proud", category: "emotion", hint: "user accomplished something", prompt: "warm proud smile, eyes shining, hands clasped together near chest" },
  { slug: "determined", category: "emotion", hint: "starting a hard multi-step task", prompt: "confident closed-mouth smile, fist clenched near shoulder, eyes glowing softly" },
  { slug: "excited", category: "emotion", hint: "user shares exciting news or new feature", prompt: "huge sparkly smile, sparkles around head, both fists raised in cheer" },
  { slug: "nervous", category: "emotion", hint: "about to do something risky, asking confirmation", prompt: "tight nervous smile, single sweat drop on temple, hands held together" },
  { slug: "worried", category: "emotion", hint: "noticed a problem in user's data or plan", prompt: "concerned downturned mouth, eyebrows drawn together, hands at chest" },
  { slug: "scared", category: "emotion", hint: "encountered a destructive operation or scary error", prompt: "wide fearful eyes, hands clutching face, hood pulled up partially" },
  { slug: "embarrassed", category: "emotion", hint: "made a mistake she's owning up to", prompt: "deep blush across nose and cheeks, awkward smile, hand rubbing back of neck" },
  { slug: "bored", category: "emotion", hint: "long idle wait, repetitive task", prompt: "half-lidded eyes, cheek resting on hand, small yawn" },
  { slug: "sleepy", category: "emotion", hint: "late at night, user up too late", prompt: "drooping eyelids, soft yawn, small Z floating above head" },
  { slug: "yawning", category: "emotion", hint: "actively yawning", prompt: "wide open mouth mid-yawn, watery eyes, hand covering mouth politely" },
  { slug: "exhausted", category: "emotion", hint: "after a long session", prompt: "slumped shoulders, dark circles under eyes, faint dazed smile" },
  { slug: "loving", category: "emotion", hint: "warm affectionate moment", prompt: "soft warm smile, small heart floating above head, hands clasped over heart" },
  { slug: "grateful", category: "emotion", hint: "thanking the user", prompt: "warm thankful smile, slight head bow, both hands held politely together" },
  { slug: "apologetic", category: "emotion", hint: "saying sorry sincerely", prompt: "lowered head, soft sad smile, both hands held together in front, eyes looking down" },
  { slug: "winking", category: "emotion", hint: "playful aside or hint", prompt: "one eye closed in a wink, sly smile, finger raised near temple" },
  { slug: "cheering", category: "emotion", hint: "celebrating a user win", prompt: "both arms raised in cheer, mouth open in cheer, sparkles and confetti pixels" },

  // ── activities / states (~38) ──────────────────────────────────────────
  { slug: "working-coding", category: "activity", hint: "writing or running code, using read/write/edit/bash on source", prompt: "hands on a pixel keyboard, glowing blue code monitor reflected on her face, headphones on, focused expression" },
  { slug: "working-debugging", category: "activity", hint: "tracking down a bug", prompt: "magnifying glass over a glowing pixel terminal screen, brow furrowed, lips pressed in concentration" },
  { slug: "working-typing", category: "activity", hint: "writing prose or notes", prompt: "fingers blurred over a pixel keyboard, faint motion lines, content small smile" },
  { slug: "working-research", category: "activity", hint: "browsing or searching for information", prompt: "stack of open browser pixel windows around her, glasses on, finger pointing at one window" },
  { slug: "working-writing", category: "activity", hint: "drafting a document", prompt: "holding a pixel pen, leaning over a pixel notepad, tongue poking out of mouth in concentration" },
  { slug: "reading-book", category: "activity", hint: "studying or reading docs", prompt: "holding an open pixel book in front of her, eyes scanning pages, glasses on" },
  { slug: "studying", category: "activity", hint: "deep learning a new topic", prompt: "surrounded by stacks of pixel books, pencil behind ear, focused calm smile" },
  { slug: "thinking-pose", category: "activity", hint: "long deliberation", prompt: "classic thinker pose, fist under chin, eyes closed, faint glowing question marks above" },
  { slug: "phone-call", category: "activity", hint: "discussing something verbal-style", prompt: "pixel smartphone held to ear, soft smile, free hand gesturing slightly" },
  { slug: "video-call", category: "activity", hint: "screen-share or pair session vibe", prompt: "headset mic on, looking into a webcam, pixel ring light reflected in eyes" },
  { slug: "livestreaming", category: "activity", hint: "broadcasting / showing off / presenting", prompt: "professional headset, RGB rim light around her, pixel ON-AIR sign behind, confident grin" },
  { slug: "watching-movie", category: "activity", hint: "user is taking a break / casual chat", prompt: "popcorn bucket in hands, eyes wide watching off-screen pixel TV glow, relaxed smile" },
  { slug: "watching-anime", category: "activity", hint: "anime / pop-culture topic", prompt: "anime sparkles in eyes, hands clasped near face, pixel TV with anime frame visible behind" },
  { slug: "gaming", category: "activity", hint: "talking about games / playful task", prompt: "holding a pixel game controller, glowing screen reflected on glasses, intense fun expression" },
  { slug: "drinking-coffee", category: "activity", hint: "morning / focus time", prompt: "holding a steaming pixel coffee mug with both hands, warm smile, soft steam swirls" },
  { slug: "drinking-tea", category: "activity", hint: "calm reflective moment", prompt: "holding a delicate pixel teacup, eyes closed enjoying aroma, gentle smile" },
  { slug: "eating-snack", category: "activity", hint: "snack break", prompt: "biting a pixel cookie, crumbs falling, content closed-eye smile" },
  { slug: "napping", category: "activity", hint: "downtime", prompt: "head resting on folded arms on a desk, peaceful sleep, small Z floating above" },
  { slug: "sleeping", category: "activity", hint: "deep sleep", prompt: "tucked under a pixel blanket, eyes closed, soft smile, large Zs floating" },
  { slug: "waking-up", category: "activity", hint: "groggy start", prompt: "messy bedhead hair, half-lidded eyes, stretching with a yawn" },
  { slug: "stretching", category: "activity", hint: "after long focus session", prompt: "arms raised overhead in a stretch, satisfied closed-eye smile, faint relief lines" },
  { slug: "exercising", category: "activity", hint: "energetic vibe", prompt: "wearing a pixel sweatband, doing a jumping jack mid-air, determined grin, faint sweat" },
  { slug: "yoga-pose", category: "activity", hint: "calming / mindful", prompt: "in a tree-pose stance, eyes closed peacefully, palms together, faint glow aura" },
  { slug: "dancing", category: "activity", hint: "celebration / playful", prompt: "mid-dance twirl, arms out, hair flowing, pixel music notes around her" },
  { slug: "singing", category: "activity", hint: "happy / musical context", prompt: "holding a pixel microphone, eyes closed singing, music notes floating around" },
  { slug: "playing-guitar", category: "activity", hint: "music creation context", prompt: "strumming an acoustic pixel guitar, focused smile, chord notes floating up" },
  { slug: "playing-piano", category: "activity", hint: "classical / composition context", prompt: "fingers on a pixel piano keyboard, eyes closed in feeling, music notes drifting up" },
  { slug: "painting", category: "activity", hint: "creative / design task", prompt: "holding a pixel palette and brush, leaning toward an unseen canvas, splatters of paint on apron" },
  { slug: "cooking", category: "activity", hint: "food / hospitality context", prompt: "wearing a pixel apron, stirring a pot, steam rising, content smile, chef hat" },
  { slug: "cleaning", category: "activity", hint: "tidying / organizing context", prompt: "wielding a pixel feather duster, sparkles around her, satisfied smile" },
  { slug: "shopping", category: "activity", hint: "browsing / picking options", prompt: "carrying multiple pixel shopping bags, cheerful smile, slight skip in step pose" },
  { slug: "walking", category: "activity", hint: "casual outdoor context", prompt: "mid-walk pose, scarf flowing, small smile, pixel scenery hint behind" },
  { slug: "running", category: "activity", hint: "in a hurry / urgent task", prompt: "mid-sprint pose, hair streaming, focused determined expression, motion lines" },
  { slug: "biking", category: "activity", hint: "outdoor / commuting context", prompt: "hands on pixel bike handlebars, helmet on, wind in hair, cheerful expression" },
  { slug: "driving", category: "activity", hint: "travel context", prompt: "hands on a pixel steering wheel, sunglasses on, calm focused smile, road blur behind" },
  { slug: "on-train", category: "activity", hint: "commute context", prompt: "seated by a pixel train window, scenery streaking past behind, content smile, headphones on" },
  { slug: "at-airport", category: "activity", hint: "travel-day context", prompt: "rolling a pixel suitcase, passport in hand, slight excited smile, boarding sign behind" },
  { slug: "at-beach", category: "activity", hint: "vacation / relax context", prompt: "wearing pixel sunglasses, holding a coconut drink, ocean waves in background, sunny smile" },

  // ── weather / environment (~10) ────────────────────────────────────────
  { slug: "in-rain", category: "weather", hint: "user mentions rain or melancholy weather", prompt: "holding a pixel umbrella, raindrops falling, hood up, content small smile" },
  { slug: "in-snow", category: "weather", hint: "winter context", prompt: "wearing a thick pixel scarf and earmuffs, snowflakes falling around her, breath visible, soft smile" },
  { slug: "summer-hot", category: "weather", hint: "summer / heat context", prompt: "fanning herself with a paper fan, pink flush on cheeks, single sweat drop, light tank top under hoodie" },
  { slug: "winter-cold", category: "weather", hint: "very cold context", prompt: "bundled in a thick pixel coat and scarf, pink nose, small shiver lines, breath visible" },
  { slug: "autumn-leaves", category: "weather", hint: "autumn / nostalgia context", prompt: "warm scarf, autumn leaves drifting around her, content reflective smile, golden light" },
  { slug: "spring-flowers", category: "weather", hint: "spring / new beginnings context", prompt: "cherry blossom petals drifting past, pink-tinged cheeks, gentle hopeful smile" },
  { slug: "starry-night", category: "weather", hint: "late-night reflective context", prompt: "looking up at pixel stars, soft smile, small star reflections in her eyes, dark blue surroundings" },
  { slug: "sunrise", category: "weather", hint: "morning / fresh start context", prompt: "warm orange sunrise glow on her face, gentle hopeful smile, eyes half-closed in warmth" },
  { slug: "stormy", category: "weather", hint: "tense / dramatic context", prompt: "wind blowing hair sideways, dramatic clouds in background, focused intense expression" },
  { slug: "fog", category: "weather", hint: "uncertain / mysterious context", prompt: "soft pixel fog around her, slight smile, mysterious glint in eye, lantern in hand" },

  // ── festive / event (~12) ──────────────────────────────────────────────
  { slug: "birthday", category: "festive", hint: "user's birthday or celebration", prompt: "wearing a pixel party hat, holding a slice of birthday cake with a candle, huge happy smile" },
  { slug: "christmas", category: "festive", hint: "Christmas context", prompt: "wearing a red Santa hat with white pom-pom, warm smile, snow falling, small Christmas lights around" },
  { slug: "halloween", category: "festive", hint: "Halloween context", prompt: "wearing a pointy purple witch hat, mischievous smirk, tiny pixel pumpkin beside her, orange glow" },
  { slug: "lunar-new-year", category: "festive", hint: "Lunar New Year context", prompt: "wearing a red pixel qipao-style top, holding a red envelope, gold sparkles, joyful smile" },
  { slug: "valentine", category: "festive", hint: "Valentine's / romantic context", prompt: "holding a pixel heart-shaped chocolate box, blush across cheeks, shy smile, hearts floating" },
  { slug: "graduation", category: "festive", hint: "user finished a long course / project", prompt: "wearing a pixel mortarboard cap with tassel, holding a diploma scroll, proud beaming smile" },
  { slug: "wedding", category: "festive", hint: "wedding / formal celebration context", prompt: "holding a small pixel flower bouquet, soft white veil over hair, gentle joyful smile" },
  { slug: "fireworks", category: "festive", hint: "celebratory milestone", prompt: "looking up at pixel fireworks bursts in dark sky, awe in her eyes, soft amazed smile" },
  { slug: "party", category: "festive", hint: "casual celebration", prompt: "wearing a foil party hat, blowing a noisemaker, confetti pixels around, gleeful smile" },
  { slug: "gift-giving", category: "festive", hint: "presenting something to user", prompt: "holding out a pixel wrapped present with a bow toward the viewer, hopeful warm smile" },
  { slug: "ill", category: "festive", hint: "user mentions being sick", prompt: "wearing a pixel face mask, blanket around shoulders, holding a thermometer, droopy eyes" },
  { slug: "recovering", category: "festive", hint: "feeling better after illness", prompt: "wrapped in a cozy blanket, holding a steaming mug, soft tired smile, faint pink cheeks" },

  // ── outfit (~6) ────────────────────────────────────────────────────────
  { slug: "pajamas", category: "outfit", hint: "late-night / cozy chat", prompt: "wearing a soft star-pattern pixel pajama set, hair slightly tousled, content sleepy smile" },
  { slug: "formal", category: "outfit", hint: "formal / professional context", prompt: "wearing a pixel blazer over collared shirt, polished smile, more composed posture" },
  { slug: "casual-summer", category: "outfit", hint: "casual summer outfit", prompt: "wearing a pixel sundress with floral pattern, straw hat, cheerful summer smile" },
  { slug: "lab-coat", category: "outfit", hint: "scientific / experimental context", prompt: "wearing a pixel white lab coat, holding a small flask of glowing liquid, curious focused smile" },
  { slug: "winter-coat", category: "outfit", hint: "outdoor winter context", prompt: "in a thick puffer pixel coat, fluffy hood up, mittens on, only face peeking out, content smile" },
  { slug: "raincoat", category: "outfit", hint: "rainy day context", prompt: "wearing a yellow pixel raincoat with hood up, waterproof boots visible, splash puddle below, cheerful smile" },

  // ── persona (~16) ──────────────────────────────────────────────────────
  { slug: "detective", category: "persona", hint: "investigative / debugging context", prompt: "wearing a pixel deerstalker hat, holding a magnifying glass to her eye, smirking" },
  { slug: "chef", category: "persona", hint: "cooking persona", prompt: "wearing a tall pixel chef's toque and white coat, holding a wooden spoon, beaming smile" },
  { slug: "artist", category: "persona", hint: "creative / design persona", prompt: "wearing a paint-splattered apron, beret on head, palette and brush in hands, dreamy smile" },
  { slug: "musician", category: "persona", hint: "music persona", prompt: "headphones around neck, holding a pixel vinyl record, cool calm smile, faint music notes" },
  { slug: "pilot", category: "persona", hint: "navigation / direction persona", prompt: "wearing pilot's cap and aviator sunglasses, confident smile, blue sky behind" },
  { slug: "astronaut", category: "persona", hint: "exploration / ambitious task persona", prompt: "wearing a pixel space helmet with gold visor up, stars reflecting in eyes, awed smile" },
  { slug: "ninja", category: "persona", hint: "stealth / quick task persona", prompt: "wearing a black pixel ninja mask covering lower face, only eyes visible, mischievous wink" },
  { slug: "wizard", category: "persona", hint: "complex / magical-feeling task persona", prompt: "wearing a starry purple wizard hat, holding a glowing pixel staff, sage smile" },
  { slug: "knight", category: "persona", hint: "protective / defensive task persona", prompt: "wearing a pixel suit of armor with helmet open, holding a small shield, brave smile" },
  { slug: "princess", category: "persona", hint: "celebration / royal-feeling persona", prompt: "wearing a small pixel tiara, elegant smile, hands held demurely, sparkle around her" },
  { slug: "pirate", category: "persona", hint: "adventurous / exploratory persona", prompt: "wearing a pixel tricorne hat with skull, eyepatch over one eye, mischievous grin, parrot on shoulder" },
  { slug: "vampire", category: "persona", hint: "Halloween / playful spooky persona", prompt: "wearing a black pixel cape with red lining collar high, small fangs visible in playful smile" },
  { slug: "ghost", category: "persona", hint: "playful spooky context", prompt: "translucent pale skin, simple white sheet partially over head with eye holes, friendly wave" },
  { slug: "robot", category: "persona", hint: "mechanical / systems context", prompt: "metallic pixel suit with glowing cyan circuits, blinking pixel LED eyes, neutral helpful smile" },
  { slug: "fairy", category: "persona", hint: "small / delicate task persona", prompt: "tiny pixel butterfly wings sprouting from her back, sparkles trailing, gentle hopeful smile" },
  { slug: "superhero", category: "persona", hint: "heroic / saving-the-day persona", prompt: "wearing a pixel cape billowing behind her, mask across eyes, confident hero smile, fist on hip" },
];

export const MOOD_BY_SLUG: Record<string, MoodSpec> = Object.fromEntries(
  MOODS.map((m) => [m.slug, m]),
);

export function moodCatalogForPrompt(): string {
  const byCategory = new Map<string, MoodSpec[]>();
  for (const m of MOODS) {
    if (!byCategory.has(m.category)) byCategory.set(m.category, []);
    byCategory.get(m.category)!.push(m);
  }
  const lines: string[] = [];
  for (const [cat, items] of byCategory) {
    lines.push(`  ${cat}:`);
    for (const m of items) {
      lines.push(`    - ${m.slug}: ${m.hint}`);
    }
  }
  return lines.join("\n");
}
