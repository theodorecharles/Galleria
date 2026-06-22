/**
 * Canonical Photo type definitions
 * Used across the application for photo data structures
 */

/**
 * Photo interface - represents a photo with all its variants and metadata
 */
export interface Photo {
  id: string;
  thumbnail: string;
  modal: string;
  download: string;
  title: string;
  description?: string;
  album: string;
  media_type?: 'photo' | 'video';
  downloads_enabled?: boolean;
  metadata?: {
    created: string;
    modified: string;
    size: number;
  };
  exif?: any;
  // Error states for post-upload processing
  optimizationError?: string;
  aiError?: string;
  // Note: Legacy 'src' field removed - original photos are not served via API
  // Only optimized versions (thumbnail, modal, download) are accessible
}

/**
 * Image dimensions for masonry grid layout calculations
 */
export interface ImageDimensions {
  [photoId: string]: {
    width: number;
    height: number;
  };
}
