# Changelog

## 0.2.0 — 2026-11-06

### Added

- `call` state: busy with a Teams call in progress (activity `InACall` or `InAConferenceCall`), with `LIGHT_CALL`.
  Do not disturb stays `dnd` during a call. Graph has no ringing state, so a call shows once it is answered.
- `brb` state for Be right back, separate from `away`, with `LIGHT_BRB` (default `YELLOW,SLOW`).
- The light-command check accepts ClearCoreStackLight's strip effects (`FIRE`, `SPARKLE`, ...), `RAMP` and `PULSE`
  on strip ranges and light outputs (`IOn=RAMP|PULSE,FROM,TO[,SPEED][,NNNMS]`), and `PIX[a-b]` physical pixels
  (firmware 2.5+).
- Roadmap: one deployment for every desk (lights carry their owner and look; status-master publishes states).

## 0.1.0 — 2026-11-04

- Teams presence (delegated or app Graph access) to an MQTT stack light, with stale handling and deployment to a
  Docker host.
