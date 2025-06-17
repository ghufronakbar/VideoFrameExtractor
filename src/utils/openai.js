import fetch from 'node-fetch'
import FormData from 'form-data';
import { OPENAI_API_KEY } from '../constant/openai.js';
const OPENAI_API_URL = "https://api.openai.com/v1";
import fs from "fs"

export const transcribeAudio = async (audioFilePath) => {
    // Download audio ke lokal, misal /tmp/audio.wav (opsional, atau pakai url langsung jika didukung)
    // OpenAI Whisper API: POST /audio/transcriptions
    const form = new FormData()
    form.append('file', fs.createReadStream(audioFilePath)); // Pastikan url/file path sesuai
    form.append('model', 'whisper-1');

    const response = await fetch(`${OPENAI_API_URL}/audio/transcriptions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: form
    });

    const data = await response.json();
    if (!data.text) throw new Error("Transcription failed: " + JSON.stringify(data));
    return data.text;
};

export const gptJson = async (messages, model = "gpt-4o") => {
    const response = await fetch(`${OPENAI_API_URL}/chat/completions`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model,
            messages,
            response_format: { type: "json_object" }
        })
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    try {
        return JSON.parse(data.choices[0].message.content);
    } catch (e) {
        throw new Error("Invalid JSON from OpenAI: " + data.choices[0].message.content);
    }
};
