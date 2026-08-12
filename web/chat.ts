import {
  GoogleGenAI,
  Type,
  type FunctionDeclaration,
} from "@google/genai";
import type pg from "pg";
import {
  getGhostBuses,
  getHeadwayGaps,
  getRouteReliability,
  getWorstRoutesToday,
} from "./tools.js";
import { getCommuteVerdict } from "./commute.js";

// Free-tier RPD on gemini-3.5-flash is only 20. Override with GEMINI_MODEL if needed.
const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";

const toolDeclarations: FunctionDeclaration[] = [
  {
    name: "getRouteReliability",
    description:
      "Get 15-minute on-time percentage and average delay for a MARTA route over the last N hours.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        route: {
          type: Type.STRING,
          description: "MARTA route_id (e.g. '1', '110', 'GOLD').",
        },
        hours: {
          type: Type.NUMBER,
          description: "Lookback window in hours (default 4, max 48).",
        },
      },
      required: ["route"],
    },
  },
  {
    name: "getGhostBuses",
    description:
      "List ghost buses: trips on today's timetable that should already be in service but have never appeared in GPS. Optional route filter (e.g. '46').",
    parameters: {
      type: Type.OBJECT,
      properties: {
        route: {
          type: Type.STRING,
          description: "Optional MARTA route (short name like '46' or 'GOLD').",
        },
      },
    },
  },
  {
    name: "getWorstRoutesToday",
    description:
      "Return the worst-performing MARTA routes today by on-time percentage.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "getHeadwayGaps",
    description:
      "Find service gaps on a MARTA route: gaps over 15 minutes between consecutive vehicle sightings in the last 2 hours.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        route_id: {
          type: Type.STRING,
          description: "MARTA route short name (e.g. '46', '20', 'GOLD').",
        },
      },
      required: ["route_id"],
    },
  },
  {
    name: "getCommuteVerdict",
    description:
      "Decide whether a rider should take a MARTA bus or an Uber to arrive on time. Prefer passing a destination (stop name like 'Georgia Tech' or 'North Ave Station'). Optionally include a preferred route. Returns take_bus / take_uber / toss_up / no_service with on-time %, ghost no-shows, destination-serving alternatives, and last vehicle.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        destination: {
          type: Type.STRING,
          description:
            "Where the rider needs to go — a MARTA stop name fragment (e.g. 'Georgia Tech', 'Five Points', 'North Ave Station').",
        },
        stop_id: {
          type: Type.STRING,
          description: "Optional exact MARTA stop_id if known.",
        },
        route: {
          type: Type.STRING,
          description:
            "Optional preferred MARTA route short name (e.g. '46', '20', 'GOLD'). If omitted with a destination, picks the most reliable route that serves it.",
        },
        arrive_by: {
          type: Type.STRING,
          description: "Optional arrival time as HH:MM (e.g. '09:30').",
        },
      },
    },
  },
];

async function runTool(
  pool: pg.Pool,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (name) {
    case "getRouteReliability":
      return getRouteReliability(
        pool,
        String(args.route ?? ""),
        Number(args.hours ?? 4)
      );
    case "getGhostBuses":
      return getGhostBuses(
        pool,
        String(args.route ?? args.route_id ?? "").trim() || undefined
      );
    case "getWorstRoutesToday":
      return getWorstRoutesToday(pool);
    case "getHeadwayGaps":
      return getHeadwayGaps(
        pool,
        String(args.route_id ?? args.route ?? "")
      );
    case "getCommuteVerdict":
      return getCommuteVerdict(pool, {
        route: String(args.route ?? args.route_id ?? "").trim() || undefined,
        destination:
          String(args.destination ?? args.to ?? "").trim() || undefined,
        stop_id: String(args.stop_id ?? args.stopId ?? "").trim() || undefined,
        arrive_by:
          String(args.arrive_by ?? args.arriveBy ?? "").trim() || undefined,
      });
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

export async function askMartaChat(
  pool: pg.Pool,
  question: string
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required");
  }

  const ai = new GoogleGenAI({ apiKey });

  const systemInstruction = [
    "You are Transit Ledger ATL, an assistant for Atlanta MARTA bus/rail reliability.",
    "Use the provided tools to answer with real data from TimescaleDB.",
    "If the user asks whether a route is trustworthy, bus vs Uber, how to get somewhere on time, or making a class/appointment, call getCommuteVerdict with destination when a place is mentioned.",
    "Ghost buses are scheduled trips that never showed up on GPS — not feed glitches.",
    "Be concise. Cite route ids, on-time %, ghost counts, and delays when available.",
    "Format answers with light markdown: **bold** for route ids and percentages, numbered lists for rankings.",
    "If data is empty, say the poller may not have run yet.",
  ].join(" ");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contents: any[] = [
    {
      role: "user",
      parts: [{ text: question }],
    },
  ];

  // Manual tool loop (up to 3 rounds). Preserve raw model parts so
  // thought_signature (required by Gemini 3.x) is echoed back.
  for (let round = 0; round < 3; round++) {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: toolDeclarations }],
      },
    });

    const functionCalls = response.functionCalls;
    if (!functionCalls || functionCalls.length === 0) {
      return (response.text ?? "").trim() || "No answer generated.";
    }

    const modelContent = response.candidates?.[0]?.content;
    if (modelContent) {
      contents.push(modelContent);
    } else {
      contents.push({
        role: "model",
        parts: functionCalls.map((fc) => ({
          functionCall: { name: fc.name, args: fc.args ?? {} },
        })),
      });
    }

    const responseParts = [];
    for (const fc of functionCalls) {
      const name = fc.name ?? "";
      const args = (fc.args ?? {}) as Record<string, unknown>;
      const result = await runTool(pool, name, args);
      responseParts.push({
        functionResponse: {
          name,
          response: { result },
        },
      });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  const final = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: { systemInstruction },
  });
  return (final.text ?? "").trim() || "No answer generated.";
}
