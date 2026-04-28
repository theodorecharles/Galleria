/**
 * AlbumContentPanel Component
 * Modal container for managing photos and videos in a selected album
 * Orchestrates header controls and photo/video grid/list view
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import AlbumContentPanelHeader from './AlbumContentPanelHeader';
import AlbumContentPanelGrid from './AlbumContentPanelGrid';
import { Photo, UploadingImage } from '../types';
import { ShuffleIcon, TrashIcon, CloseIcon, CheckmarkIcon } from '../../../icons';
import '../../PhotosModal.css';

type ViewMode = 'grid' | 'list';

interface AlbumContentPanelProps {
  selectedAlbum: string;
  albumPhotos: Photo[];
  uploadingImages: UploadingImage[];
  loadingPhotos: boolean;
  hasEverDragged: boolean;
  savingOrder: boolean;
  isDragging: boolean;
  isShuffling: boolean;
  localAlbums: any[];
  localFolders: any[];
  deletingPhotoId: string | null;
  onClose: () => void;
  setCloseHandler: (handler: () => void) => void;
  onUploadPhotos: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onDeleteAlbum: (albumName: string) => void;
  onRenameAlbum: (oldName: string, newName: string) => Promise<void>;
  onUpdateDescription: (albumName: string, description: string) => Promise<void>;
  onSetCoverPhoto: (albumName: string, filename: string | null) => Promise<void>;
  onShareAlbum: (albumName: string) => void;
  onTogglePublished: (albumName: string, currentPublished: boolean) => void;
  onToggleHomepage: (albumName: string, currentShowOnHomepage: boolean) => void;
  onPreviewAlbum: (albumName: string) => void;
  onSavePhotoOrder: () => void;
  onCancelPhotoOrder: () => void;
  onShufflePhotos: () => void;
  onShuffleStart: () => void;
  onShuffleEnd: () => void;
  onPhotoDragStart: (event: any, setActiveId?: (id: string | null) => void) => void;
  onPhotoDragEnd: (event: any, setActiveId?: (id: string | null) => void) => void;
  onOpenEditModal: (photo: Photo) => void;
  onDeletePhoto: (album: string, filename: string, photoTitle?: string, thumbnail?: string, mediaType?: 'photo' | 'video') => void;
  onBulkDeletePhotos: (photoIds: string[], onCompleted?: (deletedIds: string[]) => void) => void;
  onRetryOptimization?: (album: string, filename: string) => void;
  onRetryAI?: (album: string, filename: string) => void;
  onRetryUpload?: (filename: string, albumName: string) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  shuffleButtonRef: React.RefObject<HTMLButtonElement | null>;
  canEdit: boolean;
}

const AlbumContentPanel: React.FC<AlbumContentPanelProps> = ({
  selectedAlbum,
  albumPhotos,
  uploadingImages,
  loadingPhotos,
  deletingPhotoId,
  hasEverDragged,
  savingOrder,
  isDragging,
  isShuffling,
  localAlbums,
  localFolders,
  onClose,
  setCloseHandler,
  onUploadPhotos,
  onDeleteAlbum,
  onRenameAlbum,
  onUpdateDescription,
  onSetCoverPhoto,
  onShareAlbum,
  onTogglePublished,
  onToggleHomepage,
  onPreviewAlbum,
  onSavePhotoOrder,
  onCancelPhotoOrder,
  onShufflePhotos,
  onShuffleStart,
  onShuffleEnd,
  onPhotoDragStart,
  onPhotoDragEnd,
  onOpenEditModal,
  onDeletePhoto,
  onBulkDeletePhotos,
  onRetryOptimization,
  onRetryAI,
  onRetryUpload,
  onDragOver,
  onDragLeave,
  onDrop,
  shuffleButtonRef,
  canEdit,
}) => {
  const { t } = useTranslation();
  // Initialize viewMode from localStorage, default to 'grid'
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem('photosViewMode');
    return (saved === 'list' || saved === 'grid') ? saved : 'grid';
  });
  const [photoActiveId, setPhotoActiveId] = useState<string | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const [headerHeight, setHeaderHeight] = useState(54);

  // Multi-select state for bulk operations (ticket #622)
  const [selectMode, setSelectMode] = useState(false);
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<Set<string>>(() => new Set());
  const lastSelectedIdRef = useRef<string | null>(null);

  // Stable list of selectable photo ids (matches the order the grid renders them in)
  const selectablePhotoIds = useMemo(
    () => (Array.isArray(albumPhotos) ? albumPhotos.filter(p => p && p.id).map(p => p.id) : []),
    [albumPhotos]
  );

  // Drop selections that no longer correspond to a real photo (e.g. after a delete or album change)
  useEffect(() => {
    if (selectedPhotoIds.size === 0) return;
    const valid = new Set(selectablePhotoIds);
    let changed = false;
    const next = new Set<string>();
    selectedPhotoIds.forEach(id => {
      if (valid.has(id)) {
        next.add(id);
      } else {
        changed = true;
      }
    });
    if (changed) setSelectedPhotoIds(next);
  }, [selectablePhotoIds, selectedPhotoIds]);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedPhotoIds(new Set());
    lastSelectedIdRef.current = null;
  }, []);

  const toggleSelectMode = useCallback(() => {
    setSelectMode(prev => !prev);
    // Always clear selection on transition; safe because new Set() === empty
    setSelectedPhotoIds(new Set());
    lastSelectedIdRef.current = null;
  }, []);

  // Reset selection when album changes
  useEffect(() => {
    exitSelectMode();
  }, [selectedAlbum, exitSelectMode]);

  const handleTogglePhotoSelect = useCallback((photoId: string, withShift: boolean) => {
    setSelectedPhotoIds(prev => {
      const next = new Set(prev);
      const anchor = lastSelectedIdRef.current;
      if (withShift && anchor && anchor !== photoId) {
        const ids = selectablePhotoIds;
        const a = ids.indexOf(anchor);
        const b = ids.indexOf(photoId);
        if (a >= 0 && b >= 0) {
          const [start, end] = a < b ? [a, b] : [b, a];
          // Range-select adds photos in the range without deselecting existing ones
          for (let i = start; i <= end; i++) next.add(ids[i]);
          lastSelectedIdRef.current = photoId;
          return next;
        }
      }
      if (next.has(photoId)) {
        next.delete(photoId);
      } else {
        next.add(photoId);
      }
      lastSelectedIdRef.current = photoId;
      return next;
    });
  }, [selectablePhotoIds]);

  const handleSelectAll = useCallback(() => {
    setSelectedPhotoIds(prev => {
      // If everything's selected, clear; otherwise select all
      if (prev.size === selectablePhotoIds.length && selectablePhotoIds.length > 0) {
        return new Set();
      }
      return new Set(selectablePhotoIds);
    });
  }, [selectablePhotoIds]);

  const handleDeleteSelected = useCallback(() => {
    if (selectedPhotoIds.size === 0) return;
    const ids = Array.from(selectedPhotoIds);
    onBulkDeletePhotos(ids, () => {
      // Whether all or some succeeded, leave select mode for a clean state
      exitSelectMode();
    });
  }, [selectedPhotoIds, onBulkDeletePhotos, exitSelectMode]);

  const showBulkActionBar = selectMode;
  // Hide reorder bar while in select mode (drag is disabled, so the bar is meaningless)
  const showReorderBar = hasEverDragged && canEdit && !selectMode;
  const allSelected = selectablePhotoIds.length > 0 && selectedPhotoIds.size === selectablePhotoIds.length;

  // Measure actual header height on mount (accounts for safe-area-inset-top)
  useEffect(() => {
    const header = document.querySelector('.header') as HTMLElement;
    if (header) {
      setHeaderHeight(header.offsetHeight);
    }
  }, []);

  // Save viewMode preference to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('photosViewMode', viewMode);
  }, [viewMode]);

  // Handle close with animation
  const handleClose = () => {
    setIsClosing(true);
    // Wait for animation to complete before actually closing
    setTimeout(() => {
      onClose();
    }, 300); // Match the flipDown animation duration
  };

  // Lock body scrolling when AlbumContentPanel is open and register close handler
  useEffect(() => {
    // Save current overflow states
    const originalBodyOverflow = document.body.style.overflow;
    const originalBodyPosition = document.body.style.position;
    const originalBodyTop = document.body.style.top;
    const originalBodyWidth = document.body.style.width;
    const scrollY = window.scrollY;
    
    // Lock scrolling on body
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = '100%';
    
    // Also lock scrolling on admin-container if it exists
    const adminContainer = document.querySelector('.admin-container') as HTMLElement;
    const originalContainerOverflow = adminContainer?.style.overflow;
    if (adminContainer) {
      adminContainer.style.overflow = 'hidden';
    }
    
    // Register close handler so album deletion can trigger animation
    setCloseHandler(() => handleClose);
    
    // Restore on unmount
    return () => {
      document.body.style.overflow = originalBodyOverflow;
      document.body.style.position = originalBodyPosition;
      document.body.style.top = originalBodyTop;
      document.body.style.width = originalBodyWidth;
      window.scrollTo(0, scrollY);
      
      if (adminContainer && originalContainerOverflow !== undefined) {
        adminContainer.style.overflow = originalContainerOverflow;
      }
    };
  }, [setCloseHandler]);

  return (
    <>
      <div className={`photos-modal-backdrop ${isClosing ? 'closing' : ''}`} onClick={handleClose} />
      <div
        className={`photos-modal ${isDragging ? 'drag-over' : ''} ${isClosing ? 'closing' : ''} ${(showReorderBar || showBulkActionBar) ? 'has-reorder-bar' : ''} ${selectMode ? 'select-mode' : ''}`}
        style={{
          top: `${headerHeight}px`,
          height: `calc(100vh - ${headerHeight}px)`,
          maxHeight: `calc(100vh - ${headerHeight}px)`,
        }}
        onDragOver={uploadingImages.length > 0 ? undefined : onDragOver}
        onDragLeave={uploadingImages.length > 0 ? undefined : onDragLeave}
        onDrop={uploadingImages.length > 0 ? undefined : onDrop}
      >
          <AlbumContentPanelHeader
          selectedAlbum={selectedAlbum}
          localAlbums={localAlbums}
          localFolders={localFolders}
          albumPhotos={albumPhotos}
          uploadingImages={uploadingImages}
          viewMode={viewMode}
          selectMode={selectMode}
          canSelect={canEdit && albumPhotos.length > 0}
          onToggleSelectMode={toggleSelectMode}
          onClose={handleClose}
          onUploadPhotos={onUploadPhotos}
          onDeleteAlbum={onDeleteAlbum}
          onRenameAlbum={onRenameAlbum}
          onUpdateDescription={onUpdateDescription}
          onShareAlbum={onShareAlbum}
          onTogglePublished={onTogglePublished}
          onToggleHomepage={onToggleHomepage}
          onPreviewAlbum={onPreviewAlbum}
          onViewModeChange={setViewMode}
          canEdit={canEdit}
        />

        <AlbumContentPanelGrid
          key={viewMode}
          albumPhotos={albumPhotos}
          uploadingImages={uploadingImages}
          loadingPhotos={loadingPhotos}
          activeId={photoActiveId}
          viewMode={viewMode}
          deletingPhotoId={deletingPhotoId}
          selectedAlbum={selectedAlbum}
          selectMode={selectMode}
          selectedPhotoIds={selectedPhotoIds}
          onTogglePhotoSelect={handleTogglePhotoSelect}
          onPhotoDragStart={onPhotoDragStart}
          onPhotoDragEnd={onPhotoDragEnd}
          onOpenEditModal={onOpenEditModal}
          onDeletePhoto={onDeletePhoto}
          onRetryOptimization={onRetryOptimization}
          onRetryAI={onRetryAI}
          onRetryUpload={onRetryUpload}
          setActiveId={setPhotoActiveId}
          canEdit={canEdit}
          coverPhoto={localAlbums.find(a => a.name === selectedAlbum)?.cover_photo ?? null}
          onSetCoverPhoto={onSetCoverPhoto}
        />

        {/* Bulk-action bar (shown while in select mode) - takes priority over reorder bar */}
        {showBulkActionBar && (
          <div className="photos-reorder-bar photos-bulk-action-bar" role="region" aria-label={t('albumsManager.bulkActionsAria')}>
            <div className="photos-reorder-left">
              <button
                onClick={handleSelectAll}
                className="photos-btn photos-btn-ghost"
                title={allSelected ? t('albumsManager.deselectAll') : t('albumsManager.selectAll')}
              >
                <CheckmarkIcon width="16" height="16" />
                <span>{allSelected ? t('albumsManager.deselectAll') : t('albumsManager.selectAll')}</span>
              </button>
              <span className="bulk-selected-count" aria-live="polite">
                {t('albumsManager.selectedCount', { count: selectedPhotoIds.size })}
              </span>
            </div>
            <div className="photos-reorder-right">
              <button
                onClick={exitSelectMode}
                className="photos-btn photos-btn-ghost"
              >
                <CloseIcon width="16" height="16" />
                <span>{t('common.cancel')}</span>
              </button>
              <button
                onClick={handleDeleteSelected}
                className="photos-btn photos-btn-danger"
                disabled={selectedPhotoIds.size === 0}
                title={t('albumsManager.deleteSelected')}
              >
                <TrashIcon width="16" height="16" />
                <span>{t('albumsManager.deleteSelected')}</span>
              </button>
            </div>
          </div>
        )}

        {/* Reorder Controls (shown when dragging) - Now part of modal layout */}
        {showReorderBar && (
          <div className="photos-reorder-bar">
            <div className="photos-reorder-left">
              <button
                ref={shuffleButtonRef}
                onClick={onShufflePhotos}
                onMouseDown={onShuffleStart}
                onMouseUp={onShuffleEnd}
                onMouseLeave={onShuffleEnd}
                onTouchStart={onShuffleStart}
                onTouchEnd={onShuffleEnd}
                onTouchCancel={onShuffleEnd}
                className={`photos-btn btn-shuffle-order ${isShuffling ? 'shuffling-active' : ''}`}
                disabled={savingOrder}
                title={t('albumsManager.shufflePhotosTooltip')}
              >
                <ShuffleIcon width="16" height="16" />
                <span>{t('albumsManager.shuffle')}</span>
              </button>
              <span className="reorder-hint reorder-hint-desktop">{t('albumsManager.dragToReorder')}</span>
            </div>
            <div className="photos-reorder-right">
              <button 
                onClick={onCancelPhotoOrder} 
                className="photos-btn photos-btn-ghost" 
                disabled={savingOrder}
              >
                {t('common.cancel')}
              </button>
              <button 
                onClick={onSavePhotoOrder} 
                className="photos-btn photos-btn-success" 
                disabled={savingOrder}
              >
                {savingOrder ? t('albumsManager.savingOrder') : t('albumsManager.saveOrder')}
              </button>
            </div>
            <span className="reorder-hint reorder-hint-mobile">{t('albumsManager.dragToReorder')}</span>
          </div>
        )}
      </div>
    </>
  );
};

export default AlbumContentPanel;

