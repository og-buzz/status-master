// Entry point. `npm run once` prints the current status; `npm start` polls, prints each change and, when MQTT_URL is
// set, drives the stack light. Add --json for machine-readable output (one JSON object per line when polling).
// Status lines go to stdout; light and connection messages go to stderr.

import { clientCredentials, DelegatedAuth } from './auth.ts';
import { loadConfig } from './config.ts';
import { GraphClient } from './graph.ts';
import { MqttPublisher } from './mqtt.ts';
import { applyPoll, type GraphPresence, type Person, type Status } from './presence.ts';

const once = process.argv.includes('--once');
const json = process.argv.includes('--json');
const time = () => new Date().toLocaleTimeString();

const config = loadConfig();

// Who to watch, and how to read their presence.
let people: Person[] = [];
let readPresences: () => Promise<GraphPresence[]>;
if (config.graph.auth === 'delegated') {
  const auth = new DelegatedAuth(config.graph);
  const graph = new GraphClient(auth.accessToken);
  const me = auth.identity();
  readPresences = async () => [await graph.getMyPresence()];
  const id = me.oid ?? (await graph.getMyPresence()).id;
  people = [{ id, upn: me.username ?? id, displayName: me.name ?? me.username ?? 'me' }];
} else {
  const graph = new GraphClient(clientCredentials(config.graph));
  for (const u of config.graph.watchUsers) {
    try {
      people.push(await graph.getUser(u));
    } catch (err) {
      console.error(`Skipping ${u}: ${(err as Error).message}`);
    }
  }
  if (people.length === 0) throw new Error('None of WATCH_USERS could be resolved.');
  readPresences = () => graph.getPresences(people.map((p) => p.id));
}

const line = (s: Status) =>
  [
    s.person.displayName.padEnd(24),
    s.state.padEnd(9),
    `${s.availability}/${s.activity}`.padEnd(32),
    s.outOfOffice ? 'OOO ' : '',
    s.message ?? '',
  ]
    .join(' ')
    .trimEnd();

// The light follows the first watched person. If status-master drops off the broker, the broker publishes the
// `stale` command (Last Will) so the light never shows a state nobody is updating.
const lightCfg = once ? undefined : config.light;
const light =
  lightCfg &&
  new MqttPublisher({
    host: lightCfg.host,
    port: lightCfg.port,
    connect: {
      clientId: lightCfg.clientId,
      keepAliveSeconds: 30,
      username: lightCfg.username,
      password: lightCfg.password,
      will: { topic: lightCfg.topic, payload: lightCfg.commands.stale, retain: true },
    },
    log: (msg) => console.error(`${time()}  ${msg}`),
  });
let shown: string | undefined;
function show(command: string, why: string): void {
  if (!light || !lightCfg || command === shown) return;
  shown = command;
  light.publish(lightCfg.topic, command);
  console.error(`${time()}  light ${command} (${why})${light.isConnected ? '' : ', sent when the broker is back'}`);
}

let statuses = new Map<string, Status>();
let lastGoodPoll = Date.now();

async function poll(): Promise<void> {
  const presences = await readPresences();
  const result = applyPoll(statuses, people, presences, Date.now());
  statuses = result.statuses;
  lastGoodPoll = Date.now();
  for (const { after } of result.changes) {
    if (json) console.log(JSON.stringify({ at: new Date().toISOString(), ...after }));
    else console.log(once ? line(after) : `${time()}  ${line(after)}`);
  }
  const lit = statuses.get(people[0].id);
  if (lightCfg && lit) show(lightCfg.commands[lit.state], `${lit.person.displayName} ${lit.state}`);
}

if (once) {
  await poll();
} else {
  // On Ctrl+C or a service stop, leave the light showing `stale`, then disconnect cleanly.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, async () => {
      if (light && lightCfg) {
        show(lightCfg.commands.stale, 'status-master stopping');
        await light.close();
      }
      process.exit(0);
    });
  }
  const target = lightCfg ? `, light on ${lightCfg.host}:${lightCfg.port} ${lightCfg.topic}` : '';
  console.error(`Watching ${people.length} user(s), every ${config.pollSeconds}s${target}. Ctrl+C to stop.`);
  for (;;) {
    try {
      await poll();
    } catch (err) {
      // Keep watching through transient Graph or network failures; after STALE_SECONDS, stop claiming a state.
      console.error(`${time()}  poll failed: ${(err as Error).message}`);
      if (lightCfg && Date.now() - lastGoodPoll > config.staleSeconds * 1000) {
        show(lightCfg.commands.stale, `no presence for ${config.staleSeconds}s`);
      }
    }
    await new Promise((r) => setTimeout(r, config.pollSeconds * 1000));
  }
}
