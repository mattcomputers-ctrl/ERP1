-- CreateTable
CREATE TABLE "Notification" (
    "Notification" SERIAL NOT NULL,
    "NotificationCode" VARCHAR(50) NOT NULL,
    "SecurityGroup" VARCHAR(20) NOT NULL,
    "Version" INTEGER,
    "SendTo" TEXT,
    "Subject" TEXT,
    "Text" TEXT,
    "UseSendtoListOnly" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("Notification")
);

-- CreateTable
CREATE TABLE "NotificationDetail" (
    "NotificationDetail" SERIAL NOT NULL,
    "Notification" INTEGER NOT NULL,
    "Owner" INTEGER NOT NULL,
    "SendTo" TEXT,

    CONSTRAINT "NotificationDetail_pkey" PRIMARY KEY ("NotificationDetail")
);

-- CreateTable
CREATE TABLE "EmailSent" (
    "EmailSent" SERIAL NOT NULL,
    "SendTo" TEXT,
    "Subject" TEXT,
    "Text" TEXT,
    "DateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "Log" INTEGER,
    "Step" INTEGER,
    "Status" VARCHAR(10) NOT NULL DEFAULT 'Not sent',
    "MailItemId" INTEGER,
    "Error" TEXT,
    "erp1_notification_code" VARCHAR(50),
    "erp1_attempts" INTEGER NOT NULL DEFAULT 0,
    "erp1_claimed_at" TIMESTAMP(3),
    "erp1_sent_at" TIMESTAMP(3),

    CONSTRAINT "EmailSent_pkey" PRIMARY KEY ("EmailSent")
);

-- CreateIndex
CREATE UNIQUE INDEX "Notification_NotificationCode_SecurityGroup_key" ON "Notification"("NotificationCode", "SecurityGroup");

-- CreateIndex
CREATE INDEX "NotificationDetail_Notification_idx" ON "NotificationDetail"("Notification");

-- CreateIndex
CREATE INDEX "EmailSent_Status_EmailSent_idx" ON "EmailSent"("Status", "EmailSent");

-- AddForeignKey
ALTER TABLE "NotificationDetail" ADD CONSTRAINT "NotificationDetail_Notification_fkey" FOREIGN KEY ("Notification") REFERENCES "Notification"("Notification") ON DELETE RESTRICT ON UPDATE CASCADE;

