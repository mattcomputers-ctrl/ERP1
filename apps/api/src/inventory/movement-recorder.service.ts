import { Injectable } from '@nestjs/common';
import { Prisma } from '@erp1/db';
import { NATIVE_ID_BASE } from '../common/locks';

/**
 * Native InvMovement/InvMovementDtl emission — the movement ledger legs of
 * every ERP1 inventory write, in the legacy vocabulary so the movement,
 * at-date, shipment-detail and order-cost viewers keep working after cutover.
 *
 * Emission contract (distilled from the live legacy census, ASSUMPTIONS §20):
 * - ERP1 emits ON-HAND TRUTH ONLY: every Inventory qty change gets exactly one
 *   non-B leg whose Qty is the signed delta; value = qty × the lot's unit cost
 *   (4dp money) when known, NULL when not. B-suffixed WIP legs are never
 *   emitted — ERP1 has no vessel/WIP inventory model, and the validated
 *   at-date reconstruction sums only non-B legs, so this keeps the at-date
 *   view exactly equal to the Inventory trajectory.
 * - Header contexts stay inside the legacy set (PO/MISC/COUNT/TRNSFR/SH/
 *   CMNGL/PCKAGE/SAMPLE) — the movement viewer's type filter is a whitelist.
 *   Reversals keep the FORWARD context under the reversing change set
 *   (legacy idiom: PCKAGE movements under RVSMFP change sets).
 * - Legs of one event are written US-first with consecutive ids (legacy
 *   ordering); one or two legs per header, never more.
 *
 * Callers MUST hold NATIVE_ID_ALLOC_LOCK (ids are MAX+1 in the native range)
 * and, when they also lock parcels, take the advisory lock BEFORE the parcel
 * `FOR UPDATE` scan (the reverse() precedent) — adjust/transfer lock
 * advisory-then-parcels, so the opposite order is an ABBA deadlock.
 */
@Injectable()
export class MovementRecorderService {
  // Memoized data-driven stock owner (effectively constant per install).
  private ownerResolved = false;
  private ownerValue: number | null = null;

  /** Round to 4 decimals — the money scale of InvMovementDtl.Value. */
  money4(n: number): number {
    return Math.round(n * 10000) / 10000;
  }

  /**
   * The install's default stock owner for movement legs (Owner is NOT NULL on
   * every leg). Data-driven like the recipe editor's default owner: the modal
   * Owner over the imported movement legs (the company entity — 4 in this
   * install, on >99% of legs), else the modal order owner, else the lowest
   * entity id. 0 only on an entity-less database (a sentinel, not an entity —
   * documented in ASSUMPTIONS §20).
   */
  async defaultOwnerId(tx: Prisma.TransactionClient): Promise<number> {
    if (this.ownerResolved) return this.ownerValue ?? 0;
    const modalLeg = await tx.$queryRaw<{ owner: number }[]>`
      SELECT "Owner" AS owner FROM "InvMovementDtl"
      GROUP BY "Owner" ORDER BY COUNT(*) DESC LIMIT 1`;
    let owner: number | null = modalLeg[0]?.owner ?? null;
    if (owner == null) {
      const modalOrdr = await tx.$queryRaw<{ owner: number }[]>`
        SELECT "Owner" AS owner FROM "Ordr" WHERE "Owner" IS NOT NULL
        GROUP BY "Owner" ORDER BY COUNT(*) DESC LIMIT 1`;
      owner = modalOrdr[0]?.owner ?? null;
    }
    if (owner == null) {
      const anyEntity = await tx.entity.findFirst({ orderBy: { id: 'asc' }, select: { id: true } });
      owner = anyEntity?.id ?? null;
    }
    this.ownerValue = owner;
    this.ownerResolved = true;
    return owner ?? 0;
  }

  /**
   * A native execution change set for one order event (a consume call, a
   * completion): the envelope its movements hang on, and the ONLY linkage the
   * complete-mf-orders cost lateral has (ChangeSet.Ordr). Context matches the
   * legacy vocabulary: MF for a batch (MFBA) execution, MFP for a packout
   * (MFPP). One change set PER EVENT, dated at the event — sharing one per
   * order would stamp every movement with the first consume's date and misdate
   * the at-date view (legacy's one-session model doesn't fit ERP1's
   * record-lines-over-days execution). Requires the native-id lock.
   */
  async createOrderChangeSet(
    tx: Prisma.TransactionClient,
    order: { id: number; context: string | null },
    changeDate: Date,
  ): Promise<number> {
    const context = order.context === 'MFPP' ? 'MFP' : 'MF';
    const csId =
      ((await tx.changeSet.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ??
        NATIVE_ID_BASE) + 1;
    await tx.changeSet.create({ data: { id: csId, context, ordrId: order.id, changeDate } });
    return csId;
  }

  /**
   * Per-lot unit cost for consumption leg values: the lot's own unitCost,
   * falling back to the item's purchase price — the SAME basis the produced-
   * cost roll-up uses, so an order's US leg values and its rolled-up produced
   * MK value are built from identical inputs.
   */
  async unitCostByLot(tx: Prisma.TransactionClient, lotCodes: string[]): Promise<Map<string, number | null>> {
    const codes = [...new Set(lotCodes)];
    if (!codes.length) return new Map();
    const lots = await tx.lot.findMany({ where: { lot: { in: codes } }, select: { lot: true, itemId: true, unitCost: true } });
    const itemIds = [...new Set(lots.map((l) => l.itemId).filter((v): v is number => v != null))];
    const items = itemIds.length
      ? await tx.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, purchasePrice: true } })
      : [];
    const priceByItem = new Map(items.map((i) => [i.id, i.purchasePrice != null ? Number(i.purchasePrice) : null]));
    return new Map(
      lots.map((l) => [
        l.lot,
        l.unitCost != null ? Number(l.unitCost) : l.itemId != null ? priceByItem.get(l.itemId) ?? null : null,
      ]),
    );
  }

  /**
   * Write movement headers + legs (native ids, MAX+1 under the caller-held
   * alloc lock). Legs are written in array order — pass the US leg first.
   */
  async record(tx: Prisma.TransactionClient, events: MovementEvent[]): Promise<void> {
    if (!events.length) return;
    let headerId =
      (await tx.invMovement.aggregate({ _max: { id: true }, where: { id: { gte: BigInt(NATIVE_ID_BASE) } } }))._max
        .id ?? BigInt(NATIVE_ID_BASE);
    let legId =
      (await tx.invMovementDtl.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ??
      NATIVE_ID_BASE;
    for (const ev of events) {
      headerId += 1n;
      await tx.invMovement.create({
        data: {
          id: headerId,
          context: ev.context,
          changeSetId: ev.changeSetId,
          itemId: ev.itemId ?? null,
          sublotId: ev.sublotId ?? null,
          // Stamped on SAMPLE movements (the legacy sample shape carries the
          // sublot's Hold release); null everywhere else.
          releaseId: ev.releaseId ?? null,
          step: null,
        },
      });
      for (const leg of ev.legs) {
        legId += 1;
        await tx.invMovementDtl.create({
          data: {
            id: legId,
            invMovementId: headerId,
            context: leg.context,
            ownerId: leg.ownerId,
            locationId: leg.locationId ?? null,
            ordDetailId: leg.ordDetailId ?? null,
            qty: leg.qty ?? null,
            value: leg.value ?? null,
          },
        });
      }
    }
  }
}

export interface MovementLeg {
  /** MK/US (qty legs) or MKCA/USCA (value-only legs, qty NULL). */
  context: 'MK' | 'US' | 'MKCA' | 'USCA';
  ownerId: number;
  locationId?: number | null;
  ordDetailId?: number | null;
  /** Signed quantity delta (NULL on *CA legs). */
  qty?: number | null;
  /** Signed 4dp money (qty × unit cost); NULL when the cost is unknown. */
  value?: number | null;
}

export interface MovementEvent {
  /** Header context — legacy vocabulary only (the viewer filter whitelist).
   * SAMPLE = the QC retained-sample draw (legacy: 25,416 movements, one per
   * sample set; ERP1 emits it at the completion sampling seam).
   * PICK = shipping-assembly staging (legacy: 41,299 movements, valueless
   * US-at-source / MK-at-ASM pairs, the MK leg carrying the reserved SH
   * line; unpick mirrors it with the signs flipped — ERP1 emits it at the
   * stage/unstage seams).
   * RVSSH = shipment reversal (legacy: 1,406 movements — unlike RVSMFP,
   * whose movements keep the forward PCKAGE context, shipment-reversal
   * movements carry the RVSSH context themselves; verified census). */
  context: 'PO' | 'MISC' | 'COUNT' | 'TRNSFR' | 'SH' | 'CMNGL' | 'PCKAGE' | 'SAMPLE' | 'PICK' | 'RVSSH';
  changeSetId: number;
  itemId?: number | null;
  sublotId?: number | null;
  /** The sublot's release — stamped on SAMPLE movements (legacy shape). */
  releaseId?: number | null;
  /** US leg first, MK second (legacy id ordering); 1–2 legs. */
  legs: MovementLeg[];
}
