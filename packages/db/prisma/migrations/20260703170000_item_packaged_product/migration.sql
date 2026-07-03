-- CreateTable
CREATE TABLE "ItemPackagedProduct" (
    "ItemPackagedProduct" SERIAL NOT NULL,
    "Item" INTEGER NOT NULL,
    "PackagingPrototype" INTEGER NOT NULL,
    "PackagedProduct" INTEGER NOT NULL,
    "Recipe" INTEGER,
    "Qty" DOUBLE PRECISION NOT NULL,
    "Inactive" BOOLEAN,
    "AltID" INTEGER,
    "DateUpdated" TIMESTAMP(3),
    "Label" INTEGER,
    "UPC" VARCHAR(20),

    CONSTRAINT "ItemPackagedProduct_pkey" PRIMARY KEY ("ItemPackagedProduct")
);

-- CreateIndex
CREATE INDEX "ItemPackagedProduct_Item_idx" ON "ItemPackagedProduct"("Item");

-- CreateIndex
CREATE INDEX "ItemPackagedProduct_PackagedProduct_idx" ON "ItemPackagedProduct"("PackagedProduct");

