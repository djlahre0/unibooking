# Provider access tiers

Not every booking platform exposes a usable CRUD API. Providers fall into three
tiers.

## Tier 1 — self-serve API (shipped)

Sign up for API access yourself and start immediately. `unibooking` ships
adapters for these:

| Provider | Auth | Notes |
| --- | --- | --- |
| Google Calendar | OAuth2 | Plain calendar; no staff/services/availability. |
| Outlook / Microsoft 365 | OAuth2 | Microsoft Graph; scope `Calendars.ReadWrite`. |
| Microsoft Bookings | OAuth2 | Graph; scope `Bookings.ReadWrite.All`. Real staff & services. |
| Square Appointments | OAuth2 | Full-featured: availability, staff, services, customers, idempotency. |
| Acuity Scheduling | HTTP Basic | Calendars ≈ staff; appointment types ≈ services. |
| Bookeo | API key + secret | Products ≈ services. |
| Mindbody | Api-Key + SiteId + user token | Heavier auth; site-local times (see provider doc). No cancel endpoint. |
| Apple / CalDAV | Basic (app password) | iCloud, Fastmail, Nextcloud, … via WebDAV + iCalendar. |
| Calendly | OAuth2 / PAT | Read + cancel always; API booking-create needs a paid plan (Scheduling API, Oct 2025). No reschedule endpoint → `updateBooking` does cancel+rebook. |
| Wix Bookings | OAuth (Wix app) | Headless REST v2: full lifecycle, Time Slots V2, CRM contacts, and webhooks. |

## Tier 2 — gated API (same interface, manual approval)

These use the same adapter pattern but require per-business approval from the vendor
before API access unlocks (often with prerequisites — e.g. Vagaro requires active
Vagaro payment processing first).

| Provider | Status | Notes |
| --- | --- | --- |
| Phorest | Shipped | Full CRUD. Basic auth; `businessId`/`branchId` scoped. |
| Zenoti | Shipped | Full CRUD via multi-step booking flow; `apikey` auth, `centerId` scoped. Book times in the center's local offset (slot matching is wall-clock based; not yet verified against non-UTC live tenants). |
| Vagaro | Shipped (read-only) | Public API is read + webhooks only; writes throw `UNSUPPORTED`. |
| Boulevard | Shipped (no availability) | Enterprise-tier only. GraphQL Admin API with per-request async-HMAC auth (`Basic`). Create/read/reschedule/cancel/list + customers + webhooks. `searchAvailability` throws `UNSUPPORTED` — bookable-time queries live on the Client cart API (different creds). |
| Setmore | Shipped (gated) | Requires Setmore Pro + manual approval (email `api@setmore.com`); no sandbox. Full appointment CRUD, slots, staff, services, customers. Bring your own bearer token. |
| Mangomint | Stub (blocked) | No public API documentation exists. Methods throw `UNSUPPORTED`. |

See [docs/providers/](./providers/) for per-provider setup and caveats.

## Tier 3 — no CRUD API

No public write API exists, so a direct adapter isn't possible:

- Fresha, Booksy, GlossGenius, DaySmart, ProSolutions, **StyleSeat**,
  **MassageBook**, **Squire**.
  - Fresha runs gated partner-only integrations (Reserve with Google, Meta) plus
    a read-only analytics data connector — none give third-party booking CRUD.
  - Squire's `developer.getsquire.com` is access-controlled (403); no public spec.
  - StyleSeat & MassageBook expose only native integrations + embeddable widgets.

**Recommended fallback:** have the business connect their Google Calendar and
sync through the `google` adapter, or use CSV import/export.
