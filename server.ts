import express from 'express';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const port = parseInt(process.env.PORT || '3000', 10);

  // Allow larger payloads for base64 image quiz crops
  app.use(express.json({ limit: '50mb' }));

  // Shared Gemini client creator
  function getGeminiClient(key?: string) {
    const apiKey = key || process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    return new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }

  // Server-side Gemini API solve endpoint
  app.post('/api/gemini/solve', async (req, res) => {
    try {
      const { contents, apiKey } = req.body;

      // Try provided apiKey or fallback to server process.env.GEMINI_API_KEY
      let ai = getGeminiClient(apiKey);
      if (!ai) {
        ai = getGeminiClient(process.env.GEMINI_API_KEY);
      }

      if (!ai) {
        return res.json({
          text: '',
          success: false,
          reason: 'no_key',
          message: 'No API key provided, using local solver.',
        });
      }

      const contentPayload = Array.isArray(contents) ? contents : [contents];
      const modelsToTry = ['gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];
      let lastReason = 'unknown';

      for (const model of modelsToTry) {
        try {
          const response = await ai.models.generateContent({
            model,
            contents: contentPayload,
            config: { temperature: 0.1 },
          });

          const text = response?.text ? response.text.trim() : '';
          if (text) {
            return res.json({ text, success: true, model });
          }
        } catch (err: any) {
          const msg = (err && err.message) ? err.message : String(err);
          const is429 = msg.includes('429') || msg.includes('resource_exhausted') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota');
          const is403 = msg.includes('403') || msg.includes('PERMISSION_DENIED') || msg.includes('does not have permission');

          if (is429) {
            lastReason = 'quota_exhausted';
            // Try next model in list
            continue;
          }

          if (is403) {
            lastReason = 'permission_denied';
            // If custom key failed with permission denied and server has a different key, try server key
            if (apiKey && process.env.GEMINI_API_KEY && apiKey !== process.env.GEMINI_API_KEY) {
              const serverAi = getGeminiClient(process.env.GEMINI_API_KEY);
              if (serverAi) {
                ai = serverAi;
                continue;
              }
            }
            break;
          }

          lastReason = 'error';
          break;
        }
      }

      // If all models hit quota or permission denied, respond gracefully with HTTP 200
      return res.json({
        text: '',
        success: false,
        reason: lastReason,
        message: 'Gemini rate-limited or unavailable; falling back to local solver.',
      });
    } catch {
      return res.json({
        text: '',
        success: false,
        reason: 'error',
        message: 'Using local solver fallback.',
      });
    }
  });

  // Serve static files or Vite middlewares
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Server listening on port ${port}`);
  });
}

startServer();
