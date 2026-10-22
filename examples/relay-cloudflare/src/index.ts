import { HttpAuthority } from "../../../packages/authority-http/src/index.ts";
import { OpenAITranslationProvider } from "../../../packages/provider-openai/src/index.ts";
import {
  JoseTicketVerifier,
  RelayOrchestrator,
  type ClientPeer,
  type RelayClock,
  type TicketAlgorithm,
  type TicketClaims,
  type TicketVerifier,
} from "../../../packages/relay-core/src/index.ts";
import { CloudflareProviderTransportFactory } from "./transport.ts";

export interface Env {
  ROOMS: DurableObjectNamespace;
  AUTHORITY_URL: string;
  RELAY_SERVICE_TOKEN: string;
  TICKET_ISSUER: string;
  TICKET_AUDIENCE: string;
  JWKS_URL: string;
  TICKET_ALGORITHM: string;
  OPENAI_API_KEY: string;
}

export function roomObjectName(claims: Pick<TicketClaims, "roomId" | "roomEpoch">): string {
  return JSON.stringify([claims.roomId, claims.roomEpoch]);
}

export function isTranslateUpgrade(request: Request): boolean {
  const url = new URL(request.url);
  return request.method === "GET"
    && url.pathname === "/translate"
    && url.search === ""
    && request.headers.get("upgrade")?.toLowerCase() === "websocket"
    && /^Bearer [^\s]+$/u.test(request.headers.get("authorization") ?? "");
}

function bearer(request: Request): string {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) throw new Error("UNAUTHORIZED");
  return value.slice(7);
}

function verifier(env: Env): JoseTicketVerifier {
  const algorithm = env.TICKET_ALGORITHM;
  if (algorithm !== "EdDSA" && algorithm !== "RS256") throw new Error("INVALID_TICKET_ALGORITHM");
  return new JoseTicketVerifier({
    issuer: env.TICKET_ISSUER,
    audience: env.TICKET_AUDIENCE,
    jwksUrl: env.JWKS_URL,
    algorithms: [algorithm as TicketAlgorithm],
  });
}

let outerVerifier: JoseTicketVerifier | undefined;

export async function routeUpgrade(
  request: Request,
  rooms: Pick<DurableObjectNamespace, "idFromName" | "get">,
  verify: (token: string, nowMs: number) => Promise<TicketClaims>,
  nowMs = Date.now(),
): Promise<Response> {
  if (!isTranslateUpgrade(request)) return new Response("Not found", { status: 404 });
  try {
    const claims = await verify(bearer(request), nowMs);
    const id = rooms.idFromName(roomObjectName(claims));
    return rooms.get(id).fetch(request);
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }
}

export async function verifyRoomObjectClaims(
  token: string,
  verify: (token: string, nowMs: number) => Promise<TicketClaims>,
  idFromName: (name: string) => DurableObjectId,
  currentId: Pick<DurableObjectId, "equals">,
  nowMs = Date.now(),
): Promise<TicketClaims> {
  const claims = await verify(token, nowMs);
  if (!currentId.equals(idFromName(roomObjectName(claims)))) {
    throw new Error("ROOM_OBJECT_MISMATCH");
  }
  return claims;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    outerVerifier ??= verifier(env);
    return routeUpgrade(request, env.ROOMS, (token, nowMs) => outerVerifier!.verify(token, nowMs));
  },
};

class VerifiedTicketBridge implements TicketVerifier {
  private readonly claimsByToken = new Map<string, TicketClaims>();

  allow(token: string, claims: TicketClaims): void {
    this.claimsByToken.set(token, claims);
  }

  async verify(token: string): Promise<TicketClaims> {
    const claims = this.claimsByToken.get(token);
    this.claimsByToken.delete(token);
    if (!claims) throw new Error("UNAUTHORIZED");
    return claims;
  }
}

export class RoomDurableObject {
  private readonly routingVerifier: JoseTicketVerifier;
  private readonly ticketBridge = new VerifiedTicketBridge();
  private relay: RelayOrchestrator | undefined;
  private activeSockets = 0;

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    this.routingVerifier = verifier(env);
  }

  async fetch(request: Request): Promise<Response> {
    if (!isTranslateUpgrade(request)) return new Response("Not found", { status: 404 });
    let claims: TicketClaims;
    const token = bearer(request);
    try {
      claims = await verifyRoomObjectClaims(
        token,
        (value, nowMs) => this.routingVerifier.verify(value, nowMs),
        name => this.env.ROOMS.idFromName(name),
        this.state.id,
      );
    } catch {
      return new Response("Unauthorized", { status: 401 });
    }

    const relay = this.relay ?? this.createRelay();
    this.ticketBridge.allow(token, claims);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    let identity: Awaited<ReturnType<RelayOrchestrator["connect"]>>;
    let closedBeforeAdmission = false;
    let pendingBytes = 0;
    const pending: string[] = [];
    const peer: ClientPeer = {
      send: event => {
        if (server.readyState === WebSocket.OPEN) server.send(JSON.stringify(event));
      },
      close: (code, reason) => server.close(code, reason),
    };
    server.addEventListener("message", event => {
      if (typeof event.data !== "string") {
        server.close(1003, "binary-not-supported");
        return;
      }
      const size = new TextEncoder().encode(event.data).byteLength;
      if (!identity) {
        pendingBytes += size;
        if (pending.length >= 8 || pendingBytes > 65_536) {
          pending.length = 0;
          server.close(1009, "pre-admission-backpressure");
          return;
        }
        pending.push(event.data);
        return;
      }
      void relay.receive(identity.roomId, identity.roomEpoch, identity.participantId, identity.generation, event.data);
    });
    server.addEventListener("close", () => {
      if (!identity) {
        closedBeforeAdmission = true;
        pending.length = 0;
      } else {
        this.state.waitUntil(relay.peerClosed(
          identity.roomId,
          identity.roomEpoch,
          identity.participantId,
          identity.generation,
        ).finally(() => this.releaseSocket(relay)));
      }
    });
    server.addEventListener("error", () => server.close(1011, "socket-error"));
    server.accept();
    this.activeSockets += 1;
    identity = await relay.connect(request.headers.get("authorization") ?? undefined, peer);
    if (!identity) {
      this.releaseSocket(relay);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (closedBeforeAdmission) {
      await relay.peerClosed(identity.roomId, identity.roomEpoch, identity.participantId, identity.generation);
      this.releaseSocket(relay);
    } else {
      for (const message of pending) {
        await relay.receive(identity.roomId, identity.roomEpoch, identity.participantId, identity.generation, message);
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private createRelay(): RelayOrchestrator {
    const clock: RelayClock = {
      now: () => Date.now(),
      setInterval: (handler, ms) => setInterval(handler, ms),
      clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
      setTimeout: (handler, ms) => setTimeout(handler, ms),
      clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    const authority = new HttpAuthority({
      baseURL: this.env.AUTHORITY_URL,
      serviceToken: this.env.RELAY_SERVICE_TOKEN,
    });
    const transport = new CloudflareProviderTransportFactory();
    const relay = new RelayOrchestrator(
      this.ticketBridge,
      authority,
      {
        create: (language, sink) => new OpenAITranslationProvider(
          this.env.OPENAI_API_KEY,
          language,
          transport,
          sink,
        ),
      },
      clock,
    );
    this.relay = relay;
    return relay;
  }

  private releaseSocket(relay: RelayOrchestrator): void {
    this.activeSockets = Math.max(0, this.activeSockets - 1);
    if (this.activeSockets === 0 && this.relay === relay) {
      this.relay = undefined;
      this.state.waitUntil(relay.dispose());
    }
  }
}
