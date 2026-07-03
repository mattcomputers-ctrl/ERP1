-- CreateTable
CREATE TABLE "Test" (
    "Test" VARCHAR(20) NOT NULL,
    "Version" INTEGER,
    "Description" VARCHAR(256),
    "TestResultType" VARCHAR(4),
    "Precision" INTEGER,
    "TestGroup" VARCHAR(20),
    "Memo" TEXT,
    "SampleSize" DOUBLE PRECISION,
    "Prototype" BOOLEAN,
    "Unit" VARCHAR(20),
    "TestGrouping" VARCHAR(20),
    "Method" VARCHAR(256),
    "Specification" TEXT,

    CONSTRAINT "Test_pkey" PRIMARY KEY ("Test")
);

-- CreateTable
CREATE TABLE "TestGroup" (
    "TestGroup" VARCHAR(20) NOT NULL,
    "Version" INTEGER,
    "Description" VARCHAR(256),
    "Lab" INTEGER,
    "SampleSize" DOUBLE PRECISION,
    "Unit" VARCHAR(6),
    "SamplingMethod" VARCHAR(6),
    "LabelGroup" VARCHAR(20),
    "IsRetain" BOOLEAN,
    "SampleSizePer" DOUBLE PRECISION,
    "Memo" TEXT,
    "MaximumSampleSize" DOUBLE PRECISION,
    "MaximumSampleSizePer" DOUBLE PRECISION,
    "MFSamplingMethod" VARCHAR(6),
    "RetestSamplingMethod" VARCHAR(6),
    "TestGroupGroup" VARCHAR(20),
    "MultiResultSave" BOOLEAN,

    CONSTRAINT "TestGroup_pkey" PRIMARY KEY ("TestGroup")
);

