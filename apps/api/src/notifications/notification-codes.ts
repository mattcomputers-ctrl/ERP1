// The notification-code catalog (vendor UG ch.22 §22.2). Legacy CMS hardcodes
// this list in the client's drop-down; ERP1 defines it here. `code` strings are
// VERBATIM what this install's 14 configured Notification rows carry (verified
// live — e.g. the rule row says 'MFO Created Notification' although the UG
// prose calls it 'Manufacturing Order Created Notification'), because the
// engine matches rules by exact code.
//
// `wired: true` = ERP1 natively emits this code at the equivalent seam.
// `wired: false` = the code is offered for configuration (imports keep any
// legacy rule rows) but nothing in ERP1 fires it yet — `note` says why.

export interface NotificationCodeDef {
  code: string;
  category:
    | 'Container'
    | 'Item'
    | 'Lot/Sublot'
    | 'Order'
    | 'Planning'
    | 'Receipt'
    | 'Resource'
    | 'Workflow'
    | 'Other';
  description: string;
  /** @Field placeholders available in Subject/Text templates. */
  params: string[];
  wired: boolean;
  note?: string;
}

const ORDER_PARAMS = [
  'Area', 'Ordr', 'Context', 'ItemCode', 'ItemDescription', 'AltDescription', 'Unit',
  'RecipeNumber', 'QtyReqd', 'PlanStartDate', 'DateScheduled', 'UserHold', 'PlacedBy',
];

const RECEIPT_PARAMS = [
  'Area', 'Ordr', 'PONumber', 'Receipt', 'Item', 'Description', 'AltDescription',
  'Supplier', 'SupName', 'SupLot', 'Manufacturer', 'ManfName', 'ManfLot', 'Lot', 'Sublot',
];

export const NOTIFICATION_CODES: NotificationCodeDef[] = [
  // --- Container --------------------------------------------------------------
  {
    code: 'Container Reconciliation failure', category: 'Container',
    description: 'Reconciliation failed on disposal of a container for an item with a container reconciliation tolerance.',
    params: ['Container', 'ItemCode', 'Description', 'Lot'], wired: false,
    note: 'No item in this install has a reconciliation tolerance configured (verified live: 0 rows).',
  },
  {
    code: 'Illegally Placed Notification', category: 'Container',
    description: 'An area has one or more illegally placed containers (legacy overnight procedure).',
    params: ['Area', 'Table'], wired: false, note: 'ERP1 has no container-placement rules module.',
  },
  {
    code: 'Label Required Notification', category: 'Container',
    description: 'The last label printed for a container shows details that have since changed (legacy overnight procedure).',
    params: ['Area'], wired: false, note: 'ERP1 has no container-label print tracking.',
  },
  {
    code: 'Reweigh Outside Threshold', category: 'Container',
    description: 'An inventory quantity was adjusted by more than the configured reweigh threshold (inventory.reweighThreshold setting).',
    params: ['Container', 'Adjustment', 'ReweighThreshold', 'MaxVariance', 'OriginalQty', 'Unit', 'ItemCode', 'Description', 'Lot'],
    wired: true,
  },
  {
    code: 'Tare Correction Required', category: 'Container',
    description: 'Empty containers flagged tare-correction-required (legacy overnight procedure).',
    params: ['Area', 'Table'], wired: false, note: 'ERP1 has no per-container tare tracking.',
  },

  // --- Item -------------------------------------------------------------------
  {
    code: 'Item Api/Drug is changed', category: 'Item',
    description: 'The API or Drug field changed on an item.',
    params: ['ItemCode', 'Description'], wired: false, note: 'ERP1 does not mirror the API/Drug item fields (unused in this install).',
  },
  {
    code: 'Item Pending Disposal', category: 'Item',
    description: "An item was created with (or changed to) disposal group 'Pending'.",
    params: ['ItemCode', 'Description'], wired: false, note: 'ERP1 does not mirror disposal groups (unused in this install).',
  },
  {
    code: 'New Item Notification', category: 'Item',
    description: 'A new item was created.',
    params: ['ItemCode', 'Description'], wired: true,
  },

  // --- Lot / Sublot -------------------------------------------------------------
  {
    code: 'Lot Reconciliation', category: 'Lot/Sublot',
    description: 'Reconciliation failed on an exhausted lot for an item with a lot reconciliation tolerance (legacy overnight procedure).',
    params: ['ItemCode', 'Description', 'Lot'], wired: false,
    note: 'No item in this install has a reconciliation tolerance configured (verified live: 0 rows).',
  },
  {
    code: 'New Sample set', category: 'Lot/Sublot',
    description: 'A new QA sample set was created (receipt / batch execution of a tested item).',
    params: ['Release', 'ItemCode', 'ItemDescription', 'ItemAltDescription', 'Lot', 'Sublot', 'SupplierCode', 'SupplierName', 'SupplierLot', 'ManufacturerCode', 'ManufacturerName', 'ManufacturerLot', 'HandlingCode', 'HandlingCodeDescription'],
    wired: false, note: 'ERP1 does not create sample sets natively yet (QA release rows come from the legacy import; disposition mutates them).',
  },
  {
    code: 'QA Cancel', category: 'Lot/Sublot',
    description: 'A QA sample set was cancelled.',
    params: ['Release', 'ItemCode', 'Lot', 'Sublot'], wired: false, note: 'ERP1 has no sample-set cancel action.',
  },
  {
    code: 'Reduce Testing Toggled', category: 'Lot/Sublot',
    description: 'A QA sample set had Reduce Testing toggled.',
    params: ['Release', 'ItemCode', 'Lot', 'Sublot'], wired: false, note: 'ERP1 has no reduce-testing flag.',
  },
  {
    code: 'Release Sublot Notification', category: 'Lot/Sublot',
    description: 'A sublot was approved or rejected (QA disposition).',
    params: ['Release', 'ItemCode', 'ItemDescription', 'Lot', 'Sublot', 'Status', 'Grade', 'ReleasedBy'],
    wired: true,
  },
  {
    code: 'Stability Test Required', category: 'Lot/Sublot',
    description: 'Stability testing is required for a sublot.',
    params: ['ItemCode', 'Lot', 'Sublot'], wired: false, note: 'ERP1 has no stability-testing module (unused in this install).',
  },
  {
    code: 'Stability Test Scheduled Notification', category: 'Lot/Sublot',
    description: 'A stability test was scheduled (legacy overnight procedure).',
    params: ['ItemCode', 'Lot', 'Sublot'], wired: false, note: 'ERP1 has no stability-testing module (unused in this install).',
  },
  {
    code: 'Stability Tests Completed Notification', category: 'Lot/Sublot',
    description: 'Stability tests for a sublot completed.',
    params: ['ItemCode', 'Lot', 'Sublot'], wired: false, note: 'ERP1 has no stability-testing module (unused in this install).',
  },
  {
    code: 'Testing Required Notification', category: 'Lot/Sublot',
    description: 'Testing is required for sublots that planning needs to complete orders (plan-trace status Retest).',
    params: ['Area', 'Table'], wired: true,
  },
  {
    code: 'Tests Completed Notification', category: 'Lot/Sublot',
    description: 'All tests for a sublot are complete or bypassed (sent by Enter Test Results).',
    params: ['Release', 'ItemCode', 'ItemDescription', 'Lot', 'Sublot'],
    wired: true,
  },

  // --- Order --------------------------------------------------------------------
  {
    code: 'ESD Notification', category: 'Order',
    description: 'Orders whose earliest start date is after their planned start date (legacy overnight procedure).',
    params: ['Area', 'Table'], wired: false, note: 'The native plan engine does not compute earliest start dates.',
  },
  {
    code: 'MFO Created Notification', category: 'Order',
    description: 'A manufacturing order was created or edited (the one notification this install actually used — 516 e-mails in 2022).',
    params: ORDER_PARAMS, wired: true,
  },
  {
    code: 'Manufacturing Order Released Notification', category: 'Order',
    description: 'A manufacturing order was released.',
    params: ORDER_PARAMS, wired: true,
  },
  {
    code: 'Mark Manufacturing Order Complete', category: 'Order',
    description: 'A manufacturing order was marked complete.',
    params: ORDER_PARAMS, wired: true,
  },
  {
    code: 'Order Edit Publish Notification', category: 'Order',
    description: 'A released-order revision (order edit) was published.',
    params: [...ORDER_PARAMS, 'Revision'], wired: true,
  },

  // --- Planning -------------------------------------------------------------------
  {
    code: 'Inventory Expedite Notification', category: 'Planning',
    description: 'Planning identified inbound supply that arrives later than orders need it (late MF#/PO# plan rows).',
    params: ['Area', 'Table'], wired: true,
  },
  {
    code: 'Inventory Short Notification', category: 'Planning',
    description: 'Planning identified short inventory (Short plan rows).',
    params: ['Area', 'Table'], wired: true,
  },

  // --- Receipt --------------------------------------------------------------------
  {
    code: 'Miscellaneous receipt', category: 'Receipt',
    description: 'A miscellaneous receipt was created.',
    params: RECEIPT_PARAMS, wired: true,
  },
  {
    code: 'PPE=X Container Received', category: 'Receipt',
    description: 'A container was received for an item with no PPE code or PPE code X.',
    params: RECEIPT_PARAMS, wired: false, note: 'ERP1 does not mirror PPE codes (unused in this install).',
  },
  {
    code: 'Purchase receipt', category: 'Receipt',
    description: 'A purchase receipt was created.',
    params: RECEIPT_PARAMS, wired: true,
  },
  {
    code: 'Reverse miscellaneous receipt', category: 'Receipt',
    description: 'A miscellaneous receipt was reversed.',
    params: RECEIPT_PARAMS, wired: true,
  },
  {
    code: 'Reverse purchase receipt', category: 'Receipt',
    description: 'A purchase receipt was reversed.',
    params: RECEIPT_PARAMS, wired: true,
  },
  {
    code: 'Reverse sample receipt', category: 'Receipt',
    description: 'A sample receipt was reversed.',
    params: RECEIPT_PARAMS, wired: false, note: 'ERP1 has no sample-receipt transaction (unused in this install).',
  },
  {
    code: 'Sample receipt', category: 'Receipt',
    description: 'A sample receipt was created.',
    params: RECEIPT_PARAMS, wired: false, note: 'ERP1 has no sample-receipt transaction (unused in this install).',
  },

  // --- Resource --------------------------------------------------------------------
  {
    code: 'Post-Op Required Notification', category: 'Resource',
    description: 'A room resource requires post-op maintenance (legacy overnight procedure).',
    params: ['Resource', 'Description'], wired: false, note: 'ERP1 has no resource-maintenance module (§11 not built).',
  },
  {
    code: 'Resource Maintenance Required', category: 'Resource',
    description: 'Maintenance is required or due soon for resources (legacy overnight procedure).',
    params: ['Resource', 'Description', 'Table'], wired: false, note: 'ERP1 has no resource-maintenance module (§11 not built).',
  },

  // --- Workflow --------------------------------------------------------------------
  {
    code: 'Workflow Started', category: 'Workflow',
    description: 'A recipe/formula approval workflow was started.',
    params: ['ApprovalCode', 'TableName', 'TableID', 'Description', 'Explanation', 'LinkType', 'Link', 'Text', 'LinkLabel'],
    wired: false, note: 'This install never used workflows (0 Workflow rows, verified live).',
  },
  {
    code: 'Workflow Completed', category: 'Workflow',
    description: 'A workflow completed.',
    params: ['ApprovalCode', 'TableName', 'TableID', 'LinkType', 'Link', 'Text', 'LinkLabel'],
    wired: false, note: 'This install never used workflows (0 Workflow rows, verified live).',
  },
  {
    code: 'Workflow Cancelled', category: 'Workflow',
    description: 'A workflow was cancelled.',
    params: ['ApprovalCode', 'TableName', 'TableID'], wired: false,
    note: 'This install never used workflows (0 Workflow rows, verified live).',
  },
  {
    code: 'Workflow Rejected', category: 'Workflow',
    description: 'A workflow was rejected.',
    params: ['ApprovalCode', 'TableName', 'TableID'], wired: false,
    note: 'This install never used workflows (0 Workflow rows, verified live).',
  },

  // --- Other (present in this install's config) ---------------------------------------
  {
    code: 'ServiceInvoiceNotification', category: 'Other',
    description: "The vendor's own service-invoice e-mail (was addressed to mar-kov.com).",
    params: ['Data'], wired: false, note: 'Vendor billing artifact — not applicable to ERP1.',
  },
  {
    code: 'Waybill Documents Notification', category: 'Other',
    description: 'Waybill documents notification.',
    params: ['Waybill'], wired: false, note: 'ERP1 has no waybill/tendering module (shipping records shipped lots directly).',
  },
  {
    code: 'Waybill Shipment Notification', category: 'Other',
    description: 'A shipment was tendered on a waybill.',
    params: ['ShipmentID', 'Ordr', 'Waybill', 'DateShipped', 'OwnerAddr', 'ShipToAddr', 'Table'],
    wired: false, note: 'ERP1 has no waybill/tendering module (shipping records shipped lots directly).',
  },
];

export const NOTIFICATION_CODE_SET = new Set(NOTIFICATION_CODES.map((c) => c.code));

/** Codes ERP1 emits natively — used by the UI to badge configured rules. */
export const WIRED_CODES = new Set(NOTIFICATION_CODES.filter((c) => c.wired).map((c) => c.code));
