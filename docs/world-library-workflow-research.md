# World library workflow research

Reviewed 2026-10-02. Scope: campaign library entry, discovery of saved worlds, and handoff to existing campaign management and play.

## Sources and decisions

- **Nielsen Norman Group — [Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/).** Prioritize frequent actions and disclose secondary complexity with meaningful labels. Application: a prominent **Generate world** entry opens the existing worldbuilding panel inline; manual creation lives under **Start with a blank campaign**. Campaign configuration remains in the campaign workspace.
- **Nielsen Norman Group — [Recognition Rather Than Recall](https://media.nngroup.com/media/articles/attachments/Heuristic_6_compressed.pdf).** Make relevant actions and information visible instead of requiring users to remember previous screens. Application: named cards expose role, lifecycle, and updated date; recently updated ordering helps returning users locate saved work. Search, role/status filters, and name ordering support larger libraries.
- **Nielsen Norman Group — [Visibility of System Status](https://www.nngroup.com/articles/visibility-system-status/).** Timely feedback should distinguish successful actions, ongoing work, and unavailable information. The article specifically recommends retaining saved-list entries when their state changes rather than silently removing them. Application: failed lifecycle reads leave cards usable with **Status unavailable**; successful campaign creation is distinguished from failed library refresh; generator state stays mounted while the library refreshes.

These are established UX principles applied to this repository, not results of a Velvet usability study. This is a task-oriented saved-work dashboard: discovery and next actions matter more than aggregate metrics.

## Repository findings

- `listCampaigns()` provides identity, name, access role, and timestamps, but no lifecycle or play-readiness fields.
- `getCampaignAdministration(id)` already supplies `draft`, `published`, `paused`, `completed`, or `archived`. The library enriches cards with this read using at most four concurrent requests. Failures are isolated per campaign and stale results are discarded.
- Lifecycle is not play readiness. Published campaigns are labeled **Published**, never automatically **Ready to play**. Opening a campaign delegates actual room/setup checks to the existing campaign detail workflow.
- `onOpen(campaignId)` opens the campaign overview. The optional second argument selects `world` or `play` for the generator's **Manage world** and **Prepare to play** handoffs. Play opens room preparation; it does not start a session automatically.
- `WorldbuildingAgentPanel` already accepts optional `campaignId`, `initialCampaignName`, and `onCampaignCreated`. The library mounts it without an ID for a new world. Creation triggers only a list refresh; it neither changes the panel's key/ID nor navigates or moves focus away from generation.
- Blank creation retains duplicate-submit protection, authoritative post-create refresh, failure drafts, and focus on the new card. Filters reset after confirmed creation so the new card can be found.

## Accessibility and validation

Native labeled search/select inputs, semantic headings/list/cards, a native disclosure for manual creation, visible keyboard focus, announced result counts, separate load/error/no-match states, and mobile filter wrapping are included. Card accessible names retain the campaign name. Generator disclosure focuses its heading without interrupting later stages.

Focused client tests cover search/filter composition, ordering, unavailable lifecycle reads, generator identity across creation/refresh, and the existing mutation/read-race regressions. Parent integration validation owns browser/E2E checks.

## Limits

Lifecycle enrichment requires one existing GET per campaign; a future list summary projection could remove this cost if large libraries justify a contract change. Search/filter preferences are session-local component state. The library does not persist an unfinished generation run across route navigation or reload; the generator owns its execution/recovery behavior. No new endpoints or play-readiness assumptions are introduced.
