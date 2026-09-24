import type { CurriculumPosition, Segment } from '@/lib/api/types';

/**
 * Where the student is in the curriculum, in their own terms: the track, the
 * credit and the hour they are working through. Curriculum mode places students
 * on this path; when there is no position — legacy selection, or a student not
 * yet placed — the segment placement is shown instead, so the line is never
 * empty.
 *
 * The hour's project_label, when the SME set one, is shown beside it as a label.
 * It is not part of the position: "Hour 7 of 24" is what the student is told.
 */
export function PositionLine({ segment, className = '' }: { segment: Segment; className?: string }) {
  const p = segment.position;
  if (!p) {
    return (
      <p className={`text-sm text-text-secondary ${className}`}>
        {segment.segment ? (
          <>
            <span className="font-semibold text-text">{segment.segment.name}</span> · Level {segment.current_level}
          </>
        ) : (
          'Not placed yet'
        )}
      </p>
    );
  }
  return (
    <p className={`text-sm text-text-secondary ${className}`}>
      <span className="font-semibold text-text">{p.track}</span>
      {' · '}
      {p.credit.code} {p.credit.name}
      {' · '}
      Hour {p.hour.number} of {p.credit.total_hours}
      {p.hour.project_label ? ` · ${p.hour.project_label}` : ''}
    </p>
  );
}

/** The same position as a labelled block, for the progress panel. */
export function PositionDetail({ position }: { position: CurriculumPosition }) {
  const hourValue = [
    position.hour.title,
    `hour ${position.hour.number} of ${position.credit.total_hours}`,
    position.hour.project_label,
  ]
    .filter(Boolean)
    .join(' · ');
  const rows: Array<[string, string]> = [
    ['Track', position.track],
    ['Credit', `${position.credit.code} — ${position.credit.name}`],
    ['Hour', hourValue],
  ];
  return (
    <dl className="mt-4 grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="font-semibold text-text-secondary">{label}</dt>
          <dd className="text-text">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
