export async function responseJson(
  response: Response,
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  const obj =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  if (!response.ok) {
    const detail =
      typeof obj.message === "string"
        ? obj.message
        : typeof obj.error === "string"
          ? obj.error
          : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return obj;
}

export function httpsOrigin(input: string): string {
  const value = input.includes("://") ? input : `https://${input}`;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("instance/service must be an HTTPS origin");
  }
  return url.origin;
}
