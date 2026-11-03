import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { checkCommand, DEFAULT_LIGHT, type LightMap } from './light.ts';

// Settings come from the environment, with .env (gitignored) loaded when present.

/**
 * Reads KEY=value lines, taking the value literally apart from one pair of surrounding quotes.
 * Not process.loadEnvFile: it treats " #" and "#" inside unquoted values as a comment, which truncates secrets.
 * Variables already set in the environment win.
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2].trim();
    out[m[1]] = /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v;
  }
  return out;
}

if (existsSync('.env')) {
  for (const [k, v] of Object.entries(parseEnv(readFileSync('.env', 'utf8')))) process.env[k] ??= v;
}

function str(name: string, fallback?: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} isn't set. See .env.example.`);
}
const int = (name: string, fallback: number) => Number.parseInt(str(name, String(fallback)), 10);

export type GraphConfig =
  | { auth: 'delegated'; tenantId: string; clientId: string; tokenFile: string }
  | { auth: 'app'; tenantId: string; clientId: string; clientSecret: string; watchUsers: string[] };

export interface LightConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  clientId: string;
  /** The light's command topic, e.g. status-master/acme/hq/light-01/command. */
  topic: string;
  commands: LightMap;
}

export interface Config {
  graph: GraphConfig;
  pollSeconds: number;
  /** No light when MQTT_URL is empty. */
  light?: LightConfig;
  /** Show the `stale` command after this long without a successful poll. */
  staleSeconds: number;
}

function graphConfig(): GraphConfig {
  const auth = str('GRAPH_AUTH', 'delegated');
  const tenantId = str('GRAPH_TENANT_ID');
  const clientId = str('GRAPH_CLIENT_ID');
  if (auth === 'delegated') return { auth, tenantId, clientId, tokenFile: str('TOKEN_FILE', '.token.json') };
  if (auth === 'app') {
    const watchUsers = str('WATCH_USERS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return { auth, tenantId, clientId, clientSecret: str('GRAPH_CLIENT_SECRET'), watchUsers };
  }
  throw new Error(`GRAPH_AUTH must be delegated or app, not "${auth}".`);
}

function lightConfig(): LightConfig | undefined {
  const raw = process.env.MQTT_URL?.trim();
  if (!raw) return undefined;
  const url = new URL(raw);
  if (url.protocol !== 'mqtt:') throw new Error('MQTT_URL must be mqtt://host[:port] (no TLS support).');
  const commands = { ...DEFAULT_LIGHT };
  for (const key of Object.keys(commands) as (keyof LightMap)[]) {
    const name = `LIGHT_${key.toUpperCase()}`;
    try {
      commands[key] = checkCommand(str(name, commands[key]));
    } catch (err) {
      throw new Error(`${name}: ${(err as Error).message}`);
    }
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 1883,
    username: process.env.MQTT_USER?.trim() || undefined,
    password: process.env.MQTT_PASSWORD?.trim() || undefined,
    clientId: str('MQTT_CLIENT_ID', `status-master-${hostname()}`),
    topic: str('LIGHT_TOPIC'),
    commands,
  };
}

export function loadConfig(): Config {
  const pollSeconds = int('POLL_SECONDS', 30);
  // Graph presence is throttled; much faster than this buys nothing.
  if (!(pollSeconds >= 5)) throw new Error('POLL_SECONDS must be at least 5.');
  const staleSeconds = int('STALE_SECONDS', Math.max(300, pollSeconds * 3));
  if (!(staleSeconds >= pollSeconds)) throw new Error('STALE_SECONDS must be at least POLL_SECONDS.');
  return { graph: graphConfig(), pollSeconds, light: lightConfig(), staleSeconds };
}
