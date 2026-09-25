# Moth API contract used by Mothbake

Research date: 2026-09-25

This document separates public documentation, the machine-readable schema,
locally tested behavior and unknowns. It is not a transcript of credentials or
account data.

## Sources and versions

| Source | Version/date exposed | Verification in this upgrade |
| --- | --- | --- |
| <https://api.mothquantum.com/openapi.json> | OpenAPI 3.1.0; `moth-api` `v0.41.0` | Public GET, parsed successfully; 362,971 bytes; SHA-256 `a383dc2972189e83b6adc54f36be2cd23745ffb60e0284edc8b3182845682b91` |
| <https://docs.mothquantum.com/docs/endpoints> | Generated from `moth-api v0.41.0` on 2026-09-25 | Public GET |
| Public guide pages under `docs.mothquantum.com` | Footer `Moth Quantum v0.10.3` | Public GET |
| Authenticated engine/job/asset service | Account-dependent | **Not queried during this upgrade**; no credentials were read and no live jobs were submitted |
| Mothbake fake service and fixtures | Repository tests | Local behavior only; never evidence that a live recipe works |

The guide/footer version and API version describe different published
components. They are recorded rather than treated as a mismatch to “fix”.

## Authentication and ownership

Documented and present in OpenAPI:

- Requests use `Authorization: Bearer moth_…` API keys. Dashboard JWTs exist but
  are not needed for ordinary programmatic job/asset use.
- Keys are account-scoped and rate-limited to 300 requests/minute/key.
- Resources outside the caller's ownership/view access return 404 rather than
  revealing existence with 403.
- Keys must remain server-side and are never persisted by Mothbake.

## Engine discovery and validation

Documented and present in OpenAPI:

- `GET /api/v1/engines` lists visible engine summaries.
- `GET /api/v1/engines/{engineID}` returns the full definition, including
  `params_schema`, input/output slots, accepted content types,
  `credits_per_run`, `run_policy`, error codes and optional informational
  engine `version`.
- Submission parameters are validated against the engine's JSON Schema and
  unknown properties normally fail because schemas use
  `additionalProperties: false`.
- Engine versions may be absent for registrations predating that field. A
  missing version must stay “unknown”; it cannot be invented from an engine id.

Mothbake should cache only sanitized contract snapshots and record their
retrieval date, API version and verification level. A snapshot validates a
request shape; it does not prove a worker is currently available or that a
specific job will succeed.

## Asset upload and download

Documented flow:

1. `POST /api/v1/assets` with exact filename, content type and byte length.
2. Upload bytes to the returned presigned URL with exactly the returned method
   and headers. File bytes do not pass through the API.
3. `POST /api/v1/assets/{assetID}/complete`.

Important behavior:

- Presigned upload URLs expire; incomplete assets remain pending and count
  toward quota until completed or deleted.
- Upload maximum is documented as 100 MiB, with lower limits for scanned
  images. Accepted scanned image uploads are PNG/JPEG.
- `GET /api/v1/assets/{assetID}/download` returns a fresh `download_url` and
  `expires_at`. This is the durable refresh path for both uploads and job output
  assets.
- `GET /api/v1/assets` supports cursor pagination and kind filtering;
  `GET /api/v1/me/storage` reports upload/output usage and quota.
- Signed object-store URLs require no API Authorization header. Mothbake must
  not forward bearer credentials to them or log their query strings.

Unknown/unverified here: exact object-store redirect policy and which upload
steps, if any, are idempotent under every failure mode. The client must not
guess that create or complete POSTs are safe to repeat.

## Submission contract

Confirmed endpoint:

```text
POST /api/v1/engines/{engineID}/process
```

Body fields in OpenAPI `SubmitJobInputBody`:

- `params`: engine-specific JSON object;
- `input_files`: input slot to uploaded asset id;
- `mode`: platform-reserved execution-target switch, equivalent to
  `params.mode`; use one location, not both;
- `start_from` / `stop_after`: named-step controls for step engines.

Success is `202 Accepted` with `job_id`, `status` and `submitted_at`. The public
guide says the recorded initial state is queued and no engine work has run yet.

The OpenAPI operation exposes no idempotency-key field or header. Persisting a
client-generated key therefore does **not** make a resubmission safe. Before a
potentially billable POST, Mothbake must persist intent. If the response is lost
or a 5xx response does not carry a job id, the journal records
`unknown-submission` and never automatically resubmits.

The guide says a submission-time 503 means the runtime was unavailable and no
job was recorded. Until that is verified for the exact deployed service and all
failure paths, Mothbake keeps the more conservative no-automatic-resubmit rule
for any unconfirmed submit response. Validation/auth/rate-limit responses known
not to create a job may be surfaced for explicit user action.

## Status, history and result retrieval

The tutorial and authoritative endpoint page agree with current Mothbake:

- live polling: `GET /api/v1/jobs/{jobID}/status`;
- completed result: `GET /api/v1/jobs/{jobID}/result`;
- persisted history row: `GET /api/v1/jobs/{jobID}`;
- cursor-paginated history: `GET /api/v1/jobs` with optional `status` and
  `engine_id` filters.

There is no conflict requiring Mothbake to replace its `/status` or `/result`
URLs. `GET /jobs/{jobID}` has a different purpose: persisted history without a
live runtime query.

Documented states are `queued`, `processing`, `completed`, `failed`, and
`cancelled`. Transient worker states such as `fetching` should be treated as
processing. Completed/failed/cancelled are terminal.

Result behavior:

- File-producing engines return one entry per output slot with
  `output_asset_id`, content metadata, a presigned URL and expiry.
- Inline-result engines return JSON under `result`. Inline results have limited
  runtime retention and must be archived promptly.
- Result status 409 means not retrievable in the current state; check status.
- Result status 410 means the runtime result is gone. Output assets can still be
  refreshed/downloaded; an expired inline result is unrecoverable unless it was
  already archived.
- Result status 404 means no such visible job.

Mothbake archives exact downloaded bytes and hashes. A signed URL is transport,
not artifact identity.

## Cancellation, reconciliation and spending

- The 2026-09-25 OpenAPI contract exposes **no job-cancellation operation**.
  Local cancellation can stop waiting/download/bake work; it must not claim to
  cancel remote execution or billing.
- Job listing/history can assist a human reconciliation workflow, but the
  published job shapes do not include the original params, input identities or
  a client idempotency key. Matching an ambiguous submit to a particular local
  recipe is therefore not generally provable from the documented response.
- Catalog `credits_per_run` is the documented estimate/cost field. The
  published job/status/result schemas do not expose actual charged credits.
- Requested mode is accepted on submission, but the generic published job
  schema does not guarantee actual backend/mode metadata. Requested and
  observed execution metadata must remain separate.
- Unknown price is not zero. A Mothbake budget is local admission control around
  frozen plans and reservations; it is not a provider-enforced billing cap.

## Network and retry policy derived from the contract

- GETs may use bounded retries for transient transport errors, 429 and
  documented transient 5xx responses.
- Paid submit POSTs are retried only when the response definitively establishes
  that no job was created. An ambiguous outcome is journaled and stopped.
- Poll at the documented two-to-five-second cadence with an overall timeout;
  stopping local polling does not change remote state.
- Refresh expired file URLs through `GET /jobs/{id}/result` or, preferably when
  the output asset id is known, `GET /assets/{assetID}/download`. Never submit a
  replacement generation merely because a URL expired.
- Apply request deadlines, response/download size limits and abort propagation.
- Authenticate only API-origin requests. Redirects and signed URL origins are
  separate trust decisions and never receive the bearer token.

## Verification levels used in code and UI

1. `documented` — present in current public guide/OpenAPI.
2. `observed-read-only` — confirmed by an authorized account-safe GET, with
   date and sanitized evidence.
3. `fixture-tested` — covered by the local fake service only.
4. `recorded-result` — exact archived bytes from a prior real job, with identity
   and hashes.
5. `live-verified` — an explicitly authorized bounded integration test.
6. `local-backend` — produced by an explicitly selected, version-reported local
   adapter; not an Atlas job and never evidence of hosted or hardware execution.

No fixture-tested recipe is labelled live-verified.
