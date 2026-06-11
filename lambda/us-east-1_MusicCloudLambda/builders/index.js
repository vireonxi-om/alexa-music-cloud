const AWS = require('aws-sdk');
const s3 = new AWS.S3({ signatureVersion: 'v4', region: process.env.AWS_REGION || 'us-east-1' });

// Presigned URL valid long enough for a full track to stream (and be re-queued).
const STREAM_TTL_SECONDS = 6 * 60 * 60; // 6h

const streamUriFor = (item) =>
    s3.getSignedUrl('getObject', {
        Bucket: item.s3.bucket,
        Key: item.s3.key,
        Expires: STREAM_TTL_SECONDS
    });

// token encodes queue position so AudioPlayer callbacks can resolve the item
// without extra state, while DynamoDB state holds the full order.
const tokenFor = (pos, trackId) => `${pos}::${trackId}`;
const parseToken = (token) => {
    if (!token) return { pos: 0, trackId: null };
    const idx = token.indexOf('::');
    if (idx === -1) return { pos: 0, trackId: token };
    return { pos: parseInt(token.slice(0, idx), 10) || 0, trackId: token.slice(idx + 2) };
};

const titleOf = (item) => (item && item.metadata && item.metadata.common && item.metadata.common.title) || 'track';
const artistOf = (item) => (item && item.metadata && item.metadata.common && item.metadata.common.artist) || '';

const response = ({ speech = null, directives = [], endSession = true }) => {
    const r = { version: '1.0', response: { shouldEndSession: endSession } };
    if (speech) {
        r.response.outputSpeech = { type: 'PlainText', text: speech };
    }
    if (directives.length) {
        r.response.directives = directives;
    }
    return r;
};

module.exports = {
    tokenFor,
    parseToken,
    titleOf,
    artistOf,
    response,
    STREAM_TTL_SECONDS,

    // REPLACE_ALL play of a specific queue position.
    playDirective: (item, pos, offset = 0) => ({
        type: 'AudioPlayer.Play',
        playBehavior: 'REPLACE_ALL',
        audioItem: {
            stream: {
                token: tokenFor(pos, item.id),
                url: streamUriFor(item),
                offsetInMilliseconds: offset
            },
            metadata: {
                title: titleOf(item),
                subtitle: artistOf(item)
            }
        }
    }),

    // ENQUEUE the next track after the currently playing one.
    enqueueDirective: (item, pos, expectedPreviousToken) => ({
        type: 'AudioPlayer.Play',
        playBehavior: 'ENQUEUE',
        audioItem: {
            stream: {
                token: tokenFor(pos, item.id),
                expectedPreviousToken: expectedPreviousToken,
                url: streamUriFor(item),
                offsetInMilliseconds: 0
            },
            metadata: {
                title: titleOf(item),
                subtitle: artistOf(item)
            }
        }
    }),

    stopDirective: () => ({ type: 'AudioPlayer.Stop' }),

    clearQueueDirective: () => ({
        type: 'AudioPlayer.ClearQueue',
        clearBehavior: 'CLEAR_ALL'
    })
};
