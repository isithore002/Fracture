import { REALITIES, REALITY, bucketsMissedBy, rangeOf, type Reality } from '../lib/fracture';

type Props = {
  /** The VRF-derived bucket, 0..99. */
  bucket: number;
  prediction: Reality;
  outcome: Reality;
};

/**
 * Explains a settled round: which roll came up, where the player's band sat,
 * and which band actually won.
 *
 * This is transparency, not a retention device. It renders the real bucket the
 * contract derived and the real band boundaries — nothing is exaggerated to
 * make a loss read as closer than it was, and there is no "so close!" framing.
 * A miss by 30 looks like a miss by 30.
 *
 * It is also strictly after the fact: the roll is only ever shown once the
 * outcome and payout are already settled, so nothing here can influence a
 * result the player has not yet seen.
 */
export function RollReadout({ bucket, prediction, outcome }: Props) {
  const mine = rangeOf(prediction);
  const missedBy = bucketsMissedBy(bucket, prediction);
  const hit = missedBy === 0;

  return (
    <div className="roll">
      <div className="roll-head">
        <span className="roll-label">VRF roll</span>
        <span className="roll-value">{bucket}</span>
      </div>

      <div className="roll-track" role="img" aria-label={`Roll ${bucket} of 0 to 99`}>
        {REALITIES.map(id => {
          const { start, end } = rangeOf(id);
          const width = end - start + 1;
          return (
            <span
              key={id}
              className={`roll-band${id === prediction ? ' roll-band-mine' : ''}${
                id === outcome ? ' roll-band-won' : ''
              }`}
              style={{ left: `${start}%`, width: `${width}%` }}
              title={`${REALITY[id].name} ${start}–${end}`}
            />
          );
        })}

        {/* The marker sits at the centre of the rolled bucket's 1% slot. */}
        <span className="roll-marker" style={{ left: `${bucket + 0.5}%` }} />
      </div>

      <p className="roll-note">
        {hit ? (
          <>
            <strong>{REALITY[prediction].name}</strong> holds {mine.start}–{mine.end} — the roll
            landed inside it.
          </>
        ) : (
          <>
            <strong>{REALITY[prediction].name}</strong> holds {mine.start}–{mine.end}
            {' · '}
            {missedBy === 1 ? 'missed by 1 bucket' : `missed by ${missedBy} buckets`}
          </>
        )}
      </p>
    </div>
  );
}
