import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@erp1/db';

/**
 * Declarative set-viewer platform (§18, UG ch.23). Legacy set viewers are
 * client-defined grids over vendor SQL views — no config tables exist — so
 * ERP1 declares each viewer here (columns/filters/query) and ONE generic
 * endpoint + ONE generic web grid serve them all.
 *
 * Every SQL fragment in this registry is a CODE CONSTANT composed with
 * Prisma.raw; only user-supplied VALUES are bound as parameters. Sort keys
 * resolve through the column whitelist, never raw input.
 *
 * The working set below is the plant's ACTUAL usage, ranked by legacy Log
 * counts (update-side; reads don't log — relative signal only). The ~40
 * never-used viewers are ⏸️ in FEATURE_PARITY.md with the same evidence.
 */

export type ViewerColumnType = 'string' | 'number' | 'qty' | 'money' | 'date' | 'datetime' | 'bool';

export interface ViewerColumn {
  key: string;
  header: string;
  type: ViewerColumnType;
  /** SQL expression (code constant). */
  expr: string;
  /** Sortable in the grid (default true). */
  sortable?: boolean;
  /**
   * Included in the free-text search ORs. Searchable expressions must live in
   * the base `from` (never `selectOnlyFrom`) — the COUNT query applies them.
   */
  searchable?: boolean;
}

export interface ViewerParamOption {
  value: string;
  label: string;
}

export interface ViewerParam {
  key: string;
  label: string;
  type: 'date' | 'text' | 'select';
  required?: boolean;
  /** Client-side initial value; 'today' resolves to the current date. */
  defaultValue?: string;
  options?: ViewerParamOption[];
  /** Condition builder; null = no condition for this value. */
  where: (value: string) => Prisma.Sql | null;
}

export interface ViewerDef {
  id: string;
  title: string;
  description: string;
  program: string;
  /** Legacy program name (provenance for the parity tracker). */
  legacyName: string;
  /** Legacy Log usage count (evidence). */
  usage: number;
  /** FROM + JOINs shared by the COUNT and rows queries. */
  from: string;
  /** Extra joins (entity-name laterals etc.) only the rows query needs. */
  selectOnlyFrom?: string;
  /** Static conditions (ANDed with params/search). */
  baseWhere?: string;
  groupBy?: string;
  having?: string;
  /** 'columnKey:asc|desc' */
  defaultSort: string;
  /** Unique tiebreak expression appended to every ORDER BY (stable paging). */
  rowKeyExpr: string;
  columns: ViewerColumn[];
  params?: ViewerParam[];
}

// ---------------------------------------------------------------------------
// Param helpers
// ---------------------------------------------------------------------------

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' + n days, computed in UTC (plant wall-clock convention). */
function ymdAddDays(ymd: string, days: number): string {
  const d = new Date(ymd + 'T00:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Date-range condition against a timestamp expression. Legacy datetimes are
 * plant wall-clock stored as UTC digits, so bounds compare against UTC-digit
 * midnights: `from` is inclusive of the day, `to` is exclusive of the NEXT
 * day's midnight (i.e. inclusive of the whole `to` day).
 */
const dateParam = (expr: string, bound: 'from' | 'to') => (value: string): Prisma.Sql => {
  const v = value.trim();
  // Shape AND calendar validity: '2026-02-31' passes the regex but must 400
  // here, not surface as a Postgres cast failure (500). The Date round-trip
  // rejects rolled-over dates; the year cap keeps ymdAddDays inside the
  // 4-digit ISO range.
  const d = new Date(v + 'T00:00:00.000Z');
  if (!YMD.test(v) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v || d.getUTCFullYear() > 8999) {
    throw new BadRequestException(`Invalid date '${value}' — expected a real YYYY-MM-DD date`);
  }
  return bound === 'from'
    ? Prisma.sql`${Prisma.raw(expr)} >= ${v}::timestamp`
    : Prisma.sql`${Prisma.raw(expr)} < ${ymdAddDays(v, 1)}::timestamp`;
};

/** Select param mapping each allowed value to a static condition (null = all). */
const selectParam = (map: Record<string, string | null>) => (value: string): Prisma.Sql | null => {
  if (!(value in map)) {
    throw new BadRequestException(`Invalid value '${value}' — expected one of: ${Object.keys(map).join(', ')}`);
  }
  const sql = map[value];
  return sql == null ? null : Prisma.sql`${Prisma.raw(`(${sql})`)}`;
};

/** Escape ILIKE metacharacters so user text matches literally. */
export const escapeLike = (v: string) => v.replace(/[\\%_]/g, '\\$&');

/** Case-insensitive contains on a text expression (literal match). */
const ilikeParam = (expr: string) => (value: string): Prisma.Sql | null => {
  const v = value.trim();
  return v ? Prisma.sql`${Prisma.raw(expr)} ILIKE ${'%' + escapeLike(v) + '%'}` : null;
};

/**
 * Entity display name: legacy keeps names on the Main address
 * (AddressReference -> Address.Name), not on Entity itself.
 */
const entityNameLateral = (alias: string, entityIdExpr: string) => `
  LEFT JOIN LATERAL (
    SELECT a."Name" AS name FROM "AddressReference" ar
    JOIN "Address" a ON a."Address" = ar."Address"
    WHERE ar."TableName" = 'Entity' AND ar."TableID" = ${entityIdExpr}
    ORDER BY CASE WHEN lower(ar."Reference") = 'main' THEN 0 ELSE 1 END, ar."Address"
    LIMIT 1
  ) ${alias} ON true`;

// Recurring price arithmetic (OrdDetailPricing): the by-package trap — a
// package-priced line divides by the package quantity; EntityQuantity of 0/NULL
// counts as 1 (the 864x lesson from §13 applies unchanged here).
const UNIT_PRICE =
  `(dtl."Price"::numeric
    * CASE WHEN odp."PriceByPackage" = true THEN 1
           WHEN odp."PkgType" IS NOT NULL AND COALESCE(odp."EntityQuantity", 0) <> 0 THEN odp."EntityQuantity"
           ELSE 1 END
    / COALESCE(NULLIF(odp."QtyPerEntityQty", 0), 1))`;

const LINE_VALUE_FACTOR =
  `(dtl."Price"::numeric
    * CASE WHEN odp."PriceByPackage" = true THEN 1 ELSE COALESCE(odp."EntityQuantity", 1) END
    / COALESCE(NULLIF(odp."QtyPerEntityQty", 0), 1))`;

// Committed = own committed qty + positive allocation edges (the same formula
// the legacy open-detail views inline). Uncommitted: GetUncommittedQty is an
// encrypted vendor function — reconstructed as open balance minus committed,
// floored at zero (ASSUMPTIONS §18).
const COMMITTED =
  `(COALESCE(dtl."QtyCommitted", 0)
    + COALESCE((SELECT SUM(oc."Qty") FROM "OrdDetailCommit" oc
                WHERE oc."OrdDetail" = dtl."OrdDetail" AND oc."Qty" > 0), 0))`;
const UNCOMMITTED =
  `GREATEST(COALESCE(dtl."QtyReqd", 0) - COALESCE(dtl."QtyUsed", 0) - ${COMMITTED}, 0)`;

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const VIEWERS: ViewerDef[] = [
  {
    id: 'shipment-detail',
    title: 'Shipment Detail',
    description: 'Every shipped line: item, quantities, price, cost, customer and invoice linkage.',
    program: 'viewers.shipmentDetail',
    legacyName: 'Shipment Detail Set Viewer',
    usage: 396,
    from: `
      FROM "InvMovementDtl" imd
      JOIN "InvMovement" im ON im."InvMovement" = imd."InvMovement" AND im."Context" = 'SH'
      JOIN "ChangeSet" cs ON cs."ChangeSet" = im."ChangeSet"
      JOIN "OrdDetail" dtl ON dtl."OrdDetail" = imd."OrdDetail"
      JOIN "Ordr" o ON o."Ordr" = dtl."Ordr"
      JOIN "Item" itm ON itm."Item" = im."Item"
      LEFT JOIN "OrdDetailPricing" odp ON odp."OrdDetail" = dtl."OrdDetail"
      LEFT JOIN "Item" pkg ON pkg."Item" = odp."PkgType"
      LEFT JOIN "ChangeSetShipment" css ON css."ChangeSet" = cs."ChangeSet"
      LEFT JOIN "Waybill" wb ON wb."Waybill" = css."Waybill" AND wb."Status" = 'CMP'
      LEFT JOIN "Entity" st ON st."Entity" = o."ShipTo"
      LEFT JOIN "Entity" bt ON bt."Entity" = o."BillTo"
      LEFT JOIN "Entity" sm ON sm."Entity" = o."Salesman"
      LEFT JOIN "Trans" t ON t."Trans" = cs."Trans"`,
    selectOnlyFrom: entityNameLateral('stn', 'st."Entity"') + entityNameLateral('smn', 'sm."Entity"'),
    baseWhere: `imd."Context" IN ('US', 'USH')`,
    defaultSort: 'dateShipped:desc',
    rowKeyExpr: 'imd."InvMovementDtl"',
    columns: [
      { key: 'dateShipped', header: 'Shipped', type: 'datetime', expr: `COALESCE(wb."DateShipped", cs."ChangeDate")` },
      { key: 'ordr', header: 'Order', type: 'number', expr: `o."Ordr"`, searchable: true },
      { key: 'itemCode', header: 'Item', type: 'string', expr: `itm."ItemCode"`, searchable: true },
      { key: 'description', header: 'Description', type: 'string', expr: `itm."Description"`, searchable: true },
      { key: 'unit', header: 'Unit', type: 'string', expr: `itm."Unit"` },
      { key: 'qtyOrdered', header: 'Qty Ordered', type: 'qty', expr: `dtl."QtyReqd"` },
      { key: 'qtyShipped', header: 'Qty Shipped', type: 'qty', expr: `(-imd."Qty")` },
      { key: 'unitPrice', header: 'Unit Price', type: 'money', expr: UNIT_PRICE },
      { key: 'totalAmount', header: 'Total', type: 'money', expr: `(-imd."Qty" * ${LINE_VALUE_FACTOR})` },
      { key: 'unitCost', header: 'Unit Cost', type: 'money', expr: `(imd."Value"::numeric / NULLIF(imd."Qty", 0))` },
      { key: 'package', header: 'Package', type: 'string', expr: `pkg."ItemCode"` },
      { key: 'orderedQty', header: 'Ordered Qty', type: 'qty', expr: `(dtl."QtyReqd" / COALESCE(NULLIF(odp."QtyPerEntityQty", 0), 1))` },
      { key: 'orderedUnit', header: 'Ordered Unit', type: 'string', expr: `CASE WHEN odp."PkgType" IS NULL THEN odp."EntityUnit" ELSE pkg."ItemCode" END` },
      { key: 'shipTo', header: 'Ship To', type: 'string', expr: `st."EntityCode"`, searchable: true },
      { key: 'shipToName', header: 'Ship-To Name', type: 'string', expr: `stn.name`, sortable: false },
      { key: 'billTo', header: 'Bill To', type: 'string', expr: `bt."EntityCode"`, searchable: true },
      // Live on 98% of SH orders (review evidence 2026-07-08).
      { key: 'salesman', header: 'Salesman', type: 'string', expr: `sm."EntityCode"`, searchable: true },
      { key: 'salesmanName', header: 'Salesman Name', type: 'string', expr: `smn.name`, sortable: false },
      { key: 'dateOrdered', header: 'Ordered', type: 'datetime', expr: `o."DateOrdered"` },
      { key: 'dateRequired', header: 'Required', type: 'datetime', expr: `o."DateRequired"` },
      { key: 'placedBy', header: 'Placed By', type: 'string', expr: `o."PlacedBy"`, searchable: true },
      { key: 'poNumber', header: 'Customer PO', type: 'string', expr: `cs."PoNumber"`, searchable: true },
      { key: 'invoice', header: 'Invoice', type: 'string', expr: `t."TransDocument"`, searchable: true },
      { key: 'waybill', header: 'Waybill', type: 'number', expr: `css."Waybill"` },
      { key: 'changeSet', header: 'Shipment', type: 'number', expr: `cs."ChangeSet"` },
      { key: 'ordDetail', header: 'Line', type: 'number', expr: `dtl."OrdDetail"` },
      { key: 'comment', header: 'Comment', type: 'string', expr: `dtl."Comment"`, sortable: false },
    ],
    params: [
      { key: 'from', label: 'Shipped from', type: 'date', where: dateParam(`COALESCE(wb."DateShipped", cs."ChangeDate")`, 'from') },
      { key: 'to', label: 'Shipped to', type: 'date', where: dateParam(`COALESCE(wb."DateShipped", cs."ChangeDate")`, 'to') },
    ],
  },

  {
    id: 'open-shipping-order-detail',
    title: 'Open Shipping Order Detail',
    description: 'Open sales-order lines with balances, commitments and value.',
    program: 'viewers.openShippingOrderDetail',
    legacyName: 'Open Shipping Order Detail Set Viewer',
    usage: 290,
    from: `
      FROM "OrdDetail" dtl
      JOIN "Ordr" o ON o."Ordr" = dtl."Ordr" AND o."Context" = 'SH'
      JOIN "Item" itm ON itm."Item" = dtl."Item"
      LEFT JOIN "OrdDetailPricing" odp ON odp."OrdDetail" = dtl."OrdDetail"
      LEFT JOIN "Item" pkg ON pkg."Item" = odp."PkgType"
      LEFT JOIN "Entity" st ON st."Entity" = o."ShipTo"
      LEFT JOIN "Entity" bt ON bt."Entity" = o."BillTo"
      LEFT JOIN "Entity" sm ON sm."Entity" = o."Salesman"`,
    selectOnlyFrom: entityNameLateral('stn', 'st."Entity"'),
    baseWhere: `dtl."IsOpen" = true`,
    defaultSort: 'dateRequired:asc',
    rowKeyExpr: 'dtl."OrdDetail"',
    columns: [
      { key: 'ordr', header: 'Order', type: 'number', expr: `o."Ordr"`, searchable: true },
      { key: 'dateOrdered', header: 'Ordered', type: 'datetime', expr: `o."DateOrdered"` },
      { key: 'dateRequired', header: 'Required', type: 'datetime', expr: `o."DateRequired"` },
      { key: 'datePromised', header: 'Promised', type: 'datetime', expr: `dtl."DatePromised"` },
      { key: 'itemCode', header: 'Item', type: 'string', expr: `itm."ItemCode"`, searchable: true },
      { key: 'description', header: 'Description', type: 'string', expr: `itm."Description"`, searchable: true },
      { key: 'unit', header: 'Unit', type: 'string', expr: `itm."Unit"` },
      { key: 'qty', header: 'Qty', type: 'qty', expr: `dtl."QtyReqd"` },
      // Legacy divides by the item's default-unit BaseQty (ItemUnit is not
      // mirrored); the line's own packaging quantity is the per-line truth.
      { key: 'pkgCount', header: 'Pkgs', type: 'qty', expr: `ROUND((dtl."QtyReqd" / COALESCE(NULLIF(odp."QtyPerEntityQty", 0), 1))::numeric, 0)` },
      { key: 'complete', header: 'Complete', type: 'qty', expr: `dtl."QtyUsed"` },
      { key: 'balance', header: 'Balance', type: 'qty', expr: `(COALESCE(dtl."QtyReqd", 0) - COALESCE(dtl."QtyUsed", 0))` },
      { key: 'committed', header: 'Committed', type: 'qty', expr: COMMITTED },
      { key: 'uncommitted', header: 'Uncommitted', type: 'qty', expr: UNCOMMITTED },
      { key: 'shipTo', header: 'Ship To', type: 'string', expr: `st."EntityCode"`, searchable: true },
      { key: 'shipToName', header: 'Ship-To Name', type: 'string', expr: `stn.name`, sortable: false },
      { key: 'billTo', header: 'Bill To', type: 'string', expr: `bt."EntityCode"`, searchable: true },
      { key: 'salesman', header: 'Salesman', type: 'string', expr: `sm."EntityCode"`, searchable: true },
      { key: 'price', header: 'Price', type: 'money', expr: `dtl."Price"::numeric` },
      { key: 'value', header: 'Value', type: 'money', expr: `(COALESCE(dtl."QtyReqd", 0) * ${LINE_VALUE_FACTOR})` },
      { key: 'balanceValue', header: 'Balance Value', type: 'money', expr: `((COALESCE(dtl."QtyReqd", 0) - COALESCE(dtl."QtyUsed", 0)) * ${LINE_VALUE_FACTOR})` },
      { key: 'pricingUnit', header: 'Pricing Unit', type: 'string', expr: `CASE WHEN odp."PriceByPackage" = true THEN pkg."ItemCode" ELSE odp."EntityUnit" END` },
      { key: 'theirCode', header: 'Their Code', type: 'string', expr: `odp."EntityItemCode"`, searchable: true },
      { key: 'poNumber', header: 'Customer PO', type: 'string', expr: `o."PoNumber"`, searchable: true },
      { key: 'userHold', header: 'Hold', type: 'string', expr: `o."UserHold"` },
      { key: 'placedBy', header: 'Placed By', type: 'string', expr: `o."PlacedBy"` },
      { key: 'ordDetail', header: 'Line', type: 'number', expr: `dtl."OrdDetail"` },
      { key: 'comment', header: 'Comment', type: 'string', expr: `dtl."Comment"`, sortable: false },
    ],
  },

  {
    id: 'open-mf-order-detail',
    title: 'Open MF Order Detail',
    description: 'Open manufacturing-order ingredient (UI) and product (PK) lines with balances and commitments.',
    program: 'viewers.openMfOrderDetail',
    legacyName: 'Open Manufacturing Order Detail Set Viewer',
    usage: 153,
    from: `
      FROM "OrdDetail" dtl
      JOIN "Ordr" o ON o."Ordr" = dtl."Ordr" AND o."Context" IN ('MFBA', 'MFPK', 'MFPP')
      JOIN "Item" itm ON itm."Item" = dtl."Item"
      LEFT JOIN "Recipe" r ON r."Recipe" = o."Recipe"`,
    baseWhere: `dtl."IsOpen" = true AND dtl."Context" IN ('UI', 'PK')`,
    defaultSort: 'dateRequired:asc',
    rowKeyExpr: 'dtl."OrdDetail"',
    columns: [
      { key: 'ordr', header: 'Order', type: 'number', expr: `o."Ordr"`, searchable: true },
      { key: 'reference', header: 'Reference', type: 'string', expr: `o."Reference"`, searchable: true },
      { key: 'orderContext', header: 'Type', type: 'string', expr: `o."Context"` },
      { key: 'detail', header: 'Detail', type: 'string', expr: `dtl."Context"` },
      { key: 'status', header: 'Status', type: 'string', expr: `o."Status"` },
      { key: 'dateOrdered', header: 'Ordered', type: 'datetime', expr: `o."DateOrdered"` },
      { key: 'dateRequired', header: 'Required', type: 'datetime', expr: `o."DateRequired"` },
      { key: 'planStartDate', header: 'Plan Start', type: 'datetime', expr: `o."PlanStartDate"` },
      // Populated on 98% of open MF rows and differs from PlanStartDate on
      // most (review evidence 2026-07-08).
      { key: 'earliestStartDate', header: 'Earliest Start', type: 'datetime', expr: `o."EarliestStartDate"` },
      { key: 'dateReleased', header: 'Released', type: 'datetime', expr: `o."DateReleased"` },
      { key: 'recipeNumber', header: 'Recipe', type: 'string', expr: `r."RecipeNumber"`, searchable: true },
      { key: 'itemCode', header: 'Item', type: 'string', expr: `itm."ItemCode"`, searchable: true },
      { key: 'description', header: 'Description', type: 'string', expr: `itm."Description"`, searchable: true },
      { key: 'unit', header: 'Unit', type: 'string', expr: `itm."Unit"` },
      // UI/UB lines display negative (material consumed), PK positive — the
      // legacy sign convention.
      { key: 'qty', header: 'Qty', type: 'qty', expr: `(COALESCE(dtl."QtyReqd", 0) * CASE WHEN dtl."Context" IN ('UI', 'UB') THEN -1 ELSE 1 END)` },
      { key: 'balance', header: 'Balance', type: 'qty', expr: `((COALESCE(dtl."QtyReqd", 0) - COALESCE(dtl."QtyUsed", 0)) * CASE WHEN dtl."Context" IN ('UI', 'UB') THEN -1 ELSE 1 END)` },
      { key: 'committed', header: 'Committed', type: 'qty', expr: COMMITTED },
      { key: 'uncommitted', header: 'Uncommitted', type: 'qty', expr: UNCOMMITTED },
      { key: 'userHold', header: 'Hold', type: 'string', expr: `o."UserHold"` },
      { key: 'placedBy', header: 'Placed By', type: 'string', expr: `o."PlacedBy"` },
      { key: 'ordDetail', header: 'Line', type: 'number', expr: `dtl."OrdDetail"` },
    ],
    params: [
      {
        key: 'context', label: 'Order type', type: 'select', defaultValue: 'all',
        options: [
          { value: 'all', label: 'All' },
          { value: 'MFBA', label: 'Batching (MFBA)' },
          { value: 'MFPK', label: 'Packaging (MFPK)' },
          { value: 'MFPP', label: 'Packout (MFPP)' },
        ],
        where: selectParam({ all: null, MFBA: `o."Context" = 'MFBA'`, MFPK: `o."Context" = 'MFPK'`, MFPP: `o."Context" = 'MFPP'` }),
      },
      {
        key: 'detail', label: 'Line type', type: 'select', defaultValue: 'all',
        options: [
          { value: 'all', label: 'All' },
          { value: 'UI', label: 'Ingredients (UI)' },
          { value: 'PK', label: 'Products (PK)' },
        ],
        where: selectParam({ all: null, UI: `dtl."Context" = 'UI'`, PK: `dtl."Context" = 'PK'` }),
      },
    ],
  },

  {
    id: 'inventory-movement',
    title: 'Inventory Movement',
    description: 'Every stock movement: receipts, picks, packaging, commingles, counts, shipments — with lot and location.',
    program: 'viewers.inventoryMovement',
    legacyName: 'Inventory Movement Set Viewer',
    usage: 153,
    from: `
      FROM "InvMovementDtl" imd
      JOIN "InvMovement" im ON im."InvMovement" = imd."InvMovement"
      LEFT JOIN "ChangeSet" cs ON cs."ChangeSet" = im."ChangeSet"
      LEFT JOIN "Item" itm ON itm."Item" = im."Item"
      LEFT JOIN "Location" loc ON loc."Location" = imd."Location"
      LEFT JOIN "Entity" own ON own."Entity" = imd."Owner"
      LEFT JOIN "Ordr" o ON o."Ordr" = cs."Ordr"
      LEFT JOIN "Sublot" sl ON sl."Sublot" = im."Sublot"
      LEFT JOIN "Lot" lot ON lot."Lot" = sl."Lot"
      LEFT JOIN "Entity" mf ON mf."Entity" = lot."Manufacturer"
      LEFT JOIN "Release" rel ON rel."Release" = im."Release"`,
    defaultSort: 'id:desc',
    rowKeyExpr: 'imd."InvMovementDtl"',
    columns: [
      { key: 'id', header: '#', type: 'number', expr: `imd."InvMovementDtl"` },
      { key: 'changeDate', header: 'Date', type: 'datetime', expr: `cs."ChangeDate"` },
      { key: 'movement', header: 'Movement', type: 'string', expr: `im."Context"` },
      { key: 'detail', header: 'Detail', type: 'string', expr: `imd."Context"` },
      { key: 'itemCode', header: 'Item', type: 'string', expr: `itm."ItemCode"`, searchable: true },
      { key: 'description', header: 'Description', type: 'string', expr: `itm."Description"`, searchable: true },
      { key: 'qty', header: 'Qty', type: 'qty', expr: `imd."Qty"` },
      { key: 'unit', header: 'Unit', type: 'string', expr: `itm."Unit"` },
      { key: 'value', header: 'Value', type: 'money', expr: `imd."Value"::numeric` },
      { key: 'locationCode', header: 'Location', type: 'string', expr: `loc."LocationCode"`, searchable: true },
      { key: 'area', header: 'Area', type: 'string', expr: `own."EntityCode"` },
      { key: 'sublotCode', header: 'Sublot', type: 'string', expr: `sl."SublotCode"`, searchable: true },
      { key: 'lot', header: 'Lot', type: 'string', expr: `sl."Lot"`, searchable: true },
      { key: 'manufacturer', header: 'Manufacturer', type: 'string', expr: `mf."EntityCode"` },
      { key: 'releaseStatus', header: 'Release', type: 'string', expr: `rel."Status"` },
      { key: 'ordr', header: 'Order', type: 'number', expr: `cs."Ordr"`, searchable: true },
      { key: 'reference', header: 'Reference', type: 'string', expr: `o."Reference"`, searchable: true },
      { key: 'changeSet', header: 'ChangeSet', type: 'number', expr: `cs."ChangeSet"` },
    ],
    params: [
      {
        key: 'legs', label: 'Legs', type: 'select', defaultValue: 'stock',
        options: [
          { value: 'stock', label: 'Stock movements' },
          { value: 'wip', label: 'WIP legs (commingle)' },
          { value: 'all', label: 'All legs' },
        ],
        // The legacy InventoryMovements view's filter: on-hand legs only.
        // B-suffixed legs are commingled batch WIP.
        where: selectParam({
          stock: `imd."Context" IN ('MK', 'MKCA', 'US', 'USCA', 'ADJ', 'SCRAP')`,
          wip: `imd."Context" IN ('MKB', 'MKBCA', 'USB', 'USBCA')`,
          all: null,
        }),
      },
      {
        key: 'movement', label: 'Movement type', type: 'select', defaultValue: 'all',
        options: [
          { value: 'all', label: 'All' },
          { value: 'PO', label: 'Purchase receipt' },
          { value: 'MISC', label: 'Misc receipt' },
          { value: 'SH', label: 'Shipment' },
          { value: 'RVSSH', label: 'Shipment reversal' },
          { value: 'PCKAGE', label: 'Packaging' },
          { value: 'CMNGL', label: 'Commingle' },
          { value: 'PICK', label: 'Pick' },
          { value: 'TRNSFR', label: 'Transfer' },
          { value: 'COUNT', label: 'Count' },
          { value: 'SAMPLE', label: 'Sample' },
          { value: 'CA', label: 'Cost adjustment' },
          { value: 'RS', label: 'Return to supplier' },
        ],
        where: (value: string) => {
          const allowed = ['all', 'PO', 'MISC', 'SH', 'RVSSH', 'PCKAGE', 'CMNGL', 'PICK', 'TRNSFR', 'COUNT', 'SAMPLE', 'CA', 'RS'];
          if (!allowed.includes(value)) throw new BadRequestException(`Invalid movement type '${value}'`);
          return value === 'all' ? null : Prisma.sql`im."Context" = ${value}`;
        },
      },
      { key: 'from', label: 'From', type: 'date', where: dateParam(`cs."ChangeDate"`, 'from') },
      { key: 'to', label: 'To', type: 'date', where: dateParam(`cs."ChangeDate"`, 'to') },
    ],
  },

  {
    id: 'purchase-history',
    title: 'Purchase History',
    description: 'All purchase-order lines, open and closed, with supplier packaging and prices.',
    program: 'viewers.purchaseHistory',
    legacyName: 'Purchase History Set Viewer',
    usage: 61,
    from: `
      FROM "OrdDetail" dtl
      JOIN "Ordr" o ON o."Ordr" = dtl."Ordr"
      JOIN "Item" itm ON itm."Item" = dtl."Item"
      LEFT JOIN "OrdDetailPricing" odp ON odp."OrdDetail" = dtl."OrdDetail"
      LEFT JOIN "Item" pkg ON pkg."Item" = dtl."PkgType"
      LEFT JOIN "Entity" sup ON sup."Entity" = o."Entity"`,
    selectOnlyFrom: entityNameLateral('supn', 'sup."Entity"'),
    baseWhere: `dtl."Context" = 'PO'`,
    defaultSort: 'dateOrdered:desc',
    rowKeyExpr: 'dtl."OrdDetail"',
    columns: [
      { key: 'ordr', header: 'PO', type: 'number', expr: `o."Ordr"`, searchable: true },
      { key: 'dateOrdered', header: 'Ordered', type: 'datetime', expr: `o."DateOrdered"` },
      { key: 'supplier', header: 'Supplier', type: 'string', expr: `sup."EntityCode"`, searchable: true },
      { key: 'supplierName', header: 'Supplier Name', type: 'string', expr: `supn.name`, sortable: false },
      { key: 'itemCode', header: 'Item', type: 'string', expr: `itm."ItemCode"`, searchable: true },
      { key: 'description', header: 'Description', type: 'string', expr: `itm."Description"`, searchable: true },
      { key: 'pkgType', header: 'Pkg Type', type: 'string', expr: `pkg."ItemCode"` },
      // Supplier-facing quantity/price (PurchasedItem view formulas).
      { key: 'poQty', header: 'PO Qty', type: 'qty', expr: `(dtl."QtyReqd" / COALESCE(NULLIF(odp."QtyPerEntityQty", 0), 1) * COALESCE(NULLIF(odp."EntityQuantity", 0), 1))` },
      { key: 'poPrice', header: 'PO Price', type: 'money', expr: `(dtl."Price"::numeric / CASE WHEN COALESCE(odp."PriceByPackage", false) = false THEN 1 ELSE COALESCE(NULLIF(odp."EntityQuantity", 0), 1) END)` },
      { key: 'poUnit', header: 'PO Unit', type: 'string', expr: `CASE WHEN COALESCE(odp."EntityUnit", '') <> '' THEN odp."EntityUnit" ELSE itm."Unit" END` },
      { key: 'qty', header: 'Qty', type: 'qty', expr: `dtl."QtyReqd"` },
      { key: 'unitPrice', header: 'Unit Price', type: 'money', expr: UNIT_PRICE },
      { key: 'unit', header: 'Unit', type: 'string', expr: `itm."Unit"` },
      { key: 'theirCode', header: 'Their Code', type: 'string', expr: `odp."EntityItemCode"`, searchable: true },
      { key: 'isOpen', header: 'Open', type: 'bool', expr: `dtl."IsOpen"` },
      { key: 'ordDetail', header: 'Line', type: 'number', expr: `dtl."OrdDetail"` },
      { key: 'comment', header: 'Comment', type: 'string', expr: `dtl."Comment"`, sortable: false },
    ],
    params: [
      { key: 'from', label: 'Ordered from', type: 'date', where: dateParam(`o."DateOrdered"`, 'from') },
      { key: 'to', label: 'Ordered to', type: 'date', where: dateParam(`o."DateOrdered"`, 'to') },
      {
        key: 'open', label: 'Status', type: 'select', defaultValue: 'all',
        options: [
          { value: 'all', label: 'All' },
          { value: 'open', label: 'Open only' },
          { value: 'closed', label: 'Closed only' },
        ],
        where: selectParam({ all: null, open: `dtl."IsOpen" = true`, closed: `COALESCE(dtl."IsOpen", false) = false` }),
      },
    ],
  },

  {
    id: 'batching-order',
    title: 'Batching Orders',
    description: 'All batching (bulk manufacturing) orders with product, batch size and made quantity.',
    program: 'viewers.batchingOrder',
    legacyName: 'Batching Order Set Viewer',
    usage: 44,
    from: `
      FROM "Ordr" o
      LEFT JOIN "Entity" e ON e."Entity" = o."Owner"
      LEFT JOIN "Recipe" r ON r."Recipe" = o."Recipe"
      LEFT JOIN "OrdDetail" pk ON pk."Ordr" = o."Ordr" AND pk."Context" = 'PK'
      LEFT JOIN "Item" ipk ON ipk."Item" = pk."Item"`,
    baseWhere: `o."Context" IN ('MFBA', 'MFMB')`,
    defaultSort: 'ordr:desc',
    rowKeyExpr: 'o."Ordr"',
    columns: [
      { key: 'ordr', header: 'Order', type: 'number', expr: `o."Ordr"`, searchable: true },
      { key: 'reference', header: 'Reference', type: 'string', expr: `o."Reference"`, searchable: true },
      { key: 'status', header: 'Status', type: 'string', expr: `o."Status"` },
      { key: 'area', header: 'Area', type: 'string', expr: `e."EntityCode"` },
      { key: 'recipeNumber', header: 'Recipe', type: 'string', expr: `r."RecipeNumber"`, searchable: true },
      { key: 'itemCode', header: 'Item', type: 'string', expr: `ipk."ItemCode"`, searchable: true },
      { key: 'description', header: 'Description', type: 'string', expr: `ipk."Description"`, searchable: true },
      { key: 'unit', header: 'Unit', type: 'string', expr: `ipk."Unit"` },
      { key: 'qty', header: 'Qty', type: 'qty', expr: `pk."QtyReqd"` },
      { key: 'qtyMade', header: 'Qty Made', type: 'qty', expr: `pk."QtyUsed"` },
      { key: 'actualBatchSize', header: 'Batch Size', type: 'qty', expr: `o."ActualBatchSize"` },
      { key: 'dateOrdered', header: 'Ordered', type: 'datetime', expr: `o."DateOrdered"` },
      { key: 'dateRequired', header: 'Required', type: 'datetime', expr: `o."DateRequired"` },
      { key: 'planStartDate', header: 'Plan Start', type: 'datetime', expr: `o."PlanStartDate"` },
      { key: 'dateReleased', header: 'Released', type: 'datetime', expr: `o."DateReleased"` },
      { key: 'dateStarted', header: 'Started', type: 'datetime', expr: `o."DateStarted"` },
      { key: 'dateCompleted', header: 'Completed', type: 'datetime', expr: `o."DateCompleted"` },
      { key: 'userHold', header: 'Hold', type: 'string', expr: `o."UserHold"` },
      { key: 'placedBy', header: 'Placed By', type: 'string', expr: `o."PlacedBy"` },
      { key: 'revision', header: 'Rev', type: 'number', expr: `o."Revision"` },
      { key: 'leadTime', header: 'Lead Time', type: 'number', expr: `o."LeadTime"` },
      { key: 'comment', header: 'Comment', type: 'string', expr: `o."Comment"`, sortable: false },
    ],
    params: [
      {
        key: 'status', label: 'Status', type: 'select', defaultValue: 'all',
        options: [
          { value: 'all', label: 'All' },
          { value: 'open', label: 'Open' },
          { value: 'complete', label: 'Complete/Closed' },
        ],
        where: selectParam({
          all: null,
          open: `o."Status" NOT IN ('CMP', 'CLS', 'REJ')`,
          complete: `o."Status" IN ('CMP', 'CLS', 'REJ')`,
        }),
      },
    ],
  },

  {
    id: 'where-used',
    title: 'Where Used',
    description: 'Which active recipes use an ingredient, with per-yield quantities.',
    program: 'viewers.whereUsed',
    legacyName: 'Where Used Set Viewer',
    usage: 21,
    from: `
      FROM "RecipeDetail" rd
      JOIN "Recipe" r ON r."Recipe" = rd."Recipe" AND COALESCE(r."Inactive", false) = false
      JOIN "RecipeDetail" md ON md."Recipe" = r."Recipe" AND md."Context" = 'PK'
      JOIN "Item" mi ON mi."Item" = md."Item" AND COALESCE(mi."Status", '') = ''
      JOIN "Item" ing ON ing."Item" = rd."Item"
      LEFT JOIN "ItemPackagedProduct" ipp ON ipp."Recipe" = r."Recipe" AND r."Context" = 'RMPP'
      LEFT JOIN "Item" pp ON pp."Item" = ipp."PackagingPrototype"`,
    // Legacy shows removed-then-kept baseline lines; ERP1 revisions mark lines
    // inactive instead of deleting, so hide those.
    baseWhere: `rd."Context" IN ('UI', 'UAI') AND COALESCE(rd."Inactive", false) = false`,
    defaultSort: 'recipeNumber:asc',
    rowKeyExpr: 'rd."RecipeDetail"',
    columns: [
      { key: 'ingredientCode', header: 'Ingredient', type: 'string', expr: `ing."ItemCode"`, searchable: true },
      { key: 'ingredientDescription', header: 'Ingredient Description', type: 'string', expr: `ing."Description"`, searchable: true },
      { key: 'recipeNumber', header: 'Recipe', type: 'string', expr: `r."RecipeNumber"`, searchable: true },
      { key: 'recipeContext', header: 'Type', type: 'string', expr: `r."Context"` },
      { key: 'itemCode', header: 'Product', type: 'string', expr: `mi."ItemCode"`, searchable: true },
      { key: 'itemDescription', header: 'Product Description', type: 'string', expr: `mi."Description"`, searchable: true },
      { key: 'unit', header: 'Product Unit', type: 'string', expr: `mi."Unit"` },
      { key: 'ingQty', header: 'Qty per Yield Unit', type: 'qty', expr: `(rd."QtyReqd" / COALESCE(NULLIF(md."QtyReqd", 0), 1))` },
      { key: 'yield', header: 'Yield', type: 'qty', expr: `md."QtyReqd"` },
      { key: 'ingUnit', header: 'Ing. Unit', type: 'string', expr: `ing."Unit"` },
      { key: 'published', header: 'Published', type: 'bool', expr: `r."IsPublished"` },
      { key: 'rework', header: 'Rework', type: 'bool', expr: `r."Rework"` },
      { key: 'shared', header: 'Shared', type: 'bool', expr: `r."Shared"` },
      { key: 'packagingPrototype', header: 'Pkg Prototype', type: 'string', expr: `pp."ItemCode"` },
      { key: 'recipeDetail', header: 'Line', type: 'number', expr: `rd."RecipeDetail"` },
    ],
    params: [
      { key: 'ingredient', label: 'Ingredient code', type: 'text', where: ilikeParam(`ing."ItemCode"`) },
      {
        key: 'published', label: 'Published', type: 'select', defaultValue: 'all',
        options: [
          { value: 'all', label: 'All' },
          { value: 'published', label: 'Published only' },
        ],
        where: selectParam({ all: null, published: `COALESCE(r."IsPublished", false) = true` }),
      },
    ],
  },

  {
    id: 'inventory-at-date',
    title: 'Inventory At Date',
    description: 'On-hand quantity and value per item and area as of a chosen date, rebuilt from movement history.',
    program: 'viewers.inventoryAtDate',
    legacyName: 'Inventory Set Viewer (at date) / GetInventoryAtDate',
    usage: 21,
    // Validated live (2026-07-08): summing the non-WIP movement legs up to a
    // date reproduces the encrypted GetInventoryAtDate() exactly (Qty and
    // ActualValue; StandardValue is 0 on every row in this install and
    // ReplacementValue needs the vendor's current-cost lookup — both dropped,
    // ASSUMPTIONS §18).
    from: `
      FROM "InvMovementDtl" imd
      JOIN "InvMovement" im ON im."InvMovement" = imd."InvMovement"
      JOIN "ChangeSet" cs ON cs."ChangeSet" = im."ChangeSet"
      JOIN "Item" itm ON itm."Item" = im."Item"
      LEFT JOIN "Entity" own ON own."Entity" = imd."Owner"`,
    baseWhere: `imd."Context" IN ('MK', 'MKCA', 'US', 'USCA', 'ADJ', 'SCRAP')`,
    groupBy: `im."Item", itm."ItemCode", itm."Description", itm."GLGroup", itm."Unit", imd."Owner", own."EntityCode"`,
    having: `(ROUND(SUM(COALESCE(imd."Qty", 0))::numeric, 6) <> 0 OR COALESCE(SUM(imd."Value"::numeric), 0) <> 0)`,
    defaultSort: 'itemCode:asc',
    rowKeyExpr: 'MIN(imd."InvMovementDtl")',
    columns: [
      { key: 'area', header: 'Area', type: 'string', expr: `own."EntityCode"` },
      { key: 'itemCode', header: 'Item', type: 'string', expr: `itm."ItemCode"`, searchable: true },
      { key: 'description', header: 'Description', type: 'string', expr: `itm."Description"`, searchable: true },
      { key: 'glGroup', header: 'GL Group', type: 'string', expr: `itm."GLGroup"` },
      { key: 'unit', header: 'Unit', type: 'string', expr: `itm."Unit"` },
      { key: 'qty', header: 'Qty', type: 'qty', expr: `SUM(COALESCE(imd."Qty", 0))` },
      { key: 'actualValue', header: 'Value', type: 'money', expr: `SUM(imd."Value"::numeric)` },
    ],
    params: [
      // Inclusive of the whole asOf day (movements < next midnight, UTC-digit
      // plant convention).
      { key: 'asOf', label: 'As of', type: 'date', required: true, defaultValue: 'today', where: dateParam(`cs."ChangeDate"`, 'to') },
    ],
  },

  {
    id: 'complete-mf-orders',
    title: 'Complete MF Orders',
    description: 'Completed/closed manufacturing orders with made quantity, actual cost and packout lineage.',
    program: 'viewers.completeMfOrders',
    legacyName: 'Complete Manufacturing Orders Set Viewer',
    usage: 14,
    from: `
      FROM "Ordr" o
      JOIN "OrdDetail" pk ON pk."Ordr" = o."Ordr" AND pk."Context" = 'PK'
      JOIN "Item" itm ON itm."Item" = pk."Item"
      LEFT JOIN "Entity" e ON e."Entity" = o."Owner"
      LEFT JOIN "Recipe" r ON r."Recipe" = o."Recipe"`,
    // Laterals: first produced sublot; bulk source via the packout commit edge
    // (MFPP-UI <- MFBA-PK); actual cost = the order's MK/MKCA/MKB/MKBCA
    // movement values (validated 12/12 exact against the encrypted
    // GetQtyMade() on live data, 2026-07-08).
    selectOnlyFrom: `
      LEFT JOIN LATERAL (
        SELECT sl."SublotCode" AS sublot_code
        FROM "Lot" l JOIN "Sublot" sl ON sl."Lot" = l."Lot"
        WHERE l."OrdDetail" = pk."OrdDetail"
        ORDER BY sl."Sublot" LIMIT 1
      ) fsl ON true
      LEFT JOIN LATERAL (
        SELECT bo."Ordr" AS bulk_ordr, bitm."ItemCode" AS bulk_item
        FROM "OrdDetail" ui
        JOIN "OrdDetailCommit" oc ON oc."OrdDetail" = ui."OrdDetail"
        JOIN "OrdDetail" src ON src."OrdDetail" = oc."SrcOrdDetail"
        JOIN "Ordr" bo ON bo."Ordr" = src."Ordr" AND bo."Context" IN ('MFBA', 'MFMB')
        JOIN "Item" bitm ON bitm."Item" = src."Item"
        WHERE ui."Ordr" = o."Ordr" AND ui."Context" IN ('UI', 'UB')
        ORDER BY oc."OrdDetailCommit" LIMIT 1
      ) bulk ON true
      LEFT JOIN LATERAL (
        SELECT SUM(d."Value"::numeric) AS made_value
        FROM "ChangeSet" c
        JOIN "InvMovement" m ON m."ChangeSet" = c."ChangeSet"
        JOIN "InvMovementDtl" d ON d."InvMovement" = m."InvMovement"
          AND d."Context" IN ('MK', 'MKCA', 'MKB', 'MKBCA')
        WHERE c."Ordr" = o."Ordr"
      ) mv ON true`,
    baseWhere: `o."Parent" IS NULL AND o."Context" IN ('MFMB', 'MFBA', 'MFPK', 'MFPP') AND o."Status" IN ('CMP', 'CLS', 'REJ')`,
    defaultSort: 'dateCompleted:desc',
    rowKeyExpr: 'o."Ordr"',
    columns: [
      { key: 'ordr', header: 'Order', type: 'number', expr: `o."Ordr"`, searchable: true },
      { key: 'context', header: 'Type', type: 'string', expr: `o."Context"` },
      { key: 'reference', header: 'Reference', type: 'string', expr: `o."Reference"`, searchable: true },
      { key: 'status', header: 'Status', type: 'string', expr: `o."Status"` },
      { key: 'area', header: 'Area', type: 'string', expr: `e."EntityCode"` },
      { key: 'recipeNumber', header: 'Recipe', type: 'string', expr: `r."RecipeNumber"`, searchable: true },
      { key: 'itemCode', header: 'Item', type: 'string', expr: `itm."ItemCode"`, searchable: true },
      { key: 'description', header: 'Description', type: 'string', expr: `itm."Description"`, searchable: true },
      { key: 'unit', header: 'Unit', type: 'string', expr: `itm."Unit"` },
      { key: 'dateCompleted', header: 'Completed', type: 'datetime', expr: `o."DateCompleted"` },
      { key: 'dateOrdered', header: 'Ordered', type: 'datetime', expr: `o."DateOrdered"` },
      { key: 'dateStarted', header: 'Started', type: 'datetime', expr: `o."DateStarted"` },
      { key: 'actualBatchSize', header: 'Batch Size', type: 'qty', expr: `o."ActualBatchSize"` },
      { key: 'qtyMade', header: 'Qty Made', type: 'qty', expr: `pk."QtyUsed"` },
      { key: 'actualCost', header: 'Actual Cost', type: 'money', expr: `mv.made_value` },
      { key: 'unitActualCost', header: 'Unit Cost', type: 'money', expr: `(mv.made_value / NULLIF(pk."QtyUsed", 0))` },
      { key: 'sublot', header: 'Sublot', type: 'string', expr: `fsl.sublot_code` },
      { key: 'bulkOrder', header: 'Bulk Order', type: 'number', expr: `CASE WHEN o."Context" IN ('MFBA', 'MFMB') THEN o."Ordr" ELSE bulk.bulk_ordr END` },
      { key: 'bulkItem', header: 'Bulk Item', type: 'string', expr: `CASE WHEN o."Context" IN ('MFBA', 'MFMB') THEN itm."ItemCode" ELSE bulk.bulk_item END` },
      { key: 'placedBy', header: 'Placed By', type: 'string', expr: `o."PlacedBy"` },
    ],
    params: [
      { key: 'from', label: 'Completed from', type: 'date', where: dateParam(`o."DateCompleted"`, 'from') },
      { key: 'to', label: 'Completed to', type: 'date', where: dateParam(`o."DateCompleted"`, 'to') },
      {
        key: 'context', label: 'Order type', type: 'select', defaultValue: 'all',
        options: [
          { value: 'all', label: 'All' },
          { value: 'MFBA', label: 'Batching (MFBA)' },
          { value: 'MFPK', label: 'Packaging (MFPK)' },
          { value: 'MFPP', label: 'Packout (MFPP)' },
        ],
        where: selectParam({ all: null, MFBA: `o."Context" = 'MFBA'`, MFPK: `o."Context" = 'MFPK'`, MFPP: `o."Context" = 'MFPP'` }),
      },
    ],
  },
];

export const viewerById = new Map(VIEWERS.map((v) => [v.id, v]));
