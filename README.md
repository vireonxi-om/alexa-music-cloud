# alexa-music-cloud

**Stream your own MP3 library on Alexa, ad-free, with your voice.**

> A self-hosted Alexa skill you invoke as *"Music Cloud"* — play your own MP3s on any Echo, no subscription, no ads.
> Built by **OMSHAKTHI (VIREON)** — a modernized rebuild of the archived 2019 project.


Music Cloud is a self-hosted Alexa skill that plays music from *your own* library — no subscription, no ads, no forced shuffle. You say *"Alexa, ask Music Cloud to play Unstoppable"* and your Echo streams the track straight from your private S3 bucket.

It also ships with a **Telegram bot** so you can grow your library from anywhere: drop a YouTube / YT Music link and the whole pipeline runs itself — download, tag, upload, and re-publish the Alexa voice model automatically.

> This is a modernized rebuild of [andrei-ace/music-cloud](https://github.com/andrei-ace/music-cloud) (2019), which was archived after Amazon changed its music-catalog APIs. See [Credits & History](#credits--history) for what changed and why.

---

## Features

- 🎙️ **Voice playback** of your own MP3s on any Echo — *"Alexa, ask Music Cloud to play &lt;song&gt;"*
- 🔀 Play by song, by artist, or shuffle everything; `Next` / `Previous` / `Pause` / `Resume` / `Start Over`
- ☁️ **Fully serverless** — AWS Lambda + DynamoDB + private S3. Nothing runs on your own hardware 24/7.
- 🔒 **Bucket stays private** — tracks are served via short-lived presigned URLs (6h TTL)
- ▶️ **Gapless auto-advance** — the next track is enqueued on `PlaybackNearlyFinished`
- 🤖 **Telegram add-a-song bot** — paste a YouTube link, get it on your Echo minutes later
- 🩺 **Built-in health check** across all five layers (DynamoDB · S3 · Lambda · yt-dlp · Alexa model)
- 🌍 Ships with `en-US` and `en-IN` interaction models

## Architecture

```
                        ┌──────────────────────────────────────────┐
  "Alexa, ask Music     │                 AWS (us-east-1)           │
   Cloud to play X"     │                                          │
        │               │   ┌─────────────┐     ┌──────────────┐  │
        ▼               │   │   Lambda     │────▶│  DynamoDB    │  │
  ┌───────────┐  intent │   │ MusicCloud   │     │ cloud-music  │  │
  │   Echo    │────────▶│──▶│   (node20)   │     │ (+ user queue)│ │
  └───────────┘         │   └──────┬───────┘     └──────────────┘  │
        ▲   AudioPlayer │          │ presigned URL (6h)            │
        │   Play/Enqueue│          ▼                               │
        └───────────────│───┌──────────────┐                      │
                        │   │  S3 (private)│  mp3/*.mp3            │
                        │   └──────────────┘                      │
                        └──────────────────────────────────────────┘
                                        ▲
                                        │ add / remove tracks
                        ┌───────────────┴────────────────┐
                        │  Telegram bot (@yourbot)        │
                        │  yt-dlp → S3 → DynamoDB →        │
                        │  rebuild Alexa interaction model │
                        └─────────────────────────────────┘
```

**Why a custom AudioPlayer skill (not the Music Skill Kit)?**
Amazon's Music Skill Kit (`GetPlayableContent` / catalogs) is gated to approved music partners — a self-published music skill will **never** get native *"play X on Music Cloud"* routing. This project instead uses a **custom skill with the AudioPlayer interface**, invoked as *"ask Music Cloud to play X"*. That's the only path that actually works for a personal, self-published skill.

## Repository layout

```
music-cloud/
├── lambda/us-east-1_MusicCloudLambda/   # The skill backend (node20)
│   ├── index.js                         # Routes IntentRequest + AudioPlayer.* + PlaybackController.*
│   ├── builders/                        # Emits AudioPlayer.Play (REPLACE_ALL) + gapless ENQUEUE
│   ├── persistence/                     # DynamoDB scan + fuzzy match + per-user queue state
│   └── utils/
├── infrastructure/music-cloud.json      # CloudFormation: Lambda + DynamoDB + IAM
├── skill-package/                        # Alexa skill manifest + interaction models
│   ├── skill-create-custom.json         # Custom/AudioPlayer manifest
│   ├── build-models.js                  # Regenerates voice models from the live library
│   └── interactionModels/custom/        # en-US.json, en-IN.json
├── dropbox-catalog/                      # Library management + catalog builder (name kept for history)
│   ├── index.js                         # S3 upload + DynamoDB catalog build
│   ├── add_song.js                      # yt-dlp → S3 → DynamoDB → rebuild model
│   ├── remove_song.js                   # delete from DynamoDB + S3 + rebuild model
│   ├── list_songs.js                    # list library (--json for the bot)
│   ├── health.js                        # 5-layer health check
│   └── retag.sh                          # clean/speakable ID3 tags for voice matching
├── bot/music_cloud_bot.py               # Telegram bot (buttons, add/remove/health)
└── docs/SETUP.md                         # Full deployment walkthrough
```

## Quick start

Full step-by-step is in **[docs/SETUP.md](docs/SETUP.md)**. In short:

1. **Prereqs:** an AWS account, an [Amazon Developer](https://developer.amazon.com) account, `ask-cli@2`, Node 20, and `yt-dlp`.
2. **Infra:** `aws cloudformation deploy --template-file ./infrastructure/music-cloud.json --stack-name music-cloud-stack --capabilities CAPABILITY_IAM`
3. **Create a private S3 bucket** for your MP3s (block all public access).
4. **Configure env:** copy `dropbox-catalog/.env.template` → `.env`, fill in `MUSIC_BUCKET`, `AWS_REGION`, `SKILL_ID`.
5. **Create the skill** (`ask smapi` — see SETUP for the Lambda-permission chicken-and-egg workaround).
6. **Add songs:** run the bot, or `node dropbox-catalog/add_song.js "<youtube-url>"`.
7. **Enable the dev skill** on your account and say *"Alexa, ask Music Cloud to play &lt;song&gt;"*.

## Configuration

Everything sensitive is read from environment variables — nothing is hardcoded. Copy the template:

```bash
cp dropbox-catalog/.env.template dropbox-catalog/.env
```

| Variable          | Description                                             |
|-------------------|---------------------------------------------------------|
| `MUSIC_BUCKET`    | Your private S3 bucket name                             |
| `AWS_REGION`      | e.g. `us-east-1`                                        |
| `SKILL_ID`        | Your Alexa skill id (`amzn1.ask.skill.…`)               |
| `AWS_SDK_LOAD_CONFIG` | `true` — lets the SDK read your `~/.aws` profile    |

For the Telegram bot (in `bot/`), create two files (git-ignored):

- `.tg_token` — your BotFather token
- `allow.txt` — allowed Telegram user ids, one per line (leave empty to allow all — **not recommended**)

> ⚠️ **Security:** never commit `.env`, `.tg_token`, `allow.txt`, `.mp3` files, or your `~/.aws` credentials. The `.gitignore` already excludes them. Serve tracks only via presigned URLs and keep the bucket private.

## The Telegram bot

Once running (`python bot/music_cloud_bot.py`), DM it a link:

```
<youtube-url>
<youtube-url> | Custom Title
<youtube-url> | Custom Title | Artist
```

Commands: `/start` `/menu` `/list` `/remove` `/help`. The inline menu exposes **📋 List · 🗑 Remove · 🩺 Health · ❓ Help**.

The add pipeline: `yt-dlp` metadata → dup-check → download + convert to MP3 → clean the title → `S3 putObject` → DynamoDB put → rebuild catalog → regenerate both-locale interaction models → `ask smapi set-interaction-model`. The bot live-edits a single message with progress.

## Credits & History

- **Original project:** [andrei-ace/music-cloud](https://github.com/andrei-ace/music-cloud) by Andrei Ciobanu (2019), and the companion [Medium article](https://medium.com/@andreiciobanu_15529/build-your-own-music-streaming-service-with-amazon-alexa-41c7bf1eb66a). Archived after Amazon changed its catalog APIs.
- **What changed in this rebuild:**
  - **Dropbox → S3** for hosting; presigned URLs instead of public links.
  - **Music Skill Kit → custom AudioPlayer skill** — the Music Skill Kit path is gated to Amazon partners and never routes for self-published skills.
  - **Node 10/14/16 → Node 20** across Lambda and tooling; `aws-sdk` bundled for node20.
  - **New:** the Telegram management bot (`add`/`remove`/`health`, inline UI), the 5-layer health check, per-user playback queue state, fuzzy title/artist matching, and `en-IN` support.

## Author

Built and maintained by **OMSHAKTHI (VIREON)**. The S3 rewrite, the custom AudioPlayer
skill, the Node 20 migration, and the entire Telegram management bot are my work on top
of the original scaffold. If this helped you, a star is appreciated.

## License

Original code is under its upstream license (ISC, © Andrei Ciobanu). Modifications and new components in this repository are released under the same license. See [LICENSE](LICENSE).
