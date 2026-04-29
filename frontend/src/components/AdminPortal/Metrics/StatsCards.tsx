/**
 * Stats Cards Component
 * Displays summary statistics cards (Unique Visitors, Page Views, Total Time)
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Stats } from './types';
import { formatNumber, formatDuration } from '../../../utils/formatters';

interface StatsCardsProps {
  stats: Stats;
}

// formatNumber and formatDuration functions moved to utils/formatters.ts

const StatsCards: React.FC<StatsCardsProps> = ({ stats }) => {
  const { t } = useTranslation();

  return (
    <div className="metrics-summary">
      <div className="metric-card">
        <div className="metric-icon">👥</div>
        <div className="metric-content">
          <div className="metric-value">{formatNumber(stats.uniqueVisitors)}</div>
          <div className="metric-label">{t('metrics.uniqueVisitors')}</div>
        </div>
      </div>

      <div className="metric-card">
        <div className="metric-icon">📄</div>
        <div className="metric-content">
          <div className="metric-value">{formatNumber(stats.pageViews)}</div>
          <div className="metric-label">{t('metrics.pageViews')}</div>
        </div>
      </div>

      <div className="metric-card">
        <div className="metric-icon">⏱️</div>
        <div className="metric-content">
          <div className="metric-value">{formatDuration(stats.totalViewDuration || 0)}</div>
          <div className="metric-label">{t('metrics.totalTimeViewing')}</div>
        </div>
      </div>
    </div>
  );
};

export default StatsCards;

