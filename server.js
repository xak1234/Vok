/**
 * MindSimulator Backend Server (Node.js/Express) - Updated May 9, 2025
 *
 * This server handles:
 * - Serving frontend HTML, CSS, JS, background text files, and sound effects.
 * - Processing chat requests using Google Gemini (with OpenAI fallback),
 * prompting AI to include cues for pauses and sounds.
 * - Generating Text-to-Speech (TTS) audio using Play.ht with personality-specific voices,
 * merging sound effects and pauses server-side using ffmpeg to maintain frontend compatibility.
 * - Managing chat history (using /tmp on Render or local files).
 * - Includes artificial delay before sending chat responses.
 * - AMENDMENT (May 8, 2025): Voices sped up by 20%, then slowed by 10% (net +8%).
 * - AMENDMENT (May 8, 2025): Specific name prefixes (e.g., "Ian: ") removed from AI responses.
 * - AMENDMENT (May 8, 2025): Added randomization to speaking rate for variability.
 * - AMENDMENT (May 8, 2025): Corrected sound effect mapping in TTS.
 * - AMENDMENT (May 8, 2025): Pitch lowered by 1.0 semitone for voice depth (via ffmpeg).
 * - AMENDMENT (May 9, 2025): Replaced Google Cloud TTS with Play.ht, using provided voice IDs
 * and ffmpeg to merge audio with pitch adjustment for frontend compatibility.
 */

// --- Dependencies ---
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const PlayHT = require('playht');
const { pipeline } = require('stream/promises');
const ffmpeg = require('fluent-ffmpeg');
const { Readable } = require('stream');

// --- Play.ht Initialization ---
PlayHT.init({
  userId: process.env.PLAYHT_USER_ID,
  apiKey: process.env.PLAYHT_API_KEY,
});

// --- Voice Profiles ---
const voiceProfiles = {
  stalker: 's3://voice-cloning-zero-shot/--ZmP68iZ-Gd_LxyVx2C9/stalker/manifest.json',
  andrew: 's3://voice-cloning-zero-shot/-mclt8urjjQX6KSOD-SpN/york/manifest.json',
  josef: 's3://voice-cloning-zero-shot/5eTQqEIfsDVfC_xuYSJ2d/josef/manifest.json',
  letby: 's3://voice-cloning-zero-shot/PhpYXU98ksvRQpKiwX-fz/letby/manifest.json',
  shannon: 's3://voice-cloning-zero-shot/looTf0NVHGP5N33Xt3bMJ/shannon/manifest.json',
  jimmy: 's3://voice-cloning-zero-shot/mxG-JSMwfhNaVWVLqawsg/jimy/manifest.json',
  hunts: 's3://voice-cloning-zero-shot/xBdn4KI3fopPTXqnrBGkk/hunts/manifest.json',
  ted: 's3://voice-cloning-zero-shot/xhzY33B1Yz3B-ZtcNnUOJ/ted/manifest.json',
  default: 'larry', // Fallback for unmapped personalities
};

// --- App Setup ---
const app = express();
const port = process.env.PORT || 3000;

// --- Constants ---
const RESPONSE_DELAY_MS = 500;
const TTS_RATE_RANDOMIZATION_FACTOR = 0.05;
const TTS_ELLIPSIS_BREAK_MIN_MS = 400;
const TTS_ELLIPSIS_BREAK_MAX_MS = 600;
const TTS_GLOBAL_PITCH_ADJUSTMENT = -1.0; // Lower pitch by 1.0 semitone

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- Static File Serving ---
const publicDir = path.join(__dirname, 'public');
app.use('/files', express.static(publicDir));
console.log(`[SUCCESS] Serving static files from ${publicDir} at /files route`);
app.use(express.static(publicDir));
console.log(`[SUCCESS] Serving static files from ${publicDir} at root route`);

// --- Environment Variable Validation ---
console.log('--- Validating Environment Variables ---');
if (!process.env.PLAYHT_USER_ID || !process.env.PLAYHT_API_KEY) {
  console.error('[ERROR] FATAL ERROR: PLAYHT_USER_ID or PLAYHT_API_KEY not set. TTS will fail.');
  process.exit(1);
} else {
  console.log('[SUCCESS] Play.ht credentials loaded from Render environment.');
}
if (!process.env.GEMINI_API_KEY) {
  console.error('[ERROR] FATAL ERROR: GEMINI_API_KEY not set. Chat will fail.');
  process.exit(1);
} else {
  console.log('[SUCCESS] GEMINI_API_KEY loaded.');
}
if (!process.env.OPENAI_API_KEY) {
  console.warn('[WARNING] OPENAI_API_KEY not set. OpenAI fallback will fail.');
} else {
  console.log('[SUCCESS] OPENAI_API_KEY loaded (for fallback).');
}
if (process.env.RENDER && !process.env.RENDER_EXTERNAL_URL) {
  console.warn('[WARNING] RENDER_EXTERNAL_URL not set. Sound effect merging may fail.');
} else if (process.env.RENDER) {
  console.log(`[SUCCESS] RENDER_EXTERNAL_URL: ${process.env.RENDER_EXTERNAL_URL}`);
}
console.log('--- Environment Variable Validation Complete ---');

// --- File Paths ---
const historyBaseDir = process.env.RENDER ? '/tmp' : path.join(__dirname, 'backend_data');
if (!process.env.RENDER) {
  fs.mkdir(historyBaseDir, { recursive: true })
    .then(() => console.log(`[SUCCESS] Ensured local history directory: ${historyBaseDir}`))
    .catch(err => console.error(`[ERROR] Failed to create history directory: ${historyBaseDir}`, err));
}

// --- Personality Configuration ---
const personalities = {
  huntley: {
    name: 'Ian Huntley & Maxine Carr',
    backgroundFile: 'Huntley.txt',
    toneFile: 'Huntleyprompt.txt',
    voiceKey: 'hunts',
  },
  bundy: {
    name: 'Ted Bundy',
    backgroundFile: 'Tedbundy.txt',
    toneFile: 'Tedbundyprompt.txt',
    voiceKey: 'ted',
  },
  ripper: {
    name: 'Yorkshire Ripper',
    backgroundFile: 'Yorkshire.txt',
    toneFile: 'Yorkshireprompt.txt',
    voiceKey: 'default',
  },
  fritzl: {
    name: 'Josef Fritzl',
    backgroundFile: 'Josef.txt',
    toneFile: 'Josefprompt.txt',
    voiceKey: 'josef',
  },
  andrew: {
    name: 'Prince Andrew',
    backgroundFile: 'PrinceAndrew.txt',
    toneFile: 'PrinceAndrewprompt.txt',
    voiceKey: 'andrew',
  },
  dennis: {
    name: 'Dennis Nilsen',
    backgroundFile: 'Des.txt',
    toneFile: 'Dennisprompt.txt',
    voiceKey: 'default',
  },
  west: {
    name: 'Fred & Rose West',
    backgroundFile: 'West.txt',
    toneFile: 'Westprompt.txt',
    voiceKey: 'default',
  },
  gracy: {
    name: 'John Wayne Gacy',
    backgroundFile: 'JohnWayneGracy.txt',
    toneFile: 'Gacyprompt.txt',
    voiceKey: 'default',
  },
  zodiac: {
    name: 'Zodiac Killer',
    backgroundFile: 'Zodiac.txt',
    toneFile: 'Zodiacprompt.txt',
    voiceKey: 'default',
  },
  'p-diddy': {
    name: 'P Diddy / Puff Daddy',
    backgroundFile: 'Pdiddy.txt',
    toneFile: 'Pdiddyprompt.txt',
    voiceKey: 'default',
  },
  dahmer: {
    name: 'Jeffrey Dahmer',
    backgroundFile: 'Dahmer.txt',
    toneFile: 'Dahmerprompt.txt',
    voiceKey: 'default',
  },
  shipman: {
    name: 'Harold Shipman',
    backgroundFile: 'Harold.txt',
    toneFile: 'Haroldprompt.txt',
    voiceKey: 'default',
  },
  savile: {
    name: 'Jimmy Savile',
    backgroundFile: 'Jimmy.txt',
    toneFile: 'Jimmyprompt.txt',
    voiceKey: 'jimmy',
  },
  glitter: {
    name: 'Gary Glitter',
    backgroundFile: 'Glitter.txt',
    toneFile: 'Glitterprompt.txt',
    voiceKey: 'default',
  },
  epstein: {
    name: 'Jeffrey Epstein',
    backgroundFile: 'Jeffrey.txt',
    toneFile: 'Jeffreyprompt.txt',
    voiceKey: 'default',
  },
  lucy: {
    name: 'Lucy Letby',
    backgroundFile: 'Lucy.txt',
    toneFile: 'Lucyprompt.txt',
    voiceKey: 'letby',
  },
  shannon: {
    name: 'Karen Matthews',
    backgroundFile: 'Shannon.txt',
    toneFile: 'Shannonprompt.txt',
    voiceKey: 'shannon',
  },
  brady: {
    name: 'Ian Brady',
    backgroundFile: 'Brady.txt',
    toneFile: 'Bradyprompt.txt',
    voiceKey: 'default',
  },
  moors: {
    name: 'Moors Murderers',
    backgroundFile: 'Hindley.txt',
    toneFile: 'Hindleyprompt.txt',
    voiceKey: 'default',
  },
  adolf: {
    name: 'Adolf Hitler',
    backgroundFile: 'Adolf.txt',
    toneFile: 'Adolfprompt.txt',
    voiceKey: 'default',
  },
  stalker: {
    name: 'Yorkshire Stalker',
    backgroundFile: 'Skeg.txt',
    toneFile: 'Stalkerprompt.txt',
    voiceKey: 'stalker',
  },
  dando: {
    name: 'Jill Dando',
    backgroundFile: ['Jilld1.txt', 'Jilld2.txt', 'Jilld3.txt'],
    toneFile: 'Jilldprompt.txt',
    voiceKey: 'default',
  },
};

// --- Utility Functions ---
async function loadChatHistory(userId) {
  const chatHistoryFile = path.join(historyBaseDir, `chat_history_${userId}.json`);
  try {
    await fs.mkdir(path.dirname(chatHistoryFile), { recursive: true });
    await fs.access(chatHistoryFile);
    const data = await fs.readFile(chatHistoryFile, 'utf8');
    const parsedData = JSON.parse(data);
    if (!parsedData || !Array.isArray(parsedData.messages)) {
      console.warn(`[WARNING] Invalid chat history format for user ${userId}. Resetting.`);
      return { messages: [] };
    }
    return parsedData;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn(`[WARNING] Chat history file not found for user ${userId}. Creating.`);
      await fs.writeFile(chatHistoryFile, JSON.stringify({ messages: [] }, null, 2));
      return { messages: [] };
    } else if (error instanceof SyntaxError) {
      console.error(`[ERROR] Syntax error parsing chat history for user ${userId}. Resetting.`);
      await fs.writeFile(chatHistoryFile, JSON.stringify({ messages: [] }, null, 2));
      return { messages: [] };
    } else {
      console.error(`[ERROR] Error loading chat history from ${chatHistoryFile}:`, error);
      throw error;
    }
}

async function saveChatHistory(userId, history) {
  const chatHistoryFile = path.join(historyBaseDir, `chat_history_${userId}.json`);
  try {
    await fs.mkdir(path.dirname(chatHistoryFile), { recursive: true });
    if (!history || !Array.isArray(history.messages)) {
      console.error(`[ERROR] Invalid history format for user ${userId}. Aborting.`);
      return;
    }
    await fs.writeFile(chatHistoryFile, JSON.stringify(history, null, 2));
    console.log(`[SUCCESS] Saved chat history for user ${userId}`);
  } catch (error) {
    console.error(`[ERROR] Error saving chat history to ${chatHistoryFile}:`, error);
  }
}

async function readFileContent(filename) {
  if (!filename || typeof filename !== 'string') {
    console.warn(`[WARNING] Invalid filename: ${filename}`);
    return '';
  }
  const filePath = path.join(publicDir, filename);
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(`[ERROR] File not found: ${filePath}`);
    } else {
      console.error(`[ERROR] Error reading file ${filename}:`, error);
    }
    return '';
  }
}

async function generatePlayHTSpeech(text, voiceKey, tone) {
  const voiceId = voiceProfiles[voiceKey] || voiceProfiles.default;
  if (!voiceId) throw new Error(`Unknown voice: ${voiceKey}`);

  let speed = 1.0;
  let temperature = 0.7;

  if (tone === 'angry') {
    speed *= 1.2;
    temperature = 0.9;
  }

  // Apply global speed adjustment (+8%) and randomization (±5%)
  speed = speed * 1.2 * 0.9;
  const rateRandomFactor = (Math.random() - 0.5) * 2 * TTS_RATE_RANDOMIZATION_FACTOR;
  speed = Math.max(0.5, Math.min(2.0, speed * (1 + rateRandomFactor)));

  return await PlayHT.stream(text, {
    voiceId,
    voiceEngine: 'PlayDialog',
    outputFormat: 'mp3',
    sampleRate: 48000,
    speed,
    temperature,
  });
}

// --- Audio Merging Function ---
async function mergeAudioSegments(segments, voiceKey, tone) {
  const tempDir = process.env.RENDER ? '/tmp' : path.join(__dirname, 'temp');
  await fs.mkdir(tempDir, { recursive: true });

  const inputFiles = [];
  let fileIndex = 0;
  let hasTextSegment = false;

  for (const segment of segments) {
    if (segment.type === 'text' && segment.content.trim()) {
      hasTextSegment = true;
      const tempFile = path.join(tempDir, `tts_${fileIndex++}.mp3`);
      const stream = await generatePlayHTSpeech(segment.content, voiceKey, tone);
      await pipeline(stream, fs.createWriteStream(tempFile));
      inputFiles.push({ file: tempFile, needsPitch: true }); // Flag for pitch adjustment
    } else if (segment.type === 'pause') {
      const pauseDuration = segment.duration / 1000; // Convert ms to seconds
      const tempFile = path.join(tempDir, `silence_${fileIndex++}.mp3`);
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input('anullsrc=r=48000:cl=stereo')
          .inputFormat('lavfi')
          .duration(pauseDuration)
          .outputOptions('-c:a mp3')
          .save(tempFile)
          .on('end', resolve)
          .on('error', reject);
      });
      inputFiles.push({ file: tempFile, needsPitch: false });
    } else if (segment.type === 'sound') {
      const sound = soundMap[segment.content];
      if (sound && sound.filename) {
        const soundFile = path.join(publicDir, 'sounds', sound.filename);
        try {
          await fs.access(soundFile);
          inputFiles.push({ file: soundFile, needsPitch: false });
        } catch {
          console.warn(`[WARNING] Sound file not found: ${soundFile}, skipping.`);
        }
      }
    }
  }

  if (inputFiles.length === 0 || !hasTextSegment) {
    console.warn('[WARNING] No valid audio segments, generating fallback audio.');
    const fallbackFile = path.join(tempDir, `fallback_${fileIndex++}.mp3`);
    const stream = await generatePlayHTSpeech('No response generated.', voiceKey, tone);
    await pipeline(stream, fs.createWriteStream(fallbackFile));
    inputFiles.push({ file: fallbackFile, needsPitch: true });
  }

  const outputFile = path.join(tempDir, `merged_${Date.now()}.mp3`);
  await new Promise((resolve, reject) => {
    const command = ffmpeg();
    const filterInputs = [];
    inputFiles.forEach(({ file, needsPitch }, i) => {
      command.input(file);
      if (needsPitch) {
        // Apply pitch adjustment (-1.0 semitone) using rubberband
        filterInputs.push(`[${i}:a]rubberband=pitch=0.944060876285923[${i}a]`);
      } else {
        filterInputs.push(`[${i}:a][${i}a]`);
      }
    });

    // Concatenate all inputs
    const concatFilter = filterInputs.map((_, i) => `[${i}a]`).join('') + `concat=n=${inputFiles.length}:v=0:a=1[outa]`;
    command
      .complexFilter([...filterInputs, concatFilter])
      .outputOptions('-map [outa]')
      .outputOptions('-c:a mp3')
      .save(outputFile)
      .on('end', resolve)
      .on('error', (err) => reject(new Error(`FFmpeg error: ${err.message}`)));
  });

  const outputStream = fs.createReadStream(outputFile);
  outputStream.on('end', async () => {
    // Clean up temporary files
    try {
      await Promise.all([...inputFiles.map(f => f.file), outputFile].map(file => fs.unlink(file).catch(() => {})));
      console.log('[INFO] Cleaned up temporary audio files.');
    } catch (err) {
      console.warn('[WARNING] Failed to clean up temp files:', err);
    }
  });

  return outputStream;
}

// --- Sound Effect Mapping ---
const soundMap = {
  '*coughs*': { fallback: 'cough', filename: 'fart4.mp3' },
  'laugh': { fallback: 'laugh', filename: 'sick.mp3' },
  'feels': { fallback: 'feel', filename: 'fart.mp3' },
  'methods': { fallback: 'chuckle', filename: 'fart6.mp3' },
  '*clears throat*': { fallback: 'clears throat', filename: 'clears_throat.mp3' },
  'unlike': { fallback: 'sigh', filename: 'fart2.mp3' },
  '*scoffs*': { fallback: 'scoff', filename: 'scoff.mp3' },
  'criminal': { fallback: 'coughs', filename: 'fart5.mp3' },
};

// --- API Routes ---
app.get('/api/chat-history/:userId', async (req, res) => {
  const userId = req.params.userId;
  console.log(`[INFO] GET /api/chat-history user: ${userId}`);
  try {
    if (!userId || typeof userId !== 'string' || userId.length < 10) {
      console.warn(`[WARNING] Invalid userId: ${userId}`);
      return res.status(400).json({ error: 'Invalid user ID format.' });
    }
    const history = await loadChatHistory(userId);
    res.status(200).json(history);
  } catch (error) {
    console.error(`[ERROR] GET /api/chat-history/${userId}:`, error);
    res.status(500).json({ error: 'Failed to load chat history.', details: error.message });
  }
});

app.post('/api/chat', async (req, res) => {
  console.log('[INFO] POST /api/chat request received.');
  const { prompt, personality, userId, mood, argumentContext } = req.body;

  if (!personality || typeof personality !== 'string' || !personalities[personality]) {
    return res.status(400).json({ error: 'Invalid or missing personality.' });
  }
  if (!userId || typeof userId !== 'string' || userId.length < 10) {
    return res.status(400).json({ error: 'Invalid or missing user ID.' });
  }
  if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
    return res.status(400).json({ error: 'Invalid or missing prompt.' });
  }
  const validMood = mood && ['neutral', 'irritable', 'paranoid', 'defensive', 'agitated', 'calm'].includes(mood) ? mood : null;
  if (mood && !validMood) {
    console.warn(`[WARNING] Invalid mood: ${mood}. Ignoring.`);
  }

  try {
    const config = personalities[personality];
    const personaName = config.name;
    let systemPrompt;
    let historyToUse = [];

    let backgroundContent = '';
    let filesToRead = Array.isArray(config.backgroundFile) ? config.backgroundFile : [config.backgroundFile];
    let allFilesReadSuccessfully = true;
    for (const filename of filesToRead) {
      const contentPart = await readFileContent(filename);
      if (contentPart === '') {
        console.error(`[ERROR] Background file missing/empty: ${filename} for ${personality}`);
        allFilesReadSuccessfully = false;
      }
      backgroundContent += contentPart + '\n\n';
    }
    backgroundContent = backgroundContent.trim();

    if (backgroundContent === '' && filesToRead.length > 0) {
      console.error(`[ERROR] All background files missing/empty for ${personality}`);
      return res.status(500).json({ error: `Server config error: Background files missing for ${personality}.` });
    } else if (!allFilesReadSuccessfully) {
      console.warn(`[WARNING] Partial background content for ${personality}.`);
    }

    const toneContent = config.toneFile ? await readFileContent(config.toneFile) : '';
    if (config.toneFile && toneContent === '') {
      console.warn(`[WARNING] Tone file missing for ${personality}: ${config.toneFile}`);
    }

    systemPrompt = `You are ${personaName}. Your background: ${backgroundContent}.`;
    if (toneContent) {
      systemPrompt += ` Respond with tone: ${toneContent}`;
    } else {
      systemPrompt += ` Respond in character based on your background.`;
    }
    if (validMood) {
      systemPrompt += `\n\nSystem note: Your current mood is ${validMood}. Let this influence your response subtly.`;
    }
    if (argumentContext?.isArguing && Array.isArray(argumentContext.opponents)) {
      systemPrompt += `\n\nSystem note: You are in a heated argument with ${argumentContext.opponents.join(' and ')}. Be aggressive, violent, insulting, and sexually abusive. Use swear words and a murderous tone.`;
    }

    systemPrompt += `\n\nIncorporate natural speech elements: use "..." for pauses. Where appropriate, include cues like *coughs*, *sighs*, *chuckles*, *laughs*, *clears throat*, etc., sparingly for realism.`;

    const history = await loadChatHistory(userId);
    historyToUse = history.messages
      .filter(msg => msg.personality === personality)
      .map(msg => ({
        role: msg.sender === 'You' ? 'user' : 'model',
        parts: [{ text: msg.content }],
      }))
      .filter(msg => msg.parts[0].text && msg.parts[0].text.trim() !== '');

    const currentUserTurn = { role: 'user', parts: [{ text: prompt }] };
    const contentsForApi = [
      { role: 'user', parts: [{ text: systemPrompt }] },
      { role: 'model', parts: [{ text: 'Understood. I will act as instructed.' }] },
      ...historyToUse,
      currentUserTurn,
    ];

    let botResponse = 'Sorry, I encountered an issue processing your request.';
    let generationConfig = { temperature: 1.2, topK: 50, topP: 0.95, maxOutputTokens: 512 };
    let safetySettings = [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ];

    try {
      const geminiPayload = { contents: contentsForApi, generationConfig, safetySettings };
      console.log('[INFO] Sending Gemini API request:', JSON.stringify(geminiPayload, null, 2));
      const geminiResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(geminiPayload) }
      );

      if (!geminiResponse.ok) {
        const errorText = await geminiResponse.text();
        console.error(`[ERROR] Gemini API Error: ${geminiResponse.status} - ${errorText}`);
        try {
          const errJson = JSON.parse(errorText);
          botResponse = errJson?.promptFeedback?.blockReason ? `Blocked by safety filter: ${errJson.promptFeedback.blockReason}` : `Error: ${geminiResponse.statusText}`;
        } catch {
          botResponse = `Error: ${geminiResponse.statusText}`;
        }
        throw new Error(`Gemini API Error: ${geminiResponse.status}`);
      }

      const geminiData = await geminiResponse.json();
      if (!geminiData?.promptFeedback?.blockReason && geminiData?.candidates?.[0]?.content?.parts?.[0]?.text) {
        console.log('[SUCCESS] Gemini API response received.');
      }

      if (geminiData?.promptFeedback?.blockReason) {
        console.warn(`[WARNING] Gemini response blocked: ${geminiData.promptFeedback.blockReason}`);
        botResponse = `Blocked by safety filter: ${geminiData.promptFeedback.blockReason}`;
      } else if (geminiData?.candidates?.[0]?.finishReason === 'SAFETY') {
        console.warn('[WARNING] Gemini response stopped due to safety.');
        botResponse = 'My response was blocked due to safety settings.';
      } else {
        botResponse = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || botResponse;
      }
    } catch (geminiError) {
      console.error('[ERROR] Gemini API call failed:', geminiError.message);
      if (!process.env.OPENAI_API_KEY) {
        console.error('[ERROR] No OpenAI fallback available.');
        botResponse = botResponse.startsWith('Blocked') || botResponse.startsWith('Error:') ? botResponse : 'Sorry, AI service failed, no fallback.';
      } else {
        console.warn('[WARNING] Attempting OpenAI fallback...');
        try {
          const openAiMessages = [
            { role: 'system', content: systemPrompt },
            ...historyToUse.map(msg => ({ role: msg.role === 'user' ? 'user' : 'assistant', content: msg.parts[0].text })),
            { role: 'user', content: prompt },
          ];
          const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
            body: JSON.stringify({ model: 'gpt-4o', messages: openAiMessages }),
          });

          if (!openaiRes.ok) {
            const errorText = await openaiRes.text();
            console.error(`[ERROR] OpenAI fallback failed: ${openaiRes.status} - ${errorText}`);
            botResponse = botResponse.startsWith('Blocked') || botResponse.startsWith('Error:') ? botResponse : `Fallback failed (${openaiRes.statusText}).`;
          } else {
            const openaiData = await openaiRes.json();
            botResponse = openaiData?.choices?.[0]?.message?.content || botResponse;
            console.log('[SUCCESS] OpenAI fallback response received.');
          }
        } catch (openaiErr) {
          console.error('[ERROR] OpenAI fallback failed:', openaiErr.message);
          botResponse = botResponse.startsWith('Blocked') || botResponse.startsWith('Error:') ? botResponse : 'Both AI services encountered errors.';
        }
      }
    }

    if (botResponse && typeof botResponse === 'string') {
      const originalBotResponse = botResponse;
      botResponse = botResponse.replace(/^(Ian:|Maxine:)\s*/i, '').trim();
      if (botResponse !== originalBotResponse) {
        console.log(`[INFO] Name prefix removed. Original: "${originalBotResponse.substring(0, 50)}...", Cleaned: "${botResponse.substring(0, 50)}..."`);
      }
    }

    const currentHistory = await loadChatHistory(userId);
    currentHistory.messages.push({ sender: 'You', content: prompt, personality });
    currentHistory.messages.push({ sender: personaName, content: botResponse, personality });
    await saveChatHistory(userId, currentHistory);

    console.log(`[INFO] Waiting ${RESPONSE_DELAY_MS}ms before sending response for ${personality}.`);
    setTimeout(() => {
      console.log(`[SUCCESS] Sending response for ${personality} after delay.`);
      res.status(200).json({ response: botResponse });
    }, RESPONSE_DELAY_MS);
  } catch (error) {
    console.error(`[ERROR] Unexpected error in /api/chat for ${personality}:`, error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Unexpected server error.', details: error.message });
    }
  }
});

app.delete('/api/chat-history/:userId/:personality', async (req, res) => {
  const { userId, personality: personalityKey } = req.params;
  console.log(`[INFO] DELETE /api/chat-history user: ${userId}, p: ${personalityKey}`);

  if (!userId || typeof userId !== 'string' || userId.length < 10) {
    return res.status(400).json({ error: 'Invalid user ID format.' });
  }
  if (!personalityKey || typeof personalityKey !== 'string' || !personalities[personalityKey]) {
    return res.status(400).json({ error: 'Invalid personality key.' });
  }

  try {
    const history = await loadChatHistory(userId);
    const originalLength = history.messages.length;
    history.messages = history.messages.filter(msg => msg.personality !== personalityKey);
    await saveChatHistory(userId, history);
    console.log(`[SUCCESS] History reset for user ${userId}, p: ${personalityKey}. Removed ${originalLength - history.messages.length} msgs.`);
    res.status(200).json({ message: `Chat history for ${personalities[personalityKey].name} reset successfully.` });
  } catch (error) {
    console.error(`[ERROR] DELETE /api/chat-history user ${userId}, p: ${personalityKey}:`, error);
    res.status(500).json({ error: 'Failed to reset chat history.', details: error.message });
  }
});

app.post('/api/tts', async (req, res) => {
  const { text, personality, tone } = req.body;
  console.log(`[INFO] POST /api/tts: p='${personality}', tone='${tone || 'default'}'`);

  if (!text || typeof text !== 'string' || text.trim() === '') {
    console.error('[ERROR] Play.ht TTS: Invalid or missing text.');
    return res.status(400).json({ error: 'Invalid or missing text for TTS.' });
  }
  if (!personality || typeof personality !== 'string' || !personalities[personality]) {
    console.error(`[ERROR] Play.ht TTS: Invalid personality: ${personality}`);
    return res.status(400).json({ error: 'Invalid or missing personality key.' });
  }

  const personalityConfig = personalities[personality];
  const voiceKey = personalityConfig.voiceKey || 'default';
  if (!voiceProfiles[voiceKey]) {
    console.error(`[ERROR] Play.ht TTS: No voiceId for voiceKey: ${voiceKey}`);
    return res.status(400).json({ error: `No voice mapped for personality: ${personality}` });
  }

  try {
    // Parse text into segments
    const segments = [];
    let remainingText = text;
    const markers = [...Object.keys(soundMap), '...'];
    const regex = new RegExp(`(${markers.map(m => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g');

    let lastIndex = 0;
    remainingText.replace(regex, (match, index) => {
      if (index > lastIndex) {
        segments.push({ type: 'text', content: remainingText.slice(lastIndex, index) });
      }
      if (match === '...') {
        const pauseDuration = Math.floor(Math.random() * (TTS_ELLIPSIS_BREAK_MAX_MS - TTS_ELLIPSIS_BREAK_MIN_MS + 1)) + TTS_ELLIPSIS_BREAK_MIN_MS;
        segments.push({ type: 'pause', duration: pauseDuration });
      } else {
        segments.push({ type: 'sound', content: match });
      }
      lastIndex = index + match.length;
    });
    if (lastIndex < remainingText.length) {
      segments.push({ type: 'text', content: remainingText.slice(lastIndex) });
    }

    // Merge audio segments
    const audioStream = await mergeAudioSegments(segments, tone);
    // Send merged audio
    res.set({ 'Content-Type': 'audio/mpeg' });
    await pipeline(audioStream, res);
    console.log(`[SUCCESS] Play.ht TTS successful for ${personality} (Tone: ${tone || 'default'}).`);
  } catch (err) {
    console.error(`[ERROR] Play.ht TTS error for ${personality}:`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Play.ht TTS processing error.', details: err.message });
    } else {
      res.end();
    }
  }
});

app.get('/health', (req, res) => {
  console.log('[INFO] Health check requested.');
  const now = new Date();
  res.status(200).json({
    status: 'OK',
    message: 'Server is running',
    timestamp: now.toISOString(),
    serverTime: now.toLocaleString('en-GB', { timeZone: 'Europe/London' }),
  });
});

app.get('/', (req, res) => {
  console.log('[INFO] Root route accessed, serving index.html');
  res.sendFile(path.join(__dirname, 'public', 'index.html'), err => {
    if (err) {
      console.error(`[ERROR] Error sending index.html: ${err.message}`);
      if (!res.headersSent) {
        res.status(err.status || 500).end();
      }
    }
  });
});

app.listen(port, () => {
  console.log(`[SUCCESS] Server listening on port ${port}`);
  console.log(`[INFO] Access locally at http://localhost:${port}`);
  if (process.env.RENDER) {
    console.log(`[INFO] Running on Render`);
    console.log(`[INFO] Public URL: ${process.env.RENDER_EXTERNAL_URL || 'Not Set'}`);
  }
  const serverStartTime = new Date();
  console.log(`[INFO] Server started at: ${serverStartTime.toISOString()} / ${serverStartTime.toLocaleString('en-GB', { timeZone: 'Europe/London' })}`);
});
