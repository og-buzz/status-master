# status-master

Central source for employee status information. Today it reads Microsoft Teams presence and drives an
MQTT-controlled stack light ([ClearCoreStackLight](https://github.com/og-buzz/Clearcore-MQ-Stacklight) on a Teknic
ClearCore) so the light at someone's desk shows their Teams status.

## How it works

status-master polls Microsoft Graph every `POLL_SECONDS` and maps each Graph `availability` (and, for calls, the
`activity`) to one coarse state:

| State       | Graph availability             | Light (default) |
|-------------|--------------------------------|-----------------|
| `available` | Available, AvailableIdle       | `GREEN`         |
| `busy`      | Busy, BusyIdle                 | `RED`           |
| `call`      | Busy or BusyIdle with the activity InACall or InAConferenceCall | `RED` |
| `dnd`       | DoNotDisturb                   | `RED,SLOW`      |
| `away`      | Away                           | `YELLOW`        |
| `brb`       | BeRightBack                    | `YELLOW,SLOW`   |
| `offline`   | Offline                        | `OFF`           |
| `unknown`   | PresenceUnknown, anything else | `OFF`           |

A call shows once it is answered: Graph has no ringing state. Do not disturb stays `dnd` during a call.

The raw `availability` and `activity` (e.g. `InAMeeting`, `Presenting`), the out-of-office flag and the Teams
status message are kept too.

When the state changes it publishes the light command, retained, to `LIGHT_TOPIC`. The light applies it and reports
on its `event` topic. Each light command is checked against the firmware's format at startup, so a typo in `.env`
fails right away instead of being rejected by the light.

**The light never shows a state nobody is updating.** It shows `LIGHT_STALE` (default `OFF`) when:

- status-master stops (Ctrl+C or a service stop),
- status-master drops off the broker (its MQTT Last Will), or
- presence can't be read for `STALE_SECONDS` (default 300).

### Graph access

- **delegated** (default): one person watches their own presence. They sign in once with a device code
  (`npm run login`). status-master then refreshes the token by itself and needs only the delegated `Presence.Read`
  permission (plus `offline_access`, `openid`, `profile`). The tokens live in `TOKEN_FILE` (mode 0600, gitignored)
  on the machine that runs status-master, never on a light.
- **app**: client credentials, watching everyone in `WATCH_USERS` (the light follows the first one). Needs the
  application permissions `Presence.Read.All` and `User.Read.All` with admin consent, and a client secret.

## Setup

1. App registration in Entra ID:
   - delegated: the delegated Graph permission `Presence.Read`, admin-consented, and **Allow public client flows**
     set to Yes (device code sign-in needs it).
   - app: the application permissions above, admin-consented, and a client secret.
2. `cp .env.example .env`, then fill in the tenant id and client id. Set `MQTT_URL` and `LIGHT_TOPIC` for a light.
3. delegated only: `npm run login`, open the page it prints, enter the code, and sign in.

Requires Node 24+. No dependencies.

```sh
npm run login         # delegated: one-time sign-in
npm run once          # print the current status (doesn't touch the light)
npm start             # poll, print each change, drive the light
npm start -- --json   # same, one JSON object per line on stdout
npm test
```

Test the light without Teams: publish a command yourself, e.g.
`mosquitto_pub -h <broker> -r -t <LIGHT_TOPIC> -m 'YELLOW,SLOW'`.

## Light commands

The light ([ClearCoreStackLight](https://github.com/og-buzz/Clearcore-MQ-Stacklight) 2.3+) takes the brightness
with each command, so colour balancing lives here, in `LIGHT_*` (one command per state, checked at startup):

| Item | Does |
|---|---|
| `RED`, `GREEN,SLOW`, ... | Colour names at full brightness on the light's red/green/blue pins and the strip |
| `IO5=26[,MODE]` | One light output at a percent, e.g. a bright green LED turned down |
| `STRIP=R,G,B[,WW,CW][,MODE]`, `STRIP[a-b]=...` | Strip pixels in percent (red, green, blue, warm white, cool white) |
| `STRIP[a-b]=EFFECT[,options]` | An effect over the pixels (`FIRE`, `BREATHE`, `RAMP`, ...; see the light's README) |
| `IOn=RAMP,[FROM,]TO[,SPEED][,NNNMS]` | One light output rising from `FROM` to `TO` percent, then straight back (2.4+) |

For example, a desk light whose green LED is too bright and a strip that is a 20 % warm white with two status
pixels in the middle:

```sh
LIGHT_AVAILABLE=IO5=26;STRIP=0,0,0,20,0;STRIP[24-25]=0,100,0
LIGHT_BUSY=IO4=100;STRIP=0,0,0,20,0;STRIP[24-25]=100,0,0
LIGHT_DND=IO4=100,SLOW;STRIP=0,0,0,20,0;STRIP[24-25]=100,0,0,0,0,SLOW
LIGHT_AWAY=IO4=100;IO5=26;STRIP=0,0,0,20,0;STRIP[24-25]=100,40,0
LIGHT_OFFLINE=OFF
```

`RAMP` rises evenly and drops straight back. Ramps with the same period stay in step, on the strip and on `IOn`
outputs, so a status pixel and the stack light can pulse together (firmware 2.4+), e.g. for do not disturb:

```sh
LIGHT_DND=IO4=RAMP,50,100,1250MS;STRIP=0,0,0,3,0;STRIP[12]=RAMP,2/0/0,6/0/0,1250MS
```

Pixel numbers are positions along the light's `strip_layout`, so they may change when the strip is installed in
a new shape.

## Deployment

status-master runs as a Docker container next to the MQTT broker (`compose.yaml`: host networking, restarts by
itself, `./data` holding the token file, run as the owner of `./data`).

```sh
npm run login               # once, on a workstation: creates .token.json
scripts/deploy.sh           # copies the code and .env, and the token on the first deploy only, then (re)starts
docker logs status-master   # on the host
```

The script deploys to `DEPLOY_HOST` from `.env` (or `HOST=user@host`) over SSH, into `~/status-master`. After the
first deploy the token rotates on the host, so the script keeps the host's copy.

`firmware/StatusLight/` is the first USB bench sketch for the light, from before MQTT; the light now runs
ClearCoreStackLight.

## Roadmap

**One deployment for every desk.** Today one status-master serves one person and one light: it publishes that
person's light commands (`LIGHT_*` in `.env`) to one topic (`LIGHT_TOPIC`), and the light belongs to them only
because its `role=` on the SD card makes the same topic. A second person needs a second container, sign-in and
`.env`. The plan turns that around, so status-master knows people and each light knows its owner and its look:

1. **Lights carry their owner and look** (ClearCoreStackLight): `owner=<UPN>` and `light_<state>=<command>` in
   `settings.ini`, one per state (`available`, `busy`, `call`, `dnd`, `away`, `brb`, `offline`, `unknown`, `stale`),
   with built-in defaults. The light subscribes to its owner's presence topic and keeps its `.../command` topic for
   tests and overrides. A look changes with `set light_busy ...` on the USB console or by editing the card; a new
   desk is a flashed board and a written card, with no change on the server.
2. **status-master publishes states, not commands**: a retained state name per person on
   `<prefix>/presence/<UPN>`, and its own online/offline topic (with the Last Will), which the lights watch to show
   `light_stale`. `LIGHT_*` and `LIGHT_TOPIC` leave `.env`; during the switch it can publish both.
3. **Many people from one instance**: Graph access to other people's presence, either application permissions
   (`Presence.Read.All`, `User.Read.All`, admin consent) or delegated `Presence.Read.All` on one account if the
   tenant's consent policy allows it; the people come from a list or a group, UPNs resolved to Graph user ids.
4. **Broker authentication and ACLs**: no anonymous clients; only status-master publishes presence, and lights get
   read access to presence and their own command topic.
