/**
 * Modal Navigation Component
 * Renders previous/next buttons and navigation hint
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeftIcon, ChevronRightIcon } from '../icons/';

interface ModalNavigationProps {
  showHint: boolean;
  onPrevious: () => void;
  onNext: () => void;
  currentIndex?: number;
  totalPhotos?: number;
  style?: React.CSSProperties;
}

const ModalNavigation: React.FC<ModalNavigationProps> = ({
  showHint,
  onPrevious,
  onNext,
  currentIndex,
  totalPhotos,
  style,
}) => {
  const { t } = useTranslation();

  const showCounter =
    typeof currentIndex === 'number' &&
    typeof totalPhotos === 'number' &&
    totalPhotos > 1;
  const currentPosition = showCounter ? (currentIndex as number) + 1 : 0;

  return (
    <>
      {showHint && (
        <div className="modal-navigation-hint">
          {t('photoModal.navigationHint')}
        </div>
      )}

      <div className="modal-navigation" style={style}>
        <button onClick={onPrevious}>
          <ChevronLeftIcon width="32" height="32" />
        </button>

        {showCounter && (
          <div
            className="modal-navigation-counter"
            aria-label={t('photoModal.positionAriaLabel', {
              current: currentPosition,
              total: totalPhotos,
            })}
          >
            {t('photoModal.position', {
              current: currentPosition,
              total: totalPhotos,
            })}
          </div>
        )}

        <button onClick={onNext}>
          <ChevronRightIcon width="32" height="32" />
        </button>
      </div>
    </>
  );
};

export default ModalNavigation;

