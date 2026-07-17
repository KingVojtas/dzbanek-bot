import { GuildMember, PermissionFlagsBits, type VoiceBasedChannel } from 'discord.js';

/** True when a DJ role is configured for the guild (DJ mode is on). */
export function isDjModeEnabled(djRoleId: string | null | undefined): boolean {
  return Boolean(djRoleId && /^\d{5,30}$/.test(djRoleId));
}

/**
 * Admins (Manage Server / Admin) or members with the configured DJ role.
 * When DJ mode is off, returns false — callers should treat “open control”.
 */
export function isDjOrAdmin(
  member: GuildMember | null | undefined,
  djRoleId: string | null | undefined,
): boolean {
  if (!member) return false;
  if (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild)
  ) {
    return true;
  }
  if (!isDjModeEnabled(djRoleId)) return false;
  return member.roles.cache.has(djRoleId!);
}

/**
 * Soft DJ: full control if DJ/admin, or if alone with the bot in its VC
 * (only non-bot humans is this member).
 */
export function canForceControl(
  member: GuildMember | null | undefined,
  djRoleId: string | null | undefined,
  voiceChannel: VoiceBasedChannel | null | undefined,
): boolean {
  if (!isDjModeEnabled(djRoleId)) return true; // open mode
  if (isDjOrAdmin(member, djRoleId)) return true;
  if (!member || !voiceChannel) return false;
  const humans = voiceChannel.members.filter((m) => !m.user.bot);
  return humans.size === 1 && humans.has(member.id);
}

/** Votes needed: half of non-bot humans in VC, min 2 (or 1 if only one human). */
export function voteSkipThreshold(voiceChannel: VoiceBasedChannel | null | undefined): number {
  if (!voiceChannel) return 2;
  const humans = voiceChannel.members.filter((m) => !m.user.bot).size;
  if (humans <= 1) return 1;
  return Math.max(2, Math.ceil(humans / 2));
}
