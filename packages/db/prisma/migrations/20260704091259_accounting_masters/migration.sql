-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "Tax2Group" VARCHAR(20),
ADD COLUMN     "Tax3Group" VARCHAR(20);

-- CreateTable
CREATE TABLE "GLGroup" (
    "GLGroup" VARCHAR(20) NOT NULL,
    "Description" VARCHAR(256),

    CONSTRAINT "GLGroup_pkey" PRIMARY KEY ("GLGroup")
);

-- CreateTable
CREATE TABLE "GLCode" (
    "GLCode" VARCHAR(50) NOT NULL,
    "Description" VARCHAR(256),
    "Version" INTEGER,

    CONSTRAINT "GLCode_pkey" PRIMARY KEY ("GLCode")
);

-- CreateTable
CREATE TABLE "AccountCode" (
    "AccountCode" VARCHAR(159) NOT NULL,
    "Version" INTEGER,
    "Description" VARCHAR(256),

    CONSTRAINT "AccountCode_pkey" PRIMARY KEY ("AccountCode")
);

-- CreateTable
CREATE TABLE "GLGroupCode" (
    "GLGroupCode" SERIAL NOT NULL,
    "GLGroup" VARCHAR(20) NOT NULL,
    "GLCode" VARCHAR(50) NOT NULL,
    "AccountCode" VARCHAR(159),

    CONSTRAINT "GLGroupCode_pkey" PRIMARY KEY ("GLGroupCode")
);

-- CreateTable
CREATE TABLE "TaxRule" (
    "TaxRule" SERIAL NOT NULL,
    "Description" VARCHAR(256),
    "Version" INTEGER,
    "Context" VARCHAR(6) NOT NULL DEFAULT '',
    "ItemTaxGroup" VARCHAR(20),
    "EntityTaxGroup" VARCHAR(20),
    "Rate" DOUBLE PRECISION,
    "Amount" MONEY,
    "TaxOnTax" BOOLEAN,
    "TaxNumber" INTEGER,

    CONSTRAINT "TaxRule_pkey" PRIMARY KEY ("TaxRule")
);

-- CreateIndex
CREATE UNIQUE INDEX "GLGroupCode_GLGroup_GLCode_key" ON "GLGroupCode"("GLGroup", "GLCode");

-- CreateIndex
CREATE INDEX "TaxRule_TaxNumber_idx" ON "TaxRule"("TaxNumber");

