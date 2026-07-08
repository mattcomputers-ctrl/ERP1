// The Configuration registry (§14 / vendor UG ch.19 'Configuration Update').
//
// Legacy CMS stores plant configuration in ten Params* tables edited through
// a tabbed form; ERP1 keeps configuration in the app_settings key/value table
// and this registry is the typed catalog the Configuration page renders —
// grouped to mirror the legacy tabs where a legacy counterpart exists.
//
// ONLY LIVE KEYS ARE REGISTERED: every entry here is read by some code path
// (noted in `description`), so the page never shows dead knobs. Legacy
// Params* fields with no ERP1 behavior behind them are intentionally absent —
// the live values were surveyed (2026-07-05) and the load-bearing ones are
// either wired (reweigh threshold, security policy, receipt requirements,
// yield tolerance) or hardcoded verified conventions (lot-code yyMMdd+3,
// recipe version .NN — changing those would corrupt parallel running).
//
// `defaultValue` mirrors seed.ts (seed wins for fresh installs; the registry
// default is the fallback shown when a key was never seeded/saved).

export type SettingType = 'text' | 'number' | 'boolean' | 'select' | 'password';

export interface SettingDef {
  key: string;
  group: string;
  label: string;
  description: string;
  type: SettingType;
  options?: string[];
  /** Surfaced for information only; the PUT endpoint refuses writes. */
  readonly?: boolean;
  defaultValue: string;
}

export const SETTING_GROUPS = [
  'Company',
  'Batch Execution',
  'Inventory',
  'Purchase Receipt',
  'Mail',
  'Accounting',
  'Planning',
  'Security',
  'System',
] as const;

export const SETTINGS_REGISTRY: SettingDef[] = [
  // --- Company (document headers) -------------------------------------------
  {
    key: 'company.name', group: 'Company', label: 'Company name', type: 'text',
    defaultValue: 'Precision Ink Corporation',
    description: 'Shown on printed documents: batch tickets, purchase orders, invoices, packing slips, bills, CofAs.',
  },
  {
    key: 'company.phone', group: 'Company', label: 'Company phone', type: 'text', defaultValue: '847-952-1500',
    description: 'Shown in the purchase-order footer.',
  },
  {
    key: 'company.email', group: 'Company', label: 'Purchasing e-mail', type: 'text', defaultValue: 'PURCHASING@PRECISIONINKCORP.COM',
    description: 'Shown in the purchase-order footer.',
  },

  // --- Batch Execution (legacy Batch Execution tab) --------------------------
  {
    key: 'batchSheet.gramsThresholdLb', group: 'Batch Execution', label: 'Grams threshold (lb)', type: 'number', defaultValue: '0.05',
    description: 'Batch-ticket quantities at or below this many pounds are shown in grams instead.',
  },
  {
    key: 'batchExecution.yieldTolerancePercent', group: 'Batch Execution', label: 'Yield tolerance %', type: 'number', defaultValue: '5',
    description: 'Completing an order with an actual batch size deviating from the planned size by more than this percentage returns a yield warning (legacy ParamsBatchExecution.YieldTolerance, live value 5). 0 disables.',
  },

  // --- Inventory (legacy Inventory tab) --------------------------------------
  {
    key: 'inventory.receivingLocation', group: 'Inventory', label: 'Receiving location', type: 'text', defaultValue: '',
    description: 'Location code that received purchase stock lands in. Empty = auto-resolve the most-used inventory location.',
  },
  {
    key: 'inventory.productionLocation', group: 'Inventory', label: 'Production output location', type: 'text', defaultValue: '',
    description: 'Location code that finished-goods batch output lands in. Empty = auto-resolve the most-used inventory location.',
  },
  {
    key: 'inventory.reweighThreshold', group: 'Inventory', label: 'Reweigh threshold %', type: 'number', defaultValue: '5',
    description: "Adjusting an inventory parcel by more than this percent of its original quantity fires the 'Reweigh Outside Threshold' notification (legacy ParamsInventory.ReweighThreshold, live value 5). 0 disables.",
  },

  // --- Purchase Receipt (legacy Purchase Receipt tab) -------------------------
  {
    key: 'receiving.manfLotRequired', group: 'Purchase Receipt', label: 'Manufacturer lot required', type: 'boolean', defaultValue: 'true',
    description: "Require the manufacturer's lot number on every received lot (the recall key). This plant ran the legacy flag OFF (ParamsPurchaseReceipt.ManfLotRequired=False); ERP1 defaults ON — relax it only if receiving without manufacturer lots is routine.",
  },

  // --- Mail (legacy Mail tab — delivery is ERP1-owned, see §17) ---------------
  {
    key: 'notifications.enabled', group: 'Mail', label: 'Deliver notifications', type: 'boolean', defaultValue: 'false',
    description: 'Master switch for e-mail notification DELIVERY. Rules always queue into the e-mail log; delivery only happens when this is true.',
  },
  {
    key: 'notifications.baseUrl', group: 'Mail', label: 'Web app base URL', type: 'text', defaultValue: '',
    description: 'Public base URL of this ERP1 web app (e.g. https://erp1.example.com) used for deep links in notification e-mails. Empty = links rendered as plain text.',
  },
  {
    key: 'smtp.host', group: 'Mail', label: 'SMTP host', type: 'text', defaultValue: '',
    description: 'SMTP server host for outgoing notification e-mail. Empty = delivery disabled. The SMTP_URL environment variable overrides all smtp.* settings.',
  },
  {
    key: 'smtp.port', group: 'Mail', label: 'SMTP port', type: 'number', defaultValue: '587',
    description: 'SMTP server port (587 STARTTLS, 465 implicit TLS, 25 plain).',
  },
  {
    key: 'smtp.secure', group: 'Mail', label: 'Implicit TLS', type: 'boolean', defaultValue: 'false',
    description: 'true = implicit TLS from the first byte (port 465). false = plain or STARTTLS upgrade (STARTTLS is mandatory whenever a password is configured).',
  },
  {
    key: 'smtp.user', group: 'Mail', label: 'SMTP username', type: 'text', defaultValue: '',
    description: 'SMTP auth username. Empty = unauthenticated relay.',
  },
  {
    key: 'smtp.password', group: 'Mail', label: 'SMTP password', type: 'password', defaultValue: '',
    description: 'SMTP auth password. Prefer the SMTP_URL environment variable if you do not want the password stored in the database.',
  },
  {
    key: 'smtp.from', group: 'Mail', label: 'From address', type: 'text', defaultValue: '',
    description: 'From address for notification e-mail, e.g. "ERP1 <erp1@example.com>". Empty = the SMTP username.',
  },

  // --- Accounting (§13 export account names) ----------------------------------
  {
    key: 'accounting.arAccount', group: 'Accounting', label: 'Accounts Receivable account', type: 'text', defaultValue: 'Accounts Receivable',
    description: 'External accounting-system account debited by exported invoices.',
  },
  {
    key: 'accounting.apAccount', group: 'Accounting', label: 'Accounts Payable account', type: 'text', defaultValue: 'Accounts Payable',
    description: 'External accounting-system account credited by exported purchase-receipt bills.',
  },
  {
    key: 'accounting.taxAccount1', group: 'Accounting', label: 'Tax level 1 account', type: 'text', defaultValue: 'Sales Tax Payable',
    description: 'Account credited with level-1 tax on exported invoices.',
  },
  {
    key: 'accounting.taxAccount2', group: 'Accounting', label: 'Tax level 2 account', type: 'text', defaultValue: 'Sales Tax Payable',
    description: 'Account credited with level-2 tax on exported invoices.',
  },
  {
    key: 'accounting.taxAccount3', group: 'Accounting', label: 'Tax level 3 account', type: 'text', defaultValue: 'Sales Tax Payable',
    description: 'Account credited with level-3 tax on exported invoices.',
  },
  {
    key: 'accounting.freightAccount', group: 'Accounting', label: 'Freight income account', type: 'text', defaultValue: 'Freight Income',
    description: 'Account credited with freight lines on exported invoices.',
  },
  {
    key: 'accounting.fallbackAccount', group: 'Accounting', label: 'Fallback account', type: 'text', defaultValue: 'Uncategorized',
    description: 'Account used (with a warning) when an item’s GL group mapping cannot resolve an account.',
  },

  // --- Planning ---------------------------------------------------------------
  {
    key: 'planning.source', group: 'Planning', label: 'Plan source', type: 'select', options: ['legacy', 'native'], defaultValue: 'legacy',
    description: 'Which plan the planning viewers read: the imported legacy nightly plan or the native recalculated plan. Flipped to native automatically by the first recalc.',
  },
  {
    key: 'planning.lastRecalcAt', group: 'Planning', label: 'Last native recalc', type: 'text', readonly: true, defaultValue: '',
    description: 'Timestamp of the last native plan recalculation (set by the recalc engine).',
  },

  // --- Security (legacy User tab) ----------------------------------------------
  {
    key: 'security.passwordMinLength', group: 'Security', label: 'Password minimum length', type: 'number', defaultValue: '12',
    description: 'Minimum password length enforced on password change (legacy ParamsUser.PasswordMinLength — unset in this install; ERP1 default 12). Floor of 6.',
  },
  {
    key: 'security.lockoutCount', group: 'Security', label: 'Lockout after failed logins', type: 'number', defaultValue: '5',
    description: 'Consecutive failed password attempts before the account is temporarily locked (legacy ParamsUser.LockoutCount). 0 disables lockout.',
  },
  {
    key: 'security.lockoutDurationMinutes', group: 'Security', label: 'Lockout duration (minutes)', type: 'number', defaultValue: '15',
    description: 'How long a locked account stays locked (legacy ParamsUser.LockoutDuration).',
  },

  // --- System (read-only state) --------------------------------------------------
  {
    key: 'import.logWatermark', group: 'System', label: 'Import log watermark', type: 'text', readonly: true, defaultValue: '',
    description: 'Highest legacy change-log id already reflected in the mirror (set by the import engine; absent until a full import succeeds).',
  },
];

export const SETTINGS_BY_KEY = new Map(SETTINGS_REGISTRY.map((s) => [s.key, s]));
