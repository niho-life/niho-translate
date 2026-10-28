import http from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { HttpAuthority } from "../../../packages/authority-http/src/index.ts";
import {
  OpenAITranslationProvider,
  type ProviderSink,
  type ProviderTransport,
  type ProviderTransportFactory,
} from "../../../packages/provider-openai/src/index.ts";
import {
  OpenAILiveTranslationProvider,
  resolveLiveSettings,
} from "../../../packages/provider-openai-live/src/index.ts";
import {
  JoseTicketVerifier,
  MAX_UNACKNOWLEDGED_DELIVERY_BYTES,
  RelayOrchestrator,
  type Authority,
  type BudgetLease,
  type ClientPeer,
  type ControlRoomContext,
  type RelayClock,
  type TicketClaims,
  type TicketVerifier,
  type TranslationFactory,
  type TranslationSession,
} from "../../../packages/relay-core/src/index.ts";
import type { AuthorityRoomState } from "../../../packages/room-core/src/index.ts";

const mode = process.env.RELAY_MODE ?? "mock";
const translateProvider = process.env.TRANSLATE_PROVIDER ?? "translate";
const port = Number(process.env.PORT ?? "8787");
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("INVALID_PORT");

function mockClaims(token: string): TicketClaims {
  const allowed = new Set(["host-ja", "guest-en"]);
  if (!allowed.has(token)) throw new Error("UNAUTHORIZED");
  return {
    roomId: "local-room",
    roomEpoch: "local-epoch",
    participantId: token,
    jti: `${token}-${Date.now()}`,
    expiresAtMs: Date.now() + 10_000,
  };
}

class MockAuthority implements Authority {
  private roomState: AuthorityRoomState = "waiting";
  private readonly grants = new Map<string, string>();
  private readonly generations = new Map<string, number>();
  private readonly consumedJtis = new Set<string>();

  async admit(claims: TicketClaims) {
    if (this.consumedJtis.has(claims.jti)) throw new Error("TICKET_REPLAY");
    this.consumedJtis.add(claims.jti);
    const sourceLanguage = claims.participantId === "guest-en" ? "en" as const : "ja" as const;
    const admissionId = `${claims.participantId}-${claims.jti}`;
    this.grants.set(claims.participantId, admissionId);
    return {
      admissionId,
      role: claims.participantId === "host-ja" ? "host" as const : "guest" as const,
      sourceLanguage,
      targetLanguage: sourceLanguage === "ja" ? "en" as const : "ja" as const,
      roomEpoch: claims.roomEpoch,
      roomState: this.roomState,
    };
  }

  async syncPresence(value: Parameters<Authority["syncPresence"]>[0]) {
    const allowed = value.participants.filter(
      participant => this.grants.get(participant.participantId) === participant.admissionId,
    );
    for (const participant of allowed) {
      this.generations.set(participant.participantId, participant.generation);
    }
    return {
      roomEpoch: value.roomEpoch,
      state: this.roomState,
      allowedAdmissionIds: allowed.map(participant => participant.admissionId),
    };
  }

  async controlRoom(context: ControlRoomContext) {
    this.assertCurrent(context);
    this.roomState = context.action === "start" || context.action === "resume"
      ? "active"
      : context.action === "pause" ? "paused" : "ended";
    return { roomEpoch: context.roomEpoch, state: this.roomState };
  }

  async acquireLease(input: Parameters<Authority["acquireLease"]>[0]): Promise<BudgetLease> {
    this.assertCurrent(input);
    return this.lease();
  }

  async renewLease(input: Parameters<Authority["renewLease"]>[0]): Promise<BudgetLease> {
    this.assertCurrent(input);
    return this.lease();
  }

  async reportUsage(event: Parameters<Authority["reportUsage"]>[0]): Promise<void> {
    this.assertCurrent(event);
  }

  private assertCurrent(value: { participantId: string; admissionId: string; generation: number }): void {
    if (
      this.grants.get(value.participantId) !== value.admissionId
      || this.generations.get(value.participantId) !== value.generation
    ) {
      throw new Error("STALE_ADMISSION");
    }
  }

  private lease(): BudgetLease {
    return {
      leaseId: `mock-${Date.now()}`,
      expiresAtMs: Date.now() + 15_000,
      maxInputAudioMs: 15_000,
    };
  }
}

class MockTranslationSession implements TranslationSession {
  private closed = false;

  constructor(private readonly sink: ProviderSink) {}

  appendPcm(audio: string): boolean {
    if (this.closed) return false;
    this.sink.onInputTranscript("[synthetic input]");
    this.sink.onOutputTranscript("[synthetic translation]");
    this.sink.onOutputAudio(audio);
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class NodeWsFactory implements ProviderTransportFactory {
  connect(url: string, headers: Readonly<Record<string, string>>): ProviderTransport {
    const socket = new WebSocket(url, {
      headers: { Authorization: headers.Authorization! },
      maxPayload: 65_536,
      perMessageDeflate: false,
    });
    return {
      get bufferedAmount() {
        return socket.bufferedAmount;
      },
      ping: payload => socket.ping(payload),
      onPong: handler => socket.on("pong", data => handler(data.toString("utf8"))),
      send: data => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
      onOpen: handler => socket.on("open", handler),
      onMessage: handler => socket.on("message", (data, isBinary) => {
        handler(isBinary ? new Uint8Array(data as Buffer) : (data as Buffer).toString("utf8"));
      }),
      onClose: handler => socket.on("close", handler),
      onError: handler => socket.on("error", handler),
    };
  }
}

function main(): void {
  const clock: RelayClock = {
    now: () => Date.now(),
    setInterval: (handler, ms) => setInterval(handler, ms),
    clearInterval: handle => clearInterval(handle as NodeJS.Timeout),
    setTimeout: (handler, ms) => setTimeout(handler, ms),
    clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
  };
  let tickets: TicketVerifier;
  let authority: Authority;
  let translations: TranslationFactory;
  if (mode === "mock") {
    tickets = { verify: async token => mockClaims(token) };
    authority = new MockAuthority();
    translations = { create: (_language, sink) => new MockTranslationSession(sink) };
  } else if (mode === "real") {
    const required = [
      "AUTHORITY_URL", "RELAY_SERVICE_TOKEN", "TICKET_ISSUER",
      "AUDIENCE", "JWKS_URL", "OPENAI_API_KEY", "TICKET_ALGORITHM",
    ] as const;
    for (const name of required) {
      if (!process.env[name]) throw new Error(`MISSING_${name}`);
    }
    const authorityUrl = new URL(process.env.AUTHORITY_URL!);
    if (authorityUrl.protocol !== "https:") throw new Error("AUTHORITY_HTTPS_REQUIRED");
    const algorithm = process.env.TICKET_ALGORITHM;
    if (algorithm !== "EdDSA" && algorithm !== "RS256") throw new Error("INVALID_TICKET_ALGORITHM");
    tickets = new JoseTicketVerifier({
      issuer: process.env.TICKET_ISSUER!,
      audience: process.env.AUDIENCE!,
      jwksUrl: process.env.JWKS_URL!,
      algorithms: [algorithm],
    });
    authority = new HttpAuthority({
      baseURL: authorityUrl,
      serviceToken: process.env.RELAY_SERVICE_TOKEN!,
    });
    if (translateProvider !== "translate" && translateProvider !== "live") {
      throw new Error("TRANSLATE_PROVIDER_MUST_BE_TRANSLATE_OR_LIVE");
    }
    // Validate GPT-Live settings at startup instead of at the first capture.
    const liveSettings = translateProvider === "live"
      ? resolveLiveSettings({
        preset: process.env.TRANSLATE_LIVE_PRESET,
        voice: process.env.TRANSLATE_LIVE_VOICE,
      })
      : undefined;
    const factory = new NodeWsFactory();
    translations = {
      create: (language, sink) => liveSettings
        ? new OpenAILiveTranslationProvider(
          process.env.OPENAI_API_KEY!,
          language,
          factory,
          sink,
          liveSettings,
        )
        : new OpenAITranslationProvider(
          process.env.OPENAI_API_KEY!,
          language,
          factory,
          sink,
        ),
    };
  } else {
    throw new Error("RELAY_MODE_MUST_BE_MOCK_OR_REAL");
  }

  const relay = new RelayOrchestrator(tickets, authority, translations, clock);
  const server = http.createServer((request, response) => {
    const length = Number(request.headers["content-length"] ?? 0);
    if (length > 0 || request.headers["transfer-encoding"]) {
      response.writeHead(413).end();
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, mode }));
      return;
    }
    response.writeHead(404).end();
  });
  const webSockets = new WebSocketServer({
    server,
    maxPayload: 32_768,
    perMessageDeflate: false,
  });
  webSockets.on("connection", async (socket, request) => {
    socket.on("error", () => socket.terminate());
    type Identity = {
      roomId: string;
      roomEpoch: string;
      participantId: string;
      generation: number;
    };
    let identity: Identity | undefined;
    let closedBeforeAdmission = false;
    let pendingBytes = 0;
    const pendingMessages: Array<string | Uint8Array> = [];
    const peer: ClientPeer = {
      send: event => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const wire = JSON.stringify(event);
        if (socket.bufferedAmount + Buffer.byteLength(wire) > MAX_UNACKNOWLEDGED_DELIVERY_BYTES) {
          socket.close(4009, "socket-backpressure");
          return;
        }
        socket.send(wire);
      },
      close: (code, reason) => socket.close(code, reason),
    };
    socket.on("message", (data: RawData, isBinary: boolean) => {
      const value = isBinary ? new Uint8Array(data as Buffer) : data.toString();
      if (!identity) {
        pendingBytes += typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
        if (pendingMessages.length >= 8 || pendingBytes > 65_536) {
          pendingMessages.length = 0;
          socket.close(1009, "pre-admission-backpressure");
          return;
        }
        pendingMessages.push(value);
        return;
      }
      void relay.receive(
        identity.roomId,
        identity.roomEpoch,
        identity.participantId,
        identity.generation,
        value,
      );
    });
    socket.on("close", () => {
      if (!identity) {
        closedBeforeAdmission = true;
        pendingMessages.length = 0;
        return;
      }
      void relay.peerClosed(
        identity.roomId,
        identity.roomEpoch,
        identity.participantId,
        identity.generation,
      );
    });
    identity = await relay.connect(request.headers.authorization, peer);
    if (!identity) return;
    if (closedBeforeAdmission) {
      await relay.peerClosed(
        identity.roomId,
        identity.roomEpoch,
        identity.participantId,
        identity.generation,
      );
      return;
    }
    for (const message of pendingMessages) {
      await relay.receive(
        identity.roomId,
        identity.roomEpoch,
        identity.participantId,
        identity.generation,
        message,
      );
    }
    pendingMessages.length = 0;
  });
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const listeningPort = typeof address === "object" && address ? address.port : port;
    const label = mode === "real" ? `${mode}, ${translateProvider}` : mode;
    process.stdout.write(`relay-local listening on 127.0.0.1:${listeningPort} (${label})\n`);
  });
  const shutdown = () => {
    void relay.dispose().finally(() => server.close());
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
