/**
 * Shared types for AdminPortal components
 */

export interface User {
  id: string;
  email: string;
  name: string;
  picture?: string;
  role?: string;
  mfa_enabled?: boolean;
  passkey_enabled?: boolean;
  auth_methods?: string[];
}

export interface AuthStatus {
  authenticated: boolean;
  user?: User;
}

export interface ExternalLink {
  title: string;
  url: string;
}

export interface BrandingConfig {
  siteName: string;
  avatarPath: string;
  headerAvatarPath: string;
  avatarCacheBust: number;
  primaryColor: string;
  secondaryColor: string;
  metaDescription: string;
  metaKeywords: string;
  faviconPath: string;
  shuffleHomepage?: boolean;
  photoLicense?: string;
  language?: string;
  enableAnimatedBackground?: boolean;
  headerTheme?: 'light' | 'dark' | 'custom';
  headerBackgroundColor?: string;
  headerTextColor?: string;
  headerOpacity?: number;
  headerBlur?: number;
  headerBorderColor?: string;
  headerBorderOpacity?: number;
  headerDropdownTheme?: 'light' | 'dark';
  photoGridTheme?: 'light' | 'dark';
  customCSS?: string;
  gridColumns0?: number;
  gridColumns600?: number;
  gridColumns900?: number;
  gridColumns1200?: number;
  gridColumns1600?: number;
}

export interface ImageOptimizationSettings {
  concurrency: number;
  images: {
    thumbnail: {
      quality: number;
      maxDimension: number;
    };
    modal: {
      quality: number;
      maxDimension: number;
    };
    download: {
      quality: number;
      maxDimension: number;
    };
  };
}

export interface Album {
  name: string;
  photoCount?: number;
  published?: boolean;
  show_on_homepage?: boolean;
  description?: string | null;
  sort_order?: number | null;
  folder_id?: number | null;
}

export interface AlbumFolder {
  id: number;
  name: string;
  published: boolean;
  sort_order?: number | null;
  created_at: string;
  updated_at: string;
}

// Photo interface moved to canonical location: types/photo.ts
// The old version had a 'src' field which is no longer used (originals not served)
export type { Photo } from '../../types/photo';

export type Tab = 'branding' | 'links' | 'albums' | 'metrics' | 'config';

export type AuthMethod = 'google' | 'credentials' | 'passkey' | null;

