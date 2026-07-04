-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "CostingRecipe" INTEGER;

-- AlterTable
ALTER TABLE "Ordr" ADD COLUMN     "LeadTime" INTEGER;

-- CreateTable
CREATE TABLE "ItemEntity" (
    "ItemEntity" INTEGER NOT NULL,
    "Item" INTEGER,
    "Entity" INTEGER,
    "Context" VARCHAR(32),
    "Description" VARCHAR(256),
    "ExpiryDate" TIMESTAMP(3),
    "MinimumStock" DOUBLE PRECISION,
    "LeadTime" INTEGER,
    "TestingLeadTime" INTEGER,
    "MSDSDate" TIMESTAMP(3),
    "Inactive" BOOLEAN,
    "Parent" INTEGER,
    "MaxSkipCount" INTEGER,
    "MaxSkipDays" INTEGER,
    "ByRequestOnly" BOOLEAN,

    CONSTRAINT "ItemEntity_pkey" PRIMARY KEY ("ItemEntity")
);

-- CreateIndex
CREATE INDEX "ItemEntity_Item_idx" ON "ItemEntity"("Item");

-- CreateIndex
CREATE INDEX "ItemEntity_Context_idx" ON "ItemEntity"("Context");

