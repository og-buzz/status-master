import assert from 'node:assert/strict';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { test } from 'node:test';
import { connectPacket, encodeLength, MqttPublisher, publishPacket, takePacket } from '../src/mqtt.ts';

test('remaining length uses the MQTT variable-length encoding', () => {
  assert.deepEqual([...encodeLength(0)], [0x00]);
  assert.deepEqual([...encodeLength(127)], [0x7f]);
  assert.deepEqual([...encodeLength(128)], [0x80, 0x01]);
  assert.deepEqual([...encodeLength(16_383)], [0xff, 0x7f]);
  assert.deepEqual([...encodeLength(2_097_152)], [0x80, 0x80, 0x80, 0x01]);
  assert.throws(() => encodeLength(268_435_456), RangeError);
});

test('retained PUBLISH at QoS 0 matches the spec byte for byte', () => {
  // 0x31 = PUBLISH + retain; length 8 = 2 (topic length) + "a/b" + "RED".
  assert.deepEqual([...publishPacket('a/b', 'RED', true)], [0x31, 8, 0, 3, 0x61, 0x2f, 0x62, 0x52, 0x45, 0x44]);
  assert.equal(publishPacket('a/b', 'RED', false)[0], 0x30);
});

test('CONNECT carries the client id, a retained Last Will and the credentials', () => {
  const p = connectPacket({
    clientId: 'sm',
    keepAliveSeconds: 30,
    username: 'u',
    password: 'p',
    will: { topic: 't', payload: 'OFF', retain: true },
  });
  const parsed = takePacket(p);
  assert.ok(parsed);
  assert.equal(parsed.type, 1);
  const b = parsed.body;
  assert.equal(b.subarray(2, 6).toString(), 'MQTT');
  assert.equal(b[6], 4); // protocol level 3.1.1
  assert.equal(b[7], 0x80 | 0x40 | 0x20 | 0x04 | 0x02); // user, password, will retain, will, clean session
  assert.equal(b.readUInt16BE(8), 30);
  assert.equal(b.subarray(10).toString('latin1'), '\x00\x02sm\x00\x01t\x00\x03OFF\x00\x01u\x00\x01p');

  // No user: no credential flags, and a password alone is never sent.
  assert.equal(takePacket(connectPacket({ clientId: 'x', keepAliveSeconds: 5, password: 'p' }))?.body[7], 0x02);
});

test('takePacket waits for whole packets and splits several', () => {
  const two = Buffer.concat([Buffer.from([0x20, 0x02, 0x00, 0x00]), Buffer.from([0xd0, 0x00])]);
  assert.equal(takePacket(two.subarray(0, 3)), undefined);
  const first = takePacket(two);
  assert.equal(first?.type, 2);
  assert.equal(takePacket(first!.rest)?.type, 13);
  assert.equal(takePacket(Buffer.from([0x30])), undefined);
});

/** A broker stand-in: answers CONNECT with CONNACK and records what each connection sent. */
function fakeBroker() {
  const connections: { socket: Socket; packets: { type: number; flags: number; body: Buffer }[] }[] = [];
  const server = createServer((socket) => {
    const conn = { socket, packets: [] as { type: number; flags: number; body: Buffer }[] };
    connections.push(conn);
    let buf: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (let p = takePacket(buf); p; p = takePacket(buf)) {
        buf = p.rest;
        conn.packets.push(p);
        if (p.type === 1) socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));
      }
    });
    socket.on('error', () => {});
  });
  return { server, connections };
}

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), `timed out waiting for ${what}`);
};

test('publisher re-sends retained state after a reconnect, and DISCONNECTs on close', async () => {
  const { server, connections } = fakeBroker();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const logs: string[] = [];
  const pub = new MqttPublisher({
    host: '127.0.0.1',
    port,
    connect: { clientId: 'sm-test', keepAliveSeconds: 30, will: { topic: 'light/command', payload: 'OFF', retain: true } },
    log: (m) => logs.push(m),
    retryMs: 20,
  });
  try {
    pub.publish('light/command', 'RED'); // before CONNACK: held, then sent
    await pub.whenConnected();
    pub.publish('light/command', 'GREEN');
    await until(() => connections[0]?.packets.filter((p) => p.type === 3).length === 2, 'two publishes');
    const sent = connections[0].packets.filter((p) => p.type === 3).map((p) => p.body.subarray(2 + 13).toString());
    assert.deepEqual(sent, ['RED', 'GREEN']);
    assert.ok(connections[0].packets.every((p) => p.type !== 3 || p.flags === 0x01), 'all retained, QoS 0');

    // Broker drops the connection: the client comes back and restores the last retained command.
    connections[0].socket.destroy();
    await until(() => connections[1]?.packets.some((p) => p.type === 3) ?? false, 'reconnect + republish');
    assert.equal(connections[1].packets.find((p) => p.type === 3)!.body.subarray(15).toString(), 'GREEN');
    assert.ok(logs.some((l) => l.includes('connection lost')));

    await pub.close();
    await until(() => connections[1].packets.some((p) => p.type === 14), 'DISCONNECT');
  } finally {
    await pub.close();
    server.close();
  }
});

test('publisher reports a refused connection and keeps retrying', async () => {
  const server = createServer((socket) => {
    socket.on('data', () => socket.write(Buffer.from([0x20, 0x02, 0x00, 0x05]))); // not authorized
    socket.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const logs: string[] = [];
  const pub = new MqttPublisher({ host: '127.0.0.1', port, connect: { clientId: 'x', keepAliveSeconds: 30 }, log: (m) => logs.push(m), retryMs: 20 });
  try {
    await until(() => logs.filter((l) => l.includes('not authorized')).length >= 2, 'two refusals');
    assert.equal(pub.isConnected, false);
  } finally {
    await pub.close();
    server.close();
  }
});
