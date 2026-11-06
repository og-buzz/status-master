// Which stack-light command each status shows. Pure: no I/O, so it is what the tests cover.
// Commands are the ClearCoreStackLight format (2.3+; RAMP and NNNMS need 2.4, PIX 2.5): items joined by `;`, each one of
//   NAME[,MODE]                     colour names: RED, GREEN, YELLOW, ... at full brightness
//   IOn=PERCENT[,MODE]              one light output, n = 0..5, e.g. IO5=26
//   IOn=RAMP,[FROM,]TO[,SPEED][,NNNMS]       an output rising FROM..TO %, then straight back (2.4)
//   IOn=PULSE,[FROM,]TO[,SPEED][,NNNMS]      an output easing FROM..TO % and back down (2.4)
//   STRIP[[n]|[a-b]]=R,G,B[,WW,CW][,MODE]   strip pixels in percent (red, green, blue, warm white, cool white)
//   PIX[[n]|[a-b]]=...                       the same on physical pixels, whatever strip_layout says (2.5)
//   STRIP[[n]|[a-b]]=EFFECT[,option...]     an effect: FIRE, BREATHE, RAMP, PULSE, ... with a speed, up to
//                                           two colours, a dimmer %, 4000K, 25HZ or a RAMP/PULSE period 1250MS
// MODE is ON (default), OFF, SLOW or FAST; SPEED is SLOW, ON or FAST. The publisher sets the brightness, so colour
// balancing lives here (LIGHT_* in .env), not on the light.

import type { State } from './presence.ts';

/** One command per presence state, plus `stale`: shown when presence can't be read, and as status-master's Last Will. */
export type LightMap = Record<State | 'stale', string>;

export const DEFAULT_LIGHT: LightMap = {
  available: 'GREEN',
  busy: 'RED',
  call: 'RED',
  dnd: 'RED,SLOW',
  away: 'YELLOW',
  brb: 'YELLOW,SLOW',
  offline: 'OFF',
  unknown: 'OFF',
  stale: 'OFF',
};

const NAMES = new Set(['RED', 'GREEN', 'BLUE', 'YELLOW', 'ORANGE', 'MAGENTA', 'CYAN', 'WHITE', 'ALL', 'ALARM', 'FIRE', 'OFF']);
const MODES = new Set(['ON', 'OFF', 'SLOW', 'FAST']);
const SPEEDS = new Set(['SLOW', 'ON', 'FAST']);
const IO_PINS = 6;
const MAX_PIXELS = 300;
const MAX_EFFECTS = 8;
const MAX_ITEM = 95; // the firmware's item buffer
// Effects.cpp in ClearCoreStackLight: the effect names and the named colours.
const EFFECTS = new Set([
  'FIRE', 'CANDLE', 'LAVA', 'SUNRISE', 'WATER', 'RAIN', 'ICE', 'AURORA', 'LIGHTNING', 'SPACE', 'NEBULA', 'METEOR',
  'LASER', 'LASERS', 'SCANNER', 'DISCO', 'STROBE', 'POLICE', 'CONFETTI', 'SPARKLE', 'RAINBOW', 'PLASMA', 'COMET',
  'THEATER', 'WIPE', 'MATRIX', 'BREATHE', 'HEARTBEAT', 'TWINKLE', 'FIREPLACE', 'LAKE', 'RAMP', 'PULSE', 'WIGWAG',
  'QUAD', 'BEACON', 'HAZARD', 'LIGHT', 'DAYLIGHT', 'NEUTRAL', 'WARMLIGHT',
]);
const COLOURS = new Set(['RED', 'ORANGE', 'AMBER', 'YELLOW', 'GREEN', 'CYAN', 'BLUE', 'PURPLE', 'MAGENTA', 'PINK',
  'WARM', 'COOL', 'WHITE']);

/** A percent with at most one decimal, 0..100, in the firmware's canonical form ("26", "27.5"); undefined if not. */
function asPercent(text: string): string | undefined {
  const m = /^(\d{1,3})(?:\.(\d))?$/.exec(text);
  const tenths = m ? Number(m[1]) * 10 + Number(m[2] ?? 0) : NaN;
  if (!m || tenths > 1000) return undefined;
  return tenths % 10 ? `${Math.floor(tenths / 10)}.${tenths % 10}` : String(tenths / 10);
}

function percent(text: string, where: string): string {
  const p = asPercent(text);
  if (p === undefined) throw new Error(`${where}: "${text}" isn't a percent 0..100 (one decimal at most)`);
  return p;
}

/** "1250MS": a RAMP period, 100..60000 ms. */
function asPeriod(text: string): string | undefined {
  const m = /^(\d+)MS$/.exec(text);
  const ms = m ? Number(m[1]) : NaN;
  return ms >= 100 && ms <= 60000 ? `${ms}MS` : undefined;
}

/** A whole number with a suffix in min..max, e.g. 4000K or 25HZ. */
function asSuffixed(text: string, suffix: string, min: number, max: number): string | undefined {
  const m = new RegExp(`^(\\d+)${suffix}$`).exec(text);
  const n = m ? Number(m[1]) : NaN;
  return n >= min && n <= max ? `${n}${suffix}` : undefined;
}

/** An effect colour: a name, or r/g/b[/ww/cw] percents. */
function asColour(text: string): string | undefined {
  if (COLOURS.has(text)) return text;
  const parts = text.split('/');
  if (parts.length !== 3 && parts.length !== 5) return undefined;
  const levels = parts.map(asPercent);
  return levels.every((l) => l !== undefined) ? levels.join('/') : undefined;
}

/** EFFECT[,option...] after STRIP...=; options in any order, empty ones skipped like the firmware does. */
function checkEffect(name: string, options: string[], where: string): string {
  const out = [name];
  let colours = 0;
  for (const tok of options) {
    if (!tok) continue;
    if (SPEEDS.has(tok)) {
      if (tok !== 'ON') out.push(tok);
      continue;
    }
    const opt = asPercent(tok) ?? asSuffixed(tok, 'K', 1000, 10000) ?? asSuffixed(tok, 'HZ', 1, 60) ?? asPeriod(tok);
    if (opt !== undefined) {
      out.push(opt);
      continue;
    }
    const colour = colours < 2 ? asColour(tok) : undefined;
    if (colour === undefined) {
      throw new Error(`${where}: "${tok}" isn't a speed, colour (two at most), dimmer %, 4000K, 25HZ or 1250MS`);
    }
    colours++;
    out.push(colour);
  }
  return out.join(',');
}

/** RAMP or PULSE,[FROM,]TO[,SPEED][,NNNMS] after IOn=. */
function checkIoWave(wave: string, options: string[], where: string): string {
  const levels: string[] = [];
  const rest: string[] = [];
  for (const tok of options) {
    const level = asPercent(tok);
    if (level !== undefined) {
      if (levels.length === 2) throw new Error(`${where}: ${wave} takes two percents, from and to`);
      levels.push(level);
    } else if (SPEEDS.has(tok)) {
      if (tok !== 'ON') rest.push(tok);
    } else if (asPeriod(tok)) {
      rest.push(asPeriod(tok)!);
    } else {
      throw new Error(`${where}: "${tok}" isn't a percent, SLOW/ON/FAST or a period like 1250MS`);
    }
  }
  if (levels.length === 0) throw new Error(`${where}: ${wave} needs percents, e.g. ${where}=${wave},50,100`);
  return [wave, ...levels, ...rest].join(',');
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
  const tokens = value.split(',').map((s) => s.trim());
  const io = /^IO(\d)$/.exec(key);
  if (io) {
    if (Number(io[1]) >= IO_PINS) throw new Error(`IO pins are IO0..IO5, got "${key}"`);
    if (tokens[0] === 'RAMP' || tokens[0] === 'PULSE') return `${key}=${checkIoWave(tokens[0], tokens.slice(1), key)}`;
    const { levels, mode } = values(value, key);
    if (levels.length !== 1) throw new Error(`${key} takes one percent, e.g. ${key}=26`);
    return `${key}=${levels[0]}${mode && mode !== 'ON' ? `,${mode}` : ''}`;
  }
  // STRIP addresses layout positions; PIX (2.5) addresses physical pixels and may run backwards.
  const strip = /^(STRIP|PIX)(?:\[(\d{1,3})(?:-(\d{1,3}))?\])?$/.exec(key);
  if (strip) {
    const phys = strip[1] === 'PIX';
    const first = strip[2] === undefined ? undefined : Number(strip[2]);
    const last = strip[3] === undefined ? first : Number(strip[3]);
    if (first !== undefined && (first >= MAX_PIXELS || last! >= MAX_PIXELS || (last! < first && !phys))) {
      throw new Error(`${key}: pixels are 0..${MAX_PIXELS - 1}, first..last`);
    }
    if (EFFECTS.has(tokens[0])) return `${key}=${checkEffect(tokens[0], tokens.slice(1), key)}`;
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
  let effects = 0;
  for (const raw of command.split(';')) {
    const item = raw.trim().toUpperCase();
    if (!item) continue; // empty item, e.g. a trailing ';'
    if (item.length > MAX_ITEM) throw new Error(`"${raw.trim()}": items are ${MAX_ITEM} characters at most`);
    const eq = item.indexOf('=');
    if (eq >= 0) {
      const checked = checkAssignment(item.slice(0, eq).trim(), item.slice(eq + 1));
      if (/^STRIP[^=]*=[A-Z]/.test(checked) && ++effects > MAX_EFFECTS) {
        throw new Error(`at most ${MAX_EFFECTS} effects in one command`);
      }
      items.push(checked);
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
