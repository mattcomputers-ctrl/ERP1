import { Injectable } from '@nestjs/common';
import { Prisma } from '@erp1/db';
import { NATIVE_ID_BASE } from '../common/locks';
import { MovementRecorderService } from '../inventory/movement-recorder.service';
import { NotificationEngineService } from '../notifications/notification-engine.service';
import { formatSpec } from '../orders/order-format';

// kg → lb, the plant's universal stock unit (verified: every legacy sample draw
// is 0.005 kg stored as 0.011023113109243879 lb on the movement legs).
const KG_TO_LB = 2.2046226218487757;

/**
 * Native QA release + sample-set creation — the seam that lets ERP1-born
 * sublots enter the plant's daily QC loop (results → e-signed disposition →
 * CofA), which all key off `Sublot.releaseId`.
 *
 * Legacy reality this deliberately deviates from (live discovery 2026-07-09,
 * ASSUMPTIONS §21):
 * - Legacy RECEIPTS never created sublots, releases or sample sets (100% of
 *   ChangeSetReceipt rows carry no sublot); ERP1 receiving mints real sublots,
 *   so they get an Approved-at-birth release — QA-visible, never quarantined
 *   (matching the plant's actual receiving behavior).
 * - Legacy created the tested-item Hold release at ORDER RELEASE and the
 *   sample set at the IPT execution step (drawn from the batch VESSEL); ERP1
 *   has no vessel model and mints the produced sublot at COMPLETION, so both
 *   happen there — same loop, one seam later.
 * - Legacy Release is append-only history (disposition inserts a new row and
 *   flips the old to Context='HISTORY'); ERP1's shipped disposition updates in
 *   place, so exactly ONE release row per native sublot is created.
 * - Legacy froze specs into SampleSetTestSpec and inserted result rows at
 *   entry; ERP1 pre-creates the LocationSampleTest rows (the shape
 *   ReleasesService.enterResults updates) and evaluates pass/fail against the
 *   CURRENT ItemTest spec.
 *
 * Every method runs inside the CALLER's transaction, which must already hold
 * NATIVE_ID_ALLOC_LOCK (all four seams do). Notification emission happens here
 * (inside the tx, lock already held) — callers audit afterwards.
 */
@Injectable()
export class SamplingService {
  constructor(
    private readonly movements: MovementRecorderService,
    private readonly notifications: NotificationEngineService,
  ) {}

  private async nextId(tx: Prisma.TransactionClient, delegate: 'release' | 'sampleSet' | 'locationSampleTest' | 'location' | 'inventory'): Promise<number> {
    // All five delegates share the same int-id native-range MAX+1 shape; the
    // per-model aggregate types don't unify, hence the unknown hop.
    const agg = await (tx[delegate] as unknown as { aggregate: (args: object) => Promise<{ _max: { id: number | null } }> }).aggregate({
      _max: { id: true },
      where: { id: { gte: NATIVE_ID_BASE } },
    });
    return (agg._max.id ?? NATIVE_ID_BASE) + 1;
  }

  /**
   * Approved-at-birth release for a native sublot (receiving / misc receipt /
   * lot-enablement seams — and untested products at completion). Idempotent:
   * a sublot that already carries a release is left alone (returns null).
   */
  async createApprovedRelease(
    tx: Prisma.TransactionClient,
    opts: { sublotId: number; actorLabel: string | null; at: Date },
  ): Promise<{ releaseId: number } | null> {
    const sub = await tx.sublot.findUnique({ where: { id: opts.sublotId }, select: { releaseId: true } });
    if (!sub || sub.releaseId != null) return null;
    const releaseId = await this.nextId(tx, 'release');
    await tx.release.create({
      data: {
        id: releaseId,
        sublotId: opts.sublotId,
        status: 'Approved',
        grade: 'GMP',
        releaseDate: opts.at,
        releasedBy: opts.actorLabel,
        context: 'CURRENT',
      },
    });
    await tx.sublot.update({ where: { id: opts.sublotId }, data: { releaseId } });
    return { releaseId };
  }

  /**
   * Completion seam: a product WITH ItemTest rows gets a Hold release + a
   * sample set (retained-sample stock split off the produced parcel, result
   * rows pre-created, 'New Sample set' notification); a product without tests
   * gets the Approved-at-birth release. Returns what was created so the caller
   * can audit + report it.
   */
  async createCompletionRelease(
    tx: Prisma.TransactionClient,
    opts: {
      sublotId: number;
      itemId: number;
      lot: string;
      ordrId: number;
      ordDetailId: number;
      iptOrdDetailId: number | null;
      /** The parcel completion just minted (null when no location to mint into). */
      producedParcel: { inventoryId: number; locationId: number | null; qty: number } | null;
      legOwner: number;
      actorLabel: string | null;
      at: Date;
    },
  ): Promise<
    | { releaseId: number; held: false }
    | { releaseId: number; held: true; sampleSetId: number; sampleLocationId: number; sampleQty: number; testCount: number }
    | null
  > {
    const sub = await tx.sublot.findUnique({ where: { id: opts.sublotId }, select: { releaseId: true, sublotCode: true } });
    if (!sub || sub.releaseId != null) return null;

    const specs = await tx.itemTest.findMany({
      where: { itemId: opts.itemId },
      orderBy: [{ line: 'asc' }, { id: 'asc' }],
      select: { test: true, qualifier: true, testGroup: true, min: true, max: true, specification: true },
    });
    if (!specs.length) {
      const approved = await this.createApprovedRelease(tx, opts);
      return approved ? { releaseId: approved.releaseId, held: false } : null;
    }

    // Hold release + sample set (the release carries the set id from birth —
    // ERP1's one-mutable-row model vs legacy's stamp-on-disposition-row).
    const releaseId = await this.nextId(tx, 'release');
    const sampleSetId = await this.nextId(tx, 'sampleSet');
    await tx.release.create({
      data: { id: releaseId, sublotId: opts.sublotId, sampleSetId, status: 'Hold', grade: 'HOLD', context: 'CURRENT' },
    });
    await tx.sublot.update({ where: { id: opts.sublotId }, data: { releaseId } });
    await tx.sampleSet.create({
      data: {
        id: sampleSetId,
        version: 0,
        sublotId: opts.sublotId,
        beingTested: false,
        grade: 'GMP',
        iptOrdDetailId: opts.iptOrdDetailId,
        isStability: false,
      },
    });

    // The per-sample SMP location. Native sample-container codes use their own
    // 'E'-prefixed namespace (E00001…) — NOT the legacy 6-digit sequence: the
    // legacy plant is still minting that sequence daily during parallel
    // running and its allocator cannot see native rows, so continuing it
    // guarantees silent code collisions via sync (2026-07-09 review; 'T'/'R'
    // prefixed sample codes are precedented in the legacy data pre-2013).
    // Parented at the imported BRECEIVE rack when present (legacy convention),
    // else wherever the stock was minted.
    const sampleLocationId = await this.nextId(tx, 'location');
    // Width-agnostic numeric max: after E99999 the sequence grows to E100000
    // and keeps counting — a fixed-width lexical MAX would stop seeing the
    // true max and mint duplicates forever (2026-07-09 staging review, same
    // pattern as the EA assembly allocator). padStart is a minimum width.
    const [seq] = await tx.$queryRaw<{ n: bigint | number | null }[]>`
      SELECT MAX(CAST(SUBSTRING("LocationCode" FROM 2) AS BIGINT)) AS n FROM "Location"
      WHERE "Context" = 'SMP' AND "LocationCode" ~ '^E[0-9]+$'`;
    const sampleCode = 'E' + String(Number(seq?.n ?? 0) + 1).padStart(5, '0');
    const rack = await tx.location.findFirst({
      where: { locationCode: 'BRECEIVE', context: 'LCN' },
      select: { id: true },
    });
    await tx.location.create({
      data: {
        id: sampleLocationId,
        locationCode: sampleCode,
        context: 'SMP',
        inLocationId: rack?.id ?? opts.producedParcel?.locationId ?? null,
      },
    });

    // Retained-sample stock: TestGroup.SampleSize (kg) converted to the item's
    // stock unit, split off the produced parcel into the SMP location. The
    // plant's groups are all 0.005 kg (ZEROQTY = 0 → record-only set). A
    // conversion we can't make (exotic item unit) or a missing parcel skips
    // the stock move — the set still exists and results are recordable.
    const groupNames = [...new Set(specs.map((s) => s.testGroup?.trim()).filter((g): g is string => !!g))];
    const groups = groupNames.length
      ? await tx.testGroup.findMany({ where: { testGroup: { in: groupNames } }, select: { sampleSize: true, unit: true } })
      : [];
    const sizeKg = groups.reduce((m, g) => Math.max(m, g.sampleSize ?? 0), 0);
    const item = await tx.item.findUnique({ where: { id: opts.itemId }, select: { unit: true } });
    const itemUnit = (item?.unit ?? 'lb').trim().toLowerCase();
    const wanted =
      sizeKg <= 0 ? 0
      : itemUnit === 'kg' ? sizeKg
      : itemUnit === 'lb' || itemUnit === 'lbs' ? sizeKg * KG_TO_LB
      : 0;
    let sampleQty = 0;
    if (wanted > 0 && opts.producedParcel && opts.producedParcel.qty > wanted) {
      sampleQty = wanted;
      await tx.inventory.update({
        where: { id: opts.producedParcel.inventoryId },
        data: { qty: opts.producedParcel.qty - sampleQty },
      });
      const sampleParcelId = await this.nextId(tx, 'inventory');
      await tx.inventory.create({
        data: { id: sampleParcelId, itemId: opts.itemId, sublotId: opts.sublotId, locationId: sampleLocationId, qty: sampleQty, status: null },
      });
      // One SAMPLE movement, paired qty legs, valueless (the legacy majority
      // shape — sample draws don't move ledger value; at-date qty stays exact).
      const csId =
        ((await tx.changeSet.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
      await tx.changeSet.create({ data: { id: csId, context: 'SAMPLE', ordrId: opts.ordrId, changeDate: opts.at } });
      await this.movements.record(tx, [{
        context: 'SAMPLE', changeSetId: csId, itemId: opts.itemId, sublotId: opts.sublotId, releaseId,
        legs: [
          { context: 'US', ownerId: opts.legOwner, locationId: opts.producedParcel.locationId, ordDetailId: opts.ordDetailId, qty: -sampleQty, value: null },
          { context: 'MK', ownerId: opts.legOwner, locationId: sampleLocationId, ordDetailId: opts.ordDetailId, qty: sampleQty, value: null },
        ],
      }]);
    }

    // Pre-create the result rows enterResults() updates — one per ItemTest
    // spec, untested (result/passed/testedTime NULL).
    let lstId = (await tx.locationSampleTest.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE;
    for (const s of specs) {
      await tx.locationSampleTest.create({
        data: {
          id: (lstId += 1),
          locationId: sampleLocationId,
          test: (s.test ?? '').trim() || 'TEST',
          qualifier: s.qualifier,
          version: 0,
          sampleSetId,
        },
      });
    }

    // UG §22.2.3 'New Sample set' — the install's configured rule #10
    // (SecurityGroup '*', no SendTo list). Emitted inside the tx, before the
    // caller's audit (the alloc lock is already held, so order is safe either
    // way — kept emit-first per convention 1b). The live rule template
    // references 16 more tokens (supplier/manufacturer/handling/skip/retest
    // family) — every one must be SUPPLIED (null renders blank; a missing key
    // renders as a raw '@Token', the house lesson from the receipt emitters);
    // @Table renders the set's test list.
    const itemRow = await tx.item.findUnique({
      where: { id: opts.itemId },
      select: { itemCode: true, description: true, altDescription: true, securityGroup: true, ownerId: true },
    });
    const lotRow = await tx.lot.findUnique({
      where: { lot: opts.lot },
      select: { supLot: true, manfLot: true, supplierId: true },
    });
    // Entity display names live on the address book (PartyService) — not worth
    // a resolver here: completion lots have no supplier, so these fill only in
    // hypothetical future seams. Blank renders as blank (never a raw @token).
    const supplier = lotRow?.supplierId != null
      ? await tx.entity.findUnique({ where: { id: lotRow.supplierId }, select: { entityCode: true } })
      : null;
    await this.notifications.emit(tx, 'New Sample set', {
      securityGroup: itemRow?.securityGroup,
      ownerId: itemRow?.ownerId,
      params: {
        Release: releaseId,
        ItemCode: itemRow?.itemCode,
        ItemDescription: itemRow?.description,
        ItemAltDescription: itemRow?.altDescription,
        Lot: opts.lot,
        Sublot: sub.sublotCode ?? opts.lot,
        SampleSet: sampleSetId,
        Ordr: opts.ordrId,
        SupplierCode: supplier?.entityCode ?? null,
        SupplierName: null,
        SupplierLot: lotRow?.supLot ?? null,
        ManufacturerCode: null,
        ManufacturerName: null,
        ManufacturerLot: lotRow?.manfLot ?? null,
        HandlingCode: null,
        HandlingCodeDescription: null,
        MaxSkipCount: null,
        MaxSkipDays: null,
        Skip: null,
        LastFullTest: null,
        ReduceTesting: null,
        PreviousLot: null,
        PreviousText: null,
      },
      table: {
        columns: ['Test', 'Specification'],
        rows: specs.map((s) => [s.test ?? '', formatSpec(s.min ?? null, s.max ?? null, s.specification ?? null)]),
      },
      links: { Lot: `/lot-tracking?focus=${encodeURIComponent(opts.lot)}` },
    });

    return { releaseId, held: true, sampleSetId, sampleLocationId, sampleQty, testCount: specs.length };
  }
}
