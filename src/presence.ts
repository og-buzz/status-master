// Teams presence as Graph reports it, and the simplified status the rest of the app (stack light, API) works from.
// Pure: no I/O, so it is what the tests cover.

/** Graph presence.availability values. Anything else is treated as unknown. */
export type Availability =
  | 'Available'
  | 'AvailableIdle'
  | 'Away'
  | 'BeRightBack'
  | 'Busy'
  | 'BusyIdle'
  | 'DoNotDisturb'
  | 'Offline'
  | 'PresenceUnknown';

/** One entry of a getPresencesByUserId response (fields this app uses). */
export interface GraphPresence {
  id: string;
  availability: string;
  activity: string;
  statusMessage?: { message?: { content?: string } } | null;
  outOfOfficeSettings?: { isOutOfOffice?: boolean } | null;
}

/** Coarse status, one per stack-light state. */
export type State = 'available' | 'busy' | 'dnd' | 'away' | 'offline' | 'unknown';

export interface Person {
  id: string;
  upn: string;
  displayName: string;
}

export interface Status {
  person: Person;
  state: State;
  /** Raw Graph values, kept for display and for finer mapping later (e.g. InAMeeting vs Busy). */
  availability: string;
  activity: string;
  outOfOffice: boolean;
  /** Plain text of the user's Teams status message, if set. */
  message?: string;
  /** When this state was first seen, epoch ms. Unchanged while the state holds. */
  since: number;
}

const STATES: Record<string, State> = {
  Available: 'available',
  AvailableIdle: 'available',
  Busy: 'busy',
  BusyIdle: 'busy',
  DoNotDisturb: 'dnd',
  Away: 'away',
  BeRightBack: 'away',
  Offline: 'offline',
};

export function toState(availability: string): State {
  return STATES[availability] ?? 'unknown';
}

/** Teams status messages are HTML fragments. Reduce one to a single line of text. */
export function plainMessage(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const text = html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text || undefined;
}

export interface Change {
  before?: Status;
  after: Status;
}

/**
 * Merges a poll into the previous statuses. Returns the new map and what changed.
 * A change is a different state, activity, out-of-office flag or message. `since` moves only when the state does.
 */
export function applyPoll(
  previous: ReadonlyMap<string, Status>,
  people: readonly Person[],
  presences: readonly GraphPresence[],
  now: number,
): { statuses: Map<string, Status>; changes: Change[] } {
  const byId = new Map(presences.map((p) => [p.id, p]));
  const statuses = new Map<string, Status>();
  const changes: Change[] = [];
  for (const person of people) {
    const p = byId.get(person.id);
    const before = previous.get(person.id);
    const availability = p?.availability ?? 'PresenceUnknown';
    const state = toState(availability);
    const after: Status = {
      person,
      state,
      availability,
      activity: p?.activity ?? 'PresenceUnknown',
      outOfOffice: p?.outOfOfficeSettings?.isOutOfOffice ?? false,
      message: plainMessage(p?.statusMessage?.message?.content),
      since: before && before.state === state ? before.since : now,
    };
    statuses.set(person.id, after);
    if (
      !before ||
      before.state !== after.state ||
      before.activity !== after.activity ||
      before.outOfOffice !== after.outOfOffice ||
      before.message !== after.message
    ) {
      changes.push({ before, after });
    }
  }
  return { statuses, changes };
}
