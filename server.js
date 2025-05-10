
const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

const PLAYHT_USER_ID = process.env.PLAYHT_USER_ID;
const PLAYHT_API_KEY = process.env.PLAYHT_API_KEY;

app.post('/api/tts', async (req, res) => {
  const { text, voice } = req.body;

  try {
    const response = await fetch('https://api.play.ht/api/v2/tts', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'Authorization': `Bearer ${PLAYHT_API_KEY}`,
        'X-User-ID': PLAYHT_USER_ID
      },
      body: JSON.stringify({
        text,
        voice,
        output_format: 'mp3',
        voice_engine: 'PlayHT2.0'
      })
    });

    const result = await response.json();
    if (result && result.audioUrl) {
      res.json({ audioUrl: result.audioUrl });
    } else {
      res.status(500).json({ error: 'TTS failed', raw: result });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎧 TTS server running on ${PORT}`));
