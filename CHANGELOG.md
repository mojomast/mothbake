# Changelog

## Unreleased — 2026-09-24 integration pass

- Added a dependency-free `raw-grid` baker and an offline synthetic example to
  export measured numeric grids without image-oriented rescaling or implicit
  probability normalization.
- Unknown requested modes now remain `null` in generated provenance instead of
  the old invented `"emu"` default. Existing explicitly configured modes and
  records are unchanged. Consumers must not interpret the requested mode or
  manifest credit estimate as confirmed execution backend or billing.
- Bounded remote response/download and ZIP extraction limits protect offline
  and live processing from oversized or corrupt data; large legitimate assets
  may require adjusting the documented limits.
- Documented dated integration observations and their limits separately from
  service contracts; source artifacts remain private and are not packaged.

No release or public publication has been made from this branch.
