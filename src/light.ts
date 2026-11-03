// Which stack-light command each status shows. Pure: no I/O, so it is what the tests cover.
// Commands are the ClearCoreStackLight format (2.3+): items joined by `;`, each one of
//   NAME[,MODE]                     colour names: RED, GREEN, YELLOW, ... at full brightness
//   IOn=PERCENT[,MODE]              one light output, n = 0..5, e.g. IO5=26
//   STRIP[[n]|[a-b]]=R,G,B[,WW,CW][,MODE]   strip pixels in percent (red, green, blue, warm white, cool white)
// MODE is ON (default), OFF, SLOW or FAST. The publisher sets the brightness, so colour balancing lives here
// (LIGHT_* in .env), not on the light.

import type { State } from './presence.ts';

/** One command per presence state, plus `stale`: shown when presence can't be read, and as status-master's Last Will. */
export type LightMap = Record<State | 'stale', string>;

export const DEFAULT_LIGHT: LightMap = {
  available: 'GREEN',
  busy: 'RED',
  dnd: 'RED,SLOW',
  away: 'YELLOW',
  offline: 'OFF',
  unknown: 'OFF',
  stale: 'OFF',
};

const NAMES = new Set(['RED', 'GREEN', 'BLUE', 'YELLOW', 'ORANGE', 'MAGENTA', 'CYAN', 'WHITE', 'ALL', 'ALARM', 'FIRE', 'OFF']);
const MODES = new Set(['ON', 'OFF', 'SLOW', 'FAST']);
const IO_PINS = 6;
const MAX_PIXELS = 300;

/** A percent with at most one decimal, 0..100. Returned in the firmware's canonical form ("26", "27.5"). */
function percent(text: string, where: string): string {
  const m = /^(\d{1,3})(?:\.(\d))?$/.exec(text);
  const tenths = m ? Number(m[1]) * 10 + Number(m[2] ?? 0) : NaN;
  if (!m || tenths > 1000) throw new Error(`${where}: "${text}" isn't a percent 0..100 (one decimal at most)`);
  return tenths % 10 ? `${Math.floor(tenths / 10)}.${tenths % 10}` : String(tenths / 10);
}

/** Splits "v1,v2,...[,MODE]" into percents and an optional mode. */
function values(text: string, where: string): { levels: string[]; mode?: string } {
  const parts = text.split(',').map((s) => s.trim());
  const last = parts[parts.length - 1];
  const mode = MODES.has(last) ? last : undefined;
  if (mode) parts.pop();
  return { levels: parts.map((p) => percent(p, where)), mode };
}

function checkAssignment(key: string, value: string): string {
  const io = /^IO(\d)$/.exec(key);
  if (io) {
    if (Number(io[1]) >= IO_PINS) throw new Error(`IO pins are IO0..IO5, got "${key}"`);
    const { levels, mode } = values(value, key);
    if (levels.length !== 1) throw new Error(`${key} takes one percent, e.g. ${key}=26`);
    return `${key}=${levels[0]}${mode && mode !== 'ON' ? `,${mode}` : ''}`;
  }
  const strip = /^STRIP(?:\[(\d{1,3})(?:-(\d{1,3}))?\])?$/.exec(key);
  if (strip) {
    const first = strip[1] === undefined ? undefined : Number(strip[1]);
    const last = strip[2] === undefined ? first : Number(strip[2]);
    if (first !== undefined && (first >= MAX_PIXELS || last! >= MAX_PIXELS || last! < first)) {
      throw new Error(`${key}: pixels are 0..${MAX_PIXELS - 1}, first..last`);
    }
    const { levels, mode } = values(value, key);
    if (levels.length !== 3 && levels.length !== 5) throw new Error(`${key} takes red,green,blue[,warm,cool] percents`);
    return `${key}=${levels.join(',')}${mode && mode !== 'ON' ? `,${mode}` : ''}`;
  }
  throw new Error(`unknown item "${key}"`);
}

/**
 * Checks a light command the way the firmware's parser does and returns it upper-cased and without spaces.
 * Throws naming the bad part, so a typo in .env fails at startup instead of being rejected by the light.
 */
export function checkCommand(command: string): string {
  const items: string[] = [];
  for (const raw of command.split(';')) {
    const item = raw.trim().toUpperCase();
    if (!item) continue; // empty item, e.g. a trailing ';'
    const eq = item.indexOf('=');
    if (eq >= 0) {
      items.push(checkAssignment(item.slice(0, eq).trim(), item.slice(eq + 1)));
      continue;
    }
    const [name, mode, extra] = item.split(',').map((s) => s.trim());
    if (extra !== undefined) throw new Error(`"${raw.trim()}": one NAME[,MODE] pair per item`);
    if (!NAMES.has(name)) throw new Error(`unknown light name "${name}"`);
    if (mode !== undefined && !MODES.has(mode)) throw new Error(`unknown light mode "${mode}"`);
    if (name === 'OFF' && mode !== undefined) throw new Error('OFF takes no mode');
    items.push(mode === undefined ? name : `${name},${mode}`);
  }
  if (items.length === 0) throw new Error('empty light command');
  return items.join(';');
}
