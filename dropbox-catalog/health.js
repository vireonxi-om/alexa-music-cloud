#!/usr/bin/env node
// health.js — check every layer of the Music Cloud stack.
// Prints RESULT:{json} with per-check status. Exit 0 if all pass, 1 otherwise.
//
//   node health.js          -> RESULT:{json}
//   node health.js --text   -> human-readable lines

const path = require('path');
const { execFileSync } = require('child_process');
const AWS = require('aws-sdk');

const REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET = process.env.MUSIC_BUCKET || 'your-music-bucket-name';
const TABLE = 'cloud-music';
const SKILL = process.env.SKILL_ID || 'amzn1.ask.skill.YOUR-SKILL-ID';
const LAMBDA = process.env.LAMBDA_NAME || 'MusicCloudLambda';
const YTDLP = process.env.YTDLP || '/usr/bin/yt-dlp';
const ASK = process.env.ASK_BIN || (process.env.HOME + '/.npm-global/bin/ask');

const asText = process.argv.includes('--text');

AWS.config.update({ region: REGION });
const doc = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3({ signatureVersion: 'v4' });
const lambda = new AWS.Lambda();

const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok, detail });

async function main() {
    // 1. DynamoDB reachable + track count
    let trackCount = 0;
    try {
        const scan = await doc.scan({ TableName: TABLE }).promise();
        trackCount = (scan.Items || []).filter(
            (it) => it.id && !String(it.id).startsWith('STATE#') && it.s3
        ).length;
        add('DynamoDB', true, `${trackCount} tracks`);
    } catch (e) {
        add('DynamoDB', false, (e.message || String(e)).slice(0, 100));
    }

    // 2. S3 bucket reachable + object count
    try {
        const list = await s3.listObjectsV2({ Bucket: BUCKET, Prefix: 'mp3/' }).promise();
        add('S3 bucket', true, `${list.KeyCount} objects`);
    } catch (e) {
        add('S3 bucket', false, (e.message || String(e)).slice(0, 100));
    }

    // 3. Lambda exists + last update state
    try {
        const cfg = await lambda.getFunctionConfiguration({ FunctionName: LAMBDA }).promise();
        const ok = cfg.State === 'Active' && cfg.LastUpdateStatus === 'Successful';
        add('Lambda', ok, `${cfg.State}/${cfg.LastUpdateStatus} ${cfg.Runtime}`);
    } catch (e) {
        add('Lambda', false, (e.message || String(e)).slice(0, 100));
    }

    // 4. yt-dlp usable
    try {
        const v = execFileSync(YTDLP, ['--version'], { encoding: 'utf8', timeout: 15000 }).trim();
        add('yt-dlp', true, v.split('\n')[0]);
    } catch (e) {
        add('yt-dlp', false, (e.message || String(e)).slice(0, 80));
    }

    // 5. Alexa skill model build status (both locales) via ask-cli
    try {
        const out = execFileSync(
            ASK,
            ['smapi', 'get-skill-status', '--skill-id', SKILL, '--resource', 'interactionModel'],
            { encoding: 'utf8', timeout: 30000 }
        );
        const d = JSON.parse(out);
        const im = d.interactionModel || {};
        const statuses = Object.keys(im).map(
            (loc) => `${loc}:${(im[loc].lastUpdateRequest || {}).status}`
        );
        const allOk = statuses.every((s) => s.endsWith('SUCCEEDED'));
        add('Alexa model', allOk, statuses.join(' ') || 'no locales');
    } catch (e) {
        add('Alexa model', false, (e.message || String(e)).slice(0, 80));
    }

    const allOk = checks.every((c) => c.ok);
    const result = { ok: allOk, trackCount, checks };

    if (asText) {
        checks.forEach((c) => console.log(`${c.ok ? '✅' : '❌'} ${c.name}: ${c.detail}`));
        console.log(allOk ? '\nAll systems healthy.' : '\n⚠️ Some checks failed.');
    } else {
        console.log('RESULT:' + JSON.stringify(result));
    }
    process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
    console.log('RESULT:' + JSON.stringify({ ok: false, error: (e && e.message) || String(e), checks }));
    process.exit(1);
});
