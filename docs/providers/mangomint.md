# Mangomint

Tier-2 (gated). **Stub — not yet implemented.**

Mangomint has no public API documentation. The host `api.mangomint.com` is live, but
auth, endpoints, field names, the status enum, error shapes, and pagination are all
gated behind a sales/support conversation (custom integrations are on the top plan
tier; webhooks are a paid add-on set up via chat support). A correct adapter cannot be
built from public sources without inventing the contract.

The `mangomint` factory exists so it registers and typechecks, but every method throws
`UNSUPPORTED`. Building it out requires obtaining the official API reference (an
OpenAPI spec appears to exist internally) and the webhook signing details.
