# vibeReply

A Chrome extension that generates 6 short, natural replies for X (Twitter) posts in the chill / fun / wholesome / wow / oddly satisfying niche. Uses Google Gemini for multimodal understanding (caption + image + video frames).

## Install (developer mode)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Click the extension icon, paste your Gemini API key, click **Save API Key**

Get a free Gemini API key at https://aistudio.google.com/apikey

## Phone app (Android, works with the X app)

The `mobile/` folder is a small web app you install on your phone. In the X app, tap **Share** on a post and pick **vibeReply**: it reads the post from its link (through FxTwitter's free public API), writes the replies with the same code, prompt and rules as the extension (it loads `background.js` directly), and you tap a reply to copy it, then paste it in X. Settings are the extension's own settings page (`popup.html`).

It has to be online on an `https://` address before Android can install it. Free with GitHub Pages:

1. On github.com, create a repository (for example `vibereply`), click **uploading an existing file**, drag in everything in this folder (including the `mobile` folder) and click **Commit changes**
2. Go to the repository's **Settings → Pages**, set **Source** to *Deploy from a branch*, branch `main`, folder `/ (root)`, and click **Save**
3. After a minute or two the app is at `https://YOUR-USERNAME.github.io/vibereply/mobile/`

On the phone:

1. Open that address in **Chrome**, then tap the ⋮ menu → **Add to home screen** → **Install**
2. Open vibeReply from your home screen, tap the gear icon, add your Gemini key(s) (and Groq/OpenRouter if you use them), tap **Done**. Keys are saved only on the phone, not in the extension and not online
3. In the X app, on any post: tap the **Share** icon → **Share via…** → **vibeReply**. If it's not in the list, tap **Copy link** and paste it into the box at the top of vibeReply

Limits: posts from private (protected) accounts can't be read. The repository is public on a free GitHub plan, but it contains only code, never your keys.

## How it works

- Two buttons are added to the action bar of every post on x.com: **Vibe Reply** (sparkle, AI replies) and **Write your own reply** (pencil, no AI)
- The pencil opens the panel on that post without calling any AI, so it works with no API key and uses no quota: the "Your reply" box gets the cursor, you write or paste your reply, and **Type into reply** types it into the post's reply box (see below). The AI is used only if you then press Regenerate or Fix & improve
- On a Vibe Reply click, the extension extracts:
  - The caption text
  - Any image URLs (`pbs.twimg.com`)
  - For videos, the poster (still frame) thumbnail
- The background worker fetches each media URL, base64-encodes it, and sends it to **Gemini 3.5 Flash-Lite** (fast, minimal thinking) along with the caption. Choose **Smarter** under Reply Speed to use **Gemini 3.8 Flash** first instead (slower, it always thinks before answering). Either way, the other model is used on the same key if the first fails or is out of quota. The panel shows which model answered and how long it took
- **DeepSeek** (optional keys, paid but very cheap): uses `deepseek-flash`, which reads images. For replies it uses its **own prompt** (`buildDeepSeekPrompt`): 7 simple replies as @0xnormal_, the way a normal person reacts after reading the post once, with no reply types or technique: simple reactions, agreeing or disagreeing in plain words, at most 2 simple questions, and a light joke only on a light post. No tips or advice nobody asked for, no explaining or breaking the post down, no expert words or market talk the post doesn't use, no hot takes, predictions, wordplay or clever one-liners. Usually 3 to 12 words, never more than 20. When the post asks its audience something ("what's one skill...", "drop your...", a poll), all 7 replies just answer it, each with a different concrete answer (no questions back, no general advice). It takes the post at face value rather than doubting it, in plain words anyone gets in one quick read. It gets the whole post, like the other providers (text, author, who it replies to, quoted post, link preview, image descriptions, media, and the note that a video is only one still frame). It first writes how it read the post ("AI read it as: ..." in the panel, so a misread is easy to spot) and lists the post's concrete details, and every reply must be about one of them. It thinks at high effort before answering (slower, usually 5 to 20s, but it reads the post properly). Replies are lightly cleaned (quotes, hashtags, dashes, a final period); the author's @mention and one emoji are kept, as the prompt allows. So DeepSeek replies don't follow the 6-replies / 2-questions rules below. Fix & improve on DeepSeek uses the current prompt. By default it goes **first**, before Gemini; turn off **Use DeepSeek first** in settings to use it only after Gemini. Keys are managed like Gemini keys. A key that is out of balance is skipped for 30 minutes (top up at platform.deepseek.com)
- If every Gemini (and DeepSeek) key fails or is out of quota, it falls back to **Groq** (optional keys), then to **OpenRouter** (optional key)
- Groq keys are managed like Gemini keys: paste several, they are added to the saved ones, and each shows its status (ready / quota / invalid) with Copy and Remove buttons. Groq first tries `qwen/qwen3.8-27b` (reads images) on every key, then text-only `openai/gpt-oss-120b` on every key. Rate-limited keys are skipped until Groq's stated wait is over. Because these models are smaller than Gemini, Groq requests are tuned for sense over speed: the model thinks briefly before answering (hidden), runs at a lower temperature, first lists the post's key points and must tie every reply to one, and its answer is forced into an exact JSON shape. The text-only model is told the post has media it can't see, so it doesn't guess what's in it
- The AI returns JSON with its read of the post, a list of replies that are not questions, and a list of questions
- The side panel displays them with a copy icon next to each
- **Fix & improve your own reply:** type your reply in the "Your reply" box under the suggestions and click **Fix & improve** (or Ctrl+Enter). The post (caption + media) and your draft go to the AI, which returns a one-line note on what was wrong, a corrected version that keeps your meaning, and 3 more natural ways to say it, each with a copy button
- **Type into reply (letter by letter, no pasting):** every reply card has a keyboard icon next to the copy icon, and the "Your reply" box has a **Type into reply** button for a reply you wrote or pasted there. Instead of pasting, it types the reply into the post's reply box one letter at a time at a person's pace, with small random pauses between letters and longer ones between some words and after punctuation. Each letter goes in through the browser's own text insertion (a typed letter with a key press around it, never a paste). Where it types: X's open reply window if there is one, else the reply box you clicked into after picking the post, else it clicks the post's **Reply** button itself and types in the box that opens. If the box already has text, the reply goes after it. The bar at the bottom of the panel shows the progress and a **Stop** button; it also stops if the cursor leaves the reply box, and at the end it checks the box holds the whole reply. Typing a generated reply adds the next suffix, like copying; the "Your reply" box is typed exactly as written. Speed (Fast / Normal / Slow, about 100 / 60 / 40 words a minute) is under **Typing Speed** in settings (hidden in the phone app, which can't type into the X app). It never presses Reply: you check the text and send it

## Reply rules (enforced in the prompt and post-processed)

- The AI gets the whole post: text, author, who it replies to, the quoted post, link preview, image descriptions and the media
- It first writes one sentence on how it understood the post ("AI read it as: ..." in the panel), then writes replies based on that, so a misread is easy to spot
- Replies sound like a normal person who read the post once and typed a quick reply: simple reactions and simple questions in everyday words, usually 3 to 12 words. No technique: no tips or advice nobody asked for, no explaining why something matters, no "angles", hot takes, insights, wordplay or clever one-liners, and no expert words the post doesn't use
- Replies stay on the post's topic and mood (they use the post's own words for tickers, names and numbers; a serious post gets no jokes)
- No AI slop: no generic lines ("love this", "so true"), assistant voice ("truly", "wishing you"), hype, engagement bait, templates, or made-up facts and personal stories
- Optional **My Reply Style** setting: paste replies you wrote, and the AI copies your voice
- The AI writes 10 candidates (7 that are not questions, 3 questions); duplicates and ones that match known slop phrases are dropped. Each reply is checked by its wording (a "?" at the end, or starting like "how", "what", "did", "anyone"...), so a question in the wrong list is still counted as a question
- 6 are shown: 4 that are not questions and 2 questions, in slots 2 and 5. If there aren't enough good ones of a kind, fewer are shown instead of padding with generic lines or extra questions
- The "Fix & improve" feature uses the same rules and also tells you when your draft sounds generic

## Notes & limitations

- Video understanding is done via the **poster frame**, not the full video. For most chill / satisfying / wow clips this is enough. If you want full-video understanding, the next step would be:
  - Capture multiple frames from `<video>` via `<canvas>` (works only when the video is not CORS-tainted), or
  - Download the actual `.mp4` from the tweet's `video_info` and upload via Gemini's Files API.
- The extension does not auto-send replies: you copy and paste them, or let it type them into the reply box, and you press Reply yourself.
- Gemini free tier has per-minute / per-day limits; check your quota in AI Studio.

## File overview

- `manifest.json` – MV3 config, permissions for X, Twitter media domains, Gemini, DeepSeek, Groq and OpenRouter
- `background.js` – fetches media, calls Gemini, parses the replies and picks 2 questions + 4 others
- `content.js` – injects the button, side panel, the copy UI and the letter-by-letter typing
- `styles.css` – button + panel styling
- `popup.html` / `popup.js` / `popup-styles.css` – API key settings UI (also the phone app's settings screen)
- `mobile/` – the phone app: `index.html` / `app.js` / `app.css` (screen), `chrome-shim.js` (stands in for the `chrome.*` APIs so `background.js` and `popup.js` run unchanged), `manifest.webmanifest` (install + Share menu), `sw.js` (service worker), icons
