-- CreateTable
CREATE TABLE "InventoryCount" (
    "InventoryCount" INTEGER NOT NULL,
    "Owner" INTEGER NOT NULL,
    "Description" VARCHAR(256),
    "EffectiveDate" TIMESTAMP(3) NOT NULL,
    "Posted" BOOLEAN NOT NULL DEFAULT false,
    "Version" INTEGER,
    "ChangeSet" INTEGER,
    "erp1_created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "erp1_updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryCount_pkey" PRIMARY KEY ("InventoryCount")
);

-- CreateTable
CREATE TABLE "InventoryCountDetail" (
    "InventoryCountDetail" INTEGER NOT NULL,
    "InventoryCount" INTEGER NOT NULL,
    "Item" INTEGER NOT NULL,
    "Sublot" INTEGER,
    "Location" INTEGER NOT NULL,
    "QtyEntered" VARCHAR(20),
    "Qty" DOUBLE PRECISION,
    "QtyAdjust" DOUBLE PRECISION,
    "erp1_inventory_id" INTEGER,

    CONSTRAINT "InventoryCountDetail_pkey" PRIMARY KEY ("InventoryCountDetail")
);

-- CreateIndex
CREATE INDEX "InventoryCountDetail_InventoryCount_idx" ON "InventoryCountDetail"("InventoryCount");

