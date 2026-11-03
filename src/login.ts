// `npm run login`: one-time device code sign-in for GRAPH_AUTH=delegated. Saves the tokens to TOKEN_FILE.

import { DelegatedAuth } from './auth.ts';
import { loadConfig } from './config.ts';

const { graph } = loadConfig();
if (graph.auth !== 'delegated') throw new Error('npm run login is only for GRAPH_AUTH=delegated.');

const auth = new DelegatedAuth(graph);
const who = await auth.login((message) => console.log(message));
console.log(`Signed in as ${who.name ?? '?'} (${who.username ?? '?'}). Tokens saved to ${graph.tokenFile}.`);
