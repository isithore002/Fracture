import { useEffect, useState } from 'react';
import {
  connectGameToHost,
  observeGameContentSize,
  type GuestApiV1,
  type HostApiV1,
  type HostSnapshotV1,
} from '@chain/casino-sdk/guest';

import { createDemoHost } from './demoHost';

/** How long to wait for the host handshake before falling back to demo mode. */
const HANDSHAKE_TIMEOUT_MS = 1200;

export type CasinoHost = {
  hostApi: HostApiV1 | null;
  snapshot: HostSnapshotV1 | null;
  /** True when no host answered and the local demo host is driving the game. */
  demo: boolean;
};

/**
 * Guest side of the casino bridge, with a standalone fallback.
 *
 * Inside chain.wtf (or the local simulator) this connects over Penpal and the
 * host signs everything. Opened directly, the handshake never resolves — so
 * rather than a dead "waiting for host" screen, we mount the local demo host.
 * Both paths expose the identical `HostApiV1` + `HostSnapshotV1` surface, so
 * the rest of the app has one code path and no `if (demo)` branches.
 *
 * This is a single build that detects its environment, not two builds.
 */
export function useCasinoHost(): CasinoHost {
  const [hostApi, setHostApi] = useState<HostApiV1 | null>(null);
  const [snapshot, setSnapshot] = useState<HostSnapshotV1 | null>(null);
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    let mounted = true;
    let settled = false;
    let unsubscribeDemo: (() => void) | undefined;

    const guestMethods: GuestApiV1 = {
      async setState(nextSnapshot) {
        if (!mounted) return;
        setSnapshot(nextSnapshot);
      },
    };

    const connection = connectGameToHost(guestMethods);

    const startDemo = () => {
      if (!mounted || settled) return;
      settled = true;
      const { hostApi: demoApi, subscribe } = createDemoHost();
      setDemo(true);
      setHostApi(demoApi);
      unsubscribeDemo = subscribe(next => {
        if (mounted) setSnapshot(next);
      });
    };

    // If we are not framed there is no host to talk to — don't even wait.
    const framed = typeof window !== 'undefined' && window.parent !== window;
    const timer = window.setTimeout(startDemo, framed ? HANDSHAKE_TIMEOUT_MS : 0);

    void connection.promise
      .then(parent => {
        if (!mounted || settled) return;
        settled = true;
        window.clearTimeout(timer);
        setHostApi(parent);
      })
      .catch(() => {
        startDemo();
      });

    return () => {
      mounted = false;
      window.clearTimeout(timer);
      unsubscribeDemo?.();
      connection.destroy();
    };
  }, []);

  useEffect(() => {
    if (!hostApi || demo) return;
    const observer = observeGameContentSize(hostApi);
    return () => observer.disconnect();
  }, [hostApi, demo]);

  return { hostApi, snapshot, demo };
}
