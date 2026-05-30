/**
 * Modal Controls Component
 * Renders the top control buttons: info, copy link, download, fullscreen, close
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Photo } from './types';
import { InfoIcon, CheckmarkIcon, LinkIcon, DownloadIcon, FullscreenIcon, CloseIcon } from '../icons/';

interface ModalControlsProps {
  show: boolean;
  showInfo: boolean;
  copiedLink: boolean;
  isFullscreen: boolean;
  onToggleInfo: () => void;
  onCopyLink: (photo: Photo) => void;
  onDownload: (photo: Photo) => void;
  onToggleFullscreen: () => void;
  onClose: () => void;
  selectedPhoto: Photo;
  isVideo?: boolean;
  downloadsEnabled?: boolean;
  style?: React.CSSProperties;
}

const ModalControls: React.FC<ModalControlsProps> = ({
  show,
  showInfo,
  copiedLink,
  isFullscreen,
  onToggleInfo,
  onCopyLink,
  onDownload,
  onToggleFullscreen,
  onClose,
  selectedPhoto,
  isVideo = false,
  downloadsEnabled = true,
  style,
}) => {
  const { t } = useTranslation();
  
  return (
    <div
      className="modal-controls-top"
      style={{ opacity: show ? 1 : 0, ...style }}
    >
      <div className="modal-controls-left">
        {/* Info button */}
        <button
          onClick={onToggleInfo}
          className={showInfo ? 'active' : ''}
          title={t('photo.photoInformation')}
        >
          <InfoIcon width="20" height="20" />
        </button>

        {/* Copy link button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onCopyLink(selectedPhoto);
          }}
          title={copiedLink ? t('photo.copied') : t('photo.copyLink')}
          className={copiedLink ? "copied" : ""}
        >
          {copiedLink ? (
            <CheckmarkIcon width="20" height="20" />
          ) : (
            <LinkIcon width="20" height="20" />
          )}
        </button>

        {/* Download button - hidden for videos and portfolios with downloads disabled */}
        {!isVideo && downloadsEnabled && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDownload(selectedPhoto);
            }}
            title={t('photo.downloadPhoto')}
          >
            <DownloadIcon width="20" height="20" />
          </button>
        )}
      </div>

      <div className="modal-controls-right">
        {/* Fullscreen button */}
        <button
          className="fullscreen-toggle"
          onClick={(e) => {
            e.stopPropagation();
            onToggleFullscreen();
          }}
          title={isFullscreen ? t('photo.exitFullscreen') : t('photo.fullscreen')}
        >
          <FullscreenIcon width="24" height="24" isExit={isFullscreen} />
        </button>

        {/* Close button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title={t('photo.close')}
        >
          <CloseIcon width="24" height="24" />
        </button>
      </div>
    </div>
  );
};

export default ModalControls;
