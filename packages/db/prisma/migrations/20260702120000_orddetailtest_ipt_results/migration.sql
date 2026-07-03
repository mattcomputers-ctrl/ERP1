-- AlterTable
ALTER TABLE "OrdDetailTest" ADD COLUMN     "erp1_result" TEXT,
ADD COLUMN     "erp1_passed" BOOLEAN,
ADD COLUMN     "erp1_result_by" VARCHAR(120),
ADD COLUMN     "erp1_result_at" TIMESTAMP(3);
