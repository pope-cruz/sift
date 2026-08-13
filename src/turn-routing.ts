export type RoutingChannel = {
  send(text: string, options?: { transient?: boolean }): Promise<void>;
  responding<T>(work: () => Promise<T>): Promise<T>;
};

const CANT_READ =
  "I can't read that one yet — send me a PDF, a screenshot, or just type it and I'll keep track of it.";

/** Dependency-free orchestration used by the real core and channel parity tests. */
export async function routeActiveTurn(input: {
  text: string;
  attachmentCount: number;
  channel: RoutingChannel;
  ingest(): Promise<string>;
  answer(): Promise<string>;
}): Promise<void> {
  if (input.attachmentCount > 0) {
    await input.channel.send("Sifting...", { transient: true });
    await input.channel.responding(async () => input.channel.send(await input.ingest()));
    return;
  }
  if (!input.text) {
    await input.channel.send(CANT_READ);
    return;
  }
  await input.channel.send(await input.channel.responding(input.answer));
}
