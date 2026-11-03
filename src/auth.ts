// Graph tokens. Two ways in:
// - delegated (default): one person signs in once with a device code (`npm run login`) and status-master reads
//   only that person's own presence (Presence.Read). The refresh token is kept in TOKEN_FILE and rotated on use.
// - app: client credentials for an app registration with Presence.Read.All + User.Read.All (everyone).
// Either way the secret stays on the machine that runs status-master, never on a light.

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/** Least privilege for the delegated path: own presence, a refresh token, and the signed-in name for logs. */
export const DELEGATED_SCOPES = 'https://graph.microsoft.com/Presence.Read offline_access openid profile';

export type TokenProvider = () => Promise<string>;

const authority = (tenantId: string) => `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0`;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  id_token?: string;
}

interface OAuthError {
  error?: string;
  error_description?: string;
}

/** First line of an Entra error, without the trace and correlation ids that follow it. */
function describe(body: OAuthError): string {
  const text = body.error_description?.split(/\r?\n/)[0].trim() || body.error || 'unknown error';
  // AADSTS7000218: the app registration is a confidential client; device code needs public client flows.
  if (/AADSTS7000218/.test(text)) return `${text} (set "Allow public client flows" to Yes on the app registration)`;
  return text;
}

async function postForm(url: string, form: Record<string, string>): Promise<{ ok: boolean; body: unknown }> {
  const res = await fetch(url, { method: 'POST', body: new URLSearchParams(form) });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: `HTTP ${res.status}`, error_description: text.slice(0, 300) };
  }
  return { ok: res.ok, body };
}

export function clientCredentials(o: { tenantId: string; clientId: string; clientSecret: string }): TokenProvider {
  let token: { value: string; expires: number } | undefined;
  return async () => {
    if (token && token.expires > Date.now() + 60_000) return token.value;
    const { ok, body } = await postForm(`${authority(o.tenantId)}/token`, {
      grant_type: 'client_credentials',
      client_id: o.clientId,
      client_secret: o.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    });
    if (!ok) throw new Error(`Graph sign-in failed: ${describe(body as OAuthError)}`);
    const t = body as TokenResponse;
    token = { value: t.access_token, expires: Date.now() + t.expires_in * 1000 };
    return token.value;
  };
}

/** Who signed in, from the ID token. */
export interface Identity {
  oid?: string;
  name?: string;
  username?: string;
}

interface TokenFile extends Identity {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
}

/** Reads the claims of a JWT without checking it: the ID token comes straight from Entra over TLS, used for labels. */
function claims(jwt: string | undefined): Identity {
  if (!jwt) return {};
  try {
    const c = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    return { oid: c.oid, name: c.name, username: c.preferred_username };
  } catch {
    return {};
  }
}

export class DelegatedAuth {
  private readonly tenantId: string;
  private readonly clientId: string;
  private readonly file: string;
  private tokens?: TokenFile;

  constructor(o: { tenantId: string; clientId: string; tokenFile: string }) {
    this.tenantId = o.tenantId;
    this.clientId = o.clientId;
    this.file = o.tokenFile;
  }

  /** Device code sign-in. `show` gets Entra's instructions (a URL and a code to enter there). */
  async login(show: (message: string) => void): Promise<Identity> {
    const start = await postForm(`${authority(this.tenantId)}/devicecode`, {
      client_id: this.clientId,
      scope: DELEGATED_SCOPES,
    });
    if (!start.ok) throw new Error(`Sign-in failed to start: ${describe(start.body as OAuthError)}`);
    const dc = start.body as { device_code: string; message: string; expires_in: number; interval?: number };
    show(dc.message);

    let interval = dc.interval ?? 5;
    const deadline = Date.now() + dc.expires_in * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval * 1000));
      const { ok, body } = await postForm(`${authority(this.tenantId)}/token`, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: this.clientId,
        device_code: dc.device_code,
      });
      if (ok) return this.save(body as TokenResponse);
      const err = body as OAuthError;
      if (err.error === 'authorization_pending') continue;
      if (err.error === 'slow_down') {
        interval += 5;
        continue;
      }
      throw new Error(`Sign-in failed: ${describe(err)}`);
    }
    throw new Error('Sign-in timed out. Run `npm run login` again.');
  }

  /** Who is signed in. Throws if nobody is. */
  identity(): Identity {
    const { oid, name, username } = this.load();
    return { oid, name, username };
  }

  /** A current access token, refreshing (and saving the rotated refresh token) when it is about to expire. */
  readonly accessToken: TokenProvider = async () => {
    const t = this.load();
    if (t.expiresAt > Date.now() + 60_000) return t.accessToken;
    const { ok, body } = await postForm(`${authority(this.tenantId)}/token`, {
      grant_type: 'refresh_token',
      client_id: this.clientId,
      refresh_token: t.refreshToken,
      scope: DELEGATED_SCOPES,
    });
    if (!ok) {
      const err = body as OAuthError;
      const again = err.error === 'invalid_grant' ? ' Sign in again with `npm run login`.' : '';
      throw new Error(`Token refresh failed: ${describe(err)}.${again}`);
    }
    this.save(body as TokenResponse);
    return this.load().accessToken;
  };

  private load(): TokenFile {
    if (this.tokens) return this.tokens;
    if (!existsSync(this.file)) throw new Error(`Not signed in (no ${this.file}). Run \`npm run login\` first.`);
    this.tokens = JSON.parse(readFileSync(this.file, 'utf8')) as TokenFile;
    return this.tokens;
  }

  private save(t: TokenResponse): Identity {
    const previous = existsSync(this.file) ? (this.tokens ?? this.load()) : undefined;
    const refreshToken = t.refresh_token ?? previous?.refreshToken;
    if (!refreshToken) throw new Error('Entra returned no refresh token (is offline_access consented?).');
    const id = { ...previous, ...stripUndefined(claims(t.id_token)) };
    const next: TokenFile = {
      oid: id.oid,
      name: id.name,
      username: id.username,
      accessToken: t.access_token,
      refreshToken,
      expiresAt: Date.now() + t.expires_in * 1000,
    };
    // Write a private temp file, then rename over the old one, so a crash never leaves half a token file.
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
    this.tokens = next;
    return { oid: next.oid, name: next.name, username: next.username };
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
