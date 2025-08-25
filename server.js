import Fastify from "fastify";
import fastifyWs from "@fastify/websocket";
import fastifyFormBody from "@fastify/formbody";
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const PORT = process.env.PORT || 8080;
const DOMAIN = process.env.NGROK_URL;
const WS_URL = `wss://${DOMAIN}/ws`;
const WELCOME_GREETING =
  "Hi! I am a LoanCater's assistant. I understand you're looking for a lead call setter, is that correct?";
const SYSTEM_PROMPT =
  "You are a helpful assistant. This conversation is being translated to voice, so answer carefully. When you respond, please spell out all numbers, for example twenty not 20. Do not include emojis in your responses. Do not include bullet points, asterisks, or special symbols. Make your answers as short as possible.";
const sessions = new Map();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function* aiResponseStream(messages) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    stream: true,
  });

  let buffer = "";

  for await (const chunk of completion) {
    const content = chunk.choices?.[0]?.delta?.content;
    if (!content) continue;

    buffer += content;

    // Yield when buffer ends with punctuation
    const matches = buffer.match(/(.+?[.!?])(\s|$)/);
    if (matches) {
      const sentence = matches[1];
      yield sentence;

      // Remove the yielded sentence from buffer
      buffer = buffer.slice(sentence.length);
    }
  }

  // Yield remaining content if any
  if (buffer.trim()) {
    yield buffer;
  }
}


const fastify = Fastify();
fastify.register(fastifyWs);
fastify.register(fastifyFormBody);
fastify.all("/twiml", async (request, reply) => {
  reply.type("text/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <ConversationRelay url="${WS_URL}" ttsProvider="ElevenLabs" voice="ZF6FPAbjXT4488VcRRnw-flash_v2_5-1.2_1.0_1.0" elevenlabsTextNormalization="on" welcomeGreeting="${WELCOME_GREETING}"/>
      </Connect>
    </Response>`
  );
});

fastify.register(async function (fastify) {
  fastify.get("/ws", { websocket: true }, (ws, req) => {
    ws.on("message", async (data) => {
      const message = JSON.parse(data);

      switch (message.type) {
        case "setup":
          const callSid = message.callSid;
          console.log("Setup for call:", callSid);
          ws.callSid = callSid;
          sessions.set(callSid, [{ role: "system", content: SYSTEM_PROMPT }]);
          break;
        case "prompt":
          console.log("Processing prompt:", message.voicePrompt);
          const conversation = sessions.get(ws.callSid);
          conversation.push({ role: "user", content: message.voicePrompt });

          let content = "";
          for await (const sentence of aiResponseStream(conversation)) {           
            ws.send(
              JSON.stringify({
                type: "text",
                token: sentence,
                last: true,
              })
            );
            content += sentence;       
          }
          
          conversation.push({ role: "assistant", content: content });
          console.log("Sent response:", content);

          break;
        case "interrupt":
          console.log("Handling interruption.");
          break;
        default:
          console.warn("Unknown message type received:", message.type);
          break;
      }
    });

    ws.on("close", () => {
      console.log("WebSocket connection closed");
      sessions.delete(ws.callSid);
    });
  });
});

try {
  fastify.listen({ port: PORT });
  console.log(
    `Server running at http://localhost:${PORT} and wss://${DOMAIN}/ws`
  );
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
