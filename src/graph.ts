// Microsoft Graph: read Teams presence. getMyPresence works with a delegated token (Presence.Read); getUser and
// getPresences need an app token with Presence.Read.All and User.Read.All. Tokens come from auth.ts.

import type { TokenProvider } from './auth.ts';
import type { GraphPresence, Person } from './presence.ts';

/** getPresencesByUserId accepts at most this many ids per call. */
const PRESENCE_BATCH = 650;

export class GraphClient {
  private readonly getToken: TokenProvider;

  constructor(getToken: TokenProvider) {
    this.getToken = getToken;
  }

  /** The signed-in user's own presence (delegated). */
  async getMyPresence(): Promise<GraphPresence> {
    return (await this.request('GET', '/me/presence')) as GraphPresence;
  }

  /** Resolves a UPN, email or object id to the user's id and display name. */
  async getUser(idOrUpn: string): Promise<Person> {
    const u = (await this.request(
      'GET',
      `/users/${encodeURIComponent(idOrUpn)}?$select=id,displayName,userPrincipalName`,
    )) as { id: string; displayName: string; userPrincipalName: string };
    return { id: u.id, upn: u.userPrincipalName, displayName: u.displayName };
  }

  async getPresences(ids: readonly string[]): Promise<GraphPresence[]> {
    const out: GraphPresence[] = [];
    for (let i = 0; i < ids.length; i += PRESENCE_BATCH) {
      const page = (await this.request('POST', '/communications/getPresencesByUserId', {
        ids: ids.slice(i, i + PRESENCE_BATCH),
      })) as { value: GraphPresence[] };
      out.push(...page.value);
    }
    return out;
  }

  private async request(method: string, path: string, body?: unknown, attempt = 1): Promise<unknown> {
    const url = `https://graph.microsoft.com/v1.0${path}`;
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await this.getToken()}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // Throttled: wait as told (capped) and retry a few times.
    if ((res.status === 429 || res.status === 503) && attempt < 4) {
      const wait = Math.min(Number(res.headers.get('Retry-After')) || 2 ** attempt, 60);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return this.request(method, path, body, attempt + 1);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Graph ${method} ${new URL(url).pathname} -> ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }
}
