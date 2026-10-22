import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import {
  AUDIO_BATCH_BYTES,
  AUDIO_FRAME_BYTES,
} from "../packages/protocol/src/index.ts";
import {
  OpenAITranslationProvider,
  type ProviderTransport,
} from "../packages/provider-openai/src/index.ts";
import {
  createSummary,
  loadPcm,
  parseWavReplayArgs,
  PCM_BYTES_PER_SAMPLE,
  PCM_SAMPLE_RATE,
  WavReplayError,
} from "./wav-replay-helper.ts";

class OfflineProviderTransport implements ProviderTransport {
  bufferedAmount = 0;
  readonly sent: string[] = [];
  private openHandler = () => {};
  private messageHandler = (_data: string | Uint8Array) => {};
  private closeHandler = () => {};
  private errorHandler = () => {};

  send(data: string): void { this.sent.push(data); }
  close(): void { this.closeHandler(); }
  onOpen(handler: () => void): void { this.openHandler = handler; }
  onMessage(handler: (data: string | Uint8Array) => void): void { this.messageHandler = handler; }
  onClose(handler: () => void): void { this.closeHandler = handler; }
  onError(handler: () => void): void { this.errorHandler = handler; }
  open(): void { this.openHandler(); }
  message(value: Record<string, unknown>): void { this.messageHandler(JSON.stringify(value)); }
}

function padToFrame(pcm: Buffer): { padded: Buffer; paddingBytes: number } {
  const paddingBytes = (AUDIO_FRAME_BYTES - (pcm.length % AUDIO_FRAME_BYTES)) % AUDIO_FRAME_BYTES;
  return { padded: paddingBytes === 0 ? pcm : Buffer.concat([pcm, Buffer.alloc(paddingBytes)]), paddingBytes };
}

async function checkProvider(pcm: Buffer): Promise<{ exact: boolean; input: boolean }> {
  const transport = new OfflineProviderTransport();
  const output: Buffer[] = [];
  let fatal = false;
  const provider = new OpenAITranslationProvider(
    "offline-placeholder",
    "en",
    { connect: () => transport },
    {
      onOutputAudio: audio => output.push(Buffer.from(audio, "base64")),
      onOutputTranscript: () => {},
      onInputTranscript: () => {},
      onFatal: () => { fatal = true; },
    },
  );
  transport.open();
  transport.message({ type: "session.created", session: {} });
  transport.message({ type: "session.updated", session: {} });

  const { padded } = padToFrame(pcm);
  for (let offset = 0; offset < padded.length; offset += AUDIO_BATCH_BYTES) {
    assert.equal(provider.appendPcm(padded.subarray(offset, offset + AUDIO_BATCH_BYTES).toString("base64")), true);
  }
  const input = transport.sent
    .map(value => JSON.parse(value) as { type: string; audio?: string })
    .filter(value => value.type === "session.input_audio_buffer.append")
    .map(value => Buffer.from(value.audio!, "base64"));

  const sizes = [2, 1_002, 4_800, 14, 48_000, 6_398];
  for (let offset = 0, index = 0; offset < pcm.length; index += 1) {
    const size = Math.min(sizes[index % sizes.length]!, pcm.length - offset);
    const evenSize = size - (size % PCM_BYTES_PER_SAMPLE);
    const length = evenSize === 0 ? Math.min(2, pcm.length - offset) : evenSize;
    const delta = pcm.subarray(offset, offset + length);
    transport.message({ type: "session.output_audio.delta", delta: delta.toString("base64") });
    offset += length;
  }
  const outputBeforeClose = Buffer.concat(output);
  const outputChunksBeforeClose = output.length;
  transport.message({ type: "session.closed" });
  assert.equal(output.length, outputChunksBeforeClose);
  await provider.close();
  return {
    exact: !fatal && outputBeforeClose.equals(pcm),
    input: Buffer.concat(input).equals(padded),
  };
}

interface RelayClient {
  readonly ws: WebSocket;
  readonly id: string;
  readonly events: Array<Record<string, unknown>>;
  send(type: string, rest?: Record<string, unknown>): void;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, code: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new WavReplayError(code);
    await delay(20);
  }
}

async function connectClient(port: number, token: string, clients: RelayClient[]): Promise<RelayClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const client: RelayClient = {
    ws,
    id: token,
    events: [],
    send(type, rest = {}) { ws.send(JSON.stringify({ v: 1, type, ...rest })); },
  };
  clients.push(client);
  ws.on("message", value => {
    const event = JSON.parse(value.toString()) as Record<string, unknown>;
    client.events.push(event);
    if (typeof event.deliveryId === "number" && ws.readyState === WebSocket.OPEN) {
      client.send("client.ack", { deliveryId: event.deliveryId });
    }
  });
  ws.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", () => reject(new WavReplayError("RELAY_CONNECT_FAILED")));
  });
  client.send("client.ready");
  return client;
}

function receivedAudio(client: RelayClient, speakerId: string): Buffer {
  return Buffer.concat(client.events
    .filter(event => event.type === "audio" && event.speakerId === speakerId)
    .map(event => Buffer.from(event.audio as string, "base64")));
}

async function sendPcm(client: RelayClient, pcm: Buffer): Promise<void> {
  client.send("speech.start", { atMs: Date.now() });
  for (let offset = 0; offset < pcm.length; offset += AUDIO_BATCH_BYTES) {
    if ((offset / AUDIO_BATCH_BYTES) % 40 === 0) client.send("client.ping");
    client.send("audio.append", {
      atMs: Date.now(),
      audio: pcm.subarray(offset, offset + AUDIO_BATCH_BYTES).toString("base64"),
    });
    if (offset + AUDIO_BATCH_BYTES < pcm.length) await delay(100);
  }
  client.send("speech.end", { atMs: Date.now() });
}

async function stopRelay(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return;
  server.kill("SIGTERM");
  const closed = new Promise<void>(resolve => server.once("close", () => resolve()));
  const forced = delay(2_000).then(() => {
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
  });
  await Promise.race([closed, forced]);
  if (server.exitCode === null && server.signalCode === null) {
    await Promise.race([closed, delay(2_000)]);
  }
}

async function checkRelay(pcm: Buffer, durationSeconds: number): Promise<{
  jaToEn: boolean;
  enToJa: boolean;
  selfDelivery: boolean;
  ackFlow: boolean;
  paddingBytes: number;
}> {
  const server = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--experimental-transform-types", "examples/relay-local/src/server.ts"],
    {
      cwd: new URL("..", import.meta.url),
      env: { PATH: process.env.PATH ?? "", RELAY_MODE: "mock", PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const clients: RelayClient[] = [];
  let serverOutput = "";
  let serverOutputBytes = 0;
  const appendServerOutput = (value: Buffer) => {
    serverOutputBytes += value.length;
    if (serverOutputBytes > 16_384) {
      server.kill("SIGKILL");
      return;
    }
    serverOutput += value.toString("utf8");
  };
  server.stdout.on("data", appendServerOutput);
  server.stderr.on("data", appendServerOutput);
  const childTimeout = setTimeout(() => server.kill("SIGKILL"), (durationSeconds + 20) * 1_000);
  try {
    await waitFor(() => /listening on 127\.0\.0\.1:\d+/u.test(serverOutput), 5_000, "RELAY_START_FAILED");
    const match = /listening on 127\.0\.0\.1:(\d+)/u.exec(serverOutput);
    if (!match) throw new WavReplayError("RELAY_START_FAILED");
    const port = Number(match[1]);
    const host = await connectClient(port, "host-ja", clients);
    const guest = await connectClient(port, "guest-en", clients);
    await waitFor(
      () => clients.every(client => client.events.some(event =>
        event.type === "participant.state"
        && (event.participant as { participantId?: string })?.participantId === client.id
        && (event.participant as { state?: string })?.state === "ready")),
      5_000,
      "RELAY_READY_FAILED",
    );
    host.send("room.start");
    await waitFor(
      () => clients.every(client => client.events.some(event => event.type === "route" && event.canCapture === true)),
      5_000,
      "RELAY_ROUTE_FAILED",
    );

    const { padded, paddingBytes } = padToFrame(pcm);
    await Promise.all([sendPcm(host, padded), sendPcm(guest, padded)]);
    await waitFor(
      () => receivedAudio(guest, host.id).length >= padded.length
        && receivedAudio(host, guest.id).length >= padded.length,
      5_000,
      "RELAY_AUDIO_TIMEOUT",
    );
    const jaToEn = receivedAudio(guest, host.id).equals(padded);
    const enToJa = receivedAudio(host, guest.id).equals(padded);
    const selfDelivery = receivedAudio(host, host.id).length > 0 || receivedAudio(guest, guest.id).length > 0;
    const ackFlow = clients.every(client =>
      client.ws.readyState === WebSocket.OPEN
      && !client.events.some(event => event.type === "error" && event.fatal === true));
    host.send("room.end");
    return { jaToEn, enToJa, selfDelivery, ackFlow, paddingBytes };
  } finally {
    clearTimeout(childTimeout);
    for (const client of clients) client.ws.terminate();
    await stopRelay(server);
  }
}

try {
  const options = parseWavReplayArgs(process.argv.slice(2));
  const loaded = await loadPcm(options);
  const durationSeconds = loaded.convertedSampleCount / PCM_SAMPLE_RATE;
  const provider = await checkProvider(loaded.pcm);
  const relay = await checkRelay(loaded.pcm, durationSeconds);
  assert.equal(provider.exact, true);
  assert.equal(provider.input, true);
  assert.equal(relay.jaToEn, true);
  assert.equal(relay.enToJa, true);
  assert.equal(relay.selfDelivery, false);
  assert.equal(relay.ackFlow, true);
  process.stdout.write(`${JSON.stringify(createSummary({
    loaded,
    durationSeconds,
    providerExactPcmMatch: provider.exact,
    providerInputMatch: provider.input,
    relayJaToEnByteMatch: relay.jaToEn,
    relayEnToJaByteMatch: relay.enToJa,
    relaySelfDelivery: relay.selfDelivery,
    relayAckFlow: relay.ackFlow,
    relayPaddingBytes: relay.paddingBytes,
  }))}\n`);
} catch (error) {
  const code = error instanceof WavReplayError ? error.code : "WAV_REPLAY_FAILED";
  process.stderr.write(`${JSON.stringify({ ok: false, error: code })}\n`);
  process.exitCode = 1;
}
