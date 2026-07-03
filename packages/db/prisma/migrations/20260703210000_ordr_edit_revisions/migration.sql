-- CreateTable
CREATE TABLE "OrdrEdit" (
    "OrdrEdit" INTEGER NOT NULL,
    "OrdrEditRef" INTEGER NOT NULL,
    "OrdrEditStatus" VARCHAR(6) NOT NULL,
    "Revision" INTEGER,
    "RevisionComment" TEXT,
    "Context" VARCHAR(32),
    "erp1_created_by" VARCHAR(120),
    "erp1_created_at" TIMESTAMP(3),
    "erp1_updated_at" TIMESTAMP(3),
    "erp1_resolved_by" VARCHAR(120),
    "erp1_resolved_at" TIMESTAMP(3),

    CONSTRAINT "OrdrEdit_pkey" PRIMARY KEY ("OrdrEdit")
);

-- CreateTable
CREATE TABLE "OrdDetailEdit" (
    "OrdDetailEdit" INTEGER NOT NULL,
    "OrdrEdit" INTEGER NOT NULL,
    "OrdDetailEditRef" INTEGER,
    "Context" VARCHAR(32),
    "Item" INTEGER,
    "QtyReqd" DOUBLE PRECISION,
    "StdQty" DOUBLE PRECISION,
    "QtyUsed" DOUBLE PRECISION,
    "ExecStatus" VARCHAR(6),
    "Line" BIGINT,
    "ExecOrder" INTEGER,
    "Phase" VARCHAR(50),
    "Description" VARCHAR(256),
    "Comment" TEXT,
    "erp1_removed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "OrdDetailEdit_pkey" PRIMARY KEY ("OrdDetailEdit")
);

-- CreateTable
CREATE TABLE "OrdDetailTestEdit" (
    "OrdDetailTestEdit" INTEGER NOT NULL,
    "OrdDetailEdit" INTEGER NOT NULL,
    "OrdDetailTestEditRef" INTEGER,
    "Test" VARCHAR(20) NOT NULL,
    "Qualifier" VARCHAR(40),
    "Min" DOUBLE PRECISION,
    "Max" DOUBLE PRECISION,
    "Target" DOUBLE PRECISION,
    "Comment" TEXT,
    "Line" INTEGER,

    CONSTRAINT "OrdDetailTestEdit_pkey" PRIMARY KEY ("OrdDetailTestEdit")
);

-- CreateIndex
CREATE INDEX "OrdrEdit_OrdrEditRef_idx" ON "OrdrEdit"("OrdrEditRef");

-- CreateIndex
CREATE INDEX "OrdDetailEdit_OrdrEdit_idx" ON "OrdDetailEdit"("OrdrEdit");

-- CreateIndex
CREATE INDEX "OrdDetailTestEdit_OrdDetailEdit_idx" ON "OrdDetailTestEdit"("OrdDetailEdit");

