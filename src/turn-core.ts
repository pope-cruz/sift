import { getContextRows, type Student } from "./db.ts";
import { today } from "./dates.ts";
import { ingest } from "./ingest.ts";
import { respond } from "./llm.ts";
import { assembleContext, fallbackReply, renderContext, validateReply } from "./planner.ts";
import { runTool, TOOLS } from "./tools.ts";
import { routeActiveTurn } from "./turn-routing.ts";

export type TurnAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  read(): Promise<Buffer>;
};

export type NormalizedTurn = {
  id: string;
  text: string;
  attachments: TurnAttachment[];
};

export type Presentation =
  | { type: "source"; label: string; detail?: string }
  | { type: "deadline_list"; title: string; items: { label: string; date: string }[] }
  | { type: "saved_place"; title: string; detail: string | null }
  | { type: "task_list"; title: string; items: { label: string; date: string | null }[] }
  | { type: "reminder_jump"; targetTime: string };

export type TurnChannel = {
  send(text: string, options?: { transient?: boolean }): Promise<void>;
  responding<T>(work: () => Promise<T>): Promise<T>;
  present?(presentation: Presentation): Promise<void>;
};

/** The transport-neutral active-student path shared by Spectrum and the web demo. */
export async function processTurn(input: {
  student: Student;
  turn: NormalizedTurn;
  channel: TurnChannel;
}): Promise<void> {
  const { student, turn, channel } = input;
  const rowsBefore = channel.present ? await getContextRows(student.id) : undefined;

  await routeActiveTurn({
    text: turn.text,
    // Passed whole rather than counted: the wait notice reads mime type and size
    // to say something specific, and both are known before any byte is fetched.
    attachments: turn.attachments,
    channel,
    ingest: () => ingest({ student, text: turn.text, files: turn.attachments, sourceMessageId: turn.id }),
    answer: async () => {
      const context = assembleContext({
        student,
        question: turn.text,
        today: today(student.timezone),
        rows: rowsBefore ?? await getContextRows(student.id),
      });
      return respond({
        history: context.messages.map(({ direction, content }) => ({ direction, content })),
        text: turn.text,
        context: renderContext(context),
        timezone: student.timezone,
        tools: TOOLS,
        runTool: (name, args) => runTool(student, name, args, turn.id),
        validateReply: (text, attempt) => validateReply(context, text, attempt),
        fallbackReply: fallbackReply(context),
      });
    },
  });

  // Only show structured UI for the item created by this turn. Rendering all
  // remembered deadlines after every reply made the web channel look like a
  // dashboard and repeated old information that the assistant had just said.
  if (channel.present && rowsBefore) {
    const rowsAfter = await getContextRows(student.id);
    const previousIds = new Set(rowsBefore.items.map((row) => String(row.id)));
    const createdIds = new Set(rowsAfter.items.map((row) => String(row.id)).filter((id) => !previousIds.has(id)));
    const display = assembleContext({
      student,
      question: turn.text,
      today: today(student.timezone),
      rows: rowsAfter,
    });
    const source = display.savedItems.find((item) => createdIds.has(item.itemId));
    if (!source) return;

    const dated = source.actions.filter((action) => action.dueDate !== null).slice(0, 5);
    const undated = source.actions.filter((action) => action.dueDate === null).slice(0, 5);
    if (source.place) {
      await channel.present({
        type: "saved_place",
        title: source.place.name ?? source.title ?? "Saved place",
        detail: source.place.location ?? source.summary,
      });
    } else if (dated.length) {
      await channel.present({
        type: "deadline_list",
        title: source.title ?? "Saved deadlines",
        items: dated.map((action) => ({ label: action.description, date: action.dueDate! })),
      });
    } else if (undated.length) {
      await channel.present({
        type: "task_list",
        title: source.title ?? "Saved tasks",
        items: undated.map((action) => ({ label: action.description, date: null })),
      });
    }
    await channel.present({
      type: "source",
      label: source.title ?? "Saved item",
      detail: source.type ?? undefined,
    });
  }
}
