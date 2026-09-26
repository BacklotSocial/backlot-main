/**
 * Backlot reply worker.
 *
 * Deployed on Cloudflare Workers (free tier, no card required).
 * This is the ONLY place the Gemini API key lives — it never reaches the browser.
 *
 * Required secrets (set with `wrangler secret put NAME`, see README):
 *   GEMINI_API_KEY   - from Google AI Studio
 *   FIREBASE_API_KEY - the same apiKey from your firebaseConfig in app.js
 *   ALLOWED_ORIGIN    - e.g. https://yourname.github.io  (no trailing slash)
 *
 * Optional:
 *   GEMINI_MODEL - defaults to "gemini-flash-latest". Check ai.google.dev
 *   for whichever model is on the free tier when you deploy this.
 */

const DEFAULT_MODEL = "gemini-flash-latest";
const MAX_INPUT_CHARS = 500;
const MAX_PERSONA_CHARS = 600;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env.ALLOWED_ORIGIN);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Bad JSON" }, 400, cors);
    }

    const { idToken, characterName, persona, postText } = body || {};
    if (!idToken || !characterName || !persona || !postText) {
      return json({ error: "Missing fields" }, 400, cors);
    }
    if (postText.length > MAX_INPUT_CHARS || persona.length > MAX_PERSONA_CHARS) {
      return json({ error: "Input too long" }, 400, cors);
    }

    // Verify the caller is a real signed-in Firebase user (no full JWT
    // verification needed — Firebase's own endpoint does it for us).
    const uid = await verifyFirebaseIdToken(idToken, env.FIREBASE_API_KEY);
    if (!uid) {
      return json({ error: "Not signed in" }, 401, cors);
    }

    const prompt = buildPrompt(characterName, persona, postText);

    try {
      const reply = await callGemini(prompt, env.GEMINI_API_KEY, env.GEMINI_MODEL || DEFAULT_MODEL);
      return json({ reply }, 200, cors);
    } catch (err) {
      return json({ error: "Generation failed: " + err.message }, 502, cors);
    }
  },
};

function buildPrompt(characterName, persona, postText) {
  return [
    `You are ${characterName}, a fictional character in a social-media simulation.`,
    `Your personality: ${persona}`,
    ``,
    `Someone just posted this to the shared feed:`,
    `"""${postText}"""`,
    ``,
    `Write a single in-character reply. Stay strictly in character, keep it short, ` +
      `and do not mention that you are an AI, a language model, or a simulation. ` +
      `Do not include quotation marks around your reply. Do not include a name or label — reply text only.`,
  ].join("\n");
}

async function callGemini(prompt, apiKey, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 120, temperature: 0.9 },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    // Most often this means the safety filter blocked the response — that's fine,
    // the caller just skips this character's reply.
    return "";
  }
  return text.trim();
}

async function verifyFirebaseIdToken(idToken, firebaseApiKey) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${firebaseApiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.users?.[0]?.localId || null;
}

function corsHeaders(allowedOrigin) {
  return {
    "Access-Control-Allow-Origin": allowedOrigin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}
