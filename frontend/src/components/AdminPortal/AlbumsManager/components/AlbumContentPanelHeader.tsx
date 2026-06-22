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
import { UploadIcon, TrashIcon, LinkIcon, CloseIcon, EyeIcon, GridViewIcon, ListViewIcon } from '../../../icons';
import { showToast } from '../../../../utils/toast';

type ViewMode = 'grid' | 'list';

interface AlbumContentPanelHeaderProps {
  selectedAlbum: string;
  localAlbums: any[];
  albumPhotos: any[];
  uploadingImages: any[];
  viewMode: ViewMode;
  onClose: () => void;
  onUploadPhotos: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onDeleteAlbum: (albumName: string) => void;
  onShareAlbum: (albumName: string) => void;
  onUpdateVisibility: (albumName: string, visibility: {
    published: boolean;
    show_on_homepage: boolean;
    downloads_enabled: boolean;
  }) => Promise<boolean>;
  onPreviewAlbum: (albumName: string) => void;
  onViewModeChange: (mode: ViewMode) => void;
  onRenameAlbum: (oldName: string, newName: string) => Promise<void>;
  canEdit: boolean;
}

const AlbumContentPanelHeader: React.FC<AlbumContentPanelHeaderProps> = ({
  selectedAlbum,
  localAlbums,
  albumPhotos,
  uploadingImages,
  viewMode,
  onClose,
  onUploadPhotos,
  onDeleteAlbum,
  onShareAlbum,
  onUpdateVisibility,
  onPreviewAlbum,
  onViewModeChange,
  onRenameAlbum,
  canEdit,
}) => {
  const { t } = useTranslation();
  const [isEditingTitle, setIsEditingTitle] = React.useState(false);
  const [editedTitle, setEditedTitle] = React.useState(selectedAlbum);
  const [isSaving, setIsSaving] = React.useState(false);
  const [showVisibilityModal, setShowVisibilityModal] = React.useState(false);
  const [isSavingVisibility, setIsSavingVisibility] = React.useState(false);
  const titleInputRef = React.useRef<HTMLInputElement>(null);
  
  const currentAlbum = localAlbums.find(a => a.name === selectedAlbum);
  const isPublished = currentAlbum?.published !== false;
  const showOnHomepage = currentAlbum?.show_on_homepage === true;
  const downloadsEnabled = currentAlbum?.downloads_enabled !== false;
  const [visibilityDraft, setVisibilityDraft] = React.useState({
    published: isPublished,
    show_on_homepage: showOnHomepage,
    downloads_enabled: downloadsEnabled,
  });
  
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

  React.useEffect(() => {
    if (showVisibilityModal) {
      setVisibilityDraft({
        published: isPublished,
        show_on_homepage: isPublished ? showOnHomepage : false,
        downloads_enabled: downloadsEnabled,
      });
    }
  }, [showVisibilityModal, isPublished, showOnHomepage, downloadsEnabled]);
  
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

  const handleOpenVisibilityModal = () => {
    setVisibilityDraft({
      published: isPublished,
      show_on_homepage: isPublished ? showOnHomepage : false,
      downloads_enabled: downloadsEnabled,
    });
    setShowVisibilityModal(true);
  };

  const handleSaveVisibility = async () => {
    setIsSavingVisibility(true);
    try {
      const success = await onUpdateVisibility(selectedAlbum, visibilityDraft);
      if (success) {
        setShowVisibilityModal(false);
      }
    } finally {
      setIsSavingVisibility(false);
    }
  };

  return (
    <>
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
          {canEdit && (
            <button
              type="button"
              className={`photos-btn photos-btn-secondary visibility-button-titlebar ${isEditingTitle ? 'hidden-mobile' : ''}`}
              onClick={handleOpenVisibilityModal}
              title={t('albumsManager.visibilitySettings')}
            >
              <EyeIcon width="16" height="16" isSlashed={!isPublished} />
              <span>{t('albumsManager.visibility')}</span>
            </button>
          )}
          
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

      </div>

    </div>
    {showVisibilityModal && (
      <div
        className="edit-title-modal"
        onClick={() => setShowVisibilityModal(false)}
      >
        <div className="edit-modal visibility-modal" onClick={(e) => e.stopPropagation()}>
          <div className="edit-modal-header">
            <h3>{t('albumsManager.visibilitySettings')}</h3>
            <button
              className="modal-close-btn"
              onClick={() => setShowVisibilityModal(false)}
              title={t('common.close')}
            >
              ×
            </button>
          </div>

          <div className="edit-modal-body visibility-modal-body">
            <label className={`visibility-option ${isInFolder ? 'disabled' : ''}`}>
              <span>
                <span className="visibility-option-title">{t('albumsManager.published')}</span>
                <span className="visibility-option-description">
                  {isInFolder ? t('albumsManager.folderControlsPublished') : t('albumsManager.publishedVisibilityDescription')}
                </span>
              </span>
              <span className="toggle-switch">
                <input
                  type="checkbox"
                  checked={visibilityDraft.published}
                  disabled={isInFolder}
                  onChange={(e) => {
                    const published = e.target.checked;
                    setVisibilityDraft(prev => ({
                      ...prev,
                      published,
                      show_on_homepage: published ? prev.show_on_homepage : false,
                    }));
                  }}
                />
                <span className="toggle-slider"></span>
              </span>
            </label>

            <label className={`visibility-option ${!visibilityDraft.published ? 'disabled' : ''}`}>
              <span>
                <span className="visibility-option-title">{t('albumsManager.onHomepage')}</span>
                <span className="visibility-option-description">{t('albumsManager.homepageVisibilityDescription')}</span>
              </span>
              <span className="toggle-switch">
                <input
                  type="checkbox"
                  checked={visibilityDraft.show_on_homepage}
                  disabled={!visibilityDraft.published}
                  onChange={(e) => setVisibilityDraft(prev => ({
                    ...prev,
                    show_on_homepage: e.target.checked,
                  }))}
                />
                <span className="toggle-slider"></span>
              </span>
            </label>

            <label className="visibility-option">
              <span>
                <span className="visibility-option-title">{t('albumsManager.downloadsEnabled')}</span>
                <span className="visibility-option-description">{t('albumsManager.downloadsVisibilityDescription')}</span>
              </span>
              <span className="toggle-switch">
                <input
                  type="checkbox"
                  checked={visibilityDraft.downloads_enabled}
                  onChange={(e) => setVisibilityDraft(prev => ({
                    ...prev,
                    downloads_enabled: e.target.checked,
                  }))}
                />
                <span className="toggle-slider"></span>
              </span>
            </label>
          </div>

          <div className="edit-modal-footer">
            <button
              type="button"
              className="photos-btn photos-btn-ghost"
              onClick={() => setShowVisibilityModal(false)}
              disabled={isSavingVisibility}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="photos-btn photos-btn-success"
              onClick={handleSaveVisibility}
              disabled={isSavingVisibility}
            >
              {isSavingVisibility ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
};

export default AlbumContentPanelHeader;
