import React from 'react';
import TrackingCard from '../components/TrackingCard.jsx';

export default function TrackingSignal() {
  return (
    <div>
      <div className="page-header">
        <h1>Tracking & Meta Signal</h1>
        <p>This organization's pixel, Conversions API and SportsEngine registration webhooks — every delivery inspected below</p>
      </div>
      <TrackingCard />
    </div>
  );
}
