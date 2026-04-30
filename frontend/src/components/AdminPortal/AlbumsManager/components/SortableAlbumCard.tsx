/**
 * Sortable Album Card Component
 * Drag-and-drop enabled album card with drop zone for file uploads
 */

import { useRef, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Album, AlbumFolder } from '../types';
import { FolderMinusIcon, UploadIcon, ChevronUpIcon, ChevronDownIcon, FolderArrowIcon } from '../../../icons';
import AlbumVisibilitySummary from './AlbumVisibilitySummary';

interface SortableAlbumCardProps {
  album: Album;
  folders: AlbumFolder[];
  isSelected: boolean;
  isAnimating: boolean;
  isDragOver: boolean;
  uploadProgress?: { completed: number; total: number } | null;
  onClick: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onRemoveFromFolder?: (albumName: string) => void;
  onMoveUp?: (albumName: string) => void;
  onMoveDown?: (albumName: string) => void;
  onMoveToFolder?: (albumName: string) => void;
  isFirst?: boolean;
  isLast?: boolean;
  hasFolders?: boolean;
  canEdit: boolean;
}

const SortableAlbumCard: React.FC<SortableAlbumCardProps> = ({
  album,
  folders,
  isSelected,
  isAnimating,
  isDragOver,
  uploadProgress,
  onClick,
  onDragOver,
  onDragLeave,
  onDrop,
  onRemoveFromFolder,
  onMoveUp,
  onMoveDown,
  onMoveToFolder,
  isFirst,
  isLast,
  hasFolders = false,
  canEdit,
}) => {
  const { t } = useTranslation();
  // Detect if we're on mobile
  const [isMobile, setIsMobile] = useState(false);
  
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth <= 768);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ 
    id: album.name, 
    disabled: !canEdit || isMobile,
    animateLayoutChanges: () => true, // Always animate layout changes
  });
  

  const touchStartPos = useRef<{ x: number; y: number } | null>(null);
  const hasMoved = useRef(false);

  const handleTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    touchStartPos.current = { x: touch.clientX, y: touch.clientY };
    hasMoved.current = false;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStartPos.current) return;
    
    const touch = e.touches[0];
    const deltaX = Math.abs(touch.clientX - touchStartPos.current.x);
    const deltaY = Math.abs(touch.clientY - touchStartPos.current.y);
    
    // If moved more than 5px, mark as scrolling/dragging
    if (deltaX > 5 || deltaY > 5) {
      hasMoved.current = true;
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    // Only trigger onClick if it was a tap without movement
    if (touchStartPos.current && !hasMoved.current) {
      e.preventDefault(); // Prevent click event from firing
      onClick();
    }
    touchStartPos.current = null;
    hasMoved.current = false;
  };

  const handleClick = (e: React.MouseEvent) => {
    // For desktop only - don't fire if touch already handled it
    if (e.detail === 0) return; // Triggered by keyboard or already prevented
    onClick();
  };

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`album-card ${isSelected ? 'selected' : ''} ${album.published === false ? 'unpublished' : ''} ${isAnimating ? 'animating' : ''} ${isDragging ? 'dragging' : ''} ${isDragOver ? 'drag-over-album' : ''}`}
      data-album-name={album.name}
      onClick={handleClick}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onDragOver={canEdit && !isMobile ? onDragOver : undefined}
      onDragLeave={canEdit && !isMobile ? onDragLeave : undefined}
      onDrop={canEdit && !isMobile ? onDrop : undefined}
      {...attributes}
      {...(canEdit && !isMobile ? listeners : {})}
    >
      {canEdit && onRemoveFromFolder && album.folder_id && (
        <button
          className="album-remove-folder-btn"
          onClick={(e) => {
            e.stopPropagation();
            onRemoveFromFolder(album.name);
          }}
                      title={t('albumsManager.removeFromFolder')}
        >
          <FolderMinusIcon width="16" height="16" />
        </button>
      )}
      
      {/* Desktop: Move to folder button */}
      {canEdit && !isMobile && onMoveToFolder && hasFolders && (
        <button
          className="album-move-folder-btn"
          onClick={(e) => {
            e.stopPropagation();
            onMoveToFolder(album.name);
          }}
                      title={t('albumsManager.moveToFolder')}
        >
          <FolderArrowIcon width="16" height="16" />
        </button>
      )}
      
      {/* Mobile: Arrow buttons for reordering and move to folder */}
      {canEdit && isMobile && (onMoveUp || onMoveDown || onMoveToFolder) && (
        <div className="album-mobile-arrows">
          {!isFirst && onMoveUp && (
            <button
              className="arrow-btn arrow-up"
              onClick={(e) => {
                e.stopPropagation();
                onMoveUp(album.name);
              }}
              onTouchEnd={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onMoveUp(album.name);
              }}
                      title={t('albumsManager.moveUp')}
            >
              <ChevronUpIcon width="16" height="16" />
            </button>
          )}
          {!isLast && onMoveDown && (
            <button
              className="arrow-btn arrow-down"
              onClick={(e) => {
                e.stopPropagation();
                onMoveDown(album.name);
              }}
              onTouchEnd={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onMoveDown(album.name);
              }}
                      title={t('albumsManager.moveDown')}
            >
              <ChevronDownIcon width="16" height="16" />
            </button>
          )}
          {onMoveToFolder && hasFolders && (
            <button
              className="arrow-btn move-to-folder-btn"
              onClick={(e) => {
                e.stopPropagation();
                onMoveToFolder(album.name);
              }}
              onTouchEnd={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onMoveToFolder(album.name);
              }}
                      title={t('albumsManager.moveToFolder')}
            >
              <FolderArrowIcon width="16" height="16" />
            </button>
          )}
        </div>
      )}
      <div className="album-card-header">
        <h4>
          <span className="album-name">
            <span className={album.folder_id ? "album-card-icon-in-folder" : "album-card-icon-uncategorized"}>
              {album.published !== false ? '📁' : '🔒'}{' '}
            </span>
            {album.name}
          </span>
        </h4>
      </div>
      <AlbumVisibilitySummary
        album={album}
        folders={folders}
        canManageShareLinks={canEdit}
        variant="card"
      />
      {uploadProgress && uploadProgress.total > 0 ? (
        <div className="album-upload-progress">
          <div className="upload-progress-text">
            {t('sse.uploadingLabel')}: {uploadProgress.completed}/{uploadProgress.total}
          </div>
          <div className="upload-progress-bar-container">
            <div 
              className="upload-progress-bar"
              style={{ width: `${(uploadProgress.completed / uploadProgress.total) * 100}%` }}
            />
          </div>
        </div>
      ) : album.photoCount !== undefined ? (
        <div className="album-badge">
          {album.photoCount} {album.photoCount === 1 ? 'photo' : 'photos'}
        </div>
      ) : null}
      {isDragOver && (
        <div className="album-drop-overlay">
          <UploadIcon width="32" height="32" />
          <span>Drop to upload</span>
        </div>
      )}
    </div>
  );
};

export default SortableAlbumCard;
