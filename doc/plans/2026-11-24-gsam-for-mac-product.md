# GSAM for Mac as a sold product (24 Nov 2026)

John's decisions, 24 Nov 2026:

- A customer installs GSAM on their own Mac with the GSAM app (`packaging/macos`). They never type a command.
- Greatstone has full remote access to every customer install (this goes in the customer agreement: Greatstone is a data processor).
- Customers sign up and pay on the website with Stripe. Billing is monthly or annual.
- Customers pick modules. Greatstone sells module packages and makes exclusive deals for one customer.
- The service stops at the end of the paid period. There is no grace period. Data stays on the customer's Mac.
- No Apple notarisation yet (first open stays right-click, then Open).

## The pieces and how they join

```
website (Better Auth account, Stripe Checkout, "My GSAM" page)
   | Stripe webhook -> website -> hub (signed server-to-server call)
   v
hub = Greatstone's own GSAM with GSAM_FLEET_HUB=true
   - customers, subscriptions, modules, packages, deals
   - issues licence keys and signed entitlement documents
   - Fleet page: every install, its health, "Open" (remote), pause, stop, update now
   ^  public paths: /api/fleet/spoke/* only (each call signed or code-gated)
   |
customer Mac: GSAM.app -> engine (gsam.sh) -> GSAM server in authenticated mode
```

**Licence key.** After checkout the website shows a licence key (`gsamlk_...`, one use). On first open the app asks for it and calls `POST /api/fleet/spoke/activate`. The hub answers with the fleet registration, the first signed entitlement document, and the Greatstone operator log-in for that install. One generic DMG serves every customer.

**Modules.** A module is a named set of `ENTITLEMENT_FEATURE_KEYS` plus limits, with a monthly and an annual price. A package is a set of modules with its own price. A deal is a price or package that applies to one customer only. Each has a Stripe Price. The hub turns the active subscription into the entitlement document: `features` from the modules, `validUntil` = Stripe `current_period_end`.

**Stop at period end.** Customer documents carry `grace: 0`. When `validUntil` passes and no newer document has arrived, the install shows a "Subscription ended" screen with a renew link. Agents stop. Data is kept and can still be exported.

**Delivery.** The hub answers each check-in (every 5 minutes) with the latest signed entitlement document and any signed operator orders (pause, resume, stop, update now). The install only obeys messages signed with the hub key that is pinned in the app.

**Remote access.** Each install gets a Greatstone operator log-in (instance admin). The hub stores its password in its secrets store. Network reach is Tailscale: the app runs `tailscaled` in userspace mode (no system extension), joins Greatstone's tailnet as `tag:gsam-customer`, and the tailnet policy lets only Greatstone admins reach `tag:gsam-customer:3100`. Customers cannot reach anything. The Fleet page's "Open" button opens the install over the tailnet.

**Users.** The customer's owner creates their own log-in during setup. They invite their team from the existing Access page. The number of users is a module limit (`limits.maxUsers`) and is enforced.

## Phases

| Phase | Done when |
|---|---|
| P1 Installer complete | A fresh Mac goes from DMG to a signed-in owner, with: authenticated mode, closed sign-up, operator log-in, hourly backups, Claude and ChatGPT sign-in, licence activation, fleet registration and check-ins every 5 minutes against a sandbox hub. |
| P2 Admin and remote | From the hub Fleet page John sees every install, opens any of them remotely, and pauses, stops or updates it. Orders are signed and obeyed within 5 minutes. |
| P3 Payments and modules | The hub has modules, packages and deals mirrored to Stripe. Checkout, renewal, upgrade, cancel and failed payment each change the install's document correctly. The install stops at period end. |
| P4 Website accounts | A customer signs up, pays, sees their licence key and download, picks modules and manages billing (Stripe customer portal) on the website. The website goes live only through John's Deploy button. |

## Needs John

- Turning his live GSAM into the hub (`GSAM_FLEET_HUB=true`, a restart, Funnel for `/api/fleet/spoke/*`).
- A Tailscale OAuth client (to mint tagged auth keys) and the tailnet policy change.
- Stripe live keys (test mode until then).
- Prices for modules and packages.
- The customer agreement wording on remote access.
