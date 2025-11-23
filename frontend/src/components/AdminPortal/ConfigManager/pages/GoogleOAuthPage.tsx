/**
 * Google OAuth Settings Page
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useOptimizely } from '../../../../hooks/useOptimizely';
import { API_URL } from '../../../../config';
import Breadcrumbs from '../components/Breadcrumbs';
import AuthSettings from '../components/AuthSettings';
import { ConfigData } from '../types';
import { error } from '../../../../utils/logger';
import { trackOptimizelyEvent, OPTIMIZELY_EVENTS, isFeatureBeingEnabled } from '../../../../utils/optimizelyTracking';
import {
  updateConfig as updateConfigHelper,
  updateArrayItem as updateArrayItemHelper,
  addArrayItem as addArrayItemHelper,
  removeArrayItem as removeArrayItemHelper,
} from '../utils/configHelpers';

interface GoogleOAuthPageProps {
  setMessage: (message: { type: 'success' | 'error'; text: string }) => void;
}

const GoogleOAuthPage: React.FC<GoogleOAuthPageProps> = ({ setMessage }) => {
  const { t } = useTranslation();
  const { optimizely } = useOptimizely();
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [originalConfig, setOriginalConfig] = useState<ConfigData | null>(null);
  const [savingSection, setSavingSection] = useState<string | null>(null);
  const [actionButtons, setActionButtons] = useState<React.ReactNode>(null);

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      const res = await fetch(`${API_URL}/api/config`, {
        credentials: 'include',
      });

      if (res.ok) {
        const data = await res.json();
        setConfig(data);
        setOriginalConfig(structuredClone(data));
      } else {
        setMessage({ type: 'error', text: 'Failed to load configuration' });
      }
    } catch (err) {
      error('Failed to load config:', err);
      setMessage({ type: 'error', text: 'Failed to load configuration' });
    }
  };

  const updateConfig = (path: string[], value: any) => {
    if (!config) return;
    updateConfigHelper(config, setConfig, path, value);
  };

  const updateArrayItem = (path: string[], index: number, value: string) => {
    if (!config) return;
    updateArrayItemHelper(config, setConfig, path, index, value);
  };

  const addArrayItem = (path: string[]) => {
    if (!config) return;
    addArrayItemHelper(config, setConfig, path);
  };

  const removeArrayItem = (path: string[], index: number) => {
    if (!config) return;
    removeArrayItemHelper(config, setConfig, path, index);
  };

  const hasUnsavedChanges = (): boolean => {
    if (!config || !originalConfig) return false;
    return (
      JSON.stringify(config.environment.auth) !== JSON.stringify(originalConfig.environment.auth)
    );
  };

  const handleSave = async () => {
    if (!config) return;
    setSavingSection('Authentication');

    try {
      const res = await fetch(`${API_URL}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(config),
      });

      if (res.ok) {
        // Track Optimizely event if Google OAuth is being enabled for the first time
        if (originalConfig && isFeatureBeingEnabled(
          config.environment.auth.google.enabled,
          originalConfig.environment.auth.google.enabled
        )) {
          trackOptimizelyEvent(OPTIMIZELY_EVENTS.GOOGLE_OAUTH_CONFIGURED, optimizely);
        }
        
        setMessage({ type: 'success', text: 'Google OAuth settings saved successfully' });
        setOriginalConfig(structuredClone(config));
      } else {
        const errorData = await res.json().catch(() => ({ error: 'Unknown error' }));
        setMessage({ type: 'error', text: errorData.error || 'Failed to save settings' });
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Error saving settings';
      setMessage({ type: 'error', text: errorMessage });
      error('Failed to save config:', err);
    } finally {
      setSavingSection(null);
    }
  };

  if (!config) {
    return (
      <div className="settings-page">
        <div className="loading-container">
          <div className="loading-spinner"></div>
          <p>Loading settings...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-page">
      <div className="settings-page-header">
        <h2 className="settings-page-title">{t('settings.googleOAuth.title')}</h2>
        <p className="settings-page-description">
          {t('settings.googleOAuth.pageDescription')}
        </p>
      </div>

      <Breadcrumbs 
        section={t('settings.googleOAuth.title')}
        actions={actionButtons}
      />

      <AuthSettings
        config={config}
        updateConfig={updateConfig}
        updateArrayItem={updateArrayItem}
        addArrayItem={addArrayItem}
        removeArrayItem={removeArrayItem}
        hasUnsavedChanges={hasUnsavedChanges()}
        onSave={handleSave}
        onCancel={() => setConfig(originalConfig)}
        savingSection={savingSection}
        setActionButtons={setActionButtons}
      />
    </div>
  );
};

export default GoogleOAuthPage;

