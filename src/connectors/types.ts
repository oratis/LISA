import type { ToolDefinition } from "../types.js";

export class ConnectorError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/** Serializes credential refresh across processes; replacement checks the live grant. */
export interface CredentialAccess {
  use<T>(
    work: (value: string, replace: (value: string) => Promise<void>) => Promise<T>,
  ): Promise<T>;
}

export interface ReadonlyDriver<A, R> {
  id: string;
  authModes: readonly string[];
  reauthorizationCode: string;
  validAccount(value: unknown): value is A;
  accountId(account: A): string;
  validResource(value: unknown): value is R;
  validResourceName(value: unknown): value is string;
  validAuthorizationUrl?(value: string): boolean;
  authorize(
    mode: string,
    signal: AbortSignal,
    progress: (value: { userCode?: string; authorizationUrl?: string }) => void,
    accountId?: string,
  ): Promise<{ token: string; account: A }>;
  account(credentials: CredentialAccess, signal: AbortSignal): Promise<A>;
  resources(credentials: CredentialAccess, page: number, signal: AbortSignal): Promise<R[]>;
  resource(credentials: CredentialAccess, name: string, signal: AbortSignal): Promise<R>;
  tool: Pick<ToolDefinition, "name" | "description" | "inputSchema">;
  read(
    credentials: CredentialAccess,
    account: A,
    resources: R[],
    input: unknown,
    signal: AbortSignal,
  ): Promise<unknown>;
}
