/**
 * Shared types for AlbumsManager
 */

import { Album, AlbumFolder, Photo } from '../types';

export type UploadState = 'queued' | 'uploading' | 'optimizing' | 'generating-title' | 'complete' | 'error';

// Use AlbumFolder from parent types instead of defining a separate Folder interface
export type Folder = AlbumFolder;

export interface UploadingImage {
  file: File;
  filename: string;
  state: UploadState;
  thumbnailUrl?: string;
  error?: string;
  progress?: number;
  optimizeProgress?: number; // 0-100 for overall optimization progress (shown in circle)
  uploadIndex?: number; // Track original position in upload batch for maintaining order
  photo?: Photo; // When state='complete', this contains the complete photo data
  retryCount?: number; // Number of retry attempts (max 5)
  videoStage?: string; // Track specific video processing stage (rotation, 240p, 360p, etc.)
  videoStageProgress?: number; // 0-100 for individual stage progress (shown next to stage name)
  message?: string; // Additional message from processing
  isRetryable?: boolean; // Whether this error can be retried (defaults to true)
}

export interface AlbumsManagerProps {
  albums: Album[];
  folders: AlbumFolder[];
  loadAlbums: () => Promise<void>;
  setMessage: (message: { type: 'success' | 'error'; text: string }) => void;
  userRole: 'admin' | 'manager' | 'viewer';
}

export interface ConfirmModalConfig {
  message: string;
  onConfirm: () => void;
  confirmText?: string;
  isDanger?: boolean;
  /** Optional explicit modal title. When omitted, the modal infers one from `photo`/defaults. */
  title?: string;
  photo?: {
    thumbnail: string;
    title?: string;
    filename: string;
  };
}

// Re-export types from parent
export type { Album, AlbumFolder, Photo };
