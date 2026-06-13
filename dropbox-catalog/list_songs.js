#!/usr/bin/env node
// list_songs.js — prints the library.
//   node list_songs.js          -> human lines ("• Title — Artist") + COUNT:n
//   node list_songs.js --json   -> JSON array of {id,title,artist} (for the bot)
const AWS = require('aws-sdk');
AWS.config.update({ region: process.env.AWS_REGION || 'us-east-1' });
const doc = new AWS.DynamoDB.DocumentClient();

const asJson = process.argv.includes('--json');

(async () => {
    const res = await doc.scan({ TableName: 'cloud-music' }).promise();
    const tracks = (res.Items || [])
        .filter((it) => it.id && !String(it.id).startsWith('STATE#') && it.s3)
        .map((it) => ({
            id: it.id,
            title: (it.metadata && it.metadata.common && it.metadata.common.title) || '(untitled)',
            artist: (it.metadata && it.metadata.common && it.metadata.common.artist) || ''
        }))
        .sort((a, b) => a.title.localeCompare(b.title));

    if (asJson) {
        console.log(JSON.stringify(tracks));
        return;
    }
    console.log('COUNT:' + tracks.length);
    tracks.forEach((t) => console.log(`• ${t.title}${t.artist ? ' — ' + t.artist : ''}`));
})().catch((e) => {
    if (asJson) console.log(JSON.stringify({ error: (e && e.message) || String(e) }));
    else console.error('ERR:' + ((e && e.message) || e));
    process.exit(1);
});
