import {
  GoogleGenAI,
  Type,
  type FunctionDeclaration,
} from "@google/genai";
import type pg from "pg";
import {
  getGhostBuses,
  getHeadwayGaps,
  getReliabilitySummary24h,
  getRouteReliability,
  getWorstRoutesToday,
} from "./tools.js";

// gemini-2.5-flash is blocked for new API keys; 3.5 is the current flash tier.
const MODEL = "gemini-3.5-flash";

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
      "List possible ghost buses: vehicles with recent GPS but no matching stop-time delay updates.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
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
          description: "MARTA route_id (e.g. '1', '110', '20').",
        },
      },
      required: ["route_id"],
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
      return getGhostBuses(pool);
    case "getWorstRoutesToday":
      return getWorstRoutesToday(pool);
    case "getHeadwayGaps":
      return getHeadwayGaps(
        pool,
        String(args.route_id ?? args.route ?? "")
      );
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
    "You are MARTA Receipts, an assistant for Atlanta MARTA bus/rail reliability.",
    "Use the provided tools to answer with real data from TimescaleDB.",
    "Be concise. Cite route ids, on-time %, and delays when available.",
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

/** Plain-English reliability report card from last-24h aggregates + ghosts. */
export async function generateReportCard(pool: pg.Pool): Promise<{
  report: string;
  generated_at: string;
}> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required");
  }

  const [summary, ghosts, worst] = await Promise.all([
    getReliabilitySummary24h(pool),
    getGhostBuses(pool),
    getWorstRoutesToday(pool),
  ]);

  const best = [...summary].sort(
    (a, b) => Number(b.on_time_pct) - Number(a.on_time_pct)
  )[0];
  const worstRoute = summary[0];
  let headwayNote: unknown = null;
  if (worstRoute?.route_id) {
    headwayNote = await getHeadwayGaps(pool, String(worstRoute.route_id));
  }

  const ai = new GoogleGenAI({ apiKey });
  const prompt = [
    "Write a short plain-English MARTA Reliability Report Card in 3-5 sentences.",
    "Name the best and worst routes by on-time %, comment on overall system health,",
    "and mention any notable ghost buses or service gaps if present.",
    "Do not use markdown headings or bullet lists — just short paragraphs.",
    "",
    "DATA:",
    JSON.stringify({
      routes_24h: summary.slice(0, 25),
      best_route: best ?? null,
      worst_route: worstRoute ?? null,
      worst_today: worst,
      ghost_buses: { count: ghosts.count, sample: ghosts.buses.slice(0, 8) },
      headway_gaps_worst_route: headwayNote,
    }),
  ].join("\n");

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
  });

  const report =
    (response.text ?? "").trim() ||
    "Not enough reliability data yet to write a report card.";

  return {
    report,
    generated_at: new Date().toISOString(),
  };
}
