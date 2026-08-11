/**
 * Wait for both concurrent preparation branches so a successful upload can be
 * removed even when analysis fails first. `Promise.all` cannot provide that
 * guarantee because it rejects before the sibling branch has settled.
 */
export async function settleArtifactPreparation<T>(input: {
  analysis: Promise<T>;
  upload: Promise<string>;
  deleteUpload: (storagePath: string) => Promise<void>;
}): Promise<{ analysis: T; storagePath: string }> {
  const [analysis, upload] = await Promise.allSettled([input.analysis, input.upload]);

  if (analysis.status === "fulfilled" && upload.status === "fulfilled") {
    return { analysis: analysis.value, storagePath: upload.value };
  }

  if (upload.status === "fulfilled") {
    await input.deleteUpload(upload.value);
  }

  if (analysis.status === "rejected") throw analysis.reason;
  if (upload.status === "rejected") throw upload.reason;
  throw new Error("artifact preparation failed without a reported cause");
}

/** Best-effort compensation after a persistence failure; report every miss. */
export async function rollbackArtifact(input: {
  itemIds: string[];
  storagePath: string;
  deleteItem: (itemId: string) => Promise<void>;
  deleteUpload: (storagePath: string) => Promise<void>;
}): Promise<{ target: string; error: unknown }[]> {
  const failures: { target: string; error: unknown }[] = [];

  for (const itemId of input.itemIds) {
    try {
      await input.deleteItem(itemId);
    } catch (error) {
      failures.push({ target: `item:${itemId}`, error });
    }
  }

  try {
    await input.deleteUpload(input.storagePath);
  } catch (error) {
    failures.push({ target: `storage:${input.storagePath}`, error });
  }

  return failures;
}
