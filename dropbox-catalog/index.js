require('dotenv').config();
const crypto = require('crypto');
const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const recursive = require('recursive-readdir');
const { promisify } = require('util');
const Promise = require('bluebird');

const AWS = require("aws-sdk");
AWS.config.update({ region: process.env.AWS_REGION || 'us-east-1' });
const docClient = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const putAsync = promisify(docClient.put).bind(docClient);
const scanAsync = promisify(docClient.scan).bind(docClient);

const mm = require('music-metadata');

const BUCKET = process.env.MUSIC_BUCKET;

const argv = require('yargs')
    .demandCommand()
    .command('upload', 'Uploads the specified directory to S3', (yargs) => {
        yargs.alias('d', 'dir')
            .nargs('d', 1)
            .describe('d', 'Directory')
            .example('$0 upload -d ./mp3/', 'uploads the specified directory to S3')
            .demandOption(['d'])
    })
    .command('catalog', 'Creates the catalog files (songs.json, artists.json)')
    .alias('h', 'help')
    .argv

const hash = (value) => {
    return crypto.createHash('sha1').update(value).digest('base64');
}

const readMetadata = async (filePath) => {
    const metadata = await mm.parseFile(filePath, { native: false });
    return { metadata, filePath };
}

const scanDirectory = async (dir) => {
    return await promisify(recursive)(dir);
}

const uploadToS3 = async (entry) => {
    const key = 'mp3/' + path.basename(entry.filePath);
    const content = await promisify(fs.readFile)(entry.filePath);
    await s3.putObject({
        Bucket: BUCKET,
        Key: key,
        Body: content,
        ContentType: 'audio/mpeg'
    }).promise();
    console.log('Uploaded:', entry.filePath, '->', key);
    entry.s3 = { bucket: BUCKET, key: key };
    entry.id = hash(key);
    entry.artist_id = hash(entry.metadata.common.artist || 'Unknown Artist');
    return entry;
}

const persistToDynamoDB = async (entry) => {
    let item = _.pick(entry, ['id',
        'artist_id',
        'metadata.common.title',
        'metadata.common.artist',
        'metadata.common.album',
        's3.bucket',
        's3.key']);
    // guarantee a title so voice matching works even with untagged files
    if (!_.get(item, 'metadata.common.title')) {
        _.set(item, 'metadata.common.title', path.basename(entry.filePath).replace(/\.[^.]+$/, ''));
    }
    await putAsync({
        TableName: 'cloud-music', Item: item
    });
    return entry;
}

const scanDynamoDb = async () => {
    const tableScanResult = await scanAsync({
        TableName: 'cloud-music'
    });
    // Only real tracks: exclude per-user playback STATE# rows and any item
    // lacking an s3 object or a title (those would poison the catalog/model).
    return (tableScanResult.Items || []).filter((it) =>
        it.id &&
        !String(it.id).startsWith('STATE#') &&
        it.s3 &&
        _.get(it, 'metadata.common.title')
    );
}

const mapToArtistCatalog = (id, name) => {
    return {
        "id": id,
        "names": [
            {
                "language": "en",
                "value": name
            }
        ],
        "popularity": {
            "default": 100
        },
        "lastUpdatedTime": new Date().toISOString(),
        "deleted": false
    };
}

const createArtistCatalog = (dbItems) => {
    const catalog = {
        "type": "AMAZON.MusicGroup",
        "version": 2.0,
        "locales": [
            {
                "country": "US",
                "language": "en"
            }
        ],
        "entities": []
    };

    let artists = {};

    dbItems.forEach(item => {
        artists[item.artist_id] = _.get(item, 'metadata.common.artist', 'Unknown Artist');
    });

    catalog.entities = _.toPairs(artists).map(([id, name]) => mapToArtistCatalog(id, name));

    return catalog;
}

const createSongCatalog = (dbItems) => {
    const catalog = {
        "type": "AMAZON.MusicRecording",
        "version": 2.0,
        "locales": [
            {
                "country": "US",
                "language": "en"
            }
        ],
        "entities": []
    };

    catalog.entities = dbItems.map(item => mapToSongsCatalog(item));

    return catalog;
}

const mapToSongsCatalog = (entry) => {
    return {
        "id": entry.id,
        "names": [
            {
                "language": "en",
                "value": _.get(entry, 'metadata.common.title')
            }
        ],
        "popularity": {
            "default": 100
        },
        "lastUpdatedTime": new Date().toISOString(),
        "artists": entry.artist_id ? [
            {
                "id": entry.artist_id,
                "names": [
                    {
                        "language": "en",
                        "value": _.get(entry, 'metadata.common.artist', 'Unknown Artist')
                    }
                ]
            }
        ] : [],
        "albums": _.get(entry, 'metadata.common.album') ? [
            {
                "id": entry.metadata.common.album,
                "names": [
                    {
                        "language": "en",
                        "value": entry.metadata.common.album
                    }
                ],
                "releaseType": "Studio Album"
            }
        ] : [],
        "deleted": false
    }
}

if (argv._[0] === 'upload') {
    if (!BUCKET) {
        console.error('MUSIC_BUCKET is not set. Add it to .env');
        process.exit(1);
    }
    scanDirectory(argv.dir)
        .then(files => Promise.map(files, file => readMetadata(file)))
        .then(entries => Promise.map(entries, entry => uploadToS3(entry), { concurrency: 5 }))
        .then(entries => Promise.map(entries, entry => persistToDynamoDB(entry), { concurrency: 5 }))
        .then(entries => console.log(`Uploaded ${entries.length} files`))
        .catch(error => console.error(error));
}

if (argv._[0] === 'catalog') {
    (async () => {
        let dbItems = await scanDynamoDb();
        let catalog = createSongCatalog(dbItems);
        fs.writeFileSync('songs.json', JSON.stringify(catalog, null, 2));
        let artistCatalog = createArtistCatalog(dbItems);
        fs.writeFileSync('artists.json', JSON.stringify(artistCatalog, null, 2));
        console.log(`Wrote songs.json (${catalog.entities.length}) and artists.json (${artistCatalog.entities.length})`);
    })();
}
