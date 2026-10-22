import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export const MAX_TICKET_LIFETIME_MS = 60_000;
const MAX_JTI_ROOMS = 1_024;
const MAX_JTIS_PER_ROOM = 256;

export interface TicketClaims {
  roomId: string;
  participantId: string;
  roomEpoch: string;
  jti: string;
  expiresAtMs: number;
}

export interface TicketVerifier {
  verify(token: string, nowMs: number): Promise<TicketClaims>;
}

export type TicketAlgorithm = "EdDSA" | "RS256";

export interface TicketVerifierConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
  algorithms: readonly TicketAlgorithm[];
  getKey?: JWTVerifyGetKey;
}

export class JoseTicketVerifier implements TicketVerifier {
  private readonly getKey: JWTVerifyGetKey;
  private readonly seenByRoom = new Map<string, Map<string, number>>();

  constructor(private readonly config: TicketVerifierConfig) {
    if (!config.issuer || !config.audience || !config.jwksUrl) {
      throw new Error("TICKET_CONFIG_REQUIRED");
    }
    if (
      config.algorithms.length < 1
      || config.algorithms.some(algorithm => algorithm !== "EdDSA" && algorithm !== "RS256")
    ) {
      throw new Error("TICKET_ALGORITHM_REQUIRED");
    }
    const url = new URL(config.jwksUrl);
    if (url.protocol !== "https:") throw new Error("JWKS_HTTPS_REQUIRED");
    this.getKey = config.getKey ?? createRemoteJWKSet(url);
  }

  async verify(token: string, nowMs: number): Promise<TicketClaims> {
    if (!token || token.length > 8_192) throw new Error("UNAUTHORIZED");
    const { payload } = await jwtVerify(token, this.getKey, {
      issuer: this.config.issuer,
      audience: this.config.audience,
      algorithms: [...this.config.algorithms],
      currentDate: new Date(nowMs),
      requiredClaims: ["exp", "nbf", "jti", "roomId", "participantId", "roomEpoch"],
    });
    const { roomId, participantId, roomEpoch, jti, exp } = payload;
    if (
      ![roomId, participantId, roomEpoch, jti].every(validIdentifier)
      || typeof exp !== "number"
      || !Number.isSafeInteger(exp)
    ) {
      throw new Error("UNAUTHORIZED");
    }
    const expiresAtMs = exp * 1_000;
    if (expiresAtMs <= nowMs || expiresAtMs > nowMs + MAX_TICKET_LIFETIME_MS) {
      throw new Error("UNAUTHORIZED");
    }
    this.pruneSeen(nowMs);
    let seen = this.seenByRoom.get(roomId as string);
    if (!seen) {
      if (this.seenByRoom.size >= MAX_JTI_ROOMS) throw new Error("TICKET_REPLAY_CACHE_FULL");
      seen = new Map();
      this.seenByRoom.set(roomId as string, seen);
    }
    if (seen.has(jti as string)) throw new Error("TICKET_REPLAY");
    if (seen.size >= MAX_JTIS_PER_ROOM) throw new Error("TICKET_REPLAY_CACHE_FULL");
    seen.set(jti as string, expiresAtMs);
    return {
      roomId: roomId as string,
      participantId: participantId as string,
      roomEpoch: roomEpoch as string,
      jti: jti as string,
      expiresAtMs,
    };
  }

  private pruneSeen(nowMs: number): void {
    for (const [roomId, seen] of this.seenByRoom) {
      for (const [jti, expiry] of seen) {
        if (expiry <= nowMs) seen.delete(jti);
      }
      if (seen.size === 0) this.seenByRoom.delete(roomId);
    }
  }
}

function validIdentifier(value: unknown): boolean {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && !/[\u0000-\u001f]/u.test(value);
}
