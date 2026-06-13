#!/usr/bin/env node
// remove_song.js — remove a track by DynamoDB id, then regenerate the catalog,
// rebuild the Alexa interaction models, and publish both locales.
//
// Usage: node remove_song.js "<id>"
// Emits STEP:/RESULT:{json} lines for the Telegram bot to parse.

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const AWS = require('aws-sdk');

const REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET = process.env.MUSIC_BUCKET || 'your-music-bucket-name';
const TABLE = 'cloud-music';
const SKILL = process.env.SKILL_ID || 'amzn1.ask.skill.YOUR-SKILL-ID';

const HERE = __dirname;
const PROJECT = path.resolve(HERE, '..');
const BUILD_MODELS = path.join(PROJECT, 'skill-package', 'build-models.js');
const MODEL_DIR = path.join(PROJECT, 'skill-package', 'interactionModels', 'custom');
const MP3_DIR = path.join(HERE, 'mp3', 'clean');
const ASK = process.env.ASK_BIN || (process.env.HOME + '/.npm-global/bin/ask');

AWS.config.update({ region: REGION });
const s3 = new AWS.S3({ signatureVersion: 'v4' });
const doc = new AWS.DynamoDB.DocumentClient();

const step = (m) => console.log('STEP:' + m);
const done = (obj) => {
    console.log('RESULT:' + JSON.stringify(obj));
    process.exit(obj.ok ? 0 : 1);
};

async function main() {
    const id = process.argv[2];
    if (!id) done({ ok: false, error: 'no id provided' });

    // 1. Look up the item
    step('finding track');
    const got = await doc.get({ TableName: TABLE, Key: { id } }).promise();
    const item = got.Item;
    if (!item || String(item.id).startsWith('STATE#') || !item.s3) {
        done({ ok: false, error: 'track not found (already removed?)' });
    }
    const title = (item.metadata && item.metadata.common && item.metadata.common.title) || '(untitled)';
    const key = item.s3.key;

    // 2. Delete from DynamoDB
    step(`removing "${title}"`);
    await doc.delete({ TableName: TABLE, Key: { id } }).promise();

    // 3. Delete from S3 (best-effort)
    try {
        await s3.deleteObject({ Bucket: BUCKET, Key: key }).promise();
    } catch (e) {
        console.log('S3 delete warning:', (e.message || e).slice(0, 120));
    }

    // 4. Remove local mp3 copy (best-effort)
    try {
        const local = path.join(MP3_DIR, path.basename(key));
        if (fs.existsSync(local)) fs.unlinkSync(local);
    } catch (e) { /* ignore */ }

    // 5. Rebuild catalog
    step('rebuilding catalog');
    execSync(`node "${path.join(HERE, 'index.js')}" catalog`, { cwd: HERE, stdio: 'ignore', timeout: 60000 });

    // 6. Rebuild interaction models
    step('rebuilding voice model');
    execSync(`node "${BUILD_MODELS}"`, { stdio: 'ignore', timeout: 60000 });

    // 7. Publish both locales
    step('publishing voice model (~1 min)');
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

    // Count remaining real tracks
    const scan = await doc.scan({ TableName: TABLE }).promise();
    const count = (scan.Items || []).filter(
        (it) => it.id && !String(it.id).startsWith('STATE#') && it.s3
    ).length;

    done({ ok: true, title, count, modelWarn });
}

main().catch((e) => done({ ok: false, error: (e && e.message) || String(e) }));
