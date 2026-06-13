#!/usr/bin/env python3
"""Music Cloud Telegram bot (@awsmux8bot).

Send a YouTube / YouTube Music (or other yt-dlp supported) link and it will:
  download -> clean title -> upload to S3 + DynamoDB -> rebuild + publish the
  Alexa voice model, then reply with the invocation phrase.

Message formats:
  <url>
  <url> | <title>
  <url> | <title> | <artist>

Buttons / commands: /start /help /menu /list /remove /health

Locked to the Telegram ids in allow.txt (one per line).
"""
import json
import os
import re
import subprocess
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN = open(os.path.join(HERE, ".tg_token")).read().strip()
ALLOW_PATH = os.path.join(HERE, "allow.txt")

CATALOG_DIR = os.environ.get(
    "CATALOG_DIR",
    os.path.expanduser(
        "~/.openclaw/workspace/music-cloud-project/music-cloud/dropbox-catalog"
    ),
)
ADD_SCRIPT = os.path.join(CATALOG_DIR, "add_song.js")
LIST_SCRIPT = os.path.join(CATALOG_DIR, "list_songs.js")
REMOVE_SCRIPT = os.path.join(CATALOG_DIR, "remove_song.js")
HEALTH_SCRIPT = os.path.join(CATALOG_DIR, "health.js")

API = f"https://api.telegram.org/bot{TOKEN}"
URL_RE = re.compile(r"https?://\S+")

# Map short callback tokens -> full DynamoDB ids (ids contain chars unsafe/long
# for callback_data, which is capped at 64 bytes). Rebuilt on each /remove.
REMOVE_MAP = {}


# ---------------------------------------------------------------- Telegram API
def api_call(method, params, is_json=False):
    if is_json:
        data = json.dumps(params).encode()
        headers = {"Content-Type": "application/json"}
    else:
        data = urllib.parse.urlencode(params).encode()
        headers = {}
    req = urllib.request.Request(f"{API}/{method}", data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=70) as r:
            return json.load(r)
    except Exception as e:
        print("api_call error", method, e, flush=True)
        return None


def send(chat_id, text, keyboard=None):
    p = {"chat_id": chat_id, "text": text, "disable_web_page_preview": True}
    if keyboard is not None:
        p["reply_markup"] = {"inline_keyboard": keyboard}
    return api_call("sendMessage", p, is_json=True)


def send_get_id(chat_id, text, keyboard=None):
    r = send(chat_id, text, keyboard)
    if r and r.get("ok"):
        return r["result"]["message_id"]
    return None


def edit(chat_id, message_id, text, keyboard=None):
    p = {"chat_id": chat_id, "message_id": message_id, "text": text,
         "disable_web_page_preview": True}
    if keyboard is not None:
        p["reply_markup"] = {"inline_keyboard": keyboard}
    api_call("editMessageText", p, is_json=True)


def answer_cb(cb_id, text=None):
    p = {"callback_query_id": cb_id}
    if text:
        p["text"] = text
    api_call("answerCallbackQuery", p, is_json=True)


# ---------------------------------------------------------------- helpers
def allowed_ids():
    try:
        with open(ALLOW_PATH) as f:
            return {ln.strip() for ln in f if ln.strip() and not ln.startswith("#")}
    except FileNotFoundError:
        return set()


def run_stream(script, arg, chat_id, mid):
    """Run a node script that emits STEP:/RESULT: lines; live-edit progress."""
    env = dict(os.environ)
    args = ["node", script]
    if isinstance(arg, list):
        args += arg
    elif arg is not None:
        args.append(arg)
    proc = subprocess.Popen(
        args, cwd=CATALOG_DIR, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    result = None
    for line in proc.stdout:
        line = line.rstrip()
        if line.startswith("STEP:"):
            if mid:
                edit(chat_id, mid, f"⏳ {line[5:]}…")
        elif line.startswith("RESULT:"):
            try:
                result = json.loads(line[7:])
            except Exception:
                result = {"ok": False, "error": "could not parse result"}
        else:
            print(f"{os.path.basename(script)}:", line, flush=True)
    proc.wait()
    return result


MENU = [
    [{"text": "📋 List songs", "callback_data": "list"},
     {"text": "🗑 Remove", "callback_data": "remove"}],
    [{"text": "🩺 Health check", "callback_data": "health"},
     {"text": "❓ Help", "callback_data": "help"}],
]

HELP = (
    "🎵 Music Cloud bot\n\n"
    "Send a YouTube / YouTube Music link to add a song to your Alexa library:\n"
    "• <link>\n"
    "• <link> | Song Title\n"
    "• <link> | Song Title | Artist\n\n"
    "Then say: \"Alexa, ask Music Cloud to play <song>\".\n\n"
    "Buttons: 📋 List · 🗑 Remove · 🩺 Health\n"
    "Commands: /menu /list /remove /health"
)


# ---------------------------------------------------------------- actions
def do_add(chat_id, url, title, artist):
    mid = send_get_id(chat_id, f"⏳ Working on it…\n{url}")
    arg = [url]
    if title:
        arg += [title, artist or ""]
    result = run_stream(ADD_SCRIPT, arg, chat_id, mid)
    if not result:
        msg = "❌ Something went wrong (no result). Check logs."
    elif result.get("ok"):
        warn = f"\n⚠️ {result['modelWarn']}" if result.get("modelWarn") else ""
        art = result.get("artist")
        art_s = f" — {art}" if art and art != "Unknown Artist" else ""
        msg = (f"✅ Added: {result['title']}{art_s}\n"
               f"📚 Library: {result.get('count','?')} songs\n\n"
               f"Say: \"Alexa, ask Music Cloud to play {result['title']}\"{warn}")
    elif result.get("duplicate"):
        msg = f"ℹ️ {result.get('error')}"
    else:
        msg = f"❌ {result.get('error','unknown error')}"
    if mid:
        edit(chat_id, mid, msg)
    else:
        send(chat_id, msg)


def get_tracks():
    try:
        out = subprocess.run(["node", LIST_SCRIPT, "--json"], cwd=CATALOG_DIR,
                             capture_output=True, text=True, timeout=60).stdout.strip()
        data = json.loads(out.splitlines()[-1]) if out else []
        return data if isinstance(data, list) else []
    except Exception as e:
        print("get_tracks error", e, flush=True)
        return None


def do_list(chat_id, mid=None):
    tracks = get_tracks()
    if tracks is None:
        text = "❌ Couldn't read library."
    elif not tracks:
        text = "📚 Library is empty. Send me a link!"
    else:
        lines = [f"• {t['title']}" + (f" — {t['artist']}" if t.get('artist') else "")
                 for t in tracks]
        text = f"📚 Your library ({len(tracks)} songs):\n" + "\n".join(lines)
    text = text[:4000]
    if mid:
        edit(chat_id, mid, text, MENU)
    else:
        send(chat_id, text, MENU)


def do_remove_menu(chat_id, mid=None):
    global REMOVE_MAP
    tracks = get_tracks()
    if not tracks:
        txt = "📚 Nothing to remove." if tracks == [] else "❌ Couldn't read library."
        if mid:
            edit(chat_id, mid, txt, MENU)
        else:
            send(chat_id, txt, MENU)
        return
    REMOVE_MAP = {}
    kb = []
    for i, t in enumerate(tracks):
        tok = f"rm:{i}"
        REMOVE_MAP[str(i)] = {"id": t["id"], "title": t["title"]}
        label = t["title"][:40] + (f" — {t['artist']}" if t.get("artist") else "")
        kb.append([{"text": f"🗑 {label[:60]}", "callback_data": tok}])
    kb.append([{"text": "⬅️ Back", "callback_data": "menu"}])
    txt = "🗑 Tap a song to remove it:"
    if mid:
        edit(chat_id, mid, txt, kb)
    else:
        send(chat_id, txt, kb)


def do_remove_confirm(chat_id, mid, idx):
    entry = REMOVE_MAP.get(idx)
    if not entry:
        edit(chat_id, mid, "⚠️ That list expired. Open 🗑 Remove again.", MENU)
        return
    kb = [[{"text": f"✅ Yes, remove", "callback_data": f"rmyes:{idx}"},
           {"text": "❌ Cancel", "callback_data": "remove"}]]
    edit(chat_id, mid, f"Remove \"{entry['title']}\"?", kb)


def do_remove_exec(chat_id, mid, idx):
    entry = REMOVE_MAP.get(idx)
    if not entry:
        edit(chat_id, mid, "⚠️ That list expired. Open 🗑 Remove again.", MENU)
        return
    result = run_stream(REMOVE_SCRIPT, entry["id"], chat_id, mid)
    if result and result.get("ok"):
        warn = f"\n⚠️ {result['modelWarn']}" if result.get("modelWarn") else ""
        edit(chat_id, mid,
             f"✅ Removed: {result['title']}\n📚 Library: {result.get('count','?')} songs{warn}",
             MENU)
    else:
        err = result.get("error", "unknown error") if result else "no result"
        edit(chat_id, mid, f"❌ {err}", MENU)


def do_health(chat_id, mid=None):
    if mid:
        edit(chat_id, mid, "🩺 Running health check…")
    else:
        mid = send_get_id(chat_id, "🩺 Running health check…")
    try:
        out = subprocess.run(["node", HEALTH_SCRIPT], cwd=CATALOG_DIR,
                             capture_output=True, text=True, timeout=90).stdout
        result = None
        for line in out.splitlines():
            if line.startswith("RESULT:"):
                result = json.loads(line[7:])
        if not result:
            edit(chat_id, mid, "❌ Health check produced no result.", MENU)
            return
        head = "✅ All systems healthy." if result.get("ok") else "⚠️ Some checks failed."
        lines = [f"{'✅' if c['ok'] else '❌'} {c['name']}: {c['detail']}"
                 for c in result.get("checks", [])]
        edit(chat_id, mid, head + "\n\n" + "\n".join(lines), MENU)
    except Exception as e:
        edit(chat_id, mid, f"❌ Health check error: {e}", MENU)


def parse_message(text):
    m = URL_RE.search(text)
    if not m:
        return None
    url = m.group(0)
    rest = text[m.end():].strip()
    title = artist = None
    if rest.startswith("|"):
        parts = [p.strip() for p in rest.lstrip("|").split("|")]
        if parts:
            title = parts[0] or None
        if len(parts) > 1:
            artist = parts[1] or None
    return url, title, artist


# ---------------------------------------------------------------- dispatch
def handle_callback(cb, allow):
    frm = str(cb.get("from", {}).get("id", ""))
    msg = cb.get("message", {})
    chat_id = msg.get("chat", {}).get("id")
    mid = msg.get("message_id")
    data = cb.get("data", "")
    cb_id = cb.get("id")
    if allow and frm not in allow:
        answer_cb(cb_id, "Not authorized")
        return
    answer_cb(cb_id)
    if data == "menu":
        edit(chat_id, mid, "🎵 Music Cloud — pick an option:", MENU)
    elif data == "list":
        do_list(chat_id, mid)
    elif data == "help":
        edit(chat_id, mid, HELP, MENU)
    elif data == "remove":
        do_remove_menu(chat_id, mid)
    elif data == "health":
        do_health(chat_id, mid)
    elif data.startswith("rm:"):
        do_remove_confirm(chat_id, mid, data[3:])
    elif data.startswith("rmyes:"):
        do_remove_exec(chat_id, mid, data[6:])


def handle_message(msg, allow):
    frm = str(msg.get("from", {}).get("id", ""))
    chat_id = msg["chat"]["id"]
    if allow and frm not in allow:
        send(chat_id, "⛔ Not authorized.")
        print("blocked id", frm, flush=True)
        return
    text = (msg.get("text") or "").strip()
    if not text:
        return
    if text in ("/start", "/menu"):
        send(chat_id, "🎵 Music Cloud — send a link to add a song, or pick an option:", MENU)
    elif text == "/help":
        send(chat_id, HELP, MENU)
    elif text == "/list":
        do_list(chat_id)
    elif text == "/remove":
        do_remove_menu(chat_id)
    elif text == "/health":
        do_health(chat_id)
    else:
        parsed = parse_message(text)
        if not parsed:
            send(chat_id, "Send me a YouTube / YouTube Music link, or use the menu.", MENU)
            return
        url, title, artist = parsed
        try:
            do_add(chat_id, url, title, artist)
        except Exception as e:
            send(chat_id, f"❌ Error: {e}")
            print("do_add error", e, flush=True)


def main():
    allow = allowed_ids()
    print("Music Cloud bot starting. Allowed ids:", allow, flush=True)
    offset = None
    while True:
        params = {"timeout": 60}
        if offset is not None:
            params["offset"] = offset
        resp = api_call("getUpdates", params)
        if not resp or not resp.get("ok"):
            time.sleep(3)
            continue
        for upd in resp["result"]:
            offset = upd["update_id"] + 1
            if "callback_query" in upd:
                try:
                    handle_callback(upd["callback_query"], allow)
                except Exception as e:
                    print("callback error", e, flush=True)
                continue
            msg = upd.get("message") or upd.get("edited_message")
            if msg:
                try:
                    handle_message(msg, allow)
                except Exception as e:
                    print("message error", e, flush=True)


if __name__ == "__main__":
    main()
