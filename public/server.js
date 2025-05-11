
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

  if (!text || !voice) {
    return res.status(400).json({ error: 'Missing text or voice in request' });
  }

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
        sample_rate: 24000,
        voice_engine: 'PlayHT2.0'
      })
    });

    const contentType = response.headers.get('content-type');
    if (!response.ok || !contentType || !contentType.includes('audio/mpeg')) {
      const errorText = await response.text();
      console.error('PlayHT Error:', errorText);
      return res.status(500).json({ error: 'PlayHT failed', details: errorText });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    response.body.pipe(res);
  } catch (err) {
    console.error('Streaming Error:', err.message);
    res.status(500).json({ error: 'Streaming failed', details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔊 Vok TTS server running on ${PORT}`));
