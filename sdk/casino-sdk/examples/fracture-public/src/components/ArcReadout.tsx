import { REALITY, type Reality } from '../lib/fracture';
import { ANCHOR, ANCHORS, arcPositions, multiplierAt, type Position } from '../lib/fractureRun';

type StepRecord = {
  step: number;
  anchor: Position;
  arcStart: Position;
  arcLength: number;
  law: Reality;
  struck: boolean;
  call: Reality | null;
};

type Props = {
  log: StepRecord[];
};

/**
 * The run, step by step: where the anchor stood, which law swept through, which
 * positions it took, and what the multiplier was worth at each rung.
 *
 * Every row states its own step in words. Pips alone are not a record — a
 * player looking at five rows of dots at the end of a run cannot tell what
 * happened in any of them, which makes the whole ladder feel like it resolved
 * for reasons they never saw. The dots show the geometry; the sentence says
 * what it meant.
 *
 * This is transparency, not a retention device. Every row renders the real arc
 * the contract derived from that step's own VRF word. Nothing is massaged to
 * make a loss read as closer than it was — there is no "so close!" framing and
 * no near-miss is ever invented. Standing one position away from the arc looks
 * exactly like standing five away, because it was exactly as survivable.
 *
 * It is also strictly after the fact: it is only rendered once the run has
 * ended, so nothing here can leak a step the player has not yet taken.
 */
export function ArcReadout({ log }: Props) {
  const survived = log.filter(record => !record.struck).length;
  // The run's real depth is the last step's own number. It can exceed the row
  // count: if a host push is missed the client only ever sees the later state,
  // and the steps in between resolved on chain without a row here. Counting
  // rows would quietly under-report how far the run actually went.
  const depth = log.length > 0 ? log[log.length - 1].step : 0;
  const missing = depth > log.length;
  const called = log.filter(r => r.call !== null);
  const right = called.filter(r => r.call === r.law).length;

  return (
    <div className="arclog">
      <div className="arclog-head">
        <span className="arclog-label">The run</span>
        <span className="arclog-legend" aria-hidden="true">
          <span className="arclog-pip gone" /> destroyed
          <span className="arclog-pip mine" /> you
        </span>
        <span className="arclog-value">
          {survived} of {depth} survived
          {called.length > 0 && (
            <span className="arclog-calls">
              {' '}
              · called {right}/{called.length}
            </span>
          )}
        </span>
      </div>

      <ol className="arclog-list">
        {log.map(record => {
          const hit = arcPositions(record.arcStart, record.arcLength);
          const took = hit.map(p => ANCHOR[p].name).join(' + ');
          return (
            <li
              key={record.step}
              className={`arclog-row${record.struck ? ' struck' : ''}`}
              data-law={REALITY[record.law].key}
            >
              <span className="arclog-step">{record.step}</span>

              <span
                className="arclog-ring"
                role="img"
                aria-label={
                  `${REALITY[record.law].name} took ${took}; ` +
                  `anchor at ${ANCHOR[record.anchor].name}`
                }
              >
                {ANCHORS.map(id => (
                  <span
                    key={id}
                    className={
                      `arclog-pip` +
                      (hit.includes(id) ? ' gone' : '') +
                      (id === record.anchor ? ' mine' : '')
                    }
                  />
                ))}
              </span>

              {/* What that step actually did, in the same words the live
                  readout uses, so the record and the moment match. */}
              <span className="arclog-said">
                <span className="arclog-law">{REALITY[record.law].name}</span> took {took} —{' '}
                {record.struck ? (
                  <span className="arclog-hit">you were at {ANCHOR[record.anchor].name}</span>
                ) : (
                  <span className="arclog-safe">you held {ANCHOR[record.anchor].name}</span>
                )}
              </span>

              {record.call !== null && (
                <span
                  className={`arclog-call${record.call === record.law ? ' right' : ''}`}
                  title={`You called ${REALITY[record.call].name}`}
                >
                  {record.call === record.law ? '✓' : '✕'}
                </span>
              )}

              <span className="arclog-mult">
                {record.struck ? '—' : `${multiplierAt(record.step).toFixed(2)}×`}
              </span>
            </li>
          );
        })}
      </ol>

      <p className="arclog-note">
        Each step drew its own VRF word <em>after</em> the anchor was committed. Every position
        carried the same odds.
        {missing && (
          <>
            {' '}
            Some steps of this run are not listed above — their results arrived together and
            only the latest was recorded. They settled on chain exactly as the ones shown did.
          </>
        )}
      </p>
    </div>
  );
}
