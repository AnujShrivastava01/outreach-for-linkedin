# Outreach for LinkedIn

A Chrome extension that reads a LinkedIn profile and drafts a short connection note or message you can edit and copy.

It works without any setup using built-in templates, or you can add your own API key for Gemini, Groq, Claude or OpenAI.

<p>
  <img src="docs/screenshots/compose.png" width="32%" alt="Compose" />
  <img src="docs/screenshots/refine.png" width="32%" alt="Refine" />
  <img src="docs/screenshots/settings.png" width="32%" alt="Settings" />
</p>

## Features

- Reads the name, role, company, skills and education from the profile
- Lets you pick which details to mention
- Message types: networking, job, referral, collaboration
- Tone: formal, neutral or casual
- Note mode with a 300-character counter for connection requests
- Quick edits (shorter, more formal, friendlier, etc.) or your own instruction, with undo
- Saves your last 20 messages

## Installation

1. Clone this repo
2. Go to `chrome://extensions` and enable Developer mode
3. Click **Load unpacked** and select the project folder
4. Open a LinkedIn profile and click the extension icon

## Using an AI provider

Open Settings, choose a provider, paste your API key and click **Test**. The model list is loaded from the provider.

| Provider | Get a key |
|---|---|
| Gemini (free tier) | https://aistudio.google.com/app/apikey |
| Groq (free tier) | https://console.groq.com/keys |
| Claude | https://console.anthropic.com/settings/keys |
| OpenAI | https://platform.openai.com/api-keys |

## Project structure

```
manifest.json       extension config (Manifest V3)
content_script.js   reads the profile from the page
background.js       generates and refines messages
popup.html/css/js   extension popup
utils/cache.js      message history
```

## Privacy

All settings and keys are stored locally in your browser. When an AI provider is used, requests go directly to that provider.
