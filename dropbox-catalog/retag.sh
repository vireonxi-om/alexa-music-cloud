#!/bin/bash
# Re-tag downloaded MP3s with clean, speakable title/artist for Alexa voice matching.
set -e
cd "$(dirname "$0")/mp3"

# index|title|artist
map=(
"01|Nancy|Momoland"
"02|Ainsi Bas La Vida|DJ Anas"
"03|Sao Paulo|The Weeknd"
"04|Illuminati|Sushin Shyam"
"05|Unstoppable|Sia"
"06|Montagem Alquimia|Slowed"
"07|Hey Mama|David Guetta"
"08|Avangard|Lonown"
"09|Esse Cara|Sayfalse"
"10|Luna Bala|Slowed"
"11|Belly Dancer|Imanbek and Byor"
"12|Manda Lina|Synthmane"
"13|Amor Na Praia|Slowed"
"14|Oiia Oiia|W and W"
"15|Illuminati Mashup|DJ Dalal"
)

mkdir -p clean
for entry in "${map[@]}"; do
    idx="${entry%%|*}"
    rest="${entry#*|}"
    title="${rest%%|*}"
    artist="${rest#*|}"
    src="$(ls ${idx}\ -\ *.mp3 2>/dev/null | head -1)"
    if [ -z "$src" ]; then echo "MISSING idx $idx"; continue; fi
    out="clean/${idx} - ${title}.mp3"
    ffmpeg -y -v error -i "$src" -c copy -map_metadata -1 \
        -metadata title="$title" -metadata artist="$artist" "$out"
    echo "tagged: $title / $artist"
done
echo "DONE -> clean/"
