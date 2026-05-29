/**
 * VideoPage component for direct video links
 * Shows a single video with title, description, and back to album button
 */

import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { API_URL } from '../config';
import { Photo } from '../types/photo';
import VideoPlayer from './ContentModal/VideoPlayer';
import { ArrowLeftIcon } from './icons';
import './VideoPage.css';
import { fetchWithRateLimitCheck } from '../utils/fetchWrapper';

const VideoPage: React.FC = () => {
  const { t } = useTranslation();
  const { album, filename } = useParams<{ album: string; filename: string }>();
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const [video, setVideo] = useState<Photo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchVideo = async () => {
      // Require authentication for direct video links
      if (!isAuthenticated) {
        setError('NOT_AUTHENTICATED');
        setLoading(false);
        return;
      }

      if (!album || !filename) {
        setError(t('videoPage.invalidUrl'));
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        
        // Decode URI components
        const decodedAlbum = decodeURIComponent(album);
        const decodedFilename = decodeURIComponent(filename);
        
        // Fetch album photos to find this video
        const response = await fetchWithRateLimitCheck(
          `${API_URL}/api/albums/${encodeURIComponent(decodedAlbum)}/photos`
        );
        
        if (!response.ok) {
          if (response.status === 404) {
            throw new Error(t('videoPage.albumNotFound'));
          }
          throw new Error(t('videoPage.failedToLoad'));
        }
        
        const data = await response.json();
        const photos: Photo[] = Array.isArray(data) ? data : (data.photos || []);
        
        // Find the video by filename
        const foundVideo = photos.find(p => {
          const photoFilename = p.id.split('/').pop() || p.id;
          return photoFilename === decodedFilename && p.media_type === 'video';
        });
        
        if (!foundVideo) {
          throw new Error(t('videoPage.videoNotFound'));
        }
        
        setVideo(foundVideo);
        setError(null);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : t('videoPage.unknownError');
        setError(errorMessage);
        setVideo(null);
      } finally {
        setLoading(false);
      }
    };

    fetchVideo();
  }, [album, filename, t, isAuthenticated]);

  const shouldRedirectTo404 = !loading && (Boolean(error) || !video);

  useEffect(() => {
    if (shouldRedirectTo404) {
      navigate('/404', { replace: true });
    }
  }, [shouldRedirectTo404, navigate]);

  const handleBackToAlbum = () => {
    if (album) {
      navigate(`/album/${encodeURIComponent(decodeURIComponent(album))}`);
    } else {
      navigate('/');
    }
  };

  if (loading) {
    return (
      <div className="video-page-loading">
        <div className="loading-spinner"></div>
        <p>{t('common.loading')}</p>
      </div>
    );
  }

  if (shouldRedirectTo404) {
    return null;
  }

  return (
    <div className="video-page">
      <div className="video-page-header">
        <button onClick={handleBackToAlbum} className="back-button">
          <ArrowLeftIcon width={20} height={20} />
          {t('videoPage.backToAlbum')}
        </button>
      </div>

      <div className="video-page-content">
        <div className="video-page-player">
          <VideoPlayer
            album={video.album}
            filename={filename || ''}
          />
        </div>

        <div className="video-page-info">
          <h1 className="video-page-title">{video.title}</h1>
          {video.description && (
            <p className="video-page-description">{video.description}</p>
          )}
        </div>
      </div>
    </div>
  );
};

export default VideoPage;
