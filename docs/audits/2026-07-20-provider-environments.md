# Provider environments audit — 2026-07-20

Establishes, per provider, whether a separate sandbox HOSTNAME or regional hosts
exist. Populates `demo/lib/environments.ts`, which also backs the demo proxy's
SSRF allowlist — so an unverified host here becomes a security decision, not
just a docs gap.

**Method:** official provider documentation only. A "test mode" reached through
an account setting on the production host does not count as a sandbox.

## Summary

Three of sixteen providers publish a separate sandbox hostname.

| Provider | Production | Sandbox | Regions |
|---|---|---|---|
| google | `www.googleapis.com` | — | — |
| outlook | `graph.microsoft.com` | — | `graph.microsoft.us`, `dod-graph.microsoft.us`, `microsoftgraph.chinacloudapi.cn` |
| microsoft_bookings | `graph.microsoft.com` | — | `graph.microsoft.us`, `dod-graph.microsoft.us` |
| square | `connect.squareup.com` | `connect.squareupsandbox.com` | — |
| acuity | `acuityscheduling.com` | — | — |
| bookeo | `api.bookeo.com` | — | — |
| mindbody | `api.mindbodyonline.com` | — | — |
| wix | `www.wixapis.com` | — | — |
| calendly | `api.calendly.com` | — | — |
| vagaro | `api.vagaro.com` | — | — |
| zenoti | `api.zenoti.com` | — | — |
| boulevard | `dashboard.boulevard.io` | `sandbox.joinblvd.com` | — |
| phorest | `platform.phorest.com` | `api-gateway-dev.phorest.com` | `platform.phorest.com` (EU), `platform-us.phorest.com` (US/AUS) |
| setmore | `developer.setmore.com` | — | — |
| mangomint | `api.mangomint.com` | — | — |
| apple | `caldav.icloud.com` | — | — |

The region *keys* in `demo/lib/environments.ts` are `us-gov-high` / `us-gov-dod`
/ `china` for Graph, and `eu` / `us-aus` for Phorest (not `us` — Phorest serves
both the US and Australia off the single `platform-us` host, so the key names
the pair).

The allowlist is enforced by `assertSafeBaseUrl` (`demo/lib/environments.ts`),
which matches the parsed `URL#hostname` exactly against the table above,
requires `https`, and rejects a URL carrying an explicit non-default port
(`https://connect.squareup.com:8443/...` fails even though the hostname is
allowed). An explicit `:443` is accepted, but only because the URL parser
normalizes the default HTTPS port away before the check runs — it never
reaches the guard as a distinguishable port at all.

## Findings that would have caused bugs

- **Boulevard's sandbox is on a different registrable domain** than production
  (`sandbox.joinblvd.com` vs `dashboard.boulevard.io`). Deriving one from the
  other by pattern gives a wrong host.
- **MS Bookings is unsupported on the China 21Vianet cloud** while Outlook
  Calendar is supported there. The two cannot share one host list despite both
  riding Microsoft Graph.
- **Phorest has no AUS host.** Australia is served by `platform-us`.
- **Vagaro's region is a path parameter**, not a subdomain —
  `api.vagaro.com/{region}/api/v2/`. `us04.vagaro.com` is only the merchant
  dashboard URL you read the region code from.
- **Calendly's "Sandbox"** in its developer portal is an OAuth app designation
  that only relaxes the redirect-URI scheme rule. There is no sandbox host.
- **Mindbody's sandbox is site ID `-99`** sent in the SiteId header against the
  production host.
- **Wix's `SANDBOX`** is a CMS data-environment value, a request-level setting.

## Deliberate omissions

- **Zenoti EU/AU hosts** (`api.zenoti.eu`, `api.zenoti.com.au`) are cited by
  third-party integration guides but appear on no Zenoti-owned page. Excluded:
  an unverified host in an SSRF allowlist is a guess with consequences. Worth
  confirming with Zenoti support before adding.
- **Mangomint** publishes no public endpoint documentation at all. The host
  matches the adapter's built-in default and responds, but is not
  documentation-confirmed. Prod-only.
- **Apple/CalDAV** requests go to the account's own partition host
  (`p01-caldav.icloud.com` and similar) discovered via RFC 6764, not to a fixed
  base. `demo/lib/validate-caldav.ts` already constrains that URL to
  `*.icloud.com`; the base URL override is disabled for Apple because it has no
  effect.
