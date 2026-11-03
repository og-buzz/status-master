# status-master

Central source for employee status information. Today it reads Microsoft Teams presence and drives an
MQTT-controlled stack light ([ClearCoreStackLight](https://github.com/og-buzz/Clearcore-MQ-Stacklight) on a Teknic
ClearCore) so the light at someone's desk shows their Teams status.

## How it works

status-master polls Microsoft Graph every `POLL_SECONDS` and maps each Graph `availability` to one coarse state:

| State       | Graph availability             | Light (default) |
|-------------|--------------------------------|-----------------|
| `available` | Available, AvailableIdle       | `GREEN`         |
| `busy`      | Busy, BusyIdle                 | `RED`           |
| `dnd`       | DoNotDisturb                   | `RED,SLOW`      |
| `away`      | Away, BeRightBack              | `YELLOW`        |
| `offline`   | Offline                        | `OFF`           |
| `unknown`   | PresenceUnknown, anything else | `OFF`           |

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

For example, a desk light whose green LED is too bright and a strip that is a 20 % warm white with two status
pixels in the middle:

```sh
LIGHT_AVAILABLE=IO5=26;STRIP=0,0,0,20,0;STRIP[24-25]=0,100,0
LIGHT_BUSY=IO4=100;STRIP=0,0,0,20,0;STRIP[24-25]=100,0,0
LIGHT_DND=IO4=100,SLOW;STRIP=0,0,0,20,0;STRIP[24-25]=100,0,0,0,0,SLOW
LIGHT_AWAY=IO4=100;IO5=26;STRIP=0,0,0,20,0;STRIP[24-25]=100,40,0
LIGHT_OFFLINE=OFF
```

The light also runs animated effects (`STRIP=FIRE`, `STRIP[0-9]=LIGHT,4000K,60`, ...; see its README), but the
startup check doesn't know them yet, so `LIGHT_*` can't use them for now. The `FIRE` colour name works.

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
