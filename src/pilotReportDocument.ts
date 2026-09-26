/**
 * The emailable form of the weekly pilot report.
 *
 * One self-contained HTML file: no stylesheet, no script, no image, no font
 * request. That is the point — it has to survive being attached to an email,
 * saved to a laptop, opened on a phone with no network, and printed to PDF for a
 * meeting. Anything external turns into a broken document in one of those places.
 *
 * It renders the SAME PilotReport object the staff page renders, so the document
 * that gets emailed cannot say something different from the screen it was
 * generated from. All prose lives in pilotReport.ts; this file is layout only.
 */
import type { PilotReport, ReportSection, ReportValue } from './pilotReport.js';

/** HTML-escape. Every value below goes through this — titles are author input. */
function esc(v: ReportValue): string {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "26 September 2026" — a date a non-technical reader recognises at a glance. */
function longDate(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto; padding: 32px 24px 64px; max-width: 900px;
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #15181d; background: #fff;
  }
  h1 { font-size: 26px; margin: 0 0 4px; }
  h2 { font-size: 19px; margin: 40px 0 2px; padding-top: 16px; border-top: 2px solid #e6e8ec; }
  .sub { color: #5b6170; margin: 0 0 24px; }
  .question { color: #5b6170; font-style: italic; margin: 6px 0 10px; }
  .explainer { margin: 0 0 16px; }
  .attention { background: #fff8e6; border: 1px solid #f0d9a0; border-radius: 8px; padding: 16px 20px; margin: 24px 0; }
  .attention h2 { border: 0; margin: 0 0 8px; padding: 0; font-size: 19px; }
  .attention ul { margin: 0; padding-left: 22px; }
  .attention li { margin: 6px 0; }
  .calm { background: #eef7ef; border: 1px solid #bcdcc0; border-radius: 8px; padding: 16px 20px; margin: 24px 0; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 8px; font-size: 15px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e6e8ec; vertical-align: top; }
  th { background: #f5f6f8; font-weight: 600; }
  td.n, th.n { text-align: right; white-space: nowrap; }
  .none { color: #5b6170; margin: 0 0 8px; }
  .notes { margin-top: 48px; padding-top: 16px; border-top: 2px solid #e6e8ec; color: #5b6170; font-size: 14px; }
  .notes ul { padding-left: 22px; }
  @media print {
    body { padding: 0; max-width: none; font-size: 12pt; }
    h2 { page-break-after: avoid; }
    table { page-break-inside: avoid; }
  }
`;

function renderTable(section: ReportSection): string {
  if (section.rows.length === 0) return `<p class="none">${esc(section.empty)}</p>`;
  const head = section.columns.map((c) => `<th${c.numeric ? ' class="n"' : ''}>${esc(c.label)}</th>`).join('');
  const body = section.rows
    .map((row) => {
      const cells = section.columns
        .map((c) => {
          const v = row[c.key];
          return `<td${c.numeric ? ' class="n"' : ''}>${v == null || v === '' ? '—' : esc(v)}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('\n      ');
  return `<table>\n    <thead><tr>${head}</tr></thead>\n    <tbody>\n      ${body}\n    </tbody>\n  </table>`;
}

function renderSection(section: ReportSection): string {
  return [
    `  <h2>${esc(section.title)}</h2>`,
    `  <p class="question">${esc(section.question)}</p>`,
    `  <p class="explainer">${esc(section.explainer)}</p>`,
    `  ${renderTable(section)}`,
  ].join('\n');
}

/** pilot-report-2026-09-26.html — sortable, and obvious in an inbox. */
export function pilotReportFilename(report: PilotReport): string {
  return `pilot-report-${report.window.to}.html`;
}

export function renderPilotReportHtml(report: PilotReport): string {
  const attention = report.headline.length
    ? `  <div class="attention">
    <h2>What needs attention</h2>
    <ul>
      ${report.headline.map((h) => `<li>${esc(h)}</li>`).join('\n      ')}
    </ul>
  </div>`
    : `  <div class="calm">
    <strong>Nothing needs attention this week.</strong> Every check below came back within its
    expected range, or had too little data to judge — the notes at the end say which.
  </div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pilot report — ${esc(longDate(report.window.to))}</title>
  <style>${STYLE}</style>
</head>
<body>
  <h1>Mission Hub — pilot report</h1>
  <p class="sub">
    ${esc(longDate(report.window.from))} to ${esc(longDate(report.window.to))}
    (${report.window.weeks} week${report.window.weeks === 1 ? '' : 's'}), times in ${esc(report.timezone)}.
    Generated ${esc(longDate(report.generated_at))}.
  </p>
${attention}
${report.sections.map(renderSection).join('\n')}
  <div class="notes">
    <h2 style="border:0;padding:0;margin:0 0 8px;font-size:17px;">How to read this</h2>
    <ul>
      ${report.notes.map((n) => `<li>${esc(n)}</li>`).join('\n      ')}
    </ul>
  </div>
</body>
</html>
`;
}
