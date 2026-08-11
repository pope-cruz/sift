export const TROUBLE = "Hmm, I had trouble sifting that — mind sending it again?";

/** Best-effort recovery: a database failure can still produce a useful reply;
 * a provider outage is swallowed so the long-running worker stays alive. */
export async function sendRecovery(send: (text: string) => Promise<unknown>): Promise<boolean> {
  try {
    await send(TROUBLE);
    return true;
  } catch {
    return false;
  }
}
