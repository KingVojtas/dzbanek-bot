import { prisma } from '../client';

export interface PlaylistTrackData {
  title: string;
  url: string;
  artist?: string;
  durationSec?: number;
  addedBy?: string;
}

export class PlaylistRepository {
  private readonly defaultName = 'Dzbanek playlist';

  async getItems(guildId: string, name: string = this.defaultName) {
    return prisma.playlistItem.findMany({
      where: { guildId, name },
      orderBy: { position: 'asc' },
    });
  }

  async addItem(guildId: string, data: PlaylistTrackData, name: string = this.defaultName) {
    // Find current max position
    const max = await prisma.playlistItem.aggregate({
      where: { guildId, name },
      _max: { position: true },
    });
    const nextPos = (max._max.position ?? -1) + 1;

    return prisma.playlistItem.create({
      data: {
        guildId,
        name,
        title: data.title,
        url: data.url,
        artist: data.artist,
        durationSec: data.durationSec ?? 0,
        addedBy: data.addedBy,
        position: nextPos,
      },
    });
  }

  async getOrCreate(guildId: string, name: string = this.defaultName) {
    // No explicit create needed, items define the playlist
    return { guildId, name };
  }
}
