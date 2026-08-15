# Brain Bolt — Deferred Work Register (post-MVP)

Recorded at MVP freeze. None of these are launch blockers; none are implemented in this phase.

## Architecture
- Principal abstraction (unified user/guest/org identity) and `owner_principal_id`.
- Competition/Session constitutional cleanup — one lifecycle owner, session as execution detail.
- Canonical `can(...)` authorization helper replacing scattered `is_authorized_host()` / `has_active_host_authorization()` checks.
- Unified table GRANT + policy conventions applied in one sweep.
- Align host capability model: `host` role currently grants UI access, while write policies require `admin` or an active host authorization. Should collapse into one predicate.

## UI/UX
- Deeper mobile navigation strategy (persistent bottom bar / route-aware nav).
- Richer Arena thumbnails and cover art pipeline.
- Advanced discovery: filters, categories, sorting, recommendations.
- Creator pages and public quiz profiles.
- Seasonal / themed visual systems for leagues and events.

## Platform
- Organizations and team accounts.
- Advanced Leagues: registration, rosters, divisions, fixtures.
- Marketplace, sponsorships, creator monetization.
- Public APIs and webhooks.
- AI integration (question generation, adaptive difficulty).
- Brain Bolt Labs / experimental modes.

## Scale
- Autonomous scheduler sharding and multi-worker ticks.
- Tick-action logging and observability (structured run history, alerting).
- Analytics infrastructure and event pipeline.
- Large-scale realtime optimization (fan-out, presence, payload trimming).
- Cleanup job for abandoned lobby sessions (cosmetic today, hygiene at scale).
