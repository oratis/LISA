/**
 * Tool input validation (FOUNDATIONS §2.3) — a guard between LLM-produced tool
 * input and `tool.execute()`. The review flagged that model-generated input goes
 * straight into execute with no schema check; this catches malformed calls
 * (wrong shape / missing required field / bad enum) and returns a friendly error
 * the model can correct, BEFORE the tool runs (fail-closed).
 *
 * Deliberately lightweight — validates against the JSON-Schema `inputSchema`
 * every ToolDefinition already declares (no new dependency, no separate schema
 * to drift). It checks the high-value, low-false-positive rules: input is an
 * object, required fields are present, declared property types match, and enum
 * membership holds. It does NOT deep-validate nested objects or reject extra
 * properties — over-strictness would block valid calls the tools handle fine.
 * Pure.
 */
import type Anthropic from "@anthropic-ai/sdk";

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

export function validateToolInput(
  schema: Anthropic.Tool.InputSchema,
  input: unknown,
): ValidationResult {
  // Tools take a JSON object. Anything else is malformed.
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "input must be a JSON object" };
  }
  const obj = input as Record<string, unknown>;
  const s = schema as {
    required?: unknown;
    properties?: Record<string, { type?: string; enum?: unknown[] }>;
  };

  const required = Array.isArray(s.required) ? (s.required as string[]) : [];
  for (const key of required) {
    if (!(key in obj) || obj[key] === undefined || obj[key] === null) {
      return { ok: false, error: `missing required field "${key}"` };
    }
  }

  const props = s.properties;
  if (props) {
    for (const [key, spec] of Object.entries(props)) {
      if (!(key in obj) || obj[key] === undefined) continue; // optional + absent → fine
      const val = obj[key];
      if (spec?.type && !matchesType(val, spec.type)) {
        return { ok: false, error: `field "${key}" should be ${spec.type}` };
      }
      if (Array.isArray(spec?.enum) && spec.enum.length > 0 && !spec.enum.includes(val)) {
        return { ok: false, error: `field "${key}" must be one of: ${spec.enum.join(", ")}` };
      }
    }
  }
  return { ok: true };
}

function matchesType(val: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof val === "string";
    case "number":
      return typeof val === "number";
    case "integer":
      return typeof val === "number" && Number.isInteger(val);
    case "boolean":
      return typeof val === "boolean";
    case "object":
      return val !== null && typeof val === "object" && !Array.isArray(val);
    case "array":
      return Array.isArray(val);
    case "null":
      return val === null;
    default:
      return true; // unknown/compound type → don't block
  }
}
