-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'DISABLED', 'LOCKED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT,
    "displayName" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "passwordHash" TEXT,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mfaSecret" TEXT,
    "ssoSubject" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("userId","roleId")
);

-- CreateTable
CREATE TABLE "assignable_roles" (
    "id" TEXT NOT NULL,
    "parentRoleId" TEXT NOT NULL,
    "childRoleId" TEXT NOT NULL,

    CONSTRAINT "assignable_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "programs" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "folder" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_programs" (
    "roleId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "allow" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "role_programs_pkey" PRIMARY KEY ("roleId","programId")
);

-- CreateTable
CREATE TABLE "role_approval_policy" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "canRequestApproval" BOOLEAN NOT NULL DEFAULT true,
    "canApprove" BOOLEAN NOT NULL DEFAULT false,
    "canApproveUpdate" BOOLEAN NOT NULL DEFAULT false,
    "canApproveChange" BOOLEAN NOT NULL DEFAULT false,
    "canOverride" BOOLEAN NOT NULL DEFAULT false,
    "noApprovalRequired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_approval_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "secured_items" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "dataset" TEXT,
    "tableName" TEXT,
    "fieldName" TEXT,
    "method" TEXT,
    "description" TEXT,
    "requireReason" BOOLEAN NOT NULL DEFAULT false,
    "requireSignature" BOOLEAN NOT NULL DEFAULT false,
    "requireWitness" BOOLEAN NOT NULL DEFAULT false,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "securityGroupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "secured_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_secured_items" (
    "roleId" TEXT NOT NULL,
    "securedItemId" TEXT NOT NULL,
    "allow" BOOLEAN NOT NULL DEFAULT false,
    "allowWitness" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "role_secured_items_pkey" PRIMARY KEY ("roleId","securedItemId")
);

-- CreateTable
CREATE TABLE "security_groups" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "security_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" TEXT,
    "actorLabel" TEXT,
    "action" TEXT NOT NULL,
    "program" TEXT,
    "workstation" TEXT,
    "ip" TEXT,
    "resultCode" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT,
    "prevHash" TEXT,
    "hash" TEXT NOT NULL,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_field_change" (
    "id" BIGSERIAL NOT NULL,
    "auditLogId" BIGINT NOT NULL,
    "tableName" TEXT NOT NULL,
    "recordId" TEXT,
    "fieldName" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,

    CONSTRAINT "audit_field_change_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "esignature" (
    "id" BIGSERIAL NOT NULL,
    "auditLogId" BIGINT,
    "securedItemKey" TEXT NOT NULL,
    "meaning" TEXT,
    "userId" TEXT NOT NULL,
    "userLabel" TEXT NOT NULL,
    "userExplanation" TEXT,
    "witnessUserId" TEXT,
    "witnessLabel" TEXT,
    "witnessExplanation" TEXT,
    "masterTable" TEXT,
    "masterId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prevHash" TEXT,
    "hash" TEXT NOT NULL,

    CONSTRAINT "esignature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "description" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Entity" (
    "Entity" SERIAL NOT NULL,
    "EntityCode" VARCHAR(20) NOT NULL,
    "Version" INTEGER,
    "Prototype" BOOLEAN,
    "Parent" INTEGER,
    "Currency" VARCHAR(10),
    "TheirCode" VARCHAR(20),
    "Inactive" BOOLEAN,
    "LeadTime" INTEGER,
    "ReviewDate" TIMESTAMP(3),
    "ShipVia" INTEGER,
    "Terms" VARCHAR(20),
    "Incoterms" VARCHAR(20),
    "IsSupplier" BOOLEAN,
    "IsManufacturer" BOOLEAN,
    "IsSite" BOOLEAN,
    "IsLab" BOOLEAN,
    "IsWarehouse" BOOLEAN,
    "IsShipVia" BOOLEAN,
    "IsInstallation" BOOLEAN,
    "IsCMS" BOOLEAN,
    "IsShipTo" BOOLEAN,
    "IsBillTo" BOOLEAN,
    "IsRetain" BOOLEAN,
    "IsPriceList" BOOLEAN,
    "IsSalesman" BOOLEAN,
    "IsDivision" BOOLEAN NOT NULL DEFAULT false,
    "Salesman" INTEGER,
    "PriceList" INTEGER,
    "Territory" VARCHAR(20),
    "PoRequired" BOOLEAN,
    "DoNotShip" BOOLEAN,
    "SendMSDS" BOOLEAN,
    "SendCertificateOfAnalysis" BOOLEAN,
    "Tax1Group" VARCHAR(20),
    "Tax2Group" VARCHAR(20),
    "Tax3Group" VARCHAR(20),
    "CreditLimit" MONEY,
    "Group" VARCHAR(50),
    "Buyer" VARCHAR(10),
    "CustomerType" VARCHAR(20),
    "Language" SMALLINT,
    "ProcessingType" VARCHAR(10),
    "NoBill" BOOLEAN,
    "Context" VARCHAR(41) NOT NULL DEFAULT '',
    "erp1_created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "erp1_updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Entity_pkey" PRIMARY KEY ("Entity")
);

-- CreateTable
CREATE TABLE "Address" (
    "Address" SERIAL NOT NULL,
    "Name" VARCHAR(255) NOT NULL,
    "Department" VARCHAR(20),
    "AddrLine1" VARCHAR(255),
    "AddrLine2" VARCHAR(255),
    "AddrLine3" VARCHAR(255),
    "City" VARCHAR(255),
    "State" CHAR(2),
    "ZipCode" VARCHAR(20),
    "Country" VARCHAR(2),
    "Contact" VARCHAR(255),
    "Email" VARCHAR(100),
    "Fax" VARCHAR(30),
    "Phone" VARCHAR(30),
    "StateName" VARCHAR(10),
    "CountryName" VARCHAR(20),
    "URL" VARCHAR(1000),
    "Residential" BOOLEAN,
    "AddressCheckSum" INTEGER,
    "EmergencyContact" TEXT,

    CONSTRAINT "Address_pkey" PRIMARY KEY ("Address")
);

-- CreateTable
CREATE TABLE "AddressReference" (
    "Address" INTEGER NOT NULL,
    "TableID" INTEGER NOT NULL,
    "TableName" VARCHAR(128) NOT NULL,
    "Reference" VARCHAR(128) NOT NULL,

    CONSTRAINT "AddressReference_pkey" PRIMARY KEY ("Address","TableName","TableID","Reference")
);

-- CreateTable
CREATE TABLE "Unit" (
    "Unit" VARCHAR(6) NOT NULL,
    "BaseUnit" VARCHAR(6),
    "BaseQty" DOUBLE PRECISION,
    "Description" VARCHAR(256) NOT NULL,
    "Version" INTEGER,
    "Category" VARCHAR(6) NOT NULL DEFAULT '',
    "SystemUnit" BOOLEAN,
    "ShowOnScreen" BOOLEAN,
    "Context" VARCHAR(6) NOT NULL DEFAULT '',

    CONSTRAINT "Unit_pkey" PRIMARY KEY ("Unit")
);

-- CreateTable
CREATE TABLE "Currency" (
    "Currency" VARCHAR(10) NOT NULL,
    "Description" VARCHAR(256),
    "Version" INTEGER,

    CONSTRAINT "Currency_pkey" PRIMARY KEY ("Currency")
);

-- CreateTable
CREATE TABLE "Terms" (
    "Terms" VARCHAR(20) NOT NULL,
    "Description" VARCHAR(256),
    "TypeCode" VARCHAR(2),
    "BasisDateCode" VARCHAR(2),
    "Percent" DOUBLE PRECISION,
    "DiscountDaysDue" INTEGER,
    "NetDays" INTEGER,

    CONSTRAINT "Terms_pkey" PRIMARY KEY ("Terms")
);

-- CreateTable
CREATE TABLE "IncoTerms" (
    "IncoTerms" VARCHAR(20) NOT NULL,
    "Description" VARCHAR(256),

    CONSTRAINT "IncoTerms_pkey" PRIMARY KEY ("IncoTerms")
);

-- CreateTable
CREATE TABLE "Item" (
    "Item" SERIAL NOT NULL,
    "ItemCode" VARCHAR(30) NOT NULL,
    "Version" INTEGER,
    "Prototype" BOOLEAN,
    "Description" VARCHAR(256),
    "AltDescription" VARCHAR(256),
    "Context" VARCHAR(32),
    "Unit" VARCHAR(6),
    "PkgType" INTEGER,
    "QtyPerPackage" DOUBLE PRECISION,
    "OuterType" INTEGER,
    "PkgPerOuter" INTEGER,
    "LotRequired" SMALLINT,
    "ReplacedBy" INTEGER,
    "Owner" INTEGER,
    "Status" VARCHAR(4),
    "RetestPeriod" INTEGER,
    "MaximumLife" INTEGER,
    "SpecificGravity" DOUBLE PRECISION,
    "NoExpiry" BOOLEAN,
    "SecurityGroup" VARCHAR(20),
    "StandardCost" MONEY,
    "StandardPurchasePrice" MONEY,
    "StandardCurrency" VARCHAR(10),
    "PurchasePrice" MONEY,
    "SalesPrice" MONEY,
    "TargetPrice" MONEY,
    "ReplacementCost" MONEY,
    "Supplier" INTEGER,
    "GLGroup" VARCHAR(20),
    "ABCCode" VARCHAR(10),
    "Tax1Group" VARCHAR(20),
    "IsKit" BOOLEAN,
    "ControlledSubstance" BOOLEAN,
    "CertifiedOrganic" BOOLEAN,
    "Weight" DOUBLE PRECISION,
    "WeightUnit" VARCHAR(6),
    "ServiceGroup" VARCHAR(20),
    "Service" VARCHAR(10),
    "Comment" TEXT,
    "erp1_lot_tracked" BOOLEAN NOT NULL DEFAULT false,
    "erp1_created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "erp1_updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Item_pkey" PRIMARY KEY ("Item")
);

-- CreateTable
CREATE TABLE "import_run" (
    "id" BIGSERIAL NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "mode" TEXT NOT NULL DEFAULT 'full',
    "triggeredBy" TEXT,
    "report" JSONB,
    "error" TEXT,

    CONSTRAINT "import_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lot" (
    "Lot" VARCHAR(50) NOT NULL,
    "Version" INTEGER,
    "Item" INTEGER,
    "OrdDetail" INTEGER,
    "Supplier" INTEGER,
    "SupLot" VARCHAR(50),
    "Manufacturer" INTEGER,
    "ManfLot" VARCHAR(50),
    "ManfDate" TIMESTAMP(3),
    "DestructDate" TIMESTAMP(3),
    "ReceivedDate" TIMESTAMP(3),
    "CofADate" TIMESTAMP(3),
    "ReconciliationStatus" VARCHAR(20),
    "Comment" TEXT,
    "Context" VARCHAR(32),
    "ReduceTesting" BOOLEAN,
    "erp1_unit_cost" DECIMAL(18,6),

    CONSTRAINT "Lot_pkey" PRIMARY KEY ("Lot")
);

-- CreateTable
CREATE TABLE "Sublot" (
    "Sublot" SERIAL NOT NULL,
    "Version" INTEGER,
    "Release" INTEGER,
    "Lot" VARCHAR(50),
    "SublotCode" VARCHAR(51),
    "Context" VARCHAR(32),

    CONSTRAINT "Sublot_pkey" PRIMARY KEY ("Sublot")
);

-- CreateTable
CREATE TABLE "SublotParent" (
    "Sublot" INTEGER NOT NULL,
    "Parent" INTEGER NOT NULL,

    CONSTRAINT "SublotParent_pkey" PRIMARY KEY ("Sublot","Parent")
);

-- CreateTable
CREATE TABLE "Location" (
    "Location" SERIAL NOT NULL,
    "LocationCode" VARCHAR(20),
    "Version" INTEGER,
    "Owner" INTEGER,
    "InLocation" INTEGER,
    "Context" VARCHAR(32),
    "PkgType" INTEGER,
    "OrdDetail" INTEGER,
    "Unopened" BOOLEAN,
    "MisplacedDate" TIMESTAMP(3),
    "Tare" DOUBLE PRECISION,
    "VerifiedDate" TIMESTAMP(3),
    "Status" VARCHAR(6),
    "LocationGroup" VARCHAR(20),
    "Description" VARCHAR(256),
    "TransferCan" BOOLEAN,
    "Division" INTEGER,
    "Reference" VARCHAR(20),

    CONSTRAINT "Location_pkey" PRIMARY KEY ("Location")
);

-- CreateTable
CREATE TABLE "Inventory" (
    "Inventory" SERIAL NOT NULL,
    "Sublot" INTEGER,
    "Location" INTEGER NOT NULL,
    "OrdDetail" INTEGER,
    "Item" INTEGER NOT NULL,
    "Status" VARCHAR(6),
    "Qty" DOUBLE PRECISION,

    CONSTRAINT "Inventory_pkey" PRIMARY KEY ("Inventory")
);

-- CreateTable
CREATE TABLE "Recipe" (
    "Recipe" SERIAL NOT NULL,
    "Owner" INTEGER,
    "RecipeNumber" VARCHAR(20),
    "Version" INTEGER,
    "Comment" TEXT NOT NULL DEFAULT '',
    "DateCreated" TIMESTAMP(3),
    "Imported" BOOLEAN,
    "MergedNumber" VARCHAR(20),
    "XML" TEXT,
    "Context" VARCHAR(32),
    "OrdSubType" VARCHAR(6),
    "IsPublished" BOOLEAN,
    "PlacedBy" VARCHAR(255),
    "SecurityGroup" VARCHAR(20),
    "FormulaOnly" BOOLEAN,
    "WeightUnit" VARCHAR(6),
    "Inactive" BOOLEAN,
    "VolumeUnit" VARCHAR(6),
    "BillTo" INTEGER,
    "Shared" BOOLEAN,
    "Rework" BOOLEAN,
    "DateUpdated" TIMESTAMP(3),
    "DatePublished" TIMESTAMP(3),
    "DevelopmentStatus" VARCHAR(50),
    "LeadTime" INTEGER,
    "Reference" VARCHAR(20),

    CONSTRAINT "Recipe_pkey" PRIMARY KEY ("Recipe")
);

-- CreateTable
CREATE TABLE "RecipeDetail" (
    "RecipeDetail" SERIAL NOT NULL,
    "Recipe" INTEGER,
    "Owner" INTEGER,
    "Context" VARCHAR(32),
    "Parent" INTEGER,
    "Qualifier" VARCHAR(40),
    "Description" VARCHAR(256),
    "Item" INTEGER,
    "QtyReqd" DOUBLE PRECISION,
    "Line" BIGINT,
    "Comment" TEXT,
    "ExecOrder" INTEGER,
    "MustPreweigh" INTEGER NOT NULL DEFAULT 0,
    "Phase" VARCHAR(50),
    "BatchType" VARCHAR(1),
    "Manufacturer" INTEGER,
    "QtyYield" DOUBLE PRECISION,
    "BaseQty" DOUBLE PRECISION,
    "YieldPercent" DOUBLE PRECISION,
    "PkgType" INTEGER,
    "EntityUnit" VARCHAR(6),
    "ItemName" INTEGER,
    "TotalWeight" DOUBLE PRECISION,
    "TotalWeightPercent" DOUBLE PRECISION,
    "TotalVolume" DOUBLE PRECISION,
    "TotalVolumePercent" DOUBLE PRECISION,
    "UseFrom" INTEGER,
    "Inactive" BOOLEAN,
    "PercentUnder" DOUBLE PRECISION,
    "PercentOver" DOUBLE PRECISION,
    "Tag" VARCHAR(20),

    CONSTRAINT "RecipeDetail_pkey" PRIMARY KEY ("RecipeDetail")
);

-- CreateTable
CREATE TABLE "Ordr" (
    "Ordr" SERIAL NOT NULL,
    "Version" INTEGER,
    "Context" VARCHAR(32),
    "Owner" INTEGER,
    "Entity" INTEGER,
    "Division" INTEGER,
    "ShipTo" INTEGER,
    "BillTo" INTEGER,
    "Salesman" INTEGER,
    "ShipVia" INTEGER,
    "Incoterms" VARCHAR(20),
    "Currency" VARCHAR(10),
    "Recipe" INTEGER,
    "Status" VARCHAR(6),
    "UserHold" VARCHAR(20),
    "ExecutionHold" VARCHAR(20),
    "CreditHold" BOOLEAN,
    "OrdSubType" VARCHAR(6),
    "PoNumber" VARCHAR(25),
    "ProcessingType" VARCHAR(10),
    "IsQuote" BOOLEAN,
    "Reference" VARCHAR(20),
    "PlacedBy" VARCHAR(255),
    "Terms" VARCHAR(20),
    "SecurityGroup" VARCHAR(20),
    "DateOrdered" TIMESTAMP(3),
    "DateRequired" TIMESTAMP(3),
    "DateReleased" TIMESTAMP(3),
    "DateStarted" TIMESTAMP(3),
    "DateCompleted" TIMESTAMP(3),
    "DateScheduled" TIMESTAMP(3),
    "PlanStartDate" TIMESTAMP(3),
    "ActualBatchSize" DOUBLE PRECISION,
    "ManfLot" VARCHAR(256),
    "LabourHours" DOUBLE PRECISION,
    "MachineHours" DOUBLE PRECISION,
    "Parent" INTEGER,
    "Revision" INTEGER,
    "Comment" TEXT,
    "erp1_created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "erp1_updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ordr_pkey" PRIMARY KEY ("Ordr")
);

-- CreateTable
CREATE TABLE "OrdDetail" (
    "OrdDetail" SERIAL NOT NULL,
    "Ordr" INTEGER,
    "Context" VARCHAR(32),
    "Item" INTEGER,
    "Status" VARCHAR(6),
    "Parent" INTEGER,
    "Owner" INTEGER,
    "QtyReqd" DOUBLE PRECISION,
    "QtyCommitted" DOUBLE PRECISION,
    "QtyUsed" DOUBLE PRECISION,
    "StdQty" DOUBLE PRECISION,
    "QtyYield" DOUBLE PRECISION,
    "BaseQty" DOUBLE PRECISION,
    "YieldPercent" DOUBLE PRECISION,
    "NumberOfBatches" DOUBLE PRECISION,
    "Line" BIGINT,
    "ExecOrder" INTEGER,
    "ExecSubOrder" INTEGER,
    "SortOrder" INTEGER,
    "Phase" VARCHAR(50),
    "Qualifier" VARCHAR(40),
    "BatchType" VARCHAR(1),
    "ExecStatus" VARCHAR(6),
    "Sublot" INTEGER,
    "Lot" VARCHAR(50),
    "Manufacturer" INTEGER,
    "ItemName" INTEGER,
    "PkgType" INTEGER,
    "EntityUnit" VARCHAR(6),
    "Description" VARCHAR(256),
    "Comment" TEXT,
    "MustPreweigh" INTEGER NOT NULL DEFAULT 0,
    "PercentUnder" DOUBLE PRECISION,
    "PercentOver" DOUBLE PRECISION,
    "RecipeDetailReference" INTEGER,
    "Price" MONEY,
    "DatePromised" TIMESTAMP(3),
    "DateUpdated" TIMESTAMP(3),
    "Reference" VARCHAR(20),
    "Tag" VARCHAR(20),
    "IsOpen" BOOLEAN,
    "Discarded" BOOLEAN,
    "Inactive" BOOLEAN,
    "Version" INTEGER,

    CONSTRAINT "OrdDetail_pkey" PRIMARY KEY ("OrdDetail")
);

-- CreateTable
CREATE TABLE "OrdDetailTest" (
    "OrdDetailTest" SERIAL NOT NULL,
    "OrdDetail" INTEGER,
    "Test" VARCHAR(20),
    "Qualifier" VARCHAR(40),
    "Min" DOUBLE PRECISION,
    "Max" DOUBLE PRECISION,
    "Target" DOUBLE PRECISION,
    "TestGroup" VARCHAR(20),
    "Grade" VARCHAR(6),
    "Specification" TEXT,
    "Comment" TEXT,
    "Line" INTEGER,
    "Version" INTEGER,

    CONSTRAINT "OrdDetailTest_pkey" PRIMARY KEY ("OrdDetailTest")
);

-- CreateTable
CREATE TABLE "OrdDetailPricing" (
    "OrdDetailPricing" SERIAL NOT NULL,
    "OrdDetail" INTEGER,
    "PkgType" INTEGER,
    "EntityItemCode" VARCHAR(50),
    "EntityQuantity" DOUBLE PRECISION,
    "EntityUnit" VARCHAR(20),
    "QtyPerEntityQty" DOUBLE PRECISION,
    "PriceByPackage" BOOLEAN,
    "Version" INTEGER,

    CONSTRAINT "OrdDetailPricing_pkey" PRIMARY KEY ("OrdDetailPricing")
);

-- CreateTable
CREATE TABLE "PriceVersion" (
    "PriceVersion" SERIAL NOT NULL,
    "Entity" INTEGER,
    "EffectiveDate" TIMESTAMP(3),
    "Version" INTEGER,
    "Comment" TEXT,
    "DefaultVerifiedDate" TIMESTAMP(3),

    CONSTRAINT "PriceVersion_pkey" PRIMARY KEY ("PriceVersion")
);

-- CreateTable
CREATE TABLE "PriceDetail" (
    "PriceDetail" SERIAL NOT NULL,
    "PriceVersion" INTEGER,
    "Item" INTEGER,
    "EntityItemCode" VARCHAR(50),
    "Description" VARCHAR(256),
    "Comment" TEXT,
    "Currency" VARCHAR(10),
    "PkgType" INTEGER,
    "EntityQuantity" DOUBLE PRECISION,
    "EntityUnit" VARCHAR(20),
    "PriceByPackage" BOOLEAN,
    "MinOrder1" DOUBLE PRECISION,
    "Price1" MONEY,
    "MinOrder2" DOUBLE PRECISION,
    "Price2" MONEY,
    "MinOrder3" DOUBLE PRECISION,
    "Price3" MONEY,
    "MinOrder4" DOUBLE PRECISION,
    "Price4" MONEY,
    "MinOrder5" DOUBLE PRECISION,
    "Price5" MONEY,
    "LeadTime" INTEGER,
    "Manufacturer" INTEGER,
    "Version" INTEGER,
    "InvItem" INTEGER,
    "VerifiedDate" TIMESTAMP(3),

    CONSTRAINT "PriceDetail_pkey" PRIMARY KEY ("PriceDetail")
);

-- CreateTable
CREATE TABLE "ItemTest" (
    "ItemTest" SERIAL NOT NULL,
    "Item" INTEGER,
    "Test" VARCHAR(20),
    "Version" INTEGER,
    "TestGroup" VARCHAR(20),
    "Qualifier" VARCHAR(40),
    "Min" DOUBLE PRECISION,
    "Max" DOUBLE PRECISION,
    "Target" DOUBLE PRECISION,
    "Comment" TEXT,
    "OnReceipt" BOOLEAN,
    "OnProduction" BOOLEAN,
    "OnRetest" BOOLEAN,
    "Grade" VARCHAR(6),
    "LabelClaim" VARCHAR(20),
    "LabelClaimUnit" VARCHAR(6),
    "Line" INTEGER,
    "Specification" TEXT,

    CONSTRAINT "ItemTest_pkey" PRIMARY KEY ("ItemTest")
);

-- CreateTable
CREATE TABLE "OrdDetailCommit" (
    "OrdDetailCommit" SERIAL NOT NULL,
    "OrdDetail" INTEGER,
    "SrcOrdDetail" INTEGER,
    "Qty" DOUBLE PRECISION,
    "Manufacturer" INTEGER,
    "PackagingReady" BOOLEAN,

    CONSTRAINT "OrdDetailCommit_pkey" PRIMARY KEY ("OrdDetailCommit")
);

-- CreateTable
CREATE TABLE "LotIngredient" (
    "LotIngredient" SERIAL NOT NULL,
    "Lot" VARCHAR(50) NOT NULL,
    "Item" INTEGER NOT NULL,
    "Percent" DOUBLE PRECISION,

    CONSTRAINT "LotIngredient_pkey" PRIMARY KEY ("LotIngredient")
);

-- CreateTable
CREATE TABLE "lot_genealogy" (
    "id" BIGSERIAL NOT NULL,
    "child_lot" VARCHAR(50) NOT NULL,
    "parent_lot" VARCHAR(50) NOT NULL,
    "via_ordr" INTEGER,
    "qty" DOUBLE PRECISION,
    "source" TEXT NOT NULL DEFAULT 'OrdDetailCommit',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lot_genealogy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_lot" (
    "id" BIGSERIAL NOT NULL,
    "lot" VARCHAR(50) NOT NULL,
    "ordr" INTEGER NOT NULL,
    "ord_detail" INTEGER,
    "item" INTEGER,
    "qty" DOUBLE PRECISION,
    "unit" VARCHAR(20),
    "shipped_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_lot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_request" (
    "id" BIGSERIAL NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "target_table" VARCHAR(40) NOT NULL,
    "target_id" VARCHAR(64) NOT NULL,
    "payload" TEXT NOT NULL,
    "required_capability" VARCHAR(40) NOT NULL,
    "state" VARCHAR(12) NOT NULL DEFAULT 'PENDING',
    "request_reason" TEXT,
    "requested_by" TEXT NOT NULL,
    "requested_by_label" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL,
    "decided_by" TEXT,
    "decided_by_label" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disposition_approval" (
    "id" BIGSERIAL NOT NULL,
    "release" INTEGER NOT NULL,
    "state" VARCHAR(12) NOT NULL DEFAULT 'PENDING',
    "req_status" VARCHAR(8) NOT NULL,
    "req_grade" VARCHAR(6),
    "req_purity" DOUBLE PRECISION,
    "req_expiry" TIMESTAMP(3),
    "req_reason" TEXT,
    "requested_by" TEXT NOT NULL,
    "requested_by_label" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL,
    "decided_by" TEXT,
    "decided_by_label" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disposition_approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Release" (
    "Release" SERIAL NOT NULL,
    "SampleSet" INTEGER,
    "Sublot" INTEGER,
    "Status" VARCHAR(8),
    "Grade" VARCHAR(6),
    "Purity" DOUBLE PRECISION,
    "ExpiryDate" TIMESTAMP(3),
    "Suspend" BOOLEAN,
    "ReleaseDate" TIMESTAMP(3),
    "ReleasedBy" VARCHAR(255),
    "Context" VARCHAR(32),

    CONSTRAINT "Release_pkey" PRIMARY KEY ("Release")
);

-- CreateTable
CREATE TABLE "ReleaseCofA" (
    "Release" INTEGER NOT NULL,
    "ProductCode" VARCHAR(30),
    "Description" VARCHAR(256),
    "ManfDate" TIMESTAMP(3),
    "PkgLot" VARCHAR(50),
    "ManfLot" VARCHAR(50),
    "ExpiryDate" TIMESTAMP(3),

    CONSTRAINT "ReleaseCofA_pkey" PRIMARY KEY ("Release")
);

-- CreateTable
CREATE TABLE "LocationSampleTest" (
    "LocationSampleTest" SERIAL NOT NULL,
    "Location" INTEGER NOT NULL,
    "Test" VARCHAR(20) NOT NULL,
    "Qualifier" VARCHAR(40),
    "Version" INTEGER,
    "Result" TEXT,
    "Passed" BOOLEAN,
    "TestedTime" TIMESTAMP(3),
    "TestedBy" VARCHAR(255),
    "Approve" BOOLEAN,
    "Comment" TEXT,
    "SampleSet" INTEGER,
    "TestStartedTime" TIMESTAMP(3),
    "NotebookRef" VARCHAR(256),

    CONSTRAINT "LocationSampleTest_pkey" PRIMARY KEY ("LocationSampleTest")
);

-- CreateTable
CREATE TABLE "Trans" (
    "Trans" SERIAL NOT NULL,
    "Context" VARCHAR(6),
    "TransDocument" VARCHAR(20),
    "DocumentDate" TIMESTAMP(3),
    "TransDate" TIMESTAMP(3),
    "Ordr" INTEGER,
    "BillTo" INTEGER,
    "Owner" INTEGER,
    "Salesman" INTEGER,
    "Currency" VARCHAR(10),
    "CurrencyRate" DOUBLE PRECISION,
    "PoNumber" VARCHAR(25),
    "FreightCharge" MONEY,
    "Tax1Amount" MONEY,
    "Tax2Amount" MONEY,
    "Tax3Amount" MONEY,
    "ReversedTrans" INTEGER,

    CONSTRAINT "Trans_pkey" PRIMARY KEY ("Trans")
);

-- CreateTable
CREATE TABLE "TransDetail" (
    "TransDetail" SERIAL NOT NULL,
    "Trans" INTEGER,
    "Context" VARCHAR(6),
    "OrdDetail" INTEGER,
    "Item" INTEGER,
    "Qty" DOUBLE PRECISION,
    "Price" MONEY,
    "Unit" VARCHAR(20),

    CONSTRAINT "TransDetail_pkey" PRIMARY KEY ("TransDetail")
);

-- CreateTable
CREATE TABLE "Bill" (
    "Bill" SERIAL NOT NULL,
    "Context" VARCHAR(12),
    "Supplier" INTEGER,
    "LandingFactor" VARCHAR(20),
    "Invoice" VARCHAR(20),
    "InvoiceDate" DATE,
    "Memo" TEXT,
    "Terms" VARCHAR(20),
    "Tax1Group" VARCHAR(20),
    "Tax2Group" VARCHAR(20),
    "Tax3Group" VARCHAR(20),
    "Tax1Amount" MONEY,
    "Tax2Amount" MONEY,
    "Tax3Amount" MONEY,
    "Amount" MONEY,
    "Currency" VARCHAR(10),
    "CurrencyRate" DOUBLE PRECISION,

    CONSTRAINT "Bill_pkey" PRIMARY KEY ("Bill")
);

-- CreateTable
CREATE TABLE "BillDetail" (
    "BillDetail" SERIAL NOT NULL,
    "Bill" INTEGER,
    "LandingFactor" VARCHAR(20),
    "Receipt" INTEGER,
    "OrdDetail" INTEGER,
    "Amount" MONEY,
    "AddCost" MONEY,
    "InventoryValue" MONEY,
    "Pending" BOOLEAN,

    CONSTRAINT "BillDetail_pkey" PRIMARY KEY ("BillDetail")
);

-- CreateTable
CREATE TABLE "ChangeSet" (
    "ChangeSet" SERIAL NOT NULL,
    "Context" VARCHAR(32),
    "Ordr" INTEGER,
    "Trans" INTEGER,
    "Owner" INTEGER,
    "ChangeDate" TIMESTAMP(3),
    "PoNumber" VARCHAR(25),
    "ReverseChangeSet" INTEGER,

    CONSTRAINT "ChangeSet_pkey" PRIMARY KEY ("ChangeSet")
);

-- CreateTable
CREATE TABLE "ChangeSetShipment" (
    "ChangeSet" INTEGER NOT NULL,
    "Waybill" INTEGER,

    CONSTRAINT "ChangeSetShipment_pkey" PRIMARY KEY ("ChangeSet")
);

-- CreateTable
CREATE TABLE "Waybill" (
    "Waybill" SERIAL NOT NULL,
    "Owner" INTEGER,
    "DateShipped" TIMESTAMP(3),
    "Status" VARCHAR(6),
    "ShipVia" INTEGER,
    "PoNumber" VARCHAR(25),
    "TrailerNumber" VARCHAR(20),

    CONSTRAINT "Waybill_pkey" PRIMARY KEY ("Waybill")
);

-- CreateTable
CREATE TABLE "ChangeSetReceipt" (
    "ChangeSet" INTEGER NOT NULL,
    "OrdDetail" INTEGER,
    "Item" INTEGER,
    "Sublot" INTEGER,
    "BillTo" INTEGER,
    "Division" INTEGER,
    "PSQty" DOUBLE PRECISION,
    "PSUnit" VARCHAR(20),
    "PSQtyEntered" VARCHAR(20),
    "QtyPerPSQty" DOUBLE PRECISION,
    "NumberOfContainers" INTEGER,

    CONSTRAINT "ChangeSetReceipt_pkey" PRIMARY KEY ("ChangeSet")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_ssoSubject_key" ON "users"("ssoSubject");

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "assignable_roles_parentRoleId_childRoleId_key" ON "assignable_roles"("parentRoleId", "childRoleId");

-- CreateIndex
CREATE UNIQUE INDEX "programs_key_key" ON "programs"("key");

-- CreateIndex
CREATE UNIQUE INDEX "role_approval_policy_roleId_key" ON "role_approval_policy"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "secured_items_key_key" ON "secured_items"("key");

-- CreateIndex
CREATE UNIQUE INDEX "security_groups_code_key" ON "security_groups"("code");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "audit_log_at_idx" ON "audit_log"("at");

-- CreateIndex
CREATE INDEX "audit_log_action_idx" ON "audit_log"("action");

-- CreateIndex
CREATE INDEX "audit_field_change_tableName_recordId_idx" ON "audit_field_change"("tableName", "recordId");

-- CreateIndex
CREATE INDEX "esignature_masterTable_masterId_idx" ON "esignature"("masterTable", "masterId");

-- CreateIndex
CREATE UNIQUE INDEX "Entity_EntityCode_key" ON "Entity"("EntityCode");

-- CreateIndex
CREATE INDEX "Entity_IsSupplier_idx" ON "Entity"("IsSupplier");

-- CreateIndex
CREATE INDEX "Entity_IsBillTo_idx" ON "Entity"("IsBillTo");

-- CreateIndex
CREATE INDEX "Entity_IsShipTo_idx" ON "Entity"("IsShipTo");

-- CreateIndex
CREATE INDEX "AddressReference_TableName_TableID_idx" ON "AddressReference"("TableName", "TableID");

-- CreateIndex
CREATE UNIQUE INDEX "Item_ItemCode_key" ON "Item"("ItemCode");

-- CreateIndex
CREATE INDEX "Item_Context_idx" ON "Item"("Context");

-- CreateIndex
CREATE INDEX "Item_Status_idx" ON "Item"("Status");

-- CreateIndex
CREATE INDEX "Item_ControlledSubstance_idx" ON "Item"("ControlledSubstance");

-- CreateIndex
CREATE INDEX "Lot_Item_idx" ON "Lot"("Item");

-- CreateIndex
CREATE INDEX "Lot_Supplier_idx" ON "Lot"("Supplier");

-- CreateIndex
CREATE INDEX "Sublot_Lot_idx" ON "Sublot"("Lot");

-- CreateIndex
CREATE INDEX "SublotParent_Parent_idx" ON "SublotParent"("Parent");

-- CreateIndex
CREATE INDEX "Location_InLocation_idx" ON "Location"("InLocation");

-- CreateIndex
CREATE INDEX "Location_Status_idx" ON "Location"("Status");

-- CreateIndex
CREATE INDEX "Location_LocationCode_idx" ON "Location"("LocationCode");

-- CreateIndex
CREATE INDEX "Inventory_Sublot_idx" ON "Inventory"("Sublot");

-- CreateIndex
CREATE INDEX "Inventory_Location_idx" ON "Inventory"("Location");

-- CreateIndex
CREATE INDEX "Inventory_Item_idx" ON "Inventory"("Item");

-- CreateIndex
CREATE INDEX "Recipe_Context_idx" ON "Recipe"("Context");

-- CreateIndex
CREATE INDEX "Recipe_RecipeNumber_idx" ON "Recipe"("RecipeNumber");

-- CreateIndex
CREATE INDEX "RecipeDetail_Recipe_idx" ON "RecipeDetail"("Recipe");

-- CreateIndex
CREATE INDEX "RecipeDetail_Item_idx" ON "RecipeDetail"("Item");

-- CreateIndex
CREATE INDEX "Ordr_Context_idx" ON "Ordr"("Context");

-- CreateIndex
CREATE INDEX "Ordr_Entity_idx" ON "Ordr"("Entity");

-- CreateIndex
CREATE INDEX "Ordr_Status_idx" ON "Ordr"("Status");

-- CreateIndex
CREATE INDEX "Ordr_Recipe_idx" ON "Ordr"("Recipe");

-- CreateIndex
CREATE INDEX "OrdDetail_Ordr_idx" ON "OrdDetail"("Ordr");

-- CreateIndex
CREATE INDEX "OrdDetail_Item_idx" ON "OrdDetail"("Item");

-- CreateIndex
CREATE INDEX "OrdDetail_Parent_idx" ON "OrdDetail"("Parent");

-- CreateIndex
CREATE INDEX "OrdDetail_Sublot_idx" ON "OrdDetail"("Sublot");

-- CreateIndex
CREATE INDEX "OrdDetail_Lot_idx" ON "OrdDetail"("Lot");

-- CreateIndex
CREATE INDEX "OrdDetailTest_OrdDetail_idx" ON "OrdDetailTest"("OrdDetail");

-- CreateIndex
CREATE INDEX "OrdDetailPricing_OrdDetail_idx" ON "OrdDetailPricing"("OrdDetail");

-- CreateIndex
CREATE INDEX "PriceVersion_Entity_idx" ON "PriceVersion"("Entity");

-- CreateIndex
CREATE INDEX "PriceDetail_PriceVersion_idx" ON "PriceDetail"("PriceVersion");

-- CreateIndex
CREATE INDEX "PriceDetail_Item_idx" ON "PriceDetail"("Item");

-- CreateIndex
CREATE INDEX "PriceDetail_InvItem_idx" ON "PriceDetail"("InvItem");

-- CreateIndex
CREATE INDEX "ItemTest_Item_idx" ON "ItemTest"("Item");

-- CreateIndex
CREATE INDEX "OrdDetailCommit_OrdDetail_idx" ON "OrdDetailCommit"("OrdDetail");

-- CreateIndex
CREATE INDEX "OrdDetailCommit_SrcOrdDetail_idx" ON "OrdDetailCommit"("SrcOrdDetail");

-- CreateIndex
CREATE INDEX "LotIngredient_Lot_idx" ON "LotIngredient"("Lot");

-- CreateIndex
CREATE INDEX "LotIngredient_Item_idx" ON "LotIngredient"("Item");

-- CreateIndex
CREATE INDEX "lot_genealogy_child_lot_idx" ON "lot_genealogy"("child_lot");

-- CreateIndex
CREATE INDEX "lot_genealogy_parent_lot_idx" ON "lot_genealogy"("parent_lot");

-- CreateIndex
CREATE UNIQUE INDEX "lot_genealogy_child_lot_parent_lot_via_ordr_key" ON "lot_genealogy"("child_lot", "parent_lot", "via_ordr");

-- CreateIndex
CREATE INDEX "shipment_lot_lot_idx" ON "shipment_lot"("lot");

-- CreateIndex
CREATE INDEX "shipment_lot_ordr_idx" ON "shipment_lot"("ordr");

-- CreateIndex
CREATE INDEX "approval_request_state_kind_idx" ON "approval_request"("state", "kind");

-- CreateIndex
CREATE INDEX "disposition_approval_state_idx" ON "disposition_approval"("state");

-- CreateIndex
CREATE INDEX "disposition_approval_release_idx" ON "disposition_approval"("release");

-- CreateIndex
CREATE INDEX "Release_Sublot_idx" ON "Release"("Sublot");

-- CreateIndex
CREATE INDEX "ReleaseCofA_ProductCode_idx" ON "ReleaseCofA"("ProductCode");

-- CreateIndex
CREATE INDEX "ReleaseCofA_ManfLot_idx" ON "ReleaseCofA"("ManfLot");

-- CreateIndex
CREATE INDEX "LocationSampleTest_SampleSet_idx" ON "LocationSampleTest"("SampleSet");

-- CreateIndex
CREATE INDEX "Trans_Ordr_idx" ON "Trans"("Ordr");

-- CreateIndex
CREATE INDEX "Trans_TransDocument_idx" ON "Trans"("TransDocument");

-- CreateIndex
CREATE INDEX "Trans_Context_idx" ON "Trans"("Context");

-- CreateIndex
CREATE INDEX "TransDetail_Trans_idx" ON "TransDetail"("Trans");

-- CreateIndex
CREATE INDEX "TransDetail_OrdDetail_idx" ON "TransDetail"("OrdDetail");

-- CreateIndex
CREATE INDEX "Bill_Supplier_idx" ON "Bill"("Supplier");

-- CreateIndex
CREATE INDEX "Bill_Invoice_idx" ON "Bill"("Invoice");

-- CreateIndex
CREATE INDEX "BillDetail_Bill_idx" ON "BillDetail"("Bill");

-- CreateIndex
CREATE INDEX "BillDetail_OrdDetail_idx" ON "BillDetail"("OrdDetail");

-- CreateIndex
CREATE INDEX "ChangeSet_Ordr_idx" ON "ChangeSet"("Ordr");

-- CreateIndex
CREATE INDEX "ChangeSet_Trans_idx" ON "ChangeSet"("Trans");

-- CreateIndex
CREATE INDEX "ChangeSet_Context_idx" ON "ChangeSet"("Context");

-- CreateIndex
CREATE INDEX "ChangeSetShipment_Waybill_idx" ON "ChangeSetShipment"("Waybill");

-- CreateIndex
CREATE INDEX "ChangeSetReceipt_OrdDetail_idx" ON "ChangeSetReceipt"("OrdDetail");

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignable_roles" ADD CONSTRAINT "assignable_roles_parentRoleId_fkey" FOREIGN KEY ("parentRoleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignable_roles" ADD CONSTRAINT "assignable_roles_childRoleId_fkey" FOREIGN KEY ("childRoleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_programs" ADD CONSTRAINT "role_programs_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_programs" ADD CONSTRAINT "role_programs_programId_fkey" FOREIGN KEY ("programId") REFERENCES "programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_approval_policy" ADD CONSTRAINT "role_approval_policy_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secured_items" ADD CONSTRAINT "secured_items_securityGroupId_fkey" FOREIGN KEY ("securityGroupId") REFERENCES "security_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_secured_items" ADD CONSTRAINT "role_secured_items_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_secured_items" ADD CONSTRAINT "role_secured_items_securedItemId_fkey" FOREIGN KEY ("securedItemId") REFERENCES "secured_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_field_change" ADD CONSTRAINT "audit_field_change_auditLogId_fkey" FOREIGN KEY ("auditLogId") REFERENCES "audit_log"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "esignature" ADD CONSTRAINT "esignature_auditLogId_fkey" FOREIGN KEY ("auditLogId") REFERENCES "audit_log"("id") ON DELETE SET NULL ON UPDATE CASCADE;

