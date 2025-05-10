/**
 * MindSimulator Backend Server (Node.js/Express) - Updated May 8, 2025
 *
 * This server handles:
 * - Serving the frontend HTML, CSS, JS, background text files, and sound effects.
 * - Processing chat requests using Google Gemini (with OpenAI fallback),
 * prompting the AI to include cues for pauses and sounds.
 * - Generating Text-to-Speech (TTS) audio using Google Cloud Text-to-Speech
 * with SSML, personality-specific voices/params, tone overrides, pauses (<break>),
 * and embedded sound effects (<audio>) hosted on Render.
 * - Managing chat history (using local files or /tmp on Render).
 * - Includes an artificial delay before sending chat responses.
 * - AMENDMENT (May 8, 2025): Voices sped up by 20%, then slowed by 10% (net +8%).
 * - AMENDMENT (May 8, 2025): Specific name prefixes (e.g., "Ian: ") are removed from AI responses before TTS and display.
 * - AMENDMENT (May 8, 2025): Added subtle randomization to pause duration, speaking rate, and pitch for more voice variability.
 * - AMENDMENT (May 8, 2025): Increased voice depth (lowered pitch by 1.0 semitone).
 * - AMENDMENT (May 8, 2025): Corrected and improved sound effect mapping in TTS.
 */

// --- Dependencies ---
const express = require('express');

function getVoiceFor(personality) {
  switch (personality.toLowerCase()) {
    case "ted":
      return "s3://voice-cloning-zero-shot/xhzY33B1Yz3B-ZtcNnUOJ/ted/manifest.json";
    case "jimmy":
      return "s3://voice-cloning-zero-shot/mxG-JSMwfhNaVWVLqawsg/jimy/manifest.json";
    case "shannon":
      return "s3://voice-cloning-zero-shot/looTf0NVHGP5N33Xt3bMJ/shannon/manifest.json";
    case "letby":
      return "s3://voice-cloning-zero-shot/PhpYXU98ksvRQpKiwX-fz/letby/manifest.json";
    case "josef":
      return "s3://voice-cloning-zero-shot/5eTQqEIfsDVfC_xuYSJ2d/josef/manifest.json";
    case "ripper":
      return "s3://voice-cloning-zero-shot/-mclt8urjjQX6KSOD-SpN/york/manifest.json";
    case "hunt":
      return "s3://voice-cloning-zero-shot/xBdn4KI3fopPTXqnrBGkk/hunts/manifest.json";
    case "stalker":
      return "s3://voice-cloning-zero-shot/--ZmP68iZ-Gd_LxyVx2C9/stalker/manifest.json";
    case "prince":
      return "s3://voice-cloning-zero-shot/xReT7HapjXaa2xCkLCRbb/andrew/manifest.json";
    default:
      return "s3://voice-cloning-zero-shot/xhzY33B1Yz3B-ZtcNnUOJ/ted/manifest.json"; // default fallback
  }
}

const fs = require('fs').promises; // Use promise-based fs for async/await
const path = require('path');
const cors = require('cors'); // Enable CORS for frontend interaction
// Add node-fetch if using Node < 18, otherwise built-in fetch can be used
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
// Import Google Cloud Text-to-Speech client library
// *** Make sure to install: npm install @google-cloud/text-to-speech ***
const textToSpeech = require('@google-cloud/text-to-speech');

// --- App Setup ---
const app = express();
const port = process.env.PORT || 3000; // Use Render's port or default to 3000

// --- Constants ---
const RESPONSE_DELAY_MS = 500; // Reduced artificial delay in milliseconds
const TTS_RATE_RANDOMIZATION_FACTOR = 0.05; // +/- 5% for speaking rate
const TTS_PITCH_RANDOMIZATION_RANGE = 0.25; // +/- 0.25 semitones for pitch
const TTS_ELLIPSIS_BREAK_MIN_MS = 400; // Minimum pause for "..."
const TTS_ELLIPSIS_BREAK_MAX_MS = 600; // Maximum pause for "..."
const TTS_GLOBAL_PITCH_ADJUSTMENT = -1.0; // Lower pitch by 1.0 semitone for more depth


// --- Initialize Google Cloud TTS Client ---
let ttsClient;
try {
    ttsClient = new textToSpeech.TextToSpeechClient();
    console.log('[SUCCESS] Google Cloud Text-to-Speech client initialized.');
} catch (error) {
    console.error('[ERROR] FATAL ERROR: Failed to initialize Google Cloud Text-to-Speech client.', error);
    console.error('[ERROR] Ensure the Text-to-Speech API is enabled in your Google Cloud project and GOOGLE_APPLICATION_CREDENTIALS environment variable is set correctly (use Secret Files on Render).');
    process.exit(1); // Exit if TTS client fails to initialize
}

// --- Middleware ---
app.use(cors()); // Enable Cross-Origin Resource Sharing
app.use(express.json()); // Parse JSON request bodies

// --- Static File Serving ---
// Directory for static files (HTML, CSS, JS, background files, sounds)
const publicDir = path.join(__dirname, 'public');
// Serve files from /public/ at the /files URL path (e.g., /files/sounds/cough.mp3)
// This makes files in public/sounds/ accessible via https://your-app.onrender.com/files/sounds/cough.mp3
app.use('/files', express.static(publicDir));
console.log(`[SUCCESS] Serving static files from ${publicDir} at /files route`);
// Serve index.html etc. from the root URL path (also from publicDir)
app.use(express.static(publicDir));
console.log(`[SUCCESS] Serving static files from ${publicDir} at root route`);


// --- Environment Variable Validation ---
const PLAYHT_API_KEY = process.env.PLAYHT_API_KEY;
const PLAYHT_USER_ID = process.env.PLAYHT_USER_ID;


async function streamTTSFromVok(ssmlText, voice, res) {
  try {
    const vokRes = await fetch('https://vok-4ft3.onrender.com/api/tts', {
      method: 'POST',
      headers: {
        'X-USER-ID': PLAYHT_USER_ID,
        'AUTHORIZATION': `Bearer ${PLAYHT_API_KEY}`,
        'accept': 'audio/mpeg',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        text: ssmlText,
        voice: voice,
        output_format: 'mp3',
        speed: 1,
        sample_rate: 48000,
        voice_engine: 'Play3.0'
      })
    });

    if (!vokRes.ok) {
      const errText = await vokRes.text();
      console.error('[Vok] Error:', errText);
      res.status(500).json({ error: 'Failed to stream TTS', details: errText });
      return;
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    vokRes.body.pipe(res);
  } catch (err) {
    console.error('[Vok] Fetch failed:', err.message);
    res.status(500).json({ error: 'TTS stream failed', details: err.message });
  }
}


const PLAYHT_API_KEY = process.env.PLAYHT_API_KEY;
const PLAYHT_USER_ID = process.env.PLAYHT_USER_ID;

async function getTTSFromVok(ssmlText, voice) {
  try {
    const response = await fetch('https://vok-4ft3.onrender.com/api/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': PLAYHT_API_KEY,
        'X-User-Id': PLAYHT_USER_ID
      },
      body: JSON.stringify({
        text: ssmlText,
        voice: voice,
        output_format: 'mp3',
        voice_engine: 'PlayHT2.0'
      })
    });

    if (!response.ok) throw new Error('TTS request failed: ' + response.statusText);
    const result = await response.json();
    return result.audio_url;
  } catch (err) {
    console.error('[TTS ERROR] Failed to fetch from Vok:', err.message);
    return null;
  }
}

console.log('--- Validating Environment Variables ---');
// Note: Google Cloud client library uses GOOGLE_APPLICATION_CREDENTIALS automatically if set.
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.warn('[WARNING] GOOGLE_APPLICATION_CREDENTIALS environment variable is not set. Google Cloud authentication might fail unless running in a configured GCP environment or using Secret Files on Render.');
} else {
    // Local check if not on Render
    if (!process.env.RENDER) {
        fs.access(process.env.GOOGLE_APPLICATION_CREDENTIALS)
            .then(() => console.log(`[SUCCESS] GOOGLE_APPLICATION_CREDENTIALS path (${process.env.GOOGLE_APPLICATION_CREDENTIALS}) is accessible.`))
            .catch(() => console.error(`[ERROR] GOOGLE_APPLICATION_CREDENTIALS path (${process.env.GOOGLE_APPLICATION_CREDENTIALS}) is NOT accessible. Check the path.`));
    } else {
            console.log('[SUCCESS] GOOGLE_APPLICATION_CREDENTIALS environment variable found (assuming Render Secret File).');
    }
}
if (!process.env.GEMINI_API_KEY) { // Check for Gemini Key
    console.error('[ERROR] FATAL ERROR: GEMINI_API_KEY environment variable is not set! Chat will fail.');
    process.exit(1);
} else {
    console.log('[SUCCESS] GEMINI_API_KEY loaded.');
}
if (!process.env.OPENAI_API_KEY) { // Check for OpenAI Key (Fallback)
    console.warn('[WARNING] OPENAI_API_KEY environment variable is not set! OpenAI fallback will fail.');
} else {
    console.log('[SUCCESS] OPENAI_API_KEY loaded (for fallback).');
}
// Check for Render URL (needed for audio hosting)
if (process.env.RENDER && !process.env.RENDER_EXTERNAL_URL) {
    console.warn('[WARNING] Running on Render but RENDER_EXTERNAL_URL is not set. TTS audio tags for sound effects may fail.');
} else if (process.env.RENDER) {
    console.log(`[SUCCESS] RENDER_EXTERNAL_URL found: ${process.env.RENDER_EXTERNAL_URL}`);
}
console.log('--- Environment Variable Validation Complete ---');


// --- File Paths ---
// Use /tmp for history on Render (ephemeral storage), otherwise use local dir
const historyBaseDir = process.env.RENDER ? '/tmp' : path.join(__dirname, 'backend_data');
// Ensure local directory exists if not on Render
if (!process.env.RENDER) {
    fs.mkdir(historyBaseDir, { recursive: true })
     .then(() => console.log(`[SUCCESS] Ensured local history directory exists: ${historyBaseDir}`))
     .catch(err => console.error(`[ERROR] Failed to ensure local history directory: ${historyBaseDir}`, err));
}

// --- Personality Configuration (Updated for Google Cloud TTS with Character Voices/Params) ---
const personalities = {
    huntley: { // Ian Huntley (UK Male)
        name: 'Ian Huntley & Maxine Carr',
        backgroundFile: 'Huntley.txt',
        toneFile: 'Huntleyprompt.txt',
        googleVoice: {
            languageCode: 'en-GB',
            name: 'en-GB-Wavenet-B', // Wavenet for better quality
            params: { pitch: -0.5 } // Slightly deeper default tone
        }
        // gender: 'male' // Example if gender-specific sounds were needed later
    },
    bundy: { // Ted Bundy (US Male)
        name: 'Ted Bundy',
        backgroundFile: 'Tedbundy.txt',
        toneFile: 'Tedbundyprompt.txt',
        googleVoice: {
            languageCode: 'en-US',
            name: 'en-US-Wavenet-J', // Wavenet for smoothness
            params: { speakingRate: 0.95, pitch: -1.0 } // Slightly slower, deeper, calmer/controlled default
        }
    },
    ripper: { // Yorkshire Ripper (Peter Sutcliffe - UK Male)
        name: 'Yorkshire Ripper',
        backgroundFile: 'Yorkshire.txt',
        toneFile: 'Yorkshireprompt.txt',
        googleVoice: {
            languageCode: 'en-GB',
            name: 'en-GB-News-L', // Suggested Yorkshire/Northern accent voice
            params: { speakingRate: 0.9, pitch: -2.5 } // Slower, quite deep default tone
        }
    },
    fritzl: { // Josef Fritzl (Austrian/German Male)
        name: 'Josef Fritzl',
        backgroundFile: 'Josef.txt',
        toneFile: 'Josefprompt.txt',
        googleVoice: {
            languageCode: 'de-DE',
            name: 'de-DE-Wavenet-B', // German Wavenet Male
            params: { pitch: -2.0, speakingRate: 0.95 } // Deeper, slightly slower default tone
        }
    },
    andrew: { // Prince Andrew (UK Male)
        name: 'Prince Andrew',
        backgroundFile: 'PrinceAndrew.txt',
        toneFile: 'PrinceAndrewprompt.txt',
        googleVoice: { languageCode: 'en-GB', name: 'en-GB-News-K' }
    },
    dennis: { // Dennis Nilsen (Scottish Male)
        name: 'Dennis Nilsen',
        backgroundFile: 'Des.txt',
        toneFile: 'Dennisprompt.txt',
        googleVoice: {
            languageCode: 'en-GB',
            name: 'en-GB-Neural2-D',
            params: { speakingRate: 1.0, pitch: -1.5 } // Slightly slower, deeper default tone
        }
    },
    west: { // Fred West (UK Male)
        name: 'Fred & Rose West',
        backgroundFile: 'West.txt',
        toneFile: 'Westprompt.txt',
        googleVoice: {
            languageCode: 'en-GB',
            name: 'en-GB-Wavenet-B', // Wavenet Male
            params: { speakingRate: 1.0, pitch: -5.5 } // Slower, deeper default
        }
    },
    gracy: { // John Wayne Gacy (US Male)
        name: 'John Wayne Gacy',
        backgroundFile: 'JohnWayneGracy.txt',
        toneFile: 'Gacyprompt.txt',
        googleVoice: {
            languageCode: 'en-US',
            name: 'en-US-Wavenet-A', // Different US Wavenet Male
            params: { pitch: 0.7 } // Slightly higher default pitch
        }
    },
    zodiac: { // Zodiac Killer (US Male - Unknown)
        name: 'Zodiac Killer',
        backgroundFile: 'Zodiac.txt',
        toneFile: 'Zodiacprompt.txt',
        googleVoice: {
            languageCode: 'en-US',
            name: 'en-US-Wavenet-J',
            params: { speakingRate: 0.9, pitch: -4.0 } // Slower, deeper default
        }
    },
    'p-diddy': { // P Diddy (US Male)
        name: 'P Diddy / Puff Daddy',
        backgroundFile: 'Pdiddy.txt',
        toneFile: 'Pdiddyprompt.txt',
        googleVoice: {
            languageCode: 'en-US',
            name: 'en-US-Wavenet-J',
            params: { speakingRate: 1.05 } // Slightly faster default
        }
    },
    dahmer: { // Jeffrey Dahmer (US Male)
        name: 'Jeffrey Dahmer',
        backgroundFile: 'Dahmer.txt',
        toneFile: 'Dahmerprompt.txt',
        googleVoice: {
            languageCode: 'en-US',
            name: 'en-US-Wavenet-J',
            params: { speakingRate: 0.9, pitch: -2.0 } // Slower, deeper, flatter default
        }
    },
    shipman: { // Harold Shipman (UK Male)
        name: 'Harold Shipman',
        backgroundFile: 'Harold.txt',
        toneFile: 'Haroldprompt.txt',
        googleVoice: {
            languageCode: 'en-GB',
            name: 'en-GB-Wavenet-B',
            params: { speakingRate: 0.8, pitch: -1.0 } // Slightly deeper default
        }
    },
    savile: { // Jimmy Savile (UK Male - Yorkshire)
        name: 'Jimmy Savile',
        backgroundFile: 'Jimmy.txt',
        toneFile: 'Jimmyprompt.txt',
        googleVoice: {
            languageCode: 'en-GB',
            name: 'en-GB-News-L', // Suggested Yorkshire/Northern voice
            params: { speakingRate: 1.1, pitch: 1.0 } // Faster, slightly higher pitch default
        }
    },
    glitter: { // Gary Glitter (UK Male)
        name: 'Gary Glitter',
        backgroundFile: 'Glitter.txt',
        toneFile: 'Glitterprompt.txt',
        googleVoice: {
            languageCode: 'en-GB',
            name: 'en-GB-Wavenet-D',
            params: { pitch: -1.4 } // Slightly deeper default
        }
    },
    epstein: { // Jeffrey Epstein (US Male)
        name: 'Jeffrey Epstein',
        backgroundFile: 'Jeffrey.txt',
        toneFile: 'Jeffreyprompt.txt',
        googleVoice: {
            languageCode: 'en-US',
            name: 'en-US-Wavenet-J',
            params: { speakingRate: 0.95, pitch: -0.5 } // Slightly slower, standard pitch default
        }
    },
    lucy: { // Lucy Letby (UK Female)
        name: 'Lucy Letby',
        backgroundFile: 'Lucy.txt',
        toneFile: 'Lucyprompt.txt',
        googleVoice: { languageCode: 'en-GB', name: 'en-GB-Neural2-A' ,
                       params: { speakingRate: 1.0, pitch: -1.2 }}// UK Neural2 Female
        // gender: 'female'
    },
    shannon: { // Karen Matthews (UK Female - Yorkshire)
        name: 'Karen Matthews',
        backgroundFile: 'Shannon.txt',
        toneFile: 'Shannonprompt.txt',
        googleVoice: { languageCode: 'de-DE', name: 'en-GB-Wavenet-F',
                      params: { speakingRate: 0.90, pitch: -0.2 }}

            
        
        
    },
brady: {
    name: 'Ian Brady',
    backgroundFile: 'Brady.txt',
    toneFile: 'Bradyprompt.txt',
    googleVoice: {
        languageCode: 'en-GB',
        name: 'en-GB-Wavenet-B', // Classic deep UK male voice
        params: {
            speakingRate: 1.2,
            pitch: -1.5 // Deep and slow for gangster swagger
        }
    }
},
    
   moors: {
    name: 'Moors Murderers',
    backgroundFile: 'Hindley.txt',
    toneFile: 'Hindleyprompt.txt',
    googleVoice: {
        languageCode: 'en-GB',
        name: 'en-GB-Wavenet-C', // Deeper female or androgynous tone
        params: {
            speakingRate: 1.1,
            pitch: -3.5 // Deepen more for a butch/masc vibe
        }
    }
},
    adolf: { // Adolf Hitler (German Male)
        name: 'Adolf Hitler',
        backgroundFile: 'Adolf.txt',
        toneFile: 'Adolfprompt.txt',
        googleVoice: {
            languageCode: 'de-DE',
            name: 'de-DE-Wavenet-B',
            params: { pitch: -1.0 } // Slightly deeper default
        }
    },
    stalker: { // Yorkshire Stalker (Fictional UK Male)
        name: 'Yorkshire Stalker',
        backgroundFile: 'Skeg.txt',
        toneFile: 'Stalkerprompt.txt',
        googleVoice: {
            languageCode: 'en-GB',
            name: 'en-GB-Wavenet-B',
            params: { speakingRate: 1.0, pitch: -2.0 } // Slower, deeper default
        }
    },
    dando: { // Jill Dando (UK Female)
        name: 'Jill Dando',
        backgroundFile: ['Jilld1.txt', 'Jilld2.txt', 'Jilld3.txt'],
        toneFile: 'Jilldprompt.txt',
    //  googleVoice: { languageCode: 'en-GB', name: 'en-GB-Chirp3-HD-Callirrhoe' } // Studio voice
        googleVoice: { languageCode: 'en-GB', name: 'en-GB-Wavenet-F' }
    }
};

// --- Utility Functions ---

/**
 * Loads chat history for a specific user ID.
 */
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
            try {
                await fs.writeFile(chatHistoryFile, JSON.stringify({ messages: [] }, null, 2));
                return { messages: [] };
            } catch (writeError) {
                console.error(`[ERROR] Failed to create chat history file:`, writeError);
                throw new Error(`Failed to create chat history file: ${writeError.message}`);
            }
        } else if (error instanceof SyntaxError) {
            console.error(`[ERROR] Syntax error parsing chat history for user ${userId}. Resetting.`);
            try {
                await fs.writeFile(chatHistoryFile, JSON.stringify({ messages: [] }, null, 2));
                return { messages: [] };
            } catch (resetError) {
                console.error(`[ERROR] Failed to reset corrupted chat history file:`, resetError);
                throw new Error(`Failed to reset corrupted chat history file: ${resetError.message}`);
            }
        } else {
            console.error(`[ERROR] Error loading chat history from ${chatHistoryFile}:`, error);
            throw error;
        }
    }
}

/**
 * Saves chat history for a specific user ID.
 */
async function saveChatHistory(userId, history) {
    const chatHistoryFile = path.join(historyBaseDir, `chat_history_${userId}.json`);
    try {
        await fs.mkdir(path.dirname(chatHistoryFile), { recursive: true });
        if (!history || !Array.isArray(history.messages)) {
            console.error(`[ERROR] Attempted to save invalid history format for user ${userId}. Aborting.`);
            return;
        }
        await fs.writeFile(chatHistoryFile, JSON.stringify(history, null, 2)); // Pretty-print
        console.log(`[SUCCESS] Saved chat history for user ${userId}`);
    } catch (error) {
        console.error(`[ERROR] Error saving chat history to ${chatHistoryFile}:`, error);
    }
}

/**
 * Reads the content of a file from the public directory.
 */
async function readFileContent(filename) {
    if (!filename || typeof filename !== 'string') {
        console.warn(`[WARNING] Invalid filename to read: ${filename}`);
        return '';
    }
    const filePath = path.join(publicDir, filename);
    try {
        const content = await fs.readFile(filePath, 'utf8');
        return content;
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.error(`[ERROR] File not found: ${filePath}`);
        } else {
            console.error(`[ERROR] Error reading file ${filename} from ${filePath}:`, error);
        }
        return '';
    }
}

// --- API Routes ---

/**
 * GET /api/chat-history/:userId
 */
app.get('/api/chat-history/:userId', async (req, res) => {
    const userId = req.params.userId;
    console.log(`[INFO] GET /api/chat-history user: ${userId}`);
    try {
        if (!userId || typeof userId !== 'string' || userId.length < 10) {
            console.warn(`[WARNING] Invalid userId format: ${userId}`);
            return res.status(400).json({ error: 'Invalid user ID format.' });
        }
        const history = await loadChatHistory(userId);
        res.status(200).json(history);
    } catch (error) {
        console.error(`[ERROR] GET /api/chat-history/${userId}:`, error);
        res.status(500).json({ error: 'Failed to load chat history.', details: error.message });
    }
});

/**
 * POST /api/chat
 */
app.post('/api/chat', async (req, res) => {
    console.log('[INFO] POST /api/chat request received.');
    const { prompt, personality, userId, mood, argumentContext } = req.body;

    // --- Input Validation ---
    if (!personality || typeof personality !== 'string' || !personalities[personality]) {
        return res.status(400).json({ error: 'Invalid or missing personality.' });
    }
    if (!userId || typeof userId !== 'string' || userId.length < 10) {
        return res.status(400).json({ error: 'Invalid or missing user ID.' });
    }
    if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
        return res.status(400).json({ error: 'Invalid or missing prompt.' });
    }
    const validMood = mood && typeof mood === 'string' && ['neutral', 'irritable', 'paranoid', 'defensive', 'agitated', 'calm'].includes(mood) ? mood : null;
    if (mood && !validMood) {
        console.warn(`[WARNING] Invalid mood received: ${mood}. Ignoring.`);
    }
    // --- End Input Validation ---

    try {
        const config = personalities[personality];
        const personaName = config.name;
        let systemPrompt;
        let historyToUse = [];

        // --- Load Background Content ---
        let backgroundContent = '';
        let filesToRead = [];
        if (Array.isArray(config.backgroundFile)) {
            filesToRead = config.backgroundFile;
        } else if (typeof config.backgroundFile === 'string') {
            filesToRead = [config.backgroundFile];
        } else {
            console.error(`[ERROR] Invalid backgroundFile config for ${personality}`);
            return res.status(500).json({ error: `Server config error: Invalid backgroundFile type for ${personality}.` });
        }

        let allFilesReadSuccessfully = true;
        for (const filename of filesToRead) {
            const contentPart = await readFileContent(filename);
            if (contentPart === '') {
                console.error(`[ERROR] Background file missing/empty: ${filename} for ${personality}`);
                allFilesReadSuccessfully = false;
            }
            backgroundContent += contentPart + "\n\n";
        }
        backgroundContent = backgroundContent.trim();

        if (backgroundContent === '' && filesToRead.length > 0) {
            console.error(`[ERROR] All background files missing/empty for ${personality}`);
            return res.status(500).json({ error: `Server config error: All background files missing/empty for ${personality}.` });
        } else if (!allFilesReadSuccessfully && filesToRead.length > 0) {
            console.warn(`[WARNING] Proceeding with partial background content for ${personality}.`);
        }
        // --- End Load Background Content ---

        // --- Load Tone Content ---
        const toneContent = config.toneFile ? await readFileContent(config.toneFile) : '';
        if (config.toneFile && toneContent === '') {
            console.warn(`[WARNING] Tone file specified but not read for ${personality}: ${config.toneFile}`);
        }
        // --- End Load Tone Content ---

        // --- Construct System Prompt ---
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
            systemPrompt += `\n\nSystem note: You are currently in a heated argument with ${argumentContext.opponents.join(' and ')}. Be aggressive, voilent, insulting and sexualy abusive. swear words,  Write in an a murderous tone.`;
        }

        // *** ADDED INSTRUCTION FOR AI TO USE SOUND/PAUSE CUES ***
        systemPrompt += `\n\nAdditionally, incorporate natural speech elements into your response: use "..." (ellipses) to indicate pauses. Where appropriate for your character and the flow of conversation, also include textual cues like *coughs*, *sighs*, *chuckles*, *laughs*, *clears throat*, etc. Use these non-speech cues sparingly and naturally for realism.`;
        // *** END ADDED INSTRUCTION ***

        // --- End Construct System Prompt ---

        // --- Load and Format History ---
        const history = await loadChatHistory(userId);
        historyToUse = history.messages
            .filter(msg => msg.personality === personality)
            .map(msg => ({
                role: msg.sender === 'You' ? 'user' : 'model',
                parts: [{ text: msg.content }]
            }))
            .filter(msg => msg.parts[0].text && msg.parts[0].text.trim() !== '');

        const currentUserTurn = { role: 'user', parts: [{ text: prompt }] };
        const contentsForApi = [
            { role: 'user', parts: [{ text: systemPrompt }] },
            { role: 'model', parts: [{ text: "Understood. I will act as instructed." }] },
            ...historyToUse,
            currentUserTurn
        ];
        // --- End Load and Format History ---

        // --- Call Generative AI (Gemini with OpenAI Fallback) ---
        let botResponse = "Sorry, I encountered an issue processing your request.";
        let generationConfig = { temperature: 1.2, topK: 50, topP: 0.95, maxOutputTokens: 512 };
        let safetySettings = [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ];

        try {
            const geminiPayload = { contents: contentsForApi, generationConfig, safetySettings };

            // *** ADDED: Log Gemini request payload ***
            console.log('[INFO] Sending Gemini API request with payload:', JSON.stringify(geminiPayload, null, 2));
            // *** END ADDED ***

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

fetch('https://vok-4ft3.onrender.com/api/tts', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    text: botResponse,
    voice: getVoiceFor(personality),
    speed: 0.9,
    sample_rate: 48000
  })
}).catch(err => console.error("Failed to send to Vok TTS:", err));

                } catch { botResponse = `Error: ${geminiResponse.statusText}`; }
                throw new Error(`Gemini API Error: ${geminiResponse.status}`); // Trigger fallback
            }

            const geminiData = await geminiResponse.json();

            // *** ADDED: Explicit log for successful Gemini response (if not blocked) ***
            if (!geminiData?.promptFeedback?.blockReason && geminiData?.candidates?.[0]?.content?.parts?.[0]?.text) {
                console.log('[SUCCESS] Gemini API response received and looks good.');
            }
            // *** END ADDED ***


            if (geminiData?.promptFeedback?.blockReason) {
                console.warn(`[WARNING] Gemini response blocked. Reason: ${geminiData.promptFeedback.blockReason}`);
                botResponse = `Blocked by safety filter: ${geminiData.promptFeedback.blockReason}`;
            } else if (geminiData?.candidates?.[0]?.finishReason === 'SAFETY') {
                console.warn(`[WARNING] Gemini response stopped due to safety.`);
                botResponse = "My response was blocked due to safety settings.";
            } else {
                botResponse = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || botResponse;
            }

        } catch (geminiError) {
            console.error('[ERROR] Gemini API call failed:', geminiError.message);
            if (!process.env.OPENAI_API_KEY) {
                console.error('[ERROR] No OpenAI fallback available.');
                botResponse = botResponse.startsWith("Blocked") || botResponse.startsWith("Error:") ? botResponse : "Sorry, AI service failed, no fallback.";
            } else {
                console.warn('[WARNING] Attempting OpenAI fallback...');
                try {
                    const openAiMessages = [
                        { role: 'system', content: systemPrompt },
                        ...historyToUse.map(msg => ({ role: msg.role === 'user' ? 'user' : 'assistant', content: msg.parts[0].text })),
                        { role: 'user', content: prompt }
                    ];
                    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                        body: JSON.stringify({ model: 'gpt-4o', messages: openAiMessages })
                    });

                    if (!openaiRes.ok) {
                        const errorText = await openaiRes.text();
                        console.error(`[ERROR] OpenAI fallback failed: ${openaiRes.status} - ${errorText}`);
                        botResponse = botResponse.startsWith("Blocked") || botResponse.startsWith("Error:") ? botResponse : `Fallback failed (${openaiRes.statusText}).`;
                    } else {
                        const openaiData = await openaiRes.json();
                        botResponse = openaiData?.choices?.[0]?.message?.content || botResponse;
                        console.log('[SUCCESS] OpenAI fallback response received.');
                    }
                } catch (openaiErr) {
                    console.error('[ERROR] OpenAI fallback fetch failed:', openaiErr.message);
                    botResponse = botResponse.startsWith("Blocked") || botResponse.startsWith("Error:") ? botResponse : "Both AI services encountered errors.";
                }
            }
        }
        // --- End Call Generative AI ---

        // --- AMENDMENT: Remove specific name prefixes (e.g., "Ian: ", "Maxine: ") from AI response ---
        // This affects the text displayed to the user, sent for TTS, and saved in history.
        if (botResponse && typeof botResponse === 'string') {
            const originalBotResponse = botResponse;
            botResponse = botResponse.replace(/^(Ian:|Maxine:)\s*/i, "").trim();
            if (botResponse !== originalBotResponse) {
                console.log(`[INFO] Name prefix removed from bot response. Original: "${originalBotResponse.substring(0,50)}...", Cleaned: "${botResponse.substring(0,50)}..."`);
            }
        }
        // --- END AMENDMENT ---


        // --- Save Conversation Turn ---
        const currentHistory = await loadChatHistory(userId);
        currentHistory.messages.push({ sender: 'You', content: prompt, personality: personality });
        currentHistory.messages.push({ sender: personaName, content: botResponse, personality: personality }); // botResponse is now the cleaned version
        await saveChatHistory(userId, currentHistory);
        // --- End Save Conversation Turn ---

        // --- Send Response to Client (with delay) ---
        console.log(`[INFO] Waiting ${RESPONSE_DELAY_MS}ms before sending response for ${personality}.`);
        setTimeout(() => {
            console.log(`[SUCCESS] Sending final response for ${personality} to client after delay.`);
            res.status(200).json({ response: botResponse }); // Send the cleaned botResponse
        }, RESPONSE_DELAY_MS);
        // --- End Send Response ---

    } catch (error) {
        console.error(`[ERROR] Unexpected error in /api/chat for ${personality}:`, error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'An unexpected server error occurred.', details: error.message });
        }
    }
});

/**
 * DELETE /api/chat-history/:userId/:personality
 */
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


/**
 * POST /api/tts (Handles SSML, Render Hosted Audio, Personality Params, Tones)
 */
app.post('/api/tts', async (req, res) => {
    const { text, personality, tone } = req.body; // text received here is already cleaned by /api/chat
    console.log(`[INFO] Received POST request for /api/tts: p='${personality}', tone='${tone || 'default'}'`);

    // --- Input Validation ---
    if (!text || typeof text !== 'string' || text.trim() === '') {
        console.error('[ERROR] Google TTS: Invalid or missing text.');
        return res.status(400).json({ error: 'Invalid or missing text for TTS.' });
    }
    if (!personality || typeof personality !== 'string' || !personalities[personality]) {
        console.error(`[ERROR] Google TTS: Invalid or missing personality key: ${personality}`);
        return res.status(400).json({ error: 'Invalid or missing personality key.' });
    }

    const personalityConfig = personalities[personality];
    const voiceConfig = personalityConfig.googleVoice;

    if (!voiceConfig || !voiceConfig.languageCode || !voiceConfig.name) {
        console.error(`[ERROR] Google TTS: Missing 'googleVoice' configuration for personality: ${personality}`);
        return res.status(500).json({ error: `Server configuration error: Missing voice config for ${personality}.` });
    }
    // --- End Input Validation ---

    // --- Define Voice Parameters ---
    let voiceParams = { speakingRate: 1.0, pitch: 0.0 }; // Default speaking rate
    if (voiceConfig.params && typeof voiceConfig.params === 'object') {
        console.log(`[INFO] Applying default personality parameters for ${personality}:`, voiceConfig.params);
        voiceParams = { ...voiceParams, ...voiceConfig.params };
    }

    // Apply tone-specific modifications
    if (tone === 'angry') {
        console.log(`[INFO] Applying 'angry' voice parameter overrides for ${personality}.`);
        voiceParams = {
            ...voiceParams,
            speakingRate: (voiceParams.speakingRate || 1.0) * 1.2, // Angry tone might make it faster
            pitch: (voiceParams.pitch || 0.0) + 4.0,
            volumeGainDb: (voiceParams.volumeGainDb || 0.0) + 2.0
        };
        // Clamp angry tone adjustments (Google TTS limits)
        voiceParams.speakingRate = Math.max(0.25, Math.min(4.0, voiceParams.speakingRate));
        voiceParams.pitch = Math.max(-20.0, Math.min(20.0, voiceParams.pitch));
        voiceParams.volumeGainDb = Math.max(-96.0, Math.min(16.0, voiceParams.volumeGainDb));
    } else if (tone) {
        console.warn(`[WARNING] Received unhandled tone: '${tone}' for ${personality}. Using default/personality parameters.`);
    }
    // --- End Define Voice Parameters ---

    // --- Prepare SSML Input ---
    let ssmlText = text; // text is already cleaned of name prefixes by /api/chat

    // **Define Sound Mapping (Using Filenames in public/sounds/)**
    // AMENDMENT: Corrected sound map keys and filenames
    const soundMap = {
        "*coughs*":        { fallback: "cough", filename: "fart4.mp3" },
        "laugh":        { fallback: "laugh", filename: "sick.mp3" },
        "feels":         { fallback: "feel", filename: "fart.mp3" }, // Assuming this is a desired custom cue
        "methods":      { fallback: "chuckle", filename: "fart6.mp3" },
        "*clears throat*": { fallback: "clears throat", filename: "clears_throat.mp3" },
        "unlike":         { fallback: "sigh", filename: "fart2.mp3" },
        "*scoffs*":        { fallback: "scoff", filename: "scoff.mp3" }, // Added as a common sound cue
        // Kept 'cough' as a fallback in case AI doesn't use asterisks, though prompt encourages it.
        "criminal":           { fallback: "coughs", filename: "fart5.mp3" }
    };

    // **Determine Base URL for Sounds**
    let baseUrl = process.env.RENDER_EXTERNAL_URL;
    let canHostSounds = !!baseUrl;

    if (!baseUrl && process.env.NODE_ENV !== 'production') {
        baseUrl = `http://localhost:${port}`;
        console.warn(`[WARNING] RENDER_EXTERNAL_URL not set. Using local fallback: ${baseUrl}. Note: Google TTS <audio> needs HTTPS.`);
        canHostSounds = true; // Allow local testing structure
    } else if (!baseUrl) {
        console.error('[ERROR] RENDER_EXTERNAL_URL is not set. Cannot determine public URL for sound files. Audio tags skipped.');
        canHostSounds = false;
    } else if (!baseUrl.startsWith('https://')) {
        baseUrl = baseUrl.replace('http://', 'https://'); // Ensure Render URL is HTTPS
    }

    // **1. Replace Textual Cues with <audio> Tags**
    if (canHostSounds) {
        console.log(`[DEBUG] SSML Prep: Base URL for sounds: ${baseUrl}`);
        for (const marker in soundMap) {
            if (ssmlText.includes(marker)) {
                const { fallback, filename } = soundMap[marker];
                if (!filename) {
                    console.warn(`[WARNING] Skipping marker "${marker}" due to missing filename.`);
                    continue;
                }
                const fullSrcUrl = `${baseUrl}/files/sounds/${filename}`;
                const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(escapedMarker, 'g');
                const audioTag = `<audio src="${fullSrcUrl}">${fallback}</audio>`;
                ssmlText = ssmlText.replace(regex, audioTag);
                console.log(`[DEBUG] SSML Prep: Replacing "${marker}" with audio tag: ${audioTag}`);
            }
        }
    } else {
        console.warn("[WARNING] SSML Prep: Skipping audio tag replacement (base URL unknown).");
    }

    // **2. Replace Ellipses with <break> Tags for Pauses (with randomization)**
    const randomBreakTime = Math.floor(Math.random() * (TTS_ELLIPSIS_BREAK_MAX_MS - TTS_ELLIPSIS_BREAK_MIN_MS + 1)) + TTS_ELLIPSIS_BREAK_MIN_MS;
    ssmlText = ssmlText.replace(/\.\.\./g, `<break time="${randomBreakTime}ms"/>`);
    if (ssmlText.includes('<break time="')) { // Log if a break was actually added
        console.log(`[DEBUG] SSML Prep: Ellipses replaced with <break time="${randomBreakTime}ms"/>`);
    }


    // **3. XML Character Escaping (Omitted for brevity - handle if needed for other special chars)**

    // **4. Wrap in <speak> tags**
    const finalSsml = `<speak>${ssmlText}</speak>`;
    // --- End Prepare SSML Input ---

    try {
        // --- AMENDMENT: Apply global 20% speed increase, then 10% slow down ---
        let currentSpeakingRate = (voiceParams.speakingRate || 1.0) * 1.2 * 0.9; // Net +8%

        // --- AMENDMENT: Add subtle randomization to speaking rate ---
        const rateRandomFactor = (Math.random() - 0.5) * 2 * TTS_RATE_RANDOMIZATION_FACTOR; // Value between -TTS_RATE_RANDOMIZATION_FACTOR and +TTS_RATE_RANDOMIZATION_FACTOR
        currentSpeakingRate = currentSpeakingRate * (1 + rateRandomFactor);
        
        // Clamp final speaking rate to Google's allowed range [0.25, 4.0]
        const finalSpeakingRate = Math.max(0.25, Math.min(4.0, currentSpeakingRate));

        // --- AMENDMENT: Apply global pitch adjustment for depth, then add subtle randomization to pitch ---
        let currentPitch = (voiceParams.pitch || 0.0) + TTS_GLOBAL_PITCH_ADJUSTMENT; // Apply global depth adjustment
        const pitchRandomOffset = (Math.random() - 0.5) * 2 * TTS_PITCH_RANDOMIZATION_RANGE; // Value between -TTS_PITCH_RANDOMIZATION_RANGE and +TTS_PITCH_RANDOMIZATION_RANGE
        currentPitch = currentPitch + pitchRandomOffset;

        // Clamp final pitch to Google's allowed range [-20.0, 20.0]
        const finalPitch = Math.max(-20.0, Math.min(20.0, currentPitch));
        // --- END AMENDMENTS FOR VARIABILITY ---

        // Construct the Google Cloud TTS request using SSML
        const request = {
            input: { ssml: finalSsml }, // Use SSML
            voice: {
                languageCode: voiceConfig.languageCode,
                name: voiceConfig.name
            },
            audioConfig: {
                audioEncoding: 'MP3',
                speakingRate: finalSpeakingRate, // Use the globally adjusted, randomized, and clamped speaking rate
                pitch: finalPitch, // Use the adjusted, randomized and clamped pitch
                ...(voiceParams.volumeGainDb !== undefined && voiceParams.volumeGainDb !== 0.0 && { volumeGainDb: voiceParams.volumeGainDb })
            },
        };

        const baseRateAfterAdjustments = (voiceParams.speakingRate || 1.0) * 1.2 * 0.9;
        const basePitchAfterAdjustment = (voiceParams.pitch || 0.0) + TTS_GLOBAL_PITCH_ADJUSTMENT;

        console.log(`[INFO] Sending SSML request to Google Cloud TTS API: p='${personality}', voice='${voiceConfig.name}', rate=${request.audioConfig.speakingRate.toFixed(2)}, pitch=${request.audioConfig.pitch.toFixed(1)}, volume=${request.audioConfig.volumeGainDb === undefined ? 'default' : request.audioConfig.volumeGainDb.toFixed(1)}`);
        console.log(`[DEBUG] Randomized params: Base Rate (after all adjustments): ~${baseRateAfterAdjustments.toFixed(2)}, Final Rate: ${finalSpeakingRate.toFixed(2)}. Base Pitch (after depth adj): ${basePitchAfterAdjustment.toFixed(1)}, Final Pitch: ${finalPitch.toFixed(1)}`);


        // Performs the text-to-speech request
        const [response] = await ttsClient.synthesizeSpeech(request);
        const audioContent = response.audioContent;

        if (!audioContent) {
            console.error('[ERROR] Google TTS: Received empty audio content from API.');
            return res.status(500).json({ error: 'Google Cloud TTS Error: Received empty audio content.' });
        }

        console.log(`[SUCCESS] Google Cloud TTS successful (SSML, Tone: ${tone || 'default'}). Sending audio response.`);

        // Send the binary audio content back to the client
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Length', audioContent.length);
        res.status(200).send(audioContent);

    } catch (err) {
        console.error(`[ERROR] Error during Google Cloud TTS processing (SSML, Tone: ${tone || 'default'}):`, err);
        console.error(`[ERROR] Failed SSML (approximate): ${finalSsml.substring(0, 500)}...`);
        if (!res.headersSent) {
            const errorMessage = err.message || 'Unknown TTS error';
            const details = err.details || err.code || 'No details';
            res.status(500).json({
                error: 'Server error during Google Cloud TTS processing (SSML).',
                details: `${errorMessage} (Code: ${details})`
            });
        } else {
            console.error("[ERROR] Headers already sent, cannot send JSON error response for Google TTS failure (SSML).")
            if (!res.writableEnded) { res.end(); }
        }
    }
}); // <-- End of app.post('/api/tts', ...) route handler


// --- Health Check Route ---
app.get('/health', (req, res) => {
    console.log('[INFO] Health check requested.');
    const now = new Date();
    res.status(200).json({
        status: 'OK',
        message: 'Server is running',
        timestamp: now.toISOString(),
        serverTime: now.toLocaleString('en-GB', { timeZone: 'Europe/London' })
    });
});


// --- Root Route ---
app.get('/', (req, res) => {
    console.log('[INFO] Root route accessed, serving index.html');
    res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
        if (err) {
            console.error(`[ERROR] Error sending index.html: ${err.message}`);
            if (!res.headersSent) {
                res.status(err.status || 500).end();
            }
        }
    });
});

// --- Start Server ---
app.listen(port, () => {
    console.log(`[SUCCESS] Server listening on port ${port}`);
    console.log(`[INFO] Access locally at http://localhost:${port}`);
    if (process.env.RENDER) {
        console.log(`[INFO] Running on Render`);
        console.log(`[INFO] Public URL likely: ${process.env.RENDER_EXTERNAL_URL || 'Not Set'}`);
    }
    // Log current time according to user context - useful for checking deployment time
    const serverStartTime = new Date();
    console.log(`[INFO] Server started at: ${serverStartTime.toISOString()} / ${serverStartTime.toLocaleString('en-GB', { timeZone: 'Europe/London' })}`);
});
