/**
 * Album Management Handlers
 * Handles album deletion, renaming, publishing, and moving between folders
 */

import { TFunction } from 'i18next';
import { Album, AlbumFolder, ConfirmModalConfig } from '../types';
import { API_URL } from '../../../../config';
import { fetchWithRateLimitCheck } from '../../../../utils/fetchWrapper';
import { 
  trackAlbumDeleted, 
  trackAlbumRenamed, 
  trackAlbumPublishToggle, 
  trackAlbumHomepageToggle,
  trackAlbumMovedToFolder 
} from '../../../../utils/analytics';
import { sanitizeName, isValidAlbumName } from '../utils/albumHelpers';
import { error } from '../../../../utils/logger';


interface AlbumHandlersProps {
  localAlbums: Album[];
  setLocalAlbums: (albums: Album[]) => void;
  localFolders: AlbumFolder[];
  selectedAlbum: string | null;
  deselectAlbum: () => void;
  selectAlbum: (albumName: string) => void;
  setMessage: (message: { type: 'success' | 'error'; text: string }) => void;
  loadAlbums: () => Promise<void>;
  saveAlbumOrder: (albumsToSave?: Album[], silent?: boolean) => Promise<boolean>;
  setShowRenameModal: (show: boolean) => void;
  setRenamingAlbum: (album: string | null) => void;
  setNewAlbumName: (name: string) => void;
  renamingAlbum: string | null;
  newAlbumName: string;
  showConfirmation: (config: ConfirmModalConfig) => void;
  closePhotosPanel?: () => void; // Optional handler to trigger closing animation
  t: TFunction;
}

export const createAlbumHandlers = (props: AlbumHandlersProps) => {
  const {
    localAlbums,
    setLocalAlbums,
    localFolders,
    selectedAlbum,
    deselectAlbum,
    selectAlbum,
    setMessage,
    loadAlbums,
    saveAlbumOrder,
    setShowRenameModal,
    setRenamingAlbum,
    setNewAlbumName,
    renamingAlbum,
    newAlbumName,
    showConfirmation,
    closePhotosPanel,
    t,
  } = props;

  const handleDeleteAlbum = async (albumName: string): Promise<void> => {
    // Save any unsaved changes before deleting (silently, no success message)
    const saveSuccess = await saveAlbumOrder(localAlbums, true);
    if (!saveSuccess) {
      setMessage({ type: 'error', text: t('albumsManager.failedToSaveChangesBeforeDeletingAlbum') });
      return;
    }

    showConfirmation({
      message: t('albumsManager.deleteAlbumConfirm', { albumName }),
      confirmText: t('albumsManager.deleteAlbum'),
      isDanger: true,
      onConfirm: async () => {
        try {
          const res = await fetchWithRateLimitCheck(
            `${API_URL}/api/albums/${encodeURIComponent(albumName)}`,
            {
              method: 'DELETE',
              credentials: 'include',
            }
          );

          if (res.ok) {
            setMessage({ type: 'success', text: t('albumsManager.albumDeleted', { albumName }) });
            trackAlbumDeleted(albumName);
            // If deleting the currently open album, trigger closing animation
            if (selectedAlbum === albumName) {
              if (closePhotosPanel) {
                closePhotosPanel(); // Triggers animation, then calls deselectAlbum
              } else {
                deselectAlbum(); // Fallback if animation handler not available
              }
            }
            await loadAlbums();
            window.dispatchEvent(new Event('albums-updated'));
          } else {
            const error = await res.json();
            setMessage({ type: 'error', text: error.error || t('albumsManager.failedToDeleteAlbum') });
          }
        } catch (err) {
          setMessage({ type: 'error', text: t('albumsManager.networkErrorOccurred') });
        }
      },
    });
  };

  const handleTogglePublished = async (
    albumName: string,
    currentPublished: boolean,
    event?: React.MouseEvent
  ): Promise<void> => {
    if (event) {
      event.stopPropagation();
    }

    const newPublishedState = !currentPublished;

    try {
      const res = await fetchWithRateLimitCheck(
        `${API_URL}/api/albums/${encodeURIComponent(albumName)}/publish`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ published: newPublishedState }),
        }
      );

      if (res.ok) {
        trackAlbumPublishToggle(albumName, newPublishedState);
        setMessage({
          type: 'success',
          text: `Album "${albumName}" ${newPublishedState ? 'published' : 'unpublished'}`,
        });
        await loadAlbums();
        window.dispatchEvent(new Event('albums-updated'));
      } else {
        const error = await res.json();
        setMessage({ type: 'error', text: error.error || t('albumsManager.failedToUpdateAlbum') });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Network error occurred' });
    }
  };

  const handleToggleHomepage = async (
    albumName: string,
    currentShowOnHomepage: boolean,
    event?: React.MouseEvent
  ): Promise<void> => {
    if (event) {
      event.stopPropagation();
    }

    const newShowOnHomepageState = !currentShowOnHomepage;

    try {
      const res = await fetchWithRateLimitCheck(
        `${API_URL}/api/albums/${encodeURIComponent(albumName)}/show-on-homepage`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ showOnHomepage: newShowOnHomepageState }),
        }
      );

      if (res.ok) {
        trackAlbumHomepageToggle(albumName, newShowOnHomepageState);
        setMessage({
          type: 'success',
          text: `Album "${albumName}" ${newShowOnHomepageState ? 'added to' : 'removed from'} homepage`,
        });
        await loadAlbums();
      } else {
        const error = await res.json();
        setMessage({ type: 'error', text: error.error || t('albumsManager.failedToUpdateAlbum') });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Network error occurred' });
    }
  };

  const handleOpenRenameModal = (albumName: string): void => {
    setRenamingAlbum(albumName);
    setNewAlbumName(albumName);
    setShowRenameModal(true);
  };

  const handleRenameAlbum = async (): Promise<void> => {
    if (!renamingAlbum) return;

    const sanitized = sanitizeName(newAlbumName);

    if (!isValidAlbumName(sanitized)) {
      setMessage({
        type: 'error',
        text: 'Album name can only contain letters, numbers, spaces, hyphens, and underscores',
      });
      return;
    }

    if (sanitized === renamingAlbum) {
      setShowRenameModal(false);
      return;
    }

    if (localAlbums.some(a => a.name === sanitized)) {
      setMessage({ type: 'error', text: t('albumsManager.albumAlreadyExists', { albumName: sanitized }) });
      return;
    }

    try {
      const res = await fetchWithRateLimitCheck(
        `${API_URL}/api/albums/${encodeURIComponent(renamingAlbum)}/rename`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ newName: sanitized }),
        }
      );

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to rename album');
      }

      trackAlbumRenamed(renamingAlbum, sanitized);
      setMessage({ type: 'success', text: t('albumsManager.albumRenamed', { albumName: sanitized }) });
      setShowRenameModal(false);
      setRenamingAlbum(null);
      setNewAlbumName('');

      // If the renamed album was selected, update the selection
      if (selectedAlbum === renamingAlbum) {
        selectAlbum(sanitized);
      }

      await loadAlbums();

      // Dispatch global event to update navigation dropdown
      window.dispatchEvent(new Event('albums-updated'));
    } catch (err) {
      error('Failed to rename album:', err);
      setMessage({ type: 'error', text: t('albumsManager.errorRenamingAlbum') });
    }
  };

  // Inline rename handler for PhotosPanel title editing
  const handleInlineRenameAlbum = async (oldName: string, newName: string): Promise<void> => {
    const sanitized = sanitizeName(newName);

    if (!isValidAlbumName(sanitized)) {
      throw new Error('Album name can only contain letters, numbers, spaces, hyphens, and underscores');
    }

    if (sanitized === oldName) {
      return; // No change
    }

    if (localAlbums.some(a => a.name === sanitized)) {
      throw new Error(t('albumsManager.albumAlreadyExists', { albumName: sanitized }));
    }

    const res = await fetchWithRateLimitCheck(
      `${API_URL}/api/albums/${encodeURIComponent(oldName)}/rename`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ newName: sanitized }),
      }
    );

    if (!res.ok) {
      const errorData = await res.json();
      
      // Map error codes to translated messages
      const errorCode = errorData.errorCode;
      let errorMessage: string;
      
      switch (errorCode) {
        case 'INVALID_ALBUM_NAME':
        case 'INVALID_NEW_NAME':
          errorMessage = t('albumsManager.invalidAlbumName');
          break;
        case 'NAME_REQUIRED':
          errorMessage = t('albumsManager.albumNameRequired');
          break;
        case 'NAME_UNCHANGED':
          errorMessage = t('albumsManager.nameUnchanged');
          break;
        case 'ALBUM_NOT_FOUND':
          errorMessage = t('albumsManager.albumNotFound');
          break;
        case 'ALBUM_EXISTS':
          errorMessage = t('albumsManager.albumAlreadyExists', { albumName: sanitized });
          break;
        case 'DATABASE_UPDATE_FAILED':
          errorMessage = t('albumsManager.databaseUpdateFailed');
          break;
        case 'RENAME_FAILED':
          errorMessage = t('albumsManager.renameAlbumFailed');
          break;
        default:
          errorMessage = errorData.error || t('albumsManager.renameAlbumFailed');
      }
      
      throw new Error(errorMessage);
    }

    trackAlbumRenamed(oldName, sanitized);
    setMessage({ type: 'success', text: t('albumsManager.albumRenamed', { albumName: sanitized }) });

    // If the renamed album was selected, update the selection
    if (selectedAlbum === oldName) {
      selectAlbum(sanitized);
    }

    await loadAlbums();
    window.dispatchEvent(new Event('albums-updated'));
  };

  // Inline description editor for AlbumContentPanelHeader (ticket #621).
  // Throws on failure so the caller can surface the error inline.
  const handleUpdateAlbumDescription = async (
    albumName: string,
    description: string
  ): Promise<void> => {
    const trimmed = description.trim();
    const payload = trimmed.length > 0 ? trimmed : null;

    const res = await fetchWithRateLimitCheck(
      `${API_URL}/api/albums/${encodeURIComponent(albumName)}/description`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ description: payload }),
      }
    );

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.error || t('albumsManager.failedToUpdateAlbum'));
    }

    // Update local cache so the UI reflects the new value without a full reload.
    setLocalAlbums(
      localAlbums.map(album =>
        album.name === albumName
          ? { ...album, description: payload }
          : album
      )
    );

    setMessage({ type: 'success', text: t('albumsManager.albumDescriptionSaved') });

    // Refresh albums in parent state too (so the public-page JSON reload is consistent).
    await loadAlbums();
  };

  // Set or clear an album's cover photo (ticket #693).
  // Pass `filename` to designate that photo as the cover, or `null` to clear and
  // fall back to the first photo by sort order. Updates local state immediately
  // for snappy UI feedback, then reloads albums.
  const handleSetCoverPhoto = async (
    albumName: string,
    filename: string | null
  ): Promise<void> => {
    // Optimistic update so the cover badge moves without waiting for the network
    setLocalAlbums(
      localAlbums.map(album =>
        album.name === albumName
          ? {
              ...album,
              cover_photo: filename,
              effective_cover_photo: filename ?? album.effective_cover_photo,
            }
          : album
      )
    );

    try {
      const res = await fetchWithRateLimitCheck(
        `${API_URL}/api/albums/${encodeURIComponent(albumName)}/cover-photo`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ filename }),
        }
      );

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || t('albumsManager.failedToUpdateCoverPhoto'));
      }

      setMessage({
        type: 'success',
        text: filename
          ? t('albumsManager.coverPhotoSet')
          : t('albumsManager.coverPhotoCleared'),
      });

      await loadAlbums();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('albumsManager.failedToUpdateCoverPhoto');
      setMessage({ type: 'error', text: message });
      // Revert optimistic update by reloading authoritative state
      await loadAlbums();
    }
  };

  const handleMoveAlbumToFolder = async (
    albumName: string,
    folderId: number | null
  ): Promise<void> => {
    const currentAlbum = localAlbums.find(a => a.name === albumName);
    if (!currentAlbum) return;

    const targetFolder = folderId ? localFolders.find(f => f.id === folderId) : null;
    const targetPublishedStatus = targetFolder 
      ? targetFolder.published 
      : (currentAlbum?.published ?? true);

    const updatedAlbums = localAlbums.map(album =>
      album.name === albumName
        ? { ...album, folder_id: folderId, published: targetPublishedStatus }
        : album
    );

    setLocalAlbums(updatedAlbums);

    try {
      const res = await fetchWithRateLimitCheck(
        `${API_URL}/api/albums/${encodeURIComponent(albumName)}/move`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ folderId, published: targetPublishedStatus }),
        }
      );

      if (!res.ok) {
        throw new Error('Failed to move album');
      }

      const folderName = targetFolder?.name || null;
      trackAlbumMovedToFolder(albumName, folderName, folderId);
      setMessage({ type: 'success', text: t('albumsManager.albumMovedTo', { location: folderName || t('albumsManager.uncategorized') }) });
      await loadAlbums();
    } catch (err) {
      setMessage({ type: 'error', text: t('albumsManager.failedToMoveAlbum') });
      // Revert on error
      setLocalAlbums(localAlbums);
    }
  };

  return {
    handleDeleteAlbum,
    handleTogglePublished,
    handleToggleHomepage,
    handleOpenRenameModal,
    handleRenameAlbum,
    handleInlineRenameAlbum,
    handleUpdateAlbumDescription,
    handleSetCoverPhoto,
    handleMoveAlbumToFolder,
  };
};

