<div align="center">

# 🚀 unibooking

### One API for Every Booking Provider

**Build booking, appointment, scheduling, reservation, and calendar integrations using one strongly typed TypeScript API.**

No more provider-specific business logic.

Google Calendar • Outlook • Microsoft Bookings • Square • Calendly • Wix • Acuity • Bookeo • Mindbody • Setmore • Vagaro • Phorest • Zenoti • Boulevard • Apple CalDAV

<sub>MangoMint is scaffolded and planned — see [Supported Providers](#supported-providers).</sub>

<br/>

[![npm version](https://img.shields.io/npm/v/unibooking.svg)](https://www.npmjs.com/package/unibooking)
[![npm downloads](https://img.shields.io/npm/dw/unibooking)](https://www.npmjs.com/package/unibooking)
[![License](https://img.shields.io/npm/l/unibooking)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-20+-green)](https://nodejs.org/)

🌐 **Documentation:** https://unibooking.vercel.app

📦 **npm:** https://www.npmjs.com/package/unibooking

⭐ **If this project saves you time, please consider giving it a GitHub Star.**

</div>

---

<details>
<summary><strong>Table of Contents</strong></summary>

- [Stop Writing Booking Logic Twice](#stop-writing-booking-logic-twice)
- [Why Developers Use unibooking](#why-developers-use-unibooking)
- [Designed For](#designed-for)
- [Features](#features)
- [Installation](#installation)
- [30-Second Example](#30-second-example)
- [Architecture](#architecture)
- [Documentation](#documentation)
- [Complete Booking Lifecycle](#complete-booking-lifecycle)
  - [Create a Client](#create-a-client)
  - [Provider Capabilities](#provider-capabilities)
  - [Search Availability](#search-availability)
  - [Create or Find Customer](#create-or-find-customer)
  - [Create a Booking](#create-a-booking)
  - [Read a Booking](#read-a-booking)
  - [Update a Booking](#update-a-booking)
  - [Cancel a Booking](#cancel-a-booking)
  - [List Bookings](#list-bookings)
  - [Automatic Pagination](#automatic-pagination)
  - [Automatic Retry](#automatic-retry)
  - [Dynamic Provider Selection](#dynamic-provider-selection)
- [Booking Model](#booking-model)
- [Time Handling](#time-handling)
- [Supported Providers](#supported-providers)
- [Unified Error Handling](#unified-error-handling)
- [Webhooks](#webhooks)
- [Security](#security)
- [Runtime Support](#runtime-support)
- [Bundle Size](#bundle-size)
- [Framework Support](#framework-support)
- [Frequently Asked Questions](#frequently-asked-questions)
- [Why Not Use the Provider SDK Directly?](#why-not-use-the-provider-sdk-directly)
- [Philosophy](#philosophy)
- [Contributing](#contributing)
- [Development](#development)
- [Project Structure](#project-structure)
- [Adapter Architecture](#adapter-architecture)
- [Writing Your Own Adapter](#writing-your-own-adapter)
- [Testing](#testing)
- [Versioning](#versioning)
- [Browser Support](#browser-support)
- [Performance Philosophy](#performance-philosophy)
- [Roadmap](#roadmap)
- [Community](#community)
- [Support the Project](#support-the-project)
- [License](#license)

</details>

---

# Stop Writing Booking Logic Twice

Every booking provider exposes a completely different API.

| Google Calendar | Square | Outlook | Calendly | Wix |
|----------------|---------|----------|-----------|-----|
| Events API | Bookings API | Graph API | Scheduled Events | Booking Services |

That means...

- Different authentication
- Different request payloads
- Different pagination
- Different error models
- Different availability APIs
- Different customer objects
- Different webhook signatures
- Different retry strategies

Supporting multiple providers often means maintaining **thousands of lines of duplicate code**.

## unibooking changes that.

Write your business logic once.

Switch providers without rewriting your application.

---

# Why Developers Use unibooking

Instead of learning fifteen APIs...

```ts
google.events.insert(...)

square.bookings.create(...)

graph.calendar.events.post(...)

calendly...

acuity...

wix...
```

You write

```ts
client.createBooking(...)
```

That's it.

The adapter handles the provider.

---

# Designed For

✅ SaaS Platforms

✅ Healthcare

✅ Salons

✅ Hotels

✅ Universities

✅ Gym Management

✅ Internal Scheduling

✅ Enterprise Booking

✅ Marketplace Platforms

---

# Features

## One API

One interface for every supported provider.

No vendor lock-in.

---

## Strongly Typed

Full TypeScript support.

Autocomplete.

Compile-time safety.

No stringly-typed APIs.

---

## Stateless

Credentials are never stored.

Pass either

```ts
credentials
```

or

```ts
() => refreshToken()
```

Every request gets fresh credentials.

Perfect for OAuth refresh.

---

## Unified Booking Model

Every provider maps into one canonical booking object.

No more provider-specific models throughout your application.

---

## Capability Detection

Every provider exposes different capabilities.

Instead of runtime surprises...

```ts
client.capabilities
```

tells you exactly what is supported.

---

## Unified Error Model

Never parse provider-specific error messages again.

Instead...

```ts
switch(error.code){

case "NOT_FOUND":

case "CONFLICT":

case "AUTH":

case "RATE_LIMIT":

}
```

works across every provider.

---

## Zero Runtime Dependencies

No axios.

No lodash.

No moment.

Uses only modern platform APIs.

- fetch
- AbortController
- Web Crypto

Runs on

- Node.js
- Bun
- Deno
- Cloudflare Workers
- Vercel Edge
- Fastly Compute

---

## Tree Shakeable

Import only the adapters you use.

```ts
import { square } from "unibooking/adapters/square";
```

No unnecessary providers in your bundle.

---

# Installation

```bash
npm install unibooking
```

or

```bash
pnpm add unibooking
```

or

```bash
yarn add unibooking
```

---

# 30-Second Example

```ts
import { square } from "unibooking/adapters/square";

const client = square(() => ({
    accessToken: process.env.SQUARE_TOKEN!,
    locationId: process.env.SQUARE_LOCATION!,
}));

const booking = await client.createBooking({
    title: "Haircut",
    range: {
        start: "2026-07-20T09:00:00-07:00",
        end: "2026-07-20T09:45:00-07:00",
    },
});

console.log(booking.id);
```

Now replace

```ts
square(...)
```

with

```ts
google(...)
```

or

```ts
outlook(...)
```

or

```ts
calendly(...)
```

Everything else stays exactly the same.

---

# Architecture

```text
                 Your Application

                        │

                        ▼

              BookingClient Interface

                        │

                 unibooking Core

                        │

        ┌───────────────┼────────────────┐

        ▼               ▼                ▼

     Google         Square          Outlook

        ▼               ▼                ▼

   Provider APIs  Provider APIs   Provider APIs
```

The adapter is the only thing that changes.

Your business logic never does.

---

# Documentation

📖 https://unibooking.vercel.app

Includes

- Getting Started

- Authentication

- Providers

- Examples

- Cookbook

- API Reference

- Webhooks

- FAQ

- Migration Guides

---

# Complete Booking Lifecycle

Every adapter implements the same `BookingClient` interface, so switching
providers requires changing only the adapter—not your application logic.

The typical booking flow looks like this:

```text
Customer
    │
    ▼
Find Available Slots
    │
    ▼
Create / Find Customer
    │
    ▼
Create Booking
    │
    ▼
Read Booking
    │
    ▼
Update Booking
    │
    ▼
List Bookings
    │
    ▼
Cancel Booking
```

---

# Create a Client

Choose the provider you want to connect to.

```ts
import { square } from "unibooking/adapters/square";

const client = square(() => ({
    accessToken: process.env.SQUARE_TOKEN!,
    locationId: process.env.SQUARE_LOCATION!,
}));
```

Credentials can be either

```ts
{
    accessToken: "...",
}
```

or

```ts
() => refreshCredentials()
```

The credential function is executed for every request, making OAuth refresh
flows simple and preventing stale tokens from being stored.

---

# Provider Capabilities

Not every booking platform supports every feature.

Instead of guessing...

```ts
console.log(client.capabilities);
```

Example

```ts
{
    availability: true,
    staff: true,
    services: true,
    customers: true,
    webhooks: true,
    idempotency: true,
}
```

No more trial-and-error.

Your application knows exactly what the provider supports.

---

# Search Availability

Find bookable time slots.

```ts
const slots = await client.searchAvailability({
    range: {
        start: "2026-07-20T00:00:00-07:00",
        end: "2026-07-21T00:00:00-07:00",
    },
    serviceId,
});
```

Result

```ts
[
    {
        start: "...",
        end: "...",
        staffId: "...",
    }
]
```

---

# Create or Find Customer

Providers that support customer management expose an optional customer API.

```ts
const customerId = await client.customers?.findOrCreate({
    name: "Jane Doe",
    email: "jane@example.com",
});
```

This keeps your application provider-agnostic while avoiding duplicate customer
records.

---

# Create a Booking

```ts
const booking = await client.createBooking({
    title: "Haircut",

    serviceId,

    customer: {
        id: customerId,
    },

    range: {
        start: slot.start,
        end: slot.end,
    },

    idempotencyKey: crypto.randomUUID(),
});
```

The returned object is the unified `Booking` model regardless of provider.

```ts
console.log(booking.id);
console.log(booking.status);
console.log(booking.range.start);
```

---

# Read a Booking

```ts
const booking = await client.getBooking(id);
```

No provider-specific mapping required.

---

# Update a Booking

```ts
await client.updateBooking(id, {
    title: "VIP Appointment",

    range: {
        start: "...",
        end: "...",
    },
});
```

Changing

- time
- staff
- service
- title

uses the same API across supported providers.

---

# Cancel a Booking

```ts
await client.cancelBooking(id, {
    reason: "Client requested cancellation",
    notify: true,
});
```

Provider-specific options are automatically applied where supported.

---

# List Bookings

Retrieve bookings within a date range.

```ts
const page = await client.listBookings({
    range: {
        start: "...",
        end: "...",
    },
});
```

Response

```ts
page.bookings

page.nextPageToken
```

---

# Automatic Pagination

Most providers paginate results differently.

Instead of writing pagination logic...

```ts
import { listAll } from "unibooking";

for await (const booking of listAll(client, {
    range,
})) {

    console.log(booking.id);

}
```

Works identically across providers.

Need everything as an array?

```ts
import { collectAll } from "unibooking";

const bookings = await collectAll(client, {
    range,
});
```

---

# Automatic Retry

Network failures happen.

```ts
import { withRetry } from "unibooking";

const resilient = withRetry(client, {
    retries: 3,
});
```

Features

- Exponential backoff
- Retry-After support
- Network retry
- Rate-limit retry
- Safe idempotent retries

`createBooking()` is never retried automatically unless an
`idempotencyKey` is provided.

This prevents accidental duplicate bookings.

---

# Dynamic Provider Selection

Applications often need to connect to multiple booking providers.

Instead of writing switch statements...

```ts
import { createRegistry } from "unibooking";

import { google } from "unibooking/adapters/google";
import { square } from "unibooking/adapters/square";
import { outlook } from "unibooking/adapters/outlook";

const registry = createRegistry([
    google,
    square,
    outlook,
]);
```

Later...

```ts
const client = registry.get(
    account.provider
)(
    account.credentials
);
```

Your application never imports providers dynamically.

The registry remains fully tree-shakeable.

---

# Booking Model

Every provider maps into one canonical booking model.

```ts
interface Booking {

    id: string;

    provider: ProviderId;

    title: string;

    status: BookingStatus;

    range: TimeRange;

    customer?: Customer;

    staffId?: string;

    serviceId?: string;

    createdAt?: string;

    updatedAt?: string;

    raw: unknown;

}
```

The `raw` field always contains the original provider response for advanced
use cases.

You get the best of both worlds:

- A consistent API
- Full access to provider-specific data

---

# Time Handling

All timestamps use **RFC3339** with timezone offsets.

```text
2026-07-20T10:30:00-07:00
```

This guarantees unambiguous instants across every provider.

Display timezones are represented separately using IANA timezone names.

Example

```text
America/New_York

Europe/London

Asia/Kolkata
```

---

# Supported Providers

unibooking currently supports the following providers.

| Provider | Read | Create | Update | Cancel | Availability | Customers | Staff | Services | Webhooks |
|-----------|:---:|:------:|:------:|:------:|:------------:|:---------:|:-----:|:--------:|:---------:|
| [Google Calendar](https://developers.google.com/workspace/calendar/api/guides/overview) | ✅ | ✅ | ✅ | ✅ | ⚠️ | — | — | — | ✅ |
| [Outlook / Microsoft 365](https://learn.microsoft.com/en-us/graph/api/resources/event?view=graph-rest-1.0) | ✅ | ✅ | ✅ | ✅ | ⚠️ | — | — | — | ✅ |
| [Microsoft Bookings](https://learn.microsoft.com/en-us/graph/api/resources/booking-api-overview?view=graph-rest-1.0) | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | — |
| [Square](https://developer.squareup.com/reference/square/bookings-api) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| [Calendly](https://developer.calendly.com/api-docs) | ✅ | ⚠️ | ⚠️ | ✅ | ✅ | — | — | ✅ | ✅ |
| [Wix Bookings](https://dev.wix.com/docs/rest/business-solutions/bookings/bookings/about-the-bookings-apis) | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| [Acuity](https://developers.acuityscheduling.com/reference/quick-start) | ✅ | ✅ | ⚠️ | ✅ | ✅ | — | ✅ | ✅ | ✅ |
| [Bookeo](https://www.bookeo.com/api/) | ✅ | ✅ | ⚠️ | ✅ | ✅ | — | — | ✅ | ✅ |
| [Mindbody](https://api.mindbodyonline.com/public/v6/swagger/index) | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ |
| [Setmore](https://setmore.docs.apiary.io/) | — | ✅ | ⚠️ | — | ✅ | ✅ | ✅ | ✅ | — |
| [Vagaro](https://docs.vagaro.com/public/reference/api-introduction) | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ |
| [Phorest](https://developer.phorest.com/docs/getting-started) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| [Zenoti](https://docs.zenoti.com/reference) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| [Apple CalDAV](https://www.rfc-editor.org/rfc/rfc4791.html) | ✅ | ✅ | ✅ | ✅ | — | — | — | — | — |
| [Boulevard](https://developers.joinblvd.com/2020-01/admin-api/overview) | ✅ | ✅ | ⚠️ | ✅ | — | ✅ | ✅ | ✅ | ✅ |
| MangoMint | 🚧 Planned | 🚧 Planned | 🚧 Planned | 🚧 Planned | 🚧 Planned | 🚧 Planned | 🚧 Planned | 🚧 Planned | 🚧 Planned |

> **Note**
>
> **Platform limitations** — the provider itself does not offer this, so no
> adapter can:
>
> - Calendly has no reschedule endpoint; rescheduling is cancel + recreate.
> - Wix updates support reschedule or cancel, not arbitrary field edits. Its
>   extended-bookings query also exposes no staff/resource filter, so
>   `listBookings({ staffId })` throws `UNSUPPORTED` rather than silently
>   returning unfiltered results — filter client-side instead.
> - Boulevard availability requires the separate Client cart API, and its
>   `UpdateAppointmentInput` accepts only notes, state and custom fields — staff
>   and service changes are not expressible. Rescheduling is supported natively.
> - Setmore has **no** fetch-by-id and **no** cancel/delete endpoint — its entire
>   API is 11 routes, and the only mutation on an existing appointment is a label
>   change. Read bookings via `listBookings` over a date range.
> - Vagaro has no date-range list; `listBookings` requires a `customerId`.
> - Mindbody has no cancel *path* — cancellation is an action on the update
>   endpoint, which `cancelBooking` handles for you.
> - Square and Acuity booking `status` is read-only, and Microsoft Bookings has
>   no status field at all; `updateBooking({ status })` throws on all three, so
>   use `cancelBooking()` rather than a status write. Acuity also cannot change
>   an appointment type, and can only reassign staff as part of a reschedule.
> - Square's availability search window must be at least 24 hours and at most 31
>   days; its list window is also capped at 31 days.
> - Acuity has no list cursor — `max` only caps the count (default 100), so
>   narrow the range or raise `limit` on a busy calendar.
> - Apple/CalDAV deletes a whole resource, so cancelling a recurring booking
>   removes the entire series. Expanded occurrences share one id — tell them
>   apart via `RECURRENCE-ID` in `raw`.
> - Google and Outlook are plain calendars with no native slot search, so
>   `searchAvailability` derives free slots from their free/busy APIs
>   (`freeBusy` / `getSchedule`). It requires a positive `durationMinutes` to
>   size each slot, and Outlook additionally needs the mailbox address in
>   `providerOptions.schedules` (or a UPN-form `userId`) — `getSchedule` cannot
>   resolve the `me` alias.
> - Zenoti availability is single-day and needs `providerOptions.guestId` plus a
>   `durationMinutes`; a multi-day range throws. Each query creates a transient
>   upstream booking, so fanning out per day would litter throwaway bookings.
>   `listBookings` has no cursor — a `pageToken` throws rather than being ignored.
> - Availability ranges are capped where the provider is single-date and the
>   adapter fans out one request per day: Vagaro 31 days, Setmore 62, Acuity 31.
>   Beyond the cap you get an error rather than a silently truncated slot list.
> - Bookeo needs `providerOptions.participants` (with a `peopleCategoryId`) on
>   create, and Phorest needs a `staffId` — both are required by their specs and
>   cannot be defaulted. Bookeo updates reschedule only; its PUT is not a
>   documented partial-update contract, so title/staff/product edits throw
>   rather than risk a partial body clearing fields.
>
> **Permission caveats:**
>
> - Microsoft Bookings availability uses `getStaffAvailability`, which Graph
>   documents as **application-permission only** — a delegated user token works
>   for every other call on that adapter but not this one.
>
> **Adapter gaps** — the provider supports this, but unibooking does not model it
> yet:
>
> - Customer / staff / service *enumeration* on Vagaro, Boulevard and Setmore
>   (bookings still accept `staffId` and `serviceId`).
> - Bookeo fixed-product booking by `eventId` (pass it via `providerOptions`).
>
> **Credential requirements worth knowing before you start:** Vagaro needs a
> `businessId` and account `region`; Boulevard needs a `locationId`; Mindbody
> needs the site `timezone` for correct instants; Setmore availability needs an
> IANA `range.timezone`.
>
> Provider names in the table link to the official API documentation. MangoMint
> is unlinked because it publishes no public API reference — integration is
> arranged directly with their support team.
>
> **Verification status.** Every adapter is checked against its provider's
> current published specification — an OpenAPI/Swagger document, a GraphQL
> schema, or an official reference page. **No adapter is verified against a live
> tenant.** Several providers gate API access behind sales or manual approval,
> and the rest were not exercised end-to-end either.
>
> What the tests actually cover: the shared conformance suite asserts the
> canonical contract (offset-bearing instants, `end > start`, the status enum,
> error-code mapping) against mocked HTTP matched on request path and method.
> Individual adapter tests additionally assert request bodies and headers where
> a specific wire detail matters, but that is per-case, not blanket coverage.
> Because the mocks are authored alongside the adapter, they cannot catch a
> wrong endpoint or a misread response field — only a spec diff can, which is
> what the audits in [CHANGELOG.md](CHANGELOG.md) do.
>
> If you hit a discrepancy against a live tenant, please open an issue — that is
> exactly the gap this project cannot close on its own.

---

# Unified Error Handling

Every provider returns different errors.

Instead of this...

```ts
if (error.message.includes("RESOURCE_NOT_FOUND")) { }

if (error.errorCode === 4043) { }

if (error.status === 404) { }
```

Use one consistent model.

```ts
try {

    await client.getBooking(id);

}
catch (error) {

    if (
        isUnibookingError(error)
        &&
        error.code === "NOT_FOUND"
    ) {

        console.log("Booking not found");

    }

}
```

Supported error codes

| Code | Meaning |
|------|---------|
| AUTH | Authentication failed |
| FORBIDDEN | Permission denied |
| INVALID_INPUT | Invalid request |
| NOT_FOUND | Resource does not exist |
| CONFLICT | Booking conflict |
| RATE_LIMIT | Too many requests |
| NETWORK | Network failure |
| TIMEOUT | Request timed out |
| UNSUPPORTED | Provider limitation |
| UPSTREAM | Provider returned an unexpected error |

Every error may also contain

```ts
error.httpStatus

error.providerCode

error.retryAfterMs

error.requestId
```

No provider-specific parsing required.

---

# Webhooks

Most booking platforms send webhook events.

Every provider signs requests differently.

unibooking provides verification helpers so you don't have to implement them yourself.

Each verifier lives at its own subpath, so you only bundle what you use.

```ts
import { verifySquareSignature } from "unibooking/webhooks/square";
import { verifyCalendlySignature } from "unibooking/webhooks/calendly";
import { verifyAcuitySignature } from "unibooking/webhooks/acuity";
import { verifyBookeoSignature } from "unibooking/webhooks/bookeo";
import { verifyBoulevardSignature } from "unibooking/webhooks/boulevard";
import { verifyMindbodySignature } from "unibooking/webhooks/mindbody";
import { verifyWixWebhook } from "unibooking/webhooks/wix";
import { verifyGoogleChannelToken } from "unibooking/webhooks/google";
import { verifyVagaroToken } from "unibooking/webhooks/vagaro";
import {
    graphValidationToken,
    verifyGraphClientState,
} from "unibooking/webhooks/outlook";
```

| Provider | Helper | Async | Returns |
|-----------|---------|:-----:|---------|
| Square | `verifySquareSignature` | ✅ | `boolean` |
| Calendly | `verifyCalendlySignature` | ✅ | `boolean` |
| Acuity | `verifyAcuitySignature` | ✅ | `boolean` |
| Bookeo | `verifyBookeoSignature` | ✅ | `boolean` |
| Boulevard | `verifyBoulevardSignature` | ✅ | `boolean` |
| Mindbody | `verifyMindbodySignature` | ✅ | `boolean` |
| Wix | `verifyWixWebhook` | ✅ | decoded payload, or `null` |
| Google Calendar | `verifyGoogleChannelToken` | — | `boolean` |
| Outlook | `verifyGraphClientState` | — | `boolean` |
| Vagaro | `verifyVagaroToken` | — | `boolean` |

Calendly and Bookeo also accept an optional `toleranceMs` (plus an injectable
`now`) to reject replayed deliveries, as both vendors recommend.

Microsoft Bookings has no webhook helper because Graph v1.0 does not support
change-notification subscriptions on Bookings resources.

Your application hosts the endpoint.

unibooking only verifies authenticity.

Example

```ts
import { verifySquareSignature } from "unibooking/webhooks/square";

// The exact raw body — never a parsed-and-re-serialized object.
const body = await request.text();

const ok = await verifySquareSignature({
    signatureKey: process.env.SQUARE_WEBHOOK_KEY!,
    notificationUrl: "https://example.com/webhooks/square",
    body,
    signature: request.headers.get("x-square-hmacsha256-signature") ?? "",
});

if (!ok) {

    return new Response("Unauthorized", {
        status: 401,
    });

}
```

> **Note**
>
> Most verifiers are `async` — always `await` them. Writing
> `if (!verifySquareSignature(...))` negates a Promise, which is always truthy,
> so every request would be accepted as authentic.
>
> Always pass the **exact raw body**. A re-serialized object will not match
> the signature.
>
> Microsoft Graph subscriptions also require a one-time handshake: echo
> `graphValidationToken(url.searchParams)` back as `text/plain` with status 200.
>
> Vagaro does not HMAC-sign payloads — `verifyVagaroToken` is a constant-time
> comparison against a static shared token, not a signature check.

---

# Security

unibooking never stores credentials.

Authentication is always provided by your application.

Supported approaches

✅ OAuth

✅ Refresh tokens

✅ API Keys

✅ Service Accounts

✅ Personal Access Tokens

Credentials can be supplied as

```ts
credentials
```

or

```ts
() => refreshCredentials()
```

allowing automatic token refresh before every request.

---

# Runtime Support

Runs anywhere modern JavaScript runs.

| Runtime | Supported |
|----------|:---------:|
| Node.js 20+ | ✅ |
| Bun | ✅ |
| Deno | ✅ |
| Cloudflare Workers | ✅ |
| Vercel Edge | ✅ |
| Fastly Compute | ✅ |

No Node-specific APIs are required.

---

# Bundle Size

Designed for modern bundlers.

Features

- Tree shakeable
- Zero runtime dependencies
- Native fetch
- Native AbortController
- Native Web Crypto

Import only the adapters you need.

```ts
import { square } from "unibooking/adapters/square";
```

Unused providers are removed by the bundler.

---

# Framework Support

Works with any JavaScript framework.

### Backend

- Express
- Fastify
- NestJS
- Hono
- Koa

### Frontend

- React
- Next.js
- Remix
- Vue
- SvelteKit

### Serverless

- AWS Lambda
- Cloudflare Workers
- Vercel Functions
- Netlify Functions

---

# Frequently Asked Questions

## Does unibooking manage OAuth?

No.

It expects valid credentials.

Your application remains responsible for OAuth flows.

---

## Does it refresh tokens?

It can.

Simply provide credentials as an async function.

```ts
const client = square(async () => {

    return refreshAccessToken();

});
```

---

## Does it store tokens?

Never.

The library is completely stateless.

---

## Does it support recurring bookings?

Only when the provider supports recurring events.

Recurrence is not part of the canonical `Booking` model and has no capability
flag — pass provider-native recurrence fields through `providerOptions`, and read
them back from `booking.raw`.

Apple/CalDAV is the exception: it serializes iCalendar rather than JSON, so
`providerOptions` has nowhere to merge into and is ignored. `updateBooking`
still preserves an existing `RRULE`, and `listBookings` asks the server to
expand each in-window occurrence — but creating a recurring series through this
adapter is not supported.

---

## Can I access provider-specific data?

Yes.

Every booking contains the original provider payload.

```ts
booking.raw
```

---

## Does it support custom providers?

Yes.

The adapter interface is public.

You can build internal adapters for proprietary booking systems.

---

## Is it production ready?

The core — types, errors, retry, pagination, the adapter kit — is stable and
heavily tested.

Per-adapter maturity varies, and it is worth being precise about what the tests
prove. Every official adapter runs the shared conformance suite, which pins the
canonical `Booking` shape, status mapping, error normalization and pagination
against mocked HTTP matched on request path and method. Individual adapters add
wire-format tests for the specific URLs, headers and request bodies where a
detail matters.

What that does **not** prove is that a provider accepts those requests. The
suite mocks the transport, and the mocks are written alongside the adapter — so
a wrong endpoint, a misread response field, or a bad auth header is invisible to
it. An adapter can be fully green and still fail against the real API. **No
adapter is verified against a live tenant**; correctness rests on diffing each
one against the provider's published spec, which is what the audits recorded in
[CHANGELOG.md](CHANGELOG.md) do.

So: treat the widely-used adapters (Google, Outlook, Square, Acuity, Calendly)
as the best-exercised, and validate any adapter against your own tenant before
depending on it — especially the gated ones (Vagaro, Setmore, Boulevard, Zenoti,
Phorest, Mindbody, Wix), whose specs are the only available ground truth.
Discrepancy reports are the most useful contribution you can make.

---

# Why Not Use the Provider SDK Directly?

Because provider SDKs solve different problems.

They expose platform-specific APIs.

unibooking exposes one business API.

| Provider SDK | unibooking |
|--------------|------------|
| Google only | All providers |
| Different payloads | One booking model |
| Different errors | Unified errors |
| Different pagination | Shared helpers |
| Different auth | Common interface |
| Vendor lock-in | Provider agnostic |

---

# Philosophy

unibooking is intentionally **not** an ORM for bookings.

It does **not**

- manage OAuth
- host webhooks
- persist bookings
- synchronize providers
- replace provider SDKs

Instead, it provides one consistent abstraction layer over provider APIs.

Bring your own authentication.

Bring your own persistence.

Bring your own business logic.

We'll handle the API differences.

---

# Contributing

Contributions of all sizes are welcome.

Whether you're fixing a typo, improving documentation, implementing a provider,
or reporting a bug—you are helping make booking integrations easier for everyone.

## Ways to Contribute

- 🐛 Report bugs
- 💡 Suggest new features
- 📚 Improve documentation
- ✨ Add provider adapters
- 🧪 Improve tests
- ⚡ Performance improvements
- 🔒 Security improvements
- 🌍 Translations

---

# Development

Clone the repository

```bash
git clone https://github.com/djlahre0/unibooking.git

cd unibooking
```

Install dependencies

```bash
npm install
```

Run the test suite

```bash
npm test
```

Type checking

```bash
npm run typecheck
```

Lint

```bash
npm run lint
```

Build

```bash
npm run build
```

---

# Project Structure

```text
src/

    adapters/          google.ts, square.ts, outlook.ts, ... (16)

    webhooks/          square.ts, calendly.ts, wix.ts, ... (10)

    adapter-kit.ts     defineAdapter() — the adapter authoring toolkit

    http.ts            shared fetch layer, auth, timeouts

    errors.ts          UnibookingError + error normalization

    registry.ts        createRegistry() for dynamic dispatch

    retry.ts           withRetry()

    paginate.ts        listAll() / collectAll()

    types.ts           canonical Booking, Capabilities, BookingClient

    time.ts  tz.ts  ical.ts  crypto.ts  graph.ts

    index.ts           public barrel

examples/

test/
```

The project is intentionally organized around adapters.

Every provider follows the same architecture.

---

# Adapter Architecture

Every provider implements the same interface.

```ts
AdapterFactory<TCredentials>

↓

BookingClient

↓

Provider Adapter

↓

Provider API
```

This guarantees consistent behavior regardless of the provider.

---

# Writing Your Own Adapter

Need support for an internal booking platform?

Use `defineAdapter` to wire an adapter definition into a callable factory.

```ts
import { defineAdapter } from "unibooking";

export const myAdapter = defineAdapter({

    id: "mangomint",

    capabilities: {
        availability: true,
        staff: true,
        services: true,
        webhooks: false,
        idempotency: false,
        customers: false,
    },

    baseUrl: "https://api.example.com/",

    auth: (creds) => ({
        headers: { authorization: `Bearer ${creds.token}` },
    }),

    build: (http) => ({

        async createBooking(input){ /* ... */ },

        async getBooking(id){ /* ... */ },

        async updateBooking(id, input){ /* ... */ },

        async cancelBooking(id, options){ /* ... */ },

        async listBookings(query){ /* ... */ },

        async searchAvailability(query){ /* ... */ },

    }),

});
```

`build` receives a ready HTTP context (auth, retries, error normalization already
wired) and returns the method implementations.

Your adapter immediately works with

- withRetry()
- listAll()
- collectAll()
- createRegistry()

without any additional code.

---

# Testing

Every official adapter is validated using the shared conformance suite.

The suite verifies

- Booking lifecycle
- Status mapping
- Error normalization
- Pagination
- Time handling
- Capability consistency
- Provider invariants

This ensures every adapter behaves consistently.

---

# Versioning

unibooking follows Semantic Versioning.

- Patch → Bug fixes
- Minor → New features
- Major → Breaking changes

---

# Browser Support

Modern environments only.

Supported

- Node.js 20+
- Bun
- Deno
- Cloudflare Workers
- Vercel Edge

Legacy browsers are intentionally not supported.

---

# Performance Philosophy

unibooking is designed to stay lightweight.

Goals

- Zero runtime dependencies
- Minimal bundle size
- Fast cold start
- Tree shakeable
- Native platform APIs
- No global state

The library avoids unnecessary abstractions and favors predictable,
transparent behavior.

---

# Roadmap

The roadmap is driven by real-world use cases.

### Providers

- Microsoft Exchange
- HubSpot Meetings
- Shopify Bookings
- Fresha
- SimplyBook.me
- Timify

### Features

- Interactive Playground
- Live API Explorer
- CLI
- Code Generator
- OpenAPI Definitions
- More Examples
- Better Documentation

---

# Community

Questions?

- GitHub Discussions
- GitHub Issues

Found a bug?

Please open an issue.

Have an idea?

Feature requests are always welcome.

---

# Support the Project

If unibooking has saved you time, there are several ways you can help.

⭐ Star the repository

🐛 Report bugs

💡 Suggest features

📖 Improve documentation

🧪 Contribute tests

❤️ Share it with other developers

Every contribution—large or small—helps improve the project.

---

# License

MIT

---

<div align="center">

# ⭐ Write Booking Logic Once.

### Connect Anywhere.

**Google Calendar**

**Square**

**Outlook**

**Calendly**

**Wix**

**Mindbody**

**...and more.**

---

Built with ❤️ for developers building the next generation of booking software.

If you found this project useful, consider giving it a ⭐ on GitHub.

**Happy building!**

</div>