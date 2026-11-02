-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "sourceCollectionSlugs" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "sourceData" JSONB,
ADD COLUMN     "sourceId" TEXT,
ADD COLUMN     "sourceSku" TEXT,
ADD COLUMN     "sourceUrl" TEXT,
ALTER COLUMN "mrp" DROP NOT NULL,
ALTER COLUMN "gstRate" DROP NOT NULL,
ALTER COLUMN "minimumOrderQuantity" DROP NOT NULL,
ALTER COLUMN "minimumOrderQuantity" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ProductImage" ADD COLUMN     "sourceAssetId" TEXT,
ALTER COLUMN "cloudinaryPublicId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ProductVariant" ADD COLUMN     "sourceAvailable" BOOLEAN,
ADD COLUMN     "sourceId" TEXT,
ADD COLUMN     "sourceSku" TEXT;

-- CreateTable
CREATE TABLE "CatalogueSnapshot" (
    "id" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "CatalogueSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Product_sourceId_key" ON "Product"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductImage_sourceAssetId_key" ON "ProductImage"("sourceAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_sourceId_key" ON "ProductVariant"("sourceId");

