-- Shipment reversal (L60): link each shipment_lot row to its shipment event
-- (the native SH ChangeSet = the packing slip) and mark reversed rows instead
-- of deleting them (legacy keeps the rejected waybill as Status='REJ').
ALTER TABLE "shipment_lot" ADD COLUMN "change_set" INTEGER;
ALTER TABLE "shipment_lot" ADD COLUMN "reversed_by_change_set" INTEGER;

-- Backfill: the forward ship path stamps the SH ChangeSet's ChangeDate with
-- the same value as shipment_lot.shipped_at, so (ordr, date) identifies the
-- event — but ONLY when the match is unambiguous (two ship events recorded
-- with the same explicit ship date would tie; an arbitrary pick could unwind
-- the wrong event on reversal). Ambiguous rows stay NULL and their events
-- refuse reversal ("predates the reversal upgrade") instead of half-reversing.
UPDATE "shipment_lot" sl
SET "change_set" = m.cs
FROM (
  SELECT sl2."id" AS slid, MIN(cs."ChangeSet") AS cs
  FROM "shipment_lot" sl2
  JOIN "ChangeSet" cs
    ON cs."Context" = 'SH'
   AND cs."Ordr" = sl2."ordr"
   AND cs."ChangeDate" = sl2."shipped_at"
  GROUP BY sl2."id"
  HAVING COUNT(*) = 1
) m
WHERE sl."id" = m.slid AND sl."change_set" IS NULL;

CREATE INDEX "shipment_lot_change_set_idx" ON "shipment_lot"("change_set");
