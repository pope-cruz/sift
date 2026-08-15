/**
 * Run an async mapper over a list several at a time, in order.
 *
 * Ingest needs this because the per-file work is independent but expensive:
 * each attachment pays a provider download and a vision call, and running them
 * one after another made a three-screenshot turn cost three times a one-file
 * turn for no reason.
 *
 * Two properties the callers depend on:
 *
 *   - Results come back in input order, whatever order they finished in, so a
 *     joined reply still reads in the order the student attached things.
 *   - The limit is a real ceiling, not a batch size. Workers pull from a shared
 *     cursor, so one slow 20MB PDF never idles the other slots waiting for a
 *     batch boundary.
 *
 * Rejections propagate. Callers that need every outcome regardless (ingest does
 * — it reports a per-file failure sentence rather than losing the whole turn)
 * catch inside their own mapper.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await map(items[index]!, index);
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
