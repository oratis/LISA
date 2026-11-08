/** A short picker page signals the end. Upstream cursor pages can be short even
 * when more resources exist, including after filtering archived pages. */
export async function resourcePageFromCursors<T extends { id: string }>(
  page: number,
  read: (cursor?: string) => Promise<{ items: T[]; cursor?: string }>,
): Promise<T[]> {
  const end = page * 30;
  const available = new Map<string, T>();
  let cursor: string | undefined;
  // Keep the drivers' existing ten-upstream-page discovery bound.
  for (let n = 0; n < 10; n++) {
    const batch = await read(cursor);
    for (const item of batch.items) available.set(item.id, item);
    cursor = batch.cursor;
    if (available.size >= end || !cursor) break;
  }
  return Array.from(available.values()).slice(end - 30, end);
}
