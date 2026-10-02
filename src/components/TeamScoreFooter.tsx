'use client';

import type { Metric, TeamDay } from '@/lib/team-score/types';
import { fmtNum, hoverOff, hoverOn, linkBtn, small, type Who } from './TeamScoreShared';

export default function TeamScoreFooter({ team, tips, openDrawer }: {
  team: TeamDay; tips: { ev: string; health: string; points: string }; openDrawer: (who: Who, metric: Metric) => void;
}) {
  return (
            <div style={{ ...small, fontSize: '0.75rem', marginTop: '0.75rem', display: 'grid', gap: 2 }}>
              <div>
                Thank-yous after AI answers:{' '}
                {team.thanks_after_ai > 0
                  ? <button type="button" style={{ ...linkBtn, color: 'var(--primary)', fontWeight: 600 }} onMouseEnter={hoverOn} onMouseLeave={hoverOff}
                      onClick={() => openDrawer({ key: 'ai', name: 'AI' }, 'thanks')}>{fmtNum(team.thanks_after_ai)}</button>
                  : fmtNum(team.thanks_after_ai || 0)}
              </div>
              <div>
                Customers who waited 2 office hours with nobody holding the chat:{' '}
                {team.pool_waited_2h === null ? <span title={tips.ev}>—</span> : fmtNum(team.pool_waited_2h)}
              </div>
              <div>
                Waiting on someone not in that day:{' '}
                {team.absent_waits === null ? <span title={tips.ev}>—</span> : fmtNum(team.absent_waits)}
              </div>
              {Array.isArray(team.unattributed) && team.unattributed.length > 0 && (
                <div style={{ overflowWrap: 'anywhere' }}>
                  Replies by old logins that are not a current member: {team.unattributed.map((u) => `${u.login} ${u.replies}`).join(', ')}
                </div>
              )}
            </div>
  );
}
