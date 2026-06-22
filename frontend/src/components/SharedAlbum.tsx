/**
 * SharedAlbum Component
 * Displays an album accessed via a share link
 */

import { useEffect, useState, useRef, lazy, Suspense } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ContentGrid from './ContentGrid';
import { API_URL } from '../config';
import { trackSharedAlbumView } from '../utils/analytics';
import ExpiredLink from './Misc/ExpiredLink';

// Lazy load VideoListView (includes VideoPlayer and hls.js)
const VideoListView = lazy(() => import('./VideoListView'));
import NotFound from './Misc/NotFound';
import Header, { ExternalLink } from './Header';
import Footer from './Footer';
import '../App.css'; // Import for main-content-title styles
import { error as logError, warn, info } from '../utils/logger';

interface Photo {
  id: string;
  src: string;
  thumbnail: string;
  modal: string;
  download: string;
  title: string;
  album: string;
  downloads_enabled?: boolean;
  sort_order?: number | null;
  metadata?: {
    created: string;
    modified: string;
    size: number;
  };
  exif?: any;
}

interface ToastMessage {
  id: number;
  type: 'success' | 'error';
  text: string;
}

export default function SharedAlbum() {
  const { t } = useTranslation();
  const { secretKey } = useParams();
  const [searchParams] = useSearchParams();
  const videoParam = searchParams.get('video'); // Get ?video=filename from URL
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [albumName, setAlbumName] = useState<string | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [messages, setMessages] = useState<ToastMessage[]>([]);
  const [timeRemaining, setTimeRemaining] = useState<string>('');
  const [siteName, setSiteName] = useState<string>('');
  const [headerAvatarPath, setHeaderAvatarPath] = useState<string>('/photos/avatar-header.webp');
  const [headerAvatarBase64, setHeaderAvatarBase64] = useState<string | null>(null);
  const [avatarCacheBust, setAvatarCacheBust] = useState<number>(0);
  const [albums, setAlbums] = useState<string[]>([]);
  const [externalLinks, setExternalLinks] = useState<ExternalLink[]>([]);
  
  // Ref to prevent duplicate API calls in React StrictMode (development)
  const hasCalledApi = useRef(false);

  useEffect(() => {
    // Reset the ref when secretKey changes
    hasCalledApi.current = false;
    
    const validateShareLink = async () => {
      if (!secretKey) {
        setError('Invalid share link');
        setLoading(false);
        return;
      }

      // Prevent duplicate API calls in React StrictMode
      if (hasCalledApi.current) {
        return;
      }
      hasCalledApi.current = true;

      try {
        // Load data in parallel
        const [brandingResponse, albumsResponse, externalLinksResponse, shareResponse] = await Promise.all([
          fetch(`${API_URL}/api/branding`),
          fetch(`${API_URL}/api/albums`),
          fetch(`${API_URL}/api/external-pages`),
          fetch(`${API_URL}/api/shared/${secretKey}`),
        ]);

        // Handle branding
        if (brandingResponse.ok) {
          const branding = await brandingResponse.json();
          setSiteName(branding.siteName);
          setHeaderAvatarPath(branding.headerAvatarPath || '/photos/avatar-header.webp');
          setHeaderAvatarBase64(branding.headerAvatarBase64 || null);
          setAvatarCacheBust(branding.avatarCacheBust || 0);
        }

        // Handle albums
        if (albumsResponse.ok) {
          const albumsData = await albumsResponse.json();
          // Handle new API format with folders or old format (array)
          if (albumsData && typeof albumsData === 'object' && 'albums' in albumsData) {
            // New format - extract album names from published albums only
            const publishedAlbums = (albumsData.albums || [])
              .filter((album: any) => album.name !== 'homepage' && album.published)
              .map((album: any) => album.name);
            setAlbums(publishedAlbums);
          } else if (Array.isArray(albumsData)) {
            // Old format
            const albumNames = albumsData
              .filter((album: any) => {
                if (typeof album === 'string') return album !== 'homepage';
                return album.name !== 'homepage' && album.published;
              })
              .map((album: any) => typeof album === 'string' ? album : album.name);
            setAlbums(albumNames);
          }
        }

        // Handle external links
        if (externalLinksResponse.ok) {
          const linksData = await externalLinksResponse.json();
          info('SharedAlbum: External links loaded:', linksData);
          // API returns { externalLinks: [...] }, extract the array
          const linksArray = linksData.externalLinks || linksData || [];
          setExternalLinks(linksArray);
        } else {
          warn('SharedAlbum: External links response not ok:', externalLinksResponse.status);
        }
        
        // Handle share link validation
        if (shareResponse.status === 410) {
          // Link expired
          setExpired(true);
          setLoading(false);
          return;
        }
        
        if (!shareResponse.ok) {
          setError('Share link not found');
          setLoading(false);
          return;
        }

        const data = await shareResponse.json();
        setAlbumName(data.album);
        setPhotos(data.photos || []);
        setExpiresAt(data.expiresAt);
        
        // Track shared album view (hash secret key for privacy)
        if (secretKey && data.album) {
          // Simple hash: use first 16 chars of secret key (already 64 hex chars)
          // This provides enough uniqueness while maintaining privacy
          const hashedKey = secretKey.substring(0, 16);
          trackSharedAlbumView(data.album, hashedKey);
        }
        
        setLoading(false);
      } catch (err) {
        logError('Error validating share link:', err);
        setError('Failed to load shared album');
        setLoading(false);
      }
    };

    validateShareLink();
  }, [secretKey]);

  // Helper to add a toast message
  const addMessage = (message: { type: 'success' | 'error'; text: string }) => {
    const newMessage = { ...message, id: Date.now() + Math.random() };
    setMessages(prev => [newMessage, ...prev]);
    
    // Auto-dismiss after 5 seconds
    setTimeout(() => {
      setMessages(prev => prev.filter(m => m.id !== newMessage.id));
    }, 5000);
  };

  const removeMessage = (id: number) => {
    setMessages(prev => prev.filter(m => m.id !== id));
  };

  // Countdown timer for expiration warnings and display
  useEffect(() => {
    if (!expiresAt) {
      setTimeRemaining('');
      return; // No expiration
    }

    const shownWarnings = new Set<string>();

    const checkExpiration = () => {
      const now = Date.now();
      const expiresAtTime = new Date(expiresAt).getTime();
      const timeLeft = expiresAtTime - now;
      const secondsLeft = Math.floor(timeLeft / 1000);
      const minutesLeft = Math.floor(timeLeft / 60000);
      const hoursLeft = Math.floor(timeLeft / 3600000);

      // Update countdown display - only show when 30 minutes or less remain
      if (minutesLeft <= 30) {
        if (timeLeft <= 0) {
          setTimeRemaining('EXPIRED');
        } else if (hoursLeft > 0) {
          const mins = Math.floor((timeLeft % 3600000) / 60000);
          const secs = Math.floor((timeLeft % 60000) / 1000);
          setTimeRemaining(`${hoursLeft}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`);
        } else if (minutesLeft > 0) {
          const secs = Math.floor((timeLeft % 60000) / 1000);
          setTimeRemaining(`${minutesLeft}:${secs.toString().padStart(2, '0')}`);
        } else {
          setTimeRemaining(`0:${secondsLeft.toString().padStart(2, '0')}`);
        }
      } else {
        setTimeRemaining(''); // Hide timer when more than 30 minutes left
      }

      if (timeLeft <= 0 && !shownWarnings.has('expired')) {
        shownWarnings.add('expired');
        addMessage({ type: 'error', text: 'EXPIRED!!!' });
        setTimeout(() => {
          setExpired(true);
        }, 2000);
        return;
      }

      // Show warnings at specific times (only once per warning)
      if (secondsLeft === 5 && !shownWarnings.has('5s')) {
        shownWarnings.add('5s');
        addMessage({ type: 'error', text: '5 seconds left!' });
      } else if (secondsLeft === 10 && !shownWarnings.has('10s')) {
        shownWarnings.add('10s');
        addMessage({ type: 'error', text: '10 seconds left!' });
      } else if (secondsLeft === 30 && !shownWarnings.has('30s')) {
        shownWarnings.add('30s');
        addMessage({ type: 'error', text: '30 seconds left to look at this album!' });
      } else if (minutesLeft === 1 && secondsLeft >= 58 && secondsLeft <= 60 && !shownWarnings.has('1m')) {
        shownWarnings.add('1m');
        addMessage({ type: 'error', text: '1 minute left!' });
      } else if (minutesLeft === 2 && secondsLeft >= 118 && secondsLeft <= 120 && !shownWarnings.has('2m')) {
        shownWarnings.add('2m');
        addMessage({ type: 'error', text: '2 minutes left to look at this album!' });
      } else if (minutesLeft === 5 && secondsLeft >= 298 && secondsLeft <= 300 && !shownWarnings.has('5m')) {
        shownWarnings.add('5m');
        addMessage({ type: 'error', text: '5 minutes left to look at this album!' });
      }
    };

    // Check immediately and then every second
    checkExpiration();
    const interval = setInterval(checkExpiration, 1000);

    return () => clearInterval(interval);
  }, [expiresAt]);

  if (loading) {
    return <div className="loading">{t('common.loadingSharedAlbum')}</div>;
  }

  if (expired) {
    return <ExpiredLink />;
  }

  if (error || !albumName) {
    return <NotFound />;
  }

  info('SharedAlbum rendering Header with:', { 
    albumsCount: albums.length, 
    externalLinksCount: externalLinks.length,
    externalLinks 
  });

  // If videoParam is provided, filter to show only that video
  const displayPhotos = videoParam 
    ? photos.filter(photo => {
        const filename = photo.id.split('/').pop();
        return filename === decodeURIComponent(videoParam);
      })
    : photos;

  // Check if showing only videos
  const allVideos = displayPhotos.every(photo => photo.id.toLowerCase().match(/\.(mp4|mov|avi|mkv|webm)$/));

  return (
    <>
      <Header
        albums={albums}
        externalLinks={externalLinks}
        currentAlbum={albumName}
        siteName={siteName}
        headerAvatarPath={headerAvatarPath}
        headerAvatarBase64={headerAvatarBase64}
        avatarCacheBust={avatarCacheBust}
      />
      <main className="main-content">
        {albumName && !videoParam && (
          <h1 className="main-content-title">
            {albumName}
          </h1>
        )}
        {allVideos && albumName ? (
          <Suspense fallback={
            <div className="photo-grid-loading">
              <div className="loading-spinner"></div>
              <p>{t('common.loading')}</p>
            </div>
          }>
            <VideoListView videos={displayPhotos} album={albumName} secretKey={secretKey} />
          </Suspense>
        ) : (
          <>
            {albumName && videoParam && (
              <h1 className="main-content-title">
                {displayPhotos[0]?.title || albumName}
              </h1>
            )}
            <ContentGrid album={albumName} initialPhotos={displayPhotos} secretKey={secretKey} />
          </>
        )}
      </main>
      
      {/* Countdown timer at bottom */}
      {timeRemaining && (
        <div className="countdown-timer">
          <span className="countdown-label">Time remaining:</span>
          <span className={`countdown-value ${
            timeRemaining === 'EXPIRED' ? 'expired' : 
            expiresAt && (new Date(expiresAt).getTime() - Date.now()) < 30000 ? 'critical' :
            expiresAt && (new Date(expiresAt).getTime() - Date.now()) < 120000 ? 'warning' :
            ''
          }`}>
            {timeRemaining}
          </span>
        </div>
      )}
      
      {/* Toast notifications */}
      <div className="toast-container">
        {messages.map((message, index) => (
          <div 
            key={message.id} 
            className={`toast toast-${message.type}`}
            style={{ top: `${80 + index * 80}px` }}
          >
            <div className="toast-content">
              <span className="toast-icon">
                {message.type === 'success' ? '✓' : '⚠'}
              </span>
              <span className="toast-text">{message.text}</span>
              <button 
                className="toast-close"
                onClick={() => removeMessage(message.id)}
                aria-label="Close notification"
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
      
      <style>{`
        /* Toast Notification Container */
        .toast-container {
          position: fixed;
          top: 0;
          right: 20px;
          z-index: 9999;
          pointer-events: none;
        }

        /* Toast Notification */
        .toast {
          position: fixed;
          right: 20px;
          min-width: 300px;
          max-width: 500px;
          padding: 1rem 1.25rem;
          border-radius: 8px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), 0 2px 8px rgba(0, 0, 0, 0.2);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          animation: slideInRight 0.3s ease-out;
          transition: top 0.3s ease;
          pointer-events: all;
        }

        @keyframes slideInRight {
          from {
            transform: translateX(400px);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }

        .toast-content {
          display: flex;
          align-items: center;
          gap: 0.75rem;
        }

        .toast-icon {
          font-size: 1.5rem;
          flex-shrink: 0;
          line-height: 1;
        }

        .toast-text {
          flex: 1;
          font-size: 0.95rem;
          line-height: 1.5;
        }

        .toast-close {
          background: none;
          border: none;
          color: inherit;
          font-size: 1.75rem;
          line-height: 1;
          padding: 0;
          margin-left: 0.5rem;
          cursor: pointer;
          opacity: 0.6;
          transition: opacity 0.2s ease, transform 0.2s ease;
          flex-shrink: 0;
          width: 24px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .toast-close:hover {
          opacity: 1;
          transform: scale(1.1);
        }

        .toast-close:active {
          transform: scale(0.95);
        }

        .toast-success {
          background: linear-gradient(135deg, rgba(26, 77, 46, 0.95) 0%, rgba(20, 60, 36, 0.95) 100%);
          border: 1.5px solid #4ade80;
          color: #4ade80;
        }

        .toast-success .toast-icon {
          color: #4ade80;
        }

        .toast-error {
          background: linear-gradient(135deg, rgba(77, 26, 26, 0.95) 0%, rgba(60, 20, 20, 0.95) 100%);
          border: 1.5px solid #f87171;
          color: #f87171;
        }

        .toast-error .toast-icon {
          color: #f87171;
        }

        @media (max-width: 600px) {
          .toast-container {
            right: 10px;
            left: 10px;
          }
          
          .toast {
            right: 10px;
            left: 10px;
            min-width: auto;
          }
        }

        /* Countdown timer */
        .countdown-timer {
          position: fixed;
          bottom: 20px;
          left: 50%;
          transform: translateX(-50%);
          background: linear-gradient(135deg, rgba(26, 26, 26, 0.95) 0%, rgba(15, 15, 15, 0.95) 100%);
          border: 1.5px solid rgba(255, 255, 255, 0.2);
          padding: 0.75rem 1.5rem;
          border-radius: 8px;
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          display: flex;
          align-items: center;
          gap: 1rem;
          z-index: 10;
        }

        .countdown-label {
          color: rgba(255, 255, 255, 0.7);
          font-size: 0.9rem;
          font-weight: 500;
        }

        .countdown-value {
          font-family: 'SF Mono', 'Monaco', 'Cascadia Code', 'Courier New', monospace;
          font-size: 1.2rem;
          font-weight: 600;
          color: #4ade80;
          min-width: 60px;
          text-align: center;
          transition: color 0.3s ease;
        }

        .countdown-value.warning {
          color: #f59e0b;
        }

        .countdown-value.critical {
          color: #f87171;
        }

        .countdown-value.expired {
          color: #f87171;
          animation: pulse 0.5s infinite;
        }

        @keyframes pulse {
          0%, 100% {
            opacity: 1;
          }
          50% {
            opacity: 0.5;
          }
        }

        @media (max-width: 600px) {
          .countdown-timer {
            bottom: 10px;
            padding: 0.5rem 1rem;
          }

          .countdown-label {
            font-size: 0.8rem;
          }

          .countdown-value {
            font-size: 1rem;
            min-width: 50px;
          }
        }
      `}</style>
      
      <Footer />
    </>
  );
}
