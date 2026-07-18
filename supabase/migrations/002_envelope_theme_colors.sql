-- Theme remake ("cozy dark" → "midnight violet", 2026-07-18).
-- Recolor envelopes still carrying the old seeded defaults; rows a user
-- customized (none can exist yet — Settings ships in a later phase) are
-- untouched because we match on the exact old default hex.
update public.envelopes set color = '#B49BF5' where color = '#E4A44C'; -- Needs:   honey  → violet
update public.envelopes set color = '#93CFA9' where color = '#A8C29A'; -- Savings: sage   → mint
update public.envelopes set color = '#EFA9D6' where color = '#C4A9D1'; -- Wants:   lilac  → orchid
