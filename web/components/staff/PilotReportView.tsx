import type { PilotReport, ReportSection } from '@/lib/api/types';
import { Card, Muted } from '@/components/ui';

/**
 * The weekly pilot report, on screen.
 *
 * It renders the report's SHAPE rather than a fixed list of metrics: the server
 * sends each section's title, the question it answers, how to read it, its column
 * headings and rows already formatted for reading. So this component has no
 * opinion about what a "stall" is, the emailed document shows exactly the same
 * words, and a new section added to src/pilotReport.ts appears here with no
 * change to the web tier.
 *
 * Values are pre-formatted strings ("62%", "18 min"). A null means "nothing to
 * show", drawn as an en dash, never as 0 — a rate nobody has data for is not zero.
 */
function Table({ section }: { section: ReportSection }) {
  if (section.rows.length === 0) return <Muted className="mt-3">{section.empty}</Muted>;

  return (
    // Tables do not fold gracefully, so on a phone this scrolls sideways INSIDE
    // its own box rather than stretching the page. tabIndex makes the scroll
    // container reachable by keyboard, which axe requires of scrollable regions.
    <div className="mt-4 overflow-x-auto" tabIndex={0} role="region" aria-labelledby={`sec-${section.key}`}>
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{section.title}</caption>
        <thead>
          <tr>
            {section.columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`border-b border-border bg-surface-muted px-3 py-2 font-semibold ${
                  c.numeric ? 'text-right' : 'text-left'
                }`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {section.rows.map((row, i) => (
            <tr key={i}>
              {section.columns.map((c) => {
                const v = row[c.key];
                return (
                  <td
                    key={c.key}
                    className={`border-b border-border px-3 py-2 align-top ${
                      c.numeric ? 'whitespace-nowrap text-right' : 'text-left'
                    }`}
                  >
                    {v == null || v === '' ? '–' : v}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PilotReportView({ report, downloadHref }: { report: PilotReport; downloadHref: string }) {
  return (
    <>
      <div className="mb-4">
        <h1 className="text-xl font-bold">Pilot report</h1>
        <Muted className="mt-1">
          {report.window.from} to {report.window.to} ({report.window.weeks} week
          {report.window.weeks === 1 ? '' : 's'}), times in {report.timezone}.
        </Muted>
      </div>

      <Card className="mb-6 p-5">
        <h2 className="text-lg font-bold">What needs attention</h2>
        {report.headline.length === 0 ? (
          <Muted className="mt-2">
            Nothing needs attention this week. Every check below came back within its expected range, or had too little
            data to judge — “How to read this” at the bottom says which.
          </Muted>
        ) : (
          <ul className="mt-2 list-disc space-y-2 pl-5 text-sm">
            {report.headline.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ul>
        )}
        <p className="mt-4 text-sm">
          <a className="font-semibold text-link hover:underline" href={downloadHref} download>
            Download this report to email
          </a>{' '}
          <span className="text-text-secondary">— one file, opens in any browser, nothing else needed to read it.</span>
        </p>
      </Card>

      {report.sections.map((section) => (
        <Card key={section.key} className="mb-6 p-5">
          <h2 id={`sec-${section.key}`} className="text-lg font-bold">
            {section.title}
          </h2>
          <Muted className="mt-1 italic">{section.question}</Muted>
          <p className="mt-3 text-sm">{section.explainer}</p>
          <Table section={section} />
        </Card>
      ))}

      <Card className="p-5">
        <h2 className="text-lg font-bold">How to read this</h2>
        <ul className="mt-2 list-disc space-y-2 pl-5 text-sm">
          {report.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      </Card>
    </>
  );
}
