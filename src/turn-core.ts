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
  send(text: string): Promise<void>;
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

  await routeActiveTurn({
    text: turn.text,
    attachmentCount: turn.attachments.length,
    channel,
    ingest: () => ingest({ student, text: turn.text, files: turn.attachments }),
    answer: async () => {
      const context = assembleContext({
        student,
        question: turn.text,
        today: today(student.timezone),
        rows: await getContextRows(student.id),
      });
      return respond({
        history: context.messages.map(({ direction, content }) => ({ direction, content })),
        text: turn.text,
        context: renderContext(context),
        timezone: student.timezone,
        tools: TOOLS,
        runTool: (name, args) => runTool(student, name, args),
        validateReply: (text, attempt) => validateReply(context, text, attempt),
        fallbackReply: fallbackReply(context),
      });
    },
  });

  // Web-only presentation events are derived from the same persisted rows the
  // answerer sees. Spectrum simply omits `present`, so assistant copy and
  // mutations stay identical without paying for an extra query there.
  if (channel.present) {
    const display = assembleContext({
      student,
      question: turn.text,
      today: today(student.timezone),
      rows: await getContextRows(student.id),
    });
    const deadlines = display.upcomingDeadlines.slice(0, 5);
    if (deadlines.length) {
      await channel.present({
        type: "deadline_list",
        title: "Upcoming deadlines",
        items: deadlines.map((action) => ({ label: action.description, date: action.dueDate! })),
      });
    }
    const place = display.places[0];
    if (place) {
      await channel.present({
        type: "saved_place",
        title: place.place?.name ?? place.title ?? "Saved place",
        detail: place.place?.location ?? place.summary,
      });
    }
    const tasks = display.undatedOpenActions.slice(0, 4);
    if (tasks.length) {
      await channel.present({
        type: "task_list",
        title: "Saved tasks",
        items: tasks.map((action) => ({ label: action.description, date: action.dueDate })),
      });
    }
    const source = display.savedItems[0];
    if (source) {
      await channel.present({
        type: "source",
        label: source.title ?? "Saved item",
        detail: source.type ?? undefined,
      });
    }
  }
}
