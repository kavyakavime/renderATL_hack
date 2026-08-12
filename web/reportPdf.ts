import PDFDocument from "pdfkit";
import type { ServerResponse } from "node:http";
import type pg from "pg";
import { generateReportCard } from "./chat.js";
import { getGhostBuses, getReliabilitySummary24h } from "./tools.js";

type RouteRow = {
  route_id: string;
  on_time_pct: number;
  avg_delay_sec: number;
  sample_count: number;
  ghost_count: number;
};

type Doc = InstanceType<typeof PDFDocument>;

async function loadWorstRoutesForPdf(pool: pg.Pool): Promise<RouteRow[]> {
  const [summary, ghosts] = await Promise.all([
    getReliabilitySummary24h(pool),
    getGhostBuses(pool),
  ]);

  const ghostByRoute = new Map<string, number>();
  for (const b of ghosts.buses ?? []) {
    const id = String(b.route_id ?? "");
    if (!id) continue;
    ghostByRoute.set(id, (ghostByRoute.get(id) ?? 0) + 1);
  }

  return summary.slice(0, 10).map((r) => ({
    route_id: String(r.route_id),
    on_time_pct: Number(r.on_time_pct) || 0,
    avg_delay_sec: Number(r.avg_delay_sec) || 0,
    sample_count: Number(r.sample_count) || 0,
    ghost_count: ghostByRoute.get(String(r.route_id)) ?? 0,
  }));
}

function drawBarChart(
  doc: Doc,
  routes: RouteRow[],
  x: number,
  y: number,
  width: number,
  height: number
): number {
  doc.fontSize(12).fillColor("#1a1205").text("Worst 10 routes — on-time %", x, y);
  y += 22;

  if (routes.length === 0) {
    doc.fontSize(10).fillColor("#666").text("No reliability data yet.", x, y);
    return y + 20;
  }

  const labelW = 36;
  const pctW = 42;
  const barMax = width - labelW - pctW - 12;
  const rowH = Math.min(22, Math.floor(height / Math.max(routes.length, 1)));

  for (const r of routes) {
    const pct = Math.max(0, Math.min(100, r.on_time_pct));
    const barW = (pct / 100) * barMax;

    doc.fontSize(9).fillColor("#333").text(r.route_id, x, y + 4, {
      width: labelW,
      align: "left",
    });

    doc.rect(x + labelW, y + 3, barMax, 12).fill("#e8eef4");
    const fill = pct < 50 ? "#e86b6b" : pct < 80 ? "#f5a623" : "#3dd68c";
    doc.rect(x + labelW, y + 3, barW, 12).fill(fill);

    doc
      .fillColor("#333")
      .text(`${pct.toFixed(1)}%`, x + labelW + barMax + 6, y + 4, {
        width: pctW,
      });

    y += rowH;
  }

  return y + 8;
}

function drawTable(
  doc: Doc,
  routes: RouteRow[],
  x: number,
  y: number,
  width: number
): number {
  doc.fontSize(12).fillColor("#1a1205").text("Route detail", x, y);
  y += 18;

  const cols = [{ w: 50 }, { w: 80 }, { w: 100 }, { w: 70 }];
  const headers = ["Route", "On-time %", "Avg delay", "Ghost buses"];

  doc.fontSize(9).fillColor("#555");
  let cx = x;
  headers.forEach((h, i) => {
    doc.text(h, cx, y, { width: cols[i].w });
    cx += cols[i].w;
  });
  y += 14;
  doc
    .moveTo(x, y)
    .lineTo(x + width, y)
    .strokeColor("#ccc")
    .stroke();
  y += 6;

  doc.fillColor("#222");
  for (const r of routes) {
    if (y > 720) break;
    const delayMin = (r.avg_delay_sec / 60).toFixed(1);
    const vals = [
      r.route_id,
      `${r.on_time_pct.toFixed(1)}%`,
      `${delayMin} min`,
      String(r.ghost_count),
    ];
    cx = x;
    vals.forEach((v, i) => {
      doc.text(v, cx, y, { width: cols[i].w });
      cx += cols[i].w;
    });
    y += 14;
  }

  return y;
}

/** Build and stream a PDF report to an Express/Node response. */
export async function streamReportPdf(
  pool: pg.Pool,
  res: ServerResponse
): Promise<void> {
  const [{ report, generated_at }, routes] = await Promise.all([
    generateReportCard(pool),
    loadWorstRoutesForPdf(pool),
  ]);

  const dateStamp = generated_at.slice(0, 10);
  const filename = `marta-report-${dateStamp}.pdf`;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`
  );

  const doc = new PDFDocument({
    margin: 48,
    size: "LETTER",
    info: {
      Title: "MARTA Reliability Report Card",
      Author: "MARTA Receipts",
      CreationDate: new Date(generated_at),
    },
  });

  doc.pipe(res);

  doc
    .fontSize(20)
    .fillColor("#1a1205")
    .text("MARTA Reliability Report Card");
  doc
    .fontSize(10)
    .fillColor("#666")
    .text(`Generated ${new Date(generated_at).toLocaleString()}`);
  doc.moveDown(1);

  doc
    .moveTo(48, doc.y)
    .lineTo(564, doc.y)
    .strokeColor("#f5a623")
    .lineWidth(2)
    .stroke();
  doc.moveDown(0.8);

  doc.fontSize(12).fillColor("#1a1205").text("Summary");
  doc.moveDown(0.4);
  doc.fontSize(11).fillColor("#333").text(report, {
    align: "left",
    lineGap: 3,
  });
  doc.moveDown(1.2);

  let y = doc.y;
  y = drawBarChart(doc, routes, 48, y, 516, 260);
  doc.y = y + 8;
  drawTable(doc, routes, 48, doc.y, 516);

  doc
    .fontSize(8)
    .fillColor("#999")
    .text("MARTA Receipts · GTFS-RT → Timescale → Gemini", 48, 740, {
      align: "left",
    });

  doc.end();
}
