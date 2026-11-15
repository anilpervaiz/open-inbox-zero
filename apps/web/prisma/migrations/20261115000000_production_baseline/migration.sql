-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "LogicalOperator" AS ENUM ('AND', 'OR');

-- CreateEnum
CREATE TYPE "SystemType" AS ENUM ('TO_REPLY', 'NEWSLETTER', 'MARKETING', 'CALENDAR', 'RECEIPT', 'NOTIFICATION', 'COLD_EMAIL');

-- CreateEnum
CREATE TYPE "ActionType" AS ENUM ('ARCHIVE', 'LABEL', 'REPLY', 'SEND_EMAIL', 'FORWARD', 'DRAFT_EMAIL', 'MARK_SEEN', 'MARK_SPAM', 'CALL_WEBHOOK', 'TRACK_THREAD');

-- CreateEnum
CREATE TYPE "ExecutedRuleStatus" AS ENUM ('PENDING', 'APPLIED', 'SKIPPED', 'REJECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "ExecutedActionStatus" AS ENUM ('PENDING', 'COMPLETED', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "DelayedActionStatus" AS ENUM ('PENDING', 'CLAIMED', 'COMPLETED', 'FAILED', 'UNCERTAIN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GroupItemType" AS ENUM ('FROM', 'SUBJECT', 'BODY');

-- CreateEnum
CREATE TYPE "GroupItemSource" AS ENUM ('USER', 'AI_LEARNED');

-- CreateEnum
CREATE TYPE "ThreadTrackerType" AS ENUM ('NEEDS_REPLY', 'AWAITING_REPLY');

-- CreateEnum
CREATE TYPE "ReplyTrackingEventKind" AS ENUM ('INCOMING', 'SENT');

-- CreateEnum
CREATE TYPE "ReplyLabelOperation" AS ENUM ('ADD', 'REMOVE');

-- CreateEnum
CREATE TYPE "ColdEmailStatus" AS ENUM ('AI_LABELED_COLD', 'USER_MARKED_COLD', 'NOT_COLD');

-- CreateEnum
CREATE TYPE "InitialSyncStatus" AS ENUM ('NOT_STARTED', 'PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "NewsletterStatus" AS ENUM ('AUTO_ARCHIVE', 'AUTO_ARCHIVE_AND_LABEL', 'UNSUBSCRIBED', 'APPROVED');

-- CreateEnum
CREATE TYPE "CleanupJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL_ERROR', 'UNDONE');

-- CreateEnum
CREATE TYPE "CleanupThreadStatus" AS ENUM ('PENDING', 'STARTED', 'COMPLETED', 'SKIPPED', 'FAILED', 'UNDONE');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthAccount" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthVerification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserApiKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "UserApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "authAccountId" TEXT,
    "encryptedAccessToken" TEXT,
    "encryptedRefreshToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "lastSyncedHistoryId" TEXT,
    "googleWatchExpiresAt" TIMESTAMP(3),
    "initialSyncStatus" "InitialSyncStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "about" TEXT,
    "signature" TEXT,
    "autoCategorizeSenders" BOOLEAN NOT NULL DEFAULT true,
    "coldEmailBlocker" TEXT NOT NULL DEFAULT 'LABEL_AND_ARCHIVE',
    "coldEmailPrompt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SelfHostedCredential" (
    "emailAccountId" TEXT NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SelfHostedCredential_pkey" PRIMARY KEY ("emailAccountId")
);

-- CreateTable
CREATE TABLE "SelfHostedFolderState" (
    "emailAccountId" TEXT NOT NULL,
    "folderPath" TEXT NOT NULL,
    "uidValidity" BIGINT NOT NULL,
    "lastSyncedUid" BIGINT NOT NULL DEFAULT 0,
    "highestModSeq" BIGINT,
    "specialUse" TEXT,
    "lastScanCompletedAt" TIMESTAMP(3),

    CONSTRAINT "SelfHostedFolderState_pkey" PRIMARY KEY ("emailAccountId","folderPath")
);

-- CreateTable
CREATE TABLE "OutboundMessageDelivery" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "threadId" TEXT,
    "draftId" TEXT,
    "rfc822MessageId" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "ccEmail" TEXT,
    "subject" TEXT NOT NULL,
    "bodyHash" TEXT NOT NULL,
    "status" "DelayedActionStatus" NOT NULL DEFAULT 'PENDING',
    "smtpResponse" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "OutboundMessageDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailboxInvitation" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdByAdmin" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailboxInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderSubscription" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "clientStateHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "systemType" "SystemType",
    "instructions" TEXT,
    "automate" BOOLEAN NOT NULL DEFAULT true,
    "runOnThreads" BOOLEAN NOT NULL DEFAULT true,
    "conditionalOperator" "LogicalOperator" NOT NULL DEFAULT 'AND',
    "from" TEXT,
    "to" TEXT,
    "subject" TEXT,
    "body" TEXT,
    "groupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Action" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "type" "ActionType" NOT NULL,
    "label" TEXT,
    "subject" TEXT,
    "content" TEXT,
    "to" TEXT,
    "cc" TEXT,
    "bcc" TEXT,
    "url" TEXT,
    "delayMinutes" INTEGER,
    "autoSend" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Action_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Group" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupItem" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "type" "GroupItemType" NOT NULL DEFAULT 'FROM',
    "value" TEXT NOT NULL,
    "exclude" BOOLEAN NOT NULL DEFAULT false,
    "source" "GroupItemSource" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutedRule" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "ruleId" TEXT,
    "threadId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "sourceMessageId" TEXT,
    "status" "ExecutedRuleStatus" NOT NULL DEFAULT 'PENDING',
    "automated" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "matchReasons" JSONB,
    "selectionMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutedRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutedAction" (
    "id" TEXT NOT NULL,
    "executedRuleId" TEXT NOT NULL,
    "type" "ActionType" NOT NULL,
    "status" "ExecutedActionStatus" NOT NULL DEFAULT 'PENDING',
    "label" TEXT,
    "labelOperation" "ReplyLabelOperation",
    "subject" TEXT,
    "content" TEXT,
    "to" TEXT,
    "cc" TEXT,
    "bcc" TEXT,
    "url" TEXT,
    "draftId" TEXT,
    "draftThreadId" TEXT,
    "sentMessageId" TEXT,
    "error" TEXT,
    "undoSnapshot" JSONB,
    "executionStartedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),

    CONSTRAINT "ExecutedAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DelayedAction" (
    "id" TEXT NOT NULL,
    "executedActionId" TEXT NOT NULL,
    "sourceActionId" TEXT NOT NULL,
    "sourceFingerprint" TEXT NOT NULL,
    "protectedSenders" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "DelayedActionStatus" NOT NULL DEFAULT 'PENDING',
    "claimToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "learningPending" BOOLEAN NOT NULL DEFAULT false,
    "learningNextAttemptAt" TIMESTAMP(3),
    "trackerPending" BOOLEAN NOT NULL DEFAULT false,
    "trackerNextAttemptAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DelayedAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThreadTracker" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "type" "ThreadTrackerType" NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "followUpAt" TIMESTAMP(3),

    CONSTRAINT "ThreadTracker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplyTrackingEvent" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "kind" "ReplyTrackingEventKind" NOT NULL,
    "sender" TEXT NOT NULL,
    "recipients" TEXT[],
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "requiresReply" BOOLEAN NOT NULL DEFAULT false,
    "requiresReplySuppressed" BOOLEAN NOT NULL DEFAULT false,
    "ignored" BOOLEAN NOT NULL DEFAULT false,
    "followUpAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReplyTrackingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplyThreadState" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "needsReply" INTEGER NOT NULL DEFAULT 0,
    "awaitingReply" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ReplyThreadState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplyLabelSync" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "sourceMessageId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "executedRuleId" TEXT NOT NULL,
    "status" "DelayedActionStatus" NOT NULL DEFAULT 'PENDING',
    "claimToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReplyLabelSync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Newsletter" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "status" "NewsletterStatus",
    "unsubscribeUrl" TEXT,
    "listUnsubscribe" TEXT,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "readCount" INTEGER NOT NULL DEFAULT 0,
    "archivedCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Newsletter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ColdEmail" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "status" "ColdEmailStatus" NOT NULL DEFAULT 'AI_LABELED_COLD',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ColdEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Knowledge" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Knowledge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplyMemory" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "promptSummary" TEXT NOT NULL,
    "replyText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReplyMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassificationFeedback" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "correctRuleId" TEXT,
    "wrongRuleId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassificationFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailMessage" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "fromName" TEXT,
    "toEmail" TEXT NOT NULL,
    "ccEmail" TEXT,
    "headerMessageId" TEXT,
    "inReplyTo" TEXT,
    "references" TEXT,
    "subject" TEXT NOT NULL,
    "snippet" TEXT NOT NULL,
    "textBody" TEXT NOT NULL,
    "htmlBody" TEXT,
    "contentType" TEXT,
    "attachmentNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mimeTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "labels" TEXT[],
    "unread" BOOLEAN NOT NULL DEFAULT true,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "listUnsubscribe" TEXT,
    "listUnsubscribePost" TEXT,
    "internalDate" TIMESTAMP(3) NOT NULL,
    "imapFolder" TEXT,
    "imapUid" BIGINT,
    "imapUidValidity" BIGINT,

    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThreadExecutionLock" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "ownerClaimToken" TEXT,
    "ownerCleanupJobId" TEXT,
    "ownerTrackerJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThreadExecutionLock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailAttachment" (
    "id" TEXT NOT NULL,
    "emailMessageId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "content" BYTEA NOT NULL,

    CONSTRAINT "EmailAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionRecovery" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "abandonedLockId" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "stoppedEvidence" TEXT NOT NULL,
    "affectedExecutions" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionRecovery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CleanupJob" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "olderThan" TIMESTAMP(3) NOT NULL,
    "mode" TEXT NOT NULL,
    "status" "CleanupJobStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CleanupJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CleanupThread" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "status" "CleanupThreadStatus" NOT NULL DEFAULT 'PENDING',
    "undoSnapshot" JSONB,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "CleanupThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CleanupRecovery" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "cleanupJobId" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "stoppedEvidence" TEXT NOT NULL,
    "releasedLocks" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CleanupRecovery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AuthSession_token_key" ON "AuthSession"("token");

-- CreateIndex
CREATE INDEX "AuthSession_userId_idx" ON "AuthSession"("userId");

-- CreateIndex
CREATE INDEX "AuthAccount_userId_idx" ON "AuthAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthAccount_providerId_accountId_key" ON "AuthAccount"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "AuthVerification_identifier_idx" ON "AuthVerification"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "UserApiKey_keyHash_key" ON "UserApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "UserApiKey_userId_idx" ON "UserApiKey"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailAccount_email_key" ON "EmailAccount"("email");

-- CreateIndex
CREATE UNIQUE INDEX "EmailAccount_authAccountId_key" ON "EmailAccount"("authAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundMessageDelivery_rfc822MessageId_key" ON "OutboundMessageDelivery"("rfc822MessageId");

-- CreateIndex
CREATE INDEX "OutboundMessageDelivery_emailAccountId_status_idx" ON "OutboundMessageDelivery"("emailAccountId", "status");

-- CreateIndex
CREATE INDEX "OutboundMessageDelivery_emailAccountId_bodyHash_idx" ON "OutboundMessageDelivery"("emailAccountId", "bodyHash");

-- CreateIndex
CREATE UNIQUE INDEX "MailboxInvitation_tokenHash_key" ON "MailboxInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "MailboxInvitation_email_acceptedAt_revokedAt_idx" ON "MailboxInvitation"("email", "acceptedAt", "revokedAt");

-- CreateIndex
CREATE INDEX "MailboxInvitation_userId_idx" ON "MailboxInvitation"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderSubscription_subscriptionId_key" ON "ProviderSubscription"("subscriptionId");

-- CreateIndex
CREATE INDEX "ProviderSubscription_emailAccountId_idx" ON "ProviderSubscription"("emailAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Rule_name_emailAccountId_key" ON "Rule"("name", "emailAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupItem_groupId_type_value_key" ON "GroupItem"("groupId", "type", "value");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutedRule_emailAccountId_threadId_messageId_key" ON "ExecutedRule"("emailAccountId", "threadId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "DelayedAction_executedActionId_key" ON "DelayedAction"("executedActionId");

-- CreateIndex
CREATE INDEX "DelayedAction_status_dueAt_idx" ON "DelayedAction"("status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "ThreadTracker_emailAccountId_threadId_messageId_key" ON "ThreadTracker"("emailAccountId", "threadId", "messageId");

-- CreateIndex
CREATE INDEX "ReplyTrackingEvent_emailAccountId_threadId_occurredAt_idx" ON "ReplyTrackingEvent"("emailAccountId", "threadId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReplyTrackingEvent_emailAccountId_threadId_messageId_key" ON "ReplyTrackingEvent"("emailAccountId", "threadId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "ReplyThreadState_emailAccountId_threadId_key" ON "ReplyThreadState"("emailAccountId", "threadId");

-- CreateIndex
CREATE UNIQUE INDEX "ReplyLabelSync_executedRuleId_key" ON "ReplyLabelSync"("executedRuleId");

-- CreateIndex
CREATE INDEX "ReplyLabelSync_status_createdAt_idx" ON "ReplyLabelSync"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReplyLabelSync_emailAccountId_threadId_revision_key" ON "ReplyLabelSync"("emailAccountId", "threadId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "Newsletter_emailAccountId_fromEmail_key" ON "Newsletter"("emailAccountId", "fromEmail");

-- CreateIndex
CREATE UNIQUE INDEX "ColdEmail_emailAccountId_fromEmail_key" ON "ColdEmail"("emailAccountId", "fromEmail");

-- CreateIndex
CREATE UNIQUE INDEX "EmailMessage_emailAccountId_messageId_key" ON "EmailMessage"("emailAccountId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailMessage_emailAccountId_imapFolder_imapUidValidity_imap_key" ON "EmailMessage"("emailAccountId", "imapFolder", "imapUidValidity", "imapUid");

-- CreateIndex
CREATE UNIQUE INDEX "ThreadExecutionLock_emailAccountId_threadId_key" ON "ThreadExecutionLock"("emailAccountId", "threadId");

-- CreateIndex
CREATE INDEX "EmailAttachment_emailMessageId_idx" ON "EmailAttachment"("emailMessageId");

-- CreateIndex
CREATE INDEX "ExecutionRecovery_emailAccountId_threadId_idx" ON "ExecutionRecovery"("emailAccountId", "threadId");

-- CreateIndex
CREATE INDEX "CleanupJob_emailAccountId_createdAt_idx" ON "CleanupJob"("emailAccountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CleanupThread_jobId_threadId_key" ON "CleanupThread"("jobId", "threadId");

-- CreateIndex
CREATE INDEX "CleanupRecovery_emailAccountId_cleanupJobId_idx" ON "CleanupRecovery"("emailAccountId", "cleanupJobId");

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthAccount" ADD CONSTRAINT "AuthAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserApiKey" ADD CONSTRAINT "UserApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailAccount" ADD CONSTRAINT "EmailAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailAccount" ADD CONSTRAINT "EmailAccount_authAccountId_fkey" FOREIGN KEY ("authAccountId") REFERENCES "AuthAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SelfHostedCredential" ADD CONSTRAINT "SelfHostedCredential_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SelfHostedFolderState" ADD CONSTRAINT "SelfHostedFolderState_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundMessageDelivery" ADD CONSTRAINT "OutboundMessageDelivery_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailboxInvitation" ADD CONSTRAINT "MailboxInvitation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderSubscription" ADD CONSTRAINT "ProviderSubscription_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Action" ADD CONSTRAINT "Action_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Group" ADD CONSTRAINT "Group_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupItem" ADD CONSTRAINT "GroupItem_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutedRule" ADD CONSTRAINT "ExecutedRule_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutedRule" ADD CONSTRAINT "ExecutedRule_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutedAction" ADD CONSTRAINT "ExecutedAction_executedRuleId_fkey" FOREIGN KEY ("executedRuleId") REFERENCES "ExecutedRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelayedAction" ADD CONSTRAINT "DelayedAction_executedActionId_fkey" FOREIGN KEY ("executedActionId") REFERENCES "ExecutedAction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadTracker" ADD CONSTRAINT "ThreadTracker_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplyTrackingEvent" ADD CONSTRAINT "ReplyTrackingEvent_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplyThreadState" ADD CONSTRAINT "ReplyThreadState_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplyLabelSync" ADD CONSTRAINT "ReplyLabelSync_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplyLabelSync" ADD CONSTRAINT "ReplyLabelSync_executedRuleId_fkey" FOREIGN KEY ("executedRuleId") REFERENCES "ExecutedRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Newsletter" ADD CONSTRAINT "Newsletter_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ColdEmail" ADD CONSTRAINT "ColdEmail_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Knowledge" ADD CONSTRAINT "Knowledge_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplyMemory" ADD CONSTRAINT "ReplyMemory_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassificationFeedback" ADD CONSTRAINT "ClassificationFeedback_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailAttachment" ADD CONSTRAINT "EmailAttachment_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CleanupThread" ADD CONSTRAINT "CleanupThread_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "CleanupJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

