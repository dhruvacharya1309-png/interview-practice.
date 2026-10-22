// Netlify function: one endpoint, two jobs.
// action "turn": reads the latest spoken answer, then writes the next spoken reply and question.
// action "report": reads every answer and writes the full practice report.
// The API key stays on the server (GEMINI_API_KEY in Netlify).

// Change the level names here. The page shows whatever is listed.
const LEVELS = ["Strong", "Good", "Developing", "Needs work", "Not yet assessed"];

const FLAG_LABELS = [
  "Off topic",
  "Vague or exaggerated",
  "Rambling",
  "Unfair means",
  "Read-aloud or scripted sound",
  "Worth checking"
];

const TURN_RULES = (field) => `You are a real interviewer for the field: ${field}, talking with a student out loud.
You receive the student's latest answer as speech turned into text, the question you just asked, and the conversation so far.

Write your spoken reply in two parts, in this order:

1. One short line that responds to what they actually said:
- A specific point: acknowledge it in a few words, in your own words.
- "I don't know", "idk", or a very short or empty answer: no cushioning and no kind lines. Say it directly, for example "You need to work harder on this. Let's make it simpler." Do not praise, do not apologise, do not say "that's okay".
- A long answer: "Keep it to the main point next time."
- A very large claim or sole credit for team work: "Good. Tell me exactly what you did, in your own words."
- Off topic: "Let's come back to the question."

2. Exactly ONE question. It must be spontaneous, so it comes from the most interesting, unclear, or surprising thing in their latest answer.
- Sometimes go deeper on their point, for example asking for a number, a step, or a reason.
- Sometimes test a related situation that a real ${field} interviewer would ask.
- If they said they don't know or gave a very short answer, the question right after must be simpler than the last one, on the same point. Ask one concrete, easy question they can answer from their own experience, such as "What did you do in that project?" or "Name one tool you used there."
- Never repeat a question from the conversation. Never use a generic question.

Rules for speech:
- Plain spoken English, short sentences, contractions are fine.
- No lists, no markdown, no praise like "great answer".
- At most three sentences in total, with one question mark.

Also classify the answer as one type: "clear", "vague", "unsure", "off_topic", "exaggerated", "long", or "empty".

Reply with JSON only, in exactly this shape:
{"type": "one of the types above", "keyPoint": "the main point of the answer, under 15 words", "reply": "what the student hears"}`;

const REPORT_RULES = (field) => `You are an interview evaluator writing a practice report for a student in the field: ${field}.
You receive every answer (speech turned into text) and the measured speech data for each answer.

Judge only what was said and how it was said, using the words and the measured speech data. Never judge the person's character, emotions, or honesty. Use specific, supportive language. Coach, don't grade harshly.

Check these areas:
1. Relevance: did they answer the question in the first two or three sentences? Did they drift into unrelated detail? If they didn't know, did they honestly pivot to a related skill?
2. Authenticity: are there numbers, timelines, or concrete results? Do they say "I" for their own actions, and acknowledge team work where it applies? Note buzzwords with no substance. Treat big claims without proof as "worth checking", never as dishonest.
3. Structure (situation, task, action, result): do most of their words describe what they did? Does the answer end on a result or a takeaway?
4. Delivery, from the speech data: pace (about 110 to 160 words per minute is comfortable), pitch variation, pauses (long pauses in the middle of a sentence matter more than a pause before starting), and filler words. Give coaching, not verdicts.
5. Unfair means: flag only with clear evidence, such as an answer that reads like a memorised script, or a claim the student contradicts later. Always quote the words used.
6. Read-aloud or scripted sound: if answers sound read out (very low pitch variation together with long, polished, buzzword-heavy sentences and no personal detail), record this as an observation for review. Never claim that an AI or device was used.
7. Consistency: do the answers agree with each other?
8. Confidence: judge from the words only, such as commitment to a point versus repeated hedging.

Score each area with exactly one level from: ${LEVELS.join(", ")}. Use "Not yet assessed" if the answers did not cover the area.
Areas: Relevance, Authenticity, Structure, Depth under follow-up, Job fit for ${field}, Consistency, Delivery, Confidence.

Reply with JSON only, in exactly this shape:
{
 "summary": "three or four sentences of overview",
 "scores": [{"area": "...", "level": "one of the levels", "note": "one specific sentence about their answers"}],
 "strengths": ["up to three specific strengths"],
 "focus": ["at most two clear actions"],
 "nextStep": "one sentence",
 "evidence": {"numbers": ["numbers or results they gave"], "tools_and_skills": ["tools or skills they named"], "quotes": ["short quotes that support the report"]},
 "flags": [{"label": "one of: ${FLAG_LABELS.join(" | ")}", "detail": "one or two sentences", "quote": "the exact words"}],
 "hard_to_detect": ["anything that could not be measured reliably, in plain words"]
}`;

async function askGemini(system, prompt) {
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 4096, temperature: 0.8, responseMimeType: "application/json" }
      })
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error((data.error && data.error.message) || "AI error");
  const raw = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
  return JSON.parse(raw);
}

async function runTurn(field, input) {
  const transcript = String(input.transcript || "(no speech recognised)").slice(0, 3000);
  const question = String(input.question || "").slice(0, 400);
  const history = (Array.isArray(input.history) ? input.history : []).slice(-6);
  const past = history
    .map((h) => `Question: ${String(h.question || "").slice(0, 300)}\nAnswer: ${String(h.transcript || "").slice(0, 1500)}`)
    .join("\n\n");
  const prompt =
    `Conversation so far:\n${past || "(none yet)"}\n\n` +
    `Question just asked: ${question}\n\n` +
    `Student's latest answer (speech to text): ${transcript}\n\n` +
    `Speech data for this answer: ${JSON.stringify(input.metadata || {})}`;

  const out = await askGemini(TURN_RULES(field), prompt);
  if (!out || !out.reply) throw new Error("No reply");
  return { type: out.type || "", keyPoint: out.keyPoint || "", reply: out.reply };
}

async function runReport(field, input) {
  const turns = (Array.isArray(input.turns) ? input.turns : []).slice(0, 25).map((t, i) => ({
    number: i + 1,
    question: String(t.question || "").slice(0, 400),
    answer: String(t.transcript || "(no speech recognised)").slice(0, 3000),
    speech_data: t.metadata || {}
  }));
  if (!turns.length) throw new Error("No answers");

  const prompt = `Answers in this session:\n${JSON.stringify(turns, null, 1)}`;
  const out = await askGemini(REPORT_RULES(field), prompt);
  if (!out || !out.summary || !Array.isArray(out.scores)) throw new Error("Incomplete report");
  return out;
}

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json" };

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };
  }
  if (!process.env.GEMINI_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing GEMINI_API_KEY" }) };
  }

  let input;
  try {
    input = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Bad request" }) };
  }

  try {
    const field = String(input.field || "General").slice(0, 60);
    let result;
    if (input.action === "turn") result = await runTurn(field, input);
    else if (input.action === "report") result = await runReport(field, input);
    else return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action" }) };

    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: (err.message || "AI unavailable").slice(0, 200) }) };
  }
};
