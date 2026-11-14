// The permit owns billing idempotency. Settle completed provider work even
// when a cancellation or a newer memory generation prevents persistence.
import { ReflectionInterruptedError, type ReflectionResult } from "../reflect.js";
import type { ProviderUsage } from "../providers/types.js";

export async function reflectWithUsage(
  run: () => Promise<ReflectionResult>,
  settle?: (usage: ProviderUsage) => Promise<unknown>,
): Promise<ReflectionResult> {
  let result: ReflectionResult;
  try {
    result = await run();
  } catch (error) {
    if (
      error instanceof ReflectionInterruptedError &&
      Object.values(error.usage).some((n) => n > 0)
    ) {
      await settle?.(error.usage);
    }
    throw error;
  }
  if (result.usage) await settle?.(result.usage);
  return result;
}
