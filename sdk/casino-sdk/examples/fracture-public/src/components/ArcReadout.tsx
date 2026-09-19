import { REALITY, type Reality } from '../lib/fracture';
import { ANCHOR, ANCHORS, arcPositions, multiplierAt, type Position } from '../lib/fractureRun';

type StepRecord = {
  step: number;
  anchor: Position;
  arcStart: Position;
  arcLength: number;
  law: Reality;
  struck: boolean;
};

type Props = {
  log: StepRecord[];
};

/**
 * The run, step by step: where the anchor stood, which law swept through, which
 * positions it took, and what the multiplier was worth at each rung.
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
  return (
    <div className="arclog">
      <div className="arclog-head">
        <span className="arclog-label">The run</span>
        <span className="arclog-value">
          {log.length} {log.length === 1 ? 'step' : 'steps'}
        </span>
      </div>

      <ol className="arclog-list">
        {log.map(record => {
          const hit = arcPositions(record.arcStart, record.arcLength);
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
                  `${REALITY[record.law].name} took ` +
                  hit.map(p => ANCHOR[p].name).join(', ') +
                  `; anchor at ${ANCHOR[record.anchor].name}`
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

              <span className="arclog-law">{REALITY[record.law].name}</span>
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
      </p>
    </div>
  );
}
