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

- A **Vibe Reply** button is added next to the action bar of every post on x.com
- On click, the extension extracts:
  - The caption text
  - Any image URLs (`pbs.twimg.com`)
  - For videos, the poster (still frame) thumbnail
- The background worker fetches each media URL, base64-encodes it, and sends it to **Gemini 3.5 Flash-Lite** (fast, minimal thinking) along with the caption. Choose **Smarter** under Reply Speed to use **Gemini 3.8 Flash** first instead (slower, it always thinks before answering). Either way, the other model is used on the same key if the first fails or is out of quota. The panel shows which model answered and how long it took
- **DeepSeek** (optional keys, paid but very cheap): uses `deepseek-flash`, which reads images. For replies it uses its **own prompt** (`buildDeepSeekPrompt`, written by the owner): 7 replies as @0xnormal_ in a crypto-Twitter voice, one of each type in order (add value, different angle, builder angle, sharp question, one-liner, personal take, simple breakdown). It takes the post at face value and builds on it rather than doubting it. It gets the post's text, author, quoted post and media, and thinks briefly before answering (so it follows the rules better, e.g. no made-up numbers). Replies are lightly cleaned (quotes, hashtags, dashes, a final period); the author's @mention and one emoji are kept, as the prompt allows. So DeepSeek replies don't follow the rules below (6 replies, 2 questions, "AI read it as"). Fix & improve on DeepSeek uses the current prompt. By default it goes **first**, before Gemini; turn off **Use DeepSeek first** in settings to use it only after Gemini. Keys are managed like Gemini keys. A key that is out of balance is skipped for 30 minutes (top up at platform.deepseek.com)
- If every Gemini (and DeepSeek) key fails or is out of quota, it falls back to **Groq** (optional keys), then to **OpenRouter** (optional key)
- Groq keys are managed like Gemini keys: paste several, they are added to the saved ones, and each shows its status (ready / quota / invalid) with Copy and Remove buttons. Groq first tries `qwen/qwen3.8-27b` (reads images) on every key, then text-only `openai/gpt-oss-120b` on every key. Rate-limited keys are skipped until Groq's stated wait is over. Because these models are smaller than Gemini, Groq requests are tuned for sense over speed: the model thinks briefly before answering (hidden), runs at a lower temperature, first lists the post's key points and must tie every reply to one, and its answer is forced into an exact JSON shape. The text-only model is told the post has media it can't see, so it doesn't guess what's in it
- The AI returns JSON with its read of the post, a list of replies that are not questions, and a list of questions
- The side panel displays them with a copy icon next to each
- **Fix & improve your own reply:** type your reply in the "Your reply" box under the suggestions and click **Fix & improve** (or Ctrl+Enter). The post (caption + media) and your draft go to the AI, which returns a one-line note on what was wrong, a corrected version that keeps your meaning, and 3 more natural ways to say it, each with a copy button

## Reply rules (enforced in the prompt and post-processed)

- The AI gets the whole post: text, author, who it replies to, the quoted post, link preview, image descriptions and the media
- It first writes one sentence on how it understood the post ("AI read it as: ..." in the panel), then writes replies based on that, so a misread is easy to spot
- Replies stay on the post's topic and tone (a trading post gets a trader's reply; a serious post gets no jokes), usually 4 to 15 words
- No AI slop: no generic lines ("love this", "so true"), assistant voice ("truly", "wishing you"), hype, engagement bait, templates, or made-up facts and personal stories
- Optional **My Reply Style** setting: paste replies you wrote, and the AI copies your voice
- The AI writes 10 candidates (7 that are not questions, 3 questions); duplicates and ones that match known slop phrases are dropped. Each reply is checked by its wording (a "?" at the end, or starting like "how", "what", "did", "anyone"...), so a question in the wrong list is still counted as a question
- 6 are shown: 4 that are not questions and 2 questions, in slots 2 and 5. If there aren't enough good ones of a kind, fewer are shown instead of padding with generic lines or extra questions
- The "Fix & improve" feature uses the same rules and also tells you when your draft sounds generic

## Notes & limitations

- Video understanding is done via the **poster frame**, not the full video. For most chill / satisfying / wow clips this is enough. If you want full-video understanding, the next step would be:
  - Capture multiple frames from `<video>` via `<canvas>` (works only when the video is not CORS-tainted), or
  - Download the actual `.mp4` from the tweet's `video_info` and upload via Gemini's Files API.
- The extension does not auto-send replies — you copy and paste manually.
- Gemini free tier has per-minute / per-day limits; check your quota in AI Studio.

## File overview

- `manifest.json` – MV3 config, permissions for X, Twitter media domains, Gemini, DeepSeek, Groq and OpenRouter
- `background.js` – fetches media, calls Gemini, parses the replies and picks 2 questions + 4 others
- `content.js` – injects the button, side panel, and the copy UI
- `styles.css` – button + panel styling
- `popup.html` / `popup.js` / `popup-styles.css` – API key settings UI (also the phone app's settings screen)
- `mobile/` – the phone app: `index.html` / `app.js` / `app.css` (screen), `chrome-shim.js` (stands in for the `chrome.*` APIs so `background.js` and `popup.js` run unchanged), `manifest.webmanifest` (install + Share menu), `sw.js` (service worker), icons
