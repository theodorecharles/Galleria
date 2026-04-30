/**
 * Sortable Folder Card Component
 * Displays a folder card with drag-and-drop support for:
 * - Reordering folders
 * - Receiving albums dropped onto it
 * - Sorting albums within the folder
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSortable, SortableContext } from '@dnd-kit/sortable';
import { PlusCircleIcon, UploadIcon, DragHandleIcon, ChevronUpIcon, ChevronDownIcon } from '../../../icons';
import { useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { rectSortingStrategy } from '@dnd-kit/sortable';
import { AlbumFolder, Album, UploadingImage } from '../types';
import SortableAlbumCard from './SortableAlbumCard';

// Ghost tile wrapper for folders
const FolderGhostTileDroppable: React.FC<{
  folderId: number;
  isGhostTileDragOver: boolean;
  uploadingImages: UploadingImage[];
  onGhostTileClick: (folderId: number) => void;
  onGhostTileDragOver: (e: React.DragEvent, folderId: number) => void;
  onGhostTileDragLeave: (e: React.DragEvent) => void;
  onGhostTileDrop: (e: React.DragEvent, folderId: number) => void;
  onGhostTileFileSelect: (e: React.ChangeEvent<HTMLInputElement>, folderId: number) => void;
  folderGhostTileRef: React.RefObject<HTMLInputElement>;
}> = ({ folderId, isGhostTileDragOver, uploadingImages, onGhostTileClick, onGhostTileDragOver, onGhostTileDragLeave, onGhostTileDrop, onGhostTileFileSelect, folderGhostTileRef }) => {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id: `ghost-folder-${folderId}` });
  
  return (
    <div 
      ref={setNodeRef}
      className={`album-card ghost-album-tile ${isGhostTileDragOver ? 'drag-over-ghost' : ''} ${isOver ? 'drag-over-album' : ''} ${uploadingImages.length > 0 ? 'ghost-tile-disabled' : ''}`}
      onClick={uploadingImages.length > 0 ? undefined : (e) => {
        e.stopPropagation();
        onGhostTileClick(folderId);
      }}
      onDragOver={uploadingImages.length > 0 ? undefined : (e) => onGhostTileDragOver(e, folderId)}
      onDragLeave={uploadingImages.length > 0 ? undefined : onGhostTileDragLeave}
      onDrop={uploadingImages.length > 0 ? undefined : (e) => onGhostTileDrop(e, folderId)}
    >
      <div className="ghost-tile-content">
        {uploadingImages.length > 0 ? (
          <span style={{ fontSize: '0.875rem', color: '#94a3b8', textAlign: 'center' }}>
            {t('albumsManager.uploadInProgress')}
          </span>
        ) : isGhostTileDragOver ? (
          <UploadIcon width="48" height="48" />
        ) : (
          <PlusCircleIcon width="48" height="48" />
        )}
      </div>
      <input
        ref={folderGhostTileRef}
        type="file"
        multiple
        accept="image/*,video/*"
        onChange={(e) => onGhostTileFileSelect(e, folderId)}
        disabled={uploadingImages.length > 0}
        style={{ display: 'none' }}
      />
    </div>
  );
};

interface SortableFolderCardProps {
  folder: AlbumFolder;
  albums: Album[];
  selectedAlbum: string | null;
  animatingAlbum: string | null;
  dragOverAlbum: string | null;
  isDragOver: boolean;
  isGhostTileDragOver: boolean;
  uploadingImages: UploadingImage[];
  uploadProgress?: { album: string; completed: number; total: number } | null;
  folderGhostTileRefs: React.MutableRefObject<Map<number, React.RefObject<HTMLInputElement>>>;
  onDelete: (folderName: string) => void;
  onTogglePublished: (folderName: string, currentPublished: boolean) => void;
  onAlbumClick: (albumName: string) => void;
  onAlbumDragOver: (e: React.DragEvent, albumName: string) => void;
  onAlbumDragLeave: (e: React.DragEvent) => void;
  onAlbumDrop: (e: React.DragEvent, albumName: string) => void;
  onCreateAlbumInFolder: (folderId: number) => void;
  onGhostTileClick: (folderId: number) => void;
  onGhostTileDragOver: (e: React.DragEvent, folderId: number) => void;
  onGhostTileDragLeave: (e: React.DragEvent) => void;
  onGhostTileDrop: (e: React.DragEvent, folderId: number) => void;
  onGhostTileFileSelect: (e: React.ChangeEvent<HTMLInputElement>, folderId: number) => void;
  onMoveUp?: (folderId: number) => void;
  onMoveDown?: (folderId: number) => void;
  onAlbumMoveUp?: (albumName: string) => void;
  onAlbumMoveDown?: (albumName: string) => void;
  onAlbumMoveToFolder?: (albumName: string) => void;
  isFirst?: boolean;
  isLast?: boolean;
  hasFolders: boolean;
  canEdit: boolean;
}

const SortableFolderCard: React.FC<SortableFolderCardProps> = ({
  folder,
  albums,
  selectedAlbum,
  animatingAlbum,
  dragOverAlbum,
  isDragOver,
  isGhostTileDragOver,
  uploadingImages,
  uploadProgress,
  folderGhostTileRefs,
  onDelete,
  onTogglePublished,
  onAlbumClick,
  onAlbumDragOver,
  onAlbumDragLeave,
  onAlbumDrop,
  // onCreateAlbumInFolder, // Not currently used - ghost tile handles creation
  onGhostTileClick,
  onGhostTileDragOver,
  onGhostTileDragLeave,
  onGhostTileDrop,
  onGhostTileFileSelect,
  onMoveUp,
  onMoveDown,
  onAlbumMoveUp,
  onAlbumMoveDown,
  onAlbumMoveToFolder,
  isFirst,
  isLast,
  hasFolders,
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
  // Create/get ref for this folder's ghost tile file input
  useEffect(() => {
    if (!folderGhostTileRefs.current.has(folder.id)) {
      folderGhostTileRefs.current.set(folder.id, React.createRef<HTMLInputElement>() as React.RefObject<HTMLInputElement>);
    }
  }, [folder.id, folderGhostTileRefs]);
  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `folder-${folder.id}`,
    disabled: !canEdit || isMobile,
    animateLayoutChanges: () => true, // Always animate layout changes
  });

  // Make the folder's album grid droppable
  const { setNodeRef: setDroppableRef, isOver } = useDroppable({
    id: `folder-grid-${folder.id}`,
    data: { type: 'folder-grid', folderId: folder.id },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : 1,
  };

  const albumCount = albums.length;

  return (
    <div
      ref={setSortableRef}
      style={style}
      className={`folder-card ${isDragOver || isOver ? 'drag-over' : ''} ${isDragging ? 'dragging' : ''} ${!folder.published ? 'unpublished' : ''}`}
    >
      <div 
        className="folder-card-header"
      >
        {canEdit && !isMobile && (
          <div
            className="folder-drag-handle-icon"
            {...attributes}
            {...listeners}
            style={{ 
              cursor: isDragging ? 'grabbing' : 'grab',
              position: 'absolute',
              top: '8px',
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 10,
              color: '#888',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '2px'
            }}
          >
            <DragHandleIcon width="20" height="20" />
          </div>
        )}
        
        {/* Mobile: Arrow buttons for reordering folders */}
        {canEdit && isMobile && (onMoveUp || onMoveDown) && (
          <div className="folder-mobile-arrows">
            {!isFirst && onMoveUp && (
              <button
                className="arrow-btn arrow-up"
                onClick={(e) => {
                  e.stopPropagation();
                  onMoveUp(folder.id);
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
                  onMoveDown(folder.id);
                }}
                title={t('albumsManager.moveDown')}
              >
                <ChevronDownIcon width="16" height="16" />
              </button>
            )}
          </div>
        )}
        <div 
          className="folder-drag-handle"
          style={{ cursor: 'default' }}
        >
          <h4 className="folder-card-title">
            {folder.published ? '📁' : '🔒'} {folder.name}
          </h4>
          <div className="folder-count">
            {albumCount} {albumCount === 1 ? t('albumsManager.album') : t('albumsManager.albums')}
          </div>
        </div>
        {canEdit && (
          <div className="folder-controls">
            <label 
              className="toggle-switch" 
              style={{ 
                opacity: albumCount === 0 ? 0.5 : 1,
                cursor: albumCount === 0 ? 'not-allowed' : 'pointer',
                flexDirection: 'row-reverse'
              }} 
              onClick={(e) => e.stopPropagation()}
              title={albumCount === 0 ? t('albumsManager.cannotPublishEmptyFolder') : ''}
            >
              <span className="toggle-label">{folder.published ? t('albumsManager.published') : t('albumsManager.unpublished')}</span>
              <input
                type="checkbox"
                checked={albumCount > 0 && folder.published}
                onChange={() => onTogglePublished(folder.name, folder.published)}
                disabled={albumCount === 0}
              />
              <span className="toggle-slider"></span>
            </label>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(folder.name);
              }}
              className="folder-delete-btn-text"
              title={t('albumsManager.deleteFolderTitle')}
            >
              {t('common.delete')}
            </button>
          </div>
        )}
      </div>
      
      {/* Albums inside the folder - the grid itself is the drop zone */}
      <SortableContext items={albums.map(a => a.name)} strategy={rectSortingStrategy}>
        <div 
          ref={setDroppableRef}
          className="folder-albums-grid"
        >
          {albums.map((album, index) => (
            <SortableAlbumCard
              key={album.name}
              album={album}
              folders={[folder]}
              isSelected={selectedAlbum === album.name}
              isAnimating={animatingAlbum === album.name}
              isDragOver={dragOverAlbum === album.name}
              uploadProgress={uploadProgress?.album === album.name ? { completed: uploadProgress.completed, total: uploadProgress.total } : null}
              onClick={() => onAlbumClick(album.name)}
              onDragOver={(e) => { onAlbumDragOver(e, album.name); }}
              onDragLeave={onAlbumDragLeave}
              onDrop={(e) => { onAlbumDrop(e, album.name); }}
              onMoveUp={onAlbumMoveUp}
              onMoveDown={onAlbumMoveDown}
              onMoveToFolder={onAlbumMoveToFolder}
              isFirst={index === 0}
              isLast={index === albums.length - 1}
              hasFolders={hasFolders}
              canEdit={canEdit}
            />
          ))}
          {/* Ghost tile for creating new album in this folder - only show for editors */}
          {canEdit && (
            <FolderGhostTileDroppable
              folderId={folder.id}
              isGhostTileDragOver={isGhostTileDragOver}
              uploadingImages={uploadingImages}
              onGhostTileClick={onGhostTileClick}
              onGhostTileDragOver={onGhostTileDragOver}
              onGhostTileDragLeave={onGhostTileDragLeave}
              onGhostTileDrop={onGhostTileDrop}
              onGhostTileFileSelect={onGhostTileFileSelect}
              folderGhostTileRef={folderGhostTileRefs.current.get(folder.id) as React.RefObject<HTMLInputElement>}
            />
          )}
        </div>
      </SortableContext>
    </div>
  );
};

export default SortableFolderCard;
