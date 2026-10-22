import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

// Synthetic transport/routing acceptance only: no microphone, provider key, or external API.
const port = 17887;
const server = spawn(process.execPath, ['--experimental-transform-types', 'examples/relay-local/src/server.ts'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, RELAY_MODE: 'mock', PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
server.stdout.on('data', value => { serverOutput += value; });
server.stderr.on('data', value => { serverOutput += value; });
const clients = [];
const pcm = Buffer.alloc(960).toString('base64');
const waitFor = async (predicate, label, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timeout: ${label}`);
    await delay(20);
  }
};
async function connect(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Authorization: `Bearer ${token}` } });
  const client = { ws, token, events: [], closed: false, send(type, rest = {}) { ws.send(JSON.stringify({ v: 1, type, ...rest })); } };
  clients.push(client);
  ws.on('message', value => { const event = JSON.parse(value.toString()); client.events.push(event); if (event.deliveryId && ws.readyState === WebSocket.OPEN) client.send('client.ack', { deliveryId: event.deliveryId }); });
  ws.on('close', () => { client.closed = true; });
  ws.on('error', () => {});
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  client.send('client.ready'); // Also exercise pre-admission buffering.
  client.ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) client.send('client.ping'); }, 4000);
  return client;
}
const audioFrom = (client, id) => client.events.filter(event => event.type === 'audio' && event.speakerId === id);
try {
  await waitFor(() => serverOutput.includes('listening'), 'server startup');
  const h = await connect('host-ja');
  const a = await connect('guest-en');
  await waitFor(() => clients.every(client => client.events.some(event => event.type === 'participant.state' && event.participant.participantId === client.token && event.participant.state === 'ready')), 'two ready peers');
  h.send('room.start');
  await waitFor(() => clients.every(client => client.events.some(event => event.type === 'route' && event.canCapture)), 'active routes');
  a.send('capture.pause');
  h.send('speech.start', { atMs: Date.now() });
  h.send('audio.append', { atMs: Date.now(), audio: pcm });
  await waitFor(() => audioFrom(a, h.token).length > 0, 'Japanese to muted English listener');
  assert.equal(audioFrom(h, h.token).length, 0);
  assert.ok(a.events.some(event => event.type === 'audio' && event.language === 'en'));
  a.send('capture.resume');
  await delay(100);
  a.send('speech.start', { atMs: Date.now() });
  a.send('audio.append', { atMs: Date.now(), audio: pcm });
  await waitFor(() => audioFrom(h, a.token).length > 0, 'English to Japanese listener');
  assert.ok(h.events.some(event => event.type === 'audio' && event.language === 'ja'));
  assert.equal(audioFrom(a, a.token).length, 0);
  assert.ok(h.events.some(event => event.type === 'caption.delta' && event.speakerId === a.token));
  a.ws.send(Buffer.alloc(32769));
  await waitFor(() => a.closed, 'oversized peer closes');
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  h.send('room.end');
  await waitFor(() => clients.every(client => client.closed), 'room end closes all peers');
  const ended = await connect('host-ja');
  await waitFor(() => ended.closed, 'ended room cannot be reused');
  assert.ok(ended.events.some(event => event.type === 'error' && event.fatal));
  process.stdout.write('PASS: synthetic two-client routing, muted listener, both directions, captions, oversized-frame isolation, end/reuse rejection\n');
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  for (const client of clients) { clearInterval(client.ping); client.ws.terminate(); }
  server.kill('SIGTERM');
  const kill = setTimeout(() => server.kill('SIGKILL'), 2000);
  await new Promise(resolve => server.once('close', resolve));
  clearTimeout(kill);
}
