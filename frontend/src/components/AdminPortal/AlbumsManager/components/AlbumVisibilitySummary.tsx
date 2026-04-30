import React from 'react';
import { API_URL } from '../../../../config';
import { Album, AlbumFolder } from '../types';

interface ShareLinkCounts {
  active: number;
  expired: number;
}

interface AlbumVisibilitySummaryProps {
  album: Album;
  folders: AlbumFolder[];
  canManageShareLinks: boolean;
  variant?: 'card' | 'header';
}

const getShareLinkText = (counts: ShareLinkCounts | null): string | null => {
  if (!counts) return null;

  const parts = [];
  if (counts.active > 0) {
    parts.push(`${counts.active} active`);
  }
  if (counts.expired > 0) {
    parts.push(`${counts.expired} expired`);
  }

  return parts.length > 0 ? `${parts.join(', ')} link${counts.active + counts.expired === 1 ? '' : 's'}` : null;
};

const AlbumVisibilitySummary: React.FC<AlbumVisibilitySummaryProps> = ({
  album,
  folders,
  canManageShareLinks,
  variant = 'card',
}) => {
  const [shareLinkCounts, setShareLinkCounts] = React.useState<ShareLinkCounts | null>(null);
  const isPublished = album.published !== false;
  const showOnHomepage = album.show_on_homepage !== false;
  const folder = album.folder_id != null ? folders.find(f => f.id === album.folder_id) : undefined;
  const isFolderControlled = album.folder_id != null;

  React.useEffect(() => {
    let cancelled = false;

    if (isPublished || !canManageShareLinks) {
      setShareLinkCounts(null);
      return;
    }

    fetch(`${API_URL}/api/share-links/album/${encodeURIComponent(album.name)}`, {
      credentials: 'include',
    })
      .then(response => {
        if (!response.ok) {
          throw new Error('Unable to load share links');
        }
        return response.json();
      })
      .then(data => {
        if (cancelled) return;
        const links = Array.isArray(data.shareLinks) ? data.shareLinks : [];
        setShareLinkCounts({
          active: links.filter((link: { expired?: boolean }) => !link.expired).length,
          expired: links.filter((link: { expired?: boolean }) => link.expired).length,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setShareLinkCounts(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [album.name, canManageShareLinks, isPublished]);

  const shareLinkText = getShareLinkText(shareLinkCounts);
  const hasPrivateLink = Boolean(shareLinkCounts && shareLinkCounts.active > 0);
  const folderName = folder?.name ? `"${folder.name}"` : 'the folder';
  const summaryText = isFolderControlled
    ? `Inherited from ${folderName}. Change visibility on the folder.`
    : isPublished
      ? showOnHomepage
        ? 'Public gallery and homepage'
        : 'Public gallery, hidden from homepage'
      : hasPrivateLink
        ? 'Unpublished; accessible through active private links.'
        : 'Unpublished draft; use Share to create a private link.';

  return (
    <div className={`album-visibility-summary album-visibility-summary-${variant}`}>
      <div className="album-visibility-chips" aria-label="Album visibility">
        {isFolderControlled && (
          <span className="album-visibility-chip album-visibility-chip-folder">Folder-controlled</span>
        )}
        {isPublished ? (
          <>
            <span className="album-visibility-chip album-visibility-chip-public">Public gallery</span>
            {showOnHomepage && (
              <span className="album-visibility-chip album-visibility-chip-homepage">Homepage</span>
            )}
          </>
        ) : hasPrivateLink ? (
          <span className="album-visibility-chip album-visibility-chip-private">Private link</span>
        ) : (
          <span className="album-visibility-chip album-visibility-chip-draft">Draft</span>
        )}
      </div>
      <div className="album-visibility-text">
        <span>{summaryText}</span>
        {!isPublished && shareLinkText && (
          <span className="album-visibility-link-count">{shareLinkText}</span>
        )}
      </div>
    </div>
  );
};

export default AlbumVisibilitySummary;
