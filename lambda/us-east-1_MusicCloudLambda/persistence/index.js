const AWS = require("aws-sdk");
const docClient = new AWS.DynamoDB.DocumentClient();

const TABLE = 'cloud-music';

// State items are stored in the same table with a prefixed id so they never
// collide with track ids (track ids are base64 sha1 hashes).
const stateKey = (userId) => 'STATE#' + userId;

const normalize = (s) =>
    (s || '')
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

let _cache = { at: 0, items: null };

const getAllTracks = async () => {
    // 30s in-memory cache to avoid rescanning on every AudioPlayer event.
    if (_cache.items && Date.now() - _cache.at < 30000) {
        return _cache.items;
    }
    let items = [];
    let ExclusiveStartKey = undefined;
    do {
        const res = await docClient
            .scan({ TableName: TABLE, ExclusiveStartKey })
            .promise();
        items = items.concat(res.Items || []);
        ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);

    // Only real tracks (exclude STATE# items), stable sort by id.
    items = items
        .filter((it) => it.id && !String(it.id).startsWith('STATE#') && it.s3)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    _cache = { at: Date.now(), items };
    return items;
};

module.exports = {
    getAllTracks,

    getById: async (id) => {
        const tracks = await getAllTracks();
        return tracks.find((t) => t.id === id) || null;
    },

    // Fuzzy title match against spoken slot value.
    matchTrack: async (query) => {
        const tracks = await getAllTracks();
        if (!tracks.length) return null;
        const q = normalize(query);
        if (!q) return null;

        // 1) exact normalized title
        let hit = tracks.find((t) => normalize(t.metadata.common.title) === q);
        if (hit) return hit;
        // 2) title contains query or query contains title
        hit = tracks.find((t) => {
            const t2 = normalize(t.metadata.common.title);
            return t2.includes(q) || q.includes(t2);
        });
        if (hit) return hit;
        // 3) token overlap score
        const qt = new Set(q.split(' '));
        let best = null;
        let bestScore = 0;
        for (const t of tracks) {
            const tt = normalize(t.metadata.common.title).split(' ');
            const score = tt.filter((w) => qt.has(w)).length;
            if (score > bestScore) {
                bestScore = score;
                best = t;
            }
        }
        return bestScore > 0 ? best : null;
    },

    // Return all track ids for an artist (fuzzy), in stable order.
    tracksByArtist: async (query) => {
        const tracks = await getAllTracks();
        const q = normalize(query);
        if (!q) return [];
        let matched = tracks.filter((t) => normalize(t.metadata.common.artist) === q);
        if (!matched.length) {
            matched = tracks.filter((t) => {
                const a = normalize(t.metadata.common.artist);
                return a && (a.includes(q) || q.includes(a));
            });
        }
        return matched;
    },

    getState: async (userId) => {
        const res = await docClient
            .get({ TableName: TABLE, Key: { id: stateKey(userId) } })
            .promise();
        return res.Item || null;
    },

    putState: async (userId, order, pos, offset) => {
        await docClient
            .put({
                TableName: TABLE,
                Item: {
                    id: stateKey(userId),
                    order: order,
                    pos: pos,
                    offset: offset || 0,
                    updatedAt: Date.now()
                }
            })
            .promise();
    }
};
