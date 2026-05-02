import type { ToolDefinition } from "../types.js";
import { buildIndex, search } from "./vector.js";

interface SearchInput {
  query: string;
  limit?: number;
}

export const memorySearchTool: ToolDefinition<SearchInput, string> = {
  name: "memory_search",
  description:
    "Full-text search over the transcripts of all your past sessions (TF-IDF ranked). " +
    "Use this when the user references something from a previous conversation, when you need " +
    "to recall a workflow you've used before, or to verify a memory entry's origin. " +
    "Returns a ranked list of session id, timestamp, and a 200-char excerpt.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
    },
    required: ["query"],
  },
  async execute(input) {
    const index = await buildIndex();
    const hits = search(index, input.query, input.limit ?? 5);
    if (hits.length === 0) return "(no matches)";
    return hits
      .map(
        (h) =>
          `[${h.startedAt}] ${h.sessionId} (score=${h.score.toFixed(2)})\n  ${h.excerpt}`,
      )
      .join("\n\n");
  },
};
