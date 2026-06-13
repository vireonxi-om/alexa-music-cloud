#!/usr/bin/env node
// add_song.js — one-shot: download audio from a URL (YouTube / YT Music / etc),
// clean the title, upload to S3 + DynamoDB, regenerate the catalog, rebuild the
// Alexa interaction models, and push them to both locales.
//
// Usage:
//   node add_song.js "<url>" ["<title>"] ["<artist>"]
// Emits progress lines prefixed with "STEP:" and a final "RESULT:{json}" line
// so the Telegram bot can parse the outcome.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const AWS = require('aws-sdk');

const REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET = process.env.MUSIC_BUCKET || 'your-music-bucket-name';
const TABLE = 'cloud-music';
const SKILL = process.env.SKILL_ID || 'amzn1.ask.skill.YOUR-SKILL-ID';

const HERE = __dirname; // dropbox-catalog
const PROJECT = path.resolve(HERE, '..'); // music-cloud
const MP3_DIR = path.join(HERE, 'mp3', 'clean');
const BUILD_MODELS = path.join(PROJECT, 'skill-package', 'build-models.js');
const MODEL_DIR = path.join(PROJECT, 'skill-package', 'interactionModels', 'custom');
const YTDLP = process.env.YTDLP || '/usr/bin/yt-dlp';
const ASK = process.env.ASK_BIN || (process.env.HOME + '/.npm-global/bin/ask');

AWS.config.update({ region: REGION });
const s3 = new AWS.S3({ signatureVersion: 'v4' });
const doc = new AWS.DynamoDB.DocumentClient();

const hash = (v) => crypto.createHash('sha1').update(v).digest('base64');
const step = (m) => console.log('STEP:' + m);
const done = (obj) => {
    console.log('RESULT:' + JSON.stringify(obj));
    process.exit(obj.ok ? 0 : 1);
};

// Strip junk brackets/keywords so the spoken title is clean for Alexa.
const cleanTitle = (raw) => {
    let t = raw || '';
    // drop bracketed segments that are clearly not part of the name
    t = t.replace(/[\(\[\{][^\)\]\}]*\b(official|video|audio|lyric|lyrics|hd|4k|mv|visualizer|explicit|m\/v)\b[^\)\]\}]*[\)\]\}]/gi, ' ');
    // drop trailing "| something", "feat.", quality tags
    t = t.replace(/\s*[\|｜]\s*.*$/g, ' ');
    t = t.replace(/\s*[-–—]\s*(official|lyric|audio|video).*$/gi, ' ');
    t = t.replace(/[\"“”]/g, ' ');
    t = t.replace(/\s+/g, ' ').trim();
    // Title-case-ish: keep as-is but cap length
    if (t.length > 60) t = t.slice(0, 60).trim();
    return t || raw;
};

const safeFilename = (title) =>
    title.replace(/[^a-zA-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/ /g, '_') || 'track';

async function main() {
    const url = process.argv[2];
    const explicitTitle = process.argv[3] && process.argv[3].trim();
    const explicitArtist = process.argv[4] && process.argv[4].trim();

    if (!url) done({ ok: false, error: 'no url provided' });

    // 1. Fetch metadata (fast, no download)
    step('reading link metadata');
    let ytTitle = '';
    let ytArtist = '';
    let vid = '';
    try {
        const meta = execFileSync(
            YTDLP,
            ['--ignore-config', '--no-playlist', '--skip-download', '--print', '%(title)s\t%(artist,uploader)s\t%(id)s', url],
            { encoding: 'utf8', timeout: 60000 }
        ).trim().split('\n').pop();
        [ytTitle, ytArtist, vid] = meta.split('\t');
    } catch (e) {
        done({ ok: false, error: 'could not read link (bad/unsupported URL?): ' + (e.message || e).slice(0, 200) });
    }

    const title = cleanTitle(explicitTitle || ytTitle);
    let artist = (explicitArtist || ytArtist || 'Unknown Artist').trim();
    artist = artist.replace(/\s*-\s*Topic$/i, '').trim() || 'Unknown Artist';

    // Duplicate guard by title (case-insensitive)
    step('checking for duplicate');
    const existing = await doc.scan({ TableName: TABLE }).promise();
    const dup = (existing.Items || []).find(
        (it) => it.metadata && it.metadata.common &&
            (it.metadata.common.title || '').toLowerCase() === title.toLowerCase()
    );
    if (dup) done({ ok: false, duplicate: true, title, artist, error: `"${title}" is already in your library.` });

    // 2. Download audio → mp3
    step(`downloading "${title}"`);
    fs.mkdirSync(MP3_DIR, { recursive: true });
    const tmpBase = path.join(os.tmpdir(), 'mc_' + (vid || Date.now()));
    try {
        execFileSync(
            YTDLP,
            ['--ignore-config', '-x', '--audio-format', 'mp3', '--audio-quality', '0', '--no-playlist',
             '-o', tmpBase + '.%(ext)s', url],
            { stdio: 'ignore', timeout: 300000 }
        );
    } catch (e) {
        done({ ok: false, error: 'download failed: ' + (e.message || e).slice(0, 200) });
    }
    const tmpMp3 = tmpBase + '.mp3';
    if (!fs.existsSync(tmpMp3)) done({ ok: false, error: 'download produced no mp3' });

    // Move into catalog dir with a clean, unique-ish name.
    // Use copy+unlink (not rename) so it works when /tmp is on a different
    // filesystem than the workspace (rename across devices throws EXDEV).
    const fname = safeFilename(title) + '.mp3';
    const finalPath = path.join(MP3_DIR, fname);
    try {
        fs.renameSync(tmpMp3, finalPath);
    } catch (e) {
        if (e.code === 'EXDEV') {
            fs.copyFileSync(tmpMp3, finalPath);
            fs.unlinkSync(tmpMp3);
        } else {
            throw e;
        }
    }

    // 3. Upload to S3
    const key = 'mp3/' + fname;
    step('uploading to cloud');
    await s3.putObject({
        Bucket: BUCKET,
        Key: key,
        Body: fs.readFileSync(finalPath),
        ContentType: 'audio/mpeg'
    }).promise();

    // 4. Write DynamoDB
    step('registering track');
    const item = {
        id: hash(key),
        artist_id: hash(artist),
        metadata: { common: { title, artist } },
        s3: { bucket: BUCKET, key }
    };
    await doc.put({ TableName: TABLE, Item: item }).promise();

    // 5. Regenerate catalog (songs.json / artists.json in dropbox-catalog dir)
    step('rebuilding catalog');
    execSync(`node "${path.join(HERE, 'index.js')}" catalog`, { cwd: HERE, stdio: 'ignore', timeout: 60000 });

    // 6. Rebuild interaction models
    step('rebuilding voice model');
    execSync(`node "${BUILD_MODELS}"`, { stdio: 'ignore', timeout: 60000 });

    // 7. Push models to both locales
    step('publishing voice model (this takes ~1 min)');
    let modelWarn = null;
    for (const locale of ['en-US', 'en-IN']) {
        try {
            execFileSync(
                ASK,
                ['smapi', 'set-interaction-model', '-s', SKILL, '--stage', 'development',
                 '--locale', locale, '--interaction-model', 'file:' + path.join(MODEL_DIR, locale + '.json')],
                { stdio: 'ignore', timeout: 120000 }
            );
        } catch (e) {
            modelWarn = `model push failed for ${locale}: ${(e.message || e).slice(0, 120)}`;
        }
    }

    const count = (existing.Items || []).filter(
        (it) => it.id && !String(it.id).startsWith('STATE#') && it.s3
    ).length + 1;

    done({ ok: true, title, artist, count, modelWarn });
}

main().catch((e) => done({ ok: false, error: (e && e.message) || String(e) }));
