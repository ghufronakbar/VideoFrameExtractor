import express from "express";
const router = express.Router();
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import path from "path";
import fs from "fs";
import ffprobe from "ffprobe-static";
import fetch from "node-fetch";
import cloudinary from "./config/cloudinary.js";
import multer from "multer";
import { gptJson, transcribeAudio } from "./utils/openai.js";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";

const upload = multer({ dest: "uploads/" });

const prisma = new PrismaClient();

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobe.path);

/**
 * Menghitung hash file menggunakan algoritma yang disediakan.
 * Default algoritma adalah SHA-256.
 * @param {string} filePath Path file yang ingin dihitung hash-nya.
 * @param {string} [algo="sha256"] Algoritma yang digunakan untuk menghitung hash.
 * @returns {Promise<string>} Promise yang berisi hash file dalam bentuk string.
 */
function getFileHash(filePath, algo = "sha256") {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algo);
    const stream = fs.createReadStream(filePath);
    stream.on("data", (data) => hash.update(data));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", (err) => reject(err));
  });
}

/**
 * Helper: bagi array frame menjadi 5 kategori sesuai distribusi timestamp
 */
function categorizeFrames(frames) {
  if (!frames.length)
    return {
      opening: [],
      setup: [],
      main: [],
      climax: [],
      closing: [],
      maxTimestamp: 0,
    };
  const maxTimestamp = frames.reduce((max, f) => Math.max(max, f.timestamp), 0);
  const categories = {
    opening: [],
    setup: [],
    main: [],
    climax: [],
    closing: [],
    maxTimestamp,
  };
  frames.forEach((frame) => {
    const perc = (frame.timestamp / maxTimestamp) * 100;
    if (perc <= 10) categories.opening.push(frame);
    else if (perc <= 20) categories.setup.push(frame);
    else if (perc <= 60) categories.main.push(frame);
    else if (perc <= 90) categories.climax.push(frame);
    else categories.closing.push(frame);
  });
  return categories;
}

/**
 * Helper: potong transkrip sesuai bagian (versi simple: split rata per jumlah frame)
 */
function splitTranscript(transcript, categories) {
  // Versi sederhana: bagi transkrip sesuai panjang masing-masing kategori
  const total =
    categories.opening.length +
    categories.setup.length +
    categories.main.length +
    categories.climax.length +
    categories.closing.length;
  if (!total)
    return {
      opening: "",
      setup: "",
      main: "",
      climax: "",
      closing: "",
      general: transcript,
    };
  const words = transcript.split(" ");
  let cursor = 0;
  const parts = {};
  for (let key of ["opening", "setup", "main", "climax", "closing"]) {
    const count = categories[key].length;
    const take = Math.floor((count / total) * words.length);
    parts[key] = words.slice(cursor, cursor + take).join(" ");
    cursor += take;
  }
  parts.general = transcript;
  return parts;
}

/**
 * Helper: prompt untuk OpenAI penilaian
 */
function buildPrompt(segmentName, segmentAudio, segmentFrames) {
  return `
Do an assessment of the following video segment: "${segmentName}".
Attached frames (images): ${segmentFrames.map((f) => f.url).join(", ")}
Transcript audio: ${segmentAudio}

Return ONLY a valid JSON in the following format:

{
  "recomendations": [string, ...],
  "assessmentIndicators": {
    "<indicator_name>": boolean,
    "<indicator_name_2>": boolean
    // ...as many as needed, each key is a relevant assessment aspect you decide
  }
}

Notes:
- "assessmentIndicators" should be a dictionary/object with keys for **any relevant indicators you find important for this segment** (not limited to any fixed list).
- The keys in "assessmentIndicators" must be descriptive and written in English, e.g., "Engagement potential", "Visual originality", "Audio clarity", etc.
- Do NOT leave "recomendations" as an empty array. Always provide at least one actionable recommendation.
- Do NOT leave "assessmentIndicators" as an empty object. Always provide at least one indicator relevant to this segment.
- If unsure, infer plausible indicators and recommendations based on the content.
- All keys should have a boolean value (true if the indicator is satisfied, false if not).
- Do NOT include any text or explanation outside the JSON.
- Output must be in English.
`;
}

/**
 * Validasi apakah obj adalah AssessmentIndicator
 * (object, setiap key string, value boolean)
 */
function isAssessmentIndicator(obj) {
  if (typeof obj !== "object" || Array.isArray(obj) || obj === null)
    return false;
  return Object.values(obj).every((v) => typeof v === "boolean");
}

/**
 * Validasi ResultItem
 */
function isResultItem(obj) {
  return (
    obj &&
    Array.isArray(obj.recomendations) &&
    obj.recomendations.every((r) => typeof r === "string") &&
    isAssessmentIndicator(obj.assessmentIndicators)
  );
}

/**
 * Validasi OpenAIResponseResult
 */
function isOpenAIResponseResult(obj) {
  return (
    obj &&
    isResultItem(obj?.opening) &&
    isResultItem(obj?.setup) &&
    isResultItem(obj?.main) &&
    isResultItem(obj?.climax) &&
    isResultItem(obj?.closing) &&
    obj?.general &&
    isResultItem(obj?.general) &&
    typeof obj?.general?.summary === "string"
  );
}

/**
 * Ekstrak audio dari video lokal dan upload ke Cloudinary
 * Return: { url, name, format, size, duration, sampleRate, channels, channelLayout }
 */
async function extractAndUploadAudio(localVideoPath) {
  // Pastikan temp folder ada
  if (!fs.existsSync("temp")) fs.mkdirSync("temp");
  const audioFileName = `${Date.now()}-audio.wav`;
  const tempAudioPath = path.join("temp", audioFileName);

  // Ekstrak audio
  await new Promise((resolve, reject) => {
    ffmpeg(localVideoPath)
      .noVideo()
      .audioCodec("pcm_s16le")
      .format("wav")
      .save(tempAudioPath)
      .on("end", resolve)
      .on("error", reject);
  });

  // Probe metadata audio
  let metadata = await new Promise((resolve, reject) => {
    ffmpeg.ffprobe(tempAudioPath, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });

  const audioStreamData = metadata.streams.find(
    (s) => s.codec_type === "audio"
  );
  const duration = Number(metadata.format.duration);
  const sample_rate = audioStreamData?.sample_rate
    ? Number(audioStreamData.sample_rate)
    : null;
  const channels = audioStreamData?.channels || null;
  const channel_layout =
    audioStreamData?.channel_layout ||
    (channels === 2 ? "stereo" : channels === 1 ? "mono" : undefined);

  // Upload hasil audio ke Cloudinary
  const uploadAudioResult = await cloudinary.uploader.upload(tempAudioPath, {
    folder: "audio",
    resource_type: "auto",
    use_filename: true,
    unique_filename: true,
  });

  // Clean up
  if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);

  return {
    url: uploadAudioResult.secure_url,
    name: uploadAudioResult.public_id,
    format: uploadAudioResult.format,
    size: uploadAudioResult.bytes,
    duration,
    sampleRate: sample_rate,
    channels,
    channelLayout: channel_layout,
  };
}

/**
 * Ekstrak frames dari video lokal dan upload ke Cloudinary
 * Return: { frames: Array, videoFile: Object, settings: Object }
 */
async function extractAndUploadFrames(localVideoPath, fileInfo, settings = {}) {
  // Pastikan temp folder ada
  if (!fs.existsSync("temp")) fs.mkdirSync("temp");
  const tempFramesDir = path.join("temp", `frames-${Date.now()}`);
  if (!fs.existsSync(tempFramesDir)) fs.mkdirSync(tempFramesDir);

  // Extract metadata dari video lokal
  const meta = await new Promise((resolve, reject) => {
    ffmpeg.ffprobe(localVideoPath, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
  const videoStreamInfo = meta.streams.find((s) => s.codec_type === "video");
  if (!videoStreamInfo) throw new Error("No video stream found");
  const duration = Number(meta.format.duration);
  const width = videoStreamInfo.width;
  const height = videoStreamInfo.height;
  const format = fileInfo.mimetype;
  const size = fileInfo.size;

  // Settings
  const usedSettings = {
    interval: Number(settings.interval) || 0.8,
    format: settings.format || "jpeg",
    quality: Number(settings.quality) || 0.8,
  };

  // Ekstrak frames ke folder temp
  const framePattern = path.join(
    tempFramesDir,
    `frame-%03d.${usedSettings.format}`
  );
  await new Promise((resolve, reject) => {
    ffmpeg(localVideoPath)
      .outputOptions([`-vf`, `fps=1/${usedSettings.interval}`])
      .output(framePattern)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });

  // Upload semua frames ke Cloudinary secara paralel
  const files = fs
    .readdirSync(tempFramesDir)
    .filter((f) => f.endsWith(usedSettings.format));
  const uploads = files.map((file, idx) => {
    const framePath = path.join(tempFramesDir, file);
    return cloudinary.uploader
      .upload(framePath, {
        folder: "frames",
        resource_type: "image",
        use_filename: true,
        unique_filename: true,
      })
      .then((result) => ({
        id: `frame-${idx}`,
        timestamp: idx * usedSettings.interval,
        url: result.secure_url,
        size: result.bytes,
      }));
  });
  const extractedFrames = await Promise.all(uploads);

  // Clean up temp files
  files.forEach((f) => {
    const p = path.join(tempFramesDir, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
  if (fs.existsSync(tempFramesDir)) fs.rmdirSync(tempFramesDir);

  // Return hasil
  return {
    frames: extractedFrames,
    videoFile: {
      url: null, // No cloudinary video url, karena tidak di-upload video aslinya ke cloudinary di route ini
      duration,
      width,
      height,
      format,
      size,
      name: fileInfo.filename,
    },
    settings: usedSettings,
  };
}

/**
 * MAIN ROUTE (ONLY THIS)
 */
router.post("/api/main", upload.single("video"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "No video file uploaded" });
  }
  const inputPath = req.file.path;

  try {
    // === LANGKAH 1: Hashing file video ===
    const identifier = await getFileHash(inputPath, "sha256");
    console.log("file hash identifier:", identifier);

    // === LANGKAH 2: Cek DB ===
    const existing = await prisma.data.findUnique({
      where: { identifier },
    });

    if (existing) {
      console.log("data already exists, returning existing data");
      // Clean up file upload karena sudah tidak perlu
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      // Return hasil lama dari DB
      return res.status(200).json(existing.result);
    }
    console.log("data not found in DB, processing...");

    // === LANGKAH 3: (lanjut proses ekstrak & AI analysis seperti sebelumnya) ===

    // Step 1. Ekstrak audio & frames (upload ke Cloudinary)
    const [audioData, framesData] = await Promise.all([
      extractAndUploadAudio(inputPath),
      extractAndUploadFrames(inputPath, req.file, {
        interval: req.body.interval,
        format: req.body.format,
        quality: req.body.quality,
      }),
    ]);

    // Hapus file lokal
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);

    // Step 2. Transkrip audio
    let transcript = audioData.transcript;
    if (!transcript) {
      // Download file audio
      const audioUrl = audioData.url;
      const audioFileName = "audio-temp.wav";
      const audioTempPath = path.join("temp", audioFileName);
      if (!fs.existsSync("temp")) fs.mkdirSync("temp");
      const audioRes = await fetch(audioUrl);
      const outStream = fs.createWriteStream(audioTempPath);
      await new Promise((resolve, reject) => {
        audioRes.body.pipe(outStream);
        audioRes.body.on("error", reject);
        outStream.on("finish", resolve);
      });
      transcript = await transcribeAudio(audioTempPath);
      if (fs.existsSync(audioTempPath)) fs.unlinkSync(audioTempPath);
    }

    // Step 3. Bagi transcript ke masing-masing bagian
    const categories = categorizeFrames(framesData.frames);
    const audioSegments = splitTranscript(transcript, categories);

    // Step 4. Penilaian OpenAI per bagian (Promise.all)
    const partNames = ["opening", "setup", "main", "climax", "closing"];
    const openaiPayloads = partNames.map((name) => {
      return gptJson([
        { role: "system", content: "You are proffesional video analyzer." },
        {
          role: "user",
          content: buildPrompt(name, audioSegments[name], categories[name]),
        },
      ]);
    });
    const [opening, setup, main, climax, closing] = await Promise.all(
      openaiPayloads
    );

    const summaryPrompt = `
        You are given the assessment results of each part of a video:
        Opening: ${JSON.stringify(opening)},
        Setup: ${JSON.stringify(setup)},
        Main: ${JSON.stringify(main)},
        Climax: ${JSON.stringify(climax)},
        Closing: ${JSON.stringify(closing)}
        
        And the following is the full transcript of the video's audio:
        ${audioSegments.general}
        
        Now, do NOT summarize the assessment results.
        Instead, generate a concise summary of WHAT this video is about. 
        Your summary should answer: "What is the video about, and what happens from the beginning to the end?"
        For example: "A video that shows marketing of XYZ product. In the beginning, the video introduces the product, followed by user testimonials, then explains the benefits, and ends with a call to action."
        
        Return ONLY a valid JSON in the following format:
        {
          "recomendations": [string, ...],
          "assessmentIndicators": { ... },
          "summary": string
        }
        
        - Do NOT leave "recomendations" as an empty array. Always provide at least one actionable recommendation.
        - Do NOT leave "assessmentIndicators" as an empty object. Always provide at least one indicator relevant to this segment.
        - Write the summary in English, describing the video content/story, not the evaluation or recommendations.
        - Do NOT include any explanation or text outside the JSON.
        - The "recomendations" and "assessmentIndicators" fields should be copied from previous results or left empty (as you see fit).
        `;

    const general = await gptJson([
      { role: "system", content: "You are proffesional video analyzer." },
      { role: "user", content: summaryPrompt },
    ]);

    // Step 6.  hasil
    const result = {
      general,
      opening,
      setup,
      main,
      climax,
      closing,
    };

    // Step 7. Validasi hasil
    if (!isOpenAIResponseResult(result)) {
      throw new Error(
        "Invalid result structure from OpenAI (does not match expected interface)"
      );
    }

    // === LANGKAH 4: Simpan ke DB pakai identifier hash ===
    const data = { result, audio: audioData, frames: categories };
    const created = await prisma.data.create({
      data: {
        identifier,
        result: data,
      },
    });

    return res.status(200).json(created.result);
  } catch (error) {
    console.error(error);
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    return res
      .status(500)
      .json({ message: "Sorry there's a problem", error: error.message });
  }
});

export default router;
