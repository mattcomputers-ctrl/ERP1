-- AlterTable
ALTER TABLE "Ordr" ADD COLUMN     "EarliestStartDate" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "InvMovement" (
    "InvMovement" BIGSERIAL NOT NULL,
    "Context" VARCHAR(6),
    "ChangeSet" INTEGER NOT NULL,
    "Sublot" INTEGER,
    "Release" INTEGER,
    "Item" INTEGER,
    "Step" INTEGER,

    CONSTRAINT "InvMovement_pkey" PRIMARY KEY ("InvMovement")
);

-- CreateTable
CREATE TABLE "InvMovementDtl" (
    "InvMovementDtl" SERIAL NOT NULL,
    "InvMovement" BIGINT NOT NULL,
    "Context" VARCHAR(6) NOT NULL,
    "Owner" INTEGER NOT NULL,
    "Location" INTEGER,
    "OrdDetail" INTEGER,
    "Qty" DOUBLE PRECISION,
    "Value" MONEY,

    CONSTRAINT "InvMovementDtl_pkey" PRIMARY KEY ("InvMovementDtl")
);

-- CreateIndex
CREATE INDEX "InvMovement_ChangeSet_idx" ON "InvMovement"("ChangeSet");

-- CreateIndex
CREATE INDEX "InvMovement_Item_idx" ON "InvMovement"("Item");

-- CreateIndex
CREATE INDEX "InvMovement_Context_idx" ON "InvMovement"("Context");

-- CreateIndex
CREATE INDEX "InvMovementDtl_InvMovement_idx" ON "InvMovementDtl"("InvMovement");

-- CreateIndex
CREATE INDEX "InvMovementDtl_OrdDetail_idx" ON "InvMovementDtl"("OrdDetail");

-- CreateIndex
CREATE INDEX "InvMovementDtl_Context_idx" ON "InvMovementDtl"("Context");

