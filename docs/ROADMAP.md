# Brain Bolt — Product Roadmap

> Living document — last updated: 2026-08-17.

**Status legend:** ✅ COMPLETE · 🔄 IN PROGRESS · ⬜ PLANNED

## Table of contents

- [Era 1 — MVP / Core Product](#era-1)
- [Era 2 — Architecture & Platform Foundation](#era-2)
- [Era 3 — Monetization & Trust](#era-3)
- [Era 4 — Full Brain Bolt Platform](#era-4)
- [The roadmap at a glance](#at-a-glance)
- [Sequencing & dependencies](#sequencing)
- [Out of scope / parked](#out-of-scope)
- [Decision log](#decision-log)

---

<a id="era-1"></a>
## Era 1 — MVP / Core Product ✅ COMPLETE

This is the part we have now frozen.

**Phase 1–4 — Core Brain Bolt**
Quiz creation, live multiplayer, host controls, profiles, avatars, Arena, Training, discovery, results.

**Phase 5 — Competition Engine**
Autonomous competitions and MVP Leagues.

**Phase 6 — MVP Hardening**
Security, server-authoritative Arena scoring, reconnect/recovery, shared question engine, performance, mobile UX, search, accessibility, admin overview.

**Status: 🎉 MVP COMPLETE**

**Success metric:** shipped and stable — the create → host → play → results loop runs in production with real competitions.

---

<a id="era-2"></a>
## Era 2 — Architecture & Platform Foundation 🔄 IN PROGRESS

This is the work we're doing now.

**Success metric:** zero ownership/capability regressions since Phase 7; the first AI-generated quiz passes human review and gets published.

### Phase 7 — Architecture Constitution ✅ COMPLETE

We have completed:

- 7A — Architecture audit ✅
- 7B — Constitution locked ✅
- 7C — Role/Grant consolidation ✅
- 7D — `can(...)` capability layer ✅
- 7E — Capability stabilization ✅
- 7F — Principal foundation ✅
- 7G — Ownership migration plan ✅
- 7H — Branding ownership ✅
- 7I — League ownership ✅
- 7J — Quiz ownership ✅
- 7K — Competition ownership ✅
- 7L — final Principal-aware ownership/capability cleanup ✅

So **Phase 7 is now DONE**.

**Artifacts:**

- [ARCHITECTURE_CONSTITUTION.md](ARCHITECTURE_CONSTITUTION.md)
- [ARCHITECTURE_CONSTITUTION_AUDIT.md](ARCHITECTURE_CONSTITUTION_AUDIT.md)
- [CAPABILITY_MODEL.md](CAPABILITY_MODEL.md)
- [PRINCIPAL_MODEL.md](PRINCIPAL_MODEL.md)
- [OWNERSHIP_MIGRATION_PLAN.md](OWNERSHIP_MIGRATION_PLAN.md)
- [PHASE_7E_VERIFICATION.md](PHASE_7E_VERIFICATION.md)

**Definition of done:** satisfied — 7A–7L above, verified in PHASE_7E_VERIFICATION.

The result is the new foundation:

```text
Principal
   ↓
Role / Grant
   ↓
Entitlement / Capability
   ↓
can(...)
   ↓
Business Resource
```

That's the foundation for Organizations, billing, AI, Marketplace, etc.

### Migration toolchain ✅ COMPLETE

Added 2026-08-17. The live project has no `supabase_migrations` ledger (Lovable applies outside CLI bookkeeping), so migration state is judged by schema markers:

- `bun scripts/migrate.mjs` — connects via `DATABASE_URL` (psql), reports every migration in `supabase/migrations/` as applied/pending, and **applies pending ones automatically**, each in its own transaction, re-probing live before and confirming via marker after. `--dry-run` reports only.
- `bun scripts/check-migrations.mjs` — read-only status report.
- Single source of truth: marker probes in `scripts/migration-markers.mjs` (one entry per migration; new migrations must add one).
- First run found and applied **four migrations the live DB was missing** (7L-2 sync-trigger retirement, 7L-3 `owner_id` column retirement, and two REVOKE-only files) — the live DB is fully migrated as of 2026-08-17.

---

### Phase 8 — AI + MCP 🔄 IN PROGRESS

This is now our active AI/integration track.

#### 8A — MCP Foundation Hardening ✅ COMPLETE

We hardened the existing MCP quiz generator.

#### 8B — MCP Quiz Lifecycle ✅ COMPLETE

List, inspect, update, archive, question management, idempotency. All tools implemented in `mcp/src/lifecycle.ts`, gated through `can(...)`, suite green (124 tests).

#### 8C — MCP Competition Lifecycle & Scheduling ✅ COMPLETE

Create (draft) → configure → schedule → inspect → cancel, on the existing Competition engine. All tools implemented in `mcp/src/competition.ts`, gated through `can(...)` (`competition.create` / `competition.manage`), idempotent via the shared key table, structured failure envelopes, Session boundary enforced (scheduling hands off to the existing pg_cron tick — MCP never touches sessions).

#### 8D — MCP League, Results & Multi-Step Orchestration ✅ COMPLETE

AI can connect: Quiz → Competition → League → Results → Standings.

League discovery/inspection (`list_leagues`, `get_league`), authoritative standings via the app's existing `get_league_standings` database function (service-role wrappers `mcp_league_standings` / `mcp_league_overview`, no points logic recreated in MCP), permanent-result inspection (`get_competition_results`, `get_player_league_history`), safe league mutations (`attach_competition_to_league`, `detach_competition_from_league` — draft/scheduled only, idempotent) and the first bounded workflow (`orchestrate_competition_workflow`: create → attach → schedule / create → schedule) with per-step derived idempotency keys, preflight validation and explicit partial-failure reporting. All gated through `can(...)` (league reads: owner-or-public, matching the app's `can_view_league`); session boundary unchanged — MCP never touches sessions.

#### 8E — Brain Bolt AI Foundation ✅ COMPLETE

The actual **native Brain Bolt AI service layer**.

Server-side model gateway (`src/lib/ai/`), prompt registry (`PROMPT_VERSIONS`), usage tracking (`ai_usage_log` table + `recordUsage` helper), Bedrock + DeepSeek R1 provider (swappable via `AiProvider` interface), Principal-aware authorization (`ai.generate_questions` capability branch in `public.can(...)`), friendly-error taxonomy (`FRIENDLY_MESSAGES`), no provider secrets exposed to UI.

#### 8F — AI Question & Quiz Builder ✅ COMPLETE

A user says:

> "Create me 20 Form 3 biology questions on genetics."

Brain Bolt AI creates a **draft**, validates it, and lets the human review it before publishing.

Shipped: inline AI panel in the Quiz Editor (`src/components/quiz/AiQuestionBuilderPanel.tsx`) — structured + natural-language inputs, per-question edit / regenerate / remove / exclude, **Add to Quiz** persists via the existing `supabase.from("questions").insert(...)` path with `is_playable=false`. Two server functions (`generateQuestions`, `regenerateQuestion`) in `src/lib/api/ai.functions.ts`. See [BRAINBOLT_AI_ARCHITECTURE.md](BRAINBOLT_AI_ARCHITECTURE.md) for the full architecture.

#### 8G — Brain Bolt AI Assistant ⬜ PLANNED

Eventually:

- Player coach
- Lecturer assistant
- Creator assistant
- Competition analytics assistant
- Question improvement
- Difficulty balancing
- Weakness detection

**Definition of done:** MCP lifecycle covers quiz, competition, and league orchestration with idempotency ✅; the native AI service generates a validated draft quiz a human can review and publish ✅; assistant v1 (creator-focused) is live (8G).

---

<a id="era-3"></a>
## Era 3 — Monetization & Trust ⬜ PLANNED

**Success metric:** conversion free → paid, MRR, churn; creator payouts process without manual intervention.

### Phase 9 — Plans, Entitlements & Payments ⬜ PLANNED

This is a major architectural phase and we would **not skip the entitlement layer**.

#### 9A — Plans & Entitlements

Define things like:

```text
Free
Creator
Creator Pro
Organization
Enterprise
```

and capabilities such as:

```text
quiz.max_published
competition.max_concurrent
ai.monthly_credits
advanced_analytics
custom_branding
league_features
api_access
```

#### 9B — Feature Gating

Actually enforce those entitlements in both backend and frontend.

#### 9C — Payments & Subscriptions

Subscription lifecycle, upgrades, downgrades, cancellations, failed payments.

#### 9D — Creator Monetization

Premium quizzes, creator subscriptions, licensing, revenue share, payouts.

#### 9E — Organization Billing

Seats, usage, organization plans, enterprise contracts.

**Definition of done:** a user can subscribe, upgrade, downgrade, and cancel; every entitlement is enforced server-side (not just hidden in the UI); creator payouts process.

---

### Phase 10 — Trust, Legal & Public Readiness ⬜ PLANNED

This is the legal/public layer we decided to add after Phase 7.

**MVP/public documents**

- Terms of Service
- Privacy Policy
- Contact / Support
- Community / Acceptable Use
- Accessibility Statement
- Cookie Policy where applicable
- Account/Data Deletion

**Later**

- Creator Terms
- Marketplace Terms
- Refund Policy
- Sponsorship Terms
- Prize/Competition Rules
- Organization/Enterprise Terms
- Security / Responsible Disclosure

**Definition of done:** all MVP/public pages are published and linked from the app; account/data deletion works end-to-end.

---

<a id="era-4"></a>
## Era 4 — Full Brain Bolt Platform ⬜ PLANNED

**Success metric:** active organizations, marketplace GMV, sponsored competition volume, and a known cost per active player.

### Phase 11 — UI/UX Constitution ⬜ PLANNED

This is where we redesign the **system of experiences**, not isolated screens.

Topics we've already parked:

- Mobile navigation hierarchy
- Arena discovery architecture
- Search
- Public vs private competition discovery
- Role-aware navigation
- Admin experience
- Organization UX
- Progressive disclosure
- Design system
- Information architecture

This is also where we'd formalize the **UX Constitution**.

**Definition of done:** UX Constitution ratified; design tokens and the navigation model applied across the app.

---

### Phase 12 — Organizations 🏢 ⬜ PLANNED

Now the Principal model pays off.

A university/company/school becomes a Principal.

Then:

Organization → Members → Roles → Grants → Competitions → Leagues → Analytics

This is where the lecturer/classroom use case becomes powerful.

**Definition of done:** an organization can be created, members invited with roles/grants, org-owned competitions run, org analytics visible.

---

### Phase 13 — Advanced Leagues 🏆 ⬜ PLANNED

The MVP league system exists already.

This phase adds the serious league functionality:

- registration
- rosters
- invite links
- late joining rules
- seasons
- best-N scoring
- attendance
- rewards
- certificates
- marks/export
- organization-based leagues
- prize structures

And eventually:

**Multiple Rounds within one Competition.**

That's the round system we discussed earlier.

**Definition of done:** the full league lifecycle works — registration, rosters, seasons, best-N scoring, certificates/export — and one competition can hold multiple rounds.

---

### Phase 14 — Marketplace 🛒 ⬜ PLANNED

Creators can sell:

- Quizzes
- Question packs
- Branding
- League templates
- potentially AI-assisted educational assets

Then:

Creator → Marketplace → Buyer → Competition.

**Definition of done:** a creator lists a quiz for sale, a buyer purchases it, the quiz runs in a competition, and revenue share is tracked.

---

### Phase 15 — Sponsorships 🤝 ⬜ PLANNED

Sponsored competitions.

Sponsored Arena slots.

League sponsorship.

Prize pools.

Brand activations.

The competition itself becomes the advertising experience.

**Definition of done:** a sponsor self-serves a competition slot or prize pool; brand assets render in the host and Arena experience.

---

### Phase 16 — Mission Control / Platform Operations ⬜ PLANNED

This is the Super Admin "control tower":

- all users
- active users
- competitions today
- live sessions
- hosts
- organizations
- creators
- revenue
- infrastructure usage
- database health
- Realtime
- egress
- errors
- scheduler health

And **this is also where we'd implement the infrastructure optimizations**:

- simultaneous competition limits
- host capacity controls
- rate limiting
- session retention
- data archival
- deletion of reconstructible runtime data
- database cleanup
- query/index optimization
- Realtime scaling
- scheduler scaling
- cost monitoring

So the earlier question about **"when do we limit how many hosts can run simultaneously and clean database data?"** belongs here.

**Definition of done:** Mission Control shows live and historical ops data; simultaneous-competition limits, retention, and archival policies are enforced.

---

### Phase 17 — APIs & MCP as a Platform 🔌 ⬜ PLANNED

At this point MCP stops being mainly a development integration and becomes a real platform interface.

External systems and agents could say:

> Create a competition.

> Schedule next week's university league.

> Get standings.

> Generate a quiz from this document.

Potentially:

```text
Brain Bolt API
    +
Brain Bolt MCP
    +
Brain Bolt AI
```

all using the same Principal/capability/entitlement foundation.

**Definition of done:** public API + MCP cover quiz/competition/league operations behind the same Principal/capability/entitlement auth.

---

### Phase 18 — Brain Bolt Labs 🧪 ⬜ PLANNED

This is where our experimental ecosystem lives.

Private Labs → invited testers → public Labs.

Examples:

- AI Coach
- Voice Host
- AI Opponent
- new question types
- simulations
- streaming competitions
- experimental learning experiences
- entirely new Brain Bolt products

Nothing experimental has to destabilize the core product.

**Definition of done:** private Labs runs with invited testers; at least one experimental product is testable without destabilizing the core.

---

### Phase 19 — Scale / Global Platform 🌍 ⬜ PLANNED

Not because we need it today, but eventually:

- millions of players
- multi-region architecture
- caching
- read replicas
- advanced analytics
- global CDN strategy
- regional compliance
- more robust observability
- native mobile apps
- enterprise integrations
- LMS integrations

**Definition of done:** scale runbook written; multi-region, caching, and read replicas where cost-justified; native mobile apps shipped.

---

<a id="at-a-glance"></a>
## The roadmap at a glance

```text
MVP
✅ Core Product
✅ Competition Engine
✅ Arena
✅ Leagues MVP
✅ Hardening

        ↓

ARCHITECTURE
✅ Phase 7
Principal
Roles
Grants
can(...)
Ownership

        ↓

AI / MCP
🔄 Phase 8
MCP lifecycle
MCP orchestration
✅ Brain Bolt AI
✅ AI Question Builder
AI Assistant

        ↓

MONETIZATION
Phase 9
Plans
Entitlements
Feature Gates
Payments
Creator Economy
Enterprise Billing

        ↓

TRUST
Phase 10
Terms
Privacy
Community
Accessibility
Public readiness

        ↓

UX
Phase 11
UX Constitution
Navigation
Discovery
Mobile IA

        ↓

PLATFORM
Phase 12 Organizations
Phase 13 Advanced Leagues
Phase 14 Marketplace
Phase 15 Sponsorships
Phase 16 Mission Control / Scale Ops
Phase 17 API + MCP Platform
Phase 18 Brain Bolt Labs
Phase 19 Global Scale
```

---

<a id="sequencing"></a>
## Sequencing & dependencies

**Why this order:** Architecture → AI/MCP foundation → Entitlements/Monetization → Trust/Legal → UX Constitution → Organizations → Advanced Leagues → Marketplace. (Decision 001 — see the [decision log](#decision-log).)

Now that MCP + native AI + monetization are on the roadmap, Organizations are no longer "immediately after Phase 7". They will be much easier to build once we already know exactly how capabilities + Principal + entitlements + billing interact.

**What unlocks what:**

- `7 → 8E → 8F/8G` — the Principal/capability layer underpins the native AI service and its authorization.
- `8E → 8F, 8G` — the AI service layer is a prerequisite for the question builder and assistant.
- `7 + 9 → 12` — Organizations build on capabilities, entitlements, and billing being in place first.
- `12 → 13` — organization-based leagues depend on org membership and roles.
- `9 → 16` — Mission Control's revenue surface requires payments to exist.
- `8E + 9 → 17` — the API/MCP platform surface reuses the entitlement foundation.
- `16 → 19` — limits, retention, and cost decisions from Mission Control inform global scaling.

That gives us a genuinely strong foundation for the eventual:

> **Player → Creator → Organization → Enterprise → AI → Marketplace ecosystem.**

And that's where Brain Bolt starts looking much less like a quiz application and much more like the **competitive knowledge infrastructure** we've been talking about.

---

<a id="out-of-scope"></a>
## Out of scope / parked

Parked ideas and deferred work are tracked in [DEFERRED_WORK.md](DEFERRED_WORK.md). Note: several of its entries (Principal, `can(...)`, grant/policy consolidation) predate Phase 7 and are now complete — the register needs a sweep.

Known parked items still waiting:

- Deeper mobile navigation strategy → Phase 11
- Advanced discovery: filters, categories, sorting, recommendations → Phase 11
- Scheduler sharding, tick observability, analytics event pipeline → Phase 16
- Realtime fan-out and payload trimming at scale → Phase 16/19
- Experimental products — AI Coach, Voice Host, AI Opponent → Phase 18 Labs (parked, not cancelled)

---

<a id="decision-log"></a>
## Decision log

| # | Date | Decision | Rationale |
|---|---|---|---|
| 001 | 2026-08-16 | Sequence Organizations after Monetization, not immediately after Phase 7 | Organizations are easier to build once capabilities + Principal + entitlements + billing interactions are known; MCP + native AI + monetization now precede it on the roadmap |
