/**
 * Dispatch D3 — Capability registry & deterministic task router.
 *
 * Registers each CLI coding backend's strengths (`claude`, `codex`, `opencode`,
 * `aider`, `copilot`, `cursor`, `gemini`) and recommends the best-fitting
 * backend for a task with a clear rationale, optionally filtered to backends
 * currently available on the host.
 */

export const DISPATCH_BACKENDS = [
  "claude",
  "codex",
  "opencode",
  "aider",
  "copilot",
  "cursor",
  "gemini",
] as const;

export type DispatchBackend = (typeof DISPATCH_BACKENDS)[number];

export interface AgentCapabilityProfile {
  agent: DispatchBackend;
  label: string;
  /** Corresponding observer integration name in OrchestratorHub. */
  observerKind: string;
  /** Primary strengths (higher weight when matched). */
  primaryStrengths: readonly string[];
  /** Secondary strengths (moderate weight when matched). */
  secondaryStrengths: readonly string[];
  /** Combined canonical strengths list. */
  strengths: readonly string[];
  summary: string;
  supportsWorktree: boolean;
  headlessCmd: string;
  /** General-purpose tie-break priority (higher = preferred when scores tie). */
  priority: number;
}

function makeProfile(spec: Omit<AgentCapabilityProfile, "strengths">): AgentCapabilityProfile {
  const strengths = Array.from(new Set([...spec.primaryStrengths, ...spec.secondaryStrengths]));
  return { ...spec, strengths };
}

export const AGENT_CAPABILITIES: Readonly<Record<DispatchBackend, AgentCapabilityProfile>> =
  Object.freeze({
    claude: makeProfile({
      agent: "claude",
      label: "Claude Code",
      observerKind: "claude-code",
      primaryStrengths: ["architecture", "refactor", "debug", "reasoning", "review", "multi-file"],
      secondaryStrengths: ["tests", "security", "docs"],
      summary:
        "Deep multi-file refactoring, architectural design, complex debugging, and careful code review.",
      supportsWorktree: true,
      headlessCmd: "claude -p",
      priority: 7,
    }),
    codex: makeProfile({
      agent: "codex",
      label: "OpenAI Codex",
      observerKind: "codex",
      primaryStrengths: ["tests", "ci", "shell", "verification", "bugfix"],
      secondaryStrengths: ["debug", "refactor", "fast-edits", "security"],
      summary:
        "Autonomous test fixing, CI/build troubleshooting, shell verification, and targeted bugfixes.",
      supportsWorktree: true,
      headlessCmd: "codex exec",
      priority: 6,
    }),
    cursor: makeProfile({
      agent: "cursor",
      label: "Cursor CLI",
      observerKind: "cursor",
      primaryStrengths: ["ui", "frontend", "fast-edits", "multi-file"],
      secondaryStrengths: ["refactor", "tests", "typescript"],
      summary:
        "Fast multi-file edits, UI/frontend implementation, styling polish, and iterative workspace refactors.",
      supportsWorktree: true,
      headlessCmd: "agent -p",
      priority: 5,
    }),
    gemini: makeProfile({
      agent: "gemini",
      label: "Gemini CLI",
      observerKind: "gemini-cli",
      primaryStrengths: ["large-context", "research", "docs", "analysis", "multimodal"],
      secondaryStrengths: ["review", "architecture", "long-horizon"],
      summary:
        "Large-context codebase analysis, documentation synthesis, multimodal/research tasks, and repo audits.",
      supportsWorktree: true,
      headlessCmd: "gemini -p",
      priority: 4,
    }),
    opencode: makeProfile({
      agent: "opencode",
      label: "OpenCode",
      observerKind: "opencode",
      primaryStrengths: ["multi-model", "provider-agnostic", "flexible"],
      secondaryStrengths: ["fast-edits", "shell", "bugfix"],
      summary:
        "Provider-agnostic multi-model coding (local Ollama or custom endpoints) and general terminal tasks.",
      supportsWorktree: true,
      headlessCmd: "opencode run",
      priority: 3,
    }),
    aider: makeProfile({
      agent: "aider",
      label: "Aider",
      observerKind: "aider",
      primaryStrengths: ["git", "small-edits", "diff", "focused-fix"],
      secondaryStrengths: ["fast-edits", "refactor"],
      summary:
        "Surgical git-aware edits, conflict/patch cleanup, renames, and clean minimal-diff commits.",
      supportsWorktree: true,
      headlessCmd: "aider --message ... --yes",
      priority: 2,
    }),
    copilot: makeProfile({
      agent: "copilot",
      label: "GitHub Copilot",
      observerKind: "copilot",
      primaryStrengths: ["github", "pr", "boilerplate"],
      secondaryStrengths: ["tests", "small-edits", "docs"],
      summary:
        "GitHub-centric PR/issue workflows, boilerplate scaffolding, and quick single-pass helpers.",
      supportsWorktree: true,
      headlessCmd: "copilot -p",
      priority: 1,
    }),
  });

interface SignalRule {
  tag: string;
  label: string;
  pattern: RegExp;
}

const TASK_SIGNAL_RULES: readonly SignalRule[] = [
  {
    tag: "architecture",
    label: "architecture/design",
    pattern: /\b(architect(?:ure)?|redesign|design\s+doc|system\s+design|schema|abstraction)\b/i,
  },
  {
    tag: "refactor",
    label: "refactoring",
    pattern: /\b(refactor|restructure|clean\s*up|modularize|decouple|migrate|migration)\b/i,
  },
  {
    tag: "multi-file",
    label: "multi-file changes",
    pattern: /\b(multi[- ]file|across\s+(?:the\s+)?(?:repo|codebase|modules)|end[- ]to[- ]end)\b/i,
  },
  {
    tag: "debug",
    label: "debugging",
    pattern:
      /\b(debug|root\s+cause|race\s+condition|deadlock|memory\s+leak|flaky|stack\s*trace)\b/i,
  },
  {
    tag: "reasoning",
    label: "deep reasoning",
    pattern: /\b(complex|subtle|invariant|state\s+machine|concurrency|protocol)\b/i,
  },
  {
    tag: "review",
    label: "code review",
    pattern: /\b(review|audit|inspect\s+diff|check\s+pr|critique)\b/i,
  },
  {
    tag: "security",
    label: "security",
    pattern:
      /\b(security|vuln(?:erability)?|auth(?:entication|orization)?|ssrf|xss|csrf|permission|sandbox)\b/i,
  },
  {
    tag: "tests",
    label: "tests",
    pattern: /\b(tests?|unit\s+test|e2e|coverage|spec|assert|regression|failing\s+test)\b/i,
  },
  {
    tag: "ci",
    label: "CI/build",
    pattern: /\b(ci|pipeline|github\s+actions?|typecheck|lint|build\s+error|compile)\b/i,
  },
  {
    tag: "shell",
    label: "shell/CLI",
    pattern: /\b(shell|bash|zsh|cli|script|command)\b/i,
  },
  {
    tag: "verification",
    label: "verification",
    pattern: /\b(verify|verification|validate|check\s+all|smoke\s+test)\b/i,
  },
  {
    tag: "bugfix",
    label: "bugfix",
    pattern: /\b(fix|bug|broken|crash|error|exception|fail(?:ing|ure)?)\b/i,
  },
  {
    tag: "ui",
    label: "UI",
    pattern: /\b(ui|ux|layout|modal|button|responsive|screenshot|pixel|page|view|screen)\b/i,
  },
  {
    tag: "frontend",
    label: "frontend",
    pattern: /\b(frontend|css|html|astro|react|svelte|tailwind|dom|browser|component)\b/i,
  },
  {
    tag: "fast-edits",
    label: "fast iteration",
    pattern: /\b(quick(?:ly)?|fast|polish|tweak|interactive)\b/i,
  },
  {
    tag: "large-context",
    label: "large-context scan",
    pattern:
      /\b(large[- ]context|entire\s+(?:repo|codebase)|whole\s+(?:repo|codebase)|hundreds\s+of\s+files|monorepo|inventory)\b/i,
  },
  {
    tag: "research",
    label: "research/exploration",
    pattern: /\b(research|investigate|explore|compare\s+options|landscape|survey|feasibility)\b/i,
  },
  {
    tag: "docs",
    label: "documentation",
    pattern: /\b(docs?|documentation|readme|guide|changelog|summarize|summary|explain)\b/i,
  },
  {
    tag: "analysis",
    label: "analysis",
    pattern: /\b(analy[sz]e|analysis|report|synthesis|synthesize|trace)\b/i,
  },
  {
    tag: "multimodal",
    label: "multimodal",
    pattern: /\b(image|screenshot|mockup|diagram|pdf|video|audio|visual)\b/i,
  },
  {
    tag: "git",
    label: "git/conflicts",
    pattern: /\b(git|merge\s+conflict|rebase|cherry[- ]pick|commit|branch|diff)\b/i,
  },
  {
    tag: "small-edits",
    label: "small focused edits",
    pattern: /\b(small\s+edit|typo|rename|one[- ]liner|tiny|single[- ]file|patch)\b/i,
  },
  {
    tag: "focused-fix",
    label: "focused fix",
    pattern: /\b(minimal\s+diff|surgical|targeted\s+edit)\b/i,
  },
  {
    tag: "multi-model",
    label: "multi-model/local",
    pattern: /\b(ollama|local\s+model|open\s+model|deepseek|qwen|llama|mistral|any\s+provider)\b/i,
  },
  {
    tag: "provider-agnostic",
    label: "provider-agnostic",
    pattern: /\b(provider[- ]agnostic|custom\s+endpoint|openrouter)\b/i,
  },
  {
    tag: "github",
    label: "GitHub",
    pattern: /\b(github|gh\s+pr|gh\s+issue|repository\s+settings)\b/i,
  },
  {
    tag: "pr",
    label: "PR workflow",
    pattern: /\b(pr|pull\s+request|review\s+comment|mergeable)\b/i,
  },
  {
    tag: "boilerplate",
    label: "boilerplate/scaffolding",
    pattern: /\b(boilerplate|scaffold|template|stub|crud)\b/i,
  },
];

export interface RecommendAgentOptions {
  /** Backends currently busy; mildly penalized in tie-breaks and noted in rationale. */
  busyAgents?: readonly string[];
  /** Extra capability tags per backend (e.g. loaded from ~/.lisa/agents.json `skills`). */
  customSkills?: Partial<Record<DispatchBackend, readonly string[]>>;
}

export interface RankedAgentCandidate {
  agent: DispatchBackend;
  label: string;
  score: number;
  matchedCapabilities: string[];
  busy: boolean;
  rationale: string;
}

export interface AgentRecommendation {
  recommended: DispatchBackend | null;
  rationale: string;
  matchedSignals: string[];
  ranked: RankedAgentCandidate[];
}

export function getAgentCapability(agent: DispatchBackend): AgentCapabilityProfile {
  return AGENT_CAPABILITIES[agent];
}

export function listAgentCapabilities(): AgentCapabilityProfile[] {
  return DISPATCH_BACKENDS.map((k) => AGENT_CAPABILITIES[k]);
}

function normalizeAvailable(available?: readonly DispatchBackend[]): DispatchBackend[] {
  if (available === undefined) return [...DISPATCH_BACKENDS];
  const valid = new Set<DispatchBackend>();
  for (const a of available) {
    if (Object.hasOwn(AGENT_CAPABILITIES, a)) valid.add(a);
  }
  return [...valid];
}

/**
 * Score and rank backends for a task, returning the top pick + clear rationale.
 * Pure & deterministic (no I/O or LLM calls).
 */
export function recommendAgentForTask(
  task: string,
  available?: readonly DispatchBackend[],
  opts: RecommendAgentOptions = {},
): AgentRecommendation {
  const candidates = normalizeAvailable(available);
  if (candidates.length === 0) {
    return {
      recommended: null,
      rationale: "No coding agent backends are currently available.",
      matchedSignals: [],
      ranked: [],
    };
  }

  const text = (task ?? "").trim();
  const matchedRules = text ? TASK_SIGNAL_RULES.filter((r) => r.pattern.test(text)) : [];
  const matchedSignals = matchedRules.map((r) => r.label);
  const busySet = new Set((opts.busyAgents ?? []).map((b) => b.toLowerCase()));

  const ranked: RankedAgentCandidate[] = candidates.map((agent) => {
    const profile = AGENT_CAPABILITIES[agent];
    const custom = new Set((opts.customSkills?.[agent] ?? []).map((s) => s.toLowerCase()));
    const primary = new Set(profile.primaryStrengths);
    const secondary = new Set(profile.secondaryStrengths);

    let score = 0;
    const matchedCapabilities: string[] = [];
    const matchedLabels: string[] = [];

    for (const rule of matchedRules) {
      if (custom.has(rule.tag)) {
        score += 4;
        matchedCapabilities.push(rule.tag);
        matchedLabels.push(rule.label);
      } else if (primary.has(rule.tag)) {
        score += 3;
        matchedCapabilities.push(rule.tag);
        matchedLabels.push(rule.label);
      } else if (secondary.has(rule.tag)) {
        score += 1.5;
        matchedCapabilities.push(rule.tag);
        matchedLabels.push(rule.label);
      }
    }

    const busy = busySet.has(agent) || busySet.has(profile.observerKind);
    if (busy) score -= 1.5;

    // Small priority fraction breaks exact ties consistently without overriding a signal match.
    const totalScore = Number((score + profile.priority * 0.05).toFixed(2));
    const uniqueCaps = Array.from(new Set(matchedCapabilities));
    const uniqueLabels = Array.from(new Set(matchedLabels));

    let rationale: string;
    if (uniqueLabels.length > 0) {
      rationale = `${profile.label} matches ${uniqueLabels.join(", ")} (${profile.summary.replace(/\.$/, "")})`;
    } else if (matchedSignals.length > 0) {
      rationale = `${profile.label} selected as best available general-purpose fallback (${profile.summary.replace(/\.$/, "")})`;
    } else {
      rationale = `${profile.label} selected by general-purpose priority (${profile.summary.replace(/\.$/, "")})`;
    }
    if (busy) rationale += " [currently busy]";

    return {
      agent,
      label: profile.label,
      score: totalScore,
      matchedCapabilities: uniqueCaps,
      busy,
      rationale,
    };
  });

  ranked.sort((a, b) => b.score - a.score);
  const top = ranked[0]!;
  return {
    recommended: top.agent,
    rationale: top.rationale,
    matchedSignals,
    ranked,
  };
}

/** Human-readable formatting of a routing recommendation. Pure. */
export function formatCapabilityRecommendation(rec: AgentRecommendation, maxAlts = 3): string {
  if (!rec.recommended) return rec.rationale;
  const top = rec.ranked[0]!;
  const alts = rec.ranked
    .slice(1, 1 + maxAlts)
    .map((c) => `${c.agent} (${c.score.toFixed(2)})`)
    .join(", ");
  const signals = rec.matchedSignals.length
    ? `Detected task signals: ${rec.matchedSignals.join(", ")}.`
    : "No specialized signals detected; using general-purpose capability ranking.";
  return [
    `Recommended agent: ${top.agent} (${top.label}) — ${top.rationale}.`,
    signals,
    alts ? `Runner-ups: ${alts}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
