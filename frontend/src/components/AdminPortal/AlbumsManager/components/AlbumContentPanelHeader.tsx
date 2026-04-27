/**
 * AlbumContentPanelHeader Component
 * Header controls for the photos panel including:
 * - Album title and close button
 * - Publish/unpublish toggle
 * - Preview and share buttons
 * - Upload and delete album buttons
 * - Photo reorder controls (shuffle, save, cancel)
 * - View mode toggle (grid/list)
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { UploadIcon, TrashIcon, LinkIcon, CloseIcon, EyeIcon, GridViewIcon, ListViewIcon, CheckmarkIcon } from '../../../icons';
import { showToast } from '../../../../utils/toast';

type ViewMode = 'grid' | 'list';

interface AlbumContentPanelHeaderProps {
  selectedAlbum: string;
  localAlbums: any[];
  localFolders: any[];
  albumPhotos: any[];
  uploadingImages: any[];
  viewMode: ViewMode;
  selectMode: boolean;
  canSelect: boolean;
  onToggleSelectMode: () => void;
  onClose: () => void;
  onUploadPhotos: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onDeleteAlbum: (albumName: string) => void;
  onShareAlbum: (albumName: string) => void;
  onTogglePublished: (albumName: string, currentPublished: boolean) => void;
  onToggleHomepage: (albumName: string, currentShowOnHomepage: boolean) => void;
  onPreviewAlbum: (albumName: string) => void;
  onViewModeChange: (mode: ViewMode) => void;
  onRenameAlbum: (oldName: string, newName: string) => Promise<void>;
  canEdit: boolean;
}

const AlbumContentPanelHeader: React.FC<AlbumContentPanelHeaderProps> = ({
  selectedAlbum,
  localAlbums,
  localFolders: _localFolders,
  albumPhotos,
  uploadingImages,
  viewMode,
  selectMode,
  canSelect,
  onToggleSelectMode,
  onClose,
  onUploadPhotos,
  onDeleteAlbum,
  onShareAlbum,
  onTogglePublished,
  onToggleHomepage,
  onPreviewAlbum,
  onViewModeChange,
  onRenameAlbum,
  canEdit,
}) => {
  const { t } = useTranslation();
  const [isEditingTitle, setIsEditingTitle] = React.useState(false);
  const [editedTitle, setEditedTitle] = React.useState(selectedAlbum);
  const [isSaving, setIsSaving] = React.useState(false);
  const titleInputRef = React.useRef<HTMLInputElement>(null);
  
  const currentAlbum = localAlbums.find(a => a.name === selectedAlbum);
  const isPublished = currentAlbum?.published !== false;
  const showOnHomepage = currentAlbum?.show_on_homepage !== false;
  
  // Count completed uploads (optimization + AI done)
  const completedUploads = uploadingImages.filter((img: any) => img.state === 'complete').length;
  const totalUploading = uploadingImages.length;
  const photoCount = albumPhotos.length + completedUploads;
  
  // Check if album is in a folder (if so, disable publish toggle since folder controls it)
  const isInFolder = currentAlbum?.folder_id != null;
  
  // Check if any uploads are actively in progress (not complete)
  const hasActiveUploads = uploadingImages.some((img: any) => img.state !== 'complete');
  
  // Calculate upload progress percentage
  const uploadProgress = totalUploading > 0 ? Math.round((completedUploads / totalUploading) * 100) : 0;
  
  // Reset editing state when selected album changes
  React.useEffect(() => {
    setIsEditingTitle(false);
    setEditedTitle(selectedAlbum);
  }, [selectedAlbum]);
  
  // Focus input when editing starts
  React.useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [isEditingTitle]);
  
  const handleStartEdit = () => {
    if (canEdit && !hasActiveUploads) {
      setIsEditingTitle(true);
      setEditedTitle(selectedAlbum);
    }
  };
  
  const handleCancelEdit = () => {
    setIsEditingTitle(false);
    setEditedTitle(selectedAlbum);
  };
  
  const handleSaveEdit = async () => {
    const trimmedTitle = editedTitle.trim();
    
    // Validation
    if (!trimmedTitle) {
      showToast('Album name cannot be empty', 'error');
      return;
    }
    
    if (trimmedTitle === selectedAlbum) {
      setIsEditingTitle(false);
      return;
    }
    
    // Check if name already exists
    if (localAlbums.some(a => a.name === trimmedTitle)) {
      showToast(`Album "${trimmedTitle}" already exists`, 'error');
      return;
    }
    
    setIsSaving(true);
    try {
      await onRenameAlbum(selectedAlbum, trimmedTitle);
      setIsEditingTitle(false);
    } catch (error) {
      console.error('Failed to rename album:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to rename album';
      showToast(errorMessage, 'error');
    } finally {
      setIsSaving(false);
    }
  };
  
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSaveEdit();
    } else if (e.key === 'Escape') {
      handleCancelEdit();
    }
  };

  return (
    <div className="photos-modal-header">
      {/* Title Bar */}
      <div className="photos-title-bar">
        {/* Left: Album title + photo count */}
        <div className="photos-title-left">
          {isEditingTitle ? (
            <div className="album-title-edit-container">
              <input
                ref={titleInputRef}
                type="text"
                className="album-title-input"
                value={editedTitle}
                onChange={(e) => setEditedTitle(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={isSaving}
                maxLength={100}
              />
              <div className="album-title-edit-actions">
                <button
                  className="album-title-btn album-title-btn-save"
                  onClick={handleSaveEdit}
                  disabled={isSaving}
                >
                  {isSaving ? t('common.saving') : t('common.save')}
                </button>
                <button
                  className="album-title-btn album-title-btn-cancel"
                  onClick={handleCancelEdit}
                  disabled={isSaving}
                >
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          ) : (
            <>
              <h2 
                className={`photos-modal-title ${canEdit && !hasActiveUploads ? 'editable' : ''}`}
                onClick={handleStartEdit}
                title={canEdit && !hasActiveUploads ? t('albumsManager.clickToRename') : undefined}
              >
                {selectedAlbum}
              </h2>
              <span className="photos-count">
                {photoCount} {photoCount === 1 ? t('albumsManager.photo') : t('albumsManager.photos')}
                {hasActiveUploads && totalUploading > 0 && (
                  <span style={{ marginLeft: '0.5rem', color: '#4ade80' }}>
                    ({uploadProgress}% {t('albumsManager.complete')})
                  </span>
                )}
              </span>
            </>
          )}
        </div>
        
        {/* Right: Toggles + close button */}
        <div className="photos-title-right">
          {/* Mobile Toggle Stack: Homepage toggle above Publish toggle (hidden when editing title) */}
          <div className={`mobile-toggles-stack ${isEditingTitle ? 'hidden-mobile' : ''}`}>
            {/* Homepage Toggle (Mobile Only - vertical layout) */}
            {canEdit && isPublished && (
              <label className="toggle-switch-mobile-vertical homepage-toggle-mobile" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={showOnHomepage}
                  onChange={() => onToggleHomepage(selectedAlbum, showOnHomepage)}
                />
                <span className="toggle-slider"></span>
                <span className="toggle-label-below">
                  {t('albumsManager.homepage')}
                </span>
              </label>
            )}
            
            {/* Publish/Unpublish Toggle (Mobile Only - vertical layout) */}
            {canEdit && !isInFolder ? (
              <label className="toggle-switch-mobile-vertical publish-toggle-titlebar" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={isPublished}
                  onChange={() => onTogglePublished(selectedAlbum, isPublished)}
                />
                <span className="toggle-slider"></span>
                <span className="toggle-label-below">
                  {isPublished ? t('albumsManager.published') : t('albumsManager.unpublished')}
                </span>
              </label>
            ) : (
              <span className="photos-status-badge publish-toggle-titlebar" style={{
                padding: '0.5rem 0.75rem',
                borderRadius: '6px',
                fontSize: '0.875rem',
                fontWeight: 500,
                background: isPublished ? 'rgba(34, 197, 94, 0.2)' : 'rgba(251, 191, 36, 0.2)',
                color: isPublished ? '#4ade80' : '#fbbf24',
                border: isPublished ? '1px solid rgba(34, 197, 94, 0.3)' : '1px solid rgba(251, 191, 36, 0.3)',
              }}>
                {isPublished ? t('albumsManager.published') : t('albumsManager.unpublished')}
              </span>
            )}
          </div>
          
          <button 
            onClick={onClose} 
            className={`photos-close-btn ${isEditingTitle ? 'hidden-when-editing' : ''}`}
            title={t('common.close')}
          >
            <CloseIcon width="20" height="20" />
          </button>
        </div>
      </div>

      {/* Controls Bar */}
      <div className="photos-controls-bar">
        <div className="photos-controls-left">
          <div className="view-toggle">
            <button
              className={`view-toggle-btn ${viewMode === 'grid' ? 'active' : ''}`}
              onClick={() => onViewModeChange('grid')}
              title={t('albumsManager.gridView')}
            >
              <GridViewIcon width="16" height="16" />
            </button>
            <button
              className={`view-toggle-btn ${viewMode === 'list' ? 'active' : ''}`}
              onClick={() => onViewModeChange('list')}
              title={t('albumsManager.listView')}
            >
              <ListViewIcon width="16" height="16" />
            </button>
          </div>

          {canEdit && (
            <>
              <button
                type="button"
                className={`photos-btn ${selectMode ? 'photos-btn-success select-mode-active' : 'photos-btn-secondary'}`}
                onClick={onToggleSelectMode}
                disabled={hasActiveUploads || (!canSelect && !selectMode)}
                title={selectMode ? t('albumsManager.exitSelectMode') : t('albumsManager.enterSelectMode')}
              >
                <CheckmarkIcon width="16" height="16" />
                <span>{selectMode ? t('albumsManager.done') : t('albumsManager.select')}</span>
              </button>
              <label
                className={`photos-btn photos-btn-primary ${hasActiveUploads ? 'disabled' : ''}`}
                style={{
                  cursor: hasActiveUploads ? 'not-allowed' : 'pointer',
                  opacity: hasActiveUploads ? 0.6 : 1
                }}
              >
                <UploadIcon width="16" height="16" />
                <span>{hasActiveUploads ? t('sse.uploading') : t('albumsManager.upload')}</span>
                <input
                  type="file"
                  multiple
                  accept="image/*,video/*"
                  onChange={onUploadPhotos}
                  disabled={hasActiveUploads}
                  style={{ display: 'none' }}
                />
              </label>

              <button
                onClick={() => onDeleteAlbum(selectedAlbum)}
                className="photos-btn photos-btn-danger"
                title={t('albumsManager.deleteAlbum')}
                disabled={hasActiveUploads}
              >
                <TrashIcon width="16" height="16" />
                <span>{t('common.delete')}</span>
              </button>
              
              {!isPublished && (
                <>
                  <button
                    onClick={() => onPreviewAlbum(selectedAlbum)}
                    className="photos-btn photos-btn-secondary"
                    title={t('albumsManager.previewAlbum')}
                  >
                    <EyeIcon width="16" height="16" />
                    <span>{t('albumsManager.preview')}</span>
                  </button>
                  <button
                    onClick={() => onShareAlbum(selectedAlbum)}
                    className="photos-btn photos-btn-secondary"
                    title={t('albumsManager.generateShareableLink')}
                  >
                    <LinkIcon width="16" height="16" />
                    <span>{t('photo.share')}</span>
                  </button>
                </>
              )}
            </>
          )}
        </div>

        <div className="photos-controls-right">
          {/* Homepage Toggle (Desktop Only - full toggle with text) */}
          {canEdit && isPublished && (
            <label className="toggle-switch compact homepage-toggle-desktop" onClick={(e) => e.stopPropagation()} style={{ marginRight: '0.75rem' }}>
              <span className="toggle-label">
                {showOnHomepage ? t('albumsManager.onHomepage') : t('albumsManager.notOnHomepage')}
              </span>
              <input
                type="checkbox"
                checked={showOnHomepage}
                onChange={() => onToggleHomepage(selectedAlbum, showOnHomepage)}
              />
              <span className="toggle-slider"></span>
            </label>
          )}
          
          {/* Publish/Unpublish Toggle (Desktop Only - shown on wide screens) */}
          {canEdit && !isInFolder ? (
            <label className="toggle-switch compact publish-toggle-controlbar" onClick={(e) => e.stopPropagation()}>
              <span className="toggle-label">
                {isPublished ? t('albumsManager.published') : t('albumsManager.unpublished')}
              </span>
              <input
                type="checkbox"
                checked={isPublished}
                onChange={() => onTogglePublished(selectedAlbum, isPublished)}
              />
              <span className="toggle-slider"></span>
            </label>
          ) : (
            <span className="photos-status-badge publish-toggle-controlbar" style={{
              padding: '0.5rem 0.75rem',
              borderRadius: '6px',
              fontSize: '0.875rem',
              fontWeight: 500,
              background: isPublished ? 'rgba(34, 197, 94, 0.2)' : 'rgba(251, 191, 36, 0.2)',
              color: isPublished ? '#4ade80' : '#fbbf24',
              border: isPublished ? '1px solid rgba(34, 197, 94, 0.3)' : '1px solid rgba(251, 191, 36, 0.3)',
            }}>
              {isPublished ? t('albumsManager.published') : t('albumsManager.unpublished')}
            </span>
          )}
        </div>
      </div>

    </div>
  );
};

export default AlbumContentPanelHeader;

