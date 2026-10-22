import {
  type ProviderTransport,
  type ProviderTransportFactory,
} from "../../../packages/provider-openai/src/index.ts";

const MAX_INCOMING_BYTES = 65_536;

export class CloudflareProviderTransportFactory implements ProviderTransportFactory {
  constructor(private readonly fetchImplementation: typeof fetch = fetch) {}

  connect(url: string, headers: Readonly<Record<string, string>>): ProviderTransport {
    return new CloudflareProviderTransport(url, headers, this.fetchImplementation);
  }
}

class CloudflareProviderTransport implements ProviderTransport {
  private socket?: WebSocket;
  private openHandler?: () => void;
  private messageHandler?: (data: string | Uint8Array) => void;
  private closeHandler?: () => void;
  private errorHandler?: () => void;
  private opened = false;
  private finished = false;
  private failed = false;
  private pendingMessages: string[] = [];
  private pendingBytes = 0;

  constructor(
    url: string,
    headers: Readonly<Record<string, string>>,
    fetchImplementation: typeof fetch,
  ) {
    void this.open(url, headers, fetchImplementation);
  }

  get bufferedAmount(): undefined {
    return undefined;
  }

  send(data: string): void {
    if (!this.socket || !this.opened || this.finished) throw new Error("PROVIDER_NOT_OPEN");
    this.socket.send(data);
  }

  close(code?: number, reason?: string): void {
    if (this.finished) return;
    this.finished = true;
    this.socket?.close(code, reason);
    this.closeHandler?.();
  }

  onOpen(handler: () => void): void {
    this.openHandler = handler;
    if (this.opened && !this.finished) handler();
  }

  onMessage(handler: (data: string | Uint8Array) => void): void {
    this.messageHandler = handler;
    for (const value of this.pendingMessages) handler(value);
    this.pendingMessages = [];
    this.pendingBytes = 0;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
    if (this.finished) handler();
  }

  onError(handler: () => void): void {
    this.errorHandler = handler;
    if (this.finished && this.failed) handler();
  }

  private async open(
    urlValue: string,
    headers: Readonly<Record<string, string>>,
    fetchImplementation: typeof fetch,
  ): Promise<void> {
    try {
      const url = new URL(urlValue);
      if (url.protocol !== "wss:") throw new Error("PROVIDER_WSS_REQUIRED");
      url.protocol = "https:";
      const response = await fetchImplementation(url, {
        method: "GET",
        redirect: "error",
        headers: {
          authorization: headers.Authorization ?? "",
          upgrade: "websocket",
        },
      });
      if (response.redirected || response.status !== 101 || !response.webSocket) {
        throw new Error("PROVIDER_UPGRADE_FAILED");
      }
      const socket = response.webSocket;
      this.socket = socket;
      socket.addEventListener("message", event => this.receive(event.data));
      socket.addEventListener("close", () => this.finish(false));
      socket.addEventListener("error", () => this.finish(true));
      socket.accept();
      if (this.finished) {
        socket.close(1000, "closed-before-open");
        return;
      }
      this.opened = true;
      this.openHandler?.();
    } catch {
      this.finish(true);
    }
  }

  private receive(data: unknown): void {
    if (this.finished) return;
    if (typeof data !== "string" || new TextEncoder().encode(data).byteLength > MAX_INCOMING_BYTES) {
      this.socket?.close(1009, "invalid-provider-message");
      this.finish(true);
      return;
    }
    if (this.messageHandler) {
      this.messageHandler(data);
      return;
    }
    const bytes = new TextEncoder().encode(data).byteLength;
    this.pendingBytes += bytes;
    if (this.pendingBytes > MAX_INCOMING_BYTES) {
      this.socket?.close(1009, "provider-prehandler-backpressure");
      this.finish(true);
      return;
    }
    this.pendingMessages.push(data);
  }

  private finish(error: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.failed = error;
    this.opened = false;
    this.pendingMessages = [];
    this.pendingBytes = 0;
    if (error) this.errorHandler?.();
    this.closeHandler?.();
  }
}
