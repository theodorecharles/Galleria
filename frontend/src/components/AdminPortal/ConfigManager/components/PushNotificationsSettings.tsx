/**
 * Push Notifications Settings Component
 * Allows admins to configure Web Push notifications (VAPID keys)
 */

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useOptimizely } from '../../../../hooks/useOptimizely';
import { PasswordInput } from '../../PasswordInput';
import { Toggle } from './Toggle';
import { API_URL } from '../../../../config';
import { trackOptimizelyEvent, OPTIMIZELY_EVENTS, isFeatureBeingEnabled } from '../../../../utils/optimizelyTracking';
import PushNotificationStatus from './PushNotificationStatus';

interface PushNotificationsSettingsProps {
  config: any;
  originalConfig: any;
  updateConfig: (path: string[], value: any) => void;
  savingSection: string | null;
  onSave: (section: string, data: any) => Promise<void>;
  setMessage: (message: { type: 'success' | 'error'; text: string }) => void;
  setActionButtons: (buttons: React.ReactNode) => void;
}

const PushNotificationsSettings: React.FC<PushNotificationsSettingsProps> = ({
  config,
  originalConfig,
  updateConfig,
  savingSection,
  onSave,
  setMessage,
  setActionButtons,
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { optimizely } = useOptimizely();
  const [generating, setGenerating] = useState(false);
  const [userEmail, setUserEmail] = useState('');
  const [localKeys, setLocalKeys] = useState<{ publicKey: string; privateKey: string } | null>(null);
  const [justGenerated, setJustGenerated] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [localEnabled, setLocalEnabled] = useState<boolean | null>(null);
  const [refreshKey, setRefreshKey] = useState(Date.now()); // Force refresh of PushNotificationStatus

  // Fetch current user's email on mount
  useEffect(() => {
    fetchUserEmail();
  }, []);

  async function fetchUserEmail() {
    try {
      const res = await fetch(`${API_URL}/api/auth/status`, {
        credentials: 'include'
      });
      if (res.ok) {
        const data = await res.json();
        if (data.authenticated && data.user?.email) {
          setUserEmail(data.user.email);
          
          // Set default VAPID subject if not already set
          const pushConfig = config?.pushNotifications;
          if (!pushConfig?.vapidSubject || pushConfig.vapidSubject === 'mailto:admin@example.com') {
            updateConfig(['pushNotifications', 'vapidSubject'], `mailto:${data.user.email}`);
          }
        }
      }
    } catch (error) {
      console.error('Failed to fetch user email:', error);
    }
  }

  const basePushConfig = config?.pushNotifications || {
    enabled: false,
    vapidPublicKey: '',
    vapidPrivateKey: '',
    vapidSubject: userEmail ? `mailto:${userEmail}` : 'mailto:admin@example.com'
  };
  
  // Use local enabled state if it exists, otherwise use config
  const pushConfig = {
    ...basePushConfig,
    enabled: localEnabled !== null ? localEnabled : basePushConfig.enabled
  };
  
  // Use local keys if they exist, otherwise use config values
  const displayPublicKey = localKeys?.publicKey || pushConfig.vapidPublicKey || '';
  const displayPrivateKey = localKeys?.privateKey || pushConfig.vapidPrivateKey || '';
  
  // Check if we have keys (either in local state or in config)
  const hasKeys = !!(displayPublicKey && displayPrivateKey);

  const originalPushConfig = originalConfig?.pushNotifications || pushConfig;

  // Only show save/cancel if push notifications is enabled AND user has manually edited keys
  // Don't show if we just generated keys (they're already saved by backend)
  const hasManualChanges = 
    !justGenerated &&
    (pushConfig.enabled || false) && 
    (
      pushConfig.vapidSubject !== originalPushConfig.vapidSubject ||
      pushConfig.vapidPublicKey !== originalPushConfig.vapidPublicKey ||
      pushConfig.vapidPrivateKey !== originalPushConfig.vapidPrivateKey
    );
  
  // Clear justGenerated flag when user manually edits a field
  const handleFieldChange = (path: string[], value: any) => {
    if (justGenerated) {
      setJustGenerated(false);
    }
    updateConfig(path, value);
  };

  // Update action buttons whenever state changes
  useEffect(() => {
    const buttons = [];

    // Add Configure Events button when enabled
    if (pushConfig.enabled) {
      buttons.push(
        <button
          key="configure-events"
          type="button"
          className="btn-secondary"
          onClick={() => navigate('/admin/settings/push-notifications/events')}
          style={{ fontSize: '0.875rem', padding: '0.4rem 0.8rem' }}
        >
          {t('notifications.settings.configureEvents')}
        </button>
      );
    }

    // Add Save/Cancel buttons when there are manual changes
    if (hasManualChanges) {
      buttons.push(
        <button
          key="cancel"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleCancel();
          }}
          disabled={savingSection !== null}
          className="btn-secondary"
          style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}
        >
          {t('notifications.settings.cancel')}
        </button>,
        <button
          key="save"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleSave();
          }}
          disabled={savingSection !== null}
          className="btn-primary"
          style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}
        >
          {savingSection === 'pushNotifications' ? t('notifications.settings.saving') : t('notifications.settings.save')}
        </button>
      );
    }

    setActionButtons(buttons.length > 0 ? <>{buttons}</> : null);
  }, [pushConfig.enabled, hasManualChanges, savingSection, t, navigate, setActionButtons]);

  // Auto-generate keys when enabling if keys don't exist
  async function handleToggleEnable() {
    const newEnabled = !pushConfig.enabled;
    
    if (newEnabled) {
      // Set enabled state IMMEDIATELY for instant UI feedback
      setLocalEnabled(true);
      updateConfig(['pushNotifications', 'enabled'], true);
      
      // Enabling - only generate keys if they don't exist
      if (!hasKeys) {
        await generateVapidKeys();
      } else {
        // Keys already exist, just enable (state already set above)
        setJustGenerated(true);
        
        // Save to backend asynchronously, preserving all keys
        try {
          const response = await fetch(`${API_URL}/api/config`, {
            method: 'PUT',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              ...config,
              pushNotifications: {
                enabled: true,
                vapidPublicKey: displayPublicKey,
                vapidPrivateKey: displayPrivateKey,
                vapidSubject: basePushConfig.vapidSubject || `mailto:${userEmail || 'admin@example.com'}`
              }
            })
          });
          
          if (!response.ok) {
            // If save failed, revert the state
            setLocalEnabled(false);
            updateConfig(['pushNotifications', 'enabled'], false);
            setJustGenerated(false);
            throw new Error('Failed to save config');
          }
          
          // Track Optimizely event - notifications enabled for the first time
          if (isFeatureBeingEnabled(true, basePushConfig.enabled)) {
            trackOptimizelyEvent(OPTIMIZELY_EVENTS.NOTIFICATIONS_ENABLED, optimizely);
          }
          
          // Trigger refresh of PushNotificationStatus
          setRefreshKey(Date.now());
        } catch (error) {
          console.error('Failed to enable push notifications:', error);
          alert(t('notifications.settings.errorEnable'));
        }
      }
    } else {
      // Disabling - update UI immediately
      setLocalEnabled(false);
      setJustGenerated(false);
      updateConfig(['pushNotifications', 'enabled'], false);
      
      // Save to backend asynchronously, preserving all keys
      try {
        const response = await fetch(`${API_URL}/api/config`, {
          method: 'PUT',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ...config,
            pushNotifications: {
              enabled: false,
              vapidPublicKey: displayPublicKey,
              vapidPrivateKey: displayPrivateKey,
              vapidSubject: basePushConfig.vapidSubject || `mailto:${userEmail || 'admin@example.com'}`
            }
          })
        });
        
        if (!response.ok) {
          // If save failed, revert the state
          setLocalEnabled(true);
          updateConfig(['pushNotifications', 'enabled'], true);
          throw new Error('Failed to save config');
        }
        // Trigger refresh of PushNotificationStatus
        setRefreshKey(Date.now());
      } catch (error) {
        console.error('Failed to disable push notifications:', error);
        alert(t('notifications.settings.errorDisable'));
      }
    }
  }

  async function generateVapidKeys() {
    setGenerating(true);
    try {
      // Use /notifications/ path to avoid Safari content blocker (blocks /api/ URLs)
      // Frontend server proxies /notifications/ to backend /api/push-notifications/
      const response = await fetch(`/notifications/generate-keys`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': (window as any).csrfToken || ''
        }
      });

      if (!response.ok) {
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const errorData = await response.json();
          throw new Error(errorData.error || errorData.message || t('notifications.settings.errorGenerateKeys'));
        } else {
          // Likely got HTML error page
          throw new Error(`Server error (${response.status}) - please check backend logs`);
        }
      }

      const data = await response.json();
      
      // Store keys in local state so UI updates immediately
      setLocalKeys({
        publicKey: data.publicKey,
        privateKey: data.privateKey
      });
      
      // Track Optimizely event - notifications enabled for the first time
      if (isFeatureBeingEnabled(true, basePushConfig.enabled)) {
        trackOptimizelyEvent(OPTIMIZELY_EVENTS.NOTIFICATIONS_ENABLED, optimizely);
      }
      
      // Mark as just generated so Save/Cancel buttons don't appear
      setJustGenerated(true);
      // Trigger refresh of PushNotificationStatus
      setRefreshKey(Date.now());
    } catch (error: any) {
      console.error('Failed to generate VAPID keys:', error);
      alert(`Failed to generate VAPID keys: ${error.message}`);
      // Revert the enabled state since key generation failed
      setLocalEnabled(false);
      updateConfig(['pushNotifications', 'enabled'], false);
    } finally {
      setGenerating(false);
    }
  }

  function handleCancel() {
    // Reset to original config
    if (originalConfig?.pushNotifications) {
      updateConfig(['pushNotifications'], originalConfig.pushNotifications);
    }
  }

  async function handleSave() {
    // Build complete config object with current values
    const completeConfig = {
      ...config, // Spread entire config first
      pushNotifications: {
        enabled: pushConfig.enabled || false,
        vapidPublicKey: displayPublicKey,
        vapidPrivateKey: displayPrivateKey,
        vapidSubject: pushConfig.vapidSubject || `mailto:${userEmail || 'admin@example.com'}`
      }
    };
    
    // Save the entire config (that's what onSave expects)
    await onSave('pushNotifications', completeConfig);
    
    // Clear local keys after successful save
    setLocalKeys(null);
  }

  return (
    <div>
      {/* Subscription Status and Controls */}
      <PushNotificationStatus 
        isConfigured={pushConfig.enabled && hasKeys} 
        refreshKey={refreshKey} 
        setMessage={setMessage}
      />

      {/* 2x2 Grid Layout */}
      <div 
        style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(2, 1fr)', 
          gap: '1rem',
          width: '100%'
        }}
        className="push-notifications-grid"
      >
          {/* Row 1, Col 1: Enable/Disable Toggle */}
          <div className="branding-group" style={{ margin: 0 }}>
            <Toggle
              checked={pushConfig.enabled || false}
              onChange={handleToggleEnable}
              label={t('notifications.settings.enableLabel')}
              disabled={generating}
            />
            <p
              style={{
                fontSize: '0.8rem',
                color: '#666',
                marginTop: '0.5rem',
                marginLeft: '52px',
                marginBottom: 0,
              }}
            >
              {generating 
                ? t('notifications.settings.generatingKeys')
                : t('notifications.settings.enabledDescription')}
            </p>
          </div>

          {/* Row 1, Col 2: VAPID Subject */}
          <div className="branding-group" style={{ margin: 0, display: (pushConfig.enabled || hasKeys) ? 'block' : 'none' }}>
            <label className="branding-label">{t('notifications.settings.vapidSubject')}</label>
            <input
              type="text"
              className="branding-input"
              value={pushConfig.vapidSubject || ''}
              onChange={(e) => handleFieldChange(['pushNotifications', 'vapidSubject'], e.target.value)}
              placeholder={`mailto:${userEmail || 'admin@example.com'}`}
              disabled={generating}
            />
            <p style={{ fontSize: '0.8rem', color: '#666', marginTop: '0.5rem', marginBottom: 0 }}>
              {t('notifications.settings.vapidSubjectHint')}
            </p>
          </div>

          {/* Row 2, Col 1: VAPID Public Key */}
          <div className="branding-group" style={{ margin: 0, display: (pushConfig.enabled || hasKeys) ? 'block' : 'none' }}>
            <label className="branding-label">{t('notifications.settings.vapidPublicKey')}</label>
            <input
              type="text"
              className="branding-input"
              value={displayPublicKey}
              onChange={(e) => {
                setLocalKeys(prev => prev ? { ...prev, publicKey: e.target.value } : null);
                updateConfig(['pushNotifications', 'vapidPublicKey'], e.target.value);
              }}
              placeholder="BOl7-1UaNfhtLZ4gDWOJtDgyqvI..."
              disabled={generating}
              readOnly
            />
            <p style={{ fontSize: '0.8rem', color: '#666', marginTop: '0.5rem', marginBottom: 0 }}>
              {t('notifications.settings.vapidPublicKeyHint')}
            </p>
          </div>

          {/* Row 2, Col 2: VAPID Private Key */}
          <div className="branding-group" style={{ margin: 0, display: (pushConfig.enabled || hasKeys) ? 'block' : 'none' }}>
            <label className="branding-label">{t('notifications.settings.vapidPrivateKey')}</label>
            <PasswordInput
              value={displayPrivateKey}
              onChange={(e) => {
                setLocalKeys(prev => prev ? { ...prev, privateKey: e.target.value } : null);
                updateConfig(['pushNotifications', 'vapidPrivateKey'], e.target.value);
              }}
              placeholder="Ofopy_1ggmvAncewvCeL1gwUM4u..."
              className="branding-input"
              disabled={generating}
            />
            <p style={{ fontSize: '0.8rem', color: '#666', marginTop: '0.5rem', marginBottom: 0 }}>
              {t('notifications.settings.vapidPrivateKeyHint')}
            </p>
          </div>
        </div>

        {/* Regenerate Keys Section - Yellow Warning Banner */}
        {(pushConfig.enabled || hasKeys) && hasKeys && (
          <div
            className="regenerate-keys-banner"
            style={{
              marginTop: '1.5rem',
              padding: '1.5rem',
              background: 'rgba(255, 193, 7, 0.1)',
              border: '1px solid rgba(255, 193, 7, 0.3)',
              borderRadius: '8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '1.5rem',
            }}
          >
            <div style={{ flex: 1 }}>
              <strong style={{ fontSize: '0.875rem', color: 'rgba(255, 193, 7, 0.9)' }}>
                ⚠️ {t('common.note')}:
              </strong>
              <span style={{ fontSize: '0.875rem', color: 'rgba(255, 193, 7, 0.9)', marginLeft: '0.5rem' }}>
                {t('notifications.settings.generateKeysWarning')}
              </span>
            </div>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setShowConfirmModal(true)}
              disabled={generating}
              style={{
                whiteSpace: 'nowrap',
                fontSize: '0.875rem',
                background: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid rgba(239, 68, 68, 0.5)',
                color: '#ef4444',
              }}
            >
              {generating ? t('notifications.settings.generating') : t('notifications.settings.generateNewKeys')}
            </button>
          </div>
        )}

        {/* Confirmation Modal */}
        {showConfirmModal && (
          <div className="modal-overlay" onClick={() => setShowConfirmModal(false)}>
            <div className="generic-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '500px' }}>
              <div className="generic-modal-header">
                <h2>{t('notifications.settings.confirmTitle')}</h2>
                <button className="close-button" onClick={() => setShowConfirmModal(false)} aria-label={t('notifications.settings.close')}>
                  ×
                </button>
              </div>
              <div className="generic-modal-content">
                <p className="share-description" dangerouslySetInnerHTML={{ __html: t('notifications.settings.confirmMessage') }}>
                </p>
                <div
                  style={{
                    display: 'flex',
                    gap: '0.75rem',
                    justifyContent: 'flex-end',
                    paddingTop: '1rem',
                    borderTop: '1px solid #3a3a3a',
                  }}
                >
                  <button onClick={() => setShowConfirmModal(false)} className="btn-secondary">
                    {t('notifications.settings.cancel')}
                  </button>
                  <button
                    onClick={() => {
                      setShowConfirmModal(false);
                      generateVapidKeys();
                    }}
                    className="btn-secondary"
                    style={{
                      background: 'rgba(245, 158, 11, 0.2)',
                      borderColor: 'rgba(245, 158, 11, 0.3)',
                      color: '#f59e0b',
                    }}
                  >
                    {t('notifications.settings.confirmGenerate')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
    </div>
  );
};

export default PushNotificationsSettings;
