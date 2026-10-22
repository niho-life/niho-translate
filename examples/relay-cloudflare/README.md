# Cloudflare Durable Object relay example

This source-only example routes exactly `GET /translate` WebSocket upgrades to one
Durable Object per verified `[roomId, roomEpoch]`. The outer Worker and the Durable
Object independently verify the Authorization bearer JWT; the Durable Object also
checks that its own ID equals the ID derived from those verified claims. Ticket query
parameters, redirects, request bodies, and permissive CORS are not supported.

Copy `wrangler.toml.example` to a deployment-owned configuration and provision the
two named secrets. No deploy script is included. `npm exec tsc -- -p
examples/relay-cloudflare/tsconfig.json` performs the isolated source check.

The Durable Object keeps the room actor and sockets only in memory. Audio and captions
are never written to Durable Object storage. Private Authority remains the source of
truth for admission grants, presence/lifecycle, and budget leases. While any client or
provider WebSocket is active, this intentionally uses a non-hibernating Durable Object
and therefore remains billable. Relay disposal clears its interval; no alarm persists
media.
