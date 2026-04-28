/**
 * Album View Milestone Tracker
 * Tracks album view counts in database and sends notifications
 * when albums reach view milestones (100, 1000, 5000, etc.)
 */

import { sendNotificationToUser } from '../push-notifications.js';
import { translateNotification } from '../i18n-backend.js';
import { getAllUsers } from '../database-users.js';
import { getAllAlbumViewCounts, updateAlbumMilestone } from '../database.js';
import { error, info } from '../utils/logger.js';

// Milestones: 100, 1000, 5000, then every 5000 after that
const MILESTONES = [
  100, 1000, 5000, 10000, 15000, 20000, 25000, 30000, 35000, 40000, 
  45000, 50000, 55000, 60000, 65000, 70000, 75000, 80000, 85000, 90000, 
  95000, 100000, 150000, 200000, 250000, 300000, 400000, 500000, 1000000
];

/**
 * Check for new milestones and send notifications
 */
export async function checkMilestones(): Promise<void> {
  try {
    info('[MilestoneTracker] Checking for album view milestones...');

    const albumData = getAllAlbumViewCounts();
    let milestonesReached = 0;

    for (const [albumName, data] of albumData.entries()) {
      const currentViews = data.views;
      const lastMilestone = data.lastMilestone;

      // Find the highest milestone the album has crossed since lastMilestone.
      // Iterating in descending order and breaking on the first match ensures
      // we send a single notification (and perform a single DB write) per tick
      // even when an album's view count jumps past several thresholds at once.
      let highestNewMilestone: number | null = null;
      for (let i = MILESTONES.length - 1; i >= 0; i--) {
        const milestone = MILESTONES[i];
        if (currentViews >= milestone && lastMilestone < milestone) {
          highestNewMilestone = milestone;
          break;
        }
      }

      if (highestNewMilestone !== null) {
        const milestone = highestNewMilestone;
        // New milestone reached!
        info(`[MilestoneTracker] 🎉 ${albumName} reached ${milestone} views!`);

        // Send notification to all admins
        const admins = getAllUsers().filter(u => u.role === 'admin');

        for (const admin of admins) {
          const title = await translateNotification('notifications.backend.albumViewMilestoneTitle', {
            albumName,
            milestone: milestone.toLocaleString()
          });
          const body = await translateNotification('notifications.backend.albumViewMilestoneBody', {
            albumName,
            milestone: milestone.toLocaleString()
          });

          await sendNotificationToUser(admin.id, {
            title,
            body,
            tag: `milestone-${albumName}-${milestone}`,
            requireInteraction: true
          }, 'albumViewMilestone');
        }

        // Update milestone in database
        updateAlbumMilestone(albumName, milestone);
        milestonesReached++;
      }
    }

    if (milestonesReached > 0) {
      info(`[MilestoneTracker] ✅ ${milestonesReached} new milestone(s) reached`);
    } else {
      info('[MilestoneTracker] No new milestones reached');
    }
  } catch (err) {
    error('[MilestoneTracker] Error checking milestones:', err);
  }
}

/**
 * Start periodic milestone checking (every hour)
 */
export function startMilestoneTracking(): void {
  info('[MilestoneTracker] Starting periodic milestone tracking (every hour)');

  // Check immediately on startup
  checkMilestones().catch(err => {
    error('[MilestoneTracker] Initial milestone check failed:', err);
  });

  // Then check every hour
  setInterval(() => {
    checkMilestones().catch(err => {
      error('[MilestoneTracker] Milestone check failed:', err);
    });
  }, 60 * 60 * 1000); // Every hour
}
