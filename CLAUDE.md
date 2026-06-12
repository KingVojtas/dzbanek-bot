# CLAUDE.md — guidance for coding agents

A Discord bot (discord.js v14, TypeScript, ESM) with a YouTube music player and scheduled RSS news posting. This file explains the architecture and conventions so you can make changes safely.

## Run / check commands

```bash
npm run dev        # run with auto-reload (tsx watch)
npm run deploy     # register slash commands (run after adding/renaming a command)
npm run typecheck  # tsc --noEmit
npm run lint       # eslint .
npm run format     # prettier --write .
```

Always run `npm run typecheck && npm run lint && npm run format:check` before considering a change done.

## Conventions

- **ESM + tsx, no build step.** Source runs directly via `tsx` (esbuild under the hood); `tsc` is type-check only (`noEmit`). There is no `dist/`.
- **Extensionless relative imports** (`moduleResolution: "Bundler"`). Don't add `.js` extensions.
- **`import type { ... }`** for type-only imports (`isolatedModules` is on, and it keeps the type-only import cycle between `core/types.ts` and the manager/service classes safe to erase).
- **Env via Node's built-in loader** — `src/config/env.ts` calls `process.loadEnvFile()`. No `dotenv`. Entry points import `./config/env` first.
- **Ephemeral replies** use `flags: MessageFlags.Ephemeral`, never the deprecated `ephemeral: true`.
- Keep `npm run lint` clean (note the `preserve-caught-error` rule: re-thrown errors must pass `{ cause }`).

## Architecture

```
src/
  index.ts            Composition root: builds client + services, wires events, schedules news, logs in.
  deploy-commands.ts  One-shot REST registration of slash commands.
  config/             Typed config: config.json (non-secret) + env (DISCORD_TOKEN). `config` and `DISCORD_TOKEN` are the exports.
  core/
    types.ts          Central interfaces: Command, Services, Track, TrackSource, FeedItem.
    client.ts         createClient() — intents are only [Guilds, GuildVoiceStates] (non-privileged).
    embeds.ts         EmbedBuilder factories (track, queue, news).
    logger.ts         Leveled logger singleton (LOG_LEVEL env).
  commands/
    index.ts          commandList + buildCommandCollection(). Register new commands here.
    music/*.ts        One file per slash command, each exporting a `Command`.
  events/             registerEvents() wires `ready` and `interactionCreate`.
  music/
    MusicManager.ts             Map<guildId, GuildMusicSubscription>; creates voice connections.
    GuildMusicSubscription.ts   Per-guild voice connection + AudioPlayer + queue. Queue advances on AudioPlayerStatus.Idle; idle timer disconnects.
    sources/YouTubeSource.ts    TrackSource implementation backed by yt-dlp (youtube-dl-exec).
  news/
    FeedReader.ts     rss-parser wrapper → FeedItem[].
    SeenStore.ts      JSON-file dedup store (per-feed, capped, atomic write to data/seen.json).
    NewsService.ts    poll(): fetch → filter unseen → (seed silently on first run | post embeds) → persist.
```

**Dependency injection:** services (`config`, `logger`, `music`, `news`) are created in `index.ts` and passed into each command's `execute(interaction, services)`. Commands don't reach for globals.

## How to add a slash command

1. Create `src/commands/<group>/<name>.ts` exporting a `Command` (`data: SlashCommandBuilder`, `execute(interaction, services)`).
2. Add it to `commandList` in `src/commands/index.ts`.
3. Run `npm run deploy` to register it with Discord.

Use `MessageFlags.Ephemeral` for error/validation replies; `deferReply()` before slow work (e.g. resolving a track).

## Music backend (fragile — read before touching)

YouTube extraction breaks often. It's deliberately isolated behind the `TrackSource` interface (`core/types.ts`); `YouTubeSource` is the only place that knows about yt-dlp. To swap backends (e.g. to `youtubei.js`), implement `TrackSource` and change the one line in `MusicManager` that instantiates `new YouTubeSource()`. Audio is streamed as `StreamType.Arbitrary` and transcoded by FFmpeg via prism-media inside `@discordjs/voice`.

## News behavior

- Dedup key is the RSS `guid` (fallback: link) — Google News links redirect/carry volatile params, so don't dedup on the URL.
- First run seeds the backlog as "seen" without posting (toggle with `news.postOnFirstRun`). Posting is oldest-first, ≤10 embeds per message.
- The seen store is capped to `news.maxSeenIds` per feed to bound growth.

## Gotchas

- Enum members widen inside standalone object literals — type shared reply payloads as `InteractionReplyOptions` (see `events/interactionCreate.ts`). Inline literals are fine (contextually typed).
- `data/` is git-ignored except `.gitkeep`; `seen.json` is runtime state.
- The voice stack needs an Opus encoder + an encryption lib; `@discordjs/voice`'s `generateDependencyReport()` (logged at debug on startup) shows what's resolved.
