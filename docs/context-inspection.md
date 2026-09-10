# Campaign context inspection

P3.1 freezes version `1.0` of the proposed GM-only historical context-inspection
projection. It is a diagnostic for one recorded dispatch, not a search endpoint,
prompt replay facility, provider request viewer, or authority upgrade.

## Authorization and identity

Only an owner or GM authorized for the campaign room may request inspection. The
route is proposed as:

`GET /api/rpg/v1/campaigns/:campaignId/rooms/:sessionId/context-inspection/:lane/:dispatchId`

The response repeats this exact `campaignId`, `sessionId`, finite lane, and
`dispatchId`. A server must not infer `dispatchId` from a turn, run, claim, or
latest attempt. The lane identifiers are fixed as follows:

| Lane | Exact durable dispatch identity |
| --- | --- |
| `adventure-planning` | `agent_provider_dispatch_claims_v39.claim_id`, joined to its immutable provider context and settlement |
| `adventure-narration` | `adventure_narration_dispatches_v60.claim_id`, joined to `adventure_narration_contexts.claim_id` |
| `director-planning` | `dm_dispatches.claim_id`, with `dm_dispatches.run_id` binding the corresponding `dm_provider_requests` row |
| `director-narration` | `dm_narration_dispatches.claim_id`, with `dm_narration_dispatches.run_id` as its durable dispatch row |

The reader must authorize before reading the payload. It must not run recall,
settlement, recovery, or any provider call. Historical access is also subject to
current source visibility. No player or role-toggle projection is defined here.

## Response states and bounds

`campaignContextInspectionResponseSchema` is a strict discriminated union. An
`available` response contains recorded phase, dispatch certainty, settlement,
safe sections, recall hits, and usage. An `unavailable` response contains only
the exact identity and a finite reason. Missing sidecars, unsupported historical
versions, corrupt records, unknown dispatches, and revoked access are never
reconstructed from current data.

Sections are either safe included text or an explicit withholding reason. A
withheld section does not substitute current text for historical text. Included
section text is capped at 8,192 UTF-8 bytes and displayed metadata records its
UTF-8 byte count. There are at most 16 sections, eight recall hits, and 2,048
UTF-8 bytes per displayed recall hit. The declared safe displayed response and
the serialized safe DTO are each at most 24 KiB; if safe metadata cannot fit,
the reader withholds it with the recorded `metadata-overflow` or
`display-budget-exceeded` reason.

The DTO contains separate, non-additive counters for stored recall-packet UTF-8
bytes, stored message-content UTF-8 bytes, serialized stored-request UTF-8
bytes, safe displayed-response UTF-8 bytes, reported prompt/completion tokens,
and reserved prompt/completion tokens. Bytes and tokens are different units;
neither is an aggregate provider request or HTTP-wire total.

Any `withheld` section is treated as restricted, regardless of its particular
reason. In that state all persisted/request-derived counters must be `null`:
the three stored UTF-8 byte counters and reported/reserved prompt/completion
token counters. Only `displayedSafeResponseUtf8Bytes` remains reportable. This
prevents a private section's stored or reserved size from becoming a side
channel. For included sections and recall hits, `displayedUtf8Bytes` must equal
the displayed text's actual UTF-8 byte length, not merely be an upper bound.

## Safety boundary

Only reviewed labels, optional internal source links, authority labels, bounded
text, and known omission states may cross this boundary. The projection must not
contain raw or normalized request text, recall query text, query or scope hashes,
raw provider request JSON, credentials, hidden candidate counts, private tool
arguments, or unrestricted harness strings. A recorded request establishes only
recorded dispatch provenance. It does not prove provider receipt, turn source
prose into authority, or disclose newly private material.
