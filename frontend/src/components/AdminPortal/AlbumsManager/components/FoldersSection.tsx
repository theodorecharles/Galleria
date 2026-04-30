/**
 * FoldersSection Component
 * Displays folder cards with their contained albums
 */

import React from 'react';
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable';
import SortableFolderCard from './SortableFolderCard';
import { Folder, Album, UploadingImage } from '../types';

interface FoldersSectionProps {
  localFolders: Folder[];
  localAlbums: Album[];
  selectedAlbum: string | null;
  animatingAlbum: string | null;
  dragOverAlbum: string | null;
  dragOverFolderId: number | null;
  dragOverFolderGhostTile: number | null;
  uploadingImages: UploadingImage[];
  uploadProgress: { album: string; completed: number; total: number } | null;
  folderGhostTileRefs: React.MutableRefObject<Map<number, React.RefObject<HTMLInputElement>>>;
  onDeleteFolder: (folderName: string) => void;
  onToggleFolderPublished: (folderName: string, currentPublished: boolean) => void;
  onAlbumClick: (albumName: string) => void;
  onAlbumDragOver: (e: React.DragEvent, albumName: string) => void;
  onAlbumDragLeave: (e: React.DragEvent) => void;
  onAlbumDrop: (e: React.DragEvent, albumName: string) => void;
  onCreateAlbumInFolder: (folderId: number) => void;
  onFolderGhostTileClick: (folderId: number) => void;
  onFolderGhostTileDragOver: (e: React.DragEvent, folderId: number) => void;
  onFolderGhostTileDragLeave: (e: React.DragEvent) => void;
  onFolderGhostTileDrop: (e: React.DragEvent, folderId: number) => void;
  onFolderGhostTileFileSelect: (e: React.ChangeEvent<HTMLInputElement>, folderId: number) => void;
  onFolderMoveUp?: (folderId: number) => void;
  onFolderMoveDown?: (folderId: number) => void;
  onAlbumMoveUp?: (albumName: string) => void;
  onAlbumMoveDown?: (albumName: string) => void;
  onAlbumMoveToFolder?: (albumName: string) => void;
  onShareAlbum?: (albumName: string) => void;
  hasFolders: boolean;
  canEdit: boolean;
}

const FoldersSection: React.FC<FoldersSectionProps> = ({
  localFolders,
  localAlbums,
  selectedAlbum,
  animatingAlbum,
  dragOverAlbum,
  dragOverFolderId,
  dragOverFolderGhostTile,
  uploadingImages,
  uploadProgress,
  folderGhostTileRefs,
  onDeleteFolder,
  onToggleFolderPublished,
  onAlbumClick,
  onAlbumDragOver,
  onAlbumDragLeave,
  onAlbumDrop,
  onCreateAlbumInFolder,
  onFolderGhostTileClick,
  onFolderGhostTileDragOver,
  onFolderGhostTileDragLeave,
  onFolderGhostTileDrop,
  onFolderGhostTileFileSelect,
  onFolderMoveUp,
  onFolderMoveDown,
  onAlbumMoveUp,
  onAlbumMoveDown,
  onAlbumMoveToFolder,
  onShareAlbum,
  hasFolders,
  canEdit,
}) => {
  if (localFolders.length === 0) return null;

  return (
    <div className="folders-section" style={{ marginBottom: '1rem' }}>
      <SortableContext items={localFolders.map(f => `folder-${f.id}`)} strategy={rectSortingStrategy}>
        <div className="folders-container">
          {localFolders.map((folder, index) => (
            <SortableFolderCard
              key={folder.id}
              folder={folder}
              albums={localAlbums.filter(a => a.folder_id === folder.id)}
              selectedAlbum={selectedAlbum}
              animatingAlbum={animatingAlbum}
              dragOverAlbum={dragOverAlbum}
              isDragOver={dragOverFolderId === folder.id}
              isGhostTileDragOver={dragOverFolderGhostTile === folder.id}
              uploadingImages={uploadingImages}
              uploadProgress={uploadProgress}
              folderGhostTileRefs={folderGhostTileRefs}
              onDelete={onDeleteFolder}
              onTogglePublished={onToggleFolderPublished}
              onAlbumClick={onAlbumClick}
              onAlbumDragOver={onAlbumDragOver}
              onAlbumDragLeave={onAlbumDragLeave}
              onAlbumDrop={onAlbumDrop}
              onCreateAlbumInFolder={onCreateAlbumInFolder}
              onGhostTileClick={onFolderGhostTileClick}
              onGhostTileDragOver={onFolderGhostTileDragOver}
              onGhostTileDragLeave={onFolderGhostTileDragLeave}
              onGhostTileDrop={onFolderGhostTileDrop}
              onGhostTileFileSelect={onFolderGhostTileFileSelect}
              onMoveUp={onFolderMoveUp}
              onMoveDown={onFolderMoveDown}
              onAlbumMoveUp={onAlbumMoveUp}
              onAlbumMoveDown={onAlbumMoveDown}
              onAlbumMoveToFolder={onAlbumMoveToFolder}
              onShareAlbum={onShareAlbum}
              isFirst={index === 0}
              isLast={index === localFolders.length - 1}
              hasFolders={hasFolders}
              canEdit={canEdit}
            />
          ))}
        </div>
      </SortableContext>
    </div>
  );
};

export default FoldersSection;
