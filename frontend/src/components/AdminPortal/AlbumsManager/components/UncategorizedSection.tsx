/**
 * UncategorizedSection Component
 * Displays uncategorized albums and ghost tile for creating new albums
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import SortableAlbumCard from './SortableAlbumCard';
import { Album, UploadingImage } from '../types';
import { PlusCircleIcon, UploadIcon } from '../../../icons';

// Ghost tile wrapper that makes it droppable
const GhostTileDroppable: React.FC<{
  id: string;
  isGhostAlbumDragOver: boolean;
  uploadingImages: UploadingImage[];
  onGhostTileClick: () => void;
  onGhostTileDragOver: (e: React.DragEvent) => void;
  onGhostTileDragLeave: (e: React.DragEvent) => void;
  onGhostTileDrop: (e: React.DragEvent) => void;
  onGhostTileFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  ghostTileFileInputRef: React.RefObject<HTMLInputElement | null>;
}> = ({ id, isGhostAlbumDragOver, uploadingImages, onGhostTileClick, onGhostTileDragOver, onGhostTileDragLeave, onGhostTileDrop, onGhostTileFileSelect, ghostTileFileInputRef }) => {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id });
  
  return (
    <div 
      ref={setNodeRef}
      className={`album-card ghost-album-tile ${isGhostAlbumDragOver ? 'drag-over-ghost' : ''} ${isOver ? 'drag-over-album' : ''} ${uploadingImages.length > 0 ? 'ghost-tile-disabled' : ''}`}
      onClick={uploadingImages.length > 0 ? undefined : onGhostTileClick}
      onDragOver={uploadingImages.length > 0 ? undefined : onGhostTileDragOver}
      onDragLeave={uploadingImages.length > 0 ? undefined : onGhostTileDragLeave}
      onDrop={uploadingImages.length > 0 ? undefined : onGhostTileDrop}
    >
      <div className="ghost-tile-content">
        {uploadingImages.length > 0 ? (
          <span style={{ fontSize: '0.875rem', color: '#94a3b8', textAlign: 'center' }}>
            {t('sse.uploadInProgress')}
          </span>
        ) : isGhostAlbumDragOver ? (
          <UploadIcon width="48" height="48" />
        ) : (
          <PlusCircleIcon width="48" height="48" />
        )}
      </div>
      <input
        ref={ghostTileFileInputRef}
        type="file"
        multiple
        accept="image/*,video/*"
        onChange={onGhostTileFileSelect}
        disabled={uploadingImages.length > 0}
        style={{ display: 'none' }}
      />
    </div>
  );
};

interface UncategorizedSectionProps {
  localAlbums: Album[];
  selectedAlbum: string | null;
  animatingAlbum: string | null;
  dragOverAlbum: string | null;
  dragOverUncategorized: boolean;
  uploadingImages: UploadingImage[];
  uploadProgress: { album: string; completed: number; total: number } | null;
  isGhostAlbumDragOver: boolean;
  uncategorizedSectionRef: React.RefObject<HTMLDivElement | null>;
  ghostTileFileInputRef: React.RefObject<HTMLInputElement | null>;
  onAlbumClick: (albumName: string) => void;
  onAlbumDragOver: (e: React.DragEvent, albumName: string) => void;
  onAlbumDragLeave: (e: React.DragEvent) => void;
  onAlbumDrop: (e: React.DragEvent, albumName: string) => void;
  onGhostTileClick: () => void;
  onGhostTileDragOver: (e: React.DragEvent) => void;
  onGhostTileDragLeave: (e: React.DragEvent) => void;
  onGhostTileDrop: (e: React.DragEvent) => void;
  onGhostTileFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onAlbumMoveUp?: (albumName: string) => void;
  onAlbumMoveDown?: (albumName: string) => void;
  onAlbumMoveToFolder?: (albumName: string) => void;
  hasFolders: boolean;
  canEdit: boolean;
}

const UncategorizedSection: React.FC<UncategorizedSectionProps> = ({
  localAlbums,
  selectedAlbum,
  animatingAlbum,
  dragOverAlbum,
  dragOverUncategorized,
  uploadingImages,
  uploadProgress,
  isGhostAlbumDragOver,
  uncategorizedSectionRef,
  ghostTileFileInputRef,
  onAlbumClick,
  onAlbumDragOver,
  onAlbumDragLeave,
  onAlbumDrop,
  onGhostTileClick,
  onGhostTileDragOver,
  onGhostTileDragLeave,
  onGhostTileDrop,
  onGhostTileFileSelect,
  onAlbumMoveUp,
  onAlbumMoveDown,
  onAlbumMoveToFolder,
  hasFolders,
  canEdit,
}) => {
  const { t } = useTranslation();
  const uncategorizedAlbums = localAlbums.filter(album => !album.folder_id);
  
  // Make the uncategorized grid droppable
  const { setNodeRef: setDroppableRef, isOver } = useDroppable({
    id: 'uncategorized-grid',
    data: { type: 'uncategorized-grid' },
  });

  return (
    <div className="albums-management">
      <div className="albums-list">
        <div 
          ref={uncategorizedSectionRef}
          className={`uncategorized-section ${dragOverUncategorized || isOver ? 'drag-over-uncategorized' : ''}`}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h3 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 600, color: '#fff' }}>
              {t('albumsManager.uncategorized')}
            </h3>
            <span style={{ fontSize: '0.9rem', color: '#888' }}>
              {uncategorizedAlbums.length} {uncategorizedAlbums.length === 1 ? t('common.album') : t('common.albums')}
            </span>
          </div>
          <SortableContext 
            items={uncategorizedAlbums.map(a => a.name)} 
            strategy={rectSortingStrategy}
          >
            <div ref={setDroppableRef} className="album-grid">
              {uncategorizedAlbums.map((album, index) => (
                <SortableAlbumCard
                  key={album.name}
                  album={album}
                  folders={[]}
                  isSelected={selectedAlbum === album.name}
                  isAnimating={animatingAlbum === album.name}
                  isDragOver={dragOverAlbum === album.name}
                  uploadProgress={uploadProgress?.album === album.name ? { completed: uploadProgress.completed, total: uploadProgress.total } : null}
                  onClick={() => onAlbumClick(album.name)}
                  onDragOver={(e) => onAlbumDragOver(e, album.name)}
                  onDragLeave={onAlbumDragLeave}
                  onDrop={(e) => onAlbumDrop(e, album.name)}
                  onMoveUp={onAlbumMoveUp}
                  onMoveDown={onAlbumMoveDown}
                  onMoveToFolder={onAlbumMoveToFolder}
                  isFirst={index === 0}
                  isLast={index === uncategorizedAlbums.length - 1}
                  hasFolders={hasFolders}
                  canEdit={canEdit}
                />
              ))}
              
              {/* Ghost tile for creating new albums - only show for editors */}
              {canEdit && (
                <GhostTileDroppable 
                  id="ghost-uncategorized"
                  isGhostAlbumDragOver={isGhostAlbumDragOver}
                  uploadingImages={uploadingImages}
                  onGhostTileClick={onGhostTileClick}
                  onGhostTileDragOver={onGhostTileDragOver}
                  onGhostTileDragLeave={onGhostTileDragLeave}
                  onGhostTileDrop={onGhostTileDrop}
                  onGhostTileFileSelect={onGhostTileFileSelect}
                  ghostTileFileInputRef={ghostTileFileInputRef}
                />
              )}
            </div>
          </SortableContext>
        </div>
      </div>
    </div>
  );
};

export default UncategorizedSection;
