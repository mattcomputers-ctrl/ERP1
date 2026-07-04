-- CreateTable
CREATE TABLE "PlanTrace" (
    "PlanTrace" BIGINT NOT NULL,
    "Parent" BIGINT,
    "Owner" INTEGER,
    "Ordr" INTEGER,
    "Context" VARCHAR(32),
    "Item" INTEGER,
    "OrdDetail" INTEGER,
    "User" VARCHAR(255),
    "Reference" VARCHAR(20),
    "AvailableDate" TIMESTAMP(3),
    "Quantity" DOUBLE PRECISION,
    "DateReleased" TIMESTAMP(3),
    "DateUpdated" TIMESTAMP(3),
    "Sublot" INTEGER,
    "ExpiryFlag" INTEGER,
    "QuantityExpired" DOUBLE PRECISION,
    "DateRequired" TIMESTAMP(3),
    "OrderByDate" TIMESTAMP(3),
    "LeadTime" INTEGER,
    "TestingLeadTime" INTEGER,
    "MFLevel" INTEGER,
    "MFOrdr" INTEGER,
    "PromisedDate" TIMESTAMP(3),
    "SourceOrdr" INTEGER,
    "PlanTraceStatus" VARCHAR(10),
    "Manufacturer" INTEGER,
    "ReqdSubLot" INTEGER,
    "MfgItem" INTEGER,
    "Division" INTEGER,
    "ArrivalDate" TIMESTAMP(3),

    CONSTRAINT "PlanTrace_pkey" PRIMARY KEY ("PlanTrace")
);

-- CreateIndex
CREATE INDEX "PlanTrace_Item_idx" ON "PlanTrace"("Item");

-- CreateIndex
CREATE INDEX "PlanTrace_Reference_idx" ON "PlanTrace"("Reference");

