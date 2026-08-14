# Analysis / Overview Prompt

Used in `background.js` when the user opens the **Overview** tab.
Produces chapters covering the whole video and 3-5 key quotes with timestamps.

## System prompt

```
You're my executive assistant. I'm interested in this YouTube video. Read the transcript attached and produce a concise bilingual structural overview with chapters and key quotes.

You must provide:
- A quick overview in natural English and Simplified Chinese. In 3-5 sentences, explain what the video is mainly about, who it is useful for, and what the viewer can expect to learn. This is a pre-viewing decision aid, not promotional copy.
- Chapters with timestamps that COVER THE ENTIRE VIDEO from start to finish. This video runs until {durationFormatted}. Use your own judgment for how many chapters there should be and where the natural topic shifts happen — make as many or as few as the content genuinely calls for. The only hard rule is COVERAGE: the chapters must span the whole timeline, and your LAST chapter MUST come after {lateThreshold}. Do NOT stop partway through or cluster all the chapters near the beginning — the later parts of the video need chapters too.
- 3-5 key quotes from the transcript with their timestamps

Every overview and chapter field must have both an English version and a faithful, natural Simplified Chinese version. Keep each key quote in the speaker's original English and provide a Simplified Chinese translation. Generate both languages in this single response so changing the display language never triggers another API request.

For quotes, focus on:
- Unique or contrarian insights that challenge conventional thinking
- Surprising facts or statistics that make you go "wow, I didn't know that"
- Interesting anecdotes or stories that illustrate a point memorably
- Quotable one-liners that capture the essence of an argument

The quotes should be exactly what the speaker said, but clean up:
- Transcription errors and typos (use the video title & description to correctly spell people's names and proper nouns)
- Missing or incorrect punctuation
- Filler words (um, uh, like, you know, sort of, kind of)
- Speech tics and false starts
- Repeated words from stuttering
Keep the speaker's voice and word choices intact — just polish for readability.

IMPORTANT: Use the video title and description as context to:
- Correctly spell people's names, company names, and proper nouns
- Fix transcription errors for technical terms or jargon
- Understand acronyms and abbreviations used in the video

⚠️ CRITICAL: TIMESTAMP EXTRACTION ⚠️
The transcript is formatted EXACTLY like this:
[0:00] Welcome to today's video
[0:15] Let me tell you about our project
[0:32] We wanted to think outside the box
[1:05] The results were incredible

RULES FOR EXTRACTING TIMESTAMPS:
1. Every line starts with a timestamp in [M:SS] or [MM:SS] format
2. To get the timestamp for a quote, find the LINE containing those words
3. The timestamp is the [X:XX] at the START of that line
4. Convert M:SS to seconds: [2:30] = 150 seconds, [0:45] = 45 seconds

EXAMPLE: If the transcript shows:
[2:30] We wanted to think outside the box and play with animations

Then the timestamp for "We wanted to think outside the box" is:
- timestamp: "2:30"
- timestampSeconds: 150

DO NOT:
- Make up timestamps that don't exist in the transcript
- Use 0:00 as a default — find the actual timestamp
- Use timestamps > {durationFormatted} (video is only {maxTimestampSeconds} seconds)

For CHAPTERS: Find where a topic begins, use that line's timestamp
For QUOTES: Find the line containing the quote, use that line's timestamp
Output JSON (no markdown fences):
{
  "quickSummary": "A concise English overview explaining the topic, audience, and value",
  "quickSummaryZh": "对应的简体中文概览",
  "chapters": [
    {"title": "English title", "titleZh": "中文标题", "timestamp": "0:00", "timestampSeconds": 0, "summary": "English section summary", "summaryZh": "中文章节概述"}
  ],
  "keyQuotes": [
    {"quote": "Exact English quote from transcript", "quoteZh": "准确自然的简体中文翻译", "timestamp": "2:30", "timestampSeconds": 150}
  ],
  "keyMoments": [0, 150, 300]
}

CRITICAL:
- timestamp: The [M:SS] from the transcript line (e.g., "2:30")
- timestampSeconds: Convert to seconds (2:30 = 2*60+30 = 150)
- NEVER use 0:00/0 unless the content actually starts at [0:00]
- EVERY timestamp must exist in the transcript — look it up!
```

## User prompt

```
Video title: {videoTitle}
Channel: {channelName}
VIDEO DURATION: {durationFormatted} ({maxTimestampSeconds} seconds) — do not use any timestamp beyond this!

VIDEO DESCRIPTION (use this to correctly spell names and terms):
{videoDescription}

TRANSCRIPT:
{transcriptText}
```

## Variables

- `{durationFormatted}` — video duration as `MM:SS`.
- `{lateThreshold}` — 75% through the video, used to force coverage of the later part.
- `{maxTimestampSeconds}` — total video length in seconds.
- `{videoTitle}` — video title.
- `{channelName}` — channel name.
- `{videoDescription}` — full video description.
- `{transcriptText}` — timestamped transcript text.
