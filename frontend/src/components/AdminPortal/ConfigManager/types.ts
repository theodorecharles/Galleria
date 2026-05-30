/**
 * Shared types for ConfigManager
 */

import { BrandingConfig, ExternalLink } from '../types';

export interface EnvironmentConfig {
  features?: {
    smtpBannerDismissed?: boolean;
  };
  frontend: {
    port: number;
    apiUrl: string;
  };
  backend: {
    port: number;
    photosDir: string;
    allowedOrigins: string[];
  };
  optimization: {
    concurrency: number;
    images: {
      thumbnail: { quality: number; maxDimension: number };
      modal: { quality: number; maxDimension: number };
      download: { enabled?: boolean; quality: number; maxDimension: number };
    };
    video?: {
      segmentDuration?: number;
      hardwareAcceleration?: boolean;
      resolutions?: {
        [key: string]: {
          enabled: boolean;
          height: number;
          videoBitrate: string;
          audioBitrate: string;
        };
      };
    };
  };
  security: {
    allowedHosts: string[];
    rateLimitWindowMs: number;
    rateLimitMaxRequests: number;
  };
  logging?: {
    level: string;
  };
  auth: {
    google: {
      enabled: boolean;
      clientId: string;
      clientSecret: string;
    };
    sessionSecret: string;
    authorizedEmails: string[];
  };
}

export interface OpenAIConfig {
  apiKey: string;
}

export interface AnalyticsConfig {
  scriptPath: string;
  openobserve: {
    enabled: boolean;
    endpoint: string;
    organization: string;
    stream: string;
    username: string;
    password: string;
  };
}

export interface AIConfig {
  autoGenerateTitlesOnUpload: boolean;
}

export interface ConfigData {
  environment: EnvironmentConfig;
  openai: OpenAIConfig;
  analytics: AnalyticsConfig;
  ai?: AIConfig;
}

export interface ConfigManagerProps {
  setMessage: (message: { type: "success" | "error"; text: string }) => void;
  branding: BrandingConfig;
  setBranding: (branding: BrandingConfig) => void;
  loadBranding: () => Promise<void>;
  externalLinks: ExternalLink[];
  setExternalLinks: (links: ExternalLink[]) => void;
}

// Shared section props
export interface SectionProps {
  setMessage: (message: { type: "success" | "error"; text: string }) => void;
}
