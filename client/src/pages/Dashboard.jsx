import React from 'react';
import { isDemoMode } from '../demoMask.js';
import useSmartUpdate from '../hooks/useSmartUpdate.js';
import SmartUpdateBar from '../components/SmartUpdateBar.jsx';
import SmartUpdateLog from '../components/SmartUpdateLog.jsx';
import Collapsible from '../components/Collapsible.jsx';
import LeagueYoyCompare from '../components/LeagueYoyCompare.jsx';
import DailyActivityPanel from '../components/DailyActivityPanel.jsx';

export default function Dashboard({ ctx }) {
  const { orgId, recentRegs, refreshToken, onAggComplete } = ctx;

  const smartUpdate = useSmartUpdate({
    orgId, recentRegs,
    onComplete: async (d) => { if (onAggComplete) await onAggComplete(d); },
  });

  return (
    <div>
      <div className="page-header">
        <h1>Dashboard</h1>
        <p>{isDemoMode() ? 'Demo organization' : 'Midwest 3 on 3'} · quick glance at recent activity</p>
      </div>

      {/* ── Quick glance: Smart Update + Daily Activity (same as Reports) ─── */}
      <SmartUpdateBar {...smartUpdate} />

      <DailyActivityPanel recentRegs={recentRegs} refreshToken={refreshToken} />

      <LeagueYoyCompare recentRegs={recentRegs} />

      {/* ── Advanced / console — collapsed by default ─────────────────────── */}
      <Collapsible
        title="⚙ Smart Update Console"
        subtitle="Live log from the Smart Update run above — for troubleshooting, not needed day-to-day."
        badge={smartUpdate.running ? 'running' : null}
      >
        <SmartUpdateLog log={smartUpdate.log} />
      </Collapsible>
    </div>
  );
}
