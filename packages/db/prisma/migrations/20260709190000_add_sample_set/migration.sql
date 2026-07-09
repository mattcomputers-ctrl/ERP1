-- CreateTable
CREATE TABLE "SampleSet" (
    "SampleSet" INTEGER NOT NULL,
    "Version" INTEGER,
    "Sublot" INTEGER NOT NULL,
    "BeingTested" BOOLEAN NOT NULL,
    "Grade" VARCHAR(6) NOT NULL,
    "ExpiryDate" TIMESTAMP(3),
    "DestructDate" TIMESTAMP(3),
    "IptOrdDetail" INTEGER,
    "IsStability" BOOLEAN,

    CONSTRAINT "SampleSet_pkey" PRIMARY KEY ("SampleSet")
);

-- CreateIndex
CREATE INDEX "SampleSet_Sublot_idx" ON "SampleSet"("Sublot");

