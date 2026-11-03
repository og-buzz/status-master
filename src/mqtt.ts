// Minimal MQTT 3.1.1 publisher, enough to drive a stack light without a dependency: CONNECT with an optional
// Last Will, retained PUBLISH at QoS 0, keep-alive pings, reconnect with backoff, DISCONNECT. It never subscribes.
// Plain TCP only (no TLS): meant for a broker on the local network.

import { connect as tcpConnect, type Socket } from 'node:net';

export interface Will {
  topic: string;
  payload: string;
  retain: boolean;
}

export interface ConnectOptions {
  clientId: string;
  keepAliveSeconds: number;
  username?: string;
  password?: string;
  will?: Will;
}

/** MQTT "remaining length": 7 bits per byte, high bit set while more bytes follow. */
export function encodeLength(n: number): Buffer {
  if (!Number.isInteger(n) || n < 0 || n > 268_435_455) throw new RangeError(`MQTT packet too long: ${n}`);
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}

/** UTF-8 string with a 2-byte big-endian length. */
function mqttString(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  if (b.length > 0xffff) throw new RangeError('MQTT string longer than 65535 bytes');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}

const packet = (first: number, body: Buffer) => Buffer.concat([Buffer.from([first]), encodeLength(body.length), body]);

export function connectPacket(o: ConnectOptions): Buffer {
  let flags = 0x02; // clean session
  const payload = [mqttString(o.clientId)];
  if (o.will) {
    flags |= 0x04 | (o.will.retain ? 0x20 : 0); // will at QoS 0
    payload.push(mqttString(o.will.topic), mqttString(o.will.payload));
  }
  if (o.username) {
    flags |= 0x80;
    payload.push(mqttString(o.username));
    if (o.password) {
      flags |= 0x40;
      payload.push(mqttString(o.password));
    }
  }
  const keepAlive = Buffer.alloc(2);
  keepAlive.writeUInt16BE(o.keepAliveSeconds);
  return packet(0x10, Buffer.concat([mqttString('MQTT'), Buffer.from([4, flags]), keepAlive, ...payload]));
}

export function publishPacket(topic: string, payload: string, retain: boolean): Buffer {
  return packet(0x30 | (retain ? 0x01 : 0), Buffer.concat([mqttString(topic), Buffer.from(payload, 'utf8')]));
}

export const PINGREQ = Buffer.from([0xc0, 0x00]);
export const DISCONNECT = Buffer.from([0xe0, 0x00]);

/** Splits the first complete packet off `buf`, or returns undefined until more bytes arrive. */
export function takePacket(buf: Buffer): { type: number; flags: number; body: Buffer; rest: Buffer } | undefined {
  let len = 0;
  let mult = 1;
  let i = 1;
  for (; ; i++) {
    if (i >= buf.length) return undefined;
    if (i > 4) throw new Error('malformed MQTT remaining length');
    len += (buf[i] & 0x7f) * mult;
    mult *= 128;
    if (!(buf[i] & 0x80)) break;
  }
  const start = i + 1;
  if (buf.length < start + len) return undefined;
  return { type: buf[0] >> 4, flags: buf[0] & 0x0f, body: buf.subarray(start, start + len), rest: buf.subarray(start + len) };
}

const CONNACK_CODES = ['', 'unacceptable protocol version', 'client id rejected', 'server unavailable', 'bad user name or password', 'not authorized'];

export interface PublisherOptions {
  host: string;
  port: number;
  connect: ConnectOptions;
  log: (msg: string) => void;
  /** First reconnect delay; doubles up to 30 s. */
  retryMs?: number;
}

/**
 * Keeps one connection to the broker. Retained messages are remembered per topic and sent again after every
 * reconnect, so the broker's copy is restored even if this client's Last Will replaced it while it was away.
 */
export class MqttPublisher {
  private readonly o: PublisherOptions;
  private readonly retained = new Map<string, string>();
  private socket?: Socket;
  private connected = false;
  private closing = false;
  private retryMs: number;
  private reconnectTimer?: NodeJS.Timeout;
  private waiters: (() => void)[] = [];

  constructor(o: PublisherOptions) {
    this.o = o;
    this.retryMs = o.retryMs ?? 1000;
    this.open();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Resolves on the next successful CONNACK (at once if connected). */
  whenConnected(): Promise<void> {
    return this.connected ? Promise.resolve() : new Promise((r) => this.waiters.push(r));
  }

  /** Publishes retained at QoS 0. While disconnected it is held and sent on reconnect. */
  publish(topic: string, payload: string): void {
    this.retained.set(topic, payload);
    if (this.connected) this.socket?.write(publishPacket(topic, payload, true));
  }

  /** Sends anything already published, then DISCONNECT (which cancels the Last Will), and closes. */
  async close(): Promise<void> {
    this.closing = true;
    clearTimeout(this.reconnectTimer);
    const s = this.socket;
    if (!s || s.destroyed) return;
    const closed = new Promise<void>((r) => s.once('close', () => r()));
    if (this.connected) s.end(DISCONNECT);
    else s.destroy();
    await Promise.race([closed, new Promise((r) => setTimeout(r, 2000).unref())]);
    s.destroy();
  }

  private open(): void {
    const { host, port, connect, log } = this.o;
    const socket = tcpConnect({ host, port });
    this.socket = socket;
    socket.setNoDelay(true);
    let buf: Buffer = Buffer.alloc(0);
    let lastHeard = Date.now();

    // Ping at half the keep-alive; drop the connection if the broker has been silent for 1.5x keep-alive.
    const keepAliveMs = connect.keepAliveSeconds * 1000;
    const ping = setInterval(() => {
      if (Date.now() - lastHeard > keepAliveMs * 1.5) {
        log(`MQTT: no answer from ${host}:${port}, reconnecting`);
        socket.destroy();
      } else if (this.connected) {
        socket.write(PINGREQ);
      }
    }, keepAliveMs / 2);

    socket.on('connect', () => socket.write(connectPacket(connect)));
    socket.on('data', (chunk) => {
      lastHeard = Date.now();
      buf = Buffer.concat([buf, chunk]);
      try {
        for (let p = takePacket(buf); p; p = takePacket(buf)) {
          buf = p.rest;
          if (p.type !== 2) continue; // only CONNACK matters; PINGRESP just refreshes lastHeard
          const code = p.body[1];
          if (code !== 0) {
            log(`MQTT: ${host}:${port} refused the connection: ${CONNACK_CODES[code] ?? `code ${code}`}`);
            socket.destroy();
            return;
          }
          this.connected = true;
          this.retryMs = this.o.retryMs ?? 1000;
          log(`MQTT: connected to ${host}:${port}`);
          for (const [topic, payload] of this.retained) socket.write(publishPacket(topic, payload, true));
          for (const w of this.waiters.splice(0)) w();
        }
      } catch (err) {
        log(`MQTT: ${(err as Error).message}`);
        socket.destroy();
      }
    });
    socket.on('error', (err) => log(`MQTT: ${host}:${port}: ${err.message}`));
    socket.on('close', () => {
      clearInterval(ping);
      const was = this.connected;
      this.connected = false;
      if (this.closing) return;
      if (was) log('MQTT: connection lost, reconnecting');
      this.reconnectTimer = setTimeout(() => this.open(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 30_000);
    });
  }
}
