import React from 'react';
import { useTranslation } from 'react-i18next';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Photo, UploadingImage } from '../types';
import { API_URL } from '../../../../config';
import { EditIcon, TrashIcon, VideoIcon, CheckmarkIcon } from '../../../icons';

interface AlbumListItemProps {
  // Either an existing photo or an uploading image
  photo?: Photo;
  uploadingImage?: UploadingImage;
  uploadingIndex?: number;

  // Handlers
  onEdit: (photo: Photo) => void;
  onDelete: (album: string, filename: string, photoTitle: string, thumbnail: string, mediaType?: 'photo' | 'video') => void;
  // Inline title save (ticket #695). Optional so legacy callers (e.g. uploading rows) work without it.
  onUpdatePhotoMetadata?: (filename: string, newTitle: string, newDescription: string) => Promise<boolean>;

  // State
  deletingPhotoId: string | null;
  canEdit: boolean;

  // Multi-select (ticket #622)
  selectMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (photoId: string, withShift: boolean) => void;
}

export const AlbumListItem: React.FC<AlbumListItemProps> = ({
  photo,
  uploadingImage,
  uploadingIndex,
  onEdit,
  onDelete,
  onUpdatePhotoMetadata,
  deletingPhotoId,
  canEdit,
  selectMode = false,
  isSelected = false,
  onToggleSelect,
}) => {
  const { t } = useTranslation();
  // Determine the data source
  const photoData = uploadingImage?.photo || photo;
  const isComplete = uploadingImage ? uploadingImage.state === 'complete' : true;
  const isUploading = uploadingImage && uploadingImage.state !== 'complete';
  
  // Extract info
  const photoId = photoData?.id || `uploading-${uploadingIndex}`;
  const filename = photoData?.id ? decodeURIComponent(photoData.id.split('/')[1]) : t('albumsManager.uploadingEllipsis');
  const album = photoData?.id ? photoData.id.split('/')[0] : '';
  const title = photoData?.title || filename;
  const thumbnailUrl = photoData?.thumbnail || '';
  
  const isDeleting = deletingPhotoId === photoId;

  // Inline title edit (ticket #695) — mirrors the album-name pattern from AlbumContentPanelHeader.
  // Only available for saved photos; rows that are still uploading or that lack a save handler
  // fall back to read-only display.
  const canInlineEdit = !!(
    photoData?.id && onUpdatePhotoMetadata && canEdit && !isUploading && !selectMode
  );
  const [isEditingTitle, setIsEditingTitle] = React.useState(false);
  const [editedTitle, setEditedTitle] = React.useState(title);
  const [isSavingTitle, setIsSavingTitle] = React.useState(false);
  const titleInputRef = React.useRef<HTMLInputElement>(null);

  // Reset edit state if the photo's title changes from outside (e.g. SSE update).
  React.useEffect(() => {
    if (!isEditingTitle) {
      setEditedTitle(title);
    }
  }, [title, isEditingTitle]);

  // Focus + select-all when entering edit mode so typing replaces the title immediately.
  React.useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [isEditingTitle]);

  const handleStartTitleEdit = () => {
    if (!canInlineEdit) return;
    setEditedTitle(title);
    setIsEditingTitle(true);
  };

  const handleCancelTitleEdit = () => {
    setIsEditingTitle(false);
    setEditedTitle(title);
  };

  const handleSaveTitleEdit = async () => {
    // Guard against double-fire: Enter triggers save → state flips → blur on unmount
    // would otherwise call this again with the same edited value.
    if (isSavingTitle || !isEditingTitle) return;
    if (!photoData || !onUpdatePhotoMetadata) {
      setIsEditingTitle(false);
      return;
    }
    const trimmed = editedTitle.trim();
    // No-op when unchanged or empty — empty would clobber the existing title.
    if (!trimmed || trimmed === title) {
      setIsEditingTitle(false);
      setEditedTitle(title);
      return;
    }
    setIsSavingTitle(true);
    try {
      const success = await onUpdatePhotoMetadata(filename, trimmed, photoData.description ?? '');
      if (success) {
        setIsEditingTitle(false);
      }
    } finally {
      setIsSavingTitle(false);
    }
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveTitleEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelTitleEdit();
    }
  };

  // Drag and drop
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: photoId,
    disabled: !canEdit || selectMode,
  });

  const handleRowClick = (e: React.MouseEvent) => {
    if (!selectMode || isUploading || !photoData || !onToggleSelect) return;
    e.preventDefault();
    e.stopPropagation();
    onToggleSelect(photoData.id, e.shiftKey);
  };
  
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  // Show status for uploading items
  const getStatusText = () => {
    if (!uploadingImage) return null;
    
    switch (uploadingImage.state) {
      case 'queued':
        return t('sse.queuedWithEllipsis');
      case 'uploading':
        return t('sse.uploadingWithProgress', { progress: uploadingImage.progress });
      case 'optimizing':
        // Show video stage if available
        if (uploadingImage.videoStage) {
          // For resolutions (240p, 720p, etc), show resolution + stage progress
          // For other stages (rotation, thumbnail), just show stage name
          if (uploadingImage.videoStage.match(/^\d+p$/)) {
            return `${uploadingImage.videoStage} (${Math.round(uploadingImage.videoStageProgress || 0)}%)`;
          }
          return uploadingImage.videoStage;
        }
        return t('sse.optimizingWithProgress', { progress: Math.round(uploadingImage.optimizeProgress || 0) });
      case 'generating-title':
        return t('sse.generatingTitleLowercase');
      case 'error':
        return 'Error';
      default:
        return null;
    }
  };

  const statusText = getStatusText();

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`list-item ${isDragging ? 'dragging' : ''} ${isDeleting ? 'deleting' : ''} ${isUploading ? 'uploading' : ''} ${selectMode ? 'selectable' : ''} ${isSelected ? 'selected' : ''}`}
      {...(selectMode ? { onClick: handleRowClick } : {})}
      {...(!selectMode ? attributes : {})}
      {...(!selectMode ? listeners : {})}
    >
      {/* Selection indicator (multi-select mode) */}
      {selectMode && !isUploading && (
        <div className={`list-item-select ${isSelected ? 'checked' : ''}`} aria-hidden="true">
          {isSelected && <CheckmarkIcon width="14" height="14" />}
        </div>
      )}

      {/* Thumbnail */}
      <div className="list-item-thumbnail">
        {thumbnailUrl ? (
          <>
            <img
              src={`${API_URL}${thumbnailUrl}?t=${Date.now()}`}
              alt={title}
            />
            {photoData?.media_type === 'video' && (
              <div className="video-icon-overlay">
                <VideoIcon width="20" height="20" />
              </div>
            )}
          </>
        ) : isUploading ? (
          <div className="thumbnail-placeholder" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', width: '100%' }}>
            <div className="loading-spinner" style={{ width: '24px', height: '24px', marginTop: '12px' }} />
          </div>
        ) : (
          <div className="thumbnail-placeholder" />
        )}
      </div>

      {/* Title */}
      <div className="list-item-title">
        {statusText ? (
          <div className="status-text">{statusText}</div>
        ) : isEditingTitle ? (
          <input
            ref={titleInputRef}
            type="text"
            className="list-item-title-input"
            value={editedTitle}
            onChange={(e) => setEditedTitle(e.target.value)}
            onKeyDown={handleTitleKeyDown}
            onBlur={handleSaveTitleEdit}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            disabled={isSavingTitle}
            maxLength={200}
          />
        ) : (
          <div
            className={`title-text ${canInlineEdit ? 'editable' : ''}`}
            onDoubleClick={(e) => {
              if (!canInlineEdit) return;
              e.stopPropagation();
              e.preventDefault();
              handleStartTitleEdit();
            }}
            title={canInlineEdit ? t('albumsManager.doubleClickToEditTitle') : undefined}
          >
            {title}
          </div>
        )}
      </div>

      {/* Actions (hidden in select mode) */}
      {isComplete && canEdit && !selectMode && (
        <div className="list-item-actions">
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (photoData) onEdit(photoData);
            }}
            className="list-action-btn"
            title="Edit photo"
          >
            <EditIcon width="16" height="16" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(album, filename, title, thumbnailUrl, photoData?.media_type);
            }}
            className="list-action-btn delete"
            title="Delete photo"
          >
            <TrashIcon width="16" height="16" />
          </button>
        </div>
      )}
    </div>
  );
};

