import React from 'react';
import DeadlinesCard from '../components/DeadlinesCard.jsx';

export default function Deadlines() {
  return (
    <div>
      <div className="page-header">
        <h1>Registration Deadlines</h1>
        <p>Early-bird & final deadlines from midwest3on3.com — scraped, editable, and marked on every pace chart</p>
      </div>
      <DeadlinesCard />
    </div>
  );
}
