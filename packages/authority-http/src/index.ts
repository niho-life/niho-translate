import type {
  Authority,
  ControlRoomContext,
  PresenceSyncRequest,
  TicketClaims,
} from "../../relay-core/src/index.ts";

export const AUTHORITY_TIMEOUT_MS = 5_000;
export const AUTHORITY_MAX_RESPONSE_BYTES = 16_384;

export interface HttpAuthorityOptions {
  baseURL: URL | string;
  serviceToken: string;
  fetch?: typeof globalThis.fetch;
}

export class HttpAuthority implements Authority {
  private readonly baseURL: URL;
  private readonly serviceToken: string;
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(options: HttpAuthorityOptions) {
    const baseURL = new URL(options.baseURL);
    if (
      baseURL.protocol !== "https:"
      || baseURL.username !== ""
      || baseURL.password !== ""
      || baseURL.search !== ""
      || baseURL.hash !== ""
      || !options.serviceToken
      || options.serviceToken.length > 8_192
    ) {
      throw new Error("INVALID_AUTHORITY_CONFIG");
    }
    this.baseURL = new URL(baseURL.href.endsWith("/") ? baseURL.href : `${baseURL.href}/`);
    this.serviceToken = options.serviceToken;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  admit(claims: Readonly<TicketClaims>) {
    return this.call("admit", claims) as ReturnType<Authority["admit"]>;
  }

  controlRoom(context: Readonly<ControlRoomContext>) {
    return this.call("rooms/control", context) as ReturnType<Authority["controlRoom"]>;
  }

  syncPresence(value: Readonly<PresenceSyncRequest>) {
    return this.call("rooms/presence", value) as ReturnType<Authority["syncPresence"]>;
  }

  acquireLease(value: Parameters<Authority["acquireLease"]>[0]) {
    return this.call("leases/acquire", value) as ReturnType<Authority["acquireLease"]>;
  }

  renewLease(value: Parameters<Authority["renewLease"]>[0]) {
    return this.call("leases/renew", value) as ReturnType<Authority["renewLease"]>;
  }

  async reportUsage(value: Parameters<Authority["reportUsage"]>[0]): Promise<void> {
    await this.call("usage", value);
  }

  private async call(path: string, body: unknown): Promise<unknown> {
    const url = new URL(path, this.baseURL);
    if (url.origin !== this.baseURL.origin || !url.href.startsWith(this.baseURL.href)) {
      throw new Error("AUTHORITY_ORIGIN_MISMATCH");
    }
    const response = await this.fetchImplementation(url, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${this.serviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AUTHORITY_TIMEOUT_MS),
    });
    if (!response.ok || response.redirected) throw new Error("AUTHORITY_REJECTED");
    const statedLength = response.headers.get("content-length");
    if (statedLength !== null && Number(statedLength) > AUTHORITY_MAX_RESPONSE_BYTES) {
      throw new Error("AUTHORITY_RESPONSE_TOO_LARGE");
    }
    if (!response.body) return undefined;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > AUTHORITY_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("AUTHORITY_RESPONSE_TOO_LARGE");
      }
      chunks.push(item.value);
    }
    if (total === 0) return undefined;
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }
}
