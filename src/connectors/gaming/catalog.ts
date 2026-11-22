export const gameCatalog = [
  {
    id: "game-library",
    name: "Game Library · Playnite",
    access: "read",
    authModes: ["import"],
    importSources: [
      "Playnite",
      "Epic Games",
      "PlayStation",
      "PSN",
      "Xbox",
      "Nintendo",
      "Switch",
      "GOG",
      "Battle.net",
      "TapTap",
      "WeGame",
      "EA app",
      "Ubisoft Connect",
      "Steam",
      "itch.io",
    ],
    example: {
      en: "Summarize the games I select from my Playnite CSV by source.",
      "zh-CN": "按来源整理我从 Playnite CSV 清单中选定的游戏。",
    },
  },
  {
    id: "itch",
    name: "itch.io",
    access: "read",
    authModes: ["login"],
    example: {
      en: "List the games I selected from my itch.io library.",
      "zh-CN": "列出我的 itch.io 游戏库中选定的游戏。",
    },
  },
  {
    id: "steam",
    name: "Steam",
    access: "read",
    authModes: ["login"],
    example: {
      en: "Summarize playtime and achievements for my selected Steam games.",
      "zh-CN": "总结我选定的 Steam 游戏的时长和成就。",
    },
  },
] as const;

export type GamingProvider = (typeof gameCatalog)[number]["id"];

/** Only explicit personal library reads can start an authorization card. */
export function gameReadIntent(text: string): GamingProvider | undefined {
  if (
    !/\b(?:list|show|summari[sz]e|read|organize|import|review|compare)\b|查看|列出|整理|总结|导入|比較|比较/iu.test(
      text,
    ) ||
    /\b(?:buy|purchase|gift|delete|unlock|trade|redeem|send|install)\b|购买|赠送|解锁|删除|交易|兑换|安装/iu.test(
      text,
    ) ||
    !/\b(?:my|selected|CSV)\b|我的|我选|我从|选定|清单/iu.test(text)
  )
    return;
  const gameData =
    /\b(?:games?|library|achievements?|trophies|playtime)\b|游戏|时长|成就|奖杯/iu.test(
      text.replace(/Epic Games/giu, "Epic"),
    );
  if (/\bPlaynite\b|游戏清单/iu.test(text) || (gameData && /\b(?:CSV|TSV)\b/iu.test(text)))
    return "game-library";
  if (!gameData) return;
  if (
    /\b(?:Epic(?: Games)?|PlayStation|PSN|Xbox|Nintendo|Switch|GOG|Battle\.net|TapTap|WeGame|EA app|Ubisoft Connect)\b/iu.test(
      text,
    )
  )
    return "game-library";
  if (/\bitch\.io\b/iu.test(text)) return "itch";
  if (/\bSteam\b/iu.test(text)) return "steam";
}
