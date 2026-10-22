import type {
  ServerEvent,
  ServerEventPayload,
  WireServerEvent,
} from "../../protocol/src/index.ts";

export const MAX_UNACKNOWLEDGED_DELIVERY_BYTES = 512 * 1_024;
export const MAX_UNACKNOWLEDGED_DELIVERY_EVENTS = 128;

export interface ClientPeer {
  send(event: WireServerEvent): void;
  close(code: number, reason: string): void;
}

interface PendingDelivery {
  deliveryId: number;
  bytes: number;
}

export class BoundedDeliveryPeer {
  private nextDeliveryId = 1;
  private acknowledgedDeliveryId = 0;
  private pendingBytes = 0;
  private readonly pending: PendingDelivery[] = [];
  private closed = false;

  constructor(
    private readonly peer: ClientPeer,
    private readonly onBackpressure: () => void,
  ) {}

  send(event: ServerEventPayload): boolean {
    if (this.closed) return false;
    const deliveryId = this.nextDeliveryId;
    if (!Number.isSafeInteger(deliveryId)) {
      this.failBackpressure();
      return false;
    }
    const wire = { ...event, deliveryId } as ServerEvent;
    const bytes = new TextEncoder().encode(JSON.stringify(wire)).byteLength;
    if (
      bytes > MAX_UNACKNOWLEDGED_DELIVERY_BYTES
      || this.pending.length >= MAX_UNACKNOWLEDGED_DELIVERY_EVENTS
      || this.pendingBytes + bytes > MAX_UNACKNOWLEDGED_DELIVERY_BYTES
    ) {
      this.failBackpressure();
      return false;
    }
    this.nextDeliveryId += 1;
    this.pending.push({ deliveryId, bytes });
    this.pendingBytes += bytes;
    try {
      this.peer.send(wire);
    } catch {
      this.failBackpressure();
      return false;
    }
    return true;
  }

  acknowledge(deliveryId: number): boolean {
    if (this.closed || !Number.isSafeInteger(deliveryId) || deliveryId < 1) return false;
    const highestSent = this.nextDeliveryId - 1;
    if (deliveryId > highestSent) return false;
    if (deliveryId <= this.acknowledgedDeliveryId) return true;
    this.acknowledgedDeliveryId = deliveryId;
    while (this.pending.length > 0 && this.pending[0]!.deliveryId <= deliveryId) {
      this.pendingBytes -= this.pending.shift()!.bytes;
    }
    return true;
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.clearPending();
    try {
      this.peer.close(code, reason);
    } catch {
      // The delivery state is already closed and cleared.
    }
  }

  private failBackpressure(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearPending();
    try {
      this.peer.close(4009, "delivery-backpressure");
    } catch {
      // Cleanup still runs even if the platform close call itself throws.
    }
    this.onBackpressure();
  }

  private clearPending(): void {
    this.pending.length = 0;
    this.pendingBytes = 0;
  }
}
