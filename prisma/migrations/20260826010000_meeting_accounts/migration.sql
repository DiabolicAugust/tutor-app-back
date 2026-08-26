-- A tutor's connection to a meeting provider.
--
-- Its own table rather than a field on the users' config column, for one reason
-- that settles it: this holds a credential. That column is read on every request
-- and returned to the app in full, and a refresh token has no business
-- travelling on either path. Nothing in this table is ever sent to a client, and
-- the token itself is encrypted before it is written.
--
-- Unique on (user, provider): connecting the same provider again replaces the
-- connection rather than accumulating credentials nothing can reach.
--
-- Cascades with the user. An account that no longer exists cannot authorise
-- anything, and leaving the row would leave a working key to somebody's Zoom
-- behind a foreign key pointing at nothing.

-- CreateTable
CREATE TABLE "meeting_accounts" (
    "id" TEXT NOT NULL,
    "provider" "MeetingProvider" NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "accessToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "accountLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "meeting_accounts_userId_provider_key" ON "meeting_accounts"("userId", "provider");

-- AddForeignKey
ALTER TABLE "meeting_accounts" ADD CONSTRAINT "meeting_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
