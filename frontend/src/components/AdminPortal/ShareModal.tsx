/**
 * ShareModal Component
 * Modal for creating and managing share links for unpublished albums
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { API_URL, SITE_URL } from '../../config';
import { trackShareLinkCreated } from '../../utils/analytics';
import CustomDropdown from './ConfigManager/components/CustomDropdown';
import './GenericModal.css';
import { error as logError } from '../../utils/logger';

interface ShareModalProps {
  album: string;
  onClose: () => void;
}

const getExpirationOptions = (t: (key: string) => string) => [
  { label: t('shareModal.expiration15Minutes'), minutes: 15 },
  { label: t('shareModal.expiration1Hour'), minutes: 60 },
  { label: t('shareModal.expiration12Hours'), minutes: 720 },
  { label: t('shareModal.expiration1Day'), minutes: 1440 },
  { label: t('shareModal.expiration1Week'), minutes: 10080 },
  { label: t('shareModal.expiration1Month'), minutes: 43200 },
  { label: t('shareModal.expirationForever'), minutes: null },
  { label: t('shareModal.expirationCustom'), minutes: -1 }, // Special value for custom
];

export default function ShareModal({ album, onClose }: ShareModalProps) {
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
      // Create share link (no CSRF token needed - auth is checked via session)
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
      const url = `${SITE_URL}/shared/${data.shareLink.secretKey}`;
      setGeneratedLink(url);
      trackShareLinkCreated(album, expirationMinutes);
    } catch (err) {
      logError('Error generating share link:', err);
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
      // Custom option selected
      setIsCustom(true);
      return;
    }
    setIsCustom(false);
    setCustomMinutes('');
    setSelectedExpiration(newExpiration);
    generateLink(newExpiration);
  };

  const handleCustomMinutesSubmit = () => {
    const minutes = parseInt(customMinutes);
    if (isNaN(minutes) || minutes <= 0) {
      setError(t('shareModal.invalidMinutes'));
      return;
    }
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
          <h2>{t('shareModal.shareAlbum', { album })}</h2>
          <button className="close-button" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="generic-modal-content">
          <p className="share-description">
            {t('shareModal.description')}
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
            <div className="custom-minutes-input">
              <label htmlFor="customMinutes">
                {t('shareModal.customMinutes')}: {selectedExpiration && !loading && `(${selectedExpiration} ${t('shareModal.min')})`}
              </label>
              <div className="custom-input-group">
                <input
                  type="number"
                  id="customMinutes"
                  value={customMinutes}
                  onChange={(e) => setCustomMinutes(e.target.value)}
                  placeholder={t('shareModal.enterMinutes')}
                  min="1"
                  autoFocus
                />
                <button
                  className="apply-custom-button"
                  onClick={handleCustomMinutesSubmit}
                  disabled={!customMinutes || loading}
                >
                  {t('shareModal.apply')}
                </button>
              </div>
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
