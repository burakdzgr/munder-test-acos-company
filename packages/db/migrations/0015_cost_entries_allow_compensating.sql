-- 26 §1.1: "Append-only; corrections are compensating entries (negative
-- amount, `ref` pointing at the corrected entry) — never updates."
-- 0010 shipped CHECK (amount_cents >= 0), which makes that documented
-- correction path impossible to write. The doc outranks the code, so the
-- constraint goes; `cost_entries_kind_check` is untouched.
ALTER TABLE "cost_entries" DROP CONSTRAINT IF EXISTS "cost_entries_amount_check";
