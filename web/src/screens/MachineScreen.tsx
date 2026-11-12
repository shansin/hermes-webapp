/**
 * Machine: the operations side of Hermes, on one screen.
 *
 * Everything here acts on the machine the agent runs on rather than on this
 * app — the backend and its version, the messaging gateway and each chat
 * platform's health, who may DM the bots, housekeeping, and the host. Until it
 * existed that was a terminal, plus two rows and three buttons wedged under
 * Settings, which is this app's own preferences and now links here instead.
 *
 * Order is by how often each is the reason for opening the screen: is it up,
 * are the bots answering, is somebody waiting to pair, then the chores and
 * the dials.
 *
 * `#pairing` is the anchor a pairing push lands on (`server/src/push/
 * pairing.ts`). The section renders before its data has arrived, so the
 * scroll happens on arrival and again whenever the hash changes — a push tap
 * routes in place with `navigate()`, which keeps this screen mounted.
 */
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { MenuButton } from '../components/shared/MenuButton';
import { BackButton } from '../components/shared/BackButton';
import { PullToRefresh } from '../components/shared/PullToRefresh';
import { BackendSection } from '../components/machine/BackendSection';
import { PlatformsSection } from '../components/machine/PlatformsSection';
import { PairingSection } from '../components/machine/PairingSection';
import { MaintenanceSection } from '../components/machine/MaintenanceSection';
import { SystemSection } from '../components/machine/SystemSection';

export default function MachineScreen() {
  const qc = useQueryClient();
  const { hash } = useLocation();

  useEffect(() => {
    if (!hash) return;
    const id = decodeURIComponent(hash.slice(1));
    // After the sections above have laid out, so the target is where it ends up.
    const t = setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }), 120);
    return () => clearTimeout(t);
  }, [hash]);

  return (
    <div className="screen">
      <div className="header">
        <MenuButton />
        <BackButton />
        <div className="header__title">Machine</div>
      </div>
      <PullToRefresh
        onRefresh={() =>
          Promise.all([
            qc.invalidateQueries({ queryKey: ['machine'] }),
            qc.invalidateQueries({ queryKey: ['healthz'] }),
          ])
        }
      >
        <div style={{ padding: 12 }}>
          <BackendSection />
          <PlatformsSection />
          <PairingSection />
          <MaintenanceSection />
          <SystemSection />
        </div>
      </PullToRefresh>
    </div>
  );
}
