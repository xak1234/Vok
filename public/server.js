
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
    const response = await fetch('https://api.play.ht/api/v2/tts/stream', {
      method: 'POST',
      headers: {
        'X-USER-ID': PLAYHT_USER_ID,
        'AUTHORIZATION': `Bearer ${PLAYHT_API_KEY}`,
        'accept': 'audio/mpeg',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        text,
        voice,
        output_format: 'mp3',
        speed: 1,
        sample_rate: 48000,
        voice_engine: 'Play3.0'
      })
    });

    res.setHeader('Content-Type', 'audio/mpeg');
    response.body.pipe(res);
  } catch (err) {
    res.status(500).json({ error: 'TTS Stream failed', details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎧 TTS server running on ${PORT}`));
