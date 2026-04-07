/*
  Warnings:

  - Changed the type of `alertType` on the `Alert` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `direction` on the `Alert` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "AlertDirection" AS ENUM ('UP', 'DOWN');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('TOUCH', 'CLOSING');

-- AlterTable
ALTER TABLE "Alert" DROP COLUMN "alertType",
ADD COLUMN     "alertType" "AlertType" NOT NULL,
DROP COLUMN "direction",
ADD COLUMN     "direction" "AlertDirection" NOT NULL;
