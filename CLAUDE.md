# status-master

Central employee-status service. Reads Teams presence from Microsoft Graph and drives a stack light over MQTT.
Read `README.md` first.

## Commands

- `npm test`: unit tests (node:test, no dependencies). The pure logic is in `src/presence.ts` (presence mapping,
  change detection) and `src/light.ts` (light commands). `test/mqtt.test.ts` runs the MQTT publisher against an
  in-process fake broker; `test/auth.test.ts` stubs `fetch`.
- `npm run login` (delegated mode), `npm run once` and `npm start` need a filled-in `.env` (see `.env.example`).
- Type check: no TypeScript in the project. Run `tsc -p .` from any TypeScript 5.9+ install, with `--typeRoots`
  pointing at an `@types/node` if the project has none.

## Rules

- Graph access is read-only. Default is delegated `Presence.Read` (the user's own presence, device code sign-in);
  `GRAPH_AUTH=app` uses client credentials with `Presence.Read.All` + `User.Read.All`.
- **Secrets** stay in `.env` and `TOKEN_FILE` (both gitignored), on the server only, never on a light. Tests and docs
  use made-up users.
- `src/mqtt.ts` is a deliberately small MQTT 3.1.1 publisher (QoS 0, retained, Last Will, plain TCP). Keep it
  publish-only; reach for a library before adding subscribe, QoS 1+ or TLS.
- Light commands (`LIGHT_*`) must match ClearCoreStackLight's parser (`Light.cpp` in
  [og-buzz/Clearcore-MQ-Stacklight](https://github.com/og-buzz/Clearcore-MQ-Stacklight)); `src/light.ts` mirrors
  it (2.3 format, without the strip effects so far).
- Deploy with `scripts/deploy.sh` (Docker on the broker host, `DEPLOY_HOST` in `.env`); never copy `.token.json`
  over a host's newer one.
- **Git:** hosted on GitHub, [og-buzz/status-master](https://github.com/og-buzz/status-master) (public), and pushed
  to GitLab `ctms/labs/status-master` as the second remote `gitlab`; keep both on the same commit. Keep host names,
  topics, tenant/client ids and people out of tracked files: they belong in `.env`. Commit or push only when asked.
