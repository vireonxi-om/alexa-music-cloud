// Generates custom interaction models (en-US + en-IN) for the Music Cloud
// AudioPlayer skill, sourcing slot values from the catalog files so spoken
// song/artist names resolve tightly.
const fs = require('fs');
const path = require('path');

const catDir = path.join(__dirname, '..', 'dropbox-catalog');
const songs = JSON.parse(fs.readFileSync(path.join(catDir, 'songs.json'), 'utf8'));
const artists = JSON.parse(fs.readFileSync(path.join(catDir, 'artists.json'), 'utf8'));

const nameOf = (e) => e.names[0].value;

const songValues = songs.entities.map((e) => ({ name: { value: nameOf(e) } }));
const artistValues = artists.entities.map((e) => ({ name: { value: nameOf(e) } }));

const model = (invocationName) => ({
    interactionModel: {
        languageModel: {
            invocationName: invocationName,
            intents: [
                { name: 'AMAZON.CancelIntent', samples: [] },
                { name: 'AMAZON.HelpIntent', samples: [] },
                { name: 'AMAZON.StopIntent', samples: [] },
                { name: 'AMAZON.NextIntent', samples: [] },
                { name: 'AMAZON.PreviousIntent', samples: [] },
                { name: 'AMAZON.PauseIntent', samples: [] },
                { name: 'AMAZON.ResumeIntent', samples: [] },
                { name: 'AMAZON.StartOverIntent', samples: [] },
                { name: 'AMAZON.FallbackIntent', samples: [] },
                {
                    name: 'PlaySongIntent',
                    slots: [{ name: 'song', type: 'SONG_NAMES' }],
                    samples: [
                        'play {song}',
                        'play the song {song}',
                        'play track {song}',
                        'put on {song}',
                        'start {song}',
                        'i want to hear {song}',
                        'play {song} song',
                        'play',
                        'play music',
                        'play a song',
                        'play something',
                        'start playing',
                        'just play'
                    ]
                },
                {
                    name: 'PlayArtistIntent',
                    slots: [{ name: 'artist', type: 'ARTIST_NAMES' }],
                    samples: [
                        'play artist {artist}',
                        'play songs by {artist}',
                        'play music by {artist}',
                        'play some {artist}',
                        'play {artist} music'
                    ]
                },
                {
                    name: 'PlayAllIntent',
                    slots: [],
                    samples: [
                        'play everything',
                        'play all songs',
                        'play all my music',
                        'play my library',
                        'play all',
                        'play the playlist',
                        'play my playlist'
                    ]
                },
                {
                    name: 'ShuffleIntent',
                    slots: [],
                    samples: [
                        'shuffle',
                        'shuffle all',
                        'shuffle my music',
                        'shuffle my library',
                        'shuffle everything',
                        'shuffle songs',
                        'play music on shuffle'
                    ]
                }
            ],
            types: [
                { name: 'SONG_NAMES', values: songValues },
                { name: 'ARTIST_NAMES', values: artistValues }
            ]
        }
    }
});

const outDir = path.join(__dirname, 'interactionModels', 'custom');
fs.mkdirSync(outDir, { recursive: true });

// Both locales share the invocation name "music cloud".
fs.writeFileSync(path.join(outDir, 'en-US.json'), JSON.stringify(model('music cloud'), null, 2));
fs.writeFileSync(path.join(outDir, 'en-IN.json'), JSON.stringify(model('music cloud'), null, 2));

console.log(
    `Wrote en-US.json + en-IN.json (${songValues.length} songs, ${artistValues.length} artists)`
);
