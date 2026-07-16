-- CreateTable
CREATE TABLE "DedupEntry" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "scope" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WishlistItem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "GuildStat" (
    "guildId" TEXT NOT NULL PRIMARY KEY,
    "totalPlays" INTEGER NOT NULL DEFAULT 0,
    "totalDurationSec" INTEGER NOT NULL DEFAULT 0,
    "totalSkips" INTEGER NOT NULL DEFAULT 0,
    "totalWishlistAdds" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "UserStat" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "plays" INTEGER NOT NULL DEFAULT 0,
    "totalDurationSec" INTEGER NOT NULL DEFAULT 0,
    "skips" INTEGER NOT NULL DEFAULT 0,
    "wishlistAdds" INTEGER NOT NULL DEFAULT 0,
    "lastActive" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CommandCount" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TrackPlay" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "guildId" TEXT NOT NULL,
    "trackKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "plays" INTEGER NOT NULL DEFAULT 0,
    "lastPlayed" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PlaylistItem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "artist" TEXT,
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "addedBy" TEXT,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "position" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "DailySnapshot" (
    "date" TEXT NOT NULL PRIMARY KEY,
    "servers" INTEGER NOT NULL,
    "approxUsers" INTEGER NOT NULL,
    "totalPlays" INTEGER NOT NULL,
    "uniqueUsersTracked" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "GuildSettings" (
    "guildId" TEXT NOT NULL PRIMARY KEY,
    "newsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "newsChannelId" TEXT,
    "steamEnabled" BOOLEAN NOT NULL DEFAULT false,
    "steamChannelId" TEXT,
    "epicEnabled" BOOLEAN NOT NULL DEFAULT false,
    "epicChannelId" TEXT,
    "musicEnabled" BOOLEAN NOT NULL DEFAULT true,
    "logChannelId" TEXT,
    "welcomeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "welcomeChannelId" TEXT,
    "welcomeMessage" TEXT,
    "goodbyeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "goodbyeChannelId" TEXT,
    "goodbyeMessage" TEXT,
    "steamMinDiscount" INTEGER,
    "steamMinReviewScore" INTEGER,
    "newsKeywords" TEXT,
    "steamPostHourUtc" INTEGER,
    "epicPostHourUtc" INTEGER,
    "newsPostHourUtc" INTEGER,
    "levelingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "levelUpChannelId" TEXT,
    "levelingCooldownSec" INTEGER NOT NULL DEFAULT 60,
    "updatedAt" DATETIME NOT NULL,
    "updatedByUserId" TEXT
);

-- CreateTable
CREATE TABLE "MemberXp" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 0,
    "lastAwardAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "DedupEntry_scope_idx" ON "DedupEntry"("scope");

-- CreateIndex
CREATE INDEX "DedupEntry_scope_createdAt_idx" ON "DedupEntry"("scope", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DedupEntry_scope_itemId_key" ON "DedupEntry"("scope", "itemId");

-- CreateIndex
CREATE INDEX "WishlistItem_appId_idx" ON "WishlistItem"("appId");

-- CreateIndex
CREATE UNIQUE INDEX "WishlistItem_userId_appId_key" ON "WishlistItem"("userId", "appId");

-- CreateIndex
CREATE UNIQUE INDEX "UserStat_guildId_userId_key" ON "UserStat"("guildId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "CommandCount_guildId_userId_command_key" ON "CommandCount"("guildId", "userId", "command");

-- CreateIndex
CREATE UNIQUE INDEX "TrackPlay_guildId_trackKey_key" ON "TrackPlay"("guildId", "trackKey");

-- CreateIndex
CREATE INDEX "PlaylistItem_guildId_name_position_idx" ON "PlaylistItem"("guildId", "name", "position");

-- CreateIndex
CREATE INDEX "MemberXp_guildId_xp_idx" ON "MemberXp"("guildId", "xp" DESC);

-- CreateIndex
CREATE INDEX "MemberXp_guildId_level_xp_idx" ON "MemberXp"("guildId", "level" DESC, "xp" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "MemberXp_guildId_userId_key" ON "MemberXp"("guildId", "userId");
