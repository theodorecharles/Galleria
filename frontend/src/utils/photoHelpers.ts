/**
 * Photo utility functions for PhotoGrid component
 */

import { Photo, ImageDimensions } from '../types/photo';

/**
 * Reconstruct full photo/video object from optimized array format
 * Album format: [filename, title, media_type, description]
 * Homepage format: [filename, title, album, media_type, description]
 * media_type: 0 = photo, 1 = video
 */
export const reconstructPhoto = (data: any[], albumName: string): Photo => {
  const filename = data[0];
  const title = data[1];
  const albumFromData = typeof data[2] === 'string' ? data[2] : null;
  const mediaTypeIndex = albumFromData ? 3 : 2; // If we have album name, media_type is at index 3, otherwise index 2
  const descriptionIndex = albumFromData ? 4 : 3; // Description is after media_type
  const mediaType = data[mediaTypeIndex] === 1 ? 'video' : 'photo';
  const description = data[descriptionIndex] || undefined;
  
  const photoAlbum = albumFromData || albumName;
  
  // For videos, thumbnail and modal preview are stored in optimized folder as JPG
  // The actual video is served via /api/video endpoints
  const baseFilename = filename.replace(/\.[^.]+$/, '.jpg'); // Replace extension with .jpg for video thumbnails
  const actualFilename = mediaType === 'video' ? baseFilename : filename;
  
  return {
    id: `${photoAlbum}/${filename}`,
    thumbnail: `/optimized/thumbnail/${photoAlbum}/${actualFilename}`,
    modal: `/optimized/modal/${photoAlbum}/${actualFilename}`,
    download: mediaType === 'video' ? '' : `/optimized/download/${photoAlbum}/${filename}`,
    title: title,
    description,
    album: photoAlbum,
    media_type: mediaType
  };
};

/**
 * Get number of columns based on window width and photo count.
 * When custom grid column values are set in branding, those values
 * are used directly (bypassing the small-album special logic).
 */
export const getNumColumns = (photoCount: number): number => {
  const width = window.innerWidth;

  // Check for custom grid column settings from branding
  const branding = (window as any).__RUNTIME_BRANDING__;
  const custom0 = branding?.gridColumns0;
  const custom600 = branding?.gridColumns600;
  const custom900 = branding?.gridColumns900;
  const custom1200 = branding?.gridColumns1200;
  const custom1600 = branding?.gridColumns1600;
  const hasCustom = custom0 != null || custom600 != null || custom900 != null || custom1200 != null || custom1600 != null;

  if (hasCustom) {
    // Use custom values with defaults as fallback
    if (width >= 1600) return custom1600 ?? 5;
    if (width >= 1200) return custom1200 ?? 4;
    if (width >= 900) return custom900 ?? 3;
    if (width >= 600) return custom600 ?? 2;
    return custom0 ?? 1;
  }

  // Default behavior: 1 column on mobile
  if (width < 600) return 1;

  // Small-album special logic
  if (photoCount < 12) return 2;
  if (photoCount >= 12 && photoCount <= 23) return 3;

  // Responsive columns based on width
  if (width >= 1600) return 5;
  if (width >= 1200) return 4;
  if (width >= 900) return 3;
  if (width >= 600) return 2;
  return 1;
};

/**
 * Distribute photos into columns for masonry layout
 */
export const distributePhotos = (
  photos: Photo[], 
  numColumns: number, 
  imageDimensions: ImageDimensions
): Photo[][] => {
  // Initialize columns with empty arrays
  const columns: Photo[][] = Array.from({ length: numColumns }, () => []);

  // Calculate total height for each photo based on its aspect ratio
  const photoHeights = photos.map((photo) => {
    const dimensions = imageDimensions[photo.id];
    if (!dimensions) return 1; // Default to 1 if dimensions not loaded yet
    return dimensions.height / dimensions.width;
  });

  // Initialize column heights
  const columnHeights = Array(numColumns).fill(0);

  // Distribute photos to columns
  photos.forEach((photo, index) => {
    // Find the column with the smallest current height
    let shortestColumnIndex = 0;
    let shortestHeight = columnHeights[0];

    for (let i = 1; i < numColumns; i++) {
      if (columnHeights[i] < shortestHeight) {
        shortestHeight = columnHeights[i];
        shortestColumnIndex = i;
      }
    }

    // If this is the last photo and all columns have the same number of photos,
    // put it in the first column
    if (index === photos.length - 1) {
      const photosPerColumn = Math.floor(photos.length / numColumns);
      const hasExtraPhoto = photos.length % numColumns === 1;

      if (hasExtraPhoto) {
        // Check if all columns have the same number of photos
        const allColumnsEqual = columns.every(
          (col) => col.length === photosPerColumn
        );
        if (allColumnsEqual) {
          shortestColumnIndex = 0;
        }
      }
    }

    // Add photo to the shortest column
    columns[shortestColumnIndex].push(photo);
    columnHeights[shortestColumnIndex] += photoHeights[index];
  });

  return columns;
};

