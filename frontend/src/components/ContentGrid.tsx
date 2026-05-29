/**
 * PhotoGrid component for displaying a grid of photos.
 * This component handles fetching and displaying photos from the backend,
 * and provides functionality for viewing photos in a modal.
 */

import { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../contexts/AuthContext";
import "./ContentGrid.css";
import { API_URL, cacheBustValue } from "../config";
import { trackPhotoClick, trackError } from "../utils/analytics";
import { fetchWithRateLimitCheck } from "../utils/fetchWrapper";
import ContentModal from "./ContentModal";
import NotFound from "./Misc/NotFound";
import { reconstructPhoto, getNumColumns, distributePhotos } from "../utils/photoHelpers";
import { info } from '../utils/logger';
import { VideoIcon } from './icons';

// Lazy load VideoListView (includes VideoPlayer and hls.js)
const VideoListView = lazy(() => import("./VideoListView"));

interface ContentGridProps {
  album: string;
  onAlbumNotFound?: () => void;
  initialPhotos?: Photo[];
  onLoadComplete?: () => void;
  secretKey?: string; // For share link access
}

// Import Photo from canonical location
import type { Photo } from '../types/photo';

const ContentGrid: React.FC<ContentGridProps> = ({ album, onAlbumNotFound, initialPhotos, onLoadComplete, secretKey }) => {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [allPhotos, setAllPhotos] = useState<Photo[]>([]);
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [albumPublished, setAlbumPublished] = useState<boolean>(true);
  // Album-level description / caption (ticket #621). Empty string when there is no
  // description so we can simply skip rendering. Reset on album change.
  const [albumDescription, setAlbumDescription] = useState<string>('');
  const [imageDimensions, setImageDimensions] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const [loadingImages, setLoadingImages] = useState<Set<string>>(new Set());
  const loadedImagesRef = useRef<Set<string>>(new Set()); // Track which images have loaded
  const renderIndexRef = useRef<number>(100);
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isRenderingRef = useRef<boolean>(false);
  
  // Check if album contains only videos
  const isVideoOnlyAlbum = allPhotos.length > 0 && allPhotos.every(photo => photo.media_type === 'video');

  // Detect if this is a touch device
  const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  // Create index map for O(1) lookups (use allPhotos for navigation)
  const photoIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    allPhotos.forEach((photo, index) => {
      map.set(photo.id, index);
    });
    return map;
  }, [allPhotos]);

  // reconstructPhoto function moved to utils/photoHelpers.ts

  // Get query parameters from current URL for API calls (not for images)
  const queryParams = new URLSearchParams(location.search);
  // Remove 'photo' param from API queryString to prevent refetching when opening modals
  queryParams.delete('photo');
  const queryString = queryParams.toString()
    ? `?${queryParams.toString()}&i=${cacheBustValue}`
    : `?i=${cacheBustValue}`;
  
  // For share links, include the key parameter for accessing unpublished content
  const imageQueryString = secretKey ? `?key=${secretKey}` : ``;

  const [clickedVideoId, setClickedVideoId] = useState<string | null>(null);

  // Check if we're on the homepage
  const isHomepage = album === 'homepage';

  const handlePhotoClick = (photo: Photo, shouldAutoplay: boolean = false) => {
    setSelectedPhoto(photo);
    const index = photoIndexMap.get(photo.id) ?? 0;
    setSelectedPhotoIndex(index);
    trackPhotoClick(photo.id, photo.album, photo.title);
    
    // Track if user clicked a video AND should autoplay (play button clicked)
    if (photo.media_type === 'video' && shouldAutoplay) {
      setClickedVideoId(photo.id);
    } else {
      setClickedVideoId(null);
    }
  };

  const handleNavigatePrev = useCallback(() => {
    const prevIndex = (selectedPhotoIndex - 1 + allPhotos.length) % allPhotos.length;
    const prevPhoto = allPhotos[prevIndex];
    setSelectedPhoto(prevPhoto);
    setSelectedPhotoIndex(prevIndex);
  }, [selectedPhotoIndex, allPhotos]);

  const handleNavigateNext = useCallback(() => {
    const nextIndex = (selectedPhotoIndex + 1) % allPhotos.length;
    const nextPhoto = allPhotos[nextIndex];
    setSelectedPhoto(nextPhoto);
    setSelectedPhotoIndex(nextIndex);
  }, [selectedPhotoIndex, allPhotos]);

  const handleCloseModal = () => {
    setSelectedPhoto(null);
  };

  // Close modal when album changes
  useEffect(() => {
    setSelectedPhoto(null);
    setColumnTransforms([]);
    renderIndexRef.current = 100;
    loadedImagesRef.current.clear(); // Reset loaded images tracking
    setAlbumDescription(''); // Clear stale description on album switch (ticket #621)
  }, [album]);

  // Update column count when photos change
  useEffect(() => {
    setNumColumns(getNumColumns(photos.length));
  }, [photos.length]);

  // Preload first 6 thumbnail images for faster initial render
  useEffect(() => {
    if (photos.length > 0) {
      const preloadCount = Math.min(6, photos.length);
      photos.slice(0, preloadCount).forEach((photo) => {
        const link = document.createElement('link');
        link.rel = 'preload';
        link.as = 'image';
        link.href = photo.thumbnail;
        document.head.appendChild(link);
      });
    }
  }, [photos]);

  // Auto-open photo from URL query parameter
  useEffect(() => {
    if (allPhotos.length > 0 && !selectedPhoto) {
      const urlParams = new URLSearchParams(location.search);
      const photoParam = urlParams.get('photo');
      if (photoParam) {
        // Find photo by id. Ids are structured `<album>/<filename>`, so we must
        // compare the album too — otherwise a filename shared across albums opens
        // whichever photo happens to be first in array order (ticket #1048).
        // On album pages the route's `album` matches the photo's source album, so an
        // exact id comparison is correct. The homepage feed is sourced from multiple
        // albums and the share link carries only the filename, so there we fall back
        // to an exact filename match (still avoids endsWith partial-suffix collisions).
        const photo = allPhotos.find(p =>
          isHomepage
            ? p.id.split('/').pop() === photoParam
            : p.id === `${album}/${photoParam}`
        );
        if (photo) {
          handlePhotoClick(photo);
        }
      }
    }
  }, [allPhotos]);
  
  // Scroll-based rendering - add more photos while actively scrolling
  useEffect(() => {
    if (allPhotos.length === 0 || photos.length >= allPhotos.length) {
      return; // Nothing more to render
    }
    
    const handleScroll = () => {
      // Clear existing timeout
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      
      // Add 100 more photos immediately if not already rendering
      if (!isRenderingRef.current && renderIndexRef.current < allPhotos.length) {
        isRenderingRef.current = true;
        const newIndex = Math.min(renderIndexRef.current + 100, allPhotos.length);
        renderIndexRef.current = newIndex;
        setPhotos(allPhotos.slice(0, newIndex));
        
        // Allow next render after a brief delay
        setTimeout(() => {
          isRenderingRef.current = false;
        }, 50);
      }
      
      // Set timeout to detect when scrolling stops
      scrollTimeoutRef.current = setTimeout(() => {
        // Scrolling stopped - no more rendering until they scroll again
      }, 150);
    };
    
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll);
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, [allPhotos, photos.length]);

  useEffect(() => {
    // If initialPhotos provided, use them directly (for shared albums)
    if (initialPhotos) {
      setAllPhotos(initialPhotos);
      setPhotos(initialPhotos.slice(0, 100));
      setLoading(false);
      setError(null);
      onLoadComplete?.();
      return;
    }

    const fetchPhotos = async () => {
      try {
        // Check if homepage data was server-side rendered (SSR) into the page
        const initialData = (window as any).__INITIAL_DATA__;
        
        if (album === "homepage" && initialData && initialData.homepage) {
          // Data is already here - no loading state needed!
          // Use pre-injected homepage data from SSR (no network requests!)
          info("✓ Using server-side rendered homepage data (no network requests)");
          const homepageData = initialData.homepage;
          
          let staticPhotos;
          let shouldShuffle = false;
          
          if (homepageData && typeof homepageData === 'object' && 'photos' in homepageData) {
            // Homepage format with metadata
            shouldShuffle = homepageData.shuffle ?? true;
            staticPhotos = homepageData.photos.map((data: string[]) => reconstructPhoto(data, album));
            info(`✓ Loaded ${staticPhotos.length} photos from SSR data (shuffle: ${shouldShuffle})`);
            
            // Shuffle homepage photos for random display order each time (if enabled)
            if (shouldShuffle) {
              staticPhotos = [...staticPhotos].sort(() => Math.random() - 0.5);
              info(`ℹ️  Shuffled ${staticPhotos.length} homepage photos`);
            } else {
              info(`ℹ️  Homepage shuffle disabled - displaying in order`);
            }
          } else {
            // Legacy format (array of photos)
            const photoArray = Array.isArray(homepageData) ? homepageData : (homepageData.photos || []);
            staticPhotos = photoArray.map((data: string[]) => reconstructPhoto(data, album));
            info(`✓ Loaded ${staticPhotos.length} photos from SSR data`);
          }
          
          // Show first 100 immediately
          setAllPhotos(staticPhotos);
          setPhotos(staticPhotos.slice(0, 100));
          setLoading(false);
          setError(null);
          onLoadComplete?.();
          
          // Clear only the homepage SSR data after using it (keep albums/links for App.tsx)
          if ((window as any).__INITIAL_DATA__) {
            delete (window as any).__INITIAL_DATA__.homepage;
          }
          return;
        }

        // No SSR data, show loading state
        setLoading(true);

        // Try to fetch from static JSON first for better performance
        // Use authenticated endpoint to prevent unauthorized access to unpublished albums
        const staticJsonUrl = album === "homepage" 
          ? `/albums-data/homepage.json`  // Homepage is always public
          : `${API_URL}/api/albums/${album}/photos-json`;  // Album JSON requires auth check
        
        try {
          // Disable caching to ensure we always get the latest JSON after publish/unpublish
          const staticResponse = await fetch(staticJsonUrl, { 
            cache: 'no-store',
            credentials: 'include' // Include auth cookies for unpublished albums
          });
          if (staticResponse.ok) {
            const staticData = await staticResponse.json();
            
            // Handle homepage format: { shuffle: boolean, photos: [...] }
            let staticPhotos;
            let shouldShuffle = false;
            
            if (album === "homepage" && staticData && typeof staticData === 'object' && 'photos' in staticData) {
              // New homepage format with metadata
              shouldShuffle = staticData.shuffle ?? true;
              staticPhotos = staticData.photos.map((data: string[]) => reconstructPhoto(data, album));
              info(`✓ Loaded ${staticPhotos.length} photos from homepage JSON (shuffle: ${shouldShuffle})`);
              
              // Shuffle homepage photos for random display order each time (if enabled)
              if (shouldShuffle) {
                staticPhotos = [...staticPhotos].sort(() => Math.random() - 0.5);
                info(`ℹ️  Shuffled ${staticPhotos.length} homepage photos`);
              } else {
                info(`ℹ️  Homepage shuffle disabled - displaying in order`);
              }
            } else {
              // Album JSON shape (ticket #621): { description: string|null, photos: [...] }
              // Legacy shape (pre-#621): bare array of photo arrays. Both are tolerated.
              const photoArray = Array.isArray(staticData) ? staticData : (staticData.photos || []);
              staticPhotos = photoArray.map((data: string[]) => reconstructPhoto(data, album));
              if (!Array.isArray(staticData) && typeof staticData?.description === 'string') {
                setAlbumDescription(staticData.description);
              }
              info(`✓ Loaded ${staticPhotos.length} photos from optimized static JSON (${album})`);
            }
            
            // Show first 100 immediately
            setAllPhotos(staticPhotos);
            setPhotos(staticPhotos.slice(0, 100));
            setLoading(false);
            
            setError(null);
            onLoadComplete?.();
            return;
          }
        } catch (staticError) {
          // Static JSON not available or failed, fall back to API
          info(`⚠️  Static JSON unavailable for ${album}, falling back to API`);
        }

        // Fallback to API if static JSON is not available
        if (album === "homepage") {
          // Use the random photos endpoint for homepage
          const response = await fetchWithRateLimitCheck(
            `${API_URL}/api/random-photos${queryString}`
          );
          if (!response.ok) {
            throw new Error("Failed to fetch random photos");
          }
          const randomPhotos = await response.json();
          setAllPhotos(randomPhotos);
          setPhotos(randomPhotos.slice(0, 100));
        } else {
          // Fetch all photos from the album
          const response = await fetchWithRateLimitCheck(
            `${API_URL}/api/albums/${album}/photos${queryString}`
          );
          if (!response.ok) {
            if (response.status === 404 || response.status === 403) {
              throw new Error("ALBUM_NOT_FOUND");
            }
            throw new Error("Failed to fetch photos");
          }
          const data = await response.json();
          const photosArray = Array.isArray(data) ? data : (data.photos || []);

          // Check if album is published (from API response)
          const published = typeof data === 'object' && 'published' in data ? data.published : true;
          setAlbumPublished(published);

          // Pull album-level description from API fallback path too (ticket #621)
          if (typeof data === 'object' && typeof data?.description === 'string') {
            setAlbumDescription(data.description);
          }
          
          // Sort photos by creation date
          const sortedPhotos = photosArray.sort((a: Photo, b: Photo) => {
            if (!a.metadata || !b.metadata) return 0;
            return (
              new Date(b.metadata.created).getTime() -
              new Date(a.metadata.created).getTime()
            );
          });
          
          // Show first 100 immediately
          setAllPhotos(sortedPhotos);
          setPhotos(sortedPhotos.slice(0, 100));
        }

        setError(null);
        onLoadComplete?.();
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "An error occurred";
        // Don't log rate limit errors (already handled globally)
        if (errorMessage === 'Rate limited') {
          return;
        }
        setError(errorMessage);
        setPhotos([]);
        trackError(errorMessage, `photo_fetch_${album}`);
      } finally {
        setLoading(false);
      }
    };

    fetchPhotos();
  }, [album, queryString, initialPhotos]);

  const handleImageLoad = (
    e: React.SyntheticEvent<HTMLImageElement>,
    photoId: string
  ) => {
    const img = e.currentTarget;
    img.classList.add("loaded");
    setImageDimensions((prev) => ({
      ...prev,
      [photoId]: {
        width: img.naturalWidth,
        height: img.naturalHeight,
      },
    }));
    // Mark as loaded
    loadedImagesRef.current.add(photoId);
    // Remove from loading set
    setLoadingImages((prev) => {
      const newSet = new Set(prev);
      newSet.delete(photoId);
      return newSet;
    });
  };

  // Mark only NEW photos as loading (don't reset already-loaded ones)
  useEffect(() => {
    setLoadingImages((prev) => {
      const newSet = new Set(prev);
      photos.forEach(photo => {
        // Only add if not already loaded
        if (!loadedImagesRef.current.has(photo.id)) {
          newSet.add(photo.id);
        }
      });
      return newSet;
    });
  }, [photos]);

  // getNumColumns function moved to utils/photoHelpers.ts

  // State for number of columns
  const [numColumns, setNumColumns] = useState(getNumColumns(photos.length));
  
  // Refs for column elements and their transforms
  const columnRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [columnTransforms, setColumnTransforms] = useState<number[]>([]);
  const shiftPointRef = useRef<number | null>(null);
  const hasReachedBottomRef = useRef(false);

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      setNumColumns(getNumColumns(photos.length));
      // On resize, switch to full-page calculation if we have a shift point
      if (shiftPointRef.current !== null) {
        hasReachedBottomRef.current = true;
        shiftPointRef.current = 0;
      }
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [photos.length]);

  // distributePhotos function moved to utils/photoHelpers.ts

  // Effect to handle scroll-based column alignment
  useEffect(() => {
    // Only apply the effect if there is more than one column
    if (numColumns <= 1) {
      setColumnTransforms([]);
      shiftPointRef.current = null;
      return;
    }

    const handleScroll = () => {
      if (photos.length === 0 || !columnRefs.current.length) return;

      // Check if all images have loaded
      const allImagesLoaded = photos.every(photo => imageDimensions[photo.id]);
      
      // If all images just loaded and we haven't set the shift point yet, capture it
      if (allImagesLoaded && shiftPointRef.current === null && !hasReachedBottomRef.current) {
        shiftPointRef.current = window.scrollY;
      }
      
      // Don't apply transforms until we have a shift point
      if (!allImagesLoaded || shiftPointRef.current === null) {
        return;
      }

      const columnHeights = columnRefs.current.map((col) => col?.offsetHeight || 0);
      const maxHeight = Math.max(...columnHeights);
      
      if (maxHeight === 0) return;

      // Get scroll metrics
      const scrollY = window.scrollY;
      const windowHeight = window.innerHeight;
      const documentHeight = document.documentElement.scrollHeight;
      const maxScroll = documentHeight - windowHeight;
      
      // Check if user has reached the bottom (with small threshold for rounding)
      if (scrollY >= maxScroll - 5 && !hasReachedBottomRef.current) {
        hasReachedBottomRef.current = true;
        shiftPointRef.current = 0;
      }
      
      // Calculate scroll progress
      let scrollProgress = 0;
      
      if (hasReachedBottomRef.current) {
        // Full-page calculation: Progress = 0 at top, Progress = 1 at bottom
        scrollProgress = maxScroll > 0 ? scrollY / maxScroll : 0;
      } else {
        // Shift-point-based calculation
        const shiftPoint = shiftPointRef.current;
        
        if (scrollY <= shiftPoint) {
          // Above shift point - no transforms
          scrollProgress = 0;
        } else if (scrollY >= maxScroll) {
          // At bottom - full transforms
          scrollProgress = 1;
        } else {
          // Between shift point and bottom - calculate progress
          const scrollRange = maxScroll - shiftPoint;
          if (scrollRange > 0) {
            scrollProgress = (scrollY - shiftPoint) / scrollRange;
          }
        }
      }

      // Calculate transforms for each column
      const transforms = columnHeights.map((height) => {
        // Tallest column doesn't move
        if (height === maxHeight) return 0;
        
        const heightDiff = maxHeight - height;
        // Apply transform based on scroll progress
        return heightDiff * scrollProgress;
      });

      setColumnTransforms(transforms);
    };

    // Initial calculation
    handleScroll();

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [photos, numColumns, imageDimensions]);
  
  // Reset shift point when photos change
  useEffect(() => {
    shiftPointRef.current = null;
    hasReachedBottomRef.current = false;
  }, [photos]);

  // Memoize the column distribution to avoid recomputing on every render
  const distributedColumns = useMemo(
    () => distributePhotos(photos, numColumns, imageDimensions),
    [photos, numColumns, imageDimensions]
  );

  if (loading) {
    return (
      <div className="photo-grid-loading">
        <div className="loading-spinner"></div>
        <p>{t('app.loadingAlbum')}</p>
      </div>
    );
  }

  if (error) {
    if (error === "ALBUM_NOT_FOUND") {
      // Update URL to /404 and notify parent component to hide album title
      if (location.pathname !== '/404') {
        navigate('/404', { replace: true });
      }
      if (onAlbumNotFound) {
        onAlbumNotFound();
      }
      return <NotFound />;
    }
    return <div className="error">Error: {error}</div>;
  }

  // Empty state - no photos in the album
  if (photos.length === 0) {
    const isHomepage = album === 'homepage';
    return (
      <div className="empty-state">
        <div className="empty-icon">📸</div>
        <h2>{t('photo.noContentYet')}</h2>
        <p>{isHomepage ? t('photo.homepageEmpty') : t('photo.albumEmpty')}</p>
        <a href="/admin" className="empty-state-button">
          {t('photo.goToAdminPanel')}
        </a>
      </div>
    );
  }

  // Video-only album - use list view instead of grid
  if (isVideoOnlyAlbum) {
    // Check if user has access to unpublished video albums
    if (!albumPublished && !isAuthenticated) {
      // Show 404 for unpublished video albums when not authenticated
      if (location.pathname !== '/404') {
        navigate('/404', { replace: true });
      }
      if (onAlbumNotFound) {
        onAlbumNotFound();
      }
      return <NotFound />;
    }
    return (
      <Suspense fallback={
        <div className="photo-grid-loading">
          <div className="loading-spinner"></div>
          <p>{t('app.loadingAlbum')}</p>
        </div>
      }>
        <VideoListView videos={allPhotos} album={album} secretKey={secretKey} albumPublished={albumPublished} />
      </Suspense>
    );
  }

  return (
    <>
      {albumDescription && album !== 'homepage' && (
        <div className="album-description-public">{albumDescription}</div>
      )}
      <div className="photo-grid" style={{ gridTemplateColumns: `repeat(${numColumns}, 1fr)` }}>
        {distributedColumns.map((column, columnIndex) => (
          <div 
            key={columnIndex} 
            className="photo-column"
            ref={(el) => { columnRefs.current[columnIndex] = el; }}
            style={{
              transform: columnTransforms[columnIndex] 
                ? `translateY(${columnTransforms[columnIndex]}px)` 
                : 'none'
            }}
          >
            {column.map((photo) => (
              <div
                key={photo.id}
                className={`photo-item ${loadingImages.has(photo.id) ? 'loading' : ''} ${photo.media_type === 'video' ? 'video-item' : ''}`}
                style={{
                  aspectRatio: imageDimensions[photo.id]
                    ? `${imageDimensions[photo.id].width} / ${
                        imageDimensions[photo.id].height
                      }`
                    : "4 / 3",
                }}
                onClick={() => {
                  // On mobile/touch devices, open videos directly (no play button)
                  const shouldAutoplay = photo.media_type === 'video' && isTouchDevice;
                  handlePhotoClick(photo, shouldAutoplay);
                }}
              >
                {loadingImages.has(photo.id) && (
                  <div className="photo-loading-overlay">
                    <div className="photo-loading-spinner"></div>
                  </div>
                )}
                <img
                  src={`${API_URL}${photo.thumbnail}${imageQueryString}`}
                  alt={`${photo.album} - ${photo.title}`}
                  title={photo.title}
                  onLoad={(e) => handleImageLoad(e, photo.id)}
                />
                {photo.media_type === 'video' && (
                  <div className="video-icon-overlay">
                    <VideoIcon width="20" height="20" />
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      {selectedPhoto && (
          <ContentModal
          selectedPhoto={selectedPhoto}
          album={album}
          currentIndex={selectedPhotoIndex}
          totalPhotos={allPhotos.length}
          onNavigatePrev={handleNavigatePrev}
          onNavigateNext={handleNavigateNext}
          onClose={handleCloseModal}
          clickedVideo={clickedVideoId === selectedPhoto.id}
          secretKey={secretKey}
          isHomepage={isHomepage}
        />
      )}
    </>
  );
};

export default ContentGrid;
