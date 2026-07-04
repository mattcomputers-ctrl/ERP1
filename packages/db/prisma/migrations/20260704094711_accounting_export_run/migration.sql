-- CreateTable
CREATE TABLE "accounting_export_run" (
    "id" SERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3) NOT NULL,
    "kinds" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "entryCount" INTEGER NOT NULL,
    "warningCount" INTEGER NOT NULL,
    "actorUserId" TEXT,

    CONSTRAINT "accounting_export_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "accounting_export_run_at_idx" ON "accounting_export_run"("at");

