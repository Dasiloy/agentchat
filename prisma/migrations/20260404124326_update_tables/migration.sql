-- DropIndex
DROP INDEX "MessageReceipt_userId_idx";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastSeenAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "MessageReceipt_userId_readAt_idx" ON "MessageReceipt"("userId", "readAt");
