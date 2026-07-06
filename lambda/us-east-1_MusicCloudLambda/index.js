const b = require('./builders/');
const store = require('./persistence/');

const SKILL_NAME = 'Music Cloud';

const userIdOf = (event) =>
    (event.context && event.context.System && event.context.System.user && event.context.System.user.userId) ||
    (event.session && event.session.user && event.session.user.userId) ||
    'unknown-user';

const currentOffset = (event) =>
    (event.context && event.context.AudioPlayer && event.context.AudioPlayer.offsetInMilliseconds) || 0;

const slotValue = (event, name) => {
    try {
        const slot = event.request.intent.slots[name];
        if (!slot) return null;
        // Prefer resolved catalog/custom-slot value when available.
        const res = slot.resolutions && slot.resolutions.resolutionsPerAuthority;
        if (res) {
            for (const r of res) {
                if (r.status && r.status.code === 'ER_SUCCESS_MATCH' && r.values && r.values.length) {
                    return r.values[0].value.name;
                }
            }
        }
        return slot.value || null;
    } catch (e) {
        return null;
    }
};

exports.handler = async (event) => {
    console.log('REQUEST', JSON.stringify(event.request));
    const type = event.request.type;

    try {
        if (type === 'LaunchRequest') {
            return b.response({
                speech: `${SKILL_NAME} ready. Say, play a song, or name a track or artist.`,
                endSession: false
            });
        }

        if (type === 'IntentRequest') {
            return await handleIntent(event);
        }

        if (type && type.startsWith('AudioPlayer.')) {
            return await handleAudioPlayer(event);
        }

        if (type && type.startsWith('PlaybackController.')) {
            return await handlePlaybackController(event);
        }

        if (type === 'SessionEndedRequest' || type === 'System.ExceptionEncountered') {
            return b.response({ endSession: true });
        }
    } catch (err) {
        console.error('HANDLER_ERROR', err);
        return b.response({ speech: 'Sorry, something went wrong playing that.', endSession: true });
    }

    return b.response({ endSession: true });
};

// ---- Intent routing -------------------------------------------------------

const handleIntent = async (event) => {
    const name = event.request.intent.name;
    const userId = userIdOf(event);

    switch (name) {
        case 'PlaySongIntent':
            return playSong(event, userId);
        case 'PlayArtistIntent':
            return playArtist(event, userId);
        case 'PlayAllIntent':
            return playLibrary(event, userId);
        case 'ShuffleIntent':
            return playAll(event, userId);
        case 'AMAZON.ResumeIntent':
            return resume(event, userId);
        case 'AMAZON.NextIntent':
        case 'AMAZON.NextCommandIssued':
            return skip(event, userId, +1);
        case 'AMAZON.PreviousIntent':
            return skip(event, userId, -1);
        case 'AMAZON.StartOverIntent':
            return startOver(event, userId);
        case 'AMAZON.PauseIntent':
            return pause(event, userId);
        case 'AMAZON.CancelIntent':
        case 'AMAZON.StopIntent':
            return b.response({ directives: [b.stopDirective()], endSession: true });
        case 'AMAZON.HelpIntent':
            return b.response({
                speech: `Say, play, and the name of a song or artist. You can also say next, previous, pause, or resume.`,
                endSession: false
            });
        case 'AMAZON.FallbackIntent':
            return b.response({
                speech: `I didn't catch that. Try, play, and a song name.`,
                endSession: false
            });
        default:
            return b.response({ speech: `I can't do that yet.`, endSession: true });
    }
};

// ---- Playback intents -----------------------------------------------------

// Resolve the first playable track at or after startPos, wrapping once around
// the queue and skipping ids that no longer exist (e.g. removed songs).
const resolveValid = async (order, startPos, dir = +1) => {
    const n = order.length;
    for (let step = 0; step < n; step++) {
        const pos = ((startPos + dir * step) % n + n) % n;
        const item = await store.getById(order[pos]);
        if (item) return { item, pos };
    }
    return null;
};

const startQueue = async (userId, order, startPos, offset = 0) => {
    if (!order.length) {
        return b.response({ speech: `I couldn't find that in your library.`, endSession: true });
    }
    const clamped = Math.max(0, Math.min(startPos, order.length - 1));
    const found = await resolveValid(order, clamped, +1);
    if (!found) {
        return b.response({ speech: `Your library is empty.`, endSession: true });
    }
    const { item, pos } = found;
    // Keep the on-disk queue clean so stale/removed ids don't linger.
    const cleanOrder = order;
    await store.putState(userId, cleanOrder, pos, offset);
    return b.response({
        speech: `Playing ${b.titleOf(item)}.`,
        directives: [b.playDirective(item, pos, offset)],
        endSession: true
    });
};

const playSong = async (event, userId) => {
    const q = slotValue(event, 'song');
    // Bare "ask Music Cloud to play" (no song named) => play the whole library
    // in repeat/playlist mode.
    if (!q) return playLibrary(event, userId);
    const match = await store.matchTrack(q);
    if (!match) return b.response({ speech: `I couldn't find ${q} in your library.`, endSession: true });

    // Queue = matched song first, then the rest of the library for Next.
    const all = await store.getAllTracks();
    const order = [match.id, ...all.map((t) => t.id).filter((id) => id !== match.id)];
    return startQueue(userId, order, 0);
};

const playArtist = async (event, userId) => {
    const q = slotValue(event, 'artist');
    if (!q) return b.response({ speech: `Which artist?`, endSession: false });
    const matched = await store.tracksByArtist(q);
    if (!matched.length) return b.response({ speech: `I couldn't find ${q} in your library.`, endSession: true });
    return startQueue(userId, matched.map((t) => t.id), 0);
};

// Whole library in stable order (repeat playlist mode via looping enqueue).
const playLibrary = async (event, userId) => {
    const all = await store.getAllTracks();
    if (!all.length) return b.response({ speech: `Your library is empty.`, endSession: true });
    return startQueue(userId, all.map((t) => t.id), 0);
};

const playAll = async (event, userId) => {
    const all = await store.getAllTracks();
    if (!all.length) return b.response({ speech: `Your library is empty.`, endSession: true });
    // light shuffle
    const ids = all.map((t) => t.id);
    for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    return startQueue(userId, ids, 0);
};

const skip = async (event, userId, delta) => {
    const st = await store.getState(userId);
    if (!st || !st.order || !st.order.length) {
        return playAll(event, userId);
    }
    let pos = st.pos + delta;
    if (pos < 0) pos = 0;
    if (pos >= st.order.length) pos = 0; // wrap to start
    return startQueue(userId, st.order, pos);
};

const startOver = async (event, userId) => {
    const st = await store.getState(userId);
    if (!st || !st.order || !st.order.length) return playAll(event, userId);
    return startQueue(userId, st.order, st.pos, 0);
};

const pause = async (event, userId) => {
    const st = await store.getState(userId);
    if (st) {
        await store.putState(userId, st.order, st.pos, currentOffset(event));
    }
    return b.response({ directives: [b.stopDirective()], endSession: true });
};

const resume = async (event, userId) => {
    const st = await store.getState(userId);
    if (!st || !st.order || !st.order.length) return playAll(event, userId);
    return startQueue(userId, st.order, st.pos, st.offset || 0);
};

// ---- AudioPlayer lifecycle ------------------------------------------------

const handleAudioPlayer = async (event) => {
    const userId = userIdOf(event);
    const type = event.request.type;
    const token = event.request.token;
    const { pos } = b.parseToken(token);

    switch (type) {
        case 'AudioPlayer.PlaybackStarted': {
            const st = await store.getState(userId);
            if (st && st.order) await store.putState(userId, st.order, pos, 0);
            return b.response({ endSession: true });
        }
        case 'AudioPlayer.PlaybackNearlyFinished': {
            const st = await store.getState(userId);
            if (!st || !st.order || !st.order.length) return b.response({ endSession: true });
            // Repeat/playlist mode: wrap past the end, and skip any removed tracks.
            const found = await resolveValid(st.order, pos + 1, +1);
            if (!found) return b.response({ endSession: true });
            return b.response({
                directives: [b.enqueueDirective(found.item, found.pos, token)],
                endSession: true
            });
        }
        case 'AudioPlayer.PlaybackStopped': {
            const st = await store.getState(userId);
            if (st && st.order) await store.putState(userId, st.order, pos, currentOffset(event));
            return b.response({ endSession: true });
        }
        case 'AudioPlayer.PlaybackFailed': {
            // A stream can fail if its track was removed after being enqueued.
            // Recover by jumping to the next valid track instead of going silent.
            console.error('PLAYBACK_FAILED', JSON.stringify(event.request.error || {}));
            const st = await store.getState(userId);
            if (!st || !st.order || !st.order.length) return b.response({ endSession: true });
            const found = await resolveValid(st.order, pos + 1, +1);
            if (!found) return b.response({ endSession: true });
            await store.putState(userId, st.order, found.pos, 0);
            return b.response({
                directives: [b.playDirective(found.item, found.pos, 0)],
                endSession: true
            });
        }
        case 'AudioPlayer.PlaybackFinished':
        default:
            return b.response({ endSession: true });
    }
};

// ---- Hardware / remote transport buttons ----------------------------------

const handlePlaybackController = async (event) => {
    const userId = userIdOf(event);
    const cmd = event.request.type;
    switch (cmd) {
        case 'PlaybackController.PlayCommandIssued':
            return resume(event, userId);
        case 'PlaybackController.PauseCommandIssued':
            return pause(event, userId);
        case 'PlaybackController.NextCommandIssued':
            return skip(event, userId, +1);
        case 'PlaybackController.PreviousCommandIssued':
            return skip(event, userId, -1);
        default:
            return b.response({ endSession: true });
    }
};
