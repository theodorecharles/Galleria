/**
 * VideoShareModal Component
 * Modal for creating share links for individual videos
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { API_URL, SITE_URL } from '../../config';
import { trackShareLinkCreated } from '../../utils/analytics';
import CustomDropdown from './ConfigManager/components/CustomDropdown';
import './GenericModal.css';
import { error as logError } from '../../utils/logger';

interface VideoShareModalProps {
  album: string;
  filename: string;
  videoTitle: string;
  onClose: () => void;
}

const getExpirationOptions = (t: (key: string) => string) => [
  { minutes: 60, label: t('shareModal.oneHour') },
  { minutes: 1440, label: t('shareModal.oneDay') },
  { minutes: 10080, label: t('shareModal.oneWeek') },
  { minutes: 43200, label: t('shareModal.oneMonth') },
  { minutes: null, label: t('shareModal.never') },
  { minutes: -1, label: t('shareModal.custom') } // Special value for custom
];

export default function VideoShareModal({ album, filename, videoTitle, onClose }: VideoShareModalProps) {
  const { t } = useTranslation();
  const [selectedExpiration, setSelectedExpiration] = useState<number | null>(1440); // Default: 1 day
  const [loading, setLoading] = useState(true); // Start loading immediately
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [generatedLink, setGeneratedLink] = useState<string | null>(null);
  const [isCustom, setIsCustom] = useState(false);
  const [customMinutes, setCustomMinutes] = useState<string>('');

  const generateLink = async (expirationMinutes: number | null) => {
    setLoading(true);
    setError(null);
    setCopied(false);

    try {
      // Create share link for the album (no CSRF token needed - auth is checked via session)
      const response = await fetch(`${API_URL}/api/share-links/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          album,
          expirationMinutes,
        }),
      });

      if (!response.ok) {
        throw new Error(t('shareModal.failedToCreate'));
      }

      const data = await response.json();
      // Add video parameter to URL to show only this video
      const url = `${SITE_URL}/shared/${data.shareLink.secretKey}?video=${encodeURIComponent(filename)}`;
      setGeneratedLink(url);
      trackShareLinkCreated(album, expirationMinutes);
    } catch (err) {
      logError('Error generating video share link:', err);
      setError(err instanceof Error ? err.message : t('shareModal.failedToGenerate'));
    } finally {
      setLoading(false);
    }
  };

  // Generate link immediately on mount
  useEffect(() => {
    generateLink(selectedExpiration);
  }, []);

  // Regenerate link when expiration changes
  const handleExpirationChange = (newExpiration: number | null) => {
    if (newExpiration === -1) {
      // Custom expiration selected
      setIsCustom(true);
      setSelectedExpiration(parseInt(customMinutes) || 60);
    } else {
      setIsCustom(false);
      setSelectedExpiration(newExpiration);
      generateLink(newExpiration);
    }
  };

  const handleCustomSubmit = () => {
    const minutes = parseInt(customMinutes);
    if (isNaN(minutes) || minutes < 1) {
      setError(t('shareModal.invalidCustomTime'));
      return;
    }
    setIsCustom(false);
    setSelectedExpiration(minutes);
    generateLink(minutes);
  };

  const handleCopyClick = async () => {
    if (!generatedLink) return;

    try {
      await navigator.clipboard.writeText(generatedLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      logError('Failed to copy link:', err);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="generic-modal" onClick={(e) => e.stopPropagation()}>
        <div className="generic-modal-header">
          <h2>{t('videoShare.shareVideo')}</h2>
          <button className="close-button" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="generic-modal-content">
          <div className="video-share-info">
            <div className="video-share-title">{videoTitle}</div>
            <div className="video-share-album">{album}</div>
          </div>

          <p className="share-description">
            {t('videoShare.description')}
          </p>

          <div className="expiration-selector">
            <label htmlFor="expiration" style={{ display: 'block', marginBottom: '0.5rem' }}>
              {t('shareModal.linkExpiresIn')}:
            </label>
            <CustomDropdown
              value={isCustom ? '-1' : (selectedExpiration === null ? 'null' : String(selectedExpiration))}
              options={getExpirationOptions(t).map((option) => ({
                value: option.minutes === null ? 'null' : String(option.minutes),
                label: option.label,
                emoji: option.minutes === null ? '♾️' :
                       option.minutes === -1 ? '⚙️' :
                       option.minutes <= 60 ? '⏱️' :
                       option.minutes <= 1440 ? '⏰' :
                       option.minutes <= 10080 ? '📅' : '📆'
              }))}
              onChange={(value) => {
                const newExpiration = value === 'null' ? null : parseInt(value);
                handleExpirationChange(newExpiration);
              }}
              disabled={loading}
              portal
            />
          </div>

          {isCustom && (
            <div className="custom-expiration-input">
              <input
                type="number"
                min="1"
                value={customMinutes}
                onChange={(e) => setCustomMinutes(e.target.value)}
                placeholder={t('shareModal.enterMinutes')}
              />
              <button onClick={handleCustomSubmit}>
                {t('shareModal.generate')}
              </button>
            </div>
          )}

          {error && <div className="share-error">{error}</div>}
          {copied && <div className="share-success-inline">{t('shareModal.linkCopied')}</div>}

          <button
            className="copy-link-button"
            onClick={handleCopyClick}
            disabled={loading || !generatedLink}
          >
            {loading ? t('shareModal.generating') : t('shareModal.copyLink')}
          </button>
        </div>
      </div>
    </div>
  );
}


