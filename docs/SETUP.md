# Music Cloud — Deployment Guide

This walks you through standing up Music Cloud from scratch. Budget ~30–45 minutes the first time.

## 0. Prerequisites

- An **AWS account** (this guide uses `us-east-1`).
- An **Amazon Developer account** (developer.amazon.com) — this can be a different account from your AWS one. Use the same Amazon account your Echo is registered to so the dev skill shows up on your device.
- **Node.js 20+** and **npm**.
- **ask-cli v2**: `npm install -g ask-cli@2` then `ask configure`.
- **AWS CLI**, configured: `aws configure` (region `us-east-1`).
- **yt-dlp** and **ffmpeg** (only needed for the add-song pipeline / bot).

> **IAM note:** don't use root AWS access keys. Create an IAM user with least-privilege: `s3:PutObject`/`GetObject`/`DeleteObject` on your one bucket, and DynamoDB read/write on the `cloud-music` table only.

## 1. Deploy the infrastructure

```bash
aws cloudformation deploy \
  --template-file ./infrastructure/music-cloud.json \
  --stack-name music-cloud-stack \
  --capabilities CAPABILITY_IAM

aws cloudformation describe-stacks --stack-name music-cloud-stack
```

This creates the `MusicCloudLambda` function, the `cloud-music` DynamoDB table (with the `artist_id-id-index` GSI), and the IAM role.

## 2. Create the private S3 bucket

```bash
aws s3api create-bucket --bucket your-music-bucket-name --region us-east-1
aws s3api put-public-access-block --bucket your-music-bucket-name \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

MP3s live under the `mp3/` prefix. The bucket stays fully private — the Lambda mints 6-hour presigned URLs at playback time.

## 3. Configure environment

```bash
cp dropbox-catalog/.env.template dropbox-catalog/.env
```

Fill in:

```
MUSIC_BUCKET=your-music-bucket-name
AWS_REGION=us-east-1
AWS_SDK_LOAD_CONFIG=true
SKILL_ID=amzn1.ask.skill.YOUR-SKILL-ID   # set after step 5
```

## 4. Package the Lambda

```bash
cd lambda/us-east-1_MusicCloudLambda
npm install          # bundles aws-sdk v2 (node20 does not preinstall it)
cd ../..
```

## 5. Create the Alexa skill

> ### ⚠️ The chicken-and-egg gotcha
> Creating a custom skill whose manifest points at your Lambda **fails at create-time** with `trigger setting … is invalid`, because the Lambda's resource policy doesn't yet permit the not-yet-existent skill id. This leaves a zombie skill.
>
> **The workaround:**
> 1. Add a **broad** invoke permission to the Lambda first (principal `alexa-appkit.amazon.com`, no event-source-token).
> 2. Create the skill (`ask smapi create-skill-for-vendor -m skill-package/skill-create-custom.json`).
> 3. Now add a **skill-id-scoped** invoke permission for the new skill id.
> 4. **Remove the broad permission.** Never leave it in place.

```bash
# 1. broad permission (temporary)
aws lambda add-permission --function-name MusicCloudLambda \
  --statement-id alexa-broad --action lambda:InvokeFunction \
  --principal alexa-appkit.amazon.com

# 2. create the skill (note the returned skill id)
ask smapi create-skill-for-vendor -m skill-package/skill-create-custom.json

# 3. scoped permission
aws lambda add-permission --function-name MusicCloudLambda \
  --statement-id alexa-scoped --action lambda:InvokeFunction \
  --principal alexa-appkit.amazon.com \
  --event-source-token amzn1.ask.skill.YOUR-SKILL-ID

# 4. remove the broad one
aws lambda remove-permission --function-name MusicCloudLambda --statement-id alexa-broad
```

Put the returned skill id into your `.env` (`SKILL_ID`) and into `skill-package/skill-create-custom.json`'s Lambda ARN if needed.

## 6. Upload the Lambda code and interaction models

```bash
# deploy code
ask deploy

# build + upload voice models (both locales)
cd skill-package && node build-models.js && cd ..
ask smapi set-interaction-model -s amzn1.ask.skill.YOUR-SKILL-ID \
  -g development -l en-US --interaction-model file:skill-package/interactionModels/custom/en-US.json
ask smapi set-interaction-model -s amzn1.ask.skill.YOUR-SKILL-ID \
  -g development -l en-IN --interaction-model file:skill-package/interactionModels/custom/en-IN.json
```

## 7. Enable the skill (easy to miss)

A dev/unpublished custom skill must be **explicitly enabled** or voice invocation silently fails:

```bash
ask smapi set-skill-enablement -s amzn1.ask.skill.YOUR-SKILL-ID --stage development
```

## 8. Add your first songs

Either directly:

```bash
node dropbox-catalog/add_song.js "https://youtube.com/watch?v=..."
```

…or via the Telegram bot (see below). Then:

> **Alexa, ask Music Cloud to play &lt;song&gt;.**

## 9. (Optional) Run the Telegram bot

```bash
cd bot
echo "YOUR_BOTFATHER_TOKEN" > .tg_token && chmod 600 .tg_token
echo "YOUR_TELEGRAM_USER_ID" > allow.txt      # one id per line
python music_cloud_bot.py
```

Run it under systemd for always-on. The bot needs the same env vars (`MUSIC_BUCKET`, `SKILL_ID`, `AWS_REGION`, and paths to `yt-dlp` and `ask`). Example unit:

```ini
[Unit]
Description=Music Cloud Telegram bot
After=network-online.target

[Service]
WorkingDirectory=%h/music-cloud/bot
Environment=MUSIC_BUCKET=your-music-bucket-name
Environment=AWS_REGION=us-east-1
Environment=SKILL_ID=amzn1.ask.skill.YOUR-SKILL-ID
Environment=CATALOG_DIR=%h/music-cloud/dropbox-catalog
Environment=YTDLP=/usr/local/bin/yt-dlp
Environment=ASK_BIN=%h/.npm-global/bin/ask
ExecStart=/usr/bin/python3 music_cloud_bot.py
Restart=always

[Install]
WantedBy=default.target
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Voice invocation does nothing | Skill not enabled — run step 7. |
| `Playing music from provider … is not supported` | You registered the name as a music *provider* alias. Delete any old Music-Skill-Kit skill; use *"ask Music Cloud to play X"*, not *"play X on Music Cloud"*. |
| Model build fails `MissingSynonymValue` | Per-user `STATE#…` rows leaked into the catalog. `list_songs.js`/catalog build filter these out — keep that filter. |
| `yt-dlp` fails on a forced cookies file | Add `--ignore-config` to the yt-dlp calls. |
| `EXDEV: cross-device link` on download | `/tmp` and the workspace are different filesystems; copy+unlink instead of `rename`. |
| yt-dlp "syntax error: newline unexpected" | A corrupted HTML file is shadowing the real binary on `PATH`. Point at the real `/usr/bin/yt-dlp`. |

## Layers, at a glance

Run the health check any time:

```bash
node dropbox-catalog/health.js --text
```

It verifies DynamoDB (row count), S3 (object count), Lambda (`State`/`LastUpdateStatus`), yt-dlp (version), and the Alexa model build status for both locales.
